// M8-2 selection resolution (§2.3, §2.9): AC3 Cursor composition, AC5 custom ids, AC8 no longer available, AC9 tool switch, S1, S13, W5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCursorId } from '../../src/models/cursor-families.ts';
import { modelIdOk } from '../../src/models/sanitize.ts';
import { cursorVariantId, defaultLabel, judgeSelection, modelOffered, resolveSelection, selectionForTool, toolDefaultSelection, type ResolvedSel } from '../../src/models/select.ts';
import { claudeModelArgs, codexModelArgs, cursorModelArgs } from '../../src/agents/model-args.ts';
import { normalizeRoleSel, type RoleModelSel } from '../../src/agents/roles.ts';
import { defaultConfig, normalizeConfig } from '../../src/config.ts';
import type { CatalogView, CursorFamily } from '../../src/models/types.ts';
import type { Config } from '../../src/types.ts';
import { claude13View, claudeEnvView, codexView, cursorView, unavailable } from './m82-fixtures.ts';

const cfgWith = (patch: (c: Config) => void): Config => {
  const c = normalizeConfig(defaultConfig());
  patch(c);
  return c;
};

test('cursorVariantId reaches every listed id of the 265-id fixture from its tuple', () => {
  const cv = cursorView();
  const all = cv.models!.map((m) => m.id);
  assert.equal(all.length, 265, 'the recorded list (M8-1)');
  let reached = 0;
  for (const fam of cv.families!) {
    for (const id of fam.ids) {
      const p = parseCursorId(id);
      const got = cursorVariantId(fam, p);
      assert.ok(got !== null && fam.ids.includes(got), id);
      // a tuple collision takes the first listed id; otherwise every id is reached exactly
      const first = fam.ids.find((x) => JSON.stringify(parseCursorId(x)) === JSON.stringify(p));
      assert.equal(got, first, id);
      if (got === id) reached++;
    }
  }
  assert.equal(reached, all.length, 'no collisions in the recorded list: every id is reachable');
  // ids that do not round-trip (…-max-thinking) resolve to themselves
  const fam = cv.families!.find((f) => f.ids.includes('claude-4.6-opus-max-thinking'))!;
  assert.equal(cursorVariantId(fam, parseCursorId('claude-4.6-opus-max-thinking')), 'claude-4.6-opus-max-thinking');
  const r = resolveSelection('cursor', { tool: 'cursor', model: fam.family, thinking: true }, cv, 'role');
  assert.equal(r.modelArg, 'claude-4.6-opus-max-thinking');
});

test('composed output is always a listed id', () => {
  const cv = cursorView();
  const listed = new Set(cv.models!.map((m) => m.id));
  for (const fam of cv.families!) {
    for (const effort of [undefined, 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      for (const thinking of [false, true]) {
        for (const fast of [false, true]) {
          const sel: RoleModelSel = { tool: 'cursor', model: fam.family, ...(effort ? { effort } : {}), ...(thinking ? { thinking: true } : {}), ...(fast ? { fast: true } : {}) };
          const r = resolveSelection('cursor', sel, cv, 'role');
          assert.ok(r.modelArg !== undefined && listed.has(r.modelArg), `${fam.family} ${effort} ${thinking} ${fast} → ${r.modelArg}`);
          assert.equal(r.effortArg, undefined, 'Cursor never gets an effort argument');
        }
      }
    }
  }
});

test('cursorVariantId returns an element of family.ids (identity), never a built string', () => {
  const fam: CursorFamily = { family: 'x', efforts: ['', 'high'], thinking: false, fast: true, label: 'X', noZdr: false, ids: ['x', 'x-high', 'x-high-fast'] };
  const got = cursorVariantId(fam, { thinking: false, effort: 'high', fast: true });
  assert.equal(got, fam.ids[2]);
  assert.equal(cursorVariantId(fam, { thinking: true, effort: 'high', fast: false }), null, 'no listed tuple ⇒ null, nothing is composed');
  assert.equal(cursorVariantId(fam, { thinking: false, effort: 'low', fast: false }), null);
});

test('missing tuple: PUT refuses, run falls back fast→thinking→effort with notes', () => {
  const fam: CursorFamily = { family: 'x', efforts: ['low', 'high'], thinking: true, fast: true, label: 'X Model', noZdr: false, ids: ['x-low', 'x-high', 'x-high-fast', 'x-thinking-high'] };
  const cat: CatalogView = { provider: 'cursor', state: 'fresh', signedIn: true, models: fam.ids.map((id) => ({ id, label: id })), families: [fam] };
  // PUT: the exact tuple must be listed
  const p = judgeSelection('cursor', { model: 'x', effort: 'low', thinking: true, fast: true }, cat);
  assert.equal(p?.code, 'unknown_model');
  assert.match(p!.message, /X Model with Low, Thinking, Fast/);
  // run time: drop fast → drop thinking
  const r = resolveSelection('cursor', { tool: 'cursor', model: 'x', effort: 'low', thinking: true, fast: true }, cat, 'role');
  assert.equal(r.modelArg, 'x-low');
  assert.deepEqual(r.notes, ['X Model has no Fast variant for this choice — Fast was dropped.', 'X Model has no Thinking variant for this choice — Thinking was dropped.']);
  // run time: drop fast only
  const r2 = resolveSelection('cursor', { tool: 'cursor', model: 'x', effort: 'high', thinking: true, fast: true }, cat, 'role');
  assert.equal(r2.modelArg, 'x-thinking-high');
  assert.equal(r2.notes.length, 1);
  // a valid tuple: no notes, no refusal
  assert.equal(judgeSelection('cursor', { model: 'x', effort: 'high', fast: true }, cat), null);
  assert.equal(resolveSelection('cursor', { tool: 'cursor', model: 'x', effort: 'high', fast: true }, cat, 'role').modelArg, 'x-high-fast');
  // effort fitted to a level the family has (medium ⇒ tie ⇒ high)
  const r3 = resolveSelection('cursor', { tool: 'cursor', model: 'x', effort: 'medium' }, cat, 'role');
  assert.equal(r3.modelArg, 'x-high');
  assert.deepEqual(r3.notes, ['X Model has no Medium, so the effort is now High.']);
});

test('custom id rule at use; Cursor custom fails closed', () => {
  const cl = resolveSelection('claude', { tool: 'claude', model: 'my-private-model', custom: true }, null, 'role');
  assert.equal(cl.modelArg, 'my-private-model', 'Claude custom passes as-is, list or not');
  const cx = resolveSelection('codex', { tool: 'codex', model: 'gpt-x', custom: true }, null, 'role');
  assert.equal(cx.modelArg, 'gpt-x');
  const cu = resolveSelection('cursor', { tool: 'cursor', model: 'gpt-5.2', custom: true }, cursorView(), 'role');
  assert.equal(cu.modelArg, 'gpt-5.2', 'a listed Cursor id passes');
  const nl = resolveSelection('cursor', { tool: 'cursor', model: 'gpt-99', custom: true }, cursorView(), 'role');
  assert.equal(nl.modelArg, undefined);
  assert.equal(nl.fallback, 'not-in-list');
  const nc = resolveSelection('cursor', { tool: 'cursor', model: 'gpt-5.2', custom: true }, null, 'role');
  assert.equal(nc.modelArg, undefined);
  assert.equal(nc.fallback, 'list-unavailable');
  // the rule is re-checked at use even for a forged (never-normalised) selection
  for (const bad of ['--yolo', 'a b', 'x[1m][2m]', 'gpt-5[effort=high]']) assert.equal(resolveSelection('claude', { tool: 'claude', model: bad, custom: true }, null, 'role').modelArg, undefined, bad);
  assert.equal(resolveSelection('codex', { tool: 'codex', model: 'x[1m]', custom: true }, null, 'role').modelArg, undefined, 'Codex never brackets');
});

test('Cursor migrated value with no list: no --model, list-unavailable (S1)', () => {
  const cfg = normalizeConfig({ agents: { cursor: { model: 'gpt-5' } } });
  assert.deepEqual(cfg.toolModels.cursor, { model: 'gpt-5', custom: true });
  const r = selectionForTool('implementation', 'cursor', cfg, null);
  assert.equal(r.modelArg, undefined);
  assert.ok(r.notes.some((n) => /Cursor's model list is not available/.test(n)), r.notes.join('|'));
  assert.deepEqual(cursorModelArgs({ model: r.modelArg }), []);
});

test('Cursor migrated value not in list: not-in-list (S1, B5c)', () => {
  const cfg = normalizeConfig({ agents: { cursor: { model: 'gpt-5' } } });
  const r = selectionForTool('implementation', 'cursor', cfg, cursorView());
  assert.equal(r.modelArg, undefined);
  assert.ok(r.notes.some((n) => /gpt-5 is not in Cursor's model list/.test(n)), r.notes.join('|'));
});

test('family name without a base id is never sent (S1)', () => {
  const cv = cursorView();
  const listed = new Set(cv.models!.map((m) => m.id));
  for (const fam of cv.families!.filter((f) => !f.efforts.includes('') && !listed.has(f.family))) {
    for (const s of [{ model: fam.family }, { model: fam.family, custom: true as const }]) {
      for (const via of ['role', 'toolModels'] as const) {
        const cfg = cfgWith((c) => {
          if (via === 'role') Object.assign(c.roles.implementation, { tool: 'cursor', ...s });
          else c.toolModels.cursor = { ...s };
        });
        const r = selectionForTool('implementation', 'cursor', cfg, cv);
        assert.notEqual(r.modelArg, fam.family, `${fam.family} via ${via} ${JSON.stringify(s)}`);
        assert.ok(r.modelArg === undefined || listed.has(r.modelArg));
      }
    }
  }
});

test('saved model missing from catalog ⇒ fallback no-longer-offered; signed out ⇒ signed-out wording', () => {
  const cat = claudeEnvView();
  const cfg = cfgWith((c) => Object.assign(c.roles.planning, { tool: 'claude', model: 'claude-opus-4-1', effort: 'high' }));
  const r = selectionForTool('planning', 'claude', cfg, cat);
  assert.equal(r.fallback, 'no-longer-offered');
  assert.equal(r.modelArg, undefined, 'tool default: no --model');
  assert.equal(r.effortArg, 'high', 'effort fitted to the default model');
  assert.ok(r.notes.includes('claude-opus-4-1 is no longer offered by Claude — using the tool default.'));
  const out = selectionForTool('planning', 'claude', cfg, { ...cat, signedIn: false });
  assert.ok(out.notes.includes('claude-opus-4-1 is not offered while Claude is signed out — using the tool default.'));
  // with a toolModels default, the fallback uses it
  const cfg2 = cfgWith((c) => {
    Object.assign(c.roles.planning, { tool: 'claude', model: 'claude-opus-4-1' });
    c.toolModels.claude = { model: 'sonnet' };
  });
  const r2 = selectionForTool('planning', 'claude', cfg2, cat);
  assert.equal(r2.modelArg, 'sonnet');
  assert.equal(r2.label, 'Tool default (Sonnet)');
  // list unavailable
  const r3 = selectionForTool('planning', 'claude', cfg, unavailable('claude'));
  assert.equal(r3.fallback, 'list-unavailable');
  assert.equal(r3.modelArg, undefined);
});

test('§2.9 semantics table: every cell (modelArg/fallback/modelOffered)', () => {
  const states: [string, CatalogView | null][] = [['null', null], ['reading', { provider: 'claude', state: 'reading' }], ['unavailable', unavailable('claude')]];
  const cl = claudeEnvView();
  const cu = cursorView();
  // row 1: no list
  for (const [name, c] of states) {
    const cC = c ? { ...c, provider: 'cursor' as const } : null;
    const a = resolveSelection('claude', { tool: 'claude', model: 'opus' }, c, 'role');
    assert.deepEqual([a.modelArg, a.fallback, modelOffered('claude', c, { model: 'opus' })], [undefined, 'list-unavailable', null], `${name} discovered`);
    const b = resolveSelection('claude', { tool: 'claude', model: 'opus', custom: true }, c, 'role');
    assert.deepEqual([b.modelArg, b.fallback, modelOffered('claude', c, { model: 'opus', custom: true })], ['opus', undefined, true], `${name} custom`);
    const d = resolveSelection('cursor', { tool: 'cursor', model: 'gpt-5.2' }, cC, 'role');
    assert.deepEqual([d.modelArg, d.fallback, modelOffered('cursor', cC, { model: 'gpt-5.2' })], [undefined, 'list-unavailable', null], `${name} cursor family`);
    const e = resolveSelection('cursor', { tool: 'cursor', model: 'gpt-5.2', custom: true }, cC, 'role');
    assert.deepEqual([e.modelArg, e.fallback, modelOffered('cursor', cC, { model: 'gpt-5.2', custom: true })], [undefined, 'list-unavailable', null], `${name} cursor custom`);
    const f = resolveSelection('claude', {}, c, 'tool-default', { model: 'opus', custom: true });
    assert.deepEqual([f.modelArg, f.fallback, modelOffered('claude', c, {})], ['opus', undefined, true], `${name} tool default (custom toolModels value may be sent)`);
    const g = resolveSelection('cursor', {}, cC, 'tool-default', { model: 'gpt-5.2', custom: true });
    assert.deepEqual([g.modelArg, g.fallback], [undefined, undefined], `${name} cursor tool default: never sent without a list`);
  }
  for (const st of ['fresh', 'stale'] as const) {
    const c = { ...cl, state: st };
    const k = { ...cu, state: st };
    // row 2: listed
    assert.deepEqual([resolveSelection('claude', { tool: 'claude', model: 'opus' }, c, 'role').modelArg, modelOffered('claude', c, { model: 'opus' })], ['opus', true]);
    assert.deepEqual([resolveSelection('claude', { tool: 'claude', model: 'x', custom: true }, c, 'role').modelArg, modelOffered('claude', c, { model: 'x', custom: true })], ['x', true]);
    assert.deepEqual([resolveSelection('cursor', { tool: 'cursor', model: 'gpt-5.3-codex', effort: 'high' }, k, 'role').modelArg, modelOffered('cursor', k, { model: 'gpt-5.3-codex' })], ['gpt-5.3-codex-high', true]);
    assert.deepEqual([resolveSelection('cursor', { tool: 'cursor', model: 'gpt-5.2', custom: true }, k, 'role').modelArg, modelOffered('cursor', k, { model: 'gpt-5.2', custom: true })], ['gpt-5.2', true]);
    // row 3: not listed
    const n1 = resolveSelection('claude', { tool: 'claude', model: 'gone' }, c, 'role');
    assert.deepEqual([n1.modelArg, n1.fallback, modelOffered('claude', c, { model: 'gone' })], [undefined, 'no-longer-offered', false]);
    const n3 = resolveSelection('cursor', { tool: 'cursor', model: 'gone' }, k, 'role');
    assert.deepEqual([n3.modelArg, n3.fallback, modelOffered('cursor', k, { model: 'gone' })], [undefined, 'no-longer-offered', false]);
    const n4 = resolveSelection('cursor', { tool: 'cursor', model: 'gone', custom: true }, k, 'role');
    assert.deepEqual([n4.modelArg, n4.fallback, modelOffered('cursor', k, { model: 'gone', custom: true })], [undefined, 'not-in-list', false]);
    assert.equal(modelOffered('claude', c, {}), true, 'tool default is always offered');
  }
});

test('selectionForTool: non-head tool gets toolModels default + fitted effort, flags dropped (AC9)', () => {
  const cfg = cfgWith((c) => {
    Object.assign(c.roles.planning, { tool: 'cursor', model: 'gpt-5.3-codex', effort: 'xhigh', fast: true });
    c.toolModels.claude = { model: 'sonnet' };
  });
  const head = selectionForTool('planning', 'cursor', cfg, cursorView());
  assert.equal(head.modelArg, 'gpt-5.3-codex-xhigh-fast');
  assert.equal(head.source, 'role');
  // the fallback tool (Claude) ignores the Cursor choice
  const fb = selectionForTool('planning', 'claude', cfg, claudeEnvView());
  assert.equal(fb.source, 'tool-default');
  assert.equal(fb.modelArg, 'sonnet');
  assert.equal(fb.effortArg, 'xhigh', 'the role effort is fitted to the tool that runs');
  assert.equal(fb.fast, false);
  // no toolModels default ⇒ no --model; effort fitted against the default entry
  const fb2 = selectionForTool('planning', 'claude', cfgWith((c) => Object.assign(c.roles.planning, { tool: 'cursor', model: 'gpt-5.2', effort: 'minimal' })), claudeEnvView());
  assert.equal(fb2.modelArg, undefined);
  assert.equal(fb2.effortArg, 'low', 'minimal is not a Claude level: nearest is low');
  assert.equal(fb2.label, 'Tool default (Opus)');
  // N4: toolDefaultOnly ignores the role
  assert.equal(selectionForTool('planning', 'cursor', cfg, cursorView(), { toolDefaultOnly: true }).modelArg, undefined);
});

test('a Claude id that equals a Cursor family name is never applied to Cursor (B2)', () => {
  const cfg = cfgWith((c) => Object.assign(c.roles.planning, { tool: 'claude', model: 'gpt-5.2', custom: true }));
  const r = selectionForTool('planning', 'cursor', cfg, cursorView());
  assert.equal(r.modelArg, undefined);
  assert.equal(r.source, 'tool-default');
});

test('Tool default label names what the tool picks (real Conductor-env fixture)', () => {
  assert.equal(defaultLabel('claude', claudeEnvView()), 'Opus', 'default → claude-opus-5-5 → the Opus alias');
  assert.equal(defaultLabel('cursor', cursorView()), 'Auto');
  assert.equal(defaultLabel('claude', null), 'the tool chooses');
  assert.equal(defaultLabel('codex', codexView()), 'GPT-5.1 Codex');
  assert.deepEqual(toolDefaultSelection({ toolModels: { claude: { model: '--yolo' } } }, 'claude'), {}, 'a hostile stored default is ignored');
});

test('(NO ZDR) is a note, never a block (Q8)', () => {
  const r = resolveSelection('cursor', { tool: 'cursor', model: 'claude-fable-5', effort: 'high', thinking: true }, cursorView(), 'role');
  assert.equal(r.modelArg, 'claude-fable-5-thinking-high');
  assert.equal(r.noZdr, true);
  assert.ok(r.notes.some((n) => /NO ZDR/.test(n)));
});

test('modelIdOk per provider: W5 table (via modelIdOk, PUT, load, argv helpers)', () => {
  const claudeOnly = ['claude-fable-5-1[1m]', 'opus[1m]'];
  const rejectAll = ['x[1m][2m]', 'x[1M]', 'x[effort=high]', 'x[1m,fast]', 'x[ 1m]', 'x[]', 'x[123456789]', 'x[1m]y', '[1m]', '-x[1m]', 'x[1m]\n', 'x[1m] ', 'a'.repeat(75)];
  const ok74 = 'a'.repeat(64) + '[12345678]';
  assert.equal(ok74.length, 74);
  const argvOf = (tool: 'claude' | 'cursor' | 'codex', id: string) => (tool === 'claude' ? claudeModelArgs({ model: id }) : tool === 'cursor' ? cursorModelArgs({ model: id }) : codexModelArgs({ model: id }));
  const putOk = (tool: 'claude' | 'cursor' | 'codex', id: string) => judgeSelection(tool, { model: id, custom: true }, tool === 'cursor' ? { provider: 'cursor', state: 'fresh', models: [{ id, label: id }], families: [] } : null)?.key !== 'model';
  const loadOk = (tool: 'claude' | 'cursor' | 'codex', id: string) => normalizeRoleSel({ tool, model: id, custom: true }).model === id;
  for (const id of [...claudeOnly, ok74]) {
    assert.equal(modelIdOk('claude', id), true, id);
    assert.equal(putOk('claude', id), true, id);
    assert.equal(loadOk('claude', id), true, id);
    assert.deepEqual(argvOf('claude', id), ['--model', id]);
    for (const t of ['cursor', 'codex'] as const) {
      assert.equal(modelIdOk(t, id), false, `${t} ${id}`);
      assert.equal(putOk(t, id), false, `${t} ${id}`);
      assert.equal(loadOk(t, id), false, `${t} ${id}`);
      assert.deepEqual(argvOf(t, id), [], `${t} ${id}`);
    }
  }
  for (const id of rejectAll) {
    for (const t of ['claude', 'cursor', 'codex'] as const) {
      assert.equal(modelIdOk(t, id), false, `${t} ${JSON.stringify(id)}`);
      assert.equal(putOk(t, id), false, `${t} ${JSON.stringify(id)}`);
      assert.equal(loadOk(t, id), false, `${t} ${JSON.stringify(id)}`);
      assert.deepEqual(argvOf(t, id), [], `${t} ${JSON.stringify(id)}`);
    }
  }
});

test('selection results carry only static wording + cleaned labels/ids (S9)', () => {
  const r: ResolvedSel = selectionForTool('planning', 'claude', cfgWith((c) => Object.assign(c.roles.planning, { tool: 'claude', model: 'claude-sonnet-4-6', effort: 'xhigh' })), claude13View());
  for (const n of r.notes) assert.doesNotMatch(n, /[<>/\\]|\/Users|\/tmp/);
});

test("Claude's `default` alias is never a choosable model and never sent as --model default (CR-N1); Codex's default entry is a real model", () => {
  const cat = claudeEnvView();
  const r = resolveSelection('claude', { tool: 'claude', model: 'default' }, cat, 'role');
  assert.equal(r.modelArg, undefined);
  assert.equal(r.fallback, 'no-longer-offered');
  assert.equal(modelOffered('claude', cat, { model: 'default' }), false);
  assert.equal(judgeSelection('claude', { model: 'default' }, cat)?.code, 'unknown_model');
  const cx = resolveSelection('codex', { tool: 'codex', model: 'gpt-5.1-codex' }, codexView(), 'role');
  assert.equal(cx.modelArg, 'gpt-5.1-codex', 'Codex: the server-default model may be chosen explicitly');
  assert.equal(judgeSelection('codex', { model: 'gpt-5.1-codex' }, codexView()), null);
});
