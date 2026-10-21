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

// ───────── model discovery (M8-1): one `initialize` control request on stdin, never a prompt ─────────
// Scenario key `models` (top level of scenario.json): in | out | decoy | stderr-email | turn | garbage | wrong-id | nomodels | error |
// hang | flood | manylines | longline | plant. `modelsInner` replaces response.response; `modelsRaw` is written verbatim as the reply line.
if (argv.includes('--input-format') && prompt.startsWith('{"type":"control_request"')) await discovery();

async function discovery() {
  const flush = () => new Promise((r) => process.stdout.write('', () => process.stderr.write('', r)));
  const here = new URL('.', import.meta.url).pathname;
  let sc = {};
  try {
    sc = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'));
  } catch {}
  const mode = sc.models ?? 'in';
  const stdinLines = prompt.split('\n').filter(Boolean);
  let reqId = 'r1';
  let prompts = 0;
  for (const l of stdinLines) {
    try {
      const o = JSON.parse(l);
      if (o.type === 'control_request' && o.request?.subtype === 'initialize') reqId = o.request_id;
      else prompts++;
    } catch {
      prompts++;
    }
  }
  if (dir) {
    mkdirSync(dir, { recursive: true });
    let cwdEntries = [];
    try {
      cwdEntries = (await import('node:fs')).readdirSync(process.cwd());
    } catch {}
    appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ who: 'claude', mode: 'models', scenario: mode, argv, cwd: process.cwd(), cwdEntries, envKeys: Object.keys(process.env), stdinLines: stdinLines.length, prompts, at: Date.now() }) + '\n');
  }
  const fixture = (f) => JSON.parse(readFileSync(join(here, 'real', f), 'utf8'));
  const reply = (inner, subtype = 'success', id = reqId) => out({ type: 'control_response', response: { subtype, request_id: id, response: inner, pending_permission_requests: [], pending_user_dialog_requests: [] } });
  const linger = () => sleep(sc.lingerMs ?? 30_000); // the real CLI exits on EOF; the fake lingers so tests prove Conductor kills it (S1)
  out({ type: 'system', subtype: 'ui_invalidate', event: 'ui.render', uuid: randomUUID(), session_id: randomUUID() });
  const signedIn = () => fixture('claude-initialize-2.1.304.json').response.response;
  if (mode === 'in' || mode === 'plant') {
    if (mode === 'plant') writeFileSync(join(process.cwd(), 'left-behind.txt'), 'x');
    reply(signedIn());
    await linger();
  } else if (mode === 'out') {
    reply(fixture('claude-initialize-2.1.304-signed-out.json').response.response);
    await linger();
  } else if (mode === 'decoy') {
    process.stderr.write('Logged in as decoy.person@example.com (DECOY_ORG_7f3) at /Users/decoy/.claude\n');
    const inner = signedIn();
    reply({ commands: [{ name: 'DECOY_CMD_7f3', description: 'decoy.person@example.com' }], agents: ['DECOY_AGENT_7f3'], output_style: 'DECOY_STYLE_7f3', pid: 4242, ...inner, account: { email: 'decoy.person@example.com', organization: 'DECOY_ORG_7f3', subscriptionType: 'Claude Team', apiProvider: 'firstParty', tokenSource: 'DECOY_TOKEN_7f3', userID: 'DECOY_USER_7f3' } });
    await linger();
  } else if (mode === 'stderr-email') {
    process.stderr.write('Error: account decoy.person@example.com at /Users/decoy/.claude/x.json is not usable\n');
    await flush(); process.exit(1);
  } else if (mode === 'turn') {
    out({ type: 'system', subtype: 'init', session_id: randomUUID(), tools: [], model: 'claude-fake-1' });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'a turn started' }] } });
    reply(signedIn());
    await linger();
  } else if (mode === 'garbage') {
    process.stdout.write('this is not json\n{"half": \n');
    reply(signedIn(), 'success', 'not-ours');
    await flush(); process.exit(0);
  } else if (mode === 'wrong-id') {
    reply(signedIn(), 'success', 'r2');
    await flush(); process.exit(0);
  } else if (mode === 'nomodels') {
    const { models, ...rest } = signedIn();
    void models;
    reply(rest);
    await linger();
  } else if (mode === 'error') {
    out({ type: 'control_response', response: { subtype: 'error', request_id: reqId, error: 'no' } });
    await linger();
  } else if (mode === 'inner') {
    reply(sc.modelsInner);
    await linger();
  } else if (mode === 'raw') {
    process.stdout.write(String(sc.modelsRaw).replace('__REQ__', reqId) + '\n');
    await linger();
  } else if (mode === 'hang') {
    await sleep(120_000);
  } else if (mode === 'flood') {
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 80; i++) if (!process.stdout.write(chunk)) await new Promise((r) => process.stdout.once('drain', r));
    reply(signedIn());
    await linger();
  } else if (mode === 'manylines') {
    let buf = '';
    for (let i = 0; i < 50_000; i++) buf += `{"type":"system","subtype":"noise","n":${i},"pad":"${'p'.repeat(20)}"}\n`;
    process.stdout.write(buf);
    reply(signedIn()); // a valid reply after the cap: it must never be used (R2-5)
    await linger();
  } else if (mode === 'longline') {
    process.stdout.write('{"pad":"' + 'y'.repeat(600 * 1024) + '"}\n');
    reply(signedIn());
    await linger();
  }
  await flush(); process.exit(0);
}

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
const isResearch = argv.includes('WebSearch,WebFetch');
const tools = isResearch ? ['WebFetch', 'WebSearch', 'StructuredOutput', ...(step.extraTool ? [step.extraTool] : [])] : step.badInit ? ['Glob', 'Grep', 'Read', 'Bash', 'StructuredOutput'] : ['Glob', 'Grep', 'Read', 'StructuredOutput', ...(step.extraTool ? [step.extraTool] : [])];
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
if (step.network) {
  process.stderr.write(String(step.error ?? 'getaddrinfo ENOTFOUND api.anthropic.com') + '\n');
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
else if (stage === 'ask') payload = { kind: 'answer', answer: `Answer about ${title}.`, citations: [], ...(step.json ?? {}) };
else if (stage === 'research') payload = { summary: 'Research summary.', findings: [{ claim: 'Opened claim', sources: [{ url: 'https://example.com/a?utm_source=x#frag', title: 'A', quote: 'q' }] }, { claim: 'Listed claim', sources: [{ url: 'https://example.com/listed', title: 'L', quote: 'q' }] }, { claim: 'Made-up claim', sources: [{ url: 'https://example.com/never-seen', title: 'N', quote: 'q' }] }, { claim: 'Bad scheme', sources: [{ url: 'javascript:alert(1)', title: 'X', quote: '' }, { url: 'https://user:pw@example.com/', title: 'Y', quote: '' }] }], alternatives: [{ name: 'Option A', pros: ['fast'], cons: ['new'] }], recommendation: 'Use option A.', steps: ['Do step one', 'Do step two'], limitations: 'None.', ...(step.json ?? {}) };
else if (stage === 'analysis') payload = { summary: 'Analysis complete.', details: 'Nothing blocking.', decisions: [], ...(step.json ?? {}) };
else if (stage === 'verify') payload = verdictFor();
else if (stage === 'design') payload = { title: 'Add the feature', summary: 'Add the feature with a test.', approach: 'Change `src/index.mjs` and add a test.', files: [{ path: 'src/index.mjs', why: 'the entry point' }, { path: 'src/index.test.mjs', why: 'new test' }], acceptance: ['The feature works', 'A test covers it'], risks: ['None significant.'], parts: [{ title: 'Implement it', summary: 'The change itself.', size: 'S', files: ['src/index.mjs'], deps: [] }, { title: 'Test it', summary: 'A test for the change.', size: 'S', files: ['src/index.test.mjs'], deps: [1] }], ...(step.json ?? {}) };
else if (stage === 'research_brief') payload = { title: 'Research brief', objective: 'Decide which option to use.', questions: ['What are the options?', 'What do they cost?', 'Which is maintained?'], scope: { in: ['open-source options'], out: ['paid services'], timeWindow: '2024 onwards' }, sourceTypes: ['official-docs', 'release-notes'], deliverable: 'A summary, findings with sources, alternatives, a recommendation.', ...(step.json ?? {}) };
else payload = { note: `fake claude does not handle stage ${stage}` };
if (step.raw) payload = step.raw; // e.g. an invalid object to test validation

if (isResearch) {
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'WebSearch', input: { query: 'fake query' } }, { type: 'tool_use', id: 'w2', name: 'WebFetch', input: { url: 'https://example.com/a' } }] }, session_id: sid });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'Links: [{"title":"L","url":"https://example.com/listed"}]' }] }, session_id: sid });
}
const text = '```json\n' + JSON.stringify(payload, null, 2) + '\n```';
out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: step.noStructured ? text : 'Done.' }] }, session_id: sid });
const result = { type: 'result', subtype: 'success', is_error: false, result: step.noStructured ? text : 'Done.', session_id: sid, total_cost_usd: 0.0123, num_turns: 4, duration_ms: 1200 };
if (!step.noStructured) result.structured_output = payload;
out(result);
process.exit(0);
