// Reviewer M3 code review: tests for rules that had no failing test (Retry resets, foreign-card guard, orphan cards, redaction).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers/harness.ts';
import { approvedPaused, cardsOf, graphPlan, item, manual, resume, two, writes } from './helpers/graphs.ts';

test('T-1/T-2: Retry gives a failed task a fresh budget and a fresh floor, and leaves finished tasks alone', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const plan = graphPlan([item('T1', { criteria: ['AC1'] }), item('T2', { dependsOn: ['T1'], criteria: ['AC2'] })]);
    const key = await approvedPaused(h, plan, { cursor: { 'ENG-1': { build: [writes('t1.mjs'), { error: 'boom' }, { error: 'boom' }] } } });
    await resume(h);
    assert.equal(h.run(key).status, 'needs_human');
    const done = h.run(key).graph!.items[0]!.commitSha;
    h.engine.setPaused(true);
    h.store.update(key, (r) => { r.graph!.items[1]!.loop = 3; r.graph!.items[1]!.floor = 'a'.repeat(40); });
    await h.engine.retry(key);
    const it = h.run(key).graph!.items;
    assert.deepEqual([it[1]!.state, it[1]!.loop, it[1]!.floor, it[1]!.note], ['pending', 1, undefined, undefined]);
    assert.equal(it[0]!.commitSha, done);
  } finally {
    await h.cleanup();
  }
});

test('T-4: a run.json key that points at someone else\'s card never moves it', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const other = h.issue('Somebody else', { lane: 'backlog' });
    const key = await approvedPaused(h, two());
    h.store.update(key, (r) => { r.graph!.items[0]!.key = other; r.graph!.items[0]!.state = 'running'; });
    await h.engine.tick();
    assert.equal(h.board.item(other)!.lane, 'backlog');
  } finally {
    await h.cleanup();
  }
});

test('m-1: moving to To do right after approval (before the cards exist) leaves no live orphan card', async () => {
  const h = await makeHarness({ config: manual });
  try {
    h.scenario({ claude: { '*': { plan: [{ json: two() }] } } });
    const key = h.issue('Add the greeting');
    await h.settle();
    h.engine.setPaused(true);
    h.engine.approve(key, 'human', h.run(key).rev);
    await h.engine.applyHumanMove(key, 'todo'); // re-plan before any tick created the cards
    await h.engine.tick();
    await h.engine.tick();
    assert.ok(cardsOf(h, key).every((c) => c.lane === 'canceled'), 'no card is left in To do');
    assert.equal(h.run(key).graph, undefined);
  } finally {
    await h.cleanup();
  }
});

test('T-5: token-shaped text in a task title is redacted in the run record and on its card', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const tok = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const plan = graphPlan([item('T1', { criteria: ['AC1'], title: `Use ${tok}` }), item('T2', { dependsOn: ['T1'], criteria: ['AC2'] })]);
    const key = await approvedPaused(h, plan);
    assert.ok(!JSON.stringify(h.run(key).graph).includes(tok));
    assert.ok(cardsOf(h, key).every((c) => !c.title.includes(tok) && !c.description.includes(tok)));
  } finally {
    await h.cleanup();
  }
});
