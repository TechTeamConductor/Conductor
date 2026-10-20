import { join } from 'node:path';
import type { ProviderId, Config, NextStep, RepoConfig, Run } from '../types.ts';
import type { RunStore } from '../store.ts';
import { newRun } from '../store.ts';
import type { PersistentState } from '../config.ts';
import { loadState, saveState } from '../config.ts';
import type { Agents } from '../agents/provider.ts';
import type { EmitEvent } from '../agents/claude.ts';
import { errMsg, sha1, systemClock, truncate, slug, type Clock } from '../util.ts';
import { loadEnvSecrets, redact } from '../redact.ts';
import { logger } from '../log.ts';
import { notify as defaultNotify } from '../notify.ts';
import * as W from '../git/worktree.ts';
import { BRANCH_PREFIX } from '../git/worktree.ts';
import type { Board, Project, WorkItem } from '../board/index.ts';
import { BoardError } from '../board/index.ts';
import { laneForRun } from '../board/lanes.ts';
import { Effects } from './effects.ts';
import { graphBudgets, nextBuildRole, projectItemLane } from './graph.ts';
import { Semaphore } from './semaphore.ts';
import { ContextService, type ContextLike } from '../context/service.ts';
import type { PipelineCtx } from './context.ts';
import { Stages } from './stages.ts';
import { PROVIDER_IDS, capabilitiesOf, providerLabel } from '../agents/providers/registry.ts';
import { effectiveReadOnlyTier, readOnlyTier } from '../agents/providers/verification.ts';
import { currentCodexBinding } from '../agents/providers/codex.ts';
import { CANARY_VERSION } from '../agents/providers/canary.ts';
import { route, type ProviderState, type States } from '../agents/routing.ts';
import { resolveBin } from '../config.ts';
import type { Role } from '../agents/roles.ts';

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
  private pauses = new Map<ProviderId, { until: number; reason: string }>();
  private globalPaused = false;
  private pauseReason: string | undefined;
  private lastPollAt: number | null = null;
  private ignored: { key: string; reason: string }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private tickAgain = false;
  private stopped = true;
  private failCounts = new Map<string, number>();
  private quotaMap = new Map<ProviderId, { utilization7d?: number; utilization5h?: number; resetsAt?: number; rejected?: boolean }>();
  private envSecretCache = new Map<string, { at: number; vals: string[] }>();
  private changeListeners = new Set<() => void>();
  private unsubBoard: (() => void) | null = null;
  /** The ONE cap on concurrent read-only analysis calls across all runs (task graphs). */
  private analysisSem = new Semaphore(() => this.d.getConfig().pipeline.readOnlyParallel);
  private context!: ContextLike;
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
    this.context = deps.context ?? new ContextService({ board: deps.board, getConfig: deps.getConfig, now: () => this.clock.now() });
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
      routeStates: () => this.routeStates(),
      freshHealth: () => this.freshHealth(),
      providerPause: (agent, until, reason) => {
        // a pause derived from a CLI limit message is capped at 24 h (a hostile or buggy message cannot park a provider for months); a human can resume any time
        this.pauses.set(agent, { until: Math.min(until, this.clock.now() + PAUSE_CEILING_MS), reason });
        this.changed();
      },
      pausedUntil: (agent) => this.activePause(agent),
      tickSoon: () => this.tickSoon(),
      analysisSlot: (signal) => this.analysisSem.acquire(signal),
      context: this.context,
      recordQuota: (agent, q) => {
        this.quotaMap.set(agent, { utilization7d: q.utilization7d, utilization5h: q.utilization5h, resetsAt: q.resetsAt, rejected: q.status === 'rejected' });
        this.changed();
      },
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

  /** The router's view of every provider: capabilities derived from code, tier, CLI-reported health/auth, CLI-reported pauses. */
  routeStates(): States {
    const cfg = this.d.getConfig();
    const health = this.healthSource?.() ?? {};
    const out = {} as Record<ProviderId, ProviderState>;
    for (const id of PROVIDER_IDS) {
      const bin = (cfg.agents as Record<string, { bin: string } | undefined>)[id]?.bin;
      const h = Object.hasOwn(health, id) ? health[id] : undefined;
      out[id] = {
        caps: capabilitiesOf(this.d.agents.provider(id)),
        // code constant, adjusted by the add-only canary records (a pass counts only while the install still matches what was tested)
        tier: id === 'codex' ? effectiveReadOnlyTier('codex', currentCodexBinding(cfg.agents.codex.bin, h?.version, CANARY_VERSION)) : readOnlyTier(id),
        installed: (bin ? resolveBin(bin) !== null : true) && h?.found !== false,
        auth: h?.loggedIn === false ? 'not-logged-in' : h?.loggedIn === true ? 'ok' : 'unknown',
        pausedUntil: this.activePause(id)?.until ?? null,
      };
    }
    return out;
  }

  private activePause(agent: ProviderId): { until: number; reason: string } | null {
    const p = this.pauses.get(agent);
    if (!p) return null;
    if (p.until <= this.clock.now()) {
      this.pauses.delete(agent);
      return null;
    }
    return p;
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
      branch: `${BRANCH_PREFIX}${slug(item.key)}`,
      worktree: '',
      baseSha: '',
      loopBudget: cfg.pipeline.maxLoops,
    };
    try {
      this.d.store.create({ ...newRun(seed), untrusted: item.createdBy === 'import' ? true : undefined });
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
        if (!keepCommits) await W.resetToBase(run0.worktree, run0.baseSha);
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
    this.d.store.update(key, (r) => {
      const now = this.clock.now();
      r.restartTimes = [...recent, nowT];
      r.agentRuns = 0; // a human restart is a fresh budget (otherwise the per-card cap becomes a dead end)
      r.buildFails = 0;
      r.limitStreak = 0;
      r.limitEpisode = 0;
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

  /** The run waits only when EVERY provider that may take its next step is at a usage limit (v1 semantics, now chain-aware). */
  private blockedByPause(run: Run): { until: number } | null {
    const role = this.roleFor(run);
    if (!role) return null;
    const r = route({ role, complexity: run.complexity, roles: this.d.getConfig().roles, states: this.routeStates(), now: this.clock.now(), label: providerLabel });
    return !r.ok && r.kind === 'paused' ? { until: r.pauseUntil } : null;
  }

  schedule(): void {
    if (this.globalPaused) return;
    const cfg = this.d.getConfig();
    const now = this.clock.now();
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
      const waitingPause = r.status === 'paused' && (r.pausedUntil ?? 0) > now;
      if (r.status !== 'queued' && !(r.status === 'paused' && !waitingPause)) continue;
      const blocked = this.blockedByPause(r);
      if (blocked) {
        if (r.status !== 'paused') {
          this.d.store.update(r.key, (x) => {
            x.status = 'paused';
            x.pausedUntil = blocked.until;
            x.pauseReason = 'Waiting for the usage limit to reset';
          });
        }
        continue;
      }
      if (waitingPause) continue;
      this.startJob(r.key);
    }
  }

  private startJob(key: string): void {
    const ac = new AbortController();
    this.d.store.update(key, (r) => {
      r.status = 'running';
      r.pausedUntil = undefined;
      r.pauseReason = undefined;
      r.stageStartedAt = this.clock.now();
    });
    const promise = this.runJob(key, ac)
      .catch((e) => this.failRun(key, e))
      .finally(() => {
        this.jobs.delete(key);
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
  approve(key: string, by: 'human' | 'auto' = 'human', rev?: number): void {
    const run = this.d.store.get(key);
    if (!run || run.status !== 'awaiting_approval') throw new EngineError('bad_state', 'This run is not waiting for approval.');
    if (rev !== undefined && rev !== run.rev) throw new EngineError('stale', 'This plan was replaced by a newer revision — review it and approve again.');
    this.stages.markApproved(key, by);
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
      this.pauses.clear();
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

  async cleanup(key: string): Promise<void> {
    const run = this.d.store.get(key);
    if (!run) throw new EngineError('missing', 'Unknown run.');
    if (!['ready', 'finished', 'aborted'].includes(run.status)) throw new EngineError('bad_state', 'Only finished runs can be cleaned up.');
    const repo = this.d.getConfig().repos.find((r) => r.name === run.repo);
    if (repo && run.worktree) {
      await W.assertOwnedWorktree(repo, run.key, run.worktree, this.d.getConfig().worktreeRoot).catch((e) => {
        throw new EngineError('foreign_worktree', errMsg(e));
      });
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
    const pp: Partial<Record<ProviderId, { until: number; reason: string }>> = {};
    for (const a of PROVIDER_IDS) {
      const p = this.activePause(a);
      if (p) pp[a] = p;
    }
    const storageProblem = this.effects.storageProblem();
    return {
      paused: this.globalPaused,
      pauseReason: this.pauseReason,
      providerPause: pp,
      running: this.jobs.size,
      maxParallel: this.d.getConfig().pipeline.maxParallel,
      lastPollAt: this.lastPollAt,
      lastPollError: storageProblem,
      storageProblem,
      pollSeconds: TICK_MS / 1000,
      ignored: [...this.ignored],
      now,
      quota: { claude: this.quotaMap.get('claude') },
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
