import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers/harness.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { comments, labelNames } from './helpers/util.ts';

const bug = { title: 'Feature returns wrong value for 0', severity: 'major', file: 'feature.mjs', line: 1, evidence: 'feature() ignores input', repro: 'feature(0)', suggestedFix: 'handle 0' };

test('verifier fails → bug sub-issue (never trigger-labelled) → fix loop → pass → sub-issue closed', async () => {
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
    // sub-issue exists, is a child, carries the bug label and NOT the trigger label, and is now completed
    const kids = await h.linear.children(h.linear.issueByKey(key).id);
    assert.equal(kids.length, 1);
    assert.ok(kids[0]!.title.startsWith('[Bug]'));
    assert.ok(kids[0]!.labels.some((l) => l.name === 'conductor-bug'));
    assert.ok(!kids[0]!.labels.some((l) => l.name === 'conductor'));
    assert.equal(kids[0]!.state.type, 'completed');
    // fix prompt reached the builder with the finding; the second build used the fix template
    const calls = h.calls().filter((c) => c.who === 'cursor' && c.stage === 'build');
    assert.equal(calls.length, 2);
    const fixPrompt = readFileSync(join(h.fakeDir, `prompt-cursor-${key}-build-1.txt`), 'utf8');
    assert.match(fixPrompt, /# Stage: FIX/, 'the second build uses the fix template');
    assert.ok(fixPrompt.includes('Feature returns wrong value for 0') && fixPrompt.includes('feature(0)'), 'the verifier finding reaches the builder');
    assert.ok(fixPrompt.includes('One real problem') || fixPrompt.includes('Verifier'), 'the verifier summary is included');
    const cs = await comments(h, key);
    assert.ok(cs.some((c) => c.includes('Verification failed (loop 1')));
    assert.ok(labelNames(h, key).includes('conductor:ready'));
    // the engine must not have treated its own sub-issue as a new task
    assert.equal(h.store.list().length, 1);
  } finally {
    await h.cleanup();
  }
});

test('loop cap → needs_human with evidence; Todo retries verify with extra budget', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.maxLoops = 2) });
  try {
    h.scenario({ claude: { '*': { verify: [{ json: { verdict: 'fail', summary: 'Still broken.', bugs: [bug] } }] } } });
    const key = h.issue('Add the answer feature');
    await h.settle();
    let run = h.run(key);
    assert.equal(run.status, 'needs_human');
    assert.equal(run.needsHuman?.origin, 'verify');
    assert.equal(run.loop, 2);
    assert.ok(labelNames(h, key).includes('conductor:needs-human'));
    assert.ok((await comments(h, key)).some((c) => c.includes('needs you')));
    // only one sub-issue despite two failing loops (fingerprint dedupe)
    assert.equal((await h.linear.children(h.linear.issueByKey(key).id)).length, 1);
    // human fixes the scenario and drags it back to Todo → retries verification with a fresh budget
    h.scenario({ claude: { '*': { verify: [{ json: { verdict: 'pass' } }] } } });
    h.linear.humanMove(h.linear.issueByKey(key).id, 'Todo');
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
