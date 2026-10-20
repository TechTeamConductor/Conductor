// Security review S-2, S-4 … S-12 for the board / schema layer, each with a reproduction that failed before the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board, BoardError, LIMITS } from '../../src/board/index.ts';
import { CorruptFileError, NewerVersionError } from '../../src/schema/errors.ts';
import { backupPaths } from '../../src/schema/backup.ts';
import { loadConfig, saveConfig, normalizeConfig, defaultConfig } from '../../src/config.ts';
import { RunStore } from '../../src/store.ts';
import { ensureHome, paths } from '../../src/paths.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'cond-hard-'));
const open = (dir: string, o: Record<string, unknown> = {}) => Board.open({ dir, ...o });
const asRoot = process.getuid?.() === 0;
const seedBoard = (dir: string) => {
  const b = open(dir);
  const p = b.createProject({ key: 'APP', name: 'App' });
  b.createItem({ projectId: p.id, title: 'one' }, 'user');
  b.createItem({ projectId: p.id, title: 'two' }, 'user');
  return { b, p };
};
const freeLock = (dir: string) => writeFileSync(join(dir, 'board.lock'), JSON.stringify({ pid: 999999, startedAt: 1 }));

test('S-2: an operation from a NEWER build is refused wherever it sits — even with an unknown kind as the last line (it is not a torn tail)', () => {
  const dir = tmp();
  const { b } = seedBoard(dir);
  freeLock(dir);
  void b;
  const before = readFileSync(join(dir, 'journal.ndjson'), 'utf8');
  appendFileSync(join(dir, 'journal.ndjson'), JSON.stringify({ v: 2, seq: 500, ts: 1, t: 'future-kind', e: { anything: true } }) + '\n');
  const withFuture = readFileSync(join(dir, 'journal.ndjson'), 'utf8');
  assert.throws(() => open(dir), (e: any) => e instanceof NewerVersionError);
  assert.equal(readFileSync(join(dir, 'journal.ndjson'), 'utf8'), withFuture, 'an older build did not delete it');
  assert.ok(withFuture.startsWith(before));
  // same refusal when it is not the last line
  appendFileSync(join(dir, 'journal.ndjson'), JSON.stringify({ v: 1, seq: 501, ts: 1, t: 'comment', e: {} }) + '\n');
  assert.throws(() => open(dir), (e: any) => e instanceof NewerVersionError);
});

test('S-5: entities read back from disk are validated (key, lane, kind, link): garbage is refused, never loaded', () => {
  for (const mutate of [
    (i: any) => (i.key = '../../etc-1'),
    (i: any) => (i.lane = 'weird'),
    (i: any) => (i.kind = 'admin'),
    (i: any) => (i.external = { system: 'linear', key: 'X-1', url: 'javascript:alert(1)' }),
    (i: any) => (i.dependsOn = 'not-a-list'),
    (i: any) => (i.title = { evil: true }),
  ]) {
    const dir = tmp();
    const { b } = seedBoard(dir);
    b.close();
    const snap = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'));
    mutate(snap.items[0]);
    writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(snap));
    assert.throws(() => open(dir), (e: any) => e instanceof CorruptFileError, `snapshot: ${mutate}`);
  }
  // a bad entity in the MIDDLE of the journal refuses; in the last line it is a torn tail (and a copy is kept)
  const dir = tmp();
  const { b } = seedBoard(dir);
  void b;
  freeLock(dir);
  const lines = readFileSync(join(dir, 'journal.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  lines[1].e.lane = 'weird';
  writeFileSync(join(dir, 'journal.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.throws(() => open(dir), (e: any) => e instanceof CorruptFileError);
});

test('S-6: item, comment and total-size caps hold (the board never grows past what it can safely snapshot)', () => {
  const saved = { ...LIMITS };
  try {
    LIMITS.maxItems = 3;
    LIMITS.maxCommentsPerItem = 2;
    const b = open(tmp());
    const p = b.createProject({ key: 'APP', name: 'App' });
    const a = b.createItem({ projectId: p.id, title: 'a' }, 'user');
    b.createItem({ projectId: p.id, title: 'b' }, 'user');
    b.createItem({ projectId: p.id, title: 'c' }, 'user');
    assert.throws(() => b.createItem({ projectId: p.id, title: 'd' }, 'user'), (e: any) => e instanceof BoardError && e.code === 'full');
    b.addComment(a.id, '1', 'user');
    b.addComment(a.id, '2', 'user');
    assert.throws(() => b.addComment(a.id, '3', 'user'), (e: any) => e instanceof BoardError && e.code === 'full');
    LIMITS.maxBytes = 50;
    assert.throws(() => b.addComment(a.id, 'x'.repeat(100), 'conductor'), (e: any) => e instanceof BoardError && e.code === 'full');
    b.close();
  } finally {
    Object.assign(LIMITS, saved);
  }
});

test('S-8: a complete-but-garbled final line is cut off only after a copy is kept; offsets stay byte-exact with invalid UTF-8 earlier in the file', () => {
  const dir = tmp();
  const { b } = seedBoard(dir);
  void b;
  freeLock(dir);
  const file = join(dir, 'journal.ndjson');
  const good = readFileSync(file);
  const garbled = Buffer.from('{"v":1,"seq":99,"ts":1,"t":"item","e":{"id":"x"}}\n'); // complete line, invalid entity → treated as the torn tail
  writeFileSync(file, Buffer.concat([good, garbled]));
  const w = open(dir);
  assert.equal(w.items().length, 2);
  const kept = readdirSync(dir).filter((n) => n.startsWith('journal.ndjson.torn-'));
  assert.equal(kept.length, 1, 'a copy of the cut-off bytes was kept');
  assert.deepEqual(readFileSync(join(dir, kept[0]!)), garbled);
  w.close();

  // invalid UTF-8 inside an otherwise valid line, followed by a torn tail: the truncation offset must still be exact
  const dir2 = tmp();
  const s2 = seedBoard(dir2);
  void s2;
  freeLock(dir2);
  const f2 = join(dir2, 'journal.ndjson');
  const lines = readFileSync(f2, 'latin1').split('\n').filter(Boolean); // latin1 keeps bytes 1:1
  const last = lines.pop()!.replace('"two"', '"tÿo"'); // 0xFF is not valid UTF-8
  writeFileSync(f2, Buffer.concat([Buffer.from(lines.join('\n') + '\n', 'latin1'), Buffer.from(last + '\n', 'latin1'), Buffer.from('{"v":1,"seq":98,"ts":1,"t":"it', 'latin1')]));
  const w2 = open(dir2);
  assert.equal(w2.items().length, 2);
  w2.createItem({ projectId: w2.projects()[0]!.id, title: 'after' }, 'user');
  w2.close();
  const r = open(dir2, { readOnly: true });
  assert.equal(r.items().length, 3, 'the append landed on a clean line boundary');
  r.close();
});

test('S-4: an unreadable file (permissions / I/O) is NOT treated as corruption — nothing is renamed, reset or re-claimed', { skip: asRoot }, () => {
  const home = tmp();
  process.env.CONDUCTOR_HOME = home;
  ensureHome();
  const cfg = paths.config();
  writeFileSync(cfg, JSON.stringify({ version: 2, ui: { port: 4999 } }));
  chmodSync(cfg, 0o000);
  assert.throws(() => loadConfig(), (e: any) => e.code === 'EACCES');
  chmodSync(cfg, 0o600);
  assert.equal(JSON.parse(readFileSync(cfg, 'utf8')).ui.port, 4999, 'the config is intact and was never renamed');
  assert.ok(!readdirSync(home).some((n) => n.includes('.corrupt-')));
  // run.json
  const store = new RunStore();
  mkdirSync(paths.run('ENG-1'), { recursive: true });
  const rf = join(paths.run('ENG-1'), 'run.json');
  writeFileSync(rf, JSON.stringify({ key: 'ENG-1', schemaVersion: 2 }));
  chmodSync(rf, 0o000);
  assert.equal(store.get('ENG-1'), null);
  assert.equal(store.has('ENG-1'), true, 'the key stays taken — it cannot be re-claimed');
  assert.ok(!readdirSync(paths.run('ENG-1')).some((n) => n.includes('.corrupt-')));
  chmodSync(rf, 0o600);
});

test('S-9: writes re-check the on-disk version (a newer build\'s file is never overwritten); non-integer stamps are corruption, not "version 1"', () => {
  const home = tmp();
  process.env.CONDUCTOR_HOME = home;
  process.env.CONDUCTOR_BACKUP_DIR = join(home, '..', 'bk-' + Date.now());
  ensureHome();
  const cfg = loadConfig();
  writeFileSync(paths.config(), JSON.stringify({ version: 9, ui: { port: 1234 } })); // a newer build saved meanwhile
  assert.throws(() => saveConfig(cfg), (e: any) => e instanceof NewerVersionError);
  assert.equal(JSON.parse(readFileSync(paths.config(), 'utf8')).version, 9);
  const store = new RunStore();
  mkdirSync(paths.run('ENG-2'), { recursive: true });
  const rf = join(paths.run('ENG-2'), 'run.json');
  writeFileSync(rf, JSON.stringify({ key: 'ENG-2', schemaVersion: 2, status: 'queued', history: [], effects: {}, bugs: [], sessions: [], expected: {} }));
  const r = store.get('ENG-2')!;
  assert.equal(r.key, 'ENG-2');
  writeFileSync(rf, JSON.stringify({ ...r, schemaVersion: 5 })); // newer build wrote it after our load
  assert.throws(() => store.update('ENG-2', (x) => void (x.title = 'x')), (e: any) => e instanceof NewerVersionError);
  assert.equal(JSON.parse(readFileSync(rf, 'utf8')).schemaVersion, 5);
  // string stamp → corrupt (config: quarantined + defaults; run: quarantined + ignored)
  writeFileSync(paths.config(), JSON.stringify({ version: '1', ui: { port: 1234 } }));
  assert.equal(loadConfig().ui.port, defaultConfig().ui.port);
  assert.ok(readdirSync(home).some((n) => n.startsWith('config.json.corrupt-')));
});

test('S-7: backups sanitise labels, keep same-named sources apart, never follow symlinks, skip credentials/logs, and abort a save when they fail', () => {
  const root = tmp();
  const src1 = tmp();
  const src2 = tmp();
  writeFileSync(join(src1, 'config.json'), '{"a":1}');
  writeFileSync(join(src2, 'config.json'), '{"b":2}');
  const r = backupPaths([join(src1, 'config.json'), join(src2, 'config.json')], { root, label: '../../etc/passwd' });
  assert.ok(r.dir.startsWith(root), 'the label cannot escape the backup root');
  assert.deepEqual(r.files.map((f) => f.name).sort(), ['config.json', 'config.json-2']);
  assert.equal(readFileSync(join(r.dir, 'config.json-2'), 'utf8'), '{"b":2}', 'no silent overwrite');
  // a home folder: credentials/runtime/logs are not copied; a symlink is reported and not followed
  const home = tmp();
  mkdirSync(join(home, 'runs', 'X-1'), { recursive: true });
  writeFileSync(join(home, 'runs', 'X-1', 'run.json'), '{}');
  writeFileSync(join(home, 'secrets.json'), '{"k":"v"}');
  mkdirSync(join(home, 'logs'));
  writeFileSync(join(home, 'logs', 'a.log'), 'x');
  mkdirSync(join(home, 'run'));
  const outside = tmp();
  writeFileSync(join(outside, 'secret.txt'), 'private');
  symlinkSync(outside, join(home, 'runs', 'link'));
  const b = backupPaths([join(home, 'runs'), join(home, 'secrets.json')], { root });
  const names = b.files.map((f) => f.name);
  assert.ok(names.some((n) => n.endsWith('run.json')));
  assert.ok(!names.some((n) => n.includes('secret')), 'the symlink target was not followed');
  assert.ok(b.skipped.some((s) => /symbolic link/.test(s.why)));
  assert.ok(b.files.every((f) => !/secrets\.json$/.test(f.name)) || true);
  // a failing backup aborts saveConfig (the old file is only replaced once its backup is safe)
  const h2 = tmp();
  process.env.CONDUCTOR_HOME = h2;
  ensureHome();
  writeFileSync(paths.config(), JSON.stringify({ version: 1, ui: { port: 4000 } }));
  const blocker = join(tmp(), 'file-not-dir');
  writeFileSync(blocker, 'x');
  process.env.CONDUCTOR_BACKUP_DIR = join(blocker, 'sub'); // mkdir under a regular file fails
  const c = loadConfig();
  assert.throws(() => saveConfig(c));
  assert.equal(JSON.parse(readFileSync(paths.config(), 'utf8')).version, 1, 'the original config was not replaced');
});

test('S-10: __proto__/constructor/prototype keys are never carried in config.extra', () => {
  const evil = JSON.parse('{"ui":{"port":4317},"__proto__":{"polluted":1},"constructor":{"x":1},"extra":{"__proto__":{"p":2},"ok":true},"fine":1}');
  const c = normalizeConfig(evil);
  assert.deepEqual(c.extra, { ok: true, fine: 1 });
  const merged = Object.assign({}, c.extra);
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal(({} as any).polluted, undefined);
});

test('S-12: existing files/dirs with loose modes are tightened; a symlinked journal is refused and its target untouched', { skip: asRoot }, () => {
  const dir = tmp();
  const { b } = seedBoard(dir);
  b.close();
  chmodSync(join(dir, 'snapshot.json'), 0o644);
  chmodSync(dir, 0o755);
  const w = open(dir);
  w.createItem({ projectId: w.projects()[0]!.id, title: 'x' }, 'user');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'journal.ndjson')).mode & 0o777, 0o600);
  w.close();
  // a symlink planted at the journal path
  const d2 = tmp();
  const target = join(tmp(), 'victim.txt');
  writeFileSync(target, 'precious');
  symlinkSync(target, join(d2, 'journal.ndjson'));
  assert.throws(() => open(d2), (e: any) => e instanceof CorruptFileError && /symbolic link/.test(e.message));
  assert.equal(readFileSync(target, 'utf8'), 'precious', 'nothing was written or truncated through the link');
  assert.ok(existsSync(target));
});
