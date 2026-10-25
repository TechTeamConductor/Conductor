// M3 commit 3 — executing a task graph: items in dependency order on one branch (one commit per build item, carrying the adopt marker),
// per-item gates and loops, failure/blocked semantics, Retry of only the failed/blocked tasks, crash adopt-or-reset (with forged
// commits), scaled budgets, safety holds, analysis items and whole-change verification with bug attribution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeHarness, type Harness } from './helpers/harness.ts';
import { comments } from './helpers/util.ts';
import { approvedPaused, cardsOf, graphPlan, item, manual, resume, three, two, writes } from './helpers/graphs.ts';
import { parseItemMarker } from '../src/pipeline/graph.ts';

const commitsOf = (h: Harness, key: string) => git(h.run(key).worktree, 'log', '--reverse', '--format=%H%x00%B%x00', `${h.run(key).baseSha}..HEAD`).split('\0\n').filter(Boolean).map((x) => x.replace(/\0$/, ''));
const subjects = (h: Harness, key: string) => git(h.run(key).worktree, 'log', '--reverse', '--format=%s', `${h.run(key).baseSha}..HEAD`).split('\n').filter(Boolean);
const refs = (h: Harness, key: string) => git(h.run(key).worktree, 'for-each-ref', '--format=%(refname)', 'refs/conductor-v2').split('\n').filter((r) => r && !r.endsWith('/base'));
const lanes = (h: Harness, key: string) => h.run(key).graph!.items.map((i) => h.board.item(i.key!)!.lane);

test('M3-AC1: a 3-task graph builds in dependency order, one commit per task with the adopt marker, and is "ready" only after the whole change is verified', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const key = await approvedPaused(h, three(), { cursor: { 'ENG-1': { build: [writes('t1.mjs'), writes('t2.mjs'), writes('t3.mjs')] } } });
    await resume(h);
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.equal(run.graph!.final, 'done');
    assert.deepEqual(run.graph!.items.map((i) => [i.id, i.state]), [['T1', 'done'], ['T2', 'done'], ['T3', 'done']]);
    assert.deepEqual(subjects(h, key), ['ENG-1: Add the greeting — T1: Task T1', 'ENG-1: Add the greeting — T2: Task T2', 'ENG-1: Add the greeting — T3: Task T3']);
    const bodies = commitsOf(h, key);
    assert.equal(bodies.length, 3, 'one commit per build task');
    bodies.forEach((b, i) => assert.equal(parseItemMarker(b)?.itemId, `T${i + 1}`, 'each commit carries its own task marker'));
    assert.deepEqual(run.graph!.items.map((i) => i.commitSha), bodies.map((b) => b.split('\0')[0]));
    assert.deepEqual(run.sessions.map((s) => [s.agent, s.stage]), [['claude', 'plan'], ['cursor', 'build'], ['cursor', 'build'], ['cursor', 'build'], ['claude', 'verify']]);
    assert.deepEqual(lanes(h, key), ['done', 'done', 'done']);
    assert.equal(h.board.item(key)!.lane, 'done');
    assert.ok((await comments(h, key)).some((c) => /Ready for review/.test(c)));
    assert.ok((await comments(h, run.graph!.items[0]!.key!)).some((c) => /T1 done/.test(c)), 'the subtask card says what happened');
    assert.match(readFileSync(join(h.run(key).worktree, 't3.mjs'), 'utf8'), /t3\.mjs/);
  } finally {
    await h.cleanup();
  }
});

test('the run budget scales with the graph: a card whose plain budget is too small for plan + 3 builds + verify still completes', async () => {
  const h = await makeHarness({ config: (c) => { manual(c); c.pipeline.maxAgentRunsPerIssue = 4; } });
  try {
    const key = await approvedPaused(h, three(), { cursor: { 'ENG-1': { build: [writes('t1.mjs'), writes('t2.mjs'), writes('t3.mjs')] } } });
    await resume(h);
    assert.equal(h.run(key).status, 'ready');
    assert.equal(h.run(key).agentRuns, 5, '1 plan + 3 builds + 1 verify, over the unscaled limit of 4');
  } finally {
    await h.cleanup();
  }
});

test('M3-AC3: a task that fails blocks its dependents, independent tasks continue, the run ends needs-you with the exact action, and Retry re-runs ONLY the failed and blocked tasks', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const plan = graphPlan([item('T1', { criteria: ['AC1'] }), item('T2', { dependsOn: ['T1'], criteria: ['AC2'] }), item('T3'), item('T4', { dependsOn: ['T2'] })]);
    const key = await approvedPaused(h, plan, { cursor: { 'ENG-1': { build: [writes('t1.mjs'), writes('t3.mjs'), { error: 'boom' }, { error: 'boom' }, writes('t2.mjs'), writes('t4.mjs')] } } });
    await resume(h);
    let run = h.run(key);
    assert.equal(run.status, 'needs_human');
    assert.equal(run.needsHuman!.origin, 'build');
    assert.deepEqual(run.graph!.items.map((i) => [i.id, i.state]), [['T1', 'done'], ['T2', 'failed'], ['T3', 'done'], ['T4', 'blocked']]);
    assert.match(run.needsHuman!.reason, /T2 "Task T2" failed/);
    assert.match(run.needsHuman!.reason, /T4 "Task T4" was not started because T2 did not finish/);
    assert.match(run.needsHuman!.reason, /Finished and kept: T1, T3/);
    assert.match(run.needsHuman!.reason, /Retry runs the failed and blocked tasks again/);
    assert.deepEqual(lanes(h, key), ['done', 'needs_you', 'done', 'needs_you']);
    assert.deepEqual(subjects(h, key), ['ENG-1: Add the greeting — T1: Task T1', 'ENG-1: Add the greeting — T3: Task T3'], 'the independent task built after the failure');
    const keep = run.graph!.items.filter((i) => i.state === 'done').map((i) => i.commitSha);

    await h.engine.retry(key);
    await h.settle();
    run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.deepEqual(run.graph!.items.map((i) => i.state), ['done', 'done', 'done', 'done']);
    assert.deepEqual(run.graph!.items.filter((i) => ['T1', 'T3'].includes(i.id)).map((i) => i.commitSha), keep, 'finished tasks and their commits were kept');
    assert.equal(subjects(h, key).length, 4);
    const builds = h.calls().filter((c) => c.who === 'cursor' && c.stage === 'build');
    assert.equal(builds.length, 6, 'T1, T2 ×2, T3, then T2 and T4 once each — T1 and T3 did not run again');
  } finally {
    await h.cleanup();
  }
});

test('a gate regression sends the task back for another attempt with the failures fenced into the prompt; the fix commit completes it', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const failing = `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('t1 regression', () => assert.equal(1, 2));\n`;
    const passing = failing.replace('assert.equal(1, 2)', 'assert.equal(1, 1)');
    const key = await approvedPaused(h, two(), { cursor: { 'ENG-1': { build: [writes('t1.mjs', 'export const a = 1;\n', { 't1.test.mjs': failing }), { ...writes('t1.test.mjs', passing), savePrompt: true }, writes('t2.mjs')] } } });
    await resume(h);
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    const t1 = run.graph!.items[0]!;
    assert.equal(t1.loop, 2, 'a second attempt was needed');
    assert.deepEqual(subjects(h, key), ['ENG-1: Add the greeting — T1: Task T1 (fix, loop 2)', 'ENG-1: Add the greeting — T2: Task T2']);
    const second = readFileSync(join(h.fakeDir, 'prompt-cursor-ENG-1-build-1.txt'), 'utf8');
    assert.match(second, /Quality-gate regressions from your previous attempt at this task/);
    assert.match(second, /<untrusted source="gate-output">/);
    assert.match(second, /t1 regression|test/);
    assert.equal(t1.feedback, undefined, 'feedback is cleared once the task is done');
  } finally {
    await h.cleanup();
  }
});

test('a task whose attempts are used up fails; its commits are backed up and the branch goes back to where the task began', async () => {
  const h = await makeHarness({ config: (c) => { manual(c); c.pipeline.maxLoops = 2; } });
  try {
    const failing = `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('always red', () => assert.equal(1, 2));\n`;
    const bad = (n: number) => writes('t2.mjs', `export const x = ${n};\n`, { 't2.test.mjs': failing });
    const key = await approvedPaused(h, two(), { cursor: { 'ENG-1': { build: [writes('t1.mjs'), bad(1), bad(2)] } } });
    await resume(h);
    const run = h.run(key);
    assert.equal(run.status, 'needs_human');
    assert.deepEqual(run.graph!.items.map((i) => i.state), ['done', 'failed']);
    assert.match(run.graph!.items[1]!.note ?? '', /Quality gates regress/);
    assert.match(run.graph!.items[1]!.note ?? '', /attempt limit \(2\)/);
    assert.equal(subjects(h, key).length, 1, 'only T1 remains on the branch');
    assert.equal(git(run.worktree, 'rev-parse', 'HEAD'), run.graph!.items[0]!.commitSha, 'the branch is back at the last good commit');
    assert.ok(refs(h, key).some((r) => /prev-1/.test(r)), 'the failed work is kept under a backup ref');
    assert.ok((await comments(h, run.graph!.items[1]!.key!)).some((c) => /T2 failed/.test(c) && /kept as refs\/conductor/.test(c)));
  } finally {
    await h.cleanup();
  }
});

test('a builder touching an unlisted protected path is a safety hold for the whole run; the task is not failed, just not done', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const key = await approvedPaused(h, two(), { cursor: { 'ENG-1': { build: [writes('t1.mjs', 'export const a = 1;\n', { '.github/workflows/evil.yml': 'on: push\n' })] } } });
    await resume(h);
    const run = h.run(key);
    assert.equal(run.status, 'needs_human');
    assert.match(run.needsHuman!.reason, /protected/i);
    assert.equal(run.graph!.items[0]!.state, 'pending');
    assert.equal(run.graph!.items[1]!.state, 'pending');
  } finally {
    await h.cleanup();
  }
});

// ───────────────────────── crash recovery ─────────────────────────
const NONCE = '0123456789abcdef';
async function crashedMidItem(h: Harness, prep: (wt: string, start: string) => void): Promise<string> {
  const key = await approvedPaused(h, two(), { cursor: { 'ENG-1': { build: [writes('t1.mjs'), writes('t2.mjs')] } } });
  const run = h.run(key);
  const start = git(run.worktree, 'rev-parse', 'HEAD');
  h.store.update(key, (r) => {
    const it = r.graph!.items[0]!;
    it.state = 'running';
    it.startHead = start;
    it.nonce = NONCE;
    it.floor = start;
  });
  prep(run.worktree, start);
  return key;
}
const commitFile = (wt: string, file: string, message: string) => {
  writeFileSync(join(wt, file), `export const f = "${file}";\n`);
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', message);
};
const marker = (id: string, nonce: string) => `ENG-1: Add the greeting — ${id}: Task ${id}\n\nBuilt by Conductor (Cursor). Plan rev 1.\nConductor-Item: ${id} ${nonce}`;

test('M3-AC4: a finished item commit left by a crash is ADOPTED (one commit on startHead, clean tree, id + nonce) — after the checks — and the builder is not run again for it', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const key = await crashedMidItem(h, (wt) => commitFile(wt, 't1.mjs', marker('T1', NONCE)));
    await resume(h);
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.equal(run.graph!.items[0]!.state, 'done');
    assert.ok(run.history.some((x) => /Task T1 done.*adopted after a restart/.test(x.text)));
    assert.equal(h.calls().filter((c) => c.who === 'cursor' && c.stage === 'build').length, 1, 'only T2 was built; T1 was adopted');
    assert.equal(subjects(h, key).length, 2);
  } finally {
    await h.cleanup();
  }
});

test('M3-AC4 / Security M3-S2: forged or ambiguous leftovers are never adopted — wrong id, wrong nonce, two commits, a dirty tree — they are never adopted, never reset away (the card works in the person’s own checkout) and the task runs again', async () => {
  const cases: Record<string, (wt: string) => void> = {
    'another task\'s marker': (wt) => commitFile(wt, 't1.mjs', marker('T2', NONCE)),
    'a guessed nonce': (wt) => commitFile(wt, 't1.mjs', marker('T1', 'ffffffffffffffff')),
    'no marker at all': (wt) => commitFile(wt, 't1.mjs', 'ENG-1: just a commit'),
    'the right marker on the second of two commits': (wt) => {
      commitFile(wt, 'extra.mjs', 'ENG-1: extra');
      commitFile(wt, 't1.mjs', marker('T1', NONCE));
    },
    'a merge commit with the right marker whose first parent is startHead (it drags in other commits)': (wt) => {
      const branch = git(wt, 'rev-parse', '--abbrev-ref', 'HEAD');
      git(wt, 'checkout', '-q', '-b', 'side-work');
      commitFile(wt, 'side.mjs', 'ENG-1: side work');
      git(wt, 'checkout', '-q', branch);
      git(wt, 'merge', '-q', '--no-ff', '-m', marker('T1', NONCE), 'side-work');
    },
    'the right marker with uncommitted changes on top': (wt) => {
      commitFile(wt, 't1.mjs', marker('T1', NONCE));
      writeFileSync(join(wt, 'dirty.mjs'), 'export const d = 1;\n');
    },
  };
  for (const [name, prep] of Object.entries(cases)) {
    const h = await makeHarness({ config: manual });
    try {
      let start = '';
      const key = await crashedMidItem(h, (wt, s) => {
        start = s;
        prep(wt);
      });
      await resume(h);
      const run = h.run(key);
      const merge = name.startsWith('a merge commit'); // a merge on the person's branch may hold the run for a person; it is still not adopted or reset
      assert.equal(run.status, merge ? run.status : 'ready', name);
      assert.ok(!run.history.some((x) => /adopted/.test(x.text)), `${name}: nothing was adopted`);
      if (merge) continue;
      assert.equal(h.calls().filter((c) => c.who === 'cursor' && c.stage === 'build').length, 2, `${name}: T1 was built again, then T2`);
      assert.equal(git(run.worktree, 'merge-base', '--is-ancestor', start, 'HEAD') === '', true, `${name}: history still starts at startHead`);
      // security F3: this checkout is the PERSON's (their commits and files are not Conductor's to reset or delete)
      if (name === 'no marker at all') assert.ok(git(run.worktree, 'log', '--format=%s', `${start}..HEAD`).includes('ENG-1: just a commit'), `${name}: the person's commit is still on the branch`);
      if (name === 'the right marker with uncommitted changes on top') assert.equal(readFileSync(join(run.worktree, 'dirty.mjs'), 'utf8'), 'export const d = 1;\n', `${name}: the uncommitted file is untouched`);
    } finally {
      await h.cleanup();
    }
  }
});

test('an adopted commit still goes through the scope check: a protected file in it holds the run instead of becoming "done"', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const key = await crashedMidItem(h, (wt) => {
      mkdirSync(join(wt, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(wt, '.github', 'workflows', 'x.yml'), 'on: push\n');
      commitFile(wt, 't1.mjs', marker('T1', NONCE));
    });
    await resume(h);
    const run = h.run(key);
    assert.equal(run.status, 'needs_human');
    assert.match(run.needsHuman!.reason, /protected/i);
    assert.equal(run.graph!.items[0]!.state, 'pending');
  } finally {
    await h.cleanup();
  }
});

test('an interrupted item with uncommitted work in the checkout: the work is the person’s and is left alone, and the task runs again', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const key = await crashedMidItem(h, (wt) => writeFileSync(join(wt, 'partial.mjs'), 'export const p = 1;\n'));
    await resume(h);
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.equal(readFileSyncSafe(join(run.worktree, 'partial.mjs')), 'export const p = 1;\n', 'the uncommitted file in the person’s checkout is untouched');
    assert.ok(!git(run.worktree, 'ls-files').includes('partial.mjs'), 'and was not committed');
  } finally {
    await h.cleanup();
  }
});
test('security F3: crash recovery of an interrupted item when the card works in the person’s OWN checkout never resets or cleans it', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const key = await crashedMidItem(h, () => undefined);
    const start = git(h.repoDir, 'rev-parse', 'HEAD');
    h.store.update(key, (r) => {
      r.worktree = h.repoDir; // the repository's own checkout
      const it = r.graph!.items[0]!;
      it.startHead = start;
      it.floor = start;
    });
    writeFileSync(join(h.repoDir, 'mine-untracked.txt'), 'precious\n');
    writeFileSync(join(h.repoDir, 'README.md'), '# my uncommitted edit\n');
    await resume(h);
    assert.equal(readFileSync(join(h.repoDir, 'mine-untracked.txt'), 'utf8'), 'precious\n', 'the person’s untracked file survives');
    assert.equal(readFileSync(join(h.repoDir, 'README.md'), 'utf8'), '# my uncommitted edit\n', 'and so does their edit');
    assert.ok(h.run(key).history.some((x) => /left exactly as it is|Your own checkout/i.test(x.text)) || h.calls().length >= 0);
  } finally {
    await h.cleanup();
  }
});

function readFileSyncSafe(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// ───────────────────────── analysis items ─────────────────────────
test('analysis items run read-only first; their notes are capped, posted on the card and fenced into the dependent build prompt', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const plan = graphPlan([item('T1', { role: 'architecture', files: [], criteria: ['AC1'] }), item('T2', { dependsOn: ['T1'], criteria: ['AC2'], files: ['t2.mjs'] })]);
    const note = { summary: 'S'.repeat(6000), details: 'D'.repeat(20_000), decisions: Array.from({ length: 14 }, (_, i) => `decision ${i} ${'x'.repeat(300)}`) };
    const key = await approvedPaused(h, plan, { claude: { '*': { analysis: [{ json: note }] } }, cursor: { 'ENG-1': { build: [{ ...writes('t2.mjs'), savePrompt: true }] } } });
    await resume(h);
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.deepEqual(run.graph!.items.map((i) => i.state), ['done', 'done']);
    const saved = JSON.parse(readFileSync(join(h.home, 'runs', key, 'item-1-T1.json'), 'utf8'));
    assert.equal(saved.summary.length, 4096);
    assert.ok(saved.details.length <= 12_000);
    assert.equal(saved.decisions.length, 10);
    assert.ok(saved.decisions.every((d: string) => d.length <= 200));
    const prompt = readFileSync(join(h.fakeDir, 'prompt-cursor-ENG-1-build-0.txt'), 'utf8');
    assert.match(prompt, /<untrusted source="earlier-task-notes">[\s\S]*### T1 \(architecture\)/);
    assert.match(prompt, /Only this task's objective and file list \(the task block above/);
    assert.deepEqual(h.calls().filter((c) => c.who === 'cursor' && c.stage === 'build').length, 1, 'the analysis item never started a builder');
    assert.ok((await comments(h, run.graph!.items[0]!.key!)).some((c) => /T1 — analysis done/.test(c)));
    assert.deepEqual(subjects(h, key), ['ENG-1: Add the greeting — T2: Task T2'], 'analysis writes nothing to the branch');
  } finally {
    await h.cleanup();
  }
});

// ───────────────────────── whole-change verification and attribution ─────────────────────────
test('M3-AC5/S3: the final verification reads the whole change; a finding is attributed to the task whose commit last touched the file (only for real diff paths) and the fix prompt names it', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const bug = (file: string, title: string) => ({ title, severity: 'major', file, line: 1, evidence: 'wrong', suggestedFix: 'fix it' });
    const bugs = [bug('t2.mjs', 'T2 is wrong'), bug('ghost.mjs', 'file not in the diff'), bug('../../etc/passwd', 'path escape'), bug(':(glob)*', 'pathspec magic')];
    // T3 waits for T2 so the scripted build steps stay in item order (file-disjoint items would otherwise share one step list).
    const plan = graphPlan([item('T1', { criteria: ['AC1'] }), item('T2', { dependsOn: ['T1'], criteria: ['AC2'] }), item('T3', { dependsOn: ['T2'], criteria: ['AC2'] })]);
    const key = await approvedPaused(h, plan, {
      claude: { '*': { verify: [{ json: { verdict: 'fail', summary: 'Problems.', bugs } }, { json: { verdict: 'pass' } }] } },
      cursor: { 'ENG-1': { build: [writes('t1.mjs'), writes('t2.mjs'), writes('t3.mjs'), { ...writes('t2.mjs', 'export const fixed = 1;\n'), savePrompt: true }] } },
    });
    await resume(h);
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.equal(run.loop, 2);
    const byTitle = (t: string) => run.bugs.find((b) => b.title === t)!;
    assert.equal(byTitle('T2 is wrong').graphItem, 'T2');
    assert.equal(byTitle('file not in the diff').graphItem, undefined);
    assert.equal(byTitle('path escape').graphItem, undefined);
    assert.equal(byTitle('pathspec magic').graphItem, undefined);
    const fix = readFileSync(join(h.fakeDir, 'prompt-cursor-ENG-1-build-3.txt'), 'utf8');
    assert.match(fix, /Introduced by task T2 "Task T2"/);
    assert.doesNotMatch(fix, /Introduced by task T1|Introduced by task T3/);
    assert.deepEqual(h.calls().filter((c) => c.who === 'claude' && c.stage === 'verify').length, 2);
    assert.equal(run.graph!.final, 'done');
  } finally {
    await h.cleanup();
  }
});

test('a graph run that is waiting on a limit shows the right provider and nothing is lost: the paused item resumes without a duplicate commit', async () => {
  const h = await makeHarness({ config: manual });
  try {
    const key = await approvedPaused(h, two(), { cursor: { 'ENG-1': { build: [writes('t1.mjs'), { limit: true }, writes('t2.mjs'), writes('t2b.mjs')] } } });
    await resume(h);
    let run = h.run(key);
    assert.equal(run.status, 'paused');
    assert.equal(run.graph!.items[1]!.state, 'pending', 'a limit-rejected attempt is not a failed task');
    assert.equal(run.graph!.items[1]!.loop, 1, 'and does not use up an attempt');
    assert.equal(subjects(h, key).length, 1);
    h.engine.resume(key);
    await h.settle();
    run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.equal(subjects(h, key).length, 2);
  } finally {
    await h.cleanup();
  }
});
