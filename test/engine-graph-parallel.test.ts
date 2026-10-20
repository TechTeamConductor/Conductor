// M3 commit 4 — analysis items run concurrently (read-only, bounded by ONE engine-owned cap shared by every run); build items are strictly
// exclusive within their run; when concurrent calls raise a hold the run settles them all and makes ONE transition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, type Harness } from './helpers/harness.ts';
import { graphPlan, item, manual, writes } from './helpers/graphs.ts';
import { Semaphore } from '../src/pipeline/semaphore.ts';

const ANALYSIS = new Set(['requirements', 'architecture', 'context']);
const plan = () =>
  graphPlan([
    item('T1', { role: 'architecture', files: [], criteria: ['AC1'] }),
    item('T2', { role: 'requirements', files: [], criteria: ['AC2'] }),
    item('T3', { dependsOn: ['T1', 'T2'], files: ['t3.mjs'] }),
  ]);

/** Count how many analysis calls are in flight at once (the router is the only place read-only calls start). */
function watchAnalysis(h: Harness): { max: () => number; calls: () => number } {
  let active = 0;
  let max = 0;
  let calls = 0;
  const orig = h.agents.readOnly.bind(h.agents);
  (h.agents as any).readOnly = async (o: any) => {
    const mine = ANALYSIS.has(o.role);
    if (mine) {
      calls++;
      active++;
      max = Math.max(max, active);
    }
    try {
      return await orig(o);
    } finally {
      if (mine) active--;
    }
  };
  return { max: () => max, calls: () => calls };
}
async function approveAll(h: Harness, keys: string[]): Promise<void> {
  h.engine.setPaused(true);
  for (const k of keys) h.engine.approve(k, 'human', h.run(k).rev);
  await h.engine.tick();
  h.engine.setPaused(false);
  await h.settle();
}
const slow = { delayMs: 500 };

test('M3-AC6: the two analysis items of one run overlap; the build task starts only after both are done and overlaps nothing', async () => {
  const h = await makeHarness({ config: (c) => { manual(c); c.pipeline.readOnlyParallel = 2; } });
  try {
    const watch = watchAnalysis(h);
    h.scenario({ claude: { '*': { plan: [{ json: plan() }], analysis: [slow, slow] } }, cursor: { 'ENG-1': { build: [writes('t3.mjs')] } } });
    const key = h.issue('One run');
    await h.settle();
    await approveAll(h, [key]);
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.equal(watch.max(), 2, 'both analysis items were in flight together');
    assert.equal(watch.calls(), 2);
    const sess = run.sessions.filter((s) => s.stage === 'plan' && s.loop === 1).slice(1); // after the plan session itself
    const build = run.sessions.find((s) => s.stage === 'build')!;
    for (const s of run.sessions.filter((x) => x !== build)) {
      assert.ok((s.endedAt ?? 0) <= build.startedAt || s.startedAt >= (build.endedAt ?? Infinity), `the builder session never overlaps another session (${s.stage})`);
    }
    assert.ok(sess.length >= 2);
  } finally {
    await h.cleanup();
  }
});

test('M3-AC6 / M3-6: ONE cap is shared by every run — two runs × two analysis items never exceed it, and a cap of 1 serialises them', async () => {
  for (const cap of [1, 2]) {
    const h = await makeHarness({ config: (c) => { manual(c); c.pipeline.readOnlyParallel = cap; c.pipeline.maxParallel = 2; } });
    try {
      const watch = watchAnalysis(h);
      h.scenario({ claude: { '*': { plan: [{ json: plan() }], analysis: [slow, slow] } }, cursor: { '*': { build: [writes('t3.mjs')] } } });
      const k1 = h.issue('First run');
      await h.settle();
      const k2 = h.issue('Second run');
      await h.settle();
      await approveAll(h, [k1, k2]);
      assert.equal(h.run(k1).status, 'ready');
      assert.equal(h.run(k2).status, 'ready');
      assert.equal(watch.calls(), 4, 'all four analysis items ran');
      assert.equal(watch.max(), cap, `never more than ${cap} analysis call(s) at once across both runs, and the cap was actually used`);
    } finally {
      await h.cleanup();
    }
  }
});

test('M3-4: when concurrent analysis calls raise a hold, the run waits for all of them and makes ONE transition; only the limited item goes back to waiting', async () => {
  const h = await makeHarness({ config: (c) => { manual(c); c.pipeline.readOnlyParallel = 2; } });
  try {
    h.scenario({ claude: { '*': { plan: [{ json: plan() }], analysis: [{ limit: {} }, slow, slow] } }, cursor: { 'ENG-1': { build: [writes('t3.mjs')] } } });
    const key = h.issue('Limited');
    await h.settle();
    await approveAll(h, [key]);
    let run = h.run(key);
    assert.equal(run.status, 'paused');
    const states = run.graph!.items.slice(0, 2).map((i) => i.state).sort();
    assert.deepEqual(states, ['done', 'pending'], 'the item that finished keeps its result; the limited one waits');
    assert.equal(run.history.filter((x) => /Paused: .* usage limit/.test(x.text)).length, 1, 'one pause, not one per call');
    assert.equal(run.agentRuns, 2, 'the plan + the analysis that finished; the limit-rejected attempt was refunded');
    h.engine.resume(key);
    await h.settle();
    run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.deepEqual(run.graph!.items.map((i) => i.state), ['done', 'done', 'done']);
  } finally {
    await h.cleanup();
  }
});

test('M3-4: a person-needed hold wins over a usage-limit pause in the same wave — one needs-you, no pause, both items wait; Retry then finishes the graph', async () => {
  const h = await makeHarness({ config: (c) => { manual(c); c.pipeline.readOnlyParallel = 2; } });
  try {
    const bad = { raw: { nonsense: true } };
    h.scenario({ claude: { '*': { plan: [{ json: plan() }], analysis: [{ limit: {} }, bad, bad, {}, {}] } }, cursor: { 'ENG-1': { build: [writes('t3.mjs')] } } });
    const key = h.issue('Mixed holds');
    await h.settle();
    await approveAll(h, [key]);
    let run = h.run(key);
    assert.equal(run.status, 'needs_human');
    assert.match(run.needsHuman!.reason, /kept failing validation/);
    assert.equal(run.history.filter((x) => /Paused:/.test(x.text)).length, 0, 'no pause was recorded');
    assert.deepEqual(run.graph!.items.slice(0, 2).map((i) => i.state), ['pending', 'pending']);
    await h.engine.retry(key);
    await h.settle();
    run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.deepEqual(run.graph!.items.map((i) => i.state), ['done', 'done', 'done']);
  } finally {
    await h.cleanup();
  }
});

test('Semaphore: bounded, FIFO, releases once, honours a changing limit and an aborted waiter', async () => {
  let limit = 2;
  const s = new Semaphore(() => limit);
  const r1 = (await s.acquire())!;
  const r2 = (await s.acquire())!;
  assert.equal(s.inUse, 2);
  const order: string[] = [];
  const w1 = s.acquire().then((r) => (order.push('w1'), r!));
  const w2 = s.acquire().then((r) => (order.push('w2'), r!));
  const ac = new AbortController();
  const w3 = s.acquire(ac.signal);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, []);
  ac.abort();
  assert.equal(await w3, null, 'an aborted waiter gives up without taking a slot');
  r1();
  r1(); // a second release of the same slot is a no-op
  assert.equal(s.inUse, 1);
  const x1 = await w1;
  assert.deepEqual(order, ['w1']);
  assert.equal(s.inUse, 2);
  r2();
  const x2 = await w2;
  assert.deepEqual(order, ['w1', 'w2']);
  limit = 1;
  x1();
  x2();
  assert.equal(s.inUse, 0);
  const a = (await s.acquire())!;
  let got = false;
  const b = s.acquire().then((r) => ((got = true), r!));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got, false, 'a lowered limit applies to new acquisitions');
  a();
  (await b)();
});
