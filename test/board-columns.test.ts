import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.ts';
import { newRun } from '../src/store.ts';
import { activityOf, columnOf, toSummary } from '../src/pipeline/view.ts';
import type { Run } from '../src/types.ts';

const seed = { key: 'ENG-1', itemId: 'i1', title: 'T', description: 'D', descHash: 'h', repo: 'r', branch: 'b', worktree: '/w/ENG-1', baseSha: 'abc', loopBudget: 3 };
const mk = (p: Partial<Run>): Run => ({ ...newRun(seed), ...p });
const app = readFileSync(join(import.meta.dirname, '..', 'ui', 'app.js'), 'utf8');
const block = (name: string): string => {
  const m = new RegExp(`const ${name} = ([\\s\\S]*?);\\n(?:const|\\n)`).exec(app);
  assert.ok(m, name);
  return m[1];
};

test('persisted old runs map to the right columns (no migration)', () => {
  for (const status of ['paused', 'parked', 'failed', 'needs_human'] as const) assert.equal(columnOf(mk({ status })), 'needs_human', status);
  assert.equal(columnOf(mk({ status: 'awaiting_approval' })), 'plan_ready');
  assert.equal(columnOf(mk({ status: 'running', stage: 'plan', next: 'plan_review' })), 'plan_ready');
  assert.equal(columnOf(mk({ status: 'running', stage: 'plan', next: 'plan' })), 'planning');
  assert.equal(columnOf(mk({ status: 'running', stage: 'build', next: 'build' })), 'building');
});

test('no run ever lands in a paused column; parked keeps its state and wording', () => {
  for (const status of ['queued', 'running', 'awaiting_approval', 'needs_human', 'paused', 'parked', 'failed', 'ready', 'finished', 'aborted'] as const) {
    assert.notEqual(columnOf(mk({ status })) as string, 'paused', status);
  }
  const cfg = defaultConfig();
  const parked = mk({ status: 'parked' });
  assert.match(activityOf(parked, cfg, 1), /Parked by you/);
  assert.equal(toSummary(parked, cfg, 1).status, 'parked');
  assert.match(activityOf(mk({ status: 'awaiting_approval' }), cfg, 1), /Plan review/);
});

test('UI strings: no Paused column, renamed labels, mode-aware hint', () => {
  assert.ok(!/id: 'paused'/.test(block('COLUMNS')));
  assert.ok(!/'paused'/.test(block('MOBILE_ORDER')));
  assert.ok(!/'paused'/.test(block('WAITING_COLUMNS')));
  assert.ok(!/paused:/.test(block('STATUS_LABEL')));
  assert.match(block('COLUMNS'), /label: 'Plan review'.*Plan being reviewed; points go back to Planning/);
  assert.match(block('COLUMNS'), /label: 'Stuck resolver'/);
  assert.match(block('COLUMNS'), /Built and tested — moves to Pushed/);
  assert.match(block('COLUMNS'), /On the current branch, as you, with the ticket key in the commit/);
  assert.ok(!/Needs you|Plan ready/.test(block('COLUMNS') + block('STATUS_LABEL')));
  assert.match(app, /Blocked — the resolver analyses and fixes it/);
  assert.match(app, /Blocked — needs you/);
  assert.match(app, /Needs your approval/);
  assert.match(app, /Parked by you — move it to To do/);
});

test('UI: the Auto push panel and confirmPush flow are gone; push settings keep identity and remote only', () => {
  assert.ok(!/autoPush|confirmPush|pushBranch|AUTO_PUSH_ASK/.test(app));
  assert.match(app, /pushConsentNeeded/);
  assert.match(app, /Accept the updated Complete auto confirm once to start pushing/);
});
