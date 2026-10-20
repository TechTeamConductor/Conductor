import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { loadVersioned, saveVersioned, quarantine, _resetBackupMemory, type VersionSpec } from '../../src/schema/version.ts';
import { backupPaths, backupRoot } from '../../src/schema/backup.ts';
import { CorruptFileError, NewerVersionError } from '../../src/schema/errors.ts';
import { loadConfig, saveConfig, loadState, saveState, normalizeConfig, defaultConfig } from '../../src/config.ts';
import { RunStore, RUN_SCHEMA_VERSION } from '../../src/store.ts';
import { conductorHome, paths } from '../../src/paths.ts';
import { sha256 } from '../../src/util.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'real-shape-v1');
let home = '';
let backups = '';
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cond-schema-home-'));
  backups = mkdtempSync(join(tmpdir(), 'cond-schema-bk-'));
  process.env.CONDUCTOR_HOME = home;
  process.env.CONDUCTOR_BACKUP_DIR = backups; // tests must never write to the user's real backup directory
  _resetBackupMemory();
});

const spec = (current: number, migrations: VersionSpec['migrations'] = {}): VersionSpec => ({ kind: 'thing', field: 'schemaVersion', current, assumeWhenMissing: 1, migrations });

test('loadVersioned: missing file ⇒ fallback; missing stamp ⇒ assumed version; newer ⇒ refused; corrupt ⇒ CorruptFileError', () => {
  const f = join(home, 'a.json');
  assert.deepEqual(loadVersioned(f, spec(1), () => ({ x: 1 })), { data: { x: 1 }, fromVersion: 1, migrated: false, existed: false });
  writeFileSync(f, JSON.stringify({ a: 1 }));
  const l = loadVersioned(f, spec(1), () => ({}));
  assert.equal(l.fromVersion, 1);
  assert.equal(l.existed, true);
  writeFileSync(f, JSON.stringify({ a: 1, schemaVersion: 3 }));
  assert.throws(() => loadVersioned(f, spec(2), () => ({})), (e: any) => e instanceof NewerVersionError && e.found === 3 && e.supported === 2 && /newer Conductor/.test(e.message));
  writeFileSync(f, '{not json');
  assert.throws(() => loadVersioned(f, spec(1), () => ({})), CorruptFileError);
  writeFileSync(f, '[1,2]');
  assert.throws(() => loadVersioned(f, spec(1), () => ({})), /expected a JSON object/);
});

test('migrations run in order, in memory; saveVersioned stamps the version and backs up the ORIGINAL once before the first write', () => {
  const f = join(home, 'm.json');
  writeFileSync(f, JSON.stringify({ n: 1 }));
  const s = spec(3, { 1: (d) => ({ ...d, n: d.n + 1, via: 'v2' }), 2: (d) => ({ ...d, n: d.n * 10, via: `${d.via}>v3` }) });
  const l = loadVersioned<any>(f, s, () => ({}));
  assert.deepEqual([l.data.n, l.data.via, l.migrated, l.fromVersion], [20, 'v2>v3', true, 1]);
  assert.equal(readFileSync(f, 'utf8'), JSON.stringify({ n: 1 }), 'loading never writes');
  saveVersioned(f, l.data, s, { migratedFrom: l });
  saveVersioned(f, l.data, s, { migratedFrom: l });
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).schemaVersion, 3);
  const dirs = readdirSync(backups);
  assert.equal(dirs.length, 1, 'exactly one backup for two saves');
  assert.equal(readFileSync(join(backups, dirs[0]!, 'm.json'), 'utf8'), JSON.stringify({ n: 1 }), 'the backup is the pre-migration original');
  const manifest = JSON.parse(readFileSync(join(backups, dirs[0]!, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files[0].sha256, sha256(JSON.stringify({ n: 1 })));
  // not migrated ⇒ no backup
  const g = join(home, 'g.json');
  saveVersioned(g, { a: 1 }, spec(1), {});
  assert.equal(readdirSync(backups).length, 1);
});

test('backupPaths copies files and folders with a manifest, skips missing sources, never collides', () => {
  const d = join(home, 'runs', 'X-1');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'run.json'), '{}');
  writeFileSync(join(home, 'config.json'), '{"version":1}');
  const t = () => 1_700_000_000_000;
  const a = backupPaths([join(home, 'config.json'), join(home, 'runs'), join(home, 'nope')], { now: t });
  const b = backupPaths([join(home, 'config.json')], { now: t });
  assert.notEqual(a.dir, b.dir);
  assert.ok(existsSync(join(a.dir, 'config.json')) && existsSync(join(a.dir, 'runs', 'X-1', 'run.json')));
  assert.equal(statSync(a.dir).mode & 0o777, 0o700);
  assert.equal(backupRoot(), backups);
  const prev = process.env.CONDUCTOR_BACKUP_DIR;
  delete process.env.CONDUCTOR_BACKUP_DIR;
  assert.equal(backupRoot(), join(homedir(), '.conductor-backups'), 'default root is outside every Conductor home');
  process.env.CONDUCTOR_BACKUP_DIR = prev;
});

test('default home is ~/.conductor-v2 (never the v1 data) and the board lives under it', () => {
  delete process.env.CONDUCTOR_HOME;
  assert.equal(conductorHome(), join(homedir(), '.conductor-v2'));
  assert.equal(paths.board(), join(homedir(), '.conductor-v2', 'board'));
  process.env.CONDUCTOR_HOME = home;
});

// ───────────── config (inert in M1a: version stays 2) ─────────────
test('config: a v1-shaped file loads, is upgraded in memory, original is backed up once before the first save, and unknown keys survive', () => {
  cpSync(join(FIX, 'config.json'), paths.config());
  const raw = JSON.parse(readFileSync(paths.config(), 'utf8'));
  raw.someFutureFeature = { enabled: true, n: [1, 2] };
  writeFileSync(paths.config(), JSON.stringify(raw));
  const cfg = loadConfig();
  assert.equal(cfg.version, 2);
  assert.equal(cfg.pipeline.planApproval, 'auto', 'v1 default upgraded');
  assert.equal(cfg.pipeline.onClaudeLimit, 'cursor');
  assert.deepEqual(cfg.extra, { someFutureFeature: { enabled: true, n: [1, 2] } });
  assert.equal(readdirSync(backups).length, 0, 'loading never writes or backs up');
  saveConfig(cfg);
  saveConfig(cfg);
  const saved = JSON.parse(readFileSync(paths.config(), 'utf8'));
  assert.deepEqual(saved.someFutureFeature, { enabled: true, n: [1, 2] }, 'unknown key preserved verbatim');
  assert.equal(saved.extra, undefined, 'extra is flattened back to top-level keys');
  assert.equal(saved.version, 2);
  const dirs = readdirSync(backups);
  assert.equal(dirs.length, 1, 'one pre-upgrade backup');
  assert.equal(JSON.parse(readFileSync(join(backups, dirs[0]!, 'config.json'), 'utf8')).version, 1, 'the backup is the v1 original');
  const again = loadConfig();
  assert.deepEqual(again.extra, cfg.extra, 'round trip is stable');
});

test('config: a file from a NEWER build is refused (and untouched); a corrupt file is kept aside and defaults are used', () => {
  writeFileSync(paths.config(), JSON.stringify({ version: 9, ui: { port: 1234 } }));
  assert.throws(() => loadConfig(), (e: any) => e instanceof NewerVersionError);
  assert.equal(JSON.parse(readFileSync(paths.config(), 'utf8')).version, 9, 'nothing was rewritten');
  writeFileSync(paths.config(), '{broken');
  const cfg = loadConfig();
  assert.deepEqual(cfg.ui, defaultConfig().ui);
  assert.ok(readdirSync(home).some((n) => n.startsWith('config.json.corrupt-')), 'the corrupt file was kept for forensics');
});

test('config: normalizeConfig still clamps hostile input and does not let __proto__ keys through as extras', () => {
  const c = normalizeConfig(JSON.parse('{"ui":{"port":99999999},"__proto__":{"polluted":1},"zzz":1}'));
  assert.equal(c.ui.port, 65535);
  assert.deepEqual(c.extra, { zzz: 1 });
  assert.equal(({} as any).polluted, undefined);
});

// ───────────── state.json & run.json ─────────────
test('state.json: stamped on write, legacy (unstamped) loads, newer refused, corrupt kept aside', () => {
  cpSync(join(FIX, 'state.json'), paths.state());
  assert.deepEqual(loadState(), { repos: { 'demo-app': { approvedPlans: 1 } } });
  saveState({ repos: { a: { approvedPlans: 2 } } });
  assert.equal(JSON.parse(readFileSync(paths.state(), 'utf8')).schemaVersion, 1);
  writeFileSync(paths.state(), JSON.stringify({ schemaVersion: 2, repos: {} }));
  assert.throws(() => loadState(), NewerVersionError);
  writeFileSync(paths.state(), 'nope');
  assert.deepEqual(loadState(), { repos: {} });
  assert.ok(readdirSync(home).some((n) => n.startsWith('state.json.corrupt-')));
});

test('run.json: stamped on create/update; a legacy unstamped run (real shape) loads; newer is refused; corrupt is quarantined', () => {
  cpSync(join(FIX, 'runs'), paths.runs(), { recursive: true });
  const store = new RunStore();
  const legacy = store.get('ENG-7')!;
  assert.equal(legacy.status, 'needs_human');
  assert.equal(legacy.schemaVersion, undefined, 'legacy files carry no stamp and are treated as version 1');
  store.update('ENG-7', (r) => void (r.title = 'edited'));
  assert.equal(JSON.parse(readFileSync(join(paths.run('ENG-7'), 'run.json'), 'utf8')).schemaVersion, RUN_SCHEMA_VERSION);
  // newer
  const f = join(paths.run('ENG-7'), 'run.json');
  const j = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...j, schemaVersion: 7 }));
  const fresh = new RunStore();
  assert.throws(() => fresh.get('ENG-7'), (e: any) => e instanceof NewerVersionError);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).schemaVersion, 7, 'not rewritten');
  // corrupt
  mkdirSync(paths.run('ENG-8'), { recursive: true });
  writeFileSync(join(paths.run('ENG-8'), 'run.json'), '{oops');
  assert.equal(new RunStore().get('ENG-8'), null);
  assert.ok(readdirSync(paths.run('ENG-8')).some((n) => n.startsWith('run.json.corrupt-')));
  void quarantine;
});
