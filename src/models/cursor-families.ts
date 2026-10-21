// Cursor model families (M8-1 §2.4), pure. Cursor lists every variant as its own id (`<family>-high-fast`); the UI groups them.
// Parsing is right to left: optional `-fast`, optional effort token, optional `-thinking`; the rest is the family. No id is ever
// dropped by grouping (a test pins: union of family ids = input ids). Composition/lookup for argv is M8-2 (S19: the composed id must
// exist in `ids`).
import type { CursorFamily, ModelEntry } from './types.ts';
import { EFFORT_TOKENS, cleanText, LABEL_MAX } from './sanitize.ts';

export interface ParsedCursorId {
  family: string;
  thinking: boolean;
  /** '' = no effort token (the family's own default effort). */
  effort: string;
  fast: boolean;
}

/** Pure, total: every id parses (an id with no recognised suffix is its own family). */
export function parseCursorId(id: string): ParsedCursorId {
  let rest = id;
  let fast = false;
  let effort = '';
  let thinking = false;
  if (rest.endsWith('-fast') && rest.length > 5) {
    fast = true;
    rest = rest.slice(0, -5);
  }
  const dash = rest.lastIndexOf('-');
  if (dash > 0) {
    const tok = rest.slice(dash + 1);
    if (EFFORT_TOKENS.includes(tok)) {
      effort = tok;
      rest = rest.slice(0, dash);
    }
  }
  if (rest.endsWith('-thinking') && rest.length > 9) {
    thinking = true;
    rest = rest.slice(0, -9);
  }
  return { family: rest, thinking, effort, fast };
}

const VARIANT_WORDS = /\b(?:extra high|none|minimal|low|medium|high|xhigh|max|fast|thinking)\b/gi;

/** Group a cleaned Cursor list into families. Input order of families follows the first listed id of each. */
export function cursorFamilies(models: readonly ModelEntry[]): CursorFamily[] {
  const groups = new Map<string, { ids: string[]; parsed: ParsedCursorId[]; labels: string[]; noZdr: boolean; baseLabel?: string }>();
  for (const m of models) {
    const p = parseCursorId(m.id);
    let g = groups.get(p.family);
    if (!g) {
      g = { ids: [], parsed: [], labels: [], noZdr: false };
      groups.set(p.family, g);
    }
    g.ids.push(m.id);
    g.parsed.push(p);
    g.labels.push(m.label);
    if (m.noZdr) g.noZdr = true;
    if (m.id === p.family) g.baseLabel = m.label;
  }
  const out: CursorFamily[] = [];
  for (const [family, g] of groups) {
    const seen = new Set(g.parsed.map((p) => p.effort));
    const efforts = ['', ...EFFORT_TOKENS].filter((t) => seen.has(t));
    let label = g.baseLabel;
    if (!label) {
      const stripped = g.labels.map((l) => cleanText(l.replace(VARIANT_WORDS, ' '), LABEL_MAX)).filter(Boolean);
      label = stripped.sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))[0] ?? family;
    }
    out.push({
      family,
      efforts,
      thinking: g.parsed.some((p) => p.thinking),
      fast: g.parsed.some((p) => p.fast),
      label,
      noZdr: g.noZdr,
      ids: [...g.ids],
    });
  }
  return out;
}
