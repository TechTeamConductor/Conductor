import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProviderId, Config } from './types.ts';
import { defaultConfig, normalizeConfig } from './config.ts';
import { ensureHome } from './paths.ts';
import { Agents } from './agents/provider.ts';
import { Board } from './board/index.ts';
import { MemoryStore } from './secrets.ts';
import { createRuntime, ROOT, type Runtime } from './runtime.ts';

export interface DemoHandle {
  rt: Runtime;
  board: Board;
  url: string;
  home: string;
  close(): Promise<void>;
}

const gitEnv = { GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' };

/** Full pipeline on scripted agents + a throw-away board: no keys, no quota, nothing leaves the machine. */
export async function startDemo(opts: { port?: number; pollMs?: number; delayMs?: number; canary?: () => Promise<import('./agents/providers/canary.ts').CanaryReport> } = {}): Promise<DemoHandle> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-demo-')));
  process.env.CONDUCTOR_HOME = join(home, '.conductor');
  process.env.CONDUCTOR_NO_KEYCHAIN = '1';
  process.env.CONDUCTOR_NO_NOTIFY = '1';
  ensureHome();
  const repoDir = join(home, 'demo-app');
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ name: 'demo-app', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  writeFileSync(join(repoDir, 'src', 'index.mjs'), 'export const hello = () => "hello";\n');
  writeFileSync(join(repoDir, 'README.md'), '# demo-app\n\nA tiny project for the Conductor demo.\n');
  writeFileSync(join(repoDir, '.gitignore'), 'node_modules\n.env\n');
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repoDir, env: { ...process.env, ...gitEnv, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');

  const fakeDir = join(home, 'fake');
  mkdirSync(fakeDir, { recursive: true });
  const d = opts.delayMs ?? 1400;
  const bug = {
    title: 'Greeting ignores the name argument',
    severity: 'major',
    file: 'feature-demo-2.mjs',
    line: 1,
    evidence: 'feature() always returns 42 regardless of input, so the toggle state is never read.',
    repro: 'feature(true) !== feature(false)',
    suggestedFix: 'Read the argument and branch on it.',
  };
  writeFileSync(
    join(fakeDir, 'scenario.json'),
    JSON.stringify({
      claude: {
        '*': { plan: [{ delayMs: d }], plan_review: [{ delayMs: d }], verify: [{ delayMs: d }] },
        'DEMO-2': { plan: [{ delayMs: d, json: { complexity: 'M' } }], plan_review: [{ delayMs: d }], verify: [{ delayMs: d, json: { verdict: 'fail', summary: 'One real problem found by the independent review.', bugs: [bug] } }, { delayMs: d, json: { verdict: 'pass' } }] },
        'DEMO-3': { plan: [{ delayMs: d, json: { blocked: { is: true, questions: ['Which database should this use — SQLite or Postgres?', 'Is downtime acceptable during the migration?'] } } }] },
      },
      cursor: { '*': { build: [{ delayMs: d * 2 }, { delayMs: d * 2 }] } },
    }),
  );
  const fc = join(ROOT, 'fixtures', 'fake-claude.mjs');
  const fa = join(ROOT, 'fixtures', 'fake-agent.mjs');
  chmodSync(fc, 0o755);
  chmodSync(fa, 0o755);

  const board = Board.open({ dir: join(home, '.conductor', 'board') });
  const cfg: Config = normalizeConfig({
    ...defaultConfig(),
    ui: { port: opts.port ?? 4318, openBrowser: false },
    repos: [{ name: 'demo-app', path: repoDir, baseBranch: 'main', gates: [{ name: 'test', cmd: 'node --test', kind: 'test' }], copyFiles: [], envPassthrough: [] }],
    agents: { claude: { bin: fc, isolation: 'safe-mode', maxTurns: { plan: 40, review: 25, verify: 40 } }, cursor: { bin: fa } },
    pipeline: { ...defaultConfig().pipeline, runMode: 'per-settings', planApproval: 'first', planReview: 'always', timeoutsMin: { plan: 3, review: 3, build: 5, verify: 3, idle: 2, gate: 3 } },
    worktreeRoot: join(home, 'worktrees'),
  });
  const project = board.createProject({ key: 'DEMO', name: 'Demo app', repo: 'demo-app' });
  board.user.createItem({ projectId: project.id, title: 'Add a friendly greeting function', description: 'Add `greet(name)` that returns "Hello, <name>!" with a unit test.' });
  board.user.createItem({ projectId: project.id, title: 'Support a dark-mode toggle', description: 'The settings page needs a dark-mode toggle that persists across reloads.' });
  board.user.createItem({ projectId: project.id, title: 'Migrate storage to a real database', description: 'Replace the JSON file store with a database.' });

  const persisted: Record<string, { approvedPlans: number }> = {};
  const cfgHolder: { current: Config } = { current: cfg };
  const agents = new Agents(() => cfgHolder.current, { extraEnv: { FAKE_DIR: fakeDir } });
  const rt = await createRuntime({
    ephemeral: true,
    config: cfg,
    board,
    agents,
    secretStore: new MemoryStore(),
    persistent: { load: () => ({ repos: persisted }), save: (s) => Object.assign(persisted, s.repos) },
    health: async () => ({
      claude: { found: true, version: '2.1.296 (demo)', ok: true, loggedIn: true, detail: 'Demo mode — scripted agent' },
      cursor: { found: true, version: '2026.10.19 (demo)', ok: true, loggedIn: true, detail: 'Demo mode — scripted agent' },
      codex: { found: false, ok: false, state: 'missing', detail: 'Codex is not part of the demo.' },
    }),
    probe: async (t: 'claude' | 'cursor') => ({ ok: true, detail: `${t} (demo) answered`, durationMs: 120 }),
    canary: opts.canary ?? (async () => ({ verdict: 'inconclusive' as const, items: [{ id: 'setup', outcome: 'inconclusive' as const, detail: 'Codex is not part of the demo.' }], binding: null, ranAt: Date.now() })),
    openExec: async () => undefined,
    notify: () => undefined,
    // model discovery follows the demo's own scenario (fake CLIs + FAKE_DIR); with injected health it never starts by itself
    models: { extraEnv: { FAKE_DIR: fakeDir } },
  });
  cfgHolder.current = rt.cfgRef.current;
  const port = await rt.server.listen(opts.port ?? 4318);
  rt.engine.start({ pollMs: opts.pollMs ?? 2000 });
  return {
    rt,
    board,
    home,
    url: `http://127.0.0.1:${port}/`,
    async close() {
      await rt.close();
      board.close();
    },
  };
  void port; void dirname; void (null as unknown as ProviderId);
}
