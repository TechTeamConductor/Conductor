// The ONE place an account's child env is built (M8-3 §2.4; Security S1, S2, R2-1, R2-2, S18). Default ⇒ exactly today's functions
// (byte-identical, golden-tested). Named ⇒ the credential-bearing keys are dropped from BOTH `src` and `extra`, the account's own
// credential-locating keys are set LAST, and the folder pre-flight runs inside `accountEnv` itself (S5: no spawn path can skip it).
// `assertAccountEnv` runs on the FINAL env inside every adapter immediately before runProcess; a violation is an `isolation` failure, zero spawn.
import { claudeEnv, cursorEnv } from '../agents/env.ts';
import type { ProviderId } from '../agents/providers/types.ts';
import { DEFAULT_ACCOUNT, type AccountRef } from './types.ts';
import { AccountFolderError, accountsRoot, accountFolder, acquireAccount, preflightAccount, type PreflightResult } from './profile.ts';

/** S1 drop lists (named accounts only). Prefix entries end with `_`. */
export const NAMED_CLAUDE_DROP: readonly string[] = ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_', 'CLAUDE_CODE_USE_', 'AWS_', 'CURSOR_', 'AGENT_CLI_', 'CODEX_', 'OPENAI_', 'XDG_'];
export const NAMED_CURSOR_DROP: readonly string[] = ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'CURSOR_API_ENDPOINT', 'CURSOR_CONFIG_DIR', 'CURSOR_', 'AGENT_CLI_', 'HOME', 'XDG_', 'ANTHROPIC_', 'CLAUDE_', 'CODEX_', 'OPENAI_'];
/** Toolchain homes that must never reach a named child (R2-5 e). ACCOUNT_TOOLCHAIN_VARS itself lands only with the S17 flip. */
const TOOLCHAIN_HOMES = ['GOPATH', 'GOBIN', 'PYENV_ROOT', 'NVM_DIR', 'npm_config_cache', 'GOMODCACHE', 'RUSTUP_HOME', 'CARGO_HOME'];

const matches = (k: string, list: readonly string[]): boolean => list.some((p) => (p.endsWith('_') ? k.startsWith(p) : k === p));
function strip<T extends Record<string, string | undefined>>(o: T, list: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) if (typeof v === 'string' && !matches(k, list)) out[k] = v;
  return out;
}

export class AccountIsolationError extends Error {
  cls: string;
  constructor(cls: string) {
    super(`account isolation: ${cls}`);
    this.name = 'AccountIsolationError';
    this.cls = cls;
  }
}
/** The static stage/ask message (S2). `label` is the cleaned account label ("Claude · Work"). Never a path or a value. */
export const isolationMessage = (label: string, cls: string): string => `The ${label} account folder failed its safety check (${cls}). Nothing was started.`;

export const isNamed = (ref: AccountRef | undefined): ref is AccountRef => !!ref && ref.id !== DEFAULT_ACCOUNT;

/**
 * The child env for (provider, account). Throws AccountIsolationError (class only) on a pre-flight or assertion failure.
 * `onPreflight` receives the Cursor clean-up facts (count + note classes) for a visible run note (S14.3).
 */
export function accountEnv(provider: ProviderId, ref: AccountRef | undefined, extra: Record<string, string> = {}, src: NodeJS.ProcessEnv = process.env, onPreflight?: (r: PreflightResult) => void, opts: { allowRemoving?: boolean } = {}): Record<string, string> {
  if (!isNamed(ref)) {
    const env = provider === 'claude' ? claudeEnv(extra, src) : provider === 'cursor' ? cursorEnv(extra, src) : null;
    if (!env) throw new AccountIsolationError('a tool without account support here');
    assertAccountEnv(provider, ref, env, src);
    return env;
  }
  if (ref.provider !== provider) throw new AccountIsolationError('an account of another tool');
  if (provider === 'codex') throw new AccountIsolationError('a Codex account (not enabled)'); // S24: dormant in fact
  let pre: PreflightResult;
  try {
    pre = preflightAccount(ref, opts); // `allowRemoving`: ONLY the removal's own sign-out (S8 step 3)
  } catch (e) {
    throw new AccountIsolationError(e instanceof AccountFolderError ? e.cls : 'an account folder that could not be checked');
  }
  onPreflight?.(pre);
  let env: Record<string, string>;
  if (provider === 'claude') {
    env = strip(claudeEnv(strip(extra, [...NAMED_CLAUDE_DROP, 'HOME']), strip(src as Record<string, string | undefined>, NAMED_CLAUDE_DROP)), NAMED_CLAUDE_DROP);
    if (typeof src.HOME === 'string' && src.HOME) env.HOME = src.HOME; // the real HOME (a forged `extra.HOME` never applies)
    else delete env.HOME;
    env.CLAUDE_CONFIG_DIR = pre.folder; // LAST
  } else {
    env = strip(cursorEnv(strip(extra, NAMED_CURSOR_DROP), strip(src as Record<string, string | undefined>, NAMED_CURSOR_DROP)), NAMED_CURSOR_DROP);
    env.HOME = pre.folder; // LAST
    env.AGENT_CLI_CREDENTIAL_STORE = 'file';
    // CURSOR_CONFIG_DIR: only if L4e shows it is needed (S1) — L4e is not authorised yet, so it stays absent
  }
  for (const k of TOOLCHAIN_HOMES) delete env[k];
  assertAccountEnv(provider, ref, env, src);
  return env;
}

/**
 * S2 / R2-1 / R2-2: the binding check on the FINAL env, immediately before runProcess. Pure; throws AccountIsolationError.
 * Default: the reverse check — no file credential store, no account folder anywhere, HOME / CLAUDE_CONFIG_DIR as the default functions give them.
 */
export function assertAccountEnv(provider: ProviderId, ref: AccountRef | undefined, env: Record<string, string>, src: NodeJS.ProcessEnv = process.env): void {
  const root = accountsRoot();
  const anyAccountPath = Object.values(env).some((v) => typeof v === 'string' && v.includes(root));
  const keys = Object.keys(env);
  const has = (list: readonly string[]) => keys.some((k) => matches(k, list));
  if (!isNamed(ref)) {
    if (has(['AGENT_CLI_'])) throw new AccountIsolationError('a file sign-in setting on the main account');
    if (anyAccountPath) throw new AccountIsolationError('an added account folder on the main account');
    if (provider === 'cursor' && has(['CURSOR_CONFIG_DIR'])) throw new AccountIsolationError('a config-folder setting on the main account');
    if ((env.HOME ?? undefined) !== (src.HOME || undefined)) throw new AccountIsolationError('a changed home folder on the main account');
    if (provider === 'claude' && (env.CLAUDE_CONFIG_DIR ?? undefined) !== (src.CLAUDE_CONFIG_DIR || undefined)) throw new AccountIsolationError('a changed config folder on the main account');
    return;
  }
  let folder: string;
  try {
    folder = accountFolder(ref);
  } catch {
    throw new AccountIsolationError('an invalid account id');
  }
  const otherAccount = Object.values(env).some((v) => typeof v === 'string' && v.includes(root) && !(v === folder || v.startsWith(folder + '/')));
  if (otherAccount) throw new AccountIsolationError("another account's folder");
  if (has(TOOLCHAIN_HOMES)) throw new AccountIsolationError('a toolchain home setting');
  if (provider === 'claude') {
    if (env.CLAUDE_CONFIG_DIR !== folder) throw new AccountIsolationError('a wrong config folder');
    if ((env.HOME ?? undefined) !== (src.HOME || undefined)) throw new AccountIsolationError('a changed home folder');
    if (has(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_', 'CLAUDE_CODE_USE_', 'AWS_', 'CURSOR_', 'AGENT_CLI_', 'CODEX_', 'OPENAI_', 'XDG_'])) throw new AccountIsolationError('a credential setting from outside the account');
    return;
  }
  if (provider === 'cursor') {
    if (env.HOME !== folder) throw new AccountIsolationError('a wrong home folder');
    if (env.AGENT_CLI_CREDENTIAL_STORE !== 'file') throw new AccountIsolationError('a missing file sign-in setting');
    if (env.CURSOR_CONFIG_DIR !== undefined && env.CURSOR_CONFIG_DIR !== `${folder}/.cursor`) throw new AccountIsolationError('a wrong config folder');
    if (keys.some((k) => k !== 'AGENT_CLI_CREDENTIAL_STORE' && k.startsWith('AGENT_CLI_'))) throw new AccountIsolationError('an unexpected sign-in setting');
    if (has(['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'CURSOR_API_ENDPOINT', 'XDG_', 'ANTHROPIC_', 'CLAUDE_', 'CODEX_', 'OPENAI_'])) throw new AccountIsolationError('a credential setting from outside the account');
    return;
  }
  throw new AccountIsolationError('a Codex account (not enabled)');
}

/**
 * B5: the named-Cursor BUILD env fragment, resolved by the ENVELOPE (fixed code), never by an adapter's `prepare`. FORBIDDEN_PREP_ENV is
 * unchanged. Builds on named Cursor accounts stay fail-closed until CURSOR_ACCOUNT_HOME_BUILD_VERIFIED flips (D-G, S17) — the router never
 * hands one out; this function exists so the path is tested and the binding assertion lives inside `cursor.build.run` (R2-1).
 */
export function accountBuildEnv(ref: AccountRef | undefined, src: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  if (!isNamed(ref)) return undefined;
  if (ref.provider !== 'cursor') throw new AccountIsolationError('a tool that cannot build on an added account');
  const env = accountEnv('cursor', ref, {}, src);
  const out: Record<string, string> = { HOME: env.HOME!, AGENT_CLI_CREDENTIAL_STORE: 'file' };
  if (env.CURSOR_CONFIG_DIR) out.CURSOR_CONFIG_DIR = env.CURSOR_CONFIG_DIR;
  return out;
}
/** `req.env` (the envelope's git env) can never carry these into a named child (S1): dropped before the account env applies. */
export const BUILD_REQ_ENV_DROP: readonly string[] = ['HOME', 'CURSOR_', 'AGENT_CLI_', 'CLAUDE_CONFIG_DIR', 'XDG_'];
export const dropForNamedBuild = (env: Record<string, string>): Record<string, string> => strip(env, BUILD_REQ_ENV_DROP);

const TOOL_LABEL: Record<ProviderId, string> = { claude: 'Claude', cursor: 'Cursor', codex: 'Codex' };
export type ChildEnv = { ok: true; env: Record<string, string>; release: () => void } | { ok: false; error: string; cls: string };
/**
 * Adapter glue: build the env for this spawn, take the S9 lease (released when the child was reaped), and turn any pre-flight/assertion
 * failure into a static `isolation` message with ZERO spawn. Cursor clean-up of shell start-up / credential-style files is a visible note.
 */
export function childEnv(provider: ProviderId, ref: AccountRef | undefined, extra: Record<string, string>, note?: (text: string) => void): ChildEnv {
  try {
    const env = accountEnv(provider, ref, extra, process.env, (pre) => {
      if (pre.notes.length && note) note(`Conductor removed ${pre.notes.join(' and ')} from the added ${TOOL_LABEL[provider]} account's private home before starting.`);
    });
    if (!isNamed(ref)) return { ok: true, env, release: () => undefined };
    return { ok: true, env, release: acquireAccount(ref) };
  } catch (e) {
    const cls = e instanceof AccountIsolationError ? e.cls : 'an account folder that could not be checked';
    return { ok: false, cls, error: isolationMessage(`added ${TOOL_LABEL[provider]}`, cls) };
  }
}
