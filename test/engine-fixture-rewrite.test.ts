// Complete auto: one local rewrite when a build only trips the secret scan inside a test or fixture.
// Per settings, a production path, a secret file name, and a second failure still stop for a person. Nothing is pushed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, type Harness } from './helpers/harness.ts';

const TOKEN = `ghp_${'A'.repeat(36)}`;
const SECRET_TS = `export const token = '${TOKEN}';\n`;
const CLEAN_TS = `export const token = 'token-placeholder-not-a-credential';\n`;
const TEST_PATH = 'services/api/src/connection-store.test.ts';

async function harness(runMode: 'per-settings' | 'complete-auto'): Promise<Harness> {
  return makeHarness({
    gates: false,
    config: (c) => {
      c.pipeline.runMode = runMode;
    },
  });
}

const builds = (h: Harness) => h.calls().filter((c) => c.who === 'cursor' && c.stage === 'build');

test('Complete auto rewrites a test-only credential shape once and finishes locally', async () => {
  const h = await harness('complete-auto');
  try {
    h.scenario({
      cursor: {
        '*': {
          build: [
            { files: { [TEST_PATH]: SECRET_TS } },
            { files: { [TEST_PATH]: CLEAN_TS } },
          ],
        },
      },
    });
    const key = h.issue('Connection store');
    await h.settle();
    const r = h.run(key);
    assert.equal(r.status, 'ready', r.needsHuman?.reason);
    assert.equal(r.secretFixtureRewrites, 1);
    assert.equal(builds(h).length, 2);
    assert.ok(r.history.some((l) => /rewriting credential-shaped text/.test(l.text)));
    assert.ok(r.commitSha, 'the local worktree commit is kept');
    assert.equal(r.needsHuman, undefined);
  } finally {
    await h.cleanup();
  }
});

test('Per settings still stops on the same test file', async () => {
  const h = await harness('per-settings');
  try {
    h.scenario({ cursor: { '*': { build: [{ files: { [TEST_PATH]: SECRET_TS } }] } } });
    const key = h.issue('Connection store');
    await h.settle();
    const r = h.run(key);
    assert.equal(r.status, 'needs_human');
    assert.match(r.needsHuman?.reason ?? '', /secret-looking content in added lines: services\/api\/src\/connection-store\.test\.ts/);
    assert.doesNotMatch(r.needsHuman?.reason ?? '', /ghp_/);
    assert.equal(r.secretFixtureRewrites, undefined);
    assert.equal(builds(h).length, 1);
  } finally {
    await h.cleanup();
  }
});

test('Complete auto still stops for a production path and a secret file name', async () => {
  for (const files of [{ 'src/connection-store.ts': SECRET_TS }, { 'certs/server.pem': 'not-a-key\n' }] as Record<string, string>[]) {
    const h = await harness('complete-auto');
    try {
      h.scenario({ cursor: { '*': { build: [{ files }] } } });
      const key = h.issue('Do not leak');
      await h.settle();
      const r = h.run(key);
      assert.equal(r.status, 'needs_human', JSON.stringify(Object.keys(files)));
      assert.match(r.needsHuman?.reason ?? '', /secret/i);
      assert.equal(r.secretFixtureRewrites, undefined);
      assert.equal(builds(h).length, 1);
    } finally {
      await h.cleanup();
    }
  }
});

test('a second test-file failure under Complete auto still needs a person', async () => {
  const h = await harness('complete-auto');
  try {
    h.scenario({
      cursor: {
        '*': {
          build: [{ files: { [TEST_PATH]: SECRET_TS } }, { files: { [TEST_PATH]: SECRET_TS } }],
        },
      },
    });
    const key = h.issue('Still secret');
    await h.settle();
    const r = h.run(key);
    assert.equal(r.status, 'needs_human');
    assert.equal(r.secretFixtureRewrites, 1);
    assert.equal(builds(h).length, 2);
    assert.match(r.needsHuman?.reason ?? '', /connection-store\.test\.ts/);
  } finally {
    await h.cleanup();
  }
});
