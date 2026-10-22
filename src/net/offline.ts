// Offline detection (M4). Outbound-only and deliberately timid: a HEAD to a constant list of the providers' own hosts, no cookies, no auth,
// body never read, redirects refused, 4 s timeout, result cached 20 s. `unknown` (a proxy is configured, or the probe could not decide) is
// treated as online so the probe can never trap anyone in "offline".
export type NetState = 'online' | 'offline' | 'unknown';
export const PROBE_HOSTS: readonly string[] = Object.freeze(['https://api.anthropic.com/', 'https://api.openai.com/', 'https://cursor.sh/']);
export const PROBE_TTL_MS = 20_000;
/** Pause backoff while offline: 30 s → 1 → 2 → 5 min (cap). */
export const OFFLINE_BACKOFF_MS: readonly number[] = Object.freeze([30_000, 60_000, 120_000, 300_000]);
export const OFFLINE_RUN_CEILING_MS = 24 * 3_600_000;
export const OFFLINE_EPISODE_CAP = 20;
export const backoffFor = (streak: number): number => OFFLINE_BACKOFF_MS[Math.min(Math.max(streak, 1), OFFLINE_BACKOFF_MS.length) - 1]!;

export type Fetcher = (url: string, init: { method: 'HEAD'; redirect: 'error'; signal: AbortSignal }) => Promise<unknown>;
const proxySet = (env: NodeJS.ProcessEnv): boolean => ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'].some((k) => !!env[k]);

export class OfflineProbe {
  private cached: { at: number; state: NetState } | null = null;
  private fetcher: Fetcher | null;
  private now: () => number;
  private env: NodeJS.ProcessEnv;
  /** `fetcher: null` disables the probe (always `unknown`) — the default in tests. */
  constructor(opts: { fetcher?: Fetcher | null; now?: () => number; env?: NodeJS.ProcessEnv } = {}) {
    this.fetcher = opts.fetcher === undefined ? (globalThis.fetch as unknown as Fetcher) : opts.fetcher;
    this.now = opts.now ?? Date.now;
    this.env = opts.env ?? process.env;
  }
  last(): { at: number; state: NetState } | null {
    return this.cached;
  }
  async check(force = false): Promise<NetState> {
    const t = this.now();
    if (!force && this.cached && t - this.cached.at < PROBE_TTL_MS) return this.cached.state;
    let state: NetState = 'unknown';
    if (this.fetcher && !proxySet(this.env)) {
      let reached = 0;
      let refused = 0;
      for (const url of PROBE_HOSTS) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 4000);
        try {
          await this.fetcher(url, { method: 'HEAD', redirect: 'error', signal: ac.signal });
          reached++;
        } catch (e) {
          // an HTTP-level answer (even a redirect refusal) proves a network; a DNS/connect failure does not
          const msg = `${(e as Error)?.message ?? ''} ${((e as any)?.cause?.code ?? '')}`;
          if (/redirect/i.test(msg)) reached++;
          else refused++;
        } finally {
          clearTimeout(timer);
        }
        if (reached) break;
      }
      state = reached ? 'online' : refused === PROBE_HOSTS.length ? 'offline' : 'unknown';
    }
    this.cached = { at: t, state };
    return state;
  }
}

export interface OfflineOp { id: string; label: string; mode: 'offline-ok' | 'needs-network'; provider?: string }
export const OFFLINE_OPERATIONS: readonly OfflineOp[] = Object.freeze([
  { id: 'board', label: 'Board, cards and notes', mode: 'offline-ok' },
  { id: 'context', label: 'Project context (read and refresh from git)', mode: 'offline-ok' },
  { id: 'gates', label: 'Quality gates and builds in progress files', mode: 'offline-ok' },
  { id: 'history', label: 'Run history and saved plans', mode: 'offline-ok' },
  { id: 'import', label: 'Importing a v1 data folder', mode: 'offline-ok' },
  { id: 'settings', label: 'Settings and roles', mode: 'offline-ok' },
  { id: 'claude', label: 'Planning, review and verification with Claude', mode: 'needs-network', provider: 'claude' },
  { id: 'cursor', label: 'Building with Cursor', mode: 'needs-network', provider: 'cursor' },
  { id: 'codex', label: 'Read-only analysis with Codex', mode: 'needs-network', provider: 'codex' },
]);
