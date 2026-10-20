import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers/harness.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { comments, laneOf, stageOf } from './helpers/util.ts';

const bug = { title: 'Feature returns wrong value for 0', severity: 'major', file: 'feature.mjs', line: 1, evidence: 'feature() ignores input', repro: 'feature(0)', suggestedFix: 'handle 0' };

test('verifier fails → bug child card (never claimed as a task) → fix loop → pass → child closed', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ cursor: { '*': { build: [{ savePrompt: true }, { savePrompt: true }] } }, claude: { '*': { verify: [{ json: { verdict: 'fail', summary: 'One real problem.', bugs: [bug] } }, { json: { verdict: 'pass' } }] } } });
    const key = h.issue('Add the answer feature');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.equal(run.loop, 2, 'one fix loop');
    assert.equal(run.bugs.length, 1);
    assert.equal(run.bugs[0]!.status, 'closed');
    // the bug child exists, is a child card of kind 'bug' (never claimable), and is now done
    const kids = h.board.children(h.board.item(key)!.id);
    assert.equal(kids.length, 1);
    assert.ok(kids[0]!.title.startsWith('[Bug]'));
    assert.equal(kids[0]!.kind, 'bug');
    assert.equal(kids[0]!.createdBy, 'conductor');
    assert.equal(kids[0]!.lane, 'done');
    assert.equal(h.board.claimable().length, 0, 'a bug child is never a task'); 
    // fix prompt reached the builder with the finding; the second build used the fix template
    const calls = h.calls().filter((c) => c.who === 'cursor' && c.stage === 'build');
    assert.equal(calls.length, 2);
    const fixPrompt = readFileSync(join(h.fakeDir, `prompt-cursor-${key}-build-1.txt`), 'utf8');
    assert.match(fixPrompt, /# Stage: FIX/, 'the second build uses the fix template');
    assert.ok(fixPrompt.includes('Feature returns wrong value for 0') && fixPrompt.includes('feature(0)'), 'the verifier finding reaches the builder');
    assert.ok(fixPrompt.includes('One real problem') || fixPrompt.includes('Verifier'), 'the verifier summary is included');
    const cs = await comments(h, key);
    assert.ok(cs.some((c) => c.includes('Verification failed (loop 1')));
    assert.equal(laneOf(h, key), 'review');
    assert.equal(stageOf(h, key), 'ready');
    // the engine must not have treated its own bug card as a new task
    assert.equal(h.store.list().length, 1);
  } finally {
    await h.cleanup();
  }
});

test('loop cap → needs_human with evidence; To do retries verify with extra budget', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.maxLoops = 2) });
  try {
    h.scenario({ claude: { '*': { verify: [{ json: { verdict: 'fail', summary: 'Still broken.', bugs: [bug] } }] } } });
    const key = h.issue('Add the answer feature');
    await h.settle();
    let run = h.run(key);
    assert.equal(run.status, 'needs_human');
    assert.equal(run.needsHuman?.origin, 'verify');
    assert.equal(run.loop, 2);
    assert.equal(stageOf(h, key), 'needs_human');
    assert.equal(laneOf(h, key), 'needs_you');
    assert.ok((await comments(h, key)).some((c) => c.includes('needs you')));
    // only one bug card despite two failing loops (fingerprint dedupe)
    assert.equal(h.board.children(h.board.item(key)!.id).length, 1);
    // human fixes the scenario and moves it back to To do → retries verification with a fresh budget
    h.scenario({ claude: { '*': { verify: [{ json: { verdict: 'pass' } }] } } });
    await h.engine.applyHumanMove(key, 'todo');
    await h.settle();
    run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.equal(run.loopBudget, 4);
  } finally {
    await h.cleanup();
  }
});

test('gate regression overrides a "pass" verdict and becomes a bug', async () => {
  const h = await makeHarness();
  try {
    // builder writes a failing test on the first build; the verifier (wrongly) says pass
    h.scenario({
      cursor: { '*': { build: [
        { files: { 'feature-x.mjs': 'export const f = 1;\n', 'feature-x.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('broken', () => assert.equal(1, 2));\n" } },
        { files: { 'feature-x.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fixed', () => assert.equal(1, 1));\n" } },
      ] } },
      claude: { '*': { verify: [{ json: { verdict: 'pass' } }] } },
    });
    const key = h.issue('Break a test');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.equal(run.loop, 2, 'the regression forced a fix loop');
    assert.ok(run.bugs.some((b) => b.title.startsWith('Quality gate regression')));
  } finally {
    await h.cleanup();
  }
});
