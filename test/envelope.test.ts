// M2 commit 1a — CHARACTERIZATION of the build envelope (Security design condition 1f).
// These tests are written against the code as it is BEFORE the envelope is extracted from stages.build() and must pass
// UNCHANGED after the extraction (commit 1b). They pin what the envelope guarantees for ANY builder: git no-push env,
// git-meta restore, guard verification, secret/scope checks, failure routing and the run fields the API derives from.
// Cases that depend on a provider contract that does not exist yet (verifyGuard/prepare throwing, prepare overriding
// GIT_CONFIG_GLOBAL, a provider without prepare) are added in 1b.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeHarness, TestClock, type Harness } from './helpers/harness.ts';

const fail = (h: Harness, key: string) => h.run(key).needsHuman?.reason ?? '';
const cursorCalls = (h: Harness) => h.calls().filter((c) => c.who === 'cursor' && c.stage === 'build');

test('E1: a builder that plants a hook, core.hooksPath, an alias AND a pushurl is stopped; every one is restored; nothing is committed', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ cursor: { '*': { build: [{ tamperGit: true, tamperPushUrl: true }] } } });
    const key = h.issue('Innocent task');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.match(fail(h, key), /git settings\/hooks/);
    assert.match(fail(h, key), /pushurl/i, 'the reason names the pushurl change');
    assert.equal(existsSync(join(h.repoDir, '.git', 'hooks', 'post-commit')), false);
    assert.doesNotMatch(readFileSync(join(h.repoDir, '.git', 'config'), 'utf8'), /hookspath|alias|pushurl|evil/i);
    assert.equal(h.run(key).commitSha, undefined, 'a tampering builder never gets a commit recorded');
  } finally {
    await h.cleanup();
  }
});

test('E2: the guard file modified OR deleted by the builder is detected, and the run is held (not committed, not verified)', async () => {
  for (const op of [{ tamperGuard: true }, { deleteGuard: true }]) {
    const h = await makeHarness();
    try {
      h.scenario({ cursor: { '*': { build: [op] } } });
      const key = h.issue('Guard tamper');
      await h.settle();
      assert.equal(h.run(key).status, 'needs_human', JSON.stringify(op));
      assert.match(fail(h, key), /no-push guard/, JSON.stringify(op));
      assert.equal(h.run(key).commitSha, undefined);
    } finally {
      await h.cleanup();
    }
  }
});

test('E3: a secret written to a file by the builder is refused at commit time (reason never repeats the secret)', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ cursor: { '*': { build: [{ files: { 'src/config.mjs': "export const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd';\n" } }] } } });
    const key = h.issue('Add config');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.match(fail(h, key), /refused to commit|secret/i);
    assert.doesNotMatch(fail(h, key), /sk-ant/);
    assert.equal(h.run(key).commitSha, undefined);
  } finally {
    await h.cleanup();
  }
});

test('E4: a protected file the plan did not list (uncommitted) is held for a human', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ cursor: { '*': { build: [{ files: { 'feature.mjs': 'export const x = 1;\n', '.github/workflows/ci.yml': 'name: x\n' } }] } } });
    const key = h.issue('Add feature');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.match(fail(h, key), /protected files/);
    assert.match(fail(h, key), /\.github\/workflows\/ci\.yml/);
  } finally {
    await h.cleanup();
  }
});

test('E5: renaming a protected tracked file away counts the rename SOURCE (builder moves .npmrc out of its protected name)', async () => {
  const h = await makeHarness({ repoFiles: { '.npmrc': 'registry=https://registry.npmjs.org/\n' } });
  try {
    h.scenario({ cursor: { '*': { build: [{ files: { 'feature.mjs': 'export const x = 1;\n' }, rename: { '.npmrc': 'src/npmrc.txt' } }] } } });
    const key = h.issue('Rename');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.match(fail(h, key), /protected files/);
    assert.match(fail(h, key), /\.npmrc/);
  } finally {
    await h.cleanup();
  }
});

test('E6: the builder environment carries the no-push git env, allow-listed keys only, and no secret-looking variables', async () => {
  const h = await makeHarness();
  try {
    process.env.CONDUCTOR_ENVELOPE_PROBE_TOKEN = 'must-not-reach-the-builder';
    process.env.GITHUB_TOKEN = 'must-not-reach-the-builder-either';
    const key = h.issue('Env probe');
    await h.settle();
    const call = cursorCalls(h)[0];
    assert.ok(call, 'a build call happened');
    assert.equal(call.env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(call.env.GIT_ASKPASS, '/usr/bin/false');
    assert.ok(!call.envKeys.includes('CONDUCTOR_ENVELOPE_PROBE_TOKEN'));
    assert.ok(!call.envKeys.includes('GITHUB_TOKEN'));
    assert.ok(!call.envKeys.some((k: string) => /^(LINEAR|OPENAI|CODEX)/.test(k)));
    assert.ok(key);
  } finally {
    delete process.env.CONDUCTOR_ENVELOPE_PROBE_TOKEN;
    delete process.env.GITHUB_TOKEN;
    await h.cleanup();
  }
});

test('E7: guard bookkeeping — a normal repo records the guard hash and is NOT env-only; a repo with a tracked .cursor/cli.json is env-only with no hash', async () => {
  const a = await makeHarness();
  try {
    const key = a.issue('Normal repo');
    await a.settle();
    assert.equal(a.run(key).noPushEnvOnly, false);
    assert.match(a.run(key).cursorGuardSha ?? '', /^[0-9a-f]{64}$/);
  } finally {
    await a.cleanup();
  }
  const b = await makeHarness({ repoFiles: { '.cursor/cli.json': '{"permissions":{"allow":[],"deny":[]}}\n' } });
  try {
    const key = b.issue('Repo with its own cli.json');
    await b.settle();
    assert.equal(b.run(key).noPushEnvOnly, true);
    assert.equal(b.run(key).cursorGuardSha, undefined);
    assert.ok(b.run(key).history.length > 0);
  } finally {
    await b.cleanup();
  }
});

test('E8: the commit trailer names the builder, and a clean build is committed exactly once on the run branch', async () => {
  const h = await makeHarness();
  try {
    const key = h.issue('Trailer');
    await h.settle();
    const run = h.run(key);
    assert.ok(run.commitSha);
    const msg = git(run.worktree, 'log', '-1', '--format=%B', run.commitSha!);
    assert.match(msg, /Built by Conductor \(Cursor\)\. Plan rev 1\./);
    assert.equal(git(run.worktree, 'rev-list', '--count', `${run.baseSha}..HEAD`), '1');
  } finally {
    await h.cleanup();
  }
});

test('E9: a builder that returns an ordinary error is retried once, then held — never committed, never verified', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ cursor: { '*': { build: [{ error: 'boom: something odd' }] } } });
    const key = h.issue('Failing builder');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.match(fail(h, key), /Cursor failed twice/);
    assert.equal(cursorCalls(h).length, 2, 'exactly one retry');
    assert.equal(h.run(key).commitSha, undefined);
  } finally {
    await h.cleanup();
  }
});

test('E10: a builder usage limit pauses the card, the attempt is refunded, and nothing is committed', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock });
  try {
    h.scenario({ cursor: { '*': { build: [{ limit: true }, {}] } } });
    const key = h.issue('Limited builder');
    await h.settle();
    assert.equal(h.run(key).status, 'paused');
    assert.equal(h.run(key).commitSha, undefined);
    assert.equal(h.run(key).agentRuns, 1, 'only the plan call counts — the limited build attempt is refunded');
    assert.ok(h.engine.status().providerPause.cursor);
  } finally {
    await h.cleanup();
  }
});

test('E11: canceling a card while its builder is running ends it as canceled with nothing committed', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ cursor: { '*': { build: [{ hang: true }] } } });
    const key = h.issue('Hanging builder');
    for (let i = 0; i < 40 && cursorCalls(h).length === 0; i++) {
      await h.engine.tick();
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(cursorCalls(h).length, 1, 'the builder started');
    await h.engine.abort(key);
    await h.settle();
    assert.equal(h.run(key).status, 'aborted');
    assert.equal(h.run(key).commitSha, undefined);
  } finally {
    await h.cleanup();
  }
});

test('E12: the provider throwing (a bug, not a result) never produces a commit or a pass', async () => {
  const h = await makeHarness();
  try {
    const real = h.agents.build.bind(h.agents);
    let thrown = 0;
    h.agents.build = async (req) => {
      thrown++;
      void real;
      throw new Error('provider crashed');
    };
    const key = h.issue('Thrown builder');
    await h.settle(12);
    assert.ok(thrown >= 1);
    assert.notEqual(h.run(key).status, 'finished');
    assert.equal(h.run(key).commitSha, undefined);
    assert.notEqual(h.run(key).stage, 'done');
  } finally {
    await h.cleanup();
  }
});

// Condition 1e: today the meta restore is not in a `finally`, so a provider that throws AFTER the builder planted a hook
// leaves the hook behind. The extraction fixes this on purpose (commit 1b removes `todo` — the assertion is already the target behaviour).
test('E13: the provider throwing AFTER the builder planted a hook/config still restores them', { todo: 'fixed by the finally{} in M2 commit 1b (Security 1e)' }, async () => {
  const h = await makeHarness();
  try {
    const real = h.agents.build.bind(h.agents);
    h.agents.build = async (req) => {
      await real(req);
      throw new Error('provider crashed after the builder ran');
    };
    h.scenario({ cursor: { '*': { build: [{ tamperGit: true, tamperPushUrl: true }] } } });
    const key = h.issue('Thrown after tamper');
    await h.settle(12);
    assert.equal(existsSync(join(h.repoDir, '.git', 'hooks', 'post-commit')), false, 'the planted hook is gone');
    assert.doesNotMatch(readFileSync(join(h.repoDir, '.git', 'config'), 'utf8'), /hookspath|alias|pushurl|evil/i);
    assert.ok(key);
  } finally {
    await h.cleanup();
  }
});
