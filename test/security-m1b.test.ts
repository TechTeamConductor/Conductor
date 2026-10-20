// Regression tests for the security review of M1b (B-1 … B-10): each reproduces a finding that was real before its fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, makeHarness } from './helpers/harness.ts';
import { newRun, RunStore } from '../src/store.ts';
import { Board, BoardError } from '../src/board/index.ts';
import { removeWorktree, assertOwnedWorktree } from '../src/git/worktree.ts';
import { migrateRunV1ToV2 } from '../src/schema/run-migrations.ts';
import { SERVICE_LABEL } from '../src/service.ts';
import { defaultConfig } from '../src/config.ts';
import { sha1 } from '../src/util.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'cond-sec-'));

test('B-1: a repo that TRACKS .conductor as a symlink cannot make Conductor overwrite files outside the worktree', async () => {
  const h = await makeHarness();
  try {
    const victim = tmp();
    writeFileSync(join(victim, 'plan.md'), 'victim plan');
    writeFileSync(join(victim, 'diff.patch'), 'victim patch');
    symlinkSync(victim, join(h.repoDir, '.conductor'));
    git(h.repoDir, 'add', '-A');
    git(h.repoDir, 'commit', '-q', '-m', 'hostile: track .conductor as a symlink');
    const key = h.issue('Hostile repo');
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
    assert.equal(readFileSync(join(victim, 'plan.md'), 'utf8'), 'victim plan', 'nothing was written through the link');
    assert.equal(readFileSync(join(victim, 'diff.patch'), 'utf8'), 'victim patch');
    const wt = h.run(key).worktree;
    assert.equal(lstatSync(join(wt, '.conductor')).isSymbolicLink(), false, 'the link was replaced by a real folder');
    assert.ok(existsSync(join(wt, '.conductor', 'diff.patch')), 'Conductor\'s own files land in the real folder');
    assert.ok(h.store.readArtifact(key, 'plan-1.md', ''), 'the plan itself lives in the run store (the in-worktree copy is informational)');
  } finally {
    await h.cleanup();
  }
});

test('B-2: a run record that carries a FOREIGN worktree (a v1 checkout) is never planned in, reset, backed up or removed', async () => {
  const h = await makeHarness();
  try {
    // a v1-style checkout with uncommitted work in it
    const v1Root = join(h.root, '.conductor-worktrees', 'demo', 'ENG-1');
    mkdirSync(join(h.root, '.conductor-worktrees', 'demo'), { recursive: true });
    git(h.repoDir, 'worktree', 'add', '-q', '-b', 'conductor/eng-1', v1Root, 'HEAD');
    writeFileSync(join(v1Root, 'precious.txt'), 'uncommitted v1 work');
    const v1Head = git(v1Root, 'rev-parse', 'HEAD');
    const item = h.board.user.createItem({ projectId: h.projectId, title: 'Foreign worktree', description: 'x', lane: 'backlog' });
    h.store.create({ ...newRun({ key: item.key, itemId: item.id, title: item.title, description: item.description, descHash: sha1(item.description), repo: 'demo', branch: 'conductor/eng-1', worktree: v1Root, baseSha: v1Head, loopBudget: 3 }), status: 'queued' });
    await h.settle();
    assert.equal(h.run(item.key).status, 'needs_human');
    assert.match(h.run(item.key).needsHuman!.reason, /not the one Conductor v2 created/);
    assert.equal(readFileSync(join(v1Root, 'precious.txt'), 'utf8'), 'uncommitted v1 work');
    assert.equal(git(v1Root, 'rev-parse', 'HEAD'), v1Head);
    assert.equal(git(v1Root, 'symbolic-ref', '--short', 'HEAD'), 'conductor/eng-1');
    // restart (which would back up + reset a workspace) and cleanup both leave it alone
    await h.engine.applyHumanMove(item.key, 'todo');
    await h.settle();
    assert.equal(readFileSync(join(v1Root, 'precious.txt'), 'utf8'), 'uncommitted v1 work');
    await h.engine.abort(item.key);
    await assert.rejects(() => h.engine.cleanup(item.key), /not the one Conductor v2 created|foreign/i);
    assert.ok(existsSync(join(v1Root, 'precious.txt')), 'cleanup did not remove the foreign checkout');
    // removeWorktree validates the branch BEFORE removing anything
    await assert.rejects(removeWorktree(h.repoDir, v1Root, 'conductor/eng-1', { deleteBranch: true }), /non-conductor branch/);
    assert.ok(existsSync(join(v1Root, 'precious.txt')), 'the checkout survived the refused removal');
    await assert.rejects(assertOwnedWorktree({ name: 'demo', path: h.repoDir }, 'ENG-1', v1Root), /not the one Conductor v2 created/);
  } finally {
    await h.cleanup();
  }
});

test('B-2: the v1→v2 run migration blanks worktree/branch/base/commit (kept only as information under legacy)', () => {
  const v2 = migrateRunV1ToV2({ key: 'X-1', worktree: '/v1/wt', branch: 'conductor/x-1', baseSha: 'aaa', commitSha: 'bbb', status: 'ready' });
  assert.deepEqual([v2.worktree, v2.branch, v2.baseSha, v2.commitSha], ['', '', '', undefined]);
  assert.deepEqual([v2.legacy.v1Worktree, v2.legacy.v1Branch, v2.legacy.v1BaseSha, v2.legacy.v1CommitSha], ['/v1/wt', 'conductor/x-1', 'aaa', 'bbb']);
});

test('B-4: the board never writes what its own loader would refuse (overlong idemKey / stage fail NOW, the board still reopens)', () => {
  const dir = tmp();
  const b = Board.open({ dir });
  const p = b.createProject({ key: 'APP', name: 'App' });
  assert.throws(() => b.createItem({ projectId: p.id, title: 't', idemKey: 'k'.repeat(400) }, 'conductor'), (e: any) => e instanceof BoardError && e.code === 'bad_input');
  const it = b.createItem({ projectId: p.id, title: 'ok' }, 'user');
  assert.throws(() => b.setLane(it.id, 'active', 'conductor', { stage: 's'.repeat(80) }), (e: any) => e instanceof BoardError && e.code === 'bad_input');
  b.createItem({ projectId: p.id, title: 'still works' }, 'user');
  b.close();
  assert.equal(Board.open({ dir }).items().length, 2, 'reopens fine');
});

test('B-5: an unreadable run.json is set aside with a tombstone — the key stays taken and cannot be re-claimed over stale artifacts', () => {
  const root = tmp();
  const store = new RunStore(root);
  mkdirSync(join(root, 'ENG-1'));
  writeFileSync(join(root, 'ENG-1', 'run.json'), '{corrupt');
  writeFileSync(join(root, 'ENG-1', 'plan-1.json'), '{"stale":"approved plan"}');
  assert.equal(store.get('ENG-1'), null);
  assert.equal(store.has('ENG-1'), true, 'still taken');
  assert.deepEqual(store.tombstoned(), ['ENG-1']);
  assert.throws(() => store.create(newRun({ key: 'ENG-1', itemId: 'i', title: 't', description: '', descHash: 'h', repo: 'r', branch: 'b', worktree: '', baseSha: '', loopBudget: 3 })), (e: any) => e.code === 'exists');
  assert.ok(readdirSync(join(root, 'ENG-1')).some((n) => n.startsWith('run.json.corrupt-')), 'the bad file is kept for forensics');
});

test('B-7: v2 has its own launchd label and default port — it can never overwrite v1\'s service or collide with v1\'s port', () => {
  assert.equal(SERVICE_LABEL, 'com.techteam.conductor-v2');
  assert.notEqual(defaultConfig().ui.port, 4317);
});

test('B-8: uninstall --purge refuses a folder that is not a v2 data folder, before touching anything', () => {
  const notV2 = tmp();
  writeFileSync(join(notV2, 'precious.txt'), 'x');
  const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'conductor.mjs'), 'uninstall', '--purge'], { env: { ...process.env, CONDUCTOR_HOME: notV2 }, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a Conductor v2 data folder/);
  assert.equal(readFileSync(join(notV2, 'precious.txt'), 'utf8'), 'x');
});

test('B-10: a storage failure message carries no filesystem path; null in an edit does not clear a field', () => {
  const dir = tmp();
  let boom = false;
  const b = Board.open({ dir, fault: (p) => { if (boom && p === 'journal:before-fsync') throw new Error(`ENOSPC: no space left on device, write '${dir}/journal.ndjson'`); } });
  const p = b.createProject({ key: 'APP', name: 'App' });
  boom = true;
  try {
    b.createItem({ projectId: p.id, title: 'x' }, 'user');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof BoardError && e.code === 'storage_failed');
    assert.ok(!String((e as Error).message).includes(dir), 'no path in the message');
  }
  boom = false;
  const dir2 = tmp();
  const b2 = Board.open({ dir: dir2 });
  const p2 = b2.createProject({ key: 'APP', name: 'App' });
  const it = b2.user.createItem({ projectId: p2.id, title: 'T', description: 'keep me' });
  const after = b2.user.setFields(it.id, { title: 'T2', description: null });
  assert.equal(after.description, 'keep me');
  assert.equal(after.title, 'T2');
});
