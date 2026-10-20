import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
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
}

function listFiles(p: string): string[] {
  const st = statSync(p);
  if (!st.isDirectory()) return [p];
  const out: string[] = [];
  for (const n of readdirSync(p)) out.push(...listFiles(join(p, n)));
  return out;
}

/** Copy files/directories into a new timestamped folder with a sha256 manifest. Missing sources are skipped. Never throws on a missing source. */
export function backupPaths(sources: string[], opts: { root?: string; label?: string; now?: () => number } = {}): BackupResult {
  const root = opts.root ?? backupRoot();
  const ts = new Date((opts.now ?? Date.now)()).toISOString().replace(/[:.]/g, '-');
  let dir = join(root, `${ts}${opts.label ? `-${opts.label}` : ''}`);
  for (let i = 2; existsSync(dir); i++) dir = join(root, `${ts}${opts.label ? `-${opts.label}` : ''}-${i}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files: BackupResult['files'] = [];
  for (const src of sources) {
    if (!existsSync(src)) continue;
    const base = statSync(src).isDirectory() ? src : join(src, '..');
    for (const f of listFiles(src)) {
      const rel = statSync(src).isDirectory() ? join(basename(src), relative(base, f)) : basename(f);
      const target = join(dir, rel);
      mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
      copyFileSync(f, target);
      const buf = readFileSync(f);
      files.push({ name: rel, sha256: sha256(buf), bytes: buf.length });
    }
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ createdAt: (opts.now ?? Date.now)(), files }, null, 2) + '\n', { mode: 0o600 });
  return { dir, files };
}
