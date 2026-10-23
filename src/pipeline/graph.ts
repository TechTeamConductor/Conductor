// The task graph (M3): validation of a plan's `taskGraph`, derived item readiness, blocked propagation, budgets, lane projection and the
// crash-adoption marker. PURE — no git, no I/O, no clock — so every rule is unit-tested in isolation (test/graph.test.ts).
import { randomBytes } from 'node:crypto';
import type { Role } from '../agents/roles.ts';
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

/** Control, format (bidi, zero-width, Unicode tags …), separator, private-use and unassigned characters, plus invisible fillers and variation selectors. */
const INVISIBLE_KEEP_NEWLINE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u034F\u115F\u1160\u3164\uFFA0\u2800]/gu;
/** Multi-line text with invisible/format characters stripped (newlines and tabs kept) — for notes and objectives that stay multi-line. */
export function stripInvisible(s: unknown): string {
  return String(s ?? '').split(/([\n\t])/).map((part) => (part === '\n' || part === '\t' ? part : part.replace(INVISIBLE_KEEP_NEWLINE, ''))).join('');
}
/** Single-line, invisible/format characters stripped, length-capped — for anything that lands in a commit message, a card or a prompt. */
export function sanitizeLine(s: unknown, max: number): string {
  return String(s ?? '')
    .replace(INVISIBLE_KEEP_NEWLINE, ' ')
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

const GROUP_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;
/** A parallel-group label, or undefined when the model text is not a short token. */
export function parallelGroupOf(raw: unknown): string | undefined {
  const t = sanitizeLine(raw, 32);
  return GROUP_RE.test(t) ? t : undefined;
}

/**
 * Drop dependency edges between items that share a parallelGroup. Explicit deps to items outside the group stay.
 * Ready build items whose files do not overlap start together, up to `pipeline.maxParallel` (`pickReadyBuilds`).
 */
export function depsWithoutParallelPeers(items: readonly { id: string; dependsOn: readonly string[]; parallelGroup?: string }[]): Map<string, string[]> {
  const group = new Map(items.map((i) => [i.id, parallelGroupOf(i.parallelGroup)]));
  const out = new Map<string, string[]>();
  for (const it of items) {
    const mine = group.get(it.id);
    out.set(
      it.id,
      it.dependsOn.filter((d) => {
        const other = group.get(d);
        return !(mine && other && mine === other);
      }),
    );
  }
  return out;
}

/** The runtime form of a validated plan graph: every item `pending`, counters zeroed. Same-group edges are removed. */
export function buildGraph(plan: Plan, rev: number, now: number, loopBudget: number): TaskGraphRun {
  const planned = itemsOf(plan);
  const deps = depsWithoutParallelPeers(planned);
  return {
    rev,
    startedAt: now,
    final: 'pending',
    items: planned.map<ItemRun>((it) => ({
      id: it.id,
      key: null,
      title: sanitizeLine(it.title, 160),
      role: it.role,
      objective: sanitizeLine(it.objective, 2000),
      dependsOn: [...(deps.get(it.id) ?? it.dependsOn)],
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

const idNum = (id: string): number => Number(id.slice(1));

/** Every item `id` depends on, directly or through other items (not `id` itself), in declaration order. */
export function ancestorsOf(items: readonly ItemRun[], id: string): ItemRun[] {
  const m = byId(items);
  const seen = new Set<string>();
  const stack = [...(m.get(id)?.dependsOn ?? [])];
  while (stack.length) {
    const d = stack.pop()!;
    if (seen.has(d) || d === id) continue;
    seen.add(d);
    for (const n of m.get(d)?.dependsOn ?? []) stack.push(n);
  }
  return items.filter((i) => seen.has(i.id));
}

/**
 * The next piece of work for routing, or undefined when nothing can run: an interrupted (`running`) item first, then the first ready
 * analysis item, then the ready build item with the lowest id. Scheduling starts every ready file-disjoint build (`pickReadyBuilds`).
 */
export function pickNext(items: readonly ItemRun[]): ItemRun | undefined {
  const running = items.find((i) => i.state === 'running');
  if (running) return running;
  const ready = readySet(items);
  return ready.find((i) => ANALYSIS_ROLES.has(i.role)) ?? [...ready].filter((i) => BUILD_ROLES.has(i.role)).sort((a, b) => idNum(a.id) - idNum(b.id))[0];
}

const fileKey = (p: string): string => p.replace(/^\.\//, '').replace(/\\/g, '/');

/**
 * Ready build items that can start now: dependencies done, files disjoint from each other and from builds already running,
 * at most `limit` of them (the free `pipeline.maxParallel` slots). A build that lists no files runs by itself.
 * Lowest id first. Analysis items are not included.
 */
export function pickReadyBuilds(items: readonly ItemRun[], limit: number): ItemRun[] {
  const running = items.filter((i) => i.state === 'running' && BUILD_ROLES.has(i.role));
  const slots = Math.max(0, Math.floor(limit) - running.length);
  if (slots === 0 || running.some((i) => i.files.length === 0)) return [];
  const taken = new Set(running.flatMap((i) => i.files.map(fileKey)));
  const ready = readySet(items)
    .filter((i) => BUILD_ROLES.has(i.role))
    .sort((a, b) => idNum(a.id) - idNum(b.id));
  const out: ItemRun[] = [];
  for (const it of ready) {
    if (out.length >= slots) break;
    if (it.files.length === 0) {
      if (out.length === 0 && running.length === 0) out.push(it);
      break;
    }
    const files = it.files.map(fileKey);
    if (files.some((f) => taken.has(f))) continue;
    for (const f of files) taken.add(f);
    out.push(it);
  }
  return out;
}

/**
 * The role the next build-stage step of a graph that is still being built needs (so routing/pausing looks at the right provider chain),
 * or null when there is nothing to run. Undefined = this run has no graph under construction: the single-task rule applies.
 */
export function nextBuildRole(graph: TaskGraphRun | undefined): Role | null | undefined {
  if (!graph || graph.final !== 'pending') return undefined;
  const it = pickNext(graph.items);
  if (!it) return null;
  return ANALYSIS_ROLES.has(it.role) ? (it.role as Role) : it.loop > 1 ? 'debugging' : (it.role as Role);
}
