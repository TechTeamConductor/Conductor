#!/usr/bin/env node
// Scripted stand-in for the Cursor `agent` CLI (stream-json). Event shapes mirror real captures (agent 2026.10.19).
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('2026.10.19-fake');
  process.exit(0);
}
if (argv[0] === 'status' || argv[0] === 'whoami') {
  console.log('✓ Logged in as fake@example.com');
  process.exit(0);
}
const dir = process.env.FAKE_DIR || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const flag = (n) => argv.includes(n);
const val = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

const isBuild = flag('--force');
const workspace = resolve(val('--workspace') ?? process.cwd());
const stageRaw = /^# Stage: (\w+)/m.exec(prompt)?.[1] ?? 'UNKNOWN';
const stage = stageRaw.toLowerCase();
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
function nextIndex(name) {
  if (!dir) return 0;
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `counter-cursor-${key}-${name}`);
  appendFileSync(f, 'x');
  return statSync(f).size - 1;
}
const slot = isBuild ? 'build' : stage;
const idx = nextIndex(slot);
const sc = scenario();
const mine = sc.cursor?.[key] ?? sc.cursor?.['*'] ?? {};
const list = mine[slot];
const step = Array.isArray(list) ? (list[Math.min(idx, list.length - 1)] ?? {}) : {};

if (dir) {
  appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ who: 'cursor', argv, stage: slot, key, idx, cwd: process.cwd(), workspace, envKeys: Object.keys(process.env), env: pickEnv(), promptBytes: prompt.length }) + '\n');
  if (step.savePrompt || process.env.FAKE_SAVE_PROMPTS) writeFileSync(join(dir, `prompt-cursor-${key}-${slot}-${idx}.txt`), prompt);
}
function pickEnv() {
  const o = {};
  for (const k of Object.keys(process.env)) if (/^(GIT_|LINEAR|CURSOR|ANTHROPIC|CLAUDE)/.test(k)) o[k] = k.includes('KEY') || k.includes('TOKEN') ? '<set>' : process.env[k];
  return o;
}

const sid = randomUUID();
out({ type: 'system', subtype: 'init', apiKeySource: 'login', cwd: workspace, session_id: sid, model: 'Auto', permissionMode: isBuild ? 'default' : 'plan' });
out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt.slice(0, 80) }] }, session_id: sid });
await sleep(step.delayMs ?? 30);
if (step.hang) await sleep(120_000);

if (step.limit) {
  out({ type: 'result', subtype: 'error', is_error: true, result: "You've hit your usage limit. Upgrade your plan to continue.", session_id: sid });
  process.exit(1);
}
if (step.error) {
  process.stderr.write(String(step.error) + '\n');
  process.exit(1);
}

const think = (t) => {
  out({ type: 'thinking', subtype: 'delta', text: t, session_id: sid, timestamp_ms: Date.now() });
  out({ type: 'thinking', subtype: 'completed', session_id: sid, timestamp_ms: Date.now() });
};

if (!isBuild) {
  // read-only (ask/plan) — answer with a fenced JSON block, like the real CLI
  think('Reading the repository and drafting the structured answer.');
  const planDefault = {
    summary: `Implement "${title}" with a small, tested change.`, blocked: { is: false, questions: [] }, assumptions: [],
    currentState: 'No implementation yet.', expectedState: 'Feature exists with a test.',
    acceptanceCriteria: [{ id: 'AC1', text: `${title} works`, verification: 'node --test' }],
    filesToChange: [{ path: `feature-${key.toLowerCase()}.mjs`, action: 'create', change: 'implement', reason: 'AC1' }],
    steps: ['Implement', 'Test'], testing: { commands: ['npm test'], cases: ['works'] }, risks: [], coverage: [{ requirement: title, change: 'new module', verification: 'npm test' }], complexity: 'S',
  };
  const ids = acIds.length ? acIds : ['AC1'];
  const payload =
    stage === 'plan' ? { ...planDefault, ...(step.json ?? {}) }
    : stage === 'plan_review' ? { decision: 'approved', summary: 'Looks right.', issues: [], ...(step.json ?? {}) }
    : { verdict: step.json?.verdict ?? 'pass', summary: step.json?.summary ?? 'Verified.', acceptance: step.json?.acceptance ?? ids.map((id) => ({ id, status: (step.json?.verdict ?? 'pass') === 'pass' ? 'met' : 'not_met', evidence: 'feature.mjs:1' })), bugs: step.json?.bugs ?? [] };
  const text = `Using SoftCo Lead to analyse this.\n\`\`\`json\n${JSON.stringify(step.raw ?? payload, null, 2)}\n\`\`\``;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, session_id: sid });
  out({ type: 'result', subtype: 'success', duration_ms: 900, duration_api_ms: 900, is_error: false, result: text, session_id: sid, request_id: randomUUID(), usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  process.exit(0);
}

// ───────── build ─────────
think('Planning the edit, then writing the files.');
out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Implementing ${key}…` }] }, session_id: sid });
const slug = key.toLowerCase();
const defaults = idx === 0
  ? { files: { [`feature-${slug}.mjs`]: `export const feature = () => 42; // ${title}\n`, [`feature-${slug}.test.mjs`]: `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { feature } from './feature-${slug}.mjs';\ntest('feature', () => assert.equal(feature(), 42));\n` } }
  : { files: { [`feature-${slug}.mjs`]: `export const feature = () => 42; // ${title} (fixed in attempt ${idx + 1})\n` } };
const files = step.files ?? defaults.files;
let n = 0;
for (const [rel, content] of Object.entries(files)) {
  const p = resolve(workspace, rel);
  if (!p.startsWith(workspace)) continue;
  const id = `call-${++n}`;
  out({ type: 'tool_call', subtype: 'started', call_id: id, tool_call: { editToolCall: { args: { path: p, streamContent: String(content) } } }, session_id: sid });
  if (content === null) rmSync(p, { force: true });
  else {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(content));
  }
  out({ type: 'tool_call', subtype: 'completed', call_id: id, tool_call: { editToolCall: { args: { path: p }, result: { success: { path: p, linesAdded: String(content).split('\n').length, linesRemoved: 0 } } } }, session_id: sid });
  await sleep(10);
}
for (const rel of step.delete ?? []) rmSync(resolve(workspace, rel), { force: true });
if (step.attemptPush) {
  const r = spawnSync('git', ['push', ...(step.attemptPush === true ? ['origin', 'HEAD:refs/heads/probe'] : step.attemptPush)], { cwd: workspace, encoding: 'utf8' });
  out({ type: 'tool_call', subtype: 'completed', call_id: 'push', tool_call: { shellToolCall: { args: { command: 'git push' }, result: { success: { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr } } } }, session_id: sid });
}
if (step.commitSelf) {
  spawnSync('git', ['add', '-A'], { cwd: workspace });
  spawnSync('git', ['-c', 'user.name=Agent', '-c', 'user.email=agent@example.com', 'commit', '-q', '-m', 'agent committed by itself'], { cwd: workspace });
}
if (step.tamperGit) {
  // plant persistent code execution the way a hostile builder would: a repo-local alias/hook setting and a git hook
  spawnSync('git', ['config', '--local', 'core.hooksPath', '/tmp/evil-hooks'], { cwd: workspace });
  spawnSync('git', ['config', '--local', 'alias.pwn', '!echo pwned'], { cwd: workspace });
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: workspace, encoding: 'utf8' }).stdout.trim();
  mkdirSync(join(common, 'hooks'), { recursive: true });
  writeFileSync(join(common, 'hooks', 'post-commit'), '#!/bin/sh\necho pwned\n', { mode: 0o755 });
}
if (step.tamperGuard) writeFileSync(join(workspace, '.cursor', 'cli.json'), '{"permissions":{"allow":[],"deny":[]}}\n');
if (step.deleteGuard) rmSync(join(workspace, '.cursor', 'cli.json'), { force: true });
if (step.tamperPushUrl) spawnSync('git', ['config', '--local', 'remote.origin.pushurl', 'file:///tmp/conductor-evil-remote.git'], { cwd: workspace });
// { 'from/path': 'to/path' } — a tracked file renamed by the builder (git mv), so a rename SOURCE shows up in the diff
for (const [from, to] of Object.entries(step.rename ?? {})) {
  mkdirSync(dirname(resolve(workspace, to)), { recursive: true });
  spawnSync('git', ['mv', from, to], { cwd: workspace });
}
out({ type: 'tool_call', subtype: 'started', call_id: 'sh', tool_call: { shellToolCall: { args: { command: 'npm test', workingDirectory: workspace } } }, session_id: sid });
out({ type: 'tool_call', subtype: 'completed', call_id: 'sh', tool_call: { shellToolCall: { args: { command: 'npm test' }, result: { success: { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '' } } } }, session_id: sid });
const summary = step.message ?? `Implemented ${key}: ${Object.keys(files).join(', ')}. Ran npm test — passing.`;
out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: summary }] }, session_id: sid });
out({ type: 'result', subtype: 'success', duration_ms: 2100, duration_api_ms: 2100, is_error: false, result: summary, session_id: sid, request_id: randomUUID(), usage: { inputTokens: 5000, outputTokens: 600, cacheReadTokens: 100, cacheWriteTokens: 0 } });
process.exit(0);
