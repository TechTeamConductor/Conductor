// The release version is computed from Conventional Commits since the last vX.Y.Z tag. These tests pin the rules the release workflow
// relies on: what bumps what, what never releases, pre-1.0 behaviour, and which tags and commit text are ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, compareVersions, computeNext, highestTag, isValidVersion, parseTag, readGit } from '../../scripts/next-version.ts';
import type { Commit } from '../../scripts/next-version.ts';

const c = (subject: string, body = '', parents = 1): Commit => ({ subject, body, parents });

test('parseTag accepts only vX.Y.Z', () => {
  assert.deepEqual(parseTag('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseTag('v0.10.0'), [0, 10, 0]);
  for (const bad of ['1.2.3', 'v1.2', 'v1.2.3-rc1', 'v1.2.3+b', 'foo', 'v01.2.3', 'v1.2.3.4', 'V1.2.3', '']) assert.equal(parseTag(bad), null, bad);
});

test('highestTag picks the highest SemVer, not the newest or the lexicographically last', () => {
  assert.equal(highestTag(['v0.9.0', 'v0.10.0', 'v0.2.0']), 'v0.10.0');
  assert.equal(highestTag(['v1.0.0', 'v1.2.3-rc1', 'foo', 'v1.2', 'v0.5.0']), 'v1.0.0');
  assert.equal(highestTag(['foo', 'v1.2']), null);
  assert.equal(highestTag([]), null);
});

test('compareVersions orders numerically', () => {
  assert.ok(compareVersions([0, 10, 0], [0, 9, 0]) > 0);
  assert.ok(compareVersions([1, 0, 0], [0, 99, 99]) > 0);
  assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0);
});

test('classify: feat -> minor, fix/perf/revert -> patch, "!" or a line-start footer -> breaking', () => {
  assert.equal(classify(c('feat: add x')), 'minor');
  assert.equal(classify(c('feat(ui): add x')), 'minor');
  assert.equal(classify(c('fix: bug')), 'patch');
  assert.equal(classify(c('perf(core): faster')), 'patch');
  assert.equal(classify(c('revert: undo x')), 'patch');
  assert.equal(classify(c('Revert "feat: add x"')), 'patch');
  assert.equal(classify(c('feat!: drop api')), 'breaking');
  assert.equal(classify(c('fix(api)!: change shape')), 'breaking');
  assert.equal(classify(c('fix: x', 'details\n\nBREAKING CHANGE: the thing changed')), 'breaking');
  assert.equal(classify(c('fix: x', 'BREAKING-CHANGE: the thing changed')), 'breaking');
});

test('classify: housekeeping types, free-form subjects, merges and quoted footers never release', () => {
  for (const t of ['docs', 'chore', 'ci', 'test', 'style', 'refactor', 'build']) assert.equal(classify(c(`${t}: something`)), null, t);
  assert.equal(classify(c('update stuff')), null);
  assert.equal(classify(c('Feat: capitalised is not conventional')), null);
  assert.equal(classify(c('feat add x')), null);
  assert.equal(classify(c('Merge pull request #4 from x/y')), null);
  assert.equal(classify(c('feat: merge two things', '', 2)), null, 'a merge commit (2 parents) is skipped, its parents are parsed instead');
  assert.equal(classify(c('docs: x', 'this text mentions BREAKING CHANGE: mid-line')), null, 'footer must start the line');
  assert.equal(classify(c('docs: x', 'we said that BREAKING CHANGE: is a footer')), null);
  assert.equal(classify(c('fix: x', 'BREAKING CHANGE:no space')), 'patch');
});

test('computeNext: first release is 0.1.0 when any releasable commit exists, none otherwise', () => {
  assert.deepEqual(computeNext({ tags: [], commits: [c('feat: x')] }), { release: true, version: '0.1.0', tag: 'v0.1.0', bump: 'minor' });
  assert.deepEqual(computeNext({ tags: [], commits: [c('fix: x')] }), { release: true, version: '0.1.0', tag: 'v0.1.0', bump: 'patch' });
  assert.equal(computeNext({ tags: [], commits: [c('docs: x'), c('chore: y')] }).release, false);
  assert.equal(computeNext({ tags: [], commits: [] }).release, false);
});

test('computeNext: the highest bump wins and is applied to the highest tag', () => {
  const r = computeNext({ tags: ['v0.2.0', 'v0.10.0', 'v0.9.0'], commits: [c('fix: a'), c('feat: b'), c('docs: c')] });
  assert.deepEqual(r, { release: true, version: '0.11.0', tag: 'v0.11.0', bump: 'minor' });
  assert.equal(computeNext({ tags: ['v1.4.2'], commits: [c('fix: a')] }).version, '1.4.3');
  assert.equal(computeNext({ tags: ['v1.4.2'], commits: [c('feat: a')] }).version, '1.5.0');
  assert.equal(computeNext({ tags: ['v1.4.2'], commits: [c('feat!: a')] }).version, '2.0.0');
});

test('computeNext: only housekeeping since the last tag means no release', () => {
  assert.deepEqual(computeNext({ tags: ['v1.0.0'], commits: [c('ci: x'), c('docs: y')] }), { release: false, version: '', tag: '', bump: 'none' });
});

test('computeNext: before 1.0 a breaking change bumps minor, never silently 1.0.0', () => {
  assert.equal(computeNext({ tags: ['v0.3.1'], commits: [c('feat!: x')] }).version, '0.4.0');
  assert.equal(computeNext({ tags: ['v0.3.1'], commits: [c('fix: x', 'BREAKING CHANGE: y')] }).version, '0.4.0');
});

test('computeNext: a manual override decides the bump, but only when there are new commits', () => {
  assert.equal(computeNext({ tags: ['v0.3.1'], commits: [c('fix: x')], override: 'major' }).version, '1.0.0');
  assert.equal(computeNext({ tags: ['v0.3.1'], commits: [c('fix: x')], override: 'minor' }).version, '0.4.0');
  assert.equal(computeNext({ tags: ['v0.3.1'], commits: [c('docs: x')], override: 'patch' }).version, '0.3.2', 'override forces a release even when commits are housekeeping');
  assert.equal(computeNext({ tags: ['v0.3.1'], commits: [], override: 'major' }).release, false, 'nothing new since the tag');
  assert.equal(computeNext({ tags: [], commits: [c('feat: x')], override: 'major' }).version, '1.0.0');
  assert.equal(computeNext({ tags: ['v0.3.1'], commits: [c('feat: x')], override: 'auto' }).version, '0.4.0');
});

test('computeNext: the version is always a plain X.Y.Z', () => {
  const r = computeNext({ tags: ['v12.34.56'], commits: [c('fix: x')] });
  assert.ok(isValidVersion(r.version));
  assert.equal(r.tag, `v${r.version}`);
  assert.equal(isValidVersion('1.2.3'), true);
  for (const bad of ['', '1.2', '1.2.3-rc1', 'v1.2.3', '1.2.3\n', '1.2.3 ', '01.2.3', '1.2.3; rm -rf /']) assert.equal(isValidVersion(bad), false, JSON.stringify(bad));
});

// ── the CLI half: real git, no shell ──────────────────────────────────────────────────────────────────────────────────────────────
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'next-version-'));
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}
function commit(dir: string, message: string, file = 'f.txt'): void {
  writeFileSync(join(dir, file), `${Math.random()}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

test('readGit: reads tags and only the commits after the highest tag; bodies with hostile text stay data', () => {
  const dir = repo();
  commit(dir, 'feat: first');
  git(dir, 'tag', 'v0.1.0');
  git(dir, 'tag', 'v0.2.0-rc1');
  git(dir, 'tag', 'not-a-version');
  commit(dir, 'fix: after tag\n\nBREAKING CHANGE: $(touch pwned) `touch pwned2`; touch pwned3');
  commit(dir, 'docs: later');
  const { tags, commits } = readGit(dir);
  assert.deepEqual([...tags].sort(), ['not-a-version', 'v0.1.0', 'v0.2.0-rc1']);
  assert.deepEqual(commits.map((x) => x.subject), ['docs: later', 'fix: after tag']);
  assert.equal(commits.every((x) => x.parents === 1), true);
  const r = computeNext({ tags, commits });
  assert.equal(r.version, '0.2.0', 'pre-1.0 breaking -> minor');
  assert.equal(r.bump, 'minor');
});

test('readGit: no tags returns the whole history; HEAD on the tag returns no commits', () => {
  const dir = repo();
  commit(dir, 'feat: a');
  commit(dir, 'fix: b');
  assert.equal(readGit(dir).commits.length, 2);
  git(dir, 'tag', 'v0.1.0');
  assert.equal(readGit(dir).commits.length, 0);
  assert.equal(computeNext(readGit(dir)).release, false);
});

test('readGit: merge commits are flagged by their parent count', () => {
  const dir = repo();
  commit(dir, 'feat: base');
  git(dir, 'tag', 'v0.1.0');
  git(dir, 'checkout', '-q', '-b', 'side');
  commit(dir, 'fix: on side', 'side.txt');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'docs: on main', 'main.txt');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge branch side', 'side');
  const { commits } = readGit(dir);
  const merge = commits.find((x) => x.subject === 'Merge branch side');
  assert.ok(merge);
  assert.equal(merge.parents, 2);
  assert.equal(computeNext(readGit(dir)).version, '0.1.1', 'the fix on the side branch is counted once via its own commit');
});

test('CLI: prints key=value lines, validates --bump, and refuses to run with an unknown flag', () => {
  const dir = repo();
  commit(dir, 'feat: a');
  const run = (...args: string[]) => execFileSync(process.execPath, [join(import.meta.dirname, '..', '..', 'scripts', 'next-version.ts'), ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(run(), 'release=true\nversion=0.1.0\ntag=v0.1.0\nbump=minor\n');
  assert.equal(run('--bump', 'major'), 'release=true\nversion=1.0.0\ntag=v1.0.0\nbump=major\n');
  assert.throws(() => run('--bump', 'huge'), /bump/);
  assert.throws(() => run('--bogus'), /unknown/i);
  git(dir, 'tag', 'v0.1.0');
  assert.equal(run(), 'release=false\nversion=\ntag=\nbump=none\n');
});
