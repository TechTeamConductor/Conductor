// M4 commit 3 — offline mode: classification from structural failures only, probe rules, pause/refund/resume, caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NETWORK_RE } from '../src/agents/providers/probe.ts';
import { OFFLINE_OPERATIONS, OfflineProbe, backoffFor, PROBE_HOSTS } from '../src/net/offline.ts';
import { makeHarness } from './helpers/harness.ts';

const fail = (code = 'ENOTFOUND') => async () => { throw Object.assign(new Error('fetch failed'), { cause: { code } }); };

test('probe: online / offline / unknown, cached 20 s, proxy ⇒ unknown, disabled ⇒ unknown, constant hosts, redirects refused', async () => {
  let t = 0; const seen: any[] = [];
  const ok = async (url: string, init: any) => { seen.push([url, init.method, init.redirect]); return {}; };
  assert.equal(await new OfflineProbe({ fetcher: ok, now: () => t, env: {} }).check(), 'online');
  assert.deepEqual(seen[0], [PROBE_HOSTS[0], 'HEAD', 'error']);
  const p = new OfflineProbe({ fetcher: fail(), now: () => t, env: {} });
  assert.equal(await p.check(), 'offline');
  t = 10_000; assert.equal(await p.check(), 'offline');
  assert.equal(await new OfflineProbe({ fetcher: fail(), env: { HTTPS_PROXY: 'http://p' } }).check(), 'unknown');
  assert.equal(await new OfflineProbe({ fetcher: null }).check(), 'unknown');
  assert.equal(await new OfflineProbe({ fetcher: async () => { throw new Error('redirect mode is set to error'); }, env: {} }).check(), 'online');
  assert.deepEqual([1, 2, 3, 4, 9].map(backoffFor), [30_000, 60_000, 120_000, 300_000, 300_000]);
  assert.ok(OFFLINE_OPERATIONS.some((o) => o.mode === 'needs-network' && o.provider === 'claude') && OFFLINE_OPERATIONS.some((o) => o.id === 'board' && o.mode === 'offline-ok'));
  assert.ok(NETWORK_RE.test('getaddrinfo ENOTFOUND api.anthropic.com') && !NETWORK_RE.test('the build failed'));
});

test('a network failure pauses the run (offline), refunds the attempt, comments once, and a human Resume continues', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ claude: { '*': { plan: [{ error: 'getaddrinfo ENOTFOUND api.anthropic.com', network: true }, {}] } } });
    const key = h.issue('Add the greeting');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'paused');
    assert.equal(run.pauseReason, 'offline');
    assert.equal(run.agentRuns, 0);
    assert.equal(run.offline?.episodes, 1);
    h.engine.resume(key);
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
  } finally { await h.cleanup(); }
});

test('network words in a COMPLETED turn (a result the CLI returned) are never offline — only a structural failure with no result is', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ claude: { '*': { plan: [{ error: 'ECONNREFUSED ENOTFOUND fetch failed (written by the model)' }] } } });
    const key = h.issue('Add the greeting');
    await h.settle();
    assert.notEqual(h.run(key).pauseReason, 'offline');
    assert.notEqual(h.run(key).status, 'paused');
  } finally { await h.cleanup(); }
});

test('the episode cap ends a run that keeps going offline in needs-you (it cannot pause and resume forever)', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ claude: { '*': { plan: [{ network: true }] } } });
    const key = h.issue('Add the greeting');
    await h.settle();
    for (let i = 0; i < 25 && h.run(key).status === 'paused'; i++) {
      h.store.update(key, (r) => { if (r.offline) r.offline.streak = 0; }); // each resume starts a new episode
      h.engine.resume(key);
      await h.settle();
    }
    assert.equal(h.run(key).status, 'needs_human');
    assert.match(h.run(key).needsHuman!.reason, /network repeatedly/);
  } finally { await h.cleanup(); }
});

import { SCAN_ENV } from '../src/context/gitread.ts';
import { OFFLINE_RUN_CEILING_MS } from '../src/net/offline.ts';

test('MJ-3: a paused-offline run stays paused while the probe says offline and resumes by itself when it says online; the comment is posted once', async () => {
  let up = false;
  const clock = { t: 1_000_000, now() { return this.t; }, advance(ms: number) { this.t += ms; } };
  const h = await makeHarness({ clock: clock as any, offlineFetcher: async () => { if (!up) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); return {}; } });
  try {
    h.scenario({ claude: { '*': { plan: [{ network: true }, {}] } } });
    const key = h.issue('Add the greeting');
    await h.settle();
    assert.equal(h.run(key).status, 'paused');
    const comments = () => h.board.comments(key).filter((c) => /Paused — no network/.test(c.body)).length;
    assert.equal(comments(), 1);
    clock.advance(60_000);
    await h.engine.tick();
    assert.equal(h.run(key).status, 'paused', 'still offline: the pause is extended, not resumed');
    assert.ok((h.run(key).pausedUntil ?? 0) > clock.now());
    up = true;
    clock.advance(600_000);
    await h.settle();
    assert.equal(h.run(key).status, 'ready', 'resumed by itself when the probe said online');
    assert.equal(comments(), 1, 'one comment per episode');
  } finally { await h.cleanup(); }
});

test('MJ-1: a CLI that HANGS while the probe says offline is a network failure (refunded, paused), not a failed attempt; online ⇒ an ordinary failure', async () => {
  const h = await makeHarness({ offlineFetcher: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
  try {
    h.cfg.pipeline.timeoutsMin.idle = 1;
    h.scenario({ claude: { '*': { plan: [{ error: 'boom' }] } } });
    const key = h.issue('Add the greeting');
    await h.settle();
    assert.equal(h.run(key).status, 'paused');
    assert.equal(h.run(key).pauseReason, 'offline');
    assert.equal(h.run(key).agentRuns, 0);
  } finally { await h.cleanup(); }
  const h2 = await makeHarness({ offlineFetcher: async () => ({}) });
  try {
    h2.scenario({ claude: { '*': { plan: [{ error: 'boom' }, { error: 'boom' }] } } });
    const key = h2.issue('Add the greeting');
    await h2.settle();
    assert.equal(h2.run(key).status, 'needs_human');
  } finally { await h2.cleanup(); }
});

test('MJ-3: the cumulative 24 h ceiling ends the run in needs-you; a Cursor network failure is classified too; the scan env pins NO_LAZY_FETCH and no global config', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ claude: { '*': { plan: [{ network: true }] } } });
    const key = h.issue('Add the greeting');
    await h.settle();
    h.store.update(key, (r) => { r.offline = { episodes: 1, streak: 0, totalMs: OFFLINE_RUN_CEILING_MS }; });
    h.engine.resume(key);
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.match(h.run(key).needsHuman!.reason, /24 hours in total/);
  } finally { await h.cleanup(); }
  const h2 = await makeHarness();
  try {
    h2.cfg.roles.planning.providers = ['cursor'];
    h2.scenario({ cursor: { '*': { plan: [{ network: true }] } } });
    const key = h2.issue('Add the greeting');
    await h2.settle();
    assert.equal(h2.run(key).pauseReason, 'offline');
  } finally { await h2.cleanup(); }
  assert.equal(SCAN_ENV.GIT_NO_LAZY_FETCH, '1');
  assert.equal(SCAN_ENV.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(SCAN_ENV.GIT_CONFIG_NOSYSTEM, '1');
});
