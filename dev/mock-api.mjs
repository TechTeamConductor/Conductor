#!/usr/bin/env node
/**
 * Conductor mock API: a zero-dependency dev server that serves the UI files and implements every
 * endpoint in docs/API.md with realistic in-memory data and a live SSE stream.
 *
 *   node dev/mock-api.mjs [--port 4399] [--scenario busy] [--no-sim]
 *
 * Scenarios (also via `/?scenario=<name>` on the page URL, or MOCK_SCENARIO):
 *   setup   wizard incomplete (agents ok, Linear key / team / repo pending), fully clickable end to end
 *   setup0  nothing ready: Cursor missing, Claude not signed in
 *   empty   set up, no runs
 *   busy    one run in every board column, an unverified run, 2 closed, Claude limit banner
 *   limit   Claude provider pause + quota 100%
 *   warnings  busy + Linear poll error + health warnings + an unhealthy agent
 *   expired every /api call answers 401 (session-expired page)
 *
 * Dev only: no cookies/auth. It DOES enforce the real contract for mutations
 * (Content-Type: application/json and X-Conductor-CSRF) and sends the production CSP.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(here, '../ui');

const argv = process.argv.slice(2);
const argVal = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const PORT = Number(argVal('--port', process.env.PORT || 4399));
const SIM = !argv.includes('--no-sim');
const DEFAULT_SCENARIO = argVal('--scenario', process.env.MOCK_SCENARIO || 'busy');
const SCENARIOS = ['setup', 'setup0', 'empty', 'busy', 'limit', 'warnings', 'expired'];

/* ───────────────────────── helpers ───────────────────────── */
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000; const HOUR = 3_600_000;
const fmtDur = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
};
const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const sha = () => randomBytes(20).toString('hex');
const HOME = '/Users/demo';
const err = (status, code, message) => Object.assign(new Error(message), { status, code });

/* ───────────────────────── fake content ───────────────────────── */
const FILES = ['src/api/rateLimit.ts', 'src/api/middleware.ts', 'src/audit/list.ts', 'src/audit/cursor.ts', 'test/audit.test.ts', 'src/billing/invoice.ts',
  'src/ui/Settings.tsx', 'src/ui/theme.css', 'src/export/csv.ts', 'src/webhooks/retry.ts', 'package.json', 'tsconfig.json', 'src/checkout/dates.ts'];

const PLANS = {
  rate: {
    summary: 'Add per-API-key rate-limit headers (X-RateLimit-Limit, -Remaining, -Reset) to every public API response and expose the counters from the existing limiter.',
    complexity: 'M',
    acceptanceCriteria: [
      { id: 'AC1', text: 'Every response from /v1/* carries X-RateLimit-Limit, X-RateLimit-Remaining and X-RateLimit-Reset.', verification: 'test/rateLimit.headers.test.ts asserts all three headers on 200 and 429 responses' },
      { id: 'AC2', text: 'Limits are tracked per API key, not per IP.', verification: 'Two keys behind one IP exhaust their budgets independently (new test)' },
      { id: 'AC3', text: 'A 429 response includes Retry-After in seconds.', verification: 'Unit test on the limiter plus a curl smoke test in the PR notes' },
      { id: 'AC4', text: 'No change to behaviour for unauthenticated routes.', verification: 'Existing middleware tests stay green' },
    ],
    filesToChange: [
      { path: 'src/api/rateLimit.ts', action: 'modify', change: 'Key counters by API key and return a snapshot (limit, remaining, resetAt)', reason: 'Source of the numbers for the headers' },
      { path: 'src/api/middleware.ts', action: 'modify', change: 'Resolve the API key before the limiter and write the headers', reason: 'Headers must exist on every response' },
      { path: 'test/rateLimit.headers.test.ts', action: 'create', change: 'Header and per-key isolation tests', reason: 'Covers AC1 to AC3' },
    ],
    steps: ['Move API key extraction ahead of the limiter in middleware.ts.', 'Change limiter state to Map<apiKey, Window> and return a snapshot from consume().', 'Write the three headers in a response hook, including on 429.', 'Add Retry-After on rejection.', 'Write the tests and run the full suite.'],
    risks: ['Memory growth if keys are never evicted: reuse the existing sweep interval.', 'Clock skew between nodes changes Reset values: document that Reset is relative to the serving node.'],
  },
  dates: {
    summary: 'Replace moment.js with date-fns in the checkout flow and drop moment from the bundle, keeping every formatted date byte-identical.',
    complexity: 'S',
    acceptanceCriteria: [
      { id: 'AC1', text: 'checkout/ no longer imports moment.', verification: 'grep -r "from \'moment\'" src/checkout returns nothing' },
      { id: 'AC2', text: 'Formatted delivery dates are unchanged for en-GB and en-US.', verification: 'Snapshot tests in src/checkout/dates.test.ts' },
      { id: 'AC3', text: 'Production bundle shrinks by at least 40 kB gzip.', verification: 'npm run build -- --report compares before and after' },
    ],
    filesToChange: [
      { path: 'src/checkout/dates.ts', action: 'modify', change: 'Swap moment calls for date-fns format/addBusinessDays', reason: 'Only module that touches moment' },
      { path: 'package.json', action: 'modify', change: 'Remove moment, add date-fns', reason: 'Dependency swap' },
    ],
    steps: ['Add date-fns and a thin wrapper formatDelivery().', 'Port the four call sites.', 'Add snapshot tests first, then switch the implementation.', 'Remove moment and rebuild.'],
    risks: ['Locale data: date-fns needs explicit locale imports to avoid bundle growth.'],
  },
  audit: {
    summary: 'Paginate GET /audit with an opaque cursor and a limit parameter (default 50, max 200), newest first, without changing the response shape for existing clients.',
    complexity: 'M',
    acceptanceCriteria: [
      { id: 'AC1', text: 'GET /audit?limit=N returns at most N events and a next_cursor.', verification: 'test/audit.test.ts: paginates with cursor' },
      { id: 'AC2', text: 'Invalid limit values return 400 with a clear message.', verification: 'test/audit.test.ts: returns 400 on bad limit' },
      { id: 'AC3', text: 'Requests without parameters behave as before (first 50 events).', verification: 'Existing audit list test remains green' },
    ],
    filesToChange: [
      { path: 'src/audit/list.ts', action: 'modify', change: 'Accept limit and cursor, query with keyset pagination', reason: 'Core of the change' },
      { path: 'src/audit/cursor.ts', action: 'create', change: 'Encode and decode the opaque cursor', reason: 'Keeps clients independent of the sort key' },
      { path: 'test/audit.test.ts', action: 'modify', change: 'Cover cursor and limit validation', reason: 'AC1 and AC2' },
    ],
    steps: ['Create cursor.ts with base64url(JSON) encode/decode and validation.', 'Add keyset query (created_at, id) to list.ts.', 'Validate limit, return 400 on bad input.', 'Extend tests.'],
    risks: ['Events with identical timestamps: tie-break on id.'],
  },
  theme: {
    summary: 'Add a dark colour scheme to the settings page using CSS custom properties, following the OS preference.',
    complexity: 'S',
    acceptanceCriteria: [
      { id: 'AC1', text: 'Settings page uses prefers-color-scheme to switch palettes.', verification: 'Visual check in both modes plus a unit test on the token map' },
      { id: 'AC2', text: 'Text contrast stays at or above WCAG AA in both palettes.', verification: 'Contrast script in scripts/contrast.mjs' },
    ],
    filesToChange: [
      { path: 'src/ui/theme.css', action: 'modify', change: 'Define dark token set', reason: 'Palette source' },
      { path: 'src/ui/Settings.tsx', action: 'modify', change: 'Use tokens instead of hard-coded colours', reason: 'Consume the tokens' },
    ],
    steps: ['Extract hard-coded colours into tokens.', 'Add the dark token set under prefers-color-scheme.', 'Run the contrast script.'],
    risks: ['Third-party widgets with fixed colours.'],
  },
  csv: {
    summary: 'Add a CSV export button to the usage report, streaming rows so large accounts do not exhaust memory.',
    complexity: 'M',
    acceptanceCriteria: [
      { id: 'AC1', text: 'GET /reports/usage.csv streams a valid RFC 4180 file.', verification: 'test/csv.test.ts parses the stream back' },
      { id: 'AC2', text: 'Memory stays flat for 1M rows.', verification: 'scripts/bench-csv.mjs reports peak RSS under 150 MB' },
      { id: 'AC3', text: 'The report page has an Export CSV button.', verification: 'Component test' },
    ],
    filesToChange: [
      { path: 'src/export/csv.ts', action: 'create', change: 'Streaming CSV writer with correct quoting', reason: 'Core of the feature' },
      { path: 'src/ui/Settings.tsx', action: 'modify', change: 'Add the Export CSV button', reason: 'Entry point' },
    ],
    steps: ['Write the streaming writer.', 'Wire the endpoint.', 'Add the button.', 'Benchmark.'],
    risks: ['Excel treats leading = + - @ as formulas: prefix with a single quote.'],
  },
};
function genericPlan(title) {
  return {
    summary: `Implement: ${title}.`, complexity: 'S',
    acceptanceCriteria: [{ id: 'AC1', text: `${title} works as described in the issue.`, verification: 'Targeted test plus a manual check' }, { id: 'AC2', text: 'Existing tests stay green.', verification: 'npm test' }],
    filesToChange: [{ path: pick(FILES), action: 'modify', change: 'Implement the change', reason: 'Primary location' }],
    steps: ['Read the code around the change.', 'Implement it.', 'Add tests.'], risks: ['None identified.'],
  };
}
function fullPlan(base) {
  return {
    summary: base.summary, blocked: { is: false, questions: [] }, assumptions: ['The staging Redis instance is available for integration tests.', 'No public API consumers rely on the old header names.'],
    currentState: 'The code path exists but does not do what the issue asks. Tests cover the happy path only.',
    expectedState: base.summary,
    acceptanceCriteria: base.acceptanceCriteria, filesToChange: base.filesToChange, steps: base.steps,
    testing: { commands: ['npm test', 'npm run lint', 'npm run typecheck'], cases: ['Happy path', 'Invalid input returns a clear error', 'No change for unrelated routes'] },
    risks: base.risks,
    coverage: base.acceptanceCriteria.map((a) => ({ requirement: a.text, change: base.filesToChange[0].path, verification: a.verification })),
    complexity: base.complexity,
  };
}
function planMarkdown(p) {
  const L = [];
  L.push(`# Plan: ${p.summary.split('.')[0]}`, '', '## Summary', p.summary, '', '## Current state', p.currentState, '', '## Expected state', p.expectedState, '', '## Assumptions');
  p.assumptions.forEach((a) => L.push(`- ${a}`));
  L.push('', '## Acceptance criteria', '', '| ID | Criterion | How it is verified |', '| --- | --- | --- |');
  p.acceptanceCriteria.forEach((a) => L.push(`| ${a.id} | ${a.text} | ${a.verification} |`));
  L.push('', '## Files to change', '');
  p.filesToChange.forEach((f) => L.push(`- \`${f.path}\` (${f.action}): ${f.change}`));
  L.push('', '## Steps');
  p.steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  L.push('', '## Testing', '', '```sh', ...p.testing.commands, '```', '');
  p.testing.cases.forEach((c) => L.push(`- [ ] ${c}`));
  L.push('', '## Risks');
  p.risks.forEach((r) => L.push(`- ${r}`));
  L.push('', '> Complexity: **' + p.complexity + '**. Plan written by Claude, read-only.');
  return L.join('\n');
}
const gateRes = (name, cmd, exit, failures, ms, tail) => ({ name, cmd, exitCode: exit, timedOut: false, durationMs: ms, outputTail: tail || '', failures, failureCount: failures === null ? (exit === 0 ? 0 : null) : failures.length });
const CMD = { typecheck: 'npm run typecheck', lint: 'npm run lint', test: 'npm test' };
function baselineGates(at, sha0) {
  return {
    at, sha: sha0, results: [
      gateRes('typecheck', CMD.typecheck, 2, null, 21_400, "src/legacy/old.ts(14,5): error TS2322: Type 'string' is not assignable to type 'number'.\nFound errors in 3 files."),
      gateRes('lint', CMD.lint, 1, ['src/legacy/old.ts no-unused-vars', 'src/legacy/util.ts no-explicit-any', 'src/legacy/util.ts eqeqeq'], 8_100, '3 problems (3 errors, 0 warnings)'),
      gateRes('test', CMD.test, 0, [], 14_200, 'tests 41 · pass 41 · fail 0'),
    ],
  };
}
function loopGates(at, sha1, mode) {
  const failTests = mode === 'regress' ? ['test/audit.test.ts > audit list paginates with cursor', 'test/audit.test.ts > audit list returns 400 on bad limit'] : [];
  return {
    run: {
      at, sha: sha1, results: [
        gateRes('typecheck', CMD.typecheck, 2, null, 22_000, "src/legacy/old.ts(14,5): error TS2322: Type 'string' is not assignable to type 'number'.\nFound errors in 3 files."),
        gateRes('lint', CMD.lint, 1, ['src/legacy/old.ts no-unused-vars', 'src/legacy/util.ts no-explicit-any', 'src/legacy/util.ts eqeqeq'], 8_300, '3 problems (3 errors, 0 warnings)'),
        gateRes('test', CMD.test, failTests.length ? 1 : 0, failTests, 15_800, failTests.length ? '✖ audit list paginates with cursor\n✖ audit list returns 400 on bad limit\nℹ tests 44 · pass 42 · fail 2' : 'tests 44 · pass 44 · fail 0'),
      ],
    },
    comparison: {
      regressions: failTests.length ? [{ gate: 'test', newFailures: failTests, note: 'Passed at baseline' }] : [],
      preExisting: ['lint'], unverified: ['typecheck'], passed: failTests.length ? [] : ['test'],
    },
  };
}

/* ───────────────────────── log generation ───────────────────────── */
const lines = (n, f) => Array.from({ length: n }, f).join('\n');
function testOutput(fail) {
  const names = ['audit list returns newest first', 'audit list honours limit', 'cursor round-trips', 'rejects tampered cursor', 'limit above max is clamped'];
  const rows = names.map((n, i) => (fail && i === 2 ? `✖ ${n} (8.7ms)\n    AssertionError: expected 3 to equal 2` : `✔ ${n} (${rnd(2, 15)}.${rnd(0, 9)}ms)`));
  return `> api-gateway@2.4.1 test\n> node --test\n\n${rows.join('\n')}\nℹ tests 41 · pass ${fail ? 40 : 41} · fail ${fail ? 1 : 0}`;
}
const TEMPLATES = {
  plan: [
    () => [{ kind: 'text', text: pick(['Reading the issue and the files it mentions before drafting anything.', 'The existing limiter keys on IP. The issue asks for per-key limits, so key extraction has to move ahead of it.', 'Checking how neighbouring endpoints are structured so the plan stays consistent.', 'Two of the acceptance criteria can be verified by existing tests, the rest need new ones.']) }],
    () => { const f = pick(FILES); return [{ kind: 'tool', tool: 'Read', text: f }, { kind: 'tool_result', ok: true, text: `Read ${rnd(40, 420)} lines (${rnd(1, 14)}.${rnd(0, 9)} KB)` }]; },
    () => { const w = pick(['RateLimiter', 'paginate', 'useTheme', 'toCsv', 'retryWithBackoff', 'formatDate']); const n = rnd(2, 8); return [{ kind: 'tool', tool: 'Grep', text: `pattern: "${w}"  path: src/` }, { kind: 'tool_result', ok: true, text: `Found ${n} matches in ${rnd(1, 4)} files\n` + lines(Math.min(n, 5), () => `${pick(FILES)}:${rnd(3, 220)}: ${w}(`) }]; },
    () => [{ kind: 'tool', tool: 'Glob', text: pick(['**/*.test.ts', 'src/**/*.tsx', 'docs/**/*.md']) }, { kind: 'tool_result', ok: true, text: lines(rnd(3, 7), () => pick(FILES)) }],
    () => [{ kind: 'thinking', text: pick(['The cursor has to be opaque so clients cannot depend on the sort key. Keyset on (created_at, id) avoids deep-offset scans.', 'If the limiter runs before auth, every unauthenticated request shares one bucket. Order matters here.', 'date-fns tree-shakes, but only with named imports. A wrapper keeps call sites tidy.']) }],
  ],
  plan_review: [
    () => [{ kind: 'text', text: pick(['Checking each acceptance criterion against a concrete verification step.', 'The risk list is thin: nothing about rollback. Flagging as a suggestion, not a blocker.']) }],
    () => [{ kind: 'tool', tool: 'Read', text: pick(FILES) }, { kind: 'tool_result', ok: true, text: `Read ${rnd(40, 300)} lines` }],
  ],
  build: [
    () => [{ kind: 'text', text: pick(['Reading the approved plan and the existing tests first.', 'Writing the failing test before the implementation.', 'The helper already exists, reusing it instead of adding a new one.', 'Running the focused tests before the whole suite.']) }],
    () => { const f = pick(FILES); return [{ kind: 'tool', tool: 'read_file', text: f }, { kind: 'tool_result', ok: true, text: `${rnd(40, 400)} lines` }]; },
    () => { const f = pick(FILES); return [{ kind: 'tool', tool: 'edit_file', text: `${f}  (+${rnd(4, 60)} −${rnd(0, 20)})` }, { kind: 'tool_result', ok: true, text: 'Applied edit' }]; },
    () => { const fail = Math.random() < 0.25; return [{ kind: 'tool', tool: 'shell', text: pick(['npm test -- --run src/audit', 'npm run lint -- --fix', 'npm run typecheck']) }, { kind: 'tool_result', ok: !fail, text: testOutput(fail) }]; },
    () => [{ kind: 'tool', tool: 'grep', text: `"${pick(['cursor', 'limit', 'retry', 'theme'])}" src/` }, { kind: 'tool_result', ok: true, text: lines(rnd(2, 6), () => `${pick(FILES)}:${rnd(3, 200)}`) }],
    () => [{ kind: 'thinking', text: pick(['Keeping the diff small: only touching the two files the plan lists.', 'The test expects 400 but the handler throws. Mapping the validation error instead.']) }],
    () => (Math.random() < 0.08 ? [{ kind: 'error', text: 'Command timed out after 120s: npm run typecheck. Retrying with a longer timeout.' }] : [{ kind: 'text', text: 'Moving on to the next step of the plan.' }]),
  ],
  verify: [
    () => [{ kind: 'note', text: 'Gates finished: test passed, lint pre-existing failures only, typecheck unverified (baseline output not parseable).' }],
    () => [{ kind: 'tool', tool: 'Read', text: '.conductor/diff.patch' }, { kind: 'tool_result', ok: true, text: `Read ${rnd(80, 600)} lines` }],
    () => [{ kind: 'text', text: pick(['AC1 is met: the new test exercises the cursor and passes.', 'AC2 cannot be confirmed from the diff alone. Looking at the handler.', 'Checking that unauthenticated routes are untouched.']) }],
    () => { const f = pick(FILES); return [{ kind: 'tool', tool: 'Read', text: f }, { kind: 'tool_result', ok: true, text: `Read ${rnd(40, 300)} lines` }]; },
    () => [{ kind: 'thinking', text: 'The edge case with identical timestamps is covered by the tie-break on id. Not a bug.' }],
  ],
};
const AGENT_STAGE = { plan: ['claude', 'plan'], plan_review: ['claude', 'plan_review'], build: ['cursor', 'build'], verify: ['claude', 'verify'] };
function pushLog(run, ev, tsOverride) {
  const L = M.logs.get(run.key) || { seq: 0, events: [] };
  M.logs.set(run.key, L);
  const full = { seq: ++L.seq, ts: tsOverride || Date.now(), agent: ev.agent, stage: ev.stage, kind: ev.kind };
  if (ev.text !== undefined) full.text = ev.text;
  if (ev.tool) full.tool = ev.tool;
  if (ev.ok !== undefined) full.ok = ev.ok;
  L.events.push(full);
  run.lastEventSeq = L.seq;
  if (!tsOverride) broadcast('log', { key: run.key, event: full });
  return full;
}
function genFor(run, stage, ts) {
  const [agent, stg] = AGENT_STAGE[stage] || ['claude', stage];
  const batch = pick(TEMPLATES[stage] || TEMPLATES.plan)();
  batch.forEach((b, i) => pushLog(run, { agent: b.kind === 'note' ? 'conductor' : agent, stage: stg, ...b }, ts ? ts + i * 40 : undefined));
}
function seedStage(run, stage, count, endTs, gap) {
  const [agent, stg] = AGENT_STAGE[stage];
  const g = gap || 2800;
  const span = count * g;
  let ts = endTs - span;
  pushLog(run, { agent, stage: stg, kind: 'system', text: agent === 'claude' ? 'Session started · claude 2.1.296 · read-only tools: Read, Grep, Glob' : 'Session started · agent 2026.10.19 · workspace is the run worktree' }, ts);
  let n = 1;
  while (n < count) { ts += gap ? rnd(Math.floor(g * 0.5), Math.floor(g * 1.5)) : rnd(900, 4600); const before = (M.logs.get(run.key) || { events: [] }).events.length; genFor(run, stage, ts); n += (M.logs.get(run.key).events.length - before); }
  const resultText = { plan: 'Plan written: 5 steps, acceptance criteria listed, size M.', plan_review: 'Plan review: approved, one suggestion.', build: 'Build finished: 6 files changed, tests run locally.', verify: 'Verdict recorded.' }[stage];
  pushLog(run, { agent, stage: stg, kind: 'result', text: resultText }, endTs);
}

/* ───────────────────────── run model ───────────────────────── */
const M = {
  scenario: 'busy', csrf: randomBytes(16).toString('hex'), signedOut: false, expired: false,
  runs: new Map(), logs: new Map(), clients: new Set(), timers: [], nextIssue: 211, stateTimer: 0,
  linearOk: false, teamOk: false, viewer: null, teamId: null, agentsOk: true, health: null, quota: {}, engine: null, settings: null, repos: [],
};
function addTimer(ms, fn) { const t = setTimeout(fn, ms); M.timers.push(t); return t; }

function mkRun(o) {
  const t = Date.now();
  const key = o.key;
  const run = {
    key, title: o.title, url: `https://linear.app/demo/issue/${key}`, repo: 'api-gateway', status: 'queued', stage: null, next: 'plan',
    loop: 1, maxLoops: 3, rev: 1, branch: 'conductor/' + key.toLowerCase(), startedAt: t - 10 * MIN, updatedAt: t, stageStartedAt: null,
    pausedUntil: null, needsHuman: null, unverified: false, costUsd: 0, verdict: null, description: '', plan: null, planReview: null,
    verdicts: [], gates: { baseline: null, loops: [] }, bugs: [], sessions: [], timeline: [], diffStat: null, worktree: '', baseSha: '', commitSha: null,
    complexity: null, noPushEnvOnly: false, unverifiedWhy: null, worktreeExists: false, lastEventSeq: 0, ...o,
  };
  run.worktree = run.worktree || `${HOME}/code/.conductor-worktrees/${run.repo}/${key}`;
  return run;
}
function session(run, agent, stage, o) {
  const s = { id: randomUUID(), agent, stage, loop: stage === 'plan' || stage === 'plan_review' ? 1 : run.loop, rev: run.rev, startedAt: Date.now() - 5 * MIN, status: 'ok', costUsd: +(Math.random() * 0.9 + 0.1).toFixed(2), model: agent === 'claude' ? 'claude-sonnet-5' : 'auto', cliVersion: agent === 'claude' ? '2.1.296' : '2026.10.19', ...o };
  if (s.status !== 'running' && !s.endedAt) s.endedAt = s.startedAt + rnd(60, 500) * 1000;
  run.sessions.push(s);
  return s;
}
function tl(run, text, at) { run.timeline.push({ ts: at || Date.now(), text }); }
function columnOf(r) {
  switch (r.status) {
    case 'queued': return 'queued';
    case 'running': return r.stage === 'plan' || r.stage === 'plan_review' ? 'planning' : r.stage === 'build' ? 'building' : r.stage === 'verify' ? 'verifying' : 'queued';
    case 'awaiting_approval': return 'plan_ready';
    case 'needs_human': case 'failed': return 'needs_human';
    case 'paused': case 'parked': return 'paused';
    case 'ready': return 'ready';
    default: return 'closed';
  }
}
const agentOf = (r) => (r.status === 'running' ? (r.stage === 'build' ? 'cursor' : 'claude') : null);
function activityOf(r, now) {
  const d = r.stageStartedAt ? ' · ' + fmtDur(now - r.stageStartedAt) : '';
  switch (r.status) {
    case 'queued': return 'Waiting for a free worker slot';
    case 'running':
      if (r.stage === 'plan') return 'Claude is planning' + d;
      if (r.stage === 'plan_review') return 'Claude is reviewing the plan' + d;
      if (r.stage === 'build') return `Cursor is building (loop ${r.loop}/${r.maxLoops})` + d;
      return `Claude is verifying (loop ${r.loop}/${r.maxLoops})` + d;
    case 'awaiting_approval': return `Plan rev ${r.rev} is ready for your approval`;
    case 'needs_human': return 'Blocked, waiting for you';
    case 'failed': return 'Failed, retrying automatically';
    case 'paused': return 'Paused · Claude usage limit · resumes ' + (r.pausedUntil ? hhmm(r.pausedUntil) : 'soon');
    case 'parked': return 'Parked · issue moved to Backlog';
    case 'ready': return r.unverified ? 'Ready for review (unverified)' : 'Verified, ready for review';
    case 'finished': return 'Finished in Linear';
    case 'aborted': return 'Aborted';
    default: return r.status;
  }
}
function summaryOf(r) {
  const now = Date.now();
  const bugsOpen = r.bugs.filter((b) => b.status === 'open').length;
  const st = r.status;
  return {
    key: r.key, title: r.title, url: r.url, repo: r.repo, status: st, column: columnOf(r), stage: r.stage, next: r.next, activity: activityOf(r, now), agent: agentOf(r),
    loop: r.loop, maxLoops: r.maxLoops, rev: r.rev, branch: r.branch, startedAt: r.startedAt, updatedAt: r.updatedAt, stageStartedAt: r.stageStartedAt, pausedUntil: r.pausedUntil,
    needsHuman: r.needsHuman ? { reason: r.needsHuman.reason, origin: r.needsHuman.origin } : null, unverified: r.unverified, costUsd: +r.costUsd.toFixed(2), bugsOpen,
    verdict: r.verdict, canApprove: st === 'awaiting_approval', canRetry: st === 'needs_human' || st === 'failed' || st === 'ready',
    canAbort: ['queued', 'running', 'awaiting_approval', 'needs_human', 'paused', 'parked', 'failed'].includes(st),
    canCleanup: ['ready', 'finished', 'aborted'].includes(st) && r.worktreeExists,
  };
}
function detailOf(r) {
  return {
    ...summaryOf(r), description: r.description, worktree: r.worktree, baseSha: r.baseSha, commitSha: r.commitSha, complexity: r.complexity,
    sessions: r.sessions.map((s) => ({ ...s, resumeCommand: s.agent === 'claude' ? `cd '${r.worktree}' && claude --resume ${s.id}` : `cd '${r.worktree}' && agent --resume ${s.id}` })),
    plan: r.plan, planMarkdown: r.plan ? planMarkdown(r.plan) : null, planReview: r.planReview, verdicts: r.verdicts, gates: r.gates,
    bugs: r.bugs, timeline: r.timeline, diffStat: r.diffStat, noPushEnvOnly: r.noPushEnvOnly, unverifiedWhy: r.unverifiedWhy,
  };
}
function touch(r) { r.updatedAt = Date.now(); scheduleState(); }

/* seed builders: bring a run to a given phase with consistent plan/session/log/timeline data */
function withPlan(run, planKey, approvedBy) {
  const base = PLANS[planKey] || genericPlan(run.title);
  run.plan = fullPlan(base);
  run.complexity = base.complexity;
  run.planReview = base.complexity === 'M' ? { decision: 'approved', summary: 'The plan covers every acceptance criterion with a concrete check. One suggestion on rollback.', issues: [{ severity: 'suggestion', text: 'Mention how to roll back if the new headers break a strict client.' }] } : null;
  run.baseSha = sha();
  run.worktreeExists = true;
  run.description = `${run.title}.\n\nContext: customers asked for this in the last quarter. Please keep the diff focused and add tests for the new behaviour.\n\nAcceptance:\n- ${run.plan.acceptanceCriteria.map((a) => a.text).join('\n- ')}`;
  const t = Date.now();
  run.startedAt = t - 42 * MIN;
  tl(run, `Claimed from Linear (Todo, label conductor)`, t - 42 * MIN);
  tl(run, 'Claude started planning', t - 41 * MIN);
  const s = session(run, 'claude', 'plan', { startedAt: t - 41 * MIN, endedAt: t - 36 * MIN });
  void s;
  seedStage(run, 'plan', rnd(14, 24), t - 36 * MIN);
  if (run.planReview) { session(run, 'claude', 'plan_review', { startedAt: t - 35 * MIN, endedAt: t - 33 * MIN }); seedStage(run, 'plan_review', 6, t - 33 * MIN); tl(run, 'Plan reviewed: approved', t - 33 * MIN); }
  tl(run, `Plan rev ${run.rev} written`, t - 32 * MIN);
  if (approvedBy) tl(run, approvedBy === 'human' ? 'Plan approved by you' : 'Plan approved automatically', t - 30 * MIN);
}
function seedScenarioRuns(name) {
  const t = Date.now();
  const R = (o) => { const r = mkRun(o); M.runs.set(r.key, r); return r; };

  if (name === 'busy' || name === 'warnings' || name === 'limit') {
    const q = R({ key: 'ENG-201', title: 'Add per-key rate-limit headers to the public API', repo: 'api-gateway', status: 'queued', startedAt: t - 90_000, updatedAt: t - 90_000, description: 'Customers want X-RateLimit-* headers on every response.' });
    tl(q, 'Claimed from Linear (Todo, label conductor)', t - 90_000);

    const planning = R({ key: 'ENG-202', title: 'Fix flaky invoice export test on CI', repo: 'billing-web', status: 'running', stage: 'plan', next: 'plan', stageStartedAt: t - 134_000, startedAt: t - 3 * MIN, costUsd: 0.31, description: 'invoice-export.test.ts fails about one run in ten on CI with a timing assertion.' });
    planning.baseSha = sha(); planning.worktreeExists = true; tl(planning, 'Claimed from Linear (Todo, label conductor)', t - 3 * MIN); tl(planning, 'Claude started planning', t - 134_000);
    session(planning, 'claude', 'plan', { startedAt: t - 134_000, status: 'running' });
    seedStage(planning, 'plan', 18, t - 4000);

    const pr = R({ key: 'ENG-203', title: 'Replace moment.js with date-fns in checkout', repo: 'billing-web', status: 'awaiting_approval', stage: 'plan', next: 'approval', startedAt: t - 40 * MIN, updatedAt: t - 7 * MIN, costUsd: 0.74 });
    withPlan(pr, 'dates', null);
    pr.plan.complexity = 'S';

    const bld = R({ key: 'ENG-204', title: 'Paginate the audit log endpoint', repo: 'api-gateway', status: 'running', stage: 'build', next: 'build', loop: 2, stageStartedAt: t - 8 * MIN - 2000, costUsd: 2.86, rev: 1 });
    withPlan(bld, 'audit', 'auto');
    bld.stageStartedAt = t - 8 * MIN - 2000;
    bld.commitSha = sha();
    bld.gates.baseline = baselineGates(t - 29 * MIN, bld.baseSha);
    bld.verdicts.push({ loop: 1, verdict: { verdict: 'fail', summary: 'The cursor round-trips but invalid limits are not rejected, and two tests added by the build regress.', acceptance: [
      { id: 'AC1', status: 'met', evidence: 'test/audit.test.ts "returns newest first" passes; cursor decoding covered.' },
      { id: 'AC2', status: 'not_met', evidence: 'GET /audit?limit=-5 returns 200 with an empty list instead of 400.' },
      { id: 'AC3', status: 'unverifiable', evidence: 'Default behaviour untested after the change; no assertion on the first 50 events.' } ],
      bugs: [
        { title: 'Negative or non-numeric limit is accepted', severity: 'major', file: 'src/audit/list.ts', line: 41, evidence: 'parseInt(NaN) falls through to the query, which returns zero rows with status 200.', repro: 'curl "http://localhost:3000/audit?limit=-5" -i', suggestedFix: 'Validate with Number.isInteger and 1 <= n <= 200; respond 400 with { error: "limit must be 1-200" }.' },
        { title: 'Tampered cursor throws an unhandled exception', severity: 'blocker', file: 'src/audit/cursor.ts', line: 18, evidence: 'JSON.parse of a malformed base64 payload bubbles up as a 500.', repro: 'curl "http://localhost:3000/audit?cursor=%%%" -i', suggestedFix: 'Wrap decode in try/catch and return 400.' },
        { title: 'Doc comment still says offset pagination', severity: 'nit', file: 'src/audit/list.ts', line: 3, evidence: 'Stale comment.' } ] } });
    bld.gates.loops.push({ loop: 1, ...loopGates(t - 20 * MIN, bld.commitSha, 'regress') });
    bld.bugs = [
      { fp: sha().slice(0, 12), title: 'Negative or non-numeric limit is accepted', severity: 'major', file: 'src/audit/list.ts', detail: 'See verdict loop 1', status: 'open', linearKey: 'ENG-212', linearId: randomUUID(), loops: [1] },
      { fp: sha().slice(0, 12), title: 'Tampered cursor throws an unhandled exception', severity: 'blocker', file: 'src/audit/cursor.ts', detail: 'See verdict loop 1', status: 'open', linearKey: 'ENG-213', linearId: randomUUID(), loops: [1] },
      { fp: sha().slice(0, 12), title: 'Doc comment still says offset pagination', severity: 'nit', file: 'src/audit/list.ts', detail: 'Stale comment', status: 'closed', linearKey: 'ENG-214', linearId: randomUUID(), loops: [1] }];
    tl(bld, 'Build finished (loop 1), gates ran', t - 22 * MIN); tl(bld, 'Claude verified loop 1: fail, 2 open bugs filed (ENG-212, ENG-213)', t - 18 * MIN); tl(bld, 'Cursor started fixing (loop 2)', t - 8 * MIN);
    session(bld, 'cursor', 'build', { loop: 1, startedAt: t - 29 * MIN, endedAt: t - 22 * MIN, costUsd: 1.02 });
    session(bld, 'claude', 'verify', { loop: 1, startedAt: t - 21 * MIN, endedAt: t - 18 * MIN, costUsd: 0.64 });
    session(bld, 'cursor', 'build', { loop: 2, startedAt: t - 8 * MIN, status: 'running', costUsd: 0.4 });
    seedStage(bld, 'build', 3200, t - 22 * MIN + 1000, 70); // long backlog (>1500 lines): exercises DOM trimming
    seedStage(bld, 'verify', 14, t - 18 * MIN);
    seedStage(bld, 'build', 40, t - 4000);
    bld.diffStat = ' src/audit/cursor.ts      | 41 +++++++++++++++\n src/audit/list.ts        | 38 ++++++++++++++-----\n test/audit.test.ts       | 52 ++++++++++++++++++++++++++\n 3 files changed, 119 insertions(+), 12 deletions(-)';

    const ver = R({ key: 'ENG-205', title: 'Dark mode for the settings page', repo: 'billing-web', status: 'running', stage: 'verify', next: 'verify', stageStartedAt: t - 41_000, costUsd: 1.41 });
    withPlan(ver, 'theme', 'human');
    ver.commitSha = sha(); ver.gates.baseline = baselineGates(t - 20 * MIN, ver.baseSha);
    ver.gates.loops.push({ loop: 1, ...loopGates(t - 2 * MIN, ver.commitSha, 'ok') });
    session(ver, 'cursor', 'build', { startedAt: t - 20 * MIN, endedAt: t - 3 * MIN, costUsd: 0.88 });
    session(ver, 'claude', 'verify', { startedAt: t - 41_000, status: 'running' });
    seedStage(ver, 'build', 30, t - 3 * MIN); seedStage(ver, 'verify', 8, t - 3000);
    tl(ver, 'Build finished (loop 1), gates ran', t - 3 * MIN); tl(ver, 'Claude started verifying (loop 1)', t - 41_000);

    const nh = R({ key: 'ENG-206', title: 'Migrate the session store to Redis', repo: 'api-gateway', status: 'needs_human', stage: 'verify', next: 'verify', loop: 3, updatedAt: t - 26 * MIN, costUsd: 7.9,
      needsHuman: { reason: 'Loop cap reached: 3 fix loops done and 1 blocker bug is still open (sessions are lost on restart when REDIS_URL is unset). Decide whether the fallback should be in-memory or a hard error, then move the Linear issue back to Todo to give it 3 more loops.', origin: 'verify', at: t - 26 * MIN } });
    withPlan(nh, 'rate', 'human');
    nh.commitSha = sha(); nh.gates.baseline = baselineGates(t - 3 * HOUR, nh.baseSha);
    nh.gates.loops.push({ loop: 3, ...loopGates(t - 40 * MIN, nh.commitSha, 'regress') });
    nh.verdicts.push({ loop: 3, verdict: { verdict: 'fail', summary: 'One blocker remains: the session store silently falls back to memory.', acceptance: nh.plan.acceptanceCriteria.map((a, i) => ({ id: a.id, status: i === 1 ? 'not_met' : 'met', evidence: i === 1 ? 'Sessions vanish after restart when REDIS_URL is missing.' : 'Covered by tests.' })), bugs: [{ title: 'Silent fallback to in-memory sessions', severity: 'blocker', file: 'src/api/middleware.ts', line: 77, evidence: 'No error is raised when REDIS_URL is missing.', suggestedFix: 'Fail fast at boot or log loudly and expose a health warning.' }] } });
    nh.bugs = [{ fp: sha().slice(0, 12), title: 'Silent fallback to in-memory sessions', severity: 'blocker', file: 'src/api/middleware.ts', detail: 'See verdict loop 3', status: 'open', linearKey: 'ENG-215', loops: [1, 2, 3] }];
    session(nh, 'cursor', 'build', { loop: 3, startedAt: t - 70 * MIN, endedAt: t - 45 * MIN, costUsd: 2.3 });
    session(nh, 'claude', 'verify', { loop: 3, startedAt: t - 44 * MIN, endedAt: t - 26 * MIN, costUsd: 0.9 });
    seedStage(nh, 'build', 24, t - 45 * MIN); seedStage(nh, 'verify', 10, t - 26 * MIN);
    tl(nh, 'Loop cap reached, moved to Needs you', t - 26 * MIN);

    const pa = R({ key: 'ENG-207', title: 'Webhook retries with exponential backoff', repo: 'api-gateway', status: 'paused', stage: 'plan', next: 'plan', pausedUntil: t + 3 * HOUR + 12 * MIN, updatedAt: t - 12 * MIN, costUsd: 0.2, description: 'Failed webhooks should retry with jittered exponential backoff up to 6 attempts.' });
    pa.baseSha = sha(); pa.worktreeExists = true; tl(pa, 'Claimed from Linear (Todo, label conductor)', t - 20 * MIN); tl(pa, 'Paused: Claude usage limit (7-day), resumes automatically', t - 12 * MIN);
    session(pa, 'claude', 'plan', { startedAt: t - 19 * MIN, endedAt: t - 12 * MIN, status: 'limit', costUsd: 0.2 });
    seedStage(pa, 'plan', 9, t - 12 * MIN);
    pushLog(pa, { agent: 'conductor', stage: 'engine', kind: 'note', text: 'Claude usage limit reached (seven_day). Pausing until ' + hhmm(pa.pausedUntil) + '.' }, t - 12 * MIN + 500);

    const rd = R({ key: 'ENG-208', title: 'Add CSV export to the usage report', repo: 'billing-web', status: 'ready', stage: 'verify', next: 'none', loop: 2, verdict: 'pass', updatedAt: t - 55 * MIN, costUsd: 3.12 });
    withPlan(rd, 'csv', 'human');
    rd.commitSha = sha(); rd.gates.baseline = { ...baselineGates(t - 3 * HOUR, rd.baseSha), results: baselineGates(0, '').results.map((g) => ({ ...g, exitCode: 0, failures: [], failureCount: 0, outputTail: 'ok' })) };
    const g1 = loopGates(t - 100 * MIN, sha(), 'regress'); g1.run.results = g1.run.results.map((g) => ({ ...g, exitCode: g.name === 'test' ? 1 : 0, failures: g.name === 'test' ? ['test/csv.test.ts > escapes quotes'] : [], failureCount: g.name === 'test' ? 1 : 0 }));
    g1.comparison = { regressions: [{ gate: 'test', newFailures: ['test/csv.test.ts > escapes quotes'] }], preExisting: [], unverified: [], passed: ['typecheck', 'lint'] };
    const g2 = loopGates(t - 60 * MIN, rd.commitSha, 'ok'); g2.run.results = g2.run.results.map((g) => ({ ...g, exitCode: 0, failures: [], failureCount: 0, outputTail: '' })); g2.comparison = { regressions: [], preExisting: [], unverified: [], passed: ['typecheck', 'lint', 'test'] };
    rd.gates.loops.push({ loop: 1, ...g1 }, { loop: 2, ...g2 });
    rd.verdicts.push({ loop: 1, verdict: { verdict: 'fail', summary: 'Quotes inside fields are not escaped.', acceptance: rd.plan.acceptanceCriteria.map((a, i) => ({ id: a.id, status: i === 0 ? 'not_met' : 'met', evidence: i === 0 ? 'A field containing a double quote breaks the row.' : 'ok' })), bugs: [{ title: 'Double quotes inside fields are not escaped', severity: 'major', file: 'src/export/csv.ts', line: 22, evidence: 'Output for `a"b` is `"a"b"`.' }] } });
    rd.verdicts.push({ loop: 2, verdict: { verdict: 'pass', summary: 'All criteria met, memory stays flat at ~96 MB for 1M rows.', acceptance: rd.plan.acceptanceCriteria.map((a) => ({ id: a.id, status: 'met', evidence: 'Verified by test and benchmark.' })), bugs: [] } });
    rd.bugs = [{ fp: sha().slice(0, 12), title: 'Double quotes inside fields are not escaped', severity: 'major', file: 'src/export/csv.ts', detail: 'Fixed in loop 2', status: 'closed', linearKey: 'ENG-216', loops: [1] }];
    session(rd, 'cursor', 'build', { loop: 1, startedAt: t - 130 * MIN, endedAt: t - 105 * MIN, costUsd: 1.1 });
    session(rd, 'claude', 'verify', { loop: 1, startedAt: t - 99 * MIN, endedAt: t - 90 * MIN, costUsd: 0.5 });
    session(rd, 'cursor', 'build', { loop: 2, startedAt: t - 85 * MIN, endedAt: t - 62 * MIN, costUsd: 1.0 });
    session(rd, 'claude', 'verify', { loop: 2, startedAt: t - 61 * MIN, endedAt: t - 56 * MIN, costUsd: 0.52 });
    seedStage(rd, 'build', 20, t - 62 * MIN); seedStage(rd, 'verify', 10, t - 56 * MIN);
    rd.diffStat = ' src/export/csv.ts    | 64 ++++++++++++++++++++++++++++\n src/ui/Settings.tsx  | 12 ++++++\n test/csv.test.ts     | 48 ++++++++++++++++++++\n 3 files changed, 124 insertions(+)';
    tl(rd, 'Claude verified loop 2: pass', t - 56 * MIN); tl(rd, 'Ready for review on branch ' + rd.branch, t - 55 * MIN);

    const un = R({ key: 'ENG-209', title: 'Bump Node to 22 in the Dockerfile', repo: 'infra-scripts', status: 'ready', stage: 'verify', next: 'none', verdict: 'pass', unverified: true, unverifiedWhy: 'infra-scripts has no test, lint or type gates, so only Claude\'s read-through backs this result.', updatedAt: t - 3 * HOUR, costUsd: 0.64, noPushEnvOnly: true });
    withPlan(un, null, 'auto');
    un.commitSha = sha();
    un.verdicts.push({ loop: 1, verdict: { verdict: 'pass', summary: 'The Dockerfile base image and the CI matrix are updated consistently.', acceptance: un.plan.acceptanceCriteria.map((a) => ({ id: a.id, status: a.id === 'AC2' ? 'unverifiable' : 'met', evidence: a.id === 'AC2' ? 'No tests exist to confirm.' : 'Read the diff.' })), bugs: [] } });
    session(un, 'cursor', 'build', { startedAt: t - 200 * MIN, endedAt: t - 190 * MIN }); session(un, 'claude', 'verify', { startedAt: t - 189 * MIN, endedAt: t - 185 * MIN });
    seedStage(un, 'build', 12, t - 190 * MIN); seedStage(un, 'verify', 7, t - 185 * MIN);
    tl(un, 'Ready for review (unverified: no gates)', t - 3 * HOUR);

    const c1 = R({ key: 'ENG-190', title: 'Fix typo in the onboarding email', repo: 'billing-web', status: 'finished', stage: 'verify', next: 'none', verdict: 'pass', updatedAt: t - 2 * 86400_000, costUsd: 0.38, startedAt: t - 2 * 86400_000 - HOUR });
    withPlan(c1, null, 'auto'); tl(c1, 'Completed in Linear', t - 2 * 86400_000);
    const c2 = R({ key: 'ENG-188', title: 'Remove legacy /v1/ping endpoint', repo: 'api-gateway', status: 'aborted', stage: 'build', next: 'none', updatedAt: t - 5 * HOUR, costUsd: 0.91, startedAt: t - 6 * HOUR });
    withPlan(c2, null, 'auto'); tl(c2, 'Aborted: trigger label removed in Linear', t - 5 * HOUR);
    c1.worktreeExists = false;
  }
  if (name === 'limit') {
    // make the planning run wait too, so the whole picture is "Claude is the bottleneck"
    for (const r of M.runs.values()) {
      if (r.status === 'running' && r.stage !== 'build') { r.status = 'paused'; r.pausedUntil = t + 2 * HOUR + 40 * MIN; r.stageStartedAt = null; r.sessions.forEach((s) => { if (s.status === 'running') { s.status = 'limit'; s.endedAt = t - 60_000; } }); tl(r, 'Paused: Claude usage limit (7-day), resumes automatically'); }
    }
  }
}

/* ───────────────────────── scenarios ───────────────────────── */
function resetTimers() { M.timers.forEach(clearTimeout); M.timers = []; }
function seed(name) {
  if (!SCENARIOS.includes(name)) name = 'busy';
  resetTimers();
  const t = Date.now();
  M.scenario = name; M.signedOut = false; M.expired = name === 'expired';
  M.runs = new Map(); M.logs = new Map(); M.nextIssue = 217;
  const setupMode = name === 'setup' || name === 'setup0';
  M.linearOk = !setupMode; M.teamOk = !setupMode; M.viewer = setupMode ? null : { id: 'u-1', name: 'Demo User', email: 'demo@example.com' }; M.teamId = setupMode ? null : 'team-eng';
  M.agentsOk = name !== 'setup0';
  M.repos = setupMode ? [] : [
    { name: 'api-gateway', path: `${HOME}/code/api-gateway`, baseBranch: 'main', gates: [{ name: 'typecheck', cmd: 'npm run typecheck', kind: 'typecheck' }, { name: 'lint', cmd: 'npm run lint', kind: 'lint' }, { name: 'test', cmd: 'npm test', kind: 'test' }], approvedPlans: 4, noGates: false, warnings: [] },
    { name: 'billing-web', path: `${HOME}/code/billing-web`, baseBranch: 'main', gates: [{ name: 'lint', cmd: 'npm run lint', kind: 'lint' }, { name: 'test', cmd: 'npm test', kind: 'test' }], approvedPlans: 1, noGates: false, warnings: [] },
    { name: 'infra-scripts', path: `${HOME}/code/infra-scripts`, baseBranch: 'main', gates: [], approvedPlans: 2, noGates: true, warnings: ['No test, lint or type gates detected. Runs here are marked Unverified.'] },
  ];
  if (name === 'empty') M.repos = M.repos.slice(0, 2);
  M.settings = { planApproval: 'first', planReview: 'auto', maxLoops: 3, maxParallel: name === 'busy' || name === 'warnings' ? 3 : 2, onClaudeLimit: 'wait', noGates: 'warn', pickupFromBacklog: false, stages: { plan: 'claude', review: 'claude', verify: 'claude' }, linearMode: 'labels' };
  M.quota = { claude: { utilization7d: 0.42, utilization5h: 0.18, resetsAt: t + 2 * 86400_000 + 5 * HOUR, rejected: false } };
  M.engine = { paused: false, providerPause: {}, running: 0, maxParallel: 2, lastPollAt: t - 12_000, lastPollError: null, pollSeconds: 30 };
  M.health = { claude: { found: true, version: '2.1.296', ok: true, loggedIn: true }, cursor: { found: true, version: '2026.10.19', ok: true, loggedIn: true }, warnings: [] };
  if (name === 'setup0') { M.health.claude = { found: true, version: '2.1.296', ok: false, loggedIn: false, detail: 'Not signed in. Run `claude` in a terminal and sign in.' }; M.health.cursor = { found: false, ok: false }; }
  if (name === 'busy' || name === 'limit' || name === 'warnings') seedScenarioRuns(name);
  if (name === 'busy' || name === 'limit') {
    M.engine.providerPause = { claude: { until: t + (name === 'limit' ? 2 * HOUR + 40 * MIN : 3 * HOUR + 12 * MIN), reason: 'Claude 7-day usage limit reached. Resets ' + hhmm(t + 3 * HOUR) + '.' } };
  }
  if (name === 'limit') M.quota = { claude: { utilization7d: 1, utilization5h: 0.64, resetsAt: t + 2 * HOUR + 40 * MIN, rejected: true } };
  if (name === 'warnings') {
    M.engine.lastPollError = 'Linear returned HTTP 429 (RATELIMITED). Backing off for 90 seconds.';
    M.health.claude = { found: true, version: '2.1.296', ok: false, loggedIn: false, detail: 'Not signed in. Run `claude` in a terminal and sign in.' };
    M.health.warnings = [
      `Instruction files that could steer the agents were found: ${HOME}/.cursor/rules/techteam.mdc and ${HOME}/code/CLAUDE.md. Conductor adds a preamble that overrides them, but check they do not demand planning gates.`,
      'The worktree root is below a folder that contains AGENTS.md. Set worktreeRoot to avoid inheriting it.',
    ];
  }
  recount();
  scheduleState();
  if (SIM) startSim();
}
function recount() {
  M.engine.running = [...M.runs.values()].filter((r) => r.status === 'running').length;
  M.engine.maxParallel = M.settings.maxParallel;
}

/* ───────────────────────── setup state ───────────────────────── */
function buildSetup() {
  const h = M.health;
  const agentsOk = M.agentsOk && h.claude.found && h.cursor.found && (M.scenario === 'setup0' ? h.claude.ok && h.cursor.ok : true);
  const team = TEAMS.find((x) => x.id === M.teamId);
  const steps = [
    { id: 'agents', label: 'Agents', ok: agentsOk, detail: agentsOk ? `Claude Code ${h.claude.version} and Cursor agent ${h.cursor.version} are ready` : [!h.claude.ok ? 'Claude Code needs attention' : null, !h.cursor.ok ? (h.cursor.found ? 'Cursor agent needs attention' : 'Cursor agent not found') : null].filter(Boolean).join(' · ') },
    { id: 'linear', label: 'Linear key', ok: M.linearOk, detail: M.linearOk ? `Connected as ${M.viewer.name}` : undefined },
    { id: 'team', label: 'Team', ok: M.teamOk, detail: M.teamOk && team ? `${team.key} · ${team.name} (${M.settings.linearMode} mode)` : undefined },
    { id: 'repo', label: 'Repo', ok: M.repos.length > 0, detail: M.repos.length ? `${M.repos.length} registered: ${M.repos.map((r) => r.name).join(', ')}` : undefined },
  ];
  return { complete: steps.every((s) => s.ok), steps };
}
const TEAMS = [{ id: 'team-eng', key: 'ENG', name: 'Engineering' }, { id: 'team-ops', key: 'OPS', name: 'Operations' }];
function buildState() {
  recount();
  return {
    now: Date.now(), version: '0.1.0', csrf: M.csrf, setup: buildSetup(),
    health: { claude: M.health.claude, cursor: M.health.cursor, linear: { ok: M.linearOk, viewer: M.viewer ? M.viewer.name : undefined, detail: M.linearOk ? undefined : 'No Linear key saved yet' }, warnings: M.health.warnings },
    quota: M.quota, engine: M.engine, settings: M.settings, repos: M.repos, runs: sortedRuns().map(summaryOf),
  };
}
const sortedRuns = () => [...M.runs.values()].sort((a, b) => b.updatedAt - a.updatedAt);

/* ───────────────────────── SSE ───────────────────────── */
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of M.clients) { try { res.write(payload); } catch { M.clients.delete(res); } }
}
function scheduleState() {
  if (M.stateTimer) return;
  M.stateTimer = setTimeout(() => {
    M.stateTimer = 0;
    recount();
    broadcast('state', { now: Date.now(), runs: sortedRuns().map(summaryOf), engine: M.engine, quota: M.quota });
  }, 250);
}
const toast = (level, text) => broadcast('toast', { level, text });

/* ───────────────────────── simulation ───────────────────────── */
let simStarted = false;
function startSim() {
  if (simStarted) return;
  simStarted = true;
  setInterval(() => {
    for (const r of M.runs.values()) {
      if (r.status === 'running' && !M.engine.paused && r.stage && AGENT_STAGE[r.stage]) {
        if (Math.random() < 0.8) { genFor(r, r.stage); r.costUsd += 0.004; }
      }
    }
  }, 1100);
  setInterval(() => { broadcast('ping', { now: Date.now() }); }, 20_000);
  setInterval(() => { M.engine.lastPollAt = Date.now() - rnd(0, 20_000); scheduleState(); }, 10_000);
}
/** After the user approves a plan, walk the run through build → verify → ready so buttons visibly do something. */
function advanceAfterApprove(run) {
  if (!SIM) return;
  addTimer(18_000, () => {
    if (run.status !== 'running' || run.stage !== 'build') return;
    run.stage = 'verify'; run.next = 'verify'; run.stageStartedAt = Date.now();
    run.sessions.forEach((s) => { if (s.status === 'running') { s.status = 'ok'; s.endedAt = Date.now(); } });
    session(run, 'claude', 'verify', { startedAt: Date.now(), status: 'running', endedAt: undefined });
    run.commitSha = sha(); tl(run, 'Build finished, gates ran, Claude started verifying');
    pushLog(run, { agent: 'conductor', stage: 'verify', kind: 'note', text: 'Gates finished: lint and test passed.' });
    touch(run);
    addTimer(14_000, () => {
      if (run.status !== 'running' || run.stage !== 'verify') return;
      run.status = 'ready'; run.next = 'none'; run.verdict = 'pass'; run.stageStartedAt = null; run.worktreeExists = true;
      run.sessions.forEach((s) => { if (s.status === 'running') { s.status = 'ok'; s.endedAt = Date.now(); } });
      run.verdicts.push({ loop: run.loop, verdict: { verdict: 'pass', summary: 'All acceptance criteria are met.', acceptance: (run.plan ? run.plan.acceptanceCriteria : []).map((a) => ({ id: a.id, status: 'met', evidence: 'Verified by the new tests.' })), bugs: [] } });
      tl(run, 'Claude verified: pass. Ready for review'); touch(run);
      toast('info', `${run.key} is ready for review.`);
    });
  });
}

/* ───────────────────────── mutations ───────────────────────── */
const getRun = (key) => { const r = M.runs.get(key); if (!r) throw err(404, 'not_found', `No run named ${key}.`); return r; };
const invalid = (r, what) => err(409, 'invalid_state', `${r.key} is ${r.status.replace('_', ' ')}, so it cannot be ${what} right now.`);
const actions = {
  approve(r) {
    if (r.status !== 'awaiting_approval') throw invalid(r, 'approved');
    r.status = 'running'; r.stage = 'build'; r.next = 'build'; r.stageStartedAt = Date.now(); r.needsHuman = null;
    tl(r, 'Plan approved by you'); session(r, 'cursor', 'build', { startedAt: Date.now(), status: 'running', endedAt: undefined });
    pushLog(r, { agent: 'conductor', stage: 'build', kind: 'note', text: 'Plan approved by you. Handing over to Cursor.' });
    advanceAfterApprove(r);
  },
  retry(r) {
    if (r.status === 'needs_human') {
      const origin = r.needsHuman ? r.needsHuman.origin : 'build';
      r.stage = origin === 'plan' || origin === 'plan_review' ? 'plan' : origin === 'verify' ? 'verify' : 'build';
      r.next = r.stage; r.needsHuman = null; r.status = 'running'; r.stageStartedAt = Date.now(); r.maxLoops += 3;
      session(r, r.stage === 'build' ? 'cursor' : 'claude', r.stage, { startedAt: Date.now(), status: 'running', endedAt: undefined });
      tl(r, `Retry requested: ${r.stage} again with 3 extra loops`);
    } else if (r.status === 'ready') {
      r.rev += 1; r.loop = 1; r.verdict = null; r.status = 'running'; r.stage = 'plan'; r.next = 'plan'; r.stageStartedAt = Date.now();
      session(r, 'claude', 'plan', { startedAt: Date.now(), status: 'running', endedAt: undefined });
      tl(r, `Rework requested: re-planning (rev ${r.rev})`);
    } else if (r.status === 'failed') { r.status = 'running'; r.stageStartedAt = Date.now(); tl(r, 'Retry requested'); } else throw invalid(r, 'retried');
    pushLog(r, { agent: 'conductor', stage: r.stage, kind: 'note', text: 'Retry started from the dashboard.' });
  },
  resume(r) {
    if (r.status !== 'paused' && r.status !== 'parked') throw invalid(r, 'resumed');
    r.status = 'running'; r.pausedUntil = null; r.stageStartedAt = Date.now(); r.stage = r.stage || 'plan';
    session(r, r.stage === 'build' ? 'cursor' : 'claude', r.stage, { startedAt: Date.now(), status: 'running', endedAt: undefined });
    tl(r, 'Resumed from the dashboard');
  },
  abort(r) {
    if (!summaryOf(r).canAbort) throw invalid(r, 'aborted');
    r.status = 'aborted'; r.next = 'none'; r.stageStartedAt = null; r.pausedUntil = null;
    r.sessions.forEach((s) => { if (s.status === 'running') { s.status = 'aborted'; s.endedAt = Date.now(); } });
    tl(r, 'Aborted from the dashboard (agent process group killed)');
    pushLog(r, { agent: 'conductor', stage: r.stage || 'engine', kind: 'note', text: 'Run aborted. The agent was stopped.' });
  },
  cleanup(r) {
    if (!summaryOf(r).canCleanup) throw invalid(r, 'cleaned up');
    r.worktreeExists = false; tl(r, 'Worktree removed');
  },
};
const OPEN_TARGETS = ['cursor', 'terminal-claude', 'terminal-cursor', 'claude-desktop', 'finder', 'linear'];
function openAction(r, body) {
  if (!OPEN_TARGETS.includes(body.target)) throw err(400, 'bad_target', `Unknown open target. Use one of: ${OPEN_TARGETS.join(', ')}.`);
  if ((body.target === 'terminal-claude' || body.target === 'claude-desktop') && !r.sessions.some((s) => s.agent === 'claude')) throw err(409, 'no_session', 'This run has no Claude session yet.');
  if (body.target === 'terminal-cursor' && !r.sessions.some((s) => s.agent === 'cursor')) throw err(409, 'no_session', 'This run has no Cursor session yet.');
  if ((body.target === 'cursor' || body.target === 'finder') && !r.worktreeExists) throw err(409, 'no_worktree', 'The worktree for this run was already removed.');
  console.log(`[mock] open ${r.key} -> ${body.target}`);
}
function validateSettings(b) {
  const allowed = ['planApproval', 'planReview', 'maxLoops', 'maxParallel', 'onClaudeLimit', 'noGates', 'pickupFromBacklog', 'stages', 'linearMode'];
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw err(400, 'invalid_settings', `Unknown setting "${k}".`);
  const oneOf = (k, vals) => { if (k in b && !vals.includes(b[k])) throw err(400, 'invalid_settings', `${k} must be one of: ${vals.join(', ')}.`); };
  oneOf('planApproval', ['auto', 'manual', 'first']); oneOf('planReview', ['off', 'auto', 'always']); oneOf('onClaudeLimit', ['wait', 'cursor']);
  oneOf('noGates', ['warn', 'block']); oneOf('linearMode', ['labels', 'states']);
  const int = (k, lo, hi) => { if (k in b && !(Number.isInteger(b[k]) && b[k] >= lo && b[k] <= hi)) throw err(400, 'invalid_settings', `${k} must be a whole number between ${lo} and ${hi}.`); };
  int('maxLoops', 1, 10); int('maxParallel', 1, 8);
  if ('pickupFromBacklog' in b && typeof b.pickupFromBacklog !== 'boolean') throw err(400, 'invalid_settings', 'pickupFromBacklog must be true or false.');
  if ('stages' in b) {
    if (!b.stages || typeof b.stages !== 'object') throw err(400, 'invalid_settings', 'stages must be an object.');
    for (const k of Object.keys(b.stages)) { if (!['plan', 'review', 'verify'].includes(k)) throw err(400, 'invalid_settings', `Unknown stage "${k}".`); if (!['claude', 'cursor'].includes(b.stages[k])) throw err(400, 'invalid_settings', `stages.${k} must be claude or cursor.`); }
  }
}
function createTask(b) {
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title) throw err(400, 'invalid_task', 'A task needs a title.');
  if (title.length > 200) throw err(400, 'invalid_task', 'The title is longer than 200 characters.');
  let repo = b.repo;
  if (repo !== undefined && !M.repos.some((r) => r.name === repo)) throw err(400, 'unknown_repo', `"${repo}" is not a registered repository. Registered: ${M.repos.map((r) => r.name).join(', ') || 'none'}.`);
  if (repo === undefined) { if (M.repos.length === 1) repo = M.repos[0].name; else throw err(400, 'repo_required', 'Choose a repository for this task.'); }
  const key = 'ENG-' + M.nextIssue++;
  addTimer(2500, () => {
    const r = mkRun({ key, title, repo, status: 'queued', description: typeof b.description === 'string' ? b.description : '', startedAt: Date.now(), updatedAt: Date.now() });
    M.runs.set(key, r); tl(r, 'Claimed from Linear (Todo, label conductor)'); touch(r);
    toast('info', `${key} picked up from Linear.`);
    addTimer(4000, () => {
      if (r.status !== 'queued') return;
      r.status = 'running'; r.stage = 'plan'; r.next = 'plan'; r.stageStartedAt = Date.now(); r.baseSha = sha(); r.worktreeExists = true;
      session(r, 'claude', 'plan', { startedAt: Date.now(), status: 'running', endedAt: undefined }); tl(r, 'Claude started planning');
      pushLog(r, { agent: 'claude', stage: 'plan', kind: 'system', text: 'Session started · claude 2.1.296 · read-only tools: Read, Grep, Glob' });
      touch(r);
      addTimer(25_000, () => {
        if (r.status !== 'running' || r.stage !== 'plan') return;
        withPlanLive(r);
      });
    });
  });
  return { ok: true, key, url: `https://linear.app/demo/issue/${key}` };
}
function withPlanLive(r) {
  const base = genericPlan(r.title);
  r.plan = fullPlan(base); r.complexity = base.complexity;
  r.sessions.forEach((s) => { if (s.status === 'running') { s.status = 'ok'; s.endedAt = Date.now(); } });
  r.status = 'awaiting_approval'; r.next = 'approval'; r.stageStartedAt = null; tl(r, 'Plan rev 1 written');
  pushLog(r, { agent: 'claude', stage: 'plan', kind: 'result', text: 'Plan written: 3 steps, 2 acceptance criteria, size S.' });
  touch(r); toast('warn', `${r.key} has a plan waiting for your approval.`);
}

/* ───────────────────────── setup endpoints ───────────────────────── */
const LABELS = ['conductor', 'conductor-bug', 'conductor:planning', 'conductor:plan-ready', 'conductor:building', 'conductor:verifying', 'conductor:needs-human', 'conductor:ready'];
const STATES = ['Planning (started)', 'Plan Ready (started)', 'Building (started)', 'Verifying (started)', 'Needs Human (started)', 'Ready for Review (started)'];
async function setupLinearKey(b) {
  const key = typeof b.key === 'string' ? b.key.trim() : '';
  await sleep(700);
  if (!key.startsWith('lin_api_') || key.length < 24) throw err(400, 'linear_rejected', 'Linear rejected this key: Authentication required (HTTP 401). Check that you copied the whole key, it starts with lin_api_.');
  M.linearOk = true; M.viewer = { id: 'u-1', name: 'Demo User', email: 'demo@example.com' };
  scheduleState();
  return { ok: true, viewer: M.viewer, teams: TEAMS };
}
async function setupTeam(b) {
  if (!M.linearOk) throw err(409, 'no_key', 'Save a Linear key first.');
  const team = TEAMS.find((x) => x.id === b.teamId);
  if (!team) throw err(400, 'unknown_team', 'That team does not exist in this Linear workspace.');
  if (!['labels', 'states'].includes(b.mode)) throw err(400, 'bad_mode', 'mode must be labels or states.');
  await sleep(600);
  const eng = team.key === 'ENG';
  const will = [...LABELS.filter((n) => n !== 'conductor'), ...(b.mode === 'states' ? STATES : [])];
  if (b.dryRun) {
    return {
      ok: true, dryRun: true, willCreate: will, defaultState: eng ? { id: 's-backlog', name: 'Backlog', type: 'backlog' } : { id: 's-todo', name: 'Todo', type: 'unstarted' }, unstartedStates: ['Todo'],
      warnings: eng ? ['This team creates new issues in Backlog. Conductor only picks up issues in Todo, so a new issue with the label does nothing until it is moved.'] : [],
    };
  }
  if (!eng) {
    // simulate a permissions failure on the last labels so the UI shows the manual list
    const created = will.slice(0, 4); const manual = will.slice(4);
    return { ok: true, dryRun: false, created, manual };
  }
  M.teamId = team.id; M.teamOk = true; M.settings.linearMode = b.mode;
  scheduleState();
  return { ok: true, dryRun: false, created: will };
}
async function setupRepo(b) {
  let p = typeof b.path === 'string' ? b.path.trim() : '';
  if (p.startsWith('~')) p = HOME + p.slice(1);
  await sleep(500);
  if (!p.startsWith('/')) throw err(400, 'repo_invalid', 'The path must be absolute.');
  if (p === '/') throw err(400, 'repo_invalid', 'Refusing to use the filesystem root as a repository. Pick a project folder.');
  if (p.replace(/\/$/, '') === HOME) throw err(400, 'repo_invalid', 'Refusing to use your home folder. Pick the project folder inside it.');
  if (p.includes('notgit')) throw err(400, 'repo_invalid', `${p} is not a git work tree. \`git rev-parse --show-toplevel\` failed there.`);
  const name = (typeof b.name === 'string' && b.name.trim()) || path.basename(p.replace(/\/$/, ''));
  if (!/^[\w.-]+$/.test(name)) throw err(400, 'repo_invalid', 'Repository names may only contain letters, numbers, dots, dashes and underscores.');
  if (M.repos.some((r) => r.name === name)) throw err(409, 'repo_exists', `A repository named "${name}" is already registered.`);
  const noGates = p.includes('nogates');
  const repo = {
    name, path: p, baseBranch: 'main', approvedPlans: 0, noGates,
    gates: noGates ? [] : [{ name: 'typecheck', cmd: 'npm run typecheck', kind: 'typecheck' }, { name: 'lint', cmd: 'npm run lint', kind: 'lint' }, { name: 'test', cmd: 'npm test', kind: 'test' }],
    warnings: noGates ? ['No test, lint or type gates detected. Runs here will be marked Unverified.'] : [],
  };
  M.repos.push(repo); scheduleState();
  return { ok: true, repo };
}
async function setupProbe(b) {
  if (!['claude', 'cursor', 'linear'].includes(b.target)) throw err(400, 'bad_target', 'target must be claude, cursor or linear.');
  const ms = { claude: 1800, cursor: 1400, linear: 500 }[b.target];
  await sleep(ms);
  if (b.target === 'claude' && M.scenario === 'limit') return { ok: false, detail: 'Claude is over its 7-day usage limit. It resets at ' + hhmm(M.quota.claude.resetsAt) + '.', durationMs: ms };
  if (b.target === 'claude' && !M.health.claude.ok) return { ok: false, detail: M.health.claude.detail || 'Claude Code did not answer.', durationMs: ms };
  if (b.target === 'cursor' && !M.health.cursor.ok) return { ok: false, detail: M.health.cursor.found ? 'Cursor agent did not answer.' : 'The Cursor CLI is not installed.', durationMs: 40 };
  if (b.target === 'linear' && !M.linearOk) return { ok: false, detail: 'No Linear key saved yet.', durationMs: 5 };
  return { ok: true, detail: { claude: 'Claude Code 2.1.296 answered "pong" using about 14 tokens.', cursor: 'Cursor agent 2026.10.19 answered "pong".', linear: 'Linear answered as Demo User.' }[b.target], durationMs: ms };
}

/* ───────────────────────── http ───────────────────────── */
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
};
function send(res, status, body, headers) {
  res.writeHead(status, { ...SEC_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...(headers || {}) });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 1_048_576) { reject(err(413, 'too_large', 'Request body is larger than 1 MB.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!n) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(err(400, 'bad_json', 'The request body is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}
async function route(req, res, url) {
  const p = url.pathname; const method = req.method;
  if (M.expired || M.signedOut) throw err(401, 'unauthorized', 'Session expired. Run `conductor open` in a terminal.');
  if (method !== 'GET') {
    const ct = String(req.headers['content-type'] || '');
    if (!ct.toLowerCase().startsWith('application/json')) throw err(415, 'unsupported_media_type', 'Send the body as application/json.');
    if (req.headers['x-conductor-csrf'] !== M.csrf) throw err(403, 'csrf', 'Missing or wrong CSRF token. Reload the page and try again.');
  }
  let m;
  if (method === 'GET' && p === '/api/state') return send(res, 200, buildState());
  if (method === 'GET' && (m = /^\/api\/runs\/([^/]+)$/.exec(p))) return send(res, 200, detailOf(getRun(decodeURIComponent(m[1]))));
  if (method === 'GET' && (m = /^\/api\/runs\/([^/]+)\/log$/.exec(p))) {
    const r = getRun(decodeURIComponent(m[1]));
    const after = Number(url.searchParams.get('after') || 0) || 0;
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit') || 500) || 500));
    const all = (M.logs.get(r.key) || { events: [] }).events;
    const events = all.filter((e) => e.seq > after).slice(0, limit);
    return send(res, 200, { events, next: events.length ? events[events.length - 1].seq : after });
  }
  if (method === 'GET' && p === '/api/events') {
    res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    M.clients.add(res);
    req.on('close', () => M.clients.delete(res));
    return undefined;
  }
  if (method === 'POST' && p === '/api/tasks') { const r = createTask(await readBody(req)); return send(res, 201, r); }
  if (method === 'POST' && (m = /^\/api\/runs\/([^/]+)\/(approve|retry|resume|abort|cleanup|open)$/.exec(p))) {
    const r = getRun(decodeURIComponent(m[1]));
    const body = await readBody(req);
    if (m[2] === 'open') openAction(r, body); else actions[m[2]](r);
    touch(r); recount();
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && p === '/api/engine/pause') {
    const b = await readBody(req);
    if (typeof b.paused !== 'boolean') throw err(400, 'bad_request', 'paused must be true or false.');
    M.engine.paused = b.paused; M.engine.pauseReason = b.paused ? 'Paused from the dashboard' : undefined;
    scheduleState();
    return send(res, 200, { ok: true, paused: b.paused });
  }
  if (method === 'PUT' && p === '/api/settings') {
    const b = await readBody(req); validateSettings(b);
    const { stages, ...rest } = b;
    Object.assign(M.settings, rest); if (stages) M.settings.stages = { ...M.settings.stages, ...stages };
    scheduleState();
    return send(res, 200, { ok: true, settings: M.settings });
  }
  if (method === 'POST' && p === '/api/auth/logout') { await readBody(req); M.signedOut = true; return send(res, 200, { ok: true }); }
  if (method === 'POST' && p === '/api/setup/linear-key') return send(res, 200, await setupLinearKey(await readBody(req)));
  if (method === 'POST' && p === '/api/setup/team') return send(res, 200, await setupTeam(await readBody(req)));
  if (method === 'POST' && p === '/api/setup/repo') return send(res, 200, await setupRepo(await readBody(req)));
  if (method === 'POST' && p === '/api/setup/probe') return send(res, 200, await setupProbe(await readBody(req)));
  if (method === 'DELETE' && (m = /^\/api\/setup\/repo\/([^/]+)$/.exec(p))) {
    await readBody(req);
    const name = decodeURIComponent(m[1]);
    if (!M.repos.some((r) => r.name === name)) throw err(404, 'not_found', `No repository named ${name}.`);
    M.repos = M.repos.filter((r) => r.name !== name); scheduleState();
    return send(res, 200, { ok: true });
  }
  throw err(404, 'not_found', `No such endpoint: ${method} ${p}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      if (url.pathname === '/') {
        const sc = url.searchParams.get('scenario');
        if (sc) seed(sc); else if (M.signedOut) M.signedOut = false;
      }
      const [file, type] = STATIC[url.pathname];
      const body = await readFile(path.join(UI_DIR, file));
      res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': type });
      return res.end(body);
    }
    if (url.pathname.startsWith('/api/')) return await route(req, res, url);
    return send(res, 404, { error: { code: 'not_found', message: 'Not found.' } });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[mock] error', e);
    if (!res.headersSent) return send(res, status, { error: { code: e.code || 'internal', message: e.message || 'Internal error' } });
    try { res.end(); } catch { /* noop */ }
    return undefined;
  }
});

seed(DEFAULT_SCENARIO);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Conductor mock API on http://127.0.0.1:${PORT}/  (scenario: ${M.scenario}${SIM ? '' : ', simulation off'})`);
  console.log(`Try: ${SCENARIOS.map((s) => `/?scenario=${s}`).join('  ')}`);
});
