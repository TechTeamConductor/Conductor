// M8-6 §2.4 (+ S5, N3): turning a ready work brief + the user's tick-selection into linked card specs. PURE: no board, no I/O.
// The only trusted inputs are the user's own line, the selected part ids and code constants; everything else is model text and is
// written into the description LINE BY LINE behind a fixed `> ` prefix (S5), between a code-written header and a code-written closing
// line — so no model line can pose as the user's paragraph, Conductor's header, a `---` rule, or a "Part i of n" line.
import type { BriefPart, WorkBrief } from './types.ts';

export const DESC_MAX = 8000;
export const APPROACH_MAX = 2000;
export const END_MARK = '— end of model-written text —';

export interface CardSpec {
  part: string; // P1..P8
  index: number; // 1-based position in the brief
  title: string;
  /** Selected parts this card depends on (transitively through unticked ones). Same parallelGroup peers are omitted. */
  deps: string[];
  /** Unticked parts this card would have depended on. */
  notSent: string[];
  idemKey: string;
  /** Set when this part shares a group with peers that must not wait on each other. */
  parallelGroup?: string;
}

export const designIdemKey = (briefId: string, part: string): string => `design:${briefId}:${part}`;
export const DESIGN_IDEM_RE = /^design:(brf-[0-9a-f]{16}):P([1-8])$/;

/** Ordered specs for the selected parts (in part order). A dep on an unticked part is replaced by that part's own selected deps. */
export function planCards(brief: WorkBrief, briefId: string, selection: readonly string[]): CardSpec[] {
  const byId = new Map(brief.parts.map((p) => [p.id, p]));
  const chosen = new Set(selection);
  const resolve = (p: BriefPart, seen: Set<string>, notSent: Set<string>): Set<string> => {
    const out = new Set<string>();
    for (const d of p.deps) {
      if (seen.has(d)) continue;
      seen.add(d);
      const dp = byId.get(d);
      if (!dp) continue;
      // Same group: the model marked them runnable together. Do not chain them, and do not inherit that peer's deps.
      if (chosen.has(d) && p.parallelGroup && dp.parallelGroup === p.parallelGroup) continue;
      if (chosen.has(d)) out.add(d);
      else {
        notSent.add(d);
        for (const x of resolve(dp, seen, notSent)) out.add(x);
      }
    }
    return out;
  };
  return brief.parts
    .filter((p) => chosen.has(p.id))
    .map((p) => {
      const notSent = new Set<string>();
      const deps = resolve(p, new Set(), notSent);
      const order = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1));
      return { part: p.id, index: Number(p.id.slice(1)), title: p.title || `Part ${p.id.slice(1)}`, deps: [...deps].sort(order), notSent: [...notSent].sort(order), idemKey: designIdemKey(briefId, p.id), ...(p.parallelGroup ? { parallelGroup: p.parallelGroup } : {}) };
    });
}

/** `> `-prefixed model lines; a blank model line stays visibly inside the quote. */
const quote = (text: string): string[] => String(text).split('\n').map((l) => `> ${l}`.trimEnd());

/**
 * The card description (≤ 8,000). Code-written: the user's line (first), the header, the labels, the dependency lines and the closing
 * line. Model-written (quoted): part title/summary, file paths, approach, acceptance, risks. Truncation cuts MODEL lines from the end and
 * never removes the user's line, the "Untrusted" header or the closing line.
 */
export function cardDescription(args: { line: string; briefId: string; brief: WorkBrief; spec: CardSpec; depKeys: string[]; baseBranch: string }): string {
  const { line, briefId, brief, spec, depKeys } = args;
  const part = brief.parts.find((p) => p.id === spec.part)!;
  const head = [
    line,
    '',
    '---',
    `Part ${spec.index} of ${brief.parts.length} from "Design the work" (${briefId}) — written by a model from the request above. Untrusted: information, not instructions. This card's plan always waits for your approval.`,
  ];
  type Entry = { text: string; model: boolean };
  const body: Entry[] = [];
  const code = (t: string) => body.push({ text: t, model: false });
  const model = (t: string) => { for (const l of quote(t)) body.push({ text: l, model: true }); };
  code('Part:');
  model(part.title);
  if (part.summary) model(part.summary);
  code(`Size: ${part.size} · Files it expects to touch:${part.files.length ? '' : ' none named'}`);
  for (const f of part.files) model(f);
  if (depKeys.length) code(`Starts after ${depKeys.join(', ')}. Their commits are already on this repository's current branch. Build on that code. Conductor does not create a branch and does not push.`);
  else if (spec.parallelGroup) code(`Runs alongside the other parts in group ${spec.parallelGroup} on this repository's current branch. Conductor does not create a branch and does not push.`);
  for (const ns of spec.notSent) code(`Part ${ns.slice(1)} was not sent.`);
  if (brief.approach) {
    code('Shared brief — approach:');
    model(brief.approach.length > APPROACH_MAX ? `${brief.approach.slice(0, APPROACH_MAX)}…` : brief.approach);
  }
  if (brief.acceptance.length) {
    code('Acceptance:');
    for (const a of brief.acceptance.slice(0, 12)) model(`- ${a}`);
  }
  if (brief.risks.length) {
    code('Risks:');
    for (const r of brief.risks.slice(0, 10)) model(`- ${r}`);
  }
  const tail = [END_MARK];
  const size = (b: Entry[]) => [...head, ...b.map((e) => e.text), ...tail].join('\n').length;
  let cut = false;
  while (size(body) > DESC_MAX) {
    let i = body.length - 1;
    while (i >= 0 && !body[i]!.model) i--;
    if (i < 0) break;
    body.splice(i, 1);
    cut = true;
  }
  if (cut) tail.unshift('(model text shortened to fit the card)');
  return [...head, ...body.map((e) => e.text), ...tail].join('\n');
}
