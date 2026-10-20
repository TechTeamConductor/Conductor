import { PROVIDER_LABEL, type Capabilities, type Provider, type ProviderDeps, type ProviderId } from './types.ts';
import { cursorProvider } from './cursor.ts';
import { isBuildIsolationVerified } from './verification.ts';

/** Claude has no build capability (it is read-only by design); its read-only runner is still wired through Agents.readOnly. */
function claudeProvider(): Provider {
  return { id: 'claude', label: PROVIDER_LABEL.claude };
}

export const PROVIDER_IDS = ['claude', 'cursor'] as const satisfies readonly ProviderId[];

export function createProviders(d: ProviderDeps): Record<ProviderId, Provider> {
  return { claude: claudeProvider(), cursor: cursorProvider(d) };
}

export function isProviderId(x: unknown): x is ProviderId {
  return typeof x === 'string' && (PROVIDER_IDS as readonly string[]).includes(x);
}

export function providerLabel(id: string | undefined): string {
  return isProviderId(id) ? PROVIDER_LABEL[id] : 'The agent';
}

/**
 * Capabilities are DERIVED, never read from config or from anything an adapter says about itself:
 * `build` is the presence of `build.run`; `buildIsolationVerified` comes only from the verification baseline/store.
 */
export function capabilitiesOf(p: Provider): Capabilities {
  return { readOnly: true, build: typeof p.build?.run === 'function', buildIsolationVerified: isBuildIsolationVerified(p.id) };
}
