// ModelService (M8-1 §2.6 + §2b/§2c/§2d/§2e): asks each installed CLI which models it offers, caches the answer per (provider, account),
// refreshes in the background and serves an in-memory view. Nothing in the engine awaits it; `view()` never does I/O after construction
// (default-account caches are read once here) and never waits for a discovery, even a hung one.
//  - ONE discovery at a time across providers and accounts (a service-wide queue: the shared working folder, R2-2/C1);
//  - one in flight per (provider, account): a second call joins it; a manual refresh within 10 s returns the cached view;
//  - automatic triggers (startup / version change / unknown model) are rate-limited (S11): ≤ 1 per (provider, account) per 5 min after a
//    failure, ≤ 1 per distinct cliVersion per process, and a failed refresh never updates the cached cliVersion;
//  - Codex is dormant (S17): no binary lookup, no home preparation, no spawn;
//  - inside a test run it refuses to spawn unless a `spawn` dep was injected (B1: `npm test` never reaches a real CLI).
import type { Config } from '../types.ts';
import { runProcess, type SpawnOpts, type SpawnResult } from '../agents/spawn.ts';
import { claudeEnv, cursorEnv } from '../agents/env.ts';
import { resolveBin } from '../config.ts';
import { logger } from '../log.ts';
import { systemClock, type Clock } from '../util.ts';
import type { Catalog, CatalogView, CursorFamily, DiscoveryOutcome, ProviderId } from './types.ts';
import { ACCOUNT_RE, cleanVersion, scrubIdentity } from './sanitize.ts';
import { CACHE_REASONS, readCache, writeCache } from './cache.ts';
import { discoverClaude } from './claude.ts';
import { discoverCursor } from './cursor.ts';
import { CODEX_DISCOVERY_ENABLED, CODEX_UNAVAILABLE_REASON } from './codex.ts';
import { cursorFamilies } from './cursor-families.ts';
import { cleanDiscoveryDir, prepareDiscoveryDir } from './workdir.ts';

export const DISCOVERY_TIMEOUT_MS = 15_000;
export const MANUAL_WINDOW_MS = 10_000;
export const AUTO_BACKOFF_MS = 5 * 60_000;
export const TEST_REFUSAL_REASON = 'model discovery does not run real CLIs inside tests';

export type RefreshTrigger = 'manual' | 'startup' | 'version' | 'unknown-model';
type Discoverable = 'claude' | 'cursor';

export interface ModelServiceDeps {
  getConfig(): Config;
  clock?: Clock;
  /** The same extra env the Agents get (tests/demo: FAKE_DIR). */
  extraEnv?: Record<string, string>;
  bins?: () => { claude: string | null; cursor: string | null };
  /** Injected spawn (tests). Without it, `runProcess` — refused inside a test run. */
  spawn?: (o: SpawnOpts) => Promise<SpawnResult>;
  log?: { info(m: string): void; warn(m: string): void };
  timeoutMs?: number;
  graceMs?: number;
  /** M8-3 seam: per-account child env (allow-list only). Default: claudeEnv / cursorEnv(extraEnv). */
  envFor?: (provider: Discoverable, account: string) => Record<string, string> | Promise<Record<string, string>>;
  /** M8-3 seam: the accounts to discover for. Default ['default']. */
  accountIds?: (provider: ProviderId) => string[];
}

export interface HealthLike {
  found?: boolean;
  state?: string;
  version?: string;
}

interface Entry {
  catalog: Catalog | null;
  futureTime: boolean;
  /** A newer Conductor owns the file: fresh results stay in memory. */
  newer: boolean;
  memoryOnly: boolean;
  cacheProblem?: string;
  failed: boolean;
  failReason?: string;
  inFlight: Promise<CatalogView> | null;
  lastFinished: number;
  lastFailAt: number;
  lastUnknownAt: number;
  autoVersions: Set<string>;
  families?: { for: Catalog; value: CursorFamily[] };
}

const LABEL: Record<ProviderId, string> = { claude: 'Claude Code', cursor: 'the Cursor agent', codex: 'Codex' };

export class ModelService {
  private d: ModelServiceDeps;
  private clock: Clock;
  private entries = new Map<string, Entry>();
  private queue: Promise<void> = Promise.resolve();
  private stopAc = new AbortController();
  private stopped = false;
  private injected: boolean;
  private seenVersion = new Map<ProviderId, string>();
  private log: { info(m: string): void; warn(m: string): void };
  /** Counters for tests and the boot guard (R2-N2: ESM exports cannot be spied — count through the service). */
  readonly counters = { spawns: 0, refusedInTest: 0, refreshes: 0 };

  constructor(deps: ModelServiceDeps) {
    this.d = deps;
    this.clock = deps.clock ?? systemClock;
    this.injected = typeof deps.spawn === 'function';
    this.log = deps.log ?? logger('models');
    for (const p of ['claude', 'cursor'] as const) this.entry(p, 'default'); // the only disk reads view() would ever need
  }

  private key(p: ProviderId, a: string): string {
    return `${p}:${a}`;
  }

  private entry(provider: Discoverable, account: string): Entry {
    const k = this.key(provider, account);
    let e = this.entries.get(k);
    if (e) return e;
    e = { catalog: null, futureTime: false, newer: false, memoryOnly: false, failed: false, inFlight: null, lastFinished: 0, lastFailAt: 0, lastUnknownAt: 0, autoVersions: new Set() };
    const r = readCache(provider, account, this.clock.now());
    if (r.kind === 'ok') {
      e.catalog = r.catalog;
      e.futureTime = r.futureTime;
    } else if (r.kind === 'newer') e.newer = true;
    else if (r.kind === 'refused') e.cacheProblem = r.reason;
    else if (r.kind === 'quarantined') {
      e.cacheProblem = CACHE_REASONS.unreadable;
      this.log.warn(`models: ${provider}/${account}: ${CACHE_REASONS.unreadable}`); // static text: never the parse error (S12)
    }
    this.entries.set(k, e);
    return e;
  }

  // ───────────────────────── views (memory only) ─────────────────────────
  view(provider: ProviderId, account = 'default'): CatalogView {
    // S17: while Codex discovery is disabled (a code constant) nothing about Codex is looked up — not even its binary
    if (provider === 'codex' && !CODEX_DISCOVERY_ENABLED) return { provider: 'codex', state: 'unavailable', reason: CODEX_UNAVAILABLE_REASON };
    if (provider !== 'claude' && provider !== 'cursor') return { provider, state: 'unavailable', reason: 'unknown tool' };
    if (!ACCOUNT_RE.test(account)) return { provider, state: 'unavailable', reason: 'unknown account' };
    const e = this.entry(provider, account);
    const refreshing = e.inFlight ? ({ refreshing: true } as const) : {};
    const c = e.catalog;
    if (!c) {
      if (e.inFlight) return { provider, state: 'reading' };
      const reason = e.failReason ?? (e.newer ? CACHE_REASONS.newer.replace('showing this session\'s copy', 'refresh to get this session\'s copy') : e.cacheProblem) ?? `Conductor has not asked ${LABEL[provider]} for its models yet`;
      return { provider, state: 'unavailable', reason };
    }
    let reason: string | undefined;
    if (e.failed && e.failReason) reason = `showing the list from ${hhmm(c.fetchedAt, e.futureTime)} — ${e.failReason}`;
    else if (e.futureTime) reason = 'the saved list has an impossible date; refresh to replace it';
    else if (e.newer && e.memoryOnly) reason = CACHE_REASONS.newer;
    else if (e.memoryOnly && e.cacheProblem) reason = e.cacheProblem;
    const v: CatalogView = {
      provider,
      state: e.failed || e.futureTime ? 'stale' : 'fresh',
      ...(reason ? { reason } : {}),
      ...refreshing,
      version: 1,
      account: c.account,
      source: c.source,
      cliVersion: c.cliVersion,
      ...(e.futureTime ? {} : { fetchedAt: c.fetchedAt }),
      signedIn: c.signedIn,
      ...(c.plan ? { plan: c.plan } : {}),
      models: c.models.map((m) => ({ ...m, ...(m.efforts ? { efforts: [...m.efforts] } : {}) })),
    };
    if (provider === 'cursor') {
      if (!e.families || e.families.for !== c) e.families = { for: c, value: cursorFamilies(c.models) };
      v.families = e.families.value.map((f) => ({ ...f, efforts: [...f.efforts], ids: [...f.ids] }));
    }
    return v;
  }

  viewAll(account = 'default'): CatalogView[] {
    return (['claude', 'cursor', 'codex'] as const).map((p) => this.view(p, account));
  }

  // ───────────────────────── refresh ─────────────────────────
  /** Start (or join) a refresh. Resolves with the view once it finished; callers on the request path never await it. */
  refresh(provider: ProviderId, trigger: RefreshTrigger = 'manual', account = 'default'): Promise<CatalogView> {
    if ((provider !== 'claude' && provider !== 'cursor') || !ACCOUNT_RE.test(account) || this.stopped) return Promise.resolve(this.view(provider, account));
    const e = this.entry(provider, account);
    if (e.inFlight) return e.inFlight;
    if (trigger === 'manual' && e.lastFinished && this.clock.now() - e.lastFinished < MANUAL_WINDOW_MS) return Promise.resolve(this.view(provider, account));
    return this.start(provider, account, trigger);
  }

  private start(provider: Discoverable, account: string, trigger: RefreshTrigger): Promise<CatalogView> {
    const e = this.entry(provider, account);
    const p = this.enqueue(() => this.discover(provider, account, trigger)).then(() => {
      e.inFlight = null;
      return this.view(provider, account);
    });
    e.inFlight = p;
    return p;
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const r = this.queue.then(fn);
    this.queue = r.then(
      () => undefined,
      () => undefined,
    );
    return r.catch(() => undefined);
  }

  /** S11 gate for every automatic trigger. */
  private autoAllowed(e: Entry, version: string | null): boolean {
    if (this.stopped || e.inFlight) return false;
    if (e.lastFailAt && this.clock.now() - e.lastFailAt < AUTO_BACKOFF_MS) return false;
    const v = version ?? '?';
    if (e.autoVersions.has(v)) return false;
    e.autoVersions.add(v);
    return true;
  }

  /** A health read reported this CLI version: refresh when there is no cache or the cached list came from another version. */
  noteVersion(provider: ProviderId, version: string | undefined | null, account = 'default'): Promise<CatalogView> | null {
    if (provider !== 'claude' && provider !== 'cursor') return null;
    if (!ACCOUNT_RE.test(account)) return null;
    const v = cleanVersion(version);
    if (v) this.seenVersion.set(provider, v);
    const e = this.entry(provider, account);
    if (e.catalog && !e.futureTime && !e.failed && e.catalog.cliVersion !== null && e.catalog.cliVersion === v) return null;
    if (!this.autoAllowed(e, v)) return null;
    return this.start(provider, account, e.catalog ? 'version' : 'startup');
  }

  /** Background start-up discovery for every installed tool (cheap detect said it starts) and every account. Never throws. */
  async startup(health: Partial<Record<ProviderId, HealthLike | undefined>>): Promise<void> {
    const started: Promise<CatalogView>[] = [];
    for (const p of ['claude', 'cursor'] as const) {
      const h = health[p];
      if (!h || h.found !== true || (h.state !== undefined && h.state !== 'ok')) continue;
      for (const a of this.accounts(p)) {
        const s = this.noteVersion(p, h.version ?? null, a);
        if (s) started.push(s);
      }
    }
    await Promise.all(started);
  }

  /** M8-2 hook: a run with an explicit model failed and the CLI's own error says the model is unknown. Rate-limited. */
  noteUnknownModel(provider: ProviderId, account = 'default'): void {
    if (provider !== 'claude' && provider !== 'cursor') return;
    if (!ACCOUNT_RE.test(account) || this.stopped) return;
    const e = this.entry(provider, account);
    const now = this.clock.now();
    if (e.inFlight) return;
    if (e.lastUnknownAt && now - e.lastUnknownAt < AUTO_BACKOFF_MS) return;
    if (e.lastFailAt && now - e.lastFailAt < AUTO_BACKOFF_MS) return;
    e.lastUnknownAt = now;
    void this.start(provider, account, 'unknown-model');
  }

  /** M8-3: drop the in-memory entry of a removed account. */
  forget(provider: ProviderId, account: string): void {
    const k = this.key(provider, account);
    if (!this.entries.get(k)?.inFlight) this.entries.delete(k);
  }

  /** Abort in-flight discoveries (process-group kill) and refuse new ones. */
  stop(): void {
    this.stopped = true;
    this.stopAc.abort();
  }

  private accounts(p: ProviderId): string[] {
    const ids = this.d.accountIds?.(p) ?? ['default'];
    return ids.filter((a) => ACCOUNT_RE.test(a));
  }

  private bins(): { claude: string | null; cursor: string | null } {
    if (this.d.bins) return this.d.bins();
    const cfg = this.d.getConfig();
    return { claude: resolveBin(cfg.agents.claude.bin), cursor: resolveBin(cfg.agents.cursor.bin) };
  }

  private async discover(provider: Discoverable, account: string, trigger: RefreshTrigger): Promise<void> {
    if (this.stopped) return;
    const t0 = this.clock.now();
    this.counters.refreshes++;
    let outcome: DiscoveryOutcome;
    let leftover = 0;
    try {
      outcome = await this.runOnce(provider, account, (n) => (leftover = n));
    } catch {
      outcome = { ok: false, kind: 'failed', reason: 'model discovery failed inside Conductor', identity: [] };
    }
    if (this.stopped) return; // shutting down: nothing is applied or written
    const e = this.entry(provider, account);
    const now = this.clock.now();
    e.lastFinished = now;
    if (outcome.ok) {
      const catalog: Catalog = {
        version: 1, provider, account, source: outcome.source, cliVersion: outcome.cliVersion, fetchedAt: now, signedIn: outcome.signedIn,
        ...(outcome.plan ? { plan: outcome.plan } : {}), models: outcome.models,
      };
      const w = writeCache(catalog);
      e.memoryOnly = w !== 'written';
      if (w === 'newer') e.newer = true;
      else if (w === 'written') {
        e.newer = false;
        e.cacheProblem = undefined;
      } else e.cacheProblem = w === 'refused' ? CACHE_REASONS.folder : 'the model list could not be saved';
      e.catalog = catalog;
      e.futureTime = false;
      e.failed = false;
      e.failReason = undefined;
      if (catalog.cliVersion) e.autoVersions.add(catalog.cliVersion);
      this.log.info(`models refresh provider=${provider} account=${account} trigger=${trigger} outcome=ok models=${catalog.models.length} dropped=${outcome.dropped} cliVersion=${catalog.cliVersion ?? 'unknown'} durationMs=${now - t0} leftover=${leftover}${e.memoryOnly ? ' saved=no' : ''}`);
    } else {
      e.failed = true;
      e.lastFailAt = now;
      e.failReason = scrubIdentity(outcome.reason, outcome.identity) || 'model discovery failed';
      this.log.warn(`models refresh provider=${provider} account=${account} trigger=${trigger} outcome=${outcome.kind} models=0 dropped=0 cliVersion=${this.seenVersion.get(provider) ?? 'unknown'} durationMs=${now - t0} leftover=${leftover} reason="${e.failReason}"`);
    }
  }

  private async runOnce(provider: Discoverable, account: string, setLeftover: (n: number) => void): Promise<DiscoveryOutcome> {
    if (process.env.NODE_TEST_CONTEXT && !this.injected) {
      this.counters.refusedInTest++;
      return { ok: false, kind: 'refused', reason: TEST_REFUSAL_REASON, identity: [] };
    }
    const bin = this.bins()[provider];
    if (!bin) return { ok: false, kind: 'spawn', reason: `${LABEL[provider]} is not installed`, identity: [] };
    const wd = prepareDiscoveryDir();
    if (!wd.ok) return { ok: false, kind: 'refused', reason: wd.reason, identity: [] };
    try {
      // Security code review L4: the existing allow-lists, unchanged. Claude's model list depends on CLAUDE_CODE_ENTRYPOINT (13 entries
      // inside a Claude Code session vs 5 with Conductor's env); it must NOT be added to CLAUDE_KEYS without a Security review — it
      // changes what the CLI believes its host is. fixtures/real/claude-initialize-2.1.304-conductor-env.json pins what Conductor sees.
      const env = this.d.envFor ? await this.d.envFor(provider, account) : provider === 'claude' ? claudeEnv(this.d.extraEnv ?? {}) : cursorEnv(this.d.extraEnv ?? {});
      const spawnFn = this.d.spawn ?? runProcess;
      const ctx = {
        bin,
        cwd: wd.dir,
        env,
        timeoutMs: this.d.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
        graceMs: this.d.graceMs,
        signal: this.stopAc.signal,
        spawn: (o: SpawnOpts) => {
          this.counters.spawns++;
          return spawnFn(o);
        },
      };
      return provider === 'claude' ? await discoverClaude(ctx) : await discoverCursor({ ...ctx, cliVersion: this.seenVersion.get('cursor') ?? null });
    } finally {
      setLeftover(cleanDiscoveryDir()); // after the child was reaped (runProcess resolved)
    }
  }
}

function hhmm(t: number, future: boolean): string {
  if (future) return 'an unknown time';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
