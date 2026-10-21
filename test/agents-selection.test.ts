// M8-2 plumbing against the fake CLIs: per-candidate selection, notes, selRole/toolDefaultOnly (S3), research (S11, B3a), the init check
// (S7), the unknown-model hook (S10) and the hostile matrix on the FULL argv the fakes record (S12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, type Harness } from './helpers/harness.ts';
import { AskService } from '../src/asks/service.ts';
import { normalizeConfig } from '../src/config.ts';
import { planRoles, RolesPlanError } from '../src/server/roles-plan.ts';
import { ModelService } from '../src/models/service.ts';
import type { EmitEvent } from '../src/agents/claude.ts';
import type { ResolvedSel } from '../src/models/select.ts';
import type { States } from '../src/agents/routing.ts';
import type { CatalogView } from '../src/models/types.ts';
import { claudeEnvView, cursorView, catalogs } from './models/m82-fixtures.ts';

const schema = { type: 'object', properties: { ok: { type: 'boolean' } } } as any;
const HOSTILE = ['--yolo', '-c', 'opus --dangerously-skip-permissions', 'a=b', 'x y', 'gpt-5[effort=high]', 'a'.repeat(65), 'op‮us', 'op​us', '__proto__'];
/** Hostile for Cursor/Codex only (W3/W4): Claude may carry one `[1m]`-style suffix (W2). */
const HOSTILE_NOT_CLAUDE = ['x[1m]', 'gpt-5.2[1m]'];

const stageArgv = (h: Harness, who: 'claude' | 'cursor', key?: string): string[][] => h.calls().filter((c) => c.who === who && c.argv[0] === '-p' && (!key || c.key === key)).map((c) => c.argv as string[]);
const slice = (a: string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] === '--model' || a[i] === '--effort') out.push(a[i]!, a[i + 1]!);
  return out;
};
const without = (a: string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--model' || a[i] === '--effort') {
      i++;
      continue;
    }
    out.push(a[i]!);
  }
  return out.map((x) => (x.startsWith('{') ? '<schema>' : x)).map((x, i, arr) => (arr[i - 1] === '--workspace' ? '<cwd>' : x));
};
async function ro(h: Harness, o: { role: any; key: string; selRole?: any; toolDefaultOnly?: true; states?: States; secrets?: string[]; events?: EmitEvent[] }) {
  return h.agents.readOnly({
    role: o.role, stage: 'plan', cwd: h.repoDir, prompt: `# Stage: PLAN\nIssue key: ${o.key}\nTitle: sel`, schema, name: `conductor ${o.key} plan`,
    onEvent: (e) => o.events?.push(e), states: o.states ?? h.engine.routeStates(), secrets: o.secrets ?? [], rule: 'switch',
    ...(o.selRole ? { selRole: o.selRole } : {}), ...(o.toolDefaultOnly ? { toolDefaultOnly: true as const } : {}),
  });
}
function attach(h: Harness, m: Partial<Record<CatalogView['provider'], CatalogView | null>>, onUnknown: (t: string) => void = () => undefined) {
  h.agents.attachModels({ catalog: catalogs(m), onUnknownModel: onUnknown });
}

test('selRole changes only the --model/--effort slice: same route, same refusal, file-tool profile, init check without research (S3)', async () => {
  const h = await makeHarness({ config: (c) => Object.assign(c.roles.research, { tool: 'claude', model: 'sonnet', effort: 'low' }) });
  try {
    attach(h, { claude: claudeEnvView() });
    const plain = await ro(h, { role: 'context', key: 'SR-1' });
    const sel = await ro(h, { role: 'context', key: 'SR-2', selRole: 'research' });
    assert.equal(plain.ok, true);
    assert.equal(sel.ok, true, 'the file-tool init passed the READ-ONLY predicate (with research it would be refused: unexpected tools Glob/Grep/Read)');
    assert.equal(sel.agent, plain.agent);
    const [a] = stageArgv(h, 'claude', 'SR-1');
    const [b] = stageArgv(h, 'claude', 'SR-2');
    assert.deepEqual(slice(a!), []);
    assert.deepEqual(slice(b!), ['--model', 'sonnet', '--effort', 'low']);
    assert.deepEqual(without(b!).map((x) => x.replace('SR-2', 'SR-1')), without(a!), 'identical apart from the model/effort slice');
    assert.ok(b!.includes('Read,Grep,Glob') && !b!.some((x) => /WebSearch|WebFetch/.test(x)) && !b!.includes('--allowedTools'));
    // same refusal when context is ineligible
    const blocked: States = { ...h.engine.routeStates(), claude: { ...h.engine.routeStates().claude, tier: 'blocked' } };
    const r1 = await ro(h, { role: 'context', key: 'SR-3', states: blocked });
    const r2 = await ro(h, { role: 'context', key: 'SR-4', states: blocked, selRole: 'research' });
    assert.deepEqual({ ...r2 }, { ...r1 });
    assert.equal(r1.ok, false);
    assert.equal(stageArgv(h, 'claude', 'SR-3').length + stageArgv(h, 'claude', 'SR-4').length, 0, 'zero spawns');
  } finally {
    await h.cleanup();
  }
});

test('toolDefaultOnly likewise, and wins over selRole (R2-N1); context summary pinned to tool default (N4)', async () => {
  const h = await makeHarness({
    config: (c) => {
      Object.assign(c.roles.research, { tool: 'claude', model: 'sonnet', effort: 'low' });
      Object.assign(c.roles.context, { tool: 'claude', model: 'haiku', effort: 'high' });
    },
  });
  try {
    attach(h, { claude: claudeEnvView() });
    await ro(h, { role: 'context', key: 'TD-1', selRole: 'research', toolDefaultOnly: true });
    await ro(h, { role: 'context', key: 'TD-2' });
    assert.deepEqual(slice(stageArgv(h, 'claude', 'TD-1')[0]!), [], 'tool default: no model, no role effort');
    assert.deepEqual(slice(stageArgv(h, 'claude', 'TD-2')[0]!), ['--model', 'haiku', '--effort', 'high'], 'Quick Ask has its own choice');
    // the engine's module summary runs as role context but never on the Quick Ask choice
    const before = h.calls().length;
    await (h.engine as any).summariseCall('# Stage: PLAN\nIssue key: CS-1\nTitle: summary');
    const sum = h.calls().slice(before).filter((c) => c.who === 'claude' && c.argv[0] === '-p');
    assert.equal(sum.length, 1);
    assert.deepEqual(slice(sum[0].argv), [], 'context summary runs without the Quick Ask --model/--effort');
  } finally {
    await h.cleanup();
  }
});

test('route() always gets req.role; skipped and fallback notes come from req.role whatever selRole is (N1)', async () => {
  const h = await makeHarness({ config: (c) => Object.assign(c.roles.research, { tool: 'claude', model: 'sonnet' }) });
  try {
    attach(h, { claude: claudeEnvView(), cursor: cursorView() });
    const paused: States = { ...h.engine.routeStates(), claude: { ...h.engine.routeStates().claude, pausedUntil: Date.now() + 3600_000 } };
    const ev1: EmitEvent[] = [];
    const ev2: EmitEvent[] = [];
    const a = await ro(h, { role: 'planning', key: 'RT-1', states: paused, events: ev1 });
    const b = await ro(h, { role: 'planning', key: 'RT-2', states: paused, events: ev2, selRole: 'research' });
    assert.equal(a.agent, 'cursor');
    assert.equal(b.agent, 'cursor');
    const notes = (e: EmitEvent[]) => e.filter((x) => x.agent === 'conductor').map((x) => x.text);
    assert.deepEqual(notes(ev2), notes(ev1));
    // research's Claude choice is never applied to Cursor
    assert.deepEqual(slice(stageArgv(h, 'cursor', 'RT-2')[0]!), []);
  } finally {
    await h.cleanup();
  }
});

test('fallback candidate runs with the tool default (AC9)', async () => {
  const h = await makeHarness({
    config: (c) => {
      Object.assign(c.roles.planning, { tool: 'claude', model: 'opus', effort: 'max' });
      c.toolModels.cursor = { model: 'gpt-5.3-codex' };
    },
  });
  try {
    attach(h, { claude: claudeEnvView(), cursor: cursorView() });
    const paused: States = { ...h.engine.routeStates(), claude: { ...h.engine.routeStates().claude, pausedUntil: Date.now() + 3600_000 } };
    const r = await ro(h, { role: 'planning', key: 'FB-1', states: paused });
    assert.equal(r.agent, 'cursor');
    const argv = stageArgv(h, 'cursor', 'FB-1')[0]!;
    assert.deepEqual(argv.slice(-2), ['--model', 'gpt-5.3-codex-xhigh'], 'Cursor default family + the role effort fitted (max is not listed ⇒ xhigh), no Claude id');
    await ro(h, { role: 'planning', key: 'FB-2' });
    assert.deepEqual(slice(stageArgv(h, 'claude', 'FB-2')[0]!), ['--model', 'opus', '--effort', 'max']);
  } finally {
    await h.cleanup();
  }
});

test('run uses tool default and the timeline shows the note (AC8); timeline notes are redacted (S9)', async () => {
  const gone = 'claude-gone-secret-model-1';
  const h = await makeHarness({ config: (c) => Object.assign(c.roles.planning, { tool: 'claude', model: gone, effort: 'high' }) });
  try {
    attach(h, { claude: claudeEnvView() });
    const ev: EmitEvent[] = [];
    const r = await ro(h, { role: 'planning', key: 'NL-1', events: ev });
    assert.equal(r.ok, true);
    assert.deepEqual(slice(stageArgv(h, 'claude', 'NL-1')[0]!), ['--effort', 'high'], 'no --model: the tool default, effort kept');
    const notes = ev.filter((e) => e.agent === 'conductor' && e.kind === 'note').map((e) => e.text ?? '');
    assert.ok(notes.some((n) => /is no longer offered by Claude — using the tool default/.test(n)), notes.join('|'));
    const ev2: EmitEvent[] = [];
    await ro(h, { role: 'planning', key: 'NL-2', events: ev2, secrets: [gone] });
    const n2 = ev2.filter((e) => e.agent === 'conductor').map((e) => e.text ?? '');
    assert.ok(n2.length && n2.every((n) => !n.includes(gone)), n2.join('|'));
    // the pipeline: the plan stage's run log carries the same note, and the build sees its own selection
    const key = h.issue('Gone model');
    await h.settle();
    const evs = h.store.readEvents(key).events.filter((e) => e.agent === 'conductor').map((e) => e.text ?? '');
    assert.ok(evs.some((t) => /no longer offered by Claude/.test(t)), evs.join('|'));
  } finally {
    await h.cleanup();
  }
});

test('builds receive their selection through the envelope untouched (B2, §2.5)', async () => {
  const h = await makeHarness({ config: (c) => Object.assign(c.roles.implementation, { tool: 'cursor', model: 'gpt-5.3-codex', effort: 'high', fast: true }) });
  try {
    attach(h, { cursor: cursorView() });
    const key = h.issue('Build with a model');
    await h.settle();
    const build = h.calls().find((c) => c.who === 'cursor' && c.argv.includes('--force'));
    assert.ok(build, 'a build ran');
    assert.deepEqual(build.argv.slice(-2), ['--model', 'gpt-5.3-codex-high-fast']);
    assert.ok(build.argv.includes('--force') && !build.argv.includes('--mode'));
    assert.equal(h.run(key).status, 'ready');
  } finally {
    await h.cleanup();
  }
});

test("PUT /api/settings {stages:{plan:'cursor'}} on a planning role with a Claude model ⇒ the Cursor run has no Claude id (B2)", async () => {
  const h = await makeHarness({ config: (c) => Object.assign(c.roles.planning, { tool: 'claude', model: 'opus', effort: 'high' }) });
  try {
    attach(h, { claude: claudeEnvView(), cursor: cursorView() });
    const { applySettings } = await import('../src/config.ts');
    Object.assign(h.cfg, applySettings(h.cfg, { stages: { plan: 'cursor', review: 'claude', verify: 'claude' } } as any));
    assert.equal(h.cfg.roles.planning.providers[0], 'cursor');
    await ro(h, { role: 'planning', key: 'ST-1' });
    const a = stageArgv(h, 'cursor', 'ST-1')[0]!;
    assert.ok(!a.includes('opus') && !a.includes('--model'), a.join(' '));
    // normalizeRoles dropping an ineligible build head: the choice stays bound to its tool and is not applied to the new head
    const n = normalizeConfig({ ...h.cfg, roles: { ...h.cfg.roles, implementation: { providers: ['codex', 'cursor'], tool: 'codex', model: 'gpt-5.1-codex', custom: true } } });
    assert.deepEqual(n.roles.implementation.providers, ['cursor']);
    assert.equal(h.agents.selectionFor('implementation', 'cursor').modelArg, undefined);
  } finally {
    await h.cleanup();
  }
});

test('research runs through runResearch with the research profile and the row\'s sel (S11); fallback note in ask events and basis (B3a)', async () => {
  const h = await makeHarness({ config: (c) => Object.assign(c.roles.research, { tool: 'claude', model: 'sonnet', effort: 'low' }) });
  try {
    attach(h, { claude: claudeEnvView() });
    const asks = new AskService({ getConfig: () => h.cfg, agents: h.agents, routeStates: () => h.engine.routeStates(), freshHealth: () => h.engine.freshHealth(), cards: { create: () => ({ key: 'X-1' }) } } as any);
    const rec = await asks.startResearch({ question: 'Compare SQLite and Postgres for a local app' });
    await asks.idle();
    assert.equal(asks.get(rec.id)!.status, 'done');
    const r = h.calls().filter((c) => c.who === 'claude' && c.argv.includes('WebSearch,WebFetch'));
    assert.equal(r.length, 1);
    assert.ok(r[0].argv.includes('--allowedTools'), 'the research profile');
    assert.deepEqual(slice(r[0].argv), ['--model', 'sonnet', '--effort', 'low']);
    // the stored model disappears ⇒ tool default, visible in events and in the basis
    Object.assign(h.cfg.roles.research, { model: 'claude-gone-1' });
    const rec2 = await asks.startResearch({ question: 'Compare SQLite and Postgres again please' });
    await asks.idle();
    const done = asks.get(rec2.id)!;
    assert.equal(done.status, 'done');
    assert.ok(done.events!.some((e) => e.startsWith('conductor: claude-gone-1 is no longer offered by Claude')), done.events!.join('|'));
    assert.match(done.basis!, /; model: tool default \(no longer offered\)$/);
    const r2 = h.calls().filter((c) => c.who === 'claude' && c.argv.includes('WebSearch,WebFetch'));
    assert.deepEqual(slice(r2[1].argv), ['--effort', 'low']);
  } finally {
    await h.cleanup();
  }
});

test('checkClaudeInit with --model/--effort: good init passes; extra tool/MCP/skill/permissionMode still refused (read-only and research) (S7)', async () => {
  const h = await makeHarness({ config: (c) => Object.assign(c.roles.planning, { tool: 'claude', model: 'sonnet', effort: 'low' }) });
  try {
    attach(h, { claude: claudeEnvView() });
    assert.equal((await ro(h, { role: 'planning', key: 'IN-1' })).ok, true);
    h.scenario({ claude: { 'IN-2': { plan: [{ badInit: true }] }, 'IN-3': { plan: [{ extraTool: 'Bash' }] } } });
    for (const key of ['IN-2', 'IN-3']) {
      const r = await ro(h, { role: 'planning', key });
      assert.equal(r.errorKind, 'isolation', key);
      assert.deepEqual(slice(stageArgv(h, 'claude', key)[0]!), ['--model', 'sonnet', '--effort', 'low'], 'the model was set');
    }
    // research profile with a model set: an extra tool is still refused
    h.scenario({ claude: { '*': { unknown: [{ extraTool: 'Bash' }] } } });
    const sel = h.agents.selectionFor('research', 'claude');
    const forged: ResolvedSel = { ...sel, modelArg: 'sonnet', effortArg: 'low' };
    const res = await h.agents.provider('claude').runResearch!({ cwd: h.repoDir, prompt: 'research', schema, name: 'r', onEvent: () => undefined, sel: forged });
    assert.equal(res.errorKind, 'isolation');
  } finally {
    await h.cleanup();
  }
});

test('cliRejectedModel only on a structural stderr failure with a modelArg; result prose saying "unknown model" never sets it (S10)', async () => {
  const h = await makeHarness({ config: (c) => Object.assign(c.roles.planning, { tool: 'claude', model: 'sonnet' }, { providers: ['claude'] }) });
  try {
    const hits: string[] = [];
    attach(h, { claude: claudeEnvView() }, (t) => hits.push(t));
    h.scenario({ claude: { 'UM-1': { plan: [{ network: true, error: 'Error: invalid model: sonnet' }] }, 'UM-2': { plan: [{ error: 'There is an unknown model in your question' }] }, 'UM-3': { plan: [{ network: true, error: 'Error: invalid model: sonnet' }] } } });
    const a = await ro(h, { role: 'planning', key: 'UM-1' });
    assert.equal(a.cliRejectedModel, true);
    assert.deepEqual(hits, ['claude']);
    const b = await ro(h, { role: 'planning', key: 'UM-2' });
    assert.equal(b.cliRejectedModel, undefined, 'a result event (model/CLI prose) never sets it');
    assert.deepEqual(hits, ['claude']);
    // no modelArg ⇒ no flag, no hook
    Object.assign(h.cfg.roles.planning, { model: undefined, tool: undefined });
    delete h.cfg.roles.planning.model;
    delete h.cfg.roles.planning.tool;
    const c = await ro(h, { role: 'planning', key: 'UM-3' });
    assert.equal(c.cliRejectedModel, undefined);
    assert.deepEqual(hits, ['claude']);
    // Cursor: stderr + no result
    Object.assign(h.cfg.roles.requirements, { providers: ['cursor'], tool: 'cursor', model: 'gpt-5.2' });
    attach(h, { cursor: cursorView() }, (t) => hits.push(t));
    h.scenario({ cursor: { 'UM-4': { plan: [{ error: 'Error: model gpt-5.2 is not available for your plan' }] } } });
    const d = await ro(h, { role: 'requirements', key: 'UM-4' });
    assert.equal(d.cliRejectedModel, true);
    assert.deepEqual(hits, ['claude', 'cursor']);
  } finally {
    await h.cleanup();
  }
});

test('noteUnknownModel respects back-off (S10 → M8-1 S11)', async () => {
  const h = await makeHarness({ config: (c) => Object.assign(c.roles.planning, { tool: 'claude', model: 'sonnet' }, { providers: ['claude'] }) });
  try {
    const svc = new ModelService({ getConfig: () => h.cfg, bins: () => ({ claude: null, cursor: null }), log: { info: () => undefined, warn: () => undefined } });
    h.agents.attachModels({ catalog: () => claudeEnvView(), onUnknownModel: (t) => svc.noteUnknownModel(t) });
    h.scenario({ claude: { '*': { plan: [{ network: true, error: 'Error: invalid model: sonnet' }] } } });
    await ro(h, { role: 'planning', key: 'BO-1' });
    await new Promise((r) => setTimeout(r, 100));
    await ro(h, { role: 'planning', key: 'BO-2' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(svc.counters.refreshes, 1, 'two rejected runs inside the back-off window ⇒ one refresh');
    assert.equal(svc.counters.spawns, 0);
    svc.stop();
  } finally {
    await h.cleanup();
  }
});

test('hostile matrix: config / PUT / tampered cache / forged ResolvedSel never reach the full argv recorded by fake CLIs (S12)', async () => {
  const h = await makeHarness();
  try {
    const cl = claudeEnvView();
    const cu = cursorView();
    attach(h, { claude: cl, cursor: cu });
    let n = 0;
    const runBoth = async () => {
      n++;
      await ro(h, { role: 'planning', key: `HM-${n}` });
      await ro(h, { role: 'requirements', key: `HM-${n}` });
    };
    h.cfg.roles.requirements.providers = ['cursor'];
    // 1) hand-edited config (through the load-time normaliser)
    for (const v of HOSTILE) {
      const n1 = normalizeConfig({ ...h.cfg, roles: { ...h.cfg.roles, planning: { providers: ['claude'], tool: 'claude', model: v, effort: v }, requirements: { providers: ['cursor'], tool: 'cursor', model: v, custom: true, fast: true } }, toolModels: { claude: { model: v, custom: true }, cursor: { model: v, custom: true } } });
      Object.assign(h.cfg, { roles: n1.roles, toolModels: n1.toolModels });
      await runBoth();
      // hand-edited tool values (R2-N3)
    }
    for (const tool of ['__proto__', 'CLAUDE', 'cursor ', '--yolo', 42, {}]) {
      const n1 = normalizeConfig({ ...h.cfg, roles: { ...h.cfg.roles, planning: { providers: ['claude'], tool, model: 'opus' } } });
      assert.equal(n1.roles.planning.model, undefined, JSON.stringify(tool));
    }
    // 2) PUT: every hostile value is refused, nothing reaches the plan
    for (const v of HOSTILE) {
      for (const body of [{ roles: { planning: { providers: ['claude'], model: v, custom: true } } }, { roles: { planning: { providers: ['claude'], model: v } } }, { toolModels: { cursor: { model: v, custom: true } } }, { roles: { planning: { providers: ['claude'], effort: v } } }]) {
        assert.throws(() => planRoles({ body, cfg: h.cfg, states: h.engine.routeStates(), catalog: catalogs({ claude: cl, cursor: cu }), mode: 'put', egress: () => '' }), RolesPlanError, JSON.stringify(body).slice(0, 80));
        let p: ReturnType<typeof planRoles> | null = null;
        try {
          p = planRoles({ body, cfg: h.cfg, states: h.engine.routeStates(), catalog: catalogs({ claude: cl, cursor: cu }), mode: 'preview', egress: () => '' });
        } catch (e) {
          assert.ok(e instanceof RolesPlanError, 'a malformed body is a 400 in preview too');
        }
        if (p) {
          const draft = [p.roles.planning.model, p.roles.planning.effort, p.toolModels.cursor?.model];
          assert.ok(!draft.includes(v), `preview draft carries ${JSON.stringify(v)}`);
        }
      }
    }
    // 3) a stale, tampered cache: an entry that passes the rule was stored, but the list at use no longer has it; plus hostile ids in the view
    Object.assign(h.cfg.roles.planning, { tool: 'claude', model: 'opus-evil' });
    Object.assign(h.cfg.roles.requirements, { tool: 'cursor', model: 'evil-family', custom: undefined });
    delete h.cfg.roles.requirements.custom;
    h.cfg.toolModels = {};
    const tampered = { ...cl, models: [...cl.models!, ...HOSTILE.map((id) => ({ id, label: id }))] };
    const tamperedC = { ...cu, models: [...cu.models!, ...HOSTILE.map((id) => ({ id, label: id }))], families: [...cu.families!, ...HOSTILE.map((id) => ({ family: id, efforts: [''], thinking: false, fast: false, label: id, noZdr: false, ids: [id] }))] };
    attach(h, { claude: tampered, cursor: tamperedC });
    await runBoth();
    for (const v of HOSTILE) {
      Object.assign(h.cfg.roles.planning, { tool: 'claude', model: v });
      Object.assign(h.cfg.roles.requirements, { tool: 'cursor', model: v });
      await runBoth();
    }
    // 4) a forged ResolvedSel handed straight to the providers
    for (const v of HOSTILE) {
      const forged = { tool: 'claude', modelArg: v, effortArg: v, label: 'x', fast: false, thinking: false, source: 'role', notes: [] } as unknown as ResolvedSel;
      n++;
      await h.agents.provider('claude').runReadOnly!({ stage: 'plan', cwd: h.repoDir, prompt: `# Stage: PLAN\nIssue key: HM-${n}\nTitle: f`, schema, name: 'f', onEvent: () => undefined, sel: forged });
      await h.agents.provider('cursor').runReadOnly!({ stage: 'plan', cwd: h.repoDir, prompt: `# Stage: PLAN\nIssue key: HM-${n}\nTitle: f`, schema, name: 'f', onEvent: () => undefined, sel: { ...forged, tool: 'cursor' } });
    }
    // bracket suffixes: refused for Cursor at PUT, load and use; never in a Cursor argv
    for (const v of HOSTILE_NOT_CLAUDE) {
      assert.throws(() => planRoles({ body: { toolModels: { cursor: { model: v, custom: true } } }, cfg: h.cfg, states: h.engine.routeStates(), catalog: catalogs({ claude: cl, cursor: cu }), mode: 'put', egress: () => '' }), RolesPlanError);
      const n1 = normalizeConfig({ ...h.cfg, roles: { ...h.cfg.roles, requirements: { providers: ['cursor'], tool: 'cursor', model: v, custom: true } }, toolModels: { cursor: { model: v, custom: true } } });
      assert.equal(n1.roles.requirements.model, undefined);
      assert.equal(n1.toolModels.cursor, undefined);
      Object.assign(h.cfg.roles.requirements, { tool: 'cursor', model: v, custom: true });
      n++;
      await ro(h, { role: 'requirements', key: `HM-${n}` });
    }
    // CR-N2: a selection resolved for another tool is never applied by a provider (defence in depth)
    for (const [prov, tool] of [['claude', 'cursor'], ['cursor', 'claude']] as const) {
      const forged = { tool, modelArg: 'opus-for-the-wrong-tool', effortArg: 'high', label: 'x', fast: false, thinking: false, source: 'role', notes: [] } as unknown as ResolvedSel;
      n++;
      await h.agents.provider(prov).runReadOnly!({ stage: 'plan', cwd: h.repoDir, prompt: `# Stage: PLAN\nIssue key: HM-${n}\nTitle: w`, schema, name: 'w', onEvent: () => undefined, sel: forged });
      const a = h.calls().filter((c) => c.who === prov && c.key === `HM-${n}` && c.argv[0] === '-p')[0];
      assert.ok(a && !a.argv.includes('opus-for-the-wrong-tool') && !a.argv.includes('--effort'), `${prov} applied a ${tool} selection`);
    }
    // the assertion is on the FULL argv the fakes recorded
    const all = h.calls().filter((c) => (c.who === 'claude' || c.who === 'cursor') && c.argv[0] === '-p');
    assert.ok(all.length > HOSTILE.length * 4, `ran ${all.length}`);
    for (const c of all) {
      for (const v of HOSTILE) {
        if (v === '-c') assert.ok(!c.argv.includes('-c'), `-c in ${c.argv.join(' ')}`);
        else assert.ok(!c.argv.includes(v), `${JSON.stringify(v)} in ${c.who} argv`);
      }
      assert.ok(!c.argv.includes('opus-evil') && !c.argv.includes('evil-family'));
      if (c.who === 'cursor') for (const v of HOSTILE_NOT_CLAUDE) assert.ok(!c.argv.includes(v), `${v} in a Cursor argv`);
      assert.ok(!c.argv.some((x: string) => x.startsWith('--') && /yolo|dangerously|effort=/.test(x)));
      const m = c.argv.indexOf('--model');
      if (m >= 0) assert.match(c.argv[m + 1], /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}(?:\[[a-z0-9]{1,8}\])?$/);
    }
  } finally {
    await h.cleanup();
  }
});
