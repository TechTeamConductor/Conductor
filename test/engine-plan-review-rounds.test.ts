// R2-8: plan review may request changes up to pipeline.planReviewRounds times (default 3); exhausted rounds proceed with "concerns noted".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers/harness.ts';
import { comments } from './helpers/util.ts';

const changes = (n: number) => ({ json: { decision: 'changes_requested', summary: `Round ${n}.`, issues: [{ severity: 'blocking', text: `Fix point ${n}.` }] } });

test('plan review: three revision rounds by default, then it proceeds with concerns noted (not the resolver)', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.planReview = 'always') });
  try {
    h.scenario({ claude: { '*': { plan_review: [changes(1), changes(2), changes(3), changes(4)] } } });
    const key = h.issue('Reviewed feature');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready', run.needsHuman?.reason);
    assert.equal(run.planReviewRounds, 3);
    assert.equal(run.rev, 4);
    assert.equal(h.calls().filter((c) => c.who === 'claude' && c.stage === 'plan').length, 4);
    assert.equal(h.calls().filter((c) => c.stage === 'plan_review').length, 4);
    assert.ok((await comments(h, key)).some((c) => c.includes('concerns noted')));
  } finally {
    await h.cleanup();
  }
});

test('plan review: planReviewRounds=1 keeps the old single revision', async () => {
  const h = await makeHarness({ config: (c) => { c.pipeline.planReview = 'always'; (c.pipeline as any).planReviewRounds = 1; } });
  try {
    h.scenario({ claude: { '*': { plan_review: [changes(1), changes(2)] } } });
    const key = h.issue('Reviewed feature');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.planReviewRounds, 1);
    assert.equal(h.calls().filter((c) => c.who === 'claude' && c.stage === 'plan').length, 2);
  } finally {
    await h.cleanup();
  }
});
