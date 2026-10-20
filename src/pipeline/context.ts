import type { ProviderId, AgentResult, Config, Run } from '../types.ts';
import type { Board } from '../board/index.ts';
import type { RunStore } from '../store.ts';
import type { PersistentState } from '../config.ts';
import type { Agents } from '../agents/provider.ts';
import type { EmitEvent } from '../agents/claude.ts';
import type { Clock } from '../util.ts';
import type { States } from '../agents/routing.ts';
import type { Effects } from './effects.ts';

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
  providerPause(agent: ProviderId, until: number, reason: string): void;
  /** Active pause for a provider, if any. */
  pausedUntil(agent: ProviderId): { until: number; reason: string } | null;
  /** Provider capabilities + CLI-reported health + pauses, as the router wants them. */
  routeStates(): States;
  /** Ask the engine to run another poll/schedule pass soon. */
  tickSoon(): void;
  /** Latest provider quota/utilisation reported by an agent run (for the dashboard meter). */
  recordQuota(agent: ProviderId, q: NonNullable<AgentResult['quota']>): void;
}
