// `conductor version` must report the packaged release version, never a hard-coded or invented one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEV_VERSION, readVersion, VERSION } from '../../src/version.ts';

const pkg = (content: string): string => {
  const f = join(mkdtempSync(join(tmpdir(), 'version-')), 'package.json');
  writeFileSync(f, content);
  return f;
};

test('readVersion returns a valid X.Y.Z or pre-release version from package.json', () => {
  assert.equal(readVersion(pkg('{"version":"1.2.3"}')), '1.2.3');
  assert.equal(readVersion(pkg('{"version":"0.0.0-dev"}')), '0.0.0-dev');
  assert.equal(readVersion(pkg('{"version":"10.20.30-rc.1"}')), '10.20.30-rc.1');
});

test('readVersion falls back to the dev placeholder for a missing, unreadable, malformed or hostile version', () => {
  assert.equal(readVersion(join(tmpdir(), 'no-such-dir-xyz', 'package.json')), DEV_VERSION);
  assert.equal(readVersion(pkg('not json')), DEV_VERSION);
  assert.equal(readVersion(pkg('{}')), DEV_VERSION);
  assert.equal(readVersion(pkg('{"version":42}')), DEV_VERSION);
  for (const bad of ['1.2', 'v1.2.3', '1.2.3\n', '1.2.3; rm -rf /', '', ' 1.2.3', '1.2.3-', '01.2.3 ']) assert.equal(readVersion(pkg(JSON.stringify({ version: bad }))), DEV_VERSION, JSON.stringify(bad));
});

test('VERSION is the version of this checkout\'s package.json', async () => {
  const { readFileSync } = await import('node:fs');
  const real = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')).version;
  assert.equal(VERSION, real);
});
