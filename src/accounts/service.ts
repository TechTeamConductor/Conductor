// AccountService (M8-3 §2.6, §2.7; Security S7, S8, S11, S12, S19, S22). The ONE set of strict handlers behind the HTTP API, the 0600
// control socket and the CLI's direct mode. Conductor holds no account secret: sign-ins live in each tool's own store; views carry labels and
// states only (an allow-list, S12) — never a path, an email or an organisation.
import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountView, Config, ProviderId } from '../types.ts';
import type { CatalogView } from '../models/types.ts';
import { CURSOR_REASONS } from '../models/cursor.ts';
import { paths } from '../paths.ts';
import { logger } from '../log.ts';
import { resolveBin } from '../config.ts';
import { runProcess, type SpawnOpts, type SpawnResult } from '../agents/spawn.ts';
import { CURSOR_ACCOUNT_HOME_BUILD_VERIFIED } from '../agents/providers/verification.ts';
import { DEFAULT_ACCOUNT, accountKey, type AccountRef } from './types.ts';
import { effectiveLimitRule, isLimitRule } from './limit-rule.ts';
import { ACCOUNT_TOOLS, AccountStoreError, addAccount, findAccount, moveAccount, removeAccountMeta, renameAccount, reorderAccounts } from './store.ts';
import { AccountFolderError, CURSOR_DOT_ALLOWED, acquireAccount, createAccountFolder, deleteAccountFolder, markRemoving, sweepOrphanFolders, waitAccountIdle } from './profile.ts';
import { AccountIsolationError, accountEnv, assertAccountEnv } from './env.ts';
import { ACCOUNT_RE } from '../models/sanitize.ts';

const log = logger('accounts');
/** Named-account sign-in needs live checks L2 (Claude) / L4b (Cursor) that the user has not authorised yet (2026-10-21). */
export const ACCOUNT_LOGIN_ENABLED = false;
export const LOGIN_DISABLED_MESSAGE = 'Signing in extra accounts is not enabled yet (awaiting a live check).';
export const SIGN_OUT_NOTE = 'The tool may still hold a saved sign-in; sign out from the tool or revoke the session in your account settings.';
export const SIGNIN_COMMAND_RE = /^conductor accounts login [a-z0-9][a-z0-9-]{0,31}$/;
export const LOGOUT_TIMEOUT_MS = 20_000;
/** Constant argv (zero quota). */
export const LOGOUT_ARGS: Readonly<Record<'claude' | 'cursor', readonly string[]>> = Object.freeze({ claude: Object.freeze(['auth', 'logout']), cursor: Object.freeze(['logout']) });
export const LOGIN_ARGS: Readonly<Record<'claude' | 'cursor', readonly string[]>> = Object.freeze({ claude: Object.freeze(['auth', 'login']), cursor: Object.freeze(['login']) });
const VIEW_KEYS = ['provider', 'id', 'name', 'order', 'isDefault', 'status', 'until', 'untilKind', 'plan', 'usage', 'checkedAt', 'inUse', 'buildReady', 'signInCommand', 'note'] as const;
const BODY_MAX_KEYS = 4;

export interface AccountEngine {
  invalidate(): void;
  tickSoon(): void;
  accountRemoved(ref: AccountRef, label: string): Promise<number>;
  pauseOf(ref: AccountRef): { until: number; reason: string } | null;
  quotaOf(ref: AccountRef): { utilization7d?: number; utilization5h?: number; resetsAt?: number } | undefined;
  jobsOn(ref: AccountRef): number;
  setAccountUnavailable(ref: AccountRef, on: boolean): void;
  isAccountUnavailable(ref: AccountRef): boolean;
}
export interface AccountModels {
  view(provider: ProviderId, account?: string): CatalogView;
  refresh(provider: ProviderId, trigger?: 'manual', account?: string): Promise<CatalogView>;
  forget(provider: ProviderId, account: string): void;
}
export interface AccountServiceDeps {
  getConfig(): Config;
  /** Persist then swap (the runtime's single writer). */
  saveConfig(cfg: Config): void;
  engine?: AccountEngine;
  models?: AccountModels;
  /** Default-account health (`found`/`loggedIn`) — the view of the main sign-in. */
  health?: () => Partial<Record<ProviderId, { found?: boolean; loggedIn?: boolean }>> | null | undefined;
  /** S8 step 2: abort and await in-flight Quick Ask / Research / brief calls on the account. */
  abortCalls?: (ref: AccountRef) => Promise<number>;
  /** The same extra env the Agents get (tests: FAKE_DIR) — merged UNDER the account env, its drop lists apply. */
  extraEnv?: Record<string, string>;
  /** Test seam: the logout spawn. Default runProcess (never reached inside `npm test` — tests inject fakes). */
  spawn?: (o: SpawnOpts) => Promise<SpawnResult>;
  /** Test seam: the 4-hex nonce of a new id (B4, S8). */
  nonce?: () => string;
  now?: () => number;
}

export class AccountError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
/** S12: strict bodies — exactly the allowed keys; `__proto__` or any credential-shaped key ⇒ 400 (never echoed). */
function strictBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isPlain(body)) throw new AccountError(400, 'bad_request', 'Send a JSON object.');
  const keys = Object.keys(body);
  if (keys.length > BODY_MAX_KEYS || Object.hasOwn(body, '__proto__')) throw new AccountError(400, 'bad_request', 'Unexpected fields.');
  for (const k of keys) {
    if (/key|token|password|secret|credential|cookie|auth/i.test(k)) throw new AccountError(400, 'bad_request', 'Conductor never takes a sign-in, key or token. Sign in with the tool itself.');
    if (!allowed.includes(k)) throw new AccountError(400, 'bad_request', 'Unexpected fields.');
  }
  return body;
}
const clampPct = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : undefined);

export class AccountService {
  private d: AccountServiceDeps;
  private checking = new Set<string>();
  private removingNow = new Set<string>();
  constructor(deps: AccountServiceDeps) {
    this.d = deps;
  }
  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  // ───────────── views (S12 allow-list) ─────────────
  signInCommand(id: string): string {
    const c = `conductor accounts login ${id}`;
    if (!SIGNIN_COMMAND_RE.test(c)) throw new Error('bad id');
    return c;
  }
  private label(provider: ProviderId, name: string, isDefault: boolean): string {
    const T = provider === 'claude' ? 'Claude' : provider === 'cursor' ? 'Cursor' : 'Codex';
    const many = (this.d.getConfig().accounts?.[provider]?.length ?? 1) > 1;
    return isDefault && !many ? T : `${T} · ${name}`;
  }
  view(provider: ProviderId, id: string): AccountView {
    const cfg = this.d.getConfig();
    const list = cfg.accounts[provider] ?? [];
    const order = list.findIndex((m) => m.id === id);
    const meta = list[order];
    if (!meta) throw new AccountError(404, 'not_found', 'No such account.');
    const ref: AccountRef = { provider, id };
    const isDefault = id === DEFAULT_ACCOUNT;
    const e = this.d.engine;
    const pause = e?.pauseOf(ref) ?? null;
    const inUse = e?.jobsOn(ref) ?? 0;
    const cat = this.d.models?.view(provider, id);
    let status: AccountView['status'];
    let note: string | undefined;
    if (isDefault) {
      const h = this.d.health?.()?.[provider];
      status = h?.found === false ? 'not-installed' : h?.loggedIn === false ? 'not-signed-in' : h?.loggedIn === true ? 'ready' : 'unknown';
    } else if (provider === 'codex') {
      status = 'unavailable';
      note = 'Codex accounts are not enabled.';
    } else if (this.removingNow.has(accountKey(ref))) {
      status = 'unavailable';
      note = 'Being removed.';
    } else if (e?.isAccountUnavailable(ref)) {
      status = 'unavailable';
      // code review N4: while the Cursor `.cursor` allow-list is empty (L4c not run) every added Cursor account ends here — say why
      note = provider === 'cursor' && CURSOR_DOT_ALLOWED.size === 0 ? 'Not supported yet (awaiting a live check).' : 'Its folder failed a safety check. Remove and add it again.';
    } else if (this.checking.has(accountKey(ref)) || cat?.state === 'reading') status = 'checking';
    else if (cat?.signedIn === true) status = 'ready';
    else if (cat?.signedIn === false || cat?.reason === CURSOR_REASONS.signIn || cat?.reason?.startsWith(CURSOR_REASONS.signIn)) status = 'not-signed-in';
    else status = cat && cat.state !== 'unavailable' ? 'unknown' : 'not-signed-in';
    if ((status === 'ready' || status === 'unknown') && pause && pause.until > this.now()) status = 'at-limit';
    else if (status === 'ready' && inUse > 0) status = 'in-use';
    const q = e?.quotaOf(ref);
    const usage: AccountView['usage'] = {};
    const u7 = clampPct(q?.utilization7d);
    const u5 = clampPct(q?.utilization5h);
    if (u7 !== undefined) usage.utilization7d = u7;
    if (u5 !== undefined) usage.utilization5h = u5;
    const now = this.now();
    if (typeof q?.resetsAt === 'number' && Number.isFinite(q.resetsAt) && Math.abs(q.resetsAt - now) <= 8 * 86_400_000) usage.resetsAt = q.resetsAt;
    const v: AccountView = {
      provider, id, name: meta.name, order, isDefault, status, inUse, signInCommand: this.signInCommand(id),
      ...(status === 'at-limit' && pause ? { until: pause.until, untilKind: 'reset' as const } : {}),
      ...(cat?.plan ? { plan: cat.plan } : {}),
      ...(Object.keys(usage).length ? { usage } : {}),
      ...(typeof cat?.fetchedAt === 'number' ? { checkedAt: cat.fetchedAt } : {}),
      ...(provider === 'cursor' ? { buildReady: isDefault || CURSOR_ACCOUNT_HOME_BUILD_VERIFIED } : {}),
      ...(note ? { note } : {}),
    };
    // S12: the view is rebuilt from the allow-list, so nothing else can ever ride along
    const out: Record<string, unknown> = {};
    for (const k of VIEW_KEYS) if (v[k] !== undefined) out[k] = v[k];
    return out as unknown as AccountView;
  }
  list(): AccountView[] {
    const cfg = this.d.getConfig();
    const out: AccountView[] = [];
    for (const t of ACCOUNT_TOOLS) for (const m of cfg.accounts[t] ?? []) out.push(this.view(t, m.id));
    return out;
  }
  listing(): { accounts: AccountView[]; limitRule: Config['pipeline']['limitRule']; limitRuleEffective: Config['pipeline']['limitRule'] } {
    const cfg = this.d.getConfig();
    return { accounts: this.list(), limitRule: cfg.pipeline.limitRule, limitRuleEffective: effectiveLimitRule(cfg) };
  }

  private changed(): void {
    this.d.engine?.invalidate();
    this.d.engine?.tickSoon();
  }
  private resolve(id: unknown): { provider: ProviderId; id: string; name: string } {
    if (typeof id !== 'string' || !ACCOUNT_RE.test(id)) throw new AccountError(404, 'not_found', 'No such account.');
    if (id === DEFAULT_ACCOUNT) throw new AccountError(400, 'bad_request', 'Name the account by its id; the main sign-in is `default` of each tool.');
    const f = findAccount(this.d.getConfig(), id);
    if (!f) throw new AccountError(404, 'not_found', 'No such account.');
    return { provider: f.provider, id, name: f.meta.name };
  }
  private store<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof AccountStoreError) throw new AccountError(e.status, e.code, e.message);
      throw e;
    }
  }

  // ───────────── POST /accounts {provider, name} ─────────────
  add(body: unknown): { account: AccountView; signInCommand: string } {
    const b = strictBody(body, ['provider', 'name']);
    const nonce = (this.d.nonce ?? (() => randomBytes(2).toString('hex')))();
    const { cfg, account } = this.store(() => addAccount(this.d.getConfig(), b.provider, b.name, nonce));
    const ref: AccountRef = { provider: account.provider, id: account.id };
    try {
      createAccountFolder(ref); // an EMPTY 0700 folder (non-recursive leaf, EEXIST ⇒ refuse); no CLI runs here
    } catch (e) {
      throw new AccountError(e instanceof AccountFolderError && /already existed/.test(e.cls) ? 409 : 500, 'folder', `The account folder could not be created (${e instanceof AccountFolderError ? e.cls : 'error'}). Nothing was added.`);
    }
    // M8-4 N1: `cfg` is a NEW object; saveConfig persists before it swaps. A refused save leaves memory + disk unchanged and the empty folder goes too
    try {
      this.d.saveConfig(cfg);
    } catch (e) {
      try {
        deleteAccountFolder(ref);
      } catch {
        /* an orphan empty folder is swept at startup */
      }
      throw e;
    }
    this.changed();
    void this.check(account.id).catch(() => undefined); // at add ⇒ "Not signed in" (zero quota)
    return { account: this.view(ref.provider, ref.id), signInCommand: this.signInCommand(account.id) };
  }

  // ───────────── PUT /accounts/:id {name} (also `default`: label only) ─────────────
  rename(id: unknown, body: unknown, provider?: unknown): AccountView {
    const b = strictBody(body, ['name', 'provider']);
    if (id !== DEFAULT_ACCOUNT && b.provider !== undefined) throw new AccountError(400, 'bad_request', 'Unexpected fields.');
    let p: ProviderId;
    let accId: string;
    if (id === DEFAULT_ACCOUNT) {
      const tool = b.provider ?? provider;
      if (typeof tool !== 'string' || !(ACCOUNT_TOOLS as readonly string[]).includes(tool)) throw new AccountError(400, 'bad_request', 'Say which tool\'s main sign-in to rename ("provider").');
      p = tool as ProviderId;
      accId = DEFAULT_ACCOUNT;
    } else {
      const r = this.resolve(id);
      p = r.provider;
      accId = r.id;
    }
    const next = this.store(() => renameAccount(this.d.getConfig(), p, accId, b.name));
    this.d.saveConfig(next);
    this.changed();
    return this.view(p, accId);
  }

  // ───────────── PUT /accounts/order {provider, ids} ─────────────
  reorder(body: unknown): AccountView[] {
    const b = strictBody(body, ['provider', 'ids']);
    const next = this.store(() => reorderAccounts(this.d.getConfig(), b.provider, b.ids));
    this.d.saveConfig(next);
    this.changed();
    return this.list().filter((v) => v.provider === b.provider);
  }

  /** CLI `move <id> up|down` (direct mode): one step, as an exact permutation through `reorder`. */
  move(id: unknown, dir: 'up' | 'down'): AccountView[] {
    const r = this.resolve(id);
    const next = this.store(() => moveAccount(this.d.getConfig(), r.id, dir));
    return this.reorder({ provider: r.provider, ids: next.accounts[r.provider].map((m) => m.id) });
  }

  // ───────────── POST /accounts/:id/check ─────────────
  /** M8-1 per-account discovery (zero quota). Every finished check invalidates + ticks, so limit-paused runs resume as soon as a sign-in is usable. */
  async check(id: unknown, opts: { waitMs?: number } = {}): Promise<AccountView> {
    const isDefault = id === DEFAULT_ACCOUNT;
    const r = isDefault ? null : this.resolve(id);
    if (!r) throw new AccountError(400, 'bad_request', 'The main sign-in is checked by the provider health check.');
    const ref: AccountRef = { provider: r.provider, id: r.id };
    if (r.provider === 'codex') throw new AccountError(409, 'not_enabled', 'Codex accounts are not enabled.');
    const k = accountKey(ref);
    if (!this.d.models) return this.view(ref.provider, ref.id);
    this.checking.add(k);
    const p = this.d.models
      .refresh(ref.provider, 'manual', ref.id)
      .catch(() => undefined)
      .finally(() => {
        this.checking.delete(k);
        this.changed();
      });
    if (opts.waitMs !== undefined) await Promise.race([p, new Promise((res) => setTimeout(res, opts.waitMs).unref())]);
    else await p;
    return this.view(ref.provider, ref.id);
  }
  /** N6: at startup every named account is checked (through M8-1's serialised queue); each completion invalidates + ticks. */
  checkAll(): Promise<void> {
    const cfg = this.d.getConfig();
    const ps: Promise<unknown>[] = [];
    for (const t of ['claude', 'cursor'] as const) for (const m of cfg.accounts[t] ?? []) if (m.id !== DEFAULT_ACCOUNT) ps.push(this.check(m.id).catch(() => undefined));
    return Promise.all(ps).then(() => undefined);
  }

  /**
   * M8-1 `envFor` seam: discovery for a named account gets `accountEnv` (pre-flight + assertion). A failed pre-flight marks the account
   * `unavailable` (S2: a check ⇒ unavailable), and the discovery refuses with zero spawn; a passing one clears the mark.
   */
  envFor(provider: 'claude' | 'cursor', account: string, extra: Record<string, string> = {}): Record<string, string> {
    const ref: AccountRef = { provider, id: account };
    try {
      const env = accountEnv(provider, ref, extra);
      if (account !== DEFAULT_ACCOUNT) {
        this.d.engine?.setAccountUnavailable(ref, false);
        this.leases.get(accountKey(ref))?.();
        this.leases.set(accountKey(ref), acquireAccount(ref)); // released by afterDiscovery once the child was reaped (N3)
      }
      return env;
    } catch (e) {
      if (account !== DEFAULT_ACCOUNT && e instanceof AccountIsolationError) this.d.engine?.setAccountUnavailable(ref, true);
      throw e;
    }
  }

  private leases = new Map<string, () => void>();
  /** M8-1 seam: the discovery child of this account was reaped. */
  afterDiscovery(provider: 'claude' | 'cursor', account: string): void {
    const k = `${provider}:${account}`;
    this.leases.get(k)?.();
    this.leases.delete(k);
  }

  // ───────────── DELETE /accounts/:id ─────────────
  /**
   * S8 order: (1) mark removing (disabled for the router and discovery) → (2) abort + await its stage jobs, asks, research, briefs and checks
   * (N3: the folder goes only after every child was reaped) → (3) sign out by default (constant argv, 20 s, zero quota) → (4) delete the folder
   * (no-follow) → (5) delete the model cache + forget → (6) save the config.
   */
  async remove(id: unknown, opts: { keepSignin?: boolean } = {}): Promise<{ removed: true; id: string; signedOut: boolean | null; restarted: number; note?: string }> {
    if (id === DEFAULT_ACCOUNT) throw new AccountError(409, 'conflict', 'The main sign-in of a tool cannot be removed.');
    const r = this.resolve(id);
    const ref: AccountRef = { provider: r.provider, id: r.id };
    const k = accountKey(ref);
    if (this.removingNow.has(k)) throw new AccountError(409, 'busy', 'This account is already being removed.');
    this.removingNow.add(k);
    markRemoving(ref, true);
    this.d.engine?.invalidate();
    const label = this.label(ref.provider, r.name, false);
    try {
      const restarted = (await this.d.engine?.accountRemoved(ref, label)) ?? 0;
      await this.d.abortCalls?.(ref);
      await waitAccountIdle(ref);
      let signedOut: boolean | null = null;
      if (!opts.keepSignin && ref.provider !== 'codex') {
        signedOut = await this.logout(ref); // the last spawn of this account (its own pre-flight runs with allowRemoving)
        await waitAccountIdle(ref);
      }
      try {
        if (ref.provider !== 'codex') deleteAccountFolder(ref);
      } catch {
        /* an invalid folder cannot exist for a valid id */
      }
      this.deleteCache(ref);
      this.d.models?.forget(ref.provider, ref.id);
      this.d.saveConfig(removeAccountMeta(this.d.getConfig(), ref.provider, ref.id));
      log.info(`account removed provider=${ref.provider} signedOut=${signedOut === null ? 'skipped' : signedOut ? 'yes' : 'no'} restarted=${restarted}`);
      return { removed: true, id: ref.id, signedOut, restarted, ...(signedOut === false ? { note: SIGN_OUT_NOTE } : {}) };
    } finally {
      this.removingNow.delete(k);
      markRemoving(ref, false);
      this.changed();
    }
  }

  /** `claude auth logout` / `agent logout` with the account env (pre-flight + assertion first). Captures nothing; exit code only. */
  private async logout(ref: AccountRef): Promise<boolean> {
    if (ref.provider !== 'claude' && ref.provider !== 'cursor') return false;
    const cfg = this.d.getConfig();
    const bin = resolveBin(ref.provider === 'claude' ? cfg.agents.claude.bin : cfg.agents.cursor.bin);
    if (!bin) return false;
    let env: Record<string, string>;
    try {
      env = accountEnv(ref.provider, ref, this.d.extraEnv ?? {}, process.env, undefined, { allowRemoving: true });
      assertAccountEnv(ref.provider, ref, env);
    } catch {
      return false;
    }
    const release = acquireAccount(ref);
    try {
      const res = await (this.d.spawn ?? runProcess)({ bin, args: [...LOGOUT_ARGS[ref.provider]], cwd: paths.home(), env, idleMs: LOGOUT_TIMEOUT_MS, hardMs: LOGOUT_TIMEOUT_MS, maxOutputBytes: 64 * 1024 });
      return res.code === 0 && !res.timedOut && !res.spawnError;
    } catch {
      return false;
    } finally {
      release();
    }
  }

  private deleteCache(ref: AccountRef): void {
    if (!ACCOUNT_RE.test(ref.id) || ref.id === DEFAULT_ACCOUNT) return;
    const f = join(paths.models(), ref.provider, `${ref.id}.json`);
    try {
      if (lstatSync(f).isFile()) rmSync(f, { force: true });
    } catch {
      /* none */
    }
  }

  /** Startup: orphan folders (no sign-out — documented) and model caches of unknown ids (regular files only) are removed; counts are logged. */
  sweep(): { folders: number; caches: number } {
    const cfg = this.d.getConfig();
    const known = (p: ProviderId) => (cfg.accounts[p] ?? []).map((m) => m.id);
    let folders = 0;
    try {
      folders = sweepOrphanFolders(known);
    } catch {
      folders = 0;
    }
    let caches = 0;
    for (const p of ['claude', 'cursor'] as const) {
      const dir = join(paths.models(), p);
      let names: string[] = [];
      try {
        if (!lstatSync(dir).isDirectory()) continue;
        names = readdirSync(dir);
      } catch {
        continue;
      }
      const keep = new Set(known(p));
      for (const n of names) {
        if (!n.endsWith('.json')) continue;
        const id = n.slice(0, -5);
        if (keep.has(id) || !ACCOUNT_RE.test(id)) continue;
        try {
          if (lstatSync(join(dir, n)).isFile()) {
            rmSync(join(dir, n), { force: true });
            this.d.models?.forget(p, id);
            caches++;
          }
        } catch {
          /* skipped */
        }
      }
    }
    if (folders || caches) log.info(`accounts sweep: removed ${folders} orphan folder(s) (no sign-out) and ${caches} model cache file(s)`);
    return { folders, caches };
  }

  // ───────────── settings ─────────────
  /** PUT /api/settings {limitRule}: strict (a bad value ⇒ 400). */
  static checkLimitRule(v: unknown): void {
    if (v !== undefined && !isLimitRule(v)) throw new AccountError(400, 'bad_request', 'limitRule must be one of switch, same, wait.');
  }

  // ───────────── login (CLI only, never the server; disabled in this slice) ─────────────
  /**
   * `conductor accounts login <id>`: the tool's OWN login with stdio inherited (S7), after the pre-flight and the assertion; Conductor
   * captures nothing; a check follows. DISABLED until L2 (Claude) and L4b (Cursor) pass — `ACCOUNT_LOGIN_ENABLED` is a code constant.
   */
  async login(id: unknown, deps: { spawnInherit: (bin: string, args: string[], env: Record<string, string>) => Promise<number> }, enabled: boolean = ACCOUNT_LOGIN_ENABLED): Promise<AccountView> {
    if (!enabled) throw new AccountError(409, 'not_enabled', LOGIN_DISABLED_MESSAGE);
    const r = this.resolve(id);
    if (r.provider === 'codex') throw new AccountError(409, 'not_enabled', 'Codex accounts are not enabled.');
    const ref: AccountRef = { provider: r.provider, id: r.id };
    const cfg = this.d.getConfig();
    const bin = resolveBin(ref.provider === 'claude' ? cfg.agents.claude.bin : cfg.agents.cursor.bin);
    if (!bin) throw new AccountError(409, 'not_installed', 'The tool is not installed.');
    let env: Record<string, string>;
    try {
      env = accountEnv(ref.provider, ref, this.d.extraEnv ?? {});
      assertAccountEnv(ref.provider, ref, env);
    } catch (e) {
      throw new AccountError(409, 'isolation', `The account folder failed its safety check (${e instanceof AccountIsolationError ? e.cls : 'error'}). Nothing was started.`);
    }
    await deps.spawnInherit(bin, [...LOGIN_ARGS[ref.provider as 'claude' | 'cursor']], env);
    return this.check(ref.id);
  }
}
