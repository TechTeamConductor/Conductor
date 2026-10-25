import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { startDemo, type DemoHandle } from '../src/demo.ts';

let demo: DemoHandle;
let base = '';
let port = 0;
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
const mut = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-conductor-csrf': csrf, 'sec-fetch-site': 'same-origin', ...extra });

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
  const st = await raw('/api/state');
  csrf = JSON.parse(st.text).csrf;
});
after(async () => {
  await demo.close();
  rmSync(demo.home, { recursive: true, force: true });
});

test('no sign-in: the UI and the API answer without any cookie; the removed login routes do not exist', async () => {
  assert.equal((await raw('/')).status, 200);
  assert.equal((await raw('/app.js')).status, 200);
  assert.equal((await raw('/modes.js')).status, 200);
  assert.equal((await raw('/api/state')).status, 200);
  for (const [method, path] of [['GET', '/login'], ['GET', '/auth'], ['GET', '/auth?otp=x'], ['POST', '/auth'], ['GET', '/otp'], ['POST', '/otp']] as const) {
    assert.equal((await raw(path, { method })).status, 404, `${method} ${path}`);
  }
  assert.equal((await raw('/api/auth/logout', { method: 'POST', headers: mut(), body: '{}' })).status, 404, 'no logout route');
});

test('no Set-Cookie anywhere; every response carries security headers; the page and scripts never contain the CSRF token', async () => {
  const st = await raw('/api/state');
  const tok = JSON.parse(st.text).csrf as string;
  for (const p of ['/', '/app.js', '/modes.js', '/style.css', '/api/state']) {
    const s = await raw(p);
    assert.equal(s.headers['set-cookie'], undefined, `${p} sets no cookie`);
    assert.match(String(s.headers['content-security-policy']), /default-src 'self'/);
    assert.match(String(s.headers['content-security-policy']), /style-src 'self'/);
    assert.match(String(s.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(s.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(s.headers['x-content-type-options'], 'nosniff');
    assert.equal(s.headers['referrer-policy'], 'no-referrer');
    assert.equal(s.headers['cache-control'], 'no-store');
    if (p !== '/api/state') assert.ok(!s.text.includes(tok), `${p} must not carry the CSRF token`);
  }
  const sse = await new Promise<string>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; if (t.includes('event: state')) { resolve(t); r.destroy(); } });
    });
    r.on('error', (e) => ((e as any).code === 'ECONNRESET' ? undefined : reject(e)));
    r.end();
  });
  assert.ok(!sse.includes(tok), 'the event stream never carries the CSRF token');
});

test('wrong Host header (DNS rebinding) is refused', async () => {
  assert.equal((await raw('/api/state', { host: 'evil.example.com' })).status, 421);
  assert.equal((await raw('/api/state', { host: `127.0.0.1:${port + 1}` })).status, 421);
  assert.equal((await raw('/api/state', { host: `localhost:${port}` })).status, 200);
});

test('state has the contract fields and the demo runs', async () => {
  const s = JSON.parse((await raw('/api/state')).text);
  for (const k of ['now', 'version', 'csrf', 'setup', 'health', 'quota', 'engine', 'settings', 'repos', 'runs']) assert.ok(k in s, k);
  assert.equal(s.setup.complete, true);
  assert.ok(s.runs.length >= 1);
  for (const r of s.runs) for (const k of ['key', 'title', 'status', 'column', 'activity', 'canApprove', 'canRetry', 'canAbort', 'loop', 'maxLoops']) assert.ok(k in r, `run.${k}`);
});

test('mutations: CSRF, content-type, same-origin and body-size are enforced', async () => {
  const body = JSON.stringify({ paused: false });
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body })).status, 403, 'missing CSRF');
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: mut({ 'x-conductor-csrf': 'wrong' }), body })).status, 403, 'wrong CSRF');
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: mut({ 'content-type': 'text/plain' }), body })).status, 415);
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: mut({ 'sec-fetch-site': 'cross-site' }), body })).status, 403, 'cross-site');
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: { ...mut(), 'sec-fetch-site': '' }, body })).status >= 400, true);
  const noFetchMeta = mut();
  delete (noFetchMeta as any)['sec-fetch-site'];
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: noFetchMeta, body })).status, 403, 'neither Sec-Fetch-Site nor Origin');
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: { ...noFetchMeta, origin: 'http://evil.example' }, body })).status, 403, 'foreign Origin');
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: { ...noFetchMeta, origin: `http://127.0.0.1:${port}` }, body })).status, 200, 'same Origin ok without Sec-Fetch');
  // another localhost port is SAME-SITE, not same-origin: both signals must be refused
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: { ...noFetchMeta, origin: `http://127.0.0.1:${port + 1}` }, body })).status, 403, 'Origin of another localhost port');
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: { ...noFetchMeta, origin: `http://localhost:${port + 1}` }, body })).status, 403, 'Origin of another localhost name and port');
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: mut({ 'sec-fetch-site': 'same-site' }), body })).status, 403, 'same-site (another localhost port) is not same-origin');
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: mut(), body: 'not json' })).status, 400);
  const big = Buffer.alloc(1024 * 1024 + 10, 'a');
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: mut(), body: big })).status, 413);
  assert.equal((await raw('/api/engine/pause', { method: 'POST', headers: mut(), body })).status, 200);
});

test('static files are an exact whitelist: traversal, siblings and dotfiles are never served', async () => {
  for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/app.js/../../package.json', '/ui/index.html', '/index.html', '/package.json', '/.env', '/src/cli.ts', '/prompts/plan.md', '//etc/passwd']) {
    const r = await raw(p);
    assert.ok(r.status === 404 || r.status === 400 || r.status === 421, `${p} → ${r.status}`);
    assert.ok(!/"name"|root:/.test(r.text), `${p} leaked content`);
  }
  assert.equal((await raw('/')).status, 200);
  assert.equal((await raw('/app.js')).status, 200);
  assert.equal((await raw('/style.css')).status, 200);
});

test('SSE: authenticated stream delivers an initial state event', async () => {
  const chunk = await new Promise<string>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
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
  assert.equal((await raw('/api/runs/NOPE-1')).status, 404);
  assert.equal((await raw('/api/runs/..%2f..%2fetc')).status, 404);
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

test('the old Linear endpoints no longer exist; probe accepts only claude/cursor', async () => {
  assert.equal((await raw('/api/setup/linear-key', { method: 'POST', headers: mut(), body: JSON.stringify({ key: 'lin_api_' + 'x'.repeat(30) }) })).status, 404);
  assert.equal((await raw('/api/setup/team', { method: 'POST', headers: mut(), body: '{}' })).status, 404);
  assert.equal((await raw('/api/setup/probe', { method: 'POST', headers: mut(), body: JSON.stringify({ target: 'linear' }) })).status, 400);
});

test('board API: cards are created/commented/moved only through server-side authorship; Conductor-owned lanes and forged fields are refused', async () => {
  const created = await raw('/api/tasks', { method: 'POST', headers: mut(), body: JSON.stringify({ title: 'Authorship test', description: 'x', repo: 'demo-app', author: 'conductor', createdBy: 'conductor', kind: 'bug', lane: 'review', key: 'DEMO-999', id: 'chosen' }) });
  assert.equal(created.status, 201);
  const key = JSON.parse(created.text).key;
  assert.notEqual(key, 'DEMO-999');
  const item = JSON.parse((await raw(`/api/items/${key}`)).text).item;
  assert.equal(item.createdBy, 'user');
  assert.equal(item.kind, 'work');
  assert.notEqual(item.id, 'chosen');
  // comments are always the user's
  const c = await raw(`/api/items/${key}/comment`, { method: 'POST', headers: mut(), body: JSON.stringify({ body: 'hello', author: 'conductor' }) });
  assert.equal(c.status, 201);
  assert.equal(JSON.parse(c.text).comment.author, 'user');
  // lanes: only the four human lanes, through the engine
  assert.equal((await raw(`/api/items/${key}/move`, { method: 'POST', headers: mut(), body: JSON.stringify({ lane: 'review' }) })).status, 400);
  assert.equal((await raw(`/api/items/${key}/move`, { method: 'POST', headers: mut(), body: JSON.stringify({ lane: 'active' }) })).status, 400);
  // mutation rules apply to the new routes too
  assert.equal((await raw(`/api/items/${key}/comment`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ body: 'no csrf' }) })).status, 403);
  assert.equal((await raw(`/api/items/${key}/comment`, { method: 'POST', headers: mut({ 'sec-fetch-site': 'cross-site' }), body: JSON.stringify({ body: 'x' }) })).status, 403);
  assert.equal((await raw('/api/items/NOPE-1/comment', { method: 'POST', headers: mut(), body: JSON.stringify({ body: 'x' }) })).status, 404);
  assert.equal((await raw('/api/items/..%2f..%2fetc/comment', { method: 'POST', headers: mut(), body: JSON.stringify({ body: 'x' }) })).status, 404);
  assert.equal((await raw('/api/items/%E0%A4%A/comment', { method: 'POST', headers: mut(), body: JSON.stringify({ body: 'x' }) })).status, 400, 'malformed escapes are a 400, not an exception');
  assert.equal((await raw(`/api/items/${key}/comment`, { method: 'POST', headers: mut(), body: JSON.stringify({ body: 'z'.repeat(20_001) }) })).status, 400);
  assert.equal((await raw(`/api/items/${key}/edit`, { method: 'POST', headers: mut(), body: JSON.stringify({ title: 't'.repeat(201) }) })).status, 400);
  assert.equal((await raw('/api/projects', { method: 'POST', headers: mut(), body: JSON.stringify({ key: 'lower', name: 'x' }) })).status, 400);
  assert.equal((await raw('/api/projects', { method: 'POST', headers: mut(), body: JSON.stringify({ key: 'ABC', name: 'x', repo: '../../etc' }) })).status, 400);
});

test('end-to-end through the API: first plan waits for approval → Approve → ready; New task works', async () => {
  const runs = async () => JSON.parse((await raw('/api/state')).text).runs as any[];
  const planReady = await waitFor(async () => (await runs()).find((r) => r.column === 'plan_ready' && r.canApprove)); // Plan review also shows a run while the reviewer is still working (not yet approvable)
  assert.equal(planReady.canApprove, true);
  assert.equal((await raw(`/api/runs/${planReady.key}/approve`, { method: 'POST', headers: mut(), body: JSON.stringify({ rev: planReady.rev }) })).status, 200);
  await waitFor(async () => (await runs()).find((r) => r.key === planReady.key && r.status === 'ready'), 40_000);
  const detail = JSON.parse((await raw(`/api/runs/${planReady.key}`)).text);
  assert.ok(detail.plan && detail.planMarkdown, 'plan is exposed');
  assert.ok(detail.sessions.some((s: any) => s.agent === 'claude' && /^cd '.*' && claude --resume [0-9a-f-]{36}$/.test(s.resumeCommand)), 'copyable resume command');
  assert.ok(detail.gates.baseline, 'baseline gates are exposed');
  const log = JSON.parse((await raw(`/api/runs/${planReady.key}/log?after=0&limit=50`)).text);
  assert.ok(log.events.some((e: any) => e.agent === 'claude') && log.events.some((e: any) => e.agent === 'cursor'), 'both agents are visible in the live log');
  const created = await raw('/api/tasks', { method: 'POST', headers: mut(), body: JSON.stringify({ title: 'Brand new task', description: 'from the dashboard', repo: 'demo-app' }) });
  assert.equal(created.status, 201);
  const key = JSON.parse(created.text).key;
  await waitFor(async () => (await runs()).find((r) => r.key === key));
  // title validation
  assert.equal((await raw('/api/tasks', { method: 'POST', headers: mut(), body: JSON.stringify({ title: '   ' }) })).status, 400);
});

test('demo scenarios: the bug-fix loop and the blocked question both surface', async () => {
  const runs = async () => JSON.parse((await raw('/api/state')).text).runs as any[];
  const blocked = await waitFor(async () => (await runs()).find((r) => r.key === 'DEMO-3' && r.status === 'needs_human'), 40_000);
  assert.match(blocked.needsHuman.reason, /SQLite or Postgres/);
  // DEMO-2 runs, fails verification once, fixes, passes. Whether it waits for plan approval depends on whether DEMO-1's approval was already
  // counted when DEMO-2's plan finished (they plan in parallel) — so the test approves it if it is waiting instead of relying on timing.
  const two = await waitFor(async () => {
    const r = (await runs()).find((x) => x.key === 'DEMO-2');
    if (r?.canApprove) await raw('/api/runs/DEMO-2/approve', { method: 'POST', headers: mut(), body: JSON.stringify({ rev: r.rev }) });
    return r && r.status === 'ready' ? r : null;
  }, 60_000);
  assert.equal(two.loop, 2);
});

test('approve needs the plan revision: a missing or stale revision is refused, the current one approves', async () => {
  const runs = async () => JSON.parse((await raw('/api/state')).text).runs as any[];
  demo.rt.cfgRef.current.pipeline.planApproval = 'manual'; // force an approval gate regardless of what earlier tests consumed
  const created = await raw('/api/tasks', { method: 'POST', headers: mut(), body: JSON.stringify({ title: 'Needs approval', description: 'x', repo: 'demo-app' }) });
  const key = JSON.parse(created.text).key;
  const waiting = await waitFor(async () => (await runs()).find((r) => r.key === key && r.canApprove), 40_000);
  assert.equal((await raw(`/api/runs/${key}/approve`, { method: 'POST', headers: mut(), body: '{}' })).status, 400, 'rev is required');
  assert.equal((await raw(`/api/runs/${key}/approve`, { method: 'POST', headers: mut(), body: JSON.stringify({ rev: waiting.rev + 5 }) })).status, 409, 'a stale rev is refused');
  assert.equal((await raw(`/api/runs/${key}/approve`, { method: 'POST', headers: mut(), body: JSON.stringify({ rev: waiting.rev }) })).status, 200, 'the current rev approves');
  assert.equal((await raw(`/api/runs/${key}/approve`, { method: 'POST', headers: mut(), body: JSON.stringify({ rev: waiting.rev }) })).status, 409, 'a second approval is refused');
  demo.rt.cfgRef.current.pipeline.planApproval = 'first';
});

test('run-less cards (Backlog) are in state AND in the live feed; moving one to To do starts it and it leaves the card list; detail carries notes + park/finish flags', async () => {
  const project = demo.board.projects()[0]!;
  const card = demo.board.user.createItem({ projectId: project.id, title: 'Parked idea', description: 'later', lane: 'backlog' });
  const st = JSON.parse((await raw('/api/state')).text);
  assert.ok(st.cards.some((c: any) => c.key === card.key && c.lane === 'backlog'), 'listed as a card');
  assert.ok(!st.runs.some((r: any) => r.key === card.key), 'no run yet');
  // the live (SSE) feed carries the same list, so a card never shows twice while it is being claimed
  const live = demo.rt.api.live();
  assert.ok(live.cards.some((c) => c.key === card.key));
  assert.equal((await raw(`/api/items/${card.key}/move`, { method: 'POST', headers: mut(), body: JSON.stringify({ lane: 'todo' }) })).status, 200);
  await waitFor(async () => JSON.parse((await raw('/api/state')).text).runs.find((r: any) => r.key === card.key));
  const st2 = JSON.parse((await raw('/api/state')).text);
  assert.ok(!st2.cards.some((c: any) => c.key === card.key), 'a card with a run is no longer listed as a plain card');
  const detail = JSON.parse((await raw(`/api/runs/${card.key}`)).text);
  assert.ok(Array.isArray(detail.notes) && detail.notes.some((n: any) => n.author === 'conductor' && /picked this up/.test(n.body)), 'Conductor narration is exposed as notes');
  assert.equal(detail.canPark, true);
  assert.equal(detail.canFinish, true);
  assert.equal(detail.url, '', 'no external page');
});

// ───────────── security review: H4 (code never on a command line), M11 (`//`), M2 (cross-site reads) ─────────────
test('M11: `GET //` and over-long URLs get a quiet 400 — no exception, no 500', async () => {
  assert.equal((await raw('//')).status, 400);
  assert.equal((await raw('//evil.example/x')).status, 400);
  assert.equal((await raw('/' + 'a'.repeat(5000))).status, 400);
  assert.equal((await raw('/api/state')).status, 200, 'the server is still fine');
});

test('M2: cross-site reads of the API / event stream are refused; same-origin reads work', async () => {
  assert.equal((await raw('/api/state', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await raw('/api/events', { headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
  assert.equal((await raw('/api/state', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
});
