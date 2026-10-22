// Deterministic run-outcome digests (M4): one line per run that reached a resting state — `{key, title, status, at, files, verdict, loops,
// itemCount}` and nothing a model wrote except the verdict word. Stored as `<home>/projects/<KEY>/context/history.ndjson` (≤ 1 MB, oldest
// lines pruned), read back through a strict validator. The titles are user text and the file names are repository-controlled, so history
// only ever reaches READ-ONLY stages (fenced) and the UI — never a builder prompt (trust class iii, M3 §2b-7).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../util.ts';
import { cleanCommand, isIdent } from './facts.ts';
import { contextDir, ensureContextDir } from './store.ts';

export const HISTORY_MAX_BYTES = 1024 * 1024;
export const HISTORY_MAX_FILES = 50;
export type DigestStatus = 'ready' | 'finished' | 'needs_human' | 'aborted';
const STATUSES: readonly DigestStatus[] = ['ready', 'finished', 'needs_human', 'aborted'];

export interface HistoryLine {
  key: string;
  title: string;
  status: DigestStatus;
  at: number;
  files: string[];
  verdict: 'pass' | 'fail' | null;
  loops: number;
  itemCount: number;
  /** Idempotency marker (`status:rev:loop`) — a replay of the same transition appends nothing. */
  mark: string;
}

const KEY_RE = /^[A-Z]{2,6}-\d{1,9}$/;
const num = (v: unknown, max: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(max, Math.floor(v)) : 0);
const MARK_RE = /^[a-z_]{4,12}:\d{1,6}:\d{1,4}$/;

/** A line from untrusted bytes (the file lives where a builder could rewrite it): anything off-shape is dropped. */
export function parseHistoryLine(raw: unknown): HistoryLine | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const g = (k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);
  const key = g('key');
  const status = g('status');
  const mark = g('mark');
  if (typeof key !== 'string' || !KEY_RE.test(key) || !STATUSES.includes(status as DigestStatus) || typeof mark !== 'string' || !MARK_RE.test(mark)) return null;
  const verdict = g('verdict');
  const files = Array.isArray(g('files')) ? (g('files') as unknown[]).filter(isIdent).slice(0, HISTORY_MAX_FILES) : [];
  return {
    key,
    title: cleanCommand(g('title')).slice(0, 200),
    status: status as DigestStatus,
    at: num(g('at'), 8.64e15),
    files,
    verdict: verdict === 'pass' || verdict === 'fail' ? verdict : null,
    loops: num(g('loops'), 99),
    itemCount: num(g('itemCount'), 99),
    mark,
  };
}

export function readHistory(projectKey: string, limit = 200): HistoryLine[] {
  const f = join(contextDir(projectKey), 'history.ndjson');
  if (!existsSync(f) || statSync(f).size > HISTORY_MAX_BYTES * 2) return [];
  const out: HistoryLine[] = [];
  const seen = new Set<string>();
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line) continue;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const h = parseHistoryLine(j);
    if (!h) continue;
    const id = `${h.key}|${h.mark}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(h);
  }
  return out.slice(-limit);
}

export function appendHistory(projectKey: string, line: Omit<HistoryLine, 'files'> & { files: string[] }): void {
  const clean = parseHistoryLine(line);
  if (!clean) throw new Error('not a valid history line');
  const dir = ensureContextDir(projectKey);
  const f = join(dir, 'history.ndjson');
  const existing = readHistory(projectKey, 100_000);
  if (existing.some((h) => h.key === clean.key && h.mark === clean.mark)) return; // replay
  let all = [...existing, clean].map((h) => JSON.stringify(h));
  let text = all.join('\n') + '\n';
  while (Buffer.byteLength(text) > HISTORY_MAX_BYTES && all.length > 1) {
    all = all.slice(Math.ceil(all.length * 0.1)); // drop the oldest tenth at a time
    text = all.join('\n') + '\n';
  }
  atomicWriteFile(f, text, 0o600, { durable: true });
}

/** One digest line as prose for a READ-ONLY prompt (the whole block is fenced as untrusted by the caller). */
export function digestText(h: HistoryLine): string {
  const when = new Date(h.at).toISOString().slice(0, 10);
  const bits = [h.status.replace('_', ' '), h.verdict ? `verdict ${h.verdict}` : '', h.loops > 1 ? `${h.loops} loops` : '', h.itemCount > 1 ? `${h.itemCount} tasks` : ''].filter(Boolean).join(', ');
  return `- ${h.key} "${h.title}" (${when}) — ${bits}${h.files.length ? `; files: ${h.files.slice(0, 8).join(', ')}${h.files.length > 8 ? ` +${h.files.length - 8}` : ''}` : ''}`;
}
