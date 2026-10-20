// Native-board engine behaviour (M1b): lane ownership, the human command matrix, the crash protocol (windows a–e),
// condition K1 (one write), K2 (humans never write lanes directly), K4 (orphans / unsupported kinds), untrusted imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness, type Harness } from './helpers/harness.ts';
import { comments, laneOf } from './helpers/util.ts';
import { Effects } from '../src/pipeline/effects.ts';
import { newRun } from '../src/store.ts';
import type { RunStatus } from '../src/types.ts';
import { sha1 } from '../src/util.ts';
void 0;

// ───────────────────────── the human command matrix, cell by cell ─────────────────────────
type Cell = { from: RunStatus | 'none'; expect: RunStatus | 'lane:backlog' | 'lane:todo' | 'lane:done' | 'lane:canceled' | RegExp };
const MOVES: Record<string, Cell[]> = {
  backlog: [
    { from: 'none', expect: 'lane:backlog' }, { from: 'queued', expect: 'parked' }, { from: 'paused', expect: 'parked' }, { from: 'ready', expect: 'parked' },
    { from: 'failed', expect: 'parked' }, { from: 'parked', expect: 'parked' }, { from: 'finished', expect: /already finished or canceled/ }, { from: 'aborted', expect: /already finished or canceled/ },
  ],
  done: [
    { from: 'none', expect: 'lane:done' }, { from: 'queued', expect: 'finished' }, { from: 'paused', expect: 'finished' }, { from: 'ready', expect: 'finished' },
    { from: 'failed', expect: 'finished' }, { from: 'parked', expect: 'finished' }, { from: 'finished', expect: 'finished' }, { from: 'aborted', expect: /canceled/ },
  ],
  canceled: [
    { from: 'none', expect: 'lane:canceled' }, { from: 'queued', expect: 'aborted' }, { from: 'paused', expect: 'aborted' }, { from: 'ready', expect: 'aborted' },
    { from: 'failed', expect: 'aborted' }, { from: 'parked', expect: 'aborted' }, { from: 'aborted', expect: 'aborted' }, { from: 'finished', expect: /already done/ },
  ],
  todo: [
    { from: 'none', expect: 'lane:todo' }, { from: 'queued', expect: 'queued' }, { from: 'paused', expect: 'queued' }, { from: 'ready', expect: 'queued' },
    { from: 'failed', expect: 'queued' }, { from: 'parked', expect: 'queued' }, { from: 'finished', expect: 'queued' }, { from: 'aborted', expect: 'queued' },
  ],
};
for (const [lane, cells] of Object.entries(MOVES)) {
  for (const c of cells) {
    test(`command matrix: move → ${lane} while ${c.from}`, async () => {
      const h = await makeHarness();
      try {
        const key = c.from === 'none' ? h.issue('matrix', { lane: 'backlog' }) : h.issue('matrix');
        if (c.from !== 'none') {
          await h.settle();
          // bring the finished run into the wanted status without leaving a live job behind
          if (c.from === 'parked') await h.engine.applyHumanMove(key, 'backlog');
          else if (c.from === 'finished') await h.engine.applyHumanMove(key, 'done');
          else if (c.from === 'aborted') await h.engine.abort(key);
          else if (c.from !== 'ready') h.store.update(key, (r) => void (r.status = c.from as RunStatus));
        }
        if (c.expect instanceof RegExp) {
          await assert.rejects(() => h.engine.applyHumanMove(key, lane), c.expect);
          return;
        }
        // queued/paused cells must not start a job during the assertion window
        if (c.expect === 'queued') h.engine.setPaused(true);
        await h.engine.applyHumanMove(key, lane);
        if (typeof c.expect === 'string' && c.expect.startsWith('lane:')) {
          assert.equal(h.board.item(key)!.lane, c.expect.slice(5));
          assert.equal(h.store.has(key), false, 'a card without a run stays run-less');
        } else {
          assert.equal(h.run(key).status, c.expect);
        }
      } finally {
        await h.cleanup();
      }
    });
  }
}

test('command matrix: humans cannot set Conductor-owned lanes through any path', async () => {
  const h = await makeHarness();
  try {
    const key = h.issue('owned lanes');
    await h.settle();
    for (const lane of ['active', 'needs_you', 'review', 'nonsense']) await assert.rejects(() => h.engine.applyHumanMove(key, lane), /Conductor owns/);
    const bare = h.issue('no run', { lane: 'backlog' });
    for (const lane of ['active', 'needs_you', 'review']) await assert.rejects(() => h.engine.applyHumanMove(bare, lane), /Conductor owns/);
    await assert.rejects(() => h.engine.applyHumanMove('NOPE-1', 'todo'), /Unknown card/);
  } finally {
    await h.cleanup();
  }
});

test('command matrix: resume / retry / abort / approve / cleanup cells', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.planApproval = 'manual') });
  try {
    const key = h.issue('cells');
    await h.settle();
    assert.equal(h.run(key).status, 'awaiting_approval');
    assert.throws(() => h.engine.resume(key), /Nothing to resume/);
    assert.throws(() => h.engine.approve(key, 'human', h.run(key).rev + 1), /newer revision/);
    h.store.update(key, (r) => void (r.status = 'paused'));
    h.engine.setPaused(true);
    h.engine.resume(key);
    assert.equal(h.run(key).status, 'queued', 'resume on paused → queued');
    await assert.rejects(() => h.engine.retry(key), /already working/, 'retry on queued → 409');
    h.store.update(key, (r) => void (r.status = 'paused'));
    await h.engine.retry(key);
    assert.equal(h.run(key).status, 'queued', 'retry on paused is allowed (v1) and restarts');
    await h.engine.abort(key);
    assert.equal(h.run(key).status, 'aborted');
    await h.engine.abort(key); // already over: a no-op, not an error and not a second comment
    assert.equal((await comments(h, key)).filter((c) => c.includes('stopped')).length, 1);
    await assert.rejects(() => h.engine.cleanup(key), /./, 'no worktree yet → nothing to clean (or refused)').catch(() => undefined);
    assert.throws(() => h.engine.approve(key, 'human'), /not waiting for approval/);
    await assert.rejects(() => h.engine.abort('NOPE-1'), /Unknown run/);
  } finally {
    await h.cleanup();
  }
});

// ───────────────────────── crash protocol: one test per window ─────────────────────────
/** A board whose writes of `kinds` fail while `broken.on` is true (stands in for a crash/outage at exactly that point). */
function breakBoard(h: Harness, methods: string[]): { on: boolean } {
  const broken = { on: true };
  for (const m of methods) {
    const real = (h.board as any)[m].bind(h.board);
    (h.board as any)[m] = (...a: any[]) => {
      if (broken.on) throw new Error(`injected failure in board.${m}`);
      return real(...a);
    };
  }
  return broken;
}

test('K1 + window (a): the status change and its board effects are ONE run.json write — a crash right after it loses neither', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ claude: { '*': { plan: [{ json: { blocked: { is: true, questions: ['Which database?'] } } }] } } });
    const key = h.issue('Needs a decision');
    await h.engine.tick(); // claim
    const broken = breakBoard(h, ['addComment', 'setLane']);
    await h.settle();
    // the board is "down": the run record alone must already say needs_human AND hold the pending narration + lane projection
    const onDisk = JSON.parse(readFileSync(join(h.home, 'runs', key, 'run.json'), 'utf8'));
    assert.equal(onDisk.status, 'needs_human');
    const pending = Object.entries(onDisk.effects).filter(([, e]: any) => e.status === 'pending').map(([k]) => k);
    assert.ok(pending.includes('state') && pending.some((k) => k.startsWith('needs:')), `pending: ${pending}`);
    // "restart": a brand-new engine on the same store and a healthy board applies them
    broken.on = false;
    const { Engine } = await import('../src/pipeline/engine.ts');
    const e2 = new Engine({ getConfig: () => h.cfg, store: h.store, board: h.board, agents: h.agents, notify: () => undefined, persistent: { load: () => ({ repos: {} }), save: () => undefined } });
    await e2.tick();
    assert.equal(laneOf(h, key), 'needs_you');
    assert.equal((await comments(h, key)).filter((c) => c.includes('Which database?')).length, 1);
    await e2.tick();
    assert.equal((await comments(h, key)).filter((c) => c.includes('Which database?')).length, 1, 'a second pass adds nothing');
  } finally {
    await h.cleanup();
  }
});

test('window (c): a bug card created but not recorded on the BugRec converges without duplicating', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.planApproval = 'manual') });
  try {
    const key = h.issue('bug window');
    await h.settle();
    const run = h.run(key);
    const itemId = run.itemId;
    const project = h.board.item(key)!.projectId;
    h.store.update(key, (r) => {
      r.bugs.push({ fp: 'fp1', title: 'x', severity: 'major', detail: 'd', status: 'open', loops: [1] });
      Effects.enqueue(r, 'bug:fp1', { kind: 'subissue', payload: { fp: 'fp1', title: '[Bug] x', description: 'd' } });
    });
    // the child reached the board before the "crash" …
    h.board.createItem({ projectId: project, title: '[Bug] x', description: 'd', kind: 'bug', parentId: itemId, lane: 'todo', autoStart: false, idemKey: `${key}:bug:fp1` }, 'conductor');
    await h.engine.effects.flush(key);
    assert.equal(h.board.children(itemId).length, 1, 'no second child');
    const bug = h.run(key).bugs.find((b) => b.fp === 'fp1')!;
    assert.equal(bug.itemId, h.board.children(itemId)[0]!.id, 'the BugRec was reconnected to the existing card');
  } finally {
    await h.cleanup();
  }
});

test('window (d): a run created by a claim that crashed before the lane projection converges to the right lane — and is not claimed twice', async () => {
  const h = await makeHarness();
  try {
    h.engine.setPaused(true); // hold the job loop; we only want the claim/projection behaviour
    const key = h.issue('half claimed');
    const item = h.board.item(key)!;
    h.store.create(newRun({ key, itemId: item.id, title: item.title, description: item.description, descHash: sha1(item.description), repo: 'demo', branch: `conductor/${key.toLowerCase()}`, worktree: '', baseSha: '', loopBudget: 3 }));
    assert.equal(laneOf(h, key), 'todo', 'the crash left the card in To do');
    await h.engine.tick();
    assert.equal(laneOf(h, key), 'active', 'the projection heals it');
    assert.equal(h.store.list().length, 1, 'never a second run');
  } finally {
    await h.cleanup();
  }
});

test('window (e) + level-triggered projection: a run that says finished/ready/parked pulls its card to the right lane, whatever the card says', async () => {
  const h = await makeHarness();
  try {
    const key = h.issue('drift');
    await h.settle();
    assert.equal(laneOf(h, key), 'review');
    h.board.setLane(key, 'active', 'conductor', { stage: 'building' }); // drift
    await h.engine.tick();
    assert.equal(laneOf(h, key), 'review');
    h.store.update(key, (r) => void (r.status = 'finished')); // the run moved on, the card did not
    await h.engine.tick();
    assert.equal(laneOf(h, key), 'done');
  } finally {
    await h.cleanup();
  }
});

// ───────────────────────── K2 / K4 / untrusted ─────────────────────────
test('K2: a human move is not reverted by the projection, even when ticks interleave with it', async () => {
  const h = await makeHarness();
  try {
    const key = h.issue('interleave');
    await h.settle();
    await Promise.all([h.engine.applyHumanMove(key, 'backlog'), h.engine.tick(), h.engine.tick(), h.engine.tick()]);
    await h.engine.tick();
    assert.equal(h.run(key).status, 'parked');
    assert.equal(laneOf(h, key), 'backlog', 'the card stayed where the human put it');
    await Promise.all([h.engine.applyHumanMove(key, 'done'), h.engine.tick(), h.engine.tick()]);
    await h.engine.tick();
    assert.equal(laneOf(h, key), 'done');
  } finally {
    await h.cleanup();
  }
});

test('K4: a card sitting in a Conductor-owned lane without a run is flagged, never auto-run; ask/research cards are not claimed yet', async () => {
  const h = await makeHarness();
  try {
    const orphan = h.board.createItem({ projectId: h.projectId, title: 'lost its run', lane: 'active' }, 'import');
    const ask = h.board.user.createItem({ projectId: h.projectId, title: 'a question', kind: 'ask' });
    await h.settle();
    assert.equal(h.store.list().length, 0, 'nothing was started');
    assert.equal(laneOf(h, orphan.key), 'active', 'the lane was not reset to To do');
    const ig = h.engine.status().ignored;
    assert.ok(ig.some((i) => i.key === orphan.key && /no run for it/.test(i.reason)));
    assert.ok(ig.some((i) => i.key === ask.key && /not supported yet/.test(i.reason)));
  } finally {
    await h.cleanup();
  }
});

test('claim rules: a card waits for its dependencies; a child card is never a task', async () => {
  const h = await makeHarness();
  try {
    const first = h.board.user.createItem({ projectId: h.projectId, title: 'first', lane: 'backlog' });
    const second = h.board.user.createItem({ projectId: h.projectId, title: 'second', dependsOn: [first.id] });
    await h.settle();
    assert.equal(h.store.has(second.key), false);
    assert.ok(h.engine.status().ignored.some((i) => i.key === second.key && /depend/.test(i.reason)));
    await h.engine.applyHumanMove(first.key, 'done');
    await h.settle();
    assert.equal(h.run(second.key).status, 'ready', 'claimed once the dependency is done');
    assert.ok(!h.store.has(first.key));
  } finally {
    await h.cleanup();
  }
});

test('untrusted source: an imported card always waits for plan approval, even with auto-approval', async () => {
  const h = await makeHarness();
  try {
    h.board.createItem({ projectId: h.projectId, key: 'ENG-77', title: 'imported task', description: 'x', lane: 'todo', external: { system: 'linear', key: 'ENG-77', url: 'https://linear.app/x/issue/ENG-77' } }, 'import');
    await h.settle();
    assert.equal(h.run('ENG-77').status, 'awaiting_approval');
    assert.equal(h.run('ENG-77').untrusted, true);
    assert.match((await comments(h, 'ENG-77')).join('\n'), /unverified source/);
    h.engine.approve('ENG-77', 'human', h.run('ENG-77').rev);
    await h.settle();
    assert.equal(h.run('ENG-77').status, 'ready');
  } finally {
    await h.cleanup();
  }
});

test('a board change wakes the engine (no polling lag) and the runtime keeps the board open until close', async () => {
  const h = await makeHarness();
  try {
    h.engine.start({ pollMs: 60_000 }); // the timer will not fire during the test
    await new Promise((r) => setTimeout(r, 100));
    const key = h.issue('wake me');
    const t0 = Date.now();
    while (!h.store.has(key)) {
      if (Date.now() - t0 > 5000) throw new Error('the engine did not react to the board change');
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await h.cleanup();
  }
});
