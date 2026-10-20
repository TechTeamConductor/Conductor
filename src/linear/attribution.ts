/**
 * Attribution and idempotency-marker helpers (plan RC1 residual, C1).
 *
 * Linear is a shared workspace: a teammate could add the trigger label, edit the description, or comment.
 * Conductor only acts on text/labels that the *viewer* (the API-key owner) authored. Everything here is a pure
 * function over a `LinearIssue` returned by `LinearPort.issue()` (comments + ALL history pages).
 *
 * Fail closed: missing or truncated history never yields `ok: true`.
 */
import type { LinearComment, LinearHistoryEntry, LinearIssue, LinearLabel } from '../types.ts';
import { MARKER_PREFIX, sameName } from './names.ts';

export interface AttributionResult {
  ok: boolean;
  reason?: string;
}

/**
 * `LinearIssue` as returned by `LinearClient.issue()`. The client sets the truncation flags when a page cap (500 history
 * entries / 200 comments) was hit; attribution then fails closed because an "absent" history entry can no longer be trusted.
 */
export type IssueWithFlags = LinearIssue & { historyTruncated?: boolean; commentsTruncated?: boolean };

// ───────────────────────────── idempotency markers ─────────────────────────────

const MARKER_LINE = new RegExp(`^\\s*${MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(\\S+)\\s*$`);

/** Footer line carried by every Conductor-created comment / sub-issue description. */
export function markerLine(key: string): string {
  if (typeof key !== 'string' || key.length === 0 || /\s/.test(key)) {
    throw new Error(`invalid marker key: ${JSON.stringify(key)} (must be non-empty, no whitespace)`);
  }
  return `${MARKER_PREFIX} ${key}`;
}

/** Append the marker as the final visible line of `body`. */
export function withMarker(body: string, key: string): string {
  return `${body.replace(/\s+$/, '')}\n\n${markerLine(key)}`;
}

/** All marker keys found in `body` (one per matching line). */
export function markerKeys(body: string): string[] {
  const keys: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = MARKER_LINE.exec(line);
    if (m && m[1]) keys.push(m[1]);
  }
  return keys;
}

/** True when `body` has the exact marker line for `key` (no prefix matches: `a:1` != `a:10`). */
export function hasMarker(body: string, key: string): boolean {
  return markerKeys(body).includes(key);
}

/** True when the comment was written by Conductor (it carries any `conductor-ref:` marker line). */
export function isConductorComment(body: string): boolean {
  return markerKeys(body).length > 0;
}

// ───────────────────────────── helpers ─────────────────────────────

const ts = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

function sortedHistory(history: readonly LinearHistoryEntry[]): LinearHistoryEntry[] {
  return history
    .map((h, i) => ({ h, i }))
    .sort((a, b) => ts(a.h.createdAt) - ts(b.h.createdAt) || a.i - b.i)
    .map(({ h }) => h);
}

/** The label on the issue whose name matches the trigger label (team- or workspace-level), if any. */
export function findTriggerLabelOnIssue(issue: Pick<LinearIssue, 'labels'>, triggerLabelName: string): LinearLabel | undefined {
  return issue.labels.find((l) => sameName(l.name, triggerLabelName));
}

function historyUnusable(issue: IssueWithFlags): string | null {
  if (!Array.isArray(issue.history)) return 'issue history was not loaded (fetch the issue with LinearPort.issue())';
  if (issue.historyTruncated) return 'issue history is truncated (too many entries); attribution cannot be verified';
  return null;
}

// ───────────────────────────── attribution ─────────────────────────────

/**
 * C1: the trigger label counts as viewer-attributed when
 *  (a) the latest history entry adding it has `actorId === viewerId` (a later removal + re-add by someone else
 *      makes that someone else the latest adder and breaks attribution), or
 *  (b) NO history entry ever added it (=> it was present at creation) AND the issue creator is the viewer.
 */
export function attributeTrigger(issue: IssueWithFlags, triggerLabelId: string, viewerId: string): AttributionResult {
  const bad = historyUnusable(issue);
  if (bad) return { ok: false, reason: bad };
  if (!issue.labels.some((l) => l.id === triggerLabelId)) {
    return { ok: false, reason: 'trigger label is not on the issue' };
  }
  let lastAdd: LinearHistoryEntry | undefined;
  for (const h of sortedHistory(issue.history ?? [])) {
    if (h.addedLabelIds.includes(triggerLabelId)) lastAdd = h;
  }
  if (lastAdd) {
    if (lastAdd.actorId === viewerId) return { ok: true };
    return {
      ok: false,
      reason: `trigger label was added by ${lastAdd.actorId ?? 'an unknown actor'} (not the API-key owner) at ${lastAdd.createdAt}`,
    };
  }
  // No history entry adds it => present from creation => attributed to the creator.
  if (issue.creatorId === viewerId) return { ok: true };
  return {
    ok: false,
    reason: `trigger label was present at creation and the issue was created by ${issue.creatorId ?? 'an unknown user'} (not the API-key owner)`,
  };
}

/**
 * The issue description is trusted only if the creator is the viewer and every recorded description edit was made
 * by the viewer (`IssueHistory.descriptionUpdatedBy`).
 */
export function attributeDescription(issue: IssueWithFlags, viewerId: string): AttributionResult {
  const bad = historyUnusable(issue);
  if (bad) return { ok: false, reason: bad };
  if (issue.creatorId !== viewerId) {
    return {
      ok: false,
      reason: `issue was created by ${issue.creatorId ?? 'an unknown user'} (not the API-key owner), so its description is not trusted`,
    };
  }
  for (const h of sortedHistory(issue.history ?? [])) {
    for (const u of h.descriptionUpdatedBy ?? []) {
      if (u !== viewerId) {
        return { ok: false, reason: `description was edited by user ${u} (not the API-key owner) at ${h.createdAt}` };
      }
    }
  }
  return { ok: true };
}

/** The issue TITLE reaches planner/builder prompts, so it needs the same attribution as the description (H2). */
export function attributeTitle(issue: IssueWithFlags, viewerId: string): AttributionResult {
  const bad = historyUnusable(issue);
  if (bad) return { ok: false, reason: bad };
  if (issue.creatorId !== viewerId) return { ok: false, reason: `issue was created by ${issue.creatorId ?? 'an unknown user'} (not the API-key owner), so its title is not trusted` };
  for (const h of sortedHistory(issue.history ?? [])) {
    for (const u of h.titleUpdatedBy ?? []) if (u !== viewerId) return { ok: false, reason: `title was edited by user ${u} (not the API-key owner) at ${h.createdAt}` };
  }
  return { ok: true };
}

/** The Linear project (used for repo mapping) is trusted only if nobody else moved the issue between projects. */
export function attributeProject(issue: IssueWithFlags, viewerId: string): AttributionResult {
  const bad = historyUnusable(issue);
  if (bad) return { ok: false, reason: bad };
  for (const h of sortedHistory(issue.history ?? [])) {
    for (const u of h.projectUpdatedBy ?? []) if (u !== viewerId) return { ok: false, reason: `project was changed by user ${u} (not the API-key owner) at ${h.createdAt}` };
  }
  return { ok: true };
}

/** Labels that are safe to act on: added by the viewer (latest adder), or present from creation on a viewer-created issue. */
export function viewerAttributedLabels(issue: IssueWithFlags, viewerId: string): LinearLabel[] {
  if (historyUnusable(issue)) return [];
  const hist = sortedHistory(issue.history ?? []);
  return issue.labels.filter((l) => {
    let lastAdd: LinearHistoryEntry | undefined;
    for (const h of hist) if (h.addedLabelIds.includes(l.id)) lastAdd = h;
    return lastAdd ? lastAdd.actorId === viewerId : issue.creatorId === viewerId;
  });
}

/** Who moved the issue into its CURRENT state (null if unknown). A teammate must not be able to restart runs (H1). */
export function currentStateMover(issue: IssueWithFlags): { actorId: string | null; at: string } | null {
  const hist = sortedHistory(issue.history ?? []);
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i]!.toStateId === issue.state.id) return { actorId: hist[i]!.actorId, at: hist[i]!.createdAt };
  }
  return null;
}

/** Viewer-authored comments, oldest first, EXCLUDING Conductor's own comments (those carry a marker). */
export function viewerComments(issue: Pick<LinearIssue, 'comments'>, viewerId: string): LinearComment[] {
  return (issue.comments ?? [])
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.userId === viewerId && !isConductorComment(c.body))
    .sort((a, b) => ts(a.c.createdAt) - ts(b.c.createdAt) || a.i - b.i)
    .map(({ c }) => c);
}

/**
 * True if a viewer-authored (non-Conductor) comment, created strictly after `afterIso` when given, has `/approve`
 * as its first non-empty line (exact match after trimming).
 */
export function hasApproveCommand(comments: readonly LinearComment[], viewerId: string, afterIso?: string): boolean {
  const after = afterIso === undefined ? null : ts(afterIso);
  for (const c of comments) {
    if (c.userId !== viewerId) continue;
    if (isConductorComment(c.body)) continue;
    if (after !== null && ts(c.createdAt) <= after) continue;
    const first = c.body.split(/\r?\n/).find((l) => l.trim() !== '');
    if (first !== undefined && first.trim() === '/approve') return true;
  }
  return false;
}
