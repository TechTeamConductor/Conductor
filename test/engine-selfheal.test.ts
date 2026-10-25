// Complete auto self-heal: an empty builder attempt is re-run once; a second empty attempt parks. Per settings never heals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness, type Harness } from './helpers/harness.ts';
import { graphPlan, item, writes } from './helpers/graphs.ts';
import { HEAL_BUDGET } from '../src/pipeline/selfheal.ts';
import { effectiveHeal } from '../src/policy/policy.ts';
import { defaultConfig } from '../src/config.ts';

async function harness(runMode: 'per-settings' | 'complete-auto'): Promise<Harness> {
  return makeHarness({ gates: false, config: (c) => void (c.pipeline.runMode = runMode) });
}
const builds = (h: Harness) => h.calls().filter((c) => c.who === 'cursor' && c.stage === 'build');

test('effectiveHeal: Complete auto only, one attempt per cause', () => {
  const auto = defaultConfig();
  auto.pipeline.runMode = 'complete-auto';
  const per = defaultConfig();
  per.pipeline.runMode = 'per-settings';
  assert.equal(effectiveHeal(auto, 'empty_attempt', undefined), true);
  assert.equal(effectiveHeal(auto, 'empty_attempt', HEAL_BUDGET.empty_attempt), false);
  assert.equal(effectiveHeal(per, 'empty_attempt', undefined), false);
  assert.equal(effectiveHeal(per, 'scope_revert', 0), false);
});

test('C4 single task: one empty attempt is re-run with a static note, then continues', async () => {
  const h = await harness('complete-auto');
  try {
    h.scenario({ cursor: { '*': { build: [{ files: {} }, { ...writes('feature.mjs'), savePrompt: true }] } } });
    const key = h.issue('Empty once');
    await h.settle();
    const r = h.run(key);
    assert.equal(r.status, 'ready', r.needsHuman?.reason);
    assert.equal(r.emptyRetries, 1);
    assert.equal(builds(h).length, 2);
    assert.equal(r.emptyRetryNote, undefined, 'the note is consumed by the prompt');
    const saved = readdirSync(h.fakeDir).filter((f) => /^prompt-cursor-.*build/.test(f));
    assert.equal(saved.length, 1);
    assert.match(readFileSync(join(h.fakeDir, saved[0]!), 'utf8'), /previous attempt changed nothing/);
  } finally {
    await h.cleanup();
  }
});

test('C4 single task: two empty attempts park with the usual reason', async () => {
  const h = await harness('complete-auto');
  try {
    h.scenario({ cursor: { '*': { build: [{ files: {} }, { files: {} }, writes('never.mjs')] } } });
    const key = h.issue('Empty twice');
    await h.settle();
    const r = h.run(key);
    assert.equal(r.status, 'needs_human');
    assert.match(r.needsHuman?.reason ?? '', /without changing any files/);
    assert.equal(builds(h).length, 2);
  } finally {
    await h.cleanup();
  }
});

test('C4 single task: Per settings parks on the first empty attempt', async () => {
  const h = await harness('per-settings');
  try {
    h.scenario({ cursor: { '*': { build: [{ files: {} }, writes('never.mjs')] } } });
    const key = h.issue('Empty per settings');
    await h.settle();
    const r = h.run(key);
    assert.equal(r.status, 'needs_human');
    assert.equal(builds(h).length, 1);
    assert.equal(r.emptyRetries, undefined);
  } finally {
    await h.cleanup();
  }
});

const GRAPH = () => graphPlan([item('T1', { criteria: ['AC1'] }), item('T2', { dependsOn: ['T1'], criteria: ['AC2'] })]);
async function graphRun(h: Harness, build: unknown[]): Promise<string> {
  h.scenario({ claude: { '*': { plan: [{ json: GRAPH() }] } }, cursor: { '*': { build } } });
  const key = h.issue('Graph empty');
  await h.settle();
  return key;
}

test('C4 graph: an empty attempt on a task is re-run once through retryOrFail, then the graph completes', async () => {
  const h = await harness('complete-auto');
  try {
    const key = await graphRun(h, [{ files: {} }, writes('t1.mjs'), writes('t2.mjs')]);
    const r = h.run(key);
    assert.equal(r.status, 'ready', r.needsHuman?.reason);
    assert.equal(r.graph!.items[0]!.emptyRetries, 1);
    assert.equal(r.graph!.items[0]!.loop, 2);
    assert.equal(builds(h).length, 3);
  } finally {
    await h.cleanup();
  }
});

test('C4 graph: a second empty attempt on the same task fails it (per task, not per card)', async () => {
  const h = await harness('complete-auto');
  try {
    const key = await graphRun(h, [{ files: {} }, { files: {} }, writes('t2.mjs')]);
    const r = h.run(key);
    assert.equal(r.graph!.items[0]!.state, 'failed');
    assert.equal(r.graph!.items[0]!.emptyRetries, 1);
    assert.equal(r.status, 'needs_human');
    assert.equal(builds(h).length, 2, 'T1 twice, nothing after it');
  } finally {
    await h.cleanup();
  }
});

test('C4 graph: Per settings fails the task on the first empty attempt', async () => {
  const h = await harness('per-settings');
  try {
    const key = await graphRun(h, [{ files: {} }, writes('t1.mjs')]);
    const r = h.run(key);
    assert.equal(r.graph!.items[0]!.emptyRetries, undefined);
    assert.equal(r.graph!.items[0]!.state, 'failed');
  } finally {
    await h.cleanup();
  }
});

// ───────────────────────────── C2: out-of-scope protected files are reverted once ─────────────────────────────
import { existsSync } from 'node:fs';
import { git } from './helpers/harness.ts';
import { comments } from './helpers/util.ts';
import { AskService } from '../src/asks/service.ts';

const WF = '.github/workflows/x.yml';
const scopeBuild = (extra: Record<string, string> = {}) => ({ files: { 'feature-eng-1.mjs': 'export const v = 1;\n', [WF]: 'name: x\n', ...extra } });

test('C2: Complete auto reverts an out-of-scope workflow file once, names the backup ref, and finishes', async () => {
  const h = await harness('complete-auto');
  try {
    h.scenario({ cursor: { '*': { build: [scopeBuild()] } } });
    const key = h.issue('Scope creep');
    await h.settle();
    const r = h.run(key);
    assert.equal(r.status, 'ready', r.needsHuman?.reason);
    assert.equal(r.scopeRevertsUsed, 1);
    assert.equal(existsSync(`${r.worktree}/${WF}`), false, 'the out-of-scope file is gone from the checkout');
    assert.equal(existsSync(`${r.worktree}/feature-eng-1.mjs`), true, 'the in-scope work is kept');
    const ref = git(r.worktree, 'for-each-ref', '--format=%(refname)', 'refs/conductor-v2').split('\n').find((x) => /prev-/.test(x));
    assert.ok(ref, 'a backup ref of the pre-revert head exists');
    assert.match(git(r.worktree, 'ls-tree', '-r', '--name-only', ref!), /\.github\/workflows\/x\.yml/, 'the backup still has the reverted file');
    assert.ok(r.history.some((l) => /reverted files the plan did not list/.test(l.text) && l.text.includes(ref!)));
    assert.ok((await comments(h, key)).some((c) => /Out-of-scope files reverted/.test(c) && c.includes(ref!)));
    assert.match(git(r.worktree, 'log', '--format=%s', `${r.baseSha}..HEAD`), new RegExp(`^${key}: reverted out-of-scope files`, "m"));
    assert.equal(git(r.worktree, 'status', '--porcelain'), '');
  } finally {
    await h.cleanup();
  }
});

test('C2: a build whose only change is out of scope reverts to nothing and takes the empty-attempt path', async () => {
  const h = await harness('complete-auto');
  try {
    h.scenario({ cursor: { '*': { build: [{ files: { [WF]: 'name: x\n' } }, { files: { 'feature-eng-1.mjs': 'export const v = 2;\n' } }] } } });
    const key = h.issue('Only scope creep');
    await h.settle();
    const r = h.run(key);
    assert.equal(r.status, 'ready', r.needsHuman?.reason);
    assert.equal(r.scopeRevertsUsed, 1);
    assert.equal(r.emptyRetries, 1);
    assert.equal(existsSync(`${r.worktree}/${WF}`), false);
  } finally {
    await h.cleanup();
  }
});

test('C2: the second occurrence in the same run parks (graph: second task)', async () => {
  const h = await harness('complete-auto');
  try {
    const plan = graphPlan([item('T1', { files: ['t1.mjs'], criteria: ['AC1'] }), item('T2', { files: ['t2.mjs'], criteria: ['AC2'], dependsOn: ['T1'] })]);
    h.scenario({
      claude: { '*': { plan: [{ json: plan }] } },
      cursor: { '*': { build: [{ files: { 't1.mjs': 'export const a = 1;\n', [WF]: 'name: a\n' } }, { files: { 't2.mjs': 'export const b = 1;\n', '.vscode/tasks.json': '{}\n' } }] } },
    });
    const key = h.issue('Two creeps');
    await h.settle();
    const r = h.run(key);
    assert.equal(r.scopeRevertsUsed, 1);
    assert.equal(r.status, 'needs_human');
    assert.match(r.needsHuman?.reason ?? '', /protected files/);
    assert.match(r.needsHuman?.reason ?? '', /\.vscode\/tasks\.json/);
    assert.equal(r.graph!.items[0]!.state, 'done');
  } finally {
    await h.cleanup();
  }
});

test('C2: Per settings parks immediately and reverts nothing', async () => {
  const h = await harness('per-settings');
  try {
    h.scenario({ cursor: { '*': { build: [scopeBuild()] } } });
    const key = h.issue('Scope creep per settings');
    await h.settle();
    const r = h.run(key);
    assert.equal(r.status, 'needs_human');
    assert.match(r.needsHuman?.reason ?? '', /protected files/);
    assert.equal(r.scopeRevertsUsed, undefined);
  } finally {
    await h.cleanup();
  }
});

test('C2: a protected file the plan itself lists is never reverted automatically', async () => {
  const h = await harness('complete-auto');
  try {
    h.scenario({
      claude: { '*': { plan: [{ json: { filesToChange: [{ path: WF, action: 'create', change: 'ci', reason: 'AC1' }] } }] } },
      cursor: { '*': { build: [{ files: { [WF]: 'name: ci\n' } }] } },
    });
    const key = h.issue('Add CI as asked');
    await h.settle();
    const r = h.run(key);
    assert.equal(r.status, 'needs_human');
    assert.equal(r.scopeRevertsUsed, undefined);
  } finally {
    await h.cleanup();
  }
});

test('C2: a fast-path plan keeps parking', async () => {
  const h = await makeHarness({ gates: false, config: (c) => void (c.pipeline.runMode = 'complete-auto') });
  try {
    const change = { kind: 'change', answer: 'I would do it.', change: { title: 'T', description: 'D', files: ['feature-eng-1.mjs'], complexity: 'S' }, citations: [] };
    h.scenario({ claude: { '*': { ask: [{ json: change }] } }, cursor: { '*': { build: [scopeBuild()] } } });
    const a = new AskService({
      getConfig: () => h.cfg, agents: h.agents, routeStates: () => h.engine.routeStates(), freshHealth: () => h.engine.freshHealth(),
      cards: { create: (i) => { const p = h.engine.ensureProjectForRepo(i.repo); const it = h.board.createItem({ projectId: p.id, title: i.title, description: i.description, kind: 'work', lane: 'todo', idemKey: i.idemKey }, i.actor); h.engine.tickSoon(); return { key: it.key }; } },
    });
    const on = a.start({ question: 'Rename the feature function', repo: 'demo', allowChange: true });
    await a.idle();
    const key = a.get(on.id)!.convertedTo!;
    await h.settle();
    const r = h.run(key);
    assert.equal(r.fastPath, true);
    assert.equal(r.status, 'needs_human');
    assert.equal(r.scopeRevertsUsed, undefined);
  } finally {
    await h.cleanup();
  }
});
