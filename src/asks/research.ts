// Deep Research (M5 mode C): web research by Claude with WEB TOOLS ONLY (no file tools, no repository), in an empty scratch directory.
// Citation integrity is structural: a finding counts as "opened" only if a cited URL was actually fetched in THIS session, taken from the
// tool events (never from model text or fetched page content); a URL that only appeared in search results is "listed"; everything else is
// an unverified claim. The model's own `verified` flag does not exist — Conductor computes the status after validating the report.
import type { Schema } from '../agents/json.ts';
import { cleanCommand } from '../context/facts.ts';

const str: Schema = { type: 'string' };
export const RESEARCH_SCHEMA: Schema = {
  type: 'object',
  required: ['summary', 'findings', 'alternatives', 'recommendation', 'steps', 'limitations'],
  properties: {
    summary: { ...str, description: 'three or four sentences' },
    findings: {
      type: 'array', maxItems: 30,
      items: { type: 'object', required: ['claim', 'sources'], properties: { claim: str, sources: { type: 'array', maxItems: 8, items: { type: 'object', required: ['url', 'title'], properties: { url: str, title: str, quote: str } } } } },
    },
    alternatives: { type: 'array', maxItems: 8, items: { type: 'object', required: ['name', 'pros', 'cons'], properties: { name: str, pros: { type: 'array', items: str }, cons: { type: 'array', items: str } } } },
    recommendation: str,
    steps: { type: 'array', maxItems: 15, items: str, description: 'concrete next steps, if this should become implementation work' },
    limitations: { ...str, description: 'what could not be established, assumptions made, sources that could not be opened' },
  },
};

const TRACKING = /^(utm_|fbclid$|gclid$|msclkid$|mc_cid$|mc_eid$)/i;
/** One normal form for URLs: http(s) only, no userinfo, host lower-cased, default port and fragment dropped, tracking parameters dropped, query sorted. */
export function normalizeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  u.hash = '';
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);
  return u.toString();
}

export type SourceState = 'opened' | 'listed' | 'unverified';
export interface ResearchSource { url: string; title: string; quote: string; state: SourceState }
export interface ResearchFinding { claim: string; status: 'opened' | 'listed' | 'unverified'; sources: ResearchSource[] }
export interface ResearchReport {
  summary: string;
  findings: ResearchFinding[];
  alternatives: { name: string; pros: string[]; cons: string[] }[];
  recommendation: string;
  steps: string[];
  limitations: string;
  /** Everything the session fetched / searched, from the tool events. */
  fetched: string[];
  searched: string[];
  /** M8-6 S14: the TRUE totals (the lists above stay capped at 100 / 50), so the UI can say "+N more not shown". */
  fetchedTotal?: number;
  searchedTotal?: number;
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const own = (o: unknown, k: string): unknown => (o && typeof o === 'object' && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined);
const line = (v: unknown, n: number): string => cleanCommand(v).slice(0, n);
const block = (v: unknown, n: number): string => (typeof v === 'string' ? v.replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, '').slice(0, n) : '');

/** Turn the model's (schema-valid) JSON into a report whose citation status Conductor computed from what was really opened. */
export function buildReport(raw: unknown, observed: { read: string[]; listed: string[]; queries: string[] }): ResearchReport {
  const read = new Set(observed.read.map(normalizeUrl).filter((x): x is string => !!x));
  const listed = new Set(observed.listed.map(normalizeUrl).filter((x): x is string => !!x));
  const findings: ResearchFinding[] = arr(own(raw, 'findings')).slice(0, 30).map((f) => {
    const sources: ResearchSource[] = arr(own(f, 'sources')).slice(0, 8).flatMap((s) => {
      const n = normalizeUrl(own(s, 'url'));
      if (!n) return []; // not http(s), has credentials, or unparseable: dropped
      return [{ url: n, title: line(own(s, 'title'), 200), quote: block(own(s, 'quote'), 400), state: (read.has(n) ? 'opened' : listed.has(n) ? 'listed' : 'unverified') as SourceState }];
    });
    const status = sources.some((x) => x.state === 'opened') ? 'opened' : sources.some((x) => x.state === 'listed') ? 'listed' : 'unverified';
    return { claim: block(own(f, 'claim'), 1000), status, sources };
  });
  return {
    summary: block(own(raw, 'summary'), 2000),
    findings,
    alternatives: arr(own(raw, 'alternatives')).slice(0, 8).map((a) => ({ name: line(own(a, 'name'), 120), pros: arr(own(a, 'pros')).slice(0, 8).map((x) => line(x, 300)), cons: arr(own(a, 'cons')).slice(0, 8).map((x) => line(x, 300)) })),
    recommendation: block(own(raw, 'recommendation'), 3000),
    steps: arr(own(raw, 'steps')).slice(0, 15).map((x) => line(x, 400)),
    limitations: block(own(raw, 'limitations'), 2000),
    fetched: [...read].slice(0, 100),
    searched: observed.queries.slice(0, 50).map((q) => line(q, 300)),
    fetchedTotal: read.size,
    searchedTotal: observed.queries.length,
  };
}

/** A stored report from untrusted bytes (the file is same-user writable): shape, caps, states re-checked. */
export function validateReport(raw: unknown): ResearchReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const states: readonly string[] = ['opened', 'listed', 'unverified'];
  const findings: ResearchFinding[] = arr(own(raw, 'findings')).slice(0, 30).map((f) => {
    const sources: ResearchSource[] = arr(own(f, 'sources')).slice(0, 8).flatMap((x) => {
      const n = normalizeUrl(own(x, 'url'));
      const st = own(x, 'state');
      return n ? [{ url: n, title: line(own(x, 'title'), 200), quote: block(own(x, 'quote'), 400), state: (states.includes(st as string) ? st : 'unverified') as SourceState }] : [];
    });
    const stt = own(f, 'status');
    return { claim: block(own(f, 'claim'), 1000), status: (states.includes(stt as string) ? stt : 'unverified') as ResearchFinding['status'], sources };
  });
  return {
    summary: block(own(raw, 'summary'), 2000), findings,
    alternatives: arr(own(raw, 'alternatives')).slice(0, 8).map((a) => ({ name: line(own(a, 'name'), 120), pros: arr(own(a, 'pros')).slice(0, 8).map((x) => line(x, 300)), cons: arr(own(a, 'cons')).slice(0, 8).map((x) => line(x, 300)) })),
    recommendation: block(own(raw, 'recommendation'), 3000), steps: arr(own(raw, 'steps')).slice(0, 15).map((x) => line(x, 400)), limitations: block(own(raw, 'limitations'), 2000),
    fetched: arr(own(raw, 'fetched')).map(normalizeUrl).filter((x): x is string => !!x).slice(0, 100), searched: arr(own(raw, 'searched')).slice(0, 50).map((q) => line(q, 300)),
    ...(typeof own(raw, 'fetchedTotal') === 'number' && Number.isInteger(own(raw, 'fetchedTotal')) && (own(raw, 'fetchedTotal') as number) >= 0 ? { fetchedTotal: Math.min(own(raw, 'fetchedTotal') as number, 1_000_000) } : {}),
    ...(typeof own(raw, 'searchedTotal') === 'number' && Number.isInteger(own(raw, 'searchedTotal')) && (own(raw, 'searchedTotal') as number) >= 0 ? { searchedTotal: Math.min(own(raw, 'searchedTotal') as number, 1_000_000) } : {}),
  };
}
