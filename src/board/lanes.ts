import type { Run } from '../types.ts';
import type { Lane } from './types.ts';

/** Fine-grained stage labels shown on a card (the lane says WHERE it is, the stage says WHAT is happening). */
export type StageKey = 'planning' | 'plan_ready' | 'building' | 'verifying' | 'needs_human' | 'ready';
export const STAGE_KEYS: readonly StageKey[] = ['planning', 'plan_ready', 'building', 'verifying', 'needs_human', 'ready'];

/**
 * The lane a card belongs in, derived from the run — the single "desired lane" table of the crash protocol
 * (workspace-v2-m1.md). Level-triggered: it is recomputed at apply time and on every tick, never trusted from history.
 */
export function laneForRun(run: Pick<Run, 'status'>): Lane {
  switch (run.status) {
    case 'queued':
    case 'running':
    case 'paused':
    case 'failed':
      return 'active';
    case 'awaiting_approval':
    case 'needs_human':
      return 'needs_you';
    case 'ready':
    case 'finished':
      return 'done';
    case 'aborted':
      return 'canceled';
    case 'parked':
      return 'backlog';
  }
}
