// AC1: a clean copy WITHOUT node_modules boots, listens on loopback only, requires auth, and stops cleanly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const freePort = (): Promise<number> => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const get = (port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> =>
  new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path, headers }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body: b })); }).on('error', reject));

test('AC1: clean copy (no node_modules) boots; loopback only; 401 without a session; control socket mints a working sign-in; SIGTERM exits 0 and frees the lock', { timeout: 60_000 }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cond-boot-')));
  const copy = join(dir, 'copy');
  const home = join(dir, 'home');
  for (const p of ['bin', 'src', 'ui', 'prompts', 'package.json']) cpSync(join(ROOT, p), join(copy, p), { recursive: true });
  assert.equal(existsSync(join(copy, 'node_modules')), false, 'precondition: no node_modules');
  const port = await freePort();
  const child = spawn(process.execPath, [join(copy, 'bin', 'conductor.mjs'), 'start', '--no-open', '--port', String(port)], {
    cwd: copy,
    env: { PATH: process.env.PATH ?? '', HOME: dir, CONDUCTOR_HOME: home, CONDUCTOR_NO_KEYCHAIN: '1', CONDUCTOR_NO_NOTIFY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  try {
    for (let i = 0; i < 100 && !/is running/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /is running → http:\/\/127\.0\.0\.1:/, out);
    assert.equal((await get(port, '/api/state')).status, 401);
    assert.equal((await get(port, '/')).status, 302);
    const listeners = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    assert.ok(listeners.includes('127.0.0.1:' + port) && !/\*:|0\.0\.0\.0|\[::\]/.test(listeners), `must listen on loopback only:\n${listeners}`);
    // control socket (mode 0600) → one-time link → session → state
    const otp: { url: string } = await new Promise((resolve, reject) => {
      const rq = http.request({ socketPath: join(home, 'run', 'control.sock'), path: '/otp', method: 'POST' }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve(JSON.parse(b))); });
      rq.on('error', reject);
      rq.end();
    });
    const u = new URL(otp.url);
    const auth = await get(port, u.pathname + u.search);
    assert.equal(auth.status, 302);
    const cookie = String(auth.headers['set-cookie']?.[0]).split(';')[0]!;
    const st = await get(port, '/api/state', { cookie });
    assert.equal(st.status, 200);
    assert.ok(JSON.parse(st.body).csrf);
    assert.equal((execFileSync('stat', ['-f', '%Lp', join(home, 'run', 'control.sock')], { encoding: 'utf8' })).trim(), '600');
    // a second instance with the same home is refused politely
    const second = spawn(process.execPath, [join(copy, 'bin', 'conductor.mjs'), 'start', '--no-open'], { env: { PATH: process.env.PATH ?? '', HOME: dir, CONDUCTOR_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let o2 = '';
    second.stdout.on('data', (d) => (o2 += d));
    const code2: number | null = await new Promise((r) => second.on('close', r));
    assert.equal(code2, 0);
    assert.match(o2, /already running/);
  } finally {
    child.kill('SIGTERM');
    const code: number | null = await new Promise((r) => child.on('close', r));
    assert.equal(code, 0, 'SIGTERM shuts down cleanly');
    assert.equal(existsSync(join(home, 'run', 'lock.json')), false, 'lock released');
    rmSync(dir, { recursive: true, force: true });
  }
});
