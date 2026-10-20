/**
 * Idempotent provisioning of the labels (and, in `states` mode, the workflow statuses) Conductor needs on a team.
 *
 *  - reuses an existing label with the same name at team OR workspace level (case-insensitive);
 *  - never throws for a permission failure on one item: that item goes to `manual` (exact name) and the rest continue;
 *  - `dryRun` creates nothing and lists `willCreate`;
 *  - C4: warns when the team's default status for new issues is backlog/triage (issues created with the trigger label
 *    there are not picked up unless `pickup.fromBacklog` is enabled) or when no `unstarted` status exists.
 */
import type { LinearLabel, LinearPort, LinearState, TeamSetupInfo } from '../types.ts';
import { LinearApiError, LinearRateLimitError } from './client.ts';
import {
  BUG_LABEL,
  IN_REVIEW_STATE_NAME,
  STAGE_KEYS,
  STAGE_LABEL,
  STATE_DEFS,
  labelDefs,
  sameName,
} from './names.ts';
import type { LabelDef, StageKey, StateDef } from './names.ts';

export interface Provisioned {
  triggerLabelId: string;
  bugLabelId: string;
  stageLabelIds: Record<StageKey, string>;
  /** Present in `states` mode only. */
  stageStateIds?: Record<StageKey, string>;
  /** First `started` state, preferring a name containing "progress" (never one of Conductor's own statuses if avoidable). */
  inProgressStateId: string;
  /** The team's `started` state named "In Review", if any. */
  inReviewStateId: string | null;
  /** First `unstarted` state (prefers "Todo"). */
  todoStateId: string | null;
  unstartedStateIds: string[];
  /** The team's default status for new issues, if Linear reported it. */
  defaultState: LinearState | null;
}

export type ProvisionMode = 'labels' | 'states';

export interface ProvisionItem {
  kind: 'label' | 'state';
  name: string;
  color: string;
  status: 'exists' | 'will_create' | 'created' | 'manual';
  /** Why a `manual` item could not be created (Linear's error text, verbatim). */
  error?: string;
}

export interface ProvisionResult {
  /** Exact names that would be created (dry run) / were missing. */
  willCreate: string[];
  /** Names created by this call. */
  created: string[];
  /** Exact names the user must create by hand (permission denied / conflicting status). */
  manual: string[];
  provisioned: Provisioned | null;
  defaultState: LinearState | null;
  /** Names of the team's `unstarted` statuses. */
  unstartedStates: string[];
  warnings: string[];
  /** Per-item detail (superset of the lists above). */
  items: ProvisionItem[];
}

// ───────────────────────────── analysis ─────────────────────────────

interface Analysis {
  labelIds: Map<string, string>; // wanted label name -> id
  missingLabels: LabelDef[];
  stateIds: Partial<Record<StageKey, string>>;
  missingStates: StateDef[];
  /** Conductor status names that exist with a type other than `started` (cannot be created or used). */
  conflictingStates: { def: StateDef; existing: LinearState }[];
  inProgress: LinearState | null;
  inReview: LinearState | null;
  todo: LinearState | null;
  unstarted: LinearState[];
  defaultState: LinearState | null;
}

function visibleLabels(setup: TeamSetupInfo, teamId: string): LinearLabel[] {
  return setup.labels.filter((l) => l.teamId === null || l.teamId === teamId);
}

/** Team-level label wins over a workspace-level one of the same name. */
function findLabel(labels: LinearLabel[], teamId: string, name: string): LinearLabel | undefined {
  return labels.find((l) => l.teamId === teamId && sameName(l.name, name)) ?? labels.find((l) => l.teamId === null && sameName(l.name, name));
}

function analyse(setup: TeamSetupInfo, teamId: string, mode: ProvisionMode, triggerLabel: string): Analysis {
  const labels = visibleLabels(setup, teamId);
  const labelIds = new Map<string, string>();
  const missingLabels: LabelDef[] = [];
  const seen = new Set<string>();
  for (const def of labelDefs(triggerLabel)) {
    const key = def.name.toLowerCase();
    if (seen.has(key)) continue; // e.g. a custom trigger label equal to a stage label
    seen.add(key);
    const found = findLabel(labels, teamId, def.name);
    if (found) labelIds.set(def.name, found.id);
    else missingLabels.push(def);
  }

  const stateIds: Partial<Record<StageKey, string>> = {};
  const missingStates: StateDef[] = [];
  const conflictingStates: { def: StateDef; existing: LinearState }[] = [];
  if (mode === 'states') {
    for (const def of STATE_DEFS) {
      const existing = setup.states.find((s) => sameName(s.name, def.name));
      if (!existing) missingStates.push(def);
      else if (existing.type !== def.type) conflictingStates.push({ def, existing });
      else stateIds[def.key] = existing.id;
    }
  }

  const conductorNames = new Set(STATE_DEFS.map((d) => d.name.toLowerCase()));
  const started = setup.states.filter((s) => s.type === 'started');
  const ownFree = started.filter((s) => !conductorNames.has(s.name.toLowerCase()));
  const pool = ownFree.length > 0 ? ownFree : started;
  const inProgress = pool.find((s) => /progress/i.test(s.name)) ?? pool[0] ?? null;
  const inReview = started.find((s) => sameName(s.name, IN_REVIEW_STATE_NAME)) ?? null;
  const unstarted = setup.states.filter((s) => s.type === 'unstarted');
  const todo = unstarted.find((s) => sameName(s.name, 'Todo')) ?? unstarted[0] ?? null;
  const defaultState = setup.defaultIssueStateId ? (setup.states.find((s) => s.id === setup.defaultIssueStateId) ?? null) : null;

  return { labelIds, missingLabels, stateIds, missingStates, conflictingStates, inProgress, inReview, todo, unstarted, defaultState };
}

function build(a: Analysis, mode: ProvisionMode, triggerLabel: string): Provisioned | null {
  if (a.missingLabels.length > 0 || a.missingStates.length > 0 || a.conflictingStates.length > 0 || !a.inProgress) return null;
  const id = (name: string): string => {
    const v = a.labelIds.get(name);
    if (!v) throw new Error(`internal: label ${name} unresolved`);
    return v;
  };
  const stageLabelIds = {} as Record<StageKey, string>;
  for (const k of STAGE_KEYS) stageLabelIds[k] = id(STAGE_LABEL[k]);
  const out: Provisioned = {
    triggerLabelId: id(triggerLabel),
    bugLabelId: id(BUG_LABEL),
    stageLabelIds,
    inProgressStateId: a.inProgress.id,
    inReviewStateId: a.inReview?.id ?? null,
    todoStateId: a.todo?.id ?? null,
    unstartedStateIds: a.unstarted.map((s) => s.id),
    defaultState: a.defaultState,
  };
  if (mode === 'states') {
    const stageStateIds = {} as Record<StageKey, string>;
    for (const k of STAGE_KEYS) {
      const sid = a.stateIds[k];
      if (!sid) return null;
      stageStateIds[k] = sid;
    }
    out.stageStateIds = stageStateIds;
  }
  return out;
}

/** Resolve existing ids only (no writes). `null` when anything required is missing. */
export async function resolveProvisioned(
  port: LinearPort,
  teamId: string,
  mode: ProvisionMode,
  triggerLabel: string,
): Promise<Provisioned | null> {
  const setup = await port.teamSetup(teamId);
  return build(analyse(setup, teamId, mode, triggerLabel), mode, triggerLabel);
}

function warningsFor(a: Analysis, triggerLabel: string): string[] {
  const w: string[] = [];
  if (a.defaultState && (a.defaultState.type === 'backlog' || a.defaultState.type === 'triage')) {
    w.push(
      `The team's default status for new issues is "${a.defaultState.name}" (${a.defaultState.type}). Issues created with the "${triggerLabel}" label land there and will NOT be picked up unless "pick up from Backlog" is enabled (pickup.fromBacklog, config linear.pickupFromBacklog) — move them to ${a.todo ? `"${a.todo.name}"` : 'an unstarted status'} instead.`,
    );
  } else if (!a.defaultState) {
    w.push(
      `Linear did not report the team's default status for new issues. If it is Backlog or Triage, issues created with the "${triggerLabel}" label will not be picked up unless "pick up from Backlog" is enabled (pickup.fromBacklog, config linear.pickupFromBacklog).`,
    );
  }
  if (a.unstarted.length === 0) {
    w.push(
      'The team has no "unstarted" (Todo-type) status. Conductor only picks up issues in an unstarted status and uses it as the "retry" signal — add a status of type Todo/unstarted.',
    );
  }
  if (!a.inProgress) {
    w.push('The team has no "started" status (e.g. In Progress). Conductor needs one to mark active work — add a status of type started.');
  }
  if (!a.inReview) {
    w.push(`No "${IN_REVIEW_STATE_NAME}" status of type started: a verified issue stays in its current status and is marked with the "${STAGE_LABEL.ready}" label.`);
  }
  for (const c of a.conflictingStates) {
    w.push(
      `A status named "${c.existing.name}" already exists with type "${c.existing.type}", but Conductor's status must be of type "${c.def.type}" (an "${c.existing.type}" status would be misread as a human signal). Rename it or create "${c.def.name}" by hand.`,
    );
  }
  return w;
}

function isCreateFailure(e: unknown): e is LinearApiError {
  // Rate limits, network failures and "team not found" are infrastructure problems, not missing permissions.
  return e instanceof LinearApiError && !(e instanceof LinearRateLimitError) && !e.notFound;
}

/**
 * Ensure the labels (and in `states` mode the statuses) exist. Idempotent: a second run creates nothing.
 */
export async function provisionTeam(
  port: LinearPort,
  teamId: string,
  mode: ProvisionMode,
  triggerLabel: string,
  opts: { dryRun?: boolean } = {},
): Promise<ProvisionResult> {
  const dryRun = opts.dryRun === true;
  const setup = await port.teamSetup(teamId);
  const work: TeamSetupInfo = { states: [...setup.states], labels: [...setup.labels], defaultIssueStateId: setup.defaultIssueStateId };
  const first = analyse(work, teamId, mode, triggerLabel);

  const items: ProvisionItem[] = [];
  const created: string[] = [];
  const manual: string[] = [];
  const willCreate: string[] = [];
  const extraWarnings: string[] = [];

  const seenLabels = new Set<string>();
  for (const def of labelDefs(triggerLabel)) {
    if (seenLabels.has(def.name.toLowerCase())) continue; // e.g. a custom trigger label equal to a stage label
    seenLabels.add(def.name.toLowerCase());
    if (first.labelIds.has(def.name)) {
      items.push({ kind: 'label', name: def.name, color: def.color, status: 'exists' });
      continue;
    }
    willCreate.push(def.name);
    const item: ProvisionItem = { kind: 'label', name: def.name, color: def.color, status: 'will_create' };
    items.push(item);
    if (dryRun) continue;
    try {
      const label = await port.createLabel(teamId, { name: def.name, color: def.color });
      work.labels.push(label);
      created.push(def.name);
      item.status = 'created';
    } catch (e) {
      if (!isCreateFailure(e)) throw e;
      manual.push(def.name);
      item.status = 'manual';
      item.error = e.message;
      extraWarnings.push(`Could not create label "${def.name}": ${e.message}. Create it by hand (exact name).`);
    }
  }

  if (mode === 'states') {
    for (const def of STATE_DEFS) {
      const conflict = first.conflictingStates.find((c) => c.def.key === def.key);
      if (conflict) {
        manual.push(def.name);
        items.push({ kind: 'state', name: def.name, color: def.color, status: 'manual', error: `exists with type ${conflict.existing.type}` });
        continue;
      }
      if (first.stateIds[def.key]) {
        items.push({ kind: 'state', name: def.name, color: def.color, status: 'exists' });
        continue;
      }
      willCreate.push(def.name);
      const item: ProvisionItem = { kind: 'state', name: def.name, color: def.color, status: 'will_create' };
      items.push(item);
      if (dryRun) continue;
      try {
        const state = await port.createState(teamId, { name: def.name, type: def.type, color: def.color });
        work.states.push(state);
        created.push(def.name);
        item.status = 'created';
      } catch (e) {
        if (!isCreateFailure(e)) throw e;
        manual.push(def.name);
        item.status = 'manual';
        item.error = e.message;
        extraWarnings.push(`Could not create status "${def.name}" (type ${def.type}, colour ${def.color}): ${e.message}. Create it by hand (exact name).`);
      }
    }
  }

  const final = analyse(work, teamId, mode, triggerLabel);
  const provisioned = build(final, mode, triggerLabel);
  const warnings = [...warningsFor(final, triggerLabel), ...extraWarnings];

  return {
    willCreate,
    created,
    manual,
    provisioned,
    defaultState: final.defaultState,
    unstartedStates: final.unstarted.map((s) => s.name),
    warnings,
    items,
  };
}
