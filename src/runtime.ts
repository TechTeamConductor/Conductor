import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, LinearPort } from './types.ts';
import { defaultConfig, loadConfig, loadState, normalizeConfig, saveConfig, saveState, type PersistentState } from './config.ts';
import { ensureHome, paths } from './paths.ts';
import { RunStore } from './store.ts';
import { Agents } from './agents/provider.ts';
import { Engine } from './pipeline/engine.ts';
import { LinearClient, validateKey } from './linear/client.ts';
import { resolveProvisioned } from './linear/provision.ts';
import { Api } from './server/api.ts';
import { Auth } from './server/auth.ts';
import { DashboardServer } from './server/http.ts';
import { agentHealth, probe as doProbe, runChecks } from './doctor.ts';
import { SECRET_LINEAR, defaultSecretStore, dropSecret, getSecret, putSecret, type SecretStore } from './secrets.ts';
import { configureLog, logger } from './log.ts';
import { notify as osNotify } from './notify.ts';
import type { ExecFn } from './server/open.ts';

const log = logger('runtime');
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = '0.1.0';

export interface RuntimeOptions {
  /** Do not read/write ~/.conductor/config.json (demo, tests). */
  ephemeral?: boolean;
  config?: Config;
  linear?: LinearPort | null;
  agents?: Agents;
  secretStore?: SecretStore;
  persistent?: { load(): PersistentState; save(s: PersistentState): void };
  /** Replace real CLI health checks (demo/tests). */
  health?: () => Promise<{ claude: any; cursor: any }>;
  probe?: (t: 'claude' | 'cursor' | 'linear') => Promise<{ ok: boolean; detail: string; durationMs: number }>;
  openExec?: ExecFn;
  notify?: (title: string, message: string) => void;
  uiDir?: string;
}

export interface Runtime {
  cfgRef: { current: Config };
  engine: Engine;
  store: RunStore;
  api: Api;
  auth: Auth;
  server: DashboardServer;
  linearRef: { port: LinearPort | null; key: string | null };
  /** Re-check Linear provisioning/viewer after startup or setup. */
  refreshLinear(): Promise<void>;
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
  const secretStore = opts.secretStore ?? defaultSecretStore();
  const linearRef: Runtime['linearRef'] = { port: opts.linear ?? null, key: null };
  if (opts.linear === undefined) {
    const key = await getSecret(secretStore, SECRET_LINEAR);
    if (key) {
      linearRef.key = key;
      linearRef.port = new LinearClient({ apiKey: key });
      configureLog({ secrets: [key] });
    }
  }
  const agents = opts.agents ?? new Agents(getConfig);
  const persistent = opts.persistent ?? { load: loadState, save: saveState };
  const auth = new Auth();
  let serverRef: DashboardServer | null = null;
  const notify = (t: string, m: string) => {
    (opts.notify ?? osNotify)(t, m);
    serverRef?.toast('info', `${t}: ${m}`);
  };
  const engine = new Engine({
    getConfig,
    setConfig: save,
    store,
    linear: () => linearRef.port,
    agents,
    notify,
    persistent,
    secrets: () => (linearRef.key ? [linearRef.key] : []),
  });
  let apiRef: Api;
  const health = async () => {
    const base = opts.health ? await opts.health() : { claude: await agentHealth(getConfig(), 'claude'), cursor: await agentHealth(getConfig(), 'cursor') };
    const warnings: string[] = [];
    if (!opts.health) {
      for (const c of await runChecks(getConfig(), { linear: linearRef.port })) if (c.level === 'warn' && c.id !== 'linear' && c.id !== 'repos' && c.id !== 'keychain') warnings.push(`${c.label}: ${c.detail}`);
    }
    return { claude: base.claude, cursor: base.cursor, linear: { ok: !!linearRef.port && !!getConfig().linear.viewerId, detail: linearRef.port ? undefined : 'Not connected yet' }, warnings };
  };
  apiRef = new Api({
    engine,
    store,
    auth,
    version: VERSION,
    getConfig,
    saveConfig: save,
    persistent: () => persistent.load(),
    linear: () => linearRef.port,
    connectLinear: async (key) => {
      const r = await validateKey(key);
      await putSecret(secretStore, SECRET_LINEAR, key);
      linearRef.key = key;
      linearRef.port = new LinearClient({ apiKey: key });
      configureLog({ secrets: [key] });
      save({ ...getConfig(), linear: { ...getConfig().linear, viewerId: r.viewer.id } });
      engine.invalidate();
      return r;
    },
    health,
    probe: opts.probe ?? ((t) => doProbe(getConfig(), t, linearRef.port)),
    openExec: opts.openExec,
  });
  const server = new DashboardServer({ api: apiRef, auth, store, engine, uiDir: opts.uiDir ?? join(ROOT, 'ui') });
  serverRef = server;

  const refreshLinear = async () => {
    const cfg = getConfig();
    if (!linearRef.port) return;
    try {
      const v = await linearRef.port.viewer();
      apiRef.setViewerName(v.name || v.email);
      if (cfg.linear.viewerId !== v.id) save({ ...cfg, linear: { ...cfg.linear, viewerId: v.id } });
      if (cfg.linear.teamId) apiRef.setProvisioned(!!(await resolveProvisioned(linearRef.port, cfg.linear.teamId, cfg.linear.mode, cfg.linear.triggerLabel)));
    } catch (e) {
      log.warn(`Linear check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return {
    cfgRef, engine, store, api: apiRef, auth, server, linearRef, refreshLinear,
    async close() {
      await engine.stop();
      await server.close();
    },
  };
}
export { dropSecret };
