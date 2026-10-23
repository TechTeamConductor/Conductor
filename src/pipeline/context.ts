import type { ProviderId, AgentResult, Config, Run } from '../types.ts';
import type { Board } from '../board/index.ts';
import type { RunStore } from '../store.ts';
import type { PersistentState } from '../config.ts';
import type { Agents } from '../agents/provider.ts';
import type { EmitEvent } from '../agents/claude.ts';
import type { Clock } from '../util.ts';
import type { States } from '../agents/routing.ts';
import type { Effects } from './effects.ts';
import type { ContextLike } from '../context/service.ts';
import type { AccountRef } from '../accounts/types.ts';
import type { LimitRule } from '../accounts/limit-rule.ts';
import type { Role } from '../agents/roles.ts';

/** Everything stage logic needs from the engine. Keeps `stages.ts` testable and free of polling concerns. */
export interface PipelineCtx {
  cfg(): Config;
  store: RunStore;
  board: Board;
  agents: Agents;
  clock: Clock;
  effects: Effects;
  notify(title: string, message: string): void;
  persistent: { load(): PersistentState; save(s: PersistentState): void };
  /** Redaction secrets for a run (provider keys, repo env-file values, …). */
  secretsFor(run: Run): string[];
  /** Abort signal of the job currently running for `key`. */
  signal(key: string): AbortSignal;
  emit(key: string, ev: EmitEvent): void;
  hist(key: string, text: string): void;
  /** M8-3: a usage-limit pause on ONE account (capped at 24 h by the engine). */
  providerPause(ref: AccountRef, until: number, reason: string): void;
  /** Active pause for an account, if any. */
  pausedUntil(ref: AccountRef): { until: number; reason: string } | null;
  /** Provider capabilities + CLI-reported health + pauses + accounts, as the router wants them (`role` ⇒ offersModel per account). */
  routeStates(role?: Role): States;
  /** M8-3 (C1): the ONLY source of the limit rule for stages — `effectiveLimitRule(cfg)`. */
  limitRule(): LimitRule;
  /** M8-3: an attempt of run `key` starts on this account (records `run.account`; removal ⇒ restart). */
  noteCandidate(key: string, ref: AccountRef): void;
  /** Refresh the zero-quota provider health first if the last reading is missing/stale (so routing never relies on a dashboard having looked). */
  freshHealth(): Promise<void>;
  /**
   * One slot of the engine's single cap on concurrent read-only analysis calls (task graphs; `pipeline.readOnlyParallel`), shared by every run.
   * Resolves with a release function, or null when `signal` aborts while waiting.
   */
  analysisSlot(signal?: AbortSignal): Promise<(() => void) | null>;
  /**
   * One slot of `pipeline.maxParallel` for a build, shared by every run (task-graph items and whole-card builds).
   * Resolves with a release function, or null when `signal` aborts while waiting.
   */
  buildSlot(signal?: AbortSignal): Promise<(() => void) | null>;
  /** The connectivity probe's verdict (cached ~20 s; `unknown` when it cannot tell). */
  networkState(): Promise<'online' | 'offline' | 'unknown'>;
  /** The project context engine (M4): packs for prompts, refresh, outcome digests. Best-effort — it never fails or blocks a run. */
  context: ContextLike;
  /** Ask the engine to run another poll/schedule pass soon. */
  tickSoon(): void;
  /** Latest provider quota/utilisation reported by an agent run (for the dashboard meter). */
  recordQuota(ref: AccountRef, q: NonNullable<AgentResult['quota']>): void;
}
