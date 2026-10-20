// M2 commit 2: roles in config v4, the v3→v4 migration, the Settings compatibility layer, and role routing inside the engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySettings, defaultConfig, migrateConfigV3ToV4, normalizeConfig, toSettings } from '../src/config.ts';
import { ROLES, defaultRoles, normalizeRoles } from '../src/agents/roles.ts';
import { BUILD_CAPABLE, PROVIDER_IDS } from '../src/agents/providers/static.ts';
import { capabilitiesOf, createProviders } from '../src/agents/providers/registry.ts';
import { makeHarness, TestClock } from './helpers/harness.ts';
import { comments } from './helpers/util.ts';

test('v3 → v4: stages + onClaudeLimit become role chains, the old keys are kept verbatim under legacy.v3, nothing else is lost', () => {
  const v3 = { version: 3, ui: { port: 5000 }, stages: { plan: 'claude', review: 'cursor', verify: 'claude' }, pipeline: { onClaudeLimit: 'cursor', maxLoops: 5 }, repos: [] };
  const m = migrateConfigV3ToV4(v3);
  assert.deepEqual(m.roles.planning.providers, ['claude', 'cursor']);
  assert.deepEqual(m.roles.review.providers, ['cursor'], 'an explicit cursor review stays cursor-only (v1: no fallback for a non-Claude stage)');
  assert.deepEqual(m.roles.verification.providers, ['claude', 'cursor']);
  assert.equal(m.pipeline.onClaudeLimit, undefined);
  assert.equal(m.pipeline.maxLoops, 5);
  assert.deepEqual(m.legacy.v3, { stages: v3.stages, onClaudeLimit: 'cursor' });
  const wait = migrateConfigV3ToV4({ version: 3, stages: { plan: 'claude' }, pipeline: { onClaudeLimit: 'wait' } });
  assert.deepEqual(wait.roles.planning.providers, ['claude']);
  const cfg = normalizeConfig(m);
  assert.equal(cfg.version, 4);
  assert.deepEqual(cfg.roles.implementation.providers, ['cursor'], 'roles the old config never had get the v1 defaults');
  assert.deepEqual(cfg.roles.research.providers, ['claude']);
  assert.equal(cfg.ui.port, 5000);
  // idempotent
  assert.deepEqual(normalizeConfig(JSON.parse(JSON.stringify(cfg))).roles, cfg.roles);
});

test('Settings compat layer: derived from roles; a PUT of the same values is a no-op; a stages PUT changes ONLY the first claude|cursor slot', () => {
  const c = defaultConfig();
  assert.deepEqual(toSettings(c).stages, { plan: 'claude', review: 'claude', verify: 'claude' });
  assert.equal(toSettings(c).onClaudeLimit, 'cursor');
  // round trip: GET → PUT of the same values changes nothing
  assert.deepEqual(applySettings(c, toSettings(c)).roles, c.roles);
  // stages.plan = cursor: first slot replaced, de-duplicated; review/verification untouched
  const p = applySettings(c, { stages: { plan: 'cursor', review: 'claude', verify: 'claude' } });
  assert.deepEqual(p.roles.planning.providers, ['cursor']);
  assert.deepEqual(p.roles.review.providers, ['claude', 'cursor']);
  assert.deepEqual(toSettings(p).stages.plan, 'cursor');
  // onClaudeLimit wait/cursor across the three read-only chains; implementation is never touched
  const w = applySettings(c, { onClaudeLimit: 'wait' });
  for (const r of ['planning', 'review', 'verification'] as const) assert.deepEqual(w.roles[r].providers, ['claude']);
  assert.deepEqual(w.roles.implementation.providers, ['cursor']);
  assert.equal(toSettings(w).onClaudeLimit, 'wait');
  assert.deepEqual(applySettings(w, { onClaudeLimit: 'cursor' }).roles, c.roles, 'wait → cursor restores the default chains');
  // garbage in a PUT is ignored, never trusted
  const g = applySettings(c, { stages: { plan: 'gpt' as any, review: 7 as any, verify: null as any }, onClaudeLimit: 'sometimes' as any });
  assert.deepEqual(g.roles, c.roles);
  assert.deepEqual(applySettings(c, { stages: 'x' as any }).roles, c.roles);
});

test('normalizeRoles treats a hand-edited / migrated config as UNTRUSTED: unknown ids, prototype keys, ineligible build owners, duplicates and over-long chains', () => {
  const dropped: string[] = [];
  const hostile = JSON.parse(`{
    "__proto__": { "providers": ["claude"] },
    "constructor": { "providers": ["claude"] },
    "planning": { "providers": ["claude", "gpt", "claude", "cursor", "cursor", "claude", "cursor", "claude"], "autoByComplexity": { "L": "cursor", "XL": "claude", "S": "nope" } },
    "implementation": { "providers": ["claude", "cursor"], "autoByComplexity": { "S": "claude", "M": "cursor" } },
    "review": "not an object",
    "debugging": { "providers": [] },
    "documentation": { "providers": ["claude"] }
  }`);
  const r = normalizeRoles(hostile, (m) => dropped.push(m));
  assert.deepEqual(Object.keys(r).sort(), [...ROLES].sort(), 'only the known roles, whatever keys the input had');
  assert.equal(Object.getPrototypeOf(r), Object.prototype);
  assert.equal(({} as any).providers, undefined, 'no prototype pollution');
  assert.deepEqual(r.planning.providers, ['claude', 'cursor'], 'unknown dropped, duplicates removed');
  assert.deepEqual(r.planning.autoByComplexity, { L: 'cursor' });
  assert.deepEqual(r.implementation.providers, ['cursor'], 'Claude cannot own a build role (static capability filter re-runs at load)');
  assert.deepEqual(r.implementation.autoByComplexity, { M: 'cursor' });
  assert.deepEqual(r.review.providers, defaultRoles().review.providers, 'a non-object role falls back to its default');
  assert.deepEqual(r.debugging.providers, ['cursor'], 'an empty chain falls back to its default');
  assert.deepEqual(r.documentation.providers, ['cursor'], 'documentation is build-class');
  assert.ok(dropped.some((m) => /unknown provider/.test(m)) && dropped.some((m) => /cannot own a build role/.test(m)));
  // non-object inputs
  for (const bad of [null, undefined, 5, 'x', [], [1, 2]]) assert.deepEqual(normalizeRoles(bad), defaultRoles());
});

test('the static build-capable set can never drift from the registry (and Claude has no build)', () => {
  const reg = createProviders({ getConfig: () => defaultConfig(), clock: { now: () => 0 } as any, extraEnv: {} });
  for (const id of PROVIDER_IDS) assert.equal(BUILD_CAPABLE.has(id), capabilitiesOf(reg[id]).build, id);
  assert.equal(capabilitiesOf(reg.claude).build, false);
  assert.equal(capabilitiesOf(reg.claude).readOnly, true);
  assert.equal(capabilitiesOf(reg.cursor).readOnly, true);
});

test('engine routing: a Claude that is not installed hands the read-only stage to Cursor, with a visible note and the weaker-tier reminder', async () => {
  const h = await makeHarness({ config: (c) => void (c.agents.claude.bin = '/nonexistent/claude') });
  try {
    const key = h.issue('Claude is missing');
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
    const plan = h.calls().find((x) => x.stage === 'plan');
    assert.equal(plan.who, 'cursor', 'Cursor planned');
    assert.ok(h.run(key).sessions.some((s) => s.agent === 'cursor' && s.stage === 'plan'));
    const notes = h.store.readEvents(key, 0, 500).events.filter((e) => e.kind === 'note').map((e) => e.text ?? '');
    assert.ok(notes.some((t) => /Claude is not installed or does not start — Cursor is doing this read-only step — ask mode, without Claude's tool lock-down/.test(t)), `visible note, got: ${notes.join(' | ')}`);
  } finally {
    await h.cleanup();
  }
});

test('engine routing: onClaudeLimit "wait" keeps v1 semantics — a limited Claude pauses the card; nothing falls back', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock, config: (c) => void (c.roles = applySettings(c, { onClaudeLimit: 'wait' }).roles) });
  try {
    h.scenario({ claude: { '*': { plan: [{ limit: { resetsAt: clock.now() + 60_000 } }, {}] } } });
    const key = h.issue('Wait for Claude');
    await h.settle();
    assert.equal(h.run(key).status, 'paused');
    assert.ok(h.engine.status().providerPause.claude);
    assert.equal(h.calls().filter((x) => x.who === 'cursor').length, 0, 'Cursor never touched it');
    assert.ok((await comments(h, key)).some((t) => /Claude usage limit reached/.test(t)), 'the pause comment names Claude (label from the registry)');
  } finally {
    await h.cleanup();
  }
});

test('engine routing: an assignment that no provider may take (a build role with only Claude) is held with the reason and ZERO spawns', async () => {
  const h = await makeHarness();
  try {
    // bypass config normalisation on purpose: simulate a state the router must still refuse
    (h.cfg as any).roles.implementation = { providers: ['claude'] };
    const key = h.issue('Nobody may build');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.match(h.run(key).needsHuman!.reason, /cannot write code/);
    assert.equal(h.calls().filter((x) => x.who === 'cursor' && x.stage === 'build').length, 0);
  } finally {
    await h.cleanup();
  }
});

test('a provider pause derived from a limit message is capped at 24 hours', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock });
  try {
    h.scenario({ claude: { '*': { plan: [{ limit: { resetsAt: clock.now() + 90 * 24 * 3_600_000 } }, {}] } } });
    const key = h.issue('Hostile reset time');
    await h.settle();
    const pp = h.engine.status().providerPause;
    assert.ok(pp.claude && pp.claude.until <= clock.now() + 24 * 3_600_000, 'a 90-day reset in a message becomes at most 24 h');
    assert.ok(key);
  } finally {
    await h.cleanup();
  }
});
