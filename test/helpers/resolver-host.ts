// Shared fake host for the resolver tests: a real RunStore in a throw-away dir, a stubbed model call, no agents.
import type { Config, Run } from '../../src/types.ts';
import { defaultConfig } from '../../src/config.ts';
import { RunStore, newRun } from '../../src/store.ts';
import type { ResolverCall, ResolverHost, ScanHook } from '../../src/pipeline/resolver.ts';
import { tmpDir } from './tmp-repo.ts';

export const KEY = 'ENG-1';
export const TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

export function cfgOf(mode: 'complete-auto' | 'per-settings' = 'complete-auto'): Config {
  const c = defaultConfig();
  c.pipeline.runMode = mode;
  return c;
}

export interface Setup {
  host: ResolverHost;
  store: RunStore;
  root: string;
  cfg: Config;
  calls: string[];
  state: { paused: boolean; hits: number[]; pausedAccounts: { provider: string; id: string }[]; reply: ResolverCall | ((prompt: string) => ResolverCall | Promise<ResolverCall>) };
  run(): Run;
}

export function setup(over: Partial<Run> = {}, o: { cfg?: Config; repoPath?: string; rescan?: ScanHook; reply?: unknown } = {}): Setup {
  const root = tmpDir('runs');
  const store = new RunStore(root);
  const run = { ...newRun({ key: KEY, itemId: 'i1', title: 'Add the thing', description: 'd', descHash: 'h', repo: 'demo', branch: 'main', worktree: '/nonexistent', baseSha: '0'.repeat(40), loopBudget: 3 }), status: 'running' as const, next: 'verify' as const, ...over };
  store.create(run);
  const cfg = o.cfg ?? cfgOf();
  const calls: string[] = [];
  const state: Setup['state'] = { paused: false, hits: [], pausedAccounts: [], reply: o.reply === undefined ? { kind: 'failed', reason: 'stub' } : { kind: 'ok', json: o.reply } };
  const host: ResolverHost = {
    cfg: () => cfg,
    run: (k) => store.get(k)!,
    patch: (k, fn) => store.update(k, fn),
    now: () => Date.now(),
    secrets: () => [],
    scanEntries: () => [],
    repoPath: () => o.repoPath ?? null,
    readArtifact: (k, n, f) => store.readArtifact(k, n, f),
    call: async (_k, prompt) => {
      calls.push(prompt);
      const r = state.reply;
      return typeof r === 'function' ? r(prompt) : r;
    },
    enginePaused: () => state.paused,
    hourly: { count: () => state.hits.length, record: (t) => void state.hits.push(t) },
    pauseAccount: (ref) => void state.pausedAccounts.push(ref),
    runsLimit: () => cfg.pipeline.maxAgentRunsPerIssue,
    ...(o.rescan ? { rescan: o.rescan } : {}),
    aborted: () => false,
    note: () => undefined,
  };
  return { host, store, root, cfg, calls, state, run: () => store.get(KEY)! };
}

export const act = (a: Record<string, unknown>) => ({ analysis: 'a short analysis', ...a });

