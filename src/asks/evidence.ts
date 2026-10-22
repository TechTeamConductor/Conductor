// Code Research: the model's report cites evidence as {file, lines, quote}. Conductor does not trust those citations: every one is checked
// against the read-only snapshot the model actually worked on, and the result (verified / unverified) is computed here, never taken from
// model text. The checks are structural and bounded: the path must be a committed regular file that was materialised in the snapshot, it is
// opened without following links, size and total bytes are capped, a quote is matched with plain substring search over whitespace-normalised
// text (never a RegExp built from model text), and nothing outside the snapshot is ever read. A failed check is `unverified`, never an exception.
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Schema } from '../agents/json.ts';
import { cleanCommand } from '../context/facts.ts';
import { safeEntryName } from './snapshot.ts';
import type { SnapshotEntry } from './snapshot.ts';

export const EVIDENCE_LIMITS = Object.freeze({
  findings: 20, evidencePerFinding: 6, totalEvidence: 120, fileBytes: 512 * 1024, totalBytes: 8 * 1024 * 1024, quote: 300, minQuote: 12, lineSpan: 400, cpuMs: 2000,
  claim: 1000, summary: 2000, recommendation: 3000, limitations: 2000, risks: 12, risk: 400, steps: 15, step: 400, file: 300, lines: 40,
});

export type EvidenceState = 'verified' | 'unverified';
export interface Evidence { file: string; lines: string; quote: string; state: EvidenceState }
export type FindingStatus = 'verified' | 'partial' | 'unverified';
export interface CodeFinding { claim: string; status: FindingStatus; evidence: Evidence[] }
export interface CodeReport { summary: string; findings: CodeFinding[]; risks: string[]; recommendation: string; steps: string[]; limitations: string }

const str: Schema = { type: 'string' };
export const CODE_RESEARCH_SCHEMA: Schema = {
  type: 'object',
  required: ['summary', 'findings', 'risks', 'recommendation', 'steps', 'limitations'],
  properties: {
    summary: { ...str, description: 'three or four sentences' },
    findings: {
      type: 'array', maxItems: EVIDENCE_LIMITS.findings,
      items: {
        type: 'object', required: ['claim', 'evidence'],
        properties: {
          claim: str,
          evidence: {
            type: 'array', maxItems: EVIDENCE_LIMITS.evidencePerFinding,
            items: { type: 'object', required: ['file', 'lines', 'quote'], properties: { file: { ...str, description: 'repository-relative path' }, lines: { ...str, description: 'N or N-M (1-based); required' }, quote: { ...str, description: 'a short exact quote (12 to 300 characters) copied from those lines' } } },
          },
        },
      },
    },
    risks: { type: 'array', maxItems: EVIDENCE_LIMITS.risks, items: str },
    recommendation: str,
    steps: { type: 'array', maxItems: EVIDENCE_LIMITS.steps, items: str },
    limitations: { ...str, description: 'what could not be established from the snapshot, assumptions made' },
  },
};

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const own = (o: unknown, k: string): unknown => (o && typeof o === 'object' && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined);
const line = (v: unknown, n: number): string => cleanCommand(v).slice(0, n);
const block = (v: unknown, n: number): string => (typeof v === 'string' ? v.replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, '').slice(0, n) : '');
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** `N` or `N-M` (1-based, both whole numbers); '' = no range; null = malformed. */
export function parseLines(v: unknown): { start: number; end: number } | '' | null {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (s === '') return '';
  const m = /^([0-9]{1,7})(?:\s*-\s*([0-9]{1,7}))?$/.exec(s);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  return start >= 1 && end >= start ? { start, end } : null;
}

export interface EvidenceBudget { bytes: number; items: number; startedAt: number; now: () => number }
export const newBudget = (now: () => number = Date.now): EvidenceBudget => ({ bytes: 0, items: 0, startedAt: now(), now });

interface SnapshotLike { dir: string; index: Map<string, SnapshotEntry> }

/** One citation checked against the snapshot. Never throws, never reads outside `snap.dir`. */
export function verifyEvidence(snap: SnapshotLike, item: unknown, budget: EvidenceBudget): Evidence {
  const file = line(own(item, 'file'), EVIDENCE_LIMITS.file);
  const lines = line(own(item, 'lines'), EVIDENCE_LIMITS.lines);
  const quote = block(own(item, 'quote'), EVIDENCE_LIMITS.quote);
  const result = (ok: boolean): Evidence => ({ file, lines, quote, state: ok ? 'verified' : 'unverified' });
  try {
    if (budget.items >= EVIDENCE_LIMITS.totalEvidence || budget.now() - budget.startedAt > EVIDENCE_LIMITS.cpuMs) return result(false);
    budget.items++;
    const name = safeEntryName(file);
    if (!name || snap.index.get(name) !== 'file') return result(false); // only a committed regular file that was really materialised
    const range = parseLines(lines);
    if (range === null || range === '') return result(false); // a citation must name its lines: without them a short token would "verify" against any file
    const q = squash(quote);
    if (q.length < EVIDENCE_LIMITS.minQuote) return result(false);
    const root = realpathSync(snap.dir);
    const abs = join(snap.dir, name);
    const real = realpathSync(abs);
    if (!real.startsWith(root + sep)) return result(false);
    const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > EVIDENCE_LIMITS.fileBytes || budget.bytes + st.size > EVIDENCE_LIMITS.totalBytes) return result(false);
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const n = readSync(fd, buf, off, st.size - off, off);
        if (n <= 0) break;
        off += n;
      }
      budget.bytes += off;
      if (buf.subarray(0, Math.min(off, 8192)).includes(0)) return result(false); // binary
      text = buf.subarray(0, off).toString('utf8');
    } finally {
      closeSync(fd);
    }
    const all = text.split('\n');
    if (range.end > all.length || range.end - range.start + 1 > EVIDENCE_LIMITS.lineSpan) return result(false);
    const scope = all.slice(range.start - 1, range.end).join('\n');
    return result(squash(scope).includes(q));
  } catch {
    return result(false);
  }
}

/** The model's (schema-valid) JSON as a report whose evidence states were computed against the snapshot. Strings are capped and cleaned. */
export function buildCodeReport(raw: unknown, snap: SnapshotLike, now?: () => number): CodeReport {
  const budget = newBudget(now);
  const findings: CodeFinding[] = arr(own(raw, 'findings')).slice(0, EVIDENCE_LIMITS.findings).map((f) => {
    const evidence = arr(own(f, 'evidence')).slice(0, EVIDENCE_LIMITS.evidencePerFinding).map((e) => verifyEvidence(snap, e, budget));
    const ok = evidence.filter((e) => e.state === 'verified').length;
    const status: FindingStatus = evidence.length && ok === evidence.length ? 'verified' : ok > 0 ? 'partial' : 'unverified';
    return { claim: block(own(f, 'claim'), EVIDENCE_LIMITS.claim), status, evidence };
  });
  return {
    summary: block(own(raw, 'summary'), EVIDENCE_LIMITS.summary),
    findings,
    risks: arr(own(raw, 'risks')).slice(0, EVIDENCE_LIMITS.risks).map((x) => line(x, EVIDENCE_LIMITS.risk)),
    recommendation: block(own(raw, 'recommendation'), EVIDENCE_LIMITS.recommendation),
    steps: arr(own(raw, 'steps')).slice(0, EVIDENCE_LIMITS.steps).map((x) => line(x, EVIDENCE_LIMITS.step)),
    limitations: block(own(raw, 'limitations'), EVIDENCE_LIMITS.limitations),
  };
}

/** A stored code report from untrusted bytes (the file is same-user writable): shape, caps and states re-checked; null when it is not one. */
export function validateCodeReport(raw: unknown): CodeReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const states: readonly string[] = ['verified', 'unverified'];
  const statuses: readonly string[] = ['verified', 'partial', 'unverified'];
  const findings: CodeFinding[] = arr(own(raw, 'findings')).slice(0, EVIDENCE_LIMITS.findings).map((f) => {
    const evidence: Evidence[] = arr(own(f, 'evidence')).slice(0, EVIDENCE_LIMITS.evidencePerFinding).map((e) => ({
      file: line(own(e, 'file'), EVIDENCE_LIMITS.file), lines: line(own(e, 'lines'), EVIDENCE_LIMITS.lines), quote: block(own(e, 'quote'), EVIDENCE_LIMITS.quote),
      state: (states.includes(own(e, 'state') as string) ? own(e, 'state') : 'unverified') as EvidenceState,
    }));
    const st = own(f, 'status');
    return { claim: block(own(f, 'claim'), EVIDENCE_LIMITS.claim), status: (statuses.includes(st as string) ? st : 'unverified') as FindingStatus, evidence };
  });
  return {
    summary: block(own(raw, 'summary'), EVIDENCE_LIMITS.summary), findings,
    risks: arr(own(raw, 'risks')).slice(0, EVIDENCE_LIMITS.risks).map((x) => line(x, EVIDENCE_LIMITS.risk)),
    recommendation: block(own(raw, 'recommendation'), EVIDENCE_LIMITS.recommendation),
    steps: arr(own(raw, 'steps')).slice(0, EVIDENCE_LIMITS.steps).map((x) => line(x, EVIDENCE_LIMITS.step)),
    limitations: block(own(raw, 'limitations'), EVIDENCE_LIMITS.limitations),
  };
}
