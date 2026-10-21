// M8-2 AC6 config v5 → v6 (S4, §2g W3/W6, N7, B3b, R2-N3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_SPEC, defaultConfig, legacyModelNotices, loadConfig, migrateConfigV5ToV6, normalizeConfig, normalizeToolModels, saveConfig } from '../src/config.ts';
import { configureLog } from '../src/log.ts';
import { ensureHome, paths } from '../src/paths.ts';
import { loadVersioned } from '../src/schema/version.ts';
import { NewerVersionError } from '../src/schema/errors.ts';
import { normalizeRoles } from '../src/agents/roles.ts';
import { buildClaudeArgs } from '../src/agents/claude.ts';
import { buildCodexArgs } from '../src/agents/providers/codex.ts';
import { toolDefaultResolved } from '../src/models/select.ts';
import { migrate } from '../src/migrate.ts';

const SECRETISH = 'sk-ant-THIS-LOOKS-LIKE-A-KEY-1234567890';

function withLogs<T>(fn: () => T): { out: T; lines: string[] } {
  const lines: string[] = [];
  configureLog({ sink: (_l, line) => lines.push(line) });
  try {
    return { out: fn(), lines };
  } finally {
    configureLog({ sink: null });
  }
}
function freshHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'cond-v6-'));
  process.env.CONDUCTOR_HOME = join(root, 'home');
  ensureHome();
  return root;
}

test('v5→v6 moves models to toolModels (custom), invalid to legacy.v5', () => {
  const v5 = { version: 5, agents: { claude: { bin: 'claude', model: 'opus' }, cursor: { bin: 'agent', model: 'id[effort=high]' }, codex: { bin: 'codex', model: 'gpt-5.1-codex' } }, legacy: { v3: { stages: { plan: 'claude' } } } };
  const before = JSON.stringify(v5);
  const out = migrateConfigV5ToV6(v5);
  assert.equal(JSON.stringify(v5), before, 'pure: the input is not mutated');
  assert.deepEqual(out.toolModels, { claude: { model: 'opus', custom: true }, codex: { model: 'gpt-5.1-codex', custom: true } });
  assert.deepEqual(out.legacy, { v3: { stages: { plan: 'claude' } }, v5: { agentsModel: { cursor: 'id[effort=high]' } } });
  for (const t of ['claude', 'cursor', 'codex']) assert.equal(Object.hasOwn(out.agents[t], 'model'), false, t);
  assert.equal(out.agents.claude.bin, 'claude', 'everything else is kept');
  assert.deepEqual(migrateConfigV5ToV6({ version: 5 }).toolModels, {}, 'nothing to move ⇒ an empty toolModels');
  assert.equal(CONFIG_SPEC.current, 7); // M8-3 took v7
  assert.equal(CONFIG_SPEC.migrations?.[5], migrateConfigV5ToV6);
  assert.equal(defaultConfig().version, 7);
  assert.deepEqual(defaultConfig().toolModels, {});
});

test('Claude opus[1m] kept; Codex x[1m] and Cursor id[effort=high] go to legacy with a notice (§2g)', () => {
  const cfg = normalizeConfig(migrateConfigV5ToV6({ version: 5, agents: { claude: { model: 'sonnet[1m]' }, codex: { model: 'x[1m]' }, cursor: { model: 'id[effort=high]' } } }));
  assert.deepEqual(cfg.toolModels, { claude: { model: 'sonnet[1m]', custom: true } });
  assert.deepEqual((cfg.legacy as any).v5.agentsModel, { codex: 'x[1m]', cursor: 'id[effort=high]' });
  const notices = legacyModelNotices(cfg);
  assert.deepEqual(notices.map((n) => n.tool), ['cursor', 'codex']);
  for (const n of notices) {
    assert.doesNotMatch(n.message, /x\[1m\]|effort=high|\[/, 'never the old value');
    assert.match(n.message, /Default model for each tool/);
  }
  // the kept Claude value gives today's argv
  const s = toolDefaultResolved(cfg, 'claude');
  assert.deepEqual(buildClaudeArgs({ maxTurns: 3, isolation: 'safe-mode', name: 'n', model: s.modelArg, effort: s.effortArg }).slice(-2), ['--model', 'sonnet[1m]']);
  // once a default is chosen, the notice for that tool stops (the legacy record itself is never pruned — R2-N2)
  cfg.toolModels.cursor = { model: 'gpt-5.2' };
  const again = normalizeConfig(cfg);
  assert.deepEqual(legacyModelNotices(again).map((n) => n.tool), ['codex']);
  assert.deepEqual((again.legacy as any).v5.agentsModel, { codex: 'x[1m]', cursor: 'id[effort=high]' });
});

test('Codex x[1m] refused at load/save with a human message, never in argv (W6)', () => {
  const root = freshHome();
  void root;
  writeFileSync(paths.config(), JSON.stringify({ version: 5, agents: { codex: { bin: 'codex', model: 'x[1m]' } } }));
  const { out: cfg, lines } = withLogs(() => loadConfig());
  assert.equal(cfg.toolModels.codex, undefined);
  assert.ok(lines.some((l) => l.includes('agents.codex.model was not a valid model id; kept in legacy.v5, not used')), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('x[1m]')), 'the log never shows the value');
  assert.match(legacyModelNotices(cfg)[0]!.message, /Codex model setting was not kept/);
  const s = toolDefaultResolved(cfg, 'codex');
  assert.ok(!buildCodexArgs({ outFile: '/o', model: s.modelArg, effort: s.effortArg }).some((x) => x.includes('x[1m]') || x.startsWith('--model')));
  saveConfig(cfg);
  const disk = JSON.parse(readFileSync(paths.config(), 'utf8'));
  assert.equal(disk.version, 7);
  assert.deepEqual(disk.legacy.v5.agentsModel, { codex: 'x[1m]' });
  assert.equal(disk.agents.codex.model, undefined);
  // a hand edit putting it straight into toolModels is refused at load too
  writeFileSync(paths.config(), JSON.stringify({ ...disk, toolModels: { codex: { model: 'x[1m]', custom: true } } }));
  assert.equal(loadConfig().toolModels.codex, undefined);
});

test('invalid legacy model: warning has tool+reason only, never the value (S4a)', () => {
  const { out, lines } = withLogs(() => normalizeConfig({ agents: { cursor: { model: `${SECRETISH} --yolo` }, claude: { model: { nested: SECRETISH } } } }));
  assert.equal(out.toolModels.cursor, undefined);
  const joined = lines.join('\n');
  assert.ok(!joined.includes('THIS-LOOKS'), 'not the value');
  assert.ok(!/\b(4[0-9]|5[0-9])\b/.test(joined.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '')), 'not its length');
  assert.ok(!joined.includes('sk-'), 'not a prefix');
  assert.match(joined, /agents\.cursor\.model was not a valid model id; kept in legacy\.v5, not used/);
  assert.match(joined, /agents\.claude\.model was not a valid model id/);
});

test('toolModels wins over agents.*.model (S4b, N7)', () => {
  const { out, lines } = withLogs(() => normalizeConfig({ version: 6, toolModels: { claude: { model: 'sonnet', custom: true } }, agents: { claude: { model: 'opus' }, cursor: { model: 'gpt-5.2' } } }));
  assert.deepEqual(out.toolModels, { claude: { model: 'sonnet', custom: true } });
  assert.deepEqual((out.legacy as any).v5.agentsModel, { claude: 'opus', cursor: 'gpt-5.2' }, 'the stray keys move aside and are never read');
  assert.ok(lines.some((l) => /agents\.claude\.model was ignored because toolModels is set/.test(l)));
  assert.deepEqual(legacyModelNotices(out).map((n) => n.tool), ['cursor'], 'a notice only while that tool has no default');
  assert.equal(toolDefaultResolved(out, 'claude').modelArg, 'sonnet');
});

test('toolModels normalised field by field (__proto__ inert) (S4d)', () => {
  const raw = JSON.parse('{"__proto__":{"model":"opus"},"claude":{"model":"opus","custom":true,"extra":"x","__proto__":{"polluted":1}},"cursor":{"model":"--yolo"},"codex":{"model":"gpt-5","custom":"yes"},"CLAUDE":{"model":"opus"},"bogus":1}');
  const reports: string[] = [];
  const tm = normalizeToolModels(raw, (m) => reports.push(m));
  assert.deepEqual(tm, { claude: { model: 'opus', custom: true }, codex: { model: 'gpt-5' } });
  assert.equal(Object.getPrototypeOf(tm), Object.prototype);
  assert.equal(({} as any).polluted, undefined);
  assert.equal(Object.hasOwn(tm.claude!, 'extra'), false, 'built from literals, never spread');
  assert.ok(reports.some((r) => /toolModels\.cursor: dropped/.test(r)));
  assert.ok(!reports.join(' ').includes('--yolo'));
  assert.deepEqual(normalizeToolModels('nope'), {});
});

test('hand-edited bad model dropped and reported at load; tool missing ⇒ fields dropped (B2, R2-N3)', () => {
  const reports: string[] = [];
  const roles = normalizeRoles({
    planning: { providers: ['claude'], tool: 'claude', model: '--yolo', effort: 'high' },
    review: { providers: ['claude'], model: 'opus', fast: true, effort: 'low' },
    verification: { providers: ['claude'], tool: 'cursor', model: 'gpt-5.2', custom: true },
    context: { providers: ['claude'], tool: 'claude', model: 'opus', custom: 'yes', effort: 'turbo' },
  }, (m) => reports.push(m));
  assert.deepEqual({ ...roles.planning }, { providers: ['claude'], effort: 'high' }, 'bad model dropped, effort kept');
  assert.deepEqual({ ...roles.review }, { providers: ['claude'], effort: 'low' }, 'no tool ⇒ model fields dropped, effort kept');
  assert.deepEqual({ ...roles.verification }, { providers: ['claude'], tool: 'cursor', model: 'gpt-5.2', custom: true }, 'tool ≠ head is kept (inert until that tool leads)');
  assert.deepEqual({ ...roles.context }, { providers: ['claude'], tool: 'claude', model: 'opus' }, 'custom counts only when === true; unknown effort dropped');
  assert.ok(reports.some((r) => /planning: dropped the model \(not a valid claude model id\)/.test(r)));
  assert.ok(reports.some((r) => /review: dropped the model choice/.test(r)));
  assert.ok(reports.some((r) => /context: dropped the effort/.test(r)));
  assert.ok(!reports.join(' ').includes('--yolo'), 'reports never carry the value');
  // R2-N3 hostile tool values
  for (const tool of ['__proto__', 'CLAUDE', 'cursor ', '--yolo', 42, {}, null]) {
    const r: string[] = [];
    const out = normalizeRoles({ planning: { providers: ['claude'], tool, model: 'opus', thinking: true } }, (m) => r.push(m));
    assert.deepEqual({ ...out.planning }, { providers: ['claude'] }, JSON.stringify(tool));
    assert.ok(r.some((m) => /dropped the model choice/.test(m)), JSON.stringify(tool));
  }
});

test('load+save round trip keeps a pre-upgrade backup (AC6)', () => {
  const root = freshHome();
  const backups = join(root, 'backups');
  const prev = process.env.CONDUCTOR_BACKUP_DIR;
  process.env.CONDUCTOR_BACKUP_DIR = backups;
  const v5 = { version: 5, agents: { claude: { bin: 'claude', model: 'opus' } }, roles: { planning: { providers: ['claude'] } } };
  writeFileSync(paths.config(), JSON.stringify(v5));
  const cfg = loadConfig();
  assert.deepEqual(cfg.toolModels, { claude: { model: 'opus', custom: true } });
  saveConfig(cfg);
  const disk = JSON.parse(readFileSync(paths.config(), 'utf8'));
  assert.equal(disk.version, 7);
  assert.deepEqual(disk.toolModels, { claude: { model: 'opus', custom: true } });
  assert.equal(disk.agents.claude.model, undefined);
  if (prev === undefined) delete process.env.CONDUCTOR_BACKUP_DIR;
  else process.env.CONDUCTOR_BACKUP_DIR = prev;
  assert.ok(existsSync(backups), 'a backup folder exists');
  const dirs = readdirSync(backups);
  assert.equal(dirs.length, 1, 'one pre-upgrade backup');
  assert.equal(JSON.parse(readFileSync(join(backups, dirs[0]!, 'config.json'), 'utf8')).version, 5, 'the backup is the v5 original');
});

test('normalizeConfig idempotent', () => {
  const inputs = [
    { agents: { claude: { model: 'opus' }, cursor: { model: 'bad[x]' } } },
    { version: 6, toolModels: { cursor: { model: 'gpt-5.2' } }, roles: { planning: { providers: ['cursor'], tool: 'cursor', model: 'gpt-5.3-codex', effort: 'high', fast: true } } },
    defaultConfig(),
  ];
  for (const i of inputs) {
    const once = normalizeConfig(i);
    const twice = normalizeConfig(JSON.parse(JSON.stringify(once)));
    assert.deepEqual(JSON.parse(JSON.stringify(twice)), JSON.parse(JSON.stringify(once)));
  }
});

test('a v6 file is refused by a v5 build (NewerVersionError)', () => {
  freshHome();
  writeFileSync(paths.config(), JSON.stringify({ version: 6, toolModels: {} }));
  assert.throws(() => loadVersioned(paths.config(), { ...CONFIG_SPEC, current: 5 }, () => ({})), NewerVersionError);
});

test('migrate.ts imports a v5 home as v6', async () => {
  const from = mkdtempSync(join(tmpdir(), 'cond-v6-from-'));
  const FIX = join(import.meta.dirname, 'fixtures', 'real-shape-v1');
  const raw = JSON.parse(readFileSync(join(FIX, 'config.json'), 'utf8'));
  raw.version = 5;
  raw.agents = { ...(raw.agents ?? {}), claude: { ...(raw.agents?.claude ?? {}), model: 'opus' }, cursor: { ...(raw.agents?.cursor ?? {}), model: 'id[effort=high]' } };
  writeFileSync(join(from, 'config.json'), JSON.stringify(raw));
  cpSync(join(FIX, 'state.json'), join(from, 'state.json'));
  mkdirSync(join(from, 'runs'));
  const to = join(mkdtempSync(join(tmpdir(), 'cond-v6-to-')), 'v2');
  const r = await migrate({ from, to, apply: true, backupRoot: mkdtempSync(join(tmpdir(), 'cond-v6-bk-')) });
  assert.equal(r.published, true);
  const cfg = JSON.parse(readFileSync(join(to, 'config.json'), 'utf8'));
  assert.equal(cfg.version, 7);
  assert.deepEqual(cfg.toolModels.claude, { model: 'opus', custom: true });
  assert.equal(cfg.toolModels.cursor, undefined);
  assert.deepEqual(cfg.legacy.v5.agentsModel, { cursor: 'id[effort=high]' });
});
