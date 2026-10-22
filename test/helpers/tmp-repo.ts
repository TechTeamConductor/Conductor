/**
 * Temp git repo / bare remote factory for git-layer tests. Everything lives under one per-process temp root that is
 * deleted on exit. No network, no model calls.
 *
 * `isolateGitHome()` points HOME (which `safeEnv()` forwards to git) and CONDUCTOR_HOME at fresh temp dirs so the
 * developer's real ~/.gitconfig (identity, gpgsign, hooksPath, …) can never influence a test. Call it first.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

let root: string | null = null;
let counter = 0;
let isolated = false;

/** Per-process temp root (realpath'd: macOS tmpdir is a symlink to /private/var). */
export function tmpRoot(): string {
  if (!root) {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-git-test-')));
    const r = root;
    process.on('exit', () => {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });
  }
  return root;
}

export function tmpDir(name = 'd'): string {
  const dir = join(tmpRoot(), `${name}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Fresh HOME + CONDUCTOR_HOME for this process; strips inherited GIT_* variables. Returns the fake HOME. */
export function isolateGitHome(): string {
  const home = join(tmpRoot(), 'home');
  if (!isolated) {
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    process.env.CONDUCTOR_HOME = join(tmpRoot(), 'conductor-home');
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('GIT_')) delete process.env[k];
    }
    isolated = true;
  }
  return home;
}

function fixtureEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.test',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C',
  };
}

/** Synchronous git for fixtures (never used by code under test). Returns stdout (not trimmed). */
export function sg(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, { cwd, env: fixtureEnv(), input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}
export const sgt = (cwd: string, args: string[], input?: string): string => sg(cwd, args, input).trim();

/** Like sg but returns {code, stdout, stderr} instead of throwing. */
export function sgTry(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    return { code: 0, stdout: sg(cwd, args), stderr: '' };
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string };
    return { code: x.status ?? 1, stdout: String(x.stdout ?? ''), stderr: String(x.stderr ?? '') };
  }
}

export interface TmpRepo {
  /** Parent temp dir (siblings of the repo live here: worktrees, remotes). */
  root: string;
  /** Repo work tree (realpath). */
  dir: string;
  git(args: string[], input?: string): string;
  /** trimmed stdout */
  gt(args: string[]): string;
  write(rel: string, content: string | Buffer, mode?: number): string;
  commit(message: string): string;
  head(): string;
}

export interface MakeRepoOpts {
  name?: string;
  branch?: string;
  files?: Record<string, string>;
  /** extra lines for .gitignore */
  ignore?: string[];
  /** create a bare remote next to the repo and wire it as `origin` (pushed) */
  withRemote?: boolean;
}

export function makeRepo(opts: MakeRepoOpts = {}): TmpRepo & { remote: string | null } {
  isolateGitHome();
  const parent = tmpDir(opts.name ?? 'case');
  const dir = join(parent, 'repo');
  mkdirSync(dir, { recursive: true });
  sg(dir, ['init', '-q', '-b', opts.branch ?? 'main']);
  const repo: TmpRepo & { remote: string | null } = {
    root: parent,
    dir,
    remote: null,
    git: (args, input) => sg(dir, args, input),
    gt: (args) => sgt(dir, args),
    write(rel, content, mode) {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
      if (mode !== undefined) chmodSync(p, mode);
      return p;
    },
    commit(message) {
      sg(dir, ['add', '-A']);
      sg(dir, ['commit', '-q', '-m', message]);
      return sgt(dir, ['rev-parse', 'HEAD']);
    },
    head: () => sgt(dir, ['rev-parse', 'HEAD']),
  };
  repo.write('.gitignore', ['node_modules/', '.env.local', ...(opts.ignore ?? [])].join('\n') + '\n');
  for (const [f, c] of Object.entries(opts.files ?? { 'README.md': '# fixture\n', 'src/index.js': 'export const a = 1;\n' })) repo.write(f, c);
  repo.commit('initial');
  if (opts.withRemote) {
    const remote = makeBareRemote(parent, 'origin.git');
    sg(dir, ['remote', 'add', 'origin', remote]);
    sg(dir, ['push', '-q', '-u', 'origin', opts.branch ?? 'main']);
    repo.remote = remote;
  }
  return repo;
}

export function makeBareRemote(parent: string = tmpDir('remote'), name = 'remote.git'): string {
  isolateGitHome();
  const p = join(parent, name);
  mkdirSync(p, { recursive: true });
  sg(p, ['init', '-q', '--bare', '-b', 'main']);
  return p;
}

/** All refs of a repo as `name sha` lines (sorted) — used to prove a remote did not change. */
export function refsOf(gitDir: string): string {
  const r = sgTry(gitDir, ['for-each-ref', '--format=%(refname) %(objectname)']);
  return r.stdout.split('\n').filter(Boolean).sort().join('\n');
}

/**
 * Fingerprint of a checkout: HEAD, branch, `git status`, and a hash of every working file (excluding .git).
 * Byte-identical before/after ⇒ the main checkout was not touched.
 */
export function fingerprint(dir: string): string {
  const h = createHash('sha256');
  h.update(sgt(dir, ['rev-parse', 'HEAD']) + '\n');
  h.update(sgTry(dir, ['symbolic-ref', '-q', 'HEAD']).stdout + '\n');
  h.update(sg(dir, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '--ignored']) + '\n');
  h.update(sg(dir, ['rev-parse', 'HEAD^{tree}']));
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      if (name === '.git') continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        h.update(`${relative(dir, p)}\0${st.mode}\0`);
        h.update(readFileSync(p));
      }
    }
  };
  walk(dir);
  return h.digest('hex');
}

export function writeExecutable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

/** Poll until `fn` is true (wall-clock). */
export async function waitFor(fn: () => boolean, ms = 3000, step = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return fn();
}

/** True when `pid` is alive. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
