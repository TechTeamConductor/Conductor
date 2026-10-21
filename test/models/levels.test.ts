// M8-2 AC4 (effort fitting) + N14 + S13 static purity for levels.ts / select.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EFFORTS, CLAUDE_EFFORTS, effortsMatchDiscovery, fitEffort, levelsFor } from '../../src/models/levels.ts';
import { EFFORT_TOKENS } from '../../src/models/sanitize.ts';
import { resolveSelection } from '../../src/models/select.ts';
import { claude13View, cursorView } from './m82-fixtures.ts';

test('EffortToken set equals EFFORT_TOKENS (N14)', () => {
  assert.deepEqual([...EFFORTS], [...EFFORT_TOKENS]);
  assert.equal(effortsMatchDiscovery(), true);
  assert.deepEqual([...CLAUDE_EFFORTS], ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('fitEffort table (kept/nearest/tie-higher/null/unset)', () => {
  const lv = ['low', 'medium', 'high', 'max'];
  assert.deepEqual(fitEffort(lv, 'high'), { effort: 'high', adjusted: false }, 'kept');
  assert.deepEqual(fitEffort(lv, 'xhigh'), { effort: 'max', adjusted: true }, 'tie between high and max ⇒ the higher');
  assert.deepEqual(fitEffort(['low', 'high'], 'medium'), { effort: 'high', adjusted: true }, 'tie ⇒ higher');
  assert.deepEqual(fitEffort(['high', 'max'], 'minimal'), { effort: 'high', adjusted: true }, 'nearest');
  assert.deepEqual(fitEffort(['low'], 'max'), { effort: 'low', adjusted: true });
  assert.deepEqual(fitEffort(null, 'high'), { effort: undefined, adjusted: true }, 'null levels ⇒ dropped');
  assert.deepEqual(fitEffort(null, undefined), { effort: undefined, adjusted: false });
  assert.deepEqual(fitEffort(lv, undefined), { effort: undefined, adjusted: false }, 'unset stays unset (byte-identical argv)');
  assert.deepEqual(fitEffort(lv, 'high --yolo'), { effort: undefined, adjusted: false }, 'a non-token is never a wish');
  assert.deepEqual(fitEffort(['bogus', 'high'], 'high'), { effort: 'high', adjusted: false }, 'non-token levels ignored');
});

test('Cursor family without base id fits toward medium', () => {
  assert.deepEqual(fitEffort(['low', 'high', 'xhigh'], undefined, { needsToken: true }), { effort: 'high', adjusted: false });
  assert.deepEqual(fitEffort(['high', 'xhigh'], undefined, { needsToken: true }), { effort: 'high', adjusted: false });
  assert.deepEqual(fitEffort(['low', 'medium'], undefined, { needsToken: true }), { effort: 'medium', adjusted: false });
  const cv = cursorView();
  // real families with no base id: kimi-k3 (low, high, max) and claude-4.6-opus (high, max) — no medium id, the tie goes up
  for (const [family, want] of [['kimi-k3', 'kimi-k3-high'], ['claude-4.6-opus', 'claude-4.6-opus-high'], ['claude-opus-5', 'claude-opus-5-medium']] as const) {
    const fam = cv.families!.find((f) => f.family === family)!;
    assert.equal(fam.efforts.includes(''), false, family);
    const r = resolveSelection('cursor', { tool: 'cursor', model: family }, cv, 'role');
    assert.equal(r.modelArg, want, `${family}: no effort chosen + no base id ⇒ a token-bearing listed id`);
    assert.deepEqual(r.notes, [], family);
  }
});

test('xhigh on claude-sonnet-4-6 (real fixture) becomes max with one note; max kept', () => {
  const cat = claude13View(); // a real reply shape, not Conductor's own env
  assert.deepEqual(levelsFor('claude', cat, { model: 'claude-sonnet-4-6' }), ['low', 'medium', 'high', 'max']);
  const r = resolveSelection('claude', { tool: 'claude', model: 'claude-sonnet-4-6', effort: 'xhigh' }, cat, 'role');
  assert.equal(r.modelArg, 'claude-sonnet-4-6');
  assert.equal(r.effortArg, 'max');
  assert.deepEqual(r.notes, ['Sonnet 4.6 has no Extra high, so the effort is now Max.']);
  const k = resolveSelection('claude', { tool: 'claude', model: 'claude-sonnet-4-6', effort: 'max' }, cat, 'role');
  assert.equal(k.effortArg, 'max');
  assert.deepEqual(k.notes, []);
});

test('Haiku 4.5 drops effort with one note', () => {
  const cat = claude13View();
  assert.equal(levelsFor('claude', cat, { model: 'claude-haiku-4-5-20251001' }), null);
  for (const e of ['low', 'high', 'max'] as const) {
    const r = resolveSelection('claude', { tool: 'claude', model: 'claude-haiku-4-5-20251001', effort: e }, cat, 'role');
    assert.equal(r.effortArg, undefined);
    assert.equal(r.modelArg, 'claude-haiku-4-5-20251001');
    assert.deepEqual(r.notes, ['Haiku 4.5 has no effort setting.']);
  }
});

test('custom id effort = union of the reported levels; no catalog ⇒ null', () => {
  assert.deepEqual(levelsFor('claude', claude13View(), { model: 'my-model', custom: true }), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(levelsFor('claude', null, { model: 'my-model', custom: true }), null);
  assert.equal(levelsFor('cursor', cursorView(), { model: 'auto', custom: true }), null, 'Cursor custom ids carry no effort');
  assert.equal(levelsFor('cursor', cursorView(), { model: 'auto' }), null, 'Auto has no effort tokens');
  assert.equal(levelsFor('cursor', cursorView(), { model: 'composer-2.5' }), null, 'Composer has no effort tokens');
});

test('static: levels.ts and select.ts import no node:fs, node:child_process or spawn (S13)', () => {
  for (const f of ['levels.ts', 'select.ts']) {
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'models', f), 'utf8');
    const imports = [...src.matchAll(/^import[^;]*from '([^']+)'/gm)].map((m) => m[1]!);
    for (const i of imports) assert.ok(!/^node:|spawn|child_process|\/fs/.test(i), `${f} imports ${i}`);
    assert.doesNotMatch(src, /new RegExp|execFile|spawnSync|readFileSync|writeFileSync/);
  }
  // the argv helpers select.ts uses are a leaf too
  const ma = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'agents', 'model-args.ts'), 'utf8');
  for (const m of ma.matchAll(/^import[^;]*from '([^']+)'/gm)) assert.ok(!/^node:|spawn/.test(m[1]!), m[1]);
});
