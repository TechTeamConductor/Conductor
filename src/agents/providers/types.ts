// The provider contract (M2). Commit 1 covers what the BUILD ENVELOPE needs; roles/routing/read-only/Codex extend it later.
import type { AgentResult, Config } from '../../types.ts';
import type { EmitEvent } from '../claude.ts';
import type { Clock } from '../../util.ts';
import type { Schema } from '../json.ts';
import type { StageName } from '../../types.ts';
import type { ResolvedSel } from '../../models/select.ts';
import type { AccountRef } from '../../accounts/types.ts';

/** Registry-driven: add a provider by adding a registry entry; nothing else names providers in a ternary. */
export type ProviderId = 'claude' | 'cursor' | 'codex';

/** The ONLY place a provider's display name is written down. */
export const PROVIDER_LABEL: Readonly<Record<ProviderId, string>> = Object.freeze({ claude: 'Claude', cursor: 'Cursor', codex: 'Codex' });

export interface ProviderDeps {
  getConfig: () => Config;
  clock: Clock;
  /** Test/embedding hook: extra env merged UNDER the envelope's env (providerEnv < extraEnv < envelope env). */
  extraEnv: Record<string, string>;
}

export interface ReadOnlyRunReq {
  stage: Extract<StageName, 'plan' | 'plan_review' | 'verify'>;
  cwd: string;
  /** Already carries the JSON-output instruction. */
  prompt: string;
  schema: Schema;
  name: string;
  onEvent: (ev: EmitEvent) => void;
  signal?: AbortSignal;
  secrets?: string[];
  /** Multiplies the turn cap (retry after error_max_turns). */
  maxTurnsFactor?: number;
  /** Multiplies the wall-clock limit (code research gets a longer one; absent = 1). */
  timeoutFactor?: number;
  /** M8-2: the resolved model/effort for this tool (data only). Absent ⇒ the tool-default resolution. */
  sel?: ResolvedSel;
  /** M8-3: the account this run uses (absent/'default' ⇒ today's env, byte-identical). Never a path, never a secret. */
  account?: AccountRef;
}

/** Deep Research: Claude with web tools only, in an empty scratch directory. */
export interface ResearchRunReq {
  cwd: string;
  prompt: string;
  schema: Schema;
  name: string;
  onEvent: (ev: EmitEvent) => void;
  signal?: AbortSignal;
  secrets?: string[];
  /** M8-2: the research row's resolved selection (Claude). */
  sel?: ResolvedSel;
  /** M8-6: Standard (default — today's exact argv) or Deep. Only `--max-turns` and the wall clock differ (RESEARCH_DEPTH). */
  depth?: 'standard' | 'deep' | 'quick';
  /** M8-3 (B2): the Claude account research runs on. */
  account?: AccountRef;
}

export interface BuildRunReq {
  cwd: string;
  prompt: string;
  name: string;
  /** The envelope's env (git no-push env). Always wins over everything the provider adds. */
  env: Record<string, string>;
  onEvent: (ev: EmitEvent) => void;
  signal?: AbortSignal;
  secrets?: string[];
  /** M8-2: the builder's resolved selection, forwarded untouched by the envelope. */
  sel?: ResolvedSel;
  /** M8-3: the builder's account, and (named Cursor only, B5) the account env fragment the ENVELOPE resolved — never `prepare`. */
  account?: AccountRef;
  accountEnv?: Record<string, string>;
}

/** What a provider's own guard looks like after `prepare` (recorded on the run as guardSha / guardEnvOnly). */
export interface BuildPrep {
  /** Hash of the provider's guard artefact, or null when none was written (the provider's protection is environment-only). */
  guardSha: string | null;
  /** True when the provider's own guard could not be written (e.g. the repo tracks its own file): protection is the git env alone. */
  envOnly: boolean;
  /** Extra child env. The envelope DROPS GIT_*, HOME, PATH, CODEX_*-class keys and lets its own env win. */
  env?: Record<string, string>;
  /** A human-readable note for the run timeline (e.g. why the guard is env-only). */
  note?: string;
}

export interface BuildCapability {
  /** true ⇒ the provider declares a guard of its own: `prepare` AND `verifyGuard` MUST exist, otherwise the envelope refuses (fail closed). */
  guard: boolean;
  /** Exact names or `PREFIX_*` patterns of the env keys `prepare` may add. Everything else is dropped (the envelope's own env always wins, and the GIT_ family, HOME, PATH and similar are never allowed). */
  envAllow: readonly string[];
  prepare?(ctx: { worktree: string }): Promise<BuildPrep>;
  /** Only the envelope calls this (static test). */
  run(req: BuildRunReq, prep: BuildPrep): Promise<AgentResult>;
  verifyGuard?(prep: BuildPrep, ctx: { worktree: string }): Promise<{ ok: boolean; detail: string }>;
}

/** Derived, never declared by the adapter: `build` from the presence of `build.run`, the isolation tier from the verification store. */
export interface Capabilities {
  readOnly: boolean;
  build: boolean;
  buildIsolationVerified: boolean;
}

export type DetectState = 'missing' | 'broken-install' | 'ok';
/** Zero-quota: `--version` and nothing else. `broken-install` = the launcher exists but the program does not run. */
export interface DetectResult {
  state: DetectState;
  version?: string;
  /** What the CLI said, or why we think so — redacted/truncated by the caller before it is shown. */
  detail?: string;
  /** Older than what the adapter was written against: reported, the provider is treated as unverified. */
  belowMinimum?: boolean;
}
export type AuthState = 'ok' | 'not-logged-in' | 'unknown';
export interface AuthResult {
  state: AuthState;
  /** e.g. "Signed in as …" (CLI-reported text, redacted by the caller). */
  detail?: string;
}
/** `cheap` never reaches a model; `canary` does (a tiny probe, or Codex's isolation check) and so spends quota ⇒ callers must ask first. */
export type SelfTestLevel = 'cheap' | 'canary';
export interface SelfTestResult {
  level: SelfTestLevel;
  /** missing | broken-install | not-logged-in | ok | unknown — one vocabulary for every provider. */
  state: 'missing' | 'broken-install' | 'not-logged-in' | 'ok' | 'unknown';
  ok: boolean;
  detail: string;
}

export interface Provider {
  id: ProviderId;
  /** From PROVIDER_LABEL — used by the commit trailer, failure notes and the UI. */
  label: string;
  /** One interface for every provider (zero quota): is it there, is it signed in, does a self-test pass. */
  detect(cfg: Config): Promise<DetectResult>;
  auth(cfg: Config): Promise<AuthResult>;
  selfTest(cfg: Config, level: SelfTestLevel): Promise<SelfTestResult>;
  /** Read-only structured run. Its presence IS the `readOnly` capability. */
  runReadOnly?(req: ReadOnlyRunReq): Promise<AgentResult>;
  /** Web research (Claude only today). */
  runResearch?(req: ResearchRunReq): Promise<AgentResult>;
  build?: BuildCapability;
}
