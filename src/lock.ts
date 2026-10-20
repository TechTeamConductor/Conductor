import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { uptime } from 'node:os';
import { paths } from './paths.ts';

export interface LockInfo {
  pid: number;
  startedAt: number;
  port?: number;
}

export class LockHeldError extends Error {
  info: LockInfo;
  constructor(info: LockInfo) {
    super(`Conductor is already running (pid ${info.pid}${info.port ? `, http://127.0.0.1:${info.port}` : ''}).`);
    this.name = 'LockHeldError';
    this.info = info;
  }
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLock(path: string = paths.lock()): LockInfo | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
    return v && typeof v.pid === 'number' ? v : null;
  } catch {
    return null;
  }
}

const TAKEOVER_STALE_MS = 10_000;

function isStale(path: string): { stale: boolean; held: LockInfo | null } {
  const held = readLock(path);
  // a lock written before the last boot is stale even if its pid has since been recycled by another process
  const bootedAt = Date.now() - uptime() * 1000 - 5000;
  const live = !!held && held.startedAt >= bootedAt && alive(held.pid);
  return { stale: !live, held };
}

/**
 * Single-instance lock with REAL mutual exclusion (security review S-3):
 *  - the lock file is created complete and atomically (`link` of a fully-written temp file: fails with EEXIST when held), so no
 *    contender ever sees an empty lock and mistakes it for a stale one;
 *  - taking over a stale lock is serialised by a `mkdir` mutex and re-checked inside it, so two contenders can never both
 *    unlink and re-create it.
 */
export function acquireLock(path: string = paths.lock(), info: Partial<LockInfo> = {}): { release(): void; update(patch: Partial<LockInfo>): void; info: LockInfo } {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const mine: LockInfo = { pid: process.pid, startedAt: Date.now(), ...info };
  const body = () => JSON.stringify(mine);
  let acquired = false;
  for (let attempt = 0; attempt < 12 && !acquired; attempt++) {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, body());
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, path); // atomic: exactly one contender wins
      acquired = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* already gone */
      }
    }
    if (acquired) break;
    const { stale, held } = isStale(path);
    if (!stale && held) throw new LockHeldError(held);
    // stale or unreadable: take it over under the mutex
    const mutex = `${path}.takeover`;
    try {
      mkdirSync(mutex, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(mutex).mtimeMs > TAKEOVER_STALE_MS) rmdirSync(mutex); // a crashed taker
      } catch {
        /* raced */
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.floor(Math.random() * 15)); // brief sync back-off
      continue;
    }
    try {
      const again = isStale(path);
      if (again.stale && existsSync(path)) {
        try {
          unlinkSync(path);
        } catch {
          /* someone else removed it */
        }
      }
    } finally {
      try {
        rmdirSync(mutex);
      } catch {
        /* ignore */
      }
    }
  }
  if (!acquired) throw new Error('could not acquire lock');
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const cur = readLock(path);
      if (cur && cur.pid === process.pid && existsSync(path)) unlinkSync(path);
    } catch {
      /* ignore */
    }
  };
  const onExit = () => release();
  process.once('exit', onExit);
  return {
    info: mine,
    release() {
      process.removeListener('exit', onExit);
      release();
    },
    update(patch) {
      Object.assign(mine, patch);
      try {
        const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        writeFileSync(tmp, body(), { mode: 0o600 });
        renameSync(tmp, path); // atomic replace: a reader never sees a half-written lock
      } catch {
        /* ignore */
      }
    },
  };
}
