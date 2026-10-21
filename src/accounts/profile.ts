// Per-account folders and their hygiene pre-flight (M8-3 §2.4; Security S3, S4, S5, S9, S14; T3, T4). Modelled on prepareCodexHome.
// Paths are built ONLY from the provider enum and an id that passes the S3 rules, and are asserted to stay inside <home>/accounts/<provider>.
// No path ever leaves this module in a message: refusals name an entry CLASS ("a settings file", "a link"), never a path or a file name.
// Credentials are NEVER opened: `.credentials.json` / `auth.json` / Keychain items are only ever `lstat`ed here (static test, S5.5).
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { conductorHome } from '../paths.ts';
import type { ProviderId } from '../agents/providers/types.ts';
import { accountKey, type AccountRef } from './types.ts';
import { namedIdOk } from './store.ts';

/** Tools whose named accounts have a folder. Codex is dormant (S24): no code path resolves a named Codex folder. */
const FOLDER_TOOLS: readonly ProviderId[] = ['claude', 'cursor'];

/**
 * L1 (2026-10-21, Claude Code 2.1.304, signed out, every Conductor spawn shape): the entries Claude creates in an empty config dir.
 * `.credentials.json` is NOT here — only L2 (not authorised yet) can show whether a macOS login creates it; until then it is refused.
 */
export const CLAUDE_PROFILE_ALLOWED: ReadonlyMap<string, 'file' | 'dir'> = new Map([
  ['.claude.json', 'file'],
  ['.claude.json.lock', 'dir'],
  ['backups', 'dir'],
  ['sessions', 'dir'],
  ['projects', 'dir'],
]);
/** Always refused (S5.1), with the class named in the message. Anything unknown is refused too. */
const CLAUDE_REFUSED: ReadonlyMap<string, string> = new Map([
  ['settings.json', 'a settings file'],
  ['settings.local.json', 'a settings file'],
  ['managed-settings.json', 'a settings file'],
  ['CLAUDE.md', 'an instructions file'],
  ['.mcp.json', 'an MCP server file'],
  ['agents', 'an agents folder'],
  ['commands', 'a commands folder'],
  ['hooks', 'a hooks folder'],
  ['plugins', 'a plugins folder'],
  ['skills', 'a skills folder'],
  ['output-styles', 'an output-styles folder'],
  ['.credentials.json', 'a credentials file Conductor has not seen Claude create'],
]);
/**
 * Cursor `<H>/.cursor/` allow-list: EMPTY until L4c is measured (user decision 2026-10-21: L4b–e not authorised). L4a showed the CLI itself
 * creates `cli-config.json` there even signed out, so a named Cursor account is `unavailable` after its first check — visibly, never silently.
 */
export const CURSOR_DOT_ALLOWED: ReadonlySet<string> = new Set<string>([]);
const CURSOR_REFUSED: ReadonlyMap<string, string> = new Map([
  ['hooks.json', 'a hooks file'],
  ['mcp.json', 'an MCP server file'],
  ['rules', 'a rules folder'],
  ['commands', 'a commands folder'],
  ['agents', 'an agents folder'],
  ['skills', 'a skills folder'],
  ['environment.json', 'an environment file'],
  ['cli.json', 'a permissions file'],
]);
/** Cursor HOME top level: only `.cursor` (plus L4c-measured entries, none yet). Everything else is REMOVED while the account is idle (S14.3). */
export const CURSOR_HOME_ALLOWED: ReadonlySet<string> = new Set(['.cursor']);
const SHELL_STARTUP = new Set(['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.bashrc', '.bash_profile', '.profile', '.bash_login']);
const CREDENTIAL_STYLE = new Set(['.npmrc', '.gitconfig', '.ssh', '.netrc', '.aws', '.docker', '.git-credentials', '.pypirc']);

export const CLAUDE_JSON_MAX = 4 * 1024 * 1024;
export const CURSOR_CLI_CONFIG_MAX = 256 * 1024;

export class AccountFolderError extends Error {
  /** The entry class (never a path). */
  cls: string;
  constructor(cls: string) {
    super(`account folder check failed: ${cls}`);
    this.name = 'AccountFolderError';
    this.cls = cls;
  }
}

const uid = (): number | null => (typeof process.getuid === 'function' ? process.getuid() : null);

export function accountsRoot(): string {
  return join(conductorHome(), 'accounts');
}
function providerDir(provider: ProviderId): string {
  if (!FOLDER_TOOLS.includes(provider)) throw new AccountFolderError('a tool without account folders');
  return join(accountsRoot(), provider);
}
/** S3: `<home>/accounts/<provider>/<id>`, never for `default`, never for Codex, contained by `path.relative`. */
export function accountFolder(ref: AccountRef): string {
  const parent = providerDir(ref.provider);
  if (!namedIdOk(ref.provider, ref.id)) throw new AccountFolderError('an invalid account id');
  const leaf = join(parent, ref.id);
  const rel = relative(parent, leaf);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes('/') || rel !== ref.id) throw new AccountFolderError('an invalid account id');
  return leaf;
}

/** Real directory, owned by the user, 0700 (tightened, then re-checked). */
function verifyDir(p: string, what: string): void {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    throw new AccountFolderError(`a missing ${what}`);
  }
  if (st.isSymbolicLink()) throw new AccountFolderError(`a link in place of the ${what}`);
  if (!st.isDirectory()) throw new AccountFolderError(`a file in place of the ${what}`);
  const me = uid();
  if (me !== null && st.uid !== me) throw new AccountFolderError(`a ${what} owned by another user`);
  if ((st.mode & 0o777) !== 0o700) {
    chmodSync(p, 0o700);
    if ((lstatSync(p).mode & 0o777) !== 0o700) throw new AccountFolderError(`a ${what} other users can open`);
  }
}
/** Each parent level is created (0700) when missing, then verified — never by a recursive mkdir that could follow a planted link. */
export function ensureParents(provider: ProviderId): void {
  for (const [p, what] of [
    [accountsRoot(), 'accounts folder'],
    [providerDir(provider), 'tool accounts folder'],
  ] as const) {
    try {
      mkdirSync(p, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new AccountFolderError(`an accounts folder that could not be created`);
    }
    verifyDir(p, what);
  }
}
/** S4: the leaf is made with a NON-recursive mkdir; EEXIST ⇒ refuse (a pre-existing folder at a fresh id is planted or stale, never adopted). */
export function createAccountFolder(ref: AccountRef): void {
  ensureParents(ref.provider);
  const leaf = accountFolder(ref);
  try {
    mkdirSync(leaf, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new AccountFolderError('a folder that already existed for a new account');
    throw new AccountFolderError('an account folder that could not be created');
  }
  verifyDir(leaf, 'account folder');
}

// ───────────── S9: live children per account (cleaning / removal only while idle) ─────────────
const live = new Map<string, number>();
const idleWaiters = new Map<string, (() => void)[]>();
const removing = new Set<string>();
/** Taken synchronously right after the env is built (same tick as the pre-flight) and released when the child was reaped. */
export function acquireAccount(ref: AccountRef): () => void {
  const k = accountKey(ref);
  live.set(k, (live.get(k) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (live.get(k) ?? 1) - 1;
    if (n > 0) live.set(k, n);
    else {
      live.delete(k);
      for (const w of idleWaiters.get(k) ?? []) w();
      idleWaiters.delete(k);
    }
  };
}
export const accountBusy = (ref: AccountRef): boolean => (live.get(accountKey(ref)) ?? 0) > 0;
/** N3: resolves once every child of that account has been reaped. */
export function waitAccountIdle(ref: AccountRef): Promise<void> {
  const k = accountKey(ref);
  if (!live.get(k)) return Promise.resolve();
  return new Promise((res) => idleWaiters.set(k, [...(idleWaiters.get(k) ?? []), res]));
}
/** S8 step 1: a removing account is treated as disabled — its env can no longer be built (no new spawn). */
export function markRemoving(ref: AccountRef, on: boolean): void {
  if (on) removing.add(accountKey(ref));
  else removing.delete(accountKey(ref));
}
export const isRemoving = (ref: AccountRef): boolean => removing.has(accountKey(ref));

// ───────────── the pre-flight ─────────────
const own = (o: unknown, k: string): unknown => (o !== null && typeof o === 'object' && !Array.isArray(o) && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined);
const nonEmpty = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : v !== null && typeof v === 'object' ? Object.keys(v).length > 0 : v !== undefined && v !== null && v !== '' && v !== false);

function entryCheck(p: string, kind: 'file' | 'dir' | 'any', cls: string): void {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) throw new AccountFolderError('a link');
  const me = uid();
  if (me !== null && st.uid !== me) throw new AccountFolderError(`${cls} owned by another user`);
  if (kind === 'file' && !st.isFile()) throw new AccountFolderError(cls);
  if (kind === 'dir' && !st.isDirectory()) throw new AccountFolderError(cls);
  if (st.isFile() && st.nlink !== 1) throw new AccountFolderError('a hard-linked file');
}
/** Depth-2 rule (S5.2): every child of an allowed folder is a non-link owned by the user. */
function childrenCheck(dir: string): void {
  for (const n of readdirSync(dir)) entryCheck(join(dir, n), 'any', 'an entry');
}

/** S5.3: `.claude.json` key check (own-property parse; a static message on a parse error, never the V8 snippet). */
export function checkClaudeJson(text: string): string | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return 'an unreadable .claude.json';
  }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return 'an unreadable .claude.json';
  if (nonEmpty(own(j, 'mcpServers'))) return 'MCP servers in .claude.json';
  const projects = own(j, 'projects');
  if (projects !== null && typeof projects === 'object' && !Array.isArray(projects)) {
    for (const k of Object.keys(projects)) if (nonEmpty(own(own(projects, k), 'mcpServers'))) return 'MCP servers in .claude.json';
  }
  if (own(j, 'primaryApiKey') !== undefined) return 'an API key in .claude.json';
  const ckr = own(j, 'customApiKeyResponses');
  if (nonEmpty(own(ckr, 'approved'))) return 'an approved API key in .claude.json';
  if (own(j, 'env') !== undefined) return 'environment settings in .claude.json';
  if (own(j, 'apiKeyHelper') !== undefined) return 'a key helper in .claude.json';
  return null;
}

function claudePreflight(dir: string): void {
  for (const n of readdirSync(dir)) {
    const refused = CLAUDE_REFUSED.get(n);
    if (refused) throw new AccountFolderError(refused);
    const kind = CLAUDE_PROFILE_ALLOWED.get(n);
    if (!kind) throw new AccountFolderError('an unknown entry');
    const p = join(dir, n);
    entryCheck(p, kind, kind === 'dir' ? 'an unexpected file' : 'an unexpected folder');
    if (kind === 'dir') childrenCheck(p);
    if (n === '.claude.json') {
      if (lstatSync(p).size > CLAUDE_JSON_MAX) throw new AccountFolderError('an oversized .claude.json');
      const bad = checkClaudeJson(readFileSync(p, 'utf8'));
      if (bad) throw new AccountFolderError(bad);
    }
  }
}

/**
 * S14.2 content rule for a Cursor `cli-config.json` (used once L4c allow-lists the file): `permissions.allow` absent or EMPTY (R2-4, N1);
 * `permissions.deny` a list of strings (it can only tighten); every other top-level key is refused until L4c measures the real key set.
 */
export const CURSOR_CLI_CONFIG_KEYS: ReadonlySet<string> = new Set(['permissions']);
export function checkCursorCliConfig(text: string): string | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return 'an unreadable Cursor settings file';
  }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return 'an unreadable Cursor settings file';
  for (const k of Object.keys(j)) if (!CURSOR_CLI_CONFIG_KEYS.has(k)) return 'an unknown Cursor setting';
  const perm = own(j, 'permissions');
  if (perm !== undefined) {
    if (perm === null || typeof perm !== 'object' || Array.isArray(perm)) return 'an unreadable Cursor permission list';
    for (const k of Object.keys(perm)) if (k !== 'allow' && k !== 'deny') return 'an unknown Cursor permission setting';
    const allow = own(perm, 'allow');
    if (allow !== undefined && !(Array.isArray(allow) && allow.length === 0)) return 'a Cursor permission allow rule';
    const deny = own(perm, 'deny');
    if (deny !== undefined && !(Array.isArray(deny) && deny.every((x) => typeof x === 'string'))) return 'an unreadable Cursor deny list';
  }
  return null;
}

/** Returns the classes of removed top-level HOME entries that deserve a visible run note (S14.3). */
function cursorPreflight(home: string, clean: boolean): { removed: number; notes: string[] } {
  const notes = new Set<string>();
  let removed = 0;
  for (const n of readdirSync(home)) {
    if (CURSOR_HOME_ALLOWED.has(n)) continue;
    if (!clean) {
      if (lstatSync(join(home, n)).isSymbolicLink()) throw new AccountFolderError('a link');
      continue; // S9: check-only while another job of this account is alive — nothing is cleaned
    }
    // no-follow removal (rmSync never follows a link; a link itself is unlinked)
    rmSync(join(home, n), { recursive: true, force: true });
    removed++;
    if (SHELL_STARTUP.has(n)) notes.add('a shell start-up file');
    else if (CREDENTIAL_STYLE.has(n)) notes.add('a credential-style file');
  }
  const dot = join(home, '.cursor');
  let st;
  try {
    st = lstatSync(dot);
  } catch {
    return { removed, notes: [...notes] }; // never run yet: nothing to police
  }
  if (st.isSymbolicLink()) throw new AccountFolderError('a link');
  verifyDir(dot, 'Cursor config folder');
  for (const n of readdirSync(dot)) {
    const refused = CURSOR_REFUSED.get(n);
    if (refused) throw new AccountFolderError(refused);
    if (!CURSOR_DOT_ALLOWED.has(n)) throw new AccountFolderError(n === 'cli-config.json' ? 'an unknown Cursor config file' : 'an unknown entry');
    const p = join(dot, n);
    if (n === 'auth.json') {
      // S14.4: a regular file, nlink 1, mode tightened to 0600 — NEVER opened
      entryCheck(p, 'file', 'an unexpected sign-in entry');
      if ((lstatSync(p).mode & 0o077) !== 0) chmodSync(p, 0o600);
      continue;
    }
    entryCheck(p, 'any', 'an entry');
    if (n === 'cli-config.json') {
      if (lstatSync(p).size > CURSOR_CLI_CONFIG_MAX) throw new AccountFolderError('an oversized Cursor settings file');
      const bad = checkCursorCliConfig(readFileSync(p, 'utf8'));
      if (bad) throw new AccountFolderError(bad);
    } else if (lstatSync(p).isDirectory()) childrenCheck(p);
  }
  return { removed, notes: [...notes] };
}

export interface PreflightResult {
  folder: string;
  /** Cursor only: top-level HOME entries removed while idle, and the classes worth a visible run note. */
  removed: number;
  notes: string[];
}
/**
 * S4 + S5/S14: re-verify the parents and the leaf, then the tool's rules. Cleaning happens ONLY while no child of this account is alive (S9);
 * otherwise check-only. Throws AccountFolderError (class only) — the caller turns it into an `isolation` failure with zero spawn.
 */
export function preflightAccount(ref: AccountRef, opts: { allowRemoving?: boolean } = {}): PreflightResult {
  if (isRemoving(ref) && !opts.allowRemoving) throw new AccountFolderError('an account that is being removed');
  const leaf = accountFolder(ref);
  verifyDir(accountsRoot(), 'accounts folder');
  verifyDir(providerDir(ref.provider), 'tool accounts folder');
  verifyDir(leaf, 'account folder');
  try {
    if (ref.provider === 'claude') {
      claudePreflight(leaf);
      return { folder: leaf, removed: 0, notes: [] };
    }
    const r = cursorPreflight(leaf, !accountBusy(ref));
    return { folder: leaf, ...r };
  } catch (e) {
    if (e instanceof AccountFolderError) throw e;
    throw new AccountFolderError('an entry that could not be checked');
  }
}

/** S8 step 4: delete the folder (lstat-checked, inside <home>/accounts, no-follow). Only call once the account is idle (N3). */
export function deleteAccountFolder(ref: AccountRef): boolean {
  const leaf = accountFolder(ref);
  try {
    const st = lstatSync(leaf);
    if (st.isSymbolicLink()) {
      rmSync(leaf, { force: true }); // the link itself, never its target
      return true;
    }
  } catch {
    return false;
  }
  rmSync(leaf, { recursive: true, force: true });
  return true;
}

/** S8 startup sweep: folders that match no configured id are deleted (counted; no sign-out — documented). */
export function sweepOrphanFolders(known: (provider: ProviderId) => readonly string[]): number {
  let n = 0;
  for (const provider of FOLDER_TOOLS) {
    let names: string[];
    try {
      const dir = providerDir(provider);
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const keep = new Set(known(provider));
    for (const id of names) {
      if (keep.has(id)) continue;
      const p = join(providerDir(provider), id);
      try {
        const st = lstatSync(p);
        const me = uid();
        if (me !== null && st.uid !== me) continue;
        rmSync(p, { recursive: !st.isSymbolicLink(), force: true });
        n++;
      } catch {
        /* skipped */
      }
    }
  }
  return n;
}
