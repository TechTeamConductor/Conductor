// Selection resolution (M8-2 §2.3, §2.9). PURE: no I/O, no spawn (S13). The shared contract with M8-3 (accounts) and M8-6 (home):
// one set of rules turns a stored role choice + a discovered catalog into the exact argv values for one tool. Never trusts that "accepted by
// PUT" means "safe for argv" (S8): every value is re-checked here at use (S19) and again by the argv helpers.
//
// Ids and labels are data: never used in a path, regex, shell string or HTML (S13). `cursorVariantId` returns an element of `family.ids`,
// never a newly built string.
import type { Config } from '../types.ts';
import type { CatalogView, CursorFamily, ModelEntry, ProviderId } from './types.ts';
import { modelIdOk } from './sanitize.ts';
import { parseCursorId } from './cursor-families.ts';
import { CLAUDE_EFFORTS, EFFORTS, EFFORT_LABEL, LEVEL_LABEL, RANK, defaultEntry, effortNote, fitEffort, levelsFor, type EffortToken } from './levels.ts';
import { claudeModelArgs, codexModelArgs, cursorModelArgs } from '../agents/model-args.ts';
import { PROVIDER_LABEL } from '../agents/providers/types.ts';
import { ROLE_LABEL, ROLES, selTool, type Role, type RoleModelSel } from '../agents/roles.ts';

export { fitEffort, levelsFor, selTool };

export interface ResolvedSel {
  tool: ProviderId;
  /** Exact argv value for --model (Cursor: a listed variant id); undefined ⇒ no model flag. */
  modelArg?: string;
  /** Claude --effort / Codex model_reasoning_effort; always undefined for Cursor (its effort lives in the id). A constant element. */
  effortArg?: EffortToken;
  /** Display: "Opus", "Tool default (Opus)", "GPT-5.3 Codex" — a cleaned catalog label or the id. */
  label: string;
  effort?: EffortToken;
  fast: boolean;
  thinking: boolean;
  source: 'role' | 'tool-default';
  /** The stored choice could not be used ⇒ the tool default was used. */
  fallback?: 'no-longer-offered' | 'list-unavailable' | 'not-in-list';
  /** Cursor "(NO ZDR)" — warn only (Q8). */
  noZdr?: true;
  /** One-line notes, static wording + cleaned labels/ids; shown in roleViews and as a run-timeline note (redacted before onEvent). */
  notes: string[];
}

/** N10: the seven Settings rows (row id → roles), in the §2.8 order. The UI writes the same choice to every role of a row; the server never mirrors. */
export const ROLE_ROWS: readonly { id: string; label: string; roles: readonly Role[] }[] = Object.freeze([
  { id: 'ask', label: 'Quick Ask', roles: ['context'] },
  { id: 'research', label: 'Deep Research', roles: ['research'] },
  { id: 'design', label: 'Design the work', roles: ['requirements', 'architecture'] },
  { id: 'plan', label: 'Write the plan', roles: ['planning'] },
  { id: 'review', label: 'Review the plan', roles: ['review'] },
  { id: 'build', label: 'Build the code', roles: ['implementation', 'debugging', 'documentation'] },
  { id: 'verify', label: 'Verify the result', roles: ['verification'] },
] as const);

/** S9: the static start of "Runs as …" — never the configured bin path. */
export const RUNS_AS_PREFIX: Readonly<Record<ProviderId, string>> = Object.freeze({ claude: 'claude', cursor: 'agent', codex: 'codex exec' });

const listed = (c: CatalogView | null | undefined): c is CatalogView & { models: ModelEntry[] } => !!c && (c.state === 'fresh' || c.state === 'stale') && Array.isArray(c.models);
const TOOL = (t: ProviderId): string => PROVIDER_LABEL[t];
/** Claude's `default` alias entry is what "Tool default" means: it is never a choosable model and never sent as `--model default` (CR-N1). Codex's default entry is a real model. */
const choosable = (tool: ProviderId, m: ModelEntry): boolean => !(tool === 'claude' && m.isDefault === true);

/** `{ model, custom }` from cfg.toolModels[tool]; {} if unset or not valid for that tool. Built from literals (S4d). */
export function toolDefaultSelection(cfg: Pick<Config, 'toolModels'> | { toolModels?: unknown }, tool: ProviderId): RoleModelSel {
  const tm = (cfg as { toolModels?: unknown }).toolModels;
  const e = tm && typeof tm === 'object' && Object.hasOwn(tm, tool) ? (tm as Record<string, unknown>)[tool] : undefined;
  if (!e || typeof e !== 'object') return {};
  const model = Object.hasOwn(e, 'model') ? (e as Record<string, unknown>).model : undefined;
  if (!modelIdOk(tool, model)) return {};
  return Object.hasOwn(e, 'custom') && (e as Record<string, unknown>).custom === true ? { model, custom: true } : { model };
}

/** What a provider runs with when no selection was passed (selfTest canaries, doctor, direct calls): the tool default, no catalog. */
export function toolDefaultResolved(cfg: Pick<Config, 'toolModels'>, tool: ProviderId): ResolvedSel {
  return resolveSelection(tool, toolDefaultSelection(cfg, tool), null, 'tool-default');
}

/** The role's own stored choice, as a plain RoleModelSel (literals only). */
function roleSel(cfg: Pick<Config, 'roles'>, role: Role): RoleModelSel {
  const r = cfg.roles?.[role];
  const out: RoleModelSel = {};
  if (!r) return out;
  if (r.tool) out.tool = r.tool;
  if (r.model) out.model = r.model;
  if (r.custom === true) out.custom = true;
  if (r.effort) out.effort = r.effort;
  if (r.fast === true) out.fast = true;
  if (r.thinking === true) out.thinking = true;
  return out;
}

/** The listed id whose parsed (thinking, effort, fast) tuple equals the request — a lookup, never concatenation (S13). */
export function cursorVariantId(family: CursorFamily, want: { thinking: boolean; effort: string; fast: boolean }): string | null {
  for (const id of family.ids) {
    const p = parseCursorId(id);
    if (p.family === family.family && p.thinking === want.thinking && p.effort === want.effort && p.fast === want.fast) return id;
  }
  return null;
}

/** The label "Tool default (…)" names: what the tool picks when Conductor sends no --model. */
export function defaultLabel(tool: ProviderId, catalog: CatalogView | null | undefined): string {
  if (!listed(catalog)) return 'the tool chooses';
  const d = defaultEntry(catalog);
  if (!d) return 'the tool chooses';
  if (tool === 'cursor') return d.label;
  if (d.resolved) {
    const alias = catalog.models.find((m) => !m.isDefault && (m.id === d.resolved || m.resolved === d.resolved));
    return alias ? alias.label : d.resolved;
  }
  return d.label;
}

interface ModelPick {
  model?: string;
  /** The bare model name (catalog label or id). */
  name: string;
  /** What `who` shows: the name, or "Tool default (name)". */
  label: string;
  levels: EffortToken[] | null;
  family?: CursorFamily;
  custom: boolean;
  noZdr?: boolean;
}
type PickOut = { ok: true; pick: ModelPick } | { ok: false; fallback: NonNullable<ResolvedSel['fallback']> | 'refused'; note: string };

/** Rules 2 and 3: find the model a choice names, or say why it cannot be used. */
function pickModel(tool: ProviderId, sel: RoleModelSel, cat: CatalogView | null | undefined): PickOut {
  const m = sel.model!;
  const T = TOOL(tool);
  if (!modelIdOk(tool, m)) return { ok: false, fallback: 'refused', note: `The ${T} model id was refused — using the tool default.` };
  if (sel.custom) {
    if (tool !== 'cursor') {
      const same = listed(cat) ? cat.models.find((e) => e.id === m && !e.isDefault) : undefined; // N11: shown as the discovered option
      return { ok: true, pick: { model: m, name: same ? same.label : m, label: same ? same.label : m, levels: levelsFor(tool, cat, { model: m, custom: true }), custom: true } };
    }
    // Cursor fails closed: the id must be one of the listed ids (S1, W4)
    if (!listed(cat)) return { ok: false, fallback: 'list-unavailable', note: `Cursor's model list is not available, so ${m} cannot be checked — using the tool default.` };
    const e = cat.models.find((x) => x.id === m);
    if (!e) return { ok: false, fallback: 'not-in-list', note: `${m} is not in Cursor's model list — using the tool default.` };
    return { ok: true, pick: { model: m, name: e.label, label: e.label, levels: null, custom: true, noZdr: e.noZdr === true } };
  }
  if (!listed(cat)) return { ok: false, fallback: 'list-unavailable', note: `${T}'s model list is not available, so ${m} cannot be used — using the tool default.` };
  const gone = cat.signedIn === false ? `${m} is not offered while ${T} is signed out — using the tool default.` : `${m} is no longer offered by ${T} — using the tool default.`;
  if (tool === 'cursor') {
    const fam = (cat.families ?? []).find((f) => f.family === m);
    if (!fam) return { ok: false, fallback: 'no-longer-offered', note: gone };
    return { ok: true, pick: { model: m, name: fam.label, label: fam.label, levels: levelsFor('cursor', cat, { model: m }), family: fam, custom: false, noZdr: fam.noZdr } };
  }
  const e = cat.models.find((x) => x.id === m && choosable(tool, x));
  if (!e) return { ok: false, fallback: 'no-longer-offered', note: gone };
  return { ok: true, pick: { model: m, name: e.label, label: e.label, levels: levelsFor(tool, cat, { model: m }), custom: false } };
}

/** Rule 1: the tool default (cfg.toolModels[tool] resolved by the same rules; unset ⇒ no --model). */
function pickDefault(tool: ProviderId, def: RoleModelSel | undefined, cat: CatalogView | null | undefined, notes: string[]): ModelPick {
  if (def?.model) {
    const r = pickModel(tool, def, cat);
    if (r.ok) return { ...r.pick, label: `Tool default (${r.pick.label})` };
    notes.push(`The default model for ${TOOL(tool)} could not be used (${r.fallback === 'refused' ? 'refused' : r.fallback.replace(/-/g, ' ')}) — ${TOOL(tool)} chooses.`);
  }
  return { name: defaultLabel(tool, cat), label: `Tool default (${defaultLabel(tool, cat)})`, levels: levelsFor(tool, cat, {}), custom: false };
}

const ALL_THINKING = (f: CursorFamily) => f.ids.every((id) => parseCursorId(id).thinking);
const ALL_FAST = (f: CursorFamily) => f.ids.every((id) => parseCursorId(id).fast);
const effortRank = (e: string): number => (e === '' ? RANK.medium : RANK[e as EffortToken] ?? RANK.medium);
const levelName = (e: string): string => (e === '' ? 'Default' : LEVEL_LABEL[e as EffortToken] ?? e);

/** Rule 4 at run time: the listed variant for the request, falling back fast → thinking → nearest effort, one note per step. */
function cursorCompose(fam: CursorFamily, effort: string, thinking: boolean, fast: boolean, notes: string[]): { id: string; effort: string; thinking: boolean; fast: boolean } {
  const t = thinking || ALL_THINKING(fam);
  const f = fast || ALL_FAST(fam);
  let id = cursorVariantId(fam, { thinking: t, effort, fast: f });
  if (id) return { id, effort, thinking: t, fast: f };
  if (f && !ALL_FAST(fam)) {
    id = cursorVariantId(fam, { thinking: t, effort, fast: false });
    notes.push(`${fam.label} has no Fast variant for this choice — Fast was dropped.`);
    if (id) return { id, effort, thinking: t, fast: false };
  }
  if (t && !ALL_THINKING(fam)) {
    id = cursorVariantId(fam, { thinking: false, effort, fast: false });
    notes.push(`${fam.label} has no Thinking variant for this choice — Thinking was dropped.`);
    if (id) return { id, effort, thinking: false, fast: false };
  }
  // (c) the nearest effort that exists without flags (or with the flags the family always carries)
  const parsed = fam.ids.map((x) => ({ x, p: parseCursorId(x) }));
  const pool = parsed.filter((c) => !c.p.fast || ALL_FAST(fam)).filter((c) => c.p.thinking === ALL_THINKING(fam) || ALL_THINKING(fam));
  const cands = pool.length ? pool : parsed;
  let best = cands[0]!;
  for (const c of cands) {
    const d = Math.abs(effortRank(c.p.effort) - effortRank(effort));
    const bd = Math.abs(effortRank(best.p.effort) - effortRank(effort));
    if (d < bd || (d === bd && effortRank(c.p.effort) > effortRank(best.p.effort))) best = c;
  }
  if (best.p.effort !== effort) notes.push(`${fam.label} has no ${levelName(effort)} variant — using ${levelName(best.p.effort)}.`);
  return { id: best.x, effort: best.p.effort, thinking: best.p.thinking, fast: best.p.fast };
}

/**
 * The exact values one tool will run with. `toolDefault` is cfg.toolModels[tool] (rule 1), used when `sel` names no model or its model
 * cannot be used. Applied in order: rules 1–3 (pick), 4 (Cursor composition), 5 (effort), 6 (flags), 7 (final gate, S1).
 */
export function resolveSelection(tool: ProviderId, sel: RoleModelSel, catalog: CatalogView | null, source: ResolvedSel['source'], toolDefault?: RoleModelSel): ResolvedSel {
  const notes: string[] = [];
  let fallback: ResolvedSel['fallback'];
  let pick: ModelPick;
  let usedDefault = false;
  if (sel.model) {
    const r = pickModel(tool, sel, catalog);
    if (r.ok) pick = source === 'tool-default' ? { ...r.pick, label: `Tool default (${r.pick.label})` } : r.pick;
    else {
      if (r.fallback !== 'refused') fallback = r.fallback;
      notes.push(r.note);
      pick = pickDefault(tool, source === 'tool-default' ? undefined : toolDefault, catalog, notes);
      usedDefault = true;
    }
  } else {
    pick = pickDefault(tool, toolDefault, catalog, notes);
    usedDefault = true;
  }
  // rule 6 (and N2): flags only for Cursor, only on the role's own choice, only if the family reports them
  const wantFast = sel.fast === true && !usedDefault;
  const wantThinking = sel.thinking === true && !usedDefault;
  if ((sel.fast === true || sel.thinking === true) && usedDefault && sel.model) notes.push('Fast/Thinking were dropped with the tool default.');
  let fast = false;
  let thinking = false;
  let modelArg: string | undefined;
  let effort: EffortToken | undefined;
  let effortArg: EffortToken | undefined;

  if (tool === 'cursor') {
    if (pick.family) {
      const fam = pick.family;
      const lv = pick.levels;
      const hasBase = fam.efforts.includes('');
      const fit = fitEffort(lv, sel.effort, { needsToken: !hasBase });
      if (fit.adjusted) notes.push(effortNote(tool, fam.label, sel.effort, fit.effort));
      if (wantFast && !fam.fast) notes.push(`${fam.label} has no Fast option — Fast was dropped.`);
      if (wantThinking && !fam.thinking) notes.push(`${fam.label} has no Thinking option — Thinking was dropped.`);
      const c = cursorCompose(fam, fit.effort ?? '', wantThinking && fam.thinking, wantFast && fam.fast, notes);
      modelArg = c.id;
      effort = EFFORTS.find((x) => x === c.effort);
      fast = c.fast;
      thinking = c.thinking;
    } else {
      // a Cursor custom id, or Cursor's own default: no effort, no flags
      if (sel.effort !== undefined) notes.push(effortNote(tool, pick.name, sel.effort, undefined));
      if (!usedDefault && (sel.fast || sel.thinking)) notes.push('Fast/Thinking do not apply to a custom Cursor model id — dropped.');
      modelArg = pick.model;
    }
  } else {
    if (!usedDefault && (sel.fast || sel.thinking)) notes.push(`Fast/Thinking are not offered for ${TOOL(tool)} here — dropped.`);
    const fit = fitEffort(pick.levels, sel.effort);
    if (fit.adjusted) notes.push(effortNote(tool, pick.name, sel.effort, fit.effort));
    effort = fit.effort;
    // S5: the argv token is the constant element, and Claude only ever gets what its CLI accepts
    effortArg = tool === 'claude' ? CLAUDE_EFFORTS.find((x) => x === fit.effort) : EFFORTS.find((x) => x === fit.effort);
    modelArg = pick.model;
  }

  // rule 7 — the final gate (S1, binding): the id rule always; for Cursor the id must be listed whatever its source
  if (modelArg !== undefined) {
    let refused = !modelIdOk(tool, modelArg);
    if (!refused && tool === 'cursor') refused = !(listed(catalog) && catalog.models.some((m) => m.id === modelArg));
    if (!refused && tool !== 'cursor' && !pick.custom) refused = !(listed(catalog) && catalog.models.some((m) => m.id === modelArg && choosable(tool, m)));
    if (refused) {
      notes.push(`The ${TOOL(tool)} model id was refused — ${TOOL(tool)} chooses.`);
      modelArg = undefined;
      if (tool === 'cursor') {
        effort = undefined;
        fast = false;
        thinking = false;
      }
    }
  }
  if (pick.noZdr) notes.push(`${pick.name} is marked "NO ZDR" by Cursor (no zero data retention).`);
  return {
    tool,
    ...(modelArg !== undefined ? { modelArg } : {}),
    ...(effortArg !== undefined ? { effortArg } : {}),
    label: pick.label,
    ...(effort !== undefined ? { effort } : {}),
    fast,
    thinking,
    source,
    ...(fallback ? { fallback } : {}),
    ...(pick.noZdr ? { noZdr: true as const } : {}),
    notes: [...new Set(notes)],
  };
}

/**
 * What `tool` runs with for `role` (B2 binding): the role's own choice only when it was made for this tool; any other tool gets its
 * default model with the role's effort fitted and no flags. `opts.toolDefaultOnly` (N4, server-only) ignores the role entirely.
 */
export function selectionForTool(role: Role, tool: ProviderId, cfg: Pick<Config, 'roles' | 'toolModels'>, catalog: CatalogView | null, opts: { toolDefaultOnly?: boolean } = {}): ResolvedSel {
  const def = toolDefaultSelection(cfg, tool);
  if (opts.toolDefaultOnly) return resolveSelection(tool, def, catalog, 'tool-default');
  const rs = roleSel(cfg, role);
  if (rs.tool && rs.tool === tool) return resolveSelection(tool, rs, catalog, 'role', def);
  const s: RoleModelSel = { ...def };
  if (rs.effort) s.effort = rs.effort;
  return resolveSelection(tool, s, catalog, 'tool-default');
}

/** B4 / §2.9 table: may this tool (with this catalog) run this choice? null = the list is unknown (counts as offering for ordering). */
export function modelOffered(tool: ProviderId, catalog: CatalogView | null, sel: RoleModelSel): true | false | null {
  if (!sel.model) return true;
  if (!modelIdOk(tool, sel.model)) return false;
  if (sel.custom && tool !== 'cursor') return true;
  if (!listed(catalog)) return null;
  if (tool === 'cursor') return sel.custom ? catalog.models.some((m) => m.id === sel.model) : (catalog.families ?? []).some((f) => f.family === sel.model);
  return catalog.models.some((m) => m.id === sel.model && choosable(tool, m));
}

/** "Runs as …" (S9): the static prefix + exactly the model-args helper output. A test pins it as a contiguous slice of the real argv. */
export function runsAs(tool: ProviderId, r: Pick<ResolvedSel, 'modelArg' | 'effortArg'>): string {
  const args = tool === 'claude' ? claudeModelArgs({ model: r.modelArg, effort: r.effortArg }) : tool === 'cursor' ? cursorModelArgs({ model: r.modelArg }) : codexModelArgs({ model: r.modelArg, effort: r.effortArg });
  return [RUNS_AS_PREFIX[tool], ...args].join(' ');
}

// ───────────────────────── judging a NEW choice (PUT / preview) ─────────────────────────
export interface SelProblem {
  key: 'model' | 'custom' | 'effort' | 'fast' | 'thinking';
  code: 'bad_request' | 'unknown_model' | 'models_unavailable' | 'effort_not_offered' | 'not_offered';
  message: string;
}

/**
 * Strict check of a new choice against `tool` and its current catalog (§2.6). Returns the first problem, or null. The same helpers as
 * resolution, but nothing is fitted: a missing variant or level is refused.
 */
export function judgeSelection(tool: ProviderId, sel: RoleModelSel, catalog: CatalogView | null): SelProblem | null {
  const T = TOOL(tool);
  if (sel.custom && !sel.model) return { key: 'custom', code: 'bad_request', message: 'custom needs a model id' };
  if (sel.model !== undefined) {
    if (!modelIdOk(tool, sel.model)) return { key: 'model', code: 'bad_request', message: `That is not a valid ${T} model id: letters or digits first, then letters, digits and . _ : / - (max 64)${tool === 'claude' ? ', optionally one [suffix] like [1m]' : ''}.` };
    if (sel.custom) {
      if (tool === 'cursor') {
        if (!listed(catalog)) return { key: 'model', code: 'models_unavailable', message: "Cursor's model list is not available — refresh models or choose Tool default." };
        if (!catalog.models.some((m) => m.id === sel.model)) return { key: 'model', code: 'unknown_model', message: `${sel.model} is not in Cursor's model list.` };
        if (sel.effort !== undefined) return { key: 'effort', code: 'bad_request', message: 'A custom Cursor model id carries its own effort — leave Model effort unset.' };
        if (sel.fast || sel.thinking) return { key: sel.fast ? 'fast' : 'thinking', code: 'bad_request', message: 'A custom Cursor model id carries its own options — leave Fast and Thinking off.' };
        return null;
      }
    } else {
      if (!listed(catalog)) return { key: 'model', code: 'models_unavailable', message: `${T}'s model list is not available — refresh models, choose Tool default or type a custom id.` };
      const ok = tool === 'cursor' ? (catalog.families ?? []).some((f) => f.family === sel.model) : catalog.models.some((m) => m.id === sel.model && choosable(tool, m));
      if (!ok) return { key: 'model', code: 'unknown_model', message: `${sel.model} is not offered by ${T}.` };
    }
  }
  if ((sel.fast || sel.thinking) && tool !== 'cursor') return { key: sel.fast ? 'fast' : 'thinking', code: 'not_offered', message: `${sel.fast ? 'Fast' : 'Thinking'} is not offered for ${T} here.` };
  if ((sel.fast || sel.thinking) && tool === 'cursor' && !sel.model) return { key: sel.fast ? 'fast' : 'thinking', code: 'not_offered', message: 'Fast and Thinking need a chosen Cursor model.' };
  const levels = levelsFor(tool, catalog, sel);
  if (sel.effort !== undefined && !(levels ?? []).includes(sel.effort)) return { key: 'effort', code: 'effort_not_offered', message: levels ? `${T} does not offer ${LEVEL_LABEL[sel.effort]} for this model.` : `This ${T} model has no effort setting${listed(catalog) ? '' : ' that Conductor can see (the model list is not available)'}.` };
  if (tool === 'cursor' && sel.model && !sel.custom && listed(catalog)) {
    const fam = (catalog.families ?? []).find((f) => f.family === sel.model)!;
    if (sel.fast && !fam.fast) return { key: 'fast', code: 'not_offered', message: `${fam.label} has no Fast option.` };
    if (sel.thinking && !fam.thinking) return { key: 'thinking', code: 'not_offered', message: `${fam.label} has no Thinking option.` };
    const fit = fitEffort(levels, sel.effort, { needsToken: !fam.efforts.includes('') });
    const want = { thinking: sel.thinking === true || ALL_THINKING(fam), effort: fit.effort ?? '', fast: sel.fast === true || ALL_FAST(fam) };
    if (!cursorVariantId(fam, want)) return { key: 'model', code: 'unknown_model', message: `Cursor does not list ${fam.label} with ${[levelName(want.effort), want.thinking ? 'Thinking' : 'no Thinking', want.fast ? 'Fast' : 'not Fast'].join(', ')}.` };
  }
  return null;
}

// ───────────────────────── views for GET /api/roles ─────────────────────────
export type RoleStatus = 'ok' | 'no-longer-available' | 'list-unavailable' | 'not-in-list' | 'other-tool' | 'signed-out';
export interface RoleView {
  tool: ProviderId;
  runsAs: string;
  who: string;
  status: RoleStatus;
  notes: string[];
}

export function whoLine(r: ResolvedSel): string {
  return [TOOL(r.tool), r.label, ...(r.effort ? [LEVEL_LABEL[r.effort]] : []), ...(r.thinking ? ['Thinking'] : []), ...(r.fast ? ['Fast'] : [])].join(' · ');
}

const sameSel = (a: RoleModelSel, b: RoleModelSel): boolean => a.tool === b.tool && a.model === b.model && !!a.custom === !!b.custom && a.effort === b.effort && !!a.fast === !!b.fast && !!a.thinking === !!b.thinking;

export function roleViews(cfg: Pick<Config, 'roles' | 'toolModels'>, catalog: (t: ProviderId) => CatalogView | null): Record<Role, RoleView> {
  const out = {} as Record<Role, RoleView>;
  for (const role of ROLES) {
    const rc = cfg.roles[role];
    const tool = selTool(role, rc.providers);
    const cat = catalog(tool);
    const r = selectionForTool(role, tool, cfg, cat);
    const rs = roleSel(cfg, role);
    const notes = [...r.notes];
    let status: RoleStatus = 'ok';
    if (rs.tool && rs.tool !== tool) {
      status = 'other-tool';
      notes.unshift(`Chosen for ${TOOL(rs.tool)}; ${TOOL(tool)} now leads, so ${TOOL(tool)}'s default model is used.`);
    } else if (r.fallback === 'no-longer-offered') status = listed(cat) && cat.signedIn === false ? 'signed-out' : 'no-longer-available';
    else if (r.fallback === 'list-unavailable') status = 'list-unavailable';
    else if (r.fallback === 'not-in-list') status = 'not-in-list';
    out[role] = { tool, runsAs: runsAs(tool, r), who: whoLine(r), status, notes };
  }
  // the row-level "differ" note has one owner (N10): on the row's first role
  for (const row of ROLE_ROWS) {
    const [first, ...rest] = row.roles;
    if (!first) continue;
    const a = cfg.roles[first];
    for (const other of rest) {
      const b = cfg.roles[other];
      const differ = a.providers.join(',') !== b.providers.join(',') || !sameSel(roleSel(cfg, first), roleSel(cfg, other));
      if (differ) out[first].notes.push(`${row.label} and ${ROLE_LABEL[other]} differ — saving applies this to all.`);
    }
  }
  return out;
}

export interface ModelsView {
  effortLabel: string;
  levels: { value: EffortToken; label: string }[];
  state: CatalogView['state'];
  refreshing: boolean;
  fetchedAt: number | null;
  reason?: string;
  defaultLabel: string;
  /** The levels "Tool default" offers (levelsFor with the tool default); null = no effort setting. */
  defaultEfforts: EffortToken[] | null;
  /** The levels a custom id offers (Claude/Codex: the union the tool reports; Cursor: null). */
  customEfforts: EffortToken[] | null;
  customEffortHint: string;
  options: { value: string; label: string; efforts: EffortToken[] | null; hasBase: boolean; fast: boolean; thinking: boolean; noZdr: boolean }[];
}

export function modelsView(tool: ProviderId, cat: CatalogView | null, opts: { toolDefault?: RoleModelSel; noCatalogReason?: string } = {}): ModelsView {
  const tokens = tool === 'claude' ? CLAUDE_EFFORTS : EFFORTS;
  const state = cat ? cat.state : 'unavailable';
  const reason = cat ? cat.reason : opts.noCatalogReason; // copied from the M8-1 view (already sanitised, S9) — never rebuilt from an error
  const def = opts.toolDefault?.model ? pickModel(tool, opts.toolDefault, cat) : null;
  const options: ModelsView['options'] = [];
  if (listed(cat)) {
    if (tool === 'cursor') {
      for (const f of cat.families ?? []) options.push({ value: f.family, label: f.label, efforts: levelsFor('cursor', cat, { model: f.family }), hasBase: f.efforts.includes(''), fast: f.fast, thinking: f.thinking, noZdr: f.noZdr });
    } else {
      // Claude's `default` alias entry is not listed: it is what "Tool default" means
      for (const m of cat.models) if (choosable(tool, m)) options.push({ value: m.id, label: m.label, efforts: levelsFor(tool, cat, { model: m.id }), hasBase: false, fast: false, thinking: false, noZdr: m.noZdr === true });
    }
  }
  return {
    effortLabel: EFFORT_LABEL[tool],
    levels: tokens.map((t) => ({ value: t, label: LEVEL_LABEL[t] })),
    state,
    refreshing: cat?.refreshing === true,
    fetchedAt: typeof cat?.fetchedAt === 'number' ? cat.fetchedAt : null,
    ...(reason ? { reason } : {}),
    defaultLabel: def && def.ok ? def.pick.label : defaultLabel(tool, cat),
    defaultEfforts: levelsFor(tool, cat, opts.toolDefault?.model ? opts.toolDefault : {}),
    customEfforts: levelsFor(tool, cat, { model: 'x', custom: true }),
    customEffortHint: 'With a custom model id, every level the tool reports is offered; the model may not support all of them.',
    options,
  };
}
