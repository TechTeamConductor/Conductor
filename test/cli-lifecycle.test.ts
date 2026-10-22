// `conductor stop`, `restart` and `update` against REAL processes in throw-away homes (free ports, CONDUCTOR_NO_OPEN=1, no network).
// The safety cases matter most: a pid or a port that does not belong to a Conductor server must never be signalled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'conductor.mjs');
const NODE_DIR = dirname(process.execPath);
const hasLsof = existsSync('/usr/sbin/lsof') || existsSync('/usr/bin/lsof');
const skip = process.platform === 'win32' ? 'POSIX process handling' : false;
const skipLsof = skip || (hasLsof ? false : 'lsof is not installed');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  s.on('error', reject);
});
const probe = (port: number): Promise<number> => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
  req.on('error', () => resolve(0));
  req.on('timeout', () => { req.destroy(); resolve(0); });
});
async function until(fn: () => boolean | Promise<boolean>, ms = 30000): Promise<boolean> {
  for (let t = 0; t < ms; t += 200) { if (await fn()) return true; await sleep(200); }
  return false;
}
const answers = async (port: number): Promise<boolean> => [200, 302, 401].includes(await probe(port));

interface Env { env: Record<string, string>; home: string; lock: string }
function sandbox(): Env {
  const root = mkdtempSync(join(tmpdir(), 'lc-'));
  const home = join(root, 'd');
  mkdirSync(home, { recursive: true });
  return { home, lock: join(home, 'run', 'lock.json'), env: { ...(process.env as Record<string, string>), CONDUCTOR_HOME: home, CONDUCTOR_NO_OPEN: '1', HOME: root } };
}
const cli = (e: Env, args: string[], extra: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { env: { ...e.env, ...extra }, encoding: 'utf8', timeout: 90000 });
  return { status: r.status, out: String(r.stdout) + String(r.stderr) };
};
/** Like cli() but async, so the test process keeps reaping children while `stop` waits for them. */
const cliAsync = (e: Env, args: string[]): Promise<{ status: number | null; out: string }> => new Promise((resolve) => {
  const c = spawn(process.execPath, [BIN, ...args], { env: e.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', (b) => { out += String(b); });
  c.stderr.on('data', (b) => { out += String(b); });
  c.on('close', (status) => resolve({ status, out }));
});
async function startServer(e: Env, port: number, verb = 'start'): Promise<ChildProcess> {
  const child = spawn(process.execPath, [BIN, verb, '--no-open', '--port', String(port)], { env: e.env, stdio: 'ignore' });
  assert.ok(await until(() => answers(port)), 'the server did not start');
  assert.ok(await until(() => existsSync(e.lock)), 'no lock file');
  return child;
}
const kill = (c: ChildProcess | undefined): void => { try { if (c?.pid && alive(c.pid)) process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ } };

test('stop: stops a real server gracefully, frees the port and exits 0', { skip }, async () => {
  const e = sandbox();
  const port = await freePort();
  const server = await startServer(e, port);
  try {
    const exited = new Promise<void>((res) => server.once('exit', () => res()));
    const r = await cliAsync(e, ['stop']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Stopped Conductor/);
    await Promise.race([exited, sleep(5000)]);
    assert.equal(alive(server.pid as number), false);
    assert.equal(await probe(port), 0, 'the port is free');
  } finally { kill(server); }
});

test('stop: when nothing runs it says so and exits 0 without creating the data folder', { skip }, () => {
  const e = sandbox();
  rmSync(e.home, { recursive: true, force: true });
  const r = cli(e, ['stop']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /not running/i);
  assert.equal(existsSync(e.home), false, 'stop must not create the data folder');
});

test('stop: a lock that names an unrelated live process kills nothing', { skip }, async () => {
  const e = sandbox();
  mkdirSync(join(e.home, 'run'), { recursive: true });
  const bystander = spawn('sleep', ['120'], { stdio: 'ignore' });
  try {
    writeFileSync(e.lock, JSON.stringify({ pid: bystander.pid, startedAt: Date.now() }));
    const r = cli(e, ['stop']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Not stopping pid/);
    assert.match(r.out, /not a Conductor server/);
    await sleep(300);
    assert.equal(alive(bystander.pid as number), true, 'the unrelated process must survive');
    const forced = cli(e, ['stop', '--force']);
    assert.equal(forced.status, 1);
    assert.equal(alive(bystander.pid as number), true, 'even --force never touches an unrelated process');
  } finally { kill(bystander); }
});

test('stop --port: stops an orphan Conductor (its lock is gone) and leaves a foreign listener alone', { skip: skipLsof }, async () => {
  const e = sandbox();
  const port = await freePort();
  const server = await startServer(e, port);
  const foreignPort = await freePort();
  const foreign = spawn(process.execPath, ['-e', `require('net').createServer().listen(${foreignPort},'127.0.0.1');setInterval(()=>{},1000)`], { stdio: 'ignore' });
  try {
    assert.ok(await until(async () => (await probe(foreignPort)) === 0 && alive(foreign.pid as number)));
    await sleep(500);
    rmSync(e.lock, { force: true }); // orphaned: nothing in this data folder points at it any more
    const plain = cli(e, ['stop']);
    assert.equal(plain.status, 0, plain.out);
    assert.match(plain.out, /not running/i);
    assert.equal(alive(server.pid as number), true, 'a plain stop never kills an orphan');
    const refused = cli(e, ['stop', '--port', String(foreignPort)]);
    assert.equal(refused.status, 1, refused.out);
    assert.match(refused.out, /leaving it alone/);
    assert.equal(alive(foreign.pid as number), true, 'a non-Conductor listener must survive');
    const exited = new Promise<void>((res) => server.once('exit', () => res()));
    const ok = await cliAsync(e, ['stop', '--port', String(port)]);
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /Port \d+ is free/);
    await Promise.race([exited, sleep(5000)]);
    assert.equal(alive(server.pid as number), false);
  } finally { kill(server); kill(foreign); }
});

test('stop: --port is validated', { skip }, () => {
  const e = sandbox();
  for (const bad of ['80', 'abc', '70000', '4327;ls']) assert.equal(cli(e, ['stop', '--port', bad]).status, 2, bad);
});

test('restart: replaces a running server with a new one on the same port; when stop is refused it does not start', { skip }, async () => {
  const e = sandbox();
  const port = await freePort();
  const first = await startServer(e, port);
  let second: ChildProcess | undefined;
  try {
    second = spawn(process.execPath, [BIN, 'restart', '--no-open'], { env: e.env, stdio: 'ignore' });
    assert.ok(await until(() => !alive(first.pid as number)), 'the old server is gone');
    assert.ok(await until(() => answers(port)), 'a new server answers on the same port');
    assert.notEqual(second.pid, first.pid);
    assert.equal(alive(second.pid as number), true);
  } finally { kill(first); kill(second); }
  // a lock pointing at an unrelated process: restart refuses and does not start anything
  const e2 = sandbox();
  mkdirSync(join(e2.home, 'run'), { recursive: true });
  const bystander = spawn('sleep', ['120'], { stdio: 'ignore' });
  try {
    writeFileSync(e2.lock, JSON.stringify({ pid: bystander.pid, startedAt: Date.now() }));
    const r = cli(e2, ['restart', '--no-open']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /Not restarting/);
    assert.equal(alive(bystander.pid as number), true);
  } finally { kill(bystander); }
});

test('restart: when nothing runs it just starts', { skip }, async () => {
  const e = sandbox();
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, 'restart', '--no-open', '--port', String(port)], { env: e.env, stdio: 'ignore' });
  try { assert.ok(await until(() => answers(port))); } finally { kill(child); }
});

// ───────────────────────────── update ─────────────────────────────
function makeTgz(version: string): Buffer {
  const entries = [
    { name: 'package/package.json', content: JSON.stringify({ name: 'conductor', version }) },
    { name: 'package/bin/conductor.mjs', content: `if (process.argv[2] === 'version') console.log(${JSON.stringify(version)});\n` },
  ];
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.content);
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write('0', 156);
    h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
function releaseDir(version: string, tamperInstaller = false, tgz: Buffer = makeTgz(version)): string {
  const dir = mkdtempSync(join(tmpdir(), 'rel-'));
  writeFileSync(join(dir, 'conductor.tgz'), tgz);
  copyFileSync(join(ROOT, 'install', 'install.sh'), join(dir, 'install.sh'));
  copyFileSync(join(ROOT, 'install', 'install.ps1'), join(dir, 'install.ps1'));
  const sha = (f: string): string => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
  writeFileSync(join(dir, 'SHA256SUMS.txt'), ['conductor.tgz', 'install.sh', 'install.ps1'].map((f) => `${sha(f)}  ${f}`).join('\n') + '\n');
  if (tamperInstaller) writeFileSync(join(dir, 'install.sh'), `${readFileSync(join(dir, 'install.sh'), 'utf8')}\n# tampered\n`);
  chmodSync(join(dir, 'install.sh'), 0o755);
  return dir;
}

test('update: refuses in a git clone and says how to update it', { skip }, () => {
  const e = sandbox();
  const r = cli(e, ['update']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /git pull/);
  assert.equal(cli(e, ['update', '--check']).status, 1);
});

test('update: an installed copy updates end to end from a local release folder; a tampered installer is refused', { skip }, () => {
  const home = join(mkdtempSync(join(tmpdir(), 'up-')), 'my home');
  mkdirSync(home, { recursive: true });
  const baseEnv = { HOME: home, PATH: `${NODE_DIR}:/usr/bin:/bin`, LANG: 'C', CONDUCTOR_HOME: join(home, 'data') };
  // the first install is the REAL packed app (it has the `update` command); the update target is a tiny 1.1.0 package
  const packed = mkdtempSync(join(tmpdir(), 'pack-'));
  const packName = execFileSync('npm', ['pack', '--pack-destination', packed, '--silent'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop() as string;
  const first = releaseDir('0.0.0-dev', false, readFileSync(join(packed, packName)));
  const inst = spawnSync('bash', [join(first, 'install.sh')], { env: { ...baseEnv, CONDUCTOR_LOCAL_DIR: first }, encoding: 'utf8' });
  assert.equal(inst.status, 0, inst.stderr);
  const shim = join(home, '.local', 'bin', 'conductor');
  const version = (): string => execFileSync(shim, ['version'], { env: baseEnv, encoding: 'utf8' }).trim();
  assert.equal(version(), '0.0.0-dev');
  // tampered installer: refused, nothing changes
  const bad = spawnSync(shim, ['update'], { env: { ...baseEnv, CONDUCTOR_LOCAL_DIR: releaseDir('1.1.0', true) }, encoding: 'utf8' });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout + bad.stderr, /does not match/);
  assert.equal(version(), '0.0.0-dev');
  // good release: updated
  const second = releaseDir('1.1.0');
  const ok = spawnSync(shim, ['update'], { env: { ...baseEnv, CONDUCTOR_LOCAL_DIR: second, GITHUB_TOKEN: 'must-not-leak' }, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Updated/);
  assert.match(ok.stdout, /only catches corruption/);
  assert.equal(version(), '1.1.0');
});
