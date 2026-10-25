// C3: the local merge is blocked only by dirt that can actually collide with what the build changes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirtCollides, mergeOntoCurrent, parsePorcelainZ } from '../../src/git/worktree.ts';
import { isolateGitHome, makeRepo, sg, sgt } from '../helpers/tmp-repo.ts';

isolateGitHome();

/** A commit made on a side branch from the current HEAD; the repo is left on main, clean. */
function side(r: ReturnType<typeof makeRepo>, edit: (r: ReturnType<typeof makeRepo>) => void, branch = 'side'): string {
  sg(r.dir, ['config', 'user.name', 'Dev One']);
  sg(r.dir, ['config', 'user.email', 'dev@example.test']);
  sg(r.dir, ['checkout', '-q', '-b', branch]);
  edit(r);
  const sha = r.commit('build');
  sg(r.dir, ['checkout', '-q', 'main']);
  return sha;
}

describe('C3 collision-aware local merge', () => {
  it('an unrelated untracked file does not block, and is left untouched', async () => {
    const r = makeRepo();
    const sha = side(r, (x) => x.write('feature.txt', 'f\n'));
    r.write('.techteam/project/growth/notes.md', 'mine\n');
    const res = await mergeOntoCurrent(r.dir, sha);
    assert.equal(res.ok, true);
    assert.equal(readFileSync(join(r.dir, '.techteam/project/growth/notes.md'), 'utf8'), 'mine\n');
    assert.equal(existsSync(join(r.dir, 'feature.txt')), true);
  });

  it('an unrelated unstaged edit to a tracked file does not block', async () => {
    const r = makeRepo();
    const sha = side(r, (x) => x.write('feature.txt', 'f\n'));
    r.write('README.md', '# edited by me\n');
    const res = await mergeOntoCurrent(r.dir, sha);
    assert.equal(res.ok, true);
    assert.equal(readFileSync(join(r.dir, 'README.md'), 'utf8'), '# edited by me\n');
  });

  it('a dirty file the commit also modifies blocks and names the path', async () => {
    const r = makeRepo();
    const sha = side(r, (x) => x.write('README.md', '# build\n'));
    r.write('README.md', '# mine\n');
    const res = await mergeOntoCurrent(r.dir, sha);
    assert.equal(res.ok, false);
    assert.match(res.ok ? '' : res.detail, /README\.md/);
    assert.equal(readFileSync(join(r.dir, 'README.md'), 'utf8'), '# mine\n');
  });

  it('an untracked file at a path the commit adds blocks', async () => {
    const r = makeRepo();
    const sha = side(r, (x) => x.write('new.txt', 'b\n'));
    r.write('new.txt', 'mine\n');
    const res = await mergeOntoCurrent(r.dir, sha);
    assert.equal(res.ok, false);
    assert.match(res.ok ? '' : res.detail, /new\.txt/);
  });

  it('file vs directory collisions block in both directions', async () => {
    const r = makeRepo();
    const addsDir = side(r, (x) => x.write('a/b.txt', 'b\n'), 's1');
    r.write('a', 'a file where the build wants a directory\n');
    const one = await mergeOntoCurrent(r.dir, addsDir);
    assert.equal(one.ok, false);
    assert.match(one.ok ? '' : one.detail, /"a"/);
    const r2 = makeRepo();
    const addsFile = side(r2, (x) => x.write('d', 'file\n'), 's2');
    mkdirSync(join(r2.dir, 'd'));
    writeFileSync(join(r2.dir, 'd', 'mine.txt'), 'mine\n');
    const two = await mergeOntoCurrent(r2.dir, addsFile);
    assert.equal(two.ok, false);
    assert.match(two.ok ? '' : two.detail, /d\/mine\.txt/);
  });

  it('a staged change blocks even when unrelated', async () => {
    const r = makeRepo();
    const sha = side(r, (x) => x.write('feature.txt', 'f\n'));
    r.write('other.txt', 'staged\n');
    sg(r.dir, ['add', 'other.txt']);
    const res = await mergeOntoCurrent(r.dir, sha);
    assert.equal(res.ok, false);
    assert.match(res.ok ? '' : res.detail, /other\.txt/);
  });

  it('a case variant of an incoming path is a collision', () => {
    const entries = parsePorcelainZ('?? Docs/Readme.MD\0');
    assert.equal(dirtCollides(entries, new Set(['docs/readme.md'])), 'Docs/Readme.MD');
  });

  it('NFC and NFD spellings of the same path collide', () => {
    const nfd = 'café.txt';
    const nfc = 'café.txt';
    assert.equal(dirtCollides(parsePorcelainZ(`?? ${nfd}\0`), new Set([nfc])), nfd);
  });

  it('a modified file that the commit renames away blocks (rename source)', async () => {
    const r = makeRepo({ files: { 'old.txt': 'one\ntwo\nthree\nfour\n', 'README.md': 'x\n' } });
    const sha = side(r, (x) => {
      sg(x.dir, ['mv', 'old.txt', 'renamed.txt']);
    });
    r.write('old.txt', 'one\ntwo\nthree\nFOUR mine\n');
    const res = await mergeOntoCurrent(r.dir, sha);
    assert.equal(res.ok, false);
    assert.match(res.ok ? '' : res.detail, /old\.txt/);
  });

  it('parses renames in -z output with both paths', () => {
    const e = parsePorcelainZ('R  new name.txt\0old name.txt\0?? x\0');
    assert.deepEqual(e.map((x) => [x.path, x.from]), [['new name.txt', 'old name.txt'], ['x', undefined]]);
    assert.equal(dirtCollides(e, new Set(['old name.txt'])), 'new name.txt'); // staged rename blocks anyway
  });

  it('a multi-commit range counts every commit, including a path added then deleted', async () => {
    const r = makeRepo();
    sg(r.dir, ['config', 'user.name', 'Dev One']);
    sg(r.dir, ['config', 'user.email', 'dev@example.test']);
    sg(r.dir, ['checkout', '-q', '-b', 'multi']);
    r.write('temp.txt', 'x\n');
    r.commit('add temp');
    sg(r.dir, ['rm', '-q', 'temp.txt']);
    r.write('keep.txt', 'k\n');
    const tip = r.commit('drop temp');
    sg(r.dir, ['checkout', '-q', 'main']);
    // advance main so the merge cannot fast-forward past the range check
    r.write('mainonly.txt', 'm\n');
    r.commit('main moves');
    r.write('temp.txt', 'mine\n');
    const res = await mergeOntoCurrent(r.dir, tip);
    assert.equal(res.ok, false);
    assert.match(res.ok ? '' : res.detail, /temp\.txt/);
    assert.equal(readFileSync(join(r.dir, 'temp.txt'), 'utf8'), 'mine\n');
  });

  it('a multi-commit range with only unrelated dirt merges (cherry-pick path)', async () => {
    const r = makeRepo();
    const sha = side(r, (x) => x.write('feature.txt', 'f\n'));
    r.write('mainonly.txt', 'm\n');
    r.commit('main moves');
    r.write('scratch.txt', 'untracked\n');
    const res = await mergeOntoCurrent(r.dir, sha);
    assert.equal(res.ok, true);
    assert.equal(sgt(r.dir, ['log', '-1', '--format=%s']), 'build');
    assert.equal(readFileSync(join(r.dir, 'scratch.txt'), 'utf8'), 'untracked\n');
  });

  it('Conductor-owned .conductor/.cursor entries stay exempt', () => {
    const e = parsePorcelainZ('?? .cursor/rules.json\0 M .conductor/x\0');
    assert.equal(dirtCollides(e, new Set(['.cursor/rules.json', '.conductor/x'])), null);
  });
});
