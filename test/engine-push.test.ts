// A done ticket can be pushed on the branch already checked out. The commit is only that ticket's files, and the author is the person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeHarness } from './helpers/harness.ts';
import { columnOf } from '../src/pipeline/view.ts';

test('push stays on the current branch, commits only that ticket’s files, and records the person', async () => {
  const h = await makeHarness();
  try {
    const bare = join(h.root, 'remote.git');
    git(h.repoDir, 'init', '--bare', '-q', bare);
    git(h.repoDir, 'remote', 'add', 'origin', bare);
    git(h.repoDir, 'config', 'user.name', 'Conductor');
    git(h.repoDir, 'config', 'user.email', 'conductor@localhost');
    const key = h.issue('Add the greeting');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.equal(git(h.repoDir, 'log', '-1', '--format=%an <%ae>'), 'Conductor <conductor@localhost>');
    git(h.repoDir, 'config', 'user.name', 'Ada Lovelace');
    git(h.repoDir, 'config', 'user.email', 'ada@example.com');
    writeFileSync(join(h.repoDir, 'notes-not-this-ticket.txt'), 'leave me untracked\n');
    const branchBefore = git(h.repoDir, 'rev-parse', '--abbrev-ref', 'HEAD');
    await h.engine.push(key);
    assert.equal(git(h.repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'), branchBefore);
    assert.equal(git(h.repoDir, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort().join('\n'), 'main');
    assert.equal(git(h.repoDir, 'log', '-1', '--format=%an <%ae>'), 'Ada Lovelace <ada@example.com>');
    const files = git(h.repoDir, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').filter(Boolean);
    assert.ok(files.includes(`feature-${key.toLowerCase()}.mjs`));
    assert.ok(!files.includes('notes-not-this-ticket.txt'));
    assert.match(git(h.repoDir, 'status', '--porcelain'), /notes-not-this-ticket\.txt/);
    const remoteFiles = git(bare, 'ls-tree', '-r', '--name-only', 'refs/heads/main').split('\n');
    assert.ok(remoteFiles.includes(`feature-${key.toLowerCase()}.mjs`));
    assert.ok(!remoteFiles.includes('notes-not-this-ticket.txt'));
    const after = h.run(key);
    assert.equal(after.status, 'ready');
    assert.ok(after.pushedAt);
    assert.equal(columnOf(after), 'pushed');
    const head = git(h.repoDir, 'rev-parse', 'HEAD');
    await h.engine.push(key);
    assert.equal(git(h.repoDir, 'rev-parse', 'HEAD'), head, 'a second push does not make another commit');
  } finally {
    await h.cleanup();
  }
});

test('push refuses an agent git identity and does not send the branch', async () => {
  const h = await makeHarness();
  try {
    const bare = join(h.root, 'remote.git');
    git(h.repoDir, 'init', '--bare', '-q', bare);
    git(h.repoDir, 'remote', 'add', 'origin', bare);
    git(h.repoDir, 'config', 'user.name', 'Conductor');
    git(h.repoDir, 'config', 'user.email', 'conductor@localhost');
    const key = h.issue('Add the greeting');
    await h.settle();
    await assert.rejects(h.engine.push(key), /agent/);
    assert.throws(() => git(bare, 'rev-parse', '--verify', 'refs/heads/main'));
    assert.equal(h.run(key).pushedAt, undefined);
    assert.equal(columnOf(h.run(key)), 'ready');
  } finally {
    await h.cleanup();
  }
});
