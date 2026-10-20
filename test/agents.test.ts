import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClaudeArgs, checkClaudeInit, normalizeClaudeEvent, runClaude, type EmitEvent } from '../src/agents/claude.ts';
import { buildCursorArgs, normalizeCursorEvent, runCursor } from '../src/agents/cursor.ts';
import { describeSchema, extractJson, validateSchema } from '../src/agents/json.ts';
import { runProcess } from '../src/agents/spawn.ts';
import { claudeEnv, cursorEnv, toolEnv } from '../src/agents/env.ts';
import { PLAN_SCHEMA, VERDICT_SCHEMA } from '../src/pipeline/schemas.ts';
import { replayBin } from './helpers/replay.ts';

const REAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'real');
const lines = (f: string) => readFileSync(join(REAL, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const initOf = (f: string) => lines(f).find((x) => x.subtype === 'init');

test('B1: init predicate accepts the REAL init events (with and without --json-schema); plugins/agents are informational', () => {
  assert.deepEqual(checkClaudeInit(initOf('claude-stream-with-schema.ndjson'), { expectStructuredOutput: true }), { ok: true });
  assert.deepEqual(checkClaudeInit(initOf('claude-stream-no-schema.ndjson')), { ok: true });
  assert.ok(initOf('claude-stream-with-schema.ndjson').plugins.length > 0, 'fixture really carries plugins');
});

test('B1: init predicate rejects any leakage', () => {
  const base = () => structuredClone(initOf('claude-stream-with-schema.ndjson'));
  const cases: [string, (i: any) => void, RegExp][] = [
    ['extra tool', (i) => i.tools.push('Bash'), /unexpected tools/],
    ['MCP server', (i) => (i.mcp_servers = [{ name: 'claude.ai Linear' }]), /MCP/],
    ['skill', (i) => (i.skills = ['tech-skill']), /skills/],
    ['slash command', (i) => (i.slash_commands = ['/review']), /slash/],
    ['permission mode', (i) => (i.permissionMode = 'default'), /permissionMode/],
    ['missing Read', (i) => (i.tools = ['Glob', 'Grep', 'StructuredOutput']), /missing: Read/],
  ];
  for (const [name, mutate, re] of cases) {
    const i = base();
    mutate(i);
    const r = checkClaudeInit(i, { expectStructuredOutput: true });
    assert.equal(r.ok, false, name);
    assert.match(r.reason ?? '', re, name);
  }
  assert.equal(checkClaudeInit(null).ok, false);
  const noStructured = base();
  noStructured.tools = ['Glob', 'Grep', 'Read'];
  assert.equal(checkClaudeInit(noStructured, { expectStructuredOutput: true }).ok, false);
});

test('Claude argv: exact locked-down flag set, prompt NOT on argv, schema + model + name passed', () => {
  const a = buildClaudeArgs({ schema: { type: 'object' }, maxTurns: 40, isolation: 'safe-mode', name: 'conductor ENG-1 plan', model: 'sonnet' });
  for (const f of ['-p', '--verbose', '--safe-mode', '--disable-slash-commands', '--strict-mcp-config', '--json-schema']) assert.ok(a.includes(f), f);
  assert.equal(a[a.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(a[a.indexOf('--permission-prompts') + 1], 'none');
  assert.equal(a[a.indexOf('--max-turns') + 1], '40');
  assert.equal(a[a.indexOf('--model') + 1], 'sonnet');
  assert.equal(a[a.indexOf('-n') + 1], 'conductor ENG-1 plan');
  assert.ok(!a.includes('--bare') && !a.includes('--dangerously-skip-permissions'));
  const fb = buildClaudeArgs({ maxTurns: 5, isolation: 'setting-sources', name: 'x' });
  assert.ok(!fb.includes('--safe-mode') && fb.includes('--setting-sources') && fb[fb.indexOf('--setting-sources') + 1] === 'project,local');
});

test('Cursor argv: build uses --force --trust, read-only never does; never --approve-mcps', () => {
  const b = buildCursorArgs({ mode: 'build', cwd: '/w', model: 'm' });
  assert.deepEqual(b.slice(0, 2), ['-p', '--force']);
  assert.ok(b.includes('--trust') && b.includes('--output-format') && b[b.indexOf('--workspace') + 1] === '/w' && b[b.indexOf('--model') + 1] === 'm');
  const r = buildCursorArgs({ mode: 'ask', cwd: '/w' });
  assert.ok(!r.includes('--force') && r[r.indexOf('--mode') + 1] === 'ask');
  for (const a of [b, r]) assert.ok(!a.includes('--approve-mcps'));
});

test('REAL Claude limit stream → LIMIT result with the true reset time and quota (zero-quota capture)', async () => {
  const bin = replayBin(join(REAL, 'claude-stream-with-schema.ndjson'), 1);
  const events: EmitEvent[] = [];
  const r = await runClaude({ bin, cwd: process.cwd(), prompt: 'x', stage: 'plan', name: 'n', schema: { type: 'object' }, maxTurns: 3, isolation: 'safe-mode', env: claudeEnv(), idleMs: 20_000, hardMs: 30_000, onEvent: (e) => events.push(e) });
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'limit');
  assert.equal(r.limit?.provider, 'claude');
  assert.equal(r.limit?.resetsAt, 1792587600 * 1000);
  assert.equal(r.limit?.kind, 'seven_day');
  assert.equal(r.quota?.utilization7d, 1);
  assert.equal(r.quota?.status, 'rejected');
  assert.ok(events.some((e) => e.kind === 'system') && events.some((e) => e.kind === 'result'));
});

test('Claude isolation violation (planted Bash tool + MCP server in init) aborts with errorKind=isolation', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'cond-iso-'));
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ claude: { '*': { plan: [{ badInit: true }] } } }));
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-claude.mjs');
  const events: EmitEvent[] = [];
  const r = await runClaude({ bin, cwd: process.cwd(), prompt: '# Stage: PLAN\nIssue key: T-1\nTitle: x', stage: 'plan', name: 'n', schema: { type: 'object' }, maxTurns: 3, isolation: 'safe-mode', env: { ...claudeEnv(), FAKE_DIR: dir }, idleMs: 20_000, hardMs: 30_000, onEvent: (e) => events.push(e) });
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'isolation');
  assert.match(r.error ?? '', /Isolation check failed/);
  assert.ok(events.some((e) => e.kind === 'error'));
});

test('Claude normaliser: tool_use / tool_result / text / thinking / result', () => {
  const ctx = { stage: 'verify' as const };
  const a = normalizeClaudeEvent({ type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }, { type: 'thinking', thinking: 'hmm' }] } }, ctx);
  assert.deepEqual(a.map((e) => e.kind), ['text', 'tool', 'thinking']);
  assert.equal(a[1]!.text, 'Read a.ts');
  const u = normalizeClaudeEvent({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'ok!' }], is_error: false }] } }, ctx);
  assert.equal(u[0]!.kind, 'tool_result');
  assert.equal(u[0]!.ok, true);
  assert.equal(normalizeClaudeEvent({ type: 'result', is_error: true, result: 'boom' }, ctx)[0]!.ok, false);
  assert.deepEqual(normalizeClaudeEvent({ type: 'weird' }, ctx), []);
  const secret = normalizeClaudeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'key lin_api_ABCDEFGHIJKLMNOPQRSTUVWX end' }] } }, { stage: 'plan' });
  assert.ok(!secret[0]!.text!.includes('lin_api_ABCDEF'), 'token redacted in the live log');
});

test('REAL Cursor build capture: thinking is coalesced, tools summarised, edits/shell outcomes parsed, result usage ok', async () => {
  const st = { thinking: '' };
  const evs = lines('cursor-build-2026.10.19.ndjson').flatMap((o) => normalizeCursorEvent(o, { stage: 'build' }, st));
  const kinds = evs.map((e) => e.kind);
  assert.ok(kinds.filter((k) => k === 'thinking').length <= 6, 'thinking deltas coalesced');
  assert.ok(evs.some((e) => e.kind === 'tool' && e.tool === 'edit' && e.text!.startsWith('edit ')));
  assert.ok(evs.some((e) => e.kind === 'tool' && e.tool === 'shell' && /node -e/.test(e.text!)));
  const sh = evs.find((e) => e.kind === 'tool_result' && e.tool === 'shell');
  assert.equal(sh?.ok, true);
  assert.match(sh!.text!, /exit 0/);
  const ed = evs.find((e) => e.kind === 'tool_result' && e.tool === 'edit');
  assert.match(ed!.text!, /\+1 −0/);
  assert.equal(evs.at(-1)!.kind, 'result');
  const bin = replayBin(join(REAL, 'cursor-build-2026.10.19.ndjson'), 0);
  const r = await runCursor({ bin, cwd: process.cwd(), prompt: 'x', stage: 'build', name: 'n', mode: 'build', env: cursorEnv(), idleMs: 20_000, hardMs: 30_000, onEvent: () => undefined });
  assert.equal(r.ok, true);
  assert.ok(r.sessionId);
  assert.equal(r.model, 'Auto');
});

test('REAL Cursor ask-mode capture: JSON is extracted from prose + fenced block', async () => {
  const bin = replayBin(join(REAL, 'cursor-ask-2026.10.19.ndjson'), 0);
  const r = await runCursor({ bin, cwd: process.cwd(), prompt: 'x', stage: 'plan', name: 'n', mode: 'ask', schema: { type: 'object' }, env: cursorEnv(), idleMs: 20_000, hardMs: 30_000, onEvent: () => undefined });
  assert.equal(r.ok, true);
  assert.deepEqual(r.json, { exports: ['add', 'sub'], risk: 'low' });
});

test('Cursor usage-limit and failure classification', async () => {
  const mk = (result: string, code: number) => {
    const f = join(process.cwd(), 'fixtures', 'fake-agent.mjs');
    void f;
    return replayBin(join(REAL, 'cursor-ask-2026.10.19.ndjson'), code);
  };
  void mk;
  // limit text in a failed result
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'cond-lim-'));
  const lim = join(dir, 'lim.ndjson');
  writeFileSync(lim, JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: "You've hit your usage limit. Upgrade to continue.", session_id: 's' }) + '\n');
  const r = await runCursor({ bin: replayBin(lim, 1), cwd: process.cwd(), prompt: 'x', stage: 'build', name: 'n', mode: 'build', env: cursorEnv(), idleMs: 20_000, hardMs: 30_000, onEvent: () => undefined });
  assert.equal(r.errorKind, 'limit');
  const other = join(dir, 'err.ndjson');
  writeFileSync(other, JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'tool crashed', session_id: 's' }) + '\n');
  const r2 = await runCursor({ bin: replayBin(other, 1), cwd: process.cwd(), prompt: 'x', stage: 'build', name: 'n', mode: 'build', env: cursorEnv(), idleMs: 20_000, hardMs: 30_000, onEvent: () => undefined });
  assert.equal(r2.errorKind, 'agent');
});

test('extractJson: whole, fenced, last-fence-wins, prose around, nested/escaped braces, garbage', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Using SoftCo Lead.\n```json\n{"x":[1,2]}\n```\nbye'), { x: [1, 2] });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```\n```json\n{"b":2}\n```'), { b: 2 });
  assert.deepEqual(extractJson('noise {x} more {"k":{"s":"}{"}} tail'), { k: { s: '}{' } });
  assert.equal(extractJson('nothing here'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson('[1,2,3]'), null, 'top-level arrays are not accepted as results');
});

test('validateSchema: plan and verdict schemas accept good data and name the exact problem otherwise', () => {
  const plan = { summary: 's', blocked: { is: false, questions: [] }, assumptions: [], currentState: 'c', expectedState: 'e', acceptanceCriteria: [{ id: 'AC1', text: 't', verification: 'v' }], filesToChange: [], steps: [], testing: { commands: [], cases: [] }, risks: [], coverage: [], complexity: 'S' };
  assert.deepEqual(validateSchema(PLAN_SCHEMA, plan), []);
  const bad: any = structuredClone(plan);
  delete bad.summary;
  bad.complexity = 'XL';
  bad.acceptanceCriteria = [];
  const errs = validateSchema(PLAN_SCHEMA, bad);
  assert.ok(errs.some((e) => e.includes('summary')) && errs.some((e) => e.includes('complexity')) && errs.some((e) => e.includes('at least 1')), errs.join(' | '));
  assert.deepEqual(validateSchema(VERDICT_SCHEMA, { verdict: 'pass', summary: 's', acceptance: [], bugs: [] }), []);
  assert.ok(validateSchema(VERDICT_SCHEMA, { verdict: 'maybe', summary: 's', acceptance: [], bugs: [{ title: 't' }] }).length >= 2);
  assert.match(describeSchema(PLAN_SCHEMA), /acceptanceCriteria/);
});

// ───────────── process runner ─────────────
const node = process.execPath;
test('runProcess: stdin in, lines out, tails kept, exit code reported', async () => {
  const seen: string[] = [];
  const r = await runProcess({ bin: node, args: ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log("got:"+s);console.error("warn")})'], cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' }, stdin: 'hello', idleMs: 5000, hardMs: 10_000, onLine: (l, s) => seen.push(`${s}:${l}`) });
  assert.equal(r.code, 0);
  assert.ok(seen.includes('stdout:got:hello') && seen.includes('stderr:warn'));
  assert.match(r.stdoutTail, /got:hello/);
});
test('runProcess: idle timeout kills a silent process', async () => {
  const t0 = Date.now();
  const r = await runProcess({ bin: node, args: ['-e', 'setTimeout(()=>{},60000)'], cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' }, idleMs: 700, hardMs: 30_000, tickMs: 100, graceMs: 300 });
  assert.equal(r.timedOut, 'idle');
  assert.ok(Date.now() - t0 < 8000);
});
test('runProcess: hard timeout kills a chatty process', async () => {
  const r = await runProcess({ bin: node, args: ['-e', 'setInterval(()=>console.log("x"),50)'], cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' }, idleMs: 10_000, hardMs: 800, tickMs: 100, graceMs: 300 });
  assert.equal(r.timedOut, 'hard');
});
test('runProcess: abort kills the whole process group (grandchildren too)', async () => {
  const { mkdtempSync, existsSync, readFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'cond-grp-'));
  const pidFile = join(dir, 'pid');
  writeFileSync(join(dir, 'child.cjs'), `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`);
  writeFileSync(join(dir, 'parent.cjs'), `require('child_process').spawn(process.execPath, [${JSON.stringify(join(dir, 'child.cjs'))}], { stdio: 'ignore' }); setTimeout(() => {}, 60000);`);
  const ac = new AbortController();
  const p = runProcess({ bin: node, args: [join(dir, 'parent.cjs')], cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' }, idleMs: 30_000, hardMs: 60_000, signal: ac.signal, tickMs: 100, graceMs: 300 });
  for (let i = 0; i < 80 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
  const gpid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(gpid > 0);
  assert.doesNotThrow(() => process.kill(gpid, 0), 'grandchild is alive before the abort');
  ac.abort();
  const r = await p;
  assert.equal(r.aborted, true);
  await new Promise((r2) => setTimeout(r2, 800));
  assert.throws(() => process.kill(gpid, 0), /ESRCH/, 'grandchild is gone after the abort');
});
test('runProcess: a machine sleep (clock jump) is not mistaken for an idle hang', async () => {
  let t = 1_000_000;
  const clock = { now: () => t };
  const p = runProcess({ bin: node, args: ['-e', 'setTimeout(()=>console.log("done"),900)'], cwd: process.cwd(), env: { PATH: process.env.PATH ?? '' }, idleMs: 5_000, hardMs: 600_000, tickMs: 100, clock });
  setTimeout(() => (t += 3_600_000), 300); // "laptop slept for an hour"
  const r = await p;
  assert.equal(r.timedOut, null);
  assert.match(r.stdoutTail, /done/);
});
test('runProcess: unknown binary reports spawnError, never throws', async () => {
  const r = await runProcess({ bin: '/definitely/not/here', args: [], cwd: process.cwd(), env: {}, idleMs: 1000, hardMs: 2000 });
  assert.ok(r.spawnError);
});

// ───────────── environment allowlists ─────────────
const hostile = { PATH: '/usr/bin', HOME: '/h', LINEAR_API_KEY: 'lin_api_x', CURSOR_API_KEY: 'crsr_y', ANTHROPIC_API_KEY: 'sk-ant-z', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787', GITHUB_TOKEN: 'ghp_1', GH_TOKEN: 'ghp_2', AWS_SECRET_ACCESS_KEY: 'aws', OPENAI_API_KEY: 'sk-1', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDECODE: '1', SSH_AUTH_SOCK: '/sock', NPM_TOKEN: 'npm', MY_SECRET: 's' } as NodeJS.ProcessEnv;
test('env allowlists: each child only gets the credentials of its own provider', () => {
  const c = claudeEnv({}, hostile);
  assert.ok(c.ANTHROPIC_API_KEY && c.ANTHROPIC_BASE_URL && c.CLAUDE_CODE_OAUTH_TOKEN);
  for (const k of ['LINEAR_API_KEY', 'CURSOR_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'SSH_AUTH_SOCK', 'NPM_TOKEN', 'MY_SECRET', 'CLAUDECODE']) assert.ok(!(k in c), `claude env must not contain ${k}`);
  assert.equal(c.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  const k = cursorEnv({}, hostile);
  assert.ok(k.CURSOR_API_KEY);
  for (const n of ['LINEAR_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'SSH_AUTH_SOCK', 'MY_SECRET']) assert.ok(!(n in k), `cursor env must not contain ${n}`);
  const t = toolEnv(['NPM_TOKEN'], hostile);
  assert.equal(t.NPM_TOKEN, 'npm');
  for (const n of ['LINEAR_API_KEY', 'CURSOR_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN']) assert.ok(!(n in t), `tool env must not contain ${n}`);
  assert.equal(t.CI, '1');
  assert.ok(c.PATH.includes('/usr/bin') && c.PATH.includes('.local/bin'), 'PATH keeps the user dirs and adds the usual CLI locations');
});
