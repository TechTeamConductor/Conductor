// The manual Push click is a thin trigger for Ship (per-settings mode): same scan, identity snapshot, target rules and holds. No commit, amend or checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeHarness } from './helpers/harness.ts';
import { columnOf } from '../src/pipeline/view.ts';

test('manual push runs Ship: the checked-out branch gets the card’s commits as the person, the checkout and untracked files are untouched', async () => {
  const h = await makeHarness();
  try {
    const bare = join(h.root, 'remote.git');
    git(h.repoDir, 'init', '--bare', '-q', bare);
    git(h.repoDir, 'remote', 'add', 'origin', bare);
    git(h.repoDir, 'push', '-q', 'origin', 'main');
    git(h.repoDir, 'checkout', '-q', '-b', 'feature/x');
    git(h.repoDir, 'config', 'user.name', 'Ada Lovelace');
    git(h.repoDir, 'config', 'user.email', 'ada@example.com');
    const key = h.issue('Add the greeting');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    writeFileSync(join(h.repoDir, 'notes-not-this-ticket.txt'), 'leave me untracked\n');
    const headBefore = git(h.repoDir, 'rev-parse', 'HEAD');
    await h.engine.push(key);
    assert.equal(git(h.repoDir, 'rev-parse', 'HEAD'), headBefore, 'no commit, amend or rebase on the checkout');
    assert.equal(git(h.repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/x');
    assert.match(git(h.repoDir, 'status', '--porcelain'), /notes-not-this-ticket\.txt/);
    assert.equal(git(bare, 'log', '-1', '--format=%an <%ae>|%cn <%ce>', 'refs/heads/feature/x'), 'Ada Lovelace <ada@example.com>|Ada Lovelace <ada@example.com>');
    const remoteFiles = git(bare, 'ls-tree', '-r', '--name-only', 'refs/heads/feature/x').split('\n');
    assert.ok(remoteFiles.includes(`feature-${key.toLowerCase()}.mjs`));
    assert.ok(!remoteFiles.includes('notes-not-this-ticket.txt'));
    assert.match(git(bare, 'log', '-1', '--format=%s', 'refs/heads/feature/x'), new RegExp(`^${key}:`), 'the subject carries the ticket key');
    const after = h.run(key);
    assert.equal(after.status, 'ready');
    assert.ok(after.pushedAt);
    assert.equal(after.pushedBranch, 'feature/x');
    assert.equal(columnOf(after), 'pushed');
    const remoteTip = git(bare, 'rev-parse', 'refs/heads/feature/x');
    await h.engine.push(key);
    assert.equal(git(bare, 'rev-parse', 'refs/heads/feature/x'), remoteTip, 'a second push changes nothing');
  } finally {
    await h.cleanup();
  }
});

test('manual push on main never pushes main: the commits go to conductor/<KEY>', async () => {
  const h = await makeHarness();
  try {
    const bare = join(h.root, 'remote.git');
    git(h.repoDir, 'init', '--bare', '-q', bare);
    git(h.repoDir, 'remote', 'add', 'origin', bare);
    git(h.repoDir, 'push', '-q', 'origin', 'main');
    git(h.repoDir, 'config', 'user.name', 'Ada Lovelace');
    git(h.repoDir, 'config', 'user.email', 'ada@example.com');
    const key = h.issue('Add the greeting');
    await h.settle();
    const mainBefore = git(bare, 'rev-parse', 'refs/heads/main');
    await h.engine.push(key);
    assert.equal(git(bare, 'rev-parse', 'refs/heads/main'), mainBefore);
    assert.ok(git(bare, 'rev-parse', `refs/heads/conductor/${key}`));
    assert.equal(h.run(key).pushedBranch, `conductor/${key}`);
  } finally {
    await h.cleanup();
  }
});

test('manual push refuses an agent git identity and does not send anything', async () => {
  const h = await makeHarness();
  try {
    const bare = join(h.root, 'remote.git');
    git(h.repoDir, 'init', '--bare', '-q', bare);
    git(h.repoDir, 'remote', 'add', 'origin', bare);
    git(h.repoDir, 'push', '-q', 'origin', 'main');
    git(h.repoDir, 'config', 'user.name', 'Conductor');
    git(h.repoDir, 'config', 'user.email', 'conductor@localhost');
    const key = h.issue('Add the greeting');
    await h.settle();
    await assert.rejects(h.engine.push(key), /agent/);
    assert.equal(git(bare, 'for-each-ref', '--format=%(refname)'), 'refs/heads/main');
    assert.equal(h.run(key).pushedAt, undefined);
    assert.equal(columnOf(h.run(key)), 'ready');
  } finally {
    await h.cleanup();
  }
});

test('manual push accepts the saved developer identity even when the git name looks like an agent', async () => {
  const h = await makeHarness();
  try {
    const bare = join(h.root, 'remote.git');
    git(h.repoDir, 'init', '--bare', '-q', bare);
    git(h.repoDir, 'remote', 'add', 'origin', bare);
    git(h.repoDir, 'push', '-q', 'origin', 'main');
    git(h.repoDir, 'config', 'user.name', 'TechTeamConductor');
    git(h.repoDir, 'config', 'user.email', 'support@bargainn.io');
    const key = h.issue('Add the greeting');
    await h.settle();
    await assert.rejects(h.engine.push(key), /agent/, 'without the override the name is refused');
    h.cfg.developerIdentity = { name: 'TechTeamConductor', email: 'support@bargainn.io' };
    await h.engine.push(key);
    assert.equal(git(bare, 'log', '-1', '--format=%an <%ae>', `refs/heads/conductor/${key}`), 'TechTeamConductor <support@bargainn.io>');
    assert.ok(h.run(key).pushedAt);
  } finally {
    await h.cleanup();
  }
});

test('manual push in Complete auto is refused with a clear message (Done to Pushed is automatic)', async () => {
  const h = await makeHarness();
  try {
    const key = h.issue('Add the greeting');
    await h.settle();
    h.cfg.pipeline.runMode = 'complete-auto';
    await assert.rejects(h.engine.push(key), /Complete auto pushes finished cards by itself/);
  } finally {
    await h.cleanup();
  }
});
