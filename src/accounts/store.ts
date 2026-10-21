// Accounts metadata over Config (M8-3 §2.1, §2.7; Security S3, S8, S12; T14). Pure functions: no I/O, no clock (the nonce is injected).
// The input is UNTRUSTED (hand-edited config, API bodies): own-property reads, null-prototype results, ACCOUNT_RE, cap, `default` enforced.
import type { ProviderId } from '../agents/providers/types.ts';
import type { Config } from '../types.ts';
import { ACCOUNT_RE, cleanText } from '../models/sanitize.ts';
import { ACCOUNT_NAME_MAX, DEFAULT_ACCOUNT, MAX_ACCOUNTS_PER_TOOL, type AccountMeta, type Accounts } from './types.ts';

export const ACCOUNT_TOOLS = ['claude', 'cursor', 'codex'] as const satisfies readonly ProviderId[];
/** Named accounts can be ADDED for these tools only (Codex stays dormant, Q5 / S24). */
export const ADDABLE_TOOLS: readonly ProviderId[] = ['claude', 'cursor'];
export const DEFAULT_ACCOUNT_NAME = 'Main';
const NONCE_RE = /^[0-9a-f]{4}$/;
/** S12: an email-shaped label is refused (API) or replaced (normalize). */
const EMAILISH_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/** S3: a named id is ACCOUNT_RE AND `<provider>-[a-z0-9-]+`. `default` is the only other legal id. */
export function namedIdOk(provider: ProviderId, id: unknown): id is string {
  return typeof id === 'string' && id !== DEFAULT_ACCOUNT && ACCOUNT_RE.test(id) && id.startsWith(`${provider}-`) && /^[a-z]+-[a-z0-9-]+$/.test(id);
}
export function accountIdOk(provider: ProviderId, id: unknown): id is string {
  return id === DEFAULT_ACCOUNT || namedIdOk(provider, id);
}

export type NameCheck = { ok: true; name: string } | { ok: false; reason: string };
/** API-side label rule (S12): cleaned, 1–40 code points, never email-shaped. */
export function checkAccountName(raw: unknown): NameCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'Give the account a short name.' };
  const name = cleanText(raw, ACCOUNT_NAME_MAX + 1);
  if (!name) return { ok: false, reason: 'Give the account a short name.' };
  if (Array.from(name).length > ACCOUNT_NAME_MAX) return { ok: false, reason: `Use a name of at most ${ACCOUNT_NAME_MAX} characters.` };
  if (EMAILISH_RE.test(name)) return { ok: false, reason: 'Use a short name, not an email address.' };
  return { ok: true, name };
}

export function defaultAccounts(): Accounts {
  const out = Object.create(null) as Accounts;
  for (const t of ACCOUNT_TOOLS) out[t] = [{ id: DEFAULT_ACCOUNT, name: DEFAULT_ACCOUNT_NAME }];
  return out;
}

/** T14: hostile or hand-edited `accounts` ⇒ a clean, ordered list per tool with exactly one `default` (inserted at the END if missing). */
export function normalizeAccounts(raw: unknown, report: (m: string) => void = () => undefined): Accounts {
  const out = Object.create(null) as Accounts;
  const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  if (src) for (const k of Object.keys(src)) if (!(ACCOUNT_TOOLS as readonly string[]).includes(k)) report(`accounts.${k.slice(0, 16)}: unknown tool, dropped`);
  for (const t of ACCOUNT_TOOLS) {
    const list = src && Object.hasOwn(src, t) && Array.isArray(src[t]) ? (src[t] as unknown[]) : [];
    const seen = new Set<string>();
    const kept: AccountMeta[] = [];
    let n = 0;
    for (const e of list) {
      if (e === null || typeof e !== 'object' || Array.isArray(e)) {
        report(`accounts.${t}: an entry was not an object, dropped`);
        continue;
      }
      const id = Object.hasOwn(e, 'id') ? (e as Record<string, unknown>).id : undefined;
      if (!accountIdOk(t, id)) {
        report(`accounts.${t}: an entry had an invalid id, dropped`);
        continue;
      }
      if (seen.has(id)) {
        report(`accounts.${t}: a duplicate id was dropped`);
        continue;
      }
      seen.add(id);
      n++;
      const c = checkAccountName(Object.hasOwn(e, 'name') ? (e as Record<string, unknown>).name : undefined);
      const name = c.ok ? c.name : id === DEFAULT_ACCOUNT ? DEFAULT_ACCOUNT_NAME : `Account ${n}`;
      kept.push({ id, name });
    }
    if (!seen.has(DEFAULT_ACCOUNT)) kept.push({ id: DEFAULT_ACCOUNT, name: DEFAULT_ACCOUNT_NAME });
    if (kept.length > MAX_ACCOUNTS_PER_TOOL) {
      report(`accounts.${t}: more than ${MAX_ACCOUNTS_PER_TOOL} accounts, the rest were dropped`);
      let named = MAX_ACCOUNTS_PER_TOOL - 1; // `default` always survives the cap, in its place
      out[t] = kept.filter((m) => m.id === DEFAULT_ACCOUNT || named-- > 0);
    } else out[t] = kept;
  }
  return out;
}

/** `claude-work-3f9a`: slug from the label (≤ 20), a FRESH 4-hex nonce per add (B4, S8) — a re-added name never reuses a folder. */
export function makeAccountId(provider: ProviderId, name: string, nonce: string): string {
  if (!NONCE_RE.test(nonce)) throw new Error('bad nonce');
  const slug =
    name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20)
      .replace(/-+$/g, '') || 'account';
  const id = `${provider}-${slug}-${nonce}`;
  if (!namedIdOk(provider, id)) throw new Error('bad id');
  return id;
}

export class AccountStoreError extends Error {
  status: 400 | 404 | 409;
  code: string;
  constructor(status: 400 | 404 | 409, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const cloneAccounts = (a: Accounts): Accounts => {
  const out = Object.create(null) as Accounts;
  for (const t of ACCOUNT_TOOLS) out[t] = (a[t] ?? []).map((m) => ({ id: m.id, name: m.name }));
  return out;
};
const withAccounts = (cfg: Config, accounts: Accounts): Config => ({ ...cfg, accounts });

export function findAccount(cfg: Config, id: string): { provider: ProviderId; meta: AccountMeta; index: number } | null {
  if (typeof id !== 'string' || !ACCOUNT_RE.test(id) || id === DEFAULT_ACCOUNT) return null;
  for (const t of ACCOUNT_TOOLS) {
    const i = (cfg.accounts[t] ?? []).findIndex((m) => m.id === id);
    if (i >= 0) return { provider: t, meta: cfg.accounts[t][i]!, index: i };
  }
  return null;
}

/** POST /api/accounts. Throws AccountStoreError (400/409). The nonce is injected (randomBytes(2) in production; fixed in tests). */
export function addAccount(cfg: Config, provider: unknown, rawName: unknown, nonce: string): { cfg: Config; account: AccountMeta & { provider: ProviderId } } {
  if (provider === 'codex') throw new AccountStoreError(400, 'bad_request', 'Codex accounts cannot be added yet.');
  if (typeof provider !== 'string' || !ADDABLE_TOOLS.includes(provider as ProviderId)) throw new AccountStoreError(400, 'bad_request', 'provider must be claude or cursor');
  const p = provider as ProviderId;
  const c = checkAccountName(rawName);
  if (!c.ok) throw new AccountStoreError(400, 'bad_request', c.reason);
  const list = cfg.accounts[p] ?? [];
  if (list.length >= MAX_ACCOUNTS_PER_TOOL) throw new AccountStoreError(409, 'conflict', `A tool can have at most ${MAX_ACCOUNTS_PER_TOOL} accounts.`);
  if (list.some((m) => m.name.toLowerCase() === c.name.toLowerCase())) throw new AccountStoreError(409, 'conflict', 'This tool already has an account with that name.');
  const id = makeAccountId(p, c.name, nonce);
  if (list.some((m) => m.id === id)) throw new AccountStoreError(409, 'conflict', 'Try again.');
  const next = cloneAccounts(cfg.accounts);
  next[p] = [...next[p], { id, name: c.name }];
  return { cfg: withAccounts(cfg, next), account: { provider: p, id, name: c.name } };
}

/** PUT /api/accounts/:id {name} — label only; `default` may be renamed too (D-F). */
export function renameAccount(cfg: Config, provider: ProviderId, id: string, rawName: unknown): Config {
  const c = checkAccountName(rawName);
  if (!c.ok) throw new AccountStoreError(400, 'bad_request', c.reason);
  const list = cfg.accounts[provider] ?? [];
  const i = list.findIndex((m) => m.id === id);
  if (i < 0) throw new AccountStoreError(404, 'not_found', 'No such account.');
  if (list.some((m, k) => k !== i && m.name.toLowerCase() === c.name.toLowerCase())) throw new AccountStoreError(409, 'conflict', 'This tool already has an account with that name.');
  const next = cloneAccounts(cfg.accounts);
  next[provider][i] = { id, name: c.name };
  return withAccounts(cfg, next);
}

/** PUT /api/accounts/order {provider, ids}: an exact permutation of that tool's ids. */
export function reorderAccounts(cfg: Config, provider: unknown, ids: unknown): Config {
  if (typeof provider !== 'string' || !(ACCOUNT_TOOLS as readonly string[]).includes(provider)) throw new AccountStoreError(400, 'bad_request', 'unknown provider');
  const p = provider as ProviderId;
  const cur = (cfg.accounts[p] ?? []).map((m) => m.id);
  if (!Array.isArray(ids) || ids.length !== cur.length || ids.some((x) => typeof x !== 'string') || new Set(ids).size !== ids.length || !cur.every((x) => ids.includes(x))) {
    throw new AccountStoreError(400, 'bad_request', 'ids must be exactly this tool’s account ids, in the new order');
  }
  const byId = new Map((cfg.accounts[p] ?? []).map((m) => [m.id, m] as const));
  const next = cloneAccounts(cfg.accounts);
  next[p] = (ids as string[]).map((x) => ({ id: x, name: byId.get(x)!.name }));
  return withAccounts(cfg, next);
}

/** Move one step up/down (CLI `move`). */
export function moveAccount(cfg: Config, id: string, dir: 'up' | 'down'): Config {
  const provider = id === DEFAULT_ACCOUNT ? null : findAccount(cfg, id)?.provider;
  if (!provider) throw new AccountStoreError(404, 'not_found', 'No such account.');
  const ids = cfg.accounts[provider].map((m) => m.id);
  const i = ids.indexOf(id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= ids.length) return cfg;
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  return reorderAccounts(cfg, provider, ids);
}

/** Metadata removal (step 6 of S8 — the service does steps 1–5 first). `default` ⇒ 409. */
export function removeAccountMeta(cfg: Config, provider: ProviderId, id: string): Config {
  if (id === DEFAULT_ACCOUNT) throw new AccountStoreError(409, 'conflict', 'The main sign-in of a tool cannot be removed.');
  const list = cfg.accounts[provider] ?? [];
  if (!list.some((m) => m.id === id)) throw new AccountStoreError(404, 'not_found', 'No such account.');
  const next = cloneAccounts(cfg.accounts);
  next[provider] = list.filter((m) => m.id !== id).map((m) => ({ ...m }));
  return withAccounts(cfg, next);
}
