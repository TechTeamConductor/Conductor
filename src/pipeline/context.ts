import type { AgentName, AgentResult, Config, LinearPort, Run } from '../types.ts';
import type { RunStore } from '../store.ts';
import type { PersistentState } from '../config.ts';
import type { Agents } from '../agents/provider.ts';
import type { EmitEvent } from '../agents/claude.ts';
import type { Clock } from '../util.ts';
import type { Provisioned } from '../linear/provision.ts';
import type { Effects } from './effects.ts';

/** Everything stage logic needs from the engine. Keeps `stages.ts` testable and free of polling concerns. */
export interface PipelineCtx {
  cfg(): Config;
  store: RunStore;
  /** Throws if Linear is not configured yet. */
  linear(): LinearPort;
  agents: Agents;
  clock: Clock;
  effects: Effects;
  notify(title: string, message: string): void;
  persistent: { load(): PersistentState; save(s: PersistentState): void };
  prov(): Promise<Provisioned>;
  completedStateId(): Promise<string | null>;
  viewerId(): string;
  /** Redaction secrets for a run (Linear key, repo env-file values, …). */
  secretsFor(run: Run): string[];
  /** Abort signal of the job currently running for `key`. */
  signal(key: string): AbortSignal;
  emit(key: string, ev: EmitEvent): void;
  hist(key: string, text: string): void;
  providerPause(agent: AgentName, until: number, reason: string): void;
  /** Active pause for a provider, if any. */
  pausedUntil(agent: AgentName): { until: number; reason: string } | null;
  /** Ask the engine to run another poll/schedule pass soon. */
  tickSoon(): void;
  /** Latest provider quota/utilisation reported by an agent run (for the dashboard meter). */
  recordQuota(agent: AgentName, q: NonNullable<AgentResult['quota']>): void;
}
