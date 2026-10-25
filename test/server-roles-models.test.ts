// M8-2 API: GET /api/roles additions, strict PUT /api/roles (AC7, S8, B1, B2, C1), POST /api/roles/preview (AC10, S2), AC8 API side, S11.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Api, ApiFail } from '../src/server/api.ts';
import { defaultConfig, normalizeConfig, saveConfig, loadConfig } from '../src/config.ts';
import { ensureHome, paths } from '../src/paths.ts';
import { ENTRY_KEYS } from '../src/server/roles-plan.ts';
import { startDemo, type DemoHandle } from '../src/demo.ts';
import type { ProviderState, States } from '../src/agents/routing.ts';
import type { CatalogView } from '../src/models/types.ts';
import type { Config } from '../src/types.ts';
import { claudeEnvView, codexView, cursorView, unavailable } from './models/m82-fixtures.ts';

const st = (o: Partial<ProviderState>): ProviderState => ({ caps: { readOnly: true, build: false, buildIsolationVerified: false }, tier: 'verified', installed: true, auth: 'ok', pausedUntil: null, ...o });
const STATES: States = {
  claude: st({}),
  cursor: st({ caps: { readOnly: true, build: true, buildIsolationVerified: true }, tier: 'partial' }),
  codex: st({ tier: 'unverified' }),
};

interface H {
  api: Api;
  cfg(): Config;
  saves: number;
  file: string;
  calls: { refresh: number; noteVersion: number; noteUnknownModel: number; viewAll: number };
  setCat(t: CatalogView['provider'], v: CatalogView | null): void;
}
/** An Api over a real throw-away config file (bytes/mtime are checked), fake routing states and an in-memory model view. */
function harness(over: { models?: false; cfg?: (c: Config) => void } = {}): H {
  const root = mkdtempSync(join(tmpdir(), 'cond-rolesapi-'));
  process.env.CONDUCTOR_HOME = join(root, 'home');
  process.env.CONDUCTOR_BACKUP_DIR = join(root, 'backups');
  ensureHome();
  const c0 = normalizeConfig(defaultConfig());
  over.cfg?.(c0);
  saveConfig(normalizeConfig(c0));
  let cfg = loadConfig();
  const cats: Partial<Record<CatalogView['provider'], CatalogView | null>> = { claude: claudeEnvView(), cursor: cursorView(), codex: unavailable('codex') };
  const calls = { refresh: 0, noteVersion: 0, noteUnknownModel: 0, viewAll: 0 };
  const h: H = {
    api: null as unknown as Api,
    cfg: () => cfg,
    saves: 0,
    file: paths.config(),
    calls,
    setCat: (t, v) => void (cats[t] = v),
  };
  const models = {
    viewAll: () => {
      calls.viewAll++;
      return (['claude', 'cursor', 'codex'] as const).map((p) => cats[p]).filter((x): x is CatalogView => !!x);
    },
    refresh: async () => {
      calls.refresh++;
      return unavailable('claude');
    },
    noteVersion: () => void calls.noteVersion++,
    noteUnknownModel: () => void calls.noteUnknownModel++,
  };
  h.api = new Api({
    getConfig: () => cfg,
    saveConfig: (c: Config) => {
      h.saves++;
      saveConfig(c);
      cfg = c;
    },
    engine: { routeStates: () => STATES, invalidate: () => undefined },
    ...(over.models === false ? {} : { models }),
  } as any);
  return h;
}
async function call(h: H, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  try {
    const r = await h.api.handle(method, path, new URLSearchParams(), body);
    return { status: r.status ?? 200, json: r.json };
  } catch (e) {
    if (e instanceof ApiFail) return { status: e.status, json: { error: { code: e.code, message: e.message, ...(e.field !== undefined ? { field: e.field } : {}) } } };
    return { status: 500, json: { error: { code: 'internal', message: 'Something went wrong inside Conductor (details are in the log).' } } };
  }
}
const bytes = (h: H) => readFileSync(h.file, 'utf8');

test('GET /api/roles: every key always present; rows; models; legacyNotices; roleViews (incl. research.tool === claude)', async () => {
  const h = harness({ cfg: (c) => Object.assign(c.roles.research, { providers: ['claude'] }) });
  const r = (await call(h, 'GET', '/api/roles')).json;
  for (const role of Object.keys(r.roles)) {
    assert.deepEqual(Object.keys(r.roles[role]).sort(), [...ENTRY_KEYS].sort(), role);
    for (const k of Object.keys(r.roleViews[role])) assert.ok(['tool', 'runsAs', 'who', 'status', 'notes'].includes(k));
  }
  assert.deepEqual(r.roles.planning, { providers: ['claude', 'cursor'], autoByComplexity: null, tool: null, model: null, custom: false, effort: null, fast: false, thinking: false });
  assert.deepEqual(r.rows.map((x: any) => x.id), ['ask', 'research', 'design', 'plan', 'review', 'build', 'verify']);
  assert.deepEqual(r.rows.find((x: any) => x.id === 'build').roles, ['implementation', 'debugging', 'documentation']);
  assert.deepEqual(r.toolModels, { claude: { model: null, custom: false }, cursor: { model: null, custom: false }, codex: { model: null, custom: false } });
  assert.deepEqual(r.legacyNotices, []);
  assert.equal(r.roleViews.planning.runsAs, 'claude');
  assert.equal(r.roleViews.planning.who, 'Claude · Tool default (Opus)');
  assert.equal(r.roleViews.implementation.runsAs, 'agent');
  assert.equal(r.roleViews.research.tool, 'claude');
  assert.equal(r.models.claude.effortLabel, 'Effort');
  assert.equal(r.models.cursor.effortLabel, 'Model effort');
  assert.equal(r.models.codex.effortLabel, 'Reasoning effort');
  assert.equal(r.models.claude.defaultLabel, 'Opus');
  assert.ok(!r.models.claude.options.some((o: any) => o.value === 'default'), "Claude's `default` alias is what Tool default means");
  assert.ok(r.models.claude.options.some((o: any) => o.value === 'claude-fable-5-1[1m]'));
  assert.equal(r.models.codex.state, 'unavailable');
  assert.ok(r.models.cursor.options.some((o: any) => o.value === 'gpt-5.3-codex' && o.hasBase && o.fast && o.efforts.includes('xhigh')));
  assert.equal(r.models.claude.customEffortHint.length > 10, true);
  // keys ⊆ the PUT allow-lists
  for (const t of Object.keys(r.toolModels)) assert.deepEqual(Object.keys(r.toolModels[t]).sort(), ['custom', 'model']);
});

test('roles[r] keys ⊆ PUT role-entry allow-list; toolModels[t] keys ⊆ {model, custom}', async () => {
  const h = harness({ cfg: (c) => Object.assign(c.roles.planning, { tool: 'claude', model: 'opus', effort: 'high' }) });
  const r = (await call(h, 'GET', '/api/roles')).json;
  for (const e of Object.values<any>(r.roles)) for (const k of Object.keys(e)) assert.ok((ENTRY_KEYS as readonly string[]).includes(k), k);
  for (const e of Object.values<any>(r.toolModels)) for (const k of Object.keys(e)) assert.ok(['model', 'custom'].includes(k), k);
});

test('without a model service, roles() uses null catalogs (N5)', async () => {
  const h = harness({ models: false });
  const r = await call(h, 'GET', '/api/roles');
  assert.equal(r.status, 200);
  assert.equal(r.json.models.claude.state, 'unavailable');
  assert.equal(r.json.models.claude.reason, 'Model lists are not available in this mode.');
  assert.equal(r.json.models.claude.defaultLabel, 'the tool chooses');
});

test('GET roles echoed unchanged on PUT is accepted and changes nothing (incl. a no-longer-available model)', async () => {
  const h = harness({
    cfg: (c) => {
      Object.assign(c.roles.planning, { tool: 'claude', model: 'claude-gone-1', effort: 'high' });
      Object.assign(c.roles.implementation, { tool: 'cursor', model: 'gpt-5.3-codex', effort: 'xhigh', fast: true });
      c.roles.review.autoByComplexity = { L: 'claude' };
    },
  });
  const before = bytes(h);
  const g = (await call(h, 'GET', '/api/roles')).json;
  assert.equal(g.roleViews.planning.status, 'no-longer-available');
  assert.ok(g.roleViews.planning.notes.some((n: string) => /claude-gone-1 is no longer offered by Claude/.test(n)));
  const r = await call(h, 'PUT', '/api/roles', { roles: g.roles });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(bytes(h), before, 'config bytes unchanged');
  assert.deepEqual(r.json.roles, g.roles);
  assert.equal(r.json.roleViews.implementation.runsAs, 'agent --model gpt-5.3-codex-xhigh-fast');
});

test('PUT /api/settings stages.plan=cursor leaves the Claude selection inert (other-tool); the GET roles echoed unmodified ⇒ 200, bytes unchanged (C1, B2)', async () => {
  const h = harness({ cfg: (c) => Object.assign(c.roles.planning, { tool: 'claude', model: 'opus', effort: 'high' }) });
  const s = await call(h, 'PUT', '/api/settings', { stages: { plan: 'cursor' } });
  assert.equal(s.status, 200);
  assert.equal(h.cfg().roles.planning.providers[0], 'cursor');
  assert.equal(h.cfg().roles.planning.model, 'opus', 'kept, but bound to Claude');
  const g = (await call(h, 'GET', '/api/roles')).json;
  assert.equal(g.roleViews.planning.status, 'other-tool');
  assert.equal(g.roleViews.planning.tool, 'cursor');
  assert.ok(!g.roleViews.planning.runsAs.includes('opus'), 'the Cursor run has no Claude id');
  assert.ok(g.roleViews.planning.notes[0].startsWith('Chosen for Claude; Cursor now leads'));
  const before = bytes(h);
  const r = await call(h, 'PUT', '/api/roles', { roles: g.roles });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(bytes(h), before);
  assert.equal(r.json.roleViews.planning.status, 'other-tool');
});

test('model-only PUT keeps chain and autoByComplexity; null clears (B1a)', async () => {
  const h = harness({ cfg: (c) => (c.roles.review.autoByComplexity = { L: 'claude' }) });
  const r = await call(h, 'PUT', '/api/roles', { roles: { review: { providers: ['claude', 'cursor'], model: 'sonnet', effort: 'low' } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.roles.review, { providers: ['claude', 'cursor'], autoByComplexity: { L: 'claude' }, tool: 'claude', model: 'sonnet', custom: false, effort: 'low', fast: false, thinking: false });
  assert.equal(r.json.roleViews.review.runsAs, 'claude --model sonnet --effort low');
  assert.equal(r.json.roleViews.review.who, 'Claude · Sonnet · Low');
  const c = await call(h, 'PUT', '/api/roles', { roles: { review: { providers: ['claude', 'cursor'], model: null, effort: null, autoByComplexity: null } } });
  assert.deepEqual(c.json.roles.review, { providers: ['claude', 'cursor'], autoByComplexity: null, tool: null, model: null, custom: false, effort: null, fast: false, thinking: false });
});

test('head change + echo ⇒ cleared with notice; effort fitted to the new default', async () => {
  const h = harness({ cfg: (c) => Object.assign(c.roles.planning, { tool: 'claude', model: 'opus', effort: 'high' }) });
  const g = (await call(h, 'GET', '/api/roles')).json;
  // the M8-U row: echo the whole entry with only providers changed
  const r = await call(h, 'PUT', '/api/roles', { roles: { planning: { ...g.roles.planning, providers: ['cursor', 'claude'] } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.roles.planning, { providers: ['cursor', 'claude'], autoByComplexity: null, tool: null, model: null, custom: false, effort: null, fast: false, thinking: false });
  assert.ok(r.json.notices.some((n: string) => /Planning: Cursor now leads, so the model chosen for Claude was cleared/.test(n)));
  assert.ok(r.json.notices.some((n: string) => /Cursor's default has no effort setting/.test(n)));
});

test('head change + new selection judged against the new head', async () => {
  const h = harness({ cfg: (c) => Object.assign(c.roles.planning, { tool: 'claude', model: 'opus' }) });
  const ok = await call(h, 'PUT', '/api/roles', { roles: { planning: { providers: ['cursor'], model: 'gpt-5.3-codex', effort: 'high', fast: true } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.roles.planning.tool, 'cursor');
  assert.equal(ok.json.roleViews.planning.runsAs, 'agent --model gpt-5.3-codex-high-fast');
  // the same fields echoed with a head change are treated as omitted (cleared) — a DIFFERENT Cursor id under a Claude head is judged and refused
  const echo = await call(h, 'PUT', '/api/roles', { roles: { planning: { providers: ['claude'], model: 'gpt-5.3-codex', effort: 'high', fast: true } } });
  assert.equal(echo.status, 200);
  assert.equal(echo.json.roles.planning.model, null);
  const bad = await call(h, 'PUT', '/api/roles', { roles: { planning: { providers: ['claude'], model: 'gpt-5.2' } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'unknown_model');
  assert.equal(bad.json.error.field, 'roles.planning.model');
});

test('tool:null with model kept ⇒ 400 field roles.<r>.tool; tool_mismatch only for a new selection', async () => {
  const h = harness({ cfg: (c) => Object.assign(c.roles.planning, { tool: 'claude', model: 'opus' }) });
  const a = await call(h, 'PUT', '/api/roles', { roles: { planning: { providers: ['claude', 'cursor'], tool: null, model: 'opus' } } });
  assert.equal(a.status, 400);
  assert.equal(a.json.error.field, 'roles.planning.tool');
  const b = await call(h, 'PUT', '/api/roles', { roles: { planning: { providers: ['claude', 'cursor'], tool: null } } });
  assert.equal(b.status, 200);
  assert.equal(b.json.roles.planning.model, null, 'tool:null with no model fields clears the selection');
  const m = await call(h, 'PUT', '/api/roles', { roles: { planning: { providers: ['claude', 'cursor'], tool: 'cursor', model: 'sonnet' } } });
  assert.equal(m.status, 400);
  assert.equal(m.json.error.code, 'tool_mismatch');
  assert.equal(m.json.error.field, 'roles.planning.tool');
  const echo = await call(h, 'PUT', '/api/roles', { roles: { planning: { providers: ['claude', 'cursor'], tool: 'claude', model: 'sonnet' } } });
  assert.equal(echo.status, 200, 'the server-derived tool echoed back is fine');
});

test('model change fits stored effort (one-line notice)', async () => {
  const h = harness({ cfg: (c) => Object.assign(c.roles.planning, { tool: 'cursor', model: 'gpt-5.3-codex', effort: 'xhigh' }, { providers: ['cursor'] }) });
  const r = await call(h, 'PUT', '/api/roles', { roles: { planning: { providers: ['cursor'], model: 'kimi-k3' } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.roles.planning.effort, 'max', 'xhigh ⇒ nearest of low/high/max, tie ⇒ higher');
  assert.ok(r.json.notices.some((n: string) => /Planning: the new model has no Extra high, so the effort is now Max/.test(n)));
});

test('negatives table: 400/403 with error.field, nothing saved, field only allow-listed names, unknown key truncated in message, no 500', async () => {
  const h = harness();
  h.setCat('codex', codexView());
  const before = bytes(h);
  const long = 'k'.repeat(200);
  const cases: [unknown, number, string, string][] = [
    [{ roles: { planning: { providers: ['claude'], bogus: 1 } } }, 400, 'bad_request', 'roles.planning'],
    [{ roles: {}, extra: 1 }, 400, 'bad_request', 'body'],
    [{ roles: { planning: { providers: ['claude'], [long]: 1 } } }, 400, 'bad_request', 'roles.planning'],
    [{}, 400, 'bad_request', 'body'],
    ['nope', 400, 'bad_request', 'body'],
    [{ roles: [] }, 400, 'bad_request', 'roles'],
    [JSON.parse('{"roles":{"__proto__":{"providers":["claude"]}}}'), 400, 'bad_request', 'roles'],
    [JSON.parse('{"roles":{"planning":{"providers":["claude"],"__proto__":{"x":1}}}}'), 400, 'bad_request', 'roles.planning'],
    [{ roles: { constructor: { providers: ['claude'] } } }, 400, 'bad_request', 'roles'],
    [{ roles: { planning: { providers: ['claude'], model: 42 } } }, 400, 'bad_request', 'roles.planning.model'],
    [{ roles: { planning: { providers: ['claude'], effort: 'turbo' } } }, 400, 'bad_request', 'roles.planning.effort'],
    [{ roles: { planning: { providers: ['claude'], fast: 'yes' } } }, 400, 'bad_request', 'roles.planning.fast'],
    [{ roles: { planning: { providers: ['claude'], custom: true } } }, 400, 'bad_request', 'roles.planning.custom'],
    [{ roles: { planning: { providers: ['claude'], model: '--yolo', custom: true } } }, 400, 'bad_request', 'roles.planning.model'],
    [{ roles: { planning: { providers: ['claude'], model: 'claude-opus-9' } } }, 400, 'unknown_model', 'roles.planning.model'],
    [{ roles: { planning: { providers: ['claude'], model: 'haiku', effort: 'none' } } }, 400, 'effort_not_offered', 'roles.planning.effort'],
    [{ roles: { planning: { providers: ['claude'], model: 'haiku', effort: 'minimal' } } }, 400, 'effort_not_offered', 'roles.planning.effort'],
    [{ roles: { planning: { providers: ['claude'], model: 'opus', fast: true } } }, 400, 'not_offered', 'roles.planning.fast'],
    [{ roles: { planning: { providers: ['cursor'], model: 'gpt-5.2', thinking: true } } }, 400, 'not_offered', 'roles.planning.thinking'],
    [{ roles: { planning: { providers: ['cursor'], model: 'gpt-5.2', custom: true, effort: 'high' } } }, 400, 'bad_request', 'roles.planning.effort'],
    [{ roles: { planning: { providers: ['cursor'], model: 'gpt-99', custom: true } } }, 400, 'unknown_model', 'roles.planning.model'],
    [{ roles: { planning: { providers: ['cursor'], model: 'gpt-5[effort=high]', custom: true } } }, 400, 'bad_request', 'roles.planning.model'],
    [{ roles: { planning: { providers: ['claude'], tool: 'cursor', model: 'opus' } } }, 400, 'tool_mismatch', 'roles.planning.tool'],
    [{ roles: { research: { providers: ['cursor'] } } }, 400, 'unsupported_pairing', 'roles.research.providers'],
    [{ roles: { review: { providers: ['codex'] } } }, 409, 'needs_acknowledgement', 'roles.review.providers'],
    [{ toolModels: { cursor: { model: 'gpt-99', custom: true } } }, 400, 'unknown_model', 'toolModels.cursor.model'],
    [{ toolModels: { codex: { model: 'x[1m]', custom: true } } }, 400, 'bad_request', 'toolModels.codex.model'],
    [{ toolModels: { claude: { model: 'opus', effort: 'high' } } }, 400, 'bad_request', 'toolModels.claude'],
    [{ toolModels: { CLAUDE: { model: 'opus' } } }, 400, 'bad_request', 'toolModels'],
    [{ roles: {}, acknowledge: 'codex' }, 400, 'bad_request', 'acknowledge'],
  ];
  const allowed = /^(body|roles|toolModels|acknowledge|roles\.[a-z]+(\.(providers|autoByComplexity|tool|model|custom|effort|fast|thinking))?|toolModels\.(claude|cursor|codex)(\.(model|custom))?)$/;
  for (const [body, status, code, field] of cases) {
    const r = await call(h, 'PUT', '/api/roles', body);
    assert.equal(r.status, status, `${JSON.stringify(body).slice(0, 120)} → ${JSON.stringify(r.json)}`);
    assert.equal(r.json.error.code, code, JSON.stringify(body).slice(0, 120));
    assert.equal(r.json.error.field, field, JSON.stringify(body).slice(0, 120));
    assert.match(r.json.error.field, allowed);
    assert.ok(!r.json.error.message.includes(long), 'an unknown key is truncated in the message');
    assert.equal(h.saves, 0, 'nothing saved');
  }
  assert.equal(bytes(h), before);
  const longMsg = (await call(h, 'PUT', '/api/roles', { roles: { planning: { providers: ['claude'], [long]: 1 } } })).json.error.message;
  assert.ok(longMsg.includes(JSON.stringify(long.slice(0, 30))));
});

test('PUT custom id: rule refused with field; Claude [1m] and Codex/Claude custom accepted', async () => {
  const h = harness();
  const ok = await call(h, 'PUT', '/api/roles', { roles: { planning: { providers: ['claude', 'cursor'], model: 'my-ft-model:1', custom: true } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.roleViews.planning.runsAs, 'claude --model my-ft-model:1');
  const br = await call(h, 'PUT', '/api/roles', { roles: { planning: { providers: ['claude', 'cursor'], model: 'claude-fable-5-1[1m]', effort: 'max' } } });
  assert.equal(br.status, 200, JSON.stringify(br.json));
  assert.equal(br.json.roleViews.planning.runsAs, 'claude --model claude-fable-5-1[1m] --effort max');
  const bad = await call(h, 'PUT', '/api/roles', { roles: { planning: { providers: ['claude', 'cursor'], model: 'x y', custom: true } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.field, 'roles.planning.model');
});

test('models unavailable: a discovered model is refused with models_unavailable; Tool default and custom still work', async () => {
  const h = harness();
  h.setCat('claude', unavailable('claude'));
  const r = await call(h, 'PUT', '/api/roles', { roles: { planning: { providers: ['claude', 'cursor'], model: 'opus' } } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'models_unavailable');
  assert.match(r.json.error.message, /refresh models, choose Tool default or type a custom id/);
  assert.equal((await call(h, 'PUT', '/api/roles', { roles: { planning: { providers: ['claude', 'cursor'], model: 'opus', custom: true } } })).status, 200);
  const g = (await call(h, 'GET', '/api/roles')).json;
  assert.equal(g.roleViews.planning.status, 'ok');
});

test('roleViews status no-longer-available / list-unavailable / signed-out (AC8 API side)', async () => {
  const h = harness({ cfg: (c) => Object.assign(c.roles.planning, { tool: 'claude', model: 'claude-gone-1' }) });
  assert.equal((await call(h, 'GET', '/api/roles')).json.roleViews.planning.status, 'no-longer-available');
  h.setCat('claude', { ...claudeEnvView(), signedIn: false });
  const so = (await call(h, 'GET', '/api/roles')).json.roleViews.planning;
  assert.equal(so.status, 'signed-out');
  assert.ok(so.notes.some((n: string) => /not offered while Claude is signed out/.test(n)));
  h.setCat('claude', unavailable('claude'));
  assert.equal((await call(h, 'GET', '/api/roles')).json.roleViews.planning.status, 'list-unavailable');
});

test('legacyNotices without the value; legacy.v5 never in any API response (B3b, S4c)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cond-rolesapi-legacy-'));
  process.env.CONDUCTOR_HOME = join(root, 'home');
  ensureHome();
  writeFileSync(paths.config(), JSON.stringify({ version: 5, agents: { cursor: { model: 'id[effort=high]' }, codex: { model: 'x[1m]' } } }));
  let cfg = loadConfig();
  const api = new Api({ getConfig: () => cfg, saveConfig: (c: Config) => void (cfg = c), engine: { routeStates: () => STATES, invalidate: () => undefined } } as any);
  const responses = [
    (await api.handle('GET', '/api/roles', new URLSearchParams(), undefined)).json,
    (await api.handle('POST', '/api/roles/preview', new URLSearchParams(), { roles: {} })).json,
    (await api.handle('PUT', '/api/roles', new URLSearchParams(), { roles: {} })).json,
    (await api.handle('GET', '/api/settings', new URLSearchParams(), undefined).catch(() => ({ json: {} }))).json,
  ];
  const g = responses[0] as any;
  assert.deepEqual(g.legacyNotices.map((n: any) => n.tool), ['cursor', 'codex']);
  for (const r of responses) {
    const s = JSON.stringify(r);
    assert.ok(!s.includes('effort=high') && !s.includes('x[1m]') && !s.includes('agentsModel') && !s.includes('"legacy"'), s.slice(0, 300));
  }
});

test('research.providers [\'cursor\'] still 400 (S11); research model judged against Claude (N1)', async () => {
  const h = harness();
  const r = await call(h, 'PUT', '/api/roles', { roles: { research: { providers: ['cursor'] } } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, 'unsupported_pairing');
  const m = await call(h, 'PUT', '/api/roles', { roles: { research: { providers: ['claude'], model: 'sonnet', effort: 'high' } } });
  assert.equal(m.status, 200, JSON.stringify(m.json));
  assert.equal(m.json.roles.research.tool, 'claude');
  assert.equal(m.json.roleViews.research.runsAs, 'claude --model sonnet --effort high');
});

test('toolModels PUT: default model for each tool, used by roles on Tool default', async () => {
  const h = harness();
  const r = await call(h, 'PUT', '/api/roles', { toolModels: { claude: { model: 'sonnet' }, cursor: { model: 'gpt-5.3-codex' } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.toolModels.claude, { model: 'sonnet', custom: false });
  assert.equal(r.json.roleViews.planning.runsAs, 'claude --model sonnet');
  assert.equal(r.json.roleViews.implementation.runsAs, 'agent --model gpt-5.3-codex');
  assert.equal(r.json.roleViews.planning.who, 'Claude · Tool default (Sonnet)');
  const g = (await call(h, 'GET', '/api/roles')).json;
  assert.equal(g.models.claude.defaultLabel, 'Tool default (Sonnet)'.replace(/^Tool default \((.*)\)$/, '$1'));
  const c = await call(h, 'PUT', '/api/roles', { toolModels: { claude: null, cursor: { model: null } } });
  assert.deepEqual(c.json.toolModels.claude, { model: null, custom: false });
  assert.equal(c.json.roleViews.planning.runsAs, 'claude');
});

test('preview is pure: config bytes/mtime/in-memory unchanged, zero spawn, zero refresh/noteUnknownModel, no backup (S2, AC10)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cond-rolesapi-rec-'));
  const rec = join(root, 'spawned.log');
  const bin = join(root, 'rec.mjs');
  writeFileSync(bin, `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(rec)}, process.argv.slice(2).join(' ') + '\\n');\n`);
  chmodSync(bin, 0o755);
  const h = harness({ cfg: (c) => { c.agents.claude.bin = bin; c.agents.cursor.bin = bin; c.agents.codex.bin = bin; } });
  const before = bytes(h);
  const mtime = statSync(h.file).mtimeMs;
  const mem = JSON.parse(JSON.stringify(h.cfg()));
  const bodies = [
    { roles: { planning: { providers: ['cursor', 'claude'], model: 'gpt-5.3-codex', effort: 'high', fast: true } } },
    { roles: { planning: { providers: ['claude'], model: 'claude-opus-9' } } },
    { toolModels: { claude: { model: 'sonnet' } } },
    { roles: { review: { providers: ['codex'] } } },
    { roles: { research: { providers: ['cursor'] } } },
  ];
  for (const b of bodies) {
    const r = await call(h, 'POST', '/api/roles/preview', b);
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  assert.equal(bytes(h), before, 'config.json bytes unchanged');
  assert.equal(statSync(h.file).mtimeMs, mtime, 'mtime unchanged');
  assert.deepEqual(JSON.parse(JSON.stringify(h.cfg())), mem, 'the in-memory config is untouched');
  assert.equal(h.saves, 0);
  assert.equal(existsSync(rec), false, 'nothing was spawned');
  assert.deepEqual({ refresh: h.calls.refresh, noteVersion: h.calls.noteVersion, noteUnknownModel: h.calls.noteUnknownModel }, { refresh: 0, noteVersion: 0, noteUnknownModel: 0 });
  assert.ok(h.calls.viewAll > 0, 'catalogs are read through the memory view only');
  const bk = process.env.CONDUCTOR_BACKUP_DIR!;
  assert.ok(!existsSync(bk) || readdirSync(bk).length === 0, 'no backup');
});

test('preview: fitted selections, problems for pairing/semantic outcomes with 200, malformed still 400 (B1d)', async () => {
  const h = harness();
  const fit = await call(h, 'POST', '/api/roles/preview', { roles: { planning: { providers: ['cursor'], model: 'claude-fable-5', effort: 'high', fast: true } } });
  assert.equal(fit.status, 200);
  assert.ok(fit.json.problems.some((p: any) => p.code === 'not_offered' && p.field === 'roles.planning.fast'));
  assert.ok(!fit.json.roleViews.planning.runsAs.includes('fast'), 'the draft got its flags fitted');
  assert.equal(fit.json.roleViews.planning.runsAs, 'agent --model claude-fable-5-high');
  const ack = await call(h, 'POST', '/api/roles/preview', { roles: { review: { providers: ['codex'] } } });
  assert.equal(ack.status, 200);
  assert.deepEqual(ack.json.problems.map((p: any) => [p.code, p.field]), [['needs_acknowledgement', 'roles.review.providers']]);
  const pair = await call(h, 'POST', '/api/roles/preview', { roles: { research: { providers: ['cursor'] } } });
  assert.equal(pair.status, 200);
  assert.equal(pair.json.problems[0].code, 'unsupported_pairing');
  assert.equal((await call(h, 'POST', '/api/roles/preview', { roles: { planning: { providers: ['claude'], nope: 1 } } })).status, 400);
  assert.equal((await call(h, 'POST', '/api/roles/preview', { bogus: 1 })).status, 400);
});

test('PUT and preview share planRoles (same fitted output); preview output fed back into PUT ⇒ 200 with the same runsAs (N6)', async () => {
  const h = harness();
  const body = { roles: { planning: { providers: ['cursor', 'claude'], model: 'gpt-5.3-codex', effort: 'xhigh', fast: true }, review: { providers: ['claude', 'cursor'], model: 'sonnet', effort: 'low' } }, toolModels: { claude: { model: 'haiku' } } };
  const p = await call(h, 'POST', '/api/roles/preview', body);
  assert.equal(p.status, 200);
  assert.deepEqual(p.json.problems, []);
  const put = await call(h, 'PUT', '/api/roles', { roles: p.json.roles, toolModels: { claude: p.json.toolModels.claude } });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  for (const r of Object.keys(p.json.roleViews)) assert.equal(put.json.roleViews[r].runsAs, p.json.roleViews[r].runsAs, r);
  assert.deepEqual(put.json.roles, p.json.roles);
});

// ───────────── over HTTP: CSRF and the body cap ─────────────
let demo: DemoHandle;
let port = 0;
let csrf = '';
function raw(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string; oversized?: true } = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers, agent: false }, (res) => { // a fresh connection: never a socket the server closed after a 413
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: t }));
    });
    // only an OVERSIZED body may see the server close the socket early (after its 413); any other socket error is a real failure
    req.on('error', (e) => (opts.oversized ? resolve({ status: 413, text: '' }) : reject(e)));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
const mut = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-conductor-csrf': csrf, 'sec-fetch-site': 'same-origin', ...extra });
before(async () => {
  demo = await startDemo({ port: 0, pollMs: 150, delayMs: 15 });
  port = demo.rt.server.listeningPort;
  csrf = JSON.parse((await raw('/api/state')).text).csrf;
});
after(async () => {
  await demo.close();
  rmSync(demo.home, { recursive: true, force: true });
});

test('preview without CSRF ⇒ 403; cross-site ⇒ 403; same body cap as PUT; error.field on the wire (S2c, N6, B1e)', async () => {
  const body = JSON.stringify({ roles: {} });
  for (const path of ['/api/roles/preview', '/api/roles']) {
    const method = path.endsWith('preview') ? 'POST' : 'PUT';
    assert.equal((await raw(path, { method, headers: { 'content-type': 'application/json' }, body })).status, 403, `${path} missing csrf`);
    assert.equal((await raw(path, { method, headers: mut({ 'sec-fetch-site': 'cross-site' }), body })).status, 403, `${path} cross-site`);
    const big = JSON.stringify({ roles: {}, pad: 'x'.repeat(1_100_000) });
    assert.equal((await raw(path, { method, headers: mut(), body: big, oversized: true })).status, 413, `${path} body cap`);
  }
  const ok = await raw('/api/roles/preview', { method: 'POST', headers: mut(), body });
  assert.equal(ok.status, 200);
  const bad = await raw('/api/roles', { method: 'PUT', headers: mut(), body: JSON.stringify({ roles: { planning: { providers: ['claude'], effort: 'turbo' } } }) });
  assert.equal(bad.status, 400);
  assert.deepEqual(JSON.parse(bad.text).error.field, 'roles.planning.effort');
  const other = await raw('/api/roles', { method: 'PUT', headers: mut(), body: 'nope' });
  assert.ok(!('field' in (JSON.parse(other.text).error ?? {})) || JSON.parse(other.text).error.field === 'body');
});
