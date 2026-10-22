// `conductor start` while another Conductor already runs: it must say so, open the dashboard through the running server's control socket
// (like `conductor open`), never launch a browser when told not to, and never touch the data folder it does not own.
// Throw-away CONDUCTOR_HOME, free ports, CONDUCTOR_NO_OPEN=1 so no real browser ever starts. Child output is only asserted on, never logged
// (the printed link carries a one-time sign-in token).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = join(import.meta.dirname, '..', 'bin', 'conductor.mjs');
const skip = process.platform === 'win32' ? 'needs the unix control socket' : false;

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as net.AddressInfo).port; srv.close(() => resolve(p)); });
  srv.on('error', reject);
});
const probe = (port: number): Promise<number> => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
  req.on('error', () => resolve(0));
  req.on('timeout', () => { req.destroy(); resolve(0); });
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function withRunningConductor(fn: (home: string, env: Record<string, string>) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cs-'));
  const home = join(root, 'd');
  mkdirSync(home, { recursive: true });
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CONDUCTOR_HOME: home, CONDUCTOR_NO_OPEN: '1', HOME: root };
  const port = await freePort();
  const first = spawn(process.execPath, [BIN, 'start', '--no-open', '--port', String(port)], { env, stdio: 'ignore' });
  try {
    let code = 0;
    for (let i = 0; i < 120 && ![200, 302, 401].includes(code); i++) {
      code = await probe(port);
      if (![200, 302, 401].includes(code)) await sleep(250);
    }
    assert.ok([200, 302, 401].includes(code), 'the first Conductor did not start');
    for (let i = 0; i < 40 && !existsSync(join(home, 'run', 'control.sock')); i++) await sleep(100);
    assert.ok(existsSync(join(home, 'run', 'control.sock')), 'the control socket was not opened');
    await fn(home, env);
  } finally {
    first.kill('SIGTERM');
    await new Promise((res) => { first.once('exit', res); setTimeout(res, 3000); });
  }
}

const second = (env: Record<string, string>, args: string[]): { status: number | null; out: string } => {
  const r = spawnSync(process.execPath, [BIN, 'start', ...args, '--port', '4399'], { env, encoding: 'utf8', timeout: 30000 });
  return { status: r.status, out: String(r.stdout) };
};

test('a second `start --no-open` says it is already running, opens nothing and exits 0', { skip }, async () => {
  await withRunningConductor((_home, env) => {
    const r = second(env, ['--no-open']);
    assert.equal(r.status, 0);
    assert.match(r.out, /already running/);
    assert.match(r.out, /conductor open/);
    assert.doesNotMatch(r.out, /Opened the dashboard/);
    assert.doesNotMatch(r.out, /Open this link/);
  });
});

test('a second `start` opens the running dashboard through the control socket, and leaves a corrupt config.json and the data folder untouched', { skip }, async () => {
  await withRunningConductor((home, env) => {
    const cfg = join(home, 'config.json');
    writeFileSync(cfg, '{ this is not json');
    const before = readFileSync(cfg);
    const listing = readdirSync(home).sort();
    const r = second(env, []);
    assert.equal(r.status, 0);
    assert.match(r.out, /already running/);
    assert.match(r.out, /Open this link: /, 'a link was produced through the open path');
    assert.deepEqual(readFileSync(cfg), before, 'config.json must not be rewritten or renamed');
    assert.deepEqual(readdirSync(home).sort(), listing, 'no quarantine or temp file may appear in the data folder');
  });
});

test('the browser setting in config.json is honoured read-only: ui.openBrowser=false means a second `start` does not open', { skip }, async () => {
  await withRunningConductor((home, env) => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ ui: { openBrowser: false } }));
    const r = second(env, []);
    assert.equal(r.status, 0);
    assert.match(r.out, /already running/);
    assert.doesNotMatch(r.out, /Open this link|Opened the dashboard/);
  });
});
