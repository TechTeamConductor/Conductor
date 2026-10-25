// M8-6 §2.6 (C1 contract) + S12/S15/N2/N8/T8: the brief endpoints, strict bodies, ids before paths, 404/409/429/501, state.home, the board's
// research projection and design origin; CSRF on every new mutation over real HTTP.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHarness, type Harness } from './helpers/harness.ts';
import { briefKit, settled, workReply } from './helpers/briefs.ts';
import { Api } from '../src/server/api.ts';
import { startDemo, type DemoHandle } from '../src/demo.ts';
import { rmSync } from 'node:fs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
function apiFor(h: Harness, kit?: ReturnType<typeof briefKit>) {
  const health = async () => ({ claude: { found: true, ok: true, detail: '' }, cursor: { found: true, ok: true, detail: '' }, codex: { found: false, ok: false, detail: '' }, warnings: [] }) as any;
  const api = new Api({ engine: h.engine, store: h.store, board: h.board, csrf: 'x', version: 't', getConfig: () => h.cfg, saveConfig: () => undefined, persistent: () => ({ repos: {} }) as any, health, probe: async () => ({ ok: true, detail: '', durationMs: 1 }), ...(kit ? { briefs: kit.briefs, asks: kit.asks } : {}) });
  const call = (m: string, p: string, b: any = {}) => api.handle(m, p, new URLSearchParams(), b) as Promise<any>;
  return { api, call };
}

test('AC-6.11 strict bodies, ids by regex before any path, 404s, 501 without the service', async () => {
  const h = await makeHarness();
  try {
    const none = apiFor(h);
    await assert.rejects(none.call('POST', '/api/briefs', { kind: 'work', line: 'x' }), (e: any) => e.status === 501 && e.code === 'not_available');
    const kit = briefKit(h);
    const { call } = apiFor(h, kit);
    for (const body of [{ kind: 'work', line: 'x', selRole: 'research' }, { kind: 'work', line: 'x', createdBy: 'user' }, { kind: 'nope', line: 'x' }, { kind: 'work' }, { kind: 'work', line: 'x'.repeat(4001) }, [], Object.create({ kind: 'work', line: 'x' })]) {
      await assert.rejects(call('POST', '/api/briefs', body), (e: any) => e.status === 400, JSON.stringify(body));
    }
    for (const bad of ['..', 'brf-xyz', 'brf-0123', '%2e%2e%2fetc', 'brf-0123456789ABCDEF', 'ask-0123456789abcdef']) {
      await assert.rejects(call('GET', `/api/briefs/${bad}`), (e: any) => e.status === 404, bad);
      await assert.rejects(call('POST', `/api/briefs/${bad}/send`, { parts: ['P1'] }), (e: any) => e.status === 404, bad);
      await assert.rejects(call('POST', `/api/briefs/${bad}/cancel`, {}), (e: any) => e.status === 404, bad);
      await assert.rejects(call('DELETE', `/api/briefs/${bad}`), (e: any) => e.status === 404, bad);
    }
    await assert.rejects(call('GET', '/api/briefs/brf-0123456789abcdef'), (e: any) => e.status === 404);
    h.scenario({ claude: { '*': { design: [{ json: workReply() }] } } });
    const r = await call('POST', '/api/briefs', { kind: 'work', line: 'Add CSV export' });
    assert.equal(r.status, 202);
    assert.equal(r.json.untrusted, true);
    await kit.briefs.idle();
    const g = await call('GET', `/api/briefs/${r.json.id}`);
    assert.equal(g.json.status, 'ready');
    for (const k of ['schemaVersion', 'takenKey', 'refunded', 'events']) assert.ok(!(k in g.json), k);
    assert.equal((await call('GET', '/api/briefs')).json.briefs[0].title, 'Add CSV export');
    await assert.rejects(call('POST', `/api/briefs/${r.json.id}/cancel`, { x: 1 }), (e: any) => e.status === 400);
    await assert.rejects(call('POST', `/api/briefs/${r.json.id}/send`, { depth: 'deep' }), (e: any) => e.status === 400, 'a work brief takes parts');
    await assert.rejects(call('POST', `/api/briefs/${r.json.id}/send`, { parts: ['P1'], title: 'x' }), (e: any) => e.status === 400);
    const s = await call('POST', `/api/briefs/${r.json.id}/send`, { parts: ['P1', 'P2'] });
    assert.equal(s.status, 201);
    assert.equal(s.json.keys.length, 2);
    // the board: design origin derived from the strict idemKey; research projection present
    const b = (await call('GET', '/api/board')).json;
    const mine = b.items.filter((i: any) => i.design);
    assert.deepEqual(mine.map((i: any) => [i.design.part, i.design.parts]), [[1, 2], [2, 2]]);
    assert.ok(Array.isArray(b.research));
    const it = (await call('GET', `/api/items/${s.json.keys[1]}`)).json;
    assert.deepEqual(it.blockedBy, [{ key: s.json.keys[0], lane: 'todo' }], 'N3');
    assert.deepEqual((await call('DELETE', `/api/briefs/${r.json.id}`)).json, { ok: true });
    assert.equal((await call('GET', '/api/board')).json.items.filter((i: any) => i.design).length, 0, 'origin only while the brief exists');
    assert.equal(h.board.items().filter((i) => i.createdBy === 'design').length, 2, 'sent cards are untouched by DELETE');
  } finally { await h.cleanup(); }
});

test('error shapes: choose_repo carries repos, limited carries retryAt, 429 names its counter; state.home', async () => {
  const h = await makeHarness();
  try {
    const gate = { v: { ok: true } as any };
    const kit = briefKit(h, { accountsGate: () => gate.v });
    const { api, call } = apiFor(h, kit);
    h.cfg.repos.push({ ...h.cfg.repos[0]!, name: 'second' });
    await assert.rejects(call('POST', '/api/briefs', { kind: 'work', line: 'x' }), (e: any) => e.status === 400 && e.code === 'choose_repo' && e.extra.repos.join() === 'demo,second');
    gate.v = { ok: false, retryAt: 1_900_000_000_000, message: 'limited' };
    await assert.rejects(call('POST', '/api/briefs', { kind: 'work', line: 'x', repo: 'demo' }), (e: any) => e.status === 409 && e.code === 'limited' && e.extra.retryAt === 1_900_000_000_000);
    gate.v = { ok: true };
    h.cfg.pipeline.designPerHour = 1;
    h.scenario({ claude: { '*': { design: [{ json: workReply() }] } } });
    await call('POST', '/api/briefs', { kind: 'work', line: 'x', repo: 'demo' });
    await kit.briefs.idle();
    await assert.rejects(call('POST', '/api/briefs', { kind: 'work', line: 'y', repo: 'demo' }), (e: any) => e.status === 429 && e.code === 'limit' && /designPerHour/.test(e.message));
    const st = await api.state();
    assert.deepEqual(st.home, { design: true, researchBrief: true, limits: { designPerHour: 1, designUsed: 1, researchPerDay: h.cfg.pipeline.researchPerDay, researchUsed: 0 } });
    assert.equal((await apiFor(h).api.state()).home, undefined, 'absent without the service');
  } finally { await h.cleanup(); }
});

test('N2 /api/ask stays closed: research with brief | depth | briefId | selRole ⇒ 400; api.ts never calls startResearchFromBrief', async () => {
  const h = await makeHarness();
  try {
    const kit = briefKit(h);
    const { call } = apiFor(h, kit);
    for (const k of ['brief', 'depth', 'briefId', 'selRole']) await assert.rejects(call('POST', '/api/ask', { mode: 'research', question: 'q', [k]: k === 'depth' ? 'deep' : 'x' }), (e: any) => e.status === 400, k);
    const src = readFileSync(join(ROOT, 'src/server/api.ts'), 'utf8');
    assert.doesNotMatch(src, /startResearchFromBrief/);
    assert.doesNotMatch(src, /selRole/);
  } finally { await h.cleanup(); }
});

test('N8: 50 board fetches ⇒ at most 1 full ask scan (projection cached, invalidated on save); S15 dismiss is strict + idempotent', async () => {
  const h = await makeHarness();
  try {
    const kit = briefKit(h);
    const { call } = apiFor(h, kit);
    const q = await call('POST', '/api/ask', { mode: 'research', question: 'Which queue library?', repo: 'demo' });
    await kit.asks.idle();
    const before = kit.asks.scans;
    for (let i = 0; i < 50; i++) await call('GET', '/api/board');
    assert.ok(kit.asks.scans - before <= 1, String(kit.asks.scans - before));
    const card = (await call('GET', '/api/board')).json.research[0];
    assert.equal(card.lane, 'review');
    await assert.rejects(call('POST', `/api/asks/${q.json.id}/dismiss`, { x: 1 }), (e: any) => e.status === 400);
    await assert.rejects(call('POST', '/api/asks/ask-zz/dismiss', {}), (e: any) => e.status === 404);
    const d = await call('POST', `/api/asks/${q.json.id}/dismiss`, {});
    assert.ok(d.json.dismissedAt > 0);
    assert.equal((await call('GET', '/api/board')).json.research[0].lane, 'done', 'cache invalidated on save');
  } finally { await h.cleanup(); }
});

test('S9 static: the actor literal "design" is written only from src/board/*, src/runtime.ts and src/briefs/*; UserBoard never passes another actor', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n.endsWith('.ts') ? [join(d, n)] : []));
  const offenders: string[] = [];
  for (const f of walk(join(ROOT, 'src'))) {
    const rel = f.slice(ROOT.length);
    if (/^src\/(board|briefs)\//.test(rel) || rel === 'src/runtime.ts') continue;
    const src = readFileSync(f, 'utf8');
    // `id: 'design'` in src/models/select.ts is the UI's job-row id (M8-2), not a board actor
    for (const m of src.matchAll(/'design'/g)) if (!(rel === 'src/models/select.ts' && /id: $/.test(src.slice(Math.max(0, m.index! - 4), m.index)))) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
  const store = readFileSync(join(ROOT, 'src/board/store.ts'), 'utf8');
  const user = store.slice(store.indexOf('export class UserBoard'));
  const calls = [...user.matchAll(/this\.#b\.(createItem|addComment|setFields|setLane|setDependsOn|createMilestone|addDecision)\(([\s\S]*?)\);/g)];
  const actors = calls.map((m) => /'([a-z-]+)'\s*,?\s*$/.exec(m[2]!)?.[1]);
  assert.ok(calls.length >= 6 && actors.every((a) => a === 'user'), JSON.stringify(actors));
  // the briefs code never builds or starts a build (envelope / runBuild)
  for (const f of walk(join(ROOT, 'src/briefs'))) assert.doesNotMatch(readFileSync(f, 'utf8'), /envelope|runBuild/, f);
});

// ─────────────── T8: CSRF / Sec-Fetch on every new mutation, over real HTTP ───────────────
let demo: DemoHandle;
let port = 0;
let csrf = '';
function raw(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: t }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
before(async () => {
  demo = await startDemo({ port: 0, pollMs: 60_000, delayMs: 15 });
  port = demo.rt.server.listeningPort;
  csrf = JSON.parse((await raw('/api/state')).text).csrf;
});
after(async () => {
  await demo.close();
  rmSync(demo.home, { recursive: true, force: true });
});

test('T8: 403 without CSRF / cross-site on POST /api/briefs, cancel, send, DELETE and dismiss; state.home over HTTP', async () => {
  const id = 'brf-0123456789abcdef';
  const routes: [string, string, unknown][] = [['POST', '/api/briefs', { kind: 'work', line: 'x' }], ['POST', `/api/briefs/${id}/cancel`, {}], ['POST', `/api/briefs/${id}/send`, { parts: ['P1'] }], ['DELETE', `/api/briefs/${id}`, undefined], ['POST', '/api/asks/ask-0123456789abcdef/dismiss', {}]];
  for (const [method, path, b] of routes) {
    const body = b === undefined ? undefined : JSON.stringify(b);
    const base = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' };
    assert.equal((await raw(path, { method, headers: base, body })).status, 403, `${method} ${path}: no CSRF`);
    assert.equal((await raw(path, { method, headers: { ...base, 'x-conductor-csrf': csrf, 'sec-fetch-site': 'cross-site' }, body })).status, 403, `${method} ${path}: cross-site`);
    const ok = await raw(path, { method, headers: { ...base, 'x-conductor-csrf': csrf }, body });
    assert.notEqual(ok.status, 403, `${method} ${path}: with CSRF`);
  }
  const st = JSON.parse((await raw('/api/state')).text);
  assert.equal(st.home.design, true);
  const bad = await raw('/api/briefs', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-conductor-csrf': csrf }, body: JSON.stringify({ kind: 'work', line: 'x', repo: 'nope' }) });
  assert.equal(bad.status, 400);
  assert.equal(JSON.parse(bad.text).error.code, 'bad_request');
});
