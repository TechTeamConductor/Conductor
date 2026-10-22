// M8-2 argv with selections (AC2), "Runs as" (S9), effort constants (S5), the Codex tail (S6), Claude flag set (S7), W6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs, claudeModelArgs } from '../src/agents/claude.ts';
import { buildCursorArgs, cursorModelArgs } from '../src/agents/cursor.ts';
import { buildCodexArgs, codexModelArgs, CODEX_ARGV_DIGEST } from '../src/agents/providers/codex.ts';
import { CODEX_EFFORT_ARG } from '../src/agents/model-args.ts';
import { EFFORTS } from '../src/models/levels.ts';
import { resolveSelection, runsAs, selectionForTool, type ResolvedSel } from '../src/models/select.ts';
import { defaultConfig, normalizeConfig } from '../src/config.ts';
import { claudeEnvView, codexView, cursorView } from './models/m82-fixtures.ts';

const BASE = buildClaudeArgs({ maxTurns: 40, isolation: 'safe-mode', name: 'conductor ENG-1 plan' });
const schema = { type: 'object' } as any;
const CODEX_CONST = buildCodexArgs({ outFile: '<out>' });
const HOSTILE = ['--yolo', '-c', 'opus --dangerously-skip-permissions', 'a=b', 'x y', 'gpt-5[effort=high]', 'a'.repeat(65), 'op‮us', 'op​us', '__proto__', 'high --yolo', 'none', ''];

const indexOfSlice = (hay: string[], needle: string[]): number => {
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((x, k) => hay[i + k] === x)) return i;
  return -1;
};

test('Claude/Codex/Cursor argv with model+effort: exact elements at today\'s --model position', () => {
  const a = buildClaudeArgs({ maxTurns: 40, isolation: 'safe-mode', name: 'conductor ENG-1 plan', model: 'sonnet', effort: 'high', schema });
  const n = a.indexOf('-n');
  assert.deepEqual(a.slice(n, n + 6), ['-n', 'conductor ENG-1 plan', '--model', 'sonnet', '--effort', 'high']);
  assert.deepEqual(a.slice(n + 6), ['--json-schema', JSON.stringify(schema)]);
  assert.deepEqual(a.slice(0, n + 2), BASE, 'everything before the slice is today\'s argv');
  // Codex: --model=<id> and the one literal -c pair, immediately before -o
  const c = buildCodexArgs({ outFile: '/o', model: 'gpt-5.1-codex', effort: 'medium' });
  const o = c.indexOf('-o');
  assert.deepEqual(c.slice(o - 3), ['--model=gpt-5.1-codex', '-c', 'model_reasoning_effort="medium"', '-o', '/o', '-']);
  // Cursor: --model <listed id> last
  assert.deepEqual(buildCursorArgs({ mode: 'ask', cwd: '/w', model: 'gpt-5.3-codex-high' }).slice(-2), ['--model', 'gpt-5.3-codex-high']);
  assert.deepEqual(buildCursorArgs({ mode: 'build', cwd: '/w', model: 'gpt-5.3-codex-high' }), ['-p', '--force', '--trust', '--output-format', 'stream-json', '--workspace', '/w', '--model', 'gpt-5.3-codex-high']);
});

test('Claude --model claude-fable-5-1[1m] is one argv element (W6)', () => {
  const r = selectionForTool('planning', 'claude', { ...normalizeConfig(defaultConfig()), roles: { ...defaultConfig().roles, planning: { providers: ['claude'], tool: 'claude', model: 'claude-fable-5-1[1m]', effort: 'max' } } }, claudeEnvView());
  assert.equal(r.modelArg, 'claude-fable-5-1[1m]');
  const a = buildClaudeArgs({ maxTurns: 40, isolation: 'safe-mode', name: 'n', model: r.modelArg, effort: r.effortArg });
  const i = a.indexOf('--model');
  assert.equal(a[i + 1], 'claude-fable-5-1[1m]', 'one element, brackets intact');
  assert.equal(a.filter((x) => x.includes('[1m]')).length, 1);
  assert.deepEqual(a.slice(i, i + 4), ['--model', 'claude-fable-5-1[1m]', '--effort', 'max']);
  assert.equal(runsAs('claude', r), 'claude --model claude-fable-5-1[1m] --effort max');
});

test('runsAs is a contiguous slice of the real argv (every tool, every selection kind)', () => {
  const sels: ResolvedSel[] = [
    resolveSelection('claude', {}, null, 'tool-default'),
    resolveSelection('claude', { tool: 'claude', model: 'opus', effort: 'low' }, claudeEnvView(), 'role'),
    resolveSelection('claude', { tool: 'claude', model: 'my-id', custom: true }, null, 'role'),
    resolveSelection('claude', {}, claudeEnvView(), 'tool-default', { model: 'sonnet' }),
    resolveSelection('cursor', {}, null, 'tool-default'),
    resolveSelection('cursor', { tool: 'cursor', model: 'gpt-5.3-codex', effort: 'xhigh', fast: true }, cursorView(), 'role'),
    resolveSelection('cursor', { tool: 'cursor', model: 'gpt-5.2', custom: true }, cursorView(), 'role'),
    resolveSelection('codex', {}, null, 'tool-default'),
    resolveSelection('codex', { tool: 'codex', model: 'gpt-5.3-codex', effort: 'minimal' }, codexView(), 'role'),
    resolveSelection('codex', { tool: 'codex', model: 'x', custom: true }, null, 'role'),
  ];
  for (const r of sels) {
    const line = runsAs(r.tool, r);
    const parts = line.split(' ');
    let full: string[];
    let prefixLen: number;
    if (r.tool === 'claude') {
      full = ['claude', ...buildClaudeArgs({ maxTurns: 40, isolation: 'safe-mode', name: 'n', model: r.modelArg, effort: r.effortArg, schema })];
      prefixLen = 1;
    } else if (r.tool === 'cursor') {
      full = ['agent', ...buildCursorArgs({ mode: 'ask', cwd: '/w', model: r.modelArg })];
      prefixLen = 1;
    } else {
      full = ['codex', ...buildCodexArgs({ outFile: '/o', model: r.modelArg, effort: r.effortArg })];
      prefixLen = 2;
    }
    const slice = parts.slice(prefixLen);
    if (slice.length) assert.ok(indexOfSlice(full, slice) > 0, `${line} ⊄ ${full.join(' ')}`);
    assert.deepEqual(full.slice(0, prefixLen), parts.slice(0, prefixLen));
  }
});

test('runsAs has no bin path, cwd, workspace, -o, -n, schema (S9)', () => {
  const cfg = normalizeConfig({ ...defaultConfig(), agents: { claude: { bin: '/Users/someone/bin/claude' }, cursor: { bin: '/opt/x/agent' }, codex: { bin: '/opt/y/codex' } } });
  void cfg;
  for (const r of [resolveSelection('claude', { tool: 'claude', model: 'opus', effort: 'high' }, claudeEnvView(), 'role'), resolveSelection('cursor', { tool: 'cursor', model: 'gpt-5.2' }, cursorView(), 'role'), resolveSelection('codex', { tool: 'codex', model: 'x', custom: true, effort: 'high' }, codexView(), 'role')]) {
    const line = runsAs(r.tool, r);
    assert.doesNotMatch(line, /\/Users|\/opt|--workspace|-o |-n |--json-schema|FAKE|HOME/);
    assert.match(line, /^(claude|agent|codex exec)( |$)/);
  }
});

test("forged effortArg ('high --yolo', 'none' for Claude) yields no --effort/-c element (S5)", () => {
  for (const e of ['high --yolo', 'none', 'minimal', 'HIGH', ' high', '__proto__', 'x"; danger']) {
    assert.ok(!buildClaudeArgs({ maxTurns: 3, isolation: 'safe-mode', name: 'n', effort: e }).includes('--effort'), e);
    assert.deepEqual(claudeModelArgs({ effort: e }), []);
  }
  for (const e of ['high --yolo', 'HIGH', 'x"', 'medium" -c sandbox_mode="danger-full-access']) assert.deepEqual(codexModelArgs({ effort: e }), [], e);
  for (const e of EFFORTS) assert.deepEqual(codexModelArgs({ effort: e }), ['-c', `model_reasoning_effort="${e}"`]);
  // the argv string is the constant table element, not the caller's string
  const tok = String('hi') + 'gh';
  assert.equal(claudeModelArgs({ effort: tok })[1], 'high');
});

test('Cursor argv never carries an effort argument; Cursor mode flags independent of sel (S5, S7)', () => {
  for (const id of ['gpt-5.3-codex-high', 'gpt-5.2']) {
    for (const mode of ['ask', 'plan', 'build'] as const) {
      const a = buildCursorArgs({ mode, cwd: '/w', model: id });
      assert.ok(!a.some((x) => /effort/.test(x)));
      if (mode === 'build') assert.ok(a.includes('--force') && !a.includes('--mode'));
      else assert.deepEqual(a.slice(1, 3), ['--mode', mode]);
      assert.deepEqual(a.slice(0, -2), buildCursorArgs({ mode, cwd: '/w' }));
    }
  }
  assert.deepEqual(cursorModelArgs({ model: 'x', ...({ effort: 'high' } as object) }), ['--model', 'x']);
});

test('Codex argv = constants + only --model= and/or one literal -c before -o (every token, hostile set) (S6)', () => {
  const o = CODEX_CONST.indexOf('-o');
  const head = CODEX_CONST.slice(0, o);
  const tail = CODEX_CONST.slice(o).filter((x) => x !== '<out>');
  for (const model of [undefined, 'gpt-5.1-codex', ...HOSTILE]) {
    for (const effort of [undefined, ...EFFORTS, ...HOSTILE]) {
      const a = buildCodexArgs({ outFile: '<out>', model, effort });
      assert.deepEqual(a.slice(0, o), head, 'the constant head is untouched');
      const ins = a.slice(o, a.indexOf('-o'));
      const allowed = [...(model && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(model) ? [`--model=${model}`] : []), ...(effort && (EFFORTS as readonly string[]).includes(effort) ? ['-c', CODEX_EFFORT_ARG[effort as keyof typeof CODEX_EFFORT_ARG]] : [])];
      assert.deepEqual(ins, allowed, `${model} / ${effort}`);
      assert.deepEqual(a.slice(a.indexOf('-o')).filter((x) => x !== '<out>'), tail);
      assert.equal(a.filter((x) => x === '-c').length, 5 + (allowed.includes('-c') ? 1 : 0), 'no other -c key is ever added');
      for (const v of a.filter((_, k) => a[k - 1] === '-c').slice(5)) assert.ok(Object.values(CODEX_EFFORT_ARG).includes(v));
    }
  }
});

test('CODEX_ARGV_DIGEST unchanged (S6, N9)', () => {
  assert.equal(CODEX_ARGV_DIGEST(), 'c5390760181a53f4f01fd5b874437c2cb284f1985ef80f2e8d75856b70ed32ce');
});

test('Claude flag set ⊆ today ∪ {--model,--effort} (S7)', () => {
  const today = new Set([...buildClaudeArgs({ maxTurns: 3, isolation: 'safe-mode', name: 'n', schema }), ...buildClaudeArgs({ maxTurns: 3, isolation: 'setting-sources', name: 'n', profile: 'research', schema })].filter((x) => x.startsWith('-')));
  for (const sel of [{ model: 'opus', effort: 'max' }, { model: 'claude-fable-5-1[1m]', effort: 'low' }, ...HOSTILE.map((h) => ({ model: h, effort: h }))]) {
    for (const profile of [undefined, 'research'] as const) {
      const flags = buildClaudeArgs({ maxTurns: 3, isolation: 'safe-mode', name: 'n', schema, profile, ...sel }).filter((x) => x.startsWith('-'));
      for (const f of flags) assert.ok(today.has(f) || f === '--model' || f === '--effort', `unexpected flag ${f}`);
      assert.ok(!flags.some((f) => /fast|thinking/i.test(f)));
    }
  }
});

test('bracketed ids refused at PUT, load and use (S7, W4)', () => {
  const cv = cursorView();
  for (const id of ['gpt-5[effort=high]', 'x,fast=true', 'gpt-5.2[1m]']) {
    assert.deepEqual(cursorModelArgs({ model: id }), [], id);
    assert.equal(normalizeConfig({ toolModels: { cursor: { model: id, custom: true } } }).toolModels.cursor, undefined, id);
    const r = resolveSelection('cursor', { tool: 'cursor', model: id, custom: true }, cv, 'role');
    assert.equal(r.modelArg, undefined, id);
  }
});
