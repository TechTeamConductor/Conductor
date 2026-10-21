// "Design the work" (F3) and the Deep Research brief (F4), M8-6. One line in, a reviewed brief out; nothing reaches the board until the user
// presses Send. Cards made from a brief are authored by the server-only actor `design` (TAINTED ⇒ forced plan approval under every policy
// and run mode). Research keeps living in the asks store; this service only writes the brief and starts the existing web-only research.
//
// Hard rules (plan §2b/§2c — see .techteam/plans/workspace-v2-m8-6.md):
//  - model calls are read-only (`callAgent` → `Agents.readOnly`), never queued, never auto-retried beyond callAgent's one corrective re-ask;
//  - the research brief runs on Claude ONLY (`onlyProviders`, S3), with the question only, in an empty scratch dir (no repository text);
//  - `selRole` is a CODE CONSTANT here (S2/N1) — model/effort selection only;
//  - every model string is shaped → capped → redacted with the repo's real secret values (S7) before it is stored;
//  - Send carries part ids (work) or a depth (research) only; card text always comes from the stored, re-validated record;
//  - the send state machine is write-ahead + idempotent (B2/S8); logs carry ids, counts and durations only (S12).
import { lstatSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Agents } from '../agents/provider.ts';
import { callAgent } from '../agents/caller.ts';
import { route, type States } from '../agents/routing.ts';
import { effectiveLimitRule } from '../accounts/limit-rule.ts';
import { providerLabel } from '../agents/providers/registry.ts';
import type { Config, LimitInfo, RepoConfig } from '../types.ts';
import { GitReader } from '../context/gitread.ts';
import { liveFacts } from '../context/live.ts';
import { buildPack } from '../context/pack.ts';
import { refund, takeKeyed, used } from '../limits/budget.ts';
import { redact } from '../redact.ts';
import { fence, loadTemplate, preamble, render } from '../pipeline/prompts.ts';
import { sanitizeLine } from '../pipeline/graph.ts';
import { isProtectedPath } from '../git/worktree.ts';
import { SECRET_FILE } from '../policy/rules.ts';
import { errMsg, truncate } from '../util.ts';
import { logger } from '../log.ts';
import { buildSnapshot, removeSnapshot, SnapshotTooLarge, type Snapshot } from '../asks/snapshot.ts';
import { AskError, type AskService } from '../asks/service.ts';
import { ASK_LIMITS } from '../asks/store.ts';
import { RESEARCH_BRIEF_SCHEMA, WORK_BRIEF_SCHEMA, shapeResearchBrief, shapeWorkBrief, validateResearchBrief, validateWorkBrief, type FileFacts } from './schemas.ts';
import { cardDescription, DESC_MAX, DESIGN_IDEM_RE, planCards } from './cards.ts';
import { BRIEF_LIMITS, deleteBrief, listBriefs, loadBrief, newBriefId, saveBrief } from './store.ts';
import { BRIEF_ID_RE, MAX_PARTS, PART_ID_RE, type BriefRecord, type BriefStep, type BriefSummary, type BriefView, type Depth, type StepId } from './types.ts';

const log = logger('briefs');
/** At most two briefs are written at once (code constant, §2.8). */
export const MAX_RUNNING_BRIEFS = 2;
/** S2/N1: the research brief's model/effort row — a CODE CONSTANT, never read from a request. */
const RESEARCH_BRIEF_SEL_ROLE = 'research' as const;
/** S3: the research brief's text goes into a web-enabled session, so only Claude's fail-closed, cwd-confined read-only profile may write it. */
const RESEARCH_BRIEF_PROVIDERS = ['claude'] as const;
export const SCRATCH_PREFIX = 'conductor-brief-';
const SWEEP_PREFIXES = ['conductor-ask-', 'conductor-research-', SCRATCH_PREFIX];
/**
 * Security F4: the sweep shares os.tmpdir() with other Conductor homes (desktop app, CLI, tests). A Deep research with its one re-run can
 * last 2 × 35 min, so only folders untouched for more than 3 hours are removed.
 */
const SWEEP_AGE_MS = 3 * 60 * 60_000;
const RESEARCH_NEEDS_CLAUDE = 'The research brief needs Claude: it is not available for the Context job right now (check Settings → Who does what, or sign in to Claude).';

/** Step labels = the design's STEPS wording (`.techteam/design/v16/Main.dc.html`). */
const LABELS: Record<'work' | 'research', Partial<Record<StepId, string>>> = {
  work: { scan: 'Checking your request against the repo', brief: 'Writing the detailed brief', parts: 'Splitting it into tasks' },
  research: { scan: 'Checking the repo for context', brief: 'Writing the research brief' },
};

export class BriefError extends Error {
  code: string;
  status: number;
  extra?: Record<string, unknown>;
  constructor(code: string, message: string, status = 400, extra?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export interface LinkedCardInput { repo: string; title: string; description: string; dependsOn: string[]; idemKey: string }
export interface BriefDeps {
  getConfig: () => Config;
  agents: Agents;
  routeStates: () => States;
  freshHealth: () => Promise<void>;
  /** S7: the values the engine redacts for that repository (copyFiles env values + the injected secret store). */
  secrets: (repo: string | null) => string[];
  now?: () => number;
  networkState?: () => Promise<'online' | 'offline' | 'unknown'>;
  /** Research send (F4): the asks service (`startResearchFromBrief` / `findByBriefId`). */
  asks?: Pick<AskService, 'startResearchFromBrief' | 'findByBriefId'>;
  /**
   * The runtime facade (S9): creates a card with the actor FIXED to `design` and the field list fixed (kind work, lane todo, parentId null,
   * autoStart true). `precheck` throws a BoardError-like `{code}` when the project is archived or the board cannot take `count` cards.
   */
  cards?: {
    createLinked(i: LinkedCardInput): { id: string; key: string };
    precheck(repo: string, count: number, bytes: number): void;
    baseBranch(repo: string): string;
  };
  /** M8-3 accounts gate (absent until M8-3 lands ⇒ the route/pause fallback, C3). */
  accountsGate?: (role: 'requirements' | 'context') => { ok: true } | { ok: false; retryAt: number | null; message: string };
  /** M8-3 (code review B1): record a usage-limit pause on the account a mid-call hop left. */
  accountPause?: (ref: { provider: import('../agents/providers/types.ts').ProviderId; id: string }, until: number, reason: string) => void;
  /** Test seam: called at named points (`send:after-card-<n>`); a test may throw. */
  fault?: (point: string) => void;
  /** Scratch parent (default `os.tmpdir()`); snapshot/scratch dirs are made here with the owned prefix. */
  scratchParent?: string;
}

interface Running { ac: AbortController; promise: Promise<void>; scratch: string | null; /** M8-3: the account of the current attempt (removal ⇒ abort) */ account?: string; removed?: boolean }

export class BriefService {
  private d: BriefDeps;
  private running = new Map<string, Running>();
  private sendLocks = new Set<string>();
  private researchSends = new Map<string, Promise<{ briefId: string; askId: string }>>();
  private closing = false;
  /** N8: briefId → number of parts sent, for the board's `design{}` origin (lazily rebuilt; dropped entries on delete). */
  private partsCount: Map<string, number> | null = null;

  constructor(deps: BriefDeps) {
    this.d = deps;
  }
  private now(): number {
    return (this.d.now ?? Date.now)();
  }
  private parent(): string {
    return this.d.scratchParent ?? tmpdir();
  }

  // ───────────────────────────── start ─────────────────────────────

  /** POST /api/briefs: validate, gate, count, record, start. Returns at once (202); the brief arrives later. */
  start(input: { kind: unknown; line: unknown; repo?: unknown }): BriefView {
    if (input.kind !== 'work' && input.kind !== 'research') throw new BriefError('bad_request', '"kind" must be work or research.');
    const kind = input.kind;
    if (typeof input.line !== 'string') throw new BriefError('bad_request', '"line" is required.');
    if (input.line.length > BRIEF_LIMITS.line) throw new BriefError('bad_request', `"line" is too long (max ${BRIEF_LIMITS.line} characters).`);
    const line = sanitizeLine(input.line, BRIEF_LIMITS.line);
    if (!line) throw new BriefError('bad_request', '"line" is required.');
    const cfg = this.d.getConfig();
    let repo: RepoConfig | undefined;
    if (input.repo !== undefined && input.repo !== null && input.repo !== '') {
      if (typeof input.repo !== 'string') throw new BriefError('bad_request', '"repo" must be a registered repository name.');
      repo = cfg.repos.find((r) => r.name === input.repo);
      if (!repo) throw new BriefError('bad_request', 'Unknown repository.');
    } else if (kind === 'work') {
      if (cfg.repos.length === 1) repo = cfg.repos[0];
      else throw new BriefError('choose_repo', cfg.repos.length ? 'Pick the repository this change is for.' : 'Register a repository first.', 400, { repos: cfg.repos.map((r) => r.name) });
    } // research: the repo is optional (needed only to turn the report into work, N13)
    if (cfg.agents.claude.isolation !== 'safe-mode') throw new BriefError('isolation', kind === 'work' ? "Design the work needs Claude's safe-mode isolation (project settings and hooks would be loaded from the snapshot otherwise)." : "Deep Research needs Claude's safe-mode isolation.", 409);
    if (kind === 'research' && used('researchPerDay', { now: this.now() }) + 1 > cfg.pipeline.researchPerDay) {
      // AC-6.9: refused BEFORE a brief call is spent
      throw new BriefError('limit', `researchPerDay: you reached today's limit of ${cfg.pipeline.researchPerDay} research runs.`, 429);
    }
    if (this.running.size >= MAX_RUNNING_BRIEFS) throw new BriefError('busy', 'Two briefs are already being written — try again in a moment.', 429);
    const role = kind === 'work' ? 'requirements' : 'context';
    this.gate(role, kind);
    const t = takeKeyed('designPerHour', cfg.pipeline.designPerHour, { now: this.now() });
    if (!t.ok) throw new BriefError('limit', `designPerHour: you reached the limit of ${cfg.pipeline.designPerHour} briefs per hour.`, 429);
    const steps: BriefStep[] = (kind === 'work' ? (['scan', 'brief', 'parts'] as const) : (['scan', 'brief'] as const)).map((id, i) => ({ id, label: LABELS[kind][id]!, state: i === 0 ? 'running' : 'pending', detail: '' }));
    const rec: BriefRecord = { schemaVersion: 1, id: newBriefId(), kind, line, repo: repo?.name ?? null, status: 'running', steps, handledBy: null, scan: null, sent: null, error: null, takenKey: t.key, events: [], createdAt: this.now(), updatedAt: this.now() };
    saveBrief(rec);
    const ac = new AbortController();
    const started = this.now();
    const run: Running = { ac, scratch: null, promise: Promise.resolve() };
    run.promise = (kind === 'work' ? this.runWork(rec.id, repo!, ac, run) : this.runResearchBrief(rec.id, ac, run))
      .catch((e) => log.warn(`${rec.id}: ${truncate(errMsg(e).replace(/\s+/g, ' '), 120)}`))
      .finally(() => {
        this.running.delete(rec.id);
        log.info(`${rec.id}: ${kind} brief ${loadBrief(rec.id)?.status ?? 'deleted'} in ${this.now() - started} ms`);
      });
    this.running.set(rec.id, run);
    return this.view(rec);
  }

  /** S3: is Claude an eligible candidate (healthy, or only paused) on the Context chain? */
  private claudeCanWriteResearchBrief(): boolean {
    const r = route({ role: 'context', roles: this.d.getConfig().roles, states: this.d.routeStates(), now: this.now(), label: providerLabel });
    return r.ok ? r.candidates.some((c) => c.id === 'claude') : r.kind === 'paused' && r.provider === 'claude';
  }

  /** C3: a Home call never queues. Limited ⇒ 409 `limited` + `retryAt`, no record, no counter. */
  private gate(role: 'requirements' | 'context', kind: 'work' | 'research'): void {
    if (this.d.accountsGate) {
      const g = this.d.accountsGate(role);
      if (!g.ok) throw new BriefError('limited', g.message, 409, { retryAt: g.retryAt });
      return;
    }
    const cfg = this.d.getConfig();
    const states = this.d.routeStates();
    const now = this.now();
    if (kind === 'research') {
      const until = states.claude?.pausedUntil ?? null;
      if (until !== null && until > now) throw new BriefError('limited', `${providerLabel('claude')} is at its usage limit.`, 409, { retryAt: until });
      if (!this.claudeCanWriteResearchBrief()) throw new BriefError('needs_claude', RESEARCH_NEEDS_CLAUDE, 409);
      return;
    }
    const r = route({ role, roles: cfg.roles, states, now, label: providerLabel });
    if (!r.ok && r.kind === 'paused') throw new BriefError('limited', `${providerLabel(r.provider)} is at its usage limit.`, 409, { retryAt: r.pauseUntil });
  }

  private patch(id: string, fn: (r: BriefRecord) => void): BriefRecord | null {
    const r = loadBrief(id);
    if (!r || r.status === 'canceled') return r;
    fn(r);
    r.updatedAt = this.now();
    saveBrief(r);
    return r;
  }
  private step(r: BriefRecord, id: StepId, state: BriefStep['state'], detail?: string): void {
    const s = r.steps.find((x) => x.id === id);
    if (s) {
      s.state = state;
      if (detail !== undefined) s.detail = sanitizeLine(detail, 300);
    }
  }
  private eventSink(events: string[], secrets: string[]) {
    return (ev: { agent: string; kind: string; text?: string }) => {
      if (ev.text && ev.kind !== 'thinking' && events.length < BRIEF_LIMITS.events) events.push(sanitizeLine(redact(`${ev.agent}: ${ev.text}`, secrets), BRIEF_LIMITS.eventChars));
    };
  }
  /** End states shared by both kinds. `refundable` ⇒ a structural limit end (S11): the counter this brief took is given back once. */
  private fail(id: string, why: string, secrets: string[], opts: { kind?: 'limited' | 'failed' | 'interrupted'; retryAt?: number | null; events?: string[]; refund?: boolean } = {}): void {
    this.patch(id, (r) => {
      r.status = 'failed';
      r.error = truncate(redact(sanitizeLine(why, BRIEF_LIMITS.error), secrets), BRIEF_LIMITS.error);
      r.errorKind = opts.kind ?? 'failed';
      if (opts.retryAt !== undefined) r.retryAt = opts.retryAt;
      for (const s of r.steps) if (s.state === 'running') s.state = 'failed';
      if (opts.events) r.events = opts.events;
      if ((opts.kind === 'limited' || opts.refund === true) && r.takenKey && !r.refunded) {
        refund('designPerHour', { key: r.takenKey });
        r.refunded = true;
      }
    });
  }
  /** M8-3 (code review B1): a mid-call hop past a limited account records that ACCOUNT's pause (later stages and asks skip it). */
  private pauseFromLimit(l: LimitInfo): void {
    if (!l.account || !this.d.accountPause) return;
    const now = this.now();
    this.d.accountPause({ provider: l.provider, id: l.account }, l.resetsAt && l.resetsAt > now ? l.resetsAt : now + 15 * 60_000, l.message);
  }
  /** M8-3 S8 step 2: abort and await every brief call running on a removed account; each ends failed "the account was removed", refunded. */
  async abortAccount(ref: { provider: string; id: string }): Promise<number> {
    const k = `${ref.provider}:${ref.id}`;
    const hit = [...this.running.values()].filter((r) => r.account === k);
    for (const r of hit) {
      r.removed = true;
      r.ac.abort();
    }
    await Promise.allSettled(hit.map((r) => r.promise));
    return hit.length;
  }
  private aborted(id: string, secrets: string[]): void {
    const run = this.running.get(id);
    if (run?.removed) return this.fail(id, 'The account this was running on was removed. Try again to run it on another account.', secrets, { kind: 'failed', refund: true }); // code review N5: refunded, but not a limit
    if (this.closing) return this.fail(id, 'Interrupted: Conductor was shut down while this brief was being written.', secrets, { kind: 'interrupted' });
    const r = loadBrief(id);
    if (r && r.status === 'running') this.markCanceled(r);
  }
  private markCanceled(r: BriefRecord): void {
    r.status = 'canceled';
    for (const s of r.steps) if (s.state === 'running' || s.state === 'pending') s.state = 'stopped';
    r.updatedAt = this.now();
    saveBrief(r);
  }
  private tierNote(agent: string): string | undefined {
    const tier = this.d.routeStates()[agent as 'claude']?.tier;
    return tier === 'partial' ? `Written by ${providerLabel(agent as 'claude')} in ask mode — weaker isolation than Claude's tool lock-down.` : tier === 'unverified' ? `Written by ${providerLabel(agent as 'claude')} — its isolation has not been verified on this machine.` : undefined;
  }
  /** N10: every model cwd is an owned dir under the scratch parent — checked before the call. */
  private assertOwnedScratch(dir: string): void {
    const parent = resolve(this.parent());
    const abs = resolve(dir);
    if (!abs.startsWith(parent + sep) || !abs.slice(parent.length + 1).startsWith(SCRATCH_PREFIX) || abs.slice(parent.length + 1).includes(sep)) throw new Error('brief cwd is not a Conductor-owned scratch directory');
  }
  private limitedWhy(l: LimitInfo): string {
    const at = l.resetsAt ? ` — try again at ${new Date(l.resetsAt).toTimeString().slice(0, 5)}` : ' — try again later';
    return `${providerLabel(l.provider as 'claude')} is at its usage limit${at}.`;
  }

  private async runWork(id: string, repo: RepoConfig, ac: AbortController, run: Running): Promise<void> {
    const secrets = this.d.secrets(repo.name);
    let snap: Snapshot | null = null;
    const events: string[] = [];
    try {
      const rec = loadBrief(id)!;
      const git = new GitReader(repo.path);
      const { commit } = await git.resolveBranch(repo.baseBranch);
      snap = await buildSnapshot(git, commit, { parent: this.parent(), prefix: SCRATCH_PREFIX, tooLarge: 'too large for Design the work — describe the change as a task instead' });
      run.scratch = snap.dir;
      this.assertOwnedScratch(snap.dir);
      if (ac.signal.aborted) return this.aborted(id, secrets);
      const notes = [snap.symlinks ? `${snap.symlinks} symlink(s) omitted` : '', snap.omittedConfig ? 'agent configuration omitted' : '', snap.skippedLarge ? `${snap.skippedLarge} large file(s) skipped` : ''].filter(Boolean);
      const sha = commit.slice(0, 7);
      this.patch(id, (r) => {
        r.scan = { repo: repo.name, branch: sanitizeLine(repo.baseBranch, 200), sha, snapshotFiles: snap!.files, ...(notes.length ? { note: notes.join('; ') } : {}) };
        this.step(r, 'scan', 'done', `${repo.name} · ${repo.baseBranch} @ ${sha} · ${snap!.files} files in the snapshot`);
        this.step(r, 'brief', 'running');
      });
      let projectFacts = '';
      try {
        const live = await liveFacts({ name: repo.name, path: repo.path, baseBranch: repo.baseBranch, gates: repo.gates }, commit);
        projectFacts = fence('project-facts', buildPack({ facts: live.facts, consumer: 'readonly', task: rec.line, commit, branch: repo.baseBranch }).text, 40_000);
      } catch (e) {
        log.warn(`${id}: no project facts (${truncate(errMsg(e).replace(/\s+/g, ' '), 80)})`);
      }
      const basis = `${repo.baseBranch} @ ${sha}`;
      const prompt = render(loadTemplate('design-work'), { preamble: preamble('design'), basis, projectFacts, request: fence('user-request', rec.line, BRIEF_LIMITS.line + 100) });
      await this.d.freshHealth();
      let lastErrs: string[] = [];
      let validations = 0;
      const out = await callAgent({
        agents: this.d.agents, role: 'requirements', states: this.d.routeStates(), prompt, schema: WORK_BRIEF_SCHEMA, cwd: snap.dir, rule: effectiveLimitRule(this.d.getConfig()), onLimit: (l) => this.pauseFromLimit(l), onCandidate: (ref) => void (run.account = `${ref.provider}:${ref.id}`),
        validate: (j) => { validations++; lastErrs = validateWorkBrief(j); return lastErrs; },
        secrets, signal: ac.signal, name: `conductor design ${id}`, onEvent: this.eventSink(events, secrets),
      });
      if (out.kind === 'ok') {
        this.patch(id, (r) => { this.step(r, 'brief', 'done'); this.step(r, 'parts', 'running'); });
        const dir = snap.dir;
        const facts: FileFacts = {
          state: (p) => {
            const e = snap!.index.get(p);
            if (e === 'file') {
              // S10: `file` additionally needs a regular file INSIDE the snapshot dir — checked before the snapshot is removed
              const abs = resolve(dir, p);
              try {
                return abs.startsWith(dir + sep) && lstatSync(abs).isFile() ? 'file' : 'omitted';
              } catch {
                return 'omitted';
              }
            }
            return e ? 'omitted' : 'absent';
          },
          isProtected: (p) => isProtectedPath(p),
          isSecretLike: (p) => SECRET_FILE.test(p),
        };
        const work = shapeWorkBrief(out.json, secrets, facts);
        const n = work.parts.length;
        this.patch(id, (r) => {
          r.work = work;
          r.status = 'ready';
          r.handledBy = { provider: out.agent as 'claude', role: 'requirements', ...(this.tierNote(out.agent) ? { tierNote: this.tierNote(out.agent) } : {}) };
          this.step(r, 'parts', 'done', n === 1 ? 'One task is enough' : `${n} tasks, in order`);
          r.events = events;
        });
      } else if (out.kind === 'aborted') {
        this.aborted(id, secrets);
      } else if (out.kind === 'paused') {
        this.pauseFromLimit(out.limit); // M8-3: the limited account is paused (later calls skip it)
        this.fail(id, this.limitedWhy(out.limit), secrets, { kind: 'limited', retryAt: out.limit.resetsAt, events });
      } else if (out.kind === 'offline') {
        this.fail(id, 'There is no network right now — try again when it is back.', secrets, { events });
      } else {
        this.fail(id, validations >= 2 && lastErrs.length ? `The brief did not match the required format: ${lastErrs[0]}` : out.reason, secrets, { events });
      }
    } catch (e) {
      if (ac.signal.aborted) return this.aborted(id, secrets);
      this.fail(id, e instanceof SnapshotTooLarge ? e.message : `Could not write the brief: ${errMsg(e)}`, secrets, { events });
    } finally {
      if (snap) removeSnapshot(snap); // S13: on every outcome
      run.scratch = null;
    }
  }

  private async runResearchBrief(id: string, ac: AbortController, run: Running): Promise<void> {
    const rec0 = loadBrief(id)!;
    const secrets = this.d.secrets(rec0.repo);
    const events: string[] = [];
    // T3: no repository access — an EMPTY owned scratch dir, the question only (no snapshot, no facts, no file names)
    const scratch = mkdtempSync(join(this.parent(), SCRATCH_PREFIX));
    run.scratch = scratch;
    try {
      this.assertOwnedScratch(scratch);
      this.patch(id, (r) => { this.step(r, 'scan', 'done', 'No repository access — research uses the web only'); this.step(r, 'brief', 'running'); });
      // S3: only Claude may write a research brief (checked again here: health can change between the request and the call)
      if (!this.claudeCanWriteResearchBrief()) return this.fail(id, RESEARCH_NEEDS_CLAUDE, secrets, { events });
      const prompt = render(loadTemplate('research-brief'), { preamble: preamble('research_brief'), question: fence('user-question', rec0.line, ASK_LIMITS.question + 100) });
      await this.d.freshHealth();
      let lastErrs: string[] = [];
      let validations = 0;
      const out = await callAgent({
        agents: this.d.agents, role: 'context', selRole: RESEARCH_BRIEF_SEL_ROLE, onlyProviders: RESEARCH_BRIEF_PROVIDERS, states: this.d.routeStates(), prompt, schema: RESEARCH_BRIEF_SCHEMA, cwd: scratch, rule: effectiveLimitRule(this.d.getConfig()), onLimit: (l) => this.pauseFromLimit(l), onCandidate: (ref) => void (run.account = `${ref.provider}:${ref.id}`),
        validate: (j) => { validations++; lastErrs = validateResearchBrief(j, rec0.line); return lastErrs; },
        secrets, signal: ac.signal, name: `conductor research brief ${id}`, onEvent: this.eventSink(events, secrets),
      });
      if (out.kind === 'ok') {
        const brief = shapeResearchBrief(out.json, secrets);
        if (!brief) return this.fail(id, 'The brief did not match the required format.', secrets, { events });
        this.patch(id, (x) => { x.research = brief; x.status = 'ready'; x.handledBy = { provider: 'claude', role: 'context' }; this.step(x, 'brief', 'done'); x.events = events; });
      } else if (out.kind === 'aborted') {
        this.aborted(id, secrets);
      } else if (out.kind === 'paused') {
        this.pauseFromLimit(out.limit); // M8-3: the limited account is paused (later calls skip it)
        this.fail(id, this.limitedWhy(out.limit), secrets, { kind: 'limited', retryAt: out.limit.resetsAt, events });
      } else if (out.kind === 'offline') {
        this.fail(id, 'There is no network right now — try again when it is back.', secrets, { events });
      } else {
        this.fail(id, validations >= 2 && lastErrs.length ? `The brief did not match the required format: ${lastErrs[0]}` : out.reason, secrets, { events });
      }
    } catch (e) {
      if (ac.signal.aborted) return this.aborted(id, secrets);
      this.fail(id, `Could not write the research brief: ${errMsg(e)}`, secrets, { events });
    } finally {
      rmSync(scratch, { recursive: true, force: true }); // S13
      run.scratch = null;
    }
  }

  // ───────────────────────────── reads / small mutations ─────────────────────────────

  view(r: BriefRecord): BriefView {
    const { schemaVersion: _v, takenKey: _k, refunded: _r, events: _e, ...rest } = r;
    void _v; void _k; void _r; void _e;
    return { ...rest, untrusted: true };
  }
  get(id: string): BriefView | null {
    if (!BRIEF_ID_RE.test(id)) return null;
    const r = loadBrief(id);
    return r ? this.view(r) : null;
  }
  list(): BriefSummary[] {
    return listBriefs(50).map((r) => ({ id: r.id, kind: r.kind, line: r.line, repo: r.repo, status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt, title: r.work?.title ?? r.research?.title ?? null }));
  }
  cancel(id: string): BriefView | null {
    if (!BRIEF_ID_RE.test(id)) return null;
    const r = loadBrief(id);
    if (!r) return null;
    this.running.get(id)?.ac.abort();
    if (r.status === 'running') this.markCanceled(r);
    return this.view(loadBrief(id) ?? r);
  }
  /** DELETE: refused while `sending` (B2b — the write-ahead must survive); a running brief is aborted first (its snapshot is removed). */
  remove(id: string): boolean {
    if (!BRIEF_ID_RE.test(id)) return false;
    const r = loadBrief(id);
    if (!r) return false;
    if (r.status === 'sending' || this.sendLocks.has(id) || this.researchSends.has(id)) throw new BriefError('bad_state', 'This brief is being sent — wait until it finishes.', 409);
    this.running.get(id)?.ac.abort();
    deleteBrief(id);
    this.partsCount?.delete(id);
    return true;
  }
  /** N8/S15: the board's `design{}` origin for an item, parsed only from a strict `idemKey`. */
  designOrigin(item: { createdBy: string; idemKey?: string }): { briefId: string; part: number; parts: number } | undefined {
    if (item.createdBy !== 'design') return undefined;
    const m = typeof item.idemKey === 'string' ? DESIGN_IDEM_RE.exec(item.idemKey) : null;
    if (!m) return undefined;
    if (!this.partsCount) {
      this.partsCount = new Map();
      for (const r of listBriefs(BRIEF_LIMITS.index)) if (r.sent?.parts?.length) this.partsCount.set(r.id, r.sent.parts.length);
    }
    const parts = this.partsCount.get(m[1]!);
    return parts ? { briefId: m[1]!, part: Number(m[2]), parts } : undefined;
  }
  isRunning(): number {
    return this.running.size;
  }

  // ───────────────────────────── send ─────────────────────────────

  /** POST /api/briefs/:id/send — work: strict `{parts}` (201); research: strict `{depth}` (202, or 200 on replay). */
  async send(id: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
    if (!BRIEF_ID_RE.test(id)) throw new BriefError('not_found', 'Unknown brief.', 404);
    const rec = loadBrief(id);
    if (!rec) throw new BriefError('not_found', 'Unknown brief.', 404);
    if (rec.kind === 'work') {
      for (const k of Object.getOwnPropertyNames(body)) if (k !== 'parts') throw new BriefError('bad_request', `Unknown field "${k.slice(0, 40)}".`);
      return this.sendWork(rec, body.parts);
    }
    for (const k of Object.getOwnPropertyNames(body)) if (k !== 'depth') throw new BriefError('bad_request', `Unknown field "${k.slice(0, 40)}".`);
    if (body.depth !== 'standard' && body.depth !== 'deep') throw new BriefError('bad_request', '"depth" must be standard or deep.');
    return this.sendResearch(rec, body.depth);
  }

  private selection(rec: BriefRecord, raw: unknown): string[] {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_PARTS) throw new BriefError('bad_request', `"parts" must list 1–${MAX_PARTS} part ids.`);
    const ids = new Set<string>();
    for (const p of raw) {
      if (typeof p !== 'string' || !PART_ID_RE.test(p)) throw new BriefError('bad_request', '"parts" holds part ids like P1, P2.');
      if (ids.has(p)) throw new BriefError('bad_request', '"parts" lists a part twice.');
      if (!rec.work?.parts.some((x) => x.id === p)) throw new BriefError('bad_request', `This brief has no part ${p}.`);
      ids.add(p);
    }
    return rec.work!.parts.map((p) => p.id).filter((p) => ids.has(p)); // part order
  }

  /** Work send. From the status check to the write-ahead save there is NO await (S8); the creation loop holds a per-brief lock. */
  private sendWork(rec: BriefRecord, raw: unknown): { status: number; json: unknown } {
    if (!rec.work) throw new BriefError('bad_state', 'This brief has no parts yet.', 409);
    const parts = this.selection(rec, raw);
    const same = (a: readonly string[] = []) => a.length === parts.length && a.every((x, i) => x === parts[i]);
    if (rec.status === 'sent') {
      if (!same(rec.sent?.parts)) throw new BriefError('already_sent', 'This brief was already sent with a different selection.', 409);
      return { status: 201, json: this.sendResult(rec) };
    }
    if (rec.status === 'sending' || rec.status === 'send_failed') {
      if (!same(rec.sent?.parts)) throw new BriefError('already_sent', 'This brief is already being sent with a different selection.', 409);
      return { status: 201, json: this.runSend(rec.id) }; // idempotent replay: adopts the cards already made
    }
    if (rec.status !== 'ready') throw new BriefError('bad_state', 'This brief is not ready to send.', 409);
    if (this.sendLocks.has(rec.id)) throw new BriefError('already_sent', 'This brief is already being sent.', 409);
    // B2c pre-checks BEFORE the write-ahead: repo registered, project not archived, board has room for k cards
    const repo = rec.repo ? this.d.getConfig().repos.find((r) => r.name === rec.repo) : undefined;
    if (!repo) throw new BriefError('bad_repo', 'The repository of this brief is no longer registered.', 409);
    if (!this.d.cards) throw new BriefError('not_available', 'Cards cannot be created here.', 501);
    try {
      this.d.cards.precheck(repo.name, parts.length, parts.length * (DESC_MAX + 200));
    } catch (e) {
      const code = (e as { code?: string }).code;
      throw new BriefError(code === 'archived' ? 'archived' : code === 'full' ? 'full' : 'bad_state', code === 'archived' ? 'The project for this repository is archived.' : code === 'full' ? 'The board has no room for these cards.' : 'The board cannot take these cards right now.', 409);
    }
    rec.status = 'sending';
    rec.sent = { at: this.now(), parts, cards: [] };
    rec.updatedAt = this.now();
    saveBrief(rec); // write-ahead
    return { status: 201, json: this.runSend(rec.id) };
  }

  /** The creation loop (also the boot resume, B2a): cards in part order; already-created ones are adopted via `idemKey`. */
  private runSend(id: string): unknown {
    if (this.sendLocks.has(id)) throw new BriefError('already_sent', 'This brief is already being sent.', 409);
    this.sendLocks.add(id);
    try {
      const rec = loadBrief(id);
      if (!rec || !rec.work || !rec.sent?.parts || !rec.repo) throw new BriefError('bad_state', 'This brief cannot be sent.', 409);
      const cards = this.d.cards;
      if (!cards) throw new BriefError('not_available', 'Cards cannot be created here.', 501);
      const secrets = this.d.secrets(rec.repo);
      if (!this.d.getConfig().repos.some((r) => r.name === rec.repo)) {
        // m1: a resumed or retried send re-checks the repository (it may have been removed since the write-ahead)
        const why = 'The repository of this brief is no longer registered.';
        const cur = loadBrief(id) ?? rec;
        cur.status = 'send_failed';
        cur.sent = { ...(cur.sent ?? { at: this.now() }), cards: cur.sent?.cards ?? [], error: why };
        cur.updatedAt = this.now();
        saveBrief(cur);
        throw new BriefError('send_failed', why, 409, { briefId: id, cards: cur.sent.cards });
      }
      const specs = planCards(rec.work, rec.id, rec.sent.parts);
      const ids = new Map<string, { id: string; key: string }>();
      const made: NonNullable<NonNullable<BriefRecord['sent']>['cards']> = [];
      try {
        const baseBranch = cards.baseBranch(rec.repo);
        for (const spec of specs) {
          const depKeys = spec.deps.map((d) => ids.get(d)!.key);
          const description = redact(cardDescription({ line: rec.line, briefId: rec.id, brief: rec.work, spec, depKeys, baseBranch }), secrets);
          const it = cards.createLinked({ repo: rec.repo, title: redact(spec.title, secrets), description, dependsOn: spec.deps.map((d) => ids.get(d)!.id), idemKey: spec.idemKey });
          ids.set(spec.part, it);
          made.push({ part: spec.part, key: it.key, dependsOn: depKeys });
          this.d.fault?.(`send:after-card-${made.length}`);
        }
      } catch (e) {
        const code = (e as { code?: string }).code;
        const why = code === 'archived' ? 'The project for this repository was archived while sending.' : code === 'full' ? 'The board ran out of room while sending.' : 'The board could not take every card (see the Conductor log).';
        log.warn(`${id}: send stopped after ${made.length} card(s) (${code ?? 'error'})`);
        const cur = loadBrief(id);
        if (cur) {
          cur.status = 'send_failed';
          cur.sent = { ...(cur.sent ?? { at: this.now() }), cards: made, error: truncate(redact(why, secrets), 300) };
          cur.updatedAt = this.now();
          saveBrief(cur);
        }
        throw new BriefError('send_failed', why, 409, { briefId: id, cards: made });
      }
      const cur = loadBrief(id) ?? rec;
      cur.status = 'sent';
      cur.sent = { at: cur.sent?.at ?? this.now(), parts: rec.sent.parts, cards: made };
      cur.updatedAt = this.now();
      saveBrief(cur);
      this.partsCount?.set(id, rec.sent.parts.length);
      log.info(`${id}: sent ${made.length} card(s)`);
      return this.sendResult(cur);
    } finally {
      this.sendLocks.delete(id);
    }
  }

  private sendResult(rec: BriefRecord): { briefId: string; keys: string[]; cards: { part: string; key: string; dependsOn: string[] }[]; plansStarting: number } {
    const cards = rec.sent?.cards ?? [];
    return { briefId: rec.id, keys: cards.map((c) => c.key), cards, plansStarting: cards.filter((c) => c.dependsOn.length === 0).length };
  }

  /** Research send (B2d/S8): `sending` (with depth) is saved BEFORE the first await; a replay adopts the ask stamped with this briefId. */
  private sendResearch(rec: BriefRecord, depth: Depth): Promise<{ status: number; json: unknown }> | { status: number; json: unknown } {
    if (!rec.research) throw new BriefError('bad_state', 'This brief is not ready to send.', 409);
    if (rec.status === 'sent') {
      if (rec.sent?.depth !== depth || !rec.sent.askId) throw new BriefError('already_sent', 'This research was already started with a different depth.', 409);
      return { status: 200, json: { briefId: rec.id, askId: rec.sent.askId } };
    }
    const inflight = this.researchSends.get(rec.id);
    if (rec.status === 'sending' || inflight) {
      if ((rec.sent?.depth ?? depth) !== depth) throw new BriefError('already_sent', 'This research is already being started with a different depth.', 409);
      return (inflight ?? this.startResearchRun(rec.id)).then((j) => ({ status: 200, json: j }));
    }
    if (rec.status !== 'ready') throw new BriefError('bad_state', 'This brief is not ready to send.', 409);
    if (!this.d.asks) throw new BriefError('not_available', 'Deep Research is not available here.', 501);
    rec.status = 'sending';
    rec.sent = { at: this.now(), depth };
    rec.updatedAt = this.now();
    saveBrief(rec); // write-ahead, synchronously
    return this.startResearchRun(rec.id).then((j) => ({ status: 202, json: j }));
  }

  private startResearchRun(id: string): Promise<{ briefId: string; askId: string }> {
    const existing = this.researchSends.get(id);
    if (existing) return existing;
    const p = (async () => {
      const rec = loadBrief(id);
      if (!rec || !rec.research || !rec.sent?.depth) throw new BriefError('bad_state', 'This brief cannot be sent.', 409);
      const asks = this.d.asks;
      if (!asks) throw new BriefError('not_available', 'Deep Research is not available here.', 501);
      let ask = asks.findByBriefId(id); // a crash between start and `sent` ⇒ adopt (one run, one counter)
      if (!ask) {
        try {
          ask = await asks.startResearchFromBrief({ question: rec.line, repo: rec.repo, brief: rec.research, depth: rec.sent.depth, briefId: id });
        } catch (e) {
          // nothing started: back to `ready` (the user can retry); no budget was taken
          const cur = loadBrief(id);
          if (cur && cur.status === 'sending' && !asks.findByBriefId(id)) {
            cur.status = 'ready';
            cur.sent = null;
            cur.updatedAt = this.now();
            saveBrief(cur);
          }
          throw e;
        }
      }
      const cur = loadBrief(id) ?? rec;
      cur.status = 'sent';
      cur.sent = { at: cur.sent?.at ?? this.now(), depth: rec.sent.depth, askId: ask.id };
      cur.updatedAt = this.now();
      saveBrief(cur);
      return { briefId: id, askId: ask.id };
    })().finally(() => this.researchSends.delete(id));
    this.researchSends.set(id, p);
    return p;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  /** Startup: a brief that was being written cannot continue (never re-spawned). `sending` is left to `resumeSending()` (B2a, S13). */
  failInterrupted(): void {
    for (const r of listBriefs(BRIEF_LIMITS.index + 50)) {
      if (r.status !== 'running') continue;
      r.status = 'failed';
      r.errorKind = 'interrupted';
      r.error = 'Interrupted by a restart.';
      for (const s of r.steps) if (s.state === 'running') s.state = 'stopped';
      r.updatedAt = this.now();
      saveBrief(r);
    }
  }
  /** Startup (B2a): finish every `sending` brief through the same replay path a repeated Send uses. Never throws. */
  async resumeSending(): Promise<void> {
    for (const r of listBriefs(BRIEF_LIMITS.index + 50)) {
      if (r.status !== 'sending') continue;
      try {
        if (r.kind === 'work') this.runSend(r.id);
        else await this.startResearchRun(r.id);
      } catch (e) {
        log.warn(`${r.id}: resume of a send ended: ${(e as { code?: string }).code ?? 'error'}`);
        if (r.kind === 'research') {
          const cur = loadBrief(r.id);
          if (cur && cur.status === 'sending' && !this.d.asks?.findByBriefId(r.id)) { cur.status = 'ready'; cur.sent = null; cur.updatedAt = this.now(); saveBrief(cur); }
        }
      }
    }
  }
  /**
   * S13/M5-11: remove user-owned `conductor-ask-` / `conductor-research-` / `conductor-brief-` dirs older than 1 h from the scratch parent
   * (left by a crash). Never follows symlinks; skips anything not owned by this user. Returns how many were removed.
   */
  sweepScratch(): number {
    const parent = this.parent();
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    let n = 0;
    let names: string[] = [];
    try {
      names = readdirSync(parent);
    } catch {
      return 0;
    }
    for (const name of names) {
      if (!SWEEP_PREFIXES.some((p) => name.startsWith(p))) continue;
      if ([...this.running.values()].some((r) => r.scratch && resolve(r.scratch) === resolve(parent, name))) continue;
      const p = join(parent, name);
      try {
        const st = lstatSync(p);
        if (!st.isDirectory() || st.isSymbolicLink() || (uid !== null && st.uid !== uid)) continue;
        if (this.now() - statSync(p).mtimeMs < SWEEP_AGE_MS) continue;
        rmSync(p, { recursive: true, force: true });
        n++;
      } catch {
        /* raced or not ours */
      }
    }
    return n;
  }
  async idle(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map((v) => v.promise));
    await Promise.allSettled([...this.researchSends.values()]);
  }
  /** N10: shutdown ABORTS running briefs, waits for them, and marks them failed (interrupted); their snapshots are removed. */
  async close(): Promise<void> {
    this.closing = true;
    for (const r of this.running.values()) r.ac.abort();
    await this.idle();
  }
}

export { AskError };
