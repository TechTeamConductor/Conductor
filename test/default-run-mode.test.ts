// Addendum C: Complete auto is the DEFAULT for a brand-new config; an existing file is never silently flipped;
// the default never records the push consent (nothing is pushed until the one-time confirm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadConfig, normalizeConfig, saveConfig, toSettings } from '../src/config.ts';
import { effectiveShip, pushConsentGiven } from '../src/policy/policy.ts';
import { ensureHome, paths } from '../src/paths.ts';

const ROOT = join(import.meta.dirname, '..');

function withHome<T>(file: string | null, fn: () => T): T {
  const prev = process.env.CONDUCTOR_HOME;
  const home = mkdtempSync(join(tmpdir(), 'cond-defrm-'));
  process.env.CONDUCTOR_HOME = home;
  try {
    ensureHome();
    if (file !== null) writeFileSync(paths.config(), file);
    return fn();
  } finally {
    process.env.CONDUCTOR_HOME = prev;
  }
}

test('a fresh config is Complete auto, with no push consent: it does not push and asks for the one-time confirm', () => {
  const c = withHome(null, () => loadConfig());
  assert.equal(c.pipeline.runMode, 'complete-auto');
  assert.equal(defaultConfig().pipeline.runMode, 'complete-auto');
  assert.equal('completeAutoPushAck' in defaultConfig().pipeline, false);
  assert.equal(c.pipeline.completeAutoPushAck, undefined);
  assert.equal('completeAutoPushAck' in c.pipeline, false);
  assert.equal(pushConsentGiven(c), false);
  assert.equal(effectiveShip(c), false);
  const s = toSettings(c);
  assert.equal(s.pushEffective, false);
  assert.equal(s.pushConsentNeeded, true);
  assert.equal(normalizeConfig({}).pipeline.runMode, 'complete-auto');
  assert.equal('completeAutoPushAck' in normalizeConfig({}).pipeline, false);
});

test('an existing config file with no runMode stays Per settings (never silently flipped), also after a save', () => {
  for (const raw of [JSON.stringify({ version: 7, pipeline: { maxParallel: 2 } }), JSON.stringify({ version: 7 }), JSON.stringify({ version: 6, pipeline: {} })]) {
    withHome(raw, () => {
      const c = loadConfig();
      assert.equal(c.pipeline.runMode, 'per-settings', raw);
      assert.equal(pushConsentGiven(c), false);
      saveConfig(c);
      assert.equal(JSON.parse(readFileSync(paths.config(), 'utf8')).pipeline.runMode, 'per-settings', 'persisted');
      assert.equal(loadConfig().pipeline.runMode, 'per-settings');
    });
  }
});

test('an unreadable existing config starts on Per settings; a stored value is preserved; an invalid value falls to Per settings', () => {
  withHome('{not json', () => assert.equal(loadConfig().pipeline.runMode, 'per-settings'));
  withHome(JSON.stringify({ version: 7, pipeline: { runMode: 'per-settings' } }), () => assert.equal(loadConfig().pipeline.runMode, 'per-settings'));
  withHome(JSON.stringify({ version: 7, pipeline: { runMode: 'complete-auto' } }), () => assert.equal(loadConfig().pipeline.runMode, 'complete-auto'));
  for (const bad of ['Complete-Auto', ' complete-auto', '', null, 5, true, {}, []]) {
    assert.equal(normalizeConfig({ pipeline: { runMode: bad } }).pipeline.runMode, 'per-settings', JSON.stringify(bad));
  }
});

test('the default is never the one that records the push consent: no write path in config/migrate/demo/runtime sets it', () => {
  for (const f of ['src/config.ts', 'src/migrate.ts', 'src/demo.ts', 'src/runtime.ts', 'src/desktop-sidecar.ts', 'src/schema/backup.ts']) {
    const t = readFileSync(join(ROOT, f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(t, /completeAutoPushAck\s*(\?\?)?=(?!=)/, f);
  }
});

test('the v1 importer still forces Per settings over the new default', () => {
  const t = readFileSync(join(ROOT, 'src/migrate.ts'), 'utf8');
  assert.match(t, /cfg\.pipeline\.runMode = 'per-settings'/);
  assert.match(t, /delete cfg\.pipeline\.completeAutoPushAck/);
});

test('test, demo and ephemeral homes pin the mode explicitly', () => {
  for (const f of ['test/helpers/harness.ts', 'src/demo.ts', 'src/runtime.ts']) assert.match(readFileSync(join(ROOT, f), 'utf8'), /runMode: 'per-settings'/, f);
});

test('text: the confirm, the banner and the docs say Complete auto is the default and how to switch; no "safe" or "opt-in" wording', () => {
  const api = readFileSync(join(ROOT, 'src/server/api.ts'), 'utf8');
  for (const t of [api, readFileSync(join(ROOT, 'ui/modes.js'), 'utf8')]) {
    assert.match(t, /Complete auto is the default for new installs; you can switch to Per settings at any time\./);
    assert.match(t, /one-time push consent/);
  }
  assert.match(readFileSync(join(ROOT, 'ui/app.js'), 'utf8'), /Complete auto is on by default[^']*Nothing is pushed until you confirm once[^']*Per settings/);
  for (const f of ['README.md', 'docs/GUIDE.md', 'docs/ARCHITECTURE.md', 'docs/API.md', 'docs/TROUBLESHOOTING.md', 'AGENTS.md', 'CLAUDE.md']) {
    const t = readFileSync(join(ROOT, f), 'utf8');
    assert.match(t, /Complete auto is (on )?(the )?default|on by default/i, f);
    assert.doesNotMatch(t, /Complete auto[^.\n]{0,40}\b(opt-in|safe)\b|\b(opt-in|safe)\b[^.\n]{0,40}Complete auto/i, f);
  }
});
