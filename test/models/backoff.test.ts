// AC11 (S11): automatic refreshes are bounded — repeated failures + 20 health refreshes ⇒ 1 spawn; ≤ 1 per distinct cliVersion per
// process; ≤ 1 per 5 min after a failure; a failed refresh never updates the cached cliVersion; only a manual refresh uses the 10 s window.
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { AUTO_BACKOFF_MS, MANUAL_WINDOW_MS } from '../../src/models/service.ts';
import { paths } from '../../src/paths.ts';
import { ManualClock, REAL, buildService, modelHome, readJson, stubSpawn } from './helpers.ts';

const h = modelHome();
after(() => h.cleanup());
beforeEach(() => rmSync(paths.models(), { recursive: true, force: true }));

const fx = readJson(join(REAL, 'claude-initialize-2.1.304.json'));
const okLine = (version = '2.1.304') => ({ line: JSON.stringify({ type: 'control_response', response: { ...fx.response, request_id: 'r1', response: { ...fx.response.response, claude_code_version: version } } }) });
const failing = stubSpawn([{ line: 'not json' }], { code: 1 });
const health = (version: string) => ({ claude: { found: true, state: 'ok', version: `${version} (Claude Code)` }, cursor: { found: false, state: 'missing' } });

test('repeated failures + 20 health refreshes (same version) ⇒ exactly 1 spawn; the cache keeps no cliVersion from a failure', async () => {
  const clock = new ManualClock();
  const { svc, spawns } = buildService(h, { clock, spawnImpl: failing });
  for (let i = 0; i < 20; i++) {
    await svc.startup(health('2.1.304'));
    clock.advance(10_000);
  }
  assert.equal(spawns.length, 1);
  assert.equal(svc.view('claude').state, 'unavailable');
  assert.equal(svc.view('claude').cliVersion, undefined);
  // even after the 5-minute back-off the SAME version is not retried automatically (≤ 1 per distinct version per process)
  clock.advance(AUTO_BACKOFF_MS);
  for (let i = 0; i < 5; i++) await svc.startup(health('2.1.304'));
  assert.equal(spawns.length, 1);
});

test('a new version inside the 5-minute back-off after a failure is held; after it, one refresh', async () => {
  const clock = new ManualClock();
  const { svc, spawns } = buildService(h, { clock, spawnImpl: failing });
  await svc.startup(health('2.1.304'));
  assert.equal(spawns.length, 1);
  clock.advance(60_000);
  await svc.startup(health('2.1.305'));
  assert.equal(spawns.length, 1, 'held by the back-off');
  clock.advance(AUTO_BACKOFF_MS);
  await svc.startup(health('2.1.305'));
  await svc.startup(health('2.1.305'));
  assert.equal(spawns.length, 2);
});

test('success: the same version never re-discovers; a changed version does, once', async () => {
  const clock = new ManualClock();
  let version = '2.1.304';
  const { svc, spawns } = buildService(h, { clock, spawnImpl: (o) => stubSpawn([okLine(version)])(o) });
  await svc.startup(health('2.1.304'));
  assert.equal(svc.view('claude').cliVersion, '2.1.304');
  for (let i = 0; i < 20; i++) await svc.startup(health('2.1.304'));
  assert.equal(spawns.length, 1);
  version = '2.1.310';
  await svc.startup(health('2.1.310'));
  await svc.startup(health('2.1.310'));
  assert.equal(spawns.length, 2);
  assert.equal(svc.view('claude').cliVersion, '2.1.310');
});

test('startup ignores missing / broken tools; Codex is never touched', async () => {
  const { svc, spawns } = buildService(h, { spawnImpl: failing });
  await svc.startup({ claude: { found: false, state: 'missing' }, cursor: { found: true, state: 'broken-install', version: '1.0.0' }, codex: { found: true, state: 'ok', version: '0.50.0' } } as any);
  assert.equal(spawns.length, 0);
});

test('manual refresh: 5 concurrent calls ⇒ 1 spawn; again within 10 s ⇒ cached view; after 10 s ⇒ a new spawn', async () => {
  const clock = new ManualClock();
  const { svc, spawns } = buildService(h, { clock, spawnImpl: (o) => stubSpawn([okLine()])(o) });
  const vs = await Promise.all([1, 2, 3, 4, 5].map(() => svc.refresh('claude')));
  assert.equal(spawns.length, 1);
  assert.ok(vs.every((v) => v.state === 'fresh'));
  await svc.refresh('claude');
  assert.equal(spawns.length, 1);
  clock.advance(MANUAL_WINDOW_MS + 1);
  await svc.refresh('claude');
  assert.equal(spawns.length, 2);
});

test('the manual window never applies to automatic triggers and vice versa: a failure does not block a manual refresh', async () => {
  const clock = new ManualClock();
  const { svc, spawns } = buildService(h, { clock, spawnImpl: failing });
  await svc.startup(health('2.1.304'));
  clock.advance(MANUAL_WINDOW_MS + 1);
  await svc.refresh('claude', 'manual');
  assert.equal(spawns.length, 2, 'the user can always retry by hand after 10 s');
});

test('noteUnknownModel: at most one refresh per 5 minutes, and none inside the failure back-off', async () => {
  const clock = new ManualClock();
  const { svc, spawns } = buildService(h, { clock, spawnImpl: (o) => stubSpawn([okLine()])(o) });
  svc.noteUnknownModel('claude');
  await waitIdle(svc);
  svc.noteUnknownModel('claude');
  svc.noteUnknownModel('claude');
  await waitIdle(svc);
  assert.equal(spawns.length, 1);
  clock.advance(AUTO_BACKOFF_MS + 1);
  svc.noteUnknownModel('claude');
  await waitIdle(svc);
  assert.equal(spawns.length, 2);
  svc.noteUnknownModel('codex');
  assert.equal(spawns.length, 2);
});

async function waitIdle(svc: { view(p: 'claude'): { refreshing?: true; state: string } }): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const v = svc.view('claude');
    if (!v.refreshing && v.state !== 'reading') return;
    await new Promise((r) => setTimeout(r, 10));
  }
}
