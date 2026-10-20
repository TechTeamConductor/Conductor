// A read-only SNAPSHOT of a repository at one commit, for Quick Ask (M5 §2b-1). Built by Conductor's own extractor from git objects — not
// `git archive | tar`: only REGULAR files are written (O_CREAT|O_EXCL|O_NOFOLLOW, files 0600, directories 0700); symlinks, gitlinks and
// anything else are not materialised; entry names are validated (no `.`/`..`/empty segment, no `.git` segment in any case, no control
// characters, bounded length/depth); agent-config directories are omitted; caps are measured from `ls-tree --long` sizes BEFORE writing.
import { constants, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { isObjectId, type GitSource, type TreeEntry } from '../context/gitread.ts';

export const SNAPSHOT_LIMITS = Object.freeze({ totalBytes: 500 * 1024 * 1024, files: 200_000, blobBytes: 25 * 1024 * 1024, nameLen: 1024, depth: 64, batchBytes: 24 * 1024 * 1024 });
const AGENT_CONFIG = /^(?:\.claude|\.cursor|\.codex|\.agents|\.husky)(?:\/|$)|^\.mcp\.json$/;
export class SnapshotTooLarge extends Error {}

export interface Snapshot { dir: string; files: number; symlinks: number; gitlinks: number; skippedLarge: number; skippedNames: number; omittedConfig: number; commit: string }

/** A repository path that may be materialised, else null. */
export function safeEntryName(p: string): string | null {
  if (!p || p.length > SNAPSHOT_LIMITS.nameLen || p.startsWith('/') || /[\u0000-\u001f\u007f]/.test(p)) return null;
  const segs = p.split('/');
  if (segs.length > SNAPSHOT_LIMITS.depth) return null;
  if (segs.some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git' || s.includes('\\'))) return null;
  return p;
}

export async function buildSnapshot(src: GitSource, commit: string, opts: { parent?: string } = {}): Promise<Snapshot> {
  if (!isObjectId(commit)) throw new Error('not a commit id');
  const { entries } = await src.lsTreeRecursive(commit);
  let files = 0, symlinks = 0, gitlinks = 0, skippedLarge = 0, skippedNames = 0, omittedConfig = 0, total = 0;
  const chosen: { e: TreeEntry; name: string }[] = [];
  for (const e of entries) {
    if (e.mode === '120000') { symlinks++; continue; }
    if (e.type === 'commit' || e.mode === '160000') { gitlinks++; continue; }
    if (e.type !== 'blob' || (e.mode !== '100644' && e.mode !== '100755')) continue;
    const name = safeEntryName(e.path);
    if (!name) { skippedNames++; continue; }
    if (AGENT_CONFIG.test(name)) { omittedConfig++; continue; }
    const size = e.size ?? 0;
    if (size > SNAPSHOT_LIMITS.blobBytes) { skippedLarge++; continue; }
    total += size;
    if (total > SNAPSHOT_LIMITS.totalBytes || chosen.length + 1 > SNAPSHOT_LIMITS.files) throw new SnapshotTooLarge('too large for Quick Ask — use Engineering Work');
    chosen.push({ e, name });
  }
  const dir = mkdtempSync(join(opts.parent ?? tmpdir(), 'conductor-ask-'));
  chmodSync(dir, 0o700);
  try {
    let i = 0;
    while (i < chosen.length) {
      let bytes = 0;
      const batch: typeof chosen = [];
      while (i < chosen.length && (batch.length === 0 || bytes + (chosen[i]!.e.size ?? 0) <= SNAPSHOT_LIMITS.batchBytes)) { bytes += chosen[i]!.e.size ?? 0; batch.push(chosen[i++]!); }
      const blobs = await src.catBuffers(batch.map((b) => b.e.sha), SNAPSHOT_LIMITS.blobBytes);
      for (const { e, name } of batch) {
        const data = blobs.get(e.sha);
        if (!data) { skippedLarge++; continue; }
        const target = resolve(dir, name);
        if (!target.startsWith(dir + sep)) { skippedNames++; continue; }
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeSync(fd, data); } finally { closeSync(fd); }
        files++;
      }
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return { dir, files, symlinks, gitlinks, skippedLarge, skippedNames, omittedConfig, commit };
}
export const removeSnapshot = (s: Snapshot): void => rmSync(s.dir, { recursive: true, force: true });
