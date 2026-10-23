/**
 * Git worktree layer: repo validation, isolated worktrees, dependency install, commit hygiene, diff + scope guard,
 * backup refs (C5), resets, ancestor-instruction scan, builder no-push environment and Cursor deny-rule guard.
 *
 * Erasable TypeScript only; node:* built-ins only; argv-only git calls.
 */
import { ensureRealDir, safeWriteInside } from '../fsutil.ts';
import { access, appendFile, chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsc, existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RepoConfig } from '../types.ts';
import { conductorHome } from '../paths.ts';
import { looksSecret, loadEnvSecrets, redact } from '../redact.ts';
import { sha256, tail } from '../util.ts';
import { git, gitOk, GitError, run, safeEnv } from './exec.ts';

// ───────────────────────────── small helpers ─────────────────────────────

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_REV_RE = /^[^\s\0-]\S*$/; // no whitespace, must not start with '-'
const CONDUCTOR_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Conductor',
  GIT_AUTHOR_EMAIL: 'conductor@localhost',
  GIT_COMMITTER_NAME: 'Conductor',
  GIT_COMMITTER_EMAIL: 'conductor@localhost',
};

function assertKey(key: string): void {
  if (typeof key !== 'string' || !KEY_RE.test(key) || key.includes('..') || key.endsWith('.') || key.endsWith('.lock')) {
    throw new Error(`invalid run key ${JSON.stringify(key)} (expected letters, digits, '.', '_' or '-')`);
  }
}
function assertRev(rev: string, what = 'revision'): void {
  if (typeof rev !== 'string' || rev.length === 0 || !SAFE_REV_RE.test(rev) || rev.includes('\0')) {
    throw new Error(`invalid ${what} ${JSON.stringify(String(rev).slice(0, 80))}`);
  }
}

/**
 * v2-wide namespace (review K5): branches, base/backup refs and the default worktree folder are all DISTINCT from v1's
 * (`conductor/…`, `refs/conductor/…`, `.conductor-worktrees`), so v1 and v2 can run on the same repository — even for the same
 * card key — without ever sharing or deleting each other's checkout, branch or refs.
 */
export const BRANCH_PREFIX = 'conductor-v2/';
export const REF_PREFIX = 'refs/conductor-v2/';
export const DEFAULT_WORKTREE_DIR = '.conductor-v2-worktrees';
export const branchFor = (key: string): string => `${BRANCH_PREFIX}${key.toLowerCase()}`;
export const baseRefFor = (key: string): string => `${REF_PREFIX}${key}/base`;

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

/** realpath that tolerates a not-yet-existing tail (resolves the deepest existing ancestor). */
async function realpathLoose(p: string): Promise<string> {
  const abs = resolve(p);
  try {
    return await realpath(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(await realpathLoose(parent), basename(abs));
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function topLevel(worktree: string): Promise<string> {
  return gitOk(worktree, ['rev-parse', '--show-toplevel']);
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.code === 0;
}
async function resolveCommit(cwd: string, ref: string): Promise<string> {
  assertRev(ref);
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (r.code !== 0 || !r.stdout.trim()) throw new Error(`cannot resolve ${JSON.stringify(ref)} to a commit in ${cwd}`);
  return r.stdout.trim();
}

// ───────────────────────────── per-repo mutex ─────────────────────────────

const repoLocks = new Map<string, Promise<void>>();

/** In-process mutex keyed by an arbitrary string (the repo realpath). FIFO; a throwing task never wedges the queue. */
export async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  const chained = prev.then(() => mine);
  repoLocks.set(key, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (repoLocks.get(key) === chained) repoLocks.delete(key);
  }
}

// ───────────────────────────── inspectRepo ─────────────────────────────

export interface RepoInfo {
  root: string;
  head: string;
  currentBranch: string | null;
  remotes: string[];
  defaultBranch: string;
}

export async function inspectRepo(path: string): Promise<RepoInfo> {
  if (typeof path !== 'string' || path.trim() === '') throw new Error('repository path is empty');
  let real: string;
  try {
    real = await realpath(resolve(path));
  } catch {
    throw new Error(`path does not exist: ${path}`);
  }
  const st = await stat(real);
  if (!st.isDirectory()) throw new Error(`not a directory: ${path}`);
  if (real === '/' || dirname(real) === real) throw new Error('refusing to use "/" as a repository');

  const homes = new Set<string>();
  for (const h of [process.env.HOME, homedir()]) if (h) homes.add(await realpathLoose(h));
  if (homes.has(real)) throw new Error('refusing to use the home directory as a repository');

  const condHomes = new Set<string>();
  for (const c of [conductorHome(), join(homedir(), '.conductor'), join(homedir(), '.conductor-v2')]) condHomes.add(await realpathLoose(c));
  for (const c of condHomes) {
    if (isInside(c, real)) throw new Error(`refusing to use a path inside the Conductor home (${c})`);
  }

  const bare = await git(real, ['rev-parse', '--is-bare-repository']);
  if (bare.code !== 0) throw new Error(`not a git repository: ${path}`);
  if (bare.stdout.trim() === 'true') throw new Error(`bare repositories are not supported (no work tree): ${path}`);
  const inside = await git(real, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') throw new Error(`not inside a git work tree: ${path}`);

  const topRaw = await gitOk(real, ['rev-parse', '--show-toplevel']);
  const top = await realpath(topRaw);
  if (top !== real) throw new Error(`path is not the repository root (root is ${top}): ${path}`);

  const headRes = await git(real, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (headRes.code !== 0 || !headRes.stdout.trim()) throw new Error(`repository has no commits yet: ${path}`);
  const head = headRes.stdout.trim();

  const br = await git(real, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const currentBranch = br.code === 0 && br.stdout.trim() ? br.stdout.trim() : null;
  const remotes = (await gitOk(real, ['remote'])).split('\n').map((s) => s.trim()).filter(Boolean);
  const defaultBranch = await detectDefaultBranch(real, currentBranch);
  return { root: real, head, currentBranch, remotes, defaultBranch };
}

async function detectDefaultBranch(root: string, currentBranch: string | null): Promise<string> {
  const o = await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (o.code === 0) {
    const name = o.stdout.trim().replace(/^origin\//, '');
    if (name) {
      if (await refExists(root, `refs/heads/${name}`)) return name;
      if (await refExists(root, `refs/remotes/origin/${name}`)) return `origin/${name}`;
    }
  }
  for (const c of ['main', 'master']) {
    if (await refExists(root, `refs/heads/${c}`)) return c;
  }
  return currentBranch ?? 'HEAD';
}

// ───────────────────────────── worktree listing ─────────────────────────────

export interface WorktreeInfo {
  path: string;
  head: string | null;
  branch: string | null; // full ref, e.g. refs/heads/conductor-v2/eng-1
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  bare: boolean;
}

export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const r = await git(repoRoot, ['worktree', 'list', '--porcelain', '-z']);
  if (r.code !== 0) throw new GitError(`git worktree list failed: ${redact(r.stderr)}`, r.code, r.stderr, ['worktree', 'list']);
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const f of r.stdout.split('\0')) {
    if (f === '') {
      if (cur.length) blocks.push(cur);
      cur = [];
    } else cur.push(f);
  }
  if (cur.length) blocks.push(cur);
  const out: WorktreeInfo[] = [];
  for (const b of blocks) {
    const info: WorktreeInfo = { path: '', head: null, branch: null, detached: false, locked: false, prunable: false, bare: false };
    for (const f of b) {
      if (f.startsWith('worktree ')) info.path = f.slice(9);
      else if (f.startsWith('HEAD ')) info.head = f.slice(5);
      else if (f.startsWith('branch ')) info.branch = f.slice(7);
      else if (f === 'detached') info.detached = true;
      else if (f === 'bare') info.bare = true;
      else if (f === 'locked' || f.startsWith('locked ')) info.locked = true;
      else if (f === 'prunable' || f.startsWith('prunable ')) info.prunable = true;
    }
    if (info.path) out.push(info);
  }
  return out;
}

// ───────────────────────────── exclude + copyFiles ─────────────────────────────

/** Resolve the SHARED exclude file (`info/exclude` lives in the common git dir, so it applies to every worktree). */
async function sharedExcludePath(repoRoot: string): Promise<string> {
  const p = await gitOk(repoRoot, ['rev-parse', '--git-path', 'info/exclude']);
  return resolve(repoRoot, p);
}

/** Append missing patterns to the shared exclude file. Idempotent. */
export async function addToSharedExclude(repoRoot: string, patterns: string[]): Promise<string[]> {
  const file = await sharedExcludePath(repoRoot);
  await mkdir(dirname(file), { recursive: true });
  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch {
    /* not there yet */
  }
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = [...new Set(patterns)].filter((p) => !have.has(p));
  if (missing.length === 0) return [];
  let add = '';
  if (current.length > 0 && !current.endsWith('\n')) add += '\n';
  if (!have.has('# conductor')) add += '# conductor\n';
  add += missing.join('\n') + '\n';
  await appendFile(file, add);
  return missing;
}

function validateCopyFile(rel: string): string {
  if (typeof rel !== 'string' || rel.trim() === '' || rel.includes('\0')) throw new Error(`invalid copyFiles entry ${JSON.stringify(rel)}`);
  if (isAbsolute(rel) || rel.startsWith('~')) throw new Error(`copyFiles entry must be relative to the repository: ${rel}`);
  const segs = rel.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  if (segs.length === 0) throw new Error(`invalid copyFiles entry ${JSON.stringify(rel)}`);
  if (segs.includes('..')) throw new Error(`copyFiles entry escapes the repository (contains ".."): ${rel}`);
  if (segs[0] === '.git') throw new Error(`copyFiles entry may not touch .git: ${rel}`);
  return segs.join('/');
}

async function copyUntrackedFiles(
  repoRoot: string,
  wt: string,
  files: string[],
): Promise<{ copied: string[]; skipped: { file: string; reason: string }[]; present: string[] }> {
  const copied: string[] = [];
  const skipped: { file: string; reason: string }[] = [];
  const present: string[] = []; // untracked files that exist in the worktree (copied now or earlier)
  const realRepo = await realpath(repoRoot);
  const realWt = await realpath(wt);
  for (const rel of files) {
    const src = join(repoRoot, rel);
    let st;
    try {
      st = await lstat(src);
    } catch {
      skipped.push({ file: rel, reason: 'missing in main checkout' });
      continue;
    }
    if (st.isSymbolicLink()) {
      skipped.push({ file: rel, reason: 'symlink' });
      continue;
    }
    if (!st.isFile()) {
      skipped.push({ file: rel, reason: 'not a regular file' });
      continue;
    }
    const realSrc = await realpath(src);
    if (!isInside(realRepo, realSrc)) {
      skipped.push({ file: rel, reason: 'resolves outside the repository' });
      continue;
    }
    const tracked = await git(repoRoot, ['ls-files', '--error-unmatch', '--', rel]);
    if (tracked.code === 0) {
      skipped.push({ file: rel, reason: 'tracked (never overwritten)' });
      continue;
    }
    const dest = join(wt, rel);
    await mkdir(dirname(dest), { recursive: true });
    const realDestDir = await realpath(dirname(dest));
    if (!isInside(realWt, realDestDir)) {
      skipped.push({ file: rel, reason: 'destination escapes the worktree' });
      continue;
    }
    if (await exists(dest)) {
      skipped.push({ file: rel, reason: 'already present' });
      present.push(rel);
      continue;
    }
    await copyFile(src, dest, fsc.COPYFILE_EXCL);
    await chmod(dest, st.mode & 0o777);
    copied.push(rel);
    present.push(rel);
  }
  return { copied, skipped, present };
}

// ───────────────────────────── createWorktree ─────────────────────────────

export interface CreatedWorktree {
  path: string;
  branch: string;
  baseSha: string;
  /** Additive: false when an existing worktree was reused. */
  created: boolean;
  copied: string[];
  skipped: { file: string; reason: string }[];
}

export async function createWorktree(opts: {
  repo: RepoConfig;
  key: string;
  worktreeRoot?: string;
  baseRef?: string;
}): Promise<CreatedWorktree> {
  const { repo, key } = opts;
  assertKey(key);
  if (!NAME_RE.test(repo.name)) throw new Error(`invalid repo name ${JSON.stringify(repo.name)}`);
  const copyList = (repo.copyFiles ?? []).map(validateCopyFile); // validate BEFORE touching anything

  const repoRoot = await realpath(repo.path);
  return withRepoLock(repoRoot, async () => {
    const root = opts.worktreeRoot ?? join(dirname(repo.path), DEFAULT_WORKTREE_DIR);
    const wtPath = join(root, repo.name, key);
    const branch = branchFor(key);
    const branchRef = `refs/heads/${branch}`;

    await git(repoRoot, ['worktree', 'prune']);
    const wtReal = await realpathLoose(wtPath);
    const registered = (await listWorktrees(repoRoot)).find((w) => w.path === wtReal || w.path === wtPath);

    let baseSha: string;
    let created = false;
    if (registered) {
      if (registered.branch !== branchRef) {
        throw new Error(`worktree ${wtPath} exists on ${registered.branch ?? 'a detached HEAD'}, expected ${branch}`);
      }
      baseSha = await recordedBase(repoRoot, key, branch, repo.baseBranch);
    } else {
      if (await exists(wtPath)) {
        let entries: string[] = [];
        try {
          entries = await readdir(wtPath);
        } catch {
          entries = ['?']; // not a directory
        }
        if (entries.length > 0) {
          throw new Error(`${wtPath} exists and is not a registered worktree of ${repo.name}; refusing to overwrite`);
        }
      }
      await mkdir(dirname(wtPath), { recursive: true });
      if (await refExists(repoRoot, branchRef)) {
        // branch survived a removed worktree: re-attach it (keeps committed work)
        baseSha = await recordedBase(repoRoot, key, branch, repo.baseBranch);
        await gitOk(repoRoot, ['worktree', 'add', '--', wtPath, branch]);
      } else {
        baseSha = await resolveCommit(repoRoot, opts.baseRef ?? repo.baseBranch);
        await gitOk(repoRoot, ['worktree', 'add', '-b', branch, '--', wtPath, baseSha]);
        await gitOk(repoRoot, ['update-ref', baseRefFor(key), baseSha]);
        created = true;
      }
    }

    ensureRealDir(wtPath, '.conductor'); // a repo-tracked symlink here is replaced, never followed (B-1)
    const copy = await copyUntrackedFiles(repoRoot, wtPath, copyList);
    await addToSharedExclude(repoRoot, ['/.conductor/', 'node_modules', ...copy.present.map((f) => '/' + f)]);
    return { path: wtPath, branch, baseSha, created, copied: copy.copied, skipped: copy.skipped };
  });
}

/**
 * Use the checkout the repository already has. The branch stays whatever is checked out there.
 * No `conductor-v2/<key>` branch and no second worktree: a later card sees the earlier card's commits.
 */
export async function useCurrentCheckout(opts: { repo: RepoConfig; key: string }): Promise<CreatedWorktree> {
  assertKey(opts.key);
  const repo = opts.repo;
  if (!NAME_RE.test(repo.name)) throw new Error(`invalid repo name ${JSON.stringify(repo.name)}`);
  const copyList = repo.copyFiles.map(validateCopyFile);
  const repoRoot = await realpath(repo.path);
  return withRepoLock(repoRoot, async () => {
    const head = await git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (head.code !== 0 || !head.stdout.trim()) {
      throw new Error('this repository is not on a branch; Conductor stays on the current branch and will not create one');
    }
    const branch = head.stdout.trim();
    const recorded = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${baseRefFor(opts.key)}^{commit}`]);
    const haveRecord = recorded.code === 0 && recorded.stdout.trim() !== '';
    const baseSha = haveRecord ? recorded.stdout.trim() : await gitOk(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (!haveRecord) await gitOk(repoRoot, ['update-ref', baseRefFor(opts.key), baseSha]);
    ensureRealDir(repoRoot, '.conductor');
    await addToSharedExclude(repoRoot, ['/.conductor/', 'node_modules', '/.cursor/cli.json', ...copyList.map((f) => '/' + f)]);
    return { path: repoRoot, branch, baseSha, created: false, copied: [], skipped: [] };
  });
}

const SLOT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

/** Directory for one in-flight build. Detached: no `conductor-v2/<key>` branch is created. */
export function detachedBuildPath(repo: RepoConfig, key: string, slot: string, worktreeRoot?: string): string {
  assertKey(key);
  if (!SLOT_RE.test(slot)) throw new Error(`invalid build slot ${JSON.stringify(slot)}`);
  if (!NAME_RE.test(repo.name)) throw new Error(`invalid repo name ${JSON.stringify(repo.name)}`);
  const root = worktreeRoot ?? join(dirname(repo.path), DEFAULT_WORKTREE_DIR);
  return join(root, repo.name, `${key}--${slot}`);
}

/**
 * A detached worktree at `sha`, for one build. Replaces a previous directory at `dest`.
 * Does not create a branch. Copies the repo's untracked `copyFiles` the same way a card checkout does.
 */
export async function openDetachedBuild(repo: RepoConfig, dest: string, sha: string): Promise<void> {
  assertRev(sha, 'commit');
  const copyList = (repo.copyFiles ?? []).map(validateCopyFile);
  const repoRoot = await realpath(repo.path);
  await withRepoLock(repoRoot, async () => {
    await removeDetachedUnlocked(repoRoot, dest);
    await mkdir(dirname(dest), { recursive: true });
    await gitOk(repoRoot, ['worktree', 'add', '--detach', '--', dest, sha]);
    ensureRealDir(dest, '.conductor');
    await copyUntrackedFiles(repoRoot, dest, copyList);
    // The builder's deny rule lives in the temporary directory (prepare writes it there). The checkout the run records
    // also gets it, so the rule is still present after that directory is removed, and it stays git-excluded.
    await writeCursorGuard(repoRoot);
  });
}

async function removeDetachedUnlocked(repoRoot: string, dest: string): Promise<void> {
  const all = await listWorktrees(repoRoot);
  const main = all[0];
  const real = await realpathLoose(dest);
  const reg = all.find((w) => w.path === real || w.path === dest);
  if (reg) {
    if (main && reg.path === main.path) throw new Error('refusing to remove the main working tree');
    await gitOk(repoRoot, ['worktree', 'remove', '--force', '--', reg.path]);
  } else if (await exists(dest)) {
    await rm(dest, { recursive: true, force: true });
  }
  await git(repoRoot, ['worktree', 'prune']);
}

/** Remove a detached build directory. Never deletes a branch. */
export async function removeDetachedBuild(repoRoot: string, dest: string): Promise<void> {
  const root = await realpath(repoRoot);
  await withRepoLock(root, () => removeDetachedUnlocked(root, dest));
}

/** Porcelain lines that are only Conductor replacing a tracked `.conductor` link, or its own `.cursor` guard, do not block a merge. */
function checkoutDirtBlocksMerge(porcelain: string): boolean {
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue;
    const path = line.slice(3).replace(/^"|"$/g, '');
    if (path === '.conductor' || path.startsWith('.conductor/') || path === '.cursor' || path.startsWith('.cursor/')) continue;
    return true;
  }
  return false;
}

/**
 * Merge `sha` onto the branch checked out at `repoRoot`. One merge at a time.
 * A conflict aborts the merge and leaves the other commits in place.
 * Fast-forwards when it can, so a single build stays that commit.
 */
export async function mergeOntoCurrent(repoRoot: string, sha: string): Promise<{ ok: true; sha: string } | { ok: false; detail: string }> {
  assertRev(sha, 'commit');
  const root = await realpath(repoRoot);
  return withRepoLock(root, async () => {
    const branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch.code !== 0 || !branch.stdout.trim()) return { ok: false, detail: 'the checkout is not on a branch, so this build was not merged' };
    const name = branch.stdout.trim();
    const anc = await git(root, ['merge-base', '--is-ancestor', sha, 'HEAD']);
    if (anc.code === 0) return { ok: true, sha: (await gitOk(root, ['rev-parse', 'HEAD'])).trim() };
    const dirty = (await gitOk(root, ['status', '--porcelain'])).trim();
    if (checkoutDirtBlocksMerge(dirty)) return { ok: false, detail: `the current checkout has uncommitted changes, so this build was not merged onto ${name}` };
    const cfg = ['-c', 'commit.gpgsign=false'];
    const nm = await git(root, ['config', '--get', 'user.name']);
    const em = await git(root, ['config', '--get', 'user.email']);
    if (nm.code !== 0 || !nm.stdout.trim()) cfg.push('-c', 'user.name=Conductor', '-c', 'user.email=conductor@localhost');
    else if (em.code !== 0 || !em.stdout.trim()) cfg.push('-c', 'user.email=conductor@localhost');
    const ff = await git(root, [...cfg, 'merge', '--ff-only', sha]);
    if (ff.code === 0) return { ok: true, sha: (await gitOk(root, ['rev-parse', 'HEAD'])).trim() };
    // A sibling build already moved the branch. Replay this commit on top so the branch stays a straight line.
    const picked = await git(root, [...cfg, 'cherry-pick', sha]);
    if (picked.code !== 0) {
      const text = `${picked.stdout}\n${picked.stderr}`;
      await git(root, ['cherry-pick', '--abort']);
      if (/empty/i.test(text)) return { ok: true, sha: (await gitOk(root, ['rev-parse', 'HEAD'])).trim() };
      return { ok: false, detail: `merging this build onto ${name} conflicted; the other files on that branch were left as they are` };
    }
    return { ok: true, sha: (await gitOk(root, ['rev-parse', 'HEAD'])).trim() };
  });
}

/** True when `worktreePath` is the repository's own checkout (the branch it already has). */
export async function isRepoCheckout(repoPath: string, worktreePath: string): Promise<boolean> {
  try {
    return (await realpath(repoPath)) === (await realpath(worktreePath));
  } catch {
    return false;
  }
}

async function recordedBase(repoRoot: string, key: string, branch: string, baseBranch: string): Promise<string> {
  const ref = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${baseRefFor(key)}^{commit}`]);
  if (ref.code === 0 && ref.stdout.trim()) return ref.stdout.trim();
  const mb = await git(repoRoot, ['merge-base', baseBranch, branch]);
  if (mb.code === 0 && mb.stdout.trim()) return mb.stdout.trim();
  return gitOk(repoRoot, ['rev-parse', '--verify', `${branch}^{commit}`]);
}

// ───────────────────────────── dependencies ─────────────────────────────

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb'];

export async function detectSetupCommand(repoPath: string): Promise<string | null> {
  const pkgPath = join(repoPath, 'package.json');
  if (!existsSync(pkgPath)) return null;
  const has = (f: string): boolean => existsSync(join(repoPath, f));
  if (has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile';
  if (has('bun.lock') || has('bun.lockb')) return 'bun install --frozen-lockfile';
  if (has('yarn.lock')) return has('.yarnrc.yml') ? 'yarn install --immutable' : 'yarn install --frozen-lockfile';
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) return 'npm ci';
  // no lockfile: only install when there is something to install, and never write a lockfile into the worktree
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    const n = (k: string): number => Object.keys((pkg[k] as object | undefined) ?? {}).length;
    if (n('dependencies') + n('devDependencies') + n('optionalDependencies') > 0) {
      return 'npm install --no-package-lock --no-audit --no-fund';
    }
  } catch {
    /* unreadable package.json: no install */
  }
  return null;
}

/** sha256 over the JS lockfiles present in `wt` (carry-forward C2: re-install when this changes). */
export async function lockfileHash(wt: string): Promise<string> {
  const parts: Buffer[] = [];
  for (const f of LOCKFILES) {
    try {
      const buf = await readFile(join(wt, f));
      parts.push(Buffer.from(`${f}\0`), buf, Buffer.from('\0'));
    } catch {
      /* absent */
    }
  }
  return sha256(Buffer.concat(parts));
}

export async function installDeps(
  wt: string,
  repo: RepoConfig,
  o: { env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; output: string }> {
  const cmd = repo.setup ?? (await detectSetupCommand(wt));
  if (!cmd) return { ok: true, output: 'no setup command (no package.json)' };
  const pass: Record<string, string> = {};
  for (const name of repo.envPassthrough ?? []) {
    const v = process.env[name];
    if (typeof v === 'string') pass[name] = v;
  }
  const secrets = loadEnvSecrets((repo.copyFiles ?? []).map((f) => join(wt, f)));
  const r = await run('sh', ['-c', cmd], {
    cwd: wt,
    env: safeEnv({ CI: 'true', ...pass, ...(o.env ?? {}) }),
    timeoutMs: o.timeoutMs ?? 10 * 60_000,
    signal: o.signal,
    maxBytes: 2 * 1024 * 1024,
  });
  const body = [r.stdout, r.stderr].filter(Boolean).join('\n');
  const note = r.timedOut ? '\n[setup timed out]' : r.aborted ? '\n[setup aborted]' : '';
  return { ok: r.code === 0 && !r.timedOut && !r.aborted, output: tail(redact(body, secrets), 16 * 1024) + note };
}

// ───────────────────────────── temp-index snapshots (no mutation of the real index) ─────────────────────────────

/**
 * Write a tree object describing the COMPLETE working state (tracked changes + untracked, non-ignored files)
 * using a private copy of the index, so the real index/working tree are never touched.
 */
async function snapshotTree(top: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-idx-'));
  const idx = join(dir, 'index');
  const env = { GIT_INDEX_FILE: idx };
  try {
    let seeded = false;
    try {
      const real = resolve(top, await gitOk(top, ['rev-parse', '--git-path', 'index']));
      await copyFile(real, idx);
      seeded = true;
    } catch {
      /* no index yet / split index: rebuild from HEAD */
    }
    if (!seeded) await gitOk(top, ['read-tree', 'HEAD'], { env });
    const add = await git(top, ['add', '-A'], { env });
    if (add.code !== 0) {
      // copied index may be unusable (e.g. split index): rebuild once from HEAD
      await rm(idx, { force: true });
      await gitOk(top, ['read-tree', 'HEAD'], { env });
      await gitOk(top, ['add', '-A'], { env });
    }
    return await gitOk(top, ['write-tree'], { env });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ───────────────────────────── commitAll ─────────────────────────────

export type CommitResult =
  | { ok: true; sha: string; files: string[] }
  | { ok: false; reason: 'nothing' | 'guard' | 'hook' | 'error'; detail: string; files?: string[] };

const SECRET_NAME_RE = [/^\.env/i, /\.pem$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i, /\.key$/i, /\.p12$/i, /\.pfx$/i];
const ENV_EXAMPLE_RE = /^\.env(\..+)?\.(example|sample|template|dist|defaults)$/i;
const IDENTITY_ERR_RE = /(please tell me who you are|author identity unknown|empty ident name|unable to auto-detect email)/i;

function fmtBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;
}

export async function commitAll(o: {
  worktree: string;
  message: string;
  maxFileBytes?: number;
  identity?: { name: string; email: string };
  /** Additive: exact secret values to redact from hook output (e.g. loadEnvSecrets of copied env files). */
  secrets?: string[];
  /** Additive: commit (hook) timeout; default 5 minutes. */
  commitTimeoutMs?: number;
}): Promise<CommitResult> {
  const wt = o.worktree;
  const maxFileBytes = o.maxFileBytes ?? 5 * 1024 * 1024;
  const secrets = o.secrets ?? [];
  const unstage = async (): Promise<void> => {
    await git(wt, ['reset', '-q']);
  };
  try {
    const top = await topLevel(wt);
    const add = await git(top, ['add', '-A']);
    if (add.code !== 0) {
      await unstage();
      return { ok: false, reason: 'error', detail: `git add failed: ${redact(tail(add.stderr.trim(), 800), secrets)}` };
    }
    // A repo that tracks `.conductor` as a symlink must not have that replacement committed (B-1). The checkout keeps a
    // real directory; the product commit does not delete the link. Ignored copies were never staged, so a miss here is fine.
    await git(top, ['reset', '-q', '--', '.conductor', '.cursor']);

    // staged files (name-status so deletions are exempt from content/name guards)
    const ns = await git(top, ['diff', '--cached', '--name-status', '-z', '--no-renames']);
    const staged: { status: string; path: string }[] = [];
    const f = ns.stdout.split('\0').filter((s) => s !== '');
    for (let i = 0; i + 1 < f.length; i += 2) staged.push({ status: f[i]!, path: f[i + 1]! });
    if (staged.length === 0) return { ok: false, reason: 'nothing', detail: 'no changes to commit' };
    const files = staged.map((s) => s.path);

    // ── guard ──
    const problems: string[] = [];
    const bad = new Set<string>();
    for (const s of staged) {
      if (s.status.startsWith('D')) continue;
      const base = basename(s.path);
      if (SECRET_NAME_RE.some((re) => re.test(base)) && !ENV_EXAMPLE_RE.test(base)) {
        problems.push(`secret-like file name: ${s.path}`);
        bad.add(s.path);
      }
      try {
        const st = await lstat(join(top, s.path));
        if (st.isFile() && st.size > maxFileBytes) {
          problems.push(`file too large: ${s.path} (${fmtBytes(st.size)} > ${fmtBytes(maxFileBytes)})`);
          bad.add(s.path);
        }
      } catch {
        /* vanished: ignore */
      }
    }
    const patch = await git(top, ['-c', 'core.quotePath=false', 'diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'], {
      maxBytes: 64 * 1024 * 1024,
    });
    if (patch.code === 0) {
      if (patch.stdoutTruncated) {
        problems.push('staged diff too large to scan for secrets');
        for (const p of files) bad.add(p);
      } else {
        for (const [path, added] of addedTextByFile(patch.stdout)) {
          if (looksSecret(added)) {
            problems.push(`secret-looking content in added lines: ${path}`);
            bad.add(path);
          }
        }
      }
    }
    if (problems.length > 0) {
      await unstage();
      return { ok: false, reason: 'guard', detail: problems.join('\n'), files: [...bad] };
    }

    // ── commit (repo hooks DO run; never --no-verify) ──
    const cfg: string[] = ['-c', 'commit.gpgsign=false'];
    const idn = o.identity ?? { name: 'Conductor', email: 'conductor@localhost' };
    const nm = await git(top, ['config', '--get', 'user.name']);
    const em = await git(top, ['config', '--get', 'user.email']);
    if (nm.code !== 0 || !nm.stdout.trim()) cfg.push('-c', `user.name=${idn.name}`);
    if (em.code !== 0 || !em.stdout.trim()) cfg.push('-c', `user.email=${idn.email}`);

    const before = (await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD'])).stdout.trim();
    const c = await git(top, [...cfg, 'commit', '-q', '-m', o.message], { timeoutMs: o.commitTimeoutMs ?? 5 * 60_000, maxBytes: 1024 * 1024 });
    if (c.code === 0 && !c.timedOut) {
      const sha = await gitOk(top, ['rev-parse', 'HEAD']);
      return { ok: true, sha, files };
    }
    const out = redact([c.stdout, c.stderr].filter(Boolean).join('\n').trim(), secrets);
    const after = (await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD'])).stdout.trim();
    await unstage();
    const hooks = await activeCommitHooks(top);
    const timeoutNote = c.timedOut ? `commit timed out after ${Math.round((o.commitTimeoutMs ?? 5 * 60_000) / 1000)}s\n` : '';
    if (!IDENTITY_ERR_RE.test(out) && hooks.length > 0 && after === before) {
      return { ok: false, reason: 'hook', detail: tail(timeoutNote + out, 8 * 1024) || 'commit hook failed (no output)', files };
    }
    return { ok: false, reason: 'error', detail: tail(timeoutNote + out, 8 * 1024) || `git commit failed (exit ${c.code})`, files };
  } catch (e) {
    try {
      await unstage();
    } catch {
      /* ignore */
    }
    return { ok: false, reason: 'error', detail: redact(e instanceof Error ? e.message : String(e), secrets) };
  }
}

/** Added lines per file from a `-U0` patch (no `+` prefix, joined by newlines). */
function addedTextByFile(patch: string): Map<string, string> {
  const map = new Map<string, string[]>();
  let cur: string | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/\t$/, ''); // git appends a TAB after paths containing spaces
      cur = p === '/dev/null' ? null : p.startsWith('b/') ? p.slice(2) : p;
      if (cur !== null && !map.has(cur)) map.set(cur, []);
      continue;
    }
    if (line.startsWith('--- ') || cur === null) continue;
    if (line.startsWith('+')) map.get(cur)!.push(line.slice(1));
  }
  const out = new Map<string, string>();
  for (const [k, v] of map) out.set(k, v.join('\n'));
  return out;
}

async function activeCommitHooks(top: string): Promise<string[]> {
  const r = await git(top, ['rev-parse', '--git-path', 'hooks']);
  if (r.code !== 0) return [];
  const dir = resolve(top, r.stdout.trim());
  const found: string[] = [];
  for (const h of ['pre-commit', 'prepare-commit-msg', 'commit-msg']) {
    try {
      await access(join(dir, h), fsc.X_OK);
      found.push(h);
    } catch {
      /* no such executable hook */
    }
  }
  return found;
}

// ───────────────────────────── diff + scope guard ─────────────────────────────

export interface DiffFile {
  path: string;
  status: string;
  /** Additive: previous path for renames/copies. */
  from?: string;
}
export const PATCH_CAP_BYTES = 2 * 1024 * 1024;

/**
 * Diff of the COMPLETE current state (committed + staged + unstaged + untracked non-ignored) against `baseSha`.
 * Computed through a private temp index: the worktree's real index is never modified.
 */
export async function diffAgainst(worktree: string, baseSha: string): Promise<{ stat: string; patch: string; files: DiffFile[] }> {
  assertRev(baseSha, 'base sha');
  const top = await topLevel(worktree);
  const tree = await snapshotTree(top);
  const common = ['--no-color', '--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/'];
  const [statR, nsR, patchR] = await Promise.all([
    git(top, ['diff', '--stat=160', ...common, baseSha, tree]),
    git(top, ['diff', '--name-status', '-z', ...common, baseSha, tree]),
    git(top, ['diff', ...common, baseSha, tree], { maxBytes: 64 * 1024 * 1024 }),
  ]);
  for (const r of [statR, nsR, patchR]) {
    if (r.code !== 0) throw new GitError(`git diff failed: ${redact(tail(r.stderr.trim(), 500))}`, r.code, r.stderr, ['diff']);
  }
  const files: DiffFile[] = [];
  const f = nsR.stdout.split('\0').filter((s) => s !== '');
  for (let i = 0; i < f.length; ) {
    const st = f[i]!;
    const kind = st.charAt(0);
    if (kind === 'R' || kind === 'C') {
      files.push({ status: kind, from: f[i + 1]!, path: f[i + 2]! });
      i += 3;
    } else {
      files.push({ status: kind, path: f[i + 1]! });
      i += 2;
    }
  }
  let patch = patchR.stdout;
  if (Buffer.byteLength(patch) > PATCH_CAP_BYTES) {
    let cut = Buffer.from(patch).subarray(0, PATCH_CAP_BYTES).toString('utf8');
    const nl = cut.lastIndexOf('\n');
    if (nl > 0) cut = cut.slice(0, nl + 1);
    patch = `${cut}\n[patch truncated at ${PATCH_CAP_BYTES / 1024 / 1024} MB; full diff: git diff ${baseSha}]\n`;
  }
  return { stat: redact(statR.stdout), patch: redact(patch), files };
}

const PROTECTED_DIR_SEGMENTS = new Set(['.claude', '.cursor', '.codex', '.agents', '.husky', '.techteam', '.conductor', '.devcontainer', '.vscode']);
// instruction/config files that tools auto-load or execute (security review M6)
const PROTECTED_FILE_NAMES = new Set(['.mcp.json', 'agents.md', 'agents.override.md', 'claude.md', 'claude.local.md', 'gemini.md', '.envrc', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', '.cursorrules', '.windsurfrules', 'lefthook.yml', '.pre-commit-config.yaml']);

/** Exported for display only (M8-6: brief files flagged before Send) — no logic change. */
export function isProtectedPath(p: string): boolean {
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!.toLowerCase(); // case-insensitive: macOS volumes are
    if (s.startsWith('.git')) return true; // .git, .gitignore, .gitattributes, .gitmodules, .github, …
    if (PROTECTED_DIR_SEGMENTS.has(s)) return true;
    if (i === segs.length - 1 && PROTECTED_FILE_NAMES.has(s)) return true;
  }
  return false;
}

/**
 * Files that touch agent/CI/instruction configuration (any depth) and are not covered by the approved plan.
 * `allowedPaths` match exactly or as a directory prefix.
 */
export function diffScopeViolations(files: string[], allowedPaths: string[]): string[] {
  const allowed = allowedPaths.map((a) => a.replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of files) {
    const f = raw.replace(/^\.\//, '');
    if (seen.has(f)) continue;
    if (!isProtectedPath(f)) continue;
    if (allowed.some((a) => f === a || f.startsWith(a + '/'))) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}

// ───────────────────────────── backup refs (C5) + resets ─────────────────────────────

async function putRef(cwd: string, base: string, sha: string, same: (existingSha: string) => Promise<boolean>): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const cur = await git(cwd, ['rev-parse', '--verify', '--quiet', name]);
    if (cur.code !== 0) {
      await gitOk(cwd, ['update-ref', name, sha, '']); // create-only: expected old value is "absent"
      return name;
    }
    if (await same(cur.stdout.trim())) return name;
  }
  throw new Error(`too many backup refs for ${base}`);
}

/**
 * Create a stash-compatible commit for the COMPLETE uncommitted state, or null when the tree is clean.
 *
 * Mechanism (documented choice): `git stash create` records tracked changes (index + worktree) but ignores
 * untracked files, so untracked, non-ignored files are added as the stash's THIRD parent (a root commit built from a
 * temporary index) — exactly the layout `git stash push --include-untracked` produces. The result therefore works with
 * a plain `git stash apply <sha>` (restores tracked AND untracked work). Ignored files (node_modules, env copies) are
 * deliberately not captured: they survive `resetToBase` anyway.
 */
async function createStashCommit(top: string, message: string): Promise<string | null> {
  const env = CONDUCTOR_IDENTITY;
  const created = (await gitOk(top, ['stash', 'create', message], { env })).trim();
  const lsr = await git(top, ['ls-files', '-z', '--others', '--exclude-standard']);
  const untracked = lsr.stdout.split('\0').filter((p) => p !== '' && !p.endsWith('/'));

  let uCommit: string | null = null;
  if (untracked.length > 0) {
    const dir = await mkdtemp(join(tmpdir(), 'conductor-bk-'));
    try {
      const ienv = { ...env, GIT_INDEX_FILE: join(dir, 'index') };
      await gitOk(top, ['update-index', '--add', '-z', '--stdin'], { env: ienv, input: untracked.join('\0') + '\0' });
      const utree = await gitOk(top, ['write-tree'], { env: ienv });
      uCommit = await gitOk(top, ['commit-tree', utree, '-m', `untracked files for: ${message}`], { env });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  if (!created && !uCommit) return null;
  if (created && !uCommit) return created;

  const headTree = await gitOk(top, ['rev-parse', 'HEAD^{tree}']);
  let tree: string;
  let p1: string;
  let p2: string;
  if (created) {
    const parts = (await gitOk(top, ['rev-list', '--parents', '-n', '1', created])).split(/\s+/);
    p1 = parts[1]!;
    p2 = parts[2]!;
    tree = await gitOk(top, ['rev-parse', `${created}^{tree}`]);
  } else {
    p1 = await gitOk(top, ['rev-parse', 'HEAD']);
    p2 = await gitOk(top, ['commit-tree', headTree, '-p', p1, '-m', `index on: ${message}`], { env });
    tree = headTree;
  }
  return gitOk(top, ['commit-tree', tree, '-p', p1, '-p', p2, '-p', uCommit!, '-m', message], { env });
}

/**
 * Carry-forward C5. Writes `refs/conductor-v2/<key>/prev-<rev>` at HEAD and, when the working tree has uncommitted
 * changes (tracked OR untracked), `refs/conductor-v2/<key>/stash-<rev>` (a stash-format commit, see `createStashCommit`).
 * Never overwrites an existing, different backup: a numeric suffix (`-2`, `-3`, …) is added instead; the returned
 * names are authoritative. Recover with `git stash apply <stashRef>` / `git checkout <headRef>`.
 */
export async function backupRefs(worktree: string, key: string, rev: number): Promise<{ headRef: string; stashRef: string | null }> {
  assertKey(key);
  if (!Number.isInteger(rev) || rev < 0) throw new Error(`invalid rev ${rev}`);
  const top = await topLevel(worktree);
  const head = await gitOk(top, ['rev-parse', 'HEAD']);
  const headRef = await putRef(top, `${REF_PREFIX}${key}/prev-${rev}`, head, async (existing) => existing === head);

  const stash = await createStashCommit(top, `conductor backup ${key} rev ${rev}`);
  let stashRef: string | null = null;
  if (stash) {
    const newTree = await gitOk(top, ['rev-parse', `${stash}^{tree}`]);
    const newU = await git(top, ['rev-parse', '--verify', '--quiet', `${stash}^3^{tree}`]);
    stashRef = await putRef(top, `${REF_PREFIX}${key}/stash-${rev}`, stash, async (existing) => {
      // same backup content ⇒ reuse (idempotent re-run); compare tracked tree, base commit and untracked tree
      const t = await git(top, ['rev-parse', '--verify', '--quiet', `${existing}^{tree}`]);
      const p = await git(top, ['rev-parse', '--verify', '--quiet', `${existing}^1`]);
      const u = await git(top, ['rev-parse', '--verify', '--quiet', `${existing}^3^{tree}`]);
      return t.stdout.trim() === newTree && p.stdout.trim() === head && u.stdout.trim() === newU.stdout.trim();
    });
  }
  return { headRef, stashRef };
}

/** `reset --hard` + `clean -fd`. Ignored files (node_modules, copied env files, .conductor/) survive. Call `backupRefs` FIRST. */
export async function resetToCommit(worktree: string, sha: string): Promise<void> {
  assertRev(sha, 'commit');
  const top = await topLevel(worktree);
  const commit = await resolveCommit(top, sha);
  await gitOk(top, ['reset', '--hard', '-q', commit]);
  await gitOk(top, ['clean', '-fdq']);
}
export async function resetToBase(worktree: string, baseSha: string): Promise<void> {
  return resetToCommit(worktree, baseSha);
}

// ───────────────────────────── removal ─────────────────────────────

/** The folder `createWorktree` derives for a card — the only place a v2 run may work. */
export function expectedWorktreePath(repo: { name: string; path: string }, key: string, worktreeRoot?: string): string {
  return join(worktreeRoot ?? join(dirname(repo.path), DEFAULT_WORKTREE_DIR), repo.name, key);
}

/**
 * A run's `worktree` field is only trusted when it is exactly where v2 would have created it AND that checkout is on v2's branch for
 * the key (security review B-2: a run record carrying a v1 checkout path must never make v2 plan/build/reset/delete inside it).
 * Throws a human-readable error otherwise.
 */
export async function assertOwnedWorktree(repo: { name: string; path: string }, key: string, worktreePath: string, worktreeRoot?: string): Promise<void> {
  if (existsSync(worktreePath) && (await lstat(worktreePath)).isSymbolicLink()) {
    throw new Error(`${worktreePath} is a symbolic link, not a checkout Conductor may use; refusing to touch it`);
  }
  const repoRoot = await realpathLoose(repo.path);
  const have = await realpathLoose(worktreePath);
  // The repository's own checkout is the place a card works: whichever branch is already checked out there.
  if (have === repoRoot) {
    const head = await git(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (head.code !== 0) throw new Error(`the checkout at ${worktreePath} is detached; Conductor stays on the current branch and will not touch it`);
    return;
  }
  const want = await realpathLoose(expectedWorktreePath(repo, key, worktreeRoot));
  if (have !== want) throw new Error(`the recorded worktree is not the one Conductor v2 created for this card (${worktreePath}); refusing to touch it`);
  if (existsSync(worktreePath)) {
    const head = await git(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (head.code !== 0) throw new Error(`the checkout at ${worktreePath} is on a detached HEAD, not ${branchFor(key)}; refusing to touch it`);
    if (head.stdout.trim() !== branchFor(key)) throw new Error(`the checkout at ${worktreePath} is on branch ${head.stdout.trim()}, not ${branchFor(key)}; refusing to touch it`);
  }
}

export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  o: { deleteBranch?: boolean; force?: boolean } = {},
): Promise<{ branchKept: boolean }> {
  // validate the branch name BEFORE anything is removed: a foreign branch must never cost the user a checkout (B-2)
  if (o.deleteBranch && !branch.startsWith(BRANCH_PREFIX)) throw new Error(`refusing to delete non-conductor branch ${JSON.stringify(branch)}`);
  const root = await realpath(repoRoot);
  let branchKept = false;
  await withRepoLock(root, async () => {
    const real = await realpathLoose(worktreePath);
    const all = await listWorktrees(root);
    const main = all[0];
    const reg = all.find((w) => w.path === real || w.path === worktreePath);
    if (reg) {
      if (main && reg.path === main.path) throw new Error('refusing to remove the main working tree');
      await gitOk(root, ['worktree', 'remove', '--force', '--', reg.path]);
    } else if (await exists(worktreePath)) {
      throw new Error(`${worktreePath} is not a registered worktree of ${repoRoot}; refusing to delete it`);
    }
    await git(root, ['worktree', 'prune']);
    if (o.deleteBranch) {
      if (!branch.startsWith(BRANCH_PREFIX)) throw new Error(`refusing to delete non-conductor branch ${JSON.stringify(branch)}`);
      assertRev(branch, 'branch');
      if (await refExists(root, `refs/heads/${branch}`)) {
        const r = await git(root, ['branch', o.force ? '-D' : '-d', '--', branch]);
        // git refuses to delete a branch that is not fully merged: that is the intended safety net (the work is kept), not a failure
        if (r.code !== 0 && !/not fully merged/i.test(r.stderr + r.stdout)) throw new Error(`git branch ${o.force ? '-D' : '-d'} failed: ${(r.stderr || r.stdout).trim()}`);
        branchKept = r.code !== 0;
      }
    }
  });
  return { branchKept };
}

// ───────────────────────────── instruction-file ancestors ─────────────────────────────

const ANCESTOR_FILES = ['AGENTS.md', 'agents.override.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md'];
const ANCESTOR_DIRS = [join('.claude', 'rules'), join('.cursor', 'rules'), '.codex', '.agents'];

/** Instruction files/dirs in EVERY ancestor directory above `path` (not `path` itself). Absolute paths. */
export async function scanAncestors(path: string): Promise<string[]> {
  const start = await realpathLoose(path);
  const found: string[] = [];
  let dir = dirname(start);
  for (;;) {
    for (const f of ANCESTOR_FILES) {
      const p = join(dir, f);
      try {
        if ((await stat(p)).isFile()) found.push(p);
      } catch {
        /* absent */
      }
    }
    for (const d of ANCESTOR_DIRS) {
      const p = join(dir, d);
      try {
        if ((await stat(p)).isDirectory()) found.push(p);
      } catch {
        /* absent */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

// ───────────────────────────── builder no-push environment ─────────────────────────────

export const PUSH_DISABLED_URL = 'conductor-push-disabled://';

/**
 * Environment ADDITIONS for the builder agent: neutralises `remote.<name>.pushurl` for every remote, blanks
 * `credential.helper`, disables ssh/askpass. Does NOT stop an explicit-URL push to a local path (see tests);
 * the Cursor deny rule (`writeCursorGuard`) is the layer for that.
 */
export async function agentGitEnv(repoRoot: string): Promise<Record<string, string>> {
  const remotes = (await gitOk(repoRoot, ['remote'])).split('\n').map((s) => s.trim()).filter(Boolean);
  const env: Record<string, string> = {};
  let n = 0;
  for (const name of remotes) {
    env[`GIT_CONFIG_KEY_${n}`] = `remote.${name}.pushurl`;
    env[`GIT_CONFIG_VALUE_${n}`] = PUSH_DISABLED_URL;
    n++;
  }
  env[`GIT_CONFIG_KEY_${n}`] = 'credential.helper';
  env[`GIT_CONFIG_VALUE_${n}`] = '';
  n++;
  env.GIT_CONFIG_COUNT = String(n);
  env.GIT_SSH_COMMAND = '/usr/bin/false';
  env.GIT_ASKPASS = '/usr/bin/false';
  env.SSH_ASKPASS = '/usr/bin/false';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_GLOBAL = '/dev/null'; // the user's global git config (aliases, includes, credential helpers) is not the agent's business
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

// ───────────────────────────── Cursor deny-rule guard ─────────────────────────────

/**
 * Live-proven (Cursor 2026.10.19, --force): `Shell(git:push*)` alone stops `git push …` but NOT wrappers combined with an
 * explicit URL (`env git push <path>`, `/usr/bin/git push …`, `git -c k=v push …`, `sh -c 'git push …'` all succeeded).
 * The wider patterns below blocked every one of those. Known trade-off: a git command whose text contains "push"
 * (e.g. a commit message) is blocked too — Conductor does the committing. Other interpreters (python, node, …) are
 * not enumerable: this is defence in depth under a same-user threat model, not a sandbox.
 */
export const CURSOR_GUARD_DENY = [
  'Shell(git:push*)',
  'Shell(git:*push*)',
  'Shell(git:*send-pack*)',
  'Shell(ssh:*)',
  'Shell(nc:*)',
  'Shell(/usr/bin/git:*push*)',
  'Shell(/opt/homebrew/bin/git:*push*)',
  'Shell(/usr/local/bin/git:*push*)',
  'Shell(env:*git*)',
  'Shell(sh:*git*push*)',
  'Shell(bash:*git*push*)',
  'Shell(gh:*)',
  'Shell(security:*)',
  'Shell(osascript:*)',
  'Shell(sudo:*)',
];
/** `allow` MUST be present (empty): Cursor's schema requires both arrays (proven live). */
export const CURSOR_GUARD_JSON = JSON.stringify({ permissions: { allow: [], deny: CURSOR_GUARD_DENY } });

export async function writeCursorGuard(worktree: string): Promise<{ written: boolean; envOnly: boolean; sha256: string | null }> {
  const top = await topLevel(worktree);
  const file = join(top, '.cursor', 'cli.json');
  const tracked = await git(top, ['ls-files', '--error-unmatch', '--', '.cursor/cli.json']);
  if (tracked.code === 0) return { written: false, envOnly: true, sha256: null }; // the repo's own file: never overwrite
  // Untracked (ours from an earlier loop, or planted): REWRITE it every build so a tampered/loosened copy never survives (M7),
  // and never write through a symlink (M9).
  safeWriteInside(top, '.cursor/cli.json', CURSOR_GUARD_JSON);
  await addToSharedExclude(top, ['/.cursor/cli.json']);
  return { written: true, envOnly: false, sha256: sha256(CURSOR_GUARD_JSON) };
}

export async function checkCursorGuard(worktree: string, expectedSha256: string | null): Promise<{ ok: boolean; detail: string }> {
  if (expectedSha256 === null) return { ok: true, detail: 'no cli.json guard was written (env-only no-push)' };
  const file = join(worktree, '.cursor', 'cli.json');
  let buf: Buffer;
  try {
    buf = await readFile(file);
  } catch {
    return { ok: false, detail: '.cursor/cli.json deny rule is missing (deleted during the build)' };
  }
  const now = sha256(buf);
  if (now !== expectedSha256) return { ok: false, detail: '.cursor/cli.json deny rule was modified during the build' };
  return { ok: true, detail: 'cli.json deny rule unchanged' };
}
