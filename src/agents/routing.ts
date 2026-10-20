// Pure routing (M2). The chain a role runs through is a function of EXACTLY: the configured chains, CLI-reported health/auth,
// CLI-reported limit pauses, capabilities derived from code/stores, and the plan's complexity. No clock, no config reads, no I/O —
// `now` is an argument, and the test suite pins that (same input ⇒ same output, input never mutated).
import type { Capabilities, ProviderId } from './providers/types.ts';
import { ROLE_NEEDS, type Complexity, type Role, type Roles } from './roles.ts';

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
  /** Present only when the provider can run web research in an isolated profile (M5). */
  webResearchIsolated?: boolean;
}
export type States = Readonly<Record<ProviderId, ProviderState>>;

export interface Candidate {
  id: ProviderId;
  tier: Tier;
}
export interface Skipped {
  id: ProviderId;
  why: string;
}
export type Route =
  | { ok: true; candidates: Candidate[]; skipped: Skipped[]; usedComplexityPick: ProviderId | null }
  /** `paused`: every eligible provider is at a usage limit ⇒ wait (v1 semantics). `ineligible`: nothing may run this role ⇒ zero spawns. */
  | { ok: false; kind: 'paused'; reason: string; pauseUntil: number; provider: ProviderId; skipped: Skipped[] }
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

const unhealthy = (s: ProviderState, now: number): string | null => {
  if (!s.installed) return 'is not installed or does not start';
  if (s.auth === 'not-logged-in') return 'is not signed in';
  if (s.pausedUntil !== null && s.pausedUntil > now) return 'is at its usage limit';
  return null;
};

export function route(input: { role: Role; complexity?: Complexity; roles: Roles; states: States; now: number; label?: (id: ProviderId) => string }): Route {
  const { role, complexity, roles, states, now } = input;
  const label = input.label ?? ((x: ProviderId) => x);
  const cfg = roles[role];
  const skipped: Skipped[] = [];
  const chain: ProviderId[] = [];
  for (const id of cfg?.providers ?? []) if (!chain.includes(id) && Object.hasOwn(states, id)) chain.push(id);

  // capability / tier gate — a provider that may not hold this role is never run, whatever is left (Security 6)
  const eligible: ProviderId[] = [];
  for (const id of chain) {
    const why = ineligibleReason(role, id, states[id], label);
    if (why) skipped.push({ id, why });
    else eligible.push(id);
  }

  // complexity pick: first, but only after the plan exists, only if it is itself eligible, and NEVER at a lower isolation tier than the chain head
  let pick: ProviderId | null = null;
  const want = complexity && POST_PLAN.has(role) ? cfg?.autoByComplexity?.[complexity] : undefined;
  if (want && Object.hasOwn(states, want)) {
    const why = ineligibleReason(role, want, states[want], label);
    const head = eligible[0];
    if (why) skipped.push({ id: want, why: `complexity pick: ${why}` });
    else if (head && !ROLE_NEEDS[role].build && tierRank(states[want].tier) < tierRank(states[head].tier)) skipped.push({ id: want, why: `complexity pick ${label(want)} has a weaker isolation tier than ${label(head)}, so it is not used` });
    else pick = want;
  }
  const ordered: ProviderId[] = pick ? [pick, ...eligible.filter((x) => x !== pick)] : [...eligible];

  if (ordered.length === 0) {
    return { ok: false, kind: 'ineligible', reason: skipped.length ? skipped.map((s) => s.why).join(' ') : `No provider is assigned to ${role}.`, skipped };
  }
  const healthy: Candidate[] = [];
  const sick: { id: ProviderId; why: string; paused: number | null }[] = [];
  for (const id of ordered) {
    const why = unhealthy(states[id], now);
    if (why) sick.push({ id, why, paused: states[id].pausedUntil !== null && states[id].pausedUntil! > now ? states[id].pausedUntil : null });
    else healthy.push({ id, tier: states[id].tier });
  }
  for (const s of sick) skipped.push({ id: s.id, why: `${label(s.id)} ${s.why}` });
  if (healthy.length) return { ok: true, candidates: healthy, skipped, usedComplexityPick: pick };

  // nothing healthy: every eligible provider is limited ⇒ wait (v1); otherwise let the first eligible one run and report its own precise error
  if (sick.every((s) => s.paused !== null)) {
    const soonest = sick.reduce((a, b) => ((b.paused as number) < (a.paused as number) ? b : a));
    return { ok: false, kind: 'paused', reason: sick.map((s) => `${label(s.id)} ${s.why}`).join('; '), pauseUntil: soonest.paused as number, provider: soonest.id, skipped };
  }
  const first = sick.find((s) => s.paused === null)!;
  return { ok: true, candidates: [{ id: first.id, tier: states[first.id].tier }], skipped, usedComplexityPick: pick };
}

/** Errors that advance the chain: ONLY these. An isolation failure never falls back to a weaker provider. */
export const ADVANCING_ERRORS: ReadonlySet<string> = new Set(['limit', 'spawn', 'auth']);
export const advances = (errorKind: string | undefined): boolean => errorKind !== undefined && ADVANCING_ERRORS.has(errorKind);
