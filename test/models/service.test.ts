// AC3 (S17) + service behaviour: Codex is dormant (no binary lookup, no spawn); view() is memory-only; reading vs refreshing (N13);
// version change triggers a refresh; account seams (M8-3): envFor / accountIds / forget, account regex.
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig, normalizeConfig } from '../../src/config.ts';
import { CODEX_UNAVAILABLE_REASON } from '../../src/models/codex.ts';
import { cacheFile } from '../../src/models/cache.ts';
import { paths } from '../../src/paths.ts';
import { REAL, buildService, modelHome, readJson, stubSpawn } from './helpers.ts';

const h = modelHome();
after(() => h.cleanup());
beforeEach(() => rmSync(paths.models(), { recursive: true, force: true }));
const fx = readJson(join(REAL, 'claude-initialize-2.1.304.json'));
const okLine = { line: JSON.stringify({ type: 'control_response', response: { ...fx.response, request_id: 'r1' } }) };

test('S17: Codex — unavailable with the static reason; refresh/startup/noteVersion never look up its binary or spawn', async () => {
  let codexLookups = 0;
  const cfg = normalizeConfig(defaultConfig());
  const agents = new Proxy(cfg.agents, {
    get(t, k) {
      if (k === 'codex') codexLookups++;
      return (t as any)[k];
    },
  });
  const { svc, spawns } = buildService(h, { getConfig: () => ({ ...cfg, agents }), bins: undefined, spawnImpl: stubSpawn([okLine]) });
  const v = svc.view('codex');
  assert.deepEqual(v, { provider: 'codex', state: 'unavailable', reason: CODEX_UNAVAILABLE_REASON });
  await svc.refresh('codex');
  await svc.startup({ codex: { found: true, state: 'ok', version: '0.50.0' } });
  assert.equal(svc.noteVersion('codex', '0.50.0'), null);
  svc.noteUnknownModel('codex');
  assert.equal(spawns.length, 0);
  assert.equal(codexLookups, 0);
  assert.equal(svc.viewAll()[2]!.state, 'unavailable');
});

test('view() is memory-only after construction: deleting the cache folder does not change it', async () => {
  const a = buildService(h, { spawnImpl: stubSpawn([okLine]) });
  await a.svc.refresh('claude');
  const b = buildService(h, { spawnImpl: stubSpawn([okLine]) });
  rmSync(paths.models(), { recursive: true, force: true });
  assert.equal(b.svc.view('claude').models!.length, 13);
  assert.equal(b.svc.view('claude').state, 'fresh');
});

test('N13: no cache + refresh running ⇒ "reading"; cache + refresh running ⇒ cached state + refreshing: true', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = async (o: any) => {
    await gate;
    return stubSpawn([okLine])(o);
  };
  const { svc } = buildService(h, { spawnImpl: slow });
  const p = svc.refresh('claude');
  assert.equal(svc.view('claude').state, 'reading');
  release();
  await p;
  assert.equal(svc.view('claude').state, 'fresh');
  let release2!: () => void;
  const gate2 = new Promise<void>((r) => (release2 = r));
  const s2 = buildService(h, { spawnImpl: async (o) => (await gate2, stubSpawn([okLine])(o)) });
  const p2 = s2.svc.refresh('claude');
  const mid = s2.svc.view('claude');
  assert.equal(mid.state, 'fresh');
  assert.equal(mid.refreshing, true);
  release2();
  await p2;
  assert.equal(s2.svc.view('claude').refreshing, undefined);
});

test('a version change triggers a refresh (noteVersion); the same version does not', async () => {
  const a = buildService(h, { spawnImpl: stubSpawn([okLine]) });
  await a.svc.refresh('claude');
  const b = buildService(h, { spawnImpl: stubSpawn([okLine]) });
  assert.equal(b.svc.noteVersion('claude', '2.1.304 (Claude Code)'), null, 'same version as the cache');
  const p = b.svc.noteVersion('claude', '2.1.305 (Claude Code)');
  assert.ok(p);
  await p;
  assert.equal(b.spawns.length, 1);
});

test('M8-3 seams: envFor(provider, account), per-account cache file, accountIds fan-out, bad account refused, forget()', async () => {
  const envCalls: string[] = [];
  const { svc, spawns } = buildService(h, {
    spawnImpl: stubSpawn([okLine]),
    envFor: (p, a) => (envCalls.push(`${p}:${a}`), { PATH: process.env.PATH ?? '' }),
    accountIds: () => ['default', 'work'],
  });
  await svc.startup({ claude: { found: true, state: 'ok', version: '2.1.304' } });
  assert.deepEqual(envCalls.sort(), ['claude:default', 'claude:work']);
  assert.ok(existsSync(cacheFile('claude', 'work')));
  assert.equal(svc.view('claude', 'work').account, 'work');
  assert.equal(spawns.length, 2);
  assert.equal(svc.view('claude', '../x').state, 'unavailable');
  assert.equal((await svc.refresh('claude', 'manual', 'Bad Account')).state, 'unavailable');
  assert.equal(spawns.length, 2);
  rmSync(cacheFile('claude', 'work'));
  svc.forget('claude', 'work');
  assert.equal(svc.view('claude', 'work').state, 'unavailable');
});

test('a tool that is not installed ⇒ unavailable "… is not installed", nothing spawned', async () => {
  const { svc, spawns } = buildService(h, { bins: () => ({ claude: null, cursor: null }), spawnImpl: stubSpawn([okLine]) });
  const v = await svc.refresh('cursor');
  assert.equal(v.state, 'unavailable');
  assert.match(v.reason!, /is not installed/);
  assert.equal(spawns.length, 0);
});
