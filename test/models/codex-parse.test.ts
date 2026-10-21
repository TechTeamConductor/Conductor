// AC3: the Codex `model/list` parser on a fixture of the documented shape (NOT recorded — see its _note), with pagination.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CODEX_DISCOVERY_ENABLED, CODEX_MAX_PAGES, parseCodexModelList } from '../../src/models/codex.ts';
import { FIXTURES, readJson } from './helpers.ts';

const fx = readJson(join(FIXTURES, 'codex-model-list.json'));

test('the fixture is labelled as not recorded from a real binary', () => {
  assert.match(fx._note, /NOT recorded from a real binary/);
  assert.equal(CODEX_DISCOVERY_ENABLED, false);
});

test('two pages fold into one list; first id wins; efforts from option objects or strings; default flag', () => {
  const p = parseCodexModelList(fx.pages);
  assert.deepEqual(p.models.map((m) => m.id), ['fixture-model-a', 'fixture-model-b', 'fixture-model-c-mini']);
  assert.equal(p.dropped, 1, 'the duplicate on page 2');
  assert.equal(p.pages, 2);
  assert.equal(p.nextCursor, null);
  assert.equal(p.truncated, false);
  const a = p.models[0]!;
  assert.deepEqual(a.efforts, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(a.defaultEffort, 'medium');
  assert.equal(a.isDefault, true);
  assert.equal(a.label, 'Fixture model A');
  assert.deepEqual(p.models[1]!.efforts, ['minimal', 'low', 'medium', 'high']);
  assert.equal(p.models[1]!.isDefault, undefined);
});

test('pagination stops at nextCursor null, and never folds more than 10 pages', () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ data: [{ id: `m-${i}`, displayName: `M ${i}` }], nextCursor: `c${i + 1}` }));
  const p = parseCodexModelList(many);
  assert.equal(p.pages, CODEX_MAX_PAGES);
  assert.equal(p.models.length, 10);
  assert.equal(p.truncated, true);
  const stop = parseCodexModelList([{ data: [{ id: 'a' }], nextCursor: null }, { data: [{ id: 'b' }] }]);
  assert.deepEqual(stop.models.map((m) => m.id), ['a']);
});

test('hostile entries: bad ids, bad efforts, non-arrays, polluted keys', () => {
  const p = parseCodexModelList([{ data: [{ id: '--flag' }, { model: 'ok-1', supportedReasoningEfforts: ['ultra', { reasoningEffort: 'low' }], defaultReasoningEffort: 'ultra', isDefault: 'yes' }, JSON.parse('{"__proto__":{"isDefault":true},"id":"ok-2"}'), null, 7], nextCursor: 5 }, { data: 'nope' }]);
  assert.deepEqual(p.models.map((m) => m.id), ['ok-1', 'ok-2']);
  assert.deepEqual(p.models[0]!.efforts, ['low']);
  assert.equal(p.models[0]!.defaultEffort, undefined);
  assert.equal(p.models[0]!.isDefault, undefined);
  assert.equal(p.models[1]!.isDefault, undefined);
  assert.equal(({} as any).isDefault, undefined);
});
