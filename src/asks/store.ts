// Ask records (M5): one JSON file per ask under `<home>/asks/` (0700 dir, 0600 files, durable atomic writes, versioned) plus a capped index.
// Results are model text = untrusted data: they are rendered as text, never executed, never fed to a builder. Every id is validated before a
// path is built and every record is re-validated on load (the directory is same-user writable).
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { paths } from '../paths.ts';
import { atomicWriteFile } from '../util.ts';
import { quarantine } from '../schema/version.ts';
import { cleanCommand } from '../context/facts.ts';
import { validateReport, type ResearchReport } from './research.ts';
import { shapeResearchBrief } from '../briefs/schemas.ts';
import type { ResearchBrief } from '../briefs/types.ts';

export const ASK_ID_RE = /^ask-[0-9a-f]{16,32}$/;
export const ASK_LIMITS = Object.freeze({ question: 4000, answer: 20_000, file: 512 * 1024, events: 200, eventChars: 600, index: 500 });
export type AskStatus = 'running' | 'paused' | 'done' | 'failed' | 'canceled';
export type AskMode = 'quick' | 'research';
export interface AskCitation { file: string; lines: string }
export interface AskResult { kind: 'answer' | 'change'; answer: string; change?: { title: string; description: string; files: string[]; complexity: 'S' | 'M' | 'L' }; citations: AskCitation[] }
export interface AskRecord {
  schemaVersion: 1;
  id: string;
  mode: AskMode;
  repo?: string;
  question: string;
  /** Where the answer came from: `branch @ sha`. */
  basis?: string;
  createdAt: number;
  updatedAt: number;
  status: AskStatus;
  provider?: string;
  /** Tier note shown with the answer (e.g. "answered by Cursor in ask mode — weaker isolation"). */
  tierNote?: string;
  result?: AskResult;
  /** Deep Research: the report, with citation status computed by Conductor from the session's tool events. */
  report?: ResearchReport;
  error?: string;
  events: string[];
  convertedTo?: string;
  /** Quick Ask: the user ticked "let Conductor make this change if it is small" BEFORE asking. */
  allowChange?: boolean;
  /** M8-6 F4: the reviewed research brief (model-written from the question; untrusted) this run was started with. */
  brief?: ResearchBrief;
  /** M8-6 F4: research depth (absent = standard). */
  depth?: 'standard' | 'deep';
  /** M8-6 B2d: the brief that started this run — stamped in the FIRST save, so a replayed Send adopts it instead of starting another. */
  briefId?: string;
  /** M8-6 Q3: the research card was dismissed from the board's "Report ready" lane. */
  dismissedAt?: number;
  /** M8-3: `limited` = every account it may use reached its limit mid-call (the counter was refunded); `retryAt` = the earliest reset. */
  errorKind?: 'limited';
  retryAt?: number;
  /** The counter window this ask took (so a refund credits THAT window, N12) and whether it was refunded (at most once). */
  takenKey?: string;
  refunded?: boolean;
}
export const askDir = (): string => join(paths.home(), 'asks');
export const newAskId = (): string => `ask-${randomBytes(8).toString('hex')}`;
export function assertAskId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !ASK_ID_RE.test(id)) throw new Error('not an ask id');
}
function ensureDir(): string {
  const d = askDir();
  mkdirSync(paths.home(), { recursive: true, mode: 0o700 });
  try {
    const st = lstatSync(d);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${d} is not a real directory`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    mkdirSync(d, { mode: 0o700 });
  }
  chmodSync(d, 0o700);
  return d;
}
const STATUSES: readonly AskStatus[] = ['running', 'paused', 'done', 'failed', 'canceled'];
const own = (o: unknown, k: string): unknown => (o && typeof o === 'object' && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined);
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\p{Cf}\p{Co}\p{Cn}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}]/gu, '').slice(0, max) : '');

/** A record from untrusted bytes; null when it is not one. Strings are capped, control/bidi characters stripped from one-line fields. */
export function validateAsk(raw: unknown, id: string): AskRecord | null {
  if (own(raw, 'id') !== id || !STATUSES.includes(own(raw, 'status') as AskStatus)) return null;
  const mode = own(raw, 'mode');
  if (mode !== 'quick' && mode !== 'research') return null;
  const r = own(raw, 'result');
  let result: AskResult | undefined;
  if (r && typeof r === 'object') {
    const kind = own(r, 'kind') === 'change' ? 'change' : 'answer';
    const ch = own(r, 'change');
    const cits = own(r, 'citations');
    result = {
      kind,
      answer: text(own(r, 'answer'), ASK_LIMITS.answer),
      change: kind === 'change' && ch && typeof ch === 'object' ? { title: cleanCommand(own(ch, 'title')).slice(0, 200), description: text(own(ch, 'description'), 4000), files: (Array.isArray(own(ch, 'files')) ? (own(ch, 'files') as unknown[]) : []).filter((f): f is string => typeof f === 'string').slice(0, 20).map((f) => cleanCommand(f).slice(0, 300)), complexity: ['S', 'M', 'L'].includes(own(ch, 'complexity') as string) ? (own(ch, 'complexity') as 'S' | 'M' | 'L') : 'M' } : undefined,
      citations: (Array.isArray(cits) ? cits : []).slice(0, 30).map((c) => ({ file: cleanCommand(own(c, 'file')).slice(0, 300), lines: cleanCommand(own(c, 'lines')).slice(0, 40) })),
    };
  }
  const num = (k: string): number => { const v = own(raw, k); return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0; };
  const repo = own(raw, 'repo');
  const conv = own(raw, 'convertedTo');
  return {
    schemaVersion: 1,
    id,
    mode,
    repo: typeof repo === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(repo) ? repo : undefined,
    question: text(own(raw, 'question'), ASK_LIMITS.question),
    basis: typeof own(raw, 'basis') === 'string' ? cleanCommand(own(raw, 'basis')).slice(0, 300) : undefined,
    createdAt: num('createdAt'),
    updatedAt: num('updatedAt'),
    status: own(raw, 'status') as AskStatus,
    provider: typeof own(raw, 'provider') === 'string' ? cleanCommand(own(raw, 'provider')).slice(0, 40) : undefined,
    tierNote: typeof own(raw, 'tierNote') === 'string' ? cleanCommand(own(raw, 'tierNote')).slice(0, 300) : undefined,
    result,
    report: own(raw, 'report') ? validateReport(own(raw, 'report')) ?? undefined : undefined,
    error: typeof own(raw, 'error') === 'string' ? text(own(raw, 'error'), 500) : undefined,
    events: (Array.isArray(own(raw, 'events')) ? (own(raw, 'events') as unknown[]) : []).filter((e): e is string => typeof e === 'string').slice(-ASK_LIMITS.events).map((e) => e.slice(0, ASK_LIMITS.eventChars)),
    convertedTo: typeof conv === 'string' && /^[A-Z]{2,6}-\d{1,9}$/.test(conv) ? conv : undefined,
    allowChange: own(raw, 'allowChange') === true,
    ...(mode === 'research' && own(raw, 'brief') ? (() => { const b = shapeResearchBrief(own(raw, 'brief')); return b ? { brief: b } : {}; })() : {}),
    ...(mode === 'research' && (own(raw, 'depth') === 'standard' || own(raw, 'depth') === 'deep') ? { depth: own(raw, 'depth') as 'standard' | 'deep' } : {}),
    ...(typeof own(raw, 'briefId') === 'string' && /^brf-[0-9a-f]{16}$/.test(own(raw, 'briefId') as string) ? { briefId: own(raw, 'briefId') as string } : {}),
    ...(own(raw, 'errorKind') === 'limited' ? { errorKind: 'limited' as const } : {}),
    ...(typeof own(raw, 'retryAt') === 'number' && Number.isFinite(own(raw, 'retryAt')) && (own(raw, 'retryAt') as number) > 0 ? { retryAt: own(raw, 'retryAt') as number } : {}),
    ...(typeof own(raw, 'takenKey') === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2})?$/.test(own(raw, 'takenKey') as string) ? { takenKey: own(raw, 'takenKey') as string } : {}),
    ...(own(raw, 'refunded') === true ? { refunded: true } : {}),
    ...(typeof own(raw, 'dismissedAt') === 'number' && Number.isFinite(own(raw, 'dismissedAt')) && (own(raw, 'dismissedAt') as number) > 0 ? { dismissedAt: own(raw, 'dismissedAt') as number } : {}),
  };
}

export function saveAsk(rec: AskRecord): void {
  assertAskId(rec.id);
  const dir = ensureDir();
  atomicWriteFile(join(dir, `${rec.id}.json`), JSON.stringify(rec) + '\n', 0o600, { durable: true });
  const ids = listAskIds();
  if (ids.length > ASK_LIMITS.index) {
    const recs = ids.map((id) => ({ id, at: loadAsk(id)?.updatedAt ?? 0 })).sort((a, b) => a.at - b.at);
    for (const old of recs.slice(0, ids.length - ASK_LIMITS.index)) if (old.id !== rec.id) rmSync(join(dir, `${old.id}.json`), { force: true });
  }
}
export function listAskIds(): string[] {
  const d = askDir();
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((n) => n.endsWith('.json') && ASK_ID_RE.test(n.slice(0, -5))).map((n) => n.slice(0, -5));
}
export function loadAsk(id: string): AskRecord | null {
  assertAskId(id);
  const f = join(askDir(), `${id}.json`);
  if (!existsSync(f)) return null;
  try {
    if (statSync(f).size > ASK_LIMITS.file) throw new Error('too large');
    const rec = validateAsk(JSON.parse(readFileSync(f, 'utf8')), id);
    if (!rec) throw new Error('shape');
    return rec;
  } catch {
    quarantine(f);
    return null;
  }
}
export function deleteAsk(id: string): void {
  assertAskId(id);
  rmSync(join(askDir(), `${id}.json`), { force: true });
}
export function listAsks(limit = 100): AskRecord[] {
  return listAskIds().map((id) => loadAsk(id)).filter((r): r is AskRecord => !!r).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}
