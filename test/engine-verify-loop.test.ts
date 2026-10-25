// R2-7: verify -> building. A `fail` verdict with only unverifiable criteria / minor findings loops to Building with stable bug fingerprints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness } from './helpers/harness.ts';
import { bugFingerprint } from '../src/pipeline/stages.ts';

const unver = { verdict: 'fail', summary: 'Cannot check the UI.', acceptance: [{ id: 'AC1', status: 'unverifiable', evidence: 'needs a browser' }], bugs: [] };
const minor = { verdict: 'fail', summary: 'Style only.', acceptance: [], bugs: [{ title: 'Rename helper', severity: 'minor', file: 'feature.mjs', evidence: 'name is unclear' }] };

test('KEE-6 style: unverifiable criterion loops to build, fix prompt is never "(none recorded)", then passes', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ cursor: { '*': { build: [{ savePrompt: true }, { savePrompt: true }] } }, claude: { '*': { verify: [{ json: unver }, { json: { verdict: 'pass' } }] } } });
    const key = h.issue('UI thing');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready', run.needsHuman?.reason);
    assert.equal(run.loop, 2);
    const fix = readFileSync(join(h.fakeDir, `prompt-cursor-${key}-build-1.txt`), 'utf8');
    assert.match(fix, /# Stage: FIX/);
    assert.ok(!fix.includes('(none recorded'), fix);
    assert.ok(fix.includes('AC1') && fix.includes('needs a browser'));
  } finally {
    await h.cleanup();
  }
});

test('minor findings on a fail verdict loop to build; fingerprint is stable and one bug card exists across loops; limit still ends stuck', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.maxLoops = 3) });
  try {
    h.scenario({ claude: { '*': { verify: [{ json: minor }] } } });
    const key = h.issue('Style thing');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'needs_human');
    assert.equal(run.needsHuman?.origin, 'verify');
    assert.equal(run.loop, 3);
    assert.equal(run.bugs.length, 1, JSON.stringify(run.bugs.map((b) => [b.title, b.file, b.severity])));
    const fp = bugFingerprint({ title: 'Rename helper', file: 'feature.mjs' });
    assert.equal(run.bugs[0]!.fp, fp);
    assert.deepEqual(run.bugs[0]!.loops, [1, 2, 3]);
    assert.equal(h.board.children(h.board.item(key)!.id).filter((k) => k.kind === 'bug').length, 1, 'no duplicate bug cards');
  } finally {
    await h.cleanup();
  }
});

test('unverifiable fingerprint is stable across loops', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.maxLoops = 2) });
  try {
    h.scenario({ claude: { '*': { verify: [{ json: unver }] } } });
    const key = h.issue('UI thing');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.bugs.length, 1);
    assert.deepEqual(run.bugs[0]!.loops, [1, 2]);
  } finally {
    await h.cleanup();
  }
});

test('a pre-existing red gate does not fail the verdict', async () => {
  const h = await makeHarness({
    repoFiles: { 'pre.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('pre', () => assert.fail('boom'));\n" },
  });
  try {
    h.scenario({ claude: { '*': { verify: [{ json: { verdict: 'pass' } }] } } });
    const key = h.issue('Add feature');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready', run.needsHuman?.reason);
    assert.equal(run.bugs.length, 0);
  } finally {
    await h.cleanup();
  }
});

test('no gates: the result stays visibly unverified', async () => {
  const h = await makeHarness({ gates: false });
  try {
    h.scenario({ claude: { '*': { verify: [{ json: { verdict: 'pass' } }] } } });
    const key = h.issue('Add feature');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.equal(run.unverified, true);
    assert.ok(run.unverifiedWhy);
  } finally {
    await h.cleanup();
  }
});

test('empty diff at verify goes back to Building once (Complete auto), then stuck', async () => {
  const h = await makeHarness({ gates: false, config: (c) => void (c.pipeline.runMode = 'complete-auto') });
  try {
    const calls = () => h.calls().filter((c) => c.who === 'cursor' && c.stage === 'build').length;
    // drive the stage directly: the worktree has no change against its base
    h.scenario({ cursor: { '*': { build: [{ files: {} }] } } });
    const key = h.issue('Nothing');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'needs_human');
    assert.ok((run.emptyRetries ?? 0) <= 1);
    assert.ok(calls() <= 2);
  } finally {
    await h.cleanup();
  }
});
