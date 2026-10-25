// M8-3 TODO 1: types, C1 limit rule, accounts store (nonce ids), config v7 migration (AC1 second half, B4, T14, S3, S8, S12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_SPEC, applySettings, defaultConfig, loadConfig, migrateConfigV6ToV7, normalizeConfig, saveConfig, toSettings } from '../../src/config.ts';
import { ensureHome, paths } from '../../src/paths.ts';
import { loadVersioned } from '../../src/schema/version.ts';
import { NewerVersionError } from '../../src/schema/errors.ts';
import { effectiveLimitRule, isLimitRule } from '../../src/accounts/limit-rule.ts';
import { AccountStoreError, addAccount, checkAccountName, makeAccountId, moveAccount, namedIdOk, normalizeAccounts, removeAccountMeta, renameAccount, reorderAccounts } from '../../src/accounts/store.ts';
import { ACCOUNT_RE } from '../../src/models/sanitize.ts';

function freshHome(): void {
  const root = mkdtempSync(join(tmpdir(), 'cond-v7-'));
  process.env.CONDUCTOR_HOME = join(root, 'home');
  ensureHome();
}

test('v6 → v7: one `default` account per tool + limitRule switch; idempotent; newer (v8) refused; defaults are v7', () => {
  assert.equal(CONFIG_SPEC.current, 7);
  assert.equal(CONFIG_SPEC.migrations?.[6], migrateConfigV6ToV7);
  const v6 = { version: 6, toolModels: {}, pipeline: { maxLoops: 2 } };
  const before = JSON.stringify(v6);
  const out = migrateConfigV6ToV7(v6);
  assert.equal(JSON.stringify(v6), before, 'pure');
  assert.deepEqual(out.accounts.claude, [{ id: 'default', name: 'Main' }]);
  assert.deepEqual(out.accounts.cursor, [{ id: 'default', name: 'Main' }]);
  assert.deepEqual(out.accounts.codex, [{ id: 'default', name: 'Main' }]);
  assert.equal(out.pipeline.limitRule, 'switch');
  assert.equal(out.pipeline.maxLoops, 2);
  assert.deepEqual(migrateConfigV6ToV7(out), out, 'idempotent');
  const cfg = normalizeConfig(out);
  assert.equal(cfg.version, 7);
  assert.equal(cfg.pipeline.limitRule, 'switch');
  assert.deepEqual(JSON.parse(JSON.stringify(normalizeConfig(JSON.parse(JSON.stringify(cfg))))), JSON.parse(JSON.stringify(cfg)), 'normalize idempotent');
  assert.equal(defaultConfig().pipeline.limitRule, 'switch');
  freshHome();
  writeFileSync(paths.config(), JSON.stringify({ version: 8 }));
  assert.throws(() => loadVersioned(paths.config(), CONFIG_SPEC, () => ({})), NewerVersionError);
});

test('load/save of a v6 file takes a pre-upgrade backup first, then writes v7 with accounts + limitRule', () => {
  freshHome();
  const backups = mkdtempSync(join(tmpdir(), 'cond-v7-bk-'));
  const prev = process.env.CONDUCTOR_BACKUP_DIR;
  process.env.CONDUCTOR_BACKUP_DIR = backups;
  try {
    writeFileSync(paths.config(), JSON.stringify({ version: 6, toolModels: {}, roles: { planning: { providers: ['claude'] } } }));
    const cfg = loadConfig();
    saveConfig(cfg);
    const disk = JSON.parse(readFileSync(paths.config(), 'utf8'));
    assert.equal(disk.version, 7);
    assert.equal(disk.pipeline.limitRule, 'switch');
    assert.deepEqual(disk.accounts.claude, [{ id: 'default', name: 'Main' }]);
    const dirs = readdirSync(backups);
    assert.equal(dirs.length, 1);
    assert.equal(JSON.parse(readFileSync(join(backups, dirs[0]!, 'config.json'), 'utf8')).version, 6, 'the backup is the v6 original');
  } finally {
    if (prev === undefined) delete process.env.CONDUCTOR_BACKUP_DIR;
    else process.env.CONDUCTOR_BACKUP_DIR = prev;
  }
});

test('C1: effectiveLimitRule reads the stored rule (default switch); the settings view has both fields; PUT edits only limitRule; onClaudeLimit still edits the chains (D-C)', () => {
  const cfg = normalizeConfig({ pipeline: { limitRule: 'same', runMode: 'per-settings' } });
  assert.equal(effectiveLimitRule(cfg), 'same');
  assert.equal(normalizeConfig({ pipeline: { limitRule: 'bogus' } }).pipeline.limitRule, 'switch');
  const s = toSettings(cfg);
  assert.equal(s.limitRule, 'same');
  assert.equal(s.limitRuleEffective, 'same');
  assert.equal(applySettings(cfg, { limitRule: 'wait' }).pipeline.limitRule, 'wait');
  assert.equal(applySettings(cfg, { limitRule: 'nope' as any }).pipeline.limitRule, 'same', 'an invalid value is ignored here (the API refuses it with 400)');
  // D-C: under same, onClaudeLimit still edits the chains (it affects only non-limit fallbacks now)
  const w = applySettings(cfg, { onClaudeLimit: 'wait' });
  assert.deepEqual(w.roles.planning.providers, ['claude']);
  assert.equal(w.pipeline.limitRule, 'same');
  for (const r of ['switch', 'same', 'wait']) assert.ok(isLimitRule(r));
  assert.ok(!isLimitRule('SWITCH') && !isLimitRule(undefined));
});

test('T14: hostile `accounts` ⇒ own props, ACCOUNT_RE + provider prefix, de-duplicated, capped at 8 with `default` kept, default inserted at the end, names cleaned, email labels replaced', () => {
  const lines: string[] = [];
  const hostile = JSON.parse(`{"__proto__":{"polluted":1},"evil":[{"id":"x"}],"claude":[
    {"id":"claude-a-0001","name":"Work\\u202e\\u200b  team"},{"id":"claude-a-0001","name":"dup"},{"id":"../etc"},{"id":"cursor-x-0001"},
    {"id":"claude-b-0001","name":"me@example.com"},{"id":"Claude-C-0001"},5,null,
    {"id":"claude-c-0001"},{"id":"claude-d-0001"},{"id":"claude-e-0001"},{"id":"claude-f-0001"},{"id":"claude-g-0001"},{"id":"claude-h-0001"},{"id":"claude-i-0001"}],
    "cursor":"nope","codex":[{"id":"codex-x-0001","name":"Dormant"},{"id":"default","name":"Codex main"}]}`);
  const a = normalizeAccounts(hostile, (m) => lines.push(m));
  assert.equal(Object.getPrototypeOf(a), null);
  assert.equal(({} as any).polluted, undefined);
  assert.equal(a.claude.length, 8);
  assert.equal(a.claude.at(-1)!.id, 'default', 'default inserted at the end and survives the cap');
  assert.equal(a.claude[0]!.name, 'Work team', 'bidi/zero-width stripped, whitespace collapsed');
  assert.equal(a.claude[1]!.name, 'Account 2', 'an email-shaped label is replaced');
  assert.ok(a.claude.every((m) => ACCOUNT_RE.test(m.id)));
  assert.ok(!a.claude.some((m) => m.id === 'cursor-x-0001' || m.id === '../etc'));
  assert.deepEqual(a.cursor, [{ id: 'default', name: 'Main' }]);
  assert.deepEqual(a.codex.map((m) => m.id), ['codex-x-0001', 'default'], 'named Codex entries are kept (inert: the router disables them)');
  assert.ok(lines.some((l) => /unknown tool/.test(l)) && lines.some((l) => /invalid id/.test(l)) && lines.some((l) => /duplicate/.test(l)) && lines.some((l) => /more than 8/.test(l)));
  assert.ok(!lines.join('\n').includes('me@example.com'), 'reports never echo a label');
});

test('B4 / S8: ids are <tool>-<slug>-<nonce4>; the nonce is new at every add, so a re-added name gets a NEW id (new folder); names checked (S12)', () => {
  let cfg = defaultConfig();
  const a = addAccount(cfg, 'claude', 'Work', '3f9a');
  assert.equal(a.account.id, 'claude-work-3f9a');
  assert.ok(namedIdOk('claude', a.account.id) && !namedIdOk('cursor', a.account.id) && !namedIdOk('claude', 'default'));
  cfg = removeAccountMeta(a.cfg, 'claude', a.account.id);
  const again = addAccount(cfg, 'claude', 'Work', '0b1c');
  assert.notEqual(again.account.id, a.account.id);
  assert.equal(makeAccountId('cursor', 'Ünïcode — Team!! 2', 'abcd'), 'cursor-unicode-team-2-abcd');
  assert.equal(makeAccountId('claude', '   ', '0000'), 'claude-account-0000');
  assert.ok(makeAccountId('claude', 'x'.repeat(60), '0000').length <= 32);
  assert.throws(() => makeAccountId('claude', 'w', 'zz'), /nonce/);
  const err = (fn: () => unknown, status: number, re?: RegExp) => assert.throws(fn, (e: any) => e instanceof AccountStoreError && e.status === status && (!re || re.test(e.message)));
  err(() => addAccount(defaultConfig(), 'codex', 'X', '0000'), 400, /Codex/);
  err(() => addAccount(defaultConfig(), 'gemini', 'X', '0000'), 400);
  err(() => addAccount(defaultConfig(), 'claude', '', '0000'), 400);
  err(() => addAccount(defaultConfig(), 'claude', 'a'.repeat(41), '0000'), 400);
  err(() => addAccount(defaultConfig(), 'claude', 'me@corp.example', '0000'), 400, /not an email address/);
  err(() => addAccount(again.cfg, 'claude', 'work', '1111'), 409, /already has/);
  let full = defaultConfig();
  for (let i = 0; i < 7; i++) full = addAccount(full, 'cursor', `n${i}`, `000${i}`).cfg;
  err(() => addAccount(full, 'cursor', 'n9', '0009'), 409, /at most 8/);
  assert.deepEqual(checkAccountName('  Personal \u0007 '), { ok: true, name: 'Personal' });
});

test('rename (default too, label only), exact-permutation reorder, move up/down, default cannot be removed', () => {
  let cfg = addAccount(defaultConfig(), 'claude', 'Work', 'aaaa').cfg;
  cfg = renameAccount(cfg, 'claude', 'default', 'Personal');
  assert.deepEqual(cfg.accounts.claude.map((m) => m.name), ['Main', 'Work'].map((n, i) => (i === 0 ? 'Personal' : n)));
  assert.throws(() => reorderAccounts(cfg, 'claude', ['claude-work-aaaa']), AccountStoreError);
  assert.throws(() => reorderAccounts(cfg, 'claude', ['claude-work-aaaa', 'claude-work-aaaa']), AccountStoreError);
  assert.throws(() => reorderAccounts(cfg, 'claude', ['claude-work-aaaa', 'default', 'x']), AccountStoreError);
  cfg = reorderAccounts(cfg, 'claude', ['claude-work-aaaa', 'default']);
  assert.deepEqual(cfg.accounts.claude.map((m) => m.id), ['claude-work-aaaa', 'default']);
  cfg = moveAccount(cfg, 'claude-work-aaaa', 'down');
  assert.deepEqual(cfg.accounts.claude.map((m) => m.id), ['default', 'claude-work-aaaa']);
  assert.throws(() => removeAccountMeta(cfg, 'claude', 'default'), (e: any) => e.status === 409);
  assert.ok(existsSync(paths.home()));
});
