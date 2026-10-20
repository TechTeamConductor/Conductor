// Regression tests for the independent code review findings (B1, B2, M1–M6, m1–m6, m12) and the "question task" failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeHarness, TestClock, type Harness } from './helpers/harness.ts';
import { comments, laneOf, stageOf } from './helpers/util.ts';
import { Effects } from '../src/pipeline/effects.ts';
import { looksSecret, redact } from '../src/redact.ts';
import { defaultConfig, normalizeConfig, toSettings } from '../src/config.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(h: Harness, fn: () => boolean, ms = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('until: timed out');
    await h.engine.tick();
    await sleep(150);
  }
}
const bug = (title: string, extra: Record<string, unknown> = {}) => ({ title, severity: 'major', file: 'feature.mjs', line: 1, evidence: `${title} (evidence)`, repro: 'r', suggestedFix: 'f', ...extra });

// ───────────── the user's BAR-363 failure: a QUESTION must be answered, not built ─────────────
test('question task: the planner answers, Conductor posts the answer on the card and finishes — no build, no verify', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ claude: { '*': { plan: [{ json: { deliverable: 'answer', answer: '## Best feature\nMulti-tenant isolation (`services/api/src/isolation.test.ts`).', filesToChange: [], acceptanceCriteria: [], steps: [] } }] } } });
    const key = h.issue("What's the best feature we have?");
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.equal(run.answered, true);
    assert.equal(h.calls().filter((c) => c.who === 'cursor').length, 0, 'the builder never ran');
    assert.equal(h.calls().filter((c) => c.who === 'claude' && c.stage === 'verify').length, 0, 'the verifier never ran');
    assert.ok((await comments(h, key)).some((c) => c.includes('Multi-tenant isolation') && c.includes('Answer')), 'the answer is on the card');
    assert.equal(laneOf(h, key), 'review');
    assert.equal(stageOf(h, key), 'ready');
    assert.ok(h.notes.some((n) => /answered/i.test(n.title)));
  } finally {
    await h.cleanup();
  }
});
test('question task without an answer text is rejected by validation and re-asked once', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ claude: { '*': { plan: [{ json: { deliverable: 'answer', answer: '   ', acceptanceCriteria: [] } }, { json: { deliverable: 'answer', answer: 'Here it is.', acceptanceCriteria: [] } }] } } });
    const key = h.issue('Explain the auth flow');
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
    assert.equal(h.calls().filter((c) => c.who === 'claude' && c.stage === 'plan').length, 2);
  } finally {
    await h.cleanup();
  }
});

// ───────────── B1: the per-card agent-run cap must not be a dead end ─────────────
test('B1: hitting the agent-run cap → needs_human; moving to To do gives a FRESH budget and the run completes', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.maxAgentRunsPerIssue = 3) });
  try {
    h.scenario({ claude: { '*': { verify: [{ json: { verdict: 'fail', summary: 'x', bugs: [bug('Needs a fix')] } }, { json: { verdict: 'pass' } }] } } });
    const key = h.issue('Budget');
    await h.settle(); // plan(1) build(2) verify(3) → fail → build would be #4 → cap
    assert.equal(h.run(key).status, 'needs_human');
    assert.match(h.run(key).needsHuman!.reason, /agent runs/);
    await h.engine.applyHumanMove(key, 'todo');
    await h.settle();
    assert.equal(h.run(key).status, 'ready', 'the same retry used to hit the cap again forever');
    assert.ok(h.run(key).agentRuns <= 3);
  } finally {
    await h.cleanup();
  }
});

// ───────────── B2: repeated Cursor limits must not spam the board or eat the budget ─────────────
test('B2: 12 consecutive Cursor limit rejections → still paused, ONE comment, ONE notification, budget untouched, growing back-off', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock });
  try {
    h.scenario({ cursor: { '*': { build: [{ limit: true }] } } });
    const key = h.issue('Cursor is limited');
    await h.settle();
    const pauses: number[] = [];
    for (let i = 0; i < 12; i++) {
      assert.equal(h.run(key).status, 'paused');
      pauses.push((h.run(key).pausedUntil ?? 0) - clock.now());
      clock.advance(7 * 3600_000); // longer than the biggest back-off step
      await h.settle();
    }
    assert.equal(h.run(key).status, 'paused');
    assert.equal((await comments(h, key)).filter((c) => c.includes('Paused')).length, 1, 'one comment per limit episode');
    assert.equal(h.notes.filter((n) => /limit/i.test(n.title)).length, 1, 'one notification per limit episode');
    assert.ok(h.run(key).agentRuns <= 2, `rejected attempts must not count (agentRuns=${h.run(key).agentRuns})`);
    assert.ok(pauses[0]! < pauses[3]! && pauses[3]! <= 6 * 3600_000 + 1000, `back-off grows and is capped: ${pauses.map((p) => Math.round(p / 60000)).join(',')} min`);
    // the limit lifts → the run completes and a NEW episode would be a new comment
    h.scenario({});
    clock.advance(7 * 3600_000);
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
    assert.equal(h.run(key).limitStreak, 0);
  } finally {
    await h.cleanup();
  }
});

// ───────────── M1: kebab-case words are not API keys ─────────────
test('M1: false-positive "sk-" matches are gone; real provider keys are still caught', () => {
  for (const ok of ['task-card-header-title-container', 'risk-assessment-report-generator-service', 'desk-layout-container-wrapper-large', 'disk-usage-monitor-panel-component-wide']) {
    assert.equal(looksSecret(ok), false, ok);
    assert.equal(redact(`name: ${ok}`), `name: ${ok}`, ok);
  }
  for (const bad of ['sk-proj-AbCdEf0123456789AbCdEf0123456789', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'key=sk-ABCDEFGHIJKLMNOPQRSTUVWX1234']) assert.equal(looksSecret(bad), true, bad);
});
test('M1: a build that creates a kebab-case file/class name is committed (not refused by the secret guard)', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ cursor: { '*': { build: [{ files: { 'src/task-card-header-title-container.mjs': 'export const cls = "task-card-header-title-container";\n', 'src/x.test.mjs': "import test from 'node:test';\ntest('ok', () => {});\n" } }] } } });
    const key = h.issue('Add a card');
    await h.settle();
    assert.equal(h.run(key).status, 'ready', JSON.stringify(h.run(key).needsHuman));
  } finally {
    await h.cleanup();
  }
});

// ───────────── M2: a commit-hook rejection is fixed IN PLACE ─────────────
test('M2: pre-commit hook rejects the first commit → the fix loop keeps loop-1 work and adds to it', async () => {
  const h = await makeHarness();
  try {
    const hook = join(h.repoDir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nD="$(git rev-parse --git-common-dir)"\nif [ ! -f "$D/hook-passed-once" ]; then touch "$D/hook-passed-once"; echo "lint-staged: missing semicolon in a.mjs"; exit 1; fi\nexit 0\n');
    chmodSync(hook, 0o755);
    h.scenario({ cursor: { '*': { build: [{ files: { 'a.mjs': 'export const a = 1\n' }, savePrompt: true }, { files: { 'b.mjs': 'export const b = 2;\n' }, savePrompt: true }] } } });
    const key = h.issue('Hook test');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready', JSON.stringify(run.needsHuman));
    const files = git(run.worktree, 'ls-tree', '-r', '--name-only', 'HEAD');
    assert.ok(files.includes('a.mjs') && files.includes('b.mjs'), `both loops' files are in the final commit:\n${files}`);
    assert.equal(run.loop, 2);
  } finally {
    await h.cleanup();
  }
});

// ───────────── M3: no actionable problem → a human, never a blind loop ─────────────
test('M3: verifier "fail" with only an unverifiable criterion → needs_human after ONE build (no empty-problem loops)', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ claude: { '*': { verify: [{ json: { verdict: 'fail', summary: 'The UI part cannot be checked here.', acceptance: [{ id: 'AC1', status: 'unverifiable', evidence: 'needs a browser' }], bugs: [] } }] } } });
    const key = h.issue('UI thing');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.equal(h.calls().filter((c) => c.who === 'cursor' && c.stage === 'build').length, 1, 'no second build');
    assert.ok((await comments(h, key)).some((c) => c.includes('could not give a clean pass') && c.includes('needs a browser')));
  } finally {
    await h.cleanup();
  }
});

// ───────────── M4 / M5: sub-issue hygiene ─────────────
test('M4: a full re-plan closes the now-obsolete bug child card on the board (not just locally)', async () => {
  const h = await makeHarness();
  try {
    h.scenario({
      claude: { '*': { verify: [{ json: { verdict: 'fail', summary: 'x', bugs: [bug('Wrong value')] } }, { json: { verdict: 'pass' } }] } },
      cursor: { '*': { build: [{}, { hang: true }, {}] } },
    });
    const key = h.issue('Re-plan while a bug is open');
    await until(h, () => h.store.get(key)?.loop === 2 && h.store.get(key)?.status === 'running');
    await sleep(500);
    await h.engine.applyHumanMove(key, 'todo'); // restart while the builder is mid-flight
    await h.engine.idle();
    await h.settle(60);
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.ok(run.rev >= 2);
    const kids = h.board.children(h.board.item(key)!.id);
    assert.equal(kids.length, 1);
    assert.equal(kids[0]!.lane, 'done', 'the stale [Bug] card is closed on the board');
  } finally {
    await h.cleanup();
  }
});
test('M5: 12 findings → at most 5 bug cards per loop / 8 per run (rest summarised); a re-observed bug is commented on, not duplicated', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.maxLoops = 2) });
  try {
    const twelve = Array.from({ length: 12 }, (_, i) => bug(`Distinct problem number ${i + 1}`, { file: `f${i}.mjs` }));
    h.scenario({ claude: { '*': { verify: [{ json: { verdict: 'fail', summary: 'many', bugs: twelve } }] } } });
    const key = h.issue('Lots of bugs');
    await h.settle();
    const kids = h.board.children(h.board.item(key)!.id);
    assert.ok(kids.length <= 8, `at most 8 bug cards per run (5 per loop), got ${kids.length}`);
    assert.ok(kids.length >= 5, 'the most severe findings are still filed');
    assert.ok((await comments(h, key)).some((c) => /more finding\(s\) were not filed/.test(c)), 'overflow is summarised in the parent comment');
    assert.ok(h.board.comments(kids[0]!.id).some((c) => /Still failing after loop 2/.test(c.body)), 'the existing bug card is updated when the bug is re-observed');
  } finally {
    await h.cleanup();
  }
});

// ───────────── M6 / m12: plan integrity + protected files ─────────────
test('m12: a plan that touches CI/agent config always waits for a human, even with auto-approval', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ claude: { '*': { plan: [{ json: { filesToChange: [{ path: '.github/workflows/ci.yml', action: 'modify', change: 'x', reason: 'y' }] } }] } } });
    const key = h.issue('Touch CI');
    await h.settle();
    assert.equal(h.run(key).status, 'awaiting_approval');
    assert.ok((await comments(h, key)).some((c) => c.includes('protected files')));
  } finally {
    await h.cleanup();
  }
});

// ───────────── m1: a REAL crash window (the board write happened, "done" was never saved) ─────────────
test('m1: a pending effect whose comment already reached the board is ADOPTED by its idempotency key, not duplicated', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.planApproval = 'manual') });
  try {
    const key = h.issue('Crash window');
    await h.settle();
    const itemId = h.board.item(key)!.id;
    for (const name of ['crash-test', 'crash-test2']) {
      h.board.addComment(itemId, `🤖 ${name}`, 'conductor', { idemKey: `${key}:${name}` }); // the write that happened right before the "crash"
      h.store.update(key, (r) => Effects.enqueue(r, name, { kind: 'comment', payload: { body: `🤖 ${name}` } })); // …but the run never recorded it as done
    }
    await h.engine.effects.flush(key);
    for (const name of ['crash-test', 'crash-test2']) {
      assert.equal((await comments(h, key)).filter((c) => c === `🤖 ${name}`).length, 1, `no duplicate for ${name}`);
      assert.equal(h.run(key).effects[name]!.status, 'done');
    }
  } finally {
    await h.cleanup();
  }
});

// ───────────── m2 / m3 / m4 / m6 ─────────────
test('m2: a parked READY run moved back to To do is re-planned keeping its commits — it does not become a zombie', async () => {
  const h = await makeHarness();
  try {
    const key = h.issue('Park then restart');
    await h.settle();
    const commit = h.run(key).commitSha;
    await h.engine.applyHumanMove(key, 'backlog');
    await h.settle();
    assert.equal(h.run(key).status, 'parked');
    assert.equal(laneOf(h, key), 'backlog');
    await h.engine.applyHumanMove(key, 'todo');
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
    assert.equal(h.run(key).rev, 2);
    assert.ok(commit && h.run(key).commitSha, 'work was kept');
  } finally {
    await h.cleanup();
  }
});
test('m2: Resume/Retry on a parked run explains how to continue instead of being silently re-parked', async () => {
  const h = await makeHarness();
  try {
    const key = h.issue('Parked');
    await h.settle();
    await h.engine.applyHumanMove(key, 'backlog');
    await h.settle();
    assert.throws(() => h.engine.resume(key), /Backlog/);
    await assert.rejects(() => h.engine.retry(key), /Backlog/);
  } finally {
    await h.cleanup();
  }
});
test('m3: retrying an internally "failed" run resumes the same step — it does not re-plan from scratch', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.planApproval = 'manual') });
  try {
    const key = h.issue('Failed run');
    await h.settle();
    h.engine.approve(key, 'human');
    h.store.update(key, (r) => {
      r.status = 'failed';
      r.next = 'build';
    });
    await h.engine.retry(key);
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
    assert.equal(h.run(key).rev, 1, 'no re-plan');
  } finally {
    await h.cleanup();
  }
});
test('m4: a transient Cursor failure in a LATER loop still gets its one automatic retry', async () => {
  const h = await makeHarness();
  try {
    h.scenario({
      cursor: { '*': { build: [{ error: 'boom-1' }, {}, { error: 'boom-2' }, {}] } },
      claude: { '*': { verify: [{ json: { verdict: 'fail', summary: 'x', bugs: [bug('Fix me')] } }, { json: { verdict: 'pass' } }] } },
    });
    const key = h.issue('Flaky builder');
    await h.settle();
    assert.equal(h.run(key).status, 'ready', JSON.stringify(h.run(key).needsHuman));
  } finally {
    await h.cleanup();
  }
});
test('m6: a builder that commits by itself is accepted (not reported as "no changes")', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ cursor: { '*': { build: [{ commitSelf: true }] } } });
    const key = h.issue('Self-committing agent');
    await h.settle();
    assert.equal(h.run(key).status, 'ready', JSON.stringify(h.run(key).needsHuman));
    assert.ok(git(h.run(key).worktree, 'log', '--oneline', '-3').includes('agent committed by itself'));
  } finally {
    await h.cleanup();
  }
});

// ───────────── config migration ─────────────
test('config: an old v1 config gets the hands-off defaults once; explicit v2 choices are kept', () => {
  const old = normalizeConfig({ version: 1, pipeline: { planApproval: 'first', onClaudeLimit: 'wait', timeoutsMin: { idle: 10 } } });
  assert.equal(old.version, 4);
  assert.equal(old.pipeline.planApproval, 'auto');
  assert.deepEqual(old.roles.planning.providers, ['claude', 'cursor'], 'v1 `wait` was upgraded to Cursor taking over read-only stages');
  assert.equal(toSettings(old).onClaudeLimit, 'cursor');
  assert.equal(old.pipeline.timeoutsMin.idle, 15);
  const chosen = normalizeConfig({ version: 2, pipeline: { planApproval: 'first', onClaudeLimit: 'wait' } });
  assert.equal(chosen.pipeline.planApproval, 'first', 'a v2 choice is respected');
  assert.deepEqual(chosen.roles.planning.providers, ['claude'], 'a v2 `wait` is respected');
  assert.equal(toSettings(chosen).onClaudeLimit, 'wait');
  assert.equal(normalizeConfig(defaultConfig()).version, 4);
});
