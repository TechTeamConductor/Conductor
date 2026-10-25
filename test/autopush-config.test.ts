// Push configuration (Complete auto pushes; there is no separate switch): validation, defaults, old-config loading, the push consent marker,
// the strict PUT /api/auto-push handler (remote + identity only), copy parity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { defaultConfig, maskEmail, normalizeConfig, pushRemoteOf, toSettings, validateIdentity, validatePushRemote } from '../src/config.ts';
import { effectiveShip, pushConsentGiven } from '../src/policy/policy.ts';

const ROOT = join(import.meta.dirname, '..');


test('push remote: a name, never a URL', () => {
  for (const ok of ['origin', 'up-stream', 'a.b_c', 'R1']) assert.equal(validatePushRemote(ok).ok, true, ok);
  for (const b of ['', '-x', '--receive-pack=x', '.x', 'https://github.com/a/b', 'git@github.com:a/b', 'a/b', 'a b', 'ext::sh -c x', 'file:///x', '/tmp/x', 'a;b', 'x'.repeat(65), 1, null, undefined]) assert.equal(validatePushRemote(b).ok, false, String(b));
});

test('developer identity: strict shape, masked in the settings view', () => {
  assert.deepEqual(validateIdentity({ name: ' Ada ', email: 'ada@example.com' }), { ok: true, value: { name: 'Ada', email: 'ada@example.com' } });
  for (const b of [null, [], 'x', {}, { name: 'A' }, { email: 'a@b.co' }, { name: 'A<b>', email: 'a@b.co' }, { name: 'A', email: 'nope' }, { name: 'A', email: 'a b@c.de' }, { name: 'A\u0007', email: 'a@b.co' }, { name: 'x'.repeat(101), email: 'a@b.co' }, { name: 5, email: 'a@b.co' }]) {
    assert.equal(validateIdentity(b).ok, false, JSON.stringify(b));
  }
  assert.equal(maskEmail('ada@example.com'), 'a***@example.com');
  const c = normalizeConfig(defaultConfig());
  c.developerIdentity = { name: 'Ada', email: 'ada@example.com' };
  assert.deepEqual(toSettings(c).developerIdentity, { name: 'Ada', email: 'a***@example.com' });
  assert.equal(JSON.stringify(toSettings(c)).includes('ada@example.com'), false);
});

test('defaults, normalization, planReviewRounds and the per-repo kill switch', () => {
  const d = normalizeConfig(defaultConfig());
  assert.equal(d.pipeline.planReviewRounds, 3);
  assert.equal(d.developerIdentity, undefined);
  for (const [v, want] of [[undefined, 3], [0, 1], [-4, 1], [99, 5], [2, 2], ['4', 3], ['x', 3], [null, 3]] as const) assert.equal(normalizeConfig({ pipeline: { planReviewRounds: v } }).pipeline.planReviewRounds, want, String(v));
  const repo = { name: 'r', path: '/x', baseBranch: 'main', gates: [], copyFiles: [], envPassthrough: [] };
  const n = normalizeConfig({ repos: [repo, { ...repo, name: 'q', pushBranch: 'main', pushRemote: 'https://evil/x' }, { ...repo, name: 's', pushRemote: 'up' }, { ...repo, name: 'k', pushRemote: null }] });
  assert.deepEqual(n.repos.map((r) => r.pushRemote), ['origin', 'origin', 'up', null]);
  assert.equal(n.repos.some((r) => 'pushBranch' in r), false, 'the pushBranch setting no longer exists');
  assert.deepEqual(n.repos.map((r) => pushRemoteOf(r)), ['origin', 'origin', 'up', null]);
  assert.equal(normalizeConfig({ developerIdentity: { name: 'A<', email: 'x' } }).developerIdentity, undefined);
  assert.deepEqual(toSettings(n).pushTargets[3], { repo: 'k', pushRemote: null });
});

test('an old config with autoPush true/false loads and the key is ignored (no effect, not kept)', () => {
  for (const v of [true, false, 'true', 1, null]) {
    const c = normalizeConfig({ pipeline: { autoPush: v, runMode: 'complete-auto' } });
    assert.equal(Object.hasOwn(c.pipeline, 'autoPush'), false, String(v));
    assert.equal(c.pipeline.runMode, 'complete-auto');
  }
  // the old settings shape still loads; with or without the old key, pushing depends only on Complete auto + the consent marker
  const on = normalizeConfig({ pipeline: { autoPush: true, runMode: 'per-settings' } });
  assert.equal(effectiveShip(on), false);
});

test('push consent: Complete auto alone never pushes; the marker (set only by the confirm) is required; old configs need it once', () => {
  const c = normalizeConfig({ pipeline: { runMode: 'complete-auto' } });
  assert.equal(pushConsentGiven(c), false);
  assert.equal(effectiveShip(c), false, 'a config already in Complete auto does not push until the new confirm is accepted');
  assert.equal(toSettings(c).pushConsentNeeded, true);
  assert.equal(toSettings(c).pushEffective, false);
  for (const bad of [0, -1, 'x', true, NaN, null]) assert.equal(pushConsentGiven(normalizeConfig({ pipeline: { runMode: 'complete-auto', completeAutoPushAck: bad } })), false, String(bad));
  const acked = normalizeConfig({ pipeline: { runMode: 'complete-auto', completeAutoPushAck: 1700000000000 } });
  assert.equal(effectiveShip(acked), true);
  assert.deepEqual([toSettings(acked).pushConsentNeeded, toSettings(acked).pushEffective], [false, true]);
  const off = normalizeConfig({ pipeline: { runMode: 'per-settings', completeAutoPushAck: 1700000000000 } });
  assert.deepEqual([effectiveShip(off), toSettings(off).pushConsentNeeded, toSettings(off).pushEffective], [false, false, false]);
});

test('static: ship runs only through effectiveShip, which requires pushConsentGiven; autoPush is read nowhere', () => {
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const pol = strip(readFileSync(join(ROOT, 'src/policy/policy.ts'), 'utf8'));
  assert.match(pol, /export const effectiveShip = \(cfg: Config\): boolean => isCompleteAuto\(cfg\) && pushConsentGiven\(cfg\);/);
  assert.match(pol, /completeAutoPushAck/);
  const eng = strip(readFileSync(join(ROOT, 'src/pipeline/engine.ts'), 'utf8'));
  assert.match(eng, /return effectiveShip\(this\.d\.getConfig\(\)\)/);
  assert.doesNotMatch(eng, /isCompleteAuto\([^)]*\)\s*&&[^;\n]*shipOne|shipOne\([^)]*\)[^;\n]*isCompleteAuto/, 'shipOne is gated by shipEffective only');
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const n of readdirSync(dir)) {
      const f = join(dir, n);
      if (statSync(f).isDirectory()) walk(f);
      else if (/\.(ts|js|html)$/.test(n) && !/\.d\.ts$/.test(n)) if (/\bautoPush\b/.test(strip(readFileSync(f, 'utf8')))) offenders.push(f.slice(ROOT.length + 1));
    }
  };
  walk(join(ROOT, 'src'));
  walk(join(ROOT, 'ui'));
  assert.deepEqual(offenders, ['src/types.ts'], 'only the deprecated optional declaration remains');
  assert.match(readFileSync(join(ROOT, 'src/types.ts'), 'utf8'), /autoPush\?: boolean;/);
});

test('static: COMPLETE_AUTO_CONFIRM is byte-identical in api.ts and ui/modes.js and states every push fact (Addendum B5)', () => {
  const grab = (f: string) => { const t = readFileSync(join(ROOT, f), 'utf8'); const i = t.indexOf("'Complete auto approves"); return t.slice(i, t.indexOf("Send \"confirm\": true.'", i)); };
  const a = grab('src/server/api.ts'), m = grab('ui/modes.js');
  assert.ok(a.length > 200);
  assert.equal(a, m);
  const un = a.replace(/\\'/g, "'");
  for (const re of [
    /also pushes finished work without asking you/,
    /branch currently checked out in each repository/,
    /on that repository's push remote/,
    /as your own git identity with the ticket key in the commit subject/,
    /Only commits Conductor made are pushed, after the secret and protected-file scans pass/,
    /builder agent itself never pushes/,
    /nothing is pushed to the default branch, a protected name .* or by force/,
    /conductor\/ branch instead/,
    /visible to everyone with access to the remote/,
    /To turn pushing off, leave Complete auto/,
  ]) assert.match(un, re);
  assert.doesNotMatch(un, /Auto push|Nothing is pushed or merged|Commits stay on the local worktree/);
});

test('static: the push settings are written only by the strict handlers and the importer', () => {
  const writers: string[] = [];
  for (const f of ['src/server/api.ts', 'src/migrate.ts', 'src/config.ts', 'src/pipeline/engine.ts', 'src/pipeline/stages.ts']) {
    const t = readFileSync(join(ROOT, f), 'utf8').replace(/\/\/.*$/gm, '');
    for (const m of t.matchAll(/\.(completeAutoPushAck|developerIdentity|pushRemote)\s*(?:\?\?)?=(?!=)\s*([^;\n]*)/g)) writers.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(writers.sort(), ['src/server/api.ts: completeAutoPushAck', 'src/server/api.ts: developerIdentity', 'src/server/api.ts: pushRemote', 'src/server/api.ts: pushRemote'].sort());
});

test('API: PUT /api/auto-push is strict, confirmed, validated; the run-mode confirm records the push consent', async () => {
  const { makeHarness } = await import('./helpers/harness.ts');
  const { Api } = await import('../src/server/api.ts');
  const h = await makeHarness({ config: (c) => void c.repos.push({ name: 'r', path: '/x', baseBranch: 'main', gates: [], copyFiles: [], envPassthrough: [] } as any) });
  try {
    let cur = h.cfg;
    let saves = 0;
    const api = new Api({ engine: h.engine, store: h.store, board: h.board, csrf: 'x', version: 't', getConfig: () => cur, saveConfig: (c) => { saves++; cur = c; }, persistent: () => ({ repos: {} }) as any, health: async () => ({}) as any, probe: async () => ({ ok: true, detail: '', durationMs: 1 }) });
    const put = (b: any) => api.handle('PUT', '/api/auto-push', new URLSearchParams(), b) as Promise<any>;
    const bad = (b: any, code = 'bad_request', status = 400) => assert.rejects(put(b), (e: any) => e.status === status && e.code === code, JSON.stringify(b));
    for (const [i, b] of [null, [], { pushRemote: 'x', repo: 'r', confirm: 1 }, { pushRemote: 'origin', repo: 'r', confirm: true, x: 1 }, { autoPush: true, confirm: true }, { repo: 'r', pushBranch: 'conductor/x', confirm: true }].entries()) await assert.rejects(put(b), (e: any) => e.status === 400, 'case ' + i);
    await bad(JSON.parse('{"pushRemote":"up","repo":"r","confirm":true,"__proto__":{"x":1}}'));
    await bad({ pushRemote: 'up', confirm: true }); // no repo
    await bad({ repo: 'nope', pushRemote: 'up', confirm: true }, 'not_found', 404);
    for (const r of ['https://x/y', '-x', 'a:b']) await bad({ repo: 'r', pushRemote: r, confirm: true });
    await bad({ repo: 'r', pushRemote: 'up' }, 'confirm_required');
    await bad({ developerIdentity: { name: 'A', email: 'bad' }, confirm: true });
    await bad({ developerIdentity: { name: 'A', email: 'a@b.co' } }, 'confirm_required');
    assert.equal(saves, 0, 'nothing written by any refused call');
    let r = (await put({ repo: 'r', pushRemote: 'up', confirm: true })).json;
    assert.deepEqual(r.settings.pushTargets.filter((t: any) => t.repo === 'r'), [{ repo: 'r', pushRemote: 'up' }]);
    r = (await put({ developerIdentity: { name: 'Ada', email: 'ada@example.com' }, confirm: true })).json;
    assert.deepEqual(r.settings.developerIdentity, { name: 'Ada', email: 'a***@example.com' });
    assert.equal(cur.developerIdentity?.email, 'ada@example.com');
    assert.equal((await put({ developerIdentity: null, confirm: true })).json.settings.developerIdentity, null);
    assert.equal((await put({ repo: 'r', pushRemote: null })).json.settings.pushTargets.find((t: any) => t.repo === 'r').pushRemote, null, 'the per-repo kill switch needs no confirm');
    for (const k of ['developerIdentity', 'pushTargets', 'pushEffective', 'pushConsentNeeded', 'pushRemote', 'completeAutoPushAck']) {
      await assert.rejects(api.handle('PUT', '/api/settings', new URLSearchParams(), { [k]: true } as any) as Promise<unknown>, (e: any) => e.status === 400 && /auto-push/.test(e.message), k);
    }
    // run mode: no confirmPush field any more; the confirm records the consent; re-confirming an already-on, never-acked Complete auto records it once
    const rm = (b: any) => api.handle('PUT', '/api/run-mode', new URLSearchParams(), b) as Promise<any>;
    await assert.rejects(rm({ runMode: 'complete-auto', confirm: true, confirmPush: true }), (e: any) => e.status === 400);
    await assert.rejects(rm({ runMode: 'complete-auto' }), (e: any) => e.status === 400 && e.code === 'confirm_required');
    assert.equal(cur.pipeline.completeAutoPushAck, undefined);
    const on = (await rm({ runMode: 'complete-auto', confirm: true })).json;
    assert.deepEqual([on.settings.pushEffective, on.settings.pushConsentNeeded], [true, false]);
    assert.equal(typeof cur.pipeline.completeAutoPushAck, 'number');
    assert.deepEqual([api.live().engine.pushEffective, api.live().engine.pushConsentNeeded], [true, false]);
    // an existing config already in Complete auto without the marker: pushing is off, re-confirming (the UI banner) turns it on, only with confirm
    const old = deepCloneCfg(cur);
    delete old.pipeline.completeAutoPushAck;
    cur = old;
    assert.deepEqual([api.live().engine.pushEffective, api.live().engine.pushConsentNeeded], [false, true]);
    const same = (await rm({ runMode: 'complete-auto' })).json;
    assert.equal(same.changed, false);
    assert.equal(cur.pipeline.completeAutoPushAck, undefined, 'no confirm, no consent');
    const acked = (await rm({ runMode: 'complete-auto', confirm: true })).json;
    assert.deepEqual([acked.changed, acked.settings.pushEffective], [false, true]);
    assert.equal(cur.pipeline.runModeChangedAt === old.pipeline.runModeChangedAt, true, 'the mode did not change');
  } finally {
    await h.cleanup();
  }
});
function deepCloneCfg<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }

test('UI: shipHoldText feature-detects and caps; no autoPush note remains', () => {
  const src = readFileSync(join(ROOT, 'ui/modes.js'), 'utf8');
  const sandbox: any = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: 'ui/modes.js' });
  const M = sandbox.ConductorModes;
  assert.equal(M.shipHoldText({}), '');
  assert.equal(M.shipHoldText(null), '');
  assert.equal(M.shipHoldText({ shipHold: { reason: 5 } }), '');
  assert.equal(M.shipHoldText({ shipHold: { reason: ' blocked by KEE-2 ' } }), 'Not pushed yet: blocked by KEE-2');
  assert.ok(M.shipHoldText({ shipHold: { reason: 'x'.repeat(900) } }).length < 430);
  assert.equal(M.autoPushNote, undefined);
  assert.ok(!/innerHTML/.test(readFileSync(join(ROOT, 'ui/app.js'), 'utf8').replace(/\/\/.*$/gm, '')));
});

test('migration: an imported v1 config never carries the push consent or a developer identity', () => {
  const t = readFileSync(join(ROOT, 'src/migrate.ts'), 'utf8');
  assert.match(t, /delete cfg\.pipeline\.completeAutoPushAck/);
  assert.match(t, /delete cfg\.developerIdentity/);
  assert.match(t, /cfg\.pipeline\.runMode = 'per-settings'/);
});
