import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SUMMARY_SCHEMA } from '../context/summaries.ts';
import type { ProviderId, Config, NextStep, RepoConfig, Run } from '../types.ts';
import type { RunStore } from '../store.ts';
import { newRun } from '../store.ts';
import type { PersistentState } from '../config.ts';
import { loadState, saveState } from '../config.ts';
import type { Agents } from '../agents/provider.ts';
import type { EmitEvent } from '../agents/claude.ts';
import { errMsg, sha1, systemClock, truncate, type Clock } from '../util.ts';
import { loadEnvSecrets, redact } from '../redact.ts';
import { logger } from '../log.ts';
import { notify as defaultNotify } from '../notify.ts';
import * as W from '../git/worktree.ts';
import { pushTicket } from '../git/push-ticket.ts';
import type { Board, Project, WorkItem } from '../board/index.ts';
import { BoardError } from '../board/index.ts';
import { TAINTED_ACTORS } from '../board/types.ts';
import { laneForRun } from '../board/lanes.ts';
import { Effects } from './effects.ts';
import { graphBudgets, nextBuildRole, projectItemLane } from './graph.ts';
import { Semaphore } from './semaphore.ts';
import { OfflineProbe, backoffFor, type Fetcher } from '../net/offline.ts';
import { ContextService, type ContextLike } from '../context/service.ts';
import type { PipelineCtx } from './context.ts';
import { Stages } from './stages.ts';
import { PROVIDER_IDS, capabilitiesOf, providerLabel } from '../agents/providers/registry.ts';
import { effectiveReadOnlyTier, readOnlyTier } from '../agents/providers/verification.ts';
import { currentCodexBinding } from '../agents/providers/codex.ts';
import { CANARY_VERSION } from '../agents/providers/canary.ts';
import { route, type AccountState, type ProviderState, type States } from '../agents/routing.ts';
import { resolveBin } from '../config.ts';
import type { Role } from '../agents/roles.ts';
import { DEFAULT_ACCOUNT, accountKey, type AccountRef } from '../accounts/types.ts';
import { effectiveLimitRule } from '../accounts/limit-rule.ts';
import { accountBuildOk } from '../agents/providers/verification.ts';
import { isRemoving } from '../accounts/profile.ts';
import { candidateSel, modelOffered } from '../models/select.ts';
import type { AgentResult, LimitInfo } from '../types.ts';

const log = logger('engine');
const TERMINAL = new Set(['finished', 'aborted']);
const PAUSE_CEILING_MS = 24 * 60 * 60_000;
/** Lanes a human may set (Conductor owns active / needs_you / review). */
export const HUMAN_MOVES = ['backlog', 'todo', 'done', 'canceled'] as const;
export type HumanMove = (typeof HUMAN_MOVES)[number];
const TICK_MS = 5000;

export interface EngineDeps {
  getConfig: () => Config;
  setConfig?: (cfg: Config) => void;
  store: RunStore;
  board: Board;
  agents: Agents;
  clock?: Clock;
  notify?: (title: string, message: string) => void;
  persistent?: { load(): PersistentState; save(s: PersistentState): void };
  /** Extra redaction secrets (e.g. provider API keys). */
  secrets?: () => string[];
  /** The project context engine; the real one is created when omitted (tests may pass a stub). */
  context?: ContextLike;
  /** Connectivity probe fetcher: omitted/null = the probe is off (always `unknown`); the runtime passes the real `fetch`. */
  offlineFetcher?: Fetcher | null;
}

type Job = { ac: AbortController; promise: Promise<void> };

/** 2–6 capital letters derived from a repository name, unique among `taken`. */
export function deriveProjectKey(name: string, taken: ReadonlySet<string>): string {
  const letters = name.toUpperCase().replace(/[^A-Z]/g, '');
  const base = (letters + 'XXXXXX').slice(0, 6);
  for (let n = 3; n <= 6; n++) {
    const k = base.slice(0, n);
    if (!taken.has(k)) return k;
  }
  for (let i = 0; i < 26 * 26; i++) {
    const k = base.slice(0, 4) + String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26));
    if (!taken.has(k)) return k;
  }
  return base;
}

export class Engine {
  readonly store: RunStore;
  readonly board: Board;
  private d: EngineDeps;
  private clock: Clock;
  private stages: Stages;
  readonly effects: Effects;
  private jobs = new Map<string, Job>();
  /** M8-3: usage-limit pauses per ACCOUNT (`provider:id`), in memory (D-E), capped at 24 h. */
  private pauses = new Map<string, { until: number; reason: string }>();
  /** M8-3: which account each running job's current attempt uses (removal ⇒ restart). */
  private jobAccount = new Map<string, string>();
  /** M8-3: a named account whose pre-flight failed at its last check is `unavailable` (never routed) until a check passes. */
  private accountUnavailable = new Set<string>();
  private globalPaused = false;
  private pauseReason: string | undefined;
  private lastPollAt: number | null = null;
  private ignored: { key: string; reason: string }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private tickAgain = false;
  private stopped = true;
  private failCounts = new Map<string, number>();
  private quotaMap = new Map<string, { utilization7d?: number; utilization5h?: number; resetsAt?: number; rejected?: boolean }>();
  private envSecretCache = new Map<string, { at: number; vals: string[] }>();
  private changeListeners = new Set<() => void>();
  private unsubBoard: (() => void) | null = null;
  /** The ONE cap on concurrent read-only analysis calls across all runs (task graphs). */
  private analysisSem = new Semaphore(() => this.d.getConfig().pipeline.readOnlyParallel);
  /** The ONE cap on concurrent builds (graph items and whole-card builds), `pipeline.maxParallel`. */
  private buildSem = new Semaphore(() => this.d.getConfig().pipeline.maxParallel);
  private context!: ContextLike;
  readonly probe: OfflineProbe;
  private persistentDeps: { load(): PersistentState; save(s: PersistentState): void };
  private healthRefresh: (() => Promise<void>) | null = null;
  private healthSource: (() => Partial<Record<ProviderId, { found?: boolean; ok?: boolean; loggedIn?: boolean; version?: string }> | null | undefined>) | null = null;

  constructor(deps: EngineDeps) {
    this.d = deps;
    this.store = deps.store;
    this.board = deps.board;
    this.clock = deps.clock ?? systemClock;
    this.persistentDeps = deps.persistent ?? { load: loadState, save: saveState };
    this.effects = new Effects({ store: deps.store, board: deps.board, secrets: (r) => this.secretsFor(r), now: () => this.clock.now() });
    this.probe = new OfflineProbe({ fetcher: deps.offlineFetcher ?? null, now: () => this.clock.now() });
    this.context = deps.context ?? new ContextService({ board: deps.board, getConfig: deps.getConfig, now: () => this.clock.now(), summarise: (prompt) => this.summariseCall(prompt) });
    this.stages = new Stages(this.makeCtx());
  }

  // ───────────────────────── context for stages ─────────────────────────
  private makeCtx(): PipelineCtx {
    return {
      cfg: () => this.d.getConfig(),
      store: this.d.store,
      board: this.d.board,
      agents: this.d.agents,
      clock: this.clock,
      effects: this.effects,
      notify: (t, m) => (this.d.notify ?? defaultNotify)(t, m),
      persistent: this.persistentDeps,
      secretsFor: (r) => this.secretsFor(r),
      signal: (key) => this.jobs.get(key)?.ac.signal ?? new AbortController().signal,
      emit: (key, ev) => this.emit(key, ev),
      hist: (key, text) => this.d.store.update(key, (r) => void r.history.push({ ts: this.clock.now(), text })),
      routeStates: (role) => this.routeStates(role),
      freshHealth: () => this.freshHealth(),
      providerPause: (ref, until, reason) => this.accountPause(ref, until, reason),
      pausedUntil: (ref) => this.activePause(accountKey(ref)),
      limitRule: () => effectiveLimitRule(this.d.getConfig()),
      noteCandidate: (key, ref) => this.noteCandidate(key, ref),
      tickSoon: () => this.tickSoon(),
      analysisSlot: (signal) => this.analysisSem.acquire(signal),
      buildSlot: (signal) => this.buildSem.acquire(signal),
      context: this.context,
      networkState: () => this.probe.check(),
      recordQuota: (ref, q) => this.recordQuota(ref, q),
    };
  }

  private emit(key: string, ev: EmitEvent): void {
    const run = this.d.store.get(key);
    const text = ev.text !== undefined && run ? redact(ev.text, this.secretsFor(run)) : ev.text;
    this.d.store.appendEvent(key, { ...ev, text });
  }

  /** Last known CLI health (the dashboard's cache). Without it every provider is assumed installed and auth unknown; spawn errors still name the real problem. */
  setHealthSource(fn: () => Partial<Record<ProviderId, { found?: boolean; ok?: boolean; loggedIn?: boolean; version?: string }> | null | undefined>, refresh?: () => Promise<void>): void {
    this.healthSource = fn;
    this.healthRefresh = refresh ?? null;
  }

  /**
   * Routing must not depend on a dashboard having looked recently: when the last reading is missing or stale the engine refreshes the
   * zero-quota health itself (bounded to 8 s; a failed refresh just means "unknown", which routes as installed).
   */
  async freshHealth(): Promise<void> {
    if (!this.healthRefresh || this.healthSource?.()) return;
    try {
      await Promise.race([this.healthRefresh(), new Promise<void>((r) => setTimeout(r, 8000).unref())]);
    } catch {
      /* unknown */
    }
  }

  /**
   * The router's view of every provider: capabilities derived from code, tier, CLI-reported health/auth, CLI-reported pauses — and (M8-3)
   * every account of the tool in config order. `role` given ⇒ `offersModel` per account (the selection THAT candidate would run); else null.
   */
  routeStates(role?: Role): States {
    const cfg = this.d.getConfig();
    const health = this.healthSource?.() ?? {};
    const now = this.clock.now();
    const out = {} as Record<ProviderId, ProviderState>;
    for (const id of PROVIDER_IDS) {
      const bin = (cfg.agents as Record<string, { bin: string } | undefined>)[id]?.bin;
      const h = Object.hasOwn(health, id) ? health[id] : undefined;
      const toolAuth: ProviderState['auth'] = h?.loggedIn === false ? 'not-logged-in' : h?.loggedIn === true ? 'ok' : 'unknown';
      const sel = role ? candidateSel(cfg, role, id) : null;
      const metas = cfg.accounts?.[id] ?? [{ id: DEFAULT_ACCOUNT, name: '' }];
      const accounts: AccountState[] = metas.map((m) => {
        const isDefault = m.id === DEFAULT_ACCOUNT;
        const ref = { provider: id, id: m.id };
        const enabled = isDefault || (id !== 'codex' && !isRemoving(ref) && !this.accountUnavailable.has(accountKey(ref))); // S24: named Codex is dormant
        let offersModel: boolean | null = null;
        if (sel) {
          try {
            offersModel = modelOffered(id, this.d.agents.catalogOf(id, m.id), sel);
          } catch {
            offersModel = null;
          }
        }
        return { id: m.id, name: m.name, isDefault, enabled, auth: isDefault ? toolAuth : this.namedAuth(ref), pausedUntil: this.activePause(accountKey(ref))?.until ?? null, offersModel, buildOk: accountBuildOk(id, isDefault) };
      });
      // provider-level pause (compat + the dashboard): paused only while EVERY enabled account is
      const en = accounts.filter((a) => a.enabled);
      const allPaused = en.length > 0 && en.every((a) => a.pausedUntil !== null && a.pausedUntil > now);
      out[id] = {
        caps: capabilitiesOf(this.d.agents.provider(id)),
        // code constant, adjusted by the add-only canary records (a pass counts only while the install still matches what was tested)
        tier: id === 'codex' ? effectiveReadOnlyTier('codex', currentCodexBinding(cfg.agents.codex.bin, h?.version, CANARY_VERSION)) : readOnlyTier(id),
        installed: (bin ? resolveBin(bin) !== null : true) && h?.found !== false,
        auth: toolAuth,
        pausedUntil: allPaused ? Math.min(...en.map((a) => a.pausedUntil as number)) : null,
        // M8-3 (B2): set from CODE, never from config — only Claude in safe-mode isolates its web profile (F11 locks unchanged)
        ...(id === 'claude' && cfg.agents.claude.isolation === 'safe-mode' ? { webResearchIsolated: true } : {}),
        accounts,
      };
    }
    return out;
  }

  /** A named account's sign-in state from its last check (M8-1 per-account discovery): signed in ⇒ 'ok'; never checked ⇒ 'unknown' (NOT usable). */
  private namedAuth(ref: AccountRef): AccountState['auth'] {
    const v = this.d.agents.catalogOf(ref.provider, ref.id);
    return v?.signedIn === true ? 'ok' : v?.signedIn === false ? 'not-logged-in' : 'unknown';
  }
  /** AccountService: a failed/passed pre-flight at the last check (S2: a check ⇒ the account is `unavailable`). */
  setAccountUnavailable(ref: AccountRef, on: boolean): void {
    const k = accountKey(ref);
    if (on ? !this.accountUnavailable.has(k) : this.accountUnavailable.has(k)) {
      if (on) this.accountUnavailable.add(k);
      else this.accountUnavailable.delete(k);
      this.changed();
    }
  }
  isAccountUnavailable(ref: AccountRef): boolean {
    return this.accountUnavailable.has(accountKey(ref));
  }

  private activePause(key: string): { until: number; reason: string } | null {
    const p = this.pauses.get(key);
    if (!p) return null;
    if (p.until <= this.clock.now()) {
      this.pauses.delete(key);
      return null;
    }
    return p;
  }
  /** A pause derived from a CLI limit message is capped at 24 h (a hostile or buggy message cannot park an account for months); a human can resume any time. */
  private accountPause(ref: AccountRef, until: number, reason: string): void {
    this.pauses.set(accountKey(ref), { until: Math.min(until, this.clock.now() + PAUSE_CEILING_MS), reason });
    this.changed();
  }
  /** Home calls (research hops, asks) record the pause of the account they left (24 h cap). */
  recordAccountPause(ref: AccountRef, until: number, reason: string): void {
    this.accountPause(ref, until, reason);
  }
  /** The account's active pause (views). */
  pauseOf(ref: AccountRef): { until: number; reason: string } | null {
    return this.activePause(accountKey(ref));
  }
  private recordQuota(ref: AccountRef, q: NonNullable<AgentResult['quota']>): void {
    this.quotaMap.set(accountKey(ref), { utilization7d: q.utilization7d, utilization5h: q.utilization5h, resetsAt: q.resetsAt, rejected: q.status === 'rejected' });
    this.changed();
  }
  quotaOf(ref: AccountRef): { utilization7d?: number; utilization5h?: number; resetsAt?: number; rejected?: boolean } | undefined {
    return this.quotaMap.get(accountKey(ref));
  }
  /** How many running jobs use this account right now (the view's `inUse`). */
  jobsOn(ref: AccountRef): number {
    const k = accountKey(ref);
    let n = 0;
    for (const [run, a] of this.jobAccount) if (a === k && this.jobs.has(run)) n++;
    return n;
  }
  private noteCandidate(key: string, ref: AccountRef): void {
    this.jobAccount.set(key, accountKey(ref));
    const name = this.d.agents.accountLabel(ref.provider, ref.id);
    const meta = this.d.getConfig().accounts?.[ref.provider]?.find((a) => a.id === ref.id);
    this.d.store.update(key, (r) => void (r.account = { provider: ref.provider, id: ref.id, name: meta?.name ?? name }));
  }

  /**
   * Home requests never queue (§2.3, M8-6): the pure route over the current states. `paused` ⇒ 409 `limited` with `retryAt`; `ineligible` is
   * reported too (callers keep today's behaviour for it). Quick Ask, Research and briefs call this BEFORE taking a counter.
   */
  accountsGate(role: Role): { ok: true } | { ok: false; kind: 'paused' | 'ineligible'; retryAt: number | null; reason: string } {
    const r = route({ role, roles: this.d.getConfig().roles, states: this.routeStates(role), now: this.clock.now(), label: providerLabel, rule: effectiveLimitRule(this.d.getConfig()) });
    if (r.ok) return { ok: true };
    return r.kind === 'paused' ? { ok: false, kind: 'paused', retryAt: r.pauseUntil, reason: r.reason } : { ok: false, kind: 'ineligible', retryAt: null, reason: r.reason };
  }

  /**
   * S8 step 2 for stage jobs: every job running on the removed account is stopped (the envelope's git-meta restore runs), its attempt refunded,
   * and it goes back to the queue with the same `next` and a visible move note. Not a human restart. Partial uncommitted builder edits stay in
   * the worktree — the next attempt starts on top of them, exactly as after a timeout retry (documented).
   */
  async accountRemoved(ref: AccountRef, label: string): Promise<number> {
    const k = accountKey(ref);
    const hit = [...this.jobAccount.entries()].filter(([run, a]) => a === k && this.jobs.has(run)).map(([run]) => run);
    for (const key of hit) {
      await this.stopJob(key);
      this.jobAccount.delete(key);
      const run = this.d.store.get(key);
      // code review N6: re-queue only a run that is still in flight — a concurrent needs_human / awaiting_approval / pause is never overwritten
      if (!run || (run.status !== 'running' && run.status !== 'queued')) continue;
      const role = this.roleFor(run);
      const r = role ? route({ role, complexity: run.complexity, roles: this.d.getConfig().roles, states: this.routeStates(role), now: this.clock.now(), label: providerLabel, rule: effectiveLimitRule(this.d.getConfig()) }) : null;
      const nextWho = r?.ok ? this.d.agents.accountLabel(r.candidates[0]!.id, r.candidates[0]!.account) : 'the next available account';
      const note = `${label} was removed, so this stage started again on ${nextWho}.`;
      this.d.store.update(key, (x) => {
        x.agentRuns = Math.max(0, x.agentRuns - 1);
        x.status = 'queued';
        x.moved = { kind: r?.ok && r.candidates[0]!.id === ref.provider ? 'account' : 'tool', restarted: true, note, at: this.clock.now(), reason: 'removed' };
        x.history.push({ ts: this.clock.now(), text: note });
      });
    }
    for (const key of [...this.pauses.keys()]) if (key === k) this.pauses.delete(key);
    this.quotaMap.delete(k);
    this.accountUnavailable.delete(k);
    this.changed();
    this.tickSoon();
    return hit.length;
  }

  secretsFor(run: Run): string[] {
    const extra = this.d.secrets?.() ?? [];
    const repo = this.d.getConfig().repos.find((r) => r.name === run.repo);
    if (!repo) return extra;
    const hit = this.envSecretCache.get(repo.name);
    if (hit && this.clock.now() - hit.at < 30_000) return [...extra, ...hit.vals];
    const vals = loadEnvSecrets(repo.copyFiles.map((f) => join(repo.path, f)));
    this.envSecretCache.set(repo.name, { at: this.clock.now(), vals });
    return [...extra, ...vals];
  }

  /** Drop caches after settings changes. */
  invalidate(): void {
    this.changed();
  }

  // ───────────────────────── lifecycle ─────────────────────────
  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }
  private changed(): void {
    for (const l of this.changeListeners) {
      try {
        l();
      } catch {
        /* ignore */
      }
    }
  }

  start(opts: { pollMs?: number } = {}): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.recover();
    // the board is local and synchronous: a change on it wakes the engine immediately (no polling lag)
    this.unsubBoard = this.board.onChange(() => this.tickSoon());
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (e) {
        log.error(`tick failed: ${errMsg(e)}`);
      }
      if (this.stopped) return;
      this.timer = setTimeout(loop, opts.pollMs ?? TICK_MS);
      this.timer.unref();
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.unsubBoard?.();
    this.unsubBoard = null;
    for (const j of this.jobs.values()) j.ac.abort();
    await Promise.allSettled([...this.jobs.values()].map((j) => j.promise));
  }

  /** Crash recovery: runs that were mid-flight when the process died go back to the queue. */
  recover(): void {
    const now = this.clock.now();
    for (const r of this.d.store.list()) {
      // D-E: pauses live in memory — a limit-paused run re-seeds the pause of the account it hit, so a restart does not re-spawn into a known limit
      if (r.status === 'paused' && r.pauseKind === 'limit' && r.account && (r.pausedUntil ?? 0) > now && !this.pauses.has(accountKey(r.account))) {
        this.pauses.set(accountKey(r.account), { until: Math.min(r.pausedUntil!, now + PAUSE_CEILING_MS), reason: r.pauseReason ?? 'usage limit' });
      }
    }
    for (const r of this.d.store.list()) {
      if (r.status === 'running') {
        this.d.store.update(r.key, (x) => {
          x.status = 'queued';
          x.history.push({ ts: this.clock.now(), text: 'Recovered after a restart — resuming' });
        });
      }
    }
  }

  tickSoon(): void {
    if (this.stopped) return;
    setTimeout(() => void this.tick().catch((e) => log.error(`tick failed: ${errMsg(e)}`)), 50).unref();
  }

  /** Wait for all in-flight stage jobs (tests). */
  async idle(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled([...this.jobs.values()].map((j) => j.promise));
  }

  // ───────────────────────── each tick: flush → project → claim ─────────────────────────
  async tick(): Promise<void> {
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      await this.pollOnce();
      this.schedule();
    } finally {
      this.ticking = false;
      if (this.tickAgain && !this.stopped) {
        this.tickAgain = false;
        this.tickSoon();
      }
    }
  }

  private async pollOnce(): Promise<void> {
    this.lastPollAt = this.clock.now();
    const ignored: { key: string; reason: string }[] = [];
    // 1. re-drive every pending board effect (startup flush = the first tick; later ticks retry with back-off)
    for (const run of this.d.store.list()) {
      if (this.effects.hasPending(run)) await this.effects.flush(run.key).catch(() => undefined);
    }
    // 2. level-triggered projection: the card's lane always converges to what the run says (heals any crash window)
    for (const run of this.d.store.list()) {
      try {
        await this.project(run);
      } catch (e) {
        log.warn(`${run.key}: projection failed: ${errMsg(e)}`);
      }
      await this.digestRun(run);
    }
    // 2b. a run paused because the network was down resumes only once the probe says it is back (`unknown` counts as back)
    const dueOffline = this.d.store.list().filter((r) => r.status === 'paused' && r.pauseReason === 'offline' && (r.pausedUntil ?? 0) <= this.clock.now());
    if (dueOffline.length && (await this.probe.check()) === 'offline') {
      for (const r of dueOffline) {
        this.d.store.update(r.key, (x) => {
          const streak = (x.offline?.streak ?? 1) + 1;
          x.pausedUntil = this.clock.now() + backoffFor(streak);
          if (x.offline) x.offline = { ...x.offline, streak, totalMs: x.offline.totalMs + backoffFor(streak) };
        });
      }
    }
    // 3. claims
    const runKeys = new Set(this.d.store.list().map((r) => r.key));
    for (const item of this.board.items({ parentId: null })) {
      if (runKeys.has(item.key)) continue;
      if (item.lane === 'active' || item.lane === 'needs_you' || item.lane === 'review') {
        // K4: never auto-reset such a card to "To do" — that would silently re-run a --force build after any data loss
        ignored.push({ key: item.key, reason: `This card is in "${item.lane}" but Conductor has no run for it. Move it to To do to start it, or cancel it.` });
        continue;
      }
      if (item.lane !== 'todo' || !item.autoStart || item.kind === 'bug' || item.kind === 'subtask') continue;
      if (item.kind !== 'work') {
        ignored.push({ key: item.key, reason: `Cards of kind "${item.kind}" are not supported yet — create it as a work item.` });
        continue;
      }
      if (!this.board.claimable().some((c) => c.id === item.id)) {
        ignored.push({ key: item.key, reason: 'Waiting for the cards it depends on to be done.' });
        continue;
      }
      if (this.globalPaused) continue; // paused from the dashboard: no new claims
      try {
        await this.maybeClaim(item);
      } catch (e) {
        log.warn(`${item.key}: claim failed: ${errMsg(e)}`);
      }
    }
    for (const k of this.d.store.tombstoned()) ignored.push({ key: k, reason: 'This run\'s record was unreadable and has been set aside; the card will not be started again by itself. Check the data folder.' });
    this.ignored = ignored;
    this.changed();
  }

  /** One read-only model call for an opt-in module summary, in an EMPTY scratch directory (the facts are in the prompt). Null on any failure. */
  private async summariseCall(prompt: string): Promise<unknown | null> {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-ctx-'));
    try {
      await this.freshHealth();
      const res = await this.d.agents.readOnly({ role: 'context', complexity: undefined, states: this.routeStates('context'), rule: effectiveLimitRule(this.d.getConfig()), onLimit: (l: LimitInfo) => { if (l.account) this.accountPause({ provider: l.provider, id: l.account }, l.resetsAt && l.resetsAt > this.clock.now() ? l.resetsAt : this.clock.now() + 15 * 60_000, l.message); }, stage: 'plan', cwd: dir, prompt, schema: SUMMARY_SCHEMA as any, name: 'conductor context summary', onEvent: () => undefined, secrets: this.d.secrets?.() ?? [], toolDefaultOnly: true } as any); // M8-2 N4: the summary runs on the tool default, never the Quick Ask choice
      return res.ok ? res.json ?? null : null;
    } catch {
      return null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** A run at rest gets one outcome line in its project's history (level-triggered, idempotent, never an error for the run). */
  private async digestRun(run: Run): Promise<void> {
    if (!['ready', 'finished', 'needs_human', 'aborted'].includes(run.status)) return;
    if (run.digestMark === `${run.status}:${run.rev}:${run.loop}`) return;
    try {
      const repo = this.d.getConfig().repos.find((r) => r.name === run.repo);
      if (!repo) return;
      const mark = await this.context.digest(run, repo);
      if (mark) this.d.store.update(run.key, (r) => void (r.digestMark = mark));
    } catch (e) {
      log.warn(`${run.key}: outcome digest failed: ${errMsg(e)}`);
    }
  }

  /** Converge the card's lane/stage to the run's state (level-triggered; idempotent). A run whose card vanished is an orphan. */
  private async project(run: Run): Promise<void> {
    const item = this.board.item(run.itemId);
    const active = !TERMINAL.has(run.status);
    if (!item) {
      if (!active) return;
      await this.stopJob(run.key);
      this.d.store.update(run.key, (r) => {
        r.status = 'aborted';
        r.next = 'none';
        r.history.push({ ts: this.clock.now(), text: 'The card was removed from the board — stopped' });
      });
      return;
    }
    if (this.effects.hasPending(run)) return;
    if (item.lane !== laneForRun(run)) await this.effects.state(run.key, 'state', { stage: run.expected.stage });
    this.projectSubtasks(run);
  }

  /**
   * The task graph's cards follow the run, never the other way round: each keyed subtask card's lane converges to its item's state
   * (a card a person moved is moved back; a card that no longer exists is left alone — never recreated, never an error).
   */
  private projectSubtasks(run: Run): void {
    const g = run.graph;
    if (!g) return;
    for (const it of g.items) {
      if (!it.key) continue;
      const card = this.board.item(it.key);
      if (!card || card.parentId !== run.itemId) continue;
      const want = run.status === 'aborted' && it.state !== 'done' ? 'canceled' : projectItemLane(it);
      if (card.lane === want) continue;
      try {
        this.board.setLane(card.id, want, 'conductor');
      } catch (e) {
        log.warn(`${run.key}: could not move the card of ${it.id}: ${errMsg(e)}`);
      }
    }
  }

  private async maybeClaim(item: WorkItem): Promise<void> {
    const cfg = this.d.getConfig();
    const project = this.board.project(item.projectId);
    const repo = this.resolveRepo(project);
    const seed = {
      key: item.key,
      itemId: item.id,
      title: item.title,
      description: item.description ?? '',
      descHash: sha1(item.description ?? ''),
      repo: repo?.name ?? '',
      branch: '',
      worktree: '',
      baseSha: '',
      loopBudget: cfg.pipeline.maxLoops,
    };
    try {
      this.d.store.create({ ...newRun(seed), untrusted: TAINTED_ACTORS.includes(item.createdBy) ? true : undefined, fastPath: item.createdBy === 'user-ask' ? true : undefined });
    } catch (e) {
      if ((e as { code?: string }).code === 'exists') return;
      throw e;
    }
    log.info(`${item.key}: claimed (${repo?.name ?? 'no repo yet'})`);
    await this.stages.applyStage(item.key, 'planning');
    await this.effects.comment(item.key, 'claimed', `🤖 **Conductor picked this up.** Plan (Claude) → build (Cursor) → independent verification (Claude).`);
    if (!repo) {
      await this.stages.toNeedsHuman(
        item.key,
        `I could not tell which repository this belongs to. Registered: ${cfg.repos.map((r) => r.name).join(', ') || '(none yet)'}. Set the project's repository, then move the card back to To do.`,
        'plan',
      );
    }
    this.changed();
    this.tickSoon();
  }

  /** The project's repository, or the only registered one. Registered repos only. */
  resolveRepo(project: Project | undefined): RepoConfig | null {
    const repos = this.d.getConfig().repos;
    if (project?.repo) return repos.find((r) => r.name.toLowerCase() === project.repo.toLowerCase()) ?? null;
    return repos.length === 1 ? repos[0]! : null;
  }

  /** The project bound to a registered repo (created on first use). */
  ensureProjectForRepo(repoName: string): Project {
    const existing = this.board.projects().find((p) => p.repo === repoName);
    if (existing) return existing;
    const taken = new Set(this.board.projects().map((p) => p.key));
    return this.board.createProject({ key: deriveProjectKey(repoName, taken), name: repoName, repo: repoName });
  }


  private async park(run: Run): Promise<void> {
    await this.stopJob(run.key);
    this.d.store.update(run.key, (r) => {
      r.parkedFrom = r.status;
      r.status = 'parked';
      r.history.push({ ts: this.clock.now(), text: 'Parked (moved to Backlog) — nothing will run until you move it to To do' });
    });
    await this.effects.state(run.key, 'state', { stage: run.expected.stage });
  }

  private async stopJob(key: string): Promise<void> {
    const j = this.jobs.get(key);
    if (!j) return;
    j.ac.abort();
    await j.promise.catch(() => undefined);
  }

  /** Human move to To do / dashboard Retry. Implements the resume matrix. */
  private async rerunFromHuman(key: string): Promise<void> {
    const run0 = this.d.store.get(key);
    if (!run0) return;
    await this.stopJob(key);
    const cfg = this.d.getConfig();
    const item = this.board.item(run0.itemId);
    // rolling limit on human restarts: even the owner's own automation must not be able to spin this forever
    const nowT = this.clock.now();
    const recent = (run0.restartTimes ?? []).filter((t) => nowT - t < 3_600_000);
    if (recent.length >= 5) {
      this.d.store.update(key, (r) => void (r.restartTimes = recent));
      await this.stages.toNeedsHuman(key, 'This run was restarted 5 times within an hour, so Conductor is pausing it to protect your quota. Wait a while (or fix the underlying problem), then move it to To do again.', run0.next);
      return;
    }
    const was = run0.status === 'parked' ? (run0.parkedFrom ?? 'running') : run0.status;
    const origin: NextStep | undefined = run0.needsHuman?.origin;
    // needs_human on a later stage retries that stage; everything else re-runs from plan
    // …except for an unverified (untrusted) run that no human has approved in v2: it always re-plans, so approval is asked for first
    const unapproved = run0.untrusted === true && !run0.approvedBy;
    const retryStage = !unapproved && was === 'needs_human' && origin && ['build', 'verify', 'plan_review'].includes(origin) ? origin : null;
    const keepCommits = retryStage !== null || was === 'ready' || was === 'finished' || was === 'aborted';
    if (run0.worktree) {
      const repo0 = cfg.repos.find((r) => r.name === run0.repo);
      try {
        // never back up / reset a foreign checkout (B-2); an unregistered repository means ownership cannot be proven ⇒ touch nothing
        if (!repo0) throw new Error(`repository "${run0.repo}" is not registered, so ownership of ${run0.worktree} cannot be verified`);
        await W.assertOwnedWorktree(repo0, run0.key, run0.worktree, cfg.worktreeRoot);
        await W.backupRefs(run0.worktree, run0.key, run0.rev); // recoverable copy first, always
        // Never hard-reset the repository's own checkout. A private conductor worktree can still be reset.
        if (!keepCommits && !(await W.isRepoCheckout(repo0.path, run0.worktree))) await W.resetToBase(run0.worktree, run0.baseSha);
      } catch (e) {
        log.warn(`${key}: backup/reset skipped: ${errMsg(e)}`);
      }
    }
    const repo = run0.repo ? null : this.resolveRepo(item ? this.board.project(item.projectId) : undefined);
    const obsolete = retryStage ? [] : run0.bugs.filter((b) => b.status === 'open' && b.itemId);
    // a re-plan replaces the task graph: its subtask cards are superseded (card ids resolved now — the keys are all the run records)
    const superseded = retryStage || !run0.graph
      ? []
      : run0.graph.items.flatMap((it) => {
          const card = it.key ? this.board.item(it.key) : undefined;
          return card && card.parentId === run0.itemId ? [{ effKey: `subtask-cancel:${run0.graph!.rev}:${it.id}`, id: card.id, rev: run0.graph!.rev }] : [];
        });
    // cards whose creation effect applied but whose key the graph never recorded (crash/transient window) are found through the effect's refId
    if (!retryStage && run0.graph) {
      for (const [ek, rec] of Object.entries(run0.effects)) {
        if (!ek.startsWith(`subtask:${run0.graph.rev}:`) || rec.status !== 'done' || !rec.refId) continue;
        const card = this.board.item(rec.refId);
        const id = ek.split(':')[2]!;
        if (card && card.parentId === run0.itemId && !superseded.some((c) => c.id === card.id)) superseded.push({ effKey: `subtask-cancel:${run0.graph.rev}:${id}`, id: card.id, rev: run0.graph.rev });
      }
    }
    this.d.store.update(key, (r) => {
      const now = this.clock.now();
      r.restartTimes = [...recent, nowT];
      r.offline = undefined; // a human restart is a fresh start for the offline caps
      r.agentRuns = 0; // a human restart is a fresh budget (otherwise the per-card cap becomes a dead end)
      r.buildFails = 0;
      r.limitStreak = 0;
      r.limitEpisode = 0;
      r.limitPauses = 0; // B3b: a human restart resets the paused-episode cap, as it resets limitEpisode
      r.limitPausedEpisode = undefined;
      r.pauseKind = undefined;
      r.moved = undefined;
      if (item) {
        r.title = item.title;
        r.description = item.description ?? '';
        r.descHash = sha1(item.description ?? '');
      }
      if (repo) r.repo = repo.name;
      r.status = 'queued';
      r.needsHuman = undefined;
      r.pausedUntil = undefined;
      r.pauseReason = undefined;
      r.parkedFrom = undefined;
      r.expected = {};
      r.lastError = undefined;
      if (retryStage) {
        r.next = retryStage;
        if (retryStage === 'verify' && r.loop >= r.loopBudget) r.loopBudget += cfg.pipeline.maxLoops;
        if (retryStage === 'build' && r.graph?.final === 'pending') {
          // only the tasks that failed or were blocked by a failure run again; finished tasks (and their commits) are kept
          for (const it of r.graph.items) {
            if (it.state !== 'failed' && it.state !== 'blocked') continue;
            it.state = 'pending';
            it.loop = 1;
            it.loopBudget = cfg.pipeline.maxLoops;
            it.feedback = undefined;
            it.note = undefined;
            it.floor = undefined;
            it.startHead = undefined;
            it.nonce = undefined;
          }
          r.commitNote = undefined;
        }
        r.history.push({ ts: now, text: `Retrying ${retryStage} (requested by you)` });
      } else {
        r.rev += 1;
        r.next = 'plan';
        r.loop = 1;
        r.loopBudget = cfg.pipeline.maxLoops;
        if (!keepCommits) r.commitSha = undefined; // work was reset to base: the old commit no longer exists on the branch
        r.planApproved = false;
        r.planReviewDone = false;
        r.planReviewRounds = 0;
        r.commitNote = undefined;
        r.feedback = undefined;
        r.verdict = null;
        for (const b of r.bugs) if (b.status === 'open') b.status = 'closed';
        for (const [ek, rec] of Object.entries(r.effects)) if (ek.startsWith(`subtask:${r.rev - 1}:`) && rec.status === 'pending') rec.status = 'done'; // never create cards for a discarded graph
        r.graph = undefined;
        for (const c of superseded) Effects.enqueue(r, c.effKey, { kind: 'subtask-cancel', payload: { itemId: c.id, rev: c.rev } });
        r.history.push({ ts: now, text: `Re-planning from scratch (rev ${r.rev}) — requested by you` });
      }
    });
    if (superseded.length) await this.effects.flush(key);
    if (obsolete.length) {
      const rev = this.d.store.get(key)?.rev ?? run0.rev + 1;
      for (const b of obsolete) await this.effects.close(key, `bugclose:${b.fp}:rerun${rev}`, b.itemId!, 'done');
    }
    if (!this.d.store.get(key)!.repo) {
      await this.stages.toNeedsHuman(key, `Still no repository for this card. Registered: ${cfg.repos.map((r) => r.name).join(', ') || '(none)'}. Set the project's repository and move it back to To do.`, 'plan');
      return;
    }
    await this.stages.applyStage(key, retryStage === 'build' ? 'building' : retryStage === 'verify' ? 'verifying' : 'planning');
    this.tickSoon();
  }

  // ───────────────────────── scheduling ─────────────────────────
  private roleFor(run: Run): Role | null {
    switch (run.next) {
      case 'plan':
        return 'planning';
      case 'plan_review':
        return 'review';
      case 'verify':
        return 'verification';
      case 'build': {
        const gr = nextBuildRole(run.graph);
        if (gr !== undefined) return gr; // a task graph under construction: the role of its next task
        return run.loop > 1 || run.bugs.some((b) => b.status === 'open') ? 'debugging' : 'implementation';
      }
      default:
        return null;
    }
  }

  /** The run waits only when EVERY account that may take its next step is at a usage limit (v1 semantics, chain- and account-aware). */
  private blockedByPause(run: Run, statesFor: (role: Role) => States = (role) => this.routeStates(role)): { until: number } | null {
    const role = this.roleFor(run);
    if (!role) return null;
    const r = route({ role, complexity: run.complexity, roles: this.d.getConfig().roles, states: statesFor(role), now: this.clock.now(), label: providerLabel, rule: effectiveLimitRule(this.d.getConfig()) });
    return !r.ok && r.kind === 'paused' ? { until: r.pauseUntil } : null;
  }
  /** Who would take the run's next step right now (for the "continues on …" line). */
  private nextLabel(run: Run, statesFor: (role: Role) => States): string | null {
    const role = this.roleFor(run);
    if (!role) return null;
    const r = route({ role, complexity: run.complexity, roles: this.d.getConfig().roles, states: statesFor(role), now: this.clock.now(), label: providerLabel, rule: effectiveLimitRule(this.d.getConfig()) });
    return r.ok ? this.d.agents.accountLabel(r.candidates[0]!.id, r.candidates[0]!.account) : null;
  }
  /** B3c: a limit pause (also records written before M8-3 without a kind, unless they are offline pauses). */
  private static limitPaused(r: Run): boolean {
    return r.status === 'paused' && (r.pauseKind === 'limit' || (r.pauseKind === undefined && r.pauseReason !== 'offline'));
  }

  schedule(): void {
    if (this.globalPaused) return;
    const cfg = this.d.getConfig();
    const now = this.clock.now();
    // N4: the router's states (incl. modelOffered per account) are computed ONCE per tick per role, never per run
    const byRole = new Map<Role, States>();
    const statesFor = (role: Role): States => {
      let st = byRole.get(role);
      if (!st) {
        st = this.routeStates(role);
        byRole.set(role, st);
      }
      return st;
    };
    const runs = this.d.store.list().sort((a, b) => a.createdAt - b.createdAt);
    for (const r of runs) {
      if (r.status === 'failed') {
        const n = this.failCounts.get(r.key) ?? 0;
        if (now - r.updatedAt > Math.min(10 * 60_000, 30_000 * 2 ** n)) {
          this.d.store.update(r.key, (x) => void (x.status = 'queued'));
        }
      }
    }
    for (const r of this.d.store.list().sort((a, b) => a.createdAt - b.createdAt)) {
      if (this.jobs.size >= cfg.pipeline.maxParallel) break;
      if (this.jobs.has(r.key)) continue;
      const limitPaused = Engine.limitPaused(r);
      // offline pauses keep their own timer; a LIMIT pause is re-routed on every tick regardless of pausedUntil (a reset, an added or signed-in
      // account, a reorder or a rule change resumes it at once — §2.3 auto-resume)
      const waitingPause = r.status === 'paused' && !limitPaused && (r.pausedUntil ?? 0) > now;
      if (r.status !== 'queued' && r.status !== 'paused') continue;
      const blocked = this.blockedByPause(r, statesFor);
      if (blocked) {
        if (r.status !== 'paused') {
          this.d.store.update(r.key, (x) => {
            x.status = 'paused';
            x.pausedUntil = blocked.until;
            x.pauseReason = 'Waiting for the usage limit to reset';
            x.pauseKind = 'limit';
          });
        } else if (limitPaused && r.pausedUntil !== blocked.until) {
          this.d.store.update(r.key, (x) => void (x.pausedUntil = blocked.until));
        }
        continue;
      }
      if (waitingPause) continue;
      if (limitPaused) {
        const who = this.nextLabel(r, statesFor);
        if (who) this.d.store.update(r.key, (x) => void x.history.push({ ts: now, text: `${r.key} continues on ${who}` }));
      }
      this.startJob(r.key);
    }
  }

  private startJob(key: string): void {
    const ac = new AbortController();
    this.d.store.update(key, (r) => {
      r.status = 'running';
      r.pausedUntil = undefined;
      r.pauseReason = undefined;
      r.pauseKind = undefined;
      r.stageStartedAt = this.clock.now();
    });
    const promise = this.runJob(key, ac)
      .catch((e) => this.failRun(key, e))
      .finally(() => {
        this.jobs.delete(key);
        this.jobAccount.delete(key);
        this.changed();
        this.tickSoon();
      });
    this.jobs.set(key, { ac, promise });
    this.changed();
  }

  private async runJob(key: string, ac: AbortController): Promise<void> {
    for (let i = 0; ; i++) {
      const run = this.d.store.get(key);
      if (!run || ac.signal.aborted || run.status !== 'running') return;
      // a graph-less run keeps today's 60; a task graph scales with its size, up to a hard ceiling
      if (i >= (run.graph ? graphBudgets(run.graph.items.length, this.d.getConfig().pipeline.maxAgentRunsPerIssue).iterationCap : 60)) break;
      switch (run.next) {
        case 'plan':
          await this.stages.plan(key);
          break;
        case 'plan_review':
          await this.stages.planReview(key);
          break;
        case 'build':
          await this.stages.build(key);
          break;
        case 'verify':
          await this.stages.verify(key);
          break;
        default:
          return;
      }
    }
    await this.stages.toNeedsHuman(key, 'The pipeline made no progress after many iterations — stopping to protect your quota.', this.d.store.get(key)?.next ?? 'none');
  }

  private failRun(key: string, e: unknown): void {
    const n = (this.failCounts.get(key) ?? 0) + 1;
    this.failCounts.set(key, n);
    const msg = truncate(redact(errMsg(e), this.d.secrets?.() ?? []), 400);
    log.error(`${key}: stage crashed: ${msg}`);
    this.emit(key, { agent: 'conductor', stage: 'engine', kind: 'error', text: `Internal error: ${msg}` });
    if (n >= 4) {
      void this.stages.toNeedsHuman(key, `Conductor hit an internal error four times: ${msg}`, this.d.store.get(key)?.next ?? 'none');
      return;
    }
    this.d.store.update(key, (r) => {
      r.status = 'failed';
      r.lastError = msg;
      r.history.push({ ts: this.clock.now(), text: `Internal error (will retry): ${truncate(msg, 120)}` });
    });
  }

  // ───────────────────────── human commands (dashboard / API) ─────────────────────────
  /**
   * The ONLY way a human moves a card that has a run (condition K2): the run record changes first, the card's lane follows
   * from it. Humans may set backlog / todo / done / canceled; Conductor owns active / needs_you / review.
   */
  async applyHumanMove(key: string, lane: string): Promise<void> {
    if (!(HUMAN_MOVES as readonly string[]).includes(lane)) {
      throw new EngineError('bad_lane', `You can move cards to ${HUMAN_MOVES.join(', ')} only — Conductor owns the other lanes.`);
    }
    const asked = this.board.item(key); // accept a key or an id; the run is always looked up by the card's KEY
    const run = this.d.store.get(asked?.key ?? key);
    if (!run) {
      const item = asked;
      if (!item) throw new EngineError('missing', 'Unknown card.');
      if (item.kind === 'subtask' && item.createdBy === 'conductor' && item.parentId && this.d.store.list().some((r) => r.itemId === item.parentId && r.graph)) {
        throw new EngineError('managed', 'This task follows its plan and is moved by Conductor. Use the parent card to retry or stop the work.');
      }
      try {
        this.board.user.moveLane(item.id, lane);
      } catch (e) {
        if (e instanceof BoardError) throw new EngineError(e.code, e.message);
        throw e;
      }
      this.tickSoon();
      return;
    }
    key = run.key;
    const s = run.status;
    switch (lane as HumanMove) {
      case 'backlog':
        if (s === 'parked') return;
        if (s === 'finished' || s === 'aborted') throw new EngineError('bad_state', 'This card is already finished or canceled — use Retry to run it again.');
        await this.park(run);
        break;
      case 'todo':
        if (s === 'failed') {
          this.d.store.update(key, (r) => {
            r.status = 'queued';
            r.lastError = undefined;
            r.history.push({ ts: this.clock.now(), text: 'Retrying after an internal error (requested by you)' });
          });
          this.failCounts.delete(key);
        } else {
          this.failCounts.delete(key);
          await this.rerunFromHuman(key);
        }
        break;
      case 'done':
        if (s === 'finished') return;
        if (s === 'aborted') throw new EngineError('bad_state', 'This card was canceled — it cannot be marked done.');
        await this.stopJob(key);
        this.d.store.update(key, (r) => {
          r.status = 'finished';
          r.next = 'none';
          r.history.push({ ts: this.clock.now(), text: 'Marked done by you' });
        });
        await this.effects.state(key, 'state', { stage: run.expected.stage });
        break;
      case 'canceled':
        if (s === 'aborted') return;
        if (s === 'finished') throw new EngineError('bad_state', 'This card is already done.');
        await this.abort(key);
        break;
    }
    this.changed();
    this.tickSoon();
  }

  /** `rev` (when given) must be the current plan revision: an approval for a replaced plan is refused. */
  approve(key: string, by: 'human' | 'auto' = 'human', rev?: number, confirmRisks = false, bulk = false): void {
    const run = this.d.store.get(key);
    if (!run || run.status !== 'awaiting_approval') throw new EngineError('bad_state', 'This run is not waiting for approval.');
    if (rev !== undefined && rev !== run.rev) throw new EngineError('stale', 'This plan was replaced by a newer revision — review it and approve again.');
    if (by === 'human' && run.risks?.length && !confirmRisks) throw new EngineError('confirm_required', `This plan includes risky steps (${run.risks.map((x) => x.rule).join(', ')}). Confirm that you understand them to approve.`);
    this.stages.markApproved(key, by, bulk);
    this.tickSoon();
  }

  async retry(key: string): Promise<void> {
    const run = this.d.store.get(key);
    if (!run) throw new EngineError('missing', 'Unknown run.');
    if (!['needs_human', 'failed', 'ready', 'aborted', 'finished', 'parked', 'paused', 'awaiting_approval'].includes(run.status)) {
      throw new EngineError('bad_state', 'This run is already working.');
    }
    this.failCounts.delete(key);
    if (run.status === 'parked') {
      throw new EngineError('bad_state', 'This card is parked in Backlog. Move it to To do to continue — Conductor never moves your cards out of Backlog itself.');
    }
    if (run.status === 'failed') {
      // an internal hiccup: retry the same step, don't throw the work away
      this.d.store.update(key, (r) => {
        r.status = 'queued';
        r.lastError = undefined;
        r.history.push({ ts: this.clock.now(), text: 'Retrying after an internal error (requested by you)' });
      });
      this.tickSoon();
      return;
    }
    await this.rerunFromHuman(key);
  }

  resume(key: string): void {
    const run = this.d.store.get(key);
    if (!run) throw new EngineError('missing', 'Unknown run.');
    if (run.status === 'paused') {
      // M8-3: clear ONLY the pauses of the accounts this run's role may use (chain tools + its complexity pick), never everyone's
      const role = this.roleFor(run);
      const cfg = this.d.getConfig();
      const tools = new Set<ProviderId>(role ? [...cfg.roles[role].providers, ...Object.values(cfg.roles[role].autoByComplexity ?? {})] : PROVIDER_IDS);
      for (const k of [...this.pauses.keys()]) if (tools.has(k.slice(0, k.indexOf(':')) as ProviderId)) this.pauses.delete(k);
      this.d.store.update(key, (r) => {
        r.status = 'queued';
        r.pausedUntil = undefined;
        r.history.push({ ts: this.clock.now(), text: 'Resumed manually' });
      });
    } else if (run.status === 'parked') {
      throw new EngineError('bad_state', 'This card is parked in Backlog. Move it to To do to continue — Conductor never moves your cards out of Backlog itself.');
    } else throw new EngineError('bad_state', 'Nothing to resume.');
    this.tickSoon();
  }

  async abort(key: string): Promise<void> {
    const run = this.d.store.get(key);
    if (!run) throw new EngineError('missing', 'Unknown run.');
    if (run.status === 'finished' || run.status === 'aborted') return; // already over: nothing to stop
    await this.stopJob(key);
    this.d.store.update(key, (r) => {
      r.status = 'aborted';
      r.next = 'none';
      r.history.push({ ts: this.clock.now(), text: 'Aborted from the dashboard' });
      Effects.enqueue(r, 'state', { kind: 'state', payload: { stage: r.expected.stage } });
      Effects.enqueue(r, `abort:${this.clock.now()}`, { kind: 'comment', payload: { body: '🤖 **Conductor stopped** this run at your request. Move the card to **To do** to start it again.' } });
    });
    await this.effects.flush(key);
    this.changed();
  }

  /**
   * Push one done ticket. Stays on the branch already checked out: no checkout, no new branch, no merge.
   * The commit contains only the files this ticket's commits changed, and its author is the person's git identity.
   */
  async push(key: string): Promise<void> {
    const run = this.d.store.get(key);
    if (!run) throw new EngineError('missing', 'Unknown run.');
    if (run.status !== 'ready' && run.status !== 'finished') throw new EngineError('bad_state', 'Only a done card can be pushed.');
    if (run.pushedAt && run.pushedSha) return;
    const repo = this.d.getConfig().repos.find((r) => r.name === run.repo);
    if (!repo) throw new EngineError('bad_repo', 'This card’s repository is not registered.');
    const shas = new Set<string>();
    if (run.commitSha) shas.add(run.commitSha);
    for (const item of run.graph?.items ?? []) if (item.commitSha) shas.add(item.commitSha);
    const pushed = await pushTicket({ repoPath: repo.path, key: run.key, title: run.title, shas: [...shas] });
    if (!pushed.ok) throw new EngineError('push_failed', pushed.detail);
    const { result } = pushed;
    this.d.store.update(key, (r) => {
      const map = result.replacements;
      if (r.commitSha && map[r.commitSha]) r.commitSha = map[r.commitSha];
      for (const item of r.graph?.items ?? []) if (item.commitSha && map[item.commitSha]) item.commitSha = map[item.commitSha];
      r.pushedAt = this.clock.now();
      r.pushedSha = result.sha;
      r.history.push({
        ts: this.clock.now(),
        text: `Pushed ${result.branch} as you. The commit has only this ticket’s files (${result.files.length}). The branch was not changed.`,
      });
    });
    this.changed();
  }

  async cleanup(key: string): Promise<void> {
    const run = this.d.store.get(key);
    if (!run) throw new EngineError('missing', 'Unknown run.');
    if (!['ready', 'finished', 'aborted'].includes(run.status)) throw new EngineError('bad_state', 'Only finished runs can be cleaned up.');
    const repo = this.d.getConfig().repos.find((r) => r.name === run.repo);
    if (repo && run.worktree) {
      await W.assertOwnedWorktree(repo, run.key, run.worktree, this.d.getConfig().worktreeRoot).catch((e) => {
        throw new EngineError('foreign_worktree', errMsg(e));
      });
      if (await W.isRepoCheckout(repo.path, run.worktree)) {
        this.d.store.update(key, (r) => {
          r.worktree = '';
          r.history.push({ ts: this.clock.now(), text: 'Left the commits on the repository’s current branch' });
        });
        return;
      }
      const { branchKept } = await W.removeWorktree(repo.path, run.worktree, run.branch, { deleteBranch: true }); // git refuses to delete an unmerged branch: the work is kept
      this.d.store.update(key, (r) => {
        r.worktree = '';
        r.history.push({ ts: this.clock.now(), text: branchKept ? 'Worktree removed (the branch is kept: it is not merged yet)' : 'Worktree removed (merged branch deleted)' });
      });
    }
  }

  setPaused(paused: boolean, reason?: string): void {
    this.globalPaused = paused;
    this.pauseReason = paused ? reason ?? 'Paused from the dashboard' : undefined;
    this.changed();
    if (!paused) this.tickSoon();
  }

  async createTask(input: { title: string; description?: string; repo?: string }): Promise<{ key: string; url: string }> {
    const cfg = this.d.getConfig();
    const repoName = input.repo?.trim();
    if (repoName && !cfg.repos.some((r) => r.name === repoName)) throw new EngineError('bad_repo', `"${repoName}" is not a registered repository.`);
    if (!repoName && cfg.repos.length !== 1) throw new EngineError('bad_repo', 'Choose which repository this task is for.');
    const repo = repoName ?? cfg.repos[0]!.name;
    const project = this.ensureProjectForRepo(repo);
    try {
      const item = this.board.user.createItem({ projectId: project.id, title: input.title.trim().slice(0, 200), description: input.description ?? '', lane: 'todo' });
      this.tickSoon();
      return { key: item.key, url: '' };
    } catch (e) {
      if (e instanceof BoardError) throw new EngineError(e.code, e.message);
      throw e;
    }
  }

  // ───────────────────────── introspection ─────────────────────────
  status() {
    const now = this.clock.now();
    // compat: a provider counts as paused only while ALL its enabled accounts are, until the earliest of them
    const pp: Partial<Record<ProviderId, { until: number; reason: string }>> = {};
    const cfg = this.d.getConfig();
    for (const a of PROVIDER_IDS) {
      const ids = (cfg.accounts?.[a] ?? [{ id: DEFAULT_ACCOUNT }]).map((m) => m.id).filter((id) => id === DEFAULT_ACCOUNT || (a !== 'codex' && !this.accountUnavailable.has(`${a}:${id}`)));
      const ps = ids.map((id) => this.activePause(`${a}:${id}`));
      if (ps.length && ps.every((p) => p !== null)) pp[a] = (ps as { until: number; reason: string }[]).reduce((x, y) => (y.until < x.until ? y : x));
    }
    const claudeHead = cfg.accounts?.claude?.[0]?.id ?? DEFAULT_ACCOUNT;
    const storageProblem = this.effects.storageProblem();
    return {
      paused: this.globalPaused,
      pauseReason: this.pauseReason,
      providerPause: pp,
      running: this.jobs.size,
      maxParallel: this.d.getConfig().pipeline.maxParallel,
      lastPollAt: this.lastPollAt,
      offline: this.probe.last()?.state === 'offline' && this.clock.now() - (this.probe.last()?.at ?? 0) < 60_000,
      lastPollError: storageProblem,
      storageProblem,
      pollSeconds: TICK_MS / 1000,
      ignored: [...this.ignored],
      now,
      quota: { claude: this.quotaMap.get(`claude:${claudeHead}`) },
    };
  }
  isRunning(key: string): boolean {
    return this.jobs.has(key);
  }
}

export class EngineError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}
