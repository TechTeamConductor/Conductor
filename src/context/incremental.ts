// Refresh and staleness of a project's context (M4). Git object ids are authoritative: the unit of reuse is a top-level directory's TREE id,
// so an unchanged directory is never read again, an unchanged repository costs two git calls and no write, and a changed root manifest
// re-reads only that blob. A failed scan never blocks anything — it reports and leaves the previous store untouched.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { GateDef } from '../types.ts';
import { logger } from '../log.ts';
import { errMsg } from '../util.ts';
import { isIdent, normalizeFacts } from './facts.ts';
import { GitReader, isSafeBranch, type GitSource, type TreeEntry } from './gitread.ts';
import { ROOT_MANIFESTS, SCAN_LIMITS, assembleFacts, scanModule, scanRoot, type ManifestFacts, type ModuleScan } from './scan.ts';
import { loadContext, saveContext, type Manifest, type ModulesCache } from './store.ts';

const log = logger('context');
const DAY_MS = 86_400_000;
export const DEFAULT_STALE_DAYS = 14;
/** More than this share of top-level directories changed ⇒ a full rescan (cheaper to reason about than a big partial one). */
const FULL_RESCAN_SHARE = 0.6;

export interface RepoRef {
  name: string;
  path: string;
  baseBranch: string;
  gates: GateDef[];
}
export type StatusState = 'fresh' | 'stale' | 'missing' | 'corrupt' | 'newer' | 'unavailable';
export interface StatusInfo {
  state: StatusState;
  generatedAt?: number;
  headSha?: string;
  branch?: string;
  /** Plain-language reasons (stale/corrupt/unavailable). */
  reasons: string[];
  /** Top-level directories whose content changed since the facts were computed. */
  staleModules: string[];
  /** Top-level directories the facts cover. */
  modules: string[];
  truncated?: boolean;
  /** Strings dropped from the stored facts when they were re-validated on load (0 for an honest store). */
  dropped?: number;
}
export type RefreshAction = 'none' | 'touched' | 'incremental' | 'full' | 'refused' | 'unavailable';
export interface RefreshResult {
  action: RefreshAction;
  rescanned: string[];
  reused: string[];
  /** git processes started by this refresh. */
  gitCalls: number;
  status: StatusInfo;
  error?: string;
}
export interface ContextOpts {
  now?: () => number;
  staleDays?: number;
  /** Test seam: a stub for the git layer. */
  git?: GitSource;
  full?: boolean;
}

export function pathHash(path: string): string {
  let p = path;
  try {
    p = realpathSync(path);
  } catch {
    /* an unreadable path hashes as given */
  }
  return createHash('sha256').update(p).digest('hex').slice(0, 16);
}

interface Listing {
  commit: string;
  tree: string;
  rootEntries: TreeEntry[];
  tops: { path: string; treeSha: string }[];
  overflow: number;
  dropped: number;
  rootBlobs: Record<string, string>;
}

async function list(src: GitSource, repo: RepoRef): Promise<Listing> {
  if (!isSafeBranch(repo.baseBranch)) throw new Error('the repository base branch has an unusual name');
  const { commit, tree } = await src.resolveBranch(repo.baseBranch);
  const rootEntries = await src.lsTreeTop(commit);
  const dirs = rootEntries.filter((e) => e.type === 'tree').sort((a, b) => a.path.localeCompare(b.path));
  let dropped = 0;
  const tops: Listing['tops'] = [];
  for (const d of dirs) {
    if (!isIdent(d.path)) {
      dropped++;
      continue;
    }
    tops.push({ path: d.path, treeSha: d.sha });
  }
  const overflow = Math.max(0, tops.length - SCAN_LIMITS.maxTopDirs);
  const rootBlobs: Record<string, string> = {};
  for (const e of rootEntries) if (e.type === 'blob' && e.mode !== '120000') rootBlobs[e.path] = e.sha;
  return { commit, tree, rootEntries, tops: tops.slice(0, SCAN_LIMITS.maxTopDirs), overflow, dropped, rootBlobs };
}

const ROOT_MANIFEST_NAMES: ReadonlySet<string> = new Set(ROOT_MANIFESTS);
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const manifestRootChanged = (m: Manifest, l: Listing): boolean => {
  const names = new Set([...Object.keys(m.rootBlobs), ...Object.keys(l.rootBlobs).filter((n) => ROOT_MANIFEST_NAMES.has(n))]);
  for (const n of names) if (m.rootBlobs[n] !== l.rootBlobs[n]) return true;
  return false;
};

function topsDiff(m: Manifest, l: Listing): { changed: string[]; added: string[]; removed: string[] } {
  const old = new Map(m.tops.map((t) => [t.path, t.treeSha]));
  const now = new Map(l.tops.map((t) => [t.path, t.treeSha]));
  return {
    changed: l.tops.filter((t) => old.has(t.path) && old.get(t.path) !== t.treeSha).map((t) => t.path),
    added: l.tops.filter((t) => !old.has(t.path)).map((t) => t.path),
    removed: m.tops.filter((t) => !now.has(t.path)).map((t) => t.path),
  };
}

// ───────────────────────── status ─────────────────────────

export async function contextStatus(key: string, repo: RepoRef, opts: ContextOpts = {}): Promise<StatusInfo> {
  const now = (opts.now ?? Date.now)();
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const loaded = loadContext(key);
  if (loaded.state === 'missing') return { state: 'missing', reasons: ['No project context has been built yet.'], staleModules: [], modules: [] };
  if (loaded.state === 'newer') return { state: 'newer', reasons: [`The context was written by a newer Conductor (data version ${loaded.version}); this build leaves it alone.`], staleModules: [], modules: [] };
  if (loaded.state === 'corrupt') return { state: 'corrupt', reasons: [`The stored context could not be trusted (${loaded.why}); it was set aside and will be rebuilt.`], staleModules: [], modules: [] };
  const { manifest, facts, dropped } = loaded;
  const base: StatusInfo = { state: 'fresh', generatedAt: manifest.generatedAt, headSha: manifest.headSha, branch: manifest.branch, reasons: [], staleModules: [], modules: manifest.tops.map((t) => t.path), truncated: facts.counts.truncated, dropped };
  let l: Listing;
  try {
    l = await list(opts.git ?? new GitReader(repo.path, { now: opts.now }), repo);
  } catch (e) {
    return { ...base, state: 'unavailable', reasons: [`The repository could not be read: ${errMsg(e)}`] };
  }
  const reasons: string[] = [];
  if (l.tree !== manifest.treeSha) reasons.push(`The base branch changed (${manifest.headSha.slice(0, 7)} → ${l.commit.slice(0, 7)}).`);
  const d = topsDiff(manifest, l);
  const staleModules = [...d.changed, ...d.added, ...d.removed].sort();
  if (staleModules.length) reasons.push(`Changed directories: ${staleModules.slice(0, 8).join(', ')}${staleModules.length > 8 ? ` and ${staleModules.length - 8} more` : ''}.`);
  if (manifestRootChanged(manifest, l)) reasons.push('A root configuration file changed.');
  if (!sameJson(facts.gates, normalizeFacts({ gates: repo.gates }).facts.gates)) reasons.push("The repository's quality gates changed.");
  if (now - manifest.generatedAt > staleDays * DAY_MS) reasons.push(`Older than ${staleDays} days.`);
  if (manifest.repoPathHash !== pathHash(repo.path)) reasons.push('The store was built from a different checkout path.');
  if (dropped > 0) reasons.push('Some stored entries failed validation and were ignored.');
  return { ...base, state: reasons.length ? 'stale' : 'fresh', reasons, staleModules };
}

// ───────────────────────── refresh ─────────────────────────

const inflight = new Map<string, Promise<RefreshResult>>();

/** Build or update the project's context. Concurrent calls for one project share one run. Never throws. */
export function refreshContext(key: string, repo: RepoRef, opts: ContextOpts = {}): Promise<RefreshResult> {
  const cur = inflight.get(key);
  if (cur) return cur;
  const p = doRefresh(key, repo, opts)
    .catch(async (e): Promise<RefreshResult> => {
      log.warn(`${key}: context refresh failed: ${errMsg(e)}`);
      return { action: 'unavailable', rescanned: [], reused: [], gitCalls: 0, status: { state: 'unavailable', reasons: [errMsg(e)], staleModules: [], modules: [] }, error: errMsg(e) };
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function doRefresh(key: string, repo: RepoRef, opts: ContextOpts): Promise<RefreshResult> {
  const nowMs = (opts.now ?? Date.now)();
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const src = opts.git ?? new GitReader(repo.path, { now: opts.now });
  const done = (action: RefreshAction, rescanned: string[], reused: string[], status: StatusInfo, error?: string): RefreshResult => ({ action, rescanned, reused, gitCalls: src.calls, status, error });
  const loaded = loadContext(key);
  if (loaded.state === 'newer') return done('refused', [], [], await contextStatus(key, repo, opts), 'The stored context was written by a newer Conductor; it was not touched.');
  let l: Listing;
  try {
    l = await list(src, repo);
  } catch (e) {
    return done('unavailable', [], [], { state: 'unavailable', reasons: [errMsg(e)], staleModules: [], modules: [] }, errMsg(e));
  }
  const hash = pathHash(repo.path);
  const ok = loaded.state === 'ok' ? loaded : null;
  const gatesFacts = normalizeFacts({ gates: repo.gates }).facts.gates;
  let full = !!opts.full || !ok || ok.dropped > 0 || ok.manifest.repoPathHash !== hash;

  if (ok && !full) {
    const gatesSame = sameJson(ok.facts.gates, gatesFacts);
    if (ok.manifest.treeSha === l.tree && gatesSame) {
      const aged = nowMs - ok.manifest.generatedAt > staleDays * DAY_MS;
      if (ok.manifest.headSha === l.commit && !aged) return done('none', [], ok.manifest.tops.map((t) => t.path), await freshStatus(ok.manifest, ok.facts.counts.truncated, ok.dropped));
      // the content is identical (an empty commit, or just old): only the bookkeeping moves — no scan
      const manifest = saveContext(key, { manifest: { ...stripManifest(ok.manifest), headSha: l.commit, branch: repo.baseBranch, generatedAt: nowMs }, facts: ok.facts, cache: ok.cache });
      return done('touched', [], manifest.tops.map((t) => t.path), await freshStatus(manifest, ok.facts.counts.truncated, 0));
    }
    const d = topsDiff(ok.manifest, l);
    const total = Math.max(1, l.tops.length);
    if (d.changed.length + d.added.length >= 5 && (d.changed.length + d.added.length) / total > FULL_RESCAN_SHARE) full = true;
  }

  const rescanned: string[] = [];
  const reused: string[] = [];
  const scans: ModuleScan[] = [];
  const cache: ModulesCache = { schemaVersion: 1, tops: Object.create(null), parsedRoot: Object.create(null) };
  for (const t of l.tops) {
    const prev = ok && !full ? ok.cache.tops[t.path] : undefined;
    if (prev && prev.treeSha === t.treeSha) {
      scans.push(prev);
      cache.tops[t.path] = prev;
      reused.push(t.path);
    } else {
      const scan = await scanModule(src, t.path, t.treeSha);
      scans.push(scan);
      cache.tops[t.path] = scan;
      rescanned.push(t.path);
    }
  }
  const reuse = ok && !full ? { rootBlobs: ok.manifest.rootBlobs, parsed: ok.cache.parsedRoot as Record<string, ManifestFacts> } : undefined;
  const { root, parsed } = await scanRoot(src, l.rootEntries, reuse);
  for (const [n, mf] of Object.entries(parsed)) cache.parsedRoot[n] = mf;
  root.dropped += l.dropped;
  const facts = assembleFacts(root, scans, { gates: repo.gates, moduleOverflow: l.overflow });
  const manifest = saveContext(key, {
    manifest: { repoPathHash: hash, branch: repo.baseBranch, headSha: l.commit, treeSha: l.tree, generatedAt: nowMs, tops: l.tops, rootBlobs: root.rootBlobs, moduleOverflow: l.overflow, truncated: facts.counts.truncated },
    facts,
    cache,
  });
  return done(full ? 'full' : 'incremental', rescanned, reused, await freshStatus(manifest, facts.counts.truncated, 0));
}

function stripManifest(m: Manifest): Omit<Manifest, 'schemaVersion' | 'factsSha256' | 'modulesSha256'> {
  const { schemaVersion: _s, factsSha256: _f, modulesSha256: _m, ...rest } = m;
  return rest;
}
async function freshStatus(m: Manifest, truncated: boolean, dropped: number): Promise<StatusInfo> {
  return { state: 'fresh', generatedAt: m.generatedAt, headSha: m.headSha, branch: m.branch, reasons: [], staleModules: [], modules: m.tops.map((t) => t.path), truncated, dropped };
}
