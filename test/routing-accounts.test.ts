// M8-3 AC1 + AC2 + S10: the router with accounts and the limit rule. AC1 pins byte-identity with today's router (a verbatim copy of the
// pre-M8-3 `route()` lives below) over a seeded property matrix of roles × chains × complexity × health — with default-only accounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, ROLE_NEEDS, defaultRoles, type Complexity, type Role, type Roles } from '../src/agents/roles.ts';
import { ineligibleReason, route, tierRank, type AccountState, type ProviderState, type States } from '../src/agents/routing.ts';
import type { ProviderId } from '../src/agents/providers/types.ts';
import type { LimitRule } from '../src/accounts/limit-rule.ts';

const NOW = 1_000_000;
const LABEL = (id: ProviderId) => ({ claude: 'Claude', cursor: 'Cursor', codex: 'Codex' })[id];

// ───────────── the pre-M8-3 router, verbatim (only the types are local) ─────────────
const POST_PLAN: ReadonlySet<Role> = new Set<Role>(['review', 'implementation', 'verification', 'debugging', 'documentation']);
type LegacyRoute =
  | { ok: true; candidates: { id: ProviderId; tier: string }[]; skipped: { id: ProviderId; why: string }[]; usedComplexityPick: ProviderId | null }
  | { ok: false; kind: 'paused'; reason: string; pauseUntil: number; provider: ProviderId; skipped: { id: ProviderId; why: string }[] }
  | { ok: false; kind: 'ineligible'; reason: string; skipped: { id: ProviderId; why: string }[] };
const unhealthy = (s: ProviderState, now: number): string | null => {
  if (!s.installed) return 'is not installed or does not start';
  if (s.auth === 'not-logged-in') return 'is not signed in';
  if (s.pausedUntil !== null && s.pausedUntil > now) return 'is at its usage limit';
  return null;
};
function legacyRoute(input: { role: Role; complexity?: Complexity; roles: Roles; states: States; now: number; label?: (id: ProviderId) => string }): LegacyRoute {
  const { role, complexity, roles, states, now } = input;
  const label = input.label ?? ((x: ProviderId) => x);
  const cfg = roles[role];
  const skipped: { id: ProviderId; why: string }[] = [];
  const chain: ProviderId[] = [];
  for (const id of cfg?.providers ?? []) if (!chain.includes(id) && Object.hasOwn(states, id)) chain.push(id);
  const eligible: ProviderId[] = [];
  for (const id of chain) {
    const why = ineligibleReason(role, id, states[id], label);
    if (why) skipped.push({ id, why });
    else eligible.push(id);
  }
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
  const healthy: { id: ProviderId; tier: string }[] = [];
  const sick: { id: ProviderId; why: string; paused: number | null }[] = [];
  for (const id of ordered) {
    const why = unhealthy(states[id], now);
    if (why) sick.push({ id, why, paused: states[id].pausedUntil !== null && states[id].pausedUntil! > now ? states[id].pausedUntil : null });
    else healthy.push({ id, tier: states[id].tier });
  }
  for (const s of sick) skipped.push({ id: s.id, why: `${label(s.id)} ${s.why}` });
  if (healthy.length) return { ok: true, candidates: healthy, skipped, usedComplexityPick: pick };
  if (sick.every((s) => s.paused !== null)) {
    const soonest = sick.reduce((a, b) => ((b.paused as number) < (a.paused as number) ? b : a));
    return { ok: false, kind: 'paused', reason: sick.map((s) => `${label(s.id)} ${s.why}`).join('; '), pauseUntil: soonest.paused as number, provider: soonest.id, skipped };
  }
  const first = sick.find((s) => s.paused === null)!;
  return { ok: true, candidates: [{ id: first.id, tier: states[first.id].tier }], skipped, usedComplexityPick: pick };
}

// ───────────── fixtures ─────────────
function rng(seed: number) {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const caps = { claude: { readOnly: true, build: false, buildIsolationVerified: false }, cursor: { readOnly: true, build: true, buildIsolationVerified: true }, codex: { readOnly: true, build: false, buildIsolationVerified: false } };
const tiers = { claude: 'verified', cursor: 'partial', codex: 'unverified' } as const;
function provider(id: ProviderId, h: { installed: boolean; auth: ProviderState['auth']; pausedUntil: number | null }, withAccounts: boolean, extra: Partial<ProviderState> = {}): ProviderState {
  const base: ProviderState = { caps: caps[id], tier: tiers[id], installed: h.installed, auth: h.auth, pausedUntil: h.pausedUntil, ...(id === 'claude' ? { webResearchIsolated: true } : {}), ...extra };
  if (!withAccounts) return base;
  // exactly what Engine.routeStates() builds for a default-only config (M8-3)
  return { ...base, accounts: [{ id: 'default', name: 'Main', isDefault: true, enabled: true, auth: h.auth, pausedUntil: h.pausedUntil, offersModel: null, buildOk: true }] };
}
const CHAINS: ProviderId[][] = [['claude'], ['cursor'], ['claude', 'cursor'], ['cursor', 'claude'], ['claude', 'codex', 'cursor'], ['codex'], ['codex', 'claude']];
const COMPLEX: (Complexity | undefined)[] = [undefined, 'S', 'M', 'L'];
const PAUSES = [null, NOW - 1, NOW + 1000, NOW + 5000, NOW + 9000];

test('AC1: default-only accounts + rule switch ⇒ byte-identical to the pre-M8-3 router (seeded matrix, 6000 cases, with and without accounts[])', () => {
  const r = rng(83);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  let n = 0;
  for (let i = 0; i < 6000; i++) {
    const role = pick(ROLES);
    const chain = pick(CHAINS);
    const auto = r() < 0.4 ? { [pick(['S', 'M', 'L'] as const)]: pick(['claude', 'cursor', 'codex'] as const) } : undefined;
    const roles: Roles = { ...defaultRoles(), [role]: { providers: chain, ...(auto ? { autoByComplexity: auto } : {}) } };
    const health = () => ({ installed: r() > 0.2, auth: pick(['ok', 'ok', 'not-logged-in', 'unknown'] as const), pausedUntil: pick(PAUSES) });
    const hs = { claude: health(), cursor: health(), codex: health() };
    const complexity = pick(COMPLEX);
    for (const withAccounts of [false, true]) {
      const states: States = { claude: provider('claude', hs.claude, withAccounts), cursor: provider('cursor', hs.cursor, withAccounts), codex: provider('codex', hs.codex, withAccounts) };
      const a = legacyRoute({ role, complexity, roles, states, now: NOW, label: LABEL });
      const b = route({ role, complexity, roles, states, now: NOW, label: LABEL, rule: 'switch' });
      const proj = (x: any) => ({
        ok: x.ok, kind: x.kind, reason: x.reason, pauseUntil: x.pauseUntil, provider: x.provider, usedComplexityPick: x.usedComplexityPick,
        candidates: x.candidates?.map((c: any) => ({ id: c.id, tier: c.tier })), skipped: x.skipped.map((s: any) => ({ id: s.id, why: s.why })),
      });
      assert.deepEqual(proj(b), proj(a), JSON.stringify({ role, chain, auto, hs, complexity, withAccounts }));
      if (b.ok) for (const c of b.candidates) assert.equal(c.account, 'default');
      n++;
    }
  }
  assert.equal(n, 12000);
});

test('AC1 / B1 example: Claude signed out + Cursor paused ⇒ Claude runs and reports its own error (today\'s rule, kept exactly)', () => {
  const states: States = { claude: provider('claude', { installed: true, auth: 'not-logged-in', pausedUntil: null }, true), cursor: provider('cursor', { installed: true, auth: 'ok', pausedUntil: NOW + 5000 }, true), codex: provider('codex', { installed: false, auth: 'unknown', pausedUntil: null }, true) };
  const r = route({ role: 'planning', roles: defaultRoles(), states, now: NOW, label: LABEL });
  assert.ok(r.ok);
  assert.deepEqual(r.candidates.map((c) => [c.id, c.account]), [['claude', 'default']]);
});

// ───────────── multi-account fixtures ─────────────
const acc = (id: string, o: Partial<AccountState> = {}): AccountState => ({ id, name: id === 'default' ? 'Main' : id, isDefault: id === 'default', enabled: true, auth: 'ok', pausedUntil: null, offersModel: null, buildOk: true, ...o });
function multi(o: { claude?: AccountState[]; cursor?: AccountState[]; codex?: AccountState[]; installed?: Partial<Record<ProviderId, boolean>> } = {}): States {
  const mk = (id: ProviderId, list: AccountState[]): ProviderState => ({ caps: caps[id], tier: tiers[id], installed: o.installed?.[id] ?? true, auth: 'ok', pausedUntil: null, ...(id === 'claude' ? { webResearchIsolated: true } : {}), accounts: list });
  return { claude: mk('claude', o.claude ?? [acc('default')]), cursor: mk('cursor', o.cursor ?? [acc('default')]), codex: mk('codex', o.codex ?? [acc('default')]) };
}
const ids = (r: ReturnType<typeof route>) => (r.ok ? r.candidates.map((c) => `${c.id}:${c.account}`) : []);
const P = NOW + 60_000;

test('switch — limited first account ⇒ second account of the same tool, moved:account; all Claude limited ⇒ next chain tool Cursor, moved:tool', () => {
  const a = route({ role: 'planning', roles: defaultRoles(), states: multi({ claude: [acc('default', { pausedUntil: P }), acc('claude-personal-0001')] }), now: NOW, label: LABEL });
  assert.deepEqual(ids(a), ['claude:claude-personal-0001', 'cursor:default']);
  assert.ok(a.ok && a.candidates[0]!.moved === 'account' && a.candidates[1]!.moved === 'tool' && a.candidates.every((c) => c.crossOnLimit));
  const b = route({ role: 'planning', roles: defaultRoles(), states: multi({ claude: [acc('default', { pausedUntil: P }), acc('claude-personal-0001', { pausedUntil: P + 1 })] }), now: NOW, label: LABEL });
  assert.deepEqual(ids(b), ['cursor:default']);
  assert.ok(b.ok && b.candidates[0]!.moved === 'tool');
  assert.ok(b.ok && b.skipped.some((s) => s.kind === 'limit' && s.account === 'claude-personal-0001' && /Claude · claude-personal-0001 is at its usage limit/.test(s.why)));
});

test('switch — a Claude-only chain with all Claude accounts limited ⇒ paused until the earliest, never Cursor (D-A)', () => {
  const roles = defaultRoles({ cursorTakesOverReadOnly: false });
  const r = route({ role: 'planning', roles, states: multi({ claude: [acc('default', { pausedUntil: P + 50 }), acc('claude-w-0001', { pausedUntil: P })] }), now: NOW, label: LABEL });
  assert.ok(!r.ok && r.kind === 'paused' && r.pauseUntil === P && r.provider === 'claude' && r.account === 'claude-w-0001');
});

test('same — all Claude limited ⇒ paused, never Cursor; Claude not installed ⇒ Cursor (non-limit fallback kept); crossOnLimit false for later tools', () => {
  const states = multi({ claude: [acc('default', { pausedUntil: P }), acc('claude-w-0001', { pausedUntil: P })] });
  const r = route({ role: 'planning', roles: defaultRoles(), states, now: NOW, label: LABEL, rule: 'same' });
  assert.ok(!r.ok && r.kind === 'paused' && r.pauseUntil === P);
  const missing = route({ role: 'planning', roles: defaultRoles(), states: multi({ installed: { claude: false } }), now: NOW, label: LABEL, rule: 'same' });
  assert.deepEqual(ids(missing), ['cursor:default']);
  const ok = route({ role: 'planning', roles: defaultRoles(), states: multi({ claude: [acc('default'), acc('claude-w-0001')] }), now: NOW, label: LABEL, rule: 'same' });
  assert.ok(ok.ok);
  assert.deepEqual(ok.candidates.map((c) => [c.id, c.account, c.crossOnLimit]), [['claude', 'default', true], ['claude', 'claude-w-0001', true], ['cursor', 'default', false]]);
});

test('wait — second Claude account free ⇒ paused (the head pool is its FIRST account only; N2: no second head account is ever a candidate)', () => {
  const r = route({ role: 'planning', roles: defaultRoles(), states: multi({ claude: [acc('default', { pausedUntil: P }), acc('claude-w-0001')] }), now: NOW, label: LABEL, rule: 'wait' });
  assert.ok(!r.ok && r.kind === 'paused' && r.pauseUntil === P);
  const ok = route({ role: 'planning', roles: defaultRoles(), states: multi({ claude: [acc('default'), acc('claude-w-0001')], cursor: [acc('default'), acc('cursor-x-0001')] }), now: NOW, label: LABEL, rule: 'wait' });
  assert.ok(ok.ok);
  assert.ok(!ok.candidates.some((c) => c.id === 'claude' && c.account !== 'default'), 'N2: no second head account under wait');
  assert.deepEqual(ok.candidates.map((c) => [c.id, c.account, c.crossOnLimit]), [['claude', 'default', true], ['cursor', 'default', false]]);
});

test('Q7 / D-D: an account known to lack the model goes after those that offer it; none offers ⇒ still candidates, marked modelFallback; unknown (null) counts as offering', () => {
  const r = route({ role: 'planning', roles: defaultRoles({ cursorTakesOverReadOnly: false }), states: multi({ claude: [acc('default', { offersModel: false }), acc('claude-a-0001', { offersModel: null }), acc('claude-b-0001', { offersModel: true })] }), now: NOW, label: LABEL });
  assert.ok(r.ok);
  assert.deepEqual(r.candidates.map((c) => [c.account, c.modelFallback === true]), [['claude-a-0001', false], ['claude-b-0001', false], ['default', true]]);
  const none = route({ role: 'planning', roles: defaultRoles({ cursorTakesOverReadOnly: false }), states: multi({ claude: [acc('default', { offersModel: false })] }), now: NOW, label: LABEL });
  assert.ok(none.ok && none.candidates[0]!.modelFallback === true);
});

test('gates: a build never goes to Claude/Codex; research only Claude; D-G: an unverified named Cursor account never builds (visible reason), but does read-only work', () => {
  const states = multi({ cursor: [acc('default', { pausedUntil: P }), acc('cursor-x-0001', { buildOk: false })] });
  const b = route({ role: 'implementation', roles: { ...defaultRoles(), implementation: { providers: ['claude', 'cursor'] } }, states, now: NOW, label: LABEL });
  assert.ok(!b.ok && b.kind === 'paused', 'a build limit with only named Cursor accounts left ⇒ pause, as today');
  assert.ok(b.skipped.some((s) => s.kind === 'build-unverified' && /can run read-only work only until its build isolation is checked/.test(s.why)));
  assert.ok(b.skipped.some((s) => s.kind === 'gate' && s.id === 'claude'));
  const ro = route({ role: 'planning', roles: { ...defaultRoles(), planning: { providers: ['cursor'] } }, states, now: NOW, label: LABEL });
  assert.deepEqual(ids(ro), ['cursor:cursor-x-0001']);
  const research = route({ role: 'research', roles: { ...defaultRoles(), research: { providers: ['cursor', 'claude'] } }, states: multi({ claude: [acc('default'), acc('claude-r-0001')] }), now: NOW, label: LABEL });
  assert.deepEqual(ids(research), ['claude:default', 'claude:claude-r-0001']);
});

test('step 5: S-set paused ⇒ min; a never-signed-in named account never runs (fallback = a DEFAULT only) and never turns a pause into a failure', () => {
  const roles = defaultRoles({ cursorTakesOverReadOnly: false });
  const paused = route({ role: 'planning', roles, states: multi({ claude: [acc('default', { pausedUntil: P }), acc('claude-new-0001', { auth: 'unknown' })] }), now: NOW, label: LABEL });
  assert.ok(!paused.ok && paused.kind === 'paused' && paused.pauseUntil === P, 'adding an unsigned account never turns a pause into a failure');
  const named = route({ role: 'planning', roles, states: multi({ claude: [acc('default', { auth: 'not-logged-in' }), acc('claude-x-0001', { auth: 'not-logged-in' })] }), now: NOW, label: LABEL });
  assert.deepEqual(ids(named), ['claude:default'], 'the fallback picks the DEFAULT account, which reports its own error');
  const onlyNamed = route({ role: 'planning', roles, states: multi({ claude: [acc('claude-x-0001', { auth: 'unknown' }), acc('default', { enabled: false, isDefault: true })] }), now: NOW, label: LABEL });
  assert.ok(!onlyNamed.ok && onlyNamed.kind === 'ineligible' && /No signed-in account is available for planning/.test(onlyNamed.reason));
  // B1 with accounts: one signed out + one paused ⇒ today's rule (first non-paused default runs)
  const b1 = route({ role: 'planning', roles: defaultRoles(), states: multi({ claude: [acc('default', { auth: 'not-logged-in' })], cursor: [acc('default', { pausedUntil: P })] }), now: NOW, label: LABEL });
  assert.deepEqual(ids(b1), ['claude:default']);
});

test('dormant: a disabled account (named Codex, a removal in progress) is never a candidate', () => {
  const r = route({ role: 'review', roles: { ...defaultRoles(), review: { providers: ['codex'] } }, states: multi({ codex: [acc('default', { pausedUntil: P }), acc('codex-x-0001', { enabled: false })] }), now: NOW, label: LABEL });
  assert.ok(!r.ok && r.kind === 'paused');
  assert.ok(r.skipped.some((s) => s.kind === 'disabled' && s.account === 'codex-x-0001'));
});

test('S10 property: under every rule the candidate tools ⊆ the chain ∪ its complexity pick; hops ≤ candidates ≤ 3 × 8; route() pure (frozen input, no clock)', () => {
  const r = rng(10);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const RULES: LimitRule[] = ['switch', 'same', 'wait'];
  for (let i = 0; i < 3000; i++) {
    const role = pick(ROLES);
    const chain = pick(CHAINS);
    const auto = r() < 0.5 ? { [pick(['S', 'M', 'L'] as const)]: pick(['claude', 'cursor', 'codex'] as const) } : undefined;
    const roles: Roles = { ...defaultRoles(), [role]: { providers: chain, ...(auto ? { autoByComplexity: auto } : {}) } };
    const accs = (p: ProviderId) => Array.from({ length: 1 + Math.floor(r() * 8) }, (_, k) => acc(k === 0 ? 'default' : `${p}-a${k}-0001`, { pausedUntil: pick(PAUSES), auth: pick(['ok', 'unknown', 'not-logged-in'] as const), buildOk: k === 0 || r() < 0.5, offersModel: pick([true, false, null]) }));
    const states = multi({ claude: accs('claude'), cursor: accs('cursor'), codex: accs('codex'), installed: { claude: r() > 0.1, cursor: r() > 0.1, codex: r() > 0.1 } });
    const complexity = pick(COMPLEX);
    const allowed = new Set<ProviderId>([...chain, ...Object.values(auto ?? {})]);
    for (const rule of RULES) {
      const res = route({ role, complexity, roles, states, now: NOW, label: LABEL, rule });
      if (!res.ok) continue;
      for (const c of res.candidates) assert.ok(allowed.has(c.id), `${rule}: ${c.id} outside ${[...allowed]}`);
      assert.ok(res.candidates.length <= 24);
      if (rule === 'wait') for (const t of ['claude', 'cursor', 'codex'] as const) assert.ok(res.candidates.filter((x) => x.id === t).length <= 1, 'wait: at most the first account of each tool');
    }
  }
  const deepFreeze = <T>(o: T): T => {
    if (o && typeof o === 'object') for (const v of Object.values(o as object)) deepFreeze(v);
    return Object.freeze(o);
  };
  const input = deepFreeze({ role: 'planning' as const, roles: defaultRoles(), states: multi({ claude: [acc('default', { pausedUntil: P }), acc('claude-w-0001')] }), now: NOW, rule: 'same' as const });
  const realNow = Date.now;
  Date.now = () => {
    throw new Error('routing must not read the clock');
  };
  try {
    assert.deepEqual(route(input), route(input));
  } finally {
    Date.now = realNow;
  }
});

test('code review B2: under same, a limit may move between accounts of a FALLBACK tool (no flap); only head → other tool is blocked', () => {
  const s = multi({ installed: { claude: false }, cursor: [acc('default'), acc('cursor-personal-0001')] });
  const r = route({ role: 'planning', roles: defaultRoles(), states: s, now: NOW, label: LABEL, rule: 'same' });
  assert.ok(r.ok);
  assert.deepEqual(r.candidates.map((c) => [c.id, c.account, c.crossOnLimit]), [['cursor', 'default', true], ['cursor', 'cursor-personal-0001', true]]);
  // a fresh route's first candidate is always reachable — onLimitHit and the scheduler agree
  const after = route({ role: 'planning', roles: defaultRoles(), states: multi({ installed: { claude: false }, cursor: [acc('default', { pausedUntil: P }), acc('cursor-personal-0001')] }), now: NOW, label: LABEL, rule: 'same' });
  assert.ok(after.ok && after.candidates[0]!.account === 'cursor-personal-0001' && after.candidates[0]!.crossOnLimit);
});
