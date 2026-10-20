// LIVE: a question-only issue (the exact failure from the first real run) must be ANSWERED, not pushed through build/verify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from '../helpers/harness.ts';
import { comments } from '../helpers/util.ts';

const LIVE = process.env.LIVE === '1';

test('LIVE real Cursor: "what does this project export?" → answered in Linear, finished, no build/verify sessions', { skip: !LIVE, timeout: 15 * 60_000 }, async () => {
  const h = await makeHarness({
    repoFiles: { 'src/math.mjs': 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n' },
    config: (c) => {
      c.agents.cursor.bin = 'agent';
      c.stages = { plan: 'cursor', review: 'cursor', verify: 'cursor' };
      c.pipeline.timeoutsMin = { plan: 8, review: 5, build: 15, verify: 8, idle: 5, gate: 3 };
    },
  });
  try {
    const key = h.issue('What functions does src/math.mjs export?', { description: 'Just tell me which functions src/math.mjs exports and what each does. No code changes please.' });
    await h.settle(40);
    const run = h.run(key);
    console.log('STATUS', run.status, '| answered', run.answered, '| sessions', run.sessions.map((s) => `${s.agent}/${s.stage}`).join(' '));
    const cs = await comments(h, key);
    console.log('COMMENT:', (cs.find((c) => c.includes('Answer')) ?? cs.join('\n---\n')).slice(0, 500));
    assert.equal(run.status, 'ready', `needs_human reason: ${run.needsHuman?.reason ?? ''}`);
    assert.equal(run.answered, true);
    assert.ok(!run.sessions.some((s) => s.stage === 'build' || s.stage === 'verify'), 'no build or verify happened');
    const answer = cs.find((c) => c.includes('Answer')) ?? '';
    assert.ok(/add/.test(answer) && /mul/.test(answer), 'the answer names both exports');
  } finally {
    await h.cleanup();
  }
});
