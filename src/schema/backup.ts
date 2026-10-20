import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { sha256 } from '../util.ts';

/**
 * Backups live OUTSIDE every Conductor home (so `uninstall --purge` cannot delete them). Override for tests/CI with
 * CONDUCTOR_BACKUP_DIR.
 */
export function backupRoot(): string {
  return process.env.CONDUCTOR_BACKUP_DIR && process.env.CONDUCTOR_BACKUP_DIR.length > 0 ? process.env.CONDUCTOR_BACKUP_DIR : join(homedir(), '.conductor-backups');
}

export interface BackupResult {
  dir: string;
  files: { name: string; sha256: string; bytes: number }[];
  /** Things deliberately not copied (symlinks, excluded names) — never silently dropped. */
  skipped: { path: string; why: string }[];
}

/** Never copied by default: credentials stored in the home, volatile runtime state, logs (security review S-7). */
export const DEFAULT_EXCLUDE = new Set(['secrets.json', 'run', 'logs', 'sessions.json']);

const safeLabel = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 60);

function walk(p: string, rel: string, out: { abs: string; rel: string }[], skipped: BackupResult['skipped'], exclude: ReadonlySet<string>): void {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) {
    skipped.push({ path: p, why: 'symbolic link (never followed)' });
    return;
  }
  if (exclude.has(basename(p))) {
    skipped.push({ path: p, why: 'excluded (credentials, runtime state or logs)' });
    return;
  }
  if (st.isDirectory()) {
    for (const n of readdirSync(p)) walk(join(p, n), rel ? join(rel, n) : n, out, skipped, exclude);
    return;
  }
  if (st.isFile()) out.push({ abs: p, rel });
  else skipped.push({ path: p, why: 'not a regular file' });
}

/**
 * Copy files/directories into a new timestamped folder with a sha256 manifest. Missing sources are skipped; symlinks are never
 * followed; two sources with the same basename never overwrite each other; every copy is verified against its source hash and a
 * mismatch throws (a backup that cannot be trusted is an error, not a warning).
 */
export function backupPaths(
  sources: string[],
  opts: {
    root?: string;
    label?: string;
    now?: () => number;
    exclude?: ReadonlySet<string>;
    /** Files larger than this are skipped (reported, never silently dropped). Default 50 MB. */
    maxFileBytes?: number;
    /** An allow-list: files for which this returns false are skipped (reported). */
    keep?: (absPath: string) => boolean;
  } = {},
): BackupResult {
  const root = opts.root ?? backupRoot();
  const exclude = opts.exclude ?? DEFAULT_EXCLUDE;
  const maxBytes = opts.maxFileBytes ?? 50 * 1024 * 1024;
  const ts = new Date((opts.now ?? Date.now)()).toISOString().replace(/[:.]/g, '-');
  const label = opts.label ? `-${safeLabel(opts.label)}` : '';
  let dir = join(root, `${ts}${label}`);
  for (let i = 2; existsSync(dir); i++) dir = join(root, `${ts}${label}-${i}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files: BackupResult['files'] = [];
  const skipped: BackupResult['skipped'] = [];
  const taken = new Set<string>();
  for (const src of sources) {
    if (!existsSync(src) && !(() => { try { return lstatSync(src).isSymbolicLink(); } catch { return false; } })()) continue;
    // each source gets its own top-level name inside the backup, unique even when basenames collide
    let top = safeLabel(basename(src)) || 'item';
    for (let i = 2; taken.has(top); i++) top = `${safeLabel(basename(src)) || 'item'}-${i}`;
    taken.add(top);
    const list: { abs: string; rel: string }[] = [];
    const isDir = (() => { try { return lstatSync(src).isDirectory(); } catch { return false; } })();
    walk(src, '', list, skipped, exclude);
    for (const f of list) {
      if (opts.keep && !opts.keep(f.abs)) {
        skipped.push({ path: f.abs, why: 'not an importable file (allow-list)' });
        continue;
      }
      if (lstatSync(f.abs).size > maxBytes) {
        skipped.push({ path: f.abs, why: `larger than ${Math.round(maxBytes / 1024 / 1024)} MB` });
        continue;
      }
      const rel = isDir ? join(top, f.rel) : top;
      const target = join(dir, rel);
      mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
      let before: Buffer;
      try {
        before = readFileSync(f.abs);
      } catch (e) {
        skipped.push({ path: f.abs, why: `unreadable (${(e as NodeJS.ErrnoException).code ?? 'error'})` });
        continue;
      }
      copyFileSync(f.abs, target);
      try {
        chmodSync(target, 0o600);
      } catch {
        /* best effort */
      }
      const copied = readFileSync(target);
      if (sha256(copied) !== sha256(before)) throw new Error(`backup verification failed for ${f.abs}`);
      files.push({ name: rel, sha256: sha256(before), bytes: before.length });
    }
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ createdAt: (opts.now ?? Date.now)(), files, skipped }, null, 2) + '\n', { mode: 0o600 });
  return { dir, files, skipped };
}
