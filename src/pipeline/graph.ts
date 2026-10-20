// The task graph (M3): validation of a plan's `taskGraph`, derived item readiness, blocked propagation, budgets, lane projection and the
// crash-adoption marker. PURE — no git, no I/O, no clock — so every rule is unit-tested in isolation (test/graph.test.ts).
import { randomBytes } from 'node:crypto';
import type { ItemRun, Plan, PlanItem, TaskGraphRun } from '../types.ts';

/** Hard v2.0 ceilings: no config can lift them (plan §2b-9, §2.5). */
export const GRAPH_MAX_ITEMS = 12;
export const HARD_RUNS = 150;
export const HARD_ITERATIONS = 400;

export const BUILD_ROLES: ReadonlySet<string> = new Set(['implementation', 'documentation']);
export const ANALYSIS_ROLES: ReadonlySet<string> = new Set(['requirements', 'architecture', 'context']);
const CONDUCTOR_OWNED_ROLES: ReadonlySet<string> = new Set(['review', 'verification', 'debugging']);

const ID_RE = /^T\d{1,2}$/;
const AC_RE = /^[A-Za-z][A-Za-z0-9_-]{0,15}$/;

/** Single-line, control and bidi/format characters stripped, length-capped — for anything that lands in a commit message, a card or a prompt. */
export function sanitizeLine(s: unknown, max: number): string {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f\u0080-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export const itemsOf = (plan: Pick<Plan, 'taskGraph'>): PlanItem[] => (Array.isArray(plan.taskGraph?.items) ? plan.taskGraph!.items : []);
/** A graph of fewer than 2 items is NOT a graph: the single-task path runs (plan §2b-3). */
export const isGraphPlan = (plan: Pick<Plan, 'taskGraph'>): boolean => itemsOf(plan).length >= 2;

const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');
function badPath(p: string): string | null {
  if (!p || p.length > 500) return 'empty or too long';
  const n = normPath(p);
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) return 'must be repo-relative';
  if (n.split('/').some((seg) => seg === '..' || seg === '')) return 'must not contain ".." or empty segments';
  if (/[\u0000-\u001f]/.test(n)) return 'contains control characters';
  return null;
}

/**
 * Semantic validation of `plan.taskGraph` (after the schema check). Returns human-readable errors (each starts with a `$.taskGraph…` path) —
 * they go back to the planner as the one corrective re-ask. A plan with no graph, or an empty `items` list, has nothing to validate.
 */
export function validateTaskGraph(plan: Plan, opts: { maxItems?: number } = {}): string[] {
  const items = itemsOf(plan);
  if (!plan.taskGraph || items.length === 0) return [];
  const errs: string[] = [];
  const max = Math.min(GRAPH_MAX_ITEMS, opts.maxItems ?? GRAPH_MAX_ITEMS);
  if (items.length > max) errs.push(`$.taskGraph.items: at most ${max} items (got ${items.length}) — merge related work into fewer items`);
  const ids = new Set<string>();
  const acIds = new Set((plan.acceptanceCriteria ?? []).map((a) => a.id));
  const planFiles = new Set((plan.filesToChange ?? []).map((f) => normPath(f.path)));
  const claimedAC = new Set<string>();
  const ownedFiles = new Set<string>();
  let builders = 0;
  items.forEach((it, i) => {
    const at = `$.taskGraph.items[${i}]`;
    if (!it || typeof it !== 'object') {
      errs.push(`${at}: must be an object`);
      return;
    }
    if (!ID_RE.test(String(it.id))) errs.push(`${at}.id: must look like T1, T2, … (got ${JSON.stringify(sanitizeLine(it.id, 20))})`);
    else if (ids.has(it.id)) errs.push(`${at}.id: duplicate id ${it.id}`);
    ids.add(it.id);
    if (!sanitizeLine(it.title, 200)) errs.push(`${at}.title: required`);
    else if (String(it.title).length > 160) errs.push(`${at}.title: at most 160 characters`);
    if (!String(it.objective ?? '').trim()) errs.push(`${at}.objective: required`);
    else if (String(it.objective).length > 2000) errs.push(`${at}.objective: at most 2000 characters`);
    const role = String(it.role);
    const build = BUILD_ROLES.has(role);
    const analysis = ANALYSIS_ROLES.has(role);
    if (role === 'research') errs.push(`${at}.role: "research" is not available yet — use "requirements", "architecture" or "context" for analysis`);
    else if (CONDUCTOR_OWNED_ROLES.has(role)) errs.push(`${at}.role: "${role}" is done by Conductor itself (plan review, verification, bug fixing) — it is not a plan item`);
    else if (!build && !analysis) errs.push(`${at}.role: must be one of implementation, documentation, requirements, architecture, context (got ${JSON.stringify(sanitizeLine(role, 30))})`);
    if (build) builders++;
    for (const k of ['dependsOn', 'files', 'criteria', 'verification'] as const) {
      if (!Array.isArray(it[k]) || it[k].some((x: unknown) => typeof x !== 'string')) errs.push(`${at}.${k}: must be a list of strings`);
      else if (it[k].length > 40) errs.push(`${at}.${k}: at most 40 entries`);
    }
    const files = Array.isArray(it.files) ? it.files.filter((f): f is string => typeof f === 'string') : [];
    if (analysis && files.length) errs.push(`${at}.files: analysis items are read-only and must list no files`);
    if (build && files.length === 0) errs.push(`${at}.files: a ${role} item must list at least one file (a subset of filesToChange)`);
    for (const f of files) {
      const bad = badPath(f);
      if (bad) errs.push(`${at}.files: ${JSON.stringify(sanitizeLine(f, 60))} ${bad}`);
      else if (!planFiles.has(normPath(f))) errs.push(`${at}.files: ${JSON.stringify(sanitizeLine(f, 60))} is not in filesToChange — every item file must be declared in the plan`);
      else if (build) ownedFiles.add(normPath(f));
    }
    for (const c of Array.isArray(it.criteria) ? it.criteria : []) {
      if (typeof c !== 'string' || !AC_RE.test(c)) errs.push(`${at}.criteria: ${JSON.stringify(sanitizeLine(c, 20))} is not a criterion id`);
      else if (!acIds.has(c)) errs.push(`${at}.criteria: ${c} is not one of the plan's acceptance criteria (${[...acIds].join(', ') || 'none'})`);
      else claimedAC.add(c);
    }
  });
  if (items.some((it) => !it || typeof it !== 'object')) return errs; // the cross-item checks below assume objects
  // dependencies
  items.forEach((it, i) => {
    if (!it || !Array.isArray(it.dependsOn)) return;
    for (const d of it.dependsOn) {
      if (d === it.id) errs.push(`$.taskGraph.items[${i}].dependsOn: ${it.id} depends on itself`);
      else if (!ids.has(d)) errs.push(`$.taskGraph.items[${i}].dependsOn: unknown item ${JSON.stringify(sanitizeLine(d, 20))}`);
    }
  });
  if (!errs.some((e) => /dependsOn/.test(e)) && topoOrder(items) === null) errs.push('$.taskGraph.items: the dependencies contain a cycle — an item cannot depend on itself through other items');
  // coverage both ways
  for (const ac of acIds) if (!claimedAC.has(ac)) errs.push(`$.taskGraph: acceptance criterion ${ac} is not claimed by any item`);
  for (const f of planFiles) if (!ownedFiles.has(f)) errs.push(`$.taskGraph: ${JSON.stringify(sanitizeLine(f, 60))} is in filesToChange but no implementation/documentation item owns it`);
  if (builders === 0) errs.push('$.taskGraph: needs at least one implementation or documentation item');
  return errs;
}

/** Kahn's algorithm. Item ids in a stable order (declaration order among ready items); `null` when the dependencies contain a cycle. */
export function topoOrder(items: ReadonlyArray<{ id: string; dependsOn: readonly string[] }>): string[] | null {
  const known = new Set(items.map((i) => i.id));
  const indeg = new Map<string, number>(items.map((i) => [i.id, i.dependsOn.filter((d) => known.has(d) && d !== i.id).length + (i.dependsOn.includes(i.id) ? 1 : 0)]));
  const out: string[] = [];
  const done = new Set<string>();
  for (;;) {
    const next = items.find((i) => !done.has(i.id) && (indeg.get(i.id) ?? 0) === 0);
    if (!next) break;
    done.add(next.id);
    out.push(next.id);
    for (const i of items) if (i.dependsOn.includes(next.id)) indeg.set(i.id, (indeg.get(i.id) ?? 0) - 1);
  }
  return out.length === items.length ? out : null;
}

/** The runtime form of a validated plan graph: every item `pending`, counters zeroed. */
export function buildGraph(plan: Plan, rev: number, now: number, loopBudget: number): TaskGraphRun {
  return {
    rev,
    startedAt: now,
    final: 'pending',
    items: itemsOf(plan).map<ItemRun>((it) => ({
      id: it.id,
      key: null,
      title: sanitizeLine(it.title, 160),
      role: it.role,
      objective: String(it.objective).slice(0, 2000),
      dependsOn: [...it.dependsOn],
      files: it.files.map(normPath),
      criteria: [...it.criteria],
      verification: it.verification.map((v) => sanitizeLine(v, 300)).slice(0, 40),
      state: 'pending',
      loop: 1,
      loopBudget,
      agentRuns: 0,
    })),
  };
}

const byId = (items: readonly ItemRun[]) => new Map(items.map((i) => [i.id, i]));

/** `ready` is derived: pending with every dependency done. */
export function isReady(item: ItemRun, items: readonly ItemRun[]): boolean {
  if (item.state !== 'pending') return false;
  const m = byId(items);
  return item.dependsOn.every((d) => m.get(d)?.state === 'done');
}
export const readySet = (items: readonly ItemRun[]): ItemRun[] => items.filter((i) => isReady(i, items));

/**
 * pending → blocked when a dependency is failed/blocked; blocked → pending when none is any more. Repeated to a fixed point (a chain blocks/unblocks
 * in one call). Mutates `items`; returns whether anything changed. Running/done/failed items are never touched here.
 */
export function propagateBlocked(items: ItemRun[]): boolean {
  let changed = false;
  for (let guard = 0; guard < items.length + 2; guard++) {
    let round = false;
    const m = byId(items);
    for (const it of items) {
      if (it.state !== 'pending' && it.state !== 'blocked') continue;
      const dead = it.dependsOn.some((d) => {
        const s = m.get(d)?.state;
        return s === 'failed' || s === 'blocked';
      });
      if (dead && it.state === 'pending') {
        it.state = 'blocked';
        round = true;
      } else if (!dead && it.state === 'blocked') {
        it.state = 'pending';
        round = true;
      }
    }
    if (!round) break;
    changed = true;
  }
  return changed;
}

/** Item state → the Conductor-owned lane of its subtask card. */
export function projectItemLane(it: Pick<ItemRun, 'state'>): 'todo' | 'active' | 'done' | 'needs_you' {
  switch (it.state) {
    case 'running':
      return 'active';
    case 'done':
      return 'done';
    case 'failed':
    case 'blocked':
      return 'needs_you';
    default:
      return 'todo';
  }
}

/** Budgets that scale with the amount of work but never past the hard ceilings (a graph-less run keeps today's numbers). */
export function graphBudgets(itemCount: number, baseRuns: number): { runsLimit: number; iterationCap: number } {
  if (itemCount < 2) return { runsLimit: baseRuns, iterationCap: 60 };
  return { runsLimit: Math.min(HARD_RUNS, baseRuns + 6 * itemCount), iterationCap: Math.min(HARD_ITERATIONS, 60 + 25 * itemCount) };
}

/** Crash adoption (plan §2b-2): a per-attempt nonce the builder cannot guess, carried in the commit message Conductor writes. */
export const newNonce = (): string => randomBytes(8).toString('hex');
export const itemMarker = (itemId: string, nonce: string): string => `Conductor-Item: ${itemId} ${nonce}`;
export function parseItemMarker(message: string): { itemId: string; nonce: string } | null {
  const m = /^Conductor-Item: (T\d{1,2}) ([0-9a-f]{16})$/m.exec(message);
  return m ? { itemId: m[1]!, nonce: m[2]! } : null;
}
