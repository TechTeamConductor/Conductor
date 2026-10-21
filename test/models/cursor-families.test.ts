// AC2 (§2.4): Cursor families — pure grouping; the union of family ids equals the input ids (nothing dropped by grouping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cursorFamilies, parseCursorId } from '../../src/models/cursor-families.ts';
import { parseCursorList } from '../../src/models/cursor.ts';
import type { ModelEntry } from '../../src/models/types.ts';
import { REAL } from './helpers.ts';

const models = parseCursorList(readFileSync(join(REAL, 'cursor-list-models-2026.10.19.txt'), 'utf8').split('\n')).models;

test('union of family ids = input ids, each id in exactly one family (real fixture)', () => {
  const fams = cursorFamilies(models);
  const all = fams.flatMap((f) => f.ids);
  assert.equal(all.length, models.length);
  assert.deepEqual(new Set(all), new Set(models.map((m) => m.id)));
});

test('parseCursorId: right to left -fast, effort, -thinking', () => {
  assert.deepEqual(parseCursorId('gpt-5.3-codex-high-fast'), { family: 'gpt-5.3-codex', thinking: false, effort: 'high', fast: true });
  assert.deepEqual(parseCursorId('gpt-5.3-codex'), { family: 'gpt-5.3-codex', thinking: false, effort: '', fast: false });
  assert.deepEqual(parseCursorId('claude-opus-4-8-thinking-max-fast'), { family: 'claude-opus-4-8', thinking: true, effort: 'max', fast: true });
  assert.deepEqual(parseCursorId('auto'), { family: 'auto', thinking: false, effort: '', fast: false });
  assert.deepEqual(parseCursorId('composer-2'), { family: 'composer-2', thinking: false, effort: '', fast: false });
  assert.deepEqual(parseCursorId('muse-wonder-1.0-minimal'), { family: 'muse-wonder-1.0', thinking: false, effort: 'minimal', fast: false });
  assert.deepEqual(parseCursorId('-fast'), { family: '-fast', thinking: false, effort: '', fast: false }, 'never an empty family');
});

test('gpt-5.3-codex: the base id is effort "" (its own default), label from the base id', () => {
  const f = cursorFamilies(models).find((x) => x.family === 'gpt-5.3-codex')!;
  assert.ok(f);
  assert.equal(f.efforts[0], '');
  assert.ok(f.efforts.includes('low') && f.efforts.includes('high'));
  assert.equal(f.fast, true);
  assert.equal(f.label, models.find((m) => m.id === 'gpt-5.3-codex')!.label);
});

test('auto is a standalone family; thinking / fast / noZdr are aggregated', () => {
  const fams = cursorFamilies(models);
  const auto = fams.find((x) => x.family === 'auto')!;
  assert.deepEqual(auto.ids, ['auto']);
  assert.deepEqual(auto.efforts, ['']);
  assert.ok(fams.some((f) => f.thinking));
  assert.ok(fams.some((f) => f.noZdr));
});

test('label without a base id: shortest label with effort/Fast/Thinking words removed', () => {
  const ms: ModelEntry[] = [
    { id: 'fam-x-high-fast', label: 'Fam X High Fast' },
    { id: 'fam-x-thinking-low', label: 'Fam X Thinking Low' },
  ];
  const f = cursorFamilies(ms);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.label, 'Fam X');
  assert.deepEqual(f[0]!.efforts, ['low', 'high']);
});
