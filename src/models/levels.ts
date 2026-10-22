// Effort levels, fitting and wording (M8-2 §2.2). PURE: no I/O, no spawn (S13). Levels are exactly what the tool reported (M8-1
// discovery); nothing here invents a level. Labels from a catalog are already cleaned by M8-1; this module only adds static wording.
import type { CatalogView, ModelEntry, ProviderId } from './types.ts';
import { EFFORT_TOKENS } from './sanitize.ts';

export type EffortToken = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** The typed copy of M8-1's EFFORT_TOKENS (N14: a unit test checks both are the same set, in the same order). */
export const EFFORTS: readonly EffortToken[] = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly EffortToken[]);
/** S5: the only efforts `claude --effort` accepts (from `claude --help`, 2.1.304). `none`/`minimal` are never sent to Claude. */
export const CLAUDE_EFFORTS: readonly EffortToken[] = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly EffortToken[]);

export const EFFORT_LABEL: Readonly<Record<ProviderId, string>> = Object.freeze({ claude: 'Effort', codex: 'Reasoning effort', cursor: 'Model effort' });
export const LEVEL_LABEL: Readonly<Record<EffortToken, string>> = Object.freeze({ none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' });
export const RANK: Readonly<Record<EffortToken, number>> = Object.freeze({ none: -1, minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 });

export const isEffort = (x: unknown): x is EffortToken => typeof x === 'string' && (EFFORTS as readonly string[]).includes(x);
/** The constant element for a token (never the caller's string — S5). */
export const effortConst = (x: unknown): EffortToken | undefined => EFFORTS.find((t) => t === x);
/** Sanity check against M8-1's list (used by the N14 test; returns true when the two lists agree). */
export const effortsMatchDiscovery = (): boolean => EFFORTS.length === EFFORT_TOKENS.length && EFFORTS.every((t, i) => EFFORT_TOKENS[i] === t);

/** Constant-only, canonical order, de-duplicated. Claude is further limited to what its CLI accepts (S5). */
function canon(tool: ProviderId, xs: readonly string[] | undefined): EffortToken[] | null {
  if (!xs || !xs.length) return null;
  const allowed = tool === 'claude' ? CLAUDE_EFFORTS : EFFORTS;
  const out = allowed.filter((t) => xs.includes(t));
  return out.length ? [...out] : null;
}

const listed = (c: CatalogView | null | undefined): c is CatalogView & { models: ModelEntry[] } => !!c && (c.state === 'fresh' || c.state === 'stale') && Array.isArray(c.models);

/** The model entry "Tool default" means for Claude/Codex: Claude's `default` alias (or Codex's server default). */
export function defaultEntry(catalog: CatalogView | null | undefined): ModelEntry | undefined {
  if (!listed(catalog)) return undefined;
  return catalog.models.find((m) => m.isDefault === true);
}

export interface LevelsSel {
  model?: string;
  custom?: true;
}

/**
 * Exactly the discovered levels for this selection, or null ("this model has no effort setting" ⇒ no flag).
 *  - Claude/Codex discovered: the entry's levels; tool default (no model): the default entry's levels; custom: the union over the catalog.
 *  - Cursor family: its effort tokens minus '' (the base id); custom ids / tool default / families without tokens: null.
 */
export function levelsFor(tool: ProviderId, catalog: CatalogView | null | undefined, sel: LevelsSel): EffortToken[] | null {
  if (!listed(catalog)) return null;
  if (tool === 'cursor') {
    if (!sel.model || sel.custom) return null;
    const fam = (catalog.families ?? []).find((f) => f.family === sel.model);
    return fam ? canon(tool, fam.efforts.filter((e) => e !== '')) : null;
  }
  if (!sel.model) return canon(tool, defaultEntry(catalog)?.efforts);
  if (sel.custom) {
    const all = new Set<string>();
    for (const m of catalog.models) for (const e of m.efforts ?? []) all.add(e);
    return canon(tool, [...all]);
  }
  const e = catalog.models.find((m) => m.id === sel.model);
  return e ? canon(tool, e.efforts) : null;
}

/**
 * Fit a wished effort to the levels on offer (plain strings at the boundary — the M8-3 contract — validated inside).
 *  - levels null ⇒ no effort; adjusted iff something was wished;
 *  - wished and offered ⇒ kept; nothing wished ⇒ stays unset (argv byte-identical), unless `needsToken` (a Cursor family with no base id)
 *    — then it fits toward `medium` without counting as an adjustment;
 *  - otherwise the nearest level by RANK, a tie going to the higher one.
 */
export function fitEffort(levels: readonly string[] | null, wanted?: string, opts: { needsToken?: boolean } = {}): { effort?: EffortToken; adjusted: boolean } {
  const lv = levels ? EFFORTS.filter((t) => levels.includes(t)) : null;
  const w = effortConst(wanted);
  if (!lv || !lv.length) return { effort: undefined, adjusted: w !== undefined };
  if (w === undefined) {
    if (!opts.needsToken) return { effort: undefined, adjusted: false };
    return { effort: nearest(lv, 'medium'), adjusted: false };
  }
  if (lv.includes(w)) return { effort: w, adjusted: false };
  return { effort: nearest(lv, w), adjusted: true };
}

function nearest(lv: readonly EffortToken[], w: EffortToken): EffortToken {
  let best = lv[0]!;
  let bestD = Infinity;
  for (const t of lv) {
    const d = Math.abs(RANK[t] - RANK[w]);
    if (d < bestD || (d === bestD && RANK[t] > RANK[best])) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

/** One line, static wording + a cleaned label: "Sonnet 4.6 has no Extra high, so the effort is now Max." */
export function effortNote(tool: ProviderId, modelLabel: string, from: string | undefined, to: EffortToken | undefined): string {
  const f = effortConst(from);
  void tool;
  if (to === undefined) return `${modelLabel} has no effort setting.`;
  return `${modelLabel} has no ${f ? LEVEL_LABEL[f] : 'such level'}, so the effort is now ${LEVEL_LABEL[to]}.`;
}
