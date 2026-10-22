// The human command matrix of workspace-v2-m1.md, every run.status × command cell, with each status reached through the REAL
// mechanism (pipeline, limit pause, injected internal error, manual approval, hanging agent) — never by overwriting run.status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { makeHarness, type Harness } from './helpers/harness.ts';
import { laneOf } from './helpers/util.ts';
import type { RunStatus } from '../src/types.ts';

type Status = RunStatus | 'none';
const STATUSES: Status[] = ['none', 'queued', 'running', 'paused', 'awaiting_approval', 'needs_human', 'ready', 'finished', 'aborted', 'parked', 'failed'];

async function until(fn: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** A harness whose single card is in `status`, reached for real. The job loop is stopped afterwards so nothing moves under the assertion. */
async function reach(status: Status): Promise<{ h: Harness; key: string }> {
  const manual = status === 'queued' || status === 'awaiting_approval';
  const h = await makeHarness({ config: (c) => void (c.pipeline.planApproval = manual ? 'manual' : 'auto') });
  if (status === 'none') return { h, key: h.issue('matrix', { lane: 'backlog' }) };
  if (status === 'running') h.scenario({ claude: { '*': { plan: [{ delayMs: 20, hang: true }] } } });
  if (status === 'needs_human') h.scenario({ claude: { '*': { plan: [{ json: { blocked: { is: true, questions: ['Which one?'] } } }] } } });
  if (status === 'paused') h.scenario({ cursor: { '*': { build: [{ limit: true }] } } });
  const key = h.issue('matrix');
  if (status === 'failed') {
    // a genuine internal error inside a stage (the engine's own failure path), once
    const real = h.agents.readOnly.bind(h.agents);
    let boom = true;
    (h.agents as any).readOnly = async (...a: any[]) => {
      if (boom) {
        boom = false;
        throw new Error('injected internal error');
      }
      return (real as any)(...a);
    };
  }
  if (status === 'running') {
    await h.engine.tick();
    await until(() => h.store.get(key)?.status === 'running');
  } else await h.settle();
  if (status === 'queued') h.engine.approve(key, 'human'); // markApproved → queued; the engine is not started, so no job begins
  else if (status === 'finished') await h.engine.applyHumanMove(key, 'done');
  else if (status === 'aborted') await h.engine.abort(key);
  else if (status === 'parked') await h.engine.applyHumanMove(key, 'backlog');
  assert.equal(h.run(key).status, status, `could not reach ${status} through the pipeline`);
  h.engine.setPaused(true); // no new claims; (jobs only start from ticks)
  return { h, key };
}

type Expect = RunStatus | `lane:${string}` | RegExp;
const MOVE: Record<string, Partial<Record<Status, Expect>>> = {
  backlog: { none: 'lane:backlog', queued: 'parked', running: 'parked', paused: 'parked', awaiting_approval: 'parked', needs_human: 'parked', ready: 'parked', failed: 'parked', parked: 'parked', finished: /already finished or canceled/, aborted: /already finished or canceled/ },
  todo: { none: 'lane:todo', queued: 'queued', running: 'queued', paused: 'queued', awaiting_approval: 'queued', needs_human: 'queued', ready: 'queued', failed: 'queued', parked: 'queued', finished: 'queued', aborted: 'queued' },
  done: { none: 'lane:done', queued: 'finished', running: 'finished', paused: 'finished', awaiting_approval: 'finished', needs_human: 'finished', ready: 'finished', failed: 'finished', parked: 'finished', finished: 'finished', aborted: /canceled/ },
  canceled: { none: 'lane:canceled', queued: 'aborted', running: 'aborted', paused: 'aborted', awaiting_approval: 'aborted', needs_human: 'aborted', ready: 'aborted', failed: 'aborted', parked: 'aborted', aborted: 'aborted', finished: /already done/ },
};
for (const [lane, cells] of Object.entries(MOVE)) {
  for (const status of STATUSES) {
    test(`matrix · move → ${lane} while ${status}`, async () => {
      const { h, key } = await reach(status);
      try {
        const want = cells[status]!;
        assert.ok(want, `cell missing: ${lane}/${status}`);
        if (want instanceof RegExp) {
          await assert.rejects(() => h.engine.applyHumanMove(key, lane), want);
          return;
        }
        await h.engine.applyHumanMove(key, lane);
        if (want.startsWith('lane:')) {
          assert.equal(h.board.item(key)!.lane, want.slice(5));
          assert.equal(h.store.has(key), false, 'a card without a run stays run-less');
        } else {
          assert.equal(h.run(key).status, want);
          // the card follows the run (level-triggered): one tick and the lane is the projection of the status
          await h.engine.tick();
          const lanes: Record<string, string> = { parked: 'backlog', finished: 'done', aborted: 'canceled', queued: 'active' };
          assert.equal(laneOf(h, key), lanes[want]);
        }
      } finally {
        await h.cleanup();
      }
    });
  }
}

type Cmd = 'approve' | 'retry' | 'resume' | 'abort' | 'cleanup';
const OTHER: Record<Cmd, Partial<Record<Status, Expect>>> = {
  approve: { awaiting_approval: 'queued', queued: /not waiting for approval/, running: /not waiting for approval/, paused: /not waiting for approval/, needs_human: /not waiting for approval/, ready: /not waiting for approval/, finished: /not waiting for approval/, aborted: /not waiting for approval/, parked: /not waiting for approval/, failed: /not waiting for approval/ },
  retry: { queued: /already working/, running: /already working/, paused: 'queued', awaiting_approval: 'queued', needs_human: 'queued', ready: 'queued', finished: 'queued', aborted: 'queued', failed: 'queued', parked: /Backlog/ },
  resume: { paused: 'queued', parked: /Backlog/, queued: /Nothing to resume/, running: /Nothing to resume/, awaiting_approval: /Nothing to resume/, needs_human: /Nothing to resume/, ready: /Nothing to resume/, finished: /Nothing to resume/, aborted: /Nothing to resume/, failed: /Nothing to resume/ },
  abort: { queued: 'aborted', running: 'aborted', paused: 'aborted', awaiting_approval: 'aborted', needs_human: 'aborted', ready: 'aborted', failed: 'aborted', parked: 'aborted', finished: 'finished', aborted: 'aborted' },
  cleanup: { queued: /Only finished runs/, running: /Only finished runs/, paused: /Only finished runs/, awaiting_approval: /Only finished runs/, needs_human: /Only finished runs/, failed: /Only finished runs/, parked: /Only finished runs/, ready: 'ready', finished: 'finished', aborted: 'aborted' },
};
for (const [cmd, cells] of Object.entries(OTHER) as [Cmd, Partial<Record<Status, Expect>>][]) {
  for (const status of STATUSES.filter((s) => s !== 'none')) {
    test(`matrix · ${cmd} while ${status}`, async () => {
      const { h, key } = await reach(status);
      try {
        const want = cells[status]!;
        assert.ok(want, `cell missing: ${cmd}/${status}`);
        const call = async () => {
          if (cmd === 'approve') h.engine.approve(key, 'human', h.run(key).rev);
          else if (cmd === 'retry') await h.engine.retry(key);
          else if (cmd === 'resume') h.engine.resume(key);
          else if (cmd === 'abort') await h.engine.abort(key);
          else await h.engine.cleanup(key);
        };
        if (want instanceof RegExp) {
          await assert.rejects(call, want);
          return;
        }
        const wt = h.run(key).worktree;
        await call();
        if (cmd === 'cleanup') {
          assert.equal(h.run(key).status, want, 'cleanup does not change the status');
          assert.equal(h.run(key).worktree, '');
          if (wt) assert.equal(existsSync(wt), false, 'the worktree was removed');
        } else assert.equal(h.run(key).status, want);
        if (cmd === 'abort' && status !== 'finished' && status !== 'aborted') {
          await h.engine.abort(key); // a second abort is a no-op, not a second comment
          assert.equal(h.board.comments(key).filter((c) => c.body.includes('stopped')).length, 1);
        }
      } finally {
        await h.cleanup();
      }
    });
  }
}

test('matrix · abort and every move on a card that has no run: unknown run / lane-only', async () => {
  const h = await makeHarness();
  try {
    const key = h.issue('no run', { lane: 'backlog' });
    await assert.rejects(() => h.engine.abort(key), /Unknown run/);
    await assert.rejects(() => h.engine.retry(key), /Unknown run/);
    assert.throws(() => h.engine.resume(key), /Unknown run/);
    assert.throws(() => h.engine.approve(key), /not waiting for approval/);
    // an id works exactly like a key and routes through the same run (never straight to the board when a run exists)
    const k2 = h.issue('has a run');
    await h.settle();
    const id = h.board.item(k2)!.id;
    h.engine.setPaused(true);
    await h.engine.applyHumanMove(id, 'backlog');
    assert.equal(h.run(k2).status, 'parked', 'moving by id parks the RUN, not just the card');
  } finally {
    await h.cleanup();
  }
});
