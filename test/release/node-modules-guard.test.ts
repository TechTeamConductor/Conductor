// Node cannot type-strip TypeScript under node_modules, so a copy of the CLI there must stop with a clear message, not a cryptic error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = join(import.meta.dirname, '..', '..', 'bin', 'conductor.mjs');

test('bin/conductor.mjs refuses to run from inside node_modules and points to the installer', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'nm-guard-')), 'lib', 'node_modules', 'conductor', 'bin');
  mkdirSync(dir, { recursive: true });
  copyFileSync(BIN, join(dir, 'conductor.mjs'));
  const r = spawnSync(process.execPath, [join(dir, 'conductor.mjs'), 'version'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /node_modules/);
  assert.match(r.stderr, /install\.sh/);
  assert.match(r.stderr, /install\.ps1/);
});

test('outside node_modules the guard stays out of the way (the Node version check still comes first)', () => {
  const r = spawnSync(process.execPath, [BIN, 'version'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});
