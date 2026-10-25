import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers/harness.ts';
import { Api } from '../src/server/api.ts';

test('context API: key validated before any path, scan builds the store, settings are strict and clamped and say that summaries spend quota', async () => {
  const h = await makeHarness();
  try {
    let saved: any = null;
    const api = new Api({ engine: h.engine, store: h.store, board: h.board, csrf: 'x', version: 't', getConfig: () => h.cfg, saveConfig: (c) => { saved = c; }, persistent: () => ({ repos: {} }) as any, health: async () => ({}) as any, probe: async () => ({ ok: true, detail: '', durationMs: 1 }) });
    const call = (m: string, p: string, b: any = {}) => api.handle(m, p, new URLSearchParams(), b) as Promise<any>;
    for (const bad of ['..', 'eng', 'ENGINEER', 'E%2FG', 'NOPE']) await assert.rejects(call('GET', `/api/projects/${bad}/context`), (e: any) => e.status === 404, bad);
    assert.equal((await call('GET', '/api/projects/ENG/context')).json.status.state, 'missing');
    const scan = await call('POST', '/api/projects/ENG/context/scan', { full: true });
    assert.equal(scan.json.action, 'full');
    const g = (await call('GET', '/api/projects/ENG/context')).json;
    assert.equal(g.status.state, 'fresh');
    assert.ok(g.facts.modules >= 1);
    await assert.rejects(call('POST', '/api/projects/ENG/context/scan', { full: 'yes' }), (e: any) => e.status === 400);
    await assert.rejects(call('POST', '/api/projects/ENG/context/scan', { evil: 1 }), (e: any) => e.status === 400);
    await assert.rejects(call('PUT', '/api/projects/ENG/context/settings', { summaries: 'on' }), (e: any) => e.status === 400);
    await assert.rejects(call('PUT', '/api/projects/ENG/context/settings', { policy: 'x' }), (e: any) => e.status === 400);
    const r = await call('PUT', '/api/projects/ENG/context/settings', { summaries: true, packBytes: 10 ** 9, staleDays: 0 });
    assert.deepEqual(r.json.context, { summaries: true, staleDays: 1, packBytes: 32768 });
    assert.match(r.json.notice, /spend model quota/);
    assert.equal(saved.projects.ENG.context.summaries, true);
  } finally { await h.cleanup(); }
});
