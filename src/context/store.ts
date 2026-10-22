// The on-disk project context store (M4): `<home>/projects/<KEY>/context/{manifest,facts,modules}.json`.
//
// Honest about what it is: a CACHE for read-only stages and the UI. It lives in Conductor's own home, is written only by Conductor's code,
// is versioned (a newer file is refused, never overwritten), carries content hashes — and is STILL RE-VALIDATED on every load, because a
// hash next to a file detects corruption, not tampering, and a `--force` builder runs as the user and can rewrite it. What a builder prompt
// receives is recomputed from git objects at use time (plan §2b-2), never read from here.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { paths } from '../paths.ts';
import { atomicWriteFile } from '../util.ts';
import { CorruptFileError, NewerVersionError } from '../schema/errors.ts';
import { loadVersioned, quarantine, type VersionSpec } from '../schema/version.ts';
import { FACT_LIMITS, cleanCommand, isIdent, normalizeFacts, MODULE_KINDS, type ContextFacts, type ContextScript, type ModuleKind } from './facts.ts';
import { isObjectId } from './gitread.ts';
import { ROOT_MANIFESTS, SCAN_LIMITS, type ManifestFacts, type ModuleScan } from './scan.ts';

export const CONTEXT_SPEC: VersionSpec = { kind: 'project context', field: 'schemaVersion', current: 1, assumeWhenMissing: 1 };
export const PROJECT_KEY_RE = /^[A-Z]{2,6}$/;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_MODULES_BYTES = 8 * 1024 * 1024;

export interface Manifest {
  schemaVersion: 1;
  /** Which checkout the facts were computed from. Not a trust anchor — only a hint that the store belongs to another path. */
  repoPathHash: string;
  branch: string;
  headSha: string;
  treeSha: string;
  generatedAt: number;
  /** One entry per scanned top-level directory (the cache unit). */
  tops: { path: string; treeSha: string }[];
  rootBlobs: Record<string, string>;
  moduleOverflow: number;
  truncated: boolean;
  factsSha256: string;
  modulesSha256: string;
}
export interface ModulesCache {
  schemaVersion: 1;
  /** top-level directory name → its scan, valid for exactly that tree id. */
  tops: Record<string, ModuleScan>;
  /** parsed root manifests, valid for the blob ids in the manifest. */
  parsedRoot: Record<string, ManifestFacts>;
}

export type LoadResult =
  | { state: 'missing' }
  | { state: 'newer'; version: number }
  | { state: 'corrupt'; why: string; quarantined: string[] }
  | { state: 'ok'; manifest: Manifest; facts: ContextFacts; cache: ModulesCache; dropped: number };

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export function assertProjectKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !PROJECT_KEY_RE.test(key)) throw new Error('not a project key');
}
export function contextDir(key: string): string {
  assertProjectKey(key);
  return join(paths.home(), 'projects', key, 'context');
}

/** Create `<home>/projects/<KEY>/context` with explicit 0700 modes; a symlink or file in the way is an error, never followed. */
export function ensureContextDir(key: string): string {
  const dir = contextDir(key);
  const home = paths.home();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  let cur = home;
  for (const part of ['projects', key, 'context']) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      mkdirSync(cur, { mode: 0o700 });
      chmodSync(cur, 0o700);
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${cur} is not a real directory — Conductor will not use it`);
    chmodSync(cur, 0o700);
  }
  const real = realpathSync(dir);
  if (!(real + sep).startsWith(realpathSync(home) + sep)) throw new Error('the context directory resolves outside the Conductor home');
  return dir;
}

// ───────────────────────── validation of what comes back from disk ─────────────────────────

const own = (o: unknown, k: string): unknown => (o && typeof o === 'object' && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const idList = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter(isIdent).slice(0, max) : []);

function validateManifest(raw: unknown): Manifest | null {
  const repoPathHash = own(raw, 'repoPathHash');
  const branch = own(raw, 'branch');
  const headSha = own(raw, 'headSha');
  const treeSha = own(raw, 'treeSha');
  const factsSha = own(raw, 'factsSha256');
  const modulesSha = own(raw, 'modulesSha256');
  if (typeof repoPathHash !== 'string' || !/^[0-9a-f]{16}$/.test(repoPathHash)) return null;
  if (typeof branch !== 'string' || branch.length > 201) return null;
  if (!isObjectId(headSha) || !isObjectId(treeSha)) return null;
  if (typeof factsSha !== 'string' || !/^[0-9a-f]{64}$/.test(factsSha) || typeof modulesSha !== 'string' || !/^[0-9a-f]{64}$/.test(modulesSha)) return null;
  const topsRaw = own(raw, 'tops');
  if (!Array.isArray(topsRaw) || topsRaw.length > SCAN_LIMITS.maxTopDirs) return null;
  const tops: Manifest['tops'] = [];
  for (const t of topsRaw) {
    const p = own(t, 'path');
    const s = own(t, 'treeSha');
    if (!isIdent(p) || !isObjectId(s)) return null;
    tops.push({ path: p, treeSha: s });
  }
  const rootBlobs: Record<string, string> = Object.create(null);
  const rb = own(raw, 'rootBlobs');
  if (rb && typeof rb === 'object') {
    for (const name of ROOT_MANIFESTS) {
      const v = own(rb, name);
      if (v !== undefined) {
        if (!isObjectId(v)) return null;
        rootBlobs[name] = v;
      }
    }
  }
  const generatedAt = own(raw, 'generatedAt');
  if (typeof generatedAt !== 'number' || !Number.isFinite(generatedAt) || generatedAt < 0) return null;
  return { schemaVersion: 1, repoPathHash, branch, headSha, treeSha, generatedAt, tops, rootBlobs, moduleOverflow: num(own(raw, 'moduleOverflow')), truncated: own(raw, 'truncated') === true, factsSha256: factsSha, modulesSha256: modulesSha };
}

function validateScripts(v: unknown, max: number): ContextScript[] {
  const out: ContextScript[] = [];
  for (const s of Array.isArray(v) ? v : []) {
    const name = own(s, 'name');
    if (isIdent(name) && out.length < max) out.push({ name, command: cleanCommand(own(s, 'command')) });
  }
  return out;
}
function validateManifestFacts(raw: unknown): ManifestFacts {
  return {
    frameworks: idList(own(raw, 'frameworks'), FACT_LIMITS.frameworks),
    scripts: validateScripts(own(raw, 'scripts'), FACT_LIMITS.scripts),
    packageManagers: idList(own(raw, 'packageManagers'), FACT_LIMITS.packageManagers),
    entryPoints: idList(own(raw, 'entryPoints'), FACT_LIMITS.entryPoints),
    workspaces: [],
  };
}
const kindOf = (v: unknown): ModuleKind => (MODULE_KINDS.includes(v as ModuleKind) ? (v as ModuleKind) : 'lib');
function validateScan(raw: unknown, path: string): ModuleScan | null {
  const treeSha = own(raw, 'treeSha');
  if (!isObjectId(treeSha) || own(raw, 'path') !== path) return null;
  const langs: Record<string, number> = Object.create(null);
  const lr = own(raw, 'languages');
  if (lr && typeof lr === 'object') {
    for (const k of Object.keys(lr).slice(0, 200)) if (Object.hasOwn(lr, k) && /^[a-z0-9]{1,8}$/.test(k)) langs[k] = num((lr as Record<string, unknown>)[k]);
  }
  const children: ModuleScan['children'] = [];
  const cr = own(raw, 'children');
  for (const c of Array.isArray(cr) ? cr.slice(0, SCAN_LIMITS.maxChildren) : []) {
    const p = own(c, 'path');
    if (isIdent(p)) children.push({ path: p, kind: kindOf(own(c, 'kind')), files: num(own(c, 'files')), languages: idList(own(c, 'languages'), FACT_LIMITS.moduleLanguages), entryPoints: idList(own(c, 'entryPoints'), FACT_LIMITS.entryPoints) });
  }
  return {
    path,
    treeSha,
    kind: kindOf(own(raw, 'kind')),
    files: num(own(raw, 'files')),
    languages: langs,
    entryPoints: idList(own(raw, 'entryPoints'), FACT_LIMITS.entryPoints),
    testFiles: num(own(raw, 'testFiles')),
    testDirs: idList(own(raw, 'testDirs'), FACT_LIMITS.testDirs),
    children,
    frameworks: idList(own(raw, 'frameworks'), FACT_LIMITS.frameworks),
    scripts: validateScripts(own(raw, 'scripts'), FACT_LIMITS.scripts),
    packageManagers: idList(own(raw, 'packageManagers'), FACT_LIMITS.packageManagers),
    ci: idList(own(raw, 'ci'), FACT_LIMITS.ci),
    important: idList(own(raw, 'important'), FACT_LIMITS.importantFiles),
    conventions: idList(own(raw, 'conventions'), FACT_LIMITS.conventionsFiles),
    symlinks: num(own(raw, 'symlinks')),
    submodules: num(own(raw, 'submodules')),
    truncated: own(raw, 'truncated') === true,
    dropped: num(own(raw, 'dropped')),
  };
}
function validateCache(raw: unknown, manifest: Manifest): ModulesCache | null {
  const tops: Record<string, ModuleScan> = Object.create(null);
  const tr = own(raw, 'tops');
  if (!tr || typeof tr !== 'object') return null;
  for (const t of manifest.tops) {
    const scan = validateScan(own(tr, t.path), t.path);
    if (!scan || scan.treeSha !== t.treeSha) return null; // a cache entry that does not match the manifest is not usable
    tops[t.path] = scan;
  }
  const parsedRoot: Record<string, ManifestFacts> = Object.create(null);
  const pr = own(raw, 'parsedRoot');
  for (const name of Object.keys(manifest.rootBlobs)) parsedRoot[name] = validateManifestFacts(own(pr, name));
  return { schemaVersion: 1, tops, parsedRoot };
}

// ───────────────────────── load / save ─────────────────────────

function quarantineAll(dir: string): string[] {
  const out: string[] = [];
  for (const f of ['manifest.json', 'facts.json', 'modules.json']) {
    const q = quarantine(join(dir, f));
    if (q) out.push(q);
  }
  return out;
}

/** Read the store. NEVER throws for bad content: it reports `corrupt` (after quarantining the files) or `newer` (and leaves them alone). */
export function loadContext(key: string): LoadResult {
  const dir = contextDir(key);
  const mf = join(dir, 'manifest.json');
  if (!existsSync(mf)) return { state: 'missing' };
  const corrupt = (why: string): LoadResult => ({ state: 'corrupt', why, quarantined: quarantineAll(dir) });
  try {
    if (statSync(mf).size > MAX_MANIFEST_BYTES) return corrupt('manifest too large');
    const loaded = loadVersioned<Record<string, unknown>>(mf, CONTEXT_SPEC, () => ({}));
    const manifest = validateManifest(loaded.data);
    if (!manifest) return corrupt('manifest has an unexpected shape');
    const fp = join(dir, 'facts.json');
    const mp = join(dir, 'modules.json');
    if (!existsSync(fp) || !existsSync(mp)) return corrupt('a context file is missing');
    if (statSync(fp).size > FACT_LIMITS.factsBytes || statSync(mp).size > MAX_MODULES_BYTES) return corrupt('a context file is too large');
    const factsText = readFileSync(fp, 'utf8');
    const modulesText = readFileSync(mp, 'utf8');
    if (sha256(factsText) !== manifest.factsSha256 || sha256(modulesText) !== manifest.modulesSha256) return corrupt('content hash mismatch');
    const nf = normalizeFacts(JSON.parse(factsText));
    const cache = validateCache(JSON.parse(modulesText), manifest);
    if (!cache) return corrupt('the module cache does not match the manifest');
    return { state: 'ok', manifest, facts: nf.facts, cache, dropped: nf.dropped };
  } catch (e) {
    if (e instanceof NewerVersionError) return { state: 'newer', version: e.found };
    if (e instanceof CorruptFileError || e instanceof SyntaxError) return corrupt(e instanceof SyntaxError ? 'not valid JSON' : 'unreadable manifest');
    throw e; // an I/O error is not corruption: nothing is touched
  }
}

/** Write facts and the module cache first, the manifest (which binds their hashes) last. */
export function saveContext(key: string, parts: { manifest: Omit<Manifest, 'schemaVersion' | 'factsSha256' | 'modulesSha256'>; facts: ContextFacts; cache: ModulesCache }): Manifest {
  const dir = ensureContextDir(key);
  const factsText = JSON.stringify(parts.facts) + '\n';
  if (Buffer.byteLength(factsText) > FACT_LIMITS.factsBytes) throw new Error('the project facts are too large to store');
  const modulesText = JSON.stringify(parts.cache) + '\n';
  const manifest: Manifest = { ...parts.manifest, schemaVersion: 1, factsSha256: sha256(factsText), modulesSha256: sha256(modulesText) };
  atomicWriteFile(join(dir, 'facts.json'), factsText, 0o600, { durable: true });
  atomicWriteFile(join(dir, 'modules.json'), modulesText, 0o600, { durable: true });
  atomicWriteFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 0o600, { durable: true });
  return manifest;
}
