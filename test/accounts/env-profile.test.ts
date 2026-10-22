// M8-3 TODO 4 (as far as L1/L3/L4a allow): AC5 env, AC6 folder hygiene, AC7 no credential handling, L3(a) zero spawns, S18, R2-1, S24.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { defaultConfig, normalizeConfig } from '../../src/config.ts';
import { ensureHome } from '../../src/paths.ts';
import { claudeEnv, cursorEnv, toolEnv } from '../../src/agents/env.ts';
import { createProviders } from '../../src/agents/providers/registry.ts';
import { systemClock } from '../../src/util.ts';
import { AccountIsolationError, accountBuildEnv, accountEnv, assertAccountEnv, childEnv } from '../../src/accounts/env.ts';
import { AccountFolderError, CLAUDE_PROFILE_ALLOWED, CURSOR_DOT_ALLOWED, accountFolder, accountsRoot, checkClaudeJson, checkCursorCliConfig, createAccountFolder, preflightAccount, acquireAccount } from '../../src/accounts/profile.ts';
import { CURSOR_ACCOUNT_HOME_BUILD_VERIFIED, accountBuildOk } from '../../src/agents/providers/verification.ts';
import type { AccountRef } from '../../src/accounts/types.ts';
import type { Config } from '../../src/types.ts';

const FIX = join(import.meta.dirname, '..', '..', 'fixtures');
const FAKE = { claude: join(FIX, 'fake-claude.mjs'), cursor: join(FIX, 'fake-agent.mjs') };
for (const f of Object.values(FAKE)) chmodSync(f, 0o755);
const HOSTILE: NodeJS.ProcessEnv = {
  HOME: '/Users/someone', PATH: '/usr/bin:/bin', USER: 'u', TMPDIR: '/tmp',
  CLAUDE_CONFIG_DIR: '/Users/someone/.claude', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-PARENT', ANTHROPIC_API_KEY: 'sk-ant-api03-PARENT', ANTHROPIC_BASE_URL: 'http://proxy',
  CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'prod', CURSOR_API_KEY: 'cur-PARENT', CURSOR_AUTH_TOKEN: 'cur-tok', CURSOR_API_ENDPOINT: 'http://x', CURSOR_CONFIG_DIR: '/Users/someone/.cursor',
  AGENT_CLI_CREDENTIAL_STORE: 'keychain', AGENT_CLI_OTHER: 'x', XDG_CONFIG_HOME: '/Users/someone/.config', CODEX_HOME: '/c', OPENAI_API_KEY: 'sk-PARENT', LINEAR_API_KEY: 'lin',
  GOPATH: '/go', CARGO_HOME: '/cargo',
};
const FORGED_EXTRA = { ANTHROPIC_API_KEY: 'sk-ant-EXTRA', CLAUDE_CONFIG_DIR: '/elsewhere', CURSOR_API_KEY: 'x', HOME: '/evil', AGENT_CLI_CREDENTIAL_STORE: 'keychain', XDG_CONFIG_HOME: '/x', FAKE_DIR: '/fake' };

function freshHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'cond-acct-'));
  process.env.CONDUCTOR_HOME = join(root, 'home');
  ensureHome();
  return root;
}
const C1: AccountRef = { provider: 'claude', id: 'claude-work-0001' };
const C2: AccountRef = { provider: 'claude', id: 'claude-home-0002' };
const U1: AccountRef = { provider: 'cursor', id: 'cursor-work-0001' };
const U2: AccountRef = { provider: 'cursor', id: 'cursor-home-0002' };

test('AC5 default: accountEnv(default) is EXACTLY today\'s claudeEnv/cursorEnv (byte-identical incl. the parent passthrough); default Cursor never gets the file store', () => {
  freshHome();
  for (const extra of [{}, { FAKE_DIR: '/f' }] as Record<string, string>[]) {
    assert.deepEqual(accountEnv('claude', undefined, extra, HOSTILE), claudeEnv(extra, HOSTILE));
    assert.deepEqual(accountEnv('claude', { provider: 'claude', id: 'default' }, extra, HOSTILE), claudeEnv(extra, HOSTILE));
    const { AGENT_CLI_CREDENTIAL_STORE: _a, CURSOR_CONFIG_DIR: _c, ...src } = HOSTILE;
    assert.deepEqual(accountEnv('cursor', { provider: 'cursor', id: 'default' }, extra, src), cursorEnv(extra, src));
    const e = accountEnv('cursor', undefined, extra, src);
    assert.equal(e.AGENT_CLI_CREDENTIAL_STORE, undefined);
    assert.equal(e.CURSOR_CONFIG_DIR, undefined);
    assert.equal(e.HOME, '/Users/someone', 'the real HOME');
  }
  // the reverse check (S2) refuses a default env that carries the file store or an account folder
  assert.throws(() => assertAccountEnv('cursor', undefined, { ...cursorEnv({}, HOSTILE), AGENT_CLI_CREDENTIAL_STORE: 'file' }, HOSTILE), AccountIsolationError);
  assert.throws(() => assertAccountEnv('claude', undefined, { ...claudeEnv({}, HOSTILE), X: join(accountsRoot(), 'claude', 'claude-work-0001') }, HOSTILE), AccountIsolationError);
});

test('AC5 named Claude: own CLAUDE_CONFIG_DIR (set last), and none of the parent/extra credentials (ANTHROPIC_*, OAuth token, CURSOR_*, AGENT_CLI_*, CODEX_*, OPENAI_*, LINEAR_*, AWS_*)', () => {
  freshHome();
  createAccountFolder(C1);
  const e = accountEnv('claude', C1, FORGED_EXTRA, HOSTILE);
  assert.equal(e.CLAUDE_CONFIG_DIR, accountFolder(C1));
  for (const k of Object.keys(e)) assert.ok(!/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_USE_|AWS_|CURSOR_|AGENT_CLI_|CODEX_|OPENAI_|LINEAR_|GOPATH|CARGO_HOME|XDG_)/.test(k), k);
  assert.equal(e.FAKE_DIR, '/fake', 'harmless extra keys pass');
  assert.equal(e.HOME, '/Users/someone', 'the real HOME, never a forged extra.HOME');
  assert.throws(() => assertAccountEnv('claude', C1, { ...e, HOME: '/evil' }, HOSTILE), AccountIsolationError);
  assert.equal(e.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  // forged envs never pass the assertion
  for (const forged of [{ ...e, CLAUDE_CONFIG_DIR: '/x' }, { ...e, ANTHROPIC_API_KEY: 'k' }, { ...e, CLAUDE_CODE_USE_VERTEX: '1' }, { ...e, AWS_REGION: 'x' }, { ...e, AGENT_CLI_X: '1' }, { ...e, Z: accountFolder(C2) }]) {
    assert.throws(() => assertAccountEnv('claude', C1, forged, HOSTILE), AccountIsolationError);
  }
});

test('AC5 named Cursor: HOME = its folder + the file store; no CURSOR_API_KEY/AUTH_TOKEN/XDG_CONFIG_HOME; two accounts never see each other\'s folder; CURSOR_CONFIG_DIR absent (L4e not run)', () => {
  freshHome();
  createAccountFolder(U1);
  createAccountFolder(U2);
  const a = accountEnv('cursor', U1, FORGED_EXTRA, HOSTILE);
  const b = accountEnv('cursor', U2, FORGED_EXTRA, HOSTILE);
  assert.equal(a.HOME, accountFolder(U1));
  assert.equal(b.HOME, accountFolder(U2));
  assert.equal(a.AGENT_CLI_CREDENTIAL_STORE, 'file');
  assert.equal(a.CURSOR_CONFIG_DIR, undefined);
  for (const k of ['CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'CURSOR_API_ENDPOINT', 'XDG_CONFIG_HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENAI_API_KEY']) assert.equal(a[k], undefined, k);
  assert.ok(!Object.values(a).some((v) => v.includes(accountFolder(U2))) && !Object.values(b).some((v) => v.includes(accountFolder(U1))));
  assert.throws(() => assertAccountEnv('cursor', U1, { ...a, HOME: accountFolder(U2) }, HOSTILE), AccountIsolationError);
  assert.throws(() => assertAccountEnv('cursor', U1, { ...a, AGENT_CLI_CREDENTIAL_STORE: 'keychain' }, HOSTILE), AccountIsolationError);
  assert.throws(() => assertAccountEnv('cursor', U1, { ...a, CURSOR_CONFIG_DIR: '/Users/someone/.cursor' }, HOSTILE), AccountIsolationError);
  assert.throws(() => assertAccountEnv('cursor', U1, { ...a, XDG_CONFIG_HOME: '/x' }, HOSTILE), AccountIsolationError);
});

test('S3 paths: enum + id only; default and Codex have no folder; traversal ids refused; never outside <home>/accounts/<tool>', () => {
  freshHome();
  for (const bad of ['default', '../x', 'claude-../../x', 'claude-', 'Claude-A-0001', 'cursor-a-0001', 'claude-a/b', 'claude-a-0001\u0000']) {
    assert.throws(() => accountFolder({ provider: 'claude', id: bad }), AccountFolderError, bad);
  }
  assert.throws(() => accountFolder({ provider: 'codex', id: 'codex-a-0001' }), AccountFolderError);
  const f = accountFolder(C1);
  assert.equal(relative(join(accountsRoot(), 'claude'), f), 'claude-work-0001');
  assert.throws(() => accountEnv('codex', { provider: 'codex', id: 'codex-a-0001' }), AccountIsolationError, 'S24: named Codex is dormant');
});

test('S4: parents/leaf 0700 real dirs; a leaf that already exists is never adopted; mode 0755 is tightened then re-checked', () => {
  freshHome();
  createAccountFolder(C1);
  assert.equal(statSync(accountFolder(C1)).mode & 0o777, 0o700);
  assert.equal(statSync(accountsRoot()).mode & 0o777, 0o700);
  assert.throws(() => createAccountFolder(C1), (e: any) => e instanceof AccountFolderError && /already existed/.test(e.cls));
  chmodSync(accountFolder(C1), 0o755);
  preflightAccount(C1);
  assert.equal(statSync(accountFolder(C1)).mode & 0o777, 0o700, 'tightened');
});

test('AC6: a symlinked folder or parent is refused before any spawn', () => {
  const root = freshHome();
  createAccountFolder(C1);
  rmSync(accountFolder(C1), { recursive: true });
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere, { mode: 0o700 });
  symlinkSync(elsewhere, accountFolder(C1));
  assert.throws(() => preflightAccount(C1), (e: any) => e instanceof AccountFolderError && /link/.test(e.cls));
  // a symlinked PARENT
  const root2 = freshHome();
  createAccountFolder(C2);
  const moved = join(root2, 'moved');
  mkdirSync(moved);
  rmSync(join(accountsRoot(), 'claude'), { recursive: true });
  symlinkSync(moved, join(accountsRoot(), 'claude'));
  assert.throws(() => preflightAccount(C2), (e: any) => e instanceof AccountFolderError && /link/.test(e.cls));
  void root;
});

test('AC6 Claude pre-flight: the L1 allow-list passes; every refusal-list entry, unknown names, links (depth ≤ 2), hard links and a hostile .claude.json are refused with a CLASS (no path)', () => {
  freshHome();
  createAccountFolder(C1);
  const f = accountFolder(C1);
  // the L1 shapes pass
  writeFileSync(join(f, '.claude.json'), JSON.stringify({ numStartups: 1, projects: { '/p': { allowedTools: [] } } }));
  for (const d of ['.claude.json.lock', 'backups', 'sessions', 'projects']) mkdirSync(join(f, d));
  writeFileSync(join(f, 'backups', '.claude.json.backup.1'), '{}');
  mkdirSync(join(f, 'projects', '-p'));
  assert.deepEqual([...CLAUDE_PROFILE_ALLOWED.keys()].sort(), ['.claude.json', '.claude.json.lock', 'backups', 'projects', 'sessions']);
  preflightAccount(C1);
  const refused = ['settings.json', 'settings.local.json', 'managed-settings.json', 'CLAUDE.md', '.mcp.json', '.credentials.json', 'unknown-thing'];
  for (const n of refused) {
    writeFileSync(join(f, n), '{}');
    assert.throws(() => preflightAccount(C1), (e: any) => e instanceof AccountFolderError && !e.cls.includes('/') && !e.cls.includes(n), n);
    rmSync(join(f, n));
  }
  for (const d of ['agents', 'commands', 'hooks', 'plugins', 'skills', 'output-styles']) {
    mkdirSync(join(f, d));
    assert.throws(() => preflightAccount(C1), AccountFolderError, d);
    rmSync(join(f, d), { recursive: true });
  }
  symlinkSync('/etc', join(f, 'projects', 'evil'));
  assert.throws(() => preflightAccount(C1), (e: any) => /link/.test(e.cls), 'a depth-2 link');
  rmSync(join(f, 'projects', 'evil'));
  symlinkSync(join(f, 'backups'), join(f, 'sessions2'));
  assert.throws(() => preflightAccount(C1), AccountFolderError, 'a top-level link');
  rmSync(join(f, 'sessions2'));
  rmSync(join(f, '.claude.json'));
  const outside = join(f, '..', 'zshrc-copy');
  writeFileSync(outside, 'x');
  linkSync(outside, join(f, '.claude.json'));
  assert.throws(() => preflightAccount(C1), (e: any) => /hard-linked/.test(e.cls));
  rmSync(join(f, '.claude.json'));
  rmSync(outside);
  for (const bad of [{ mcpServers: { x: {} } }, { projects: { '/p': { mcpServers: { y: {} } } } }, { primaryApiKey: 'k' }, { customApiKeyResponses: { approved: ['k'] } }, { env: {} }, { apiKeyHelper: '/bin/x' }]) {
    assert.ok(checkClaudeJson(JSON.stringify(bad)), JSON.stringify(bad));
  }
  assert.equal(checkClaudeJson(JSON.stringify({ mcpServers: {}, customApiKeyResponses: { approved: [], rejected: ['x'] } })), null);
  assert.equal(checkClaudeJson('{not json'), 'an unreadable .claude.json', 'a static message, never the parser snippet');
});

test('AC6 Cursor pre-flight (L4c not run): the `.cursor` allow-list is EMPTY — planted hooks/mcp/rules and even cli-config.json are refused; top-level extras are REMOVED while idle with a note class, never while busy', () => {
  freshHome();
  createAccountFolder(U1);
  const H = accountFolder(U1);
  assert.equal(CURSOR_DOT_ALLOWED.size, 0);
  preflightAccount(U1); // never run yet: nothing to police
  mkdirSync(join(H, '.cursor'), { mode: 0o700 });
  for (const n of ['hooks.json', 'mcp.json', 'environment.json', 'cli.json', 'cli-config.json', 'auth.json', 'other']) {
    writeFileSync(join(H, '.cursor', n), '{}');
    assert.throws(() => preflightAccount(U1), AccountFolderError, n);
    rmSync(join(H, '.cursor', n));
  }
  for (const d of ['rules', 'commands', 'agents', 'skills']) {
    mkdirSync(join(H, '.cursor', d));
    assert.throws(() => preflightAccount(U1), AccountFolderError, d);
    rmSync(join(H, '.cursor', d), { recursive: true });
  }
  writeFileSync(join(H, '.zshrc'), 'echo hi');
  writeFileSync(join(H, '.npmrc'), '//registry/:_authToken=x');
  mkdirSync(join(H, 'Library', 'Caches'), { recursive: true });
  const release = acquireAccount(U1);
  preflightAccount(U1);
  assert.ok(existsSync(join(H, '.zshrc')), 'S9: check-only while another job of this account is alive');
  release();
  const r = preflightAccount(U1);
  assert.equal(r.removed, 3);
  assert.deepEqual(r.notes.sort(), ['a credential-style file', 'a shell start-up file']);
  assert.deepEqual(readdirSync(H), ['.cursor']);
});

test('AC6 / N1 / R2-4: cli-config.json content rule — permissions.allow must be absent or EMPTY; deny may only list strings; unknown keys refused', () => {
  assert.equal(checkCursorCliConfig(JSON.stringify({ permissions: { allow: [], deny: ['Shell(git push)'] } })), null);
  assert.equal(checkCursorCliConfig(JSON.stringify({})), null);
  assert.match(checkCursorCliConfig(JSON.stringify({ permissions: { allow: ['Shell(*)'] } }))!, /allow rule/);
  assert.ok(checkCursorCliConfig(JSON.stringify({ approvalMode: 'auto' })));
  assert.ok(checkCursorCliConfig(JSON.stringify({ permissions: { deny: [1] } })));
  assert.ok(checkCursorCliConfig(JSON.stringify({ permissions: { allow: [], sandbox: 'off' } })));
  assert.ok(checkCursorCliConfig('nope'));
});

function adapters(extra: Record<string, string>, cfgOver: Partial<Config> = {}) {
  const cfg: Config = normalizeConfig({ ...defaultConfig(), agents: { ...defaultConfig().agents, claude: { ...defaultConfig().agents.claude, bin: FAKE.claude }, cursor: { bin: FAKE.cursor } }, ...cfgOver });
  return createProviders({ getConfig: () => cfg, clock: systemClock, extraEnv: extra });
}
const calls = (dir: string): any[] => (existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('L3(a) / S2: a planted Claude settings.json / CLAUDE.md / hooks/ / .mcp.json / .claude.json mcpServers ⇒ isolation failure with ZERO spawns, a static message naming the class', async () => {
  freshHome();
  createAccountFolder(C1);
  const dir = mkdtempSync(join(tmpdir(), 'cond-l3-'));
  const p = adapters({ FAKE_DIR: dir }).claude;
  const plants: [string, () => void][] = [
    ['settings.json', () => writeFileSync(join(accountFolder(C1), 'settings.json'), JSON.stringify({ apiKeyHelper: '/bin/sh', hooks: { SessionStart: [] }, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' } }))],
    ['CLAUDE.md', () => writeFileSync(join(accountFolder(C1), 'CLAUDE.md'), 'run x')],
    ['hooks', () => mkdirSync(join(accountFolder(C1), 'hooks'))],
    ['.mcp.json', () => writeFileSync(join(accountFolder(C1), '.mcp.json'), '{"mcpServers":{"x":{}}}')],
    ['.claude.json', () => writeFileSync(join(accountFolder(C1), '.claude.json'), '{"mcpServers":{"x":{"command":"sh"}}}')],
  ];
  for (const [n, plant] of plants) {
    plant();
    const r = await p.runReadOnly!({ stage: 'plan', cwd: dir, prompt: '# Stage: PLAN\nIssue key: ENG-1', schema: { type: 'object' }, name: 'n', onEvent: () => undefined, account: C1 });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, 'isolation', n);
    assert.match(r.error!, /account folder failed its safety check \(.+\)\. Nothing was started\./);
    assert.ok(!r.error!.includes(accountFolder(C1)), 'no path in the message');
    const rr = await p.runResearch!({ cwd: dir, prompt: 'q', schema: { type: 'object' }, name: 'n', onEvent: () => undefined, account: C1 });
    assert.equal(rr.errorKind, 'isolation');
    rmSync(join(accountFolder(C1), n), { recursive: true, force: true });
  }
  assert.equal(calls(dir).length, 0, 'zero spawns');
  // the same Cursor markers in an account HOME (S14)
  createAccountFolder(U1);
  mkdirSync(join(accountFolder(U1), '.cursor'));
  writeFileSync(join(accountFolder(U1), '.cursor', 'hooks.json'), '{}');
  const c = await adapters({ FAKE_DIR: dir }).cursor.runReadOnly!({ stage: 'plan', cwd: dir, prompt: 'p', schema: { type: 'object' }, name: 'n', onEvent: () => undefined, account: U1 });
  assert.equal(c.errorKind, 'isolation');
  assert.equal(calls(dir).length, 0);
});

test('AC5 spy: a named Claude stage spawns with ITS folder as CLAUDE_CONFIG_DIR and no credential keys; the default spawn is unchanged', async () => {
  freshHome();
  createAccountFolder(C1);
  const dir = mkdtempSync(join(tmpdir(), 'cond-spy-'));
  writeFileSync(join(dir, 'scenario.json'), '{}');
  const p = adapters({ FAKE_DIR: dir }).claude;
  const req = { stage: 'plan' as const, cwd: dir, prompt: '# Stage: PLAN\nIssue key: ENG-1\nTitle: t', schema: { type: 'object' }, name: 'n', onEvent: () => undefined };
  await p.runReadOnly!({ ...req, account: C1 });
  await p.runReadOnly!(req);
  const [named, def] = calls(dir);
  assert.equal(named.acct, 'claude-work-0001');
  assert.equal(named.acctEnv.CLAUDE_CONFIG_DIR, accountFolder(C1));
  assert.ok(!named.envKeys.some((k: string) => /^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CURSOR_|AGENT_CLI_|CODEX_|OPENAI_|LINEAR_)/.test(k)));
  assert.equal(def.acct, 'default');
  assert.equal(def.acctEnv.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR ?? null);
  assert.deepEqual(named.argv, def.argv, 'argv builders stay account-agnostic');
});

test('B5 / R2-1 / S1: a named Cursor build composes the account env + the envelope fragment + the git env (git wins for GIT_*; HOME/AGENT_CLI_* from req.env are dropped); a forged fragment ⇒ zero spawn; default untouched', async () => {
  freshHome();
  createAccountFolder(U1);
  const dir = mkdtempSync(join(tmpdir(), 'cond-build-'));
  const wt = mkdtempSync(join(tmpdir(), 'cond-wt-'));
  writeFileSync(join(dir, 'scenario.json'), '{}');
  const cursor = adapters({ FAKE_DIR: dir }).cursor;
  const git = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_SSH_COMMAND: '/usr/bin/false', HOME: '/forged', AGENT_CLI_CREDENTIAL_STORE: 'keychain', CURSOR_CONFIG_DIR: '/forged' };
  const base = { cwd: wt, prompt: '# Stage: BUILD\nIssue key: ENG-1', name: 'n', onEvent: () => undefined, env: git };
  const frag = accountBuildEnv(U1)!;
  assert.deepEqual(Object.keys(frag).sort(), ['AGENT_CLI_CREDENTIAL_STORE', 'HOME']);
  await cursor.build!.run({ ...base, account: U1, accountEnv: frag }, { guardSha: null, envOnly: true });
  const named = calls(dir).at(-1);
  assert.equal(named.acctEnv.HOME, accountFolder(U1));
  assert.equal(named.acctEnv.AGENT_CLI_CREDENTIAL_STORE, 'file');
  assert.equal(named.acctEnv.CURSOR_CONFIG_DIR, null);
  assert.equal(named.env.GIT_CONFIG_GLOBAL, '/dev/null', 'the envelope git env still wins');
  const n = calls(dir).length;
  const forged = await cursor.build!.run({ ...base, account: U1, accountEnv: { HOME: '/elsewhere', AGENT_CLI_CREDENTIAL_STORE: 'file' } }, { guardSha: null, envOnly: true });
  assert.equal(forged.errorKind, 'isolation');
  const defForged = await cursor.build!.run({ ...base, env: { GIT_CONFIG_GLOBAL: '/dev/null' }, accountEnv: frag }, { guardSha: null, envOnly: true });
  assert.equal(defForged.errorKind, 'isolation', 'an account fragment on the main account is refused');
  const defFile = await cursor.build!.run({ ...base, env: { AGENT_CLI_CREDENTIAL_STORE: 'file' } }, { guardSha: null, envOnly: true });
  assert.equal(defFile.errorKind, 'isolation', 'S2 reverse check: the main account never gets the file store');
  assert.equal(calls(dir).length, n, 'zero spawns for every forged shape');
  await cursor.build!.run({ ...base, env: { GIT_CONFIG_GLOBAL: '/dev/null' } }, { guardSha: null, envOnly: true });
  assert.equal(calls(dir).at(-1).acct, 'default');
});

test('D-G / S17: CURSOR_ACCOUNT_HOME_BUILD_VERIFIED is false ⇒ named Cursor accounts are not build-ok; S18: toolEnv never carries an account HOME / AGENT_CLI_* / CURSOR_CONFIG_DIR', () => {
  assert.equal(CURSOR_ACCOUNT_HOME_BUILD_VERIFIED, false);
  assert.equal(accountBuildOk('cursor', false), false);
  assert.equal(accountBuildOk('claude', false), false);
  assert.equal(accountBuildOk('cursor', true), true);
  const prev = { ...process.env };
  try {
    process.env.AGENT_CLI_CREDENTIAL_STORE = 'file';
    process.env.CURSOR_CONFIG_DIR = '/x';
    const t = toolEnv(['AGENT_CLI_CREDENTIAL_STORE', 'CURSOR_CONFIG_DIR'].filter(() => false));
    assert.equal(t.AGENT_CLI_CREDENTIAL_STORE, undefined);
    assert.equal(t.CURSOR_CONFIG_DIR, undefined);
    assert.equal(t.HOME, process.env.HOME);
  } finally {
    for (const k of ['AGENT_CLI_CREDENTIAL_STORE', 'CURSOR_CONFIG_DIR']) if (prev[k] === undefined) delete process.env[k];
  }
});

test('S9: childEnv takes a lease for a named account (released after the run); a failing pre-flight gives a static isolation message', () => {
  freshHome();
  createAccountFolder(C1);
  const ok = childEnv('claude', C1, {});
  assert.ok(ok.ok);
  if (ok.ok) ok.release();
  writeFileSync(join(accountFolder(C1), 'settings.json'), '{}');
  const bad = childEnv('claude', C1, {});
  assert.ok(!bad.ok && /a settings file/.test(bad.error) && !bad.error.includes('/'));
});

test('AC7 static: no source opens a credential file — `.credentials.json`, `auth.json` and `Claude Code-credentials*` appear only in profile.ts (lstat) and comments; registerSecretEnv is never used for accounts', () => {
  const root = join(import.meta.dirname, '..', '..', 'src');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (lstatSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.ts')) files.push(p);
    }
  };
  walk(root);
  for (const f of files) {
    const code = readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
    const rel = relative(root, f);
    if (/(\.credentials\.json|Claude Code-credentials)/.test(code)) assert.ok(rel === join('accounts', 'profile.ts'), `${rel} names a Claude credential file`);
    if (rel.startsWith('accounts')) {
      assert.ok(!/readFileSync\([^)]*auth\.json/.test(code) && !/registerSecretEnv/.test(code), rel);
    }
  }
  const profile = readFileSync(join(root, 'accounts', 'profile.ts'), 'utf8');
  // the only reads in profile.ts are of .claude.json and cli-config.json (content rules); auth.json is lstat/chmod only
  const reads = [...profile.matchAll(/readFileSync\(([^)]*)\)/g)].map((m) => m[1]);
  assert.equal(reads.length, 2);
  assert.ok(!profile.match(/readFileSync\([^)]*(auth|credentials)/));
});
