import { AskService } from './asks/service.ts';
import { BriefService, type BriefDeps } from './briefs/service.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, Run } from './types.ts';
import { configLoadedCleanly, defaultConfig, loadConfig, loadState, normalizeConfig, resolveBin, saveConfig, saveState, type PersistentState } from './config.ts';
import { ensureHome, paths } from './paths.ts';
import { RunStore } from './store.ts';
import { Board } from './board/index.ts';
import { Agents } from './agents/provider.ts';
import { runCodexCanary } from './agents/providers/canary.ts';
import { Engine } from './pipeline/engine.ts';
import { Api } from './server/api.ts';
import { Auth } from './server/auth.ts';
import { DashboardServer } from './server/http.ts';
import { agentHealth, probe as doProbe, runChecks } from './doctor.ts';
import { defaultSecretStore, dropSecret, type SecretStore } from './secrets.ts';
import { notify as osNotify } from './notify.ts';
import type { ExecFn } from './server/open.ts';
import { ModelService, type ModelServiceDeps } from './models/service.ts';
import { claudeEnv, cursorEnv } from './agents/env.ts';
import { logger } from './log.ts';
import { AccountService } from './accounts/service.ts';
import { effectiveLimitRule } from './accounts/limit-rule.ts';
import { DEFAULT_ACCOUNT } from './accounts/types.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = '0.2.0-dev';

export interface RuntimeOptions {
  /** Do not read/write <home>/config.json (demo, tests). */
  ephemeral?: boolean;
  config?: Config;
  /** Use this board instead of opening <home>/board (tests, demo). The caller owns closing it. */
  board?: Board;
  agents?: Agents;
  secretStore?: SecretStore;
  persistent?: { load(): PersistentState; save(s: PersistentState): void };
  /** Replace real CLI health checks (demo/tests). */
  health?: () => Promise<{ claude: any; cursor: any; codex?: any }>;
  probe?: (t: 'claude' | 'cursor') => Promise<{ ok: boolean; detail: string; durationMs: number }>;
  /** Replace the real Codex isolation canary (demo/tests). */
  canary?: (id: 'codex') => Promise<import('./agents/providers/canary.ts').CanaryReport>;
  openExec?: ExecFn;
  notify?: (title: string, message: string) => void;
  uiDir?: string;
  /**
   * Model discovery (M8-1 B1). `false` ⇒ no ModelService (GET /api/models answers 501). An object ⇒ deps merged over the defaults
   * (tests inject `spawn`, `bins`, `extraEnv`). Automatic discovery (startup / version change) runs only with REAL health (no `health`).
   */
  models?: false | Partial<ModelServiceDeps>;
}

export interface Runtime {
  cfgRef: { current: Config };
  engine: Engine;
  store: RunStore;
  board: Board;
  api: Api;
  auth: Auth;
  server: DashboardServer;
  /** Model discovery (absent when `models: false`). */
  models: ModelService | null;
  /** M8-3: accounts per tool (the shared strict handlers of the API, the control socket and the CLI). */
  accounts: AccountService;
  /**
   * One background, zero-quota health read (R2-N1): `conductor start` and the desktop sidecar call it after `listen`, so a headless start
   * still discovers models. Never awaited by anything; never throws.
   */
  warmUp(): void;
  close(): Promise<void>;
}

export async function createRuntime(opts: RuntimeOptions = {}): Promise<Runtime> {
  ensureHome();
  const cfgRef = { current: opts.config ?? (opts.ephemeral ? normalizeConfig(defaultConfig()) : loadConfig()) };
  const getConfig = () => cfgRef.current;
  // M8-4 B1: persist FIRST, then swap memory. A failed write (assertNotNewer, pre-upgrade backup, disk) throws before the swap, so memory
  // and disk always agree and a refused save changes nothing (every writer: settings, roles, projects, run mode).
  const save = (c: Config) => {
    if (!opts.ephemeral) saveConfig(c);
    cfgRef.current = c;
  };
  const store = new RunStore(paths.runs());
  const ownBoard = !opts.board;
  const board = opts.board ?? Board.open({ dir: paths.board() });
  const secretStore = opts.secretStore ?? defaultSecretStore();
  void secretStore;
  const agents = opts.agents ?? new Agents(getConfig);
  const persistent = opts.persistent ?? { load: loadState, save: saveState };
  const auth = new Auth({ persistPath: opts.ephemeral ? undefined : join(paths.runtime(), 'sessions.json') });
  let serverRef: DashboardServer | null = null;
  const notify = (t: string, m: string) => {
    (opts.notify ?? osNotify)(t, m);
    serverRef?.toast('info', `${t}: ${m}`);
  };
  const mlog = logger('models');
  // M8-3: the account service is created below; discovery reaches it lazily (envFor = accountEnv + pre-flight + assertion; S9 lease)
  let accountsRef: AccountService | null = null;
  const discoveryExtra = (opts.models ? opts.models.extraEnv : undefined) ?? {};
  const models = opts.models === false ? null : new ModelService({
    getConfig,
    extraEnv: {},
    bins: () => ({ claude: resolveBin(getConfig().agents.claude.bin), cursor: resolveBin(getConfig().agents.cursor.bin) }),
    log: mlog,
    // default ⇒ claudeEnv/cursorEnv(extraEnv) exactly as M8-1; named ⇒ the account env (never before the service exists)
    envFor: (p, a) => {
      if (!accountsRef) {
        if (a !== DEFAULT_ACCOUNT) throw new Error('accounts are not ready');
        return accountEnvDefault(p, discoveryExtra);
      }
      return accountsRef.envFor(p, a, discoveryExtra);
    },
    accountIds: (p) => (p === 'codex' ? [DEFAULT_ACCOUNT] : (getConfig().accounts?.[p] ?? []).map((m) => m.id)),
    afterDiscovery: (p, a) => accountsRef?.afterDiscovery(p, a),
    ...(opts.models ?? {}),
  });
  // M8-2: stage argv is resolved against the discovered lists (memory-only view, never awaited) and a CLI-rejected --model asks for a refresh
  // M8-3: per ACCOUNT (the M8-1 cache is keyed (provider, account); `default.json` carries over unchanged)
  if (models) agents.attachModels({ catalog: (t, a) => (a === undefined ? models.view(t) : models.view(t, a)), onUnknownModel: (t, a) => (a === undefined ? models.noteUnknownModel(t) : models.noteUnknownModel(t, a)) });
  // automatic discovery only when health is REAL (B1): an injected health (tests, demo) never starts a discovery by itself
  const autoDiscovery = !!models && !opts.health;
  const engine = new Engine({ getConfig, setConfig: save, store, board, agents, notify, persistent, secrets: () => [], offlineFetcher: globalThis.fetch as any });
  // The last CLI health the dashboard computed (the router reads it: a provider that is not installed / not signed in is skipped, visibly).
  // Older than 5 minutes it counts as unknown — a stale "not logged in" must never keep a provider out after the user signed in.
  let lastHealth: { at: number; value: { claude: any; cursor: any; codex: any } } | null = null;
  const readAgents = async () => {
    const base = opts.health ? await opts.health() : { claude: await agentHealth(getConfig(), 'claude'), cursor: await agentHealth(getConfig(), 'cursor'), codex: await agentHealth(getConfig(), 'codex') };
    if (autoDiscovery) void models!.startup({ claude: base.claude, cursor: base.cursor }).catch((e) => mlog.warn(`model discovery start failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`));
    return { claude: base.claude, cursor: base.cursor, codex: base.codex ?? { found: false, ok: false, state: 'missing', detail: 'Not checked.' } };
  };
  engine.setHealthSource(
    () => (lastHealth && Date.now() - lastHealth.at < 5 * 60_000 ? lastHealth.value : null),
    async () => {
      // the engine's own zero-quota refresh (version + sign-in only; agentHealth caches 60 s) — not the dashboard's heavier check list
      lastHealth = { at: Date.now(), value: await readAgents() };
    },
  );
  const health = async () => {
    const agentsNow = await readAgents();
    lastHealth = { at: Date.now(), value: agentsNow };
    const warnings: string[] = [];
    if (!opts.health) {
      for (const c of await runChecks(getConfig())) if (c.level === 'warn' && c.id !== 'repos' && c.id !== 'keychain' && c.id !== 'codex') warnings.push(`${c.label}: ${c.detail}`);
    }
    return { ...agentsNow, warnings };
  };
  const asks = new AskService({ getConfig, agents, routeStates: (role) => engine.routeStates(role), freshHealth: () => engine.freshHealth(), secrets: () => [],
    accountsGate: (role) => engine.accountsGate(role),
    limitRule: () => effectiveLimitRule(getConfig()),
    accountPause: (ref, until, reason) => engine.recordAccountPause(ref, until, reason),
    notify,
    networkState: () => engine.probe.check(),
    fastPathBusy: (repo) => store.list().some((r) => r.fastPath && r.repo === repo && !['ready', 'finished', 'aborted', 'needs_human'].includes(r.status)),
    cards: { create: (i) => { const p = engine.ensureProjectForRepo(i.repo); const it = board.createItem({ projectId: p.id, title: i.title, description: i.description, kind: 'work', lane: 'todo', idemKey: i.idemKey }, i.actor); engine.tickSoon(); return { key: it.key }; } } });
  asks.failInterrupted();
  // M8-6 "Design the work" + research briefs. The actor `design` is FIXED here (S9): the facade passes exactly kind/lane/parentId/autoStart,
  // the code-built title/description, ids from this send only and the strict idemKey — no key, external, milestone or stage.
  const briefs = new BriefService({
    getConfig, agents, routeStates: () => engine.routeStates(), freshHealth: () => engine.freshHealth(),
    // S7: the same values the engine redacts for that repository (copyFiles env values + the injected secret source)
    secrets: (repo) => (repo ? engine.secretsFor({ repo } as Run) : []),
    networkState: () => engine.probe.check(),
    asks,
    cards: designCards(engine, board, getConfig),
    accountPause: (ref, until, reason) => engine.recordAccountPause(ref, until, reason),
    // M8-3 / M8-6 C3: a Home call never queues — only a LIMIT pause refuses here (409 limited + retryAt); other routing refusals keep M8-6's checks
    accountsGate: (role) => {
      const g = engine.accountsGate(role);
      return g.ok || g.kind !== 'paused' ? { ok: true } : { ok: false, retryAt: g.retryAt, message: `${g.reason} — try again after the limit resets.` };
    },
  });
  briefs.sweepScratch();
  briefs.failInterrupted();
  void briefs.resumeSending();
  const accounts = new AccountService({
    getConfig,
    saveConfig: save,
    engine,
    ...(models ? { models } : {}),
    health: () => lastHealth?.value ?? null,
    extraEnv: discoveryExtra,
    abortCalls: async (ref) => (await asks.abortAccount(ref)) + (await briefs.abortAccount(ref)),
  });
  accountsRef = accounts;
  // code review N3: never sweep account folders after a config recovery (quarantined, missing, migrated or injected config) — they may hold
  // live sign-ins that the restored config would still name
  if (!opts.ephemeral && !opts.config && configLoadedCleanly()) accounts.sweep();
  // N6: every named account is checked at startup (M8-1's serialised queue); each completion invalidates + ticks the engine
  if (models && Object.values(getConfig().accounts ?? {}).some((l) => l.some((m) => m.id !== DEFAULT_ACCOUNT))) void accounts.checkAll();
  const apiRef = new Api({
    accounts,
    asks,
    briefs,
    engine,
    store,
    board,
    auth,
    version: VERSION,
    getConfig,
    saveConfig: save,
    persistent: () => persistent.load(),
    health,
    probe: opts.probe ?? ((t) => doProbe(getConfig(), t)),
    canary: opts.canary ?? (() => runCodexCanary({ bin: getConfig().agents.codex.bin })),
    openExec: opts.openExec,
    ...(models ? { models } : {}),
  });
  const server = new DashboardServer({ api: apiRef, auth, store, engine, uiDir: opts.uiDir ?? join(ROOT, 'ui') });
  serverRef = server;
  return {
    cfgRef, engine, store, board, api: apiRef, auth, server, models, accounts,
    warmUp() {
      void readAgents()
        .then((v) => {
          lastHealth = { at: Date.now(), value: v };
        })
        .catch(() => undefined);
    },
    async close() {
      models?.stop();
      await briefs.close();
      await engine.stop();
      await server.close();
      if (ownBoard) board.close();
    },
  };
}
export { dropSecret };

function accountEnvDefault(p: 'claude' | 'cursor', extra: Record<string, string>): Record<string, string> {
  return p === 'claude' ? claudeEnv(extra) : cursorEnv(extra);
}

/**
 * The ONLY writer of `design` cards (S9): the actor is fixed here, and the facade passes exactly kind work / lane todo / parentId null /
 * autoStart true, the code-built title and description, dependency ids from this send only and the strict idemKey — never a key,
 * external link, milestone or stage.
 */
export function designCards(engine: Engine, board: Board, getConfig: () => Config): NonNullable<BriefDeps['cards']> {
  return {
    createLinked: (i) => {
      const p = engine.ensureProjectForRepo(i.repo);
      const it = board.createItem({ projectId: p.id, kind: 'work', lane: 'todo', parentId: null, autoStart: true, title: i.title, description: i.description, dependsOn: i.dependsOn, idemKey: i.idemKey }, 'design');
      engine.tickSoon();
      return { id: it.id, key: it.key };
    },
    precheck: (repo, count, bytes) => {
      // a lookup, never a create (code review m2): a refused send must not leave a new project behind
      const p = board.projects().find((x) => x.repo === repo);
      if (p?.archived) throw Object.assign(new Error('archived'), { code: 'archived' });
      if (!board.hasRoom(count, bytes)) throw Object.assign(new Error('full'), { code: 'full' });
    },
    baseBranch: (repo) => getConfig().repos.find((r) => r.name === repo)?.baseBranch ?? 'main',
  };
}
