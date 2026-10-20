import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './types.ts';
import { defaultConfig, loadConfig, loadState, normalizeConfig, saveConfig, saveState, type PersistentState } from './config.ts';
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
}

export interface Runtime {
  cfgRef: { current: Config };
  engine: Engine;
  store: RunStore;
  board: Board;
  api: Api;
  auth: Auth;
  server: DashboardServer;
  close(): Promise<void>;
}

export async function createRuntime(opts: RuntimeOptions = {}): Promise<Runtime> {
  ensureHome();
  const cfgRef = { current: opts.config ?? (opts.ephemeral ? normalizeConfig(defaultConfig()) : loadConfig()) };
  const getConfig = () => cfgRef.current;
  const save = (c: Config) => {
    cfgRef.current = c;
    if (!opts.ephemeral) saveConfig(c);
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
  const engine = new Engine({ getConfig, setConfig: save, store, board, agents, notify, persistent, secrets: () => [], offlineFetcher: globalThis.fetch as any });
  // The last CLI health the dashboard computed (the router reads it: a provider that is not installed / not signed in is skipped, visibly).
  // Older than 5 minutes it counts as unknown — a stale "not logged in" must never keep a provider out after the user signed in.
  let lastHealth: { at: number; value: { claude: any; cursor: any; codex: any } } | null = null;
  const readAgents = async () => {
    const base = opts.health ? await opts.health() : { claude: await agentHealth(getConfig(), 'claude'), cursor: await agentHealth(getConfig(), 'cursor'), codex: await agentHealth(getConfig(), 'codex') };
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
  const apiRef = new Api({
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
  });
  const server = new DashboardServer({ api: apiRef, auth, store, engine, uiDir: opts.uiDir ?? join(ROOT, 'ui') });
  serverRef = server;
  return {
    cfgRef, engine, store, board, api: apiRef, auth, server,
    async close() {
      await engine.stop();
      await server.close();
      if (ownBoard) board.close();
    },
  };
}
export { dropSecret };
