// The ONE accounting module for counted limits (M4 commit 4; M5/M6 reuse it). Persisted, versioned, restart-safe, validated on load.
//  - the day is the user's LOCAL calendar day, as a `YYYY-MM-DD` string (DST-safe: no 24 h arithmetic),
//  - counters live in `<home>/limits.json`; a damaged file is quarantined and counting restarts for today,
//  - every counter has a code-constant ceiling no config can lift.
// Same-user bookkeeping, not tamper-proofing.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths.ts';
import { atomicWriteFile } from '../util.ts';
import { quarantine } from '../schema/version.ts';

export type CounterId = 'contextRunsPerDay' | 'asksPerHour' | 'researchPerDay' | 'fastPathPerHour' | 'designPerHour';
export const CEILINGS: Readonly<Record<CounterId, number>> = Object.freeze({ contextRunsPerDay: 48, asksPerHour: 60, researchPerDay: 20, fastPathPerHour: 20, designPerHour: 30 });
const WINDOW: Readonly<Record<CounterId, 'day' | 'hour'>> = Object.freeze({ contextRunsPerDay: 'day', asksPerHour: 'hour', researchPerDay: 'day', fastPathPerHour: 'hour', designPerHour: 'hour' });
const SCOPE_RE = /^[A-Za-z0-9._-]{1,40}$/;
const FILE_VERSION = 1;

export const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const windowKey = (id: CounterId, ms: number): string => (WINDOW[id] === 'day' ? localDay(ms) : `${localDay(ms)}T${String(new Date(ms).getHours()).padStart(2, '0')}`);
const KEY_RE = /^\d{4}-\d{2}-\d{2}(T\d{2})?$/;

type Store = { version: 1; counters: Record<string, Record<string, number>> };
const file = (): string => join(paths.home(), 'limits.json');

function load(): Store {
  const f = file();
  const empty: Store = { version: FILE_VERSION, counters: Object.create(null) };
  if (!existsSync(f)) return empty;
  try {
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    if (!raw || raw.version !== FILE_VERSION || typeof raw.counters !== 'object' || raw.counters === null) throw new Error('shape');
    for (const [name, byKey] of Object.entries(raw.counters as Record<string, unknown>)) {
      if (!Object.hasOwn(CEILINGS, name.split('|')[0]!) || !byKey || typeof byKey !== 'object') continue;
      const [id, scope] = name.split('|') as [CounterId, string?];
      if (scope !== undefined && !SCOPE_RE.test(scope)) continue;
      const clean: Record<string, number> = Object.create(null);
      for (const [k, v] of Object.entries(byKey as Record<string, unknown>)) {
        if (KEY_RE.test(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0) clean[k] = Math.min(CEILINGS[id], Math.floor(v));
      }
      empty.counters[name] = clean;
    }
    return empty;
  } catch {
    quarantine(f);
    return empty;
  }
}

const nameOf = (id: CounterId, scope?: string): string => {
  if (scope !== undefined && !SCOPE_RE.test(scope)) throw new Error('bad counter scope');
  return scope ? `${id}|${scope}` : id;
};

/** How many have been used in the current window. */
export function used(id: CounterId, opts: { scope?: string; now?: number } = {}): number {
  const now = opts.now ?? Date.now();
  return load().counters[nameOf(id, opts.scope)]?.[windowKey(id, now)] ?? 0;
}
/** Take `n` if the limit (≤ the ceiling) allows it; returns whether it was taken. Old windows are dropped on write. */
export function take(id: CounterId, limit: number, opts: { scope?: string; now?: number; n?: number } = {}): boolean {
  return takeKeyed(id, limit, opts).ok;
}
/**
 * `take` that also returns the window key it counted in (M8-6 N12), so a later `refund` credits THAT window — never the current one.
 * `n` must be an integer ≥ 1 (S11: a negative `n` would otherwise decrement the counter).
 */
export function takeKeyed(id: CounterId, limit: number, opts: { scope?: string; now?: number; n?: number } = {}): { ok: boolean; key: string } {
  const now = opts.now ?? Date.now();
  const n = opts.n ?? 1;
  if (!Number.isInteger(n) || n < 1) throw new Error('take: n must be an integer >= 1');
  const cap = Math.min(CEILINGS[id], Math.max(0, Math.floor(limit)));
  const s = load();
  const name = nameOf(id, opts.scope);
  const key = windowKey(id, now);
  const cur = s.counters[name]?.[key] ?? 0;
  if (cur + n > cap) return { ok: false, key };
  s.counters[name] = { [key]: cur + n };
  atomicWriteFile(file(), JSON.stringify(s) + '\n', 0o600, { durable: true });
  return { ok: true, key };
}
/**
 * Give back `n` taken in window `key` (from `takeKeyed`), floored at 0. A no-op when that window has rolled over (the stored counter
 * only keeps the current window) — a refund never credits a later window (N12). Callers refund at most once per take (S11).
 */
export function refund(id: CounterId, opts: { key: string; scope?: string; n?: number }): void {
  const n = opts.n ?? 1;
  if (!Number.isInteger(n) || n < 1 || !KEY_RE.test(opts.key)) return;
  const s = load();
  const name = nameOf(id, opts.scope);
  const cur = s.counters[name]?.[opts.key];
  if (cur === undefined) return;
  s.counters[name] = { [opts.key]: Math.max(0, cur - n) };
  atomicWriteFile(file(), JSON.stringify(s) + '\n', 0o600, { durable: true });
}
