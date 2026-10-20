import { PROVIDER_LABEL, type Capabilities, type Provider, type ProviderDeps, type ProviderId } from './types.ts';
import { cursorProvider } from './cursor.ts';
import { claudeProvider } from './claude.ts';
import { isBuildIsolationVerified } from './verification.ts';
import { isProviderId } from './static.ts';


export function createProviders(d: ProviderDeps): Record<ProviderId, Provider> {
  return { claude: claudeProvider(d), cursor: cursorProvider(d) };
}

export { PROVIDER_IDS, isProviderId } from './static.ts';

export function providerLabel(id: string | undefined): string {
  return isProviderId(id) ? PROVIDER_LABEL[id] : 'The agent';
}

/**
 * Capabilities are DERIVED, never read from config or from anything an adapter says about itself:
 * `build` is the presence of `build.run`; `buildIsolationVerified` comes only from the verification baseline/store.
 */
export function capabilitiesOf(p: Provider): Capabilities {
  return { readOnly: typeof p.runReadOnly === 'function', build: typeof p.build?.run === 'function', buildIsolationVerified: isBuildIsolationVerified(p.id) };
}
