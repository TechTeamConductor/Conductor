// Read-only access to a repository's git OBJECTS for the context scanner (M4). Nothing here touches the working tree, runs a filter or a
// hook, follows a symlink or fetches from a remote:
//  - every call uses a hardened environment (no global/system git config, no prompts, no optional locks, NO_LAZY_FETCH so a partial clone
//    can never reach out — with credential helpers — during a "local" scan),
//  - refs and ids are validated before they reach argv, `--end-of-options` precedes anything derived from data, trees/blobs are named by
//    40/64-hex ids,
//  - the number of spawns and the wall time of one scan are capped, and `cat-file --batch` replaces a process per blob.
import { spawn } from 'node:child_process';
import { git, safeEnv, GIT_BASE_ENV } from '../git/exec.ts';

export const SCAN_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_NO_LAZY_FETCH: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '/usr/bin/false',
  GIT_EXTERNAL_DIFF: '',
  GIT_PAGER: 'cat',
});

export interface TreeEntry {
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  /** Blob size in bytes (null for trees and gitlinks). */
  size: number | null;
  path: string;
}

/** What the scanner needs from git. The real implementation is `GitReader`; tests stub it (e.g. a 300 000-file listing). */
export interface GitSource {
  /** Number of git processes started so far (tests assert exact counts). */
  readonly calls: number;
  resolveBranch(branch: string): Promise<{ commit: string; tree: string }>;
  lsTreeTop(commit: string): Promise<TreeEntry[]>;
  lsTreeRecursive(tree: string): Promise<{ entries: TreeEntry[]; truncated: boolean }>;
  /** Contents of blobs by id (each already known to be ≤ `maxEach` bytes); null when missing or too large. */
  catBlobs(shas: string[], maxEach: number): Promise<Map<string, string | null>>;
  /** Same, byte-exact (for writing files): total output of one call is capped at `READER_LIMITS.catBytes`. */
  catBuffers(shas: string[], maxEach: number): Promise<Map<string, Buffer | null>>;
}

const HEX_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const isObjectId = (s: unknown): s is string => typeof s === 'string' && HEX_RE.test(s);
/** A branch name as git allows it, minus everything that could be read as an option or a revision expression. */
export const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
export function isSafeBranch(b: unknown): b is string {
  return typeof b === 'string' && BRANCH_RE.test(b) && !b.includes('..') && !b.endsWith('/') && !b.endsWith('.lock') && !b.includes('//') && !b.includes('/.');
}

export const READER_LIMITS = Object.freeze({
  /** One scan may start at most this many git processes. */
  maxCalls: 1000,
  /** … and run this long in total. */
  deadlineMs: 60_000,
  callTimeoutMs: 30_000,
  /** ls-tree -r output ceiling: ~200k files × ~120 bytes with headroom. */
  lsTreeBytes: 96 * 1024 * 1024,
  catBytes: 32 * 1024 * 1024,
});

const LS_RE = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64}) +(\d+|-)\t([\s\S]*)$/;
export function parseLsTree(out: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const m = LS_RE.exec(rec);
    if (!m) continue; // a torn record (output truncated at the cap) or something unexpected: skipped, never guessed at
    entries.push({ mode: m[1]!, type: m[2] as TreeEntry['type'], sha: m[3]!, size: m[4] === '-' ? null : Number(m[4]), path: m[5]! });
  }
  return entries;
}

export class GitReader implements GitSource {
  private repo: string;
  private n = 0;
  private started = Date.now();
  private now: () => number;
  constructor(repo: string, opts: { now?: () => number } = {}) {
    this.repo = repo;
    this.now = opts.now ?? Date.now;
    this.started = this.now();
  }
  get calls(): number {
    return this.n;
  }
  private guard(): void {
    if (this.n >= READER_LIMITS.maxCalls) throw new Error('the scan started too many git processes — stopped');
    if (this.now() - this.started > READER_LIMITS.deadlineMs) throw new Error('the scan ran too long — stopped');
  }
  private async g(args: string[], maxBytes: number): Promise<string> {
    this.guard();
    this.n++;
    const r = await git(this.repo, args, { env: { ...SCAN_ENV }, timeoutMs: READER_LIMITS.callTimeoutMs, maxBytes });
    if (r.code !== 0) throw new Error(`git ${args[0]} failed${r.timedOut ? ' (timed out)' : ''}`);
    return r.stdout;
  }

  async resolveBranch(branch: string): Promise<{ commit: string; tree: string }> {
    if (!isSafeBranch(branch)) throw new Error('the repository base branch has an unusual name');
    // without --verify, rev-parse echoes `--end-of-options` itself: only the two object ids are taken
    const out = (await this.g(['rev-parse', '--end-of-options', `refs/heads/${branch}^{commit}`, `refs/heads/${branch}^{tree}`], 4096)).split('\n').filter(isObjectId);
    const [commit, tree] = out;
    if (!isObjectId(commit) || !isObjectId(tree)) throw new Error(`the base branch "${branch}" could not be resolved`);
    return { commit, tree };
  }

  async lsTreeTop(commit: string): Promise<TreeEntry[]> {
    if (!isObjectId(commit)) throw new Error('not an object id');
    return parseLsTree(await this.g(['ls-tree', '-z', '--long', commit], READER_LIMITS.lsTreeBytes));
  }

  async lsTreeRecursive(tree: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    if (!isObjectId(tree)) throw new Error('not an object id');
    this.guard();
    this.n++;
    const r = await git(this.repo, ['ls-tree', '-r', '-z', '--long', tree], { env: { ...SCAN_ENV }, timeoutMs: READER_LIMITS.callTimeoutMs, maxBytes: READER_LIMITS.lsTreeBytes });
    if (r.code !== 0) throw new Error('git ls-tree failed');
    // TailBuffer keeps the END of an over-long stream: the first record may be torn — parseLsTree skips what does not match
    return { entries: parseLsTree(r.stdout), truncated: r.stdoutTruncated };
  }

  async catBlobs(shas: string[], maxEach: number): Promise<Map<string, string | null>> {
    const raw = await this.catBuffers(shas, maxEach);
    return new Map([...raw].map(([k, v]) => [k, v === null ? null : v.toString('utf8')]));
  }

  async catBuffers(shas: string[], maxEach: number): Promise<Map<string, Buffer | null>> {
    const out = new Map<string, Buffer | null>();
    const want = [...new Set(shas)].filter(isObjectId);
    if (!want.length) return out;
    this.guard();
    this.n++;
    const env = safeEnv({ ...GIT_BASE_ENV, ...SCAN_ENV });
    const buf = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn('git', ['cat-file', '--batch'], { cwd: this.repo, env, stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('git cat-file timed out'));
      }, READER_LIMITS.callTimeoutMs);
      child.stdout.on('data', (b: Buffer) => {
        size += b.length;
        if (size > READER_LIMITS.catBytes) {
          child.kill('SIGKILL');
          reject(new Error('git cat-file output too large'));
          return;
        }
        chunks.push(b);
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(want.join('\n') + '\n');
    });
    let pos = 0;
    for (const sha of want) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl < 0) break;
      const header = buf.subarray(pos, nl).toString('utf8');
      pos = nl + 1;
      const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(header);
      if (!m) {
        out.set(sha, null); // "<sha> missing"
        continue;
      }
      const len = Number(m[3]);
      if (len > maxEach || m[2] !== 'blob') {
        out.set(sha, null);
      } else {
        out.set(sha, Buffer.from(buf.subarray(pos, pos + len)));
      }
      pos += len + 1; // content + the newline git appends
    }
    return out;
  }
}
