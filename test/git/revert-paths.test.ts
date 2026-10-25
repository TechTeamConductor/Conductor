// C2: revertPathsTo puts out-of-scope paths back to the attempt base inside a Conductor-created worktree, and refuses what it cannot do safely.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { revertPathsTo } from '../../src/git/worktree.ts';
import { isolateGitHome, makeRepo, sg, sgt, tmpDir } from '../helpers/tmp-repo.ts';

isolateGitHome();

function setup(files: Record<string, string> = { 'README.md': 'r\n', '.github/ci.yml': 'ci: 1\n', 'src/a.txt': 'a\n' }) {
  const r = makeRepo({ files });
  const base = r.head();
  const wt = join(tmpDir('wt'), 'build');
  sg(r.dir, ['worktree', 'add', '--detach', wt, base]);
  const w = (rel: string, c: string) => {
    sg(wt, ['config', 'user.name', 'Dev']);
    sg(wt, ['config', 'user.email', 'dev@example.test']);
    return require_write(wt, rel, c);
  };
  const commit = (m: string) => {
    sg(wt, ['add', '-A']);
    sg(wt, ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.test', 'commit', '-q', '-m', m]);
  };
  return { r, base, wt, w, commit };
}
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
function require_write(root: string, rel: string, c: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, c);
}

describe('revertPathsTo', () => {
  it('removes an added file, restores a modified and a deleted file, leaves in-scope work alone', async () => {
    const { r, base, wt, w, commit } = setup({ 'README.md': 'r\n', '.github/ci.yml': 'ci: 1\n', '.github/keep.yml': 'k: 1\n', 'src/a.txt': 'a\n' });
    w('.github/new.yml', 'n\n');
    w('.github/ci.yml', 'ci: 2\n');
    sg(wt, ['rm', '-q', '.github/keep.yml']);
    w('src/a.txt', 'changed\n');
    commit('build');
    const res = await revertPathsTo(wt, base, ['.github/new.yml', '.github/ci.yml', '.github/keep.yml'], { repoRoot: r.dir });
    assert.equal(res.ok, true, res.ok ? '' : res.detail);
    sg(wt, ['-c', 'user.name=Dev', '-c', 'user.email=d@e.test', 'commit', '-q', '-m', 'revert']);
    assert.equal(existsSync(join(wt, '.github/new.yml')), false);
    assert.equal(readFileSync(join(wt, '.github/ci.yml'), 'utf8'), 'ci: 1\n');
    assert.equal(readFileSync(join(wt, '.github/keep.yml'), 'utf8'), 'k: 1\n');
    assert.equal(readFileSync(join(wt, 'src/a.txt'), 'utf8'), 'changed\n');
    assert.equal(sgt(wt, ['diff', '--name-only', base, 'HEAD']), 'src/a.txt');
  });

  it('a rename into a protected path restores the source and removes the target', async () => {
    const { r, base, wt, commit } = setup({ 'tool.txt': 'one\ntwo\nthree\nfour\nfive\n', 'README.md': 'r\n' });
    mkdirSync(join(wt, '.github'), { recursive: true });
    sg(wt, ['mv', 'tool.txt', '.github/tool.txt']);
    commit('move');
    const res = await revertPathsTo(wt, base, ['.github/tool.txt'], { repoRoot: r.dir });
    assert.equal(res.ok, true, res.ok ? '' : res.detail);
    assert.equal(existsSync(join(wt, 'tool.txt')), true);
    assert.equal(existsSync(join(wt, '.github/tool.txt')), false);
  });

  it('a rename out of a protected path restores the source and removes the target', async () => {
    const { r, base, wt, commit } = setup({ '.github/tool.txt': 'one\ntwo\nthree\nfour\nfive\n', 'README.md': 'r\n' });
    sg(wt, ['mv', '.github/tool.txt', 'moved.txt']);
    commit('move');
    const res = await revertPathsTo(wt, base, ['.github/tool.txt'], { repoRoot: r.dir });
    assert.equal(res.ok, true, res.ok ? '' : res.detail);
    assert.equal(existsSync(join(wt, '.github/tool.txt')), true);
    assert.equal(existsSync(join(wt, 'moved.txt')), false);
  });

  it('refuses a symlink and changes nothing', async () => {
    const { r, base, wt, commit } = setup();
    symlinkSync('/etc/passwd', join(wt, '.github', 'link.yml'));
    commit('link');
    const before = sgt(wt, ['rev-parse', 'HEAD^{tree}']);
    const res = await revertPathsTo(wt, base, ['.github/link.yml'], { repoRoot: r.dir });
    assert.equal(res.ok, false);
    assert.equal(lstatSync(join(wt, '.github/link.yml')).isSymbolicLink(), true);
    assert.equal(sgt(wt, ['write-tree']), before);
  });

  it('refuses a submodule link (gitlink)', async () => {
    const { r, base, wt } = setup();
    sg(wt, ['update-index', '--add', '--cacheinfo', `160000,${base},.github/mod`]);
    sg(wt, ['-c', 'user.name=Dev', '-c', 'user.email=d@e.test', 'commit', '-q', '-m', 'gitlink']);
    const res = await revertPathsTo(wt, base, ['.github/mod'], { repoRoot: r.dir });
    assert.equal(res.ok, false);
  });

  it('refuses the repository checkout itself', async () => {
    const r = makeRepo();
    const base = r.head();
    r.write('.github/x.yml', 'x\n');
    r.commit('x');
    const res = await revertPathsTo(r.dir, base, ['.github/x.yml'], { repoRoot: r.dir });
    assert.equal(res.ok, false);
    assert.equal(existsSync(join(r.dir, '.github/x.yml')), true);
  });

  it('refuses odd paths: parent traversal, .git, absolute, a path that was not part of the build', async () => {
    const { r, base, wt, w, commit } = setup();
    w('.github/x.yml', 'x\n');
    commit('x');
    for (const bad of ['../outside', '.git/config', '/etc/hosts', '.github/not-changed.yml']) {
      const res = await revertPathsTo(wt, base, [bad], { repoRoot: r.dir });
      assert.equal(res.ok, false, bad);
    }
    assert.equal(existsSync(join(wt, '.github/x.yml')), true);
  });
});
