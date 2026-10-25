// AC8 (S13): GET /api/models (allow-listed keys at every level), strict POST /api/models/refresh (400s, 403 without CSRF), 202 with the
// cached view inside the 10 s window, 501 without a service, no absolute paths in reasons — and (Lead) a hung discovery never blocks
// GET: it answers at once with `refreshing: true`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRuntime, type Runtime } from '../../src/runtime.ts';
import { MemoryStore } from '../../src/secrets.ts';
import { defaultConfig, normalizeConfig } from '../../src/config.ts';
import { runProcess, type SpawnOpts } from '../../src/agents/spawn.ts';
import { Api } from '../../src/server/api.ts';
import { FAKE_AGENT, FAKE_CLAUDE, ManualClock, modelHome } from './helpers.ts';

const h = modelHome();
const clock = new ManualClock();
const spawns: SpawnOpts[] = [];
let rt: Runtime;
let port = 0;
let csrf = '';

function call(path: string, method = 'GET', body?: unknown, opts: { raw?: string; csrf?: boolean } = {}): Promise<{ status: number; json: any; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
    if (opts.csrf !== false) headers['x-conductor-csrf'] = csrf;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        let j: any = null;
        try {
          j = JSON.parse(t);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode ?? 0, json: j, ms: Date.now() - t0 });
      });
    });
    req.on('error', reject);
    if (opts.raw !== undefined) req.write(opts.raw);
    else if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  rt = await createRuntime({
    ephemeral: true,
    config: normalizeConfig(defaultConfig()),
    secretStore: new MemoryStore(),
    health: async () => ({ claude: { found: true, ok: true, loggedIn: true, detail: 'ok', version: '2.1.304' }, cursor: { found: true, ok: true, loggedIn: true, detail: 'ok' } }),
    persistent: { load: () => ({ repos: {} }), save: () => undefined },
    notify: () => undefined,
    models: {
      clock,
      extraEnv: { FAKE_DIR: h.fake },
      bins: () => ({ claude: FAKE_CLAUDE, cursor: FAKE_AGENT }),
      timeoutMs: 2500,
      graceMs: 200,
      log: { info: () => undefined, warn: () => undefined },
      spawn: (o) => {
        spawns.push(o);
        return runProcess(o);
      },
    },
  });
  port = await rt.server.listen(0);
  csrf = (await call('/api/state')).json.csrf;
});
after(async () => {
  await rt.close();
  h.cleanup();
});

const VIEW_KEYS = new Set(['provider', 'state', 'reason', 'families', 'refreshing', 'version', 'account', 'source', 'cliVersion', 'fetchedAt', 'signedIn', 'plan', 'models']);
const MODEL_KEYS = new Set(['id', 'label', 'resolved', 'efforts', 'defaultEffort', 'isDefault', 'fast', 'thinking', 'adaptiveThinking', 'thinkingOff', 'noZdr']);
const FAMILY_KEYS = new Set(['family', 'efforts', 'thinking', 'fast', 'label', 'noZdr', 'ids']);
function allowListed(body: any): void {
  assert.deepEqual(Object.keys(body), ['providers']);
  assert.deepEqual(body.providers.map((p: any) => p.provider), ['claude', 'cursor', 'codex']);
  for (const p of body.providers) {
    for (const k of Object.keys(p)) assert.ok(VIEW_KEYS.has(k), `view key ${k}`);
    for (const m of p.models ?? []) for (const k of Object.keys(m)) assert.ok(MODEL_KEYS.has(k), `model key ${k}`);
    for (const f of p.families ?? []) for (const k of Object.keys(f)) assert.ok(FAMILY_KEYS.has(k), `family key ${k}`);
    if (p.reason) assert.ok(!/(^|\s)(\/|~\/)[^\s]+/.test(p.reason), `absolute path in reason: ${p.reason}`);
  }
}

test('GET /api/models before any discovery: allow-listed, Codex unavailable, nothing spawned (injected health ⇒ no auto discovery)', async () => {
  await call('/api/state');
  await call('/api/providers');
  const r = await call('/api/models');
  assert.equal(r.status, 200);
  allowListed(r.json);
  assert.equal(r.json.providers[0].state, 'unavailable');
  assert.equal(r.json.providers[2].reason, 'Codex model discovery is not available yet');
  assert.equal(spawns.length, 0);
});

test('strict refresh body: non-object, unknown key, __proto__, constructor, unknown/non-string provider ⇒ 400; no CSRF ⇒ 403', async () => {
  for (const raw of ['[]', '"claude"', '7', 'true', '{"provider":"claude","x":1}', '{"__proto__":{"provider":"claude"}}', '{"constructor":1}', '{"provider":"gemini"}', '{"provider":1}', '{"provider":null}', '{"provider":"__proto__"}']) {
    const r = await call('/api/models/refresh', 'POST', undefined, { raw });
    assert.equal(r.status, 400, raw);
  }
  const no = await call('/api/models/refresh', 'POST', { provider: 'claude' }, { csrf: false });
  assert.equal(no.status, 403);
  assert.equal(spawns.length, 0);
});

test('refresh {provider}: 202 at once, then the list; empty body = all providers; within 10 s ⇒ 202 with the cached view, no spawn', async () => {
  h.scenario({ models: 'in', listModels: 'ok', lingerMs: 30_000 });
  const r = await call('/api/models/refresh', 'POST', { provider: 'claude' });
  assert.equal(r.status, 202);
  allowListed(r.json);
  await waitState(0, 'fresh');
  const all = await call('/api/models/refresh', 'POST', {});
  assert.equal(all.status, 202);
  await waitState(1, 'fresh');
  const before = spawns.length;
  assert.equal(before, 2, 'claude once, cursor once (codex never)');
  const again = await call('/api/models/refresh', 'POST', { provider: 'claude' });
  assert.equal(again.status, 202);
  assert.equal(again.json.providers[0].state, 'fresh');
  assert.equal(again.json.providers[0].refreshing, undefined);
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(spawns.length, before, 'inside the 10 s window nothing is spawned');
  const g = await call('/api/models');
  allowListed(g.json);
  assert.equal(g.json.providers[1].families.length > 0, true);
});

test('Lead #3: a HUNG discovery never blocks GET /api/models — it answers at once with refreshing: true, then stale', async () => {
  clock.advance(11_000);
  h.scenario({ models: 'hang', listModels: 'ok' });
  const r = await call('/api/models/refresh', 'POST', { provider: 'claude' });
  assert.equal(r.status, 202);
  assert.ok(r.ms < 1000, `POST took ${r.ms} ms`);
  const g = await call('/api/models');
  assert.ok(g.ms < 1000, `GET took ${g.ms} ms`);
  assert.equal(g.json.providers[0].state, 'fresh');
  assert.equal(g.json.providers[0].refreshing, true);
  assert.equal(g.json.providers[0].models.length, 13);
  // while the hung Claude discovery holds the queue, a Cursor refresh waits its turn — and GET still answers at once
  clock.advance(11_000);
  await call('/api/models/refresh', 'POST', { provider: 'cursor' });
  const g2 = await call('/api/models');
  assert.ok(g2.ms < 1000);
  assert.equal(g2.json.providers[1].refreshing, true);
  await waitState(0, 'stale');
  const done = (await call('/api/models')).json.providers[0];
  assert.match(done.reason, /did not answer within 15 seconds/);
  allowListed((await call('/api/models')).json);
});

test('reasons never carry absolute paths (stderr with a home path)', async () => {
  clock.advance(11_000);
  h.scenario({ models: 'stderr-email' });
  await call('/api/models/refresh', 'POST', { provider: 'claude' });
  await waitFor(async () => (await call('/api/models')).json.providers[0].reason?.includes('ended without'));
  const g = await call('/api/models');
  allowListed(g.json);
  assert.match(g.json.providers[0].reason, /\[path\]/);
});

test('501 when the API has no model service (runtime `models: false` passes none)', async () => {
  const api = new Api({} as any);
  await assert.rejects(api.handle('GET', '/api/models', new URLSearchParams(), {}), (e: any) => e.status === 501);
  await assert.rejects(api.handle('POST', '/api/models/refresh', new URLSearchParams(), {}), (e: any) => e.status === 501);
});

async function waitFor(pred: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
async function waitState(i: number, state: string): Promise<void> {
  await waitFor(async () => {
    const p = (await call('/api/models')).json.providers[i];
    return p.state === state && !p.refreshing;
  });
}
