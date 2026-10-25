// Ship's target is the branch checked out in the repository (read once, re-verified before the push); protected, detached, default and
// non-fast-forward cases go to conductor/<name|KEY>. Real temp repos and a BARE temp remote only. Nothing here can reach a real remote.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fingerprint, isolateGitHome, makeRepo, refsOf, sg, sgt, sgTry, tmpDir } from './helpers/tmp-repo.ts';
import { pushShip, prepareShip, rescanRange, ship } from '../src/git/ship.ts';
import type { ScanFn } from '../src/git/ship.ts';

isolateGitHome();
const ME = { name: 'Ada Lovelace', email: 'ada@example.test' };

function commitAs(dir: string, msg: string, file: string, content: string): string {
  execFileSync('sh', ['-c', `mkdir -p "$(dirname "${file}")" && printf %s "$CONTENT" > "${file}"`], { cwd: dir, env: { ...process.env, CONTENT: content } });
  const env = { ...process.env, GIT_AUTHOR_NAME: ME.name, GIT_AUTHOR_EMAIL: ME.email, GIT_COMMITTER_NAME: ME.name, GIT_COMMITTER_EMAIL: ME.email, GIT_CONFIG_NOSYSTEM: '1' };
  execFileSync('git', ['add', '-A'], { cwd: dir, env });
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir, env });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env, encoding: 'utf8' }).trim();
}

const okScan: ScanFn = async () => ({ ok: true });

function world(branch: string | null) {
  const r = makeRepo({ withRemote: true });
  sg(r.dir, ['config', 'user.name', ME.name]);
  sg(r.dir, ['config', 'user.email', ME.email]);
  if (branch && branch !== 'main') sg(r.dir, ['checkout', '-q', '-b', branch]);
  const sha = commitAs(r.dir, 'KEE-7: add thing\n', 'src/thing.js', 'export const t = 1;\n');
  if (!branch) sg(r.dir, ['checkout', '-q', '--detach']);
  const base = { repoRoot: r.dir, remote: 'origin', key: 'KEE-7', recordedShas: [sha], owners: { [sha]: 'KEE-7' }, scan: okScan };
  return { r, remote: r.remote!, sha, base };
}
const tipOf = (remote: string, branch: string): string => sgTry(remote, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).stdout.trim();

describe('ship target = the checked-out branch, with a bounded fallback', () => {
  it('a feature branch is pushed to directly, by sha, and the local checkout is untouched', async () => {
    const w = world('feature/x');
    const before = fingerprint(w.r.dir);
    const res = await ship(w.base);
    assert.ok(res.ok, JSON.stringify(res));
    if (!res.ok) return;
    assert.deepEqual([res.prepared.target, res.prepared.fallback, res.prepared.checkedOut], ['feature/x', false, 'feature/x']);
    assert.equal(tipOf(w.remote, 'feature/x'), w.sha);
    assert.equal(fingerprint(w.r.dir), before);
  });

  for (const [name, branch, expected] of [['a protected name (main)', 'main', 'conductor/KEE-7'], ['a release branch', 'release/1.0', 'conductor/KEE-7'], ['develop', 'develop', 'conductor/KEE-7'], ['detached HEAD', null, 'conductor/KEE-7']] as const) {
    it(`${name} is refused as a direct target: the sha goes to ${expected}, main and the protected name stay put`, async () => {
      const w = world(branch);
      const mainBefore = tipOf(w.remote, 'main');
      const res = await ship(w.base);
      assert.ok(res.ok, JSON.stringify(res));
      if (!res.ok) return;
      assert.deepEqual([res.prepared.target, res.prepared.fallback], [expected, true]);
      assert.equal(tipOf(w.remote, expected), w.sha);
      assert.equal(tipOf(w.remote, 'main'), mainBefore);
      if (branch) assert.equal(tipOf(w.remote, branch) === w.sha, false);
    });
  }

  it('a non-fast-forward branch goes to conductor/<branch>; a rerun is a no-op and makes no third branch', async () => {
    const w = world('feature/x');
    const other = tmpDir('clone');
    sg(other, ['clone', '-q', w.remote, 'c']);
    sg(`${other}/c`, ['config', 'user.name', 'S']);
    sg(`${other}/c`, ['config', 'user.email', 's@example.test']);
    commitAs(`${other}/c`, 'remote only\n', 'r.txt', 'r\n');
    sg(`${other}/c`, ['push', '-q', 'origin', 'HEAD:refs/heads/feature/x']);
    const theirs = tipOf(w.remote, 'feature/x');
    const first = await ship(w.base);
    assert.ok(first.ok && first.pushed, JSON.stringify(first));
    assert.equal(first.ok && first.prepared.target, 'conductor/feature-x');
    assert.equal(tipOf(w.remote, 'feature/x'), theirs, 'never forced');
    const refs = refsOf(w.remote);
    const again = await ship(w.base);
    assert.ok(again.ok && !again.pushed, JSON.stringify(again));
    assert.equal(refsOf(w.remote), refs);
  });

  it('a fallback branch that itself diverged on the remote holds (never forced)', async () => {
    const w = world('main');
    const other = tmpDir('clone');
    sg(other, ['clone', '-q', w.remote, 'c']);
    sg(`${other}/c`, ['config', 'user.name', 'S']);
    sg(`${other}/c`, ['config', 'user.email', 's@example.test']);
    commitAs(`${other}/c`, 'theirs\n', 'r.txt', 'r\n');
    sg(`${other}/c`, ['push', '-q', 'origin', 'HEAD:refs/heads/conductor/KEE-7']);
    const refs = refsOf(w.remote);
    const res = await ship(w.base);
    assert.equal(res.ok, false);
    assert.equal(refsOf(w.remote), refs);
  });

  it('the checked-out branch switched while shipping holds: nothing is pushed, a retry pushes to the new branch', async () => {
    const w = world('feature/x');
    sg(w.r.dir, ['branch', 'other']);
    const refs = refsOf(w.remote);
    const res = await ship({ ...w.base, beforePush: () => (sg(w.r.dir, ['checkout', '-q', 'other']), null) });
    assert.equal(res.ok, false);
    assert.match(res.ok ? '' : res.hold.reason, /checked-out branch or its tip changed/);
    assert.equal(refsOf(w.remote), refs);
    const retry = await ship(w.base);
    assert.ok(retry.ok, JSON.stringify(retry));
    assert.equal(retry.ok && retry.prepared.target, 'other');
  });

  it('a new commit on the checked-out branch while shipping holds too', async () => {
    const w = world('feature/x');
    const refs = refsOf(w.remote);
    const res = await ship({ ...w.base, beforePush: () => (commitAs(w.r.dir, 'mine\n', 'mine.txt', 'm\n'), null) });
    assert.equal(res.ok, false);
    assert.equal(refsOf(w.remote), refs);
  });

  it('pushShip re-verifies the branch itself', async () => {
    const w = world('feature/x');
    const prep = await prepareShip(w.base);
    assert.ok(prep.ok);
    if (!prep.ok) return;
    sg(w.r.dir, ['checkout', '-q', '-b', 'moved']);
    const refs = refsOf(w.remote);
    const res = await pushShip({ repoRoot: w.r.dir, remote: 'origin', target: prep.prepared.target, sha: prep.prepared.sha, checkedOut: prep.prepared.checkedOut, headSha: prep.prepared.headSha });
    assert.equal(res.ok, false);
    assert.equal(refsOf(w.remote), refs);
  });

  it('a partial failure (the remote rejects once) holds, then the retry pushes the same sha', async () => {
    const w = world('feature/x');
    execFileSync('sh', ['-c', 'mkdir -p hooks && printf "#!/bin/sh\\nexit 1\\n" > hooks/pre-receive && chmod +x hooks/pre-receive'], { cwd: w.remote });
    const held = await ship(w.base);
    assert.equal(held.ok, false);
    assert.equal(tipOf(w.remote, 'feature/x'), '');
    execFileSync('rm', ['hooks/pre-receive'], { cwd: w.remote });
    const retry = await ship(w.base);
    assert.ok(retry.ok && retry.pushed, JSON.stringify(retry));
    assert.equal(tipOf(w.remote, 'feature/x'), w.sha);
  });

  it('the user’s own unpushed commit under the tip holds: Conductor never pushes work it did not make', async () => {
    const r = makeRepo({ withRemote: true });
    sg(r.dir, ['config', 'user.name', ME.name]);
    sg(r.dir, ['config', 'user.email', ME.email]);
    sg(r.dir, ['checkout', '-q', '-b', 'feature/x']);
    const mine = commitAs(r.dir, 'my wip\n', 'wip.txt', 'w\n');
    const sha = commitAs(r.dir, 'KEE-7: thing\n', 'src/t.js', 't\n');
    const refs = refsOf(r.remote!);
    const res = await ship({ repoRoot: r.dir, remote: 'origin', key: 'KEE-7', recordedShas: [sha], owners: { [sha]: 'KEE-7' }, scan: okScan });
    assert.equal(res.ok, false);
    assert.ok((res.ok ? '' : res.hold.reason).includes(mine.slice(0, 8)));
    assert.equal(refsOf(r.remote!), refs);
  });

  it('a bad ticket key cannot name a fallback branch', async () => {
    const w = world('main');
    const res = await ship({ ...w.base, key: 'x; rm -rf' });
    assert.equal(res.ok, false);
  });
});

describe('rescanRange (the hook for the Stuck resolver)', () => {
  it('runs the scan over the unpublished range, passes the live exclusions, and fails closed', async () => {
    const w = world('feature/x');
    const calls: Array<{ tip: string; excludeTips: string[] }> = [];
    const ok = await rescanRange({ repoRoot: w.r.dir, remote: 'origin', tip: w.sha, scan: async (o) => (calls.push({ tip: o.tip, excludeTips: o.excludeTips }), { ok: true }) });
    assert.deepEqual(ok, { ok: true });
    assert.equal(calls[0]!.tip, w.sha);
    assert.ok(calls[0]!.excludeTips.includes(tipOf(w.remote, 'main')));
    assert.equal((await rescanRange({ repoRoot: w.r.dir, remote: 'origin', tip: w.sha, scan: async () => { throw new Error('boom'); } })).ok, false);
    assert.equal((await rescanRange({ repoRoot: w.r.dir, remote: 'origin', tip: w.sha, scan: async () => ({ ok: false, reason: 'secret', commits: [w.sha], files: ['.env'] }) })).ok, false);
    assert.equal((await rescanRange({ repoRoot: w.r.dir, remote: 'nope', tip: w.sha, scan: okScan })).ok, false, 'no usable remote: closed');
    assert.equal((await rescanRange({ repoRoot: w.r.dir, remote: 'origin', tip: 'f'.repeat(40), scan: okScan })).ok, false);
  });
});
