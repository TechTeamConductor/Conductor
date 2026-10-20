import { PROVIDER_LABEL, type Capabilities, type Provider, type ProviderDeps, type ProviderId } from './types.ts';
import { cursorProvider } from './cursor.ts';
import { claudeProvider } from './claude.ts';
import { codexProvider } from './codex.ts';
import { isBuildIsolationVerified } from './verification.ts';
import { isProviderId } from './static.ts';


/** Every provider object that came out of `createProviders` — the envelope refuses any other object, whatever `id` it claims (Security M2-2). */
const REGISTERED = new WeakSet<object>();
export const isRegisteredProvider = (p: unknown): p is Provider => !!p && typeof p === 'object' && REGISTERED.has(p);

function seal(p: Provider): Provider {
  if (p.build) {
    Object.freeze(p.build.envAllow); // an adapter's env allow-list is frozen too: `envAllow.push('GH_*')` must not work (security review F-3)
    Object.freeze(p.build);
  }
  Object.freeze(p);
  REGISTERED.add(p);
  return p;
}

export function createProviders(d: ProviderDeps): Record<ProviderId, Provider> {
  return Object.freeze({ claude: seal(claudeProvider(d)), cursor: seal(cursorProvider(d)), codex: seal(codexProvider(d)) });
}

/**
 * TEST SEAM ONLY (throws outside a test run): a sealed, registered COPY of `p` after `mutate` has edited a draft. Production code can never
 * alter a registry provider; tests that need a misbehaving adapter go through here.
 */
export function mutatedProviderForTests(p: Provider, mutate: (draft: Provider) => void): Provider {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('mutatedProviderForTests is available only inside a test run');
  const draft: Provider = { ...p, build: p.build ? { ...p.build } : undefined };
  mutate(draft);
  return seal(draft);
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
