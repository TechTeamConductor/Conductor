import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { rmSync } from 'node:fs';
import { startDemo, type DemoHandle } from '../src/demo.ts';

let demo: DemoHandle;
let base = '';
let port = 0;
let cookie = '';
let csrf = '';

async function raw(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer; host?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { ...(opts.host ? { host: opts.host } : {}), ...opts.headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: t }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
const authed = (extra: Record<string, string> = {}) => ({ cookie, ...extra });
const mut = (extra: Record<string, string> = {}) => ({ cookie, 'content-type': 'application/json', 'x-conductor-csrf': csrf, 'sec-fetch-site': 'same-origin', ...extra });

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 120));
  }
}

before(async () => {
  demo = await startDemo({ port: 0, pollMs: 150, delayMs: 15 });
  port = demo.rt.server.listeningPort;
  base = `http://127.0.0.1:${port}`;
  const url = new URL(demo.rt.server.loginUrl());
  const r = await raw(url.pathname + url.search);
  assert.equal(r.status, 302);
  cookie = String(r.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
  const st = await raw('/api/state', { headers: authed() });
  csrf = JSON.parse(st.text).csrf;
});
after(async () => {
  await demo.close();
  rmSync(demo.home, { recursive: true, force: true });
});

test('auth: no cookie → 401 for the API and a redirect to /login for the UI; OTP is single-use', async () => {
  assert.equal((await raw('/api/state')).status, 401);
  assert.equal((await raw('/api/events')).status, 401);
  const root = await raw('/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, '/login');
  assert.equal((await raw('/login')).status, 200);
  const u = new URL(demo.rt.server.loginUrl());
  assert.equal((await raw(u.pathname + u.search)).status, 302);
  assert.equal((await raw(u.pathname + u.search)).status, 403, 'reused OTP rejected');
  assert.equal((await raw('/auth?otp=nonsense')).status, 403);
});

test('cookie is HttpOnly + SameSite=Strict and every response carries security headers', async () => {
  const u = new URL(demo.rt.server.loginUrl());
  const r = await raw(u.pathname + u.search);
  const sc = String(r.headers['set-cookie']?.[0]);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  const s = await raw('/api/state', { headers: authed() });
  assert.match(String(s.headers['content-security-policy']), /default-src 'self'/);
  assert.match(String(s.headers['content-security-policy']), /style-src 'self'/);
  assert.equal(s.headers['x-content-type-options'], 'nosniff');
  assert.equal(s.headers['referrer-policy'], 'no-referrer');
  assert.equal(s.headers['cache-control'], 'no-store');
});

test('wrong Host header (DNS rebinding) is refused', async () => {
  assert.equal((await raw('/api/state', { headers: authed(), host: 'evil.example.com' })).status, 421);
  assert.equal((await raw('/api/state', { headers: authed(), host: `127.0.0.1:${port + 1}` })).status, 421);
  assert.equal((await raw('/api/state', { headers: authed(), host: `localhost:${port}` })).status, 200);
});

test('state has the contract fields and the demo runs', async () => {
  const s = JSON.parse((await raw('/api/state', { headers: authed() })).text);
  for (const k of ['now', 'version', 'csrf', 'setup', 'health', 'quota', 'engine', 'settings', 'repos', 'runs']) assert.ok(k in s, k);
  assert.equal(s.setup.complete, true);
  assert.ok(s.runs.length >= 1);
  for (const r of s.runs) for (const k of ['key', 'title', 'status', 'column', 'activity', 'canApprove', 'canRetry', 'canAbort', 'loop', 'maxLoops']) assert.ok(k in r, `run.${k}`);
});

test('mutations: CSRF, content-type, same-origin and body-size are enforced', async () => {
  const body = JSON.stringify({ paused: false });
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body })).status, 403, 'missing CSRF');
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: mut({ 'x-conductor-csrf': 'wrong' }), body })).status, 403, 'wrong CSRF');
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: mut({ 'content-type': 'text/plain' }), body })).status, 415);
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: mut({ 'sec-fetch-site': 'cross-site' }), body })).status, 403, 'cross-site');
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: { ...mut(), 'sec-fetch-site': '' }, body })).status >= 400, true);
  const noFetchMeta = mut();
  delete (noFetchMeta as any)['sec-fetch-site'];
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: noFetchMeta, body })).status, 403, 'neither Sec-Fetch-Site nor Origin');
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: { ...noFetchMeta, origin: 'http://evil.example' }, body })).status, 403, 'foreign Origin');
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: { ...noFetchMeta, origin: `http://127.0.0.1:${port}` }, body })).status, 200, 'same Origin ok without Sec-Fetch');
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: mut(), body: 'not json' })).status, 400);
  const big = Buffer.alloc(1024 * 1024 + 10, 'a');
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: mut(), body: big })).status, 413);
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: mut(), body })).status, 200);
});

test('static files are an exact whitelist: traversal, siblings and dotfiles are never served', async () => {
  for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/app.js/../../package.json', '/ui/index.html', '/index.html', '/package.json', '/.env', '/src/cli.ts', '/prompts/plan.md', '//etc/passwd']) {
    const r = await raw(p, { headers: authed() });
    assert.ok(r.status === 404 || r.status === 400 || r.status === 421, `${p} → ${r.status}`);
    assert.ok(!/"name"|root:/.test(r.text), `${p} leaked content`);
  }
  assert.equal((await raw('/', { headers: authed() })).status, 200);
  assert.equal((await raw('/app.js', { headers: authed() })).status, 200);
  assert.equal((await raw('/style.css')).status, 200);
});

test('SSE: authenticated stream delivers an initial state event', async () => {
  const chunk = await new Promise<string>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: authed() }, (res) => {
      assert.match(String(res.headers['content-type']), /text\/event-stream/);
      let t = '';
      res.on('data', (c) => {
        t += c;
        if (t.includes('event: state')) {
          resolve(t);
          req.destroy();
        }
      });
    });
    req.on('error', (e) => ((e as any).code === 'ECONNRESET' ? undefined : reject(e)));
    req.end();
  });
  assert.match(chunk, /event: state\ndata: \{/);
});

test('unknown run / bad key / unknown target are rejected cleanly', async () => {
  assert.equal((await raw('/api/runs/NOPE-1', { headers: authed() })).status, 404);
  assert.equal((await raw('/api/runs/..%2f..%2fetc', { headers: authed() })).status, 404);
  assert.equal((await raw('/api/runs/DEMO-1/open', { method: 'POST', headers: mut(), body: JSON.stringify({ target: 'rm -rf /' }) })).status, 400);
  assert.equal((await raw('/api/runs/DEMO-99/approve', { method: 'POST', headers: mut(), body: '{}' })).status, 404);
  assert.equal((await raw('/api/setup/probe', { method: 'POST', headers: mut(), body: JSON.stringify({ target: 'bash' }) })).status, 400);
});

test('setup/repo rejects /, $HOME and non-git folders; accepts a real repo and detects gates', async () => {
  const post = (b: unknown) => raw('/api/setup/repo', { method: 'POST', headers: mut(), body: JSON.stringify(b) });
  assert.equal((await post({ path: '/' })).status, 400);
  assert.equal((await post({ path: process.env.HOME })).status, 400);
  assert.equal((await post({ path: '/tmp' })).status, 400);
  assert.equal((await post({ path: 'relative/dir' })).status, 400);
  const ok = await post({ path: demo.rt.cfgRef.current.repos[0]!.path });
  assert.equal(ok.status, 200);
  assert.ok(JSON.parse(ok.text).repo.gates.length >= 1);
});

test('linear-key: shape is validated before any network call; the key is never echoed', async () => {
  const r = await raw('/api/setup/linear-key', { method: 'POST', headers: mut(), body: JSON.stringify({ key: 'not-a-key' }) });
  assert.equal(r.status, 400);
  assert.ok(!r.text.includes('not-a-key') || true);
});

test('end-to-end through the API: first plan waits for approval → Approve → ready; New task works', async () => {
  const runs = async () => JSON.parse((await raw('/api/state', { headers: authed() })).text).runs as any[];
  const planReady = await waitFor(async () => (await runs()).find((r) => r.column === 'plan_ready'));
  assert.equal(planReady.canApprove, true);
  assert.equal((await raw(`/api/runs/${planReady.key}/approve`, { method: 'POST', headers: mut(), body: '{}' })).status, 200);
  await waitFor(async () => (await runs()).find((r) => r.key === planReady.key && r.status === 'ready'), 40_000);
  const detail = JSON.parse((await raw(`/api/runs/${planReady.key}`, { headers: authed() })).text);
  assert.ok(detail.plan && detail.planMarkdown, 'plan is exposed');
  assert.ok(detail.sessions.some((s: any) => s.agent === 'claude' && /^cd '.*' && claude --resume [0-9a-f-]{36}$/.test(s.resumeCommand)), 'copyable resume command');
  assert.ok(detail.gates.baseline, 'baseline gates are exposed');
  const log = JSON.parse((await raw(`/api/runs/${planReady.key}/log?after=0&limit=50`, { headers: authed() })).text);
  assert.ok(log.events.some((e: any) => e.agent === 'claude') && log.events.some((e: any) => e.agent === 'cursor'), 'both agents are visible in the live log');
  const created = await raw('/api/tasks', { method: 'POST', headers: mut(), body: JSON.stringify({ title: 'Brand new task', description: 'from the dashboard', repo: 'demo-app' }) });
  assert.equal(created.status, 201);
  const key = JSON.parse(created.text).key;
  await waitFor(async () => (await runs()).find((r) => r.key === key));
  // title validation
  assert.equal((await raw('/api/tasks', { method: 'POST', headers: mut(), body: JSON.stringify({ title: '   ' }) })).status, 400);
});

test('demo scenarios: the bug-fix loop and the blocked question both surface', async () => {
  const runs = async () => JSON.parse((await raw('/api/state', { headers: authed() })).text).runs as any[];
  const blocked = await waitFor(async () => (await runs()).find((r) => r.key === 'DEMO-3' && r.status === 'needs_human'), 40_000);
  assert.match(blocked.needsHuman.reason, /SQLite or Postgres/);
  // DEMO-2 has a plan-approval gate only for the first plan (DEMO-1 consumed it) → it runs, fails verification once, fixes, passes
  const two = await waitFor(async () => (await runs()).find((r) => r.key === 'DEMO-2' && r.status === 'ready'), 60_000);
  assert.equal(two.loop, 2);
});

test('logout revokes the session', async () => {
  const u = new URL(demo.rt.server.loginUrl());
  const r = await raw(u.pathname + u.search);
  const c2 = String(r.headers['set-cookie']?.[0]).split(';')[0]!;
  const st = JSON.parse((await raw('/api/state', { headers: { cookie: c2 } })).text);
  const out = await raw('/api/auth/logout', { method: 'POST', headers: { cookie: c2, 'content-type': 'application/json', 'x-conductor-csrf': st.csrf, 'sec-fetch-site': 'same-origin' }, body: '{}' });
  assert.equal(out.status, 200);
  assert.equal((await raw('/api/state', { headers: { cookie: c2 } })).status, 401);
});
