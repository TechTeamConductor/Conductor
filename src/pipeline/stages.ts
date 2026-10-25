import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentResult, Bug, BugRec, GateComparison, GateDef, GateResult, GateRun, ItemRun, LimitInfo, NextStep, Plan,
  PlanReview, RepoConfig, Run, SessionRec, StageName, Verdict,
} from '../types.ts';
import type { EmitEvent } from '../agents/claude.ts';
import type { Schema } from '../agents/json.ts';
import { validateSchema } from '../agents/json.ts';
import { toolEnv } from '../agents/env.ts';
import { redact } from '../redact.ts';
import { errMsg, fmtDuration, sha1, sha256, truncate } from '../util.ts';
import { logger } from '../log.ts';
import * as W from '../git/worktree.ts';
import { safeWriteInside } from '../fsutil.ts';
import * as G from '../git/gates.ts';
import { gitOk } from '../git/exec.ts';
import { scanBranchForSecrets } from '../git/branchscan.ts';
import type { StageKey } from '../board/lanes.ts';
import type { WorkItem } from '../board/index.ts';
import { Effects } from './effects.ts';
import { EMPTY_ATTEMPT_NOTE } from './selfheal.ts';
import { decideApproval, decidedByRunMode, effectiveFirstPlanHold, effectiveFixtureRewrite, effectiveHeal, effectivePolicy, effectiveLiftsHolds } from '../policy/policy.ts';
import { projectKeyOf } from '../context/service.ts';
import { buildGraph, graphBudgets, isGraphPlan, itemsOf, sanitizeLine, topoOrder, validateTaskGraph } from './graph.ts';
import { GraphBuilder } from './graph-build.ts';
import { exemptPaths, postBuildChecks, runBuild, type BuildInput } from './envelope.ts';
import { providerLabel } from '../agents/providers/registry.ts';
import type { ProviderId } from '../agents/providers/types.ts';
import type { Role } from '../agents/roles.ts';
import type { Consumer } from '../context/pack.ts';
import { OFFLINE_EPISODE_CAP, OFFLINE_RUN_CEILING_MS, backoffFor } from '../net/offline.ts';
import { route } from '../agents/routing.ts';
import { DEFAULT_ACCOUNT, type AccountRef } from '../accounts/types.ts';
import type { PipelineCtx } from './context.ts';
import { ITEM_NOTE_SCHEMA, PLAN_REVIEW_SCHEMA, PLAN_SCHEMA, VERDICT_SCHEMA } from './schemas.ts';
import { conventionsBlock, fence, loadTemplate, planToMarkdown, preamble, render, taskBlock } from './prompts.ts';
import { resolve as resolveStuck, type ResolverHost } from './resolver.ts';
import { RESOLVER_SCHEMA } from './schemas.ts';

const log = logger('stages');
const PROTECTED = '.claude/**, .cursor/**, .codex/**, .agents/**, .mcp.json, AGENTS.md, agents.override.md, CLAUDE.md, GEMINI.md, .github/**, .husky/**, .git*, .techteam/**, .conductor/**';

type ReadOnlyStage = 'plan' | 'plan_review' | 'verify';
/** What a read-only call asks the run to do when it cannot continue (applied at once, or deferred so concurrent calls make ONE transition). */
export type Hold = { type: 'human'; reason: string; origin: NextStep } | { type: 'pause'; limit: LimitInfo; role?: Role } | { type: 'offline'; message: string };
type Called = { kind: 'ok'; json: unknown; result: AgentResult; agent: ProviderId } | { kind: 'stop'; hold?: Hold };

/** Eligibility for the Quick Ask fast path is decided on the PLANNER's plan: small, ≤ 3 files, plain relative paths, nothing protected or secret-looking. */
export function fastPathEligible(plan: Plan): boolean {
  if (plan.complexity !== 'S' || plan.deliverable === 'answer' || isGraphPlan(plan)) return false;
  const files = plan.filesToChange.map((f) => f.path);
  if (files.length === 0 || files.length > 3) return false;
  if (files.some((f) => !/^[A-Za-z0-9._@+\-][A-Za-z0-9._@+/\- ]{0,300}$/.test(f) || f.startsWith('/') || f.split('/').some((x) => x === '..' || x === '.' || x === '' || /^\.git/i.test(x)) || /(^|\/)\.env|\.(pem|key)$|id_rsa|credentials/i.test(f))) return false;
  return W.diffScopeViolations(files, []).length === 0;
}

/** More tasks than this in one plan always waits for a human (even with automatic approval). */
const GRAPH_BIG_ITEMS = 8;

/** The text of a subtask card: what the task is, never anything a builder would take as an instruction (the card is for people). */
function describeItem(it: ItemRun): string {
  const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
  const lines = [
    `**${it.id}** · ${it.role}`,
    '',
    sanitizeLine(it.objective, 1_200),
    '',
    it.dependsOn.length ? `**Depends on:** ${it.dependsOn.join(', ')}` : '',
    it.files.length ? `**Files:** ${it.files.slice(0, 12).map((f) => code(sanitizeLine(f, 120))).join(', ')}${it.files.length > 12 ? ` … (+${it.files.length - 12})` : ''}` : '',
    it.criteria.length ? `**Acceptance criteria:** ${it.criteria.join(', ')}` : '',
    '',
    '_This card is managed by Conductor from the plan — it follows the work; moving it by hand has no effect. Use the parent card to retry or stop._',
  ];
  return lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n').trim();
}

export function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim();
}
export function bugFingerprint(b: Pick<Bug, 'title' | 'file'>): string {
  return sha1(`${normalizeTitle(b.title)}|${(b.file ?? '').toLowerCase()}`).slice(0, 16);
}

function readConventions(root: string): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const p = join(root, name);
    try {
      if (!existsSync(p)) continue;
      const st = lstatSync(p);
      if (!st.isFile() || st.size > 256 * 1024) continue; // never follow symlinks out of the worktree
      out.push({ name, text: readFileSync(p, 'utf8').slice(0, 16_000) });
    } catch {
      /* unreadable: skip */
    }
  }
  return out;
}

export class Stages {
  private c: PipelineCtx;
  private graphs: GraphBuilder;
  constructor(ctx: PipelineCtx) {
    this.c = ctx;
    this.graphs = new GraphBuilder({
      c: ctx,
      run: (k) => this.run(k),
      repo: (r) => this.repo(r),
      patch: (k, fn) => this.patch(k, fn),
      note: (k, st, t) => this.note(k, st, t),
      toNeedsHuman: (k, reason, origin, comment, cause) => this.toNeedsHuman(k, reason, origin, comment, cause),
      pauseForLimit: (k, l, role) => this.onLimitHit(k, l, role),
      finishSession: (k, res) => this.finishSession(k, res),
      refundIfLimit: (k, res) => this.refundIfLimit(k, res),
      emitter: (k, st, loop, rev) => this.emitter(k, st, loop, rev),
      runAllGates: (k, repo, defs, cwd) => this.runAllGates(k, repo, defs, cwd),
      reinstallIfLockChanged: (k, st, cwd) => this.reinstallIfLockChanged(k, st, cwd),
      hasUncommitted: (wt) => this.hasUncommitted(wt),
      writePromptAudit: (k, name, text) => this.writePromptAudit(k, name, text),
      runsLimit: (r) => this.runsLimit(r),
      scopeRevertHook: (k, listed) => this.scopeRevertHook(k, listed),
      land: (k, repoPath, sha) => this.land(k, repoPath, sha),
      callAnalysis: async (k, prompt, role, label) => {
        const called = await this.callReadOnly(k, 'plan', prompt, ITEM_NOTE_SCHEMA, this.run(k).worktree, (j) => validateSchema(ITEM_NOTE_SCHEMA, j), { role, label, defer: true });
        return called.kind === 'ok' ? { kind: 'ok', json: called.json } : { kind: 'stop', hold: called.hold };
      },
      applyHold: (k, hold) => this.applyHold(k, hold),
      looksOffline: (res) => this.looksOffline(res),
      refundRun: (k) => this.patch(k, (r) => void (r.agentRuns = Math.max(0, r.agentRuns - 1))),
      analysisSlot: (k) => ctx.analysisSlot(ctx.signal(k)),
      buildSlot: (k) => ctx.buildSlot(ctx.signal(k)),
      projectBlocks: (k, consumer, files) => this.projectBlocks(k, consumer, files),
      protectedPaths: PROTECTED,
    });
  }

  /**
   * The project-context blocks of a prompt, fenced as data: deterministic facts recomputed from git at the run's base commit (and, for
   * read-only stages only, previously completed tasks). A builder never receives history, summaries or anything an agent wrote.
   */
  async projectBlocks(key: string, consumer: Consumer, files: string[] = []): Promise<{ projectFacts: string; projectHistory: string; projectNotes: string }> {
    const run = this.run(key);
    let b: { facts: string; history: string; notes: string };
    try {
      b = await this.c.context.blocks(run, this.repo(run), consumer, files);
    } catch (e) {
      // the context engine is an aid: whatever goes wrong inside it, the stage simply runs without the block
      log.warn(`${key}: project context unavailable: ${errMsg(e)}`);
      b = { facts: '', history: '', notes: '' };
    }
    return {
      projectFacts: b.facts ? fence('project-facts', b.facts, 40_000) : '',
      projectHistory: consumer === 'readonly' && b.history ? fence('project-history', b.history, 8_000) : '',
      projectNotes: consumer === 'readonly' && b.notes ? fence('project-notes', b.notes, 4_000) : '',
    };
  }

  /** Fast-path runs skipped plan review, so the build may touch ONLY the files the plan listed (every path). Null = fine. */
  private async fastPathScopeProblem(run: Run, plan: Plan, headSha: string): Promise<string | null> {
    if (!run.fastPath) return null;
    const files = (await gitOk(run.worktree, ['diff', '--name-only', '-z', run.baseSha, headSha]).catch(() => '')).split('\0').filter(Boolean);
    const planSet = new Set(plan.filesToChange.map((f) => f.path.replace(/^\.\//, '')));
    const extra = files.filter((f) => !planSet.has(f));
    return extra.length ? `This fast-path change touched files the plan did not list: ${extra.slice(0, 6).join(', ')}. Review them (they are committed on the branch), then continue.` : null;
  }

  /**
   * C2: what the envelope may do when a build touched protected files the plan did not list. Complete auto only, a reviewed (non
   * fast-path) plan only, once per run. `allow` reserves the budget at once (parallel graph items share it); a failed revert still parks.
   */
  scopeRevertHook(key: string, listed: string[]): NonNullable<BuildInput['scopeRevert']> {
    return {
      key,
      listed,
      allow: () => {
        const r = this.run(key);
        if (r.fastPath || !effectiveHeal(this.c.cfg(), 'scope_revert', r.scopeRevertsUsed)) return false;
        this.patch(key, (x) => void (x.scopeRevertsUsed = (x.scopeRevertsUsed ?? 0) + 1));
        return true;
      },
      onReverted: ({ paths, backupRef, originalSha }) => {
        this.recordLanded(key, [originalSha]);
        const secrets = this.c.secretsFor(this.run(key));
        const list = redact(paths.slice(0, 6).join(', '), secrets);
        const text = `Complete auto reverted files the plan did not list (${list}). The build's original commit is kept as ${backupRef} in the repository.`;
        this.patch(key, (r) => {
          r.history.push({ ts: this.c.clock.now(), text });
          Effects.enqueue(r, `scope-revert:${r.scopeRevertsUsed ?? 1}`, { kind: 'comment', payload: { body: `🤖 **Out-of-scope files reverted** — ${text}` } }, secrets);
        });
        this.note(key, 'build', text);
        void this.c.effects.flush(key).catch(() => undefined);
      },
    };
  }

  /** Remember commits Conductor itself put on the checkout: Ship pushes only commits it can find here (anything else is somebody's own work). */
  recordLanded(key: string, shas: readonly string[]): void {
    const ok = shas.filter((x) => /^[0-9a-f]{40}$/.test(x));
    if (!ok.length) return;
    this.patch(key, (r) => {
      const set = new Set(r.landedShas ?? []);
      for (const x of ok) set.add(x);
      r.landedShas = [...set].slice(-500);
    });
  }

  /** `mergeOntoCurrent`, remembering every commit it lands (the chain it fast-forwards over, the commit itself, and the resulting tip). */
  async land(key: string, repoPath: string, sha: string): Promise<Awaited<ReturnType<typeof W.mergeOntoCurrent>>> {
    const pending = (await gitOk(repoPath, ['rev-list', '--max-count=200', sha, '--not', 'HEAD']).catch(() => '')).split('\n').map((x) => x.trim()).filter(Boolean);
    const landed = await W.mergeOntoCurrent(repoPath, sha);
    // `landed.sha` is the commit this build became (itself, or its cherry-pick) and never the checkout's HEAD, which may be the person's own commit
    if (landed.ok) this.recordLanded(key, [...pending, sha, landed.sha]);
    return landed;
  }

  /** The agent-run budget of a run: a task graph scales it with the amount of work (never past the hard ceiling). */
  runsLimit(run: Run): number {
    const base = this.c.cfg().pipeline.maxAgentRunsPerIssue;
    const extra = run.resolverExtended?.runs ?? 0; // the resolver's one bounded extension (a code constant, once per card)
    return (run.graph ? graphBudgets(run.graph.items.length, base).runsLimit : base) + extra;
  }

  // ───────────────────────── helpers ─────────────────────────
  private run(key: string): Run {
    const r = this.c.store.get(key);
    if (!r) throw new Error(`run ${key} vanished`);
    return r;
  }
  private repo(run: Run): RepoConfig {
    const r = this.c.cfg().repos.find((x) => x.name === run.repo);
    if (!r) throw new Error(`repository "${run.repo}" is not registered any more`);
    return r;
  }
  private patch(key: string, fn: (r: Run) => void): Run {
    return this.c.store.update(key, fn);
  }
  private note(key: string, stage: StageName | 'engine', text: string): void {
    this.c.emit(key, { agent: 'conductor', stage, kind: 'note', text });
  }

  /** Project the stage label (and the lane derived from the run's status) onto the board card. */
  async applyStage(key: string, stage: StageKey): Promise<void> {
    try {
      await this.c.effects.state(key, 'state', { stage });
    } catch (e) {
      log.warn(`${key}: could not update the board stage "${stage}": ${errMsg(e)}`);
    }
  }

  /** A question was answered: ready + the answer comment + the board projection in ONE run write (K1). */
  private async deliverAnswer(key: string, rev: number, answer: string): Promise<void> {
    const secrets = this.c.secretsFor(this.run(key));
    const run = this.patch(key, (r) => {
      r.answered = true;
      r.status = 'ready';
      r.next = 'none';
      r.needsHuman = undefined;
      r.history.push({ ts: this.c.clock.now(), text: 'Answered (no code change needed)' });
      Effects.enqueue(r, 'state', { kind: 'state', payload: { stage: 'ready' } }, secrets);
      Effects.enqueue(r, `answer:${rev}`, { kind: 'comment', payload: { body: `🤖 **Answer** — no code change was needed\n\n${truncate(answer, 24_000)}` } }, secrets);
    });
    await this.c.effects.flush(key);
    this.c.notify(`${key} answered`, truncate(run.title, 80));
  }

  /**
   * THE choke point for every stop. Complete auto only, the Stuck resolver gets one look first (resolver.ts): an applied action leaves the
   * run running/queued with `next` set and returns here WITHOUT any stuck card, comment or notification (callers `return` this call, so
   * they do not continue their own flow). Anything else (not eligible, give_up, invalid, model failure) parks exactly as before, with the
   * resolver's analysis appended. `cause` names what stopped the run when the caller knows it; otherwise it is recognised from the wording.
   */
  async toNeedsHuman(key: string, reasonRaw: string, origin: NextStep, commentRaw?: string, cause?: string): Promise<void> {
    let analysis = '';
    try {
      const out = await resolveStuck(this.resolverHost(), key, { reason: reasonRaw, origin, ...(cause ? { cause } : {}) });
      if (out.kind === 'applied' || out.kind === 'handled') return;
      if (out.kind === 'declined') analysis = out.analysis;
    } catch (e) {
      log.warn(`${key}: resolver failed: ${errMsg(e)}`); // never blocks the park below
    }
    const now = this.c.clock.now();
    const secrets = this.c.secretsFor(this.run(key));
    const reason = redact(reasonRaw, secrets); // agent/gate text can carry secrets into the UI, notifications and the board (H3)
    const comment0 = commentRaw === undefined ? undefined : redact(commentRaw, secrets);
    const comment = analysis ? `${comment0 ?? reason}\n\n**Resolver analysis:** ${truncate(redact(analysis, secrets), 600)}` : comment0;
    const body = `🤖 **Conductor needs you**\n\n${comment ?? reason}\n\n_To retry: move this card back to **To do** (or use Retry in the dashboard). Anything you add as a comment is included in the next attempt._`;
    const run = this.patch(key, (r) => {
      r.status = 'needs_human';
      r.needsHuman = { reason: truncate(reason, 600), origin, at: now };
      r.next = 'none';
      r.history.push({ ts: now, text: `Needs you: ${truncate(reason, 200)}` });
      // K1: the status change and its board effects are ONE write — a crash can never leave "needs you" without its explanation
      Effects.enqueue(r, 'state', { kind: 'state', payload: { stage: 'needs_human' } }, secrets);
      Effects.enqueue(r, `needs:${now}`, { kind: 'comment', payload: { body } }, secrets);
    });
    this.c.emit(key, { agent: 'conductor', stage: run.stage ?? 'engine', kind: 'error', text: `Needs human: ${reason}` });
    await this.c.effects.flush(key);
    this.c.notify(`${key} needs you`, truncate(reason, 160));
  }

  /** Resolver calls across all cards in the last hour (in memory). */
  private resolverHits: number[] = [];

  /** The narrow view of the stage runner the resolver gets: no config writers, lanes, identity or push. */
  private resolverHost(): ResolverHost {
    const hits = this.resolverHits;
    return {
      cfg: () => this.c.cfg(),
      run: (k) => this.run(k),
      patch: (k, fn) => this.patch(k, fn),
      now: () => this.c.clock.now(),
      secrets: (r) => this.c.secretsFor(r),
      scanEntries: (r) => this.c.scanEntriesFor(r),
      repoPath: (r) => this.c.cfg().repos.find((x) => x.name === r.repo)?.path ?? null,
      readArtifact: (k, name, fallback) => this.c.store.readArtifact(k, name, fallback),
      call: async (k, prompt) => {
        const run = this.run(k);
        const called = await this.callReadOnly(k, 'plan', prompt, RESOLVER_SCHEMA, run.worktree, (j) => validateSchema(RESOLVER_SCHEMA, j), { role: 'planning', label: 'resolver', defer: true });
        if (called.kind === 'ok') return { kind: 'ok', json: called.json };
        const hold = called.hold;
        if (!hold) return { kind: 'handled' }; // aborted
        if (hold.type === 'human') return { kind: 'failed', reason: hold.reason };
        await this.applyHold(k, hold); // a usage limit or a lost network is a real pause, not a stuck card
        return { kind: 'handled' };
      },
      enginePaused: () => this.c.enginePaused?.() ?? false,
      hourly: {
        count: (now) => {
          while (hits.length && now - hits[0]! >= 3_600_000) hits.shift();
          return hits.length;
        },
        record: (now) => void hits.push(now),
      },
      pauseAccount: (ref, until, reason) => this.c.providerPause({ provider: ref.provider as ProviderId, id: ref.id }, until, reason),
      runsLimit: (r) => this.runsLimit(r),
      aborted: (k) => this.c.signal(k).aborted,
      note: (k, text) => this.note(k, 'engine', text),
    };
  }

  /**
   * Crash recovery (`Engine.recover`): a run found with the resolver marker set was stopped mid-resolution. The counter is already spent,
   * so the resolver does NOT run again for that event: the marker is cleared and the run parks as stuck, in one synchronous write.
   */
  async parkAfterResolverCrash(key: string): Promise<void> {
    const r0 = this.c.store.get(key);
    const marker = r0?.resolverActive;
    if (!r0 || !marker) return;
    const now = this.c.clock.now();
    const secrets = this.c.secretsFor(r0);
    const reason = 'Conductor stopped while the Stuck resolver was working on this card. The resolver does not run twice for the same stop, so it needs a person.';
    const body = `🤖 **Conductor needs you**\n\n${reason}\n\n_To retry: move this card back to **To do** (or use Retry in the dashboard). Anything you add as a comment is included in the next attempt._`;
    this.patch(key, (r) => {
      r.resolverActive = undefined;
      r.status = 'needs_human';
      r.needsHuman = { reason, origin: marker.origin, at: now };
      r.next = 'none';
      r.history.push({ ts: now, text: `Needs you: ${reason}` });
      Effects.enqueue(r, 'state', { kind: 'state', payload: { stage: 'needs_human' } }, secrets);
      Effects.enqueue(r, `needs:${now}`, { kind: 'comment', payload: { body } }, secrets);
    });
    await this.c.effects.flush(key).catch(() => undefined);
    this.c.notify(`${key} needs you`, truncate(reason, 160));
  }

  /**
   * Complete auto, once per run: a credential shape that appears only in tests or fixtures is rewritten in place instead of
   * stopping. The scan still ran; a second failure, a secret file name, or the same shape outside tests still needs a person.
   * Returns true when the run stays on `build`.
   */
  private scheduleFixtureRewrite(key: string, reason: string, commitSha?: string): boolean {
    const rw = effectiveFixtureRewrite(this.c.cfg(), this.run(key).secretFixtureRewrites, reason);
    if (!rw) return false;
    this.patch(key, (r) => {
      r.secretFixtureRewrites = rw.nextUsed;
      r.fixtureRewriteNote = rw.note;
      if (commitSha) r.commitSha = commitSha;
      r.next = 'build';
      r.history.push({ ts: this.c.clock.now(), text: `Complete auto: rewriting credential-shaped text in ${rw.paths.join(', ')} (local worktree only; nothing is pushed)` });
    });
    this.note(key, 'build', `Complete auto is rewriting credential-shaped text in ${rw.paths.join(', ')}. The change stays on this machine; nothing is pushed.`);
    return true;
  }

  /** A candidate hit a usage limit but the chain moved on: remember the pause (on THAT account) so later stages skip it until it resets. */
  recordLimitPause(limit: LimitInfo): void {
    // the account comes from the candidate the CALLER ran, never from provider output (§2.3); a missing one is a programming error
    if (!limit.account) throw new Error('usage-limit pause without an account');
    const now = this.c.clock.now();
    const until = limit.resetsAt && limit.resetsAt > now ? limit.resetsAt : now + 15 * 60_000;
    this.c.providerPause({ provider: limit.provider, id: limit.account }, until, limit.message);
  }

  /** "Claude" with one sign-in; "Claude · Work" with several (labels only). */
  private who(ref: AccountRef): string {
    return this.c.agents.accountLabel(ref.provider, ref.id);
  }

  /**
   * M8-3 `onLimitHit` (was pauseForLimit): record the ACCOUNT's pause, re-route the role under `effectiveLimitRule`; a candidate the rule
   * allows ⇒ the stage starts again at once on it (same `next`, `moved.restarted`); none ⇒ pause until the route's earliest reset — with a
   * known reset time we wait for it, with an unknown one we back off 15 m → 6 h. One board comment and one notification per limit
   * *episode*; only episodes that END IN A PAUSE count toward the cap (B3b); rejected attempts never count toward the run budget.
   */
  async onLimitHit(key: string, limit: LimitInfo, role?: Role): Promise<void> {
    if (!limit.account) throw new Error('usage-limit pause without an account');
    const now = this.c.clock.now();
    const before = this.run(key);
    const ref: AccountRef = { provider: limit.provider, id: limit.account };
    const who = this.who(ref);
    const streak = (before.limitStreak ?? 0) + 1;
    const episode = streak === 1 ? (before.limitEpisode ?? 0) + 1 : before.limitEpisode ?? 1;
    const known = !!limit.resetsAt && limit.resetsAt > now;
    const backoffMin = Math.min(360, 15 * 2 ** (streak - 1));
    const until = known ? limit.resetsAt! : now + backoffMin * 60_000;
    this.c.providerPause(ref, until, limit.message);
    const cfg = this.c.cfg();
    const rt = role ? route({ role, complexity: before.complexity, roles: cfg.roles, states: this.c.routeStates(role), now, label: providerLabel, rule: this.c.limitRule() }) : null;
    const next = rt?.ok ? rt.candidates[0]! : null;
    if (next && next.crossOnLimit) {
      // restart at once on the next account / chain tool the rule allows (the attempt was refunded by the caller)
      const nextWho = this.who({ provider: next.id, id: next.account });
      const kind = next.id === ref.provider ? 'account' : 'tool';
      const note = `${who} reached its usage limit — this step starts again on ${nextWho}.`;
      this.patch(key, (r) => {
        r.status = 'queued';
        r.limitStreak = streak;
        r.limitEpisode = episode;
        r.moved = { kind, restarted: true, note, at: now, reason: 'limit' };
        r.history.push({ ts: now, text: note });
      });
      this.c.emit(key, { agent: 'conductor', stage: this.run(key).stage ?? 'engine', kind: 'note', text: note });
      if (streak === 1) {
        const tier = kind === 'tool' ? this.tierSentence(next.id) : '';
        await this.c.effects.comment(key, `limit:ep${episode}`, `🤖 **${who} reached its usage limit; this step continued on ${nextWho}.**${tier} Nothing is lost.`);
        this.c.notify('Usage limit reached', `${who} — continuing on ${nextWho}`);
      }
      this.c.tickSoon();
      return;
    }
    const pauseUntil = rt && !rt.ok && rt.kind === 'paused' ? rt.pauseUntil : until;
    // B3b: an episode that ends in a pause is counted once; more than 6 of them ⇒ a human looks (a provider faking limits cannot stall forever)
    const pauses = (before.limitPauses ?? 0) + (before.limitPausedEpisode === episode ? 0 : 1);
    if (pauses > 6) {
      return this.toNeedsHuman(key, `This task has hit a usage limit ${pauses - 1} separate times. Check your ${who} plan limits, then move it to To do to retry.`, before.next);
    }
    this.patch(key, (r) => {
      r.status = 'paused';
      r.pausedUntil = pauseUntil;
      r.pauseReason = truncate(limit.message, 300);
      r.pauseKind = 'limit';
      r.limitStreak = streak;
      r.limitEpisode = episode;
      r.limitPauses = pauses;
      r.limitPausedEpisode = episode;
      if (streak === 1) r.history.push({ ts: now, text: `Paused: ${limit.provider} usage limit — resuming automatically` });
    });
    this.c.emit(key, { agent: limit.provider, stage: this.run(key).stage ?? 'engine', kind: 'error', text: `Usage limit reached — paused until ${new Date(pauseUntil).toLocaleString()}` });
    if (streak === 1) {
      const knownAt = pauseUntil > now && (known || pauseUntil !== until);
      await this.c.effects.comment(
        key,
        `limit:ep${episode}`,
        `🤖 **Paused — ${who} usage limit reached.** Conductor will resume automatically${knownAt ? ` after ${new Date(pauseUntil).toLocaleString()}` : ' (it retries with growing gaps until the limit lifts)'}. Nothing is lost.`,
      );
      this.c.notify('Usage limit reached', `${limit.provider} — Conductor resumes automatically`);
    }
  }

  /** The isolation-tier sentence of the fallback comment (kept when a limit episode comment replaces it). */
  private tierSentence(id: ProviderId): string {
    const tier = this.c.routeStates()[id]?.tier;
    return tier === 'partial' ? " It ran in ask mode, which has weaker isolation than Claude's fail-closed tool lock-down." : tier === 'unverified' ? ' Its isolation has not been verified on this machine.' : '';
  }

  /**
   * A CLI that is offline usually HANGS rather than printing a network error: a timeout or generic failure while the probe says "offline"
   * is a network failure (plan §2b-3a). Only the probe's verdict counts — never the CLI's or the model's words.
   */
  async looksOffline(res: AgentResult): Promise<boolean> {
    if (res.ok || !(res.errorKind === 'timeout_idle' || res.errorKind === 'timeout_hard' || res.errorKind === 'agent')) return false;
    return (await this.c.networkState()) === 'offline';
  }

  /**
   * The network is unreachable: pause (never fail), refund the attempt (done by the caller), back off 30 s → 5 min, and resume by itself when
   * the engine's probe says the network is back. One comment and one notification per episode; a cumulative 24 h ceiling and an episode cap
   * keep a CLI that keeps reporting network errors from pausing and resuming forever.
   */
  async pauseForOffline(key: string, message: string): Promise<void> {
    const now = this.c.clock.now();
    const before = this.run(key);
    const o = before.offline ?? { episodes: 0, streak: 0, totalMs: 0 };
    const streak = o.streak + 1;
    const episodes = streak === 1 ? o.episodes + 1 : o.episodes;
    if (episodes > OFFLINE_EPISODE_CAP || o.totalMs >= OFFLINE_RUN_CEILING_MS) {
      return this.toNeedsHuman(key, `This task could not reach the network ${episodes > OFFLINE_EPISODE_CAP ? 'repeatedly' : 'for 24 hours in total'}. Check your connection, then move it to To do to retry.`, before.next);
    }
    const wait = backoffFor(streak);
    this.patch(key, (r) => {
      r.status = 'paused';
      r.pausedUntil = now + wait;
      r.pauseReason = 'offline';
      r.pauseKind = 'offline';
      r.offline = { episodes, streak, totalMs: o.totalMs + wait, pausedAt: now };
      if (streak === 1) r.history.push({ ts: now, text: 'Paused: no network — resuming automatically when it is back' });
    });
    this.c.emit(key, { agent: 'conductor', stage: this.run(key).stage ?? 'engine', kind: 'error', text: `No network — ${truncate(redact(message, this.c.secretsFor(this.run(key))), 200)}` });
    if (streak === 1) {
      await this.c.effects.comment(key, `offline:ep${episodes}`, '🤖 **Paused — no network.** Conductor resumes automatically when the connection is back. Board, notes, history, project context and gates keep working offline.');
      this.c.notify('Offline', `${key} is waiting for the network`);
    }
  }

  private recordSession(key: string, rec: Omit<SessionRec, 'status'> & { status?: SessionRec['status'] }): void {
    this.patch(key, (r) => {
      if (!r.sessions.some((s) => s.id === rec.id)) r.sessions.push({ status: 'running', ...rec });
    });
  }
  private finishSession(key: string, res: AgentResult): void {
    if (!res.sessionId) return;
    const status: SessionRec['status'] = res.ok ? 'ok' : res.errorKind === 'limit' ? 'limit' : res.errorKind === 'aborted' ? 'aborted' : res.errorKind?.startsWith('timeout') ? 'timeout' : 'error';
    this.patch(key, (r) => {
      const s = r.sessions.find((x) => x.id === res.sessionId);
      if (s) {
        s.status = status;
        s.endedAt = this.c.clock.now();
        s.costUsd = res.costUsd;
        s.model = res.model ?? s.model;
        s.cliVersion = res.cliVersion ?? s.cliVersion;
      }
      if (typeof res.costUsd === 'number') r.costUsd += res.costUsd;
      if (res.ok) {
        r.limitStreak = 0;
        if (r.offline) r.offline.streak = 0;
      }
    });
  }
  /** A limit-rejected attempt did no work: it must not eat the per-card run budget. */
  private refundIfLimit(key: string, res: AgentResult): void {
    if (!res.ok && (res.errorKind === 'limit' || res.errorKind === 'network')) this.patch(key, (r) => void (r.agentRuns = Math.max(0, r.agentRuns - 1)));
  }
  private emitter(key: string, stage: StageName, loop: number, rev: number): (ev: EmitEvent) => void {
    return (ev) => {
      this.c.emit(key, ev);
      if (ev.sessionId && ev.agent !== 'conductor') {
        this.recordSession(key, { id: ev.sessionId, agent: ev.agent, stage, loop, rev, startedAt: this.c.clock.now() });
      }
    };
  }

  /**
   * Every stage start re-checks that the card is still the one the human approved: the plan and its acceptance criteria were
   * written against the description text and the builder reads a snapshot, so a description edit halts the run at the next
   * stage boundary (restart re-plans).
   */
  private integrity(run: Run): { item: WorkItem | null; problem: string | null } {
    const item = this.c.board.item(run.itemId) ?? null;
    if (!item) return { item: null, problem: 'The card for this run no longer exists on the board.' };
    if (sha1(item.description ?? '') !== run.descHash) {
      return { item, problem: 'The card description changed after Conductor started it. Move the card back to To do to re-plan with the new text.' };
    }
    return { item, problem: null };
  }

  /**
   * One read-only agent call with validation, one corrective retry, hang/max-turn retry, limit pausing and
   * the per-card agent-run cap. Returns {kind:'stop'} after it has already moved the run to paused/needs_human/aborted.
   */
  private async callReadOnly(
    key: string,
    stage: ReadOnlyStage,
    prompt: string,
    schema: Schema,
    cwd: string,
    validate: (json: unknown) => string[],
    opts: { role?: Role; label?: string; defer?: boolean } = {},
  ): Promise<Called> {
    const stop = async (hold?: Hold): Promise<Called> => {
      if (opts.defer) return { kind: 'stop', hold };
      await this.applyHold(key, hold);
      return { kind: 'stop' };
    };
    let corrective = '';
    let retried = false;
    let turnsFactor = 1;
    for (let attempt = 0; attempt < 4; attempt++) {
      const run = this.run(key);
      if (this.c.signal(key).aborted) return stop();
      if (run.agentRuns >= this.runsLimit(run)) {
        return stop({ type: 'human', reason: `This card has used its limit of ${this.runsLimit(run)} agent runs. Review the work so far, then move it back to To do to continue.`, origin: run.next });
      }
      this.patch(key, (r) => {
        r.agentRuns += 1;
      });
      const cfg = this.c.cfg();
      await this.c.freshHealth();
      const role: Role = opts.role ?? (stage === 'plan' ? 'planning' : stage === 'plan_review' ? 'review' : 'verification');
      const res = await this.c.agents.readOnly({
        role,
        complexity: run.complexity,
        states: this.c.routeStates(role),
        rule: this.c.limitRule(),
        onCandidate: (ref) => this.c.noteCandidate(key, ref),
        onLimit: (info) => this.recordLimitPause(info),
        stage,
        cwd,
        prompt: prompt + corrective,
        schema,
        name: `conductor ${key} ${stage}`,
        onEvent: this.emitter(key, stage, run.loop, run.rev),
        signal: this.c.signal(key),
        secrets: this.c.secretsFor(run),
        maxTurnsFactor: turnsFactor,
      });
      if (await this.looksOffline(res)) res.errorKind = 'network';
      const merged = await this.limitEpisodeFromHops(key, stage, res);
      this.finishSession(key, res);
      this.refundIfLimit(key, res);
      if (res.fellBack && res.from && res.from !== res.agent && !merged) {
        // a visible, durable trace on the card when a read-only step ran on a different (possibly weaker-isolation) provider than configured
        await this.c.effects.comment(key, `fallback:${stage}:${run.loop}:${res.agent}`, `🤖 **${providerLabel(res.agent)} did the ${stage.replace('_', ' ')} step instead of ${providerLabel(res.from)}.**${this.tierSentence(res.agent)}`);
      }
      if (res.moved) this.patch(key, (r) => void (r.moved = { kind: res.moved!.kind, restarted: false, note: truncate(res.moved!.note, 300), at: this.c.clock.now(), ...(res.moved!.reason ? { reason: res.moved!.reason } : {}) }));
      if (res.quota) this.c.recordQuota({ provider: res.agent, id: res.account ?? DEFAULT_ACCOUNT }, res.quota);
      this.writePromptAudit(key, `${opts.label ?? stage}-${run.loop}-${attempt}`, prompt + corrective);
      if (res.ok) {
        const errs = validate(res.json);
        if (!errs.length) return { kind: 'ok', json: res.json, result: res, agent: res.agent };
        if (!retried) {
          retried = true;
          corrective = `\n\n## Your previous reply was rejected\nIt did not match the required format:\n${errs.slice(0, 8).map((e) => `- ${e}`).join('\n')}\nReturn a corrected JSON object.`;
          this.note(key, stage, `Reply failed validation (${errs[0]}) — asking once more.`);
          continue;
        }
        return stop({ type: 'human', reason: `The ${res.agent} reply kept failing validation: ${errs[0]}`, origin: run.next });
      }
      switch (res.errorKind) {
        case 'limit':
          return stop({ type: 'pause', role, limit: { ...(res.limit ?? { resetsAt: null, message: res.error ?? 'limit' }), provider: res.agent, account: res.account ?? DEFAULT_ACCOUNT } });
        case 'aborted':
          return stop();
        case 'network':
          return stop({ type: 'offline', message: res.error ?? 'network unreachable' });
        case 'auth': // not signed in: another attempt cannot help — say how to sign in (the message carries the exact command)
        case 'isolation':
        case 'spawn':
          return stop({ type: 'human', reason: res.error ?? 'agent could not start', origin: run.next });
        case 'max_turns':
          if (!retried) {
            retried = true;
            turnsFactor = 1.5;
            this.note(key, stage, 'Hit the turn cap — retrying once with a higher cap.');
            continue;
          }
          return stop({ type: 'human', reason: 'The agent ran out of turns twice. The task may be too large — consider splitting the card.', origin: run.next });
        case 'parse':
          if (!retried) {
            retried = true;
            corrective = '\n\n## Your previous reply was rejected\nNo JSON object could be found. Reply with ONLY the fenced ```json block.';
            continue;
          }
          return stop({ type: 'human', reason: res.error ?? 'could not parse the agent reply', origin: run.next });
        default: // timeouts and generic agent errors: one more attempt, then a human
          if (!retried) {
            retried = true;
            this.note(key, stage, `${res.agent} failed (${truncate(res.error ?? '', 160)}) — retrying once.`);
            continue;
          }
          return stop({ type: 'human', reason: `${res.agent} failed twice: ${truncate(res.error ?? 'unknown error', 300)}`, origin: run.next });
      }
    }
    return stop({ type: 'human', reason: 'The agent could not produce a valid reply.', origin: this.run(key).next });
  }

  /** Apply what a read-only call asked for (nothing for an abort). */
  async applyHold(key: string, hold: Hold | undefined): Promise<void> {
    if (!hold) return;
    if (hold.type === 'human') return this.toNeedsHuman(key, hold.reason, hold.origin);
    if (hold.type === 'offline') return this.pauseForOffline(key, hold.message);
    return this.onLimitHit(key, hold.limit, hold.role);
  }

  /**
   * B3a: a read-only call that switched account/tool on a LIMIT and then produced a result opens ONE episode — one board comment (merged with
   * the fallback comment when the tool changed) and one notify. Later hops of the same episode add history lines only. A call that ENDS in a
   * limit leaves the episode to `onLimitHit` (its pause comment says what happened). Returns true when the fallback comment was merged.
   */
  private async limitEpisodeFromHops(key: string, stage: ReadOnlyStage, res: { ok: boolean; errorKind?: string; agent: ProviderId; account?: string; from?: ProviderId; fellBack?: boolean; hops?: { from: AccountRef; to: AccountRef; kind: string }[] }): Promise<boolean> {
    const hops = (res.hops ?? []).filter((h) => h.kind === 'limit');
    if (!hops.length) return false;
    const now = this.c.clock.now();
    const to: AccountRef = { provider: res.agent, id: res.account ?? DEFAULT_ACCOUNT };
    this.patch(key, (r) => {
      for (const h of hops) r.history.push({ ts: now, text: `${this.who(h.from)} reached its usage limit — continued on ${this.who(h.to)}` });
    });
    if (res.errorKind === 'limit') return false;
    const before = this.run(key);
    const opening = (before.limitStreak ?? 0) === 0;
    const episode = opening ? (before.limitEpisode ?? 0) + 1 : before.limitEpisode ?? 1;
    this.patch(key, (r) => {
      r.limitStreak = (r.limitStreak ?? 0) + hops.length;
      r.limitEpisode = episode;
    });
    const toolChanged = !!(res.fellBack && res.from && res.from !== res.agent);
    if (!opening) return toolChanged;
    const fromWho = this.who(hops[0]!.from);
    const toWho = this.who(to);
    const fallback = toolChanged ? ` ${providerLabel(res.agent)} did the ${stage.replace('_', ' ')} step instead of ${providerLabel(res.from!)}.${this.tierSentence(res.agent)}` : '';
    await this.c.effects.comment(key, `limit:ep${episode}`, `🤖 **${fromWho} reached its usage limit; this step continued on ${toWho}.**${fallback}`);
    this.c.notify('Usage limit reached', `${fromWho} — continuing on ${toWho}`);
    return toolChanged;
  }

  private writePromptAudit(key: string, name: string, text: string): void {
    try {
      this.c.store.writeText(key, `prompt-${name}.md`, redact(text, this.c.secretsFor(this.run(key))));
    } catch {
      /* audit only */
    }
  }

  // ───────────────────────── workspace ─────────────────────────
  /** Create/reuse the worktree, install deps, record the baseline gate run (once). */
  private async ensureWorkspace(key: string): Promise<boolean> {
    let run = this.run(key);
    const repo = this.repo(run);
    const cfg = this.c.cfg();
    if (run.worktree && existsSync(run.worktree)) {
      // Only the repository checkout, or a checkout this run already opened for this card.
      try {
        await W.assertOwnedWorktree(repo, run.key, run.worktree, cfg.worktreeRoot);
      } catch (e) {
        await this.toNeedsHuman(key, errMsg(e), 'plan');
        return false;
      }
    }
    if (!run.worktree || !existsSync(run.worktree)) {
      this.note(key, 'plan', `Using the current branch of ${repo.name}…`);
      const wt = await W.useCurrentCheckout({ repo, key: run.key });
      run = this.patch(key, (r) => {
        r.worktree = wt.path;
        r.branch = wt.branch;
        r.baseSha = r.baseSha || wt.baseSha;
      });
      const anc = await W.scanAncestors(wt.path);
      if (anc.length) this.note(key, 'plan', `Heads-up: instruction files exist above the worktree and may be read by Cursor: ${anc.slice(0, 3).join(', ')}`);
    }
    // dependencies
    const lock = await W.lockfileHash(run.worktree);
    if (run.lockfileHash !== lock) {
      this.note(key, 'plan', 'Installing dependencies…');
      const inst = await W.installDeps(run.worktree, repo, { env: toolEnv(repo.envPassthrough), timeoutMs: cfg.pipeline.timeoutsMin.gate * 60_000, signal: this.c.signal(key) });
      if (!inst.ok) {
        if (this.c.signal(key).aborted) return false;
        await this.toNeedsHuman(key, `Installing dependencies failed in the worktree. Fix the repo's setup command, then move the card back to To do.\n\n\`\`\`\n${truncate(inst.output.slice(-1500), 1500)}\n\`\`\``, 'plan');
        return false;
      }
      this.patch(key, (r) => {
        r.lockfileHash = lock;
      });
    }
    // baseline gates (once per run)
    if (!this.c.store.readArtifact<GateRun | null>(key, 'baseline.json', null) && repo.gates.length) {
      this.note(key, 'plan', `Running baseline quality gates (${repo.gates.map((g) => g.name).join(', ')})…`);
      const base = await this.runAllGates(key, repo, repo.gates);
      if (this.c.signal(key).aborted) return false;
      this.c.store.writeArtifact(key, 'baseline.json', base);
    }
    return true;
  }

  /** Dependencies are re-installed before gates run when the lockfile changed since the last install (a failure is a visible note, not a stop). */
  private async reinstallIfLockChanged(key: string, stage: StageName, cwd?: string): Promise<void> {
    const run = this.run(key);
    const repo = this.repo(run);
    const cfg = this.c.cfg();
    const dir = cwd ?? run.worktree;
    const lock = await W.lockfileHash(dir);
    if (run.lockfileHash && run.lockfileHash !== lock) {
      const inst = await W.installDeps(dir, repo, { env: toolEnv(repo.envPassthrough), timeoutMs: cfg.pipeline.timeoutsMin.gate * 60_000, signal: this.c.signal(key) });
      if (inst.ok) this.patch(key, (r) => void (r.lockfileHash = lock));
      else this.note(key, stage, `Re-installing dependencies failed (${truncate(inst.output.slice(-200), 200)}) — gates may fail for that reason.`);
    }
  }

  private async runAllGates(key: string, repo: RepoConfig, defs: GateDef[], cwd?: string): Promise<GateRun> {
    const run = this.run(key);
    const dir = cwd ?? run.worktree;
    const o = { cwd: dir, env: toolEnv(repo.envPassthrough), timeoutMs: this.c.cfg().pipeline.timeoutsMin.gate * 60_000, signal: this.c.signal(key), secrets: this.c.secretsFor(run) };
    const results: GateResult[] = [];
    for (const def of defs) {
      let r = await G.runGate(def, o);
      if (r.exitCode !== 0 && !this.c.signal(key).aborted) r = await G.rerunFlaky(def, o, r); // flake guard
      results.push(r);
      this.c.emit(key, { agent: 'conductor', stage: 'verify', kind: 'note', ok: r.exitCode === 0, text: `gate ${def.name}: ${r.exitCode === 0 ? 'pass' : r.timedOut ? 'timeout' : `fail (${r.failureCount ?? '?'} failure${r.failureCount === 1 ? '' : 's'})`}` });
    }
    let sha = '';
    try {
      sha = await gitOk(dir, ['rev-parse', 'HEAD']);
    } catch {
      /* ignore */
    }
    return { at: this.c.clock.now(), sha, results };
  }

  // ───────────────────────── PLAN ─────────────────────────
  async plan(key: string): Promise<void> {
    let run = this.run(key);
    this.patch(key, (r) => {
      r.stage = 'plan';
      r.stageStartedAt = this.c.clock.now();
    });
    await this.applyStage(key, 'planning');
    if (!(await this.ensureWorkspace(key))) return;
    run = this.run(key);
    const { item, problem } = this.integrity(run);
    if (problem) return this.toNeedsHuman(key, problem, 'plan');
    const repo = this.repo(run);
    const comments = item ? this.c.board.comments(item.id).filter((c) => c.author === 'user').slice(-20).map((c) => truncate(c.body, 2000)) : [];
    // keep the stored project context fresh without ever holding the run up (cheap no-op when nothing changed)
    void Promise.resolve().then(() => this.c.context.refresh(run, repo)).catch(() => undefined);
    const prompt = render(loadTemplate('plan'), {
      ...(await this.projectBlocks(key, 'readonly')),
      preamble: preamble('plan'),
      key: run.key,
      task: taskBlock({ key: run.key, title: run.title, description: run.description, comments }),
      feedback: run.feedback ? fence('plan-feedback', run.feedback, 8000) : '',
      rev: String(run.rev),
      baseSha: run.baseSha.slice(0, 12),
      branch: run.branch,
      gates: repo.gates.length ? repo.gates.map((g) => `\`${g.cmd}\``).join(', ') : '(none detected)',
      maxItems: String(this.c.cfg().pipeline.maxItems),
      conventions: conventionsBlock(readConventions(run.worktree)),
    });
    const called = await this.callReadOnly(key, 'plan', prompt, PLAN_SCHEMA, run.worktree, (j) => {
      const errs = validateSchema(PLAN_SCHEMA, j);
      const p = j as Plan;
      if (!errs.length && p.blocked?.is && !(p.blocked.questions?.length > 0)) errs.push('$.blocked.questions: required when blocked.is is true');
      if (!errs.length && p.deliverable === 'answer' && !String(p.answer ?? '').trim()) errs.push('$.answer: required when deliverable is "answer"');
      if (!errs.length && p.deliverable !== 'answer' && !(p.filesToChange?.length > 0)) errs.push('$.deliverable: this plan changes no files — if the task is a question or analysis, set "deliverable" to "answer" and put the full answer in "answer"; otherwise list the files to change');
      if (!errs.length && p.deliverable !== 'answer' && !(p.acceptanceCriteria?.length > 0)) errs.push('$.acceptanceCriteria: needs at least 1 item for a code change');
      if (!errs.length) errs.push(...validateTaskGraph(p, { maxItems: this.c.cfg().pipeline.maxItems })); // a malformed decomposition goes back to the planner once (corrective re-ask), then to a human
      return errs;
    });
    if (called.kind === 'stop') return;
    const plan = called.json as Plan;
    const secretsForRun = this.c.secretsFor(run);
    plan.summary = redact(plan.summary, secretsForRun);
    if (plan.answer) plan.answer = redact(plan.answer, secretsForRun);
    for (const it of itemsOf(plan)) {
      // agent-derived strings of the decomposition are redacted once, here, before they reach any artifact, card or prompt
      it.title = redact(String(it.title ?? ''), secretsForRun);
      it.objective = redact(String(it.objective ?? ''), secretsForRun);
      if (Array.isArray(it.verification)) it.verification = it.verification.map((v) => redact(String(v), secretsForRun));
    }
    this.c.store.writeArtifact(key, `plan-${run.rev}.json`, plan);
    const md = redact(planToMarkdown(plan), secretsForRun);
    this.c.store.writeArtifact(key, `plan-${run.rev}.md`, md);
    try {
      safeWriteInside(run.worktree, '.conductor/plan.md', md); // never through a repo-planted symlink (B-1)
    } catch {
      /* non-fatal */
    }
    this.patch(key, (r) => {
      r.complexity = plan.complexity;
      r.feedback = undefined;
      r.planReviewDone = false;
      r.history.push({ ts: this.c.clock.now(), text: `Plan rev ${r.rev} ready (${plan.complexity}, ${plan.acceptanceCriteria.length} AC)` });
    });
    if (plan.blocked.is) {
      const qs = plan.blocked.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
      return this.toNeedsHuman(key, `The planner needs a decision before it can proceed:\n${qs}`, 'plan', `The planner needs your input before it can proceed:\n\n${qs}\n\nAnswer in a comment, then move this card back to **To do**.`);
    }
    if (plan.deliverable === 'answer' && String(plan.answer ?? '').trim()) {
      // a question / analysis: deliver the answer on the card and finish — never push it through build + verify
      await this.deliverAnswer(key, run.rev, plan.answer!);
      return;
    }
    await this.c.effects.comment(key, `plan:${run.rev}`, `🤖 **Conductor plan** (revision ${run.rev}, complexity ${plan.complexity})\n\n${truncate(md, 24_000)}`);
    const cfg = this.c.cfg();
    // a fast-path run (Quick Ask, user opted in) skips plan REVIEW only — and only when the planner's own plan is small and unremarkable;
    // approval, holds and policies are untouched. A plan that is not eligible takes the normal path.
    if (run.fastPath && !fastPathEligible(plan)) {
      this.patch(key, (r) => { r.fastPath = false; r.history.push({ ts: this.c.clock.now(), text: 'The plan is not small enough for the fast path — normal review applies' }); });
    }
    const wantsReview = !this.run(key).fastPath && (cfg.pipeline.planReview === 'always' || (cfg.pipeline.planReview === 'auto' && plan.complexity !== 'S'));
    if (wantsReview) {
      this.patch(key, (r) => {
        r.next = 'plan_review';
      });
      return;
    }
    await this.approvalGate(key, plan);
  }

  // ───────────────────────── PLAN REVIEW ─────────────────────────
  async planReview(key: string): Promise<void> {
    const run = this.run(key);
    this.patch(key, (r) => {
      r.stage = 'plan_review';
      r.stageStartedAt = this.c.clock.now();
    });
    const plan = this.c.store.readArtifact<Plan | null>(key, `plan-${run.rev}.json`, null);
    if (!plan) return this.toNeedsHuman(key, 'Plan artifact is missing; re-planning is needed.', 'plan');
    const repo = this.repo(run);
    const prompt = render(loadTemplate('plan-review'), {
      ...(await this.projectBlocks(key, 'readonly', plan.filesToChange.map((f) => f.path))),
      preamble: preamble('plan_review'),
      key: run.key,
      task: taskBlock({ key: run.key, title: run.title, description: run.description }),
      plan: fence('plan-under-review', planToMarkdown(plan), 30_000),
      baseSha: run.baseSha.slice(0, 12),
      gates: repo.gates.length ? repo.gates.map((g) => `\`${g.cmd}\``).join(', ') : '(none detected)',
    });
    const called = await this.callReadOnly(key, 'plan_review', prompt, PLAN_REVIEW_SCHEMA, run.worktree, (j) => validateSchema(PLAN_REVIEW_SCHEMA, j));
    if (called.kind === 'stop') return;
    const review = called.json as PlanReview;
    this.c.store.writeArtifact(key, `review-${run.rev}.json`, review);
    const blocking = review.issues.filter((i) => i.severity === 'blocking');
    const maxRounds = Math.min(5, Math.max(1, Math.floor(Number((this.c.cfg().pipeline as { planReviewRounds?: number }).planReviewRounds ?? 3)) || 3));
    if (review.decision === 'changes_requested' && blocking.length && run.planReviewRounds < maxRounds) {
      const fb = blocking.map((i, n) => `${n + 1}. ${i.text}`).join('\n');
      this.patch(key, (r) => {
        r.planReviewRounds += 1;
        r.rev += 1;
        r.feedback = `An independent review requested changes to the previous plan:\n${fb}`;
        r.next = 'plan';
        r.history.push({ ts: this.c.clock.now(), text: `Plan review requested ${blocking.length} change(s); revising` });
      });
      this.note(key, 'plan_review', `Plan review requested changes (${blocking.length}) — re-planning (round ${run.planReviewRounds + 1} of ${maxRounds}).`);
      return;
    }
    this.patch(key, (r) => {
      r.planReviewDone = true;
      r.history.push({ ts: this.c.clock.now(), text: `Plan review: ${review.decision}${review.issues.length ? ` (${review.issues.length} note(s))` : ''}` });
    });
    await this.c.effects.comment(
      key,
      `review:${run.rev}`,
      `🤖 **Plan review: ${review.decision === 'approved' ? 'approved ✅' : 'concerns noted ⚠️'}**\n\n${review.summary}${review.issues.length ? `\n\n${review.issues.map((i) => `- _${i.severity}_ — ${i.text}`).join('\n')}` : ''}`,
    );
    await this.approvalGate(key, this.c.store.readArtifact<Plan>(key, `plan-${run.rev}.json`, plan));
  }

  // ───────────────────────── APPROVAL ─────────────────────────
  async approvalGate(key: string, plan: Plan): Promise<void> {
    const run = this.run(key);
    const cfg = this.c.cfg();
    const approved = this.c.persistent.load().repos[run.repo]?.approvedPlans ?? 0;
    const touchesProtected = W.diffScopeViolations(plan.filesToChange.map((f) => f.path), []).length > 0;
    // a big decomposition is a big change of plan: more than 8 items always waits for a person (the union of the items' files is the plan's
    // file list, so the protected-path rule above already covers every item)
    const bigGraph = itemsOf(plan).length > GRAPH_BIG_ITEMS;
    const project = projectKeyOf(run.key);
    // M8-4: the run-mode overlay changes ONLY the policy and first-plan inputs (policy.ts); the forced inputs below never depend on it
    const forced = { protectedPaths: touchesProtected, untrusted: run.untrusted === true, bigGraph };
    const decision = decideApproval({
      plan,
      policy: effectivePolicy(cfg, project),
      forced,
      firstPlanHold: effectiveFirstPlanHold(cfg, approved),
      completeAuto: effectiveLiftsHolds(cfg),
    });
    if (decision.auto) {
      const byMode = decidedByRunMode(cfg, { plan, forced }, project, approved);
      this.patch(key, (r) => {
        r.planApproved = true;
        r.approvedBy = 'auto';
        r.approvedBulk = undefined;
        r.next = 'build';
        r.holdReasons = undefined;
        r.risks = undefined;
        r.forcedHold = undefined;
        if (byMode) {
          const lifted = [plan.complexity === 'L' ? 'large change' : '', touchesProtected ? 'protected files' : '', bigGraph ? 'more than 8 tasks' : ''].filter(Boolean);
          r.history.push({ ts: this.c.clock.now(), text: `Plan approved automatically (Complete auto)${lifted.length ? `; holds lifted: ${lifted.join(', ')}` : ''}` });
        }
        this.attachGraph(r, plan);
      });
      await this.c.effects.flush(key);
      return;
    }
    const why = ` (${decision.reasons.join('; ')})`;
    const secrets = this.c.secretsFor(run);
    this.patch(key, (r) => {
      r.status = 'awaiting_approval';
      r.next = 'approval';
      r.holdReasons = decision.reasons;
      r.risks = decision.risks;
      r.forcedHold = decision.forcedHold; // M8-4: stored so "Approve waiting plans" can tell forced holds apart (absent = forced)
      r.history.push({ ts: this.c.clock.now(), text: 'Waiting for plan approval' });
      // K1: the status change and its board effects are ONE write
      Effects.enqueue(r, 'state', { kind: 'state', payload: { stage: 'plan_ready' } }, secrets);
      Effects.enqueue(r, `approval:${run.rev}`, { kind: 'comment', payload: { body: `🤖 **Plan ready — your approval is needed${why}.**\n\nPress **Approve** on this card in the dashboard. To change the plan, add a comment and move the card back to **To do**.` } }, secrets);
    });
    await this.c.effects.flush(key);
    this.c.notify(`${key}: plan ready`, 'Your approval is needed.');
  }

  // ───────────────────────── BUILD ─────────────────────────
  async build(key: string): Promise<void> {
    let run = this.run(key);
    const cfg = this.c.cfg();
    const repo = this.repo(run);
    this.patch(key, (r) => {
      r.stage = 'build';
      r.stageStartedAt = this.c.clock.now();
    });
    await this.applyStage(key, 'building');
    const { problem } = this.integrity(run);
    if (problem) return this.toNeedsHuman(key, problem, 'plan');
    const plan = this.c.store.readArtifact<Plan | null>(key, `plan-${run.rev}.json`, null);
    if (!plan) return this.toNeedsHuman(key, 'The approved plan is missing; re-planning is needed.', 'plan');
    if (!(await this.ensureWorkspace(key))) return;
    run = this.run(key);

    // a task graph that is still being built is executed item by item (graph-build.ts); the whole-change fix loop after verification, and
    // a plan without a graph, continue below exactly as before
    if (run.graph && run.graph.rev !== run.rev) {
      this.patch(key, (r) => void (r.graph = undefined)); // a graph that does not belong to this plan revision is never executed
      this.note(key, 'build', 'The task graph did not belong to this plan revision — building the plan as one task.');
      run = this.run(key);
    }
    if (run.graph && run.graph.final === 'pending') return this.graphs.step(key, plan);

    // crash window: a commit exists beyond what we recorded ⇒ the builder had finished
    const head = await gitOk(run.worktree, ['rev-parse', 'HEAD']).catch(() => '');
    const known = run.commitSha ?? run.baseSha;
    if (head && head !== known && head !== run.baseSha && !(await this.hasUncommitted(run.worktree))) {
      const scope = await this.fastPathScopeProblem(run, plan, head);
      if (scope) return this.toNeedsHuman(key, scope, 'build');
      const secretProblem = await postBuildChecks(run.worktree, run.baseSha, exemptPaths(run, plan), this.c.scanEntriesFor(run), known, { deferFixtureShapes: this.c.shipEffective() });
      if (secretProblem) {
        if (this.scheduleFixtureRewrite(key, secretProblem, head)) return;
        return this.toNeedsHuman(key, secretProblem, 'build');
      }
      this.note(key, 'build', 'Found a finished build from before a restart — moving on to verification.');
      this.patch(key, (r) => {
        r.commitSha = head;
        r.next = 'verify';
      });
      return;
    }
    // Builds run in their own detached directories, never in the person's checkout, so uncommitted changes in the repository's own checkout are
    // the PERSON's. They are never backed up, reset or cleaned (the `reset --hard` + `clean -fd` below would delete their untracked files).
    if ((await this.hasUncommitted(run.worktree)) && !run.commitNote && !run.fixtureRewriteNote && !(await W.isRepoCheckout(repo.path, run.worktree))) {
      // leftover partial work from an interrupted build: keep a recoverable copy, then start clean.
      // (A commit rejected by a repo hook leaves the previous build's files in place ON PURPOSE — fixed in place.)
      let refs: Awaited<ReturnType<typeof W.backupRefs>> | null = null;
      try {
        refs = await W.backupRefs(run.worktree, run.key, run.rev);
      } catch (e) {
        return this.toNeedsHuman(key, `Unfinished work from an interrupted build could not be backed up (${truncate(errMsg(e), 160)}), so Conductor will not discard it. Check the worktree, then move the card to To do.`, 'build');
      }
      await W.resetToCommit(run.worktree, known);
      this.note(key, 'build', `Discarded partial work from an interrupted build${refs.stashRef ? ` (backup: ${refs.stashRef})` : ''}.`);
    }

    const baseline = this.c.store.readArtifact<GateRun | null>(key, 'baseline.json', null);
    const baselineFailing = baseline ? baseline.results.filter((g) => g.exitCode !== 0).map((g) => g.name).join(', ') : '';
    const rewriteNote = run.fixtureRewriteNote;
    if (rewriteNote) this.patch(key, (r) => void (r.fixtureRewriteNote = undefined));
    const emptyNote = run.emptyRetryNote;
    if (emptyNote) this.patch(key, (r) => void (r.emptyRetryNote = undefined));
    const isFix = run.loop > 1 || run.bugs.some((b) => b.status === 'open') || !!rewriteNote;
    const commonVars = {
      ...(await this.projectBlocks(key, 'builder', plan.filesToChange.map((f) => f.path))),
      preamble: preamble(isFix ? 'fix' : 'build'),
      key: run.key,
      task: taskBlock({ key: run.key, title: run.title, description: run.description }),
      plan: fence('approved-plan', planToMarkdown(plan), 40_000),
      branch: run.branch,
      protected: PROTECTED,
      gates: repo.gates.length ? repo.gates.map((g) => `\`${g.cmd}\``).join(', ') : '(none detected)',
    };
    let prompt: string;
    if (!isFix) {
      prompt = render(loadTemplate('build'), { ...commonVars, feedback: emptyNote ? fence('retry-note', emptyNote, 600) : '', baselineFailing });
    } else {
      const prevLoop = run.loop - 1;
      const cmp = this.c.store.readArtifact<{ comparison: GateComparison } | null>(key, `gates-${prevLoop}.json`, null)?.comparison;
      const gateFailures = cmp?.regressions.length ? cmp.regressions.map((r) => `- gate \`${r.gate}\`: ${r.newFailures.length ? r.newFailures.slice(0, 15).join('; ') : r.note ?? 'now failing'}`).join('\n') : '';
      prompt = render(loadTemplate('fix'), {
        ...commonVars,
        loop: String(run.loop),
        maxLoops: String(run.loopBudget),
        bugs: this.bugList(run),
        verifierSummary: this.c.store.readArtifact<Verdict | null>(key, `verdict-${prevLoop}.json`, null)?.summary ?? '',
        gateFailures,
        commitNote: [run.commitNote ? fence('commit-hook-output', run.commitNote, 4000) : '', rewriteNote ? fence('fixture-rewrite', rewriteNote, 2000) : ''].filter(Boolean).join('\n\n'),
      });
    }
    this.writePromptAudit(key, `build-${run.loop}`, prompt);
    const secrets = this.c.secretsFor(run);
    this.patch(key, (r) => {
      r.agentRuns += 1;
    });
    if (run.agentRuns + 1 > this.runsLimit(run)) {
      return this.toNeedsHuman(key, `This card has used its limit of ${this.runsLimit(run)} agent runs.`, 'build');
    }
    // Everything that makes a builder safe (eligibility, provider guard, no-push env, git-meta restore, guard check, commit guard,
    // branch scans) is the envelope's job; the stage only records facts and routes the outcome.
    await this.c.freshHealth();
    const role = isFix ? 'debugging' : 'implementation';
    const rt = route({ role, complexity: run.complexity, roles: cfg.roles, states: this.c.routeStates(role), now: this.c.clock.now(), label: providerLabel, rule: this.c.limitRule() });
    if (!rt.ok) {
      // nothing may build this card: either every eligible account is at a limit (wait, v1 semantics) or none is eligible (zero spawns, a human decides)
      this.patch(key, (r) => void (r.agentRuns = Math.max(0, r.agentRuns - 1)));
      if (rt.kind === 'paused') return this.onLimitHit(key, { provider: rt.provider, account: rt.account, resetsAt: rt.pauseUntil, message: rt.reason }, role);
      return this.toNeedsHuman(key, rt.reason, 'build');
    }
    const cand = rt.candidates[0]!;
    const builder = this.c.agents.provider(cand.id);
    const account: AccountRef = { provider: cand.id, id: cand.account };
    this.c.noteCandidate(key, account);
    if (cand.moved && !run.moved?.restarted) { // a restart's own note (limit / removal) is the more precise record: keep it
      const sk = rt.skipped.find((x) => x.id === (cfg.roles[role].providers[0] ?? cand.id));
      const note = `${sk?.why ?? 'The first choice is unavailable'} — ${this.who(account)} is building.`;
      this.note(key, 'build', note);
      this.patch(key, (r) => void (r.moved = { kind: cand.moved!, restarted: false, note: truncate(note, 300), at: this.c.clock.now(), ...(sk?.kind ? { reason: sk.kind } : {}) }));
    }
    // M8-2: the role's model/effort for the tool that actually builds (B2: a choice made for another tool is not applied) — M8-3: against THIS account's list
    const sel = this.c.agents.selectionFor(role, builder.id, { account: cand.account });
    for (const n of sel.notes) this.note(key, 'build', redact(n, secrets));
    const release = await this.c.buildSlot(this.c.signal(key));
    if (!release) return;
    const tip = (await gitOk(run.worktree, ['rev-parse', 'HEAD'])).trim();
    const buildWt = W.detachedBuildPath(repo, run.key, 'build', cfg.worktreeRoot);
    // A commit hook rejects the commit and leaves the files uncommitted. The next attempt continues in that same directory.
    const reuse = !!run.commitNote && existsSync(buildWt);
    try {
    if (!reuse) await W.openDetachedBuild(repo, buildWt, tip);
    const out = await runBuild({
      provider: builder,
      sel,
      ...(cand.account !== DEFAULT_ACCOUNT ? { account } : {}),
      repoPath: repo.path,
      worktree: buildWt,
      baseSha: run.baseSha,
      subject: `${run.key}: ${truncate(run.title, 80)}${isFix ? ` (fix, loop ${run.loop})` : ''}`,
      rev: run.rev,
      prompt,
      name: `conductor ${run.key} ${isFix ? 'fix' : 'build'} ${run.loop}`,
      onEvent: this.emitter(key, 'build', run.loop, run.rev),
      signal: this.c.signal(key),
      secrets,
      planPaths: exemptPaths(run, plan),
      scopeRevert: this.scopeRevertHook(key, plan.filesToChange.map((f) => f.path)),
      scanEntries: this.c.scanEntriesFor(run),
      deferFixtureShapes: this.c.shipEffective(),
      onPrepared: (prep) => {
        this.patch(key, (r) => {
          r.guardSha = prep.guardSha ?? undefined;
          r.guardEnvOnly = prep.envOnly;
        });
        if (prep.note) this.note(key, 'build', prep.note);
      },
      onResult: (res) => {
        this.c.agents.noteRunResult(builder.id, sel, res, cand.account);
        this.finishSession(key, res);
        this.refundIfLimit(key, res);
        if (res.ok) this.patch(key, (r) => void (r.buildFails = 0));
      },
    });
    switch (out.kind) {
      case 'held': {
        if (this.scheduleFixtureRewrite(key, out.reason)) return;
        return this.toNeedsHuman(key, out.reason, 'build');
      }
      case 'failed':
        return this.handleBuildFailure(key, out.res, out.provider, cand.account, role);
      case 'hook':
        // hook failure = feedback, never a hang
        this.patch(key, (r) => {
          r.commitNote = truncate(out.detail, 4000);
        });
        return this.nextLoopOrHuman(key, 'The repository commit hook rejected the build');
      case 'nothing': {
        // the builder may have committed by itself: accept real work instead of calling it "no changes"
        const headNow = await gitOk(buildWt, ['rev-parse', 'HEAD']).catch(() => '');
        if (headNow && headNow !== tip) {
          const selfProblem = await postBuildChecks(buildWt, run.baseSha, exemptPaths(run, plan), this.c.scanEntriesFor(run), tip, { deferFixtureShapes: this.c.shipEffective() });
          if (selfProblem) {
            if (this.scheduleFixtureRewrite(key, selfProblem)) return;
            return this.toNeedsHuman(key, selfProblem, 'build');
          }
          const selfScope = await this.fastPathScopeProblem(run, plan, headNow);
          if (selfScope) return this.toNeedsHuman(key, selfScope, 'build');
          const landed = await this.land(key, repo.path, headNow);
          if (!landed.ok) return this.toNeedsHuman(key, landed.detail, 'build');
          this.note(key, 'build', 'The builder committed its own work — keeping it and moving on to verification.');
          this.patch(key, (r) => {
            r.commitSha = landed.sha;
            r.commitNote = undefined;
            r.next = 'verify';
          });
          this.refreshContextSoon(key);
          return;
        }
        if (run.loop === 1 && !isFix) {
          const answerText = redact(String(out.res.text ?? ''), secrets).trim();
          if (plan.filesToChange.length === 0 && answerText.length >= 40) {
            // the plan itself changed nothing (a question): the builder's reply is the deliverable — finish as "answered"
            await this.deliverAnswer(key, run.rev, answerText);
            return;
          }
          if (effectiveHeal(this.c.cfg(), 'empty_attempt', run.emptyRetries)) {
            this.patch(key, (r) => {
              r.emptyRetries = (r.emptyRetries ?? 0) + 1;
              r.emptyRetryNote = EMPTY_ATTEMPT_NOTE;
              r.next = 'build';
              r.history.push({ ts: this.c.clock.now(), text: 'Complete auto: the build changed nothing — running it once more with a clarifying note' });
            });
            this.note(key, 'build', 'The builder changed nothing. Complete auto is running it once more with a clarifying note.');
            return;
          }
          return this.toNeedsHuman(key, 'The builder finished without changing any files. The task may need to be clarified.', 'build');
        }
        return this.toNeedsHuman(key, 'The builder made no changes in response to the reported problems.', 'build');
      }
      case 'committed':
        if (run.fastPath) {
          // no plan review happened: the build may touch ONLY the files the plan listed, for every path
          const planSet = new Set(plan.filesToChange.map((f) => f.path.replace(/^\.\//, '')));
          const extra = out.files.filter((f) => !planSet.has(f));
          if (extra.length) return this.toNeedsHuman(key, `This fast-path change touched files the plan did not list: ${extra.slice(0, 6).join(', ')}. They were not merged onto the current branch.`, 'build');
        }
        const landed = await this.land(key, repo.path, out.sha);
        if (!landed.ok) return this.toNeedsHuman(key, landed.detail, 'build');
        this.patch(key, (r) => {
          r.commitSha = landed.sha;
          r.commitNote = undefined;
          r.next = 'verify';
          r.history.push({ ts: this.c.clock.now(), text: `Build ${run.loop}: ${out.files.length} file(s) committed (${landed.sha.slice(0, 7)})` });
        });
        this.refreshContextSoon(key);
        return;
    }
    } finally {
      const after = this.run(key);
      const keep = !!after.commitNote && after.next === 'build' && after.status !== 'needs_human';
      if (!keep) await W.removeDetachedBuild(repo.path, buildWt).catch(() => undefined);
      release();
    }
  }

  /** The plan-time refresh can finish before the build commit lands. Scan again so the stored context matches the branch. */
  private refreshContextSoon(key: string): void {
    const run = this.run(key);
    const repo = this.repo(run);
    void this.c.context.refresh(run, repo).then(() => this.c.context.refresh(run, repo)).catch(() => undefined);
  }

  private async hasUncommitted(wt: string): Promise<boolean> {
    try {
      return (await gitOk(wt, ['status', '--porcelain'])).trim().length > 0;
    } catch {
      return false;
    }
  }

  private async handleBuildFailure(key: string, res: AgentResult, provider: ProviderId, account: string = DEFAULT_ACCOUNT, role?: Role): Promise<void> {
    const label = providerLabel(provider);
    const run = this.run(key);
    switch (res.errorKind) {
      case 'limit':
        return this.onLimitHit(key, { ...(res.limit ?? { resetsAt: null, message: res.error ?? 'limit' }), provider, account }, role);
      case 'aborted':
        return;
      case 'network':
        return this.pauseForOffline(key, res.error ?? 'network unreachable');
      case 'spawn':
        return this.toNeedsHuman(key, res.error ?? 'agent could not start', 'build');
      default: {
        if (await this.looksOffline(res)) {
          this.patch(key, (r) => void (r.agentRuns = Math.max(0, r.agentRuns - 1)));
          return this.pauseForOffline(key, res.error ?? 'network unreachable');
        }
        const tries = run.buildFails ?? 0;
        this.patch(key, (r) => {
          r.buildFails = tries + 1;
          r.history.push({ ts: this.c.clock.now(), text: `Build attempt failed: ${truncate(res.error ?? 'error', 120)}` });
        });
        if (tries < 1) {
          this.note(key, 'build', `${label} failed (${truncate(res.error ?? '', 160)}) — retrying once.`);
          return; // run.next stays 'build'; the job loop calls build again
        }
        return this.toNeedsHuman(key, `${label} failed twice: ${truncate(res.error ?? 'unknown error', 300)}`, 'build');
      }
    }
  }

  private async nextLoopOrHuman(key: string, why: string): Promise<void> {
    const run = this.run(key);
    if (run.loop >= run.loopBudget) {
      return this.toNeedsHuman(key, `${why}, and the loop limit (${run.loopBudget}) is reached.`, 'verify');
    }
    this.patch(key, (r) => {
      r.loop += 1;
      r.next = 'build';
    });
  }

  /**
   * Task graphs: a finding with a `file` is attributed to the task whose commit LAST touched that file, so the fix prompt can name the
   * suspect. The `file` is model-supplied: it counts only if it is exactly a path in `git diff --name-only <base> HEAD`, it is passed after
   * `--` with literal pathspecs, and the commit it resolves to must be 40 hex characters and one of the graph's own item commits.
   */
  private async attributeBugs(key: string, bugs: Bug[]): Promise<void> {
    const run = this.run(key);
    const g = run.graph;
    const withFile = bugs.filter((b) => typeof b.file === 'string' && b.file);
    if (!g || !withFile.length) return;
    let changed: Set<string>;
    try {
      changed = new Set((await gitOk(run.worktree, ['diff', '--name-only', '-z', run.baseSha, 'HEAD'])).split('\0').filter(Boolean));
    } catch {
      return;
    }
    for (const b of withFile) {
      const file = String(b.file);
      if (!changed.has(file)) continue;
      let sha = '';
      try {
        sha = (await gitOk(run.worktree, ['--literal-pathspecs', 'log', '-n1', '--format=%H', `${run.baseSha}..HEAD`, '--', file])).trim();
      } catch {
        continue;
      }
      if (!/^[0-9a-f]{40}$/.test(sha)) continue;
      const item = g.items.find((i) => i.commitSha === sha);
      if (!item) continue;
      const fp = bugFingerprint(b);
      this.patch(key, (r) => {
        const rec = r.bugs.find((x) => x.fp === fp);
        if (rec) rec.graphItem = item.id;
      });
    }
  }

  private bugList(run: Run): string {
    const failOn = new Set(this.c.cfg().pipeline.failOn);
    let open = run.bugs.filter((b) => b.status === 'open' && failOn.has(b.severity));
    if (!open.length) open = run.bugs.filter((b) => b.status === 'open');
    if (!open.length) return '(none recorded — see the verifier summary)';
    return fence(
      'verifier-findings',
      open
        .map((b, i) => {
          const suspect = b.graphItem ? run.graph?.items.find((x) => x.id === b.graphItem) : undefined;
          return `${i + 1}. [${b.severity}] ${b.title}\n${b.detail}${suspect ? `\n(Introduced by task ${suspect.id} "${sanitizeLine(suspect.title, 100)}")` : ''}`;
        })
        .join('\n\n'),
      24_000,
    );
  }

  // ───────────────────────── VERIFY ─────────────────────────
  async verify(key: string): Promise<void> {
    let run = this.run(key);
    const cfg = this.c.cfg();
    const repo = this.repo(run);
    this.patch(key, (r) => {
      r.stage = 'verify';
      r.stageStartedAt = this.c.clock.now();
    });
    await this.applyStage(key, 'verifying');
    const { problem } = this.integrity(run);
    if (problem) return this.toNeedsHuman(key, problem, 'plan');
    const plan = this.c.store.readArtifact<Plan | null>(key, `plan-${run.rev}.json`, null);
    if (!plan) return this.toNeedsHuman(key, 'The approved plan is missing; re-planning is needed.', 'plan');

    // 1) deterministic gates (ground truth), compared against the baseline by failure set
    await this.reinstallIfLockChanged(key, 'verify');
    const baseline = this.c.store.readArtifact<GateRun | null>(key, 'baseline.json', null);
    let current: GateRun = { at: this.c.clock.now(), sha: run.commitSha ?? '', results: [] };
    let comparison: GateComparison = { regressions: [], preExisting: [], unverified: [], passed: [] };
    let unverifiedWhy: string | undefined;
    if (repo.gates.length) {
      current = await this.runAllGates(key, repo, repo.gates);
      if (this.c.signal(key).aborted) return;
      comparison = G.compareGates(baseline, current);
      if (comparison.unverified.length) unverifiedWhy = `Gate(s) already failing before the change with unparseable output — regressions cannot be excluded: ${comparison.unverified.join(', ')}`;
    } else {
      unverifiedWhy = 'No automated quality gates (tests/lint/typecheck) were detected for this repository — the result rests on the AI review alone.';
      if (cfg.pipeline.noGates === 'block') {
        return this.toNeedsHuman(key, `${unverifiedWhy} Add gate commands for this repo (config) or set noGates to "warn".`, 'verify');
      }
    }
    this.c.store.writeArtifact(key, `gates-${run.loop}.json`, { run: current, comparison });
    this.patch(key, (r) => {
      r.unverified = !!unverifiedWhy;
      r.unverifiedWhy = unverifiedWhy;
    });

    // 2) the diff the verifier reads
    const diff = await W.diffAgainst(run.worktree, run.baseSha);
    if (diff.files.length === 0) {
      if (effectiveHeal(cfg, 'empty_attempt', run.emptyRetries)) {
        // the empty-attempt budget is shared with the build stage: one more build, then stuck
        this.patch(key, (r) => {
          r.emptyRetries = (r.emptyRetries ?? 0) + 1;
          r.emptyRetryNote = EMPTY_ATTEMPT_NOTE;
          r.next = 'build';
          r.history.push({ ts: this.c.clock.now(), text: 'Complete auto: there was nothing to verify — running the build once more with a clarifying note' });
        });
        this.note(key, 'verify', 'There was nothing to verify. Complete auto is running the build once more.');
        return;
      }
      return this.toNeedsHuman(key, 'There is nothing to verify: the branch has no changes compared with its base. The build may not have run — move the card back to To do to try again.', 'build');
    }
    this.c.store.writeArtifact(key, 'diffstat.txt', diff.stat);
    try {
      safeWriteInside(run.worktree, '.conductor/diff.patch', diff.patch);
    } catch {
      /* non-fatal */
    }
    run = this.run(key);
    const prompt = render(loadTemplate('verify'), {
      ...(await this.projectBlocks(key, 'readonly', plan.filesToChange.map((f) => f.path))),
      preamble: preamble('verify'),
      key: run.key,
      task: taskBlock({ key: run.key, title: run.title, description: run.description }),
      plan: fence('approved-plan', planToMarkdown(plan), 40_000),
      gates: this.renderGates(baseline, current, comparison, repo.gates),
      unverifiedNote: unverifiedWhy ?? '',
      baseSha: run.baseSha.slice(0, 12),
      diffStat: truncate(diff.stat, 4000),
      diffPath: '.conductor/diff.patch',
    });
    const called = await this.callReadOnly(key, 'verify', prompt, VERDICT_SCHEMA, run.worktree, (j) => validateSchema(VERDICT_SCHEMA, j));
    if (called.kind === 'stop') return;
    const verdict = called.json as Verdict;
    this.c.store.writeArtifact(key, `verdict-${run.loop}.json`, verdict);
    await this.decide(key, plan, verdict, comparison, diff.stat);
  }

  private renderGates(baseline: GateRun | null, current: GateRun, cmp: GateComparison, defs: GateDef[]): string {
    if (!defs.length) return '_No automated gates ran._';
    const lines = ['| Gate | Command | Before the change | After | Verdict |', '| --- | --- | --- | --- | --- |'];
    for (const r of current.results) {
      const b = baseline?.results.find((x) => x.name === r.name);
      const status = cmp.regressions.some((x) => x.gate === r.name) ? 'REGRESSION' : cmp.unverified.includes(r.name) ? 'unverified for regressions' : cmp.preExisting.includes(r.name) ? 'pre-existing failure' : 'pass';
      lines.push(`| ${r.name} | \`${r.cmd}\` | ${b ? (b.exitCode === 0 ? 'pass' : `fail${b.failureCount != null ? ` (${b.failureCount})` : ''}`) : 'n/a'} | ${r.exitCode === 0 ? 'pass' : `fail${r.failureCount != null ? ` (${r.failureCount})` : ''}`} | ${status} |`);
    }
    const detail = current.results
      .filter((r) => r.exitCode !== 0)
      .map((r) => `#### ${r.name} output (tail)\n${fence(`gate:${r.name}`, r.outputTail.slice(-2500), 2600)}${cmp.regressions.find((x) => x.gate === r.name)?.newFailures.length ? `\nNew failures: ${cmp.regressions.find((x) => x.gate === r.name)!.newFailures.slice(0, 15).join('; ')}` : ''}`);
    return [...lines, '', ...detail].join('\n');
  }

  private async decide(key: string, plan: Plan, verdict: Verdict, cmp: GateComparison, diffStat: string): Promise<void> {
    const run = this.run(key);
    const cfg = this.c.cfg();
    const failOn = new Set(cfg.pipeline.failOn);
    const bugs: Bug[] = [...verdict.bugs];
    for (const r of cmp.regressions) {
      bugs.push({
        title: `Quality gate regression: ${r.gate}`,
        severity: 'blocker',
        evidence: r.newFailures.length ? `New failures: ${r.newFailures.slice(0, 15).join('; ')}` : r.note ?? 'The gate fails now but passed (or had fewer failures) before the change.',
        suggestedFix: `Run \`${r.gate}\` locally and fix the new failures.`,
      });
    }
    // An unmet criterion with no real finding behind it still needs actionable feedback for the fix loop.
    if (!bugs.some((b) => failOn.has(b.severity))) {
      for (const a of verdict.acceptance) {
        if (a.status === 'not_met') bugs.push({ title: `Acceptance criterion not met: ${a.id}`, severity: 'major', evidence: a.evidence });
      }
    }
    // A `fail` verdict whose only substance is unverifiable criteria or minor/nit findings: hand them to the builder as major bugs.
    // Titles/files are kept (or derived only from the criterion id), so bugFingerprint is stable across loops and no card is duplicated.
    if (verdict.verdict === 'fail' && !bugs.some((b) => failOn.has(b.severity))) {
      const promoted = bugs.map((b) => (failOn.has(b.severity) ? b : { ...b, severity: 'major' as const }));
      bugs.splice(0, bugs.length, ...promoted);
      for (const a of verdict.acceptance) {
        if (a.status === 'unverifiable') {
          bugs.push({
            title: `Acceptance criterion could not be verified: ${a.id}`,
            severity: 'major',
            evidence: a.evidence,
            suggestedFix: 'Make the behaviour demonstrable (add or adjust a test, or make it observable) so the verifier can confirm it.',
          });
        }
      }
    }
    const failing = bugs.filter((b) => failOn.has(b.severity));
    const pass = verdict.verdict === 'pass' && failing.length === 0;

    // Not a pass, yet nothing the builder could act on (e.g. only an "unverifiable" criterion or nitpicks):
    // looping Cursor with an empty problem list just burns quota — hand it to a human with the verifier's reasoning.
    if (!pass && failing.length === 0) {
      const unver = verdict.acceptance.filter((a) => a.status === 'unverifiable');
      const minor = bugs.filter((b) => !failOn.has(b.severity));
      this.patch(key, (r) => {
        r.verdict = 'fail';
      });
      const detail = [
        verdict.summary,
        unver.length ? `\nCould not be verified automatically:\n${unver.map((a) => `- ${a.id}: ${a.evidence}`).join('\n')}` : '',
        minor.length ? `\nMinor notes:\n${minor.map((b) => `- (${b.severity}) ${b.title}`).join('\n')}` : '',
      ].filter(Boolean).join('\n');
      return this.toNeedsHuman(
        key,
        `The verifier did not pass this change, but found nothing the builder can fix: ${truncate(verdict.summary, 300)}`,
        'verify',
        `The independent verifier could not give a clean pass, and it did not report a concrete problem for the builder to fix, so I am not looping.\n\n${detail}\n\nIf you are happy with the branch as it is, you can merge it; to have me verify again, move the card back to **To do**.`,
      );
    }

    // bug records: upsert by fingerprint, close those not re-observed
    const seen = new Set<string>();
    const reopened = new Map<string, BugRec>();
    const detailOf = new Map<string, string>();
    for (const b of bugs) {
      const fp = bugFingerprint(b);
      seen.add(fp);
      const detail = `**Severity:** ${b.severity}${b.file ? `\n**File:** \`${b.file}${b.line ? `:${b.line}` : ''}\`` : ''}\n\n**Evidence:** ${b.evidence}${b.repro ? `\n\n**Repro:** ${b.repro}` : ''}${b.suggestedFix ? `\n\n**Suggested fix:** ${b.suggestedFix}` : ''}`;
      detailOf.set(fp, detail);
      this.patch(key, (r) => {
        const cur = r.bugs.find((x) => x.fp === fp);
        if (cur) {
          if (cur.status === 'closed') reopened.set(fp, { ...cur });
          cur.status = 'open';
          cur.detail = detail;
          cur.severity = b.severity;
          if (!cur.loops.includes(run.loop)) cur.loops.push(run.loop);
        } else {
          r.bugs.push({ fp, title: b.title, severity: b.severity, file: b.file, detail, status: 'open', loops: [run.loop] });
        }
      });
    }

    if (run.graph) await this.attributeBugs(key, bugs);

    // Board: file at most N bug cards per loop / per run (most severe first); summarise the rest in the comment.
    const PER_LOOP = 5;
    const PER_RUN = 8;
    const rank: Record<string, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };
    const overflow: Bug[] = [];
    if (!pass) {
      let createdNow = 0;
      for (const b of [...failing].sort((x, y) => (rank[x.severity] ?? 9) - (rank[y.severity] ?? 9))) {
        const fp = bugFingerprint(b);
        const cur = this.run(key).bugs.find((x) => x.fp === fp);
        const re = reopened.get(fp);
        if (re?.itemId) {
          await this.c.effects.close(key, `bugreopen:${fp}:${run.rev}:${run.loop}`, re.itemId, 'todo');
        } else if (cur?.itemId) {
          await this.c.effects.commentOn(key, `bugseen:${fp}:${run.rev}:${run.loop}`, cur.itemId, `Still failing after loop ${run.loop}:\n\n${detailOf.get(fp) ?? b.evidence}`);
        } else if (createdNow < PER_LOOP && this.run(key).bugs.filter((x) => x.itemId).length + createdNow < PER_RUN) {
          createdNow += 1;
          await this.c.effects.subIssue(key, `bug:${fp}`, {
            fp,
            title: `[Bug] ${b.title}`,
            description: `Found by Conductor's independent verification of **${run.key}** (loop ${run.loop}).\n\n${detailOf.get(fp) ?? b.evidence}`,
          });
        } else overflow.push(b);
      }
    }

    const toClose: BugRec[] = [];
    this.patch(key, (r) => {
      for (const b of r.bugs) {
        if (b.status === 'open' && (pass || !seen.has(b.fp))) {
          b.status = 'closed';
          toClose.push({ ...b });
        }
      }
      r.verdict = pass ? 'pass' : 'fail';
    });
    for (const b of toClose) if (b.itemId) await this.c.effects.close(key, `bugclose:${b.fp}:${run.rev}:${run.loop}`, b.itemId, 'done');

    if (pass) return this.markReady(key, plan, verdict, cmp, diffStat);

    const summary = `🤖 **Verification failed (loop ${run.loop}/${run.loopBudget})**\n\n${verdict.summary}\n\n${failing.map((b) => `- **${b.severity}** ${b.title}${b.file ? ` — \`${b.file}\`` : ''}`).join('\n')}${overflow.length ? `\n\n_${overflow.length} more finding(s) were not filed as separate issues (limit per loop): ${overflow.map((b) => b.title).join('; ')}_` : ''}`;
    await this.c.effects.comment(key, `verify:${run.rev}:${run.loop}`, summary);
    this.patch(key, (r) => {
      r.history.push({ ts: this.c.clock.now(), text: `Verification ${run.loop}: ${failing.length} problem(s)` });
    });
    await this.nextLoopOrHuman(key, `Verification still finds ${failing.length} problem(s)`);
  }

  private async markReady(key: string, plan: Plan, verdict: Verdict, cmp: GateComparison, diffStat: string): Promise<void> {
    const run = this.run(key);
    const repo = this.repo(run);
    const acTable = verdict.acceptance.length ? ['| AC | Status | Evidence |', '| --- | --- | --- |', ...verdict.acceptance.map((a) => `| ${a.id} | ${a.status} | ${a.evidence.replace(/\|/g, '\\|').replace(/\n+/g, ' ')} |`)].join('\n') : '';
    const gates = cmp.passed.length || cmp.preExisting.length || cmp.unverified.length ? `Gates passed: ${cmp.passed.join(', ') || '—'}${cmp.preExisting.length ? `\nPre-existing failures (not caused by this change): ${cmp.preExisting.join(', ')}` : ''}` : '';
    const secrets = this.c.secretsFor(run);
    const body = [
      `🤖 **Ready for review ✅**${run.unverified ? ' — ⚠️ **not verified by automated tests**' : ''}`,
      '',
      verdict.summary,
      '',
      acTable,
      '',
      gates,
      run.unverifiedWhy ? `\n> ⚠️ ${run.unverifiedWhy}` : '',
      '',
      `**Branch:** \`${run.branch}\` (base \`${run.baseSha.slice(0, 7)}\`)`,
      '',
      '```',
      truncate(diffStat, 1500),
      '```',
      '',
      'Review (inside the repo): `' + `git diff ${run.baseSha.slice(0, 7)}...${run.branch}` + '`',
      'Merge when you are happy: `' + `git merge --no-ff ${run.branch}` + '` (Conductor never merges or pushes).',
    ]
      .filter((l) => l !== undefined)
      .join('\n');
    this.patch(key, (r) => {
      r.status = 'ready';
      r.next = 'none';
      r.needsHuman = undefined;
      if (r.graph) r.graph.final = 'done';
      r.history.push({ ts: this.c.clock.now(), text: `Verified — ready for your review${r.unverified ? ' (unverified by tests)' : ''}` });
      // K1: "ready" and its board effects are ONE write
      Effects.enqueue(r, 'state', { kind: 'state', payload: { stage: 'ready' } }, secrets);
      Effects.enqueue(r, `ready:${run.rev}:${run.loop}`, { kind: 'comment', payload: { body } }, secrets);
    });
    await this.c.effects.flush(key);
    const st = this.c.persistent.load();
    void plan;
    void st;
    this.c.notify(`${key} is ready`, `${truncate(run.title, 80)} — verified${run.unverified ? ' (no tests)' : ''}.`);
  }

  // used by the engine when a human approves
  markApproved(key: string, by: 'human' | 'auto', bulk = false): void {
    const run = this.run(key);
    const st = this.c.persistent.load();
    st.repos[run.repo] = { approvedPlans: (st.repos[run.repo]?.approvedPlans ?? 0) + 1 };
    this.c.persistent.save(st);
    const plan = this.c.store.readArtifact<Plan | null>(key, `plan-${run.rev}.json`, null);
    this.patch(key, (r) => {
      r.planApproved = true;
      r.approvedBy = by;
      r.approvedBulk = bulk || undefined;
      r.status = 'queued';
      r.next = 'build';
      r.forcedHold = undefined; // M8-4 (N1): holdReasons stay as today; the view hides them outside awaiting_approval
      r.history.push({ ts: this.c.clock.now(), text: `Plan approved (${by})` });
      this.attachGraph(r, plan);
    });
  }

  /**
   * Turn an approved plan's decomposition into the run's task graph and queue one board card per item (plan M3 §2b). Called INSIDE the
   * `store.update` that records the approval, so a crash can never leave an approved plan with half a graph: the graph and its pending card
   * effects are written together, and the card effects (keyed by plan revision + item) are idempotent. A plan without a real graph
   * (fewer than 2 items) leaves the run exactly as the single-task pipeline expects it.
   */
  private attachGraph(r: Run, plan: Plan | null): void {
    if (!plan || !isGraphPlan(plan)) {
      r.graph = undefined;
      return;
    }
    if (r.graph && r.graph.rev === r.rev) return; // already attached for this revision
    const graph = buildGraph(plan, r.rev, this.c.clock.now(), r.loopBudget);
    r.graph = graph;
    const secrets = this.c.secretsFor(r);
    for (const id of topoOrder(graph.items) ?? []) {
      const it = graph.items.find((x) => x.id === id)!;
      Effects.enqueue(r, `subtask:${r.rev}:${id}`, { kind: 'subtask', payload: { rev: r.rev, itemId: id, title: it.title, description: describeItem(it), dependsOn: it.dependsOn } }, secrets);
    }
    r.history.push({ ts: this.c.clock.now(), text: `Task graph attached: ${graph.items.length} tasks (plan rev ${r.rev})` });
  }

  /** Short hash used to detect description edits. */
  static descHash(description: string): string {
    return sha1(description ?? '');
  }
  static sha256 = sha256;
  static fmt = fmtDuration;
}
