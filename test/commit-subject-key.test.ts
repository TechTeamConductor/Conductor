// Commit-message rule: every commit Conductor creates or pushes has the ticket key as the subject prefix (`KEY: title`, `KEY: title — T1: …`).
// Real temp repos, fake agents and a BARE temp remote only. Nothing here can reach a real remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { git as hgit, makeHarness } from './helpers/harness.ts';
import { approvedPaused, manual, resume, three, writes } from './helpers/graphs.ts';
import { isolateGitHome, makeRepo, sg, sgt } from './helpers/tmp-repo.ts';
import { replayRange } from '../src/pipeline/resolver.ts';
import { prepareShip, subjectHasKey, withTicketKey } from '../src/git/ship.ts';

isolateGitHome();

const subjectsOf = (dir: string, range: string): string[] => hgit(dir, 'log', '--reverse', '--format=%s', range).split('\n').filter(Boolean);

test('single-commit build: the subject is `KEY: title`', async () => {
  const h = await makeHarness();
  try {
    const key = h.issue('Add the greeting');
    await h.settle();
    const run = h.run(key);
    const subs = subjectsOf(run.worktree, `${run.baseSha}..HEAD`);
    assert.ok(subs.length >= 1);
    for (const s of subs) assert.match(s, new RegExp(`^${key}: `), s);
    assert.equal(subs[0], `${key}: Add the greeting`);
  } finally {
    await h.cleanup();
  }
});

test('graph task commits: every subject is `KEY: title — Tn: …`', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const key = await approvedPaused(h, three(), { cursor: { 'ENG-1': { build: [writes('t1.mjs'), writes('t2.mjs'), writes('t3.mjs')] } } });
    await resume(h);
    const run = h.run(key);
    const subs = subjectsOf(run.worktree, `${run.baseSha}..HEAD`);
    assert.equal(subs.length, 3);
    subs.forEach((s, i) => assert.match(s, new RegExp(`^${key}: .* — T${i + 1}: `), s));
  } finally {
    await h.cleanup();
  }
});

test('resolver exclude replay keeps the key on every rebuilt commit', async () => {
  const r = makeRepo({ withRemote: false });
  const base = sgt(r.dir, ['rev-parse', 'HEAD']);
  execFileSync('sh', ['-c', 'echo a > a.txt && echo b > b.txt'], { cwd: r.dir });
  sg(r.dir, ['add', '-A']);
  sg(r.dir, ['commit', '-q', '-m', 'KEE-1: add things\n\nBuilt by Conductor (x).']);
  const tip = sgt(r.dir, ['rev-parse', 'HEAD']);
  const out = await replayRange(r.dir, base, tip, new Set([tip]), ['b.txt'], 'exclude');
  assert.ok(out.ok, out.ok ? '' : out.why);
  if (!out.ok) return;
  assert.notEqual(out.tip, tip, 'the commit was rebuilt');
  assert.deepEqual(subjectsOf(r.dir, `${base}..${out.tip}`), ['KEE-1: add things']);
  assert.equal(sgt(r.dir, ['ls-tree', '--name-only', out.tip]).includes('b.txt'), false);
});

test('the key helpers: prepend only when missing, only for a well-formed key', () => {
  assert.equal(subjectHasKey('KEE-1: x\n', 'KEE-1'), true);
  assert.equal(subjectHasKey('KEE-12: x\n', 'KEE-1'), false);
  assert.equal(withTicketKey('add it\n\nbody\n', 'KEE-1'), 'KEE-1: add it\n\nbody\n');
  assert.equal(withTicketKey('KEE-1: add it\n', 'KEE-1'), 'KEE-1: add it\n');
  assert.equal(withTicketKey('add it\n', 'not a key'), 'add it\n');
  assert.equal(withTicketKey('add it\n', null), 'add it\n');
});

const AGENT = { name: 'Conductor', email: 'conductor@localhost' };
function commit(dir: string, who: { name: string; email: string }, msg: string, file: string): string {
  execFileSync('sh', ['-c', `mkdir -p "$(dirname "${file}")" && echo x > "${file}"`], { cwd: dir });
  const env = { ...process.env, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email, GIT_CONFIG_NOSYSTEM: '1' };
  execFileSync('git', ['add', '-A'], { cwd: dir, env });
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir, env });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env, encoding: 'utf8' }).trim();
}
const okScan = async () => ({ ok: true as const });

function shipWorld() {
  const r = makeRepo({ withRemote: true });
  sg(r.dir, ['config', 'user.name', 'Ada Lovelace']);
  sg(r.dir, ['config', 'user.email', 'ada@example.test']);
  sg(r.dir, ['checkout', '-q', '-b', 'work/ship']);
  return r;
}

test('Ship: an unpublished Conductor-recorded commit without the key gets `KEY: ` prepended (the cleanMessage path); a keyed one is left as it is', async () => {
  const r = shipWorld();
  const a = commit(r.dir, AGENT, 'add feature\n\nBuilt by Conductor (x)\n', 'src/a.js');
  const b = commit(r.dir, AGENT, 'KEE-1: second\n\nBuilt by Conductor (x)\n', 'src/b.js');
  const res = await prepareShip({ repoRoot: r.dir, remote: 'origin', key: 'KEE-1', recordedShas: [a, b], owners: { [a]: 'KEE-1', [b]: 'KEE-1' }, scan: okScan });
  assert.ok(res.ok, res.ok ? '' : res.hold.reason);
  if (!res.ok) return;
  assert.deepEqual(subjectsOf(r.dir, `origin/main..${res.prepared.sha}`), ['KEE-1: add feature', 'KEE-1: second']);
});

test('Ship: a developer-clean unpublished recorded commit with no key still gets the key; the owning card key is used per commit', async () => {
  const r = shipWorld();
  const a = commit(r.dir, { name: 'Ada Lovelace', email: 'ada@example.test' }, 'plain message\n', 'src/a.js');
  const b = commit(r.dir, { name: 'Ada Lovelace', email: 'ada@example.test' }, 'other message\n', 'src/b.js');
  const res = await prepareShip({ repoRoot: r.dir, remote: 'origin', key: 'KEE-2', recordedShas: [a, b], owners: { [a]: 'KEE-1', [b]: 'KEE-2' }, scan: okScan });
  assert.ok(res.ok, res.ok ? '' : res.hold.reason);
  if (!res.ok) return;
  assert.deepEqual(subjectsOf(r.dir, `origin/main..${res.prepared.sha}`), ['KEE-1: plain message', 'KEE-2: other message']);
});

test('Ship never touches a non-Conductor commit (it holds) or a published one (left byte-identical)', async () => {
  const r = shipWorld();
  const mine = commit(r.dir, { name: 'Ada Lovelace', email: 'ada@example.test' }, 'my own work\n', 'src/mine.js');
  const held = await prepareShip({ repoRoot: r.dir, remote: 'origin', key: 'KEE-1', recordedShas: [], scan: okScan });
  assert.equal(held.ok, false);
  assert.equal(sgt(r.dir, ['log', '-1', '--format=%s', mine]), 'my own work');
  // published: the remote already has `pub`, then a recorded keyed-less commit on top is the only thing rewritten
  sg(r.dir, ['push', '-q', 'origin', `${mine}:refs/heads/work/ship`]);
  const next = commit(r.dir, AGENT, 'next step\n\nBuilt by Conductor (x)\n', 'src/next.js');
  const res = await prepareShip({ repoRoot: r.dir, remote: 'origin', key: 'KEE-3', recordedShas: [mine, next], owners: { [mine]: 'KEE-3', [next]: 'KEE-3' }, scan: okScan });
  assert.ok(res.ok, res.ok ? '' : res.hold.reason);
  if (!res.ok) return;
  assert.equal(sgt(r.dir, ['log', '-1', '--format=%s', mine]), 'my own work', 'the published commit keeps its subject');
  assert.deepEqual(subjectsOf(r.dir, `${mine}..${res.prepared.sha}`), ['KEE-3: next step']);
  assert.equal(sgt(r.dir, ['rev-parse', `${res.prepared.sha}~1`]), mine, 'its parent is the untouched published commit');
});

test('Ship fallback branch: the pushed commits still carry the key', async () => {
  const r = shipWorld();
  const a = commit(r.dir, AGENT, 'add feature\n\nBuilt by Conductor (x)\n', 'src/a.js');
  sg(r.remote!, ['update-ref', 'refs/heads/work/ship', sgt(r.remote!, ['rev-parse', 'refs/heads/main'])]);
  sg(r.remote!, ['symbolic-ref', 'HEAD', 'refs/heads/work/ship']); // the live default branch is the checked-out one -> conductor/ fallback
  const res = await prepareShip({ repoRoot: r.dir, remote: 'origin', key: 'KEE-1', recordedShas: [a], owners: { [a]: 'KEE-1' }, scan: okScan });
  assert.ok(res.ok, res.ok ? '' : res.hold.reason);
  if (!res.ok) return;
  assert.equal(res.prepared.fallback, true);
  assert.equal(sgt(r.dir, ['log', '-1', '--format=%s', res.prepared.sha]), 'KEE-1: add feature');
});
