/**
 * Shared contract for Conductor. Every module and the HTTP API/UI are typed against this file.
 * Erasable TypeScript only (no enums, no parameter properties) — Node strips types at runtime.
 */

// ───────────────────────────── primitives ─────────────────────────────
export type AgentName = 'claude' | 'cursor';
export type StageName = 'plan' | 'plan_review' | 'build' | 'verify';
export type Severity = 'blocker' | 'major' | 'minor' | 'nit';
export type Complexity = 'S' | 'M' | 'L';

/** Where the run currently is in its lifecycle (local source of truth for execution facts). */
export type RunStatus =
  | 'queued' // claimed, waiting for a worker slot
  | 'running' // a stage job is executing
  | 'awaiting_approval' // plan ready, waiting for human `/approve` or dashboard approve
  | 'needs_human' // blocked; human must act (see needsHuman)
  | 'paused' // provider usage limit; auto-resumes at pausedUntil
  | 'parked' // human moved the issue to Backlog/Triage; hold, do nothing
  | 'ready' // verified; waiting for human to review/merge
  | 'aborted' // human cancelled/removed the trigger
  | 'failed' // infrastructure failure (retried by the poller)
  | 'finished'; // human completed the Linear issue

/** The next step the engine will execute for a run. */
export type NextStep = 'plan' | 'plan_review' | 'approval' | 'build' | 'verify' | 'none';

/** Dashboard board column (derived server-side so the UI stays dumb). */
export type BoardColumn =
  | 'queued'
  | 'planning'
  | 'plan_ready'
  | 'building'
  | 'verifying'
  | 'needs_human'
  | 'paused'
  | 'ready'
  | 'closed';

// ───────────────────────────── LLM structured outputs ─────────────────────────────
export interface PlanAC {
  id: string; // "AC1"
  text: string;
  verification: string; // test / command / observable behaviour
}
export interface PlanFile {
  path: string;
  action: 'create' | 'modify' | 'delete' | 'rename';
  change: string;
  reason: string;
}
export interface Plan {
  summary: string;
  blocked: { is: boolean; questions: string[] };
  assumptions: string[];
  currentState: string;
  expectedState: string;
  acceptanceCriteria: PlanAC[];
  filesToChange: PlanFile[];
  steps: string[];
  testing: { commands: string[]; cases: string[] };
  risks: string[];
  coverage: { requirement: string; change: string; verification: string }[];
  complexity: Complexity;
}
export interface PlanReview {
  decision: 'approved' | 'changes_requested';
  summary: string;
  issues: { severity: 'blocking' | 'suggestion'; text: string }[];
}
export interface VerdictAC {
  id: string;
  status: 'met' | 'not_met' | 'unverifiable';
  evidence: string;
}
export interface Bug {
  title: string;
  severity: Severity;
  file?: string;
  line?: number;
  evidence: string;
  repro?: string;
  suggestedFix?: string;
}
export interface Verdict {
  verdict: 'pass' | 'fail';
  summary: string;
  acceptance: VerdictAC[];
  bugs: Bug[];
}

// ───────────────────────────── gates ─────────────────────────────
export interface GateDef {
  name: string; // "test", "lint", "typecheck"
  cmd: string; // shell command line, run with `sh -c` in the worktree (repo-owned, user-registered)
  kind: 'typecheck' | 'lint' | 'test' | 'build' | 'other';
}
export interface GateResult {
  name: string;
  cmd: string;
  exitCode: number | null; // null when killed/timed out
  timedOut: boolean;
  durationMs: number;
  outputTail: string; // redacted, last ~8 KB
  /** Parsed failure keys (no line/column numbers — C2). null = output not parseable. */
  failures: string[] | null;
  failureCount: number | null;
}
export interface GateRun {
  at: number;
  sha: string; // commit the gates ran against
  results: GateResult[];
}
export interface GateComparison {
  /** Gate failed now with failure keys that were not failing at baseline (or baseline passed). */
  regressions: { gate: string; newFailures: string[]; note?: string }[];
  /** Gate failing at baseline with no new failure keys. */
  preExisting: string[];
  /** Gate failing at baseline whose output isn't parseable: regressions cannot be excluded. */
  unverified: string[];
  passed: string[];
}

// ───────────────────────────── events / logs ─────────────────────────────
export type LogKind = 'system' | 'text' | 'thinking' | 'tool' | 'tool_result' | 'error' | 'result' | 'note';
export interface LogEvent {
  seq: number; // per-run monotonically increasing
  ts: number;
  agent: AgentName | 'conductor';
  stage: StageName | 'setup' | 'engine';
  kind: LogKind;
  text?: string; // redacted, truncated
  tool?: string;
  ok?: boolean;
  sessionId?: string;
}

// ───────────────────────────── run record ─────────────────────────────
export interface SessionRec {
  id: string; // agent session id (uuid) — used for resume commands
  agent: AgentName;
  stage: StageName;
  loop: number;
  rev: number;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'ok' | 'error' | 'limit' | 'aborted' | 'timeout';
  costUsd?: number;
  model?: string;
  cliVersion?: string;
}
export interface BugRec {
  fp: string; // fingerprint: sha1(normalised title + file)
  title: string;
  severity: Severity;
  file?: string;
  detail: string; // markdown body used for the sub-issue
  status: 'open' | 'closed';
  linearId?: string;
  linearKey?: string;
  loops: number[]; // loops in which it was observed
}
export interface EffectRec {
  status: 'pending' | 'done';
  linearId?: string;
  kind: 'comment' | 'subissue' | 'state' | 'labels' | 'close';
  payload?: unknown; // everything needed to (re)apply the effect idempotently
  attempts: number;
  lastError?: string;
}
export interface HistoryLine {
  ts: number;
  text: string;
}
export interface Run {
  key: string; // Linear identifier, e.g. "ENG-123"
  issueId: string;
  teamId: string;
  title: string;
  description: string; // snapshot at claim (trusted: attribution-checked)
  descHash: string;
  url: string;
  repo: string; // RepoConfig.name
  branch: string; // conductor/<key-lower>
  worktree: string;
  baseSha: string;
  commitSha?: string;
  status: RunStatus;
  next: NextStep;
  stage: StageName | null; // current or last stage
  loop: number; // 1-based build/verify loop
  loopBudget: number; // max loop number allowed before needs_human
  rev: number; // plan revision
  agentRuns: number; // counts toward maxAgentRunsPerIssue
  createdAt: number;
  updatedAt: number;
  stageStartedAt?: number;
  pausedUntil?: number;
  pauseReason?: string;
  parkedFrom?: RunStatus;
  needsHuman?: { reason: string; origin: NextStep; at: number };
  unverified: boolean; // no gates, or gates unparseable for regressions
  unverifiedWhy?: string;
  noPushEnvOnly: boolean; // tracked .cursor/cli.json prevented writing the deny rule
  cursorGuardSha?: string; // sha256 of .cursor/cli.json written for the build
  /** Picked up via the explicit `allowAssignedToMe` opt-in (creator attribution is skipped). */
  assignedPickup?: boolean;
  planApproved: boolean;
  approvedBy?: 'auto' | 'human';
  planReviewDone: boolean;
  planReviewRounds: number; // revisions requested by plan review so far
  feedback?: string; // reviewer/human feedback to include in the next plan prompt
  commitNote?: string; // repo-hook output from a failed commit, fed to the fix prompt
  lockfileHash?: string; // last installed lockfile hash (re-install when it changes)
  lastError?: string;
  complexity?: Complexity;
  /** What Conductor last wrote to Linear (used to tell human edits from its own). */
  expected: { stateId?: string; stage?: string };
  sessions: SessionRec[];
  bugs: BugRec[];
  effects: Record<string, EffectRec>;
  costUsd: number;
  verdict: 'pass' | 'fail' | null;
  history: HistoryLine[];
  lastEventSeq: number;
  /** Markers: conversation comments already consumed into prompts (Linear comment ids). */
  commentsSeen: string[];
}

// ───────────────────────────── config ─────────────────────────────
export interface RepoConfig {
  name: string; // unique; used for `repo:<name>` label / project mapping
  path: string; // realpath of git toplevel
  baseBranch: string;
  gates: GateDef[];
  setup?: string; // dependency install command (auto-detected if absent)
  copyFiles: string[]; // git-ignored env files to copy into worktrees (e.g. ".env.local")
  envPassthrough: string[]; // extra env var names that gates/deps may receive
}
export interface Config {
  version: 1;
  ui: { port: number; openBrowser: boolean };
  linear: {
    teamId?: string;
    teamKey?: string;
    mode: 'labels' | 'states';
    triggerLabel: string; // default "conductor"
    pollSeconds: number; // >= 15, default 30
    pickupFromBacklog: boolean; // C4, default false
    allowAssignedToMe: boolean; // default false
    viewerId?: string;
  };
  repos: RepoConfig[];
  agents: {
    claude: {
      bin: string;
      model?: string;
      isolation: 'safe-mode' | 'setting-sources';
      maxTurns: { plan: number; review: number; verify: number };
    };
    cursor: { bin: string; model?: string };
  };
  stages: { plan: AgentName; review: AgentName; verify: AgentName }; // build is always cursor
  pipeline: {
    maxParallel: number;
    maxLoops: number;
    maxAgentRunsPerIssue: number;
    planApproval: 'auto' | 'manual' | 'first'; // 'first' = manual for the first plan per repo
    planReview: 'off' | 'auto' | 'always'; // 'auto' = only complexity M/L
    onClaudeLimit: 'wait' | 'cursor';
    failOn: Severity[];
    noGates: 'warn' | 'block';
    timeoutsMin: { plan: number; review: number; build: number; verify: number; idle: number; gate: number };
  };
  worktreeRoot?: string;
}
/** Subset of Config editable from the dashboard. */
export interface Settings {
  planApproval: Config['pipeline']['planApproval'];
  planReview: Config['pipeline']['planReview'];
  maxLoops: number;
  maxParallel: number;
  onClaudeLimit: Config['pipeline']['onClaudeLimit'];
  noGates: Config['pipeline']['noGates'];
  pickupFromBacklog: boolean;
  stages: Config['stages'];
  linearMode: Config['linear']['mode'];
}

// ───────────────────────────── agents ─────────────────────────────
export interface LimitInfo {
  provider: AgentName;
  resetsAt: number | null; // epoch ms; null = unknown (use backoff)
  kind?: string; // 'seven_day' | 'five_hour' | 'unknown'
  message: string;
}
export interface AgentResult {
  ok: boolean;
  text: string; // final assistant text (redacted)
  json?: unknown; // parsed structured output (unvalidated)
  sessionId?: string;
  costUsd?: number;
  model?: string;
  cliVersion?: string;
  turns?: number;
  exitCode: number | null;
  error?: string;
  errorKind?: 'limit' | 'max_turns' | 'timeout_idle' | 'timeout_hard' | 'aborted' | 'isolation' | 'spawn' | 'agent' | 'parse';
  limit?: LimitInfo;
  quota?: { utilization7d?: number; utilization5h?: number; resetsAt?: number; status?: string };
}

// ───────────────────────────── Linear port ─────────────────────────────
export interface LinearState {
  id: string;
  name: string;
  type: 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';
}
export interface LinearLabel {
  id: string;
  name: string;
  teamId: string | null; // null = workspace-level label
}
export interface LinearComment {
  id: string;
  body: string;
  userId: string | null;
  createdAt: string; // ISO
}
export interface LinearHistoryEntry {
  id: string;
  createdAt: string; // ISO
  actorId: string | null;
  addedLabelIds: string[];
  removedLabelIds: string[];
  /** Users who edited the description in this entry (empty/undefined if not edited). */
  descriptionUpdatedBy: string[];
  fromStateId?: string | null;
  toStateId?: string | null;
}
export interface LinearIssue {
  id: string;
  identifier: string; // "ENG-123"
  title: string;
  description: string;
  url: string;
  priority: number;
  state: LinearState;
  labels: LinearLabel[];
  creatorId: string | null;
  assigneeId: string | null;
  parentId: string | null;
  projectName: string | null;
  teamId: string;
  createdAt: string;
  updatedAt: string;
  comments?: LinearComment[]; // present on `issue()` only
  history?: LinearHistoryEntry[]; // present on `issue()` only; ALL pages
}
export interface TeamSetupInfo {
  states: LinearState[];
  labels: LinearLabel[]; // team + workspace labels
  /** Team's default state for new issues (C4), if Linear exposes it. */
  defaultIssueStateId: string | null;
}
export interface LinearPort {
  viewer(): Promise<{ id: string; name: string; email: string }>;
  teams(): Promise<{ id: string; key: string; name: string }[]>;
  teamSetup(teamId: string): Promise<TeamSetupInfo>;
  createLabel(teamId: string, input: { name: string; color: string }): Promise<LinearLabel>;
  createState(teamId: string, input: { name: string; type: LinearState['type']; color: string }): Promise<LinearState>;
  /** Open issues (state type not completed/canceled) in the team carrying `triggerLabel`; creator/assignee/parent/state/labels populated. */
  candidates(teamId: string, triggerLabel: string, opts?: { includeAssigned?: boolean }): Promise<LinearIssue[]>;
  /** One issue with comments and ALL history pages. */
  issue(id: string): Promise<LinearIssue>;
  update(
    id: string,
    patch: { stateId?: string; addLabelIds?: string[]; removeLabelIds?: string[]; description?: string },
  ): Promise<void>;
  comment(issueId: string, body: string): Promise<{ id: string }>;
  createIssue(input: {
    teamId: string;
    title: string;
    description?: string;
    parentId?: string;
    labelIds?: string[];
    stateId?: string;
    projectId?: string;
  }): Promise<LinearIssue>;
  /** Sub-issues of an issue (for marker-based dedupe). */
  children(issueId: string): Promise<LinearIssue[]>;
}

// ───────────────────────────── HTTP API shapes (see docs/API.md) ─────────────────────────────
export interface AgentHealth {
  found: boolean;
  version?: string;
  ok: boolean;
  loggedIn?: boolean;
  detail?: string;
}
export interface ApiRunSummary {
  key: string;
  title: string;
  url: string;
  repo: string;
  status: RunStatus;
  column: BoardColumn;
  stage: StageName | null;
  next: NextStep;
  /** Human sentence, e.g. "Claude is planning · 2m 14s". */
  activity: string;
  agent: AgentName | null; // who is working right now
  loop: number;
  maxLoops: number;
  rev: number;
  branch: string;
  startedAt: number;
  updatedAt: number;
  stageStartedAt: number | null;
  pausedUntil: number | null;
  needsHuman: { reason: string; origin: NextStep } | null;
  unverified: boolean;
  costUsd: number;
  bugsOpen: number;
  verdict: 'pass' | 'fail' | null;
  canApprove: boolean;
  canRetry: boolean;
  canAbort: boolean;
  canCleanup: boolean;
}
export interface ApiSession extends SessionRec {
  resumeCommand: string; // e.g. `cd '/path' && claude --resume <id>`
}
export interface ApiBug extends BugRec {}
export interface ApiRunDetail extends ApiRunSummary {
  description: string;
  worktree: string;
  baseSha: string;
  commitSha: string | null;
  complexity: Complexity | null;
  sessions: ApiSession[];
  plan: Plan | null;
  planMarkdown: string | null;
  planReview: PlanReview | null;
  verdicts: { loop: number; verdict: Verdict }[];
  gates: {
    baseline: GateRun | null;
    loops: { loop: number; run: GateRun; comparison: GateComparison }[];
  };
  bugs: ApiBug[];
  timeline: HistoryLine[];
  diffStat: string | null;
  noPushEnvOnly: boolean;
  unverifiedWhy: string | null;
}
export interface ApiQuota {
  claude?: { utilization7d?: number; utilization5h?: number; resetsAt?: number; rejected?: boolean };
}
export interface ApiEngine {
  /** Issues carrying the trigger label that Conductor deliberately ignores, with the reason. */
  ignored?: { key: string; reason: string }[];
  paused: boolean;
  pauseReason?: string;
  providerPause: Partial<Record<AgentName, { until: number; reason: string }>>;
  running: number;
  maxParallel: number;
  lastPollAt: number | null;
  lastPollError: string | null;
  pollSeconds: number;
}
export interface ApiSetupStep {
  id: 'agents' | 'linear' | 'team' | 'repo';
  label: string;
  ok: boolean;
  detail?: string;
}
export interface ApiRepo {
  name: string;
  path: string;
  baseBranch: string;
  gates: GateDef[];
  approvedPlans: number;
  noGates: boolean;
  warnings: string[];
}
export interface ApiState {
  now: number;
  version: string;
  csrf: string;
  setup: { complete: boolean; steps: ApiSetupStep[] };
  health: {
    claude: AgentHealth;
    cursor: AgentHealth;
    linear: { ok: boolean; viewer?: string; detail?: string };
    warnings: string[];
  };
  quota: ApiQuota;
  engine: ApiEngine;
  settings: Settings;
  repos: ApiRepo[];
  runs: ApiRunSummary[];
}
export interface ApiError {
  error: { code: string; message: string };
}
