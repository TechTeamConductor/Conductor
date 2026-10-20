import { join } from 'node:path';
import type { AgentName, Config, LinearIssue, LinearPort, NextStep, RepoConfig, Run } from '../types.ts';
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
import { attributeDescription, attributeTrigger, findTriggerLabelOnIssue, hasApproveCommand, hasMarker } from '../linear/attribution.ts';
import { resolveProvisioned, type Provisioned } from '../linear/provision.ts';
import { Effects } from './effects.ts';
import type { PipelineCtx } from './context.ts';
import { Stages } from './stages.ts';

const log = logger('engine');
const TERMINAL = new Set(['finished', 'aborted']);

export interface EngineDeps {
  getConfig: () => Config;
  setConfig?: (cfg: Config) => void;
  store: RunStore;
  linear: () => LinearPort | null;
  agents: Agents;
  clock?: Clock;
  notify?: (title: string, message: string) => void;
  persistent?: { load(): PersistentState; save(s: PersistentState): void };
  /** Extra redaction secrets (e.g. the Linear API key). */
  secrets?: () => string[];
}

type Job = { ac: AbortController; promise: Promise<void> };

export class Engine {
  readonly store: RunStore;
  private d: EngineDeps;
  private clock: Clock;
  private stages: Stages;
  readonly effects: Effects;
  private jobs = new Map<string, Job>();
  private pauses = new Map<AgentName, { until: number; reason: string }>();
  private globalPaused = false;
  private pauseReason: string | undefined;
  private lastPollAt: number | null = null;
  private lastPollError: string | null = null;
  private backoffUntil = 0;
  private backoffStep = 0;
  private ignoredMap = new Map<string, { key: string; reason: string; updatedAt: string }>();
  private provCache: { at: number; value: Provisioned } | null = null;
  private doneState: string | null | undefined;
  private viewer: string | undefined;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private tickAgain = false;
  private stopped = true;
  private failCounts = new Map<string, number>();
  private quotaMap = new Map<AgentName, { utilization7d?: number; utilization5h?: number; resetsAt?: number; rejected?: boolean }>();
  private envSecretCache = new Map<string, { at: number; vals: string[] }>();
  private changeListeners = new Set<() => void>();
  private persistentDeps: { load(): PersistentState; save(s: PersistentState): void };

  constructor(deps: EngineDeps) {
    this.d = deps;
    this.store = deps.store;
    this.clock = deps.clock ?? systemClock;
    this.persistentDeps = deps.persistent ?? { load: loadState, save: saveState };
    this.effects = new Effects({ store: deps.store, linear: deps.linear, secrets: (r) => this.secretsFor(r) });
    this.stages = new Stages(this.makeCtx());
  }

  // ───────────────────────── context for stages ─────────────────────────
  private makeCtx(): PipelineCtx {
    return {
      cfg: () => this.d.getConfig(),
      store: this.d.store,
      linear: () => {
        const l = this.d.linear();
        if (!l) throw new Error('Linear is not configured');
        return l;
      },
      agents: this.d.agents,
      clock: this.clock,
      effects: this.effects,
      notify: (t, m) => (this.d.notify ?? defaultNotify)(t, m),
      persistent: this.persistentDeps,
      prov: () => this.prov(),
      completedStateId: () => this.completedStateId(),
      viewerId: () => this.viewerId(),
      secretsFor: (r) => this.secretsFor(r),
      signal: (key) => this.jobs.get(key)?.ac.signal ?? new AbortController().signal,
      emit: (key, ev) => this.emit(key, ev),
      hist: (key, text) => this.d.store.update(key, (r) => void r.history.push({ ts: this.clock.now(), text })),
      providerPause: (agent, until, reason) => {
        this.pauses.set(agent, { until, reason });
        this.changed();
      },
      pausedUntil: (agent) => this.activePause(agent),
      tickSoon: () => this.tickSoon(),
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

  private activePause(agent: AgentName): { until: number; reason: string } | null {
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

  private viewerId(): string {
    const v = this.d.getConfig().linear.viewerId ?? this.viewer;
    if (!v) throw new Error('Linear viewer is unknown — complete setup first');
    return v;
  }

  private async prov(): Promise<Provisioned> {
    const now = this.clock.now();
    if (this.provCache && now - this.provCache.at < 60_000) return this.provCache.value;
    const cfg = this.d.getConfig();
    const linear = this.d.linear();
    if (!linear || !cfg.linear.teamId) throw new Error('Linear is not set up yet');
    const p = await resolveProvisioned(linear, cfg.linear.teamId, cfg.linear.mode, cfg.linear.triggerLabel);
    if (!p) throw new Error('Linear labels/statuses are not created yet — open Setup → Team and click Create.');
    this.provCache = { at: now, value: p };
    return p;
  }

  private async completedStateId(): Promise<string | null> {
    if (this.doneState !== undefined) return this.doneState;
    const cfg = this.d.getConfig();
    const linear = this.d.linear();
    if (!linear || !cfg.linear.teamId) return null;
    const info = await linear.teamSetup(cfg.linear.teamId);
    const done = info.states.find((s) => s.type === 'completed' && /^done$/i.test(s.name)) ?? info.states.find((s) => s.type === 'completed');
    this.doneState = done?.id ?? null;
    return this.doneState;
  }

  /** Drop caches after setup/settings changes. */
  invalidate(): void {
    this.provCache = null;
    this.doneState = undefined;
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
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (e) {
        log.error(`tick failed: ${errMsg(e)}`);
      }
      if (this.stopped) return;
      const ms = opts.pollMs ?? Math.max(15, this.d.getConfig().linear.pollSeconds) * 1000 + Math.floor(Math.random() * 2000);
      this.timer = setTimeout(loop, ms);
      this.timer.unref();
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
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

  // ───────────────────────── polling ─────────────────────────
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
    const cfg = this.d.getConfig();
    const linear = this.d.linear();
    if (!linear || !cfg.linear.teamId) {
      this.lastPollError = 'Linear is not set up yet';
      this.changed();
      return;
    }
    const now = this.clock.now();
    if (now < this.backoffUntil) return;
    let issues: LinearIssue[];
    try {
      if (!cfg.linear.viewerId && !this.viewer) this.viewer = (await linear.viewer()).id;
      await this.prov();
      issues = await linear.candidates(cfg.linear.teamId, cfg.linear.triggerLabel, { includeAssigned: cfg.linear.allowAssignedToMe });
      this.lastPollAt = now;
      this.lastPollError = null;
      this.backoffStep = 0;
    } catch (e) {
      this.lastPollError = truncate(errMsg(e), 300);
      const rate = /rate.?limit|429/i.test(errMsg(e));
      this.backoffStep = Math.min(this.backoffStep + 1, 6);
      if (rate) this.backoffUntil = now + Math.min(10 * 60_000, 15_000 * 2 ** this.backoffStep);
      log.warn(`poll failed: ${this.lastPollError}`);
      this.changed();
      return;
    }
    const byId = new Map(issues.map((i) => [i.id, i]));
    for (const run of this.d.store.list()) {
      try {
        await this.reconcileRun(run, byId.get(run.issueId));
      } catch (e) {
        log.warn(`${run.key}: reconcile failed: ${errMsg(e)}`);
      }
    }
    for (const issue of issues) {
      if (this.globalPaused) break; // paused from the dashboard: no new claims, no new Linear writes for new issues
      if (this.d.store.has(issue.identifier)) continue;
      try {
        await this.maybeClaim(issue);
      } catch (e) {
        log.warn(`${issue.identifier}: claim failed: ${errMsg(e)}`);
      }
    }
    for (const run of this.d.store.list()) {
      if (!TERMINAL.has(run.status)) await this.effects.flush(run.key).catch(() => undefined);
    }
    this.changed();
  }

  private ignore(issue: LinearIssue, reason: string): void {
    this.ignoredMap.set(issue.id, { key: issue.identifier, reason, updatedAt: issue.updatedAt });
  }

  private async maybeClaim(issue: LinearIssue): Promise<void> {
    const cfg = this.d.getConfig();
    const seen = this.ignoredMap.get(issue.id);
    if (seen && seen.updatedAt === issue.updatedAt) return;
    this.ignoredMap.delete(issue.id);
    const prov = await this.prov();
    const viewerId = this.viewerId();
    if (issue.labels.some((l) => l.id === prov.bugLabelId)) return; // our own bug sub-issues
    if (issue.parentId && this.d.store.list().some((r) => r.issueId === issue.parentId)) return; // child of a Conductor run
    const t = issue.state.type;
    const pickable = t === 'unstarted' || (t === 'backlog' && cfg.linear.pickupFromBacklog);
    if (!pickable) {
      if (t === 'backlog' || t === 'triage') this.ignore(issue, `in ${issue.state.name} — move it to Todo to start`);
      return;
    }
    const mine = issue.creatorId === viewerId || (cfg.linear.allowAssignedToMe && issue.assigneeId === viewerId);
    if (!mine) {
      this.ignore(issue, 'created by someone else (only issues you create are picked up)');
      return;
    }
    const full = await this.linearOrThrow().issue(issue.id);
    const assignedPickup = issue.creatorId !== viewerId && cfg.linear.allowAssignedToMe && issue.assigneeId === viewerId;
    if (!assignedPickup) {
      const triggerId = findTriggerLabelOnIssue(full, cfg.linear.triggerLabel)?.id ?? prov.triggerLabelId; // team vs workspace label
      const a = attributeTrigger(full, triggerId, viewerId);
      if (!a.ok) return this.ignore(issue, a.reason ?? 'trigger label was added by someone else');
      const d = attributeDescription(full, viewerId);
      if (!d.ok) return this.ignore(issue, d.reason ?? 'description was edited by someone else');
    }
    const repo = this.resolveRepo(full);
    const seed = {
      key: full.identifier,
      issueId: full.id,
      teamId: full.teamId,
      title: full.title,
      description: full.description ?? '',
      descHash: sha1(full.description ?? ''),
      url: full.url,
      repo: repo?.name ?? '',
      branch: `conductor/${slug(full.identifier)}`,
      worktree: '',
      baseSha: '',
      loopBudget: cfg.pipeline.maxLoops,
    };
    try {
      this.d.store.create({ ...newRun(seed), assignedPickup });
    } catch (e) {
      if ((e as { code?: string }).code === 'exists') return;
      throw e;
    }
    log.info(`${full.identifier}: claimed (${repo?.name ?? 'no repo yet'})`);
    await this.stages.applyStage(full.identifier, 'planning');
    await this.effects.comment(
      full.identifier,
      'claimed',
      `🤖 **Conductor picked this up.** Plan (Claude) → build (Cursor) → independent verification (Claude).`,
    );
    if (!repo) {
      await this.stages.toNeedsHuman(
        full.identifier,
        `I could not tell which repository this belongs to. Registered: ${cfg.repos.map((r) => r.name).join(', ') || '(none yet)'}. Add the label \`repo:<name>\` or a first line \`repo: <name>\` to the description, then move the issue back to Todo.`,
        'plan',
      );
    }
    this.changed();
    this.tickSoon();
  }

  private linearOrThrow(): LinearPort {
    const l = this.d.linear();
    if (!l) throw new Error('Linear is not configured');
    return l;
  }

  /** label `repo:<name>` > Linear project name > the only registered repo > `repo: <name>` first line. Registered repos only. */
  resolveRepo(issue: LinearIssue): RepoConfig | null {
    const repos = this.d.getConfig().repos;
    const byName = (n: string) => repos.find((r) => r.name.toLowerCase() === n.trim().toLowerCase()) ?? null;
    for (const l of issue.labels) {
      const m = /^repo:\s*(.+)$/i.exec(l.name);
      if (m && byName(m[1]!)) return byName(m[1]!);
    }
    if (issue.projectName && byName(issue.projectName)) return byName(issue.projectName);
    if (repos.length === 1) return repos[0]!;
    const first = (issue.description ?? '').split('\n').find((l) => l.trim());
    const m = first ? /^repo:\s*([\w.-]+)\s*$/i.exec(first.trim()) : null;
    if (m && byName(m[1]!)) return byName(m[1]!);
    return null;
  }

  // ───────────────────────── reconcile (resume matrix) ─────────────────────────
  private async reconcileRun(run: Run, issue: LinearIssue | undefined): Promise<void> {
    const active = !TERMINAL.has(run.status);
    if (!issue) {
      if (!active) return;
      let full: LinearIssue | null = null;
      try {
        full = await this.linearOrThrow().issue(run.issueId);
      } catch (e) {
        if (/not found|entity not found|no issue/i.test(errMsg(e))) full = null;
        else return; // transient: try again next poll
      }
      const closed = full && (full.state.type === 'completed' || full.state.type === 'canceled');
      await this.stopJob(run.key);
      this.d.store.update(run.key, (r) => {
        r.status = closed && full!.state.type === 'completed' ? 'finished' : 'aborted';
        r.next = 'none';
        r.history.push({ ts: this.clock.now(), text: closed ? `Issue ${full!.state.type} in Linear` : 'Issue removed or label dropped in Linear — stopped' });
      });
      return;
    }
    const t = issue.state.type;
    if (t === 'backlog' || t === 'triage') {
      if (active && run.status !== 'parked') await this.park(run);
      return;
    }
    if (t === 'unstarted') {
      const humanMoved = !!run.expected.stateId;
      if (run.status === 'parked' || (humanMoved && active) || (TERMINAL.has(run.status) && humanMoved)) {
        await this.rerunFromHuman(run.key);
      }
      return;
    }
    // started
    if (run.status === 'parked') {
      this.d.store.update(run.key, (r) => {
        r.status = restoredStatus(r);
        r.parkedFrom = undefined;
        r.history.push({ ts: this.clock.now(), text: 'Un-parked' });
      });
      return;
    }
    if (run.status === 'awaiting_approval') {
      const cfg = this.d.getConfig();
      let approved = false;
      if (cfg.linear.mode === 'states') {
        const prov = await this.prov().catch(() => null);
        approved = !!prov?.stageStateIds && issue.state.id === prov.stageStateIds.building;
      }
      if (!approved) {
        try {
          const full = await this.linearOrThrow().issue(run.issueId);
          const all = full.comments ?? [];
          // only `/approve` comments written AFTER our approval request count (clock-independent anchor)
          const anchor = all.findIndex((c) => hasMarker(c.body, `${run.key}:approval:${run.rev}`));
          approved = hasApproveCommand(anchor >= 0 ? all.slice(anchor + 1) : all, this.viewerId());
        } catch {
          /* transient */
        }
      }
      if (approved) this.approve(run.key, 'human');
    }
  }

  private async park(run: Run): Promise<void> {
    await this.stopJob(run.key);
    this.d.store.update(run.key, (r) => {
      r.parkedFrom = r.status;
      r.status = 'parked';
      r.history.push({ ts: this.clock.now(), text: 'Parked (moved to Backlog) — nothing will run until you move it to Todo' });
    });
  }

  private async stopJob(key: string): Promise<void> {
    const j = this.jobs.get(key);
    if (!j) return;
    j.ac.abort();
    await j.promise.catch(() => undefined);
  }

  /** Human drag-to-Todo / dashboard Retry. Implements the resume matrix. */
  private async rerunFromHuman(key: string): Promise<void> {
    const run0 = this.d.store.get(key);
    if (!run0) return;
    await this.stopJob(key);
    const cfg = this.d.getConfig();
    let issue: LinearIssue | null = null;
    try {
      issue = await this.linearOrThrow().issue(run0.issueId);
    } catch {
      /* continue with what we have */
    }
    if (issue && !run0.assignedPickup) {
      const viewerId = this.viewerId();
      const d = attributeDescription(issue, viewerId);
      if (!d.ok) {
        await this.stages.toNeedsHuman(key, `Cannot restart: ${d.reason ?? 'the description was edited by someone else'}`, 'plan');
        return;
      }
    }
    const was = run0.status === 'parked' ? (run0.parkedFrom ?? 'running') : run0.status;
    const origin: NextStep | undefined = run0.needsHuman?.origin;
    // needs_human on a later stage retries that stage; everything else re-runs from plan
    const retryStage = was === 'needs_human' && origin && ['build', 'verify', 'plan_review'].includes(origin) ? origin : null;
    const keepCommits = retryStage !== null || was === 'ready' || was === 'finished' || was === 'aborted';
    if (run0.worktree) {
      try {
        await W.backupRefs(run0.worktree, run0.key, run0.rev); // recoverable copy first, always
        if (!keepCommits) await W.resetToBase(run0.worktree, run0.baseSha);
      } catch (e) {
        log.warn(`${key}: backup/reset skipped: ${errMsg(e)}`);
      }
    }
    const repo = run0.repo ? null : issue ? this.resolveRepo(issue) : null;
    const obsolete = retryStage ? [] : run0.bugs.filter((b) => b.status === 'open' && b.linearId);
    this.d.store.update(key, (r) => {
      const now = this.clock.now();
      r.agentRuns = 0; // a human restart is a fresh budget (otherwise the per-issue cap becomes a dead end)
      r.buildFails = 0;
      r.limitStreak = 0;
      if (issue) {
        r.title = issue.title;
        r.description = issue.description ?? '';
        r.descHash = sha1(issue.description ?? '');
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
        r.history.push({ ts: now, text: `Re-planning from scratch (rev ${r.rev}) — requested by you` });
      }
    });
    if (obsolete.length) {
      const done = await this.completedStateId().catch(() => null);
      const rev = this.d.store.get(key)?.rev ?? run0.rev + 1;
      if (done) for (const b of obsolete) await this.effects.close(key, `bugclose:${b.fp}:rerun${rev}`, b.linearId!, done);
    }
    if (!this.d.store.get(key)!.repo) {
      await this.stages.toNeedsHuman(key, `Still no repository for this issue. Registered: ${cfg.repos.map((r) => r.name).join(', ') || '(none)'}. Add the label \`repo:<name>\` and move it back to Todo.`, 'plan');
      return;
    }
    await this.stages.applyStage(key, retryStage === 'build' ? 'building' : retryStage === 'verify' ? 'verifying' : 'planning');
    this.tickSoon();
  }

  // ───────────────────────── scheduling ─────────────────────────
  private providerFor(next: NextStep): AgentName | null {
    const s = this.d.getConfig().stages;
    switch (next) {
      case 'plan':
        return s.plan;
      case 'plan_review':
        return s.review;
      case 'verify':
        return s.verify;
      case 'build':
        return 'cursor';
      default:
        return null;
    }
  }

  private blockedByPause(run: Run): { until: number } | null {
    const cfg = this.d.getConfig();
    const p = this.providerFor(run.next);
    if (!p) return null;
    const pause = this.activePause(p);
    if (!pause) return null;
    if (p === 'claude' && cfg.pipeline.onClaudeLimit === 'cursor') return null; // will fall back to Cursor
    return { until: pause.until };
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
    for (let i = 0; i < 60; i++) {
      const run = this.d.store.get(key);
      if (!run || ac.signal.aborted || run.status !== 'running') return;
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

  // ───────────────────────── controls (dashboard / API) ─────────────────────────
  approve(key: string, by: 'human' | 'auto' = 'human'): void {
    const run = this.d.store.get(key);
    if (!run || run.status !== 'awaiting_approval') throw new EngineError('bad_state', 'This run is not waiting for approval.');
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
      throw new EngineError('bad_state', 'This issue is parked in Backlog. Move it to Todo in Linear to continue — Conductor never moves your issues out of Backlog itself.');
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
      for (const a of ['claude', 'cursor'] as AgentName[]) this.pauses.delete(a);
      this.d.store.update(key, (r) => {
        r.status = 'queued';
        r.pausedUntil = undefined;
        r.history.push({ ts: this.clock.now(), text: 'Resumed manually' });
      });
    } else if (run.status === 'parked') {
      throw new EngineError('bad_state', 'This issue is parked in Backlog. Move it to Todo in Linear to continue — Conductor never moves your issues out of Backlog itself.');
    } else throw new EngineError('bad_state', 'Nothing to resume.');
    this.tickSoon();
  }

  async abort(key: string): Promise<void> {
    const run = this.d.store.get(key);
    if (!run) throw new EngineError('missing', 'Unknown run.');
    await this.stopJob(key);
    this.d.store.update(key, (r) => {
      r.status = 'aborted';
      r.next = 'none';
      r.history.push({ ts: this.clock.now(), text: 'Aborted from the dashboard' });
    });
    await this.effects.comment(key, `abort:${this.clock.now()}`, '🤖 **Conductor stopped** this run at your request. Move the issue to **Todo** to start it again.');
    this.changed();
  }

  async cleanup(key: string): Promise<void> {
    const run = this.d.store.get(key);
    if (!run) throw new EngineError('missing', 'Unknown run.');
    if (!['ready', 'finished', 'aborted'].includes(run.status)) throw new EngineError('bad_state', 'Only finished runs can be cleaned up.');
    const repo = this.d.getConfig().repos.find((r) => r.name === run.repo);
    if (repo && run.worktree) {
      await W.removeWorktree(repo.path, run.worktree, run.branch, { deleteBranch: true }); // git refuses unless fully merged
      this.d.store.update(key, (r) => {
        r.worktree = '';
        r.history.push({ ts: this.clock.now(), text: 'Worktree removed (branch kept)' });
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
    const prov = await this.prov();
    const linear = this.linearOrThrow();
    if (!cfg.linear.teamId) throw new EngineError('setup', 'Pick a Linear team first.');
    const repoName = input.repo?.trim();
    if (repoName && !cfg.repos.some((r) => r.name === repoName)) throw new EngineError('bad_repo', `"${repoName}" is not a registered repository.`);
    if (!repoName && cfg.repos.length !== 1) throw new EngineError('bad_repo', 'Choose which repository this task is for.');
    const desc = `${repoName ? `repo: ${repoName}\n\n` : ''}${input.description ?? ''}`.trim();
    const issue = await linear.createIssue({
      teamId: cfg.linear.teamId,
      title: input.title.trim().slice(0, 200),
      description: desc,
      labelIds: [prov.triggerLabelId],
      stateId: prov.todoStateId ?? undefined,
    });
    this.tickSoon();
    return { key: issue.identifier, url: issue.url };
  }

  // ───────────────────────── introspection ─────────────────────────
  status() {
    const now = this.clock.now();
    const pp: Partial<Record<AgentName, { until: number; reason: string }>> = {};
    for (const a of ['claude', 'cursor'] as AgentName[]) {
      const p = this.activePause(a);
      if (p) pp[a] = p;
    }
    return {
      paused: this.globalPaused,
      pauseReason: this.pauseReason,
      providerPause: pp,
      running: this.jobs.size,
      maxParallel: this.d.getConfig().pipeline.maxParallel,
      lastPollAt: this.lastPollAt,
      lastPollError: this.lastPollError,
      pollSeconds: this.d.getConfig().linear.pollSeconds,
      ignored: [...this.ignoredMap.values()].map((i) => ({ key: i.key, reason: i.reason })),
      now,
      quota: { claude: this.quotaMap.get('claude') },
    };
  }
  isRunning(key: string): boolean {
    return this.jobs.has(key);
  }
}

/** What a parked run goes back to when its issue leaves Backlog. */
function restoredStatus(r: Run): Run['status'] {
  const was = r.parkedFrom;
  return was && ['awaiting_approval', 'needs_human', 'ready'].includes(was) ? was : 'queued';
}

export class EngineError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}
