// The provider contract (M2). Commit 1 covers what the BUILD ENVELOPE needs; roles/routing/read-only/Codex extend it later.
import type { AgentResult, Config } from '../../types.ts';
import type { EmitEvent } from '../claude.ts';
import type { Clock } from '../../util.ts';
import type { Schema } from '../json.ts';
import type { StageName } from '../../types.ts';

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

export interface Provider {
  id: ProviderId;
  /** From PROVIDER_LABEL — used by the commit trailer, failure notes and the UI. */
  label: string;
  /** Read-only structured run. Its presence IS the `readOnly` capability. */
  runReadOnly?(req: ReadOnlyRunReq): Promise<AgentResult>;
  build?: BuildCapability;
}
