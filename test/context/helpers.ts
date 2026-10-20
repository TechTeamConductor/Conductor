// Fixture repositories for the context tests: real git, real objects, in temp dirs.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GateDef } from '../../src/types.ts';
import type { RepoRef } from '../../src/context/incremental.ts';
import { GitReader, type GitSource, type TreeEntry } from '../../src/context/gitread.ts';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
export const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV }).trim();

export interface Fixture {
  dir: string;
  repo: RepoRef;
  /** Write files (string/Buffer; `null` deletes), commit them on the base branch. */
  commit(files: Record<string, string | Buffer | null>, message?: string): string;
  cleanup(): void;
}

/** A fresh CONDUCTOR_HOME (the context store lives there) — call once per test, returns its path. */
export function freshHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-home-')));
  process.env.CONDUCTOR_HOME = home;
  return home;
}

export function mkrepo(files: Record<string, string | Buffer> = {}, gates: GateDef[] = []): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-repo-')));
  const dir = join(root, 'repo');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  const write = (rel: string, content: string | Buffer | null): void => {
    const p = join(dir, rel);
    if (content === null) {
      rmSync(p, { force: true });
      return;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  const commit = (fs: Record<string, string | Buffer | null>, message = 'c'): string => {
    for (const [rel, content] of Object.entries(fs)) write(rel, content);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--allow-empty', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  };
  commit({ 'README.md': '# demo\n', ...files }, 'init');
  return { dir, repo: { name: 'demo', path: dir, baseBranch: 'main', gates }, commit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export const addSymlink = (dir: string, name: string, target: string): void => {
  symlinkSync(target, join(dir, name));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'link');
};
export const addGitlink = (dir: string, path: string): void => {
  const sha = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'update-index', '--add', '--cacheinfo', `160000,${sha},${path}`);
  git(dir, 'commit', '-q', '-m', 'submodule entry');
};

/** A GitReader that records which blobs were asked for and exposes the real spawn count. */
export class SpyReader implements GitSource {
  inner: GitReader;
  catted: string[] = [];
  constructor(path: string) {
    this.inner = new GitReader(path);
  }
  get calls(): number {
    return this.inner.calls;
  }
  resolveBranch(b: string) {
    return this.inner.resolveBranch(b);
  }
  lsTreeTop(c: string) {
    return this.inner.lsTreeTop(c);
  }
  lsTreeRecursive(t: string) {
    return this.inner.lsTreeRecursive(t);
  }
  catBlobs(shas: string[], max: number) {
    this.catted.push(...shas);
    return this.inner.catBlobs(shas, max);
  }
}

/** A stub source over a synthetic listing (no git). */
export function stubSource(opts: { top: TreeEntry[]; recursive: Record<string, TreeEntry[]>; blobs?: Record<string, string> }): GitSource & { recursiveCalls: string[] } {
  let calls = 0;
  const recursiveCalls: string[] = [];
  return {
    get calls() {
      return calls;
    },
    recursiveCalls,
    async resolveBranch() {
      calls++;
      return { commit: 'c'.repeat(40), tree: 't'.repeat(40) };
    },
    async lsTreeTop() {
      calls++;
      return opts.top;
    },
    async lsTreeRecursive(tree: string) {
      calls++;
      recursiveCalls.push(tree);
      return { entries: opts.recursive[tree] ?? [], truncated: false };
    },
    async catBlobs(shas: string[]) {
      calls++;
      return new Map(shas.map((s) => [s, opts.blobs?.[s] ?? null]));
    },
  };
}
