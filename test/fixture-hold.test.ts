import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureContentHold, planFixtureRewrite, testOrFixturePath } from '../src/git/fixture-hold.ts';

const content = (path: string) => `Conductor refused to commit: secret-looking content in added lines: ${path}. Nothing was committed.`;
const branch = (path: string, kind = 'credential-shaped value') =>
  `The branch contains what looks like a secret (${path} (${kind})). Nothing was pushed. Remove it from the branch history before continuing.`;

test('test and fixture paths are recognised; production paths are not', () => {
  for (const p of ['services/api/src/connection-store.test.ts', 'a.spec.tsx', 'src/foo.test.mjs', 'fixtures/tokens.json', 'pkg/__fixtures__/key.js']) {
    assert.equal(testOrFixturePath(p), true, p);
  }
  for (const p of ['services/api/src/connection-store.ts', '.env', 'src/secrets.ts', 'test-utils.ts']) {
    assert.equal(testOrFixturePath(p), false, p);
  }
});

test('only all-test content holds can be rewritten once', () => {
  const ok = fixtureContentHold(content('services/api/src/connection-store.test.ts'));
  assert.deepEqual(ok, { paths: ['services/api/src/connection-store.test.ts'], committed: false });
  const both = `Conductor refused to commit: secret-looking content in added lines: a.test.ts\nsecret-looking content in added lines: src/app.ts. Nothing was committed.`;
  assert.equal(fixtureContentHold(both), null, 'a production path blocks the rewrite');
  assert.equal(fixtureContentHold(content('.env')), null);
  assert.equal(fixtureContentHold(`Conductor refused to commit: secret-like file name: fixtures/id_rsa. Nothing was committed.`), null);
  assert.equal(fixtureContentHold(`Conductor refused to commit: file too large: a.test.ts (9 MB > 5 MB). Nothing was committed.`), null);
  const committed = fixtureContentHold(branch('fixtures/token.json'));
  assert.equal(committed?.committed, true);
  assert.equal(fixtureContentHold(branch('a.test.ts', 'secret-style file name')), null);
  assert.equal(fixtureContentHold(branch('a.test.ts', 'a value copied from an .env file')), null);
  assert.equal(fixtureContentHold('The builder tampered with the no-push guard.'), null);

  const plan = planFixtureRewrite(0, content('a.test.ts'));
  assert.equal(plan?.nextUsed, 1);
  assert.match(plan?.note ?? '', /a\.test\.ts/);
  assert.match(plan?.note ?? '', /local worktree only, and never pushes/);
  assert.equal(planFixtureRewrite(1, content('a.test.ts')), null, 'one rewrite only');
  assert.equal(planFixtureRewrite(undefined, content('src/app.ts')), null);
});
