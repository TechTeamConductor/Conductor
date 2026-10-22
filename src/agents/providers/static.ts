// Static, load-time knowledge for validating a hand-edited / migrated config. NOT the source of truth for running anything:
// the router and the envelope re-derive capabilities from the registry on every run. A test pins that this set matches the registry.
import type { ProviderId } from './types.ts';
import { isBuildIsolationVerified } from './verification.ts';

export const PROVIDER_IDS = ['claude', 'cursor', 'codex'] as const satisfies readonly ProviderId[];
/** Providers that have a build capability in code. */
export const BUILD_CAPABLE: ReadonlySet<ProviderId> = new Set<ProviderId>(['cursor']);

export const isProviderId = (x: unknown): x is ProviderId => typeof x === 'string' && (PROVIDER_IDS as readonly string[]).includes(x);
export const staticBuildEligible = (id: ProviderId): boolean => BUILD_CAPABLE.has(id) && isBuildIsolationVerified(id);
