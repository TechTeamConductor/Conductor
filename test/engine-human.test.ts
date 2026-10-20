import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeHarness } from './helpers/harness.ts';
import { comments, laneOf, stageOf } from './helpers/util.ts';

test('move to Backlog parks (no reset, no requeue); To do later re-plans keeping a backup ref', async () => {
  const h = await makeHarness();
  try {
    const key = h.issue('Park me');
    await h.settle();
    const run1 = h.run(key);
    assert.equal(run1.status, 'ready');
    const head = git(run1.worktree, 'rev-parse', 'HEAD');
    await h.engine.applyHumanMove(key, 'backlog');
    await h.settle();
    assert.equal(h.run(key).status, 'parked');
    assert.equal(laneOf(h, key), 'backlog', 'the card follows the run');
    assert.equal(git(run1.worktree, 'rev-parse', 'HEAD'), head, 'parking never touches committed work');
    assert.ok(existsSync(join(run1.worktree, `feature-${key.toLowerCase()}.mjs`)));
    const callsBefore = h.calls().length;
    await h.settle();
    assert.equal(h.calls().length, callsBefore, 'nothing runs while parked');
    // back to To do → rework: plan rev 2; commits kept
    await h.engine.applyHumanMove(key, 'todo');
    await h.settle();
    const run2 = h.run(key);
    assert.equal(run2.status, 'ready');
    assert.equal(run2.rev, 2);
    assert.ok(git(run2.worktree, 'rev-list', '--count', `${run2.baseSha}..HEAD`) >= '1');
  } finally {
    await h.cleanup();
  }
});

test('re-run from To do while work is mid-flight: backup ref is written before the reset', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.planApproval = 'manual') });
  try {
    const key = h.issue('Re-run me');
    await h.settle();
    assert.equal(h.run(key).status, 'awaiting_approval');
    h.engine.approve(key, 'human');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    // human wants a completely fresh attempt: status ready + To do ⇒ rework (keeps commits) — verify backup ref exists
    await h.engine.applyHumanMove(key, 'todo');
    await h.settle();
    const refs = git(run.worktree, 'for-each-ref', '--format=%(refname)', `refs/conductor/${key}/`);
    assert.ok(refs.includes(`prev-${run.rev}`), `backup ref present: ${refs}`);
  } finally {
    await h.cleanup();
  }
});

test('moving a card to Canceled stops the run; Done finishes it; both cards follow the run', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.planApproval = 'manual') });
  try {
    const k1 = h.issue('Cancel me');
    const k2 = h.issue('Finish me');
    await h.settle();
    await h.engine.applyHumanMove(k1, 'canceled');
    await h.engine.applyHumanMove(k2, 'done');
    assert.equal(h.run(k1).status, 'aborted');
    assert.equal(h.run(k2).status, 'finished');
    await h.settle();
    assert.equal(laneOf(h, k1), 'canceled');
    assert.equal(laneOf(h, k2), 'done');
    await assert.rejects(() => h.engine.applyHumanMove(k1, 'done'), /canceled/);
    await assert.rejects(() => h.engine.applyHumanMove(k2, 'canceled'), /already done/);
    await assert.rejects(() => h.engine.applyHumanMove(k2, 'review'), /Conductor owns/, 'humans cannot set Conductor-owned lanes');
  } finally {
    await h.cleanup();
  }
});

test('a running agent is killed when the card is cancelled (process group abort)', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ claude: { '*': { plan: [{ delayMs: 20, hang: true }] } } });
    const key = h.issue('Hangs forever');
    await h.engine.tick(); // claims + starts the plan job (agent hangs)
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(h.run(key).status, 'running');
    const t0 = Date.now();
    await h.engine.applyHumanMove(key, 'canceled'); // stops the job
    await h.engine.idle();
    assert.ok(Date.now() - t0 < 15_000, 'did not wait for the 120s hang');
    assert.equal(h.run(key).status, 'aborted');
  } finally {
    await h.cleanup();
  }
});

test('dashboard abort + retry', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.planApproval = 'manual') });
  try {
    const key = h.issue('Abort then retry');
    await h.settle();
    await h.engine.abort(key);
    assert.equal(h.run(key).status, 'aborted');
    assert.ok((await comments(h, key)).some((c) => c.includes('stopped')));
    await h.engine.retry(key);
    await h.settle();
    assert.equal(h.run(key).status, 'awaiting_approval');
    assert.equal(stageOf(h, key), 'plan_ready');
    assert.equal(laneOf(h, key), 'needs_you');
  } finally {
    await h.cleanup();
  }
});

test('description edited by the user mid-run halts at the next stage boundary', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.planApproval = 'manual') });
  try {
    const key = h.issue('Edit me');
    await h.settle();
    assert.equal(h.run(key).status, 'awaiting_approval');
    h.board.user.setFields(key, { description: 'Actually do something else' });
    h.engine.approve(key, 'human');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'needs_human');
    assert.ok(/description changed/i.test(run.needsHuman?.reason ?? ''));
    // re-plan from To do snapshots the new description
    await h.engine.applyHumanMove(key, 'todo');
    await h.settle();
    assert.equal(h.run(key).rev, 2, 'To do after a description change RE-PLANS (rev 2), it does not just retry the build');
    assert.ok(['awaiting_approval', 'ready'].includes(h.run(key).status));
    assert.equal(h.run(key).description, 'Actually do something else');
  } finally {
    await h.cleanup();
  }
});
