// Security F3 (resetToCommit never touches a repository's own checkout) and F4/M2 (mergeOntoCurrent reports the build's commit, never HEAD).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainCheckout, mergeOntoCurrent, resetToBase, resetToCommit } from '../../src/git/worktree.ts';
import { isolateGitHome, makeRepo, sg, sgt, tmpDir } from '../helpers/tmp-repo.ts';

isolateGitHome();

describe('F3: resetToCommit refuses the repository checkout itself', () => {
  it('leaves untracked files, edits and the person’s newer commit alone, and says why', async () => {
    const r = makeRepo();
    const base = r.head();
    sg(r.dir, ['config', 'user.name', 'Dev One']);
    sg(r.dir, ['config', 'user.email', 'dev@example.test']);
    r.write('mine.txt', 'my own commit\n');
    r.commit('mine');
    const mine = r.head();
    r.write('untracked.txt', 'precious\n');
    r.write('README.md', '# edited, not committed\n');
    assert.equal(await isMainCheckout(r.dir), true);
    await assert.rejects(resetToCommit(r.dir, base), /refusing to reset or clean/);
    await assert.rejects(resetToBase(r.dir, base), /refusing to reset or clean/);
    assert.equal(r.head(), mine, 'HEAD did not move');
    assert.equal(readFileSync(join(r.dir, 'untracked.txt'), 'utf8'), 'precious\n');
    assert.equal(readFileSync(join(r.dir, 'README.md'), 'utf8'), '# edited, not committed\n');
  });

  it('still resets a linked worktree that Conductor created', async () => {
    const r = makeRepo();
    const base = r.head();
    const wt = join(tmpDir('wt'), 'b');
    sg(r.dir, ['worktree', 'add', '--detach', wt, base]);
    r.write('x.txt', 'x\n');
    assert.equal(await isMainCheckout(wt), false);
    sg(wt, ['-c', 'user.name=D', '-c', 'user.email=d@example.test', 'commit', '-q', '--allow-empty', '-m', 'c']);
    await resetToCommit(wt, base);
    assert.equal(sgt(wt, ['rev-parse', 'HEAD']), base);
    assert.equal(existsSync(join(r.dir, 'x.txt')), true, 'the main checkout was not touched');
  });
});

describe('F4/M2: mergeOntoCurrent reports the build’s commit, never the checkout HEAD', () => {
  function built() {
    const r = makeRepo();
    sg(r.dir, ['config', 'user.name', 'Dev One']);
    sg(r.dir, ['config', 'user.email', 'dev@example.test']);
    r.write('feature.txt', 'f\n');
    const sha = r.commit('build');
    return { r, sha };
  }

  it('a commit that is already an ancestor, with the person’s commit on top, returns that commit', async () => {
    const { r, sha } = built();
    r.write('mine.txt', 'mine\n');
    r.commit('person on top');
    const head = r.head();
    assert.notEqual(head, sha);
    const res = await mergeOntoCurrent(r.dir, sha);
    assert.deepEqual(res, { ok: true, sha });
    assert.equal(r.head(), head);
  });

  it('an empty cherry-pick (changes already present) returns the build commit, not the person’s HEAD', async () => {
    const r = makeRepo();
    sg(r.dir, ['config', 'user.name', 'Dev One']);
    sg(r.dir, ['config', 'user.email', 'dev@example.test']);
    sg(r.dir, ['checkout', '-q', '-b', 'side']);
    r.write('same.txt', 'same\n');
    const sha = r.commit('build');
    sg(r.dir, ['checkout', '-q', 'main']);
    r.write('same.txt', 'same\n');
    r.commit('person did the same thing');
    r.write('other.txt', 'o\n');
    r.commit('and more');
    const head = r.head();
    const res = await mergeOntoCurrent(r.dir, sha);
    assert.deepEqual(res, { ok: true, sha });
    assert.equal(r.head(), head);
  });
});
