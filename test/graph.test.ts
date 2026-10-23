// M3 commit 1: the pure task-graph rules (validation, readiness, blocked propagation, budgets, lanes, markers) and their rendering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ItemRun, Plan, PlanItem } from '../src/types.ts';
import { GRAPH_MAX_ITEMS, HARD_ITERATIONS, HARD_RUNS, buildGraph, depsWithoutParallelPeers, graphBudgets, isGraphPlan, isReady, itemMarker, newNonce, parseItemMarker, projectItemLane, propagateBlocked, readySet, sanitizeLine, topoOrder, validateTaskGraph } from '../src/pipeline/graph.ts';
import { planToMarkdown } from '../src/pipeline/prompts.ts';
import { PLAN_SCHEMA } from '../src/pipeline/schemas.ts';
import { validateSchema } from '../src/agents/json.ts';

const item = (id: string, over: Partial<PlanItem> = {}): PlanItem => ({ id, title: `Item ${id}`, role: 'implementation', objective: `Do ${id}`, dependsOn: [], files: [`src/${id.toLowerCase()}.ts`], criteria: [], verification: ['npm test'], ...over });
function plan(items: PlanItem[], over: Partial<Plan> = {}): Plan {
  return {
    summary: 's', blocked: { is: false, questions: [] }, assumptions: [], currentState: 'c', expectedState: 'e',
    acceptanceCriteria: [{ id: 'AC1', text: 'works', verification: 'npm test' }, { id: 'AC2', text: 'also works', verification: 'npm test' }],
    filesToChange: items.flatMap((i) => i.files).map((path) => ({ path, action: 'create' as const, change: 'x', reason: 'AC1' })),
    steps: ['a'], testing: { commands: ['npm test'], cases: ['c'] }, risks: [], coverage: [], complexity: 'M', taskGraph: { items }, ...over,
  };
}
const good = () => plan([item('T1', { criteria: ['AC1'] }), item('T2', { dependsOn: ['T1'], criteria: ['AC2'] })]);

test('a valid graph passes; no graph, an empty graph and a one-item graph are "not a graph" for execution', () => {
  assert.deepEqual(validateTaskGraph(good()), []);
  assert.equal(isGraphPlan(good()), true);
  const none = good();
  delete none.taskGraph;
  assert.deepEqual(validateTaskGraph(none), []);
  assert.equal(isGraphPlan(none), false);
  assert.deepEqual(validateTaskGraph(plan([])), []);
  assert.equal(isGraphPlan(plan([])), false);
  const one = plan([item('T1', { criteria: ['AC1', 'AC2'] })]);
  assert.deepEqual(validateTaskGraph(one), [], 'a one-item graph is valid …');
  assert.equal(isGraphPlan(one), false, '… and runs as a single task');
});

test('every invalid-graph class is rejected with a specific message (M3-AC2)', () => {
  const bad = (items: PlanItem[], over: Partial<Plan> = {}) => validateTaskGraph(plan(items, over)).join('\n');
  assert.match(bad([item('T1', { dependsOn: ['T2'], criteria: ['AC1'] }), item('T2', { dependsOn: ['T1'], criteria: ['AC2'] })]), /cycle/);
  assert.match(bad([item('T1', { dependsOn: ['T1'], criteria: ['AC1', 'AC2'] }), item('T2')]), /depends on itself/);
  assert.match(bad([item('T1', { dependsOn: ['T9'], criteria: ['AC1', 'AC2'] })]), /unknown item "T9"/);
  assert.match(bad([item('T1', { criteria: ['AC1'] }), item('T1', { criteria: ['AC2'], files: ['src/other.ts'] })]), /duplicate id T1/);
  assert.match(bad([item('X1', { criteria: ['AC1', 'AC2'] })]), /must look like T1/);
  assert.match(bad([item('T1', { criteria: ['AC1'] })]), /acceptance criterion AC2 is not claimed/);
  assert.match(bad([item('T1', { criteria: ['AC1', 'AC2', 'AC9'] })]), /AC9 is not one of the plan's acceptance criteria/);
  const o = plan([item('T1', { criteria: ['AC1', 'AC2'], files: ['src/a.ts', 'src/ghost.ts'] })]);
  o.filesToChange = o.filesToChange.filter((f) => f.path !== 'src/ghost.ts'); // the plan never declared it
  assert.match(validateTaskGraph(o).join('\n'), /ghost\.ts" is not in filesToChange/);
  const orphan = plan([item('T1', { criteria: ['AC1', 'AC2'] })]);
  orphan.filesToChange.push({ path: 'src/forgotten.ts', action: 'create', change: 'x', reason: 'y' });
  assert.match(validateTaskGraph(orphan).join('\n'), /forgotten\.ts" is in filesToChange but no implementation\/documentation item owns it/);
  assert.match(bad([item('T1', { role: 'architecture', files: ['src/t1.ts'], criteria: ['AC1', 'AC2'] }), item('T2', { files: ['src/t2.ts'] })]), /analysis items are read-only and must list no files/);
  assert.match(bad([item('T1', { role: 'research', files: [], criteria: ['AC1', 'AC2'] })]), /"research" is not available yet/);
  assert.match(bad([item('T1', { role: 'verification', files: [], criteria: ['AC1', 'AC2'] })]), /done by Conductor itself/);
  assert.match(bad([item('T1', { role: 'wizard', criteria: ['AC1', 'AC2'] })]), /must be one of implementation/);
  assert.match(bad([item('T1', { role: 'architecture', files: [], criteria: ['AC1', 'AC2'] })], { filesToChange: [] }), /needs at least one implementation or documentation item/);
  assert.match(bad([item('T1', { files: [], criteria: ['AC1', 'AC2'] })]), /must list at least one file/);
  const many = Array.from({ length: GRAPH_MAX_ITEMS + 1 }, (_, i) => item(`T${i + 1}`, { criteria: i === 0 ? ['AC1', 'AC2'] : [] }));
  assert.match(bad(many), /at most 12 items/);
  assert.match(validateTaskGraph(plan(many.slice(0, 4)), { maxItems: 3 }).join('\n'), /at most 3 items/, 'a lower configured cap applies');
  assert.ok(!validateTaskGraph(plan(many.slice(0, 12))).join('').includes('at most'), '12 is allowed; the config can only LOWER it');
  for (const p of ['/etc/passwd', '../x', 'a//b', 'C:\\x', 'a/../b', '']) {
    const t = plan([item('T1', { criteria: ['AC1', 'AC2'], files: [p] })]);
    assert.ok(validateTaskGraph(t).length > 0, `path ${JSON.stringify(p)}`);
  }
  assert.match(bad([item('T1', { title: '', criteria: ['AC1', 'AC2'] })]), /title: required/);
  assert.match(bad([item('T1', { objective: ' ', criteria: ['AC1', 'AC2'] })]), /objective: required/);
  assert.match(bad([{ ...item('T1', { criteria: ['AC1', 'AC2'] }), dependsOn: 'T2' as any }]), /dependsOn: must be a list of strings/);
  const withNull = plan([item('T1', { criteria: ['AC1', 'AC2'] }), item('T2')]);
  withNull.taskGraph!.items[0] = null as any;
  assert.ok(validateTaskGraph(withNull).some((e) => /must be an object/.test(e)));
});

test('the schema accepts a graph and rejects a malformed one; topological order is stable; a cycle has none', () => {
  assert.deepEqual(validateSchema(PLAN_SCHEMA, good()), []);
  const broken: any = good();
  broken.taskGraph.items[0].files = 'src/a.ts';
  assert.ok(validateSchema(PLAN_SCHEMA, broken).length > 0);
  assert.deepEqual(topoOrder([{ id: 'T1', dependsOn: [] }, { id: 'T2', dependsOn: ['T1'] }, { id: 'T3', dependsOn: ['T1'] }, { id: 'T4', dependsOn: ['T2', 'T3'] }]), ['T1', 'T2', 'T3', 'T4']);
  assert.deepEqual(topoOrder([{ id: 'T2', dependsOn: ['T1'] }, { id: 'T1', dependsOn: [] }]), ['T1', 'T2'], 'declaration order does not matter');
  assert.equal(topoOrder([{ id: 'T1', dependsOn: ['T2'] }, { id: 'T2', dependsOn: ['T1'] }]), null);
  assert.equal(topoOrder([{ id: 'T1', dependsOn: ['T1'] }]), null);
});

test('readiness is DERIVED, blocked propagates to a fixed point and un-propagates when the failure is cleared', () => {
  const g = buildGraph(good(), 1, 1000, 3);
  assert.deepEqual(g.items.map((i) => i.state), ['pending', 'pending']);
  assert.deepEqual(readySet(g.items).map((i) => i.id), ['T1']);
  g.items[0]!.state = 'done';
  assert.deepEqual(readySet(g.items).map((i) => i.id), ['T2']);
  // a chain T1 → T2 → T3, T4 independent
  const chain = buildGraph(plan([item('T1', { criteria: ['AC1'] }), item('T2', { dependsOn: ['T1'], criteria: ['AC2'] }), item('T3', { dependsOn: ['T2'] }), item('T4')]), 1, 0, 3);
  chain.items[0]!.state = 'failed';
  assert.equal(propagateBlocked(chain.items), true);
  assert.deepEqual(chain.items.map((i) => i.state), ['failed', 'blocked', 'blocked', 'pending'], 'dependents blocked transitively, the independent item untouched');
  assert.deepEqual(readySet(chain.items).map((i) => i.id), ['T4'], 'independent items continue');
  assert.equal(propagateBlocked(chain.items), false, 'idempotent');
  chain.items[0]!.state = 'pending'; // Retry
  assert.equal(propagateBlocked(chain.items), true);
  assert.deepEqual(chain.items.map((i) => i.state), ['pending', 'pending', 'pending', 'pending'], 'blocked items return to pending');
  // running/done are never touched
  chain.items[1]!.state = 'running';
  chain.items[0]!.state = 'failed';
  propagateBlocked(chain.items);
  assert.equal(chain.items[1]!.state, 'running');
  assert.equal(isReady(chain.items[3]!, chain.items), true);
});

test('budgets scale with the amount of work and stop at hard ceilings; a graph-less run keeps today\'s numbers', () => {
  assert.deepEqual(graphBudgets(0, 10), { runsLimit: 10, iterationCap: 60 });
  assert.deepEqual(graphBudgets(1, 10), { runsLimit: 10, iterationCap: 60 });
  assert.deepEqual(graphBudgets(3, 10), { runsLimit: 28, iterationCap: 135 });
  assert.deepEqual(graphBudgets(12, 10), { runsLimit: 82, iterationCap: 360 });
  assert.equal(graphBudgets(12, 100).runsLimit, HARD_RUNS);
  assert.equal(graphBudgets(12, 5).iterationCap, 360);
  assert.ok(graphBudgets(500, 10_000).runsLimit <= HARD_RUNS && graphBudgets(500, 10_000).iterationCap <= HARD_ITERATIONS, 'no input lifts a ceiling');
});

test('item lanes are a projection of the item state (Conductor-owned)', () => {
  for (const [state, lane] of [['pending', 'todo'], ['running', 'active'], ['done', 'done'], ['failed', 'needs_you'], ['blocked', 'needs_you']] as const) assert.equal(projectItemLane({ state }), lane, state);
});

test('the crash-adoption marker is a per-attempt nonce: parse accepts only the exact line, a forged lookalike is not parsed', () => {
  const n = newNonce();
  assert.match(n, /^[0-9a-f]{16}$/);
  assert.notEqual(n, newNonce());
  const msg = `ENG-1: title — T2: step\n\nBuilt by Conductor (Cursor). Plan rev 1.\n${itemMarker('T2', n)}\n`;
  assert.deepEqual(parseItemMarker(msg), { itemId: 'T2', nonce: n });
  assert.equal(parseItemMarker('Conductor-Item: T2 nothex0000000000'), null);
  assert.equal(parseItemMarker('see Conductor-Item: T2 0123456789abcdef in text'), null, 'must be a whole line');
  assert.equal(parseItemMarker('Conductor-Item: T200 0123456789abcdef'), null);
});

test('strings from items are single-line, stripped of control and bidi/format characters and capped', () => {
  assert.equal(sanitizeLine('a\u202Eb\u0000c\nd\te', 50), 'a b c d e');
  assert.equal(sanitizeLine('x'.repeat(500), 20).length, 20);
  assert.equal(sanitizeLine(undefined, 5), '');
  const g = buildGraph(plan([item('T1', { title: 'Evil\u202E\nTitle', criteria: ['AC1', 'AC2'] })]), 1, 0, 3);
  assert.equal(g.items[0]!.title, 'Evil Title');
});

test('the approval screen shows the graph: planToMarkdown renders items, dependencies, files and criteria — and nothing for a graph-less plan', () => {
  const md = planToMarkdown(good());
  assert.match(md, /### Tasks\n\| Id \| Role \| Task \| Depends on \| Files \| Criteria \|/);
  assert.match(md, /\| T2 \| implementation \| Item T2 — Do T2 \| T1 \| `src\/t2\.ts` \| AC2 \|/);
  const plain = good();
  delete plain.taskGraph;
  assert.ok(!planToMarkdown(plain).includes('### Tasks'));
  assert.ok(!planToMarkdown(plan([item('T1', { criteria: ['AC1', 'AC2'] })])).includes('### Tasks'), 'a one-item graph renders no task table');
  const hostile = good();
  hostile.taskGraph!.items[0]!.title = 'a|b\u202E';
  assert.ok(!planToMarkdown(hostile).includes('\u202E'));
});

test('parallelGroup drops edges between peers and keeps deps outside the group; builds stay one ready item', () => {
  const items = [
    item('T1', { criteria: ['AC1'], parallelGroup: 'api' }),
    item('T2', { criteria: ['AC2'], dependsOn: ['T1'], parallelGroup: 'api' }),
    item('T3', { dependsOn: ['T2'], parallelGroup: 'later' }),
  ];
  const dropped = depsWithoutParallelPeers(items);
  assert.deepEqual(dropped.get('T1'), []);
  assert.deepEqual(dropped.get('T2'), [], 'same group does not wait');
  assert.deepEqual(dropped.get('T3'), ['T2'], 'a different group keeps the declared dep');
  const g = buildGraph(plan(items), 1, 0, 3);
  assert.deepEqual(g.items.map((i) => i.dependsOn), [[], [], ['T2']]);
  assert.deepEqual(readySet(g.items).map((i) => i.id), ['T1', 'T2'], 'peers are both ready');
});
