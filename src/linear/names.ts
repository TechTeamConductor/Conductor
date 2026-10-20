/**
 * Names, colours and marker constants shared by the Linear layer (provisioning, attribution, the engine).
 * Erasable TypeScript only.
 */
import type { LinearState } from '../types.ts';

/** Default trigger label (Config.linear.triggerLabel can override). */
export const TRIGGER_LABEL_DEFAULT = 'conductor';
/** Label carried by bug sub-issues created by the verifier loop. Never the trigger label. */
export const BUG_LABEL = 'conductor-bug';

export type StageKey = 'planning' | 'plan_ready' | 'building' | 'verifying' | 'needs_human' | 'ready';

export const STAGE_KEYS: readonly StageKey[] = ['planning', 'plan_ready', 'building', 'verifying', 'needs_human', 'ready'];

/** Stage labels (labels mode shows the stage through these; added/removed via addedLabelIds/removedLabelIds). */
export const STAGE_LABEL: Readonly<Record<StageKey, string>> = {
  planning: 'conductor:planning',
  plan_ready: 'conductor:plan-ready',
  building: 'conductor:building',
  verifying: 'conductor:verifying',
  needs_human: 'conductor:needs-human',
  ready: 'conductor:ready',
};

/** Label colours (hex). */
export const TRIGGER_LABEL_COLOR = '#5e6ad2';
export const BUG_LABEL_COLOR = '#eb5757';
export const STAGE_LABEL_COLOR: Readonly<Record<StageKey, string>> = {
  planning: '#8b5cf6',
  plan_ready: '#f59e0b',
  building: '#3b82f6',
  verifying: '#06b6d4',
  needs_human: '#ef4444',
  ready: '#22c55e',
};

export interface StateDef {
  key: StageKey;
  name: string;
  type: LinearState['type'];
  color: string;
}

/**
 * Workflow statuses created in `linear.mode: "states"`. All are of native type `started`, so the issue is never
 * mistaken for a human "retry" signal (`unstarted`) or "abort" signal (`completed` / `canceled`).
 */
export const STATE_DEFS: readonly StateDef[] = [
  { key: 'planning', name: 'Planning', type: 'started', color: '#8b5cf6' },
  { key: 'plan_ready', name: 'Plan Ready', type: 'started', color: '#f59e0b' },
  { key: 'building', name: 'Building', type: 'started', color: '#3b82f6' },
  { key: 'verifying', name: 'Verifying', type: 'started', color: '#06b6d4' },
  { key: 'needs_human', name: 'Needs Human', type: 'started', color: '#ef4444' },
  { key: 'ready', name: 'Ready for Review', type: 'started', color: '#22c55e' },
];

/** Name of the team's native review status (labels mode moves a verified issue there if it exists). */
export const IN_REVIEW_STATE_NAME = 'In Review';

/** Idempotency marker: a visible final footer line `conductor-ref: <key>` in comments / descriptions. */
export const MARKER_PREFIX = 'conductor-ref:';

export interface LabelDef {
  name: string;
  color: string;
}

/** Every label Conductor needs for a team (trigger first). */
export function labelDefs(triggerLabel: string = TRIGGER_LABEL_DEFAULT): LabelDef[] {
  return [
    { name: triggerLabel, color: TRIGGER_LABEL_COLOR },
    { name: BUG_LABEL, color: BUG_LABEL_COLOR },
    ...STAGE_KEYS.map((k) => ({ name: STAGE_LABEL[k], color: STAGE_LABEL_COLOR[k] })),
  ];
}

/** Case-insensitive name equality used for every label/state lookup. */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
