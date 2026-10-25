// Stuck resolver, end to end through the engine with fake agents (no network, no quota). Complete auto only.
// Covers: a resolved stop shows NO stuck card / comment / notification on every call path (stage loop, graph endWithProblems), the
// always-failing stub terminates, per-settings never resolves, crash recovery treats a marked run as stuck, old runs load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, type Harness } from './helpers/harness.ts';
import { comments } from './helpers/util.ts';
import { graphPlan, item, writes } from './helpers/graphs.ts';
import { RESOLVER_SCHEMA } from '../src/pipeline/schemas.ts';
import { validateSchema } from '../src/agents/json.ts';

const minor = { verdict: 'fail', summary: 'Style only.', acceptance: [], bugs: [{ title: 'Rename helper', severity: 'minor', file: 'feature.mjs', evidence: 'name is unclear' }] };
const pass = { verdict: 'pass' };
const reply = (a: Record<string, unknown>) => ({ raw: { analysis: 'The verify loop used its budget on a style note; one more round is enough.', ...a } });

const harness = (mode: 'complete-auto' | 'per-settings' = 'complete-auto', maxLoops = 3) =>
  makeHarness({ config: (c) => { (c.pipeline as any).runMode = mode; c.pipeline.maxLoops = maxLoops; } });
const resolverCalls = (h: Harness) => h.calls().filter((c) => c.who === 'claude' && c.stage === 'resolver');
const stuckComments = async (h: Harness, key: string) => (await comments(h, key)).filter((c) => /needs you/i.test(c));
const stuckNotes = (h: Harness) => h.notes.filter((n) => /needs you/i.test(n.title));

test('the reply used by these tests matches RESOLVER_SCHEMA', () => {
  assert.deepEqual(validateSchema(RESOLVER_SCHEMA, reply({ action: 'extend_budget', kind: 'loops' }).raw), []);
});

test('verify loop limit: the resolver extends the loop budget once, the card finishes, and NO stuck card, comment or notification ever appears', async () => {
  const h = await harness();
  try {
    h.scenario({ claude: { '*': { verify: [{ json: minor }, { json: minor }, { json: minor }, { json: pass }], resolver: [reply({ action: 'extend_budget', kind: 'loops' })] } } });
    const key = h.issue('Style thing');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready', run.needsHuman?.reason);
    assert.equal(run.resolverUsed, 1);
    assert.equal(run.resolverActive, undefined);
    assert.deepEqual(run.resolverExtended, { loops: 1 });
    assert.equal(run.loopBudget, 4);
    assert.equal(run.needsHuman, undefined);
    assert.equal(resolverCalls(h).length, 1);
    assert.deepEqual(await stuckComments(h, key), []);
    assert.deepEqual(stuckNotes(h), []);
    assert.ok(run.history.some((l) => l.text.startsWith('Resolver (loop_limit)')), JSON.stringify(run.history.map((l) => l.text)));
    assert.ok(!run.history.some((l) => l.text.startsWith('Needs you')));
    assert.ok(run.agentRuns >= 1 + 1 + 4 + 3, 'the resolver call is counted in agentRuns');
  } finally {
    await h.cleanup();
  }
});

test('resolver -> toNeedsHuman -> resolver with a stub that always retries: it stops at the round rule and the card parks with the analysis', async () => {
  const h = await harness();
  try {
    h.scenario({ claude: { '*': { verify: [{ json: minor }], resolver: [reply({ action: 'retry_stage', origin: 'verify' })] } } });
    const key = h.issue('Style thing');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'needs_human');
    assert.equal(run.needsHuman?.origin, 'verify');
    assert.equal(resolverCalls(h).length, 1, 'one invocation for (loop_limit, verify); the re-entry is refused');
    assert.equal(run.resolverUsed, 1);
    assert.equal(run.resolverActive, undefined);
    assert.equal((await stuckComments(h, key)).length, 1, 'a person is told once, when it really is stuck');
  } finally {
    await h.cleanup();
  }
});

test('a resolver that always fails (garbage replies, model errors): parks as before, bounded, with no marker left behind', async () => {
  for (const step of [{ raw: { note: 'not an action' } }, { error: 'boom' }, { raw: { analysis: 'x', action: 'push_to_main' } }]) {
    const h = await harness();
    try {
      h.scenario({ claude: { '*': { verify: [{ json: minor }], resolver: [step] } } });
      const key = h.issue('Style thing');
      await h.settle();
      const run = h.run(key);
      assert.equal(run.status, 'needs_human', JSON.stringify(step));
      assert.equal(run.resolverActive, undefined);
      assert.equal(run.resolverUsed, 1);
      assert.ok(resolverCalls(h).length <= 3, 'the call itself retries at most a couple of times');
      assert.equal(run.pushedAt, undefined);
      assert.equal((await stuckComments(h, key)).length, 1);
    } finally {
      await h.cleanup();
    }
  }
});

test('a give_up parks the card with the resolver analysis on the stuck comment', async () => {
  const h = await harness();
  try {
    h.scenario({ claude: { '*': { verify: [{ json: minor }], resolver: [reply({ action: 'give_up', reason: 'needs a person', analysis: 'The verifier keeps wanting a rename that conflicts with the plan.' })] } } });
    const key = h.issue('Style thing');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    const [c] = await stuckComments(h, key);
    assert.match(c!, /Resolver analysis:\*\* The verifier keeps wanting a rename/);
  } finally {
    await h.cleanup();
  }
});

test('per settings: the resolver never runs, the card parks exactly as before', async () => {
  const h = await harness('per-settings');
  try {
    h.scenario({ claude: { '*': { verify: [{ json: minor }], resolver: [reply({ action: 'extend_budget', kind: 'loops' })] } } });
    const key = h.issue('Style thing');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'needs_human');
    assert.equal(resolverCalls(h).length, 0);
    assert.equal(run.resolverUsed, undefined);
    assert.equal(run.resolverActive, undefined);
  } finally {
    await h.cleanup();
  }
});

test('graph build, endWithProblems path: a failed task is retried by the resolver, the graph builder stops after toNeedsHuman returns, and no stuck card appears', async () => {
  const h = await harness();
  try {
    const plan = graphPlan([item('T1', { criteria: ['AC1'] }), item('T2', { dependsOn: ['T1'], criteria: ['AC2'] }), item('T3'), item('T4', { dependsOn: ['T2'] })]);
    h.scenario({
      claude: { '*': { plan: [{ json: plan }], resolver: [reply({ action: 'retry_stage', origin: 'build', analysis: 'T2 failed on a transient builder error; running the failed and blocked tasks again.' })] } },
      cursor: { 'ENG-1': { build: [writes('t1.mjs'), writes('t3.mjs'), { error: 'boom' }, { error: 'boom' }, writes('t2.mjs'), writes('t4.mjs')] } },
    });
    const key = h.issue('Add the greeting');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready', run.needsHuman?.reason);
    assert.deepEqual(run.graph!.items.map((i) => i.state), ['done', 'done', 'done', 'done']);
    assert.equal(run.resolverUsed, 1);
    assert.equal(resolverCalls(h).length, 1);
    assert.deepEqual(await stuckComments(h, key), []);
    assert.deepEqual(stuckNotes(h), []);
    assert.ok(run.history.some((l) => l.text.startsWith('Resolver (graph_failed)')));
    const builds = h.calls().filter((c) => c.who === 'cursor' && c.stage === 'build');
    assert.equal(builds.length, 6, 'T1, T3, T2 x2, then T2 and T4 once each');
  } finally {
    await h.cleanup();
  }
});

test('an empty build (stage `nothing` path): the resolver can send the builder back and the card finishes without a stuck card', async () => {
  const h = await makeHarness({ gates: false, config: (c) => { (c.pipeline as any).runMode = 'complete-auto'; } });
  try {
    // two empty attempts exhaust the built-in empty-attempt heal; the resolver gets the third look
    h.scenario({
      cursor: { '*': { build: [{ files: {} }, { files: {} }, {}] } },
      claude: { '*': { resolver: [reply({ action: 'retry_stage', origin: 'build', analysis: 'The builder changed nothing twice; one more attempt.' })] } },
    });
    const key = h.issue('Add the feature');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready', run.needsHuman?.reason);
    assert.equal(run.resolverUsed, 1);
    assert.deepEqual(await stuckComments(h, key), []);
  } finally {
    await h.cleanup();
  }
});

test('non-resolvable stops (restart guard, no repository) skip the resolver and park', async () => {
  const h = await harness();
  try {
    h.scenario({ claude: { '*': { resolver: [reply({ action: 'retry_stage', origin: 'build' })] } } });
    const key = h.issue('Anything');
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
    const stages = (h.engine as any).stages;
    h.store.update(key, (r) => void ((r.status = 'running'), (r.restartTimes = [Date.now(), Date.now(), Date.now(), Date.now(), Date.now()])));
    await stages.toNeedsHuman(key, 'This run was restarted 5 times within an hour, so Conductor is pausing it.', 'build', undefined, 'restart_guard');
    assert.equal(h.run(key).status, 'needs_human');
    assert.equal(h.run(key).resolverUsed, undefined);
    assert.equal(resolverCalls(h).length, 0);
  } finally {
    await h.cleanup();
  }
});

test('a person-parked run is never touched by the resolver', async () => {
  const h = await harness();
  try {
    h.scenario({ claude: { '*': { resolver: [reply({ action: 'retry_stage', origin: 'build' })] } } });
    const key = h.issue('Anything');
    await h.settle();
    h.store.update(key, (r) => void ((r.status = 'parked'), (r.parkedFrom = 'ready'), (r.next = 'none')));
    const before = JSON.stringify(h.run(key));
    const out = await (await import('../src/pipeline/resolver.ts')).resolve(
      { ...(h.engine as any).stages.resolverHost() },
      key,
      { reason: 'anything', origin: 'build', cause: 'other' },
    );
    assert.equal(out.kind, 'skipped');
    assert.equal(JSON.stringify(h.run(key)), before);
    assert.equal(resolverCalls(h).length, 0);
  } finally {
    await h.cleanup();
  }
});

test('crash recovery: a run found with the resolver marker is treated as stuck; the marker is cleared and the resolver does not run again', async () => {
  const h = await harness();
  try {
    h.scenario({ claude: { '*': { resolver: [reply({ action: 'retry_stage', origin: 'build' })] } } });
    const key = h.issue('Anything');
    await h.settle();
    h.store.update(key, (r) => {
      r.status = 'running';
      r.next = 'build';
      r.resolverUsed = 1;
      r.resolverActive = { at: Date.now(), round: 1, origin: 'build', cause: 'other' };
    });
    h.engine.recover();
    const run = h.run(key);
    assert.equal(run.status, 'needs_human', 'parked synchronously, before any tick can re-queue it');
    assert.equal(run.resolverActive, undefined);
    assert.equal(run.resolverUsed, 1, 'the counter was already spent');
    assert.equal(run.needsHuman?.origin, 'build');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.equal(resolverCalls(h).length, 0);
    assert.equal((await stuckComments(h, key)).length, 1);
  } finally {
    await h.cleanup();
  }
});

test('a human restart gives the card a fresh resolver budget (give_up is terminal only until a person acts)', async () => {
  const h = await harness();
  try {
    h.scenario({ claude: { '*': { verify: [{ json: minor }], resolver: [reply({ action: 'give_up', reason: 'x' })] } } });
    const key = h.issue('Style thing');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.equal(h.run(key).resolverUsed, 1);
    await h.engine.retry(key);
    assert.equal(h.run(key).resolverUsed, 0);
    assert.equal(h.run(key).resolverRounds, undefined);
  } finally {
    await h.cleanup();
  }
});
