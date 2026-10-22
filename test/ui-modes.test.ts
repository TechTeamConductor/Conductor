// ui/modes.js is a plain browser script (no import/export). Load the identical bytes in a fresh vm context and test the pure helpers.
// Results cross a realm boundary, so they are compared after a JSON round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

type Chain = string[];
type RoleEntry = { providers: Chain; [k: string]: unknown };
type Roles = Record<string, RoleEntry>;
type Choices = Record<string, Record<string, { ok: boolean; reason?: string; needsAck?: boolean }>>;
type Origin = { model: boolean; part: number; parts: number; after: string[]; waiting: string[]; unknown: number };
type RCard = { id: string; title: string; lane: string; status: string; deep: boolean; repo: string | null; createdAt: number; updatedAt: number; counts: { opened: number; listed: number; unverified: number }; convertedTo: string | null; error: string | null };
type Extras = { cards: Record<string, Origin>; research: { planning: RCard[]; ready: RCard[]; needs_human: RCard[] } };
interface Modes {
  detectMode(t: string): 'ask' | 'research' | 'work';
  NONE: string;
  matchRepo(text: string, names: string[]): string | null;
  resolveRepo(o: { text?: string; chosen?: string; lastUsed?: string; names: string[]; allowNone?: boolean }): { name: string | null; how: string };
  noneAllowed(mode: string, repoCount: number): boolean;
  taskFromText(text: string): { title: string; description?: string };
  ROLE_ROWS: readonly { id: string; label: string; role: string; followers: readonly string[] }[];
  leadOf(roles: Roles, role: string): string | null;
  setLead(chain: Chain, to: string): Chain;
  roleEdit(entry: RoleEntry, to: string): RoleEntry;
  rolesPatch(roles: Roles, changes: Record<string, string>): { roles: Record<string, RoleEntry> };
  acksNeeded(roles: Roles, choices: Choices, patch: { roles: Record<string, RoleEntry> }): { provider: string; roles: string[]; rows: string[] }[];
  withAck(patch: { roles: Record<string, RoleEntry> }, ids: string[]): { roles: Record<string, RoleEntry>; acknowledge?: string[] };
  selFields(sel: unknown): { model: string | null; custom: boolean; effort: string | null; fast: boolean; thinking: boolean };
  selOf(entry: unknown, tool: string): { model: string | null; custom: boolean; effort: string | null; fast: boolean; thinking: boolean };
  sameSel(a: unknown, b: unknown): boolean;
  withSel(patch: { roles: Record<string, RoleEntry> }, roles: unknown, sels: Record<string, unknown>): { roles: Record<string, any> };
  moreNote(total: unknown, shown: number, what: string): string;
  RESEARCH_COL: Record<string, string>;
  isAskId(id: unknown): boolean;
  boardExtras(board: unknown): Extras;
  partTip(p: unknown): string;
  waitNote(p: unknown): string;
  researchCounts(c: unknown): string;
  safeHttp(u: string): string | null;
  safeAttr(name: string, value: unknown): string | null;
  toolJobs(roles: Roles, provider: string): string;
  colHints(roles: Roles, labelOf: (id: string) => string): { planning: string | null; building: string | null; verifying: string | null };
  flowText(roles: Roles, planApproval: string, labelOf: (id: string) => string): { steps: { t: string; d: string }[]; howTail: string };
  LIMIT_RULE_LABEL: Record<string, string>;
  COMPLETE_AUTO_CONFIRM: string;
  isCompleteAuto(runMode: unknown): boolean;
  runModeOverridden(overridden: unknown, key: string): boolean;
  approveWaitingBody(eligible: unknown): { runs: { key: string; rev: number }[]; confirm: true };
  skipReasonLabel(reason: unknown): string;
}

const src = readFileSync(join(import.meta.dirname, '..', 'ui', 'modes.js'), 'utf8');
// a fresh context has only the JS built-ins; the browser's URL is the one web API modes.js uses
const sandbox: { ConductorModes?: Modes; URL: typeof URL } = { URL };
vm.runInNewContext(src, sandbox, { filename: 'ui/modes.js' });
const M = sandbox.ConductorModes!;
const j = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const LABEL: Record<string, string> = { claude: 'Claude', cursor: 'Cursor', codex: 'Codex' };
const label = (id: string): string => LABEL[id] ?? id;

/** v1 defaults (src/agents/roles.ts defaultRoles) */
const defaults = (): Roles => ({
  requirements: { providers: ['claude'] },
  context: { providers: ['claude'] },
  planning: { providers: ['claude', 'cursor'] },
  architecture: { providers: ['claude'] },
  implementation: { providers: ['cursor'] },
  review: { providers: ['claude', 'cursor'] },
  verification: { providers: ['claude', 'cursor'] },
  debugging: { providers: ['cursor'] },
  documentation: { providers: ['cursor'] },
  research: { providers: ['claude'] },
});

test('modes.js defines one frozen namespace and touches nothing else', () => {
  assert.ok(M, 'ConductorModes is defined');
  assert.deepEqual(Object.keys(sandbox).sort(), ['ConductorModes', 'URL']);
  const frozenDeep = (o: unknown, path: string): void => {
    if (!o || typeof o !== 'object') return;
    assert.ok(Object.isFrozen(o), `${path} is frozen`);
    for (const [k, v] of Object.entries(o)) frozenDeep(v, `${path}.${k}`);
  };
  frozenDeep(M, 'ConductorModes');
  assert.doesNotMatch(src, /\b(document|window|fetch|XMLHttpRequest|localStorage|sessionStorage|eval|Function|importScripts)\b/);
  assert.doesNotMatch(src, /^\s*(import|export)\b/m);
});

test('detectMode follows the design table', () => {
  const cases: [string, string][] = [
    ['', 'work'],
    ['   ', 'work'],
    ['Add a dark mode toggle to the settings page', 'work'],
    ['Where are rate limits enforced?', 'ask'],
    ['the login flow is broken?', 'ask'],
    ['find the code that sends emails', 'ask'],
    ['Explain the retry schedule', 'ask'],
    ['Compare job-queue options for webhook retries', 'research'],
    ['postgres vs mysql for this', 'research'],
    ['What is the safest way to roll out feature flags?', 'research'],
    ['How do I compare options?', 'research'],
    ['  HOW does pagination work  ', 'ask'],
    ['Fix the crash when the list is empty', 'work'],
  ];
  for (const [t, want] of cases) assert.equal(M.detectMode(t), want, t);
});

test('matchRepo: whole words, case-insensitive, unique only', () => {
  const names = ['demo-app', 'app', 'api', 'web.v2'];
  assert.equal(M.matchRepo('fix the app', names), 'app');
  assert.equal(M.matchRepo('Fix the APP now', names), 'app');
  assert.equal(M.matchRepo('apply this change', names), null, 'common-word prefix');
  assert.equal(M.matchRepo('rapid change', names), null, 'inside a word');
  assert.equal(M.matchRepo('in demo-app.', names), 'demo-app', 'sentence full stop');
  assert.equal(M.matchRepo('edit demo-app.js', names), null, 'part of a file name');
  assert.equal(M.matchRepo('the api and the app', names), null, 'two matches ⇒ none');
  assert.equal(M.matchRepo('deploy web.v2 today', names), 'web.v2', 'regex metacharacters are literal');
  assert.equal(M.matchRepo('deploy webXv2 today', names), null, '"." is not a wildcard');
  assert.equal(M.matchRepo('', names), null);
});

test('resolveRepo precedence: chosen > none > matched > last used > only repo', () => {
  const names = ['alpha', 'beta'];
  assert.deepEqual(j(M.resolveRepo({ text: 'beta', chosen: 'alpha', names })), { name: 'alpha', how: 'chosen' });
  assert.deepEqual(j(M.resolveRepo({ text: 'beta', chosen: M.NONE, names })), { name: null, how: 'none' });
  assert.deepEqual(j(M.resolveRepo({ text: 'fix beta', lastUsed: 'alpha', names })), { name: 'beta', how: 'matched' });
  assert.deepEqual(j(M.resolveRepo({ text: 'fix it', lastUsed: 'alpha', names })), { name: 'alpha', how: 'last' });
  assert.deepEqual(j(M.resolveRepo({ text: 'fix it', lastUsed: 'gone', names })), { name: null, how: 'unresolved' }, 'a stale last-used name is ignored');
  assert.deepEqual(j(M.resolveRepo({ text: 'fix it', names: ['solo'] })), { name: 'solo', how: 'only' });
  assert.deepEqual(j(M.resolveRepo({ text: 'x', chosen: 'unknown', names })), { name: null, how: 'unresolved' }, 'an unregistered choice is ignored');
});

test('taskFromText: first line as title (≤ 200), full text as description', () => {
  assert.deepEqual(j(M.taskFromText('  Add a toggle  ')), { title: 'Add a toggle' });
  assert.deepEqual(j(M.taskFromText('\n\nAdd a toggle\nIt must persist.')), { title: 'Add a toggle', description: 'Add a toggle\nIt must persist.' });
  const words = 'word '.repeat(60).trim(); // 299 chars with spaces
  const t1 = M.taskFromText(words);
  assert.ok(t1.title.length <= 200, String(t1.title.length));
  assert.ok(t1.title.endsWith('…'));
  assert.ok(t1.title.length - 1 >= 120);
  assert.match(t1.title, /word…$/, 'cut at a word boundary');
  assert.equal(t1.description, words);
  const blob = 'x'.repeat(250);
  const t2 = M.taskFromText(blob);
  assert.equal(t2.title.length, 200);
  assert.equal(t2.title, 'x'.repeat(199) + '…');
  assert.equal(t2.description, blob);
  assert.deepEqual(j(M.taskFromText('a   b\tc')), { title: 'a b c', description: 'a   b\tc' });
});

test('setLead replaces the lead, keeps order, de-duplicates, never mutates', () => {
  const c = ['claude', 'cursor'];
  assert.deepEqual(j(M.setLead(c, 'cursor')), ['cursor']);
  assert.deepEqual(j(M.setLead(c, 'claude')), ['claude', 'cursor']);
  assert.deepEqual(c, ['claude', 'cursor'], 'input untouched');
  assert.deepEqual(j(M.setLead(['cursor'], 'claude')), ['claude']);
  assert.deepEqual(j(M.setLead(['claude'], 'cursor')), ['cursor']);
  assert.deepEqual(j(M.setLead(['claude', 'codex'], 'cursor')), ['cursor', 'codex']);
  assert.deepEqual(j(M.setLead(['codex', 'claude', 'cursor'], 'claude')), ['claude', 'cursor']);
  assert.deepEqual(j(M.setLead([], 'claude')), ['claude']);
});

test('roleEdit echoes every other field (autoByComplexity, M8-2 fields, unknown keys)', () => {
  const entry = { providers: ['claude', 'cursor'], autoByComplexity: { L: 'claude' }, model: 'opus', effort: 'high', fast: false, foo: { bar: 1 } };
  const out = j(M.roleEdit(entry, 'cursor'));
  assert.deepEqual(out, { providers: ['cursor'], autoByComplexity: { L: 'claude' }, model: 'opus', effort: 'high', fast: false, foo: { bar: 1 } });
  assert.deepEqual(entry.providers, ['claude', 'cursor'], 'input untouched');
});

test('rolesPatch sends only real changes, mirrors followers on their own chains', () => {
  const roles = defaults();
  roles.documentation = { providers: ['cursor', 'codex'], model: 'm1' };
  roles.planning = { providers: ['claude', 'cursor'], autoByComplexity: { S: 'cursor' } };
  assert.deepEqual(j(M.rolesPatch(roles, { plan: 'claude' })), { roles: {} }, 'unchanged lead ⇒ nothing');
  assert.deepEqual(j(M.rolesPatch(roles, { plan: 'cursor' })), { roles: { planning: { providers: ['cursor'], autoByComplexity: { S: 'cursor' } } } });
  assert.deepEqual(j(M.rolesPatch(roles, { build: 'codex' })), {
    roles: {
      implementation: { providers: ['codex'] },
      debugging: { providers: ['codex'] },
      documentation: { providers: ['codex'], model: 'm1' },
    },
  });
  roles.architecture = { providers: ['cursor'] };
  assert.deepEqual(j(M.rolesPatch(roles, { design: 'cursor' })), { roles: { requirements: { providers: ['cursor'] } } }, 'a follower already led by the target is not sent');
  assert.deepEqual(j(M.rolesPatch(roles, { nope: 'cursor', ask: '' })), { roles: {} }, 'unknown rows and empty picks are ignored');
  assert.deepEqual(roles.planning.providers, ['claude', 'cursor'], 'input untouched');
});

test('the seven rows map to the v2 roles of the master plan', () => {
  assert.deepEqual(j(M.ROLE_ROWS.map((r) => [r.id, r.role, r.followers])), [
    ['ask', 'context', []], ['research', 'research', []], ['design', 'requirements', ['architecture']], ['plan', 'planning', []],
    ['review', 'review', []], ['build', 'implementation', ['debugging', 'documentation']], ['verify', 'verification', []],
  ]);
});

test('wording from roles: default roles give today\'s exact strings', () => {
  const r = defaults();
  assert.deepEqual(j(M.colHints(r, label)), { planning: 'Claude writes the plan', building: 'Cursor writes the code', verifying: 'Gates, then Claude checks' });
  assert.equal(M.toolJobs(r, 'cursor'), 'handles Build the code');
  assert.equal(M.toolJobs(r, 'claude'), 'handles Quick Ask, Deep Research, Design the work, Write the plan, Review the plan, Verify the result');
  assert.equal(M.toolJobs(r, 'codex'), 'not assigned to a job');
  const f = M.flowText(r, 'first', label);
  assert.deepEqual(j(f.steps.map((s) => s.d)), [
    'Claude reads the card and writes a plan', 'You confirm the first plan per repo', 'Cursor writes the code in a worktree',
    'Gates and Claude check every criterion', 'You merge. Conductor never pushes',
  ]);
  assert.equal(f.howTail, ' or a plan needs approval');
  assert.equal(M.flowText(r, 'auto', label).howTail, '');
  r.planning = { providers: ['cursor'] };
  assert.equal(M.colHints(r, label).planning, 'Cursor writes the plan');
  assert.deepEqual(j(M.colHints({}, label)), { planning: null, building: null, verifying: null }, 'no roles ⇒ static hints');
});

test('acksNeeded: one entry per newly added unverified provider, followers included, from the fresh GET', () => {
  const roles = defaults();
  const choices: Choices = {};
  for (const r of Object.keys(roles)) choices[r] = { claude: { ok: true, needsAck: false }, cursor: { ok: true, needsAck: false }, codex: { ok: true, needsAck: true } };
  choices.implementation!.claude = { ok: false, reason: 'Claude cannot write code.' };
  // two rows → two unverified providers: both listed, each with its rows
  choices.context!.cursor = { ok: true, needsAck: true };
  const p1 = M.rolesPatch(roles, { ask: 'cursor', build: 'codex' });
  assert.deepEqual(j(M.acksNeeded(roles, choices, p1)), [
    { provider: 'cursor', roles: ['context'], rows: ['Quick Ask'] },
    { provider: 'codex', roles: ['implementation', 'debugging', 'documentation'], rows: ['Build the code'] },
  ]);
  // a provider already in the chain needs no acknowledgement (the server does not re-judge it)
  const r2 = defaults();
  r2.planning = { providers: ['claude', 'codex'] };
  assert.deepEqual(j(M.acksNeeded(r2, choices, M.rolesPatch(r2, { plan: 'codex' }))), []);
  // ok:false and verified choices never ask
  assert.deepEqual(j(M.acksNeeded(roles, choices, M.rolesPatch(roles, { plan: 'cursor' }))), []);
  const bad = { roles: { implementation: { providers: ['claude'] } } };
  assert.deepEqual(j(M.acksNeeded(roles, choices, bad)), []);
  // no mutation
  assert.deepEqual(roles.implementation!.providers, ['cursor']);
});

test('withAck adds exactly the confirmed ids and never mutates the patch', () => {
  const patch = { roles: { implementation: { providers: ['codex'] } } };
  const body = j(M.withAck(patch, ['codex']));
  assert.deepEqual(body, { roles: { implementation: { providers: ['codex'] } }, acknowledge: ['codex'] });
  assert.deepEqual(j(M.withAck(patch, [])), { roles: { implementation: { providers: ['codex'] } } }, 'nothing confirmed ⇒ no field');
  assert.deepEqual(j(M.withAck(patch, ['codex', 'codex'])).acknowledge, ['codex'], 'no duplicate');
  assert.deepEqual(Object.keys(patch), ['roles'], 'patch untouched');
  const b2 = M.withAck(patch, ['codex']);
  (b2.roles.implementation!.providers as string[]).push('x');
  assert.deepEqual(patch.roles.implementation.providers, ['codex'], 'deep copy');
});

test('safeAttr: drops handlers, style and script URLs; keeps in-app and http(s) links', () => {
  const drop: [string, unknown][] = [
    ['href', 'javascript:alert(1)'], ['href', ' javascript:alert(1)'], ['href', 'JaVaScRiPt:x'], ['href', 'vbscript:x'], ['href', 'data:text/html,x'],
    ['href', '//evil.example/x'], ['src', 'file:///etc/passwd'], ['action', 'javascript:x'], ['xlink:href', 'javascript:x'],
    ['onclick', 'alert(1)'], ['onClick', 'x'], ['style', 'color:red'], ['srcdoc', '<b>'], ['formaction', '/x'], ['innerHTML', '<b>'],
    ['srcset', 'https://x.test/a.png 1x'], ['ping', 'javascript:x'], ['background', 'javascript:x'], ['cite', 'vbscript:x'], ['longdesc', 'data:text/html,x'],
    ['manifest', '//evil.example/m'], ['poster', 'javascript:x'], ['XLINK:HREF', 'javascript:x'], ['codebase', 'javascript:x'], ['data', 'javascript:x'],
  ];
  for (const [n, v] of drop) assert.equal(M.safeAttr(n, v), null, `${n}=${String(v)}`);
  const keep: [string, string, string][] = [
    ['href', '#/board', '#/board'], ['href', '#/run/A%2FB', '#/run/A%2FB'], ['href', '/login', '/login'],
    ['href', 'https://example.com/a b', 'https://example.com/a%20b'], ['href', 'http://x.test/', 'http://x.test/'],
    ['aria-label', 'Close', 'Close'], ['title', 'javascript: is just text here', 'javascript: is just text here'],
    ['ping', 'https://x.test/p', 'https://x.test/p'], ['cite', '/notes', '/notes'],
  ];
  for (const [n, v, want] of keep) assert.equal(M.safeAttr(n, v), want, `${n}=${v}`);
  assert.equal(M.safeAttr('hidden', true), '');
  assert.equal(M.safeHttp('ftp://x'), null);
});

test('repo matching stays fast and exact (4,000 characters × 50 repos)', () => {
  const names = Array.from({ length: 50 }, (_, i) => `repo-${i}.svc+(x)[y]`);
  const text = 'lorem ipsum '.repeat(340).slice(0, 4000);
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) M.matchRepo(text, names);
  assert.ok((performance.now() - t0) / 5 < 50, 'under 50 ms');
  assert.equal(M.matchRepo('work on repo-7.svc+(x)[y] please', names), 'repo-7.svc+(x)[y]');
  assert.deepEqual(j(M.resolveRepo({ text: 'x', lastUsed: 'Alpha', names: ['alpha', 'beta'] })), { name: null, how: 'unresolved' }, 'last used is case-sensitive exact');
});

test('"No repository" never sticks where the mode does not allow it (code review C1)', () => {
  const one = ['solo'];
  const many = ['alpha', 'beta'];
  // where "none" is allowed
  assert.equal(M.noneAllowed('research', 1), true);
  assert.equal(M.noneAllowed('research', 2), true);
  assert.equal(M.noneAllowed('ask', 2), true);
  assert.equal(M.noneAllowed('ask', 0), true);
  assert.equal(M.noneAllowed('ask', 1), false, 'one repo: the server picks it, so "none" would be untrue');
  assert.equal(M.noneAllowed('work', 1), false);
  assert.equal(M.noneAllowed('work', 2), false);
  const pick = (mode: string, names: string[], extra: Record<string, string> = {}) =>
    j(M.resolveRepo({ text: 'fix it', chosen: M.NONE, names, allowNone: M.noneAllowed(mode, names.length), ...extra }));
  // one repo
  assert.deepEqual(pick('research', one), { name: null, how: 'none' });
  assert.deepEqual(pick('ask', one), { name: 'solo', how: 'only' }, 'Ask with one repo: NONE counts as Auto');
  assert.deepEqual(pick('work', one), { name: 'solo', how: 'only' }, 'Build with one repo: NONE counts as Auto');
  // several repos
  assert.deepEqual(pick('research', many), { name: null, how: 'none' });
  assert.deepEqual(pick('ask', many), { name: null, how: 'none' });
  assert.deepEqual(pick('work', many), { name: null, how: 'unresolved' }, 'Build: never "none"; the UI then asks which repo');
  assert.deepEqual(pick('work', many, { lastUsed: 'beta' }), { name: 'beta', how: 'last' }, 'Build falls back to Auto resolution');
});

// ───────── M8-2 model choices ─────────
test('M8-2 selOf: a choice made for another tool keeps only the effort (B2 binding)', () => {
  const e = { providers: ['cursor'], tool: 'claude', model: 'opus', custom: false, effort: 'high', fast: false, thinking: false };
  assert.deepEqual(j(M.selOf(e, 'cursor')), { model: null, custom: false, effort: 'high', fast: false, thinking: false });
  assert.deepEqual(j(M.selOf(e, 'claude')), { model: 'opus', custom: false, effort: 'high', fast: false, thinking: false });
  assert.deepEqual(j(M.selOf({ providers: ['claude'] }, 'claude')), { model: null, custom: false, effort: null, fast: false, thinking: false });
  assert.equal(M.sameSel({ model: 'opus' }, { model: 'opus', custom: false, effort: null }), true);
  assert.equal(M.sameSel({ model: 'opus' }, { model: 'opus', effort: 'low' }), false);
  assert.deepEqual(j(M.selFields({ custom: true })), { model: null, custom: false, effort: null, fast: false, thinking: false }, 'custom without a model is not custom');
});

test('M8-2 withSel: every role of the row gets the same fields, tool left out, others untouched, inputs never mutated', () => {
  const roles: any = defaults();
  roles.debugging = { providers: ['cursor'], tool: 'cursor', model: 'gpt-5.2', autoByComplexity: { L: 'cursor' }, extra: 1 };
  const before = j(roles);
  const patch = M.rolesPatch(roles, { plan: 'cursor' });
  const p0 = j(patch);
  const out = M.withSel(patch, roles, { build: { model: 'gpt-5.3-codex', effort: 'high', fast: true }, plan: { model: null, effort: 'low' } });
  assert.deepEqual(j(roles), before);
  assert.deepEqual(j(patch), p0);
  for (const r of ['implementation', 'debugging', 'documentation']) {
    assert.equal(out.roles[r].model, 'gpt-5.3-codex', r);
    assert.equal(out.roles[r].effort, 'high');
    assert.equal(out.roles[r].fast, true);
    assert.equal(out.roles[r].thinking, false);
    assert.equal('tool' in out.roles[r], false, 'the server derives tool');
  }
  assert.deepEqual(j(out.roles.debugging.autoByComplexity), { L: 'cursor' }, 'every other field is echoed');
  assert.equal(out.roles.debugging.extra, 1);
  assert.deepEqual(j(out.roles.planning.providers), ['cursor'], 'the tool change from rolesPatch is kept');
  assert.equal(out.roles.planning.effort, 'low');
  assert.equal(out.roles.review, undefined, 'rows without a choice are not sent');
});

test('M8-6 S14/F1 moreNote: "+N more … not listed" only when the true total exceeds the capped list', () => {
  assert.equal(M.moreNote(130, 100, 'pages opened'), '+30 more pages opened, not listed');
  assert.equal(M.moreNote(50, 50, 'searches'), '');
  assert.equal(M.moreNote(undefined, 10, 'searches'), '', 'older reports have no total');
  assert.equal(M.moreNote('999', 10, 'searches'), '', 'a non-number total is ignored');
  assert.equal(M.moreNote(1.5, 0, 'searches'), '');
});

/* ───────── M8-U2: board extras (GET /api/board) ───────── */
const A1 = 'ask-' + 'a'.repeat(16), A2 = 'ask-' + 'b'.repeat(16), A3 = 'ask-' + 'c'.repeat(16), A4 = 'ask-' + 'd'.repeat(16), A5 = 'ask-' + 'e'.repeat(16);
const rc = (id: string, lane: string, updatedAt: number, extra: Record<string, unknown> = {}) => ({ id, title: 'Q ' + id.slice(-1), lane, status: lane === 'active' ? 'running' : 'done', depth: 'standard', repo: null, createdAt: 1, updatedAt, counts: { opened: 2, listed: 1, unverified: 0 }, convertedTo: null, error: null, ...extra });
const item = (id: string, key: string, o: Record<string, unknown> = {}) => ({ id, key, lane: 'todo', createdBy: 'user', dependsOn: [], ...o });

test('M8-U2 boardExtras: research lanes map to Board columns; done and canceled are not drawn; newest first; bad ids dropped', () => {
  const x = j(M.boardExtras({ items: [], research: [
    rc(A1, 'active', 10), rc(A2, 'review', 20), rc(A3, 'needs_you', 30, { status: 'failed', error: 'Interrupted by a restart.' }),
    rc(A4, 'done', 40), rc(A5, 'canceled', 50), rc('ask-../../x', 'review', 60), rc('ASK-' + 'a'.repeat(16), 'review', 61),
    rc(A5.replace('e', 'f'), 'review', 25, { depth: 'deep', counts: { opened: -1, listed: 1.5, unverified: '3' } }), rc(A4.replace('d', '9'), 'weird', 70),
  ] }));
  assert.deepEqual(x.research.planning.map((r) => r.id), [A1]);
  assert.deepEqual(x.research.ready.map((r) => r.id), [A5.replace('e', 'f'), A2], 'newest first');
  assert.deepEqual(x.research.needs_human.map((r) => [r.id, r.error]), [[A3, 'Interrupted by a restart.']]);
  const deep = x.research.ready[0]!;
  assert.equal(deep.deep, true);
  assert.deepEqual(deep.counts, { opened: 0, listed: 0, unverified: 0 }, 'only non-negative integer counts are kept');
  assert.deepEqual(j(M.RESEARCH_COL), { active: 'planning', review: 'ready', needs_you: 'needs_human' });
});

test('M8-U2 boardExtras: design origin, the model-written flag on every design card (C1), deps as keys, waiting = not done', () => {
  const x = j(M.boardExtras({ research: [], items: [
    item('i1', 'D-1', { createdBy: 'design', design: { briefId: 'brf-0', part: 1, parts: 3 }, lane: 'done' }),
    item('i2', 'D-2', { createdBy: 'design', design: { briefId: 'brf-0', part: 2, parts: 3 }, dependsOn: ['i1'] }),
    item('i3', 'D-3', { createdBy: 'design', design: { briefId: 'brf-0', part: 3, parts: 3 }, dependsOn: ['i1', 'i2', 'gone'] }),
    item('i4', 'D-4', { createdBy: 'design', design: { briefId: 'brf-1', part: 1, parts: 1 } }),
    item('i5', 'D-5', { createdBy: 'design' }),
    item('i6', 'D-6', { createdBy: 'design', design: { part: 4, parts: 3 } }),
    item('i7', 'D-7', { createdBy: 'design', design: { part: 1.5, parts: 2 } }),
    item('i8', 'D-8', { createdBy: 'design', design: { part: 1, parts: 9 } }),
    item('i9', 'U-1', { createdBy: 'user', design: { part: 1, parts: 2 } }),
    item('i10', 'R-1', { createdBy: 'research' }),
  ] }));
  assert.deepEqual(x.cards['D-1'], { model: true, part: 1, parts: 3, after: [], waiting: [], unknown: 0 });
  assert.deepEqual(x.cards['D-2'], { model: true, part: 2, parts: 3, after: ['D-1'], waiting: [], unknown: 0 }, 'a dependency in Done is not waited for');
  assert.deepEqual(x.cards['D-3'], { model: true, part: 3, parts: 3, after: ['D-1', 'D-2'], waiting: ['D-2'], unknown: 1 });
  assert.deepEqual(x.cards['D-4'], { model: true, part: 0, parts: 0, after: [], waiting: [], unknown: 0 }, 'parts === 1: no chip, still model-written');
  assert.deepEqual(x.cards['D-5'], { model: true, part: 0, parts: 0, after: [], waiting: [], unknown: 0 }, 'brief deleted (no design field): still model-written');
  for (const k of ['D-6', 'D-7', 'D-8']) assert.equal(x.cards[k]!.parts, 0, k + ': malformed design ignored');
  assert.equal(x.cards['U-1'], undefined, 'only createdBy design counts, never a design field alone');
  assert.equal(x.cards['R-1'], undefined);
});

test('M8-U2 boardExtras never throws on bad input', () => {
  for (const bad of [null, undefined, 'x', 42, [], {}, { items: 'x', research: {} }, { items: [null, 1, { id: 1, key: 'K' }], research: [null, 'x', { id: 5 }] }]) {
    const x = j(M.boardExtras(bad));
    assert.deepEqual(x, { cards: {}, research: { planning: [], ready: [], needs_human: [] } }, JSON.stringify(bad));
  }
});

test('M8-5 run-mode helpers + chain-only wording', () => {
  assert.equal(M.isCompleteAuto('complete-auto'), true);
  assert.equal(M.isCompleteAuto('per-settings'), false);
  assert.equal(M.isCompleteAuto(null), false);
  assert.equal(M.runModeOverridden(['planApproval', 'limitRule'], 'planApproval'), true);
  assert.equal(M.runModeOverridden(['planApproval'], 'limitRule'), false);
  assert.equal(M.runModeOverridden(null, 'planApproval'), false);
  assert.match(M.LIMIT_RULE_LABEL.switch, /job's list/);
  assert.match(M.COMPLETE_AUTO_CONFIRM, /next tool in the job's list/);
  assert.deepEqual(j(M.approveWaitingBody([{ key: 'A-1', rev: 2, title: 'x' }, { key: 'bad' }, null])), { runs: [{ key: 'A-1', rev: 2 }], confirm: true });
  assert.deepEqual(j(M.approveWaitingBody(null)), { runs: [], confirm: true });
  assert.equal(M.skipReasonLabel('forced'), 'Held for a safety reason');
  assert.equal(M.skipReasonLabel('nope'), 'Skipped');
});

test('M8-U2 partTip / waitNote / researchCounts / isAskId wording', () => {
  assert.equal(M.partTip({ after: [] }), 'One part of a larger piece of work');
  assert.equal(M.partTip({ after: ['D-1', 'D-2'] }), 'One part of a larger piece of work · After D-1, D-2');
  assert.equal(M.partTip(null), 'One part of a larger piece of work');
  assert.equal(M.waitNote({ waiting: ['D-2'], unknown: 0 }), 'Waits for D-2 to be done.');
  assert.equal(M.waitNote({ waiting: ['D-1', 'D-2'], unknown: 1 }), 'Waits for D-1, D-2 to be done.');
  assert.equal(M.waitNote({ waiting: [], unknown: 2 }), 'Waits for other cards to be done.', 'N4: unresolved dependency');
  assert.equal(M.waitNote({ waiting: [], unknown: 0 }), '');
  assert.equal(M.waitNote(null), '');
  assert.equal(M.researchCounts({ opened: 3, listed: 1, unverified: 0 }), '3 opened · 1 listed · 0 unverified');
  assert.equal(M.researchCounts(null), '0 opened · 0 listed · 0 unverified');
  assert.equal(M.isAskId(A1), true);
  for (const bad of ['ask-123', 'ask-' + 'g'.repeat(16), '../ask-' + 'a'.repeat(16), 'ask-' + 'a'.repeat(33), 7, null]) assert.equal(M.isAskId(bad), false, String(bad));
});
