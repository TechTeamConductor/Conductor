// M8-4 commit 1 — the run-mode overlay ("Per settings | Complete auto"), pure + config + static + persist-then-swap.
//   T1  matrix: every forced hold stops under Complete auto; everything else is auto; Per settings === today's decision
//   T9  static: stages.ts reads no stored approval field and never the mode itself (N7); the overlay is the only path
//   T12 v1 import never arrives with Complete auto on (N2)
//   T13 exact equality: non-canonical runMode values are Per settings (N4)
//   T4 (commit-1 part, B1) a refused config save changes nothing in memory (runtime persist-then-swap)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { decideApproval, decidedByRunMode, effectiveFirstPlanHold, effectiveLiftsHolds, effectivePolicy, isCompleteAuto, POLICIES, storedPolicy, type ApprovalInput, type Policy } from '../src/policy/policy.ts';
import { defaultConfig, normalizeConfig, toSettings } from '../src/config.ts';
import type { Config } from '../src/types.ts';

const ROOT = join(import.meta.dirname, '..');
const plan = (over: any = {}) => ({ complexity: 'S', deliverable: 'code', steps: ['Edit the module'], testing: { commands: ['npm test'], cases: [] }, filesToChange: [{ path: 'src/a.ts', action: 'modify', change: '', reason: '' }], ...over }) as any;
const RISKY = { testing: { commands: ['git push origin main'], cases: [] } };
const NONE = { protectedPaths: false, untrusted: false, bigGraph: false };
type Cause = 'none' | 'L' | 'protected' | 'untrusted' | 'bigGraph';
const CAUSES: Cause[] = ['none', 'L', 'protected', 'untrusted', 'bigGraph'];

const cfgWith = (p: { runMode?: unknown; policy?: Policy; planApproval?: 'auto' | 'manual' | 'first'; project?: Policy }): Config => {
  const c = normalizeConfig(defaultConfig());
  if (p.policy) c.pipeline.policy = p.policy;
  if (p.planApproval) c.pipeline.planApproval = p.planApproval;
  if (p.project) c.projects = { ENG: { policy: p.project } };
  if ('runMode' in p) (c.pipeline as any).runMode = p.runMode;
  return c;
};
const inputOf = (cause: Cause, risky: boolean): Omit<ApprovalInput, 'policy' | 'firstPlanHold'> => ({
  plan: plan({ ...(risky ? RISKY : {}), ...(cause === 'L' ? { complexity: 'L' } : {}) }),
  forced: { ...NONE, protectedPaths: cause === 'protected', untrusted: cause === 'untrusted', bigGraph: cause === 'bigGraph' },
});
/** Exactly the composition the approval gate (stages.ts) performs. */
const gate = (cfg: Config, i: Omit<ApprovalInput, 'policy' | 'firstPlanHold'>, approved: number) =>
  decideApproval({ ...i, policy: effectivePolicy(cfg, 'ENG'), firstPlanHold: effectiveFirstPlanHold(cfg, approved), completeAuto: effectiveLiftsHolds(cfg) });
/** Today's (pre-M8-4) gate, written out literally: the Per-settings baseline. */
const legacyGate = (cfg: Config, i: Omit<ApprovalInput, 'policy' | 'firstPlanHold'>, approved: number) =>
  decideApproval({ ...i, policy: storedPolicy(cfg, 'ENG'), firstPlanHold: cfg.pipeline.planApproval === 'first' && approved === 0 });

test('T1 run-mode: matrix — nothing waits under Complete auto (every forced hold is lifted); Per settings is today\'s decision', () => {
  let cells = 0;
  for (const policy of POLICIES) for (const project of [undefined, ...POLICIES] as (Policy | undefined)[]) for (const planApproval of ['auto', 'manual', 'first'] as const)
    for (const approved of [0, 1]) for (const cause of CAUSES) for (const risky of [false, true]) {
      const i = inputOf(cause, risky);
      const where = JSON.stringify({ policy, project, planApproval, approved, cause, risky });
      // Per settings (explicit and missing): byte-identical to the pre-slice composition
      for (const per of [cfgWith({ runMode: 'per-settings', policy, planApproval, project }), cfgWith({ runMode: undefined, policy, planApproval, project })]) {
        assert.deepEqual(gate(per, i, approved), legacyGate(per, i, approved), `per-settings ${where}`);
        assert.equal(decidedByRunMode(per, i, 'ENG', approved), false, where);
      }
      const ca = cfgWith({ runMode: 'complete-auto', policy, planApproval, project });
      const d = gate(ca, i, approved);
      const fullAuto = decideApproval({ ...i, completeAuto: true, policy: 'full-auto', firstPlanHold: false });
      assert.deepEqual(d, fullAuto, `complete-auto === full-auto without holds ${where}`);
      assert.equal(d.auto, true, `nothing waits under Complete auto ${where}`);
      assert.equal(decidedByRunMode(ca, i, 'ENG', approved), !legacyGate(ca, i, approved).auto, `history wording only when the mode made the difference ${where}`);
      // the stored settings are never touched by evaluating the overlay
      assert.equal(ca.pipeline.policy, policy);
      assert.equal(ca.pipeline.planApproval, planApproval);
      assert.equal(ca.projects.ENG?.policy, project);
      cells++;
    }
  assert.equal(cells, 4 * 5 * 3 * 2 * 5 * 2);
});

test('T13 run-mode: exact equality — missing, empty, wrong case, padded, boolean, null and objects are Per settings (global and project policy)', () => {
  for (const v of [undefined, '', 'Complete-Auto', 'complete-auto ', ' complete-auto', 'COMPLETE-AUTO', 'complete_auto', true, 1, null, {}, ['complete-auto']]) {
    for (const shape of [{ policy: 'approve-plan' as Policy }, { policy: 'full-auto' as Policy, project: 'approve-plan' as Policy }, { planApproval: 'first' as const }]) {
      const c = cfgWith({ runMode: v, ...shape });
      assert.equal(isCompleteAuto(c), false, JSON.stringify(v));
      assert.equal(effectivePolicy(c, 'ENG'), storedPolicy(c, 'ENG'));
      assert.equal(effectiveFirstPlanHold(c, 0), c.pipeline.planApproval === 'first');
      assert.equal(gate(c, inputOf('none', false), 0).auto, false, `still waits under ${JSON.stringify(v)}`);
    }
    // and the loader normalises it to the canonical safe value
    const loaded = normalizeConfig({ ...defaultConfig(), pipeline: { ...defaultConfig().pipeline, runMode: v } } as any);
    assert.equal(loaded.pipeline.runMode, 'per-settings', JSON.stringify(v));
  }
  assert.equal(normalizeConfig({ ...defaultConfig(), pipeline: { ...defaultConfig().pipeline, runMode: 'complete-auto' } } as any).pipeline.runMode, 'complete-auto');
  assert.equal(isCompleteAuto(undefined as any), false, 'a missing config is never Complete auto');
});

test('C3/C4 config + settings view: default per-settings; runModeChangedAt kept only when a positive number; overriddenByRunMode empty vs all three; stored fields reported as stored', () => {
  assert.equal(defaultConfig().pipeline.runMode, 'per-settings');
  const base = defaultConfig().pipeline;
  assert.equal(normalizeConfig({ ...defaultConfig(), pipeline: { ...base, runModeChangedAt: 1_700_000_000_000 } } as any).pipeline.runModeChangedAt, 1_700_000_000_000);
  for (const bad of ['1', -1, 0, NaN, Infinity, null]) assert.equal('runModeChangedAt' in normalizeConfig({ ...defaultConfig(), pipeline: { ...base, runModeChangedAt: bad } } as any).pipeline, false, String(bad));
  const per = cfgWith({ runMode: 'per-settings', policy: 'approve-plan', planApproval: 'first' });
  assert.deepEqual([toSettings(per).runMode, toSettings(per).overriddenByRunMode], ['per-settings', []]);
  const ca = cfgWith({ runMode: 'complete-auto', policy: 'approve-plan', planApproval: 'first' });
  const s = toSettings(ca);
  assert.equal(s.runMode, 'complete-auto');
  assert.deepEqual(s.overriddenByRunMode, ['planApproval', 'policy', 'limitRule']);
  assert.equal(s.planApproval, 'first', 'the view never substitutes the effective value into a stored field');
});

// ───────────────────────── T9 / N7 static ─────────────────────────
const srcFiles = (dir: string, out: string[] = []): string[] => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) srcFiles(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
};
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('T9 static: the overlay is the only path — stages.ts reads no stored approval field, never the mode; only the allowed files read runMode/isCompleteAuto', () => {
  const stages = stripComments(readFileSync(join(ROOT, 'src/pipeline/stages.ts'), 'utf8'));
  assert.doesNotMatch(stages, /pipeline\.planApproval|pipeline\.policy\b|\.projects\??\.\[/, 'stages.ts reads approval settings only through policy.ts');
  assert.doesNotMatch(stages, /runMode|isCompleteAuto|storedPolicy/, 'N7: stages.ts never names the mode');
  assert.match(stages, /effectivePolicy\(cfg, project\)/);
  assert.match(stages, /effectiveFirstPlanHold\(cfg, approved\)/);
  assert.match(stages, /completeAuto: effectiveLiftsHolds\(cfg\)/);
  // N7: who may name the mode at all (api.ts joins in commit 2 for PUT /api/run-mode and the live view)
  const allowed = new Set(['src/config.ts', 'src/types.ts', 'src/policy/policy.ts', 'src/accounts/limit-rule.ts', 'src/migrate.ts', 'src/server/api.ts']);
  const readers = srcFiles(join(ROOT, 'src'))
    .filter((f) => /\brunMode\b|\bisCompleteAuto\b/.test(stripComments(readFileSync(f, 'utf8'))))
    .map((f) => relative(ROOT, f).split('\\').join('/'));
  for (const f of readers) assert.ok(allowed.has(f), `${f} must not read the run mode (use effectivePolicy / effectiveFirstPlanHold / effectiveLimitRule)`);
  // C1: the stored limit rule is read only by the settings view/edit + migration (config.ts) and effectiveLimitRule itself
  const limitReaders = srcFiles(join(ROOT, 'src'))
    .filter((f) => /pipeline\??\.limitRule\b/.test(stripComments(readFileSync(f, 'utf8'))))
    .map((f) => relative(ROOT, f).split('\\').join('/'));
  for (const f of limitReaders) {
    if (f === 'src/accounts/service.ts') {
      // M8-3's accounts listing is a settings VIEW: it may report the stored value next to the effective one, and nothing else
      const reads = [...stripComments(readFileSync(join(ROOT, f), 'utf8')).matchAll(/(.{0,40})pipeline\??\.limitRule\b/g)].map((m) => m[1]!);
      for (const before of reads) assert.match(before, /limitRule: cfg\.$/, `${f}: only the view field "limitRule: cfg.pipeline.limitRule" may read the stored rule`);
      continue;
    }
    assert.ok(['src/config.ts', 'src/accounts/limit-rule.ts'].includes(f), `${f} must call effectiveLimitRule, not read pipeline.limitRule`);
  }
  assert.ok(limitReaders.includes('src/accounts/limit-rule.ts'));
  // decideApproval itself never sees the mode
  const policy = readFileSync(join(ROOT, 'src/policy/policy.ts'), 'utf8');
  const body = policy.slice(policy.indexOf('export function decideApproval'), policy.indexOf('\n}\n', policy.indexOf('export function decideApproval')));
  assert.doesNotMatch(body, /runMode|isCompleteAuto|cfg/, 'decideApproval is unchanged and takes no config');
});

// ───────────────────────── T12 v1 import (N2) ─────────────────────────
test('T12 migrate: a v1 config carrying runMode: complete-auto imports as per-settings (and drops runModeChangedAt)', async () => {
  const { migrate } = await import('../src/migrate.ts');
  const tmp = () => mkdtempSync(join(tmpdir(), 'cond-rm-'));
  const from = tmp();
  const v1 = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'real-shape-v1', 'config.json'), 'utf8'));
  v1.pipeline = { ...(v1.pipeline ?? {}), runMode: 'complete-auto', runModeChangedAt: 123 };
  writeFileSync(join(from, 'config.json'), JSON.stringify(v1));
  mkdirSync(join(from, 'runs'));
  const to = join(tmp(), 'v2');
  const r = await migrate({ from, to, apply: true, backupRoot: tmp() });
  assert.equal(r.published, true);
  const out = JSON.parse(readFileSync(join(to, 'config.json'), 'utf8'));
  assert.equal(out.pipeline.runMode, 'per-settings');
  assert.equal('runModeChangedAt' in out.pipeline, false);
  assert.equal(normalizeConfig(out).pipeline.runMode, 'per-settings');
});

// ───────────────────────── T4 (commit-1 part): B1 persist-then-swap ─────────────────────────
test('T4/B1 runtime: a refused config save (newer file on disk) throws and leaves memory unchanged — memory and disk agree', async () => {
  const { createRuntime } = await import('../src/runtime.ts');
  const { paths } = await import('../src/paths.ts');
  const home = mkdtempSync(join(tmpdir(), 'cond-rm-rt-'));
  const prev = process.env.CONDUCTOR_HOME;
  process.env.CONDUCTOR_HOME = home;
  const start = normalizeConfig({ ...defaultConfig(), pipeline: { ...defaultConfig().pipeline, planApproval: 'manual', runMode: 'complete-auto' } } as any);
  const rt = await createRuntime({
    config: start,
    models: false,
    health: async () => ({ claude: { found: true, ok: true, loggedIn: true, detail: 'ok' }, cursor: { found: true, ok: true, loggedIn: true, detail: 'ok' } }),
    persistent: { load: () => ({ repos: {} }), save: () => undefined },
    notify: () => undefined,
  });
  try {
    // a save that succeeds: disk first, then memory
    await rt.api.handle('PUT', '/api/settings', new URLSearchParams(), { maxLoops: 4 });
    assert.equal(rt.cfgRef.current.pipeline.maxLoops, 4);
    assert.equal(JSON.parse(readFileSync(paths.config(), 'utf8')).pipeline.maxLoops, 4);
    const before = rt.cfgRef.current;
    // a newer build wrote config.json since: saveConfig refuses (assertNotNewer) ⇒ the swap must not happen
    const onDisk = JSON.parse(readFileSync(paths.config(), 'utf8'));
    writeFileSync(paths.config(), JSON.stringify({ ...onDisk, version: 999 }));
    await assert.rejects(rt.api.handle('PUT', '/api/settings', new URLSearchParams(), { maxLoops: 2, planApproval: 'auto' }) as Promise<unknown>);
    assert.equal(rt.cfgRef.current, before, 'the live config object is the old one');
    assert.equal(rt.cfgRef.current.pipeline.maxLoops, 4);
    assert.equal(rt.cfgRef.current.pipeline.planApproval, 'manual');
    assert.equal(rt.cfgRef.current.pipeline.runMode, 'complete-auto', 'the effective mode stays what disk says');
    assert.equal(JSON.parse(readFileSync(paths.config(), 'utf8')).version, 999, 'the newer file is untouched');
  } finally {
    await rt.close();
    if (prev === undefined) delete process.env.CONDUCTOR_HOME;
    else process.env.CONDUCTOR_HOME = prev;
  }
  assert.ok(existsSync(home));

});

// ═════════════════════════ commit 2: limit overlay + PUT /api/run-mode ═════════════════════════
test('T5 effectiveLimitRule: Complete auto ⇒ switch for every stored rule; Per settings (and any non-canonical mode) ⇒ the stored rule', async () => {
  const { effectiveLimitRule, LIMIT_RULES } = await import('../src/accounts/limit-rule.ts');
  for (const rule of LIMIT_RULES) {
    const c = normalizeConfig(defaultConfig());
    c.pipeline.limitRule = rule;
    for (const v of ['per-settings', undefined, 'Complete-Auto', 'complete-auto ', true]) {
      (c.pipeline as any).runMode = v;
      assert.equal(effectiveLimitRule(c), rule, `${rule} ${String(v)}`);
    }
    c.pipeline.runMode = 'complete-auto';
    assert.equal(effectiveLimitRule(c), 'switch', rule);
    assert.equal(c.pipeline.limitRule, rule, 'stored rule unchanged');
    const s = toSettings(c);
    assert.deepEqual([s.limitRule, s.limitRuleEffective], [rule, 'switch'], 'the view reports stored and effective separately');
  }
});

test('T8 static: one writer — only the PUT /api/run-mode handler assigns pipeline.runMode (the v1 importer may only force per-settings)', () => {
  const writers: string[] = [];
  for (const f of srcFiles(join(ROOT, 'src'))) {
    const rel = relative(ROOT, f).split('\\').join('/');
    const text = stripComments(readFileSync(f, 'utf8'));
    for (const m of text.matchAll(/\.runMode\s*=(?!=)\s*([^;\n]*)/g)) writers.push(`${rel}: ${m[1]!.trim()}`);
    for (const m of text.matchAll(/\.runModeChangedAt\s*=(?!=)\s*([^;\n]*)/g)) writers.push(`${rel}: changedAt ${m[1]!.trim()}`);
  }
  assert.deepEqual(writers.sort(), ["src/migrate.ts: 'per-settings'", 'src/server/api.ts: changedAt Date.now()', 'src/server/api.ts: runMode'].sort());
  const api = readFileSync(join(ROOT, 'src/server/api.ts'), 'utf8');
  const handler = api.slice(api.indexOf("path === '/api/run-mode'"), api.indexOf("path === '/api/settings'"));
  assert.match(handler, /next\.pipeline\.runMode = runMode/, 'the assignment lives in the run-mode handler, on a NEW config');
  assert.match(handler, /deepClone\(cfg\)/);
  assert.doesNotMatch(handler, /\bcfg\.pipeline\.runMode\s*=(?!=)/, 'the live config is never mutated');
  // and no writer of the stored approval / limit settings in that handler (AC3)
  assert.doesNotMatch(handler, /\.(policy|planApproval|limitRule)\s*=(?!=)/);
});

// ───────────────────────── T4 direct API: strict body, confirm, idempotent, failed save ─────────────────────────
test('T4 run-mode API: strict body, confirm to turn on, idempotent same-mode, PUT /api/settings refuses runMode, waiting.total, a failed save is a 500 that changes nothing', async () => {
  const { makeHarness } = await import('./helpers/harness.ts');
  const { Api } = await import('../src/server/api.ts');
  const h = await makeHarness({ config: (c) => void ((c.pipeline as any).policy = 'approve-plan') });
  try {
    let cur = h.cfg;
    let saves = 0;
    let failSave = false;
    const api = new Api({ engine: h.engine, store: h.store, board: h.board, auth: {} as any, version: 't', getConfig: () => cur, saveConfig: (c) => { if (failSave) throw new Error('disk full /secret/path'); saves++; cur = c; }, persistent: () => ({ repos: {} }) as any, health: async () => ({}) as any, probe: async () => ({ ok: true, detail: '', durationMs: 1 }) });
    const put = (b: any) => api.handle('PUT', '/api/run-mode', new URLSearchParams(), b) as Promise<any>;
    const bad = (b: any, code = 'bad_request') => assert.rejects(put(b), (e: any) => e.status === 400 && e.code === code, JSON.stringify(b));
    h.scenario({ claude: { '*': { plan: [{ json: {} }] } } });
    const waitingKey = h.issue('Waits under approve-plan');
    await h.settle();
    assert.equal(h.run(waitingKey).status, 'awaiting_approval');
    await bad(null); await bad([]); await bad('complete-auto'); await bad({});
    await bad({ runMode: 'complete-auto', confirm: true, extra: 1 });
    await bad(JSON.parse('{"runMode":"complete-auto","confirm":true,"__proto__":{"x":1}}'));
    await bad(JSON.parse('{"runMode":"complete-auto","confirm":true,"constructor":1}'));
    for (const v of ['Complete-Auto', 'complete-auto ', '', true, null, 1]) await bad({ runMode: v, confirm: true });
    await bad({ runMode: 'complete-auto' }, 'confirm_required');
    await bad({ runMode: 'complete-auto', confirm: false }, 'confirm_required');
    await bad({ runMode: 'complete-auto', confirm: 'true' });
    await assert.rejects(put({ runMode: 'complete-auto' }), (e: any) => /large changes, protected files, plans with more than 8 tasks, imports, Ask and research results, and designed work/.test(e.message) && /next tool in the job's list/.test(e.message), 'N8 + M8-5 B2: confirm text names every forced hold and is chain-only');
    assert.equal(saves, 0, 'nothing written by any refused call');
    // same mode: idempotent, nothing written
    let r = (await put({ runMode: 'per-settings' })).json;
    assert.deepEqual([r.ok, r.changed, r.runMode, r.waiting.total], [true, false, 'per-settings', 1]);
    assert.equal(saves, 0);
    // on
    const before = cur;
    r = (await put({ runMode: 'complete-auto', confirm: true })).json;
    assert.deepEqual([r.changed, r.runMode, r.waiting.total, r.waiting.bulkApprovable], [true, 'complete-auto', 1, 1]);
    assert.deepEqual(r.waiting.eligible, [{ key: waitingKey, rev: h.run(waitingKey).rev, title: 'Waits under approve-plan' }]);
    assert.equal(r.settings.runMode, 'complete-auto');
    assert.deepEqual(r.settings.overriddenByRunMode, ['planApproval', 'policy', 'limitRule']);
    assert.notEqual(cur, before, 'a NEW config object was saved');
    assert.equal(before.pipeline.runMode, 'per-settings', 'the old live object was never mutated');
    assert.equal(typeof cur.pipeline.runModeChangedAt, 'number');
    assert.equal(api.live().engine.runMode, 'complete-auto');
    assert.equal(api.live().waiting.total, 1, 'M8-5: waiting is on live()');
    assert.equal(h.run(waitingKey).status, 'awaiting_approval', 'turning it on approves nothing');
    // same mode again ⇒ no write
    assert.equal((await put({ runMode: 'complete-auto', confirm: true })).json.changed, false);
    assert.equal(saves, 1);
    // off needs no confirm
    assert.equal((await put({ runMode: 'per-settings' })).json.changed, true);
    assert.equal(cur.pipeline.runMode, 'per-settings');
    // PUT /api/settings refuses the mode (one writer)
    for (const b of [{ runMode: 'complete-auto' }, { runMode: 'per-settings', maxLoops: 2 }, { runModeChangedAt: 1 }]) {
      await assert.rejects(api.handle('PUT', '/api/settings', new URLSearchParams(), b) as Promise<unknown>, (e: any) => e.status === 400 && /PUT \/api\/run-mode/.test(e.message));
    }
    assert.equal((await api.handle('PUT', '/api/settings', new URLSearchParams(), { maxLoops: 2 }) as any).json.ok, true, 'other keys behave as before');
    // B1: a failed save ⇒ 500, the effective mode stays (both directions), no path leaks
    failSave = true;
    const kept = cur;
    await assert.rejects(put({ runMode: 'complete-auto', confirm: true }), (e: any) => e.status === 500 && e.code === 'save_failed' && !/secret/.test(e.message));
    assert.equal(cur, kept);
    assert.equal(cur.pipeline.runMode, 'per-settings');
    failSave = false;
    await put({ runMode: 'complete-auto', confirm: true });
    failSave = true;
    await assert.rejects(put({ runMode: 'per-settings' }), (e: any) => e.status === 500);
    assert.equal(cur.pipeline.runMode, 'complete-auto', 'a failed "off" leaves Complete auto on, consistently');
  } finally { await h.cleanup(); }
});

test('T4/B1 engine: after a refused save, a harmless plan under stored approve-plan still waits (the mode never switched)', async () => {
  const { makeHarness } = await import('./helpers/harness.ts');
  const { Api } = await import('../src/server/api.ts');
  const h = await makeHarness({ config: (c) => void ((c.pipeline as any).policy = 'approve-plan') });
  try {
    const api = new Api({ engine: h.engine, store: h.store, board: h.board, auth: {} as any, version: 't', getConfig: () => h.cfg, saveConfig: () => { throw new Error('refused'); }, persistent: () => ({ repos: {} }) as any, health: async () => ({}) as any, probe: async () => ({ ok: true, detail: '', durationMs: 1 }) });
    await assert.rejects(api.handle('PUT', '/api/run-mode', new URLSearchParams(), { runMode: 'complete-auto', confirm: true }) as Promise<unknown>, (e: any) => e.status === 500);
    assert.equal(h.cfg.pipeline.runMode, 'per-settings');
    h.scenario({ claude: { '*': { plan: [{ json: {} }] } } });
    const key = h.issue('Harmless');
    await h.settle();
    assert.equal(h.run(key).status, 'awaiting_approval');
  } finally { await h.cleanup(); }
});

// ───────────────────────── T4/T6/T7 over HTTP with a real (non-ephemeral) runtime: CSRF, cookie, AC3 on disk, /api/state, SSE ─────────────────────────
test('T4/T6/T7 HTTP: 401 without cookie, 403 without CSRF; /api/state settings; SSE state follows; AC3 the saved config.json differs only in runMode', async () => {
  const http = await import('node:http');
  const { createRuntime } = await import('../src/runtime.ts');
  const { paths } = await import('../src/paths.ts');
  const home = mkdtempSync(join(tmpdir(), 'cond-rm-http-'));
  const prev = process.env.CONDUCTOR_HOME;
  process.env.CONDUCTOR_HOME = home;
  const start = normalizeConfig({ ...defaultConfig(), projects: { ENG: { policy: 'approve-risky' } }, pipeline: { ...defaultConfig().pipeline, policy: 'approve-plan', planApproval: 'first', limitRule: 'wait' } } as any);
  const rt = await createRuntime({
    config: start,
    models: false,
    health: async () => ({ claude: { found: true, ok: true, loggedIn: true, detail: 'ok' }, cursor: { found: true, ok: true, loggedIn: true, detail: 'ok' } }),
    persistent: { load: () => ({ repos: {} }), save: () => undefined },
    notify: () => undefined,
  });
  try {
    const port = await rt.server.listen(0);
    const req = (path: string, o: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
      new Promise<{ status: number; json: any }>((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: o.headers }, (res) => {
          let t = '';
          res.on('data', (c) => (t += c));
          res.on('end', () => { let j: any = null; try { j = JSON.parse(t); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, json: j }); });
        });
        r.on('error', reject);
        if (o.body !== undefined) r.write(JSON.stringify(o.body));
        r.end();
      });
    const u = new URL(rt.server.loginUrl());
    const login = await new Promise<import('node:http').IncomingMessage>((res) => http.get({ host: '127.0.0.1', port, path: u.pathname + u.search }, res));
    const cookie = String(login.headers['set-cookie']?.[0]).split(';')[0]!;
    const state = (await req('/api/state', { headers: { cookie } })).json;
    const csrf = state.csrf;
    // T6
    assert.equal(state.settings.runMode, 'per-settings');
    assert.deepEqual(state.settings.overriddenByRunMode, []);
    assert.deepEqual([state.settings.limitRule, state.settings.limitRuleEffective], ['wait', 'wait']);
    assert.equal(state.engine.runMode, 'per-settings');
    assert.ok(state.waiting && typeof state.waiting.total === 'number', 'M8-5: waiting on GET /api/state');
    assert.deepEqual([state.waiting.total, state.waiting.bulkApprovable, state.waiting.eligible], [0, 0, []]);
    const mut = { cookie, 'content-type': 'application/json', 'x-conductor-csrf': csrf, 'sec-fetch-site': 'same-origin' };
    const on = { runMode: 'complete-auto', confirm: true };
    assert.equal((await req('/api/run-mode', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: on })).status, 401);
    const { 'x-conductor-csrf': _drop, ...noCsrf } = mut;
    assert.equal((await req('/api/run-mode', { method: 'PUT', headers: noCsrf, body: on })).status, 403);
    assert.equal((await req('/api/run-mode', { method: 'PUT', headers: { ...mut, 'x-conductor-csrf': 'wrong' }, body: on })).status, 403);
    assert.equal(rt.cfgRef.current.pipeline.runMode, 'per-settings');
    // AC3 baseline after one save (N6), then SSE (T7)
    assert.equal((await req('/api/settings', { method: 'PUT', headers: mut, body: { maxLoops: 3 } })).status, 200);
    const strip = (o: any) => { const c = JSON.parse(JSON.stringify(o)); delete c.pipeline.runMode; delete c.pipeline.runModeChangedAt; return c; };
    const baseline = strip(JSON.parse(readFileSync(paths.config(), 'utf8')));
    const sse = new Promise<string>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { cookie } }, (res) => {
        let t = '';
        res.on('data', (c) => {
          t += c;
          if (/"runMode":"complete-auto"/.test(t)) { resolve(t); r.destroy(); }
        });
      });
      r.on('error', (e) => ((e as any).code === 'ECONNRESET' ? undefined : reject(e)));
      r.end();
    });
    await new Promise((r) => setTimeout(r, 300)); // let the stream deliver its initial state
    const res = await req('/api/run-mode', { method: 'PUT', headers: mut, body: on });
    assert.equal(res.status, 200);
    assert.deepEqual([res.json.changed, res.json.waiting.total], [true, 0]);
    const frame = await Promise.race([sse, new Promise<string>((_, rej) => setTimeout(() => rej(new Error('no SSE state with runMode')), 5000))]);
    assert.match(frame, /event: state/);
    const after = (await req('/api/state', { headers: { cookie } })).json;
    assert.deepEqual(after.settings.overriddenByRunMode, ['planApproval', 'policy', 'limitRule']);
    assert.deepEqual([after.settings.limitRule, after.settings.limitRuleEffective, after.settings.planApproval], ['wait', 'switch', 'first'], 'stored values reported as stored');
    let disk = JSON.parse(readFileSync(paths.config(), 'utf8'));
    assert.equal(disk.pipeline.runMode, 'complete-auto');
    assert.deepEqual(strip(disk), baseline, 'AC3: only pipeline.runMode (+ its timestamp) differs on disk');
    assert.equal((await req('/api/run-mode', { method: 'PUT', headers: mut, body: { runMode: 'per-settings' } })).status, 200);
    disk = JSON.parse(readFileSync(paths.config(), 'utf8'));
    assert.equal(disk.pipeline.runMode, 'per-settings');
    assert.deepEqual(strip(disk), baseline, 'AC3 after on → off');
    assert.equal((await req('/api/settings', { method: 'PUT', headers: mut, body: { runMode: 'complete-auto' } })).status, 400);
    // B1 over HTTP: a newer config.json on disk ⇒ 500, nothing switched
    writeFileSync(paths.config(), JSON.stringify({ ...disk, version: 999 }));
    const refused = await req('/api/run-mode', { method: 'PUT', headers: mut, body: on });
    assert.equal(refused.status, 500);
    assert.equal(rt.cfgRef.current.pipeline.runMode, 'per-settings');
    assert.equal((await req('/api/state', { headers: { cookie } })).json.engine.runMode, 'per-settings');
  } finally {
    await rt.close();
    if (prev === undefined) delete process.env.CONDUCTOR_HOME;
    else process.env.CONDUCTOR_HOME = prev;
  }
});
