// PUT /api/roles and POST /api/roles/preview share ONE pure planning function (M8-2 §2.6, Security S2): it works on a deep copy of the
// config's roles and toolModels and returns the next state; PUT = plan + save, preview = plan only. It never saves, never backs up, never
// refreshes a model list, never notes an unknown model, never resolves a binary, never spawns: catalogs come in as a synchronous lookup.
//
// Strict shape (S8): allow-lists by iterating Object.keys; `__proto__`/`constructor`/`prototype` are never role, key or tool names; `field`
// only ever holds allow-listed names (an unknown key appears only in the message, as JSON.stringify(key.slice(0, 30))).
import type { ApiRoleEntry, Config, ProviderId } from '../types.ts';
import type { CatalogView } from '../models/types.ts';
import { COMPLEXITIES, ROLES, isComplexity, isRole, normalizeRoles, selTool, type Role, type RoleConfig, type RoleModelSel, type Roles } from '../agents/roles.ts';
import { validatePairing, type States } from '../agents/routing.ts';
import { PROVIDER_IDS, isProviderId, providerLabel } from '../agents/providers/registry.ts';
import { isEffort, LEVEL_LABEL, type EffortToken } from '../models/levels.ts';
import { modelIdOk } from '../models/sanitize.ts';
import { fitEffort, judgeSelection, levelsFor, resolveSelection, toolDefaultSelection } from '../models/select.ts';
import { ROLE_LABEL } from '../agents/roles.ts';

export const TOP_KEYS = ['roles', 'toolModels', 'acknowledge'] as const;
export const ENTRY_KEYS = ['providers', 'autoByComplexity', 'tool', 'model', 'custom', 'effort', 'fast', 'thinking'] as const;
export const TOOL_MODEL_KEYS = ['model', 'custom'] as const;
const SEL_KEYS = ['model', 'custom', 'effort', 'fast', 'thinking'] as const;

export interface PlanProblem {
  status: number;
  code: string;
  /** Allow-listed names only: "roles.<role>.<key>", "toolModels.<tool>.model", "roles", "toolModels", "acknowledge", "body". */
  field: string;
  message: string;
}
/** A refusal. In PUT mode every problem is one; in preview only a malformed body (wrong types / unknown keys) is. */
export class RolesPlanError extends Error {
  status: number;
  code: string;
  field: string;
  constructor(p: PlanProblem) {
    super(p.message);
    this.name = 'RolesPlanError';
    this.status = p.status;
    this.code = p.code;
    this.field = p.field;
  }
}

export interface PlanInput {
  body: unknown;
  cfg: Config;
  states: States;
  catalog: (tool: ProviderId) => CatalogView | null;
  mode: 'put' | 'preview';
  /** The fixed "what leaves this machine" line per provider (a notice when a provider newly joins a role). */
  egress: (id: ProviderId) => string;
}
export interface PlanOutput {
  roles: Roles;
  toolModels: Config['toolModels'];
  notices: string[];
  problems: PlanProblem[];
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const q = (k: string) => JSON.stringify(k.slice(0, 30));
function bad(field: string, message: string): never {
  throw new RolesPlanError({ status: 400, code: 'bad_request', field, message });
}

/** GET form of one role entry: every PUT-accepted key, always present (R2-N4). */
export function apiRoleEntry(rc: RoleConfig): ApiRoleEntry {
  return {
    providers: [...rc.providers],
    autoByComplexity: rc.autoByComplexity ? { ...rc.autoByComplexity } : null,
    tool: rc.tool ?? null,
    model: rc.model ?? null,
    custom: rc.custom === true,
    effort: rc.effort ?? null,
    fast: rc.fast === true,
    thinking: rc.thinking === true,
  };
}
export function apiRolesForm(roles: Roles): Record<Role, ApiRoleEntry> {
  const out = {} as Record<Role, ApiRoleEntry>;
  for (const r of ROLES) out[r] = apiRoleEntry(roles[r]);
  return out;
}
export function apiToolModels(tm: Config['toolModels']): Record<ProviderId, { model: string | null; custom: boolean }> {
  const out = {} as Record<ProviderId, { model: string | null; custom: boolean }>;
  for (const t of PROVIDER_IDS) out[t] = { model: tm[t]?.model ?? null, custom: tm[t]?.custom === true };
  return out;
}

/** The body's raw model fields for one entry, type-checked (a wrong type is malformed in both modes). */
interface RawSel {
  tool?: ProviderId | null;
  model?: string | null;
  custom?: boolean | null;
  effort?: EffortToken | null;
  fast?: boolean | null;
  thinking?: boolean | null;
}
function readRawSel(role: Role, raw: Record<string, unknown>): RawSel {
  const f = (k: string) => `roles.${role}.${k}`;
  const out: RawSel = {};
  if (Object.hasOwn(raw, 'tool')) {
    const v = raw.tool;
    if (v !== null && !isProviderId(v)) bad(f('tool'), `Role "${role}": "tool" must be a provider id or null.`);
    out.tool = v as ProviderId | null;
  }
  if (Object.hasOwn(raw, 'model')) {
    const v = raw.model;
    if (v !== null && typeof v !== 'string') bad(f('model'), `Role "${role}": "model" must be a string or null.`);
    out.model = v as string | null;
  }
  if (Object.hasOwn(raw, 'custom')) {
    const v = raw.custom;
    if (v !== null && typeof v !== 'boolean') bad(f('custom'), `Role "${role}": "custom" must be true or false.`);
    out.custom = v as boolean | null;
  }
  if (Object.hasOwn(raw, 'effort')) {
    const v = raw.effort;
    if (v !== null && !isEffort(v)) bad(f('effort'), `Role "${role}": "effort" must be one of none, minimal, low, medium, high, xhigh, max, or null.`);
    out.effort = v as EffortToken | null;
  }
  for (const k of ['fast', 'thinking'] as const) {
    if (!Object.hasOwn(raw, k)) continue;
    const v = raw[k];
    if (v !== null && typeof v !== 'boolean') bad(f(k), `Role "${role}": "${k}" must be true, false or null.`);
    out[k] = v as boolean | null;
  }
  if (out.custom === true && typeof out.model !== 'string') bad(f('custom'), `Role "${role}": "custom" needs a model id.`);
  return out;
}

/** Absent ⇒ the stored value; null/false ⇒ unset (B1a). The result carries no `tool` (it is server-derived). */
function mergeSel(stored: RoleModelSel, raw: RawSel): RoleModelSel {
  const out: RoleModelSel = {};
  const model = raw.model === undefined ? stored.model : raw.model ?? undefined;
  if (model !== undefined) out.model = model;
  const custom = raw.custom === undefined ? stored.custom === true : raw.custom === true;
  if (custom && out.model !== undefined) out.custom = true;
  const effort = raw.effort === undefined ? stored.effort : raw.effort ?? undefined;
  if (effort !== undefined) out.effort = effort;
  if (raw.fast === undefined ? stored.fast === true : raw.fast === true) out.fast = true;
  if (raw.thinking === undefined ? stored.thinking === true : raw.thinking === true) out.thinking = true;
  return out;
}
const storedSel = (rc: RoleConfig): RoleModelSel => {
  const s: RoleModelSel = {};
  if (rc.model !== undefined) s.model = rc.model;
  if (rc.custom === true) s.custom = true;
  if (rc.effort !== undefined) s.effort = rc.effort;
  if (rc.fast === true) s.fast = true;
  if (rc.thinking === true) s.thinking = true;
  return s;
};
const sameModelFields = (a: RoleModelSel, b: RoleModelSel) => a.model === b.model && !!a.custom === !!b.custom && !!a.fast === !!b.fast && !!a.thinking === !!b.thinking;
const hasModelFields = (s: RoleModelSel) => s.model !== undefined || s.fast === true || s.thinking === true;

/** Write a selection onto an entry built from literals; `tool` only when a model field is set (§2.1: only set fields on disk). */
function applySel(entry: RoleConfig, sel: RoleModelSel, tool: ProviderId): void {
  if (sel.model !== undefined) entry.model = sel.model;
  if (sel.custom === true && sel.model !== undefined) entry.custom = true;
  if (sel.effort !== undefined) entry.effort = sel.effort;
  if (sel.fast === true) entry.fast = true;
  if (sel.thinking === true) entry.thinking = true;
  if (hasModelFields(sel)) entry.tool = tool;
}

export function planRoles(i: PlanInput): PlanOutput {
  const { cfg, states, mode } = i;
  const problems: PlanProblem[] = [];
  const notices: string[] = [];
  /** PUT: the first problem is the refusal. Preview: collect it and carry on with a fitted draft. */
  const problem = (p: PlanProblem): void => {
    if (mode === 'put') throw new RolesPlanError(p);
    problems.push(p);
  };
  const body = i.body;
  if (!isPlain(body)) bad('body', 'The request body must be an object.');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!(TOP_KEYS as readonly string[]).includes(k)) bad('body', `Unknown key ${q(k)}.`);
  if (!Object.hasOwn(b, 'roles') && !Object.hasOwn(b, 'toolModels')) bad('body', 'Send "roles", "toolModels" or both.');
  if (Object.hasOwn(b, 'roles') && !isPlain(b.roles)) bad('roles', '"roles" must be an object.');
  if (Object.hasOwn(b, 'toolModels') && !isPlain(b.toolModels)) bad('toolModels', '"toolModels" must be an object.');
  const ack = new Set<string>();
  if (b.acknowledge !== undefined) {
    if (!Array.isArray(b.acknowledge) || b.acknowledge.length > 8 || !b.acknowledge.every((x) => typeof x === 'string')) bad('acknowledge', '"acknowledge" must be a short list of provider ids.');
    for (const a of b.acknowledge as string[]) ack.add(a);
  }

  // ── shape first (malformed ⇒ 400 in both modes, before anything is judged) ──
  const bodyRoles = (isPlain(b.roles) ? b.roles : {}) as Record<string, unknown>;
  const rawSels = new Map<Role, RawSel>();
  for (const role of Object.keys(bodyRoles)) {
    if (!isRole(role)) bad('roles', `Unknown role ${q(role)}.`);
    const raw = bodyRoles[role];
    if (!isPlain(raw)) bad(`roles.${role}`, `Role "${role}" must be an object.`);
    const r = raw as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!(ENTRY_KEYS as readonly string[]).includes(k)) bad(`roles.${role}`, `Role "${role}": unknown key ${q(k)}.`);
    if (!Array.isArray(r.providers) || r.providers.length === 0 || r.providers.length > 4) bad(`roles.${role}.providers`, `Role "${role}" needs 1–4 providers.`);
    for (const p of r.providers as unknown[]) if (!isProviderId(p)) bad(`roles.${role}.providers`, `Role "${role}": unknown provider.`);
    if (r.autoByComplexity !== undefined && r.autoByComplexity !== null) {
      if (!isPlain(r.autoByComplexity)) bad(`roles.${role}.autoByComplexity`, `Role "${role}": "autoByComplexity" must be an object or null.`);
      for (const k of Object.keys(r.autoByComplexity as object)) {
        if (!isComplexity(k)) bad(`roles.${role}.autoByComplexity`, `Role "${role}": complexity must be one of ${COMPLEXITIES.join(', ')}.`);
        if (!isProviderId((r.autoByComplexity as Record<string, unknown>)[k])) bad(`roles.${role}.autoByComplexity`, `Role "${role}" (${k}): unknown provider.`);
      }
    }
    rawSels.set(role, readRawSel(role, r));
  }
  const bodyTM = (isPlain(b.toolModels) ? b.toolModels : {}) as Record<string, unknown>;
  for (const t of Object.keys(bodyTM)) {
    if (!isProviderId(t)) bad('toolModels', `Unknown tool ${q(t)}.`);
    const e = bodyTM[t];
    if (e === null) continue;
    if (!isPlain(e)) bad(`toolModels.${t}`, `toolModels.${t} must be an object or null.`);
    for (const k of Object.keys(e as object)) if (!(TOOL_MODEL_KEYS as readonly string[]).includes(k)) bad(`toolModels.${t}`, `toolModels.${t}: unknown key ${q(k)}.`);
    const m = (e as Record<string, unknown>).model;
    const c = (e as Record<string, unknown>).custom;
    if (m !== undefined && m !== null && typeof m !== 'string') bad(`toolModels.${t}.model`, `toolModels.${t}.model must be a string or null.`);
    if (c !== undefined && c !== null && typeof c !== 'boolean') bad(`toolModels.${t}.custom`, `toolModels.${t}.custom must be true or false.`);
    if (c === true && typeof m !== 'string') bad(`toolModels.${t}.custom`, `toolModels.${t}.custom needs a model id.`);
  }

  // ── tool defaults (judged first: role effort fitting uses the NEW defaults) ──
  const nextTM: Config['toolModels'] = JSON.parse(JSON.stringify(cfg.toolModels ?? {}));
  for (const t of Object.keys(bodyTM) as ProviderId[]) {
    const e = bodyTM[t] as Record<string, unknown> | null;
    const m = e ? e.model : null;
    if (m === null || m === undefined) {
      delete nextTM[t];
      continue;
    }
    const want: RoleModelSel = e!.custom === true ? { model: m as string, custom: true } : { model: m as string };
    const cur = cfg.toolModels?.[t];
    if (cur && cur.model === want.model && !!cur.custom === !!want.custom) continue; // unchanged: not re-judged
    const p = judgeSelection(t, want, i.catalog(t));
    if (p) {
      problem({ status: 400, code: p.code, field: `toolModels.${t}.model`, message: p.message });
      continue; // preview: the draft keeps the stored default
    }
    nextTM[t] = want.custom ? { model: want.model!, custom: true } : { model: want.model! };
  }
  const cfgTM = { toolModels: nextTM };

  // ── roles ──
  const next: Roles = JSON.parse(JSON.stringify(cfg.roles));
  for (const role of Object.keys(bodyRoles) as Role[]) {
    const raw = bodyRoles[role] as Record<string, unknown>;
    const stored = cfg.roles[role];
    const entry: RoleConfig = { providers: [] };
    // providers (as before M8-2): unchanged entries are not re-judged; new ones pass the pairing gate, unverified ones need an ack
    for (const p of raw.providers as ProviderId[]) {
      if (!stored.providers.includes(p)) {
        const v = validatePairing(role, p, states, providerLabel);
        if (!v.ok) {
          problem({ status: 400, code: 'unsupported_pairing', field: `roles.${role}.providers`, message: v.reason });
          continue;
        }
        if (states[p].tier === 'unverified' && !ack.has(p)) problem({ status: 409, code: 'needs_acknowledgement', field: `roles.${role}.providers`, message: `${providerLabel(p)}'s isolation has not been verified on this machine. Send "acknowledge": ["${p}"] to use it for ${role} anyway.` });
      }
      if (!entry.providers.includes(p)) entry.providers.push(p);
    }
    if (!entry.providers.length) entry.providers = [...stored.providers];
    // autoByComplexity: absent ⇒ keep; null ⇒ clear; an object replaces it
    if (raw.autoByComplexity === undefined) {
      if (stored.autoByComplexity) entry.autoByComplexity = { ...stored.autoByComplexity };
    } else if (raw.autoByComplexity !== null) {
      const picks: NonNullable<RoleConfig['autoByComplexity']> = {};
      const abc = raw.autoByComplexity as Record<string, ProviderId>;
      for (const k of Object.keys(abc) as ('S' | 'M' | 'L')[]) {
        const p = abc[k]!;
        if (stored.autoByComplexity?.[k] !== p) {
          const v = validatePairing(role, p, states, providerLabel);
          if (!v.ok) {
            problem({ status: 400, code: 'unsupported_pairing', field: `roles.${role}.autoByComplexity`, message: v.reason });
            continue;
          }
          if (states[p].tier === 'unverified' && !stored.providers.includes(p) && !ack.has(p)) problem({ status: 409, code: 'needs_acknowledgement', field: `roles.${role}.autoByComplexity`, message: `${providerLabel(p)}'s isolation has not been verified on this machine. Send "acknowledge": ["${p}"] to use it for ${role} anyway.` });
        }
        picks[k] = p;
      }
      if (Object.keys(picks).length) entry.autoByComplexity = picks;
    }
    for (const id of entry.providers) if (!stored.providers.includes(id)) notices.push(`${providerLabel(id)} → ${role}: ${i.egress(id)}`);

    planSelection(role, stored, entry, rawSels.get(role)!, cfgTM, i, problem, notices);
    next[role] = entry;
  }

  // the load-time shape/capability filter runs again (silently: nothing is logged from a plan)
  const roles = normalizeRoles(next, () => undefined);
  return { roles, toolModels: nextTM, notices: [...new Set(notices)], problems };
}

/** §2f B1(b): unchanged / head changed with an echo / a new choice judged against the new head. */
function planSelection(role: Role, stored: RoleConfig, entry: RoleConfig, raw: RawSel, cfgTM: Pick<Config, 'toolModels'>, i: PlanInput, problem: (p: PlanProblem) => void, notices: string[]): void {
  const f = (k: string) => `roles.${role}.${k}`;
  const newHead = selTool(role, entry.providers);
  const oldHead = selTool(role, stored.providers);
  const before = storedSel(stored);
  const req = mergeSel(before, raw);
  const T = (t: ProviderId) => providerLabel(t);
  const R = ROLE_LABEL[role];
  const cat = i.catalog(newHead);

  // tool is server-derived: an echo only
  if (raw.tool === null) {
    const carries = (typeof raw.model === 'string') || raw.custom === true || raw.fast === true || raw.thinking === true;
    if (carries) {
      problem({ status: 400, code: 'bad_request', field: f('tool'), message: 'tool is set by Conductor; send it back as received or leave it out.' });
      if (stored.tool) applySel(entry, before, stored.tool);
      return;
    }
    // null with no model fields ⇒ the selection is cleared; the effort (if any) is judged below like any effort-only choice
    delete req.model;
    delete req.custom;
    delete req.fast;
    delete req.thinking;
  }
  const toolEcho = raw.tool === undefined || raw.tool === (stored.tool ?? null);

  // 1) unchanged ⇒ not re-judged: the stored selection is kept byte for byte (including an inert other-tool one)
  if (newHead === oldHead && toolEcho && sameModelFields(req, before) && req.effort === before.effort && raw.tool !== null) {
    if (stored.tool) applySel(entry, before, stored.tool);
    else applySel(entry, before, newHead);
    return;
  }

  const def = toolDefaultSelection(cfgTM, newHead);
  // 2) the head changed and the model fields are an echo of the stored ones ⇒ treated as omitted: cleared, effort fitted to the new default
  if (newHead !== oldHead && sameModelFields(req, before)) {
    if (hasModelFields(before)) notices.push(`${R}: ${T(newHead)} now leads, so the model chosen for ${T(stored.tool ?? oldHead)} was cleared.`);
    const eff = req.effort;
    if (eff !== undefined) {
      if (eff === before.effort) {
        const lv = levelsFor(newHead, cat, def);
        const fit = fitEffort(lv, eff);
        if (fit.adjusted) notices.push(`${R}: ${T(newHead)}'s default ${fit.effort ? `has no ${LEVEL_LABEL[eff]}, so the effort is now ${LEVEL_LABEL[fit.effort]}` : 'has no effort setting, so the effort was cleared'}.`);
        if (fit.effort) entry.effort = fit.effort;
      } else judgeEffortOnly(role, newHead, eff, def, cat, entry, problem, f);
    }
    return;
  }

  // 3) a new choice, judged for the new head
  if (raw.tool !== undefined && raw.tool !== null && raw.tool !== newHead && raw.tool !== stored.tool) {
    problem({ status: 400, code: 'tool_mismatch', field: f('tool'), message: `This choice was made for ${T(raw.tool)}, but ${T(newHead)} leads ${R}. Choose again for ${T(newHead)}.` });
  } else if (raw.tool !== undefined && raw.tool !== null && raw.tool !== newHead && raw.tool === stored.tool && !sameModelFields(req, before)) {
    problem({ status: 400, code: 'tool_mismatch', field: f('tool'), message: `This choice was made for ${T(raw.tool)}, but ${T(newHead)} leads ${R}. Choose again for ${T(newHead)}.` });
  }
  const sel: RoleModelSel = { ...req };
  if (!hasModelFields(sel) && sel.custom) delete sel.custom;
  // the model changed and the body left the effort out ⇒ the stored effort is fitted (a one-line notice), not refused
  const modelChanged = sel.model !== before.model || !!sel.custom !== !!before.custom;
  if (raw.effort === undefined && sel.effort !== undefined && (modelChanged || newHead !== oldHead)) {
    const probe = { ...sel, effort: undefined };
    const lv = levelsFor(newHead, cat, probe.model ? probe : def);
    const fam = newHead === 'cursor' && sel.model && !sel.custom && cat?.families ? cat.families.find((x) => x.family === sel.model) : undefined;
    const fit = fitEffort(lv, sel.effort, { needsToken: !!fam && !fam.efforts.includes('') });
    if (fit.adjusted) notices.push(`${R}: ${fit.effort ? `the new model has no ${LEVEL_LABEL[sel.effort]}, so the effort is now ${LEVEL_LABEL[fit.effort]}` : 'the new model has no effort setting, so the effort was cleared'}.`);
    if (fit.effort) sel.effort = fit.effort;
    else delete sel.effort;
  }
  if (!hasModelFields(sel)) {
    // effort-only (or nothing): judged against the tool default's levels
    if (sel.effort !== undefined && sel.effort !== before.effort) judgeEffortOnly(role, newHead, sel.effort, def, cat, entry, problem, f);
    else if (sel.effort !== undefined) entry.effort = sel.effort;
    return;
  }
  const p = judgeSelection(newHead, sel, cat);
  if (!p) {
    applySel(entry, sel, newHead);
    return;
  }
  problem({ status: 400, code: p.code, field: f(p.key), message: p.message });
  // preview only from here: the draft gets the fitted selection with notes instead of a 400
  const r = resolveSelection(newHead, sel, cat, 'role', def);
  for (const n of r.notes) notices.push(`${R}: ${n}`);
  if (r.fallback || !modelIdOk(newHead, sel.model ?? '')) {
    if (r.effort) entry.effort = r.effort;
    return;
  }
  const fitted: RoleModelSel = { model: sel.model };
  if (sel.custom) fitted.custom = true;
  if (r.effort) fitted.effort = r.effort;
  if (newHead === 'cursor' && r.fast) fitted.fast = true;
  if (newHead === 'cursor' && r.thinking) fitted.thinking = true;
  applySel(entry, fitted, newHead);
}

function judgeEffortOnly(role: Role, tool: ProviderId, effort: EffortToken, def: RoleModelSel, cat: CatalogView | null, entry: RoleConfig, problem: (p: PlanProblem) => void, f: (k: string) => string): void {
  const p = judgeSelection(tool, { ...def, effort }, cat);
  if (p && p.key === 'effort') {
    problem({ status: 400, code: p.code, field: f('effort'), message: p.message });
    const fit = fitEffort(levelsFor(tool, cat, def), effort);
    if (fit.effort) entry.effort = fit.effort;
    return;
  }
  void role;
  entry.effort = effort;
}
