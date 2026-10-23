import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeHarness } from './helpers/harness.ts';

test('happy path: To do → plan → build → verify → ready, on the repository’s current branch', async () => {
  const h = await makeHarness();
  try {
    const mainBefore = git(h.repoDir, 'rev-parse', 'HEAD');
    const key = h.issue('Add the answer feature');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready', JSON.stringify(run.history.map((x) => x.text)));
    assert.equal(run.verdict, 'pass');
    assert.ok(run.commitSha && run.commitSha !== run.baseSha, 'builder work was committed');
    // the commit is on the branch the repo already had; no conductor-v2 branch
    assert.notEqual(git(h.repoDir, 'rev-parse', 'HEAD'), mainBefore);
    assert.equal(git(h.repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(run.branch, 'main');
    assert.equal(git(h.repoDir, 'status', '--porcelain'), '');
    assert.ok(existsSync(join(h.repoDir, `feature-${key.toLowerCase()}.mjs`)));
    assert.equal(git(h.repoDir, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort().join('\n'), 'main');
    assert.equal(git(run.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), run.branch);
    assert.ok(existsSync(join(run.worktree, `feature-${key.toLowerCase()}.mjs`)));
    // plan artifact + untracked plan file, never committed
    assert.ok(existsSync(join(run.worktree, '.conductor', 'plan.md')));
    assert.equal(git(run.worktree, 'status', '--porcelain'), '');
    assert.ok(!git(run.worktree, 'ls-files').includes('.conductor'));
    // Board: comments posted, lane + stage reflected, no PR/push
    const comments = h.board.comments(key);
    assert.ok(comments.some((c) => c.author === 'conductor' && c.body.includes('Conductor plan')), 'plan comment');
    assert.ok(comments.some((c) => c.body.includes('Ready for review')), 'ready comment');
    assert.equal(h.board.item(key)!.lane, 'done');
    assert.equal(h.board.item(key)!.stage, 'ready');
    assert.ok(h.notes.some((n) => /ready/i.test(n.title)));
    // sessions recorded for both agents with resumable ids
    assert.ok(run.sessions.some((s) => s.agent === 'claude' && s.stage === 'plan'));
    assert.ok(run.sessions.some((s) => s.agent === 'cursor' && s.stage === 'build'));
    assert.ok(run.sessions.some((s) => s.agent === 'claude' && s.stage === 'verify'));
    // claude was invoked read-only with the locked-down flags and prompt on stdin
    const claude = h.calls().filter((c) => c.who === 'claude');
    assert.ok(claude.length >= 2);
    for (const c of claude) {
      for (const f of ['--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--max-turns', '--json-schema']) assert.ok(c.argv.includes(f), f);
      assert.equal(c.argv[c.argv.indexOf('--tools') + 1], 'Read,Grep,Glob');
      assert.equal(c.argv[c.argv.indexOf('--permission-mode') + 1], 'dontAsk');
      assert.ok(!c.envKeys.includes('LINEAR_API_KEY'));
    }
    const events = h.store.readEvents(key, 0, 2000).events;
    assert.ok(events.some((e) => e.agent === 'claude' && e.kind === 'tool'));
    assert.ok(events.some((e) => e.agent === 'cursor' && e.kind === 'tool'));
    void readFileSync;
  } finally {
    await h.cleanup();
  }
});

test('a later card commits on the same branch and sees the earlier card’s file', async () => {
  const h = await makeHarness();
  try {
    const first = h.issue('Add the first feature');
    await h.settle();
    assert.equal(h.run(first).status, 'ready');
    const second = h.board.user.createItem({ projectId: h.projectId, title: 'Add the second feature', dependsOn: [h.board.item(first)!.id] });
    await h.settle();
    const run2 = h.run(second.key);
    assert.equal(run2.status, 'ready', JSON.stringify(run2.history.map((x) => x.text)));
    assert.equal(run2.branch, 'main');
    assert.equal(git(h.repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.ok(existsSync(join(h.repoDir, `feature-${first.toLowerCase()}.mjs`)));
    assert.ok(existsSync(join(h.repoDir, `feature-${second.key.toLowerCase()}.mjs`)));
    assert.equal(git(h.repoDir, 'merge-base', '--is-ancestor', h.run(first).commitSha!, 'HEAD'), '');
    assert.equal(git(h.repoDir, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).join('\n'), 'main');
  } finally {
    await h.cleanup();
  }
});
