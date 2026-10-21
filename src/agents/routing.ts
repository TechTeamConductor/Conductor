// Pure routing (M2). The chain a role runs through is a function of EXACTLY: the configured chains, CLI-reported health/auth,
// CLI-reported limit pauses, capabilities derived from code/stores, and the plan's complexity. No clock, no config reads, no I/O —
// `now` is an argument, and the test suite pins that (same input ⇒ same output, input never mutated).
import type { Capabilities, ProviderId } from './providers/types.ts';
import { ROLE_NEEDS, type Complexity, type Role, type Roles } from './roles.ts';
import type { LimitRule } from '../accounts/limit-rule.ts';

/** Read-only isolation tier of a provider. `blocked` = a probe/canary FAILED: never selectable for any role. */
export type Tier = 'verified' | 'partial' | 'unverified' | 'blocked';
const TIER_RANK: Record<Tier, number> = { verified: 3, partial: 2, unverified: 1, blocked: 0 };
export const tierRank = (t: Tier): number => TIER_RANK[t];

export interface ProviderState {
  caps: Capabilities;
  tier: Tier;
  /** CLI-reported: the binary runs. */
  installed: boolean;
  /** CLI-reported: signed in ('unknown' when the CLI could not say — treated as usable). */
  auth: 'ok' | 'not-logged-in' | 'unknown';
  /** CLI-reported usage limit: epoch ms until which the provider is paused, or null. */
  pausedUntil: number | null;
  /**
   * Present only when the provider can run web research in an isolated profile (M5). Intentionally never set in production until F11
   * (M8-2 S11): Deep Research runs through `claude.runResearch` directly; making research routable needs its own Security design.
   */
  webResearchIsolated?: boolean;
  /**
   * M8-3: the tool's accounts in config order. Absent ⇒ ONE implicit `default` account mirroring `auth`/`pausedUntil` (today's behaviour,
   * byte-identical). The router never adds a tool outside the role's chain for any account (D-A, S10).
   */
  accounts?: readonly AccountState[];
}
/** M8-3 §2.2: one sign-in of a tool as the router sees it. Labels only — never a path or a secret. */
export interface AccountState {
  id: string;
  name: string;
  isDefault: boolean;
  /** false ⇒ never a candidate (dormant Codex, an account being removed). */
  enabled: boolean;
  /** default: today's provider health; named: from its last check — 'unknown' is NOT usable for a named account (S2). */
  auth: 'ok' | 'not-logged-in' | 'unknown';
  pausedUntil: number | null;
  /** M8-2 `modelOffered` with the selection THIS candidate runs; null = this account's list is unknown (counts as offering, D-D). */
  offersModel: boolean | null;
  /** false ⇒ skipped for build-class roles (named Cursor while CURSOR_ACCOUNT_HOME_BUILD_VERIFIED is false; D-G, S17). */
  buildOk: boolean;
}
export type States = Readonly<Record<ProviderId, ProviderState>>;

export interface Candidate {
  id: ProviderId;
  tier: Tier;
  /** M8-3: the account this candidate runs on ('default' = the user's own sign-in). */
  account: string;
  /** 'account' = the head tool but not its first enabled account; 'tool' = a later tool of the chain. Absent = the head's first account. */
  moved?: 'account' | 'tool';
  /** Q7: this account is known NOT to offer the chosen model (tried after those that do; the selection falls back to the tool default). */
  modelFallback?: true;
  /**
   * Mid-call rule (§2.2 step 3): after a `limit` error the caller may advance ONLY to a next candidate whose crossOnLimit is true. It is false
   * only for the first candidate of another tool that follows a HEAD candidate under same/wait (a limit never leaves the head tool).
   */
  crossOnLimit: boolean;
}
export type SkipKind = 'gate' | 'limit' | 'auth' | 'missing' | 'model' | 'disabled' | 'build-unverified';
export interface Skipped {
  id: ProviderId;
  /** M8-3: the account (absent for gate/complexity skips, which are per tool). */
  account?: string;
  why: string;
  kind: SkipKind;
}
export type Route =
  | { ok: true; candidates: Candidate[]; skipped: Skipped[]; usedComplexityPick: ProviderId | null }
  /** `paused`: every eligible provider is at a usage limit ⇒ wait (v1 semantics). `ineligible`: nothing may run this role ⇒ zero spawns. */
  | { ok: false; kind: 'paused'; reason: string; pauseUntil: number; provider: ProviderId; account: string; skipped: Skipped[] }
  | { ok: false; kind: 'ineligible'; reason: string; skipped: Skipped[] };

/** Roles whose complexity-based pick applies: only stages that run AFTER the plan (and so its complexity) exists. */
const POST_PLAN: ReadonlySet<Role> = new Set<Role>(['review', 'implementation', 'verification', 'debugging', 'documentation']);

/** Why a provider may NOT hold a role at all (capability / tier gate). null = eligible. */
export function ineligibleReason(role: Role, id: ProviderId, s: ProviderState, label: (id: ProviderId) => string = (x) => x): string | null {
  const needs = ROLE_NEEDS[role];
  const who = label(id);
  if (s.tier === 'blocked') return `${who} failed its isolation check and is blocked until that is fixed.`;
  if (!s.caps.readOnly && !needs.build) return `${who} cannot run read-only stages.`;
  if (needs.build) {
    if (!s.caps.build) return `${who} cannot write code (no build capability).`;
    if (!s.caps.buildIsolationVerified) return `${who} cannot own ${role}: its no-push isolation has not been verified on this machine.`;
  }
  if (needs.research && !s.webResearchIsolated) return `${who} cannot do research: its web access is not isolated yet.`;
  return null;
}

/** Pairing check used when a human assigns providers to a role (PUT /api/roles). */
export function validatePairing(role: Role, id: ProviderId, states: States, label?: (id: ProviderId) => string): { ok: true } | { ok: false; reason: string } {
  const why = ineligibleReason(role, id, states[id], label);
  return why ? { ok: false, reason: why } : { ok: true };
}

const DEFAULT_ID = 'default';
/** The implicit single account of a provider without an `accounts` list: exactly today's provider-level health. */
const implicitAccounts = (s: ProviderState): readonly AccountState[] => [{ id: DEFAULT_ID, name: '', isDefault: true, enabled: true, auth: s.auth, pausedUntil: s.pausedUntil, offersModel: null, buildOk: true }];

/** A sign-in that could run if it were healthy (S-set, §2.2 step 5): default accounts, and named ones whose last check said signed in. */
const credentialed = (a: AccountState): boolean => a.isDefault || a.auth === 'ok';

export function route(input: { role: Role; complexity?: Complexity; roles: Roles; states: States; now: number; label?: (id: ProviderId) => string; rule?: LimitRule }): Route {
  const { role, complexity, roles, states, now } = input;
  const label = input.label ?? ((x: ProviderId) => x);
  const rule: LimitRule = input.rule ?? 'switch';
  const cfg = roles[role];
  const skipped: Skipped[] = [];
  const chain: ProviderId[] = [];
  for (const id of cfg?.providers ?? []) if (!chain.includes(id) && Object.hasOwn(states, id)) chain.push(id);

  // capability / tier gate — a provider that may not hold this role is never run, whatever is left (Security 6)
  const eligible: ProviderId[] = [];
  for (const id of chain) {
    const why = ineligibleReason(role, id, states[id], label);
    if (why) skipped.push({ id, why, kind: 'gate' });
    else eligible.push(id);
  }

  // complexity pick: first, but only after the plan exists, only if it is itself eligible, and NEVER at a lower isolation tier than the chain head
  let pick: ProviderId | null = null;
  const want = complexity && POST_PLAN.has(role) ? cfg?.autoByComplexity?.[complexity] : undefined;
  if (want && Object.hasOwn(states, want)) {
    const why = ineligibleReason(role, want, states[want], label);
    const head = eligible[0];
    if (why) skipped.push({ id: want, why: `complexity pick: ${why}`, kind: 'gate' });
    else if (head && !ROLE_NEEDS[role].build && tierRank(states[want].tier) < tierRank(states[head].tier)) skipped.push({ id: want, why: `complexity pick ${label(want)} has a weaker isolation tier than ${label(head)}, so it is not used`, kind: 'gate' });
    else pick = want;
  }
  // D-A / S10: candidate tools ⊆ the role's chain ∪ its complexity pick — nothing below ever adds a tool
  const ordered: ProviderId[] = pick ? [pick, ...eligible.filter((x) => x !== pick)] : [...eligible];

  if (ordered.length === 0) {
    return { ok: false, kind: 'ineligible', reason: skipped.length ? skipped.map((s) => s.why).join(' ') : `No provider is assigned to ${role}.`, skipped };
  }
  const build = ROLE_NEEDS[role].build === true;
  const headTool = ordered[0]!;
  const candidates: Candidate[] = [];
  /** The S-set: health-skipped sign-ins that could run if healthy (§2.2 step 5), in `ordered` order. */
  const sick: { id: ProviderId; account: string; isDefault: boolean; text: string; paused: number | null; kind: SkipKind }[] = [];
  const later: Skipped[] = [];
  for (const id of ordered) {
    const s = states[id];
    const all = s.accounts ?? implicitAccounts(s);
    const enabled = all.filter((a) => a.enabled);
    // labels: just the tool while it has a single (default) sign-in — today's wording, byte-identical — else "Tool · Name"
    const who = (a: AccountState) => (enabled.length > 1 || !a.isDefault ? `${label(id)} · ${a.name || a.id}` : label(id));
    for (const a of all) if (!a.enabled) later.push({ id, account: a.id, why: `${who(a)} is not available`, kind: 'disabled' });
    const pool = rule === 'wait' ? enabled.slice(0, 1) : enabled;
    const firstId = enabled[0]?.id;
    const usable: AccountState[] = [];
    for (const a of pool) {
      if (build && !a.buildOk) {
        later.push({ id, account: a.id, why: `${who(a)} can run read-only work only until its build isolation is checked`, kind: 'build-unverified' });
        continue;
      }
      // the provider-level fields still count for every account: the default account IS the provider's own health, and a provider-level
      // pause (every enabled account paused, or a caller's override) covers each account until at least then
      const until = Math.max(a.pausedUntil ?? 0, s.pausedUntil ?? 0);
      const paused = until > now ? until : null;
      const authOk = a.isDefault ? s.auth !== 'not-logged-in' : a.auth === 'ok';
      let kind: SkipKind | null = null;
      let why = '';
      if (!s.installed) [kind, why] = ['missing', 'is not installed or does not start'];
      else if (!authOk) [kind, why] = ['auth', 'is not signed in'];
      else if (paused !== null) [kind, why] = ['limit', 'is at its usage limit'];
      if (kind === null) {
        usable.push(a);
        continue;
      }
      const text = `${who(a)} ${why}`;
      if (credentialed(a)) sick.push({ id, account: a.id, isDefault: a.isDefault, text, paused, kind });
      else later.push({ id, account: a.id, why: text, kind });
    }
    // Q7: accounts known to lack the model go last (still candidates; the selection then falls back to the tool default)
    const ordUsable = [...usable.filter((a) => a.offersModel !== false), ...usable.filter((a) => a.offersModel === false)];
    // limits only (D-B; R2-B2): under same/wait a limited head with nothing usable PAUSES — later tools are not candidates
    if (id === headTool && rule !== 'switch' && ordUsable.length === 0) {
      const limited = sick.filter((x) => x.id === id && x.kind === 'limit');
      if (limited.length) {
        for (const x of sick) skipped.push({ id: x.id, account: x.account, why: x.text, kind: x.kind });
        skipped.push(...later);
        const soonest = limited.reduce((a, b) => ((b.paused as number) < (a.paused as number) ? b : a));
        return { ok: false, kind: 'paused', reason: limited.map((x) => x.text).join('; '), pauseUntil: soonest.paused as number, provider: id, account: soonest.account, skipped };
      }
    }
    for (const a of ordUsable) {
      const moved = id !== headTool ? 'tool' : a.id !== firstId ? 'account' : undefined;
      // the mid-call rule (code review B2): under same/wait a limit never leaves the HEAD tool, so the step from the head's last candidate
      // to another tool is blocked. Every other step (head → head account, or between the non-limit fallback tools and their accounts) is
      // allowed, exactly as a fresh route would allow it — so onLimitHit and the scheduler make one decision.
      const prev = candidates[candidates.length - 1];
      const crossOnLimit = rule === 'switch' || !prev || !(prev.id === headTool && id !== headTool);
      candidates.push({ id, tier: s.tier, account: a.id, ...(moved ? { moved } : {}), ...(a.offersModel === false ? { modelFallback: true as const } : {}), crossOnLimit });
    }
  }
  for (const x of sick) skipped.push({ id: x.id, account: x.account, why: x.text, kind: x.kind });
  skipped.push(...later);
  if (candidates.length) return { ok: true, candidates, skipped, usedComplexityPick: pick };

  // nothing usable (B1: today's rule, exactly): every member of the S-set limited ⇒ wait until the earliest reset (v1)…
  if (sick.length && sick.every((x) => x.paused !== null)) {
    const soonest = sick.reduce((a, b) => ((b.paused as number) < (a.paused as number) ? b : a));
    return { ok: false, kind: 'paused', reason: sick.map((x) => x.text).join('; '), pauseUntil: soonest.paused as number, provider: soonest.id, account: soonest.account, skipped };
  }
  // …otherwise the first non-paused DEFAULT sign-in runs and reports its own precise error (never a named account: no credential, S2)
  const first = sick.find((x) => x.paused === null && x.isDefault);
  if (first) return { ok: true, candidates: [{ id: first.id, tier: states[first.id].tier, account: first.account, ...(first.id !== headTool ? { moved: 'tool' as const } : {}), crossOnLimit: true }], skipped, usedComplexityPick: pick };
  return { ok: false, kind: 'ineligible', reason: `No signed-in account is available for ${role}. ${skipped.map((x) => x.why).join('; ')}`.trim(), skipped };
}

/** Errors that advance the chain: ONLY these. An isolation failure never falls back to a weaker provider. */
export const ADVANCING_ERRORS: ReadonlySet<string> = new Set(['limit', 'spawn', 'auth']);
export const advances = (errorKind: string | undefined): boolean => errorKind !== undefined && ADVANCING_ERRORS.has(errorKind);
