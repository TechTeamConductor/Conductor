// M8-3 AC7 / AC8 / AC9 / N6 / S11 / S12 / S13 / S22 + the M8-4 N1 persist-then-swap rule for account writers.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDemo, type DemoHandle } from '../../src/demo.ts';
import { paths, ensureHome } from '../../src/paths.ts';
import { defaultConfig, normalizeConfig } from '../../src/config.ts';
import { configureLog } from '../../src/log.ts';
import { createRuntime } from '../../src/runtime.ts';
import { runProcess } from '../../src/agents/spawn.ts';
import { ModelService } from '../../src/models/service.ts';
import { AccountService, LOGIN_DISABLED_MESSAGE, SIGNIN_COMMAND_RE } from '../../src/accounts/service.ts';
import { accountsCli, socketClient } from '../../src/accounts/cli.ts';
import { accountFolder, createAccountFolder } from '../../src/accounts/profile.ts';
import { CONTROL_BODY_MAX, controlDirOk } from '../../src/server/http.ts';
import type { AccountView, Config } from '../../src/types.ts';

const FIX = join(import.meta.dirname, '..', '..', 'fixtures');
const FAKE_CLAUDE = join(FIX, 'fake-claude.mjs');
const FAKE_AGENT = join(FIX, 'fake-agent.mjs');
chmodSync(FAKE_CLAUDE, 0o755);
chmodSync(FAKE_AGENT, 0o755);
const VIEW_KEYS = new Set(['provider', 'id', 'name', 'order', 'isDefault', 'status', 'until', 'untilKind', 'plan', 'usage', 'checkedAt', 'inUse', 'buildReady', 'signInCommand', 'note']);

let demo: DemoHandle;
let port = 0;
let csrf = '';
async function raw(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; json: any; text: string }> {
  return new Promise((resolve, reject) => {
    const headers = { ...opts.headers, ...(opts.body !== undefined ? { 'content-length': String(Buffer.byteLength(opts.body)) } : {}) }; // DELETE bodies are not chunked by Node
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        let json: any = null;
        try {
          json = JSON.parse(t);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode ?? 0, json, text: t });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
const mut = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-conductor-csrf': csrf, 'sec-fetch-site': 'same-origin', ...extra });
const call = (method: string, path: string, body?: unknown) => raw(path, { method, headers: method === 'GET' ? {} : mut(), body: body === undefined ? undefined : JSON.stringify(body) });

before(async () => {
  demo = await startDemo({ port: 0, pollMs: 150, delayMs: 15 });
  port = demo.rt.server.listeningPort;
  csrf = (await raw('/api/state', {})).json.csrf;
});
after(async () => {
  await demo.close();
  rmSync(demo.home, { recursive: true, force: true });
});

test('AC8 HTTP: GET lists the allow-listed views (no path/email), state carries accounts + limitRule fields; no CSRF ⇒ 403', async () => {
  const l = await call('GET', '/api/accounts');
  assert.equal(l.status, 200);
  assert.equal(l.json.limitRule, 'switch');
  assert.equal(l.json.limitRuleEffective, 'switch');
  assert.deepEqual(l.json.accounts.map((v: AccountView) => `${v.provider}:${v.id}`), ['claude:default', 'cursor:default', 'codex:default']);
  for (const v of l.json.accounts) {
    for (const k of Object.keys(v)) assert.ok(VIEW_KEYS.has(k), k);
    assert.match(v.signInCommand, SIGNIN_COMMAND_RE);
  }
  const st = (await raw('/api/state', {})).json;
  assert.ok(Array.isArray(st.accounts));
  assert.equal(st.settings.limitRule, 'switch');
  assert.equal(st.settings.limitRuleEffective, 'switch');
  assert.equal((await raw('/api/accounts', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ provider: 'claude', name: 'X' }) })).status, 403);
  assert.equal((await raw('/api/accounts', { method: 'POST', headers: mut({ 'sec-fetch-site': 'cross-site' }), body: JSON.stringify({ provider: 'claude', name: 'X' }) })).status, 403);
});

test('AC8 HTTP: add (201, empty 0700 folder, not signed in), strict bodies, credential-like fields, codex, email labels, duplicates, re-add ⇒ new id + new folder (B4); order, rename; default ⇒ 409; removal signs out; keepSignin is CLI-only', async () => {
  const bad = [{}, { provider: 'claude' }, { provider: 'claude', name: 'X', extra: 1 }, { provider: 'claude', name: 'X', apiKey: 'k' }, { provider: 'claude', name: 'X', token: 't' }, { provider: 'claude', password: 'p' }, { provider: 'codex', name: 'X' }, { provider: 'gemini', name: 'X' }, { provider: 'claude', name: 'me@corp.example' }, { provider: 'claude', name: '' }, { provider: 'claude', name: 'x'.repeat(41) }, [1]];
  for (const b of bad) assert.equal((await call('POST', '/api/accounts', b)).status, 400, JSON.stringify(b));
  assert.equal((await raw('/api/accounts', { method: 'POST', headers: mut(), body: '{"__proto__":{"x":1},"provider":"claude","name":"P"}' })).status, 400);
  const a = await call('POST', '/api/accounts', { provider: 'claude', name: 'Work' });
  assert.equal(a.status, 201, a.text);
  const id: string = a.json.account.id;
  assert.match(id, /^claude-work-[0-9a-f]{4}$/);
  assert.match(a.json.signInCommand, SIGNIN_COMMAND_RE);
  assert.ok(['not-signed-in', 'checking', 'unknown'].includes(a.json.account.status), a.json.account.status);
  const folder = accountFolder({ provider: 'claude', id });
  assert.equal(statSync(folder).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(folder), [], 'no CLI ran: the folder is empty');
  assert.ok(!a.text.includes(folder) && !a.text.includes(paths.home()), 'no path in the response');
  assert.equal((await call('POST', '/api/accounts', { provider: 'claude', name: 'work' })).status, 409);
  // order (exact permutation) and rename
  assert.equal((await call('PUT', '/api/accounts/order', { provider: 'claude', ids: [id] })).status, 400);
  assert.equal((await call('PUT', '/api/accounts/order', { provider: 'claude', ids: [id, 'default'] })).status, 200);
  assert.deepEqual(demo.rt.cfgRef.current.accounts.claude.map((m) => m.id), [id, 'default']);
  assert.equal((await call('PUT', `/api/accounts/${id}`, { name: 'Work 2' })).json.account.name, 'Work 2');
  assert.equal((await call('PUT', '/api/accounts/default', { provider: 'claude', name: 'Personal' })).json.account.name, 'Personal');
  assert.equal((await call('DELETE', '/api/accounts/default')).status, 409);
  assert.equal((await call('DELETE', `/api/accounts/${id}`, { keepSignin: true })).status, 400, '--keep-signin is CLI-only');
  assert.equal((await call('DELETE', '/api/accounts/../x')).status, 404);
  assert.equal((await call('POST', '/api/accounts/login')).status, 404, 'no login route');
  const del = await call('DELETE', `/api/accounts/${id}`);
  assert.equal(del.status, 200, del.text);
  assert.equal(del.json.signedOut, true, 'removal signs out by default (fake claude auth logout)');
  assert.ok(!existsSync(folder));
  const again = await call('POST', '/api/accounts', { provider: 'claude', name: 'Work' });
  assert.notEqual(again.json.account.id, id, 'B4: a re-added name gets a NEW id (fresh nonce)');
  assert.ok(!existsSync(folder));
  assert.ok(['not-signed-in', 'checking', 'unknown'].includes(again.json.account.status));
  await call('DELETE', `/api/accounts/${again.json.account.id}`);
  // the limit rule (strict)
  assert.equal((await call('PUT', '/api/settings', { limitRule: 'bogus' })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { limitRuleEffective: 'wait' })).status, 400);
  const s = await call('PUT', '/api/settings', { limitRule: 'same' });
  assert.equal(s.json.settings.limitRule, 'same');
  await call('PUT', '/api/settings', { limitRule: 'switch' });
});

test('S11 control socket: the same strict handlers on the 0600 socket in a 0700 run dir; exact allow-list; ≤ 16 KB JSON; no login route; the CLI goes through it when a server runs', async () => {
  // a short private dir (macOS limits unix socket paths to 104 bytes); a 0755 dir is tightened to 0700 before the socket opens
  const runDir = mkdtempSync('/tmp/cs-');
  chmodSync(runDir, 0o755);
  const sock = join(runDir, 'c.sock');
  await demo.rt.server.listenControl(sock);
  assert.ok(controlDirOk(runDir));
  assert.equal(statSync(sock).mode & 0o777, 0o600);
  const c = socketClient(sock);
  assert.equal((await c('GET', '/accounts')).status, 200);
  assert.equal((await c('POST', '/accounts', { provider: 'claude', name: 'Sock', apiKey: 'x' })).status, 400);
  assert.equal((await c('POST', '/accounts/login', {})).status, 404);
  assert.equal((await c('GET', '/accounts/../../otp')).status, 404);
  assert.equal((await c('POST', '/otp')).status, 404, 'the control socket mints no sign-in link any more');
  assert.equal((await c('GET', '/otp')).status, 404);
  const big = await new Promise<number>((resolve) => {
    const data = JSON.stringify({ provider: 'claude', name: 'x'.repeat(CONTROL_BODY_MAX) });
    const req = http.request({ socketPath: sock, path: '/accounts', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
    req.on('error', () => resolve(0));
    req.end(data);
  });
  assert.ok(big === 413 || big === 0, `oversized body refused (${big})`);
  const notJson = await new Promise<number>((resolve) => {
    const req = http.request({ socketPath: sock, path: '/accounts', method: 'POST', headers: { 'content-type': 'text/plain' } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
    req.end('provider=claude');
  });
  assert.equal(notJson, 415);
  // the CLI through the socket
  const out: string[] = [];
  const err: string[] = [];
  const io = { control: c, direct: async () => { throw new Error('must not write directly while a server runs'); }, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
  assert.equal(await accountsCli(['add', 'claude', '--name', 'Cli'], io), 0, err.join('\n'));
  const added = demo.rt.cfgRef.current.accounts.claude.find((m) => m.name === 'Cli')!;
  assert.ok(out.some((l) => l.includes(LOGIN_DISABLED_MESSAGE)), 'sign-in is not enabled yet');
  assert.equal(await accountsCli(['move', added.id, 'up'], io), 0, err.join('\n'));
  assert.equal(demo.rt.cfgRef.current.accounts.claude[0]!.id, added.id);
  assert.equal(await accountsCli(['list', '--json'], io), 0);
  const listed = JSON.parse(out.filter((l) => l.startsWith('{')).at(-1)!);
  assert.ok(listed.accounts.every((v: AccountView) => Object.keys(v).every((k) => VIEW_KEYS.has(k))));
  assert.equal(await accountsCli(['login', added.id], io), 1);
  assert.equal(err.at(-1), LOGIN_DISABLED_MESSAGE);
  const before = demo.rt.cfgRef.current.accounts.claude.length;
  assert.equal(await accountsCli(['remove', added.id, '--keep-signin'], io), 0, err.join('\n'));
  assert.equal(demo.rt.cfgRef.current.accounts.claude.length, before - 1);
  assert.ok(out.some((l) => /sign-in was kept/.test(l)));
  // a run dir that is not private ⇒ no socket
  const loose = mkdtempSync(join(tmpdir(), 'cond-run-'));
  chmodSync(loose, 0o755);
  assert.equal(controlDirOk(loose), false);
  rmSync(loose, { recursive: true, force: true });
  after(() => rmSync(runDir, { recursive: true, force: true }));
});

test('S13 CLI direct mode: no server ⇒ the CLI takes the lock and writes the config itself; `login default` points at the tool\'s own command', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cond-cli-'));
  const prev = process.env.CONDUCTOR_HOME;
  process.env.CONDUCTOR_HOME = join(home, 'h');
  try {
    ensureHome();
    let cfg: Config = normalizeConfig(defaultConfig());
    let locked = 0;
    const out: string[] = [];
    const io = {
      control: null,
      direct: async () => {
        locked++;
        const svc = new AccountService({ getConfig: () => cfg, saveConfig: (c) => void (cfg = c) });
        return { svc, release: () => void locked-- };
      },
      out: (l: string) => out.push(l),
      err: (l: string) => out.push(l),
    };
    assert.equal(await accountsCli(['add', 'cursor', '--name', 'Spare'], io), 0, out.join('\n'));
    assert.equal(locked, 0, 'lock released');
    assert.equal(cfg.accounts.cursor.length, 2);
    assert.equal(await accountsCli(['login', 'default'], io), 1);
    assert.match(out.at(-1)!, /claude auth login|agent login/);
    assert.equal(await accountsCli(['remove', cfg.accounts.cursor[1]!.id, '--keep-signin'], io), 0);
    assert.equal(cfg.accounts.cursor.length, 1);
    assert.equal(await accountsCli(['bogus'], io), 2);
  } finally {
    process.env.CONDUCTOR_HOME = prev;
  }
});

test('M8-4 N1: a refused save leaves memory AND disk unchanged (add removes its empty folder; reorder/rename change nothing)', () => {
  const home = mkdtempSync(join(tmpdir(), 'cond-n1-'));
  const prev = process.env.CONDUCTOR_HOME;
  process.env.CONDUCTOR_HOME = join(home, 'h');
  try {
    ensureHome();
    const cfg: Config = normalizeConfig(defaultConfig());
    const snapshot = JSON.stringify(cfg);
    const svc = new AccountService({ getConfig: () => cfg, saveConfig: () => { throw new Error('disk refused'); }, nonce: () => 'abcd' });
    assert.throws(() => svc.add({ provider: 'claude', name: 'Work' }), /disk refused/);
    assert.equal(JSON.stringify(cfg), snapshot, 'memory unchanged');
    assert.ok(!existsSync(accountFolder({ provider: 'claude', id: 'claude-work-abcd' })), 'the empty folder was removed again');
    assert.throws(() => svc.reorder({ provider: 'claude', ids: ['default'] }), /disk refused/);
    assert.throws(() => svc.rename('default', { name: 'X', provider: 'claude' }), /disk refused/);
    assert.equal(JSON.stringify(cfg), snapshot);
  } finally {
    process.env.CONDUCTOR_HOME = prev;
  }
});

async function freshServices(scenario: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'cond-mod-'));
  process.env.CONDUCTOR_HOME = join(root, 'h');
  ensureHome();
  const fake = join(root, 'fake');
  mkdirSync(fake);
  writeFileSync(join(fake, 'scenario.json'), JSON.stringify(scenario));
  let cfg: Config = normalizeConfig({ ...defaultConfig(), agents: { ...defaultConfig().agents, claude: { ...defaultConfig().agents.claude, bin: FAKE_CLAUDE }, cursor: { bin: FAKE_AGENT } } });
  let svc: AccountService | null = null;
  const models = new ModelService({ getConfig: () => cfg, spawn: runProcess, bins: () => ({ claude: FAKE_CLAUDE, cursor: FAKE_AGENT }), extraEnv: { FAKE_DIR: fake }, envFor: (p, a) => svc!.envFor(p, a, { FAKE_DIR: fake }), afterDiscovery: (p, a) => svc?.afterDiscovery(p, a) });
  svc = new AccountService({ getConfig: () => cfg, saveConfig: (c) => void (cfg = c), models, extraEnv: { FAKE_DIR: fake }, nonce: () => '0a0a' });
  return { root, fake, svc, models, cfg: () => cfg };
}
const calls = (fake: string): any[] => (existsSync(join(fake, 'calls.jsonl')) ? readFileSync(join(fake, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('AC9 + check: a named account\'s check is M8-1 discovery under ITS env (cache <id>.json); default.json is untouched; removal deletes the cache + forget; unknown-id cache files are swept', async () => {
  const id = 'claude-work-0a0a';
  const t = await freshServices({ models: 'out', accounts: { [id]: { models: 'in' } } });
  const prev = process.env.CONDUCTOR_HOME;
  try {
    const def = join(paths.models(), 'claude', 'default.json');
    mkdirSync(join(paths.models(), 'claude'), { recursive: true, mode: 0o700 });
    writeFileSync(def, '{"keep":true}');
    t.svc.add({ provider: 'claude', name: 'Work' });
    const v = await t.svc.check(id);
    assert.equal(v.status, 'ready', JSON.stringify(v));
    const disc = calls(t.fake).filter((c) => c.mode === 'models');
    assert.ok(disc.length >= 1 && disc.every((c) => c.acct === id && c.acctEnv.CLAUDE_CONFIG_DIR === accountFolder({ provider: 'claude', id })));
    assert.ok(existsSync(join(paths.models(), 'claude', `${id}.json`)));
    assert.equal(readFileSync(def, 'utf8'), '{"keep":true}', 'the main sign-in cache carries over unchanged');
    writeFileSync(join(paths.models(), 'claude', 'claude-ghost-0001.json'), '{}');
    assert.deepEqual(t.svc.sweep(), { folders: 0, caches: 1 });
    assert.ok(existsSync(def));
    const r = await t.svc.remove(id);
    assert.equal(r.signedOut, true);
    assert.ok(!existsSync(join(paths.models(), 'claude', `${id}.json`)));
    assert.equal(t.models.view('claude', id).state, 'unavailable', 'forgotten');
    // a planted entry ⇒ the check refuses with zero spawns and the account is `unavailable` (S2: a check ⇒ unavailable)
    t.svc.add({ provider: 'claude', name: 'Work' });
    writeFileSync(join(accountFolder({ provider: 'claude', id }), 'settings.json'), '{}');
    const n = calls(t.fake).length;
    const v2 = await t.svc.check(id);
    assert.equal(calls(t.fake).length, n, 'zero spawns');
    assert.notEqual(v2.status, 'ready');
  } finally {
    process.env.CONDUCTOR_HOME = prev;
    t.models.stop();
  }
});

test('S22 / AC7 decoy: planted credential files holding DECOY_TOKEN never appear in config, API views, logs or CLI JSON — and are never opened', async () => {
  const id = 'claude-work-0a0a';
  const t = await freshServices({ models: 'in' });
  const prev = process.env.CONDUCTOR_HOME;
  const logs: string[] = [];
  configureLog({ sink: (_l, line) => logs.push(line) });
  try {
    t.svc.add({ provider: 'claude', name: 'Work' });
    t.svc.add({ provider: 'cursor', name: 'Spare' });
    const cid = t.cfg().accounts.cursor[1]!.id;
    writeFileSync(join(accountFolder({ provider: 'claude', id }), '.credentials.json'), '{"token":"DECOY_TOKEN_claude_1234567890"}', { mode: 0o600 });
    mkdirSync(join(accountFolder({ provider: 'cursor', id: cid }), '.cursor'), { mode: 0o700 });
    writeFileSync(join(accountFolder({ provider: 'cursor', id: cid }), '.cursor', 'auth.json'), '{"accessToken":"DECOY_TOKEN_cursor_0987654321"}', { mode: 0o600 });
    await t.svc.check(id);
    await t.svc.check(cid);
    const out: string[] = [];
    await accountsCli(['list', '--json'], { control: null, direct: async () => ({ svc: t.svc, release: () => undefined }), out: (l) => out.push(l), err: (l) => out.push(l) });
    const surfaces = [JSON.stringify(t.cfg()), JSON.stringify(t.svc.list()), JSON.stringify(t.svc.listing()), logs.join('\n'), out.join('\n'), existsSync(join(t.fake, 'calls.jsonl')) ? readFileSync(join(t.fake, 'calls.jsonl'), 'utf8') : ''];
    for (const s of surfaces) assert.ok(!s.includes('DECOY_TOKEN'), s.slice(0, 200));
    for (const s of surfaces.slice(0, 5)) assert.ok(!s.includes(paths.home()), 'no path in views/config/logs/CLI JSON');
    assert.equal(calls(t.fake).filter((c) => c.acct === id).length, 0, 'the refused Claude folder was never spawned');
  } finally {
    configureLog({ sink: null });
    process.env.CONDUCTOR_HOME = prev;
    t.models.stop();
  }
});

test('N6: at startup every named account is checked (fake discovery under its env); the engine then sees it signed in', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cond-n6-'));
  const prev = process.env.CONDUCTOR_HOME;
  process.env.CONDUCTOR_HOME = join(root, 'h');
  try {
    ensureHome();
    const fake = join(root, 'fake');
    mkdirSync(fake);
    writeFileSync(join(fake, 'scenario.json'), JSON.stringify({ models: 'in' }));
    const id = 'claude-boot-0001';
    createAccountFolder({ provider: 'claude', id });
    const cfg = normalizeConfig({ ...defaultConfig(), agents: { ...defaultConfig().agents, claude: { ...defaultConfig().agents.claude, bin: FAKE_CLAUDE }, cursor: { bin: FAKE_AGENT } }, accounts: { claude: [{ id: 'default', name: 'Main' }, { id, name: 'Boot' }] } });
    const rt = await createRuntime({ ephemeral: true, config: cfg, health: async () => ({ claude: { found: true, ok: true, loggedIn: true }, cursor: { found: true, ok: true, loggedIn: true } }), models: { spawn: runProcess, bins: () => ({ claude: FAKE_CLAUDE, cursor: FAKE_AGENT }), extraEnv: { FAKE_DIR: fake } } });
    try {
      for (let i = 0; i < 100 && rt.accounts.view('claude', id).status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(rt.accounts.view('claude', id).status, 'ready');
      assert.ok(calls(fake).some((c) => c.mode === 'models' && c.acct === id));
      assert.equal(rt.engine.routeStates().claude.accounts!.find((a) => a.id === id)!.auth, 'ok');
    } finally {
      await rt.close();
    }
  } finally {
    process.env.CONDUCTOR_HOME = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('S8 sweep: an orphan folder (no configured id) is removed at startup, counted; a symlink is unlinked, never followed', () => {
  const root = mkdtempSync(join(tmpdir(), 'cond-sweep-'));
  const prev = process.env.CONDUCTOR_HOME;
  process.env.CONDUCTOR_HOME = join(root, 'h');
  try {
    ensureHome();
    createAccountFolder({ provider: 'claude', id: 'claude-orphan-0001' });
    const target = join(root, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'keep'), 'x');
    symlinkSync(target, join(paths.home(), 'accounts', 'claude', 'claude-link-0001'));
    const cfg = normalizeConfig(defaultConfig());
    const svc = new AccountService({ getConfig: () => cfg, saveConfig: () => undefined });
    assert.equal(svc.sweep().folders, 2);
    assert.ok(existsSync(join(target, 'keep')), 'the link target is untouched');
    assert.ok(!lstatSyncSafe(join(paths.home(), 'accounts', 'claude', 'claude-orphan-0001')));
  } finally {
    process.env.CONDUCTOR_HOME = prev;
  }
});
function lstatSyncSafe(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
