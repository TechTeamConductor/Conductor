import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoConfig } from '../../src/types.ts';
import { git } from '../../src/git/exec.ts';
import {
  agentGitEnv,
  backupRefs,
  baseRefFor,
  checkCursorGuard,
  commitAll,
  createWorktree,
  detectSetupCommand,
  diffAgainst,
  diffScopeViolations,
  inspectRepo,
  installDeps,
  listWorktrees,
  lockfileHash,
  removeWorktree,
  resetToBase,
  resetToCommit,
  scanAncestors,
  withRepoLock,
  writeCursorGuard,
  CURSOR_GUARD_JSON, CURSOR_GUARD_DENY } from '../../src/git/worktree.ts';
import {
  fingerprint,
  isolateGitHome,
  makeBareRemote,
  makeRepo,
  refsOf,
  sg,
  sgTry,
  sgt,
  alive,
  tmpDir,
  waitFor,
  writeExecutable,
} from '../helpers/tmp-repo.ts';

const HOME = isolateGitHome();
const FAKE_TOKEN = 'ghp_' + 'a1B2c3D4'.repeat(5); // 40 chars after the prefix: matches the GitHub token pattern
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function cfg(repo: { dir: string }, over: Partial<RepoConfig> = {}): RepoConfig {
  return { name: 'demo', path: repo.dir, baseBranch: 'main', gates: [], copyFiles: [], envPassthrough: [], ...over };
}
async function mkWt(repo: ReturnType<typeof makeRepo>, key = 'ENG-1', over: Partial<RepoConfig> = {}) {
  return createWorktree({ repo: cfg(repo, over), key });
}

// ───────────────────────────── inspectRepo ─────────────────────────────

describe('inspectRepo', () => {
  it('describes a normal repo', async () => {
    const r = makeRepo({ withRemote: true });
    const info = await inspectRepo(r.dir);
    assert.equal(info.root, r.dir);
    assert.equal(info.head, r.head());
    assert.equal(info.currentBranch, 'main');
    assert.deepEqual(info.remotes, ['origin']);
    assert.equal(info.defaultBranch, 'main');
  });

  it('defaultBranch: origin/HEAD target, then main/master, then the current branch', async () => {
    const t = makeRepo({ branch: 'trunk', withRemote: true });
    t.git(['remote', 'set-head', 'origin', 'trunk']);
    assert.equal((await inspectRepo(t.dir)).defaultBranch, 'trunk');

    const m = makeRepo({ branch: 'master' });
    assert.equal((await inspectRepo(m.dir)).defaultBranch, 'master');

    const odd = makeRepo({ branch: 'develop' });
    assert.equal((await inspectRepo(odd.dir)).defaultBranch, 'develop');
  });

  it('reports a detached HEAD as currentBranch null', async () => {
    const r = makeRepo();
    r.git(['checkout', '-q', '--detach']);
    const info = await inspectRepo(r.dir);
    assert.equal(info.currentBranch, null);
    assert.equal(info.defaultBranch, 'main');
  });

  it('rejects "/"', async () => {
    await assert.rejects(inspectRepo('/'), /refusing to use "\/"/);
  });

  it('rejects $HOME even when it is a git repo', async () => {
    sg(HOME, ['init', '-q']);
    await assert.rejects(inspectRepo(HOME), /home directory/);
  });

  it('rejects anything under $CONDUCTOR_HOME and ~/.conductor', async () => {
    const inCond = join(process.env.CONDUCTOR_HOME!, 'repos', 'x');
    mkdirSync(inCond, { recursive: true });
    sg(inCond, ['init', '-q']);
    await assert.rejects(inspectRepo(inCond), /Conductor home/);

    const dot = join(HOME, '.conductor', 'y');
    mkdirSync(dot, { recursive: true });
    sg(dot, ['init', '-q']);
    await assert.rejects(inspectRepo(dot), /Conductor home/);
  });

  it('rejects bare repos, non-git dirs, subdirectories, missing paths, files and empty repos', async () => {
    await assert.rejects(inspectRepo(makeBareRemote()), /bare repositories/);
    await assert.rejects(inspectRepo(tmpDir()), /not a git repository/);

    const r = makeRepo();
    await assert.rejects(inspectRepo(join(r.dir, 'src')), /not the repository root/);
    await assert.rejects(inspectRepo(join(r.dir, '.git')), /not inside a git work tree/);
    await assert.rejects(inspectRepo(join(r.dir, 'missing')), /does not exist/);
    await assert.rejects(inspectRepo(join(r.dir, 'README.md')), /not a directory/);

    const empty = tmpDir('empty');
    sg(empty, ['init', '-q']);
    await assert.rejects(inspectRepo(empty), /no commits/);
    await assert.rejects(inspectRepo(''), /empty/);
  });

  it('follows symlinks: a symlinked path to the repo root is accepted and reported by realpath', async () => {
    const r = makeRepo();
    const link = join(r.root, 'link');
    (await import('node:fs')).symlinkSync(r.dir, link);
    const info = await inspectRepo(link);
    assert.equal(info.root, r.dir);
  });
});

// ───────────────────────────── mutex ─────────────────────────────

describe('withRepoLock', () => {
  it('serialises tasks per key, survives a throwing task, and does not block other keys', async () => {
    let active = 0;
    let max = 0;
    const order: number[] = [];
    await Promise.all(
      [...Array(6).keys()].map((i) =>
        withRepoLock('k1', async () => {
          active++;
          max = Math.max(max, active);
          await sleep(8);
          order.push(i);
          active--;
        }),
      ),
    );
    assert.equal(max, 1);
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5], 'FIFO');

    await assert.rejects(
      withRepoLock('k1', async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(await withRepoLock('k1', async () => 7), 7);

    let a = 0;
    let both = false;
    await Promise.all([
      withRepoLock('A', async () => {
        a++;
        await sleep(30);
        both ||= a === 2;
        a--;
      }),
      withRepoLock('B', async () => {
        a++;
        await sleep(30);
        both ||= a === 2;
        a--;
      }),
    ]);
    assert.equal(both, true, 'different keys run concurrently');
  });
});

// ───────────────────────────── createWorktree ─────────────────────────────

describe('createWorktree', () => {
  it('creates <repo parent>/.conductor-worktrees/<name>/<key> on branch conductor/<key-lowercase> at the base SHA', async () => {
    const r = makeRepo();
    const base = r.head();
    const w = await mkWt(r, 'ENG-123');
    assert.equal(w.path, join(r.root, '.conductor-worktrees', 'demo', 'ENG-123'));
    assert.equal(w.branch, 'conductor/eng-123');
    assert.equal(w.baseSha, base);
    assert.equal(w.created, true);
    assert.equal(sgt(w.path, ['rev-parse', 'HEAD']), base);
    assert.equal(sgt(w.path, ['symbolic-ref', '--short', 'HEAD']), 'conductor/eng-123');
    assert.ok(statSync(join(w.path, '.conductor')).isDirectory());
    assert.equal(sgt(r.dir, ['rev-parse', baseRefFor('ENG-123')]), base, 'base is recorded in a ref');
    const wts = await listWorktrees(r.dir);
    assert.equal(wts.length, 2);
  });

  it('honours worktreeRoot and baseRef (resolved to a SHA, no fetch)', async () => {
    const r = makeRepo();
    const first = r.head();
    r.write('later.txt', 'x');
    r.commit('second');
    const customRoot = tmpDir('wtroot');
    const w = await createWorktree({ repo: cfg(r), key: 'ENG-2', worktreeRoot: customRoot, baseRef: first });
    assert.equal(w.path, join(customRoot, 'demo', 'ENG-2'));
    assert.equal(w.baseSha, first);
    assert.equal(existsSync(join(w.path, 'later.txt')), false);
    assert.match(w.baseSha, /^[0-9a-f]{40}$/);
    await assert.rejects(createWorktree({ repo: cfg(r), key: 'ENG-3', baseRef: 'does-not-exist' }), /cannot resolve/);
    assert.equal(existsSync(join(customRoot, 'demo', 'ENG-3')), false);
  });

  it('is idempotent: reuses worktree + branch and keeps the ORIGINAL base even after main moved on', async () => {
    const r = makeRepo();
    const base = r.head();
    const a = await mkWt(r, 'ENG-1');
    r.write('moved.txt', 'x');
    r.commit('main moved on');
    const c = await commitAllIn(a.path, 'work', { 'work.txt': 'w' });
    assert.equal(c, true);
    const b = await mkWt(r, 'ENG-1');
    assert.equal(b.created, false);
    assert.equal(b.path, a.path);
    assert.equal(b.branch, a.branch);
    assert.equal(b.baseSha, base);
    assert.notEqual(sgt(a.path, ['rev-parse', 'HEAD']), base, 'the worktree keeps its commits');
    assert.equal((await listWorktrees(r.dir)).length, 2);
  });

  it('re-attaches a surviving branch after the worktree directory was removed', async () => {
    const r = makeRepo();
    const base = r.head();
    const a = await mkWt(r, 'ENG-1');
    await commitAllIn(a.path, 'work', { 'work.txt': 'w' });
    const tip = sgt(a.path, ['rev-parse', 'HEAD']);
    await removeWorktree(r.dir, a.path, a.branch);
    assert.equal(existsSync(a.path), false);
    const b = await mkWt(r, 'ENG-1');
    assert.equal(b.baseSha, base);
    assert.equal(sgt(b.path, ['rev-parse', 'HEAD']), tip);
  });

  it('survives a worktree dir deleted behind git’s back (prune + recreate)', async () => {
    const r = makeRepo();
    const a = await mkWt(r, 'ENG-9');
    (await import('node:fs')).rmSync(a.path, { recursive: true, force: true });
    const b = await mkWt(r, 'ENG-9');
    assert.equal(b.path, a.path);
    assert.ok(existsSync(join(b.path, 'README.md')));
  });

  it('serialises parallel creation: 5 keys on one repo, no corruption', async () => {
    const r = makeRepo();
    const base = r.head();
    const keys = ['P-1', 'P-2', 'P-3', 'P-4', 'P-5'];
    const out = await Promise.all(keys.map((k) => mkWt(r, k)));
    assert.equal(new Set(out.map((o) => o.path)).size, 5);
    for (const [i, o] of out.entries()) {
      assert.equal(o.baseSha, base);
      assert.equal(o.branch, `conductor/${keys[i]!.toLowerCase()}`);
      assert.equal(sgt(o.path, ['rev-parse', 'HEAD']), base);
      assert.ok(existsSync(join(o.path, '.conductor')));
    }
    assert.equal((await listWorktrees(r.dir)).length, 6);
    const fsck = sgTry(r.dir, ['fsck', '--no-dangling']);
    assert.equal(fsck.code, 0, fsck.stderr);
    const branches = sgt(r.dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/conductor']).split('\n').sort();
    assert.deepEqual(branches, keys.map((k) => `conductor/${k.toLowerCase()}`).sort());
  });

  it('worktree-isolation: main checkout is byte-identical after creating worktrees and committing in them', async () => {
    const r = makeRepo({ files: { 'README.md': '# x\n', 'src/index.js': 'a\n', 'sub/deep/file.txt': 'deep\n' } });
    r.write('.env.local', 'API_TOKEN=supersecretvalue123\n'); // ignored by the fixture .gitignore
    r.write('node_modules/pkg/index.js', 'x');
    const before = fingerprint(r.dir);
    const a = await mkWt(r, 'ENG-1', { copyFiles: ['.env.local'] });
    const b = await mkWt(r, 'ENG-2', { copyFiles: ['.env.local'] });
    assert.equal(await commitAllIn(a.path, 'change a', { 'src/index.js': 'changed in a\n', 'new-a.txt': 'a' }), true);
    assert.equal(await commitAllIn(b.path, 'change b', { 'sub/deep/file.txt': 'changed in b\n' }), true);
    assert.equal(fingerprint(r.dir), before);
    assert.equal(sgt(r.dir, ['rev-parse', 'HEAD']), r.head());
    assert.equal(readFileSync(join(r.dir, 'src/index.js'), 'utf8'), 'a\n');
    const heads = sgt(r.dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').sort();
    assert.deepEqual(heads, ['conductor/eng-1', 'conductor/eng-2', 'main']);
  });

  it('git-excludes .conductor/, copied env files and node_modules in the SHARED exclude file', async () => {
    const r = makeRepo();
    r.write('.env.local', 'API_TOKEN=supersecretvalue123\n');
    const w = await mkWt(r, 'ENG-1', { copyFiles: ['.env.local'] });
    const w2 = await mkWt(r, 'ENG-2', { copyFiles: ['.env.local'] });

    const excludePath = join(r.dir, sgt(r.dir, ['rev-parse', '--git-path', 'info/exclude']));
    const sharedFromWt = sgt(w.path, ['rev-parse', '--git-path', 'info/exclude']);
    assert.ok(sharedFromWt.endsWith('info/exclude'));
    assert.equal(readFileSync(excludePath, 'utf8').split('\n').filter((l) => l === '/.conductor/' || l === '/.env.local' || l === 'node_modules').length, 3);

    for (const wt of [w.path, w2.path]) {
      writeFileSync(join(wt, '.conductor', 'plan.md'), '# plan');
      mkdirSync(join(wt, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(wt, 'node_modules', 'pkg', 'i.js'), 'x');
      assert.equal(readFileSync(join(wt, '.env.local'), 'utf8'), 'API_TOKEN=supersecretvalue123\n');
      assert.equal(sgt(wt, ['status', '--porcelain']), '', `worktree ${wt} status must be clean`);
    }
    assert.equal(sgt(r.dir, ['status', '--porcelain']), '');
  });

  it('copyFiles: copies untracked files, never overwrites tracked ones, never clobbers on reuse, preserves mode', async () => {
    const r = makeRepo({ files: { 'tracked.env': 'TRACKED=1\n', 'README.md': 'x\n' } });
    r.write('.env.local', 'A_SECRET_VALUE=abcdefgh1234\n', 0o600);
    r.write('config/.env.dev', 'DEV=1\n');
    r.git(['config', 'core.excludesFile', '/dev/null']);
    writeFileSync(join(r.dir, '.git', 'info', 'exclude'), '/config/\n', { flag: 'a' });
    const w = await mkWt(r, 'ENG-1', { copyFiles: ['.env.local', 'tracked.env', 'missing.env', 'config/.env.dev'] });
    assert.deepEqual(w.copied.sort(), ['.env.local', 'config/.env.dev']);
    const reasons = Object.fromEntries(w.skipped.map((s) => [s.file, s.reason]));
    assert.match(reasons['tracked.env']!, /tracked/);
    assert.match(reasons['missing.env']!, /missing/);
    assert.equal(readFileSync(join(w.path, '.env.local'), 'utf8'), 'A_SECRET_VALUE=abcdefgh1234\n');
    assert.equal(lstatSync(join(w.path, '.env.local')).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(w.path, 'tracked.env'), 'utf8'), 'TRACKED=1\n');

    writeFileSync(join(w.path, '.env.local'), 'EDITED_BY_BUILDER=1\n');
    const again = await mkWt(r, 'ENG-1', { copyFiles: ['.env.local'] });
    assert.deepEqual(again.copied, []);
    assert.equal(readFileSync(join(again.path, '.env.local'), 'utf8'), 'EDITED_BY_BUILDER=1\n', 'reuse must not overwrite');
  });

  it('copyFiles: rejects path escape (.., absolute, ~, .git) before creating anything', async () => {
    const r = makeRepo();
    writeFileSync(join(r.root, 'outside-secret'), 'SECRET=outsidevalue1234\n');
    for (const bad of ['../outside-secret', 'a/../../outside-secret', '/etc/hosts', '~/x', '.git/config', 'ok/../../x', '']) {
      await assert.rejects(mkWt(r, 'ENG-1', { copyFiles: [bad] }), /copyFiles|escapes|invalid/, `entry ${JSON.stringify(bad)}`);
    }
    assert.equal(existsSync(join(r.root, '.conductor-worktrees')), false, 'nothing was created');
    assert.equal(sgTry(r.dir, ['rev-parse', '--verify', '--quiet', 'refs/heads/conductor/eng-1']).code !== 0, true, 'no branch created');
  });

  it('copyFiles: does not follow symlinks out of the repo', async () => {
    const r = makeRepo();
    writeFileSync(join(r.root, 'real-secret'), 'SECRET=symlinkedvalue1234\n');
    (await import('node:fs')).symlinkSync(join(r.root, 'real-secret'), join(r.dir, '.env.local'));
    const w = await mkWt(r, 'ENG-1', { copyFiles: ['.env.local'] });
    assert.deepEqual(w.copied, []);
    assert.match(w.skipped[0]!.reason, /symlink/);
    assert.equal(existsSync(join(w.path, '.env.local')), false);
  });

  it('rejects unsafe keys and repo names', async () => {
    const r = makeRepo();
    for (const k of ['../evil', 'a/b', '', '-rf', 'x y', 'a..b', 'x.lock']) {
      await assert.rejects(mkWt(r, k), /invalid run key/, k);
    }
    await assert.rejects(createWorktree({ repo: cfg(r, { name: '../x' }), key: 'ENG-1' }), /invalid repo name/);
  });

  it('refuses to adopt a non-empty directory that is not a registered worktree', async () => {
    const r = makeRepo();
    const target = join(r.root, '.conductor-worktrees', 'demo', 'ENG-1');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'precious.txt'), 'x');
    await assert.rejects(mkWt(r, 'ENG-1'), /not a registered worktree/);
    assert.ok(existsSync(join(target, 'precious.txt')));
  });
});

// ───────────────────────────── dependencies ─────────────────────────────

describe('detectSetupCommand / lockfileHash / installDeps', () => {
  const dirWith = (files: Record<string, string>): string => {
    const d = tmpDir('pm');
    for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c);
    return d;
  };

  it('maps lockfiles to frozen installs; null without package.json', async () => {
    assert.equal(await detectSetupCommand(tmpDir()), null);
    assert.equal(await detectSetupCommand(dirWith({ 'package.json': '{}', 'pnpm-lock.yaml': '' })), 'pnpm install --frozen-lockfile');
    assert.equal(await detectSetupCommand(dirWith({ 'package.json': '{}', 'package-lock.json': '{}' })), 'npm ci');
    assert.equal(await detectSetupCommand(dirWith({ 'package.json': '{}', 'npm-shrinkwrap.json': '{}' })), 'npm ci');
    assert.equal(await detectSetupCommand(dirWith({ 'package.json': '{}', 'yarn.lock': '' })), 'yarn install --frozen-lockfile');
    assert.equal(await detectSetupCommand(dirWith({ 'package.json': '{}', 'yarn.lock': '', '.yarnrc.yml': '' })), 'yarn install --immutable');
    assert.equal(await detectSetupCommand(dirWith({ 'package.json': '{}', 'bun.lockb': '' })), 'bun install --frozen-lockfile');
    assert.equal(await detectSetupCommand(dirWith({ 'package.json': '{}', 'bun.lock': '' })), 'bun install --frozen-lockfile');
  });

  it('no lockfile: installs only when there are dependencies, and never writes a lockfile', async () => {
    assert.equal(await detectSetupCommand(dirWith({ 'package.json': '{"name":"x"}' })), null);
    assert.equal(
      await detectSetupCommand(dirWith({ 'package.json': '{"dependencies":{"left-pad":"1.0.0"}}' })),
      'npm install --no-package-lock --no-audit --no-fund',
    );
  });

  it('lockfileHash changes with the lockfile and is stable otherwise', async () => {
    const d = dirWith({ 'package.json': '{}', 'package-lock.json': '{"v":1}' });
    const h1 = await lockfileHash(d);
    assert.equal(await lockfileHash(d), h1);
    writeFileSync(join(d, 'package-lock.json'), '{"v":2}');
    const h2 = await lockfileHash(d);
    assert.notEqual(h1, h2);
    writeFileSync(join(d, 'package.json'), '{"changed":true}');
    assert.equal(await lockfileHash(d), h2, 'package.json alone does not change the lockfile hash');
    assert.match(h1, /^[0-9a-f]{64}$/);
  });

  it('installDeps runs repo.setup with a minimal env + envPassthrough only', async () => {
    const d = tmpDir('inst');
    process.env.MY_PASS_VAR = 'passthrough-value';
    process.env.LINEAR_API_KEY = 'lin_api_' + 'x'.repeat(30);
    try {
      const repo = cfg({ dir: d }, { setup: 'echo "[$MY_PASS_VAR][$LINEAR_API_KEY][$EXPLICIT]" > env.txt; echo installed', envPassthrough: ['MY_PASS_VAR'] });
      const res = await installDeps(d, repo, { env: { EXPLICIT: 'yes' } });
      assert.equal(res.ok, true);
      assert.match(res.output, /installed/);
      assert.equal(readFileSync(join(d, 'env.txt'), 'utf8').trim(), '[passthrough-value][][yes]');
    } finally {
      delete process.env.MY_PASS_VAR;
      delete process.env.LINEAR_API_KEY;
    }
  });

  it('installDeps reports failure, redacts secrets, and honours the timeout', async () => {
    const d = tmpDir('inst');
    const fail = await installDeps(d, cfg({ dir: d }, { setup: `echo "token ${FAKE_TOKEN}" >&2; exit 3` }));
    assert.equal(fail.ok, false);
    assert.match(fail.output, /\[redacted\]/);
    assert.doesNotMatch(fail.output, /ghp_/);

    const slow = await installDeps(d, cfg({ dir: d }, { setup: 'sleep 20' }), { timeoutMs: 200 });
    assert.equal(slow.ok, false);
    assert.match(slow.output, /timed out/);

    const none = await installDeps(d, cfg({ dir: d }));
    assert.deepEqual(none.ok, true);
  });

  it('installDeps redacts exact values from the copied env files', async () => {
    const d = tmpDir('inst');
    writeFileSync(join(d, '.env.local'), 'DB_PASSWORD=correct-horse-battery\n');
    const res = await installDeps(d, cfg({ dir: d }, { setup: 'echo "pw is correct-horse-battery"', copyFiles: ['.env.local'] }));
    assert.equal(res.ok, true);
    assert.doesNotMatch(res.output, /correct-horse-battery/);
  });
});

// ───────────────────────────── commitAll ─────────────────────────────

/** write files into a worktree and commit them through commitAll; resolves to ok. */
async function commitAllIn(wt: string, message: string, files: Record<string, string>): Promise<boolean> {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(wt, f, '..'), { recursive: true });
    writeFileSync(join(wt, f), c);
  }
  const res = await commitAll({ worktree: wt, message });
  return res.ok;
}
const staged = (wt: string): string => sgt(wt, ['diff', '--cached', '--name-only']);
const author = (wt: string): string => sgt(wt, ['log', '-1', '--format=%an <%ae> | %cn <%ce>']);

describe('commit-hygiene: commitAll', () => {
  it('reports "nothing" when there are no changes (and excluded files do not count)', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    writeFileSync(join(w.path, '.conductor', 'plan.md'), 'plan'); // excluded
    mkdirSync(join(w.path, 'node_modules'), { recursive: true });
    writeFileSync(join(w.path, 'node_modules', 'x.js'), 'x');
    const res = await commitAll({ worktree: w.path, message: 'noop' });
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.reason, 'nothing');
  });

  it('commits everything, returns sha + files, and supplies an identity when none is configured', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    assert.notEqual(sgTry(w.path, ['config', '--get', 'user.name']).code, 0, 'precondition: no identity configured');
    writeFileSync(join(w.path, 'a.txt'), 'a');
    mkdirSync(join(w.path, 'dir'));
    writeFileSync(join(w.path, 'dir', 'b.txt'), 'b');
    writeFileSync(join(w.path, 'README.md'), 'changed\n');
    const res = await commitAll({ worktree: w.path, message: 'feat: things\n\nbody line' });
    assert.equal(res.ok, true);
    assert.ok(res.ok);
    assert.equal(res.sha, sgt(w.path, ['rev-parse', 'HEAD']));
    assert.deepEqual(res.files.sort(), ['README.md', 'a.txt', 'dir/b.txt']);
    assert.equal(author(w.path), 'Conductor <conductor@localhost> | Conductor <conductor@localhost>');
    assert.equal(sgt(w.path, ['log', '-1', '--format=%B']), 'feat: things\n\nbody line');
    assert.equal(sgt(w.path, ['status', '--porcelain']), '');
    assert.equal(sgt(w.path, ['rev-parse', 'HEAD~1']), w.baseSha);
  });

  it('uses the configured identity when present and the `identity` option otherwise', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    writeFileSync(join(w.path, 'a.txt'), 'a');
    const bot = await commitAll({ worktree: w.path, message: 'one', identity: { name: 'Bot', email: 'bot@example.test' } });
    assert.ok(bot.ok);
    assert.equal(author(w.path), 'Bot <bot@example.test> | Bot <bot@example.test>');

    r.git(['config', 'user.name', 'Alice']);
    r.git(['config', 'user.email', 'alice@example.test']);
    writeFileSync(join(w.path, 'b.txt'), 'b');
    const alice = await commitAll({ worktree: w.path, message: 'two', identity: { name: 'Bot', email: 'bot@example.test' } });
    assert.ok(alice.ok);
    assert.equal(author(w.path), 'Alice <alice@example.test> | Alice <alice@example.test>');
  });

  it('supplies only the missing half of the identity', async () => {
    const r = makeRepo();
    r.git(['config', 'user.name', 'Alice']);
    const w = await mkWt(r);
    writeFileSync(join(w.path, 'a.txt'), 'a');
    const res = await commitAll({ worktree: w.path, message: 'half' });
    assert.ok(res.ok);
    assert.equal(author(w.path), 'Alice <conductor@localhost> | Alice <conductor@localhost>');
  });

  it('forces commit.gpgsign=false (a repo that signs with a broken gpg still commits)', async () => {
    const r = makeRepo();
    r.git(['config', 'commit.gpgsign', 'true']);
    r.git(['config', 'gpg.program', '/usr/bin/false']);
    const w = await mkWt(r);
    writeFileSync(join(w.path, 'a.txt'), 'a');
    // sanity: a plain `git commit` in this repo really would fail, so the assertion below is meaningful
    sg(w.path, ['add', '-A']);
    assert.notEqual(sgTry(w.path, ['commit', '-q', '-m', 'plain']).code, 0, 'plain git commit must fail with the broken gpg');
    sg(w.path, ['reset', '-q']);
    const res = await commitAll({ worktree: w.path, message: 'unsigned' });
    assert.equal(res.ok, true);
    assert.equal(sgTry(w.path, ['verify-commit', 'HEAD']).code !== 0, true, 'commit is unsigned');
  });

  it('guard: secret-looking content is refused, UNSTAGED, and the secret is not echoed', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    const headBefore = sgt(w.path, ['rev-parse', 'HEAD']);
    writeFileSync(join(w.path, 'src', 'config.js'), `export const token = "${FAKE_TOKEN}";\n`);
    writeFileSync(join(w.path, 'ok.txt'), 'harmless');
    const res = await commitAll({ worktree: w.path, message: 'leak' });
    assert.equal(res.ok, false);
    assert.ok(!res.ok);
    assert.equal(res.reason, 'guard');
    assert.deepEqual(res.files, ['src/config.js']);
    assert.match(res.detail, /src\/config\.js/);
    assert.doesNotMatch(res.detail, /ghp_/);
    assert.equal(sgt(w.path, ['rev-parse', 'HEAD']), headBefore, 'nothing committed');
    assert.equal(staged(w.path), '', 'everything is unstaged again');
    assert.equal(readFileSync(join(w.path, 'src', 'config.js'), 'utf8').includes(FAKE_TOKEN), true, 'working files untouched');
    assert.ok(existsSync(join(w.path, 'ok.txt')));
  });

  it('guard: paths with spaces / non-ASCII characters are reported verbatim', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    const odd = 'docs/my notes ünï.txt';
    mkdirSync(join(w.path, 'docs'), { recursive: true });
    writeFileSync(join(w.path, odd), `token = ${FAKE_TOKEN}\n`);
    const res = await commitAll({ worktree: w.path, message: 'odd' });
    assert.ok(!res.ok);
    assert.equal(res.reason, 'guard');
    assert.deepEqual(res.files, [odd]);
    assert.equal(staged(w.path), '');
  });

  it('guard: PEM private key blocks (multi-line pattern)', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    writeFileSync(join(w.path, 'notes.txt'), '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n');
    const res = await commitAll({ worktree: w.path, message: 'x' });
    assert.ok(!res.ok);
    assert.equal(res.reason, 'guard');
    assert.equal(staged(w.path), '');
  });

  it('guard: .env*, *.pem, id_rsa*, *.key, *.p12 file names are refused (examples/templates are allowed)', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    const bad = ['.env', '.env.production', 'certs/server.pem', 'id_rsa', 'id_rsa.pub', 'deploy/tls.key', 'cert.p12', 'pkg/.envrc'];
    for (const f of bad) {
      mkdirSync(join(w.path, f, '..'), { recursive: true });
      writeFileSync(join(w.path, f), 'harmless content');
    }
    const res = await commitAll({ worktree: w.path, message: 'bad names' });
    assert.ok(!res.ok);
    assert.equal(res.reason, 'guard');
    assert.deepEqual([...res.files!].sort(), [...bad].sort());
    assert.equal(staged(w.path), '');
    // reset the working tree and check that example files go through
    for (const f of bad) (await import('node:fs')).rmSync(join(w.path, f), { force: true });
    writeFileSync(join(w.path, '.env.example'), 'KEY=\n');
    writeFileSync(join(w.path, '.env.local.sample'), 'KEY=\n');
    const ok = await commitAll({ worktree: w.path, message: 'examples' });
    assert.equal(ok.ok, true);
  });

  it('guard: files above maxFileBytes (default 5 MB, configurable) are refused', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    writeFileSync(join(w.path, 'big.bin'), Buffer.alloc(2000, 1));
    writeFileSync(join(w.path, 'small.txt'), 'x');
    const res = await commitAll({ worktree: w.path, message: 'big', maxFileBytes: 1000 });
    assert.ok(!res.ok);
    assert.equal(res.reason, 'guard');
    assert.deepEqual(res.files, ['big.bin']);
    assert.match(res.detail, /too large/);
    assert.equal(staged(w.path), '');

    const def = await commitAll({ worktree: w.path, message: 'under default limit' });
    assert.equal(def.ok, true);

    writeFileSync(join(w.path, 'huge.bin'), Buffer.alloc(5 * 1024 * 1024 + 1, 2));
    const huge = await commitAll({ worktree: w.path, message: 'huge' });
    assert.ok(!huge.ok);
    assert.equal(huge.reason, 'guard');
  });

  it('guard: deleting a tracked secret-named file is not blocked', async () => {
    const r = makeRepo({ files: { 'README.md': 'x', '.env.production': 'LEGACY=1\n' } });
    const w = await mkWt(r);
    (await import('node:fs')).rmSync(join(w.path, '.env.production'));
    const res = await commitAll({ worktree: w.path, message: 'remove committed env file' });
    assert.equal(res.ok, true);
  });

  it('hook failure is reported as reason "hook" with redacted output; HEAD unchanged, nothing staged, never --no-verify', async () => {
    const r = makeRepo();
    writeExecutable(join(r.dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho "lint failed: forbidden word" >&2\necho "leaked ${FAKE_TOKEN}"\nexit 1\n`);
    const w = await mkWt(r);
    const head = sgt(w.path, ['rev-parse', 'HEAD']);
    writeFileSync(join(w.path, 'a.txt'), 'a');
    const res = await commitAll({ worktree: w.path, message: 'hooked' });
    assert.ok(!res.ok);
    assert.equal(res.reason, 'hook');
    assert.match(res.detail, /lint failed: forbidden word/);
    assert.match(res.detail, /\[redacted\]/);
    assert.doesNotMatch(res.detail, /ghp_/);
    assert.equal(sgt(w.path, ['rev-parse', 'HEAD']), head);
    assert.equal(staged(w.path), '');
    assert.ok(existsSync(join(w.path, 'a.txt')));
  });

  it('repo hooks DO run on success, and core.hooksPath is honoured (not overridden)', async () => {
    const r = makeRepo();
    const marker = join(r.root, 'hook-ran');
    writeExecutable(join(r.dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho ran > "${marker}"\nexit 0\n`);
    const w = await mkWt(r);
    writeFileSync(join(w.path, 'a.txt'), 'a');
    assert.equal((await commitAll({ worktree: w.path, message: 'one' })).ok, true);
    assert.ok(existsSync(marker), 'pre-commit hook executed');

    const custom = join(r.root, 'custom-hooks');
    writeExecutable(join(custom, 'pre-commit'), '#!/bin/sh\necho "custom hook rejects" >&2\nexit 1\n');
    r.git(['config', 'core.hooksPath', custom]);
    writeFileSync(join(w.path, 'b.txt'), 'b');
    const res = await commitAll({ worktree: w.path, message: 'two' });
    assert.ok(!res.ok);
    assert.equal(res.reason, 'hook');
    assert.match(res.detail, /custom hook rejects/);
  });

  it('commit-msg hook failures are reported as hook failures too', async () => {
    const r = makeRepo();
    writeExecutable(join(r.dir, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\necho "bad message" >&2\nexit 1\n');
    const w = await mkWt(r);
    writeFileSync(join(w.path, 'a.txt'), 'a');
    const res = await commitAll({ worktree: w.path, message: 'whatever' });
    assert.ok(!res.ok);
    assert.equal(res.reason, 'hook');
    assert.match(res.detail, /bad message/);
  });

  it('a hook that never exits is killed at the commit timeout (whole group) and reported as a hook failure', async () => {
    const r = makeRepo();
    const pidFile = join(r.root, 'hook.pid');
    writeExecutable(join(r.dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho $$ > "${pidFile}"\necho "starting slow hook"\nsleep 60\n`);
    const w = await mkWt(r);
    const head = sgt(w.path, ['rev-parse', 'HEAD']);
    writeFileSync(join(w.path, 'a.txt'), 'a');
    const t0 = Date.now();
    const res = await commitAll({ worktree: w.path, message: 'slow', commitTimeoutMs: 400 });
    assert.ok(Date.now() - t0 < 8000, 'returned promptly');
    assert.ok(!res.ok);
    assert.equal(res.reason, 'hook');
    assert.match(res.detail, /timed out/);
    assert.equal(sgt(w.path, ['rev-parse', 'HEAD']), head);
    assert.equal(staged(w.path), '');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.equal(await waitFor(() => !alive(pid), 3000), true, 'hook process is gone');
  });

  it('reports reason "error" (not hook) for non-hook git failures', async () => {
    const res = await commitAll({ worktree: join(tmpDir(), 'nope'), message: 'x' });
    assert.ok(!res.ok);
    assert.equal(res.reason, 'error');
  });
});

// ───────────────────────────── diff + scope ─────────────────────────────

describe('diffAgainst', () => {
  it('diffs committed + uncommitted + untracked work against the base without touching the real index', async () => {
    const r = makeRepo({ files: { 'README.md': 'line1\nline2\nline3\nline4\nline5\nline6\n', 'src/index.js': 'a\n', 'src/other.js': 'o\n' } });
    const w = await mkWt(r);
    assert.equal(await commitAllIn(w.path, 'c1', { 'src/other.js': 'o changed\n', 'added.txt': 'added\n' }), true);
    writeFileSync(join(w.path, 'src/index.js'), 'a changed\n'); // unstaged modification
    mkdirSync(join(w.path, 'new'), { recursive: true });
    writeFileSync(join(w.path, 'new/untracked.txt'), 'u\n'); // untracked
    (await import('node:fs')).renameSync(join(w.path, 'README.md'), join(w.path, 'docs-README.md')); // rename
    writeFileSync(join(w.path, '.conductor', 'plan.md'), 'excluded');
    const statusBefore = sg(w.path, ['status', '--porcelain=v2']);
    const d = await diffAgainst(w.path, w.baseSha);
    assert.equal(sg(w.path, ['status', '--porcelain=v2']), statusBefore, 'real index/work tree untouched');
    assert.equal(staged(w.path), '', 'nothing staged by diffAgainst');

    const byPath = Object.fromEntries(d.files.map((f) => [f.path, f]));
    assert.equal(byPath['src/other.js']!.status, 'M');
    assert.equal(byPath['added.txt']!.status, 'A');
    assert.equal(byPath['src/index.js']!.status, 'M');
    assert.equal(byPath['new/untracked.txt']!.status, 'A');
    assert.equal(byPath['docs-README.md']!.status, 'R');
    assert.equal(byPath['docs-README.md']!.from, 'README.md');
    assert.equal(byPath['.conductor/plan.md'], undefined, 'excluded files are not part of the diff');
    assert.match(d.patch, /\+\+\+ b\/new\/untracked\.txt/);
    assert.match(d.patch, /\+a changed/);
    assert.match(d.stat, /untracked\.txt/);
    assert.match(d.stat, /files? changed/);
  });

  it('empty diff when nothing changed', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    const d = await diffAgainst(w.path, w.baseSha);
    assert.deepEqual(d.files, []);
    assert.equal(d.patch, '');
  });

  it('caps the patch at 2 MB with a truncation note and redacts secrets', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    const line = 'x'.repeat(99) + '\n';
    writeFileSync(join(w.path, 'big.txt'), line.repeat(30_000)); // ~3 MB
    writeFileSync(join(w.path, 'token.txt'), `const t = "${FAKE_TOKEN}";\n`);
    const d = await diffAgainst(w.path, w.baseSha);
    assert.ok(Buffer.byteLength(d.patch) <= 2 * 1024 * 1024 + 300, `patch is ${Buffer.byteLength(d.patch)} bytes`);
    assert.match(d.patch, /patch truncated at 2 MB/);
    assert.ok(d.files.some((f) => f.path === 'big.txt'));
    assert.doesNotMatch(d.patch, /ghp_/);
  });

  it('rejects option-looking base revisions', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    await assert.rejects(diffAgainst(w.path, '--output=/tmp/x'), /invalid base sha/);
  });
});

describe('diffScopeViolations', () => {
  it('flags protected configuration paths at any depth', () => {
    const files = [
      'src/index.ts',
      '.claude/settings.json',
      'packages/x/.claude/settings.json',
      '.cursor/rules/a.mdc',
      'apps/web/.cursor/cli.json',
      '.mcp.json',
      'packages/y/.mcp.json',
      'AGENTS.md',
      'docs/CLAUDE.md',
      'sub/GEMINI.md',
      '.github/workflows/ci.yml',
      '.husky/pre-commit',
      '.gitignore',
      'pkg/.gitattributes',
      '.gitmodules',
      '.techteam/plans/x.md',
      '.conductor/plan.md',
      'README.md',
      'docs/agents-overview.md',
      'src/claude.md.ts',
    ];
    assert.deepEqual(diffScopeViolations(files, []), [
      '.claude/settings.json',
      'packages/x/.claude/settings.json',
      '.cursor/rules/a.mdc',
      'apps/web/.cursor/cli.json',
      '.mcp.json',
      'packages/y/.mcp.json',
      'AGENTS.md',
      'docs/CLAUDE.md',
      'sub/GEMINI.md',
      '.github/workflows/ci.yml',
      '.husky/pre-commit',
      '.gitignore',
      'pkg/.gitattributes',
      '.gitmodules',
      '.techteam/plans/x.md',
      '.conductor/plan.md',
    ]);
  });

  it('allowedPaths match exactly or as a directory prefix; case-insensitive names; dedupe', () => {
    const files = ['.github/workflows/ci.yml', '.github/CODEOWNERS', 'AGENTS.md', 'agents.md', '.gitignore', '.gitignore'];
    assert.deepEqual(diffScopeViolations(files, ['.github/workflows']), ['.github/CODEOWNERS', 'AGENTS.md', 'agents.md', '.gitignore']);
    assert.deepEqual(diffScopeViolations(files, ['.github/workflows/', 'AGENTS.md', './.gitignore']), ['.github/CODEOWNERS', 'agents.md']);
    assert.deepEqual(diffScopeViolations(files, ['.github']), ['AGENTS.md', 'agents.md', '.gitignore']);
    assert.deepEqual(diffScopeViolations(['.github-extra/x'], ['.github']), ['.github-extra/x'], 'prefix match is per directory, not per string');
    assert.deepEqual(diffScopeViolations([], ['x']), []);
  });
});

// ───────────────────────────── backup refs (C5) + reset ─────────────────────────────

describe('backupRefs + resetToBase (C5)', () => {
  async function dirtyWorktree() {
    const r = makeRepo({ files: { 'README.md': 'readme\n', 'src/index.js': 'a\n' } });
    r.write('.env.local', 'API_SECRET=abcdefgh123456\n');
    const w = await mkWt(r, 'ENG-1', { copyFiles: ['.env.local'] });
    assert.equal(await commitAllIn(w.path, 'builder commit', { 'feature.txt': 'v1\n', 'README.md': 'readme edited\n' }), true);
    const commitA = sgt(w.path, ['rev-parse', 'HEAD']);
    writeFileSync(join(w.path, 'feature.txt'), 'v2 uncommitted\n'); // tracked, unstaged
    writeFileSync(join(w.path, 'staged.txt'), 'staged only\n');
    sg(w.path, ['add', 'staged.txt']); // staged new file
    writeFileSync(join(w.path, 'scratch.txt'), 'untracked work\n'); // untracked
    mkdirSync(join(w.path, 'deep/dir'), { recursive: true });
    writeFileSync(join(w.path, 'deep/dir/note.md'), 'deep untracked\n');
    mkdirSync(join(w.path, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(w.path, 'node_modules/pkg/index.js'), 'ignored dep\n');
    writeFileSync(join(w.path, '.conductor', 'plan.md'), 'the plan\n');
    return { r, w, commitA };
  }

  it('preserves committed AND tracked+staged+untracked work in refs; resetToBase cleans; ignored files survive; fully recoverable', async () => {
    const { r, w, commitA } = await dirtyWorktree();
    const stBefore = sg(w.path, ['status', '--porcelain=v2', '--untracked-files=all']);
    const { headRef, stashRef } = await backupRefs(w.path, 'ENG-1', 1);
    assert.equal(headRef, 'refs/conductor/ENG-1/prev-1');
    assert.equal(stashRef, 'refs/conductor/ENG-1/stash-1');
    assert.equal(sgt(r.dir, ['rev-parse', headRef]), commitA, 'headRef = pre-reset HEAD');
    assert.equal(sg(w.path, ['status', '--porcelain=v2', '--untracked-files=all']), stBefore, 'backupRefs does not touch the work tree or index');
    const parents = sgt(r.dir, ['rev-list', '--parents', '-n', '1', stashRef!]).split(' ');
    assert.equal(parents.length, 4, 'stash-format commit: itself + HEAD + index + untracked parents');
    assert.equal(parents[1], commitA);

    await resetToBase(w.path, w.baseSha);
    assert.equal(sgt(w.path, ['rev-parse', 'HEAD']), w.baseSha);
    assert.equal(sgt(w.path, ['status', '--porcelain']), '', 'clean after reset');
    for (const gone of ['feature.txt', 'staged.txt', 'scratch.txt', 'deep/dir/note.md']) assert.equal(existsSync(join(w.path, gone)), false, gone);
    assert.equal(readFileSync(join(w.path, 'README.md'), 'utf8'), 'readme\n');
    // ignored files survive
    assert.equal(readFileSync(join(w.path, 'node_modules/pkg/index.js'), 'utf8'), 'ignored dep\n');
    assert.equal(readFileSync(join(w.path, '.conductor/plan.md'), 'utf8'), 'the plan\n');
    assert.equal(readFileSync(join(w.path, '.env.local'), 'utf8'), 'API_SECRET=abcdefgh123456\n');

    // recovery (documented procedure): return to the committed work, then re-apply the stash
    sg(w.path, ['reset', '--hard', '-q', headRef]);
    assert.equal(readFileSync(join(w.path, 'feature.txt'), 'utf8'), 'v1\n');
    sg(w.path, ['stash', 'apply', '-q', stashRef!]);
    assert.equal(readFileSync(join(w.path, 'feature.txt'), 'utf8'), 'v2 uncommitted\n', 'tracked uncommitted change recovered');
    assert.equal(readFileSync(join(w.path, 'staged.txt'), 'utf8'), 'staged only\n', 'staged file recovered');
    assert.equal(readFileSync(join(w.path, 'scratch.txt'), 'utf8'), 'untracked work\n', 'UNTRACKED file recovered');
    assert.equal(readFileSync(join(w.path, 'deep/dir/note.md'), 'utf8'), 'deep untracked\n', 'nested untracked file recovered');
    assert.equal(sgt(w.path, ['rev-parse', 'HEAD']), commitA);
  });

  it('only untracked work (no tracked changes) is still backed up and recoverable', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    writeFileSync(join(w.path, 'only-untracked.txt'), 'precious\n');
    const { headRef, stashRef } = await backupRefs(w.path, 'ENG-1', 2);
    assert.equal(sgt(r.dir, ['rev-parse', headRef]), w.baseSha);
    assert.ok(stashRef);
    assert.equal(sgt(r.dir, ['show', `${stashRef}^3:only-untracked.txt`]), 'precious');
    await resetToBase(w.path, w.baseSha);
    assert.equal(existsSync(join(w.path, 'only-untracked.txt')), false);
    sg(w.path, ['stash', 'apply', '-q', stashRef!]);
    assert.equal(readFileSync(join(w.path, 'only-untracked.txt'), 'utf8'), 'precious\n');
  });

  it('only tracked changes: a plain stash commit (2 parents)', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    writeFileSync(join(w.path, 'README.md'), 'edited\n');
    const { stashRef } = await backupRefs(w.path, 'ENG-1', 1);
    assert.ok(stashRef);
    assert.equal(sgt(r.dir, ['rev-list', '--parents', '-n', '1', stashRef!]).split(' ').length, 3);
    await resetToBase(w.path, w.baseSha);
    sg(w.path, ['stash', 'apply', '-q', stashRef!]);
    assert.equal(readFileSync(join(w.path, 'README.md'), 'utf8'), 'edited\n');
  });

  it('clean tree ⇒ headRef only (stashRef null); ignored-only changes do not count as dirty', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    mkdirSync(join(w.path, 'node_modules'), { recursive: true });
    writeFileSync(join(w.path, 'node_modules/x.js'), 'x');
    writeFileSync(join(w.path, '.conductor', 'plan.md'), 'p');
    const res = await backupRefs(w.path, 'ENG-1', 1);
    assert.equal(res.stashRef, null);
    assert.equal(sgt(r.dir, ['rev-parse', res.headRef]), w.baseSha);
  });

  it('is idempotent for the same state and never clobbers a different earlier backup', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    writeFileSync(join(w.path, 'a.txt'), 'first\n');
    const one = await backupRefs(w.path, 'ENG-1', 1);
    const again = await backupRefs(w.path, 'ENG-1', 1);
    assert.deepEqual(again, one, 'same state ⇒ same ref names');
    const firstStash = sgt(r.dir, ['rev-parse', one.stashRef!]);

    writeFileSync(join(w.path, 'a.txt'), 'second\n');
    const two = await backupRefs(w.path, 'ENG-1', 1);
    assert.equal(two.headRef, one.headRef, 'same HEAD ⇒ same headRef');
    assert.notEqual(two.stashRef, one.stashRef);
    assert.equal(two.stashRef, 'refs/conductor/ENG-1/stash-1-2');
    assert.equal(sgt(r.dir, ['rev-parse', one.stashRef!]), firstStash, 'earlier stash untouched');

    await commitAllIn(w.path, 'moved head', { 'b.txt': 'b' });
    const three = await backupRefs(w.path, 'ENG-1', 1);
    assert.equal(three.headRef, 'refs/conductor/ENG-1/prev-1-2');
    assert.equal(sgt(r.dir, ['rev-parse', one.headRef]), w.baseSha);
  });

  it('resetToCommit resets to an intermediate commit and discards uncommitted work', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    await commitAllIn(w.path, 'c1', { 'one.txt': '1' });
    const c1 = sgt(w.path, ['rev-parse', 'HEAD']);
    await commitAllIn(w.path, 'c2', { 'two.txt': '2' });
    writeFileSync(join(w.path, 'junk.txt'), 'junk');
    writeFileSync(join(w.path, 'one.txt'), 'dirty');
    await resetToCommit(w.path, c1);
    assert.equal(sgt(w.path, ['rev-parse', 'HEAD']), c1);
    assert.equal(sgt(w.path, ['status', '--porcelain']), '');
    assert.equal(existsSync(join(w.path, 'two.txt')), false);
    assert.equal(readFileSync(join(w.path, 'one.txt'), 'utf8'), '1');
    await assert.rejects(resetToCommit(w.path, '--hard'), /invalid commit/);
    await assert.rejects(resetToCommit(w.path, 'deadbeefdeadbeefdeadbeef'), /cannot resolve/);
  });

  it('rejects invalid keys / revs', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    await assert.rejects(backupRefs(w.path, '../x', 1), /invalid run key/);
    await assert.rejects(backupRefs(w.path, 'ENG-1', -1), /invalid rev/);
    await assert.rejects(backupRefs(w.path, 'ENG-1', 1.5), /invalid rev/);
  });
});

// ───────────────────────────── removeWorktree ─────────────────────────────

describe('removeWorktree', () => {
  it('removes the directory (even with ignored files) and keeps the branch unless asked', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    mkdirSync(join(w.path, 'node_modules'), { recursive: true });
    writeFileSync(join(w.path, 'node_modules/x.js'), 'x');
    await removeWorktree(r.dir, w.path, w.branch);
    assert.equal(existsSync(w.path), false);
    assert.equal(sgTry(r.dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${w.branch}`]).code, 0, 'branch kept');
    assert.equal((await listWorktrees(r.dir)).length, 1);
  });

  it('deleteBranch removes a fully merged branch; refuses an unmerged one unless force', async () => {
    const r = makeRepo();
    const merged = await mkWt(r, 'ENG-1');
    await removeWorktree(r.dir, merged.path, merged.branch, { deleteBranch: true });
    assert.notEqual(sgTry(r.dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${merged.branch}`]).code, 0);

    const unmerged = await mkWt(r, 'ENG-2');
    await commitAllIn(unmerged.path, 'unmerged work', { 'w.txt': 'w' });
    await assert.rejects(removeWorktree(r.dir, unmerged.path, unmerged.branch, { deleteBranch: true }), /not fully merged|failed/);
    assert.equal(sgTry(r.dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${unmerged.branch}`]).code, 0, 'unmerged branch kept');
    await removeWorktree(r.dir, unmerged.path, unmerged.branch, { deleteBranch: true, force: true });
    assert.notEqual(sgTry(r.dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${unmerged.branch}`]).code, 0);
  });

  it('refuses the main working tree, unregistered directories and non-conductor branches', async () => {
    const r = makeRepo();
    await assert.rejects(removeWorktree(r.dir, r.dir, 'conductor/x'), /main working tree/);
    const stray = tmpDir('stray');
    writeFileSync(join(stray, 'keep.txt'), 'keep');
    await assert.rejects(removeWorktree(r.dir, stray, 'conductor/x'), /not a registered worktree/);
    assert.ok(existsSync(join(stray, 'keep.txt')));
    const w = await mkWt(r);
    await assert.rejects(removeWorktree(r.dir, w.path, 'main', { deleteBranch: true }), /non-conductor branch/);
  });
});

// ───────────────────────────── scanAncestors ─────────────────────────────

describe('scanAncestors', () => {
  it('finds instruction files/dirs in every ancestor, never in the path itself', async () => {
    const base = tmpDir('anc');
    const deep = join(base, 'a', 'b', 'c', 'repo');
    mkdirSync(deep, { recursive: true });
    const plant = (rel: string, dir = false): string => {
      const p = join(base, rel);
      if (dir) mkdirSync(p, { recursive: true });
      else {
        mkdirSync(join(p, '..'), { recursive: true });
        writeFileSync(p, 'x');
      }
      return p;
    };
    const expected = [
      plant('AGENTS.md'),
      plant('a/CLAUDE.md'),
      plant('a/CLAUDE.local.md'),
      plant('a/b/GEMINI.md'),
      plant('a/b/.claude/rules', true),
      plant('a/b/c/.cursor/rules', true),
      plant('a/b/c/AGENTS.md'),
    ];
    plant('a/b/c/repo/AGENTS.md'); // inside `path` itself: must NOT be reported
    plant('a/b/c/repo/CLAUDE.md');
    plant('a/b/c/repo/.cursor/rules', true);
    plant('a/unrelated.md');
    plant('a/b/.claude/settings.json'); // .claude but not rules
    const found = (await scanAncestors(deep)).filter((p) => p.startsWith(base + '/'));
    assert.deepEqual([...found].sort(), [...expected].sort());
    for (const p of found) assert.ok(p.startsWith('/'), 'absolute paths');
    assert.equal(found.some((p) => p.startsWith(deep + '/')), false);
  });

  it('works for a non-existent path (uses the deepest existing ancestor chain)', async () => {
    const base = tmpDir('anc2');
    writeFileSync(join(base, 'AGENTS.md'), 'x');
    const found = (await scanAncestors(join(base, 'does', 'not', 'exist'))).filter((p) => p.startsWith(base + '/'));
    assert.deepEqual(found, [join(base, 'AGENTS.md')]);
  });
});

// ───────────────────────────── agentGitEnv ─────────────────────────────

describe('agentGitEnv', () => {
  const count = (env: Record<string, string>): number => Number(env.GIT_CONFIG_COUNT);
  const pairs = (env: Record<string, string>): [string, string][] =>
    [...Array(count(env)).keys()].map((i) => [env[`GIT_CONFIG_KEY_${i}`]!, env[`GIT_CONFIG_VALUE_${i}`]!]);

  it('0 remotes: only the credential.helper blank', async () => {
    const r = makeRepo();
    const env = await agentGitEnv(r.dir);
    assert.equal(env.GIT_CONFIG_COUNT, '1');
    assert.deepEqual(pairs(env), [['credential.helper', '']]);
    assert.equal(env.GIT_CONFIG_KEY_1, undefined);
    assert.equal(env.GIT_SSH_COMMAND, '/usr/bin/false');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  });

  it('1 and 3 remotes: one pushurl per remote + credential.helper; count is exact', async () => {
    const r = makeRepo({ withRemote: true });
    const one = await agentGitEnv(r.dir);
    assert.equal(one.GIT_CONFIG_COUNT, '2');
    assert.deepEqual(pairs(one), [
      ['remote.origin.pushurl', 'conductor-push-disabled://'],
      ['credential.helper', ''],
    ]);

    r.git(['remote', 'add', 'backup', makeBareRemote()]);
    r.git(['remote', 'add', 'up.stream', makeBareRemote()]);
    const three = await agentGitEnv(r.dir);
    assert.equal(three.GIT_CONFIG_COUNT, '4');
    const ps = pairs(three);
    assert.equal(ps.length, 4);
    assert.deepEqual(
      ps.filter(([k]) => k.endsWith('.pushurl')).map(([k]) => k).sort(),
      ['remote.backup.pushurl', 'remote.origin.pushurl', 'remote.up.stream.pushurl'],
    );
    assert.ok(ps.every(([k, v]) => (k.endsWith('.pushurl') ? v === 'conductor-push-disabled://' : k === 'credential.helper' && v === '')));
    assert.equal(three.GIT_CONFIG_KEY_4, undefined);
  });

  it('adversarial: with the env, pushes to NAMED remotes and ssh URLs fail; an explicit LOCAL PATH push still succeeds (documented limit)', async () => {
    const r = makeRepo({ withRemote: true });
    const backup = makeBareRemote();
    const explicitTarget = makeBareRemote();
    const control = makeBareRemote();
    r.git(['remote', 'add', 'backup', backup]);
    r.git(['checkout', '-q', '-b', 'feature']);
    r.write('feature.txt', 'feature work\n');
    r.commit('feature work');
    const originRefs = refsOf(r.remote!);
    const backupRefsBefore = refsOf(backup);

    // control: without the env the very same push works, so the failures below are caused by the env
    const ctl = await git(r.dir, ['push', '-q', control, 'feature']);
    assert.equal(ctl.code, 0, ctl.stderr);
    assert.match(refsOf(control), /refs\/heads\/feature /);

    const env = await agentGitEnv(r.dir);
    const named = await git(r.dir, ['push', 'origin', 'feature'], { env, timeoutMs: 15_000 });
    assert.notEqual(named.code, 0, 'push to the named remote must fail');
    assert.match(named.stderr, /conductor-push-disabled|remote helper/);
    const other = await git(r.dir, ['push', 'backup', 'feature'], { env, timeoutMs: 15_000 });
    assert.notEqual(other.code, 0);
    const bare = await git(r.dir, ['push'], { env, timeoutMs: 15_000 });
    assert.notEqual(bare.code, 0, 'plain `git push` (upstream remote) must fail');
    const ssh = await git(r.dir, ['push', 'ssh://git@localhost/none.git', 'feature'], { env, timeoutMs: 15_000 });
    assert.notEqual(ssh.code, 0, 'explicit ssh URL: GIT_SSH_COMMAND=/usr/bin/false');
    assert.equal(refsOf(r.remote!), originRefs, 'origin untouched');
    assert.equal(refsOf(backup), backupRefsBefore, 'backup untouched');

    // HONEST LIMIT: an explicit URL that is a LOCAL PATH bypasses remote.<name>.pushurl, and local transport needs no
    // credentials or ssh. The env alone cannot stop it — the `Shell(git:push*)` deny rule in .cursor/cli.json is that layer.
    const explicit = await git(r.dir, ['push', '-q', explicitTarget, 'feature'], { env, timeoutMs: 15_000 });
    assert.equal(explicit.code, 0, `expected the documented hole to be real: ${explicit.stderr}`);
    assert.match(refsOf(explicitTarget), /refs\/heads\/feature /);
  });
});

// ───────────────────────────── Cursor deny-rule guard ─────────────────────────────

describe('writeCursorGuard / checkCursorGuard', () => {
  it('writes the exact deny file once, git-excludes it, and returns its sha256', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    const g = await writeCursorGuard(w.path);
    assert.equal(g.written, true);
    assert.equal(g.envOnly, false);
    const file = join(w.path, '.cursor', 'cli.json');
    const text = readFileSync(file, 'utf8');
    assert.equal(
      text,
      JSON.stringify({ permissions: { allow: [], deny: CURSOR_GUARD_DENY } }),
    );
    assert.equal(text, CURSOR_GUARD_JSON);
    const parsed = JSON.parse(text) as { permissions: { allow: unknown[]; deny: string[] } };
    assert.deepEqual(parsed.permissions.allow, [], '`allow` MUST be present and empty');
    assert.equal(g.sha256, (await import('node:crypto')).createHash('sha256').update(text).digest('hex'));
    assert.equal(sgt(w.path, ['status', '--porcelain']), '', 'cli.json is git-excluded');
    assert.equal(sgt(r.dir, ['status', '--porcelain']), '');
    assert.match(readFileSync(join(r.dir, '.git/info/exclude'), 'utf8'), /^\/\.cursor\/cli\.json$/m);
    assert.deepEqual(await checkCursorGuard(w.path, g.sha256), { ok: true, detail: 'cli.json deny rule unchanged' });
  });

  it('re-entry with our own unchanged file keeps the guard (build loop 2)', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    const first = await writeCursorGuard(w.path);
    const second = await writeCursorGuard(w.path);
    // M7: the file is REWRITTEN on every build (never trusted from a previous loop) — same bytes, same hash
    assert.deepEqual(second, { written: true, envOnly: false, sha256: first.sha256 });
  });

  it('a tampered untracked copy is replaced by the exact deny file on the next build (M7)', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    const first = await writeCursorGuard(w.path);
    writeFileSync(join(w.path, '.cursor', 'cli.json'), '{"permissions":{"allow":["Shell(git:push*)"],"deny":[]}}');
    const second = await writeCursorGuard(w.path);
    assert.equal(second.sha256, first.sha256);
    assert.equal(readFileSync(join(w.path, '.cursor', 'cli.json'), 'utf8'), CURSOR_GUARD_JSON);
  });

  it('never writes through a symlink planted at .cursor (M9)', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    const outside = mkdtempSync(join(tmpdir(), 'cond-outside-'));
    symlinkSync(outside, join(w.path, '.cursor'));
    await writeCursorGuard(w.path);
    assert.equal(existsSync(join(outside, 'cli.json')), false, 'nothing was written through the link');
    assert.equal(readFileSync(join(w.path, '.cursor', 'cli.json'), 'utf8'), CURSOR_GUARD_JSON);
  });

  it('an existing UNTRACKED .cursor/cli.json is replaced by ours (it cannot be the repo\'s own file)', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    mkdirSync(join(w.path, '.cursor'), { recursive: true });
    writeFileSync(join(w.path, '.cursor', 'cli.json'), '{"permissions":{"allow":["Shell(ls)"],"deny":[]}}');
    const g = await writeCursorGuard(w.path);
    assert.equal(g.written, true);
    assert.equal(g.envOnly, false);
    assert.equal(readFileSync(join(w.path, '.cursor', 'cli.json'), 'utf8'), CURSOR_GUARD_JSON);
    assert.equal((await checkCursorGuard(w.path, g.sha256)).ok, true);
  });

  it('a TRACKED .cursor/cli.json ⇒ env-only and untouched', async () => {
    const r = makeRepo({ files: { 'README.md': 'x', '.cursor/cli.json': '{"permissions":{"allow":[],"deny":[]}}' } });
    const w = await mkWt(r);
    const g = await writeCursorGuard(w.path);
    assert.deepEqual(g, { written: false, envOnly: true, sha256: null });
    assert.equal(readFileSync(join(w.path, '.cursor', 'cli.json'), 'utf8'), '{"permissions":{"allow":[],"deny":[]}}');
    assert.equal(sgt(w.path, ['status', '--porcelain']), '');
  });

  it('hash guard detects an edit and a deletion', async () => {
    const r = makeRepo();
    const w = await mkWt(r);
    const g = await writeCursorGuard(w.path);
    assert.equal((await checkCursorGuard(w.path, g.sha256)).ok, true);

    const file = join(w.path, '.cursor', 'cli.json');
    writeFileSync(file, '{"permissions":{"allow":["Shell(git:push*)"],"deny":[]}}');
    const edited = await checkCursorGuard(w.path, g.sha256);
    assert.equal(edited.ok, false);
    assert.match(edited.detail, /modified/);

    (await import('node:fs')).rmSync(file);
    const deleted = await checkCursorGuard(w.path, g.sha256);
    assert.equal(deleted.ok, false);
    assert.match(deleted.detail, /missing/);

    writeFileSync(file, CURSOR_GUARD_JSON);
    assert.equal((await checkCursorGuard(w.path, g.sha256)).ok, true, 'restoring the exact bytes passes');
    assert.equal((await checkCursorGuard(w.path, null)).ok, true, 'no sha expected ⇒ nothing to check');
  });
});
