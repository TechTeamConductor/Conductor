import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync, mkdirSync } from 'node:fs';
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

/** Single-instance lock: O_EXCL create + pid-liveness stale takeover. */
export function acquireLock(path: string = paths.lock(), info: Partial<LockInfo> = {}): { release(): void; update(patch: Partial<LockInfo>): void; info: LockInfo } {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const mine: LockInfo = { pid: process.pid, startedAt: Date.now(), ...info };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, JSON.stringify(mine));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = readLock(path);
      // a lock written before the last boot is stale even if its pid has since been recycled by another process
      const bootedAt = Date.now() - uptime() * 1000 - 5000;
      if (held && held.startedAt >= bootedAt && alive(held.pid)) throw new LockHeldError(held);
      try {
        unlinkSync(path); // stale (dead pid / unreadable): take over
      } catch {
        /* race: someone else removed it */
      }
      if (attempt === 2) throw new Error('could not acquire lock');
    }
  }
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
        const fd = openSync(path, 'w', 0o600);
        writeSync(fd, JSON.stringify(mine));
        closeSync(fd);
      } catch {
        /* ignore */
      }
    },
  };
}
