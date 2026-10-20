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
