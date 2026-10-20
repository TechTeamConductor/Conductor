import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentResult, Bug, BugRec, GateComparison, GateDef, GateResult, GateRun, LimitInfo, NextStep, Plan,
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
import { postBuildChecks, runBuild } from './envelope.ts';
import { providerLabel } from '../agents/providers/registry.ts';
import type { ProviderId } from '../agents/providers/types.ts';
import { route } from '../agents/routing.ts';
import type { PipelineCtx } from './context.ts';
import { PLAN_REVIEW_SCHEMA, PLAN_SCHEMA, VERDICT_SCHEMA } from './schemas.ts';
import { conventionsBlock, fence, loadTemplate, planToMarkdown, preamble, render, taskBlock } from './prompts.ts';

const log = logger('stages');
const PROTECTED = '.claude/**, .cursor/**, .codex/**, .agents/**, .mcp.json, AGENTS.md, agents.override.md, CLAUDE.md, GEMINI.md, .github/**, .husky/**, .git*, .techteam/**, .conductor/**';

type ReadOnlyStage = 'plan' | 'plan_review' | 'verify';
type Called = { kind: 'ok'; json: unknown; result: AgentResult; agent: ProviderId } | { kind: 'stop' };

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
  constructor(ctx: PipelineCtx) {
    this.c = ctx;
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

  async toNeedsHuman(key: string, reasonRaw: string, origin: NextStep, commentRaw?: string): Promise<void> {
    const now = this.c.clock.now();
    const secrets = this.c.secretsFor(this.run(key));
    const reason = redact(reasonRaw, secrets); // agent/gate text can carry secrets into the UI, notifications and the board (H3)
    const comment = commentRaw === undefined ? undefined : redact(commentRaw, secrets);
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

  /** A candidate hit a usage limit but the chain moved on: remember the pause so later stages skip that provider until it resets. */
  recordLimitPause(limit: LimitInfo): void {
    const now = this.c.clock.now();
    const until = limit.resetsAt && limit.resetsAt > now ? limit.resetsAt : now + 15 * 60_000;
    this.c.providerPause(limit.provider, until, limit.message);
  }

  /**
   * Pause (never fail) on a provider usage limit. With a known reset time we wait for it; with an unknown one
   * (Cursor) we back off 15 m → 30 m → 1 h → 2 h → 4 h → 6 h. One board comment and one notification per limit
   * *episode* (a streak of consecutive rejections), and rejected attempts never count toward the run budget.
   */
  async pauseForLimit(key: string, limit: LimitInfo): Promise<void> {
    const now = this.c.clock.now();
    const before = this.run(key);
    const streak = (before.limitStreak ?? 0) + 1;
    const episode = streak === 1 ? (before.limitEpisode ?? 0) + 1 : before.limitEpisode ?? 1;
    if (episode > 6) {
      // M12: a run that keeps getting rejected (or a provider that keeps faking limits) must not stall silently forever
      return this.toNeedsHuman(key, `This task has hit a usage limit ${episode - 1} separate times. Check your ${providerLabel(limit.provider)} plan limits, then move it to To do to retry.`, before.next);
    }
    const known = !!limit.resetsAt && limit.resetsAt > now;
    const backoffMin = Math.min(360, 15 * 2 ** (streak - 1));
    const until = known ? limit.resetsAt! : now + backoffMin * 60_000;
    this.c.providerPause(limit.provider, until, limit.message);
    this.patch(key, (r) => {
      r.status = 'paused';
      r.pausedUntil = until;
      r.pauseReason = truncate(limit.message, 300);
      r.limitStreak = streak;
      r.limitEpisode = episode;
      if (streak === 1) r.history.push({ ts: now, text: `Paused: ${limit.provider} usage limit — resuming automatically` });
    });
    this.c.emit(key, { agent: limit.provider, stage: this.run(key).stage ?? 'engine', kind: 'error', text: `Usage limit reached — paused until ${new Date(until).toLocaleString()}` });
    if (streak === 1) {
      await this.c.effects.comment(
        key,
        `pause:ep${episode}`,
        `🤖 **Paused — ${providerLabel(limit.provider)} usage limit reached.** Conductor will resume automatically${known ? ` after ${new Date(until).toLocaleString()}` : ' (it retries with growing gaps until the limit lifts)'}. Nothing is lost.`,
      );
      this.c.notify('Usage limit reached', `${limit.provider} — Conductor resumes automatically`);
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
      if (res.ok) r.limitStreak = 0;
    });
  }
  /** A limit-rejected attempt did no work: it must not eat the per-card run budget. */
  private refundIfLimit(key: string, res: AgentResult): void {
    if (!res.ok && res.errorKind === 'limit') this.patch(key, (r) => void (r.agentRuns = Math.max(0, r.agentRuns - 1)));
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
  ): Promise<Called> {
    let corrective = '';
    let retried = false;
    let turnsFactor = 1;
    for (let attempt = 0; attempt < 4; attempt++) {
      const run = this.run(key);
      if (this.c.signal(key).aborted) return { kind: 'stop' };
      if (run.agentRuns >= this.c.cfg().pipeline.maxAgentRunsPerIssue) {
        await this.toNeedsHuman(key, `This card has used its limit of ${this.c.cfg().pipeline.maxAgentRunsPerIssue} agent runs. Review the work so far, then move it back to To do to continue.`, run.next);
        return { kind: 'stop' };
      }
      this.patch(key, (r) => {
        r.agentRuns += 1;
      });
      const cfg = this.c.cfg();
      await this.c.freshHealth();
      const res = await this.c.agents.readOnly({
        role: stage === 'plan' ? 'planning' : stage === 'plan_review' ? 'review' : 'verification',
        complexity: run.complexity,
        states: this.c.routeStates(),
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
      this.finishSession(key, res);
      this.refundIfLimit(key, res);
      if (res.fellBack && res.from && res.from !== res.agent) {
        // a visible, durable trace on the card when a read-only step ran on a different (possibly weaker-isolation) provider than configured
        const tier = this.c.routeStates()[res.agent]?.tier;
        const note = tier === 'partial' ? " It ran in ask mode, which has weaker isolation than Claude's fail-closed tool lock-down." : tier === 'unverified' ? " Its isolation has not been verified on this machine." : '';
        await this.c.effects.comment(key, `fallback:${stage}:${run.loop}:${res.agent}`, `🤖 **${providerLabel(res.agent)} did the ${stage.replace('_', ' ')} step instead of ${providerLabel(res.from)}.**${note}`);
      }
      if (res.quota) this.c.recordQuota(res.agent, res.quota);
      this.writePromptAudit(key, `${stage}-${run.loop}-${attempt}`, prompt + corrective);
      if (res.ok) {
        const errs = validate(res.json);
        if (!errs.length) return { kind: 'ok', json: res.json, result: res, agent: res.agent };
        if (!retried) {
          retried = true;
          corrective = `\n\n## Your previous reply was rejected\nIt did not match the required format:\n${errs.slice(0, 8).map((e) => `- ${e}`).join('\n')}\nReturn a corrected JSON object.`;
          this.note(key, stage, `Reply failed validation (${errs[0]}) — asking once more.`);
          continue;
        }
        await this.toNeedsHuman(key, `The ${res.agent} reply kept failing validation: ${errs[0]}`, run.next);
        return { kind: 'stop' };
      }
      switch (res.errorKind) {
        case 'limit':
          await this.pauseForLimit(key, res.limit ?? { provider: res.agent, resetsAt: null, message: res.error ?? 'limit' });
          return { kind: 'stop' };
        case 'aborted':
          return { kind: 'stop' };
        case 'auth': // not signed in: another attempt cannot help — say how to sign in (the message carries the exact command)
        case 'isolation':
        case 'spawn':
          await this.toNeedsHuman(key, res.error ?? 'agent could not start', run.next);
          return { kind: 'stop' };
        case 'max_turns':
          if (!retried) {
            retried = true;
            turnsFactor = 1.5;
            this.note(key, stage, 'Hit the turn cap — retrying once with a higher cap.');
            continue;
          }
          await this.toNeedsHuman(key, 'The agent ran out of turns twice. The task may be too large — consider splitting the card.', run.next);
          return { kind: 'stop' };
        case 'parse':
          if (!retried) {
            retried = true;
            corrective = '\n\n## Your previous reply was rejected\nNo JSON object could be found. Reply with ONLY the fenced ```json block.';
            continue;
          }
          await this.toNeedsHuman(key, res.error ?? 'could not parse the agent reply', run.next);
          return { kind: 'stop' };
        default: // timeouts and generic agent errors: one more attempt, then a human
          if (!retried) {
            retried = true;
            this.note(key, stage, `${res.agent} failed (${truncate(res.error ?? '', 160)}) — retrying once.`);
            continue;
          }
          await this.toNeedsHuman(key, `${res.agent} failed twice: ${truncate(res.error ?? 'unknown error', 300)}`, run.next);
          return { kind: 'stop' };
      }
    }
    await this.toNeedsHuman(key, 'The agent could not produce a valid reply.', this.run(key).next);
    return { kind: 'stop' };
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
      // B-2: only ever work in the checkout v2 itself created for this card
      try {
        await W.assertOwnedWorktree(repo, run.key, run.worktree, cfg.worktreeRoot);
      } catch (e) {
        await this.toNeedsHuman(key, errMsg(e), 'plan');
        return false;
      }
    }
    if (!run.worktree || !existsSync(run.worktree)) {
      this.note(key, 'plan', `Creating isolated worktree for ${repo.name}…`);
      const wt = await W.createWorktree({ repo, key: run.key, worktreeRoot: cfg.worktreeRoot });
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

  private async runAllGates(key: string, repo: RepoConfig, defs: GateDef[]): Promise<GateRun> {
    const run = this.run(key);
    const o = { cwd: run.worktree, env: toolEnv(repo.envPassthrough), timeoutMs: this.c.cfg().pipeline.timeoutsMin.gate * 60_000, signal: this.c.signal(key), secrets: this.c.secretsFor(run) };
    const results: GateResult[] = [];
    for (const def of defs) {
      let r = await G.runGate(def, o);
      if (r.exitCode !== 0 && !this.c.signal(key).aborted) r = await G.rerunFlaky(def, o, r); // flake guard
      results.push(r);
      this.c.emit(key, { agent: 'conductor', stage: 'verify', kind: 'note', ok: r.exitCode === 0, text: `gate ${def.name}: ${r.exitCode === 0 ? 'pass' : r.timedOut ? 'timeout' : `fail (${r.failureCount ?? '?'} failure${r.failureCount === 1 ? '' : 's'})`}` });
    }
    let sha = '';
    try {
      sha = await gitOk(run.worktree, ['rev-parse', 'HEAD']);
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
    const prompt = render(loadTemplate('plan'), {
      preamble: preamble('plan'),
      key: run.key,
      task: taskBlock({ key: run.key, title: run.title, description: run.description, comments }),
      feedback: run.feedback ? fence('plan-feedback', run.feedback, 8000) : '',
      rev: String(run.rev),
      baseSha: run.baseSha.slice(0, 12),
      branch: run.branch,
      gates: repo.gates.length ? repo.gates.map((g) => `\`${g.cmd}\``).join(', ') : '(none detected)',
      conventions: conventionsBlock(readConventions(run.worktree)),
    });
    const called = await this.callReadOnly(key, 'plan', prompt, PLAN_SCHEMA, run.worktree, (j) => {
      const errs = validateSchema(PLAN_SCHEMA, j);
      const p = j as Plan;
      if (!errs.length && p.blocked?.is && !(p.blocked.questions?.length > 0)) errs.push('$.blocked.questions: required when blocked.is is true');
      if (!errs.length && p.deliverable === 'answer' && !String(p.answer ?? '').trim()) errs.push('$.answer: required when deliverable is "answer"');
      if (!errs.length && p.deliverable !== 'answer' && !(p.filesToChange?.length > 0)) errs.push('$.deliverable: this plan changes no files — if the task is a question or analysis, set "deliverable" to "answer" and put the full answer in "answer"; otherwise list the files to change');
      if (!errs.length && p.deliverable !== 'answer' && !(p.acceptanceCriteria?.length > 0)) errs.push('$.acceptanceCriteria: needs at least 1 item for a code change');
      return errs;
    });
    if (called.kind === 'stop') return;
    const plan = called.json as Plan;
    const secretsForRun = this.c.secretsFor(run);
    plan.summary = redact(plan.summary, secretsForRun);
    if (plan.answer) plan.answer = redact(plan.answer, secretsForRun);
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
    const wantsReview = cfg.pipeline.planReview === 'always' || (cfg.pipeline.planReview === 'auto' && plan.complexity !== 'S');
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
    const maxRounds = 1;
    if (review.decision === 'changes_requested' && blocking.length && run.planReviewRounds < maxRounds) {
      const fb = blocking.map((i, n) => `${n + 1}. ${i.text}`).join('\n');
      this.patch(key, (r) => {
        r.planReviewRounds += 1;
        r.rev += 1;
        r.feedback = `An independent review requested changes to the previous plan:\n${fb}`;
        r.next = 'plan';
        r.history.push({ ts: this.c.clock.now(), text: `Plan review requested ${blocking.length} change(s); revising` });
      });
      this.note(key, 'plan_review', `Plan review requested changes (${blocking.length}) — re-planning once.`);
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
    const required = cfg.pipeline.planApproval === 'manual' || (cfg.pipeline.planApproval === 'first' && approved === 0) || plan.complexity === 'L' || touchesProtected || run.untrusted === true;
    if (!required) {
      this.patch(key, (r) => {
        r.planApproved = true;
        r.approvedBy = 'auto';
        r.next = 'build';
      });
      return;
    }
    const why = touchesProtected ? ' (the plan touches protected files such as CI or agent config)' : plan.complexity === 'L' ? ' (large change)' : run.untrusted ? ' (the task text came from an unverified source)' : approved === 0 ? ' (first plan for this repo)' : '';
    const secrets = this.c.secretsFor(run);
    this.patch(key, (r) => {
      r.status = 'awaiting_approval';
      r.next = 'approval';
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

    // crash window: a commit exists beyond what we recorded ⇒ the builder had finished
    const head = await gitOk(run.worktree, ['rev-parse', 'HEAD']).catch(() => '');
    const known = run.commitSha ?? run.baseSha;
    if (head && head !== known && head !== run.baseSha && !(await this.hasUncommitted(run.worktree))) {
      this.note(key, 'build', 'Found a finished build from before a restart — moving on to verification.');
      this.patch(key, (r) => {
        r.commitSha = head;
        r.next = 'verify';
      });
      return;
    }
    if ((await this.hasUncommitted(run.worktree)) && !run.commitNote) {
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
    const isFix = run.loop > 1 || run.bugs.some((b) => b.status === 'open');
    const commonVars = {
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
      prompt = render(loadTemplate('build'), { ...commonVars, feedback: '', baselineFailing });
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
        commitNote: run.commitNote ? fence('commit-hook-output', run.commitNote, 4000) : '',
      });
    }
    this.writePromptAudit(key, `build-${run.loop}`, prompt);
    const secrets = this.c.secretsFor(run);
    this.patch(key, (r) => {
      r.agentRuns += 1;
    });
    if (run.agentRuns + 1 > cfg.pipeline.maxAgentRunsPerIssue) {
      return this.toNeedsHuman(key, `This card has used its limit of ${cfg.pipeline.maxAgentRunsPerIssue} agent runs.`, 'build');
    }
    // Everything that makes a builder safe (eligibility, provider guard, no-push env, git-meta restore, guard check, commit guard,
    // branch scans) is the envelope's job; the stage only records facts and routes the outcome.
    await this.c.freshHealth();
    const role = isFix ? 'debugging' : 'implementation';
    const rt = route({ role, complexity: run.complexity, roles: cfg.roles, states: this.c.routeStates(), now: this.c.clock.now(), label: providerLabel });
    if (!rt.ok) {
      // nothing may build this card: either every eligible provider is at a limit (wait, v1 semantics) or none is eligible (zero spawns, a human decides)
      this.patch(key, (r) => void (r.agentRuns = Math.max(0, r.agentRuns - 1)));
      if (rt.kind === 'paused') return this.pauseForLimit(key, { provider: rt.provider, resetsAt: rt.pauseUntil, message: rt.reason });
      return this.toNeedsHuman(key, rt.reason, 'build');
    }
    const builder = this.c.agents.provider(rt.candidates[0]!.id);
    const out = await runBuild({
      provider: builder,
      repoPath: repo.path,
      worktree: run.worktree,
      baseSha: run.baseSha,
      subject: `${run.key}: ${truncate(run.title, 80)}${isFix ? ` (fix, loop ${run.loop})` : ''}`,
      rev: run.rev,
      prompt,
      name: `conductor ${run.key} ${isFix ? 'fix' : 'build'} ${run.loop}`,
      onEvent: this.emitter(key, 'build', run.loop, run.rev),
      signal: this.c.signal(key),
      secrets,
      planPaths: plan.filesToChange.map((f) => f.path),
      onPrepared: (prep) => {
        this.patch(key, (r) => {
          r.guardSha = prep.guardSha ?? undefined;
          r.guardEnvOnly = prep.envOnly;
        });
        if (prep.note) this.note(key, 'build', prep.note);
      },
      onResult: (res) => {
        this.finishSession(key, res);
        this.refundIfLimit(key, res);
        if (res.ok) this.patch(key, (r) => void (r.buildFails = 0));
      },
    });
    switch (out.kind) {
      case 'held':
        return this.toNeedsHuman(key, out.reason, 'build');
      case 'failed':
        return this.handleBuildFailure(key, out.res, out.provider);
      case 'hook':
        // hook failure = feedback, never a hang
        this.patch(key, (r) => {
          r.commitNote = truncate(out.detail, 4000);
        });
        return this.nextLoopOrHuman(key, 'The repository commit hook rejected the build');
      case 'nothing': {
        // the builder may have committed by itself: accept real work instead of calling it "no changes"
        const headNow = await gitOk(run.worktree, ['rev-parse', 'HEAD']).catch(() => '');
        if (headNow && headNow !== known && headNow !== run.baseSha) {
          const selfProblem = await postBuildChecks(run.worktree, run.baseSha, plan.filesToChange.map((f) => f.path), secrets);
          if (selfProblem) return this.toNeedsHuman(key, selfProblem, 'build');
          this.note(key, 'build', 'The builder committed its own work — keeping it and moving on to verification.');
          this.patch(key, (r) => {
            r.commitSha = headNow;
            r.commitNote = undefined;
            r.next = 'verify';
          });
          return;
        }
        if (run.loop === 1 && !isFix) {
          const answerText = redact(String(out.res.text ?? ''), secrets).trim();
          if (plan.filesToChange.length === 0 && answerText.length >= 40) {
            // the plan itself changed nothing (a question): the builder's reply is the deliverable — finish as "answered"
            await this.deliverAnswer(key, run.rev, answerText);
            return;
          }
          return this.toNeedsHuman(key, 'The builder finished without changing any files. The task may need to be clarified.', 'build');
        }
        return this.toNeedsHuman(key, 'The builder made no changes in response to the reported problems.', 'build');
      }
      case 'committed':
        this.patch(key, (r) => {
          r.commitSha = out.sha;
          r.commitNote = undefined;
          r.next = 'verify';
          r.history.push({ ts: this.c.clock.now(), text: `Build ${run.loop}: ${out.files.length} file(s) committed (${out.sha.slice(0, 7)})` });
        });
        return;
    }
  }

  private async hasUncommitted(wt: string): Promise<boolean> {
    try {
      return (await gitOk(wt, ['status', '--porcelain'])).trim().length > 0;
    } catch {
      return false;
    }
  }

  private async handleBuildFailure(key: string, res: AgentResult, provider: ProviderId): Promise<void> {
    const label = providerLabel(provider);
    const run = this.run(key);
    switch (res.errorKind) {
      case 'limit':
        return this.pauseForLimit(key, res.limit ?? { provider, resetsAt: null, message: res.error ?? 'limit' });
      case 'aborted':
        return;
      case 'spawn':
        return this.toNeedsHuman(key, res.error ?? 'agent could not start', 'build');
      default: {
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

  private bugList(run: Run): string {
    const failOn = new Set(this.c.cfg().pipeline.failOn);
    const open = run.bugs.filter((b) => b.status === 'open' && failOn.has(b.severity));
    if (!open.length) return '(none recorded — see the verifier summary)';
    return fence(
      'verifier-findings',
      open.map((b, i) => `${i + 1}. [${b.severity}] ${b.title}\n${b.detail}`).join('\n\n'),
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
    const lock = await W.lockfileHash(run.worktree);
    if (run.lockfileHash && run.lockfileHash !== lock) {
      const inst = await W.installDeps(run.worktree, repo, { env: toolEnv(repo.envPassthrough), timeoutMs: cfg.pipeline.timeoutsMin.gate * 60_000, signal: this.c.signal(key) });
      if (inst.ok) this.patch(key, (r) => void (r.lockfileHash = lock));
      else this.note(key, 'verify', `Re-installing dependencies failed (${truncate(inst.output.slice(-200), 200)}) — gates may fail for that reason.`);
    }
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
  markApproved(key: string, by: 'human' | 'auto'): void {
    const run = this.run(key);
    const st = this.c.persistent.load();
    st.repos[run.repo] = { approvedPlans: (st.repos[run.repo]?.approvedPlans ?? 0) + 1 };
    this.c.persistent.save(st);
    this.patch(key, (r) => {
      r.planApproved = true;
      r.approvedBy = by;
      r.status = 'queued';
      r.next = 'build';
      r.history.push({ ts: this.c.clock.now(), text: `Plan approved (${by})` });
    });
  }

  /** Short hash used to detect description edits. */
  static descHash(description: string): string {
    return sha1(description ?? '');
  }
  static sha256 = sha256;
  static fmt = fmtDuration;
}
