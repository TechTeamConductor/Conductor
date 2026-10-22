import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, TestClock } from './helpers/harness.ts';
import { comments } from './helpers/util.ts';
import { applySettings } from '../src/config.ts';

test('Claude usage limit pauses (does not fail), comments once, notifies, and auto-resumes after the reset', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock, config: (c) => void (c.roles = applySettings(c, { onClaudeLimit: 'wait' }).roles) });
  try {
    const resetsAt = Math.floor(clock.now() / 1000) + 2 * 3600;
    h.scenario({ claude: { '*': { plan: [{ limit: { resetsAt } }, {}] } } });
    const key = h.issue('Limited feature');
    await h.settle();
    let run = h.run(key);
    assert.equal(run.status, 'paused');
    assert.equal(run.pausedUntil, resetsAt * 1000);
    assert.ok(h.engine.status().providerPause.claude, 'provider pause is visible to the dashboard');
    assert.equal((await comments(h, key)).filter((c) => c.includes('Paused')).length, 1);
    assert.ok(h.notes.some((n) => /limit/i.test(n.title)));
    // no retry storm: many polls while paused must not call claude again
    const before = h.calls().filter((c) => c.who === 'claude').length;
    for (let i = 0; i < 6; i++) {
      await h.engine.tick();
      await h.engine.idle();
    }
    assert.equal(h.calls().filter((c) => c.who === 'claude').length, before);
    assert.equal((await comments(h, key)).filter((c) => c.includes('Paused')).length, 1, 'still exactly one comment');
    // time passes → resumes by itself and completes
    clock.advance(2 * 3600_000 + 5000);
    await h.settle();
    run = h.run(key);
    assert.equal(run.status, 'ready');
  } finally {
    await h.cleanup();
  }
});

test('onClaudeLimit=cursor falls back to a read-only Cursor stage', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock, config: (c) => void (c.roles = applySettings(c, { onClaudeLimit: 'cursor' }).roles) });
  try {
    h.scenario({ claude: { '*': { plan: [{ limit: {} }], verify: [{ limit: {} }] } } });
    const key = h.issue('Fallback feature');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready', JSON.stringify(run.history.map((x) => x.text)));
    const cursorAsk = h.calls().filter((c) => c.who === 'cursor' && c.argv.includes('--mode'));
    assert.ok(cursorAsk.length >= 2, 'plan and verify ran on Cursor ask-mode');
    for (const c of cursorAsk) assert.ok(!c.argv.includes('--force'), 'read-only fallback never uses --force');
  } finally {
    await h.cleanup();
  }
});

test('Cursor usage limit pauses the build and resumes', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock });
  try {
    h.scenario({ cursor: { '*': { build: [{ limit: true }, {}] } } });
    const key = h.issue('Cursor limited');
    await h.settle();
    assert.equal(h.run(key).status, 'paused');
    assert.ok(h.engine.status().providerPause.cursor);
    clock.advance(16 * 60_000);
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
  } finally {
    await h.cleanup();
  }
});
