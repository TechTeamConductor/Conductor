import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, LockHeldError, readLock } from '../src/lock.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'cond-lock-'));

test('lock: second acquire in the same process is refused; release frees it; update replaces atomically', () => {
  const p = join(tmp(), 'x.lock');
  const a = acquireLock(p, { port: 1 });
  assert.throws(() => acquireLock(p), (e: any) => e instanceof LockHeldError);
  a.update({ port: 2 });
  assert.equal(readLock(p)!.port, 2);
  a.release();
  assert.equal(existsSync(p), false);
  acquireLock(p).release();
});

test('lock: a lock that is stale (dead pid), empty or garbage is taken over', () => {
  for (const content of [JSON.stringify({ pid: 999999, startedAt: Date.now() }), '', 'garbage', JSON.stringify({ pid: process.pid, startedAt: 1 })]) {
    const p = join(tmp(), 'y.lock');
    writeFileSync(p, content);
    const l = acquireLock(p);
    assert.equal(readLock(p)!.pid, process.pid);
    l.release();
  }
});

test('lock: a crashed takeover mutex does not wedge the lock', () => {
  const dir = tmp();
  const p = join(dir, 'z.lock');
  writeFileSync(p, JSON.stringify({ pid: 999999, startedAt: Date.now() }));
  mkdirSync(`${p}.takeover`);
  const old = new Date(Date.now() - 60_000);
  // age the mutex like a crashed taker left it
  import('node:fs').then(({ utimesSync }) => utimesSync(`${p}.takeover`, old, old));
  return new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => {
    acquireLock(p).release();
  });
});

test('security review S-3: with a stale lock and several processes contending, there is never more than one holder', async () => {
  let violations = 0;
  let wins = 0;
  for (let round = 0; round < 12; round++) {
    const dir = tmp();
    const lockPath = join(dir, 'c.lock');
    const marker = join(dir, 'inside');
    const report = join(dir, 'report');
    writeFileSync(report, '');
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: Date.now() })); // stale
    const kids = Array.from({ length: 4 }, () => new Promise<void>((resolve) => {
      const c = spawn(process.execPath, [join(import.meta.dirname, 'helpers', 'lock-child.ts')], { env: { ...process.env, LOCK_PATH: lockPath, MARKER: marker, REPORT: report }, stdio: 'ignore' });
      c.on('exit', () => resolve());
    }));
    await Promise.all(kids);
    const lines = readFileSync(report, 'utf8').split('\n').filter(Boolean);
    violations += lines.filter((l) => l === 'VIOLATION').length;
    wins += lines.filter((l) => l === 'won').length;
    assert.ok(lines.every((l) => ['won', 'held', 'VIOLATION'].includes(l)), `unexpected: ${lines}`);
  }
  assert.equal(violations, 0, 'two processes were inside the critical section at once');
  assert.ok(wins >= 12, `at least one winner per round (got ${wins})`);
});

test('a contender WAITS for a slow takeover (descheduled holder of the takeover mutex) instead of failing with a raw error', async () => {
  const dir = tmp();
  const lockPath = join(dir, 'c.lock');
  const report = join(dir, 'report');
  writeFileSync(report, '');
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: Date.now() })); // stale
  mkdirSync(`${lockPath}.takeover`); // somebody is in the middle of taking over …
  const child = spawn(process.execPath, [join(import.meta.dirname, 'helpers', 'lock-child.ts')], { env: { ...process.env, LOCK_PATH: lockPath, MARKER: join(dir, 'inside'), REPORT: report }, stdio: 'ignore' });
  const exited = new Promise<void>((r) => child.on('exit', () => r()));
  await new Promise((r) => setTimeout(r, 900)); // … for much longer than the old 12 short back-offs allowed
  rmSync(`${lockPath}.takeover`, { recursive: true, force: true });
  await exited;
  assert.deepEqual(readFileSync(report, 'utf8').split('\n').filter(Boolean), ['won']);
});
