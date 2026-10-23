import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exemptPaths } from '../src/pipeline/envelope.ts';

const plan = { filesToChange: [{ path: '.github/workflows/ci.yml' }, { path: 'src/a.ts' }] };

test('protected-file exemption applies only to an individual human approval', () => {
  assert.deepEqual(exemptPaths({ approvedBy: 'human' }, plan), ['.github/workflows/ci.yml', 'src/a.ts']);
  assert.deepEqual(exemptPaths({ approvedBy: 'human', approvedBulk: true }, plan), []);
  assert.deepEqual(exemptPaths({ approvedBy: 'auto' }, plan), []);
  assert.deepEqual(exemptPaths({}, plan), []);
});
