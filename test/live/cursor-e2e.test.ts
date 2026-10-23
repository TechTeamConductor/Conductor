// LIVE: real Cursor CLI for plan / build / verify. Linear is the in-memory fake. Opt-in: LIVE=1 npm run test:live
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeHarness } from '../helpers/harness.ts';

const LIVE = process.env.LIVE === '1';
const repoFiles = {
  'src/math.mjs': 'export const add = (a, b) => a + b;\n',
  'test/math.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.mjs';\ntest('add', () => assert.equal(add(1, 2), 3));\n",
};

test('LIVE real Cursor: plan → build → verify on a tiny repo; diff is exactly the expected files; nothing pushed', { skip: !LIVE, timeout: 20 * 60_000 }, async () => {
  const h = await makeHarness({
    repoFiles,
    config: (c) => {
      c.agents.cursor.bin = 'agent';
      for (const r of ['planning', 'review', 'verification'] as const) c.roles[r].providers = ['cursor'];
      c.pipeline.planReview = 'off';
      c.pipeline.timeoutsMin = { plan: 8, review: 5, build: 15, verify: 8, idle: 5, gate: 3 };
    },
  });
  try {
    // a local bare remote so we can prove nothing is pushed
    const bare = join(h.root, 'remote.git');
    git(h.root, 'init', '-q', '--bare', bare);
    git(h.repoDir, 'remote', 'add', 'origin', bare);
    git(h.repoDir, 'push', '-q', 'origin', 'main');
    const remoteBefore = git(bare, 'for-each-ref');
    const mainBefore = git(h.repoDir, 'rev-parse', 'HEAD');
    const key = h.issue('Add a sub(a, b) function', {
      description: 'In src/math.mjs add and export `sub(a, b)` that returns a - b. Add a test for it in test/math.test.mjs next to the existing add test. Do not change anything else.',
    });
    await h.settle(60);
    const run = h.run(key);
    console.log('RUN STATUS', run.status, '| loop', run.loop, '| history:', run.history.map((x) => x.text).join(' → '));
    if (run.needsHuman) console.log('NEEDS HUMAN:', run.needsHuman.reason);
    assert.equal(run.status, 'ready', `pipeline should finish; got ${run.status}: ${run.needsHuman?.reason ?? ''}`);
    assert.equal(run.verdict, 'pass');
    // exact diff
    const files = git(run.worktree, 'diff', '--name-only', `${run.baseSha}..HEAD`).split('\n').filter(Boolean).sort();
    console.log('CHANGED FILES', files);
    assert.deepEqual(files, ['src/math.mjs', 'test/math.test.mjs'], 'only the expected files changed');
    assert.match(readFileSync(join(run.worktree, 'src/math.mjs'), 'utf8'), /sub/);
    // negatives: no tooling artefacts, no extra branches, remote untouched; the commit is on the current branch
    const tracked = git(run.worktree, 'ls-files');
    for (const bad of ['.techteam', '.cursor', '.claude', '.conductor', '.mcp.json']) assert.ok(!tracked.includes(bad), `${bad} must not be tracked`);
    assert.equal(git(run.worktree, 'status', '--porcelain'), '');
    const commits = git(run.worktree, 'rev-list', '--count', `${run.baseSha}..HEAD`);
    assert.equal(commits, '1', 'exactly one Conductor commit');
    assert.notEqual(git(h.repoDir, 'rev-parse', 'HEAD'), mainBefore, 'the commit landed on the current branch');
    assert.equal(git(bare, 'for-each-ref'), remoteBefore, 'remote untouched');
    const branches = git(h.repoDir, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort();
    assert.deepEqual(branches, ['main'], 'no extra branch');
    // the live log shows Cursor really worked and the builder honoured the pipeline preamble (no TechTeam/SoftCo ceremony artefacts)
    const ev = h.store.readEvents(key, 0, 2000).events;
    assert.ok(ev.some((e) => e.agent === 'cursor' && e.stage === 'build' && e.kind === 'tool'));
    const cursorGuard = join(run.worktree, '.cursor', 'cli.json');
    assert.ok(existsSync(cursorGuard));
    assert.equal(JSON.parse(readFileSync(cursorGuard, 'utf8')).permissions.deny[0], 'Shell(git:push*)');
    // sessions are resumable
    assert.ok(run.sessions.filter((s) => s.agent === 'cursor').length >= 3);
    console.log('SESSIONS', run.sessions.map((s) => `${s.agent}/${s.stage}/${s.id.slice(0, 8)}`).join(' '));
  } finally {
    await h.cleanup();
  }
});
