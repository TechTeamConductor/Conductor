// Per-(provider, account) model cache (M8-1 §2.5, B3/C2, Security S12/S12a, R2-3). `<home>/models/<provider>/<account>.json`.
//  - folders: real directories (lstat), owned by the user, 0700 (tightened), created 0700;
//  - read: open(O_RDONLY|O_NOFOLLOW|O_NONBLOCK) → fstat on the handle (regular, owned, ≤ 4 MB) → read through the handle → JSON.parse;
//    `version === 1` required (missing/other ⇒ corrupt ⇒ quarantined, ≤ 3 kept); an integer > 1 ⇒ newer ⇒ left untouched;
//  - write: atomic temp+rename, 0600, version stamped — after a no-follow newer check (not saveVersioned: L2);
//  - every field re-validated by the sanitiser (a hand-edited cache is untrusted too); families are never read (recomputed);
//  - parse/corruption messages are never surfaced (V8 echoes file text in them).
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, rmSync, renameSync } from 'node:fs';
import { securePrivateDir } from './workdir.ts';
import { join, resolve, sep } from 'node:path';
import { paths } from '../paths.ts';
import type { VersionSpec } from '../schema/version.ts';
import { atomicWriteFile } from '../util.ts';
import type { Catalog, CatalogSource, ModelEntry, ProviderId } from './types.ts';
import { MODEL_PROVIDERS } from './types.ts';
import { ACCOUNT_RE, LABEL_MAX, MAX_MODELS, cleanEffort, cleanEfforts, cleanId, cleanPlan, cleanText, cleanVersion, isObj, own } from './sanitize.ts';

export const MODEL_CACHE_SPEC: VersionSpec = { kind: 'model cache', field: 'version', current: 1, assumeWhenMissing: 1 };
export const CACHE_MAX_BYTES = 4 * 1024 * 1024;
export const FUTURE_SLACK_MS = 5 * 60_000;
const KEEP_QUARANTINED = 3;
const SOURCES: readonly CatalogSource[] = ['claude-initialize', 'cursor-list-models', 'codex-app-server'];

export const CACHE_REASONS = {
  folder: 'the model cache folder is not a plain folder',
  unreadable: 'the model cache file was unreadable and was set aside',
  newer: 'a newer Conductor wrote this list; showing this session\'s copy',
} as const;

export type CacheRead =
  | { kind: 'none' }
  | { kind: 'ok'; catalog: Catalog; /** fetchedAt was more than 5 min in the future: shown stale, with no age (S12a) */ futureTime: boolean }
  | { kind: 'newer' }
  | { kind: 'quarantined' }
  | { kind: 'refused'; reason: string };

const myUid = (): number | null => (typeof process.getuid === 'function' ? process.getuid() : null);

/** Path from the provider enum + account regex only, asserted inside the models folder (S12). Throws on anything else. */
export function cacheFile(provider: ProviderId, account: string): string {
  if (!MODEL_PROVIDERS.includes(provider)) throw new Error('unknown provider');
  if (!ACCOUNT_RE.test(account)) throw new Error('bad account');
  const root = resolve(paths.models());
  const f = resolve(root, provider, `${account}.json`);
  if (!f.startsWith(root + sep)) throw new Error('cache path escapes the models folder');
  return f;
}

/** A real (non-link) directory owned by the user with mode 0700 — checked and tightened through a no-follow handle (L1, workdir.ts). */
function checkDir(dir: string, create: boolean): 'ok' | 'missing' | 'bad' {
  return securePrivateDir(dir, create);
}

/** Check (and with `create`, make) `<home>/models` and `<home>/models/<provider>`. */
export function checkCacheDirs(provider: ProviderId, create: boolean): 'ok' | 'missing' | 'bad' {
  const a = checkDir(paths.models(), create);
  if (a !== 'ok') return a;
  return checkDir(join(paths.models(), provider), create);
}

/** Rename a bad cache file aside and keep only the newest 3 quarantined copies of it (S12a). Never follows a link. */
export function quarantineCache(file: string): void {
  try {
    let ts = Date.now();
    while (existsSync(`${file}.corrupt-${ts}`)) ts++; // two in the same millisecond must not overwrite each other
    renameSync(file, `${file}.corrupt-${ts}`); // rename moves a link itself, never its target
  } catch {
    try {
      rmSync(file, { force: true });
    } catch {
      /* nothing more we can do */
    }
  }
  try {
    const dir = resolve(file, '..');
    const base = file.slice(dir.length + 1);
    const old = readdirSync(dir)
      .filter((n) => n.startsWith(`${base}.corrupt-`))
      .sort((a, b) => Number(b.slice(base.length + 9)) - Number(a.slice(base.length + 9)));
    for (const n of old.slice(KEEP_QUARANTINED)) rmSync(join(dir, n), { force: true });
  } catch {
    /* best effort */
  }
}

/** Read the file through a no-follow handle. 'link' / 'notfile' / 'big' are refused before any byte is read. */
function readNoFollow(file: string): { kind: 'none' } | { kind: 'link' } | { kind: 'bad' } | { kind: 'text'; text: string } {
  let pre;
  try {
    pre = lstatSync(file);
  } catch {
    return { kind: 'none' };
  }
  if (pre.isSymbolicLink()) return { kind: 'link' };
  if (!pre.isFile() || pre.size > CACHE_MAX_BYTES) return { kind: 'bad' };
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'none' };
    if (code === 'ELOOP' || code === 'EMLINK') return { kind: 'link' };
    return { kind: 'bad' };
  }
  try {
    const st = fstatSync(fd);
    const uid = myUid();
    if (!st.isFile() || st.size > CACHE_MAX_BYTES || (uid !== null && st.uid !== uid)) return { kind: 'bad' };
    const buf = Buffer.alloc(Math.min(st.size, CACHE_MAX_BYTES) + 1);
    let n = 0;
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r <= 0) break;
      n += r;
      if (n >= buf.length) return { kind: 'bad' }; // grew past its fstat size while we read
    }
    return { kind: 'text', text: buf.subarray(0, n).toString('utf8') };
  } catch {
    return { kind: 'bad' };
  } finally {
    closeSync(fd);
  }
}

/** Re-validate one stored entry exactly like a fresh CLI entry (S8): literal construction, flags only `=== true`. */
function entryFrom(m: unknown, provider: ProviderId): ModelEntry | null {
  const id = cleanId(own(m, 'id'), provider);
  if (!id) return null;
  const e: ModelEntry = { id, label: cleanText(own(m, 'label'), LABEL_MAX) || id };
  const resolved = cleanId(own(m, 'resolved'), provider);
  if (resolved) e.resolved = resolved;
  const efforts = cleanEfforts(own(m, 'efforts'));
  if (efforts.length) e.efforts = efforts;
  const de = cleanEffort(own(m, 'defaultEffort'));
  if (de) e.defaultEffort = de;
  for (const k of ['isDefault', 'fast', 'thinking', 'adaptiveThinking', 'thinkingOff', 'noZdr'] as const) if (own(m, k) === true) e[k] = true;
  return e;
}

/** Validate a parsed cache object for (provider, account). null = corrupt. */
export function catalogFrom(raw: unknown, provider: ProviderId, account: string, now: number): { catalog: Catalog; futureTime: boolean } | null {
  if (!isObj(raw)) return null;
  if (own(raw, 'version') !== 1) return null;
  if (own(raw, 'provider') !== provider || own(raw, 'account') !== account) return null; // S12a
  const source = own(raw, 'source');
  if (typeof source !== 'string' || !SOURCES.includes(source as CatalogSource)) return null;
  const fetchedAt = own(raw, 'fetchedAt');
  if (typeof fetchedAt !== 'number' || !Number.isInteger(fetchedAt) || fetchedAt <= 0) return null;
  const rawModels = own(raw, 'models');
  if (!Array.isArray(rawModels)) return null;
  const models: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const m of rawModels) {
    if (models.length >= MAX_MODELS) break;
    const e = entryFrom(m, provider);
    if (e && !seen.has(e.id)) {
      seen.add(e.id);
      models.push(e);
    }
  }
  const signedIn = own(raw, 'signedIn');
  const plan = cleanPlan(own(raw, 'plan'));
  const catalog: Catalog = {
    version: 1,
    provider,
    account,
    source: source as CatalogSource,
    cliVersion: cleanVersion(own(raw, 'cliVersion')),
    fetchedAt,
    signedIn: signedIn === true ? true : signedIn === false ? false : null,
    ...(plan ? { plan } : {}),
    models,
  };
  return { catalog, futureTime: fetchedAt > now + FUTURE_SLACK_MS };
}

/** Load the cache for (provider, account). Never throws; never surfaces file text. */
export function readCache(provider: ProviderId, account: string, now: number): CacheRead {
  let file: string;
  try {
    file = cacheFile(provider, account);
  } catch {
    return { kind: 'refused', reason: CACHE_REASONS.folder };
  }
  const d = checkCacheDirs(provider, false);
  if (d === 'missing') return { kind: 'none' };
  if (d === 'bad') return { kind: 'refused', reason: CACHE_REASONS.folder };
  const r = readNoFollow(file);
  if (r.kind === 'none') return { kind: 'none' };
  if (r.kind === 'link') {
    try {
      rmSync(file, { force: true }); // the link itself; its target is never touched
    } catch {
      /* ignore */
    }
    return { kind: 'none' };
  }
  if (r.kind === 'bad') {
    quarantineCache(file);
    return { kind: 'quarantined' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(r.text);
  } catch {
    quarantineCache(file); // the parse message is never logged (it can echo file text)
    return { kind: 'quarantined' };
  }
  const v = own(raw, 'version');
  if (typeof v === 'number' && Number.isInteger(v) && v > MODEL_CACHE_SPEC.current) return { kind: 'newer' }; // untouched (B3/C2)
  const c = catalogFrom(raw, provider, account, now);
  if (!c) {
    quarantineCache(file);
    return { kind: 'quarantined' };
  }
  return { kind: 'ok', catalog: c.catalog, futureTime: c.futureTime };
}

/**
 * Write a fresh catalog. Returns 'newer' (nothing written: a newer Conductor's file stays untouched), 'refused' (folder not plain) or
 * 'written'. Never throws.
 */
export function writeCache(catalog: Catalog): 'written' | 'newer' | 'refused' | 'failed' {
  let file: string;
  try {
    file = cacheFile(catalog.provider, catalog.account);
  } catch {
    return 'refused';
  }
  if (checkCacheDirs(catalog.provider, true) !== 'ok') return 'refused';
  const r = readNoFollow(file);
  if (r.kind === 'link') {
    try {
      rmSync(file, { force: true });
    } catch {
      return 'failed';
    }
  } else if (r.kind === 'text') {
    let v: unknown;
    let parsed = true;
    try {
      v = own(JSON.parse(r.text), 'version');
    } catch {
      parsed = false;
    }
    if (parsed && typeof v === 'number' && Number.isInteger(v) && v > MODEL_CACHE_SPEC.current) return 'newer';
    // Reviewer N1: an unreadable or unversioned file is set aside exactly as the read path does (S12a), never silently overwritten
    if (!parsed || v !== MODEL_CACHE_SPEC.current) quarantineCache(file);
  } else if (r.kind === 'bad') {
    quarantineCache(file);
  }
  // literal construction: exactly the Catalog fields, nothing else from anywhere
  const data = {
    version: 1,
    provider: catalog.provider,
    account: catalog.account,
    source: catalog.source,
    cliVersion: catalog.cliVersion,
    fetchedAt: catalog.fetchedAt,
    signedIn: catalog.signedIn,
    ...(catalog.plan ? { plan: catalog.plan } : {}),
    models: catalog.models,
  };
  try {
    // Security code review L2: not saveVersioned — its assertNotNewer re-reads the path with readFileSync (follows links). The newer
    // check above already ran through the no-follow handle; this is the same atomic temp+rename write (random temp name; the rename
    // replaces a link at the final path, never writes through it), with the version stamped (MODEL_CACHE_SPEC.current), mode 0600.
    atomicWriteFile(file, JSON.stringify({ ...data, [MODEL_CACHE_SPEC.field]: MODEL_CACHE_SPEC.current }, null, 2) + '\n', 0o600);
    return 'written';
  } catch {
    return 'failed';
  }
}
