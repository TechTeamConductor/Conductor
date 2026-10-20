// M6 commit 2 — policies in the engine: who has to click, risk confirmation, per-project override, forced holds under every policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers/harness.ts';
import { Api } from '../src/server/api.ts';
import { comments } from './helpers/util.ts';

const risky = { testing: { commands: ['git push origin main'], cases: [] } };
const run = async (policy: string | undefined, plan: any = {}, mut?: (h: any) => void) => {
  const h = await makeHarness({ config: (c) => { if (policy) (c.pipeline as any).policy = policy; } });
  mut?.(h);
  h.scenario({ claude: { '*': { plan: [{ json: plan }] } } });
  const key = h.issue('Add the greeting');
  await h.settle();
  return { h, key };
};

test('M6-AC1 (engine): full-auto runs a risky plan; approve-risky holds it with named reasons and needs an explicit confirmation; approve-plan holds even a harmless plan', async () => {
  let r = await run('full-auto', risky);
  try { assert.equal(r.h.run(r.key).status, 'ready'); } finally { await r.h.cleanup(); }
  r = await run('approve-risky');
  try { assert.equal(r.h.run(r.key).status, 'ready', 'a harmless plan runs'); } finally { await r.h.cleanup(); }
  r = await run('approve-risky', risky);
  try {
    const run1 = r.h.run(r.key);
    assert.equal(run1.status, 'awaiting_approval');
    assert.match(run1.holdReasons!.join(), /risky: git push/);
    assert.ok((await comments(r.h, r.key)).some((c) => /risky: git push/.test(c)), 'the reason is on the card');
    assert.throws(() => r.h.engine.approve(r.key, 'human', run1.rev), (e: any) => e.code === 'confirm_required');
    r.h.engine.approve(r.key, 'human', run1.rev, true);
    await r.h.settle();
    assert.equal(r.h.run(r.key).status, 'ready');
  } finally { await r.h.cleanup(); }
  r = await run('approve-plan');
  try { assert.equal(r.h.run(r.key).status, 'awaiting_approval'); } finally { await r.h.cleanup(); }
});

test('forced holds survive full-auto (large change, protected path); the legacy planApproval:manual maps to approve-plan; a project policy overrides the global one', async () => {
  let r = await run('full-auto', { complexity: 'L' });
  try { assert.equal(r.h.run(r.key).status, 'awaiting_approval'); } finally { await r.h.cleanup(); }
  r = await run('full-auto', { filesToChange: [{ path: '.github/workflows/ci.yml', action: 'create', change: 'x', reason: 'AC1' }] });
  try { assert.equal(r.h.run(r.key).status, 'awaiting_approval'); } finally { await r.h.cleanup(); }
  r = await run(undefined, {}, (h) => void (h.cfg.pipeline.planApproval = 'manual'));
  try { assert.equal(r.h.run(r.key).status, 'awaiting_approval'); } finally { await r.h.cleanup(); }
  r = await run('full-auto', {}, (h) => void (h.cfg.projects = { ENG: { policy: 'approve-plan' } } as any));
  try { assert.equal(r.h.run(r.key).status, 'awaiting_approval', 'ENG is stricter than the global default'); } finally { await r.h.cleanup(); }
});

test('project settings API: strict body, full-auto needs an explicit confirmation, the policy is stored per project', async () => {
  const h = await makeHarness();
  try {
    let saved: any = null;
    const api = new Api({ engine: h.engine, store: h.store, board: h.board, auth: {} as any, version: 't', getConfig: () => h.cfg, saveConfig: (c) => { saved = c; }, persistent: () => ({ repos: {} }) as any, health: async () => ({}) as any, probe: async () => ({ ok: true, detail: '', durationMs: 1 }) });
    const put = (b: any) => api.handle('PUT', '/api/projects/ENG/settings', new URLSearchParams(), b) as Promise<any>;
    await assert.rejects(put({ policy: 'yolo' }), (e: any) => e.status === 400);
    await assert.rejects(put({ policy: 'approve-risky', limits: {} }), (e: any) => e.status === 400);
    await assert.rejects(put({ policy: 'full-auto' }), (e: any) => e.code === 'confirm_required');
    assert.equal((await put({ policy: 'approve-risky' })).json.policy, 'approve-risky');
    assert.equal(saved.projects.ENG.policy, 'approve-risky');
    assert.equal((await put({ policy: 'full-auto', confirmFullAuto: true })).json.policy, 'full-auto');
  } finally { await h.cleanup(); }
});
