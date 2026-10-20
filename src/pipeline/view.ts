import type {
  AgentName, ApiRunDetail, ApiRunSummary, ApiSession, BoardColumn, Config, GateComparison, GateRun, Plan, PlanReview, Run, SessionRec, Verdict,
} from '../types.ts';
import type { RunStore } from '../store.ts';
import { fmtDuration, isUuid, shellQuote, truncate } from '../util.ts';

export function columnOf(run: Run): BoardColumn {
  switch (run.status) {
    case 'queued':
      return 'queued';
    case 'running':
      return run.stage === 'build' ? 'building' : run.stage === 'verify' ? 'verifying' : 'planning';
    case 'awaiting_approval':
      return 'plan_ready';
    case 'needs_human':
      return 'needs_human';
    case 'paused':
    case 'parked':
    case 'failed':
      return 'paused';
    case 'ready':
      return 'ready';
    default:
      return 'closed';
  }
}

export function workingAgent(run: Run, cfg: Config): AgentName | null {
  if (run.status !== 'running') return null;
  const live = [...run.sessions].reverse().find((s) => s.status === 'running');
  if (live) return live.agent;
  switch (run.next) {
    case 'plan':
      return cfg.stages.plan;
    case 'plan_review':
      return cfg.stages.review;
    case 'verify':
      return cfg.stages.verify;
    case 'build':
      return 'cursor';
    default:
      return null;
  }
}

const AGENT_NAME: Record<AgentName, string> = { claude: 'Claude', cursor: 'Cursor' };
const STAGE_VERB: Record<string, string> = { plan: 'planning', plan_review: 'reviewing the plan', build: 'building', verify: 'verifying' };

export function activityOf(run: Run, cfg: Config, now: number): string {
  const since = run.stageStartedAt ? ` · ${fmtDuration(now - run.stageStartedAt)}` : '';
  switch (run.status) {
    case 'queued':
      return 'Waiting for a free slot';
    case 'running': {
      const a = workingAgent(run, cfg);
      const stage = run.stage ?? 'plan';
      return a ? `${AGENT_NAME[a]} is ${STAGE_VERB[stage] ?? stage}${since}` : `Preparing the workspace${since}`;
    }
    case 'awaiting_approval':
      return 'Plan ready — waiting for your approval';
    case 'needs_human':
      return run.needsHuman ? truncate(run.needsHuman.reason.replace(/\s+/g, ' '), 200) : 'Needs you';
    case 'paused':
      return `Paused until ${new Date(run.pausedUntil ?? now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ${truncate(run.pauseReason ?? 'usage limit', 120)}`;
    case 'parked':
      return 'Parked — move the issue to Todo to continue';
    case 'ready':
      return run.unverified ? 'Ready for review — not verified by tests' : 'Verified — ready for your review';
    case 'failed':
      return `Internal error — retrying (${truncate(run.lastError ?? '', 100)})`;
    case 'aborted':
      return 'Stopped';
    default:
      return 'Done';
  }
}

export function toSummary(run: Run, cfg: Config, now: number): ApiRunSummary {
  const st = run.status;
  return {
    key: run.key,
    title: run.title,
    url: '', // cards have no external page (kept for API compatibility; removed from the UI in M1c)
    repo: run.repo,
    status: st,
    column: columnOf(run),
    stage: run.stage,
    next: run.next,
    activity: activityOf(run, cfg, now),
    agent: workingAgent(run, cfg),
    loop: run.loop,
    maxLoops: run.loopBudget,
    rev: run.rev,
    branch: run.branch,
    startedAt: run.createdAt,
    updatedAt: run.updatedAt,
    stageStartedAt: run.stageStartedAt ?? null,
    pausedUntil: run.pausedUntil ?? null,
    needsHuman: run.needsHuman ? { reason: run.needsHuman.reason, origin: run.needsHuman.origin } : null,
    unverified: run.unverified,
    costUsd: Math.round(run.costUsd * 10000) / 10000,
    bugsOpen: run.bugs.filter((b) => b.status === 'open').length,
    verdict: run.verdict,
    canApprove: st === 'awaiting_approval',
    canRetry: ['needs_human', 'failed', 'ready', 'aborted', 'finished', 'parked'].includes(st),
    canAbort: ['queued', 'running', 'awaiting_approval', 'needs_human', 'paused', 'parked', 'failed'].includes(st),
    canCleanup: ['ready', 'finished', 'aborted'].includes(st) && !!run.worktree,
    canPark: !['finished', 'aborted', 'parked'].includes(st),
    canFinish: !['finished', 'aborted'].includes(st),
  };
}

export function resumeCommand(run: Run, s: SessionRec): string {
  if (!isUuid(s.id) || !run.worktree) return '';
  const bin = s.agent === 'claude' ? 'claude' : 'agent';
  return `cd ${shellQuote(run.worktree)} && ${bin} --resume ${s.id}`;
}

export function toDetail(store: RunStore, run: Run, cfg: Config, now: number): ApiRunDetail {
  const base = toSummary(run, cfg, now);
  const plan = store.readArtifact<Plan | null>(run.key, `plan-${run.rev}.json`, null);
  const verdicts: { loop: number; verdict: Verdict }[] = [];
  const loops: { loop: number; run: GateRun; comparison: GateComparison }[] = [];
  for (let n = 1; n <= Math.max(run.loop, 1); n++) {
    const v = store.readArtifact<Verdict | null>(run.key, `verdict-${n}.json`, null);
    if (v) verdicts.push({ loop: n, verdict: v });
    const g = store.readArtifact<{ run: GateRun; comparison: GateComparison } | null>(run.key, `gates-${n}.json`, null);
    if (g) loops.push({ loop: n, run: g.run, comparison: g.comparison });
  }
  const sessions: ApiSession[] = run.sessions.map((s) => ({ ...s, resumeCommand: resumeCommand(run, s) }));
  return {
    ...base,
    notes: [], // filled in by the API (the board owns comments)
    description: run.description,
    worktree: run.worktree,
    baseSha: run.baseSha,
    commitSha: run.commitSha ?? null,
    complexity: run.complexity ?? null,
    sessions,
    plan,
    planMarkdown: store.readArtifact<string | null>(run.key, `plan-${run.rev}.md`, null),
    planReview: store.readArtifact<PlanReview | null>(run.key, `review-${run.rev}.json`, null),
    verdicts,
    gates: { baseline: store.readArtifact<GateRun | null>(run.key, 'baseline.json', null), loops },
    bugs: run.bugs,
    timeline: run.history,
    diffStat: store.readArtifact<string | null>(run.key, 'diffstat.txt', null),
    noPushEnvOnly: run.guardEnvOnly, // API name kept (derived view of the generic guard field)
    unverifiedWhy: run.unverifiedWhy ?? null,
  };
}
