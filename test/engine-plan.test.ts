import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness } from './helpers/harness.ts';
import { comments, labelNames } from './helpers/util.ts';

test('blocked plan → needs_human with the questions; viewer comment + Todo → re-plan includes the comment', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ claude: { '*': { plan: [{ json: { blocked: { is: true, questions: ['Which database should this use?'] } } }, {}] } } });
    const key = h.issue('Add storage');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.ok((await comments(h, key)).some((c) => c.includes('Which database should this use?')));
    h.linear.humanComment(h.linear.issueByKey(key).id, 'Use SQLite please.');
    h.linear.humanMove(h.linear.issueByKey(key).id, 'Todo');
    h.scenario({ claude: { '*': { plan: [{ savePrompt: true }] } } });
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
    assert.equal(h.run(key).rev, 2);
    const saved = readFileSync(join(h.fakeDir, `prompt-claude-${key}-plan-1.txt`), 'utf8');
    assert.ok(saved.includes('Use SQLite please.'), 'viewer clarification reaches the prompt');
    assert.ok(saved.includes('<untrusted'), 'task text is fenced as untrusted');
    assert.ok(saved.includes('Conductor pipeline mode'), 'preamble present');
  } finally {
    await h.cleanup();
  }
});

test('first plan per repo waits for /approve; the next plan is automatic', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.planApproval = 'first') });
  try {
    const k1 = h.issue('First feature');
    await h.settle();
    assert.equal(h.run(k1).status, 'awaiting_approval');
    assert.ok(labelNames(h, k1).includes('conductor:plan-ready'));
    assert.ok((await comments(h, k1)).some((c) => c.includes('your approval is needed')));
    h.linear.humanComment(h.linear.issueByKey(k1).id, '/approve');
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

test('dashboard approve works; teammate "/approve" does not', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.planApproval = 'manual') });
  try {
    const k = h.issue('Manual one');
    await h.settle();
    assert.equal(h.run(k).status, 'awaiting_approval');
    h.linear.humanComment(h.linear.issueByKey(k).id, '/approve', h.linear.otherUserId);
    await h.settle();
    assert.equal(h.run(k).status, 'awaiting_approval', 'teammate approval ignored');
    h.engine.approve(k, 'human');
    await h.settle();
    assert.equal(h.run(k).status, 'ready');
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
