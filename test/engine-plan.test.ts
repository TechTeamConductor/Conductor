import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness } from './helpers/harness.ts';
import { comments, laneOf, stageOf } from './helpers/util.ts';

test('blocked plan → needs_human with the questions; user comment + To do → re-plan includes the comment', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ claude: { '*': { plan: [{ json: { blocked: { is: true, questions: ['Which database should this use?'] } } }, {}] } } });
    const key = h.issue('Add storage');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.ok((await comments(h, key)).some((c) => c.includes('Which database should this use?')));
    h.board.user.comment(key, 'Use SQLite please.');
    await h.engine.applyHumanMove(key, 'todo');
    h.scenario({ claude: { '*': { plan: [{ savePrompt: true }] } } });
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
    assert.equal(h.run(key).rev, 2);
    const saved = readFileSync(join(h.fakeDir, `prompt-claude-${key}-plan-1.txt`), 'utf8');
    assert.ok(saved.includes('Use SQLite please.'), 'the user clarification reaches the prompt');
    assert.ok(saved.includes('<untrusted'), 'task text is fenced as untrusted');
    assert.ok(saved.includes('Conductor pipeline mode'), 'preamble present');
  } finally {
    await h.cleanup();
  }
});

test('first plan per repo waits for approval; the next plan is automatic', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.planApproval = 'first') });
  try {
    const k1 = h.issue('First feature');
    await h.settle();
    assert.equal(h.run(k1).status, 'awaiting_approval');
    assert.equal(stageOf(h, k1), 'plan_ready');
    assert.equal(laneOf(h, k1), 'needs_you');
    assert.ok((await comments(h, k1)).some((c) => c.includes('your approval is needed')));
    h.engine.approve(k1, 'human', h.run(k1).rev);
    await h.settle();
    assert.equal(h.run(k1).status, 'ready');
    const k2 = h.issue('Second feature');
    await h.settle();
    assert.equal(h.run(k2).status, 'ready', 'no approval needed the second time');
    assert.equal(h.run(k2).approvedBy, 'auto');
  } finally {
    await h.cleanup();
  }
});

test('approve works only while awaiting approval and only for the current plan revision', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.planApproval = 'manual') });
  try {
    const k = h.issue('Manual one');
    await h.settle();
    assert.equal(h.run(k).status, 'awaiting_approval');
    // a comment that merely says /approve changes nothing (approval is a button, not text)
    h.board.user.comment(k, '/approve');
    await h.settle();
    assert.equal(h.run(k).status, 'awaiting_approval', 'text never approves');
    assert.throws(() => h.engine.approve(k, 'human', h.run(k).rev + 1), /replaced by a newer revision/, 'a stale revision is refused');
    h.engine.approve(k, 'human', h.run(k).rev);
    await h.settle();
    assert.equal(h.run(k).status, 'ready');
    assert.throws(() => h.engine.approve(k, 'human', h.run(k).rev), /not waiting for approval/, 'a second approval is refused');
  } finally {
    await h.cleanup();
  }
});

test('plan review requesting changes triggers exactly one revision', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.planReview = 'always') });
  try {
    h.scenario({ claude: { '*': { plan_review: [{ json: { decision: 'changes_requested', summary: 'Missing a test.', issues: [{ severity: 'blocking', text: 'Add a negative test.' }] } }, { json: { decision: 'approved' } }] } } });
    const key = h.issue('Reviewed feature');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.equal(run.rev, 2);
    assert.equal(run.planReviewRounds, 1);
    const plans = h.calls().filter((c) => c.who === 'claude' && c.stage === 'plan');
    assert.equal(plans.length, 2);
  } finally {
    await h.cleanup();
  }
});
