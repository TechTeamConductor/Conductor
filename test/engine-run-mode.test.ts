// M8-4 commit 1 — the run-mode overlay in the engine (driven by setting `pipeline.runMode` on the harness config; the only writer,
// PUT /api/run-mode, lands in commit 2).
//   T2 forced holds still stop under Complete auto (every TAINTED_ACTORS actor, L, protected path, > 8 tasks); stored holds do not
//   T3 (engine part) waiting plans are never approved by the mode (on, tick, recover) and approved runs are never re-held (off)
//   N3e a run held before M8-4 (no forcedHold on disk) counts as forced in the view
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeHarness, TestClock, type Harness } from './helpers/harness.ts';
import { Api } from '../src/server/api.ts';
import { applySettings } from '../src/config.ts';
import { comments } from './helpers/util.ts';
import { graphPlan, item } from './helpers/graphs.ts';
import { TAINTED_ACTORS } from '../src/board/types.ts';
import { RunStore } from '../src/store.ts';
import { toSummary } from '../src/pipeline/view.ts';

const RISKY = { testing: { commands: ['git push origin main'], cases: [] } };
const PROTECTED = { filesToChange: [{ path: '.github/workflows/ci.yml', action: 'create', change: 'x', reason: 'AC1' }] };
const AUTO_LINE = 'Plan approved automatically (Complete auto)';
const lines = (h: Harness, key: string) => h.run(key).history.map((x) => x.text);

const harness = (stored: { policy?: string; planApproval?: 'auto' | 'manual' | 'first'; project?: string }, plan: any = {}) =>
  makeHarness({
    config: (c) => {
      (c.pipeline as any).runMode = 'complete-auto';
      if (stored.policy) (c.pipeline as any).policy = stored.policy;
      if (stored.planApproval) c.pipeline.planApproval = stored.planApproval;
      if (stored.project) c.projects = { ENG: { policy: stored.project } } as any;
    },
  }).then((h) => {
    h.scenario({ claude: { '*': { plan: [{ json: plan }] } } });
    return h;
  });

test('T2 engine-run-mode: a card from EVERY TAINTED_ACTORS actor builds without a click under Complete auto', async () => {
  assert.ok(TAINTED_ACTORS.length >= 3);
  for (const actor of TAINTED_ACTORS) {
    const h = await harness({ policy: 'approve-plan' });
    try {
      const key = h.board.createItem({ projectId: h.projectId, title: `from ${actor}`, description: 'x', lane: 'todo' }, actor).key;
      await h.settle();
      const r = h.run(key);
      assert.equal(r.untrusted, true, actor);
      assert.equal(r.status, 'ready', actor);
      assert.equal(r.approvedBy, 'auto', actor);
      assert.equal(r.approvedBulk, undefined, actor);
      assert.ok(lines(h, key).some((l) => l.startsWith(AUTO_LINE)), actor);
    } finally { await h.cleanup(); }
  }
});

test('T2 engine-run-mode: large change, protected path and more than 8 tasks build without a click; the history names the lifted holds', async () => {
  const nine = graphPlan(Array.from({ length: 9 }, (_, i) => item(`T${i + 1}`, { criteria: i === 0 ? ['AC1', 'AC2'] : [] })));
  for (const [name, plan, why] of [['L', { complexity: 'L', ...RISKY }, /large change/], ['protected', PROTECTED, /protected files/], ['graph > 8', nine, /more than 8 tasks/]] as const) {
    const h = await harness({ policy: 'approve-plan' }, plan);
    try {
      const key = h.issue('Forced');
      await h.settle();
      const r = h.run(key);
      assert.notEqual(r.status, 'awaiting_approval', name);
      assert.equal(r.approvedBy, 'auto', name);
      assert.ok(lines(h, key).some((l) => l.startsWith(AUTO_LINE) && why.test(l)), `${name}: ${lines(h, key).join(' | ')}`);
    } finally { await h.cleanup(); }
  }
});

test('T2 engine-run-mode: stored approve-plan, project approve-plan, approve-risky + risky plan, planApproval manual and first (0 approved) all build without a click — history says Complete auto', async () => {
  for (const [name, stored, plan] of [
    ['global approve-plan', { policy: 'approve-plan' }, {}],
    ['project approve-plan', { policy: 'full-auto', project: 'approve-plan' }, {}],
    ['manual-stages', { policy: 'manual-stages' }, {}],
    ['approve-risky + risky', { policy: 'approve-risky' }, RISKY],
    ['legacy manual', { planApproval: 'manual' }, {}],
    ['legacy first, 0 approved', { planApproval: 'first' }, {}],
  ] as const) {
    const h = await harness(stored as any, plan);
    try {
      const key = h.issue('Harmless');
      await h.settle();
      const r = h.run(key);
      assert.equal(r.status, 'ready', name);
      assert.equal(r.approvedBy, 'auto', name);
      assert.equal(r.forcedHold, undefined, name);
      assert.ok(lines(h, key).includes(AUTO_LINE), `${name}: the history says why no click was needed`);
      assert.ok(!lines(h, key).includes('Waiting for plan approval'), name);
    } finally { await h.cleanup(); }
  }
  // stored full-auto: Complete auto made no difference ⇒ no extra history line
  const h = await harness({ policy: 'full-auto' });
  try {
    const key = h.issue('Harmless');
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
    assert.ok(!lines(h, key).includes(AUTO_LINE));
  } finally { await h.cleanup(); }
});

test('T3 engine-run-mode: plans already waiting stay waiting when Complete auto turns on (tick, settle, recover) — same rev, reasons, no approvedBy', async () => {
  const h = await makeHarness({ config: (c) => void ((c.pipeline as any).policy = 'approve-plan') });
  try {
    h.scenario({ claude: { '*': { plan: [{ json: {} }] } } });
    const plain = h.issue('Plain, held by the stored policy');
    const imported = h.board.createItem({ projectId: h.projectId, title: 'imported', description: 'x', lane: 'todo' }, 'import').key;
    await h.settle();
    const snap = (k: string) => { const r = h.run(k); return { status: r.status, rev: r.rev, holdReasons: r.holdReasons, approvedBy: r.approvedBy, forcedHold: r.forcedHold }; };
    const before = { plain: snap(plain), imported: snap(imported) };
    assert.equal(before.plain.status, 'awaiting_approval');
    assert.equal(before.plain.forcedHold, false, 'a policy hold is not forced');
    assert.equal(before.imported.forcedHold, true);
    (h.cfg.pipeline as any).runMode = 'complete-auto';
    await h.engine.tick();
    await h.settle();
    h.engine.recover();
    await h.settle();
    assert.deepEqual({ plain: snap(plain), imported: snap(imported) }, before, 'the mode never approves a waiting plan');
    // retrying is a HUMAN action: the new plan passes the gate under the current mode (documented, not "the toggle approving")
  } finally { await h.cleanup(); }
});

test('T3/N5 engine-run-mode: a run approved under Complete auto keeps going after the mode is turned off — never re-held', async () => {
  const h = await harness({ policy: 'approve-plan' });
  try {
    // turn the mode off the moment the gate's auto approval is written (the run is queued for build at that point)
    let flippedAt: string | null = null;
    const update = h.store.update.bind(h.store);
    h.store.update = (k, fn) => {
      const r = update(k, fn);
      if (!flippedAt && r.approvedBy === 'auto' && r.next === 'build') { flippedAt = r.next; (h.cfg.pipeline as any).runMode = 'per-settings'; }
      return r;
    };
    const key = h.issue('Approved before the switch');
    await h.settle();
    assert.equal(flippedAt, 'build', 'the mode was turned off between approval and build');
    assert.equal(h.cfg.pipeline.runMode, 'per-settings');
    assert.equal(h.run(key).status, 'ready');
    assert.ok(!lines(h, key).includes('Waiting for plan approval'));
    // and the next card is decided under Per settings again
    const next = h.issue('After the switch');
    await h.settle();
    assert.equal(h.run(next).status, 'awaiting_approval');
    assert.equal(h.run(next).forcedHold, false);
  } finally { await h.cleanup(); }
});

test('N3e: a run held before M8-4 (no forcedHold on disk) loads without one and counts as forced in the view', async () => {
  const h = await makeHarness({ config: (c) => void ((c.pipeline as any).policy = 'approve-plan') });
  try {
    h.scenario({ claude: { '*': { plan: [{ json: {} }] } } });
    const key = h.issue('Held long ago');
    await h.settle();
    assert.equal(h.run(key).forcedHold, false);
    h.store.update(key, (r) => void delete r.forcedHold); // the pre-slice on-disk shape
    const reloaded = new RunStore(join(h.home, 'runs')).get(key)!;
    assert.equal('forcedHold' in reloaded, false, 'no loader or migration defaults it');
    assert.equal(toSummary(reloaded, h.cfg, Date.now()).forcedHold, true, 'absent = forced (fail closed)');
    assert.equal(toSummary(reloaded, h.cfg, Date.now()).risky, false);
    assert.ok((await comments(h, key)).length > 0);
  } finally { await h.cleanup(); }
});

// ───────────────────────── commit 3: "Approve waiting plans" (T10, AC8, S9b) ─────────────────────────
const apiFor = (h: Harness) => new Api({ engine: h.engine, store: h.store, board: h.board, csrf: 'x', version: 't', getConfig: () => h.cfg, saveConfig: () => undefined, persistent: () => ({ repos: {} }) as any, health: async () => ({}) as any, probe: async () => ({ ok: true, detail: '', durationMs: 1 }) });

test('T10 approve-waiting: only listed, non-forced, no-risk, rev-matching runs are approved — every skip reason, pre-slice holds and design cards (S9b) skipped', async () => {
  const h = await makeHarness({ config: (c) => void ((c.pipeline as any).policy = 'approve-plan') });
  try {
    // keys are assigned in creation order: ENG-1 … ENG-8
    h.scenario({ claude: {
      'ENG-1': { plan: [{ json: {} }] }, // plain ⇒ approved
      'ENG-2': { plan: [{ json: {} }] }, // imported ⇒ forced
      'ENG-3': { plan: [{ json: RISKY }] }, // risky ⇒ risky
      'ENG-4': { plan: [{ json: { complexity: 'L' } }] }, // forced
      'ENG-5': { plan: [{ json: {} }] }, // listed with an old rev ⇒ stale
      'ENG-6': { plan: [{ json: {} }] }, // pre-slice hold (no forcedHold) ⇒ forced
      'ENG-7': { plan: [{ json: {} }] }, // design card, even with its flags cleared ⇒ forced (S9b)
      'ENG-8': { plan: [{ json: {} }] }, // plain, NOT listed ⇒ untouched
      '*': { plan: [{ json: {} }] },
    } });
    const k = [
      h.issue('plain'),
      h.board.createItem({ projectId: h.projectId, title: 'imported', description: 'x', lane: 'todo' }, 'import').key,
      h.issue('risky'),
      h.issue('large'),
      h.issue('stale'),
      h.issue('old hold'),
      h.board.createItem({ projectId: h.projectId, title: 'designed part', description: 'x', lane: 'todo' }, 'design').key,
      h.issue('not listed'),
    ];
    assert.deepEqual(k, ['ENG-1', 'ENG-2', 'ENG-3', 'ENG-4', 'ENG-5', 'ENG-6', 'ENG-7', 'ENG-8']);
    await h.settle();
    for (const key of k) assert.equal(h.run(key).status, 'awaiting_approval', key);
    h.store.update('ENG-6', (r) => void delete r.forcedHold);
    h.store.update('ENG-7', (r) => { r.untrusted = false; r.forcedHold = false; }); // only the card's author still says "design"
    const api = apiFor(h);
    const post = (b: any) => api.handle('POST', '/api/runs/approve-waiting', new URLSearchParams(), b) as Promise<any>;
    const list = [...k.slice(0, 7).map((key) => ({ key, rev: h.run(key).rev })), { key: 'ENG-99', rev: 1 }];
    list[4] = { key: 'ENG-5', rev: h.run('ENG-5').rev + 1 };
    const r = (await post({ runs: list, confirm: true })).json;
    assert.deepEqual(r.approved, ['ENG-1']);
    assert.deepEqual(r.skipped, [
      { key: 'ENG-2', reason: 'forced' }, { key: 'ENG-3', reason: 'risky' }, { key: 'ENG-4', reason: 'forced' }, { key: 'ENG-5', reason: 'stale' },
      { key: 'ENG-6', reason: 'forced' }, { key: 'ENG-7', reason: 'forced' }, { key: 'ENG-99', reason: 'missing' },
    ]);
    assert.equal(h.run('ENG-1').approvedBy, 'human');
    assert.ok(lines(h, 'ENG-1').includes('Plan approved (you, from the waiting list)'), 'N3b distinct history line');
    for (const key of k.slice(1)) assert.equal(h.run(key).status, 'awaiting_approval', `${key} untouched (the server never expands "all")`);
    // a second call: ENG-1 is no longer waiting
    assert.deepEqual((await post({ runs: [{ key: 'ENG-1', rev: h.run('ENG-1').rev }], confirm: true })).json.skipped, [{ key: 'ENG-1', reason: 'not_waiting' }]);
    await h.settle();
    assert.equal(h.run('ENG-1').status, 'ready');
    // strict body
    const bad = async (b: any, code = 'bad_request') => assert.rejects(post(b), (e: any) => e.status === 400 && e.code === code, JSON.stringify(b));
    await bad({ runs: [{ key: 'ENG-8', rev: 1 }] }, 'confirm_required');
    await bad({ runs: [{ key: 'ENG-8', rev: 1 }], confirm: 'yes' });
    await bad({ runs: [], confirm: true });
    await bad({ runs: Array.from({ length: 51 }, (_, i) => ({ key: `ENG-${i + 100}`, rev: 1 })), confirm: true });
    await bad({ runs: [{ key: 'ENG-8', rev: 1 }, { key: 'ENG-8', rev: 1 }], confirm: true });
    await bad({ runs: [{ key: 'ENG-8', rev: 0 }], confirm: true });
    await bad({ runs: [{ key: 'ENG-8', rev: 1.5 }], confirm: true });
    await bad({ runs: [{ key: '../x', rev: 1 }], confirm: true });
    await bad({ runs: [{ key: 'ENG-8', rev: 1, extra: 1 }], confirm: true });
    await bad({ runs: [{ key: 'ENG-8', rev: 1 }], confirm: true, all: true });
    await bad(JSON.parse('{"runs":[{"key":"ENG-8","rev":1}],"confirm":true,"__proto__":{}}'));
    await bad({ runs: 'all', confirm: true });
    await bad([{ key: 'ENG-8', rev: 1 }]);
    assert.equal(h.run('ENG-8').status, 'awaiting_approval');
  } finally { await h.cleanup(); }
});

// ───────────────────────── T5 engine: the limit-rule overlay (needs M8-3's engine to read effectiveLimitRule) ─────────────────────────
test('T5 engine: stored limitRule "wait" — Per settings pauses at a Claude limit; Complete auto moves the plan to the next tool in the chain', async () => {
  for (const runMode of ['per-settings', 'complete-auto'] as const) {
    const clock = new TestClock();
    const h = await makeHarness({ clock, config: (c) => { c.roles = applySettings(c, { onClaudeLimit: 'cursor' }).roles; c.pipeline.limitRule = 'wait'; c.pipeline.runMode = runMode; } });
    try {
      h.scenario({ claude: { '*': { plan: [{ limit: { resetsAt: Math.floor(clock.now() / 1000) + 3600 } }], verify: [{ limit: {} }] } } });
      const key = h.issue('Limited');
      await h.settle();
      const r = h.run(key);
      if (runMode === 'per-settings') assert.equal(r.status, 'paused', JSON.stringify(r.history.map((x) => x.text)));
      else {
        assert.equal(r.status, 'ready', JSON.stringify(r.history.map((x) => x.text)));
        assert.ok(h.calls().some((c) => c.who === 'cursor' && c.argv.includes('--mode')), 'the plan ran on Cursor');
      }
      assert.equal(h.cfg.pipeline.limitRule, 'wait', 'the stored rule is never written');
    } finally { await h.cleanup(); }
  }
});
