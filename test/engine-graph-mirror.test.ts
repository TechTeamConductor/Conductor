// M3 commit 2 — the task graph's data model and its board mirror: the graph is attached in the SAME update that approves the plan, one
// Conductor-owned subtask card per item is created idempotently (dependencies mapped to card ids), the cards' lanes are a level-triggered
// projection of the items, a re-plan supersedes the old cards, and a plan without a real graph is untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, type Harness } from './helpers/harness.ts';
import { comments } from './helpers/util.ts';
import { normalizeConfig, defaultConfig } from '../src/config.ts';
import { toDetail, toGraph, toSummary } from '../src/pipeline/view.ts';
import { itemsOf } from '../src/pipeline/graph.ts';

import { cardsOf, graphPlan, item, manual, two } from './helpers/graphs.ts';

/** Plan a graph, stop at the approval screen, approve it while the engine is paused (so nothing builds), and let the effects land. */
async function approvedWithCards(h: Harness, plan: object): Promise<string> {
  h.scenario({ claude: { '*': { plan: [{ json: plan }] } } });
  const key = h.issue('Add the greeting');
  await h.settle();
  assert.equal(h.run(key).status, 'awaiting_approval');
  h.engine.setPaused(true);
  h.engine.approve(key, 'human', h.run(key).rev);
  await h.engine.tick();
  return key;
}

test('a planned graph is shown on the approval screen but nothing exists on the board or in the run until the plan is approved', async () => {
  const h = await makeHarness({ config: manual });
  try {
    h.scenario({ claude: { '*': { plan: [{ json: two() }] } } });
    const key = h.issue('Add the greeting');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'awaiting_approval');
    assert.equal(run.graph, undefined);
    assert.equal(cardsOf(h, key).length, 0);
    const detail = toDetail(h.store, run, h.cfg, Date.now());
    assert.equal(detail.graph, null);
    assert.match(detail.planMarkdown ?? '', /### Tasks/);
    assert.equal(itemsOf(detail.plan!).length, 2);
  } finally {
    await h.cleanup();
  }
});

test('approval attaches the graph and creates one Conductor-owned subtask card per item, dependencies mapped to card ids', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const key = await approvedWithCards(h, two());
    const run = h.run(key);
    assert.equal(run.planApproved, true);
    assert.equal(run.graph?.rev, run.rev);
    assert.deepEqual(run.graph!.items.map((i) => [i.id, i.state, i.dependsOn]), [['T1', 'pending', []], ['T2', 'pending', ['T1']]]);
    assert.ok(run.graph!.items.every((i) => i.key), 'every item records its card key');
    const cards = cardsOf(h, key);
    assert.equal(cards.length, 2);
    assert.ok(cards.every((c) => c.kind === 'subtask' && c.createdBy === 'conductor' && c.lane === 'todo' && c.autoStart === false && c.parentId === h.board.item(key)!.id));
    const [c1, c2] = [h.board.item(run.graph!.items[0]!.key!)!, h.board.item(run.graph!.items[1]!.key!)!];
    assert.deepEqual(c1.dependsOn, []);
    assert.deepEqual(c2.dependsOn, [c1.id], 'T2 depends on the card of T1');
    assert.match(c1.title, /^T1 · Task T1$/);
    assert.match(c1.description ?? '', /\*\*Files:\*\* `t1\.mjs`/);
    assert.match(c2.description ?? '', /\*\*Depends on:\*\* T1/);
    assert.match(c2.description ?? '', /managed by Conductor/);
    assert.ok(run.history.some((x) => /Task graph attached: 2 tasks/.test(x.text)));
    assert.ok(Object.entries(run.effects).filter(([k]) => k.startsWith('subtask:')).every(([, e]) => e.status === 'done'));
    // the run does not claim the subtask cards as work of their own
    assert.equal(h.store.list().length, 1);
  } finally {
    await h.cleanup();
  }
});

test('API views: the summary carries progress, the detail carries items with a DERIVED ready state, and GET /api/items exposes the graph', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const key = await approvedWithCards(h, two());
    const run = h.run(key);
    const sum = toSummary(run, h.cfg, Date.now());
    assert.deepEqual(sum.taskProgress, { total: 2, done: 0, running: 0, failed: 0, blocked: 0 });
    const g = toGraph(run)!;
    assert.deepEqual(g.items.map((i) => [i.id, i.state]), [['T1', 'ready'], ['T2', 'pending']], 'ready is derived, never stored');
    assert.deepEqual(g.items[1]!.dependsOn, ['T1']);
    assert.equal(run.graph!.items[0]!.state, 'pending');
    const plain = toSummary({ ...run, graph: undefined }, h.cfg, Date.now());
    assert.equal(plain.taskProgress, undefined);
    assert.equal(toGraph({ ...run, graph: undefined }), null);
  } finally {
    await h.cleanup();
  }
});

test('the cards follow the items: a card a person moves is moved back; a human move through the dashboard is refused with a reason', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const key = await approvedWithCards(h, two());
    const run = h.run(key);
    const k1 = run.graph!.items[0]!.key!;
    // direct board move by the user is overwritten by the level-triggered projection
    h.board.user.moveLane(k1, 'done');
    assert.equal(h.board.item(k1)!.lane, 'done');
    await h.engine.tick();
    assert.equal(h.board.item(k1)!.lane, 'todo', 'the item is still pending, so the card is back in To do');
    // an item that is running shows as active, a failed or blocked one as "needs you", a done one as done
    h.store.update(key, (r) => {
      r.graph!.items[0]!.state = 'running';
      r.graph!.items[1]!.state = 'blocked';
    });
    await h.engine.tick();
    assert.equal(h.board.item(k1)!.lane, 'active');
    assert.equal(h.board.item(run.graph!.items[1]!.key!)!.lane, 'needs_you');
    h.store.update(key, (r) => {
      r.graph!.items[0]!.state = 'done';
      r.graph!.items[1]!.state = 'pending';
    });
    await h.engine.tick();
    assert.equal(h.board.item(k1)!.lane, 'done');
    // the dashboard route says why instead of silently reverting
    await assert.rejects(h.engine.applyHumanMove(k1, 'todo'), (e: any) => e.code === 'managed' && /follows its plan/.test(e.message));
  } finally {
    await h.cleanup();
  }
});

test('a card that no longer exists is never recreated and never makes the projection throw', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const key = await approvedWithCards(h, two());
    h.store.update(key, (r) => {
      r.graph!.items[0]!.key = 'ENG-999'; // a key that is not on the board (restored backup, hand-edited data)
    });
    await h.engine.tick();
    await h.engine.tick();
    assert.equal(cardsOf(h, key).length, 2, 'nothing was recreated');
    assert.equal(h.board.item('ENG-999'), undefined);
  } finally {
    await h.cleanup();
  }
});

test('replaying the card effects after a crash creates no duplicate cards', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const key = await approvedWithCards(h, two());
    const before = cardsOf(h, key).map((c) => c.id).sort();
    h.store.update(key, (r) => {
      for (const [k, e] of Object.entries(r.effects)) if (k.startsWith('subtask:')) e.status = 'pending'; // as if the "done" marks were never written
    });
    await h.engine.tick();
    assert.deepEqual(cardsOf(h, key).map((c) => c.id).sort(), before);
    assert.ok(Object.entries(h.run(key).effects).filter(([k]) => k.startsWith('subtask:')).every(([, e]) => e.status === 'done'));
  } finally {
    await h.cleanup();
  }
});

test('stopping the run cancels the cards of unfinished items; a re-plan supersedes every card with a note and discards the graph', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const key = await approvedWithCards(h, two());
    const run = h.run(key);
    const [k1, k2] = run.graph!.items.map((i) => i.key!);
    h.store.update(key, (r) => void (r.graph!.items[0]!.state = 'done'));
    await h.engine.applyHumanMove(key, 'canceled');
    await h.engine.tick();
    assert.equal(h.run(key).status, 'aborted');
    assert.equal(h.board.item(k1!)!.lane, 'done', 'finished work stays done');
    assert.equal(h.board.item(k2!)!.lane, 'canceled');
    h.scenario({ claude: { '*': { plan: [{ json: two() }] } } });
    await h.engine.retry(key);
    const after = h.run(key);
    assert.equal(after.rev, run.rev + 1);
    assert.equal(after.graph, undefined, 'a re-plan discards the graph');
    for (const k of [k1!, k2!]) {
      assert.equal(h.board.item(k)!.lane, 'canceled');
      assert.ok((await comments(h, k)).some((c) => /Superseded/.test(c)), `${k} says why`);
    }
    assert.equal(cardsOf(h, key).length, 2, 'the old cards are kept (canceled), not deleted');
    assert.ok(Object.entries(after.effects).filter(([k]) => k.startsWith('subtask-cancel:')).every(([, e]) => e.status === 'done'));
  } finally {
    await h.cleanup();
  }
});

test('a one-item graph is not a graph: nothing is attached and no card is created', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const key = await approvedWithCards(h, graphPlan([item('T1', { criteria: ['AC1', 'AC2'] })]));
    assert.equal(h.run(key).graph, undefined);
    assert.equal(cardsOf(h, key).length, 0);
  } finally {
    await h.cleanup();
  }
});

test('more than 8 tasks always waits for a person, even with automatic approval; 8 or fewer is automatic', async () => {
  const h = await makeHarness();
  try {
    const nine = graphPlan(Array.from({ length: 9 }, (_, i) => item(`T${i + 1}`, { criteria: i === 0 ? ['AC1', 'AC2'] : [] })));
    h.scenario({ claude: { '*': { plan: [{ json: nine }] } } });
    const k1 = h.issue('Big change');
    await h.settle();
    assert.equal(h.run(k1).status, 'awaiting_approval');
    assert.ok((await comments(h, k1)).some((c) => /9 tasks — more than 8/.test(c)));
    assert.equal(h.run(k1).graph, undefined, 'no graph before a person approves');
    const eight = graphPlan(Array.from({ length: 8 }, (_, i) => item(`T${i + 1}`, { criteria: i === 0 ? ['AC1', 'AC2'] : [] })));
    h.scenario({ claude: { '*': { plan: [{ json: eight }] } } });
    h.engine.setPaused(true);
    h.engine.setPaused(false);
    const k2 = h.issue('Medium change');
    await h.engine.tick();
    await h.engine.idle();
    assert.equal(h.run(k2).approvedBy, 'auto');
    assert.equal(h.run(k2).graph?.items.length, 8);
  } finally {
    await h.cleanup();
  }
});

test('config: the item ceiling can only be lowered (1–12), read-only parallelism is 1–4, per-item verification is opt-in', () => {
  const d = defaultConfig().pipeline;
  assert.deepEqual([d.maxItems, d.readOnlyParallel, d.verifyEachItem], [12, 2, false]);
  const n = (p: Record<string, unknown>) => normalizeConfig({ ...defaultConfig(), pipeline: { ...defaultConfig().pipeline, ...p } }).pipeline;
  assert.equal(n({ maxItems: 99 }).maxItems, 12);
  assert.equal(n({ maxItems: 0 }).maxItems, 1);
  assert.equal(n({ maxItems: 5 }).maxItems, 5);
  assert.equal(n({ maxItems: 'many' }).maxItems, 12);
  assert.equal(n({ readOnlyParallel: 9 }).readOnlyParallel, 4);
  assert.equal(n({ readOnlyParallel: 0 }).readOnlyParallel, 1);
  assert.equal(n({ verifyEachItem: 'yes' }).verifyEachItem, false);
  assert.equal(n({ verifyEachItem: true }).verifyEachItem, true);
});
