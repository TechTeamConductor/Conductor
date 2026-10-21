// AC5 (S12, S12a, C2, R2-3): the per-(provider, account) cache — 0700 dirs, path containment, no-follow read, size cap, version rule,
// newer files untouched, ≤ 3 quarantines, forged fetchedAt, provider/account cross-checks, families recomputed; a failed refresh keeps
// the list and marks it stale.
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_MAX_BYTES, CACHE_REASONS, cacheFile, readCache, writeCache } from '../../src/models/cache.ts';
import type { Catalog } from '../../src/models/types.ts';
import { paths } from '../../src/paths.ts';
import { securePrivateDir } from '../../src/models/workdir.ts';
import { buildService, modelHome } from './helpers.ts';

const h = modelHome();
after(() => h.cleanup());
beforeEach(() => rmSync(paths.models(), { recursive: true, force: true }));

const cat = (over: Partial<Catalog> = {}): Catalog => ({
  version: 1, provider: 'claude', account: 'default', source: 'claude-initialize', cliVersion: '2.1.304', fetchedAt: Date.now(), signedIn: true, plan: 'max',
  models: [{ id: 'opus', label: 'Opus', efforts: ['low', 'high'], isDefault: true }],
  ...over,
});
const write = (provider: string, account: string, data: unknown) => {
  mkdirSync(join(paths.models(), provider), { recursive: true, mode: 0o700 });
  writeFileSync(join(paths.models(), provider, `${account}.json`), typeof data === 'string' ? data : JSON.stringify(data));
};
const quarantined = (provider = 'claude') => readdirSync(join(paths.models(), provider)).filter((n) => n.includes('.corrupt-'));

test('round trip: per provider/account file, 0700 dirs, 0600 file, re-validated on read', () => {
  assert.equal(writeCache(cat()), 'written');
  assert.equal(statSync(paths.models()).mode & 0o777, 0o700);
  assert.equal(statSync(join(paths.models(), 'claude')).mode & 0o777, 0o700);
  assert.equal(statSync(cacheFile('claude', 'default')).mode & 0o777, 0o600);
  const r = readCache('claude', 'default', Date.now());
  assert.equal(r.kind, 'ok');
  assert.deepEqual(r.kind === 'ok' && r.catalog.models, cat().models);
  assert.equal(writeCache(cat({ provider: 'cursor', source: 'cursor-list-models', account: 'work-2' })), 'written');
  assert.ok(existsSync(join(paths.models(), 'cursor', 'work-2.json')));
});

test('path containment: provider enum and account regex only', () => {
  for (const a of ['../x', 'Default', '', 'a/b', '.hidden', 'x'.repeat(33)]) assert.throws(() => cacheFile('claude', a), a);
  assert.throws(() => cacheFile('evil' as any, 'default'));
  assert.equal(readCache('claude', '../../etc', Date.now()).kind, 'refused');
});

test('folders must be real, owned dirs; looser modes are tightened; a symlinked folder is refused', () => {
  mkdirSync(paths.models(), { mode: 0o755 });
  chmodSync(paths.models(), 0o755);
  assert.equal(writeCache(cat()), 'written');
  assert.equal(statSync(paths.models()).mode & 0o777, 0o700, 'tightened');
  rmSync(join(paths.models(), 'claude'), { recursive: true });
  const elsewhere = join(h.root, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  symlinkSync(elsewhere, join(paths.models(), 'claude'));
  assert.equal(readCache('claude', 'default', Date.now()).kind, 'refused');
  assert.equal(writeCache(cat()), 'refused');
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing written through the link');
});

test('a symlinked cache file is removed (the link only) and treated as no cache; its target survives untouched', () => {
  mkdirSync(join(paths.models(), 'claude'), { recursive: true, mode: 0o700 });
  const target = join(h.root, 'secret.txt');
  writeFileSync(target, 'TOP SECRET {"version":1}');
  symlinkSync(target, cacheFile('claude', 'default'));
  assert.equal(readCache('claude', 'default', Date.now()).kind, 'none');
  assert.equal(existsSync(cacheFile('claude', 'default')), false);
  assert.equal(readFileSync(target, 'utf8'), 'TOP SECRET {"version":1}');
});

test('non-regular file (a directory, a fifo-like) and > 4 MB are refused and set aside', () => {
  mkdirSync(cacheFile('claude', 'default'), { recursive: true });
  const r = readCache('claude', 'default', Date.now());
  assert.equal(r.kind, 'quarantined');
  rmSync(join(paths.models(), 'claude'), { recursive: true, force: true });
  write('claude', 'default', JSON.stringify({ ...cat(), pad: 'x'.repeat(CACHE_MAX_BYTES) }));
  assert.equal(readCache('claude', 'default', Date.now()).kind, 'quarantined');
  assert.equal(quarantined().length, 1);
});

test('C2/R2-3: a file without `version` is quarantined and never served (also version 0, "1", 1.5)', () => {
  for (const v of [undefined, 0, '1', 1.5]) {
    const { version, ...rest } = cat();
    void version;
    write('claude', 'default', v === undefined ? rest : { ...rest, version: v });
    assert.equal(readCache('claude', 'default', Date.now()).kind, 'quarantined', String(v));
  }
  const { version, ...noVersion } = cat();
  void version;
  write('claude', 'default', noVersion);
  const { svc } = buildService(h);
  assert.equal(svc.view('claude').state, 'unavailable', 'nothing is served');
  assert.equal(svc.view('claude').models, undefined);
  assert.equal(svc.view('claude').reason, CACHE_REASONS.unreadable);
});

test('≤ 3 quarantined copies are kept per file', async () => {
  for (let i = 0; i < 6; i++) {
    write('claude', 'default', '{not json');
    assert.equal(readCache('claude', 'default', Date.now()).kind, 'quarantined');
    await new Promise((r) => setTimeout(r, 3));
  }
  assert.equal(quarantined().length, 3);
});

test('a parse error never surfaces file text (the log line is static)', () => {
  write('claude', 'default', '{"version":1, SECRET_IN_FILE');
  const { logs, svc } = buildService(h);
  assert.equal(svc.view('claude').state, 'unavailable');
  assert.ok(logs.some((l) => l.includes(CACHE_REASONS.unreadable)));
  assert.ok(!logs.join('\n').includes('SECRET_IN_FILE'));
  assert.ok(!(svc.view('claude').reason ?? '').includes('SECRET'));
});

test('a NEWER file is neither quarantined nor overwritten; a fresh result stays in memory with a reason', async () => {
  write('claude', 'default', { ...cat(), version: 2, futureField: true });
  const before = readFileSync(cacheFile('claude', 'default'), 'utf8');
  assert.equal(readCache('claude', 'default', Date.now()).kind, 'newer');
  assert.equal(writeCache(cat()), 'newer');
  h.scenario({ models: 'in', lingerMs: 5000 });
  const { svc } = buildService(h);
  const v = await svc.refresh('claude');
  assert.equal(v.state, 'fresh');
  assert.equal(v.models!.length, 13);
  assert.equal(v.reason, CACHE_REASONS.newer);
  assert.equal(readFileSync(cacheFile('claude', 'default'), 'utf8'), before, 'untouched');
  assert.equal(quarantined().length, 0);
});

test('S12a: provider/account must match the path; source enum; fetchedAt finite integer', () => {
  for (const bad of [{ provider: 'cursor' }, { account: 'other' }, { source: 'made-up' }, { fetchedAt: 'yesterday' }, { fetchedAt: 1.5 }, { models: 'x' }]) {
    write('claude', 'default', { ...cat(), ...bad });
    assert.equal(readCache('claude', 'default', Date.now()).kind, 'quarantined', JSON.stringify(bad));
  }
});

test('S12a: a forged far-future fetchedAt is served stale with no age, never fresh forever', () => {
  write('claude', 'default', { ...cat(), fetchedAt: Date.now() + 365 * 86400_000 });
  const r = readCache('claude', 'default', Date.now());
  assert.ok(r.kind === 'ok' && r.futureTime);
  const v = buildService(h).svc.view('claude');
  assert.equal(v.state, 'stale');
  assert.equal(v.fetchedAt, undefined);
  assert.ok(v.reason);
});

test('re-validation on read: hand-edited entries are cleaned/dropped, extra fields never come back, families recomputed', () => {
  write('cursor', 'default', {
    ...cat({ provider: 'cursor', source: 'cursor-list-models' }),
    families: [{ family: 'INJECTED', ids: ['evil'] }],
    extra: 'x',
    models: [{ id: 'gpt-5.3-codex-high', label: 'High\u202e', isDefault: 'true', efforts: ['ultra'], injected: 1 }, { id: '--evil', label: 'x' }, { id: 'gpt-5.3-codex-high', label: 'dup' }],
  });
  const v = buildService(h).svc.view('cursor');
  assert.deepEqual(v.models, [{ id: 'gpt-5.3-codex-high', label: 'High' }]);
  assert.equal((v as any).extra, undefined);
  assert.deepEqual(v.families!.map((f) => f.family), ['gpt-5.3-codex']);
});

test('a failed refresh keeps the list (stale + reason); the cached cliVersion is not updated by a failure', async () => {
  h.scenario({ models: 'in', lingerMs: 5000 });
  const a = buildService(h);
  assert.equal((await a.svc.refresh('claude')).state, 'fresh');
  h.scenario({ models: 'nomodels', lingerMs: 5000 });
  const b = buildService(h);
  const v = await b.svc.refresh('claude');
  assert.equal(v.state, 'stale');
  assert.equal(v.models!.length, 13);
  assert.equal(v.cliVersion, '2.1.304');
  assert.match(v.reason!, /^showing the list from \d\d:\d\d — this Claude Code version answered in an unexpected shape$/);
  const disk = JSON.parse(readFileSync(cacheFile('claude', 'default'), 'utf8'));
  assert.equal(disk.models.length, 13, 'the file still holds the last good list');
  assert.ok(lstatSync(cacheFile('claude', 'default')).isFile());
});

test('W1 on read: a Claude cache keeps a [1m] id; the same id in a Cursor cache is dropped (narrow rule)', () => {
  assert.equal(writeCache(cat({ models: [{ id: 'claude-fable-5-1[1m]', label: 'Fable', resolved: 'claude-fable-5-1[1m]' }] })), 'written');
  const r = readCache('claude', 'default', Date.now());
  assert.ok(r.kind === 'ok');
  assert.deepEqual(r.kind === 'ok' && r.catalog.models, [{ id: 'claude-fable-5-1[1m]', label: 'Fable', resolved: 'claude-fable-5-1[1m]' }]);
  write('cursor', 'default', { ...cat({ provider: 'cursor', source: 'cursor-list-models' }), models: [{ id: 'gpt-x[1m]', label: 'bracketed' }, { id: 'gpt-x', label: 'plain' }] });
  const c = readCache('cursor', 'default', Date.now());
  assert.deepEqual(c.kind === 'ok' && c.catalog.models.map((m) => m.id), ['gpt-x']);
});

test('L1: a symlinked folder with a loose mode is refused and the chmod never lands on the link target', () => {
  const target = join(h.root, 'loose-target');
  mkdirSync(target, { recursive: true });
  chmodSync(target, 0o755);
  rmSync(paths.models(), { recursive: true, force: true });
  symlinkSync(target, paths.models());
  assert.equal(securePrivateDir(paths.models(), false), 'bad');
  assert.equal(writeCache(cat()), 'refused');
  assert.equal(statSync(target).mode & 0o777, 0o755, 'the target keeps its mode');
  rmSync(paths.models());
  mkdirSync(paths.models(), { mode: 0o700 });
  chmodSync(paths.models(), 0o750);
  assert.equal(securePrivateDir(paths.models(), false), 'ok');
  assert.equal(statSync(paths.models()).mode & 0o777, 0o700, 'tightened through the handle');
  assert.equal(securePrivateDir(join(h.root, 'does-not-exist'), false), 'missing');
});

test('L2: writing over a symlinked cache path never reads or writes through it; the link becomes a regular file', () => {
  mkdirSync(join(paths.models(), 'claude'), { recursive: true, mode: 0o700 });
  const target = join(h.root, 'newer-elsewhere.json');
  writeFileSync(target, JSON.stringify({ version: 2, decoy: true }));
  symlinkSync(target, cacheFile('claude', 'default'));
  assert.equal(writeCache(cat()), 'written', 'the link target\'s "newer" version is never consulted');
  assert.ok(lstatSync(cacheFile('claude', 'default')).isFile());
  assert.equal(readFileSync(target, 'utf8'), JSON.stringify({ version: 2, decoy: true }));
  assert.equal(JSON.parse(readFileSync(cacheFile('claude', 'default'), 'utf8')).version, 1);
  assert.equal(statSync(cacheFile('claude', 'default')).mode & 0o777, 0o600);
});

test('N1: writing over an unreadable or unversioned existing file quarantines it first (as the read path does)', () => {
  write('claude', 'default', '{not json');
  assert.equal(writeCache(cat()), 'written');
  assert.equal(quarantined().length, 1);
  const { version, ...noVersion } = cat();
  void version;
  write('claude', 'default', noVersion);
  assert.equal(writeCache(cat()), 'written');
  assert.equal(quarantined().length, 2);
  assert.equal(writeCache(cat()), 'written', 'a valid version-1 file is simply replaced');
  assert.equal(quarantined().length, 2);
});
