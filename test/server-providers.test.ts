// M2 commit 2d: /api/providers, /api/providers/:id/test, /api/roles — strict bodies, id whitelist before any path, pairing gate, confirm on every canary.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { rmSync } from 'node:fs';
import { startDemo, type DemoHandle } from '../src/demo.ts';

let demo: DemoHandle;
let port = 0;
let cookie = '';
let csrf = '';

function raw(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: t }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
const mut = (extra: Record<string, string> = {}) => ({ cookie, 'content-type': 'application/json', 'x-conductor-csrf': csrf, 'sec-fetch-site': 'same-origin', ...extra });
const get = async (p: string) => {
  const r = await raw(p, { headers: { cookie } });
  return { status: r.status, json: r.text ? JSON.parse(r.text) : null };
};
const send = async (method: string, p: string, body: unknown, headers = mut()) => {
  const r = await raw(p, { method, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  let json: any = null;
  try {
    json = JSON.parse(r.text);
  } catch {
    /* non-JSON */
  }
  return { status: r.status, json };
};

before(async () => {
  demo = await startDemo({ port: 0, pollMs: 150, delayMs: 15 });
  port = demo.rt.server.listeningPort;
  const u = new URL(demo.rt.server.loginUrl());
  const r = await new Promise<http.IncomingMessage>((res, rej) => http.get({ host: '127.0.0.1', port, path: u.pathname + u.search }, res).on('error', rej));
  cookie = String(r.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
  csrf = (await get('/api/state')).json.csrf;
});
after(async () => {
  await demo.close();
  rmSync(demo.home, { recursive: true, force: true });
});

test('GET /api/providers: every registry provider with derived capabilities, a tier, a static hint; GET /api/state carries the same list', async () => {
  const r = await get('/api/providers');
  assert.equal(r.status, 200);
  const ids = r.json.providers.map((p: any) => p.id).sort();
  assert.deepEqual(ids, ['claude', 'cursor']);
  const cursor = r.json.providers.find((p: any) => p.id === 'cursor');
  assert.equal(cursor.label, 'Cursor');
  assert.deepEqual(cursor.capabilities, { readOnly: true, build: true, buildIsolationVerified: true });
  assert.equal(cursor.tier, 'partial');
  const claude = r.json.providers.find((p: any) => p.id === 'claude');
  assert.deepEqual(claude.capabilities, { readOnly: true, build: false, buildIsolationVerified: false });
  assert.equal(claude.tier, 'verified');
  assert.match(claude.hint, /claude\.com\/claude-code/);
  assert.ok(claude.inUse && cursor.inUse);
  const st = await get('/api/state');
  assert.deepEqual(st.json.providers.map((p: any) => p.id).sort(), ids);
});

test('GET /api/roles: the config, the role requirements and, per role and provider, whether it may be assigned and why not', async () => {
  const r = (await get('/api/roles')).json;
  assert.deepEqual(r.roles.implementation.providers, ['cursor']);
  assert.equal(r.needs.implementation.build, true);
  assert.equal(r.needs.documentation.build, true, 'documentation is build-class');
  assert.equal(r.choices.implementation.cursor.ok, true);
  assert.equal(r.choices.implementation.claude.ok, false);
  assert.match(r.choices.implementation.claude.reason, /cannot write code/);
  assert.equal(r.choices.planning.claude.ok, true);
});

test('PUT /api/roles negatives: non-object bodies, prototype/unknown roles, bad providers, unsupported pairings, bad complexity keys — all 400/409, nothing saved', async () => {
  const before = JSON.stringify((await get('/api/roles')).json.roles);
  const bad: [string, unknown, number][] = [
    ['null body', 'null', 400], ['array body', [], 400], ['string body', '"x"', 400], ['number body', '5', 400],
    ['roles missing', {}, 400], ['roles array', { roles: [] }, 400], ['roles string', { roles: 'x' }, 400],
    ['__proto__ role', JSON.parse('{"roles":{"__proto__":{"providers":["claude"]}}}'), 400],
    ['constructor role', { roles: { constructor: { providers: ['claude'] } } }, 400],
    ['unknown role', { roles: { janitor: { providers: ['claude'] } } }, 400],
    ['role not an object', { roles: { planning: 'claude' } }, 400],
    ['providers missing', { roles: { planning: {} } }, 400],
    ['providers empty', { roles: { planning: { providers: [] } } }, 400],
    ['providers too long', { roles: { planning: { providers: ['claude', 'cursor', 'claude', 'cursor', 'claude'] } } }, 400],
    ['unknown provider', { roles: { planning: { providers: ['gpt'] } } }, 400],
    ['provider not a string', { roles: { planning: { providers: [{}] } } }, 400],
    ['claude cannot implement', { roles: { implementation: { providers: ['claude'] } } }, 400],
    ['claude cannot document', { roles: { documentation: { providers: ['claude', 'cursor'] } } }, 400],
    ['research needs isolation', { roles: { research: { providers: ['claude'] } } }, 400],
    ['autoByComplexity not an object', { roles: { review: { providers: ['claude'], autoByComplexity: [] } } }, 400],
    ['bad complexity key', { roles: { review: { providers: ['claude'], autoByComplexity: { XL: 'claude' } } } }, 400],
    ['ineligible complexity pick', { roles: { implementation: { providers: ['cursor'], autoByComplexity: { S: 'claude' } } } }, 400],
    ['bad acknowledge', { roles: { planning: { providers: ['claude'] } }, acknowledge: 'claude' }, 400],
  ];
  for (const [name, body, want] of bad) {
    const r = await send('PUT', '/api/roles', body);
    assert.equal(r.status, want, `${name}: got ${r.status} ${JSON.stringify(r.json)}`);
  }
  const claudeImpl = await send('PUT', '/api/roles', { roles: { implementation: { providers: ['claude'] } } });
  assert.equal(claudeImpl.json.error.code, 'unsupported_pairing');
  assert.match(claudeImpl.json.error.message, /Claude cannot write code/);
  assert.equal(JSON.stringify((await get('/api/roles')).json.roles), before, 'nothing was saved');
  assert.equal(({} as any).providers, undefined, 'no prototype pollution');
});

test('PUT /api/roles: CSRF and cross-site negatives', async () => {
  const body = { roles: { planning: { providers: ['claude'] } } };
  assert.equal((await send('PUT', '/api/roles', body, { cookie, 'content-type': 'application/json' } as any)).status, 403, 'missing csrf');
  assert.equal((await send('PUT', '/api/roles', body, mut({ 'sec-fetch-site': 'cross-site' }))).status, 403, 'cross-site');
  assert.equal((await send('PUT', '/api/roles', body, { 'content-type': 'application/json', 'x-conductor-csrf': csrf, 'sec-fetch-site': 'same-origin' } as any)).status, 401, 'no cookie');
});

test('PUT /api/roles: a valid assignment is saved, validated again at load, reflected in the Settings compat fields, and announces where the text goes', async () => {
  const r = await send('PUT', '/api/roles', { roles: { planning: { providers: ['cursor', 'claude'] }, requirements: { providers: ['claude', 'cursor'] } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.roles.planning.providers, ['cursor', 'claude']);
  assert.ok(r.json.notices.some((n: string) => /Cursor → requirements: Task text and repository content/.test(n)), 'the data-egress statement for a newly assigned provider');
  const st = (await get('/api/state')).json;
  assert.equal(st.settings.stages.plan, 'cursor');
  assert.equal(st.settings.onClaudeLimit, 'wait', 'derived: no cursor FOLLOWS claude in the planning chain any more');
  // put it back
  const back = await send('PUT', '/api/roles', { roles: { planning: { providers: ['claude', 'cursor'] }, requirements: { providers: ['claude'] } } });
  assert.equal(back.status, 200);
});

test('POST /api/providers/:id/test: the id is checked against the registry before anything else; bodies are strict; a canary needs confirm:true EVERY time, runs one at a time, with a cool-down', async () => {
  for (const id of ['..%2F..%2Fetc', '__proto__', 'constructor', 'codex', 'CLAUDE', 'claude%00', '']) {
    const r = await send('POST', `/api/providers/${id}/test`, {});
    assert.ok(r.status === 404 || r.status === 400, `${id}: ${r.status}`);
  }
  assert.equal((await send('POST', '/api/providers/claude/test', [])).status, 400);
  assert.equal((await send('POST', '/api/providers/claude/test', { level: 'deep' })).status, 400);
  const cheap = await send('POST', '/api/providers/cursor/test', {});
  assert.equal(cheap.status, 200);
  assert.equal(cheap.json.level, 'cheap');
  assert.equal(cheap.json.provider.id, 'cursor');
  for (const confirm of [undefined, false, 'true', 1, null]) {
    const r = await send('POST', '/api/providers/claude/test', { level: 'canary', confirm });
    assert.equal(r.status, 400, String(confirm));
    assert.equal(r.json.error.code, 'confirm_required');
  }
  // wait for the demo board to be idle, then: first confirmed canary runs, the second (concurrent or immediate) is refused
  const t0 = Date.now();
  while ((await get('/api/state')).json.engine.running > 0 && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 150));
  const [a, b] = await Promise.all([send('POST', '/api/providers/claude/test', { level: 'canary', confirm: true }), send('POST', '/api/providers/claude/test', { level: 'canary', confirm: true })]);
  const statuses = [a.status, b.status].sort();
  assert.equal(statuses[0], 200, `one ran: ${statuses}`);
  assert.ok(statuses[1] === 409 || statuses[1] === 429, `the other was refused: ${statuses}`);
  const again = await send('POST', '/api/providers/claude/test', { level: 'canary', confirm: true });
  assert.equal(again.status, 429, 'cool-down');
  assert.equal(again.json.error.code, 'cooldown');
});
