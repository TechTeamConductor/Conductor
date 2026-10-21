// M8-3 AC3 / AC4 / N3 / N4 / B3 — the engine, stages, research and Home calls with several accounts per tool (fake CLIs, no quota).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { makeHarness, TestClock, type Harness } from './helpers/harness.ts';
import { comments } from './helpers/util.ts';
import { applySettings } from '../src/config.ts';
import { accountFolder, createAccountFolder } from '../src/accounts/profile.ts';
import { AccountService } from '../src/accounts/service.ts';
import { AskService } from '../src/asks/service.ts';
import { used } from '../src/limits/budget.ts';
import { effectiveLimitRule } from '../src/accounts/limit-rule.ts';
import type { Config } from '../src/types.ts';
import type { ProviderId } from '../src/agents/providers/types.ts';

const W = 'claude-work-0001';
const P2 = 'claude-play-0002';
const P3 = 'claude-xtra-0003';
/** Named Claude accounts in config order, each with an empty 0700 folder, "signed in" per its last check (fake catalog). */
function accounts(h: Harness, ids: string[], opts: { signedOut?: string[]; claudeOnly?: boolean; rule?: Config['pipeline']['limitRule'] } = {}): Set<string> {
  const signed = new Set(ids.filter((x) => !(opts.signedOut ?? []).includes(x)));
  h.cfg.accounts.claude = [{ id: 'default', name: 'Main' }, ...ids.map((id) => ({ id, name: id.split('-')[1]![0]!.toUpperCase() + id.split('-')[1]!.slice(1) }))];
  for (const id of ids) if (!existsSync(accountFolder({ provider: 'claude', id }))) createAccountFolder({ provider: 'claude', id });
  h.agents.attachModels({ catalog: (t, a) => (a && a !== 'default' ? ({ provider: t, state: 'fresh', signedIn: signed.has(a) } as any) : null), onUnknownModel: () => undefined });
  if (opts.claudeOnly) h.cfg.roles = applySettings(h.cfg, { onClaudeLimit: 'wait' }).roles;
  if (opts.rule) h.cfg.pipeline.limitRule = opts.rule;
  return signed;
}
const limitComments = async (h: Harness, key: string) => (await comments(h, key)).filter((c) => /usage limit/i.test(c));
const limitNotes = (h: Harness) => h.notes.filter((n) => /limit/i.test(n.title));
const reset = (clock: TestClock, s = 3600) => Math.floor(clock.now() / 1000) + s;

test('read-only limit ⇒ the next ACCOUNT in the same call; the pause lands on the limited account; one comment + one notify; attempts refunded', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock });
  try {
    accounts(h, [W], { claudeOnly: true });
    h.scenario({ claude: { '*': { plan: [{ limit: { resetsAt: reset(clock) } }] } }, accounts: { [W]: { claude: { '*': {} } } } });
    const key = h.issue('Switch accounts');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready', JSON.stringify(run.history.map((x) => x.text)));
    const plans = h.calls().filter((c) => c.who === 'claude' && c.stage === 'plan');
    assert.deepEqual(plans.map((c) => c.acct), ['default', W], 'default hit its limit, the same call continued on Work');
    assert.ok(h.engine.pauseOf({ provider: 'claude', id: 'default' }), 'the pause is on the limited account');
    assert.equal(h.engine.pauseOf({ provider: 'claude', id: W }), null);
    assert.equal(h.engine.status().providerPause.claude, undefined, 'Claude as a tool is not paused while one account is free');
    const lc = await limitComments(h, key);
    assert.equal(lc.length, 1);
    assert.match(lc[0]!, /Claude · Main reached its usage limit; this step continued on Claude · Work/);
    assert.equal(limitNotes(h).length, 1);
    assert.ok(run.history.some((x) => /Claude · Main reached its usage limit — continued on Claude · Work/.test(x.text)));
    // later stages skip the paused default and run on Work straight away (no new episode)
    assert.ok(h.calls().filter((c) => c.who === 'claude' && c.stage === 'verify').every((c) => c.acct === W));
    assert.equal(run.account?.id, W);
    assert.ok(run.agentRuns <= 3, `agentRuns=${run.agentRuns}`);
  } finally {
    await h.cleanup();
  }
});

test('three hops in one episode ⇒ exactly 1 comment and 1 notify; the run ends on the first free account', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock });
  try {
    accounts(h, [W, P2, P3], { claudeOnly: true });
    const lim = { plan: [{ limit: { resetsAt: reset(clock) } }] };
    h.scenario({ claude: { '*': lim }, accounts: { [W]: { claude: { '*': lim } }, [P2]: { claude: { '*': lim } }, [P3]: { claude: { '*': {} } } } });
    const key = h.issue('Three hops');
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
    assert.deepEqual(h.calls().filter((c) => c.who === 'claude' && c.stage === 'plan').map((c) => c.acct), ['default', W, P2, P3]);
    assert.equal((await limitComments(h, key)).length, 1);
    assert.equal(limitNotes(h).length, 1);
  } finally {
    await h.cleanup();
  }
});

test('a tool hop on a LIMIT merges the fallback comment into the episode comment (one comment total); a non-limit tool move keeps today\'s fallback comment', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock, config: (c) => void (c.pipeline.planReview = 'always') });
  try {
    h.scenario({ claude: { '*': { plan_review: [{ limit: { resetsAt: reset(clock) } }] } } });
    const key = h.issue('Merge the fallback comment');
    await h.settle();
    const all = await comments(h, key);
    const about = all.filter((c) => /did the plan review step instead of Claude|usage limit/.test(c));
    assert.equal(about.length, 1, all.join('\n---\n'));
    assert.match(about[0]!, /Claude reached its usage limit; this step continued on Cursor\.\*\* Cursor did the plan review step instead of Claude\. It ran in ask mode/);
  } finally {
    await h.cleanup();
  }
  const h2 = await makeHarness();
  try {
    h2.engine.setHealthSource(() => ({ claude: { found: false } }));
    const key = h2.issue('Claude missing');
    await h2.settle();
    const all = await comments(h2, key);
    assert.ok(all.some((c) => /Cursor did the plan step instead of Claude/.test(c)), 'non-limit move: today\'s fallback comment');
    assert.ok(!all.some((c) => /usage limit/.test(c)));
  } finally {
    await h2.cleanup();
  }
});

test('build limit ⇒ the stage restarts at once on the next build-eligible account (moved.restarted, one comment); refunds; (named Cursor build-ok forced in the router states for this test only)', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock });
  try {
    const X = 'cursor-xbuild-0001';
    h.cfg.accounts.cursor = [{ id: 'default', name: 'Main' }, { id: X, name: 'Spare' }];
    createAccountFolder({ provider: 'cursor', id: X });
    h.agents.attachModels({ catalog: (t, a) => (a === X ? ({ provider: t, state: 'fresh', signedIn: true } as any) : null), onUnknownModel: () => undefined });
    // D-G keeps named Cursor accounts off builds (CURSOR_ACCOUNT_HOME_BUILD_VERIFIED = false). To exercise the restart MECHANISM, this test
    // marks the spare account build-ok in the engine's router view only; the envelope/adapter path below still runs the real env + assertion.
    const orig = h.engine.routeStates.bind(h.engine);
    (h.engine as any).routeStates = (role?: any) => {
      const s: any = orig(role);
      return { ...s, cursor: { ...s.cursor, accounts: s.cursor.accounts.map((a: any) => (a.id === X ? { ...a, buildOk: true } : a)) } };
    };
    h.scenario({ cursor: { '*': { build: [{ limit: true }, {}] } } });
    const key = h.issue('Build switches account');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready', JSON.stringify(run.history.map((x) => x.text)));
    const builds = h.calls().filter((c) => c.who === 'cursor' && c.stage === 'build');
    assert.deepEqual(builds.map((c) => c.acct), ['default', X]);
    assert.equal(builds[1].acctEnv.HOME, accountFolder({ provider: 'cursor', id: X }));
    assert.equal(builds[1].acctEnv.AGENT_CLI_CREDENTIAL_STORE, 'file');
    assert.equal(builds[1].env.GIT_CONFIG_GLOBAL, '/dev/null', 'the envelope git env still wins');
    assert.equal(run.moved?.restarted, true);
    assert.equal(run.moved?.reason, 'limit');
    assert.ok(run.history.some((x) => /Cursor · Main reached its usage limit — this step starts again on Cursor · Spare/.test(x.text)));
    assert.equal((await limitComments(h, key)).length, 1);
    assert.equal(limitNotes(h).length, 1);
    assert.ok(run.agentRuns <= 3, `rejected attempt refunded (agentRuns=${run.agentRuns})`);
  } finally {
    await h.cleanup();
  }
});

test('D-G in the engine: with only named Cursor accounts left for a build, the run PAUSES (they are never handed a build)', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock });
  try {
    const X = 'cursor-ro-0001';
    h.cfg.accounts.cursor = [{ id: 'default', name: 'Main' }, { id: X, name: 'Spare' }];
    createAccountFolder({ provider: 'cursor', id: X });
    h.agents.attachModels({ catalog: (t, a) => (a === X ? ({ provider: t, state: 'fresh', signedIn: true } as any) : null), onUnknownModel: () => undefined });
    h.scenario({ cursor: { '*': { build: [{ limit: true }] } } });
    const key = h.issue('No named build');
    await h.settle();
    assert.equal(h.run(key).status, 'paused');
    assert.ok(!h.calls().some((c) => c.who === 'cursor' && c.stage === 'build' && c.acct === X));
  } finally {
    await h.cleanup();
  }
});

test('nothing usable ⇒ paused until the earliest reset; auto-resume when an account is ADDED + signed in, on a REORDER under wait, and on a RULE change', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock });
  try {
    accounts(h, [], { claudeOnly: true });
    h.scenario({ claude: { '*': { plan: [{ limit: { resetsAt: reset(clock, 7200) } }] } }, accounts: { [W]: { claude: { '*': {} } }, [P2]: { claude: { '*': {} } } } });
    const key = h.issue('Waits, then resumes on a new account');
    await h.settle();
    assert.equal(h.run(key).status, 'paused');
    assert.equal(h.run(key).pauseKind, 'limit');
    // (a) an account is added and its check says signed in ⇒ the paused run resumes at once on it (the pause has 2 h to go)
    accounts(h, [W], { claudeOnly: true });
    h.engine.invalidate();
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
    assert.ok(h.run(key).history.some((x) => new RegExp(`${key} continues on Claude · Work`).test(x.text)));
    assert.ok(h.calls().some((c) => c.stage === 'plan' && c.acct === W));
  } finally {
    await h.cleanup();
  }
  const h2 = await makeHarness({ clock });
  try {
    accounts(h2, [W], { claudeOnly: true, rule: 'wait' });
    h2.scenario({ claude: { '*': { plan: [{ limit: { resetsAt: reset(clock, 7200) } }] } }, accounts: { [W]: { claude: { '*': {} } } } });
    const key = h2.issue('wait: only the first account');
    await h2.settle();
    assert.equal(h2.run(key).status, 'paused', 'wait: the second account is never used on a limit');
    assert.ok(!h2.calls().some((c) => c.acct === W));
    // (b) a reorder puts the free account first ⇒ resume
    h2.cfg.accounts.claude = [h2.cfg.accounts.claude[1]!, h2.cfg.accounts.claude[0]!];
    h2.engine.invalidate();
    await h2.settle();
    assert.equal(h2.run(key).status, 'ready');
  } finally {
    await h2.cleanup();
  }
  const h3 = await makeHarness({ clock });
  try {
    accounts(h3, [W], { claudeOnly: true, rule: 'wait' });
    h3.scenario({ claude: { '*': { plan: [{ limit: { resetsAt: reset(clock, 7200) } }] } }, accounts: { [W]: { claude: { '*': {} } } } });
    const key = h3.issue('rule change resumes');
    await h3.settle();
    assert.equal(h3.run(key).status, 'paused');
    // (c) the rule changes to switch (the engine reads only effectiveLimitRule) ⇒ resume on the next account
    h3.cfg.pipeline.limitRule = 'switch';
    assert.equal(effectiveLimitRule(h3.cfg), 'switch');
    h3.engine.invalidate();
    await h3.settle();
    assert.equal(h3.run(key).status, 'ready');
  } finally {
    await h3.cleanup();
  }
});

test('same: the head\'s last account hits a limit mid-call ⇒ no hop to Cursor, paused; a SPAWN-class failure of the head still falls back (non-limit)', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock });
  try {
    accounts(h, [W], { rule: 'same' }); // planning chain claude → cursor
    const lim = { plan: [{ limit: { resetsAt: reset(clock) } }] };
    h.scenario({ claude: { '*': lim }, accounts: { [W]: { claude: { '*': lim } } } });
    const key = h.issue('same never changes tool');
    await h.settle();
    assert.equal(h.run(key).status, 'paused');
    assert.deepEqual(h.calls().filter((c) => c.stage === 'plan').map((c) => `${c.who}:${c.acct}`), ['claude:default', `claude:${W}`]);
  } finally {
    await h.cleanup();
  }
  const h2 = await makeHarness();
  try {
    h2.cfg.pipeline.limitRule = 'same';
    h2.engine.setHealthSource(() => ({ claude: { found: false } }));
    const key = h2.issue('same: non-limit fallback kept');
    await h2.settle();
    assert.equal(h2.run(key).status, 'ready');
    assert.ok(h2.calls().some((c) => c.who === 'cursor' && c.stage === 'plan'));
  } finally {
    await h2.cleanup();
  }
});

test('B3b cap: successful switches never count; more than 6 episodes that ENDED IN A PAUSE ⇒ needs_human', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock });
  try {
    accounts(h, [W], { claudeOnly: true });
    const key = h.issue('Cap');
    await h.settle();
    const stages = (h.engine as any).stages;
    const limitOn = (id: string) => ({ provider: 'claude' as ProviderId, account: id, resetsAt: null, message: 'limit' });
    const newEpisode = () => h.store.update(key, (r) => { r.limitStreak = 0; r.status = 'running'; r.next = 'plan'; });
    for (let i = 0; i < 7; i++) {
      newEpisode();
      (h.engine as any).pauses.clear();
      await stages.onLimitHit(key, limitOn('default'), 'planning'); // Work is free ⇒ a switch, not a pause
      assert.equal(h.run(key).status, 'queued');
    }
    assert.equal(h.run(key).limitPauses ?? 0, 0, 'seven successful switches: never counted');
    for (let i = 1; i <= 7; i++) {
      newEpisode();
      (h.engine as any).pauses.clear();
      (h.engine as any).accountPause({ provider: 'claude', id: W }, clock.now() + 3600_000, 'limit');
      await stages.onLimitHit(key, limitOn('default'), 'planning');
      assert.equal(h.run(key).status, i <= 6 ? 'paused' : 'needs_human', `episode ${i}`);
    }
    assert.match(h.run(key).needsHuman!.reason, /hit a usage limit 6 separate times/);
  } finally {
    await h.cleanup();
  }
});

test('N4: N limit-paused runs on one role ⇒ ONE router-states computation per tick for that role', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock });
  try {
    accounts(h, [], { claudeOnly: true });
    h.scenario({ claude: { '*': { plan: [{ limit: { resetsAt: reset(clock, 7200) } }] } } });
    const keys = [h.issue('a'), h.issue('b'), h.issue('c')];
    await h.settle();
    for (const k of keys) assert.equal(h.run(k).status, 'paused');
    const orig = h.engine.routeStates.bind(h.engine);
    const seen: (string | undefined)[] = [];
    (h.engine as any).routeStates = (role?: string) => (seen.push(role), orig(role as any));
    h.engine.schedule();
    assert.equal(seen.filter((r) => r === 'planning').length, 1, `calls: ${seen.join(',')}`);
  } finally {
    await h.cleanup();
  }
});

test('removal of the account a stage runs on ⇒ that stage stops and starts again on the next account (moved.restarted, reason removed, refunded, not a human restart); sign-out runs; the folder is deleted only after the child exited (N3)', async () => {
  const h = await makeHarness();
  try {
    accounts(h, [W], { claudeOnly: true });
    h.cfg.accounts.claude = [h.cfg.accounts.claude[1]!, h.cfg.accounts.claude[0]!]; // Work first
    h.scenario({ claude: { '*': {} }, accounts: { [W]: { claude: { '*': { plan: [{ delayMs: 4000 }] } } } } });
    const svc = new AccountService({ getConfig: () => h.cfg, saveConfig: (c) => void Object.assign(h.cfg, c), engine: h.engine, extraEnv: { FAKE_DIR: h.fakeDir } });
    const key = h.issue('Removed mid-stage');
    await h.engine.tick();
    for (let i = 0; i < 50 && !h.calls().some((c) => c.acct === W && c.stage === 'plan'); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.run(key).account?.id, W);
    const folder = accountFolder({ provider: 'claude', id: W });
    const out = await svc.remove(W);
    assert.equal(out.restarted, 1);
    assert.equal(out.signedOut, true);
    assert.ok(!existsSync(folder), 'folder deleted');
    const run = h.run(key);
    assert.equal(run.moved?.restarted, true);
    assert.equal(run.moved?.reason, 'removed');
    assert.match(run.moved!.note, /Claude · Work was removed, so this stage started again on Claude/);
    assert.equal(run.restartTimes?.length ?? 0, 0, 'not a human restart');
    const calls = h.calls();
    const logoutAt = calls.findIndex((c) => c.mode === 'logout' && c.acct === W);
    assert.ok(logoutAt > calls.findIndex((c) => c.acct === W && c.stage === 'plan'), 'sign-out after the aborted stage');
    assert.deepEqual(h.cfg.accounts.claude.map((m) => m.id), ['default']);
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
  } finally {
    await h.cleanup();
  }
});

test('Home never queues: every account at its limit ⇒ 409 limited + retryAt, NO counter taken; mid-call exhaustion ⇒ failed + limited + refund; research gate and run agree; research moves to the next Claude account', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock });
  try {
    accounts(h, [W]);
    h.cfg.roles.context = { providers: ['claude'] };
    const a = new AskService({ getConfig: () => h.cfg, agents: h.agents, routeStates: (role) => h.engine.routeStates(role), freshHealth: () => h.engine.freshHealth(), accountsGate: (r) => h.engine.accountsGate(r), limitRule: () => effectiveLimitRule(h.cfg), accountPause: (ref: any, u: number, why: string) => h.engine.recordAccountPause(ref, u, why), notify: (t, m) => h.notes.push({ title: t, message: m }), now: () => clock.now() });
    // research: default limited ⇒ the same run continues on Work (only Claude passes the research gate)
    h.scenario({ claude: { '*': { research: [{ limit: { resetsAt: reset(clock) } }] } }, accounts: { [W]: { claude: { '*': {} } } } });
    const r1 = await a.startResearch({ question: 'What is new in X?' });
    await a.idle();
    const rec = a.get(r1.id)!;
    assert.equal(rec.status, 'done', rec.error);
    assert.deepEqual(h.calls().filter((c) => c.stage === 'research').map((c) => c.acct), ['default', W]);
    assert.equal(limitNotes(h).length, 1, 'one notify for the research episode');
    // now every Claude account is limited ⇒ the gate refuses BEFORE a record or a counter
    h.engine.recordAccountPause({ provider: 'claude', id: W }, clock.now() + 5 * 60_000, 'limit');
    const before = used('asksPerHour', { now: clock.now() });
    assert.throws(() => a.start({ question: 'q' }), (e: any) => e.status === 409 && e.code === 'limited' && typeof e.extra.retryAt === 'number');
    await assert.rejects(a.startResearch({ question: 'q2' }), (e: any) => e.status === 409 && e.code === 'limited' && e.extra.retryAt === clock.now() + 5 * 60_000);
    assert.equal(used('asksPerHour', { now: clock.now() }), before, 'counter untouched');
    assert.equal(h.engine.accountsGate('research').ok, false, 'the gate and the run use the same route');
    // mid-call exhaustion: clear the pauses, then both accounts reject the ask ⇒ failed + limited + refunded
    (h.engine as any).pauses.clear();
    const lim = { ask: [{ limit: { resetsAt: reset(clock) } }] };
    h.scenario({ claude: { '*': lim }, accounts: { [W]: { claude: { '*': lim } } } });
    const r2 = a.start({ question: 'mid-call' });
    assert.equal(used('asksPerHour', { now: clock.now() }), before + 1);
    await a.idle();
    const rec2 = a.get(r2.id)!;
    assert.equal(rec2.status, 'failed');
    assert.equal(rec2.errorKind, 'limited');
    assert.ok(typeof rec2.retryAt === 'number');
    assert.equal(rec2.refunded, true);
    assert.equal(used('asksPerHour', { now: clock.now() }), before, 'refunded once');
  } finally {
    await h.cleanup();
  }
});

test('removal during a running ask ⇒ the ask ends failed "the account was removed" and is refunded; the folder goes only after the child exits (N3)', async () => {
  const h = await makeHarness();
  try {
    accounts(h, [W]);
    h.cfg.accounts.claude = [h.cfg.accounts.claude[1]!, h.cfg.accounts.claude[0]!];
    h.cfg.roles.context = { providers: ['claude'] };
    h.scenario({ accounts: { [W]: { claude: { '*': { ask: [{ delayMs: 4000 }] } } } } });
    const a = new AskService({ getConfig: () => h.cfg, agents: h.agents, routeStates: (role) => h.engine.routeStates(role), freshHealth: () => h.engine.freshHealth(), accountsGate: (r) => h.engine.accountsGate(r), limitRule: () => effectiveLimitRule(h.cfg) });
    const svc = new AccountService({ getConfig: () => h.cfg, saveConfig: (c) => void Object.assign(h.cfg, c), engine: h.engine, extraEnv: { FAKE_DIR: h.fakeDir }, abortCalls: (ref) => a.abortAccount(ref) });
    const before = used('asksPerHour');
    const r = a.start({ question: 'long' });
    for (let i = 0; i < 60 && !h.calls().some((c) => c.acct === W); i++) await new Promise((res) => setTimeout(res, 50));
    await svc.remove(W, { keepSignin: true });
    const rec = a.get(r.id)!;
    assert.equal(rec.status, 'failed');
    assert.match(rec.error!, /was removed/);
    assert.equal(used('asksPerHour'), before, 'refunded');
    assert.ok(!existsSync(accountFolder({ provider: 'claude', id: W })));
    assert.ok(!h.calls().some((c) => c.mode === 'logout'), '--keep-signin skips the sign-out');
  } finally {
    await h.cleanup();
  }
});

test('S24: a named Codex account in config is inert — never routed, never spawned', async () => {
  const h = await makeHarness({ config: (c) => void (c.roles.review = { providers: ['codex', 'claude'] }) });
  try {
    h.cfg.accounts.codex = [{ id: 'default', name: 'Main' }, { id: 'codex-x-0001', name: 'X' }];
    const s = h.engine.routeStates('review');
    assert.equal(s.codex.accounts!.find((a) => a.id === 'codex-x-0001')!.enabled, false);
    rmSync(h.fakeDir, { recursive: true, force: true });
  } finally {
    await h.cleanup();
  }
});

test('a reset (pause expiry) never interrupts a healthy stage: routing happens only at stage start', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock });
  try {
    accounts(h, [W], { claudeOnly: true });
    h.engine.recordAccountPause({ provider: 'claude', id: 'default' }, clock.now() + 60_000, 'limit');
    h.scenario({ accounts: { [W]: { claude: { '*': { plan: [{ delayMs: 1500 }] } } } } });
    const key = h.issue('Long stage on Work');
    await h.engine.tick();
    for (let i = 0; i < 60 && !h.calls().some((c) => c.acct === W); i++) await new Promise((r) => setTimeout(r, 25));
    clock.advance(120_000); // the default account's pause expires while the stage runs on Work
    await h.engine.tick();
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'ready');
    assert.ok(!run.sessions.some((s) => s.status === 'aborted'), 'nothing was aborted');
    assert.equal(h.calls().filter((c) => c.stage === 'plan').length, 1, 'one plan call, on Work');
  } finally {
    await h.cleanup();
  }
});

test('B2 side effect: routeStates sets webResearchIsolated from CODE (Claude in safe-mode only) — research routes, and a research pairing validates', async () => {
  const h = await makeHarness();
  try {
    const s = h.engine.routeStates('research');
    assert.equal(s.claude.webResearchIsolated, true);
    assert.equal(s.cursor.webResearchIsolated, undefined);
    assert.equal(h.engine.accountsGate('research').ok, true);
    const { validatePairing } = await import('../src/agents/routing.ts');
    assert.deepEqual(validatePairing('research', 'claude', s), { ok: true });
    assert.equal(validatePairing('research', 'cursor', s).ok, false);
    h.cfg.agents.claude.isolation = 'setting-sources';
    assert.equal(h.engine.routeStates('research').claude.webResearchIsolated, undefined, 'never from config: setting-sources does not isolate');
  } finally {
    await h.cleanup();
  }
});

test('S16: Claude OAuth token shapes are redacted in event/comment/log text and refused by the commit guard', async () => {
  const { redact, looksSecret } = await import('../src/redact.ts');
  for (const t of ['sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdEFGH', 'sk-ant-ort01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdEFGH']) {
    assert.ok(!redact(`token: ${t}`).includes(t), t);
    assert.ok(looksSecret(t), t);
  }
});

test('code review B2: same — head not installed, Cursor default limited mid-call ⇒ continues on Cursor · Personal; no Paused comment; limitPauses unchanged (read-only path and onLimitHit)', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock });
  try {
    const X = 'cursor-personal-0001';
    h.cfg.pipeline.limitRule = 'same';
    h.cfg.pipeline.planApproval = 'manual'; // stop after the plan: the build would (correctly) pause — named Cursor accounts never build (D-G)
    h.cfg.accounts.cursor = [{ id: 'default', name: 'Main' }, { id: X, name: 'Personal' }];
    createAccountFolder({ provider: 'cursor', id: X });
    h.agents.attachModels({ catalog: (t, a) => (a === X ? ({ provider: t, state: 'fresh', signedIn: true } as any) : null), onUnknownModel: () => undefined });
    h.engine.setHealthSource(() => ({ claude: { found: false } }));
    h.scenario({ cursor: { '*': { plan: [{ limit: true }, {}] } } });
    const key = h.issue('same on a fallback tool');
    await h.settle();
    const run = h.run(key);
    assert.equal(run.status, 'awaiting_approval', JSON.stringify(run.history.map((x) => x.text)));
    assert.deepEqual(h.calls().filter((c) => c.who === 'cursor' && c.stage === 'plan').map((c) => c.acct), ['default', X]);
    const all = await comments(h, key);
    assert.ok(!all.some((c) => /Paused/.test(c)), 'no Paused comment');
    assert.ok(all.some((c) => /Cursor · Main reached its usage limit; this step continued on Cursor · Personal/.test(c)));
    assert.equal(run.limitPauses ?? 0, 0);
    // the same case through onLimitHit (the build/stage-restart path): a restart, never a pause
    h.store.update(key, (r) => { r.status = 'running'; r.next = 'plan'; r.limitStreak = 0; });
    await (h.engine as any).stages.onLimitHit(key, { provider: 'cursor', account: 'default', resetsAt: null, message: 'limit' }, 'planning');
    assert.equal(h.run(key).status, 'queued');
    assert.equal(h.run(key).limitPauses ?? 0, 0);
    assert.equal(h.run(key).moved?.restarted, true);
    assert.ok(!(await comments(h, key)).some((c) => /Paused/.test(c)));
  } finally {
    await h.cleanup();
  }
});

test('code review B1: briefs apply the limit rule and record account pauses — same: no tool hop + pause recorded; switch: hop to the next Claude account + pause on the limited one', async () => {
  const { briefKit, settled, workReply } = await import('./helpers/briefs.ts');
  const clock = new TestClock();
  const h = await makeHarness({ clock });
  try {
    h.cfg.roles.requirements = { providers: ['claude', 'cursor'] };
    h.cfg.pipeline.limitRule = 'same';
    const k = briefKit(h, { accountPause: (ref: any, u: number, why: string) => h.engine.recordAccountPause(ref, u, why), now: () => clock.now() } as any);
    h.scenario({ claude: { '*': { design: [{ limit: { resetsAt: reset(clock) } }] } }, cursor: { '*': { design: [{ json: workReply() }] } } });
    const v = await settled(k.briefs, k.briefs.start({ kind: 'work', line: 'Add CSV export', repo: 'demo' }).id);
    assert.equal(v.status, 'failed');
    assert.equal((v as any).errorKind, 'limited');
    assert.ok(!h.calls().some((c) => c.who === 'cursor'), 'same: a limit never moves the brief to another tool');
    assert.ok(h.engine.pauseOf({ provider: 'claude', id: 'default' }), 'the limited account is paused');
  } finally {
    await h.cleanup();
  }
  const h2 = await makeHarness({ clock });
  try {
    accounts(h2, [W]);
    h2.cfg.roles.requirements = { providers: ['claude'] };
    const k = briefKit(h2, { accountPause: (ref: any, u: number, why: string) => h2.engine.recordAccountPause(ref, u, why), now: () => clock.now() } as any);
    h2.scenario({ claude: { '*': { design: [{ limit: { resetsAt: reset(clock) } }] } }, accounts: { [W]: { claude: { '*': { design: [{ json: workReply() }] } } } } });
    const v = await settled(k.briefs, k.briefs.start({ kind: 'work', line: 'Add CSV export', repo: 'demo' }).id);
    assert.equal(v.status, 'ready', JSON.stringify(v));
    assert.deepEqual(h2.calls().filter((c) => c.stage === 'design').map((c) => c.acct), ['default', W]);
    assert.ok(h2.engine.pauseOf({ provider: 'claude', id: 'default' }), 'the hop recorded the pause on the limited account');
  } finally {
    await h2.cleanup();
  }
});

test('code review N6: a removal never overwrites a run that already left `running` (needs_human stays needs_human)', async () => {
  const h = await makeHarness();
  try {
    accounts(h, [W], { claudeOnly: true });
    const key = h.issue('N6');
    await h.settle();
    h.store.update(key, (r) => { r.status = 'needs_human'; r.needsHuman = { reason: 'x', origin: 'plan', at: 1 }; });
    (h.engine as any).jobAccount.set(key, `claude:${W}`);
    (h.engine as any).jobs.set(key, { ac: new AbortController(), promise: Promise.resolve() });
    await h.engine.accountRemoved({ provider: 'claude', id: W }, 'Claude · Work');
    (h.engine as any).jobs.delete(key);
    assert.equal(h.run(key).status, 'needs_human');
  } finally {
    await h.cleanup();
  }
});
