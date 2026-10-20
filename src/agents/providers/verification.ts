// Where "this provider's build isolation was proven" comes from (Security conditions 1c / 5).
// Commit 1 ships the CODE baseline only: a constant, not a file, so no file/route/canary can create or downgrade it.
// A later commit adds an add-only, version-bound record file on top; it can never lower what is asserted here.
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
