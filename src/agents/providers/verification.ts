// Where "this provider's build isolation was proven" comes from (Security conditions 1c / 5).
// Commit 1 ships the CODE baseline only: a constant, not a file, so no file/route/canary can create or downgrade it.
// A later commit adds an add-only, version-bound record file on top; it can never lower what is asserted here.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { conductorHome } from '../../paths.ts';
import { atomicWriteFile } from '../../util.ts';
import type { ProviderId } from './types.ts';

export interface BuildBaseline {
  readonly cliVersion: string;
  /** Proven by the repo's live adversarial suite (test/live/cursor-nopush.test.ts) on that version; honoured only because this constant says so. */
  readonly grandfathered: boolean;
  readonly source: 'bundled-repo-suite';
  /** What the verification depends on: 'file' = the provider's own guard artefact must be written and intact; 'sandbox' = an OS/CLI sandbox verified by a canary instead (no file guard). A provider cannot opt out of a guard its verification relies on. */
  readonly guard: 'file' | 'sandbox';
}

const BASELINES: Readonly<Partial<Record<ProviderId, BuildBaseline>>> = Object.freeze({
  cursor: Object.freeze({ cliVersion: '2026.10.19', grandfathered: true, source: 'bundled-repo-suite', guard: 'file' } as const),
});

export function buildBaseline(id: ProviderId): BuildBaseline | undefined {
  return Object.hasOwn(BASELINES, id) ? BASELINES[id] : undefined;
}

export function isBuildIsolationVerified(id: ProviderId): boolean {
  return buildBaseline(id)?.grandfathered === true;
}

/** The read-only isolation tier each provider ships with (code constants; a later commit adds the add-only canary result for Codex). */
export type ReadOnlyTier = 'verified' | 'partial' | 'unverified' | 'blocked';
const TIERS: Readonly<Partial<Record<ProviderId, ReadOnlyTier>>> = Object.freeze({
  claude: 'verified', // fail-closed init predicate on every run
  cursor: 'partial', // `--mode ask`: a knowingly weaker, accepted tier
});
export function readOnlyTier(id: ProviderId): ReadOnlyTier {
  return Object.hasOwn(TIERS, id) ? TIERS[id]! : 'unverified';
}

// ───────────── add-only verification records (read-only tier results; later also build suites) ─────────────
// The file can only ADD information: it can lift a provider to `partial` (a passed canary bound to the CURRENT install) or mark it
// `blocked` (sticky). It can never write `buildIsolationVerified` — that comes from the code baseline above and nothing else — and a
// corrupt / unreadable / invalid file simply reads as "no record" (never an upgrade, never a downgrade below the baseline).
// The file is same-user writable, so this is bookkeeping, not tamper-proofing: the only thing forging it could buy is `partial` for
// READ-ONLY roles, which is the tier Cursor already holds.
export interface VerificationBinding {
  cliVersion: string;
  binSha256: string | null;
  argvDigest: string;
  privateConfigSha: string;
  canaryVersion: number;
}
export interface VerificationRecord {
  provider: ProviderId;
  kind: 'readOnly' | 'build';
  verdict: 'pass' | 'blocked' | 'inconclusive';
  source: 'canary' | 'live-suite';
  suite?: string;
  suiteDigest?: string;
  binding: VerificationBinding;
  at: number;
  items?: { id: string; outcome: string }[];
}
const MAX_RECORDS = 20;
const SHA = /^[0-9a-f]{64}$/;

export const verificationFile = (id: ProviderId): string => join(conductorHome(), 'providers', id, 'verification.json');

function validBinding(b: unknown): b is VerificationBinding {
  const x = b as Record<string, unknown> | null;
  return !!x && typeof x === 'object' && typeof x.cliVersion === 'string' && x.cliVersion.length <= 40 && (x.binSha256 === null || (typeof x.binSha256 === 'string' && SHA.test(x.binSha256))) && typeof x.argvDigest === 'string' && SHA.test(x.argvDigest) && typeof x.privateConfigSha === 'string' && SHA.test(x.privateConfigSha) && Number.isInteger(x.canaryVersion);
}
function validRecord(id: ProviderId, r: unknown): r is VerificationRecord {
  const x = r as Record<string, unknown> | null;
  if (!x || typeof x !== 'object') return false;
  return x.provider === id && (x.kind === 'readOnly' || x.kind === 'build') && (x.verdict === 'pass' || x.verdict === 'blocked' || x.verdict === 'inconclusive') && (x.source === 'canary' || x.source === 'live-suite') && validBinding(x.binding) && typeof x.at === 'number' && Number.isFinite(x.at);
}

/** Records for a provider; anything wrong with the file (type, owner, size, JSON, a bad entry) ⇒ no records at all. */
export function loadRecords(id: ProviderId): VerificationRecord[] {
  const f = verificationFile(id);
  try {
    if (!existsSync(f)) return [];
    const st = lstatSync(f);
    if (!st.isFile() || st.size > 256 * 1024) return [];
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return [];
    const j = JSON.parse(readFileSync(f, 'utf8'));
    const list = Array.isArray(j?.records) ? j.records : null;
    if (!list || !list.every((r: unknown) => validRecord(id, r))) return [];
    return list.slice(-MAX_RECORDS);
  } catch {
    return [];
  }
}

/** Append a record (never edits or removes an earlier one beyond the cap). */
export function addRecord(rec: VerificationRecord): void {
  const dir = join(conductorHome(), 'providers', rec.provider);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const records = [...loadRecords(rec.provider), rec].slice(-MAX_RECORDS);
  atomicWriteFile(verificationFile(rec.provider), JSON.stringify({ version: 1, records }, null, 2) + '\n', 0o600, { durable: true });
}

/**
 * The read-only tier to use NOW: the code constant, adjusted by the add-only records.
 *  - the latest verdict being `blocked` (with no later pass) ⇒ `blocked`, whatever the install looks like now (sticky);
 *  - a `pass` counts ONLY while the install still matches what was tested (CLI version, binary hash when known, argv, private config, canary version);
 *    when the current install is unknown, a pass does not count.
 */
export function effectiveReadOnlyTier(id: ProviderId, current: VerificationBinding | null): ReadOnlyTier {
  const base = readOnlyTier(id);
  const recs = loadRecords(id).filter((r) => r.kind === 'readOnly' && r.source === 'canary' && r.verdict !== 'inconclusive');
  const last = recs[recs.length - 1];
  if (!last) return base;
  if (last.verdict === 'blocked') return 'blocked';
  if (!current) return base;
  const b = last.binding;
  const same = b.cliVersion === current.cliVersion && (b.binSha256 === null || current.binSha256 === null || b.binSha256 === current.binSha256) && b.argvDigest === current.argvDigest && b.privateConfigSha === current.privateConfigSha && b.canaryVersion === current.canaryVersion;
  return same && (base === 'unverified' || base === 'partial') ? 'partial' : base;
}

/** What backs `buildIsolationVerified` for a provider, for display ("not re-verified on <version>"). Informational: it never gates anything. */
export function buildVerificationInfo(id: ProviderId, installedVersion: string | undefined): { source: 'baseline' | 'live-suite'; verifiedOn: string; grandfathered: boolean; current: boolean | null } | null {
  const base = buildBaseline(id);
  if (!base) return null;
  const v = installedVersion ? /(\d+(?:\.\d+)+)/.exec(installedVersion)?.[1] : undefined;
  const rec = loadRecords(id).filter((r) => r.kind === 'build' && r.source === 'live-suite' && r.verdict === 'pass').pop();
  if (rec && v && rec.binding.cliVersion === v) return { source: 'live-suite', verifiedOn: rec.binding.cliVersion, grandfathered: false, current: true };
  return { source: 'baseline', verifiedOn: base.cliVersion, grandfathered: base.grandfathered, current: v ? v === base.cliVersion : null };
}
