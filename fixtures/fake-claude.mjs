#!/usr/bin/env node
// Scripted stand-in for the `claude` CLI (stream-json). Used by tests and `conductor demo`.
// Behaviour comes from $FAKE_DIR/scenario.json (see test/helpers/fakes.ts). Event shapes mirror the real CLI 2.1.296.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('2.1.296 (Claude Code)');
  process.exit(0);
}
const dir = process.env.FAKE_DIR || '';
if (argv[0] === 'auth' && argv[1] === 'status') {
  // sign-in state: scenario `login: 'out'` ⇒ signed out (shape of the real `claude auth status` JSON)
  let login = 'ok';
  try {
    login = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8')).login ?? 'ok';
  } catch {}
  if (login === 'out') {
    console.log(JSON.stringify({ loggedIn: false }));
    process.exit(1);
  }
  console.log(JSON.stringify({ loggedIn: true, email: 'fake@example.com', orgName: 'Fake Org', subscriptionType: 'max' }));
  process.exit(0);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

const stageMatch = /^# Stage: (\w+)/m.exec(prompt);
const stage = (stageMatch?.[1] ?? 'UNKNOWN').toLowerCase();
const key = /^Issue key: ([A-Z][A-Z0-9]*-\d+)\s*$/m.exec(prompt)?.[1] ?? 'UNKNOWN-0';
const title = /^Title: (.*)$/m.exec(prompt)?.[1] ?? 'Untitled';
const acIds = [...new Set([...prompt.matchAll(/\*\*(AC\d+)\*\*/g)].map((m) => m[1]))];

function scenario() {
  try {
    return JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'));
  } catch {
    return {};
  }
}
function nextIndex() {
  if (!dir) return 0;
  mkdirSync(dir, { recursive: true });
  // an atomic claim (mkdir fails with EEXIST for everyone but one), so concurrent invocations never share an index
  for (let i = 0; ; i++) {
    try {
      mkdirSync(join(dir, `counter-${key}-${stage}-${i}`));
      return i;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}
const idx = nextIndex();
const sc = scenario();
const mine = sc.claude?.[key] ?? sc.claude?.['*'] ?? {};
const list = mine[stage];
const step = Array.isArray(list) ? (list[Math.min(idx, list.length - 1)] ?? {}) : {};

if (dir) {
  appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ who: 'claude', argv, stage, key, idx, cwd: process.cwd(), envKeys: Object.keys(process.env), promptBytes: prompt.length }) + '\n');
  if (step.savePrompt) writeFileSync(join(dir, `prompt-claude-${key}-${stage}-${idx}.txt`), prompt);
}

const sid = randomUUID();
const tools = step.badInit ? ['Glob', 'Grep', 'Read', 'Bash', 'StructuredOutput'] : ['Glob', 'Grep', 'Read', 'StructuredOutput'];
out({
  type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sid, tools,
  mcp_servers: step.badInit ? [{ name: 'claude.ai Linear', status: 'connected', source: 'claudeai' }] : [],
  model: 'claude-fake-1', permissionMode: 'dontAsk', slash_commands: [], skills: [], agents: ['claude', 'Explore'],
  plugins: Array.from({ length: 3 }, (_, i) => ({ name: `builtin-${i}`, path: 'builtin', source: `p${i}@builtin` })),
  claude_code_version: '2.1.296', apiKeySource: 'none', uuid: randomUUID(),
});
await sleep(step.delayMs ?? 30);

if (step.hang) await sleep(120_000);

if (step.limit) {
  const resetsAt = step.limit.resetsAt ?? Math.floor(Date.now() / 1000) + 3600;
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'seven_day', overageStatus: 'rejected', isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0, resetsAt: resetsAt - 100 }, seven_day: { utilization: 1, resetsAt } } }, session_id: sid });
  out({ type: 'assistant', message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your weekly limit" }] }, session_id: sid });
  out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, api_error: 'usage_limit_reached', result: "You've hit your weekly limit · resets Oct 21 at 2pm (Europe/London)", session_id: sid, total_cost_usd: 0, num_turns: 1 });
  process.exit(1);
}
if (step.error) {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: String(step.error), session_id: sid, total_cost_usd: 0, num_turns: 1 });
  process.exit(1);
}
if (step.maxTurns) {
  out({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'max turns', session_id: sid, total_cost_usd: 0.01, num_turns: 99 });
  process.exit(1);
}

// a little realistic activity
out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Looking at the repository for ${key}…` }] }, session_id: sid });
out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Glob', input: { pattern: '**/*.{js,mjs,ts,json}' } }] }, session_id: sid });
await sleep(step.delayMs ?? 30);
out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'package.json\nsrc/index.mjs' }] }, session_id: sid });
out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: 'package.json' } }] }, session_id: sid });
out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: '{ "name": "demo" }' }] }, session_id: sid });

function defaultPlan() {
  return {
    summary: `Implement "${title}" with a small, tested change.`,
    blocked: { is: false, questions: [] },
    assumptions: ['Existing project conventions apply.'],
    currentState: 'The repository has no implementation for this yet (see package.json, src/).',
    expectedState: `The requested behaviour exists and is covered by a test. Nothing else changes.`,
    acceptanceCriteria: [{ id: 'AC1', text: `${title} works as described`, verification: 'node --test passes with a new test' }],
    filesToChange: [
      { path: `feature-${key.toLowerCase()}.mjs`, action: 'create', change: 'implement the feature', reason: 'AC1' },
      { path: `feature-${key.toLowerCase()}.test.mjs`, action: 'create', change: 'test for the feature', reason: 'AC1' },
    ],
    steps: ['Create the module', 'Add a test', 'Run the gates'],
    testing: { commands: ['npm test'], cases: ['feature returns the expected value'] },
    risks: ['None significant.'],
    coverage: [{ requirement: title, change: 'new module + test', verification: 'npm test' }],
    complexity: 'S',
  };
}
const planFor = () => ({ ...defaultPlan(), ...(step.json ?? {}) });
const reviewFor = () => ({ decision: 'approved', summary: 'The plan covers every requirement.', issues: [], ...(step.json ?? {}) });
function verdictFor() {
  const v = step.json ?? {};
  const verdict = v.verdict ?? 'pass';
  const ids = acIds.length ? acIds : ['AC1'];
  return {
    verdict,
    summary: v.summary ?? (verdict === 'pass' ? 'All acceptance criteria are met and the gates pass.' : 'Problems were found.'),
    acceptance: v.acceptance ?? ids.map((id) => ({ id, status: verdict === 'pass' ? 'met' : 'not_met', evidence: `feature-${key.toLowerCase()}.mjs:1` })),
    bugs: v.bugs ?? [],
  };
}
let payload;
if (stage === 'plan') payload = planFor();
else if (stage === 'plan_review') payload = reviewFor();
else if (stage === 'analysis') payload = { summary: 'Analysis complete.', details: 'Nothing blocking.', decisions: [], ...(step.json ?? {}) };
else if (stage === 'verify') payload = verdictFor();
else payload = { note: `fake claude does not handle stage ${stage}` };
if (step.raw) payload = step.raw; // e.g. an invalid object to test validation

const text = '```json\n' + JSON.stringify(payload, null, 2) + '\n```';
out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: step.noStructured ? text : 'Done.' }] }, session_id: sid });
const result = { type: 'result', subtype: 'success', is_error: false, result: step.noStructured ? text : 'Done.', session_id: sid, total_cost_usd: 0.0123, num_turns: 4, duration_ms: 1200 };
if (!step.noStructured) result.structured_output = payload;
out(result);
process.exit(0);
