import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');
export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

/** POSIX single-quote escaping: safe to embed in `sh -c` strings. */
export function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}
export function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  return '…' + s.slice(s.length - max + 1);
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Lowercase, [a-z0-9-] only; used for branch names and directory names. */
export function slug(s: string): string {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'x'
  );
}

/** Write atomically (temp file + rename). Creates parent directories. */
export function atomicWriteFile(path: string, data: string | Buffer, mode = 0o644, opts: { durable?: boolean } = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  if (opts.durable) {
    // data on disk BEFORE the rename, and the rename itself on disk after: a power cut leaves the old file or the new one, never an empty one
    const fd = openSync(tmp, 'w', mode);
    try {
      writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    try {
      const dfd = openSync(dirname(path), 'r');
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      /* some filesystems cannot fsync a directory: the file itself is already durable */
    }
    return;
  }
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

export function readJsonFile<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Human duration like "2m 14s". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
