import { looksSecret } from '../redact.ts';
import { git } from './exec.ts';
import { secretLikeEnvValues } from './envvalues.ts';

const SECRET_NAME = /(^|\/)(\.env(\.[^/]*)?|id_(rsa|dsa|ecdsa|ed25519)|[^/]*\.(pem|key|p12|pfx))$/i;
const SAFE_ENV_NAME = /(^|\/)\.env\.(example|sample|template|dist|defaults)$/i;

const FILE_CAP = 5 * 1024 * 1024;
const DEFAULT_COMMIT_BYTES = 32 * 1024 * 1024;
const GIT_TIMEOUT = 120_000;
const MAX_FINDINGS = 10;

export interface ScanEnvEntry {
  name: string;
  value: string;
  multiline?: boolean;
}
export type ScanFailure = { ok: false; reason: string; commits: string[]; files: string[] };

class ScanError extends Error {}

interface Finding {
  commit: string;
  file: string;
  what: string;
}

async function g(cwd: string, args: string[], maxBytes: number, input?: string): Promise<string> {
  const r = await git(cwd, args, { maxBytes, timeoutMs: GIT_TIMEOUT, ...(input !== undefined ? { input } : {}) });
  if (r.code !== 0 || r.timedOut || r.aborted) throw new ScanError(`git ${args[0]} failed${r.timedOut ? ' (timed out)' : ''}`);
  if (r.stdoutTruncated) throw new ScanError(`git ${args[0]} output exceeded the scan limit`);
  return r.stdout;
}

function safeRev(rev: string): boolean {
  return typeof rev === 'string' && rev.length > 0 && !rev.startsWith('-') && !/[\s\0]/.test(rev);
}

/** Added lines per file of one commit's patch. Hunk counts drive the parse so an added line that looks like `+++ b/x` cannot confuse it. */
export function addedLinesByFile(patch: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const lines = patch.split('\n');
  let file = '(unknown file)';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/\t.*$/, '');
      file = p === '/dev/null' ? file : p.replace(/^"?b\//, '').replace(/"$/, '');
      continue;
    }
    const h = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (!h) continue;
    let oldN = h[1] === undefined ? 1 : Number(h[1]);
    let newN = h[2] === undefined ? 1 : Number(h[2]);
    const bucket = out.get(file) ?? [];
    while ((oldN > 0 || newN > 0) && i + 1 < lines.length) {
      const l = lines[++i] ?? '';
      if (l.startsWith('+')) {
        bucket.push(l.slice(1));
        newN--;
      } else if (l.startsWith('-')) oldN--;
      else if (l.startsWith('\\')) continue;
      else {
        oldN--;
        newN--;
      }
    }
    out.set(file, bucket);
  }
  return out;
}

function textHit(text: string, values: readonly string[]): 'shape' | 'env' | null {
  if (looksSecret(text)) return 'shape';
  for (const v of values) if (text.includes(v)) return 'env';
  return null;
}
const WHAT = { shape: 'credential-shaped value', env: 'a value copied from an .env file' } as const;

async function scanCommit(repo: string, sha: string, values: readonly string[], maxBytes: number, found: Finding[]): Promise<void> {
  const short = sha.slice(0, 10);
  const add = (file: string, what: string) => {
    if (!found.some((f) => f.commit === short && f.file === file && f.what === what)) found.push({ commit: short, file, what });
  };
  // 1. author / committer / message
  const meta = await g(repo, ['show', '-s', '--no-color', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', sha], 1024 * 1024);
  const hit = textHit(meta.replace(/\0/g, '\n'), values);
  if (hit) add('(commit message or author fields)', WHAT[hit]);
  // 2. names, modes and blob ids of everything the commit adds or changes
  const raw = await g(repo, ['diff-tree', '-r', '--root', '--no-commit-id', '--no-renames', '--raw', '-z', '--no-ext-diff', sha], maxBytes);
  const parts = raw.split('\0');
  const blobs: { path: string; blob: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const head = parts[i] ?? '';
    const path = parts[i + 1] ?? '';
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/.exec(head);
    if (!m) throw new ScanError('unparseable diff-tree output');
    if (m[5] === 'D') continue;
    if (SECRET_NAME.test(path) && !SAFE_ENV_NAME.test(path)) add(path, 'secret-style file name');
    const ph = textHit(path, values);
    if (ph) add('(a file name)', WHAT[ph]);
    if (m[2] !== '160000') blobs.push({ path, blob: m[4]! });
  }
  if (blobs.length) {
    const sizes = (await g(repo, ['cat-file', '--batch-check=%(objectsize)'], 8 * 1024 * 1024, blobs.map((b) => b.blob).join('\n') + '\n')).split('\n').filter(Boolean);
    if (sizes.length !== blobs.length) throw new ScanError('unparseable cat-file output');
    sizes.forEach((s, i) => {
      const n = Number(s);
      if (!Number.isFinite(n)) throw new ScanError('unparseable cat-file output');
      if (n > FILE_CAP) add(blobs[i]!.path, 'file larger than 5 MB');
    });
  }
  // 3. content: added lines joined per file (a multi-line PEM in a .md is one string)
  const patch = await g(repo, ['diff-tree', '-p', '--root', '--no-commit-id', '--text', '-U0', '--no-renames', '--no-color', '--no-ext-diff', '-r', sha], maxBytes);
  for (const [file, lines] of addedLinesByFile(patch)) {
    const joined = lines.join('\n');
    const h = textHit(joined, values);
    if (h) add(file, WHAT[h]);
    if (found.length >= MAX_FINDINGS) return;
  }
}

async function scanRange(repo: string, tip: string, excludeTips: readonly string[], entries: readonly ScanEnvEntry[], maxCommitBytes: number): Promise<{ commits: number; findings: Finding[] }> {
  for (const r of [tip, ...excludeTips]) if (!safeRev(r)) throw new ScanError('unresolvable range');
  const resolve = async (r: string) => (await g(repo, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`], 4096)).trim();
  try {
    await resolve(tip);
    for (const e of excludeTips) await resolve(e);
  } catch {
    throw new ScanError('unresolvable range');
  }
  const listing = await g(repo, ['rev-list', '--parents', tip, ...(excludeTips.length ? ['--not', ...excludeTips] : [])], 64 * 1024 * 1024);
  const commits = listing.split('\n').filter(Boolean).map((l) => l.trim().split(' '));
  const values = secretLikeEnvValues(entries);
  const findings: Finding[] = [];
  for (const [sha, ...parents] of commits) {
    if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) throw new ScanError('unparseable rev-list output');
    if (parents.length > 1) findings.push({ commit: sha.slice(0, 10), file: '(merge commit)', what: 'merge commits are not scanned or pushed automatically' });
    else await scanCommit(repo, sha, values, maxCommitBytes, findings);
    if (findings.length >= MAX_FINDINGS) break;
  }
  return { commits: commits.length, findings };
}

/**
 * Per-commit, fail-closed scan of everything a push of `tip` would add beyond `excludeTips` (empty = all history reachable
 * from tip). Every commit is scanned separately, so a secret added and removed in a later commit is still found. Reasons
 * name commits and files only, never the secret.
 */
export async function scanPushRange(opts: { repoRoot: string; tip: string; excludeTips: string[]; envEntries: ScanEnvEntry[]; maxCommitBytes?: number }): Promise<{ ok: true } | ScanFailure> {
  try {
    const { findings } = await scanRange(opts.repoRoot, opts.tip, opts.excludeTips, opts.envEntries, opts.maxCommitBytes ?? DEFAULT_COMMIT_BYTES);
    if (!findings.length) return { ok: true };
    const commits = [...new Set(findings.map((f) => f.commit))];
    const files = [...new Set(findings.map((f) => f.file))].slice(0, 20);
    const reason = findings.slice(0, 6).map((f) => `${f.commit}: ${f.file} (${f.what})`).join('; ');
    return { ok: false, reason: `secret scan blocked the push: ${reason}`, commits, files };
  } catch (e) {
    const why = e instanceof ScanError ? e.message : 'unexpected error';
    return { ok: false, reason: `secret scan could not complete (${why}); nothing is treated as safe`, commits: [], files: [] };
  }
}

/**
 * Scan EVERYTHING the branch adds relative to the base (not just what Conductor itself staged): an agent may have
 * committed on its own (security review M1). Fail closed: a git error, truncation or over-cap commit is a finding.
 * `envSecrets` entries may be plain strings (legacy callers: no name is known, so every string value qualifies) or
 * `{name, value, multiline}` entries (C1: only secret-like values qualify). Findings never contain the secret itself.
 */
export async function scanBranchForSecrets(worktree: string, baseSha: string, envSecrets: readonly (string | ScanEnvEntry)[]): Promise<string[]> {
  const entries: ScanEnvEntry[] = envSecrets.map((s) => (typeof s === 'string' ? { name: 'SECRET', value: s } : s));
  try {
    const { findings } = await scanRange(worktree, 'HEAD', [baseSha], entries, DEFAULT_COMMIT_BYTES);
    return [...new Set(findings.map((f) => `${f.file} (${f.what})`))];
  } catch (e) {
    return [`secret scan could not complete (${e instanceof ScanError ? e.message : 'unexpected error'})`];
  }
}
