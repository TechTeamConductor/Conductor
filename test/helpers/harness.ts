import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, Run } from '../../src/types.ts';
import { defaultConfig, normalizeConfig } from '../../src/config.ts';
import { ensureHome } from '../../src/paths.ts';
import { RunStore } from '../../src/store.ts';
import { Agents } from '../../src/agents/provider.ts';
import { Engine } from '../../src/pipeline/engine.ts';
import { Board, type Lane } from '../../src/board/index.ts';
import { configureLog } from '../../src/log.ts';
import { setNotifier } from '../../src/notify.ts';
import type { Clock } from '../../src/util.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, '..', '..', 'fixtures');
export const FAKE_CLAUDE = join(FIXTURES, 'fake-claude.mjs');
export const FAKE_AGENT = join(FIXTURES, 'fake-agent.mjs');

/** A manually-advanced clock for deterministic pause/resume tests. */
export class TestClock implements Clock {
  t: number;
  constructor(start = Date.now()) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface HarnessOpts {
  config?: (cfg: Config) => void;
  clock?: Clock;
  repoFiles?: Record<string, string>;
  gates?: boolean;
  /** Board redactor etc. */
  board?: Parameters<typeof Board.open>[0];
  /** A stand-in for the project context engine (default: the real one). */
  context?: import('../../src/context/service.ts').ContextLike;
  /** Connectivity probe fetcher (default: probe off). */
  offlineFetcher?: import('../../src/net/offline.ts').Fetcher | null;
}
export interface Harness {
  root: string;
  home: string;
  repoDir: string;
  fakeDir: string;
  cfg: Config;
  board: Board;
  projectId: string;
  store: RunStore;
  agents: Agents;
  engine: Engine;
  notes: { title: string; message: string }[];
  scenario(obj: unknown): void;
  calls(): any[];
  /** Create a work card in To do (or `lane`), authored by the user. Returns its key. */
  issue(title: string, extra?: { description?: string; lane?: 'todo' | 'backlog' }): string;
  /** tick → wait for jobs, repeat until nothing is queued/running (or maxTicks). */
  settle(maxTicks?: number): Promise<void>;
  run(key: string): Run;
  cleanup(): Promise<void>;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).trim();
}

export function makeRepo(dir: string, files: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  const base: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
    'README.md': '# demo\n',
    'src/index.mjs': 'export const hello = () => "hi";\n',
    '.gitignore': 'node_modules\n.env\n',
    ...files,
  };
  for (const [p, c] of Object.entries(base)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
}

export async function makeHarness(opts: HarnessOpts = {}): Promise<Harness> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cond-h-')));
  const home = join(root, 'home');
  process.env.CONDUCTOR_HOME = home;
  process.env.CONDUCTOR_NO_NOTIFY = '1';
  process.env.CONDUCTOR_QUIET = '1';
  configureLog({ file: false, level: 'warn' });
  ensureHome();
  chmodSync(FAKE_CLAUDE, 0o755);
  chmodSync(FAKE_AGENT, 0o755);
  const repoDir = join(root, 'repo');
  makeRepo(repoDir, opts.repoFiles);
  const fakeDir = join(root, 'fake');
  mkdirSync(fakeDir, { recursive: true });
  const board = Board.open({ dir: join(home, 'board'), ...opts.board });
  const cfg = normalizeConfig({
    ...defaultConfig(),
    repos: [
      {
        name: 'demo',
        path: repoDir,
        baseBranch: 'main',
        gates: opts.gates === false ? [] : [{ name: 'test', cmd: 'node --test', kind: 'test' }],
        copyFiles: [],
        envPassthrough: [],
      },
    ],
    agents: { claude: { bin: FAKE_CLAUDE, isolation: 'safe-mode', maxTurns: { plan: 40, review: 25, verify: 40 } }, cursor: { bin: FAKE_AGENT } },
    pipeline: { ...defaultConfig().pipeline, runMode: 'per-settings', planApproval: 'auto', planReview: 'off', timeoutsMin: { plan: 2, review: 2, build: 2, verify: 2, idle: 1, gate: 2 } },
    worktreeRoot: join(root, 'worktrees'),
  });
  opts.config?.(cfg);
  const project = board.createProject({ key: 'ENG', name: 'Demo', repo: 'demo' });
  const store = new RunStore(join(home, 'runs'));
  const agents = new Agents(() => cfg, { clock: opts.clock, extraEnv: { FAKE_DIR: fakeDir } });
  const notes: { title: string; message: string }[] = [];
  setNotifier((title, message) => notes.push({ title, message }));
  const approved: Record<string, { approvedPlans: number }> = {};
  const engine = new Engine({
    getConfig: () => cfg,
    store,
    board,
    agents,
    clock: opts.clock,
    notify: (title, message) => notes.push({ title, message }),
    persistent: { load: () => ({ repos: approved }), save: (s) => Object.assign(approved, s.repos) },
    secrets: () => [],
    context: opts.context,
    offlineFetcher: opts.offlineFetcher,
  });
  const h: Harness = {
    root, home, repoDir, fakeDir, cfg, board, projectId: project.id, store, agents, engine, notes,
    scenario(obj) {
      writeFileSync(join(fakeDir, 'scenario.json'), JSON.stringify(obj, null, 2));
    },
    calls() {
      const f = join(fakeDir, 'calls.jsonl');
      return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    issue(title, extra = {}) {
      return board.user.createItem({ projectId: project.id, title, description: extra.description ?? `Please implement: ${title}`, lane: (extra.lane ?? 'todo') as Lane }).key;
    },
    async settle(maxTicks = 40) {
      for (let i = 0; i < maxTicks; i++) {
        await engine.tick();
        await engine.idle();
        const busy = store.list().some((r) => r.status === 'queued' || r.status === 'running');
        if (!busy) {
          await engine.tick(); // let the projection observe the final state once more
          await engine.idle();
          if (!store.list().some((r) => r.status === 'queued' || r.status === 'running')) return;
        }
      }
      throw new Error('settle: pipeline did not quiesce: ' + JSON.stringify(store.list().map((r) => [r.key, r.status, r.next])));
    },
    run(key) {
      const r = store.get(key);
      if (!r) throw new Error(`no run ${key}`);
      return r;
    },
    async cleanup() {
      await engine.stop();
      board.close();
      setNotifier(null);
      rmSync(root, { recursive: true, force: true });
    },
  };
  return h;
}
