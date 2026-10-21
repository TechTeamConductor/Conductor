// M8-2 commit 0 (plan `workspace-v2-m8-2.md` B5a / AC1): END-TO-END golden argv, pinned BEFORE any M8-2 source edit.
//
// M8-1's `test/argv-golden.test.ts` pins the three argv BUILDERS. M8-2 changes the plumbing that decides what those builders receive
// (who resolves the model, the effort, the tool default), so this file pins what the CLI actually RECEIVES on every real path:
//   pipeline plan → Cursor build (runBuild) → verify · Agents.readOnly plan_review / Cursor ask / Codex exec · AskService research ·
//   doctor isolation probe + probes · provider selfTest canaries.
// Each CLI is a recorder that appends its full argv to calls.jsonl and then runs the existing fake (unchanged fakes).
// The expected arrays below are LITERALS written from today's code — never recomputed by calling a builder. Only four run-dependent
// values are normalised: the value after `--workspace` (<cwd>), after `-o` (<out>), after `--json-schema` (<schema>), and the ask id
// in "conductor research <id>". Everything else is compared element by element.
// Configs: (a) defaults, (b) a v5 config.json without models, (c) a v5 config.json with agents.claude.model 'opus' and
// agents.codex.model 'gpt-5.1-codex' — loaded through loadConfig(), so after M8-2 it goes through the v5→v6 migration and must still
// yield today's `--model` elements. Also pins CODEX_ARGV_DIGEST() to a hex literal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config } from '../src/types.ts';
import { loadConfig } from '../src/config.ts';
import { paths } from '../src/paths.ts';
import { CODEX_ARGV_DIGEST } from '../src/agents/providers/codex.ts';
import { codexHomePath, prepareCodexHome } from '../src/agents/providers/codex-home.ts';
import { AskService } from '../src/asks/service.ts';
import { isolationProbe, probe } from '../src/doctor.ts';
import { FAKE_AGENT, FAKE_CLAUDE, FIXTURES, makeHarness, type Harness } from './helpers/harness.ts';

const FAKE_CODEX = join(FIXTURES, 'fake-codex.mjs');

// ───────────── literals (today's argv) ─────────────
const DENIED = ['Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.pem)', 'Read(**/*.key)', 'Read(**/id_rsa*)', 'Read(**/id_ed25519*)', 'Read(**/.npmrc)', 'Read(**/.aws/**)', 'Read(**/.ssh/**)'];
const CLAUDE_COMMON_TAIL = ['--disallowedTools', ...DENIED, '--disable-slash-commands', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--permission-prompts', 'none'];
const claudeReadOnly = (maxTurns: string, name: string, model: string[], schema: boolean): string[] => [
  '-p', '--output-format', 'stream-json', '--verbose', '--safe-mode',
  '--tools', 'Read,Grep,Glob',
  ...CLAUDE_COMMON_TAIL,
  '--max-turns', maxTurns, '-n', name,
  ...model,
  ...(schema ? ['--json-schema', '<schema>'] : []),
];
const claudeResearch = (model: string[]): string[] => [
  '-p', '--output-format', 'stream-json', '--verbose', '--safe-mode',
  '--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch', 'WebFetch',
  ...CLAUDE_COMMON_TAIL,
  '--max-turns', '30', '-n', 'conductor research <ask-id>',
  ...model,
  '--json-schema', '<schema>',
];
const CURSOR_ASK = ['-p', '--mode', 'ask', '--trust', '--output-format', 'stream-json', '--workspace', '<cwd>'];
const CURSOR_BUILD = ['-p', '--force', '--trust', '--output-format', 'stream-json', '--workspace', '<cwd>'];
const codexExec = (model: string[]): string[] => [
  'exec', '--json', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', '--ephemeral',
  '-c', 'approval_policy="never"',
  '-c', 'sandbox_workspace_write.network_access=false',
  '-c', 'shell_environment_policy.inherit="core"',
  '-c', 'shell_environment_policy.ignore_default_excludes=false',
  '-c', 'shell_environment_policy.exclude=["CODEX_*","*KEY*","*TOKEN*","*SECRET*","*PASSWORD*"]',
  ...model,
  '-o', '<out>', '-',
];
/** sha256 of JSON.stringify(buildCodexArgs({ outFile: '<out>' })) on 2026-10-21 — the canary binding's argv digest. */
const CODEX_DIGEST_LITERAL = 'c5390760181a53f4f01fd5b874437c2cb284f1985ef80f2e8d75856b70ed32ce';

// ───────────── recorders ─────────────
interface Rec { claude: string; cursor: string; codex: string; log: string }
function makeRecorders(root: string, fakeDir: string): Rec {
  const log = join(root, 'argv-calls.jsonl');
  const one = (who: string, target: string): string => {
    const f = join(root, `rec-${who}.mjs`);
    writeFileSync(f, [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      'const argv = process.argv.slice(2);',
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ who: ${JSON.stringify(who)}, argv }) + '\\n');`,
      `const r = spawnSync(process.execPath, [${JSON.stringify(target)}, ...argv], { stdio: 'inherit', env: { ...process.env, FAKE_DIR: ${JSON.stringify(fakeDir)} } });`,
      'process.exit(r.status ?? 1);',
      '',
    ].join('\n'));
    chmodSync(f, 0o755);
    return f;
  };
  return { claude: one('claude', FAKE_CLAUDE), cursor: one('cursor', FAKE_AGENT), codex: one('codex', FAKE_CODEX), log };
}

/** Stage calls only (not --version / auth status / login status), with the four run-dependent values normalised. */
function stageCalls(log: string): { who: string; argv: string[] }[] {
  if (!existsSync(log)) return [];
  const all = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { who: string; argv: string[] });
  return all
    .filter((c) => (c.who === 'codex' ? c.argv[0] === 'exec' : c.argv[0] === '-p'))
    .map((c) => {
      const a = [...c.argv];
      for (let i = 0; i < a.length - 1; i++) {
        if (a[i] === '--workspace') a[i + 1] = '<cwd>';
        else if (c.who === 'codex' && a[i] === '-o') a[i + 1] = '<out>';
        else if (a[i] === '--json-schema') {
          JSON.parse(a[i + 1]!); // a real JSON schema was passed
          a[i + 1] = '<schema>';
        } else if (a[i] === '-n' && /^conductor research /.test(a[i + 1]!)) a[i + 1] = 'conductor research <ask-id>';
      }
      return { who: c.who, argv: a };
    });
}

type Scenario = 'defaults' | 'v5-no-models' | 'v5-migrated-models';
const MODELS: Record<Scenario, { claude: string[]; codex: string[] }> = {
  defaults: { claude: [], codex: [] },
  'v5-no-models': { claude: [], codex: [] },
  'v5-migrated-models': { claude: ['--model', 'opus'], codex: ['--model=gpt-5.1-codex'] },
};

/** Read-only roles used by the direct calls: requirements → Cursor (ask), architecture → Codex (exec). Not used by the pipeline. */
const EXTRA_ROLES = { requirements: { providers: ['cursor'] }, architecture: { providers: ['codex'] } };

function configure(cfg: Config, scenario: Scenario): void {
  const root = dirname(cfg.worktreeRoot!);
  const rec = makeRecorders(root, join(root, 'fake'));
  if (scenario === 'defaults') {
    cfg.agents.claude.bin = rec.claude;
    cfg.agents.cursor.bin = rec.cursor;
    cfg.agents.codex.bin = rec.codex;
    Object.assign(cfg.roles, JSON.parse(JSON.stringify(EXTRA_ROLES)));
    return;
  }
  // a v5 config.json on disk, read back through the versioned loader (after M8-2: through the v5 → v6 migration)
  const v5 = {
    version: 5,
    repos: cfg.repos,
    worktreeRoot: cfg.worktreeRoot,
    agents: {
      claude: { bin: rec.claude, isolation: 'safe-mode', maxTurns: { plan: 40, review: 25, verify: 40 }, ...(scenario === 'v5-migrated-models' ? { model: 'opus' } : {}) },
      cursor: { bin: rec.cursor },
      codex: { bin: rec.codex, ...(scenario === 'v5-migrated-models' ? { model: 'gpt-5.1-codex' } : {}) },
    },
    roles: EXTRA_ROLES,
    pipeline: { planApproval: 'auto', planReview: 'off', timeoutsMin: { plan: 2, review: 2, build: 2, verify: 2, idle: 1, gate: 2 } },
    projects: {},
  };
  writeFileSync(paths.config(), JSON.stringify(v5, null, 2) + '\n', { mode: 0o600 });
  const loaded = loadConfig();
  for (const k of Object.keys(cfg)) delete (cfg as unknown as Record<string, unknown>)[k];
  Object.assign(cfg, loaded);
}

async function runEveryPath(h: Harness): Promise<void> {
  const noop = () => undefined;
  // 1. the real pipeline: plan (Claude) → build (Cursor, through runBuild) → verify (Claude)
  const key = h.issue('Golden argv');
  await h.settle();
  assert.equal(h.run(key).status, 'ready', JSON.stringify(h.run(key).history.map((x) => x.text)));

  // 2. Agents.readOnly — plan_review on Claude, ask on Cursor, exec on Codex
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } } as any;
  const rev = await h.agents.readOnly({ role: 'planning', stage: 'plan_review', cwd: h.repoDir, prompt: '# Stage: PLAN_REVIEW\nIssue key: GLD-1\nTitle: golden', schema, name: 'conductor golden review', onEvent: noop, states: h.engine.routeStates(), rule: 'switch' });
  assert.equal(rev.agent, 'claude');
  const ask = await h.agents.readOnly({ role: 'requirements', stage: 'plan', cwd: h.repoDir, prompt: '# Stage: PLAN\nIssue key: GLD-2\nTitle: golden', schema, name: 'conductor golden ask', onEvent: noop, states: h.engine.routeStates(), rule: 'switch' });
  assert.equal(ask.agent, 'cursor');
  prepareCodexHome();
  writeFileSync(join(codexHomePath(), 'auth.json'), '{}', { mode: 0o600 });
  const cx = await h.agents.readOnly({ role: 'architecture', stage: 'verify', cwd: h.repoDir, prompt: '# Stage: VERIFY\nIssue key: GLD-3\nTitle: golden', schema, name: 'conductor golden codex', onEvent: noop, states: h.engine.routeStates(), rule: 'switch' });
  assert.equal(cx.agent, 'codex');

  // 3. Deep Research through the asks service
  const asks = new AskService({ getConfig: () => h.cfg, agents: h.agents, routeStates: () => h.engine.routeStates(), freshHealth: () => h.engine.freshHealth(), cards: { create: () => ({ key: 'X-1' }) } } as any);
  const rec = await asks.startResearch({ question: 'Compare SQLite and Postgres for a local app', repo: 'demo' });
  await asks.idle();
  assert.equal(asks.get(rec.id)!.status, 'done');

  // 4. doctor probes + provider selfTest canaries — with a throw-away HOME (the isolation probe reads ~/.claude)
  const realHome = process.env.HOME;
  const fakeHome = mkdtempSync(join(tmpdir(), 'cond-golden-home-'));
  process.env.HOME = fakeHome;
  try {
    await isolationProbe(h.cfg);
    await probe(h.cfg, 'claude');
    await probe(h.cfg, 'cursor');
    await h.agents.provider('claude').selfTest(h.cfg, 'canary');
    await h.agents.provider('cursor').selfTest(h.cfg, 'canary');
  } finally {
    process.env.HOME = realHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

function expectedCalls(scenario: Scenario): { who: string; argv: string[] }[] {
  const m = MODELS[scenario];
  return [
    { who: 'claude', argv: claudeReadOnly('40', 'conductor ENG-1 plan', m.claude, true) },
    { who: 'cursor', argv: CURSOR_BUILD },
    { who: 'claude', argv: claudeReadOnly('40', 'conductor ENG-1 verify', m.claude, true) },
    { who: 'claude', argv: claudeReadOnly('25', 'conductor golden review', m.claude, true) },
    { who: 'cursor', argv: CURSOR_ASK }, // Agents.readOnly (requirements → Cursor)
    { who: 'codex', argv: codexExec(m.codex) },
    { who: 'claude', argv: claudeResearch(m.claude) },
    { who: 'claude', argv: claudeReadOnly('3', 'conductor isolation probe', m.claude, false) },
    { who: 'claude', argv: claudeReadOnly('3', 'conductor probe', m.claude, true) }, // doctor probe
    { who: 'cursor', argv: CURSOR_ASK }, // doctor probe
    { who: 'claude', argv: claudeReadOnly('40', 'conductor probe', m.claude, true) }, // selfTest canary
    { who: 'cursor', argv: CURSOR_ASK }, // selfTest canary
  ];
}

const sortKey = (c: { who: string; argv: string[] }) => JSON.stringify([c.who, c.argv]);

for (const scenario of ['defaults', 'v5-no-models', 'v5-migrated-models'] as const) {
  test(`end-to-end argv golden (${scenario}): what each CLI receives on every path equals today's literals`, async () => {
    const h = await makeHarness({ config: (cfg) => configure(cfg, scenario) });
    try {
      const log = join(h.root, 'argv-calls.jsonl');
      await runEveryPath(h);
      const actual = stageCalls(log);
      const expected = expectedCalls(scenario);
      // every expected call happened, exactly as pinned
      for (const e of expected) assert.ok(actual.some((a) => sortKey(a) === sortKey(e)), `missing or changed argv (${scenario}):\n${JSON.stringify(e)}\n--- actual ---\n${actual.map((a) => JSON.stringify(a)).join('\n')}`);
      // and nothing else was spawned: every recorded stage call is one of the pinned shapes (a retry or an extra context call may repeat one)
      const allowed = new Set(expected.map(sortKey));
      for (const a of actual) assert.ok(allowed.has(sortKey(a)), `unexpected argv (${scenario}): ${JSON.stringify(a)}`);
      // no model/effort element appears unless the scenario sets one
      const flat = actual.flatMap((a) => a.argv);
      assert.ok(!flat.includes('--effort') && !flat.some((x) => x.includes('model_reasoning_effort')), 'no effort flag is ever sent today');
      if (scenario !== 'v5-migrated-models') assert.ok(!flat.some((x) => x === '--model' || x.startsWith('--model=')), 'no model flag with no model configured');
    } finally {
      await h.cleanup();
    }
  });
}

test('CODEX_ARGV_DIGEST is pinned to a literal (the canary binding never moves with a model/effort choice)', () => {
  assert.equal(CODEX_ARGV_DIGEST(), CODEX_DIGEST_LITERAL);
});
