import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeHarness, makeRepo } from './helpers/harness.ts';
import { comments } from './helpers/util.ts';

test('Claude isolation is fail-closed: an unexpected tool/MCP in init stops the stage', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ claude: { '*': { plan: [{ badInit: true }] } } });
    const key = h.issue('Leaky claude');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'needs_human');
    assert.match(run.needsHuman?.reason ?? '', /Isolation check failed/);
  } finally {
    await h.cleanup();
  }
});

test('builder env: no secrets, no-push git env present, Cursor deny rule written and git-excluded', async () => {
  process.env.LINEAR_API_KEY = 'lin_api_SECRETSECRETSECRETSECRET1234';
  process.env.CURSOR_API_KEY = 'crsr_cursorsecretvalue123456789012';
  const h = await makeHarness();
  try {
    const key = h.issue('Env check');
    await h.settle();
    const build = h.calls().find((c) => c.who === 'cursor' && c.stage === 'build');
    assert.ok(build);
    assert.ok(!build.envKeys.includes('LINEAR_API_KEY'), 'Linear key must not reach the builder');
    assert.ok(build.envKeys.includes('CURSOR_API_KEY'), 'Cursor credentials are passed (only) to Cursor');
    assert.ok(build.envKeys.includes('GIT_CONFIG_COUNT'), 'no-push env present');
    assert.equal(build.env.GIT_SSH_COMMAND, '/usr/bin/false');
    assert.equal(build.env.GIT_TERMINAL_PROMPT, '0');
    assert.ok(build.argv.includes('--force') && build.argv.includes('--trust'));
    assert.ok(!build.argv.includes('--approve-mcps'), 'never auto-approve MCP servers');
    const run = h.run(key);
    const cli = JSON.parse(readFileSync(join(run.worktree, '.cursor', 'cli.json'), 'utf8'));
    assert.deepEqual(cli.permissions.allow, []);
    assert.ok(cli.permissions.deny.includes('Shell(git:push*)'));
    assert.equal(git(run.worktree, 'status', '--porcelain'), '', 'cli.json is git-excluded and never committed');
    const claude = h.calls().filter((c) => c.who === 'claude');
    for (const c of claude) {
      assert.ok(!c.envKeys.includes('LINEAR_API_KEY'));
      assert.ok(!c.envKeys.includes('CURSOR_API_KEY'));
    }
  } finally {
    delete process.env.LINEAR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    await h.cleanup();
  }
});

test('diff-scope guard: builder-written .claude/ config is held for a human', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ cursor: { '*': { build: [{ files: { 'feature.mjs': 'export const x = 1;\n', '.claude/settings.json': '{"hooks":{}}\n' } }] } } });
    const key = h.issue('Sneaky config');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'needs_human');
    assert.match(run.needsHuman?.reason ?? '', /protected files/);
    assert.match(run.needsHuman?.reason ?? '', /\.claude\/settings\.json/);
  } finally {
    await h.cleanup();
  }
});

test('builder tampering with the no-push guard file is detected', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ cursor: { '*': { build: [{ tamperGuard: true }] } } });
    const key = h.issue('Tamper');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.match(h.run(key).needsHuman?.reason ?? '', /no-push guard/);
  } finally {
    await h.cleanup();
  }
});

test('a builder that tries `git push` to the named remote cannot push (env neutralisation)', async () => {
  const h = await makeHarness();
  try {
    const bare = join(h.root, 'remote.git');
    git(h.root, 'init', '-q', '--bare', bare);
    git(h.repoDir, 'remote', 'add', 'origin', bare);
    h.scenario({ cursor: { '*': { build: [{ attemptPush: true }] } } });
    const key = h.issue('Push attempt');
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
    assert.equal(git(bare, 'for-each-ref'), '', 'remote is untouched');
  } finally {
    await h.cleanup();
  }
});

test('secrets from copied env files are redacted from Linear comments and logs', async () => {
  const secret = 'SuperSecretValue-9f8e7d6c5b4a';
  const h = await makeHarness({
    repoFiles: {},
    config: (c) => void (c.repos[0]!.copyFiles = ['.env']),
  });
  try {
    writeFileSync(join(h.repoDir, '.env'), `API_TOKEN=${secret}\n`);
    h.scenario({ cursor: { '*': { build: [{ message: `Done. I noticed the token ${secret} in .env` }] } } });
    const key = h.issue('Leak test');
    await h.settle();
    const all = (await comments(h, key)).join('\n') + JSON.stringify(h.store.readEvents(key, 0, 2000).events) + JSON.stringify(h.run(key));
    assert.ok(!all.includes(secret), 'secret value must not appear anywhere we persist or post');
    assert.ok(all.includes('[redacted]') || !all.includes('token'), 'redaction marker present when the text was echoed');
    // and the env file was never committed
    assert.ok(!git(h.run(key).worktree, 'ls-files').includes('.env'));
  } finally {
    await h.cleanup();
  }
});

test('crash between "comment created" and "recorded": retry adopts the existing comment (no duplicate)', async () => {
  const h = await makeHarness();
  try {
    const key = h.issue('Idempotent');
    // the first plan comment is created in Linear but the call "fails" after success
    h.linear.failNext('comment', new Error('network dropped after write'), 1, { after: true });
    await h.settle();
    for (let i = 0; i < 3; i++) await h.engine.tick(); // flush pending effects
    const cs = (await comments(h, key)).filter((c) => c.includes('conductor-ref:') && c.includes(':claimed'));
    assert.equal(cs.length, 1, 'claimed comment exists exactly once');
    const planCs = (await comments(h, key)).filter((c) => c.includes('Conductor plan'));
    assert.equal(planCs.length, 1);
  } finally {
    await h.cleanup();
  }
});

test('Linear outage during a run does not lose work; effects flush when Linear recovers', async () => {
  const h = await makeHarness();
  try {
    const key = h.issue('Outage');
    await h.engine.tick(); // claim OK
    h.linear.failNext('comment', new Error('Linear is down'), 50);
    h.linear.failNext('update', new Error('Linear is down'), 50);
    await h.settle(); // pipeline still completes locally
    assert.equal(h.run(key).status, 'ready');
    assert.ok(h.engine.effects.pendingCount(key) > 0, 'some effects are still pending');
    h.linear.clearFailures();
    for (let i = 0; i < 4; i++) await h.engine.tick();
    assert.equal(h.engine.effects.pendingCount(key), 0);
    assert.ok((await comments(h, key)).some((c) => c.includes('Ready for review')));
  } finally {
    await h.cleanup();
  }
});

test('crash recovery: a run that was mid-build restarts cleanly without duplicating comments', async () => {
  const h = await makeHarness({ config: (c) => void (c.pipeline.planApproval = 'manual') });
  try {
    const key = h.issue('Recover me');
    await h.settle();
    h.engine.approve(key, 'human');
    // simulate the process dying mid-build: status running, partial uncommitted work in the worktree
    const run = h.run(key);
    writeFileSync(join(run.worktree, 'partial.mjs'), 'half-written\n');
    h.store.update(key, (r) => void (r.status = 'running'));
    h.engine.recover();
    assert.equal(h.run(key).status, 'queued');
    await h.settle();
    const after = h.run(key);
    assert.equal(after.status, 'ready');
    assert.ok(!git(after.worktree, 'ls-files').includes('partial.mjs'), 'partial work was discarded (and backed up)');
    assert.ok(git(after.worktree, 'for-each-ref', '--format=%(refname)', `refs/conductor/${key}/`).includes('stash-'), 'partial work is recoverable');
    const plans = (await comments(h, key)).filter((c) => c.includes('Conductor plan'));
    assert.equal(plans.length, 1);
  } finally {
    await h.cleanup();
  }
});

test('no gates detected → verified by AI only and flagged "unverified" (never a silent pass)', async () => {
  const h = await makeHarness({ gates: false });
  try {
    const key = h.issue('No tests here');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.equal(run.unverified, true);
    assert.match(run.unverifiedWhy ?? '', /No automated quality gates/);
    assert.ok((await comments(h, key)).some((c) => c.includes('not verified by automated tests')));
  } finally {
    await h.cleanup();
  }
});

test('noGates=block sends the run to a human instead', async () => {
  const h = await makeHarness({ gates: false, config: (c) => void (c.pipeline.noGates = 'block') });
  try {
    const key = h.issue('No tests, strict');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
  } finally {
    await h.cleanup();
  }
});

test('baseline masking: a gate already failing at baseline cannot hide new failures', async () => {
  const failing = (n: number) => Array.from({ length: n }, (_, i) => `test('pre-${i}', () => assert.fail('boom'));`).join('\n');
  const h = await makeHarness({
    repoFiles: { 'pre.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\n${failing(2)}\n` },
  });
  try {
    h.scenario({
      cursor: { '*': { build: [
        { files: { 'new.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\n${failing(3).replace(/pre-/g, 'new-')}\n` } },
        { files: { 'new.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('new-ok', () => assert.ok(true));\n` } },
      ] } },
      claude: { '*': { verify: [{ json: { verdict: 'pass' } }] } },
    });
    const key = h.issue('Add failing tests');
    await h.settle();
    const run = h.run(key);
    assert.ok(run.bugs.some((b) => b.title.startsWith('Quality gate regression')), 'new failures reported although the gate was already red');
    const g1 = h.store.readArtifact<any>(key, 'gates-1.json', null);
    assert.ok(g1.comparison.regressions[0].newFailures.some((f: string) => f.includes('new-')), JSON.stringify(g1.comparison));
    assert.equal(run.status, 'ready', 'after the fix only the 2 pre-existing failures remain (not blamed)');
  } finally {
    await h.cleanup();
  }
});
void mkdirSync; void makeRepo;
