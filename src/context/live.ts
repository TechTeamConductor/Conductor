// Facts computed AT USE TIME from git objects (plan §2b-2): what a builder prompt receives never comes from a file a builder could have
// rewritten. Module scans are keyed by tree id — content-addressed, so a result is valid forever and can be memoised in this process (a
// builder cannot reach this memory) — which makes repeated prompts of one run cost two git calls.
import { assembleFacts, scanModule, scanRoot, SCAN_LIMITS, type ManifestFacts, type ModuleScan } from './scan.ts';
import { isIdent, type ContextFacts } from './facts.ts';
import { GitReader, isObjectId, type GitSource } from './gitread.ts';
import type { RepoRef } from './incremental.ts';

const MODULE_MEMO_MAX = 400;
const BLOB_MEMO_MAX = 800;
const moduleMemo = new Map<string, ModuleScan>();
const blobMemo = new Map<string, ManifestFacts>();
const remember = <V>(m: Map<string, V>, k: string, v: V, max: number): void => {
  if (m.has(k)) m.delete(k);
  m.set(k, v);
  while (m.size > max) m.delete(m.keys().next().value as string);
};

/** Test seam. */
export function _clearLiveMemo(): void {
  moduleMemo.clear();
  blobMemo.clear();
}

export interface LiveFacts {
  facts: ContextFacts;
  commit: string;
  gitCalls: number;
}

/** Deterministic facts of `repo` at `commit` (a 40/64-hex id — the run's base commit, never a branch name taken from data). */
export async function liveFacts(repo: RepoRef, commit: string, opts: { git?: GitSource } = {}): Promise<LiveFacts> {
  if (!isObjectId(commit)) throw new Error('not a commit id');
  const src = opts.git ?? new GitReader(repo.path);
  const rootEntries = await src.lsTreeTop(commit);
  const dirs = rootEntries.filter((e) => e.type === 'tree' && isIdent(e.path)).sort((a, b) => a.path.localeCompare(b.path));
  const scans: ModuleScan[] = [];
  for (const d of dirs.slice(0, SCAN_LIMITS.maxTopDirs)) {
    let scan = moduleMemo.get(d.sha);
    if (!scan || scan.path !== d.path) {
      scan = await scanModule(src, d.path, d.sha);
      remember(moduleMemo, d.sha, scan, MODULE_MEMO_MAX);
    }
    scans.push(scan);
  }
  // root manifests: blobs already parsed in this process are reused (keyed by blob id)
  const known: Record<string, string> = {};
  const parsedKnown: Record<string, ManifestFacts> = {};
  for (const e of rootEntries) {
    const mf = e.type === 'blob' ? blobMemo.get(e.sha) : undefined;
    if (mf) {
      known[e.path] = e.sha;
      parsedKnown[e.path] = mf;
    }
  }
  const { root, parsed } = await scanRoot(src, rootEntries, { rootBlobs: known, parsed: parsedKnown });
  for (const [name, sha] of Object.entries(root.rootBlobs)) if (parsed[name]) remember(blobMemo, sha, parsed[name]!, BLOB_MEMO_MAX);
  return { facts: assembleFacts(root, scans, { gates: repo.gates, moduleOverflow: Math.max(0, dirs.length - SCAN_LIMITS.maxTopDirs) }), commit, gitCalls: src.calls };
}
