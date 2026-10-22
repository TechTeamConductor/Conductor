// Roles and their configuration (M2). A role is a job; providers are who may do it, in order.
import type { ProviderId } from './providers/types.ts';
import { isProviderId, staticBuildEligible } from './providers/static.ts';
import { modelIdOk } from '../models/sanitize.ts';
import { isEffort, type EffortToken } from '../models/levels.ts';
export type { EffortToken };

export const ROLES = ['requirements', 'context', 'planning', 'architecture', 'implementation', 'review', 'verification', 'debugging', 'documentation', 'research'] as const;
export type Role = (typeof ROLES)[number];
export type Complexity = 'S' | 'M' | 'L';
export const COMPLEXITIES: readonly Complexity[] = ['S', 'M', 'L'];

/**
 * What a role REQUIRES of a provider. Exhaustive on purpose: adding a role without an entry here does not compile
 * (Security condition 6 — `documentation` writes files, so it is build-class).
 */
export const ROLE_NEEDS: Readonly<Record<Role, { build?: true; research?: true }>> = Object.freeze({
  requirements: {},
  context: {},
  planning: {},
  architecture: {},
  implementation: { build: true },
  review: {},
  verification: {},
  debugging: { build: true },
  documentation: { build: true },
  research: { research: true },
});

export const ROLE_LABEL: Readonly<Record<Role, string>> = Object.freeze({
  requirements: 'Requirements',
  context: 'Context',
  planning: 'Planning',
  architecture: 'Architecture',
  implementation: 'Implementation',
  review: 'Review',
  verification: 'Verification',
  debugging: 'Debugging',
  documentation: 'Documentation',
  research: 'Research',
});

/**
 * A role's model choice (config v6, M8-2 §2.1). Every field is optional; unset = "Tool default" / "the tool decides".
 * Binding rule (B2): model, custom, fast and thinking belong to `tool`, the tool they were chosen for, and are applied ONLY when that tool
 * runs. Any other tool (a fallback, a complexity pick, a head changed by another path) gets its own default with the effort fitted.
 */
export interface RoleModelSel {
  /** The tool the choice was made for. Present whenever model/custom/fast/thinking is (server-derived). */
  tool?: ProviderId;
  /** Claude/Codex: a discovered model id or a custom id. Cursor: a discovered family (or, with custom, a listed id). modelIdOk(tool, …). */
  model?: string;
  /** The user typed the id ("Custom model id…"); only with `model`. */
  custom?: true;
  /** A role-level wish, fitted to whichever tool runs. */
  effort?: EffortToken;
  /** Cursor only in this slice. */
  fast?: true;
  thinking?: true;
}

export interface RoleConfig extends RoleModelSel {
  /** Ordered: the first healthy, eligible provider runs; the next ones are the fallbacks. */
  providers: ProviderId[];
  /** Per plan complexity, a provider to try FIRST (never lowers the isolation tier; must itself be eligible). */
  autoByComplexity?: Partial<Record<Complexity, ProviderId>>;
}
export type Roles = Record<Role, RoleConfig>;

export const isRole = (x: unknown): x is Role => typeof x === 'string' && Object.hasOwn(ROLE_NEEDS, x);
export const isComplexity = (x: unknown): x is Complexity => x === 'S' || x === 'M' || x === 'L';

/**
 * Defaults reproduce v1 exactly: Claude plans/reviews/verifies (Cursor takes over read-only stages when Claude is limited — v1's
 * default `onClaudeLimit: 'cursor'`), Cursor builds. Codex is in NO default chain (D8).
 */
export function defaultRoles(opts: { cursorTakesOverReadOnly?: boolean } = {}): Roles {
  const ro: ProviderId[] = opts.cursorTakesOverReadOnly === false ? ['claude'] : ['claude', 'cursor'];
  return {
    requirements: { providers: ['claude'] },
    context: { providers: ['claude'] },
    planning: { providers: [...ro] },
    architecture: { providers: ['claude'] },
    implementation: { providers: ['cursor'] },
    review: { providers: [...ro] },
    verification: { providers: [...ro] },
    debugging: { providers: ['cursor'] },
    documentation: { providers: ['cursor'] },
    research: { providers: ['claude'] },
  };
}

const MAX_CHAIN = 4;

/**
 * A role map from UNTRUSTED input (a hand-edited or migrated config, a PUT body). Output is always complete and safe:
 *  - role names are own-property checked and stored in a plain object keyed only by the known roles (a `__proto__` key is inert);
 *  - provider entries must be registry ids, are de-duplicated and capped;
 *  - for build-class roles the static capability filter re-runs here (an ineligible entry is dropped and reported);
 *  - an empty result falls back to the role's default; `autoByComplexity` keeps only S/M/L → registry ids that are themselves eligible.
 * `report` receives every dropped entry so the caller can warn.
 */
export function normalizeRoles(input: unknown, report: (msg: string) => void = () => undefined, defaults: Roles = defaultRoles()): Roles {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out = {} as Roles;
  for (const role of ROLES) {
    const raw = Object.hasOwn(src, role) ? src[role] : undefined;
    const rc = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const wantBuild = ROLE_NEEDS[role].build === true;
    const chain: ProviderId[] = [];
    for (const p of Array.isArray(rc.providers) ? rc.providers : []) {
      if (!isProviderId(p)) {
        report(`${role}: dropped unknown provider ${JSON.stringify(String(p).slice(0, 30))}`);
        continue;
      }
      if (wantBuild && !staticBuildEligible(p)) {
        report(`${role}: dropped ${p} — it cannot own a build role on this machine`);
        continue;
      }
      if (!chain.includes(p) && chain.length < MAX_CHAIN) chain.push(p);
    }
    const cfg: RoleConfig = { providers: chain.length ? chain : [...defaults[role].providers] };
    const abc = rc.autoByComplexity && typeof rc.autoByComplexity === 'object' && !Array.isArray(rc.autoByComplexity) ? (rc.autoByComplexity as Record<string, unknown>) : null;
    if (abc) {
      const picks: Partial<Record<Complexity, ProviderId>> = {};
      for (const c of COMPLEXITIES) {
        if (!Object.hasOwn(abc, c)) continue;
        const p = abc[c];
        if (!isProviderId(p) || (wantBuild && !staticBuildEligible(p))) {
          report(`${role}: dropped the ${c}-complexity choice ${JSON.stringify(String(p).slice(0, 30))}`);
          continue;
        }
        picks[c] = p;
      }
      if (Object.keys(picks).length) cfg.autoByComplexity = picks;
    }
    Object.assign(cfg, normalizeRoleSel(rc, (m) => report(`${role}: ${m}`)));
    out[role] = cfg;
  }
  return out;
}

/**
 * The model fields of one role entry from UNTRUSTED input, shape only (no catalog at load time; use-time resolution re-checks everything —
 * S19). Built from literals, never spread. Dropped values are reported WITHOUT the value (hand-edited text can be anything).
 */
export function normalizeRoleSel(rc: Record<string, unknown>, report: (msg: string) => void = () => undefined): RoleModelSel {
  const get = (k: string): unknown => (Object.hasOwn(rc, k) ? rc[k] : undefined);
  const out: RoleModelSel = {};
  const effort = get('effort');
  if (isEffort(effort)) out.effort = effort;
  else if (effort !== undefined && effort !== null) report('dropped the effort (not a known level)');
  const rawTool = get('tool');
  const model = get('model');
  const wantsModel = (model !== undefined && model !== null) || get('custom') === true || get('fast') === true || get('thinking') === true;
  if (!wantsModel) return out;
  if (!isProviderId(rawTool)) {
    report('dropped the model choice (it does not say which tool it was chosen for)');
    return out;
  }
  if (model !== undefined && model !== null) {
    if (modelIdOk(rawTool, model)) {
      out.model = model;
      if (get('custom') === true) out.custom = true;
    } else report(`dropped the model (not a valid ${rawTool} model id)`);
  }
  if (get('fast') === true) out.fast = true;
  if (get('thinking') === true) out.thinking = true;
  if (out.model !== undefined || out.fast || out.thinking) out.tool = rawTool;
  return out;
}

/** The tool a role's model choice is judged against and bound to (B2, N1): Claude for `research`, else the chain head. */
export function selTool(role: Role, providers: readonly ProviderId[]): ProviderId {
  return role === 'research' ? 'claude' : (providers[0] ?? 'claude');
}

/** v1/v3 compatibility: the first claude|cursor provider of a chain (what the old `stages.*` meant). */
export function firstReadOnlyProvider(chain: readonly ProviderId[]): 'claude' | 'cursor' {
  return chain.find((p): p is 'claude' | 'cursor' => p === 'claude' || p === 'cursor') ?? 'claude';
}
/** v1/v3 compatibility: does a `cursor` follow a `claude` in this chain (what `onClaudeLimit: cursor` meant)? */
export function cursorFollowsClaude(chain: readonly ProviderId[]): boolean {
  const i = chain.indexOf('claude');
  return i >= 0 && chain.indexOf('cursor', i + 1) > i;
}
