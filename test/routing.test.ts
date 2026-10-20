import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, ROLE_NEEDS, defaultRoles, isRole, type Roles } from '../src/agents/roles.ts';
import { advances, route, validatePairing, type ProviderState, type States } from '../src/agents/routing.ts';
import type { ProviderId } from '../src/agents/providers/types.ts';

const NOW = 1_000_000;
const st = (over: Partial<ProviderState> & { build?: boolean; verified?: boolean; readOnly?: boolean } = {}): ProviderState => ({
  caps: { readOnly: over.readOnly ?? true, build: over.build ?? false, buildIsolationVerified: over.verified ?? false },
  tier: over.tier ?? 'verified',
  installed: over.installed ?? true,
  auth: over.auth ?? 'ok',
  pausedUntil: over.pausedUntil ?? null,
  webResearchIsolated: over.webResearchIsolated,
});
const states = (o: Partial<Record<ProviderId, ProviderState>> = {}): States => ({
  claude: o.claude ?? st(),
  cursor: o.cursor ?? st({ build: true, verified: true, tier: 'partial' }),
});
const names = (r: ReturnType<typeof route>) => (r.ok ? r.candidates.map((c) => c.id) : []);

test('defaults reproduce v1: Claude plans/reviews/verifies with Cursor as read-only fallback, Cursor builds, no Codex anywhere (D8)', () => {
  const d = defaultRoles();
  assert.deepEqual(d.planning.providers, ['claude', 'cursor']);
  assert.deepEqual(d.review.providers, ['claude', 'cursor']);
  assert.deepEqual(d.verification.providers, ['claude', 'cursor']);
  assert.deepEqual(d.implementation.providers, ['cursor']);
  assert.deepEqual(d.debugging.providers, ['cursor']);
  assert.deepEqual(defaultRoles({ cursorTakesOverReadOnly: false }).planning.providers, ['claude']);
  assert.ok(!JSON.stringify(d).includes('codex'));
  assert.deepEqual(Object.keys(d).sort(), [...ROLES].sort());
});

test('ROLE_NEEDS is exhaustive, `documentation` is build-class, research needs isolated research, and role names are own-property checked', () => {
  for (const r of ROLES) assert.ok(Object.hasOwn(ROLE_NEEDS, r), r);
  assert.equal(ROLE_NEEDS.documentation.build, true);
  assert.equal(ROLE_NEEDS.implementation.build, true);
  assert.equal(ROLE_NEEDS.debugging.build, true);
  assert.equal(ROLE_NEEDS.research.research, true);
  for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'Planning', 7, null, undefined]) assert.equal(isRole(bad), false, String(bad));
});

test('healthy first, then fallbacks in configured order; unhealthy providers are skipped with a reason', () => {
  const roles = defaultRoles();
  assert.deepEqual(names(route({ role: 'planning', roles, states: states(), now: NOW })), ['claude', 'cursor']);
  const r = route({ role: 'planning', roles, states: states({ claude: st({ installed: false }) }), now: NOW });
  assert.deepEqual(names(r), ['cursor']);
  assert.ok(r.ok && r.skipped.some((s) => s.id === 'claude' && /not installed/.test(s.why)));
  const r2 = route({ role: 'planning', roles, states: states({ claude: st({ auth: 'not-logged-in' }) }), now: NOW });
  assert.deepEqual(names(r2), ['cursor']);
  const r3 = route({ role: 'planning', roles, states: states({ claude: st({ pausedUntil: NOW + 5000 }) }), now: NOW });
  assert.deepEqual(names(r3), ['cursor']);
  // a pause that has already passed no longer counts
  assert.deepEqual(names(route({ role: 'planning', roles, states: states({ claude: st({ pausedUntil: NOW - 1 }) }), now: NOW })), ['claude', 'cursor']);
  // unknown auth is usable (the CLI could not say)
  assert.deepEqual(names(route({ role: 'planning', roles, states: states({ claude: st({ auth: 'unknown' }) }), now: NOW })), ['claude', 'cursor']);
});

test('every eligible provider paused ⇒ wait until the earliest reset (v1 semantics); not paused but broken ⇒ the first one still runs and reports its own error', () => {
  const roles = defaultRoles();
  const paused = route({ role: 'planning', roles, states: states({ claude: st({ pausedUntil: NOW + 9000 }), cursor: st({ pausedUntil: NOW + 4000, build: true, verified: true }) }), now: NOW });
  assert.equal(paused.ok, false);
  assert.ok(!paused.ok && paused.kind === 'paused' && paused.pauseUntil === NOW + 4000);
  const broken = route({ role: 'planning', roles, states: states({ claude: st({ installed: false }), cursor: st({ installed: false, build: true, verified: true }) }), now: NOW });
  assert.deepEqual(names(broken), ['claude'], 'let the spawn error name the real problem');
});

test('build roles admit only build && verified providers; an only-ineligible chain spawns NOTHING and says why', () => {
  const roles: Roles = { ...defaultRoles(), implementation: { providers: ['claude'] } };
  const r = route({ role: 'implementation', roles, states: states(), now: NOW });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.kind === 'ineligible' && /cannot write code/.test(r.reason));
  // a provider with a build function but UNVERIFIED isolation is not a builder, however the chain is ordered
  const unverified = states({ cursor: st({ build: true, verified: false }) });
  const r2 = route({ role: 'implementation', roles: defaultRoles(), states: unverified, now: NOW });
  assert.ok(!r2.ok && r2.kind === 'ineligible' && /no-push isolation has not been verified/.test(r2.reason));
  for (const role of ['implementation', 'debugging', 'documentation'] as const) {
    const roles2: Roles = { ...defaultRoles(), [role]: { providers: ['claude', 'cursor'] } };
    assert.deepEqual(names(route({ role, roles: roles2, states: states(), now: NOW })), ['cursor'], `${role}: Claude is skipped, Cursor builds`);
  }
});

test('"unless nothing else remains" never runs an ineligible provider, even when it is the only one left', () => {
  const roles: Roles = { ...defaultRoles(), implementation: { providers: ['cursor'] } };
  const r = route({ role: 'implementation', roles, states: states({ cursor: st({ build: true, verified: false, installed: false }) }), now: NOW });
  assert.ok(!r.ok && r.kind === 'ineligible');
});

test('research needs an isolated-web provider; a blocked tier is unusable for every role', () => {
  const roles: Roles = { ...defaultRoles(), research: { providers: ['claude'] } };
  assert.ok(!route({ role: 'research', roles, states: states(), now: NOW }).ok);
  assert.deepEqual(names(route({ role: 'research', roles, states: states({ claude: st({ webResearchIsolated: true }) }), now: NOW })), ['claude']);
  for (const role of ROLES) {
    const r = route({ role, roles: { ...defaultRoles(), [role]: { providers: ['claude'] } }, states: states({ claude: st({ tier: 'blocked', build: true, verified: true, webResearchIsolated: true }) }), now: NOW });
    assert.ok(!r.ok && r.kind === 'ineligible', `${role}: blocked claude is never selectable`);
  }
});

test('complexity pick: first, post-plan roles only, never at a lower isolation tier than the chain head', () => {
  const roles: Roles = { ...defaultRoles(), review: { providers: ['claude', 'cursor'], autoByComplexity: { L: 'cursor', S: 'claude' } } };
  // post-plan role with a complexity ⇒ the pick leads
  const a = route({ role: 'review', complexity: 'L', roles, states: states({ cursor: st({ tier: 'verified', build: true, verified: true }) }), now: NOW });
  assert.deepEqual(names(a), ['cursor', 'claude']);
  // Cursor's read-only tier is `partial` (weaker than Claude's `verified`): the pick would lower isolation ⇒ ignored, with a visible reason
  const b = route({ role: 'review', complexity: 'L', roles, states: states(), now: NOW });
  assert.deepEqual(names(b), ['claude', 'cursor']);
  assert.ok(b.ok && b.skipped.some((s) => /weaker isolation tier/.test(s.why)));
  // planning runs before the plan (and its complexity) exists ⇒ never picked by complexity
  const c = route({ role: 'planning', complexity: 'L', roles: { ...roles, planning: { providers: ['claude', 'cursor'], autoByComplexity: { L: 'cursor' } } }, states: states({ cursor: st({ tier: 'verified', build: true, verified: true }) }), now: NOW });
  assert.deepEqual(names(c), ['claude', 'cursor']);
  // no complexity known ⇒ no pick
  assert.deepEqual(names(route({ role: 'review', roles, states: states({ cursor: st({ tier: 'verified', build: true, verified: true }) }), now: NOW })), ['claude', 'cursor']);
  // an ineligible pick for a BUILD role is rejected, not trusted
  const d = route({ role: 'implementation', complexity: 'S', roles: { ...defaultRoles(), implementation: { providers: ['cursor'], autoByComplexity: { S: 'claude' } } }, states: states(), now: NOW });
  assert.deepEqual(names(d), ['cursor']);
  assert.ok(d.ok && d.skipped.some((s) => s.id === 'claude' && /complexity pick/.test(s.why)));
});

test('validatePairing explains a refused assignment in human words', () => {
  const s = states({ claude: st() });
  assert.deepEqual(validatePairing('implementation', 'cursor', s), { ok: true });
  const bad = validatePairing('implementation', 'claude', s, (id) => (id === 'claude' ? 'Claude' : id));
  assert.ok(!bad.ok && /Claude cannot write code/.test(bad.reason));
  const unverified = validatePairing('implementation', 'cursor', states({ cursor: st({ build: true, verified: false }) }), () => 'Codex');
  assert.ok(!unverified.ok && /Codex cannot own implementation: its no-push isolation has not been verified on this machine/.test(unverified.reason));
});

test('routing is PURE: same input ⇒ same output, the input is never mutated (a deep-frozen input works), and it reads no clock', () => {
  const deepFreeze = <T>(o: T): T => {
    if (o && typeof o === 'object') for (const v of Object.values(o as object)) deepFreeze(v);
    return Object.freeze(o);
  };
  const input = deepFreeze({ role: 'review' as const, complexity: 'M' as const, roles: defaultRoles(), states: states({ claude: st({ pausedUntil: NOW + 10 }) }), now: NOW });
  const a = route(input);
  const b = route(input);
  assert.deepEqual(a, b);
  const realNow = Date.now;
  Date.now = () => { throw new Error('routing must not read the clock'); };
  try {
    assert.deepEqual(route(input), a);
  } finally {
    Date.now = realNow;
  }
});

test('only limit / spawn / auth advance the chain — an isolation failure never falls back to a weaker provider', () => {
  for (const k of ['limit', 'spawn', 'auth']) assert.equal(advances(k), true, k);
  for (const k of ['isolation', 'agent', 'parse', 'timeout_hard', 'timeout_idle', 'max_turns', 'aborted', undefined]) assert.equal(advances(k as string | undefined), false, String(k));
});
