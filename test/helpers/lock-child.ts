// Contender for the lock mutual-exclusion test: tries to take the lock, and if it wins it enters a critical section guarded by an
// O_EXCL marker file — a second simultaneous holder would find the marker and report a violation.
import { existsSync, openSync, closeSync, unlinkSync, appendFileSync } from 'node:fs';
import { acquireLock, LockHeldError } from '../../src/lock.ts';

const lockPath = process.env.LOCK_PATH!;
const marker = process.env.MARKER!;
const report = process.env.REPORT!;
try {
  const l = acquireLock(lockPath, { port: process.pid });
  try {
    const fd = openSync(marker, 'wx'); // throws if another holder is inside
    closeSync(fd);
    const t = Date.now();
    while (Date.now() - t < 40) void 0; // hold the lock briefly
    unlinkSync(marker);
    appendFileSync(report, 'won\n');
  } catch {
    appendFileSync(report, 'VIOLATION\n');
  } finally {
    l.release();
  }
} catch (e) {
  appendFileSync(report, e instanceof LockHeldError ? 'held\n' : `error ${(e as Error).message}\n`);
}
void existsSync;
