/**
 * Shared contract for Conductor. Every module and the HTTP API/UI are typed against this file.
 * Erasable TypeScript only (no enums, no parameter properties) — Node strips types at runtime.
 */

// ───────────────────────────── primitives ─────────────────────────────
import type { ProviderId } from './agents/providers/types.ts';
import type { Roles } from './agents/roles.ts';
export type { ProviderId };
export type StageName = 'plan' | 'plan_review' | 'build' | 'verify';
export type Severity = 'blocker' | 'major' | 'minor' | 'nit';
export type Complexity = 'S' | 'M' | 'L';

/** Where the run currently is in its lifecycle (local source of truth for execution facts). */
export type RunStatus =
  | 'queued' // claimed, waiting for a worker slot
  | 'running' // a stage job is executing
  | 'awaiting_approval' // plan ready, waiting for the human's Approve
  | 'needs_human' // blocked; human must act (see needsHuman)
  | 'paused' // provider usage limit; auto-resumes at pausedUntil
  | 'parked' // human moved the card to Backlog; hold, do nothing
  | 'ready' // verified; waiting for human to review/merge
  | 'aborted' // human cancelled/removed the trigger
  | 'failed' // infrastructure failure (retried by the poller)
  | 'finished'; // human marked the card done

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
  /** 'answer' = the task is a question/analysis that needs no code change: `answer` is the deliverable. Default 'code'. */
  deliverable?: 'code' | 'answer';
  answer?: string;
  /** Optional decomposition (M3). A graph of fewer than 2 items is treated as no graph. */
  taskGraph?: { items: PlanItem[] };
}
/** One planned unit of work. `files` are advisory for scope (build-class items only; ⊆ plan.filesToChange). */
export interface PlanItem {
  id: string; // T1, T2 …
  title: string;
  role: string; // implementation | documentation (build-class) · requirements | architecture | context (analysis-class); validated semantically
  objective: string;
  dependsOn: string[];
  files: string[];
  criteria: string[]; // acceptance-criterion ids this item satisfies
  verification: string[];
  parallelGroup?: string; // recorded for later parallel work; never used to schedule builds in v2.0
}
/** Stored item states. `ready` is DERIVED (pending with every dependency done), never stored. */
export type ItemState = 'pending' | 'running' | 'done' | 'failed' | 'blocked';
export interface ItemRun {
  id: string;
  /** Board key of this item's subtask card (null until the `subtasks` effect has created it). */
  key: string | null;
  title: string;
  role: string;
  objective: string;
  dependsOn: string[];
  files: string[];
  criteria: string[];
  verification: string[];
  state: ItemState;
  loop: number;
  loopBudget: number;
  agentRuns: number; // informational: Run.agentRuns governs budgets
  /** HEAD before this item's builder started, and the per-attempt nonce its commit message must carry (crash adoption). */
  startHead?: string;
  nonce?: string;
  /** Gate-regression / hook feedback for this item's next attempt (deterministic tool output, capped). */
  feedback?: string;
  /** HEAD before this item's FIRST attempt: a failed item's commits are backed up and the branch is reset here, so independent items continue on good code. */
  floor?: string;
  commitSha?: string;
  note?: string;
}
export interface TaskGraphRun {
  items: ItemRun[];
  /** Plan revision this graph belongs to (a re-plan discards it). */
  rev: number;
  startedAt: number;
  final: 'pending' | 'verifying' | 'done';
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
  agent: ProviderId | 'conductor';
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
  agent: ProviderId;
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
  itemId?: string; // the board item (kind 'bug') filed for this finding
  itemKey?: string;
  loops: number[]; // loops in which it was observed
  graphItem?: string; // the plan item whose commit last touched `file` (task graphs only; see Stages.attributeBugs)
}
export interface EffectRec {
  status: 'pending' | 'done';
  refId?: string; // id of the board entity the effect produced (comment / bug item)
  kind: 'comment' | 'subissue' | 'state' | 'close' | 'subtask' | 'subtask-cancel';
  payload?: unknown; // everything needed to (re)apply the effect idempotently (already redacted)
  attempts: number; // failures so far (reporting + back-off only; a local write cannot half-fail)
  lastError?: string;
}
export interface HistoryLine {
  ts: number;
  text: string;
}
export interface Run {
  /** On-disk data version of this record (see src/schema). Stamped on every write; absent in legacy files = 1 (migrated in memory to 2). */
  schemaVersion?: number;
  /** Fields carried over from a v1 (Linear) run, kept verbatim and never interpreted. */
  legacy?: Record<string, unknown>;
  key: string; // board key, e.g. "APP-12"
  itemId: string; // board item id
  title: string;
  description: string; // snapshot at claim; a later edit halts the run at the next stage boundary
  descHash: string;
  repo: string; // RepoConfig.name
  branch: string; // conductor-v2/<key-lower>
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
  guardEnvOnly: boolean; // the builder's own guard could not be written (e.g. a tracked .cursor/cli.json): protection is the git env alone
  guardSha?: string; // sha256 of the provider's guard artefact written for the build
  /** Source text was never verified (e.g. imported from another system): the plan always waits for human approval. */
  untrusted?: boolean;
  planApproved: boolean;
  approvedBy?: 'auto' | 'human';
  planReviewDone: boolean;
  planReviewRounds: number; // revisions requested by plan review so far
  answered?: boolean; // deliverable was an answer (no code); finished without build/verify
  limitStreak?: number; // consecutive usage-limit rejections (back-off); reset on any successful agent call
  limitEpisode?: number; // increments when a new limit streak starts (one board comment/notification per episode)
  buildFails?: number; // consecutive failed Cursor build attempts in the current stage
  feedback?: string; // reviewer/human feedback to include in the next plan prompt
  commitNote?: string; // repo-hook output from a failed commit, fed to the fix prompt
  lockfileHash?: string; // last installed lockfile hash (re-install when it changes)
  lastError?: string;
  complexity?: Complexity;
  /** What Conductor last projected onto the board. */
  expected: { written?: boolean; stage?: string };
  sessions: SessionRec[];
  bugs: BugRec[];
  effects: Record<string, EffectRec>;
  costUsd: number;
  verdict: 'pass' | 'fail' | null;
  history: HistoryLine[];
  lastEventSeq: number;
  /** Conversation comments already consumed into prompts (board comment ids). */
  commentsSeen: string[];
  /** Task-graph execution state (M3); absent for a plan without a graph. */
  graph?: TaskGraphRun;
  /** `status:rev:loop` of the last outcome digest written to the project's history (M4) — makes the digest idempotent. */
  digestMark?: string;
  /** Offline bookkeeping (M4): pause episodes and the cumulative time spent offline. */
  offline?: { episodes: number; streak: number; totalMs: number; pausedAt?: number };
  /** Timestamps of human-initiated restarts (rolling limit against restart loops). */
  restartTimes?: number[];
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
  version: number;
  /** Unknown top-level keys found on disk (e.g. written by a newer build) — preserved verbatim on save, never interpreted. */
  extra?: Record<string, unknown>;
  ui: { port: number; openBrowser: boolean };
  /** Carried over from older configs (e.g. the v1 `linear` block), kept verbatim and never interpreted. */
  legacy?: Record<string, unknown>;
  repos: RepoConfig[];
  agents: {
    claude: {
      bin: string;
      model?: string;
      isolation: 'safe-mode' | 'setting-sources';
      maxTurns: { plan: number; review: number; verify: number };
    };
    cursor: { bin: string; model?: string };
    /** Codex CLI (read-only roles only in M2). `model` is validated against a strict pattern and passed as `--model=<v>`. */
    codex: { bin: string; model?: string };
  };
  /** Roles → ordered provider chains (config v4). Replaces v3's `stages` + `pipeline.onClaudeLimit`, which are derived for the dashboard (see Settings). */
  roles: Roles;
  pipeline: {
    maxParallel: number;
    maxLoops: number;
    maxAgentRunsPerIssue: number;
    planApproval: 'auto' | 'manual' | 'first'; // 'first' = manual for the first plan per repo
    planReview: 'off' | 'auto' | 'always'; // 'auto' = only complexity M/L
    failOn: Severity[];
    noGates: 'warn' | 'block';
    /** Task graph (M3): item ceiling (1–12; 12 is a hard v2.0 limit), concurrent analysis-item calls (1–4) and an optional AI check per item. */
    maxItems: number;
    readOnlyParallel: number;
    /** RESERVED: accepted and clamped, not used yet (per-task AI verification is not implemented; the whole change is verified once). */
    verifyEachItem: boolean;
    timeoutsMin: { plan: number; review: number; build: number; verify: number; idle: number; gate: number };
  };
  /** Per-project settings keyed by board project key (config v5). */
  projects: Record<string, ProjectSettings>;
  worktreeRoot?: string;
}
/** Per-project settings (config v5). One record per board project key; M6 adds `policy` and `limits` here. */
export interface ProjectContextSettings {
  /** Opt-in LLM module summaries (spends quota). Off by default. */
  summaries: boolean;
  /** A context older than this many days reports stale. */
  staleDays: number;
  /** Size budget of a context pack in bytes (hard ceiling 32 KB). */
  packBytes: number;
}
export interface ProjectSettings {
  context?: ProjectContextSettings;
}
/** Subset of Config editable from the dashboard. */
export interface Settings {
  planApproval: Config['pipeline']['planApproval'];
  planReview: Config['pipeline']['planReview'];
  maxLoops: number;
  maxParallel: number;
  /** Derived from `roles` (compat layer): 'cursor' iff Cursor follows Claude in the planning chain. */
  onClaudeLimit: 'wait' | 'cursor';
  noGates: Config['pipeline']['noGates'];
  /** Derived from `roles`: the first claude|cursor provider of the planning / review / verification chains. */
  stages: { plan: 'claude' | 'cursor'; review: 'claude' | 'cursor'; verify: 'claude' | 'cursor' };
}

// ───────────────────────────── agents ─────────────────────────────
export interface LimitInfo {
  provider: ProviderId;
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
  errorKind?: 'limit' | 'auth' | 'max_turns' | 'timeout_idle' | 'timeout_hard' | 'aborted' | 'isolation' | 'spawn' | 'agent' | 'parse' | 'network';
  limit?: LimitInfo;
  quota?: { utilization7d?: number; utilization5h?: number; resetsAt?: number; status?: string };
}

// ───────────────────────────── HTTP API shapes (see docs/API.md) ─────────────────────────────
export interface AgentHealth {
  found: boolean;
  version?: string;
  ok: boolean;
  loggedIn?: boolean;
  detail?: string;
  /** `broken-install`: the launcher exists but the program does not run (e.g. a shim whose native binary is missing). */
  state?: 'missing' | 'broken-install' | 'ok';
}
export interface ApiProvider {
  id: ProviderId;
  label: string;
  /** What the CLI said (redacted, truncated). */
  state: 'ok' | 'missing' | 'broken-install' | 'not-logged-in' | 'unknown';
  version?: string;
  detail?: string;
  /** A fixed instruction per provider — never CLI-originated text. Conductor never runs it. */
  hint: string;
  capabilities: { readOnly: boolean; build: boolean; buildIsolationVerified: boolean };
  /** Read-only isolation tier: how much to trust it for read-only roles. */
  tier: 'verified' | 'partial' | 'unverified' | 'blocked';
  /** What backs the build isolation (display only): the code baseline or a re-verification record, and whether it matches the installed version. */
  buildVerification?: { source: 'baseline' | 'live-suite'; verifiedOn: string; grandfathered: boolean; current: boolean | null };
  /** Result of the last Codex isolation check, bound to the installed version (display only). */
  isolationCheck?: { verdict: 'pass' | 'blocked' | 'inconclusive'; at: number; current: boolean; /** false until the canary's matchers have been validated against a real Codex transcript: a pass is then shown but does not lift the tier */ trusted: boolean };
  /** The provider appears in at least one role chain. */
  inUse: boolean;
  /** Paused by a usage limit until this time (epoch ms). */
  pausedUntil: number | null;
}
export interface ApiRoles {
  roles: Roles;
  /** For each role and provider: may it be assigned, and if not, why (human words). */
  choices: Record<string, Record<string, { ok: boolean; reason?: string; needsAck?: boolean }>>;
  needs: Record<string, { build?: true; research?: true }>;
}
/** One task of a run's graph, as the dashboard shows it (strings were redacted when the plan was stored). */
export interface ApiGraphItem {
  id: string;
  key: string | null;
  title: string;
  role: string;
  objective: string;
  dependsOn: string[];
  files: string[];
  criteria: string[];
  state: ItemState | 'ready';
  loop: number;
  loopBudget: number;
  commitSha: string | null;
  note: string | null;
}
export interface ApiGraph {
  rev: number;
  final: TaskGraphRun['final'];
  items: ApiGraphItem[];
}
export interface ApiGraphProgress {
  total: number;
  done: number;
  running: number;
  failed: number;
  blocked: number;
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
  agent: ProviderId | null; // who is working right now
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
  canPark: boolean; // move the card to Backlog
  canFinish: boolean; // mark it done
  /** Progress of the task graph, when the run has one. */
  taskProgress?: ApiGraphProgress;
}
export interface ApiSession extends SessionRec {
  resumeCommand: string; // e.g. `cd '/path' && claude --resume <id>`
}
export interface ApiBug extends BugRec {}
/** A card on the board that has NO run (Backlog / To do): shown as a plain card with Start / Park / Cancel. */
export interface ApiCard {
  key: string;
  title: string;
  lane: string;
  kind: string;
  createdAt: number;
  updatedAt: number;
  /** Why Conductor is not running it (e.g. waiting for a dependency), when known. */
  note?: string;
}
export interface ApiNote {
  id: string;
  author: 'user' | 'conductor';
  body: string;
  ts: number;
}
export interface ApiRunDetail extends ApiRunSummary {
  notes: ApiNote[];
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
  /** The task graph (items, states, dependencies, commits), or null for a single-task run. */
  graph: ApiGraph | null;
}
export interface ApiQuota {
  claude?: { utilization7d?: number; utilization5h?: number; resetsAt?: number; rejected?: boolean };
}
export interface ApiEngine {
  /** Cards Conductor deliberately does not run (e.g. in a Conductor-owned lane without a run), with the reason. */
  ignored?: { key: string; reason: string }[];
  /** Set when the board cannot be written (disk full, journal refused): effects stop retrying every tick until it recovers. */
  storageProblem?: string | null;
  /** The connectivity probe's last verdict is "offline" (M4). */
  offline?: boolean;
  paused: boolean;
  pauseReason?: string;
  providerPause: Partial<Record<ProviderId, { until: number; reason: string }>>;
  running: number;
  maxParallel: number;
  /** Last time the engine looked at the board. */
  lastPollAt: number | null;
  lastPollError: string | null;
  pollSeconds: number;
}
export interface ApiSetupStep {
  id: 'agents' | 'repo';
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
    codex: AgentHealth;
    warnings: string[];
  };
  providers: ApiProvider[];
  quota: ApiQuota;
  engine: ApiEngine;
  settings: Settings;
  repos: ApiRepo[];
  runs: ApiRunSummary[];
  cards: ApiCard[];
}
export interface ApiError {
  error: { code: string; message: string };
}
