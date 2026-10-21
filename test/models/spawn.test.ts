// AC6: spawn isolation — exact Claude discovery argv (B5a), env per tool (S15), S1 tripwire, S4 overflow (both shapes) with no partial
// catalog (R2-5), the discovery folder rules (R2-2: planted .mcp.json / symlink, cleaned after reaping), serialised spawns never overlap,
// the 15 s timeout, and zero prompts recorded by the fakes. Spawns are inspected through the injected `spawn` dep (R2-N2).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_DISCOVERY_ARGS, CLAUDE_INIT_LINE, CLAUDE_REASONS, discoverClaude, DISCOVERY_MAX_BYTES } from '../../src/models/claude.ts';
import { CURSOR_DISCOVERY_ARGS } from '../../src/models/cursor.ts';
import { DISCOVERY_TIMEOUT_MS } from '../../src/models/service.ts';
import { cacheFile } from '../../src/models/cache.ts';
import { WORKDIR_REASON } from '../../src/models/workdir.ts';
import { paths } from '../../src/paths.ts';
import { REAL, buildService, modelHome, readJson, stubSpawn } from './helpers.ts';

const h = modelHome();
after(() => h.cleanup());
const noCache = () => !existsSync(cacheFile('claude', 'default'));
const clearCache = () => rmSync(paths.models(), { recursive: true, force: true });

test('B5a: the Claude discovery argv is exactly the constant list; stdin is the one initialize line; no prompt, no --model', async () => {
  assert.deepEqual([...CLAUDE_DISCOVERY_ARGS], ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']);
  assert.equal(CLAUDE_INIT_LINE, '{"type":"control_request","request_id":"r1","request":{"subtype":"initialize"}}\n');
  assert.deepEqual([...CURSOR_DISCOVERY_ARGS], ['--list-models']);
  h.scenario({ models: 'in', listModels: 'ok', lingerMs: 30_000 });
  const { svc, spawns } = buildService(h);
  await svc.refresh('claude');
  await svc.refresh('cursor');
  assert.equal(spawns.length, 2);
  const [c, k] = spawns;
  assert.deepEqual(c!.opts.args, [...CLAUDE_DISCOVERY_ARGS]);
  assert.equal(c!.opts.stdin, CLAUDE_INIT_LINE);
  assert.ok(!c!.opts.args.includes('--model'));
  assert.deepEqual(k!.opts.args, ['--list-models']);
  assert.equal(k!.opts.stdin, undefined);
  for (const s of spawns) {
    assert.equal(s.opts.maxOutputBytes, DISCOVERY_MAX_BYTES);
    assert.equal(s.opts.cwd, paths.discovery());
  }
  // the fakes record what they actually received: one stdin line, zero prompts, an empty cwd
  const calls = h.calls().filter((x) => x.mode === 'models');
  const cc = calls.find((x) => x.who === 'claude')!;
  assert.equal(cc.stdinLines, 1);
  assert.equal(cc.prompts, 0);
  assert.deepEqual(cc.cwdEntries, []);
  assert.deepEqual(calls.find((x) => x.who === 'cursor')!.cwdEntries, []);
});

test('S1: in the normal case the child is killed right after the reply is parsed (it would linger 30 s)', async () => {
  h.scenario({ models: 'in', lingerMs: 30_000 });
  clearCache();
  const { svc, spawns } = buildService(h);
  const v = await svc.refresh('claude');
  assert.equal(v.state, 'fresh');
  assert.equal(spawns[0]!.result!.aborted, true);
  assert.ok(spawns[0]!.result!.durationMs < 5000, `took ${spawns[0]!.result!.durationMs} ms`);
});

test('S1 tripwire: system/init + assistant ⇒ killed, unavailable, nothing cached, no retry', async () => {
  clearCache();
  h.scenario({ models: 'turn', lingerMs: 30_000 });
  const { svc, spawns } = buildService(h);
  const v = await svc.refresh('claude');
  assert.equal(v.state, 'unavailable');
  assert.equal(v.reason, CLAUDE_REASONS.turn);
  assert.ok(noCache());
  assert.ok(spawns[0]!.result!.durationMs < 5000);
  assert.equal(svc.noteVersion('claude', '2.1.304'), null, 'no automatic retry inside the back-off');
  assert.equal(spawns.length, 1);
});

for (const mode of ['flood', 'manylines', 'longline'] as const) {
  test(`S4: "${mode}" ⇒ unavailable "the reply was too large", killed, no partial catalog`, async () => {
    clearCache();
    h.scenario({ models: mode, lingerMs: 30_000 });
    const { svc, spawns } = buildService(h);
    const v = await svc.refresh('claude');
    assert.equal(v.state, 'unavailable');
    assert.equal(v.reason, CLAUDE_REASONS.tooLarge);
    assert.ok(noCache());
    assert.ok(spawns[0]!.result!.durationMs < 10_000);
  });
}

test('S4 Cursor: a 5 MB flood with no newline ⇒ unavailable too large', async () => {
  h.scenario({ listModels: 'flood' });
  const { svc } = buildService(h);
  const v = await svc.refresh('cursor');
  assert.equal(v.reason?.endsWith('the reply was too large'), true, v.reason);
});

test('R2-5: a valid reply that arrived before the overflow is discarded', async () => {
  const fx = readJson(join(REAL, 'claude-initialize-2.1.304.json'));
  const line = JSON.stringify({ type: 'control_response', response: { ...fx.response, request_id: 'r1' } });
  const r = await discoverClaude({ bin: 'x', cwd: '/', env: {}, timeoutMs: 1000, signal: new AbortController().signal, spawn: stubSpawn([{ line }], { overflow: true }) });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.kind, 'too-large');
  const ok = await discoverClaude({ bin: 'x', cwd: '/', env: {}, timeoutMs: 1000, signal: new AbortController().signal, spawn: stubSpawn([{ line }]) });
  assert.equal(ok.ok, true);
});

test('S15: env per tool — Claude gets no Cursor/Linear/OpenAI/Codex keys; Cursor gets no Anthropic/Claude/Linear/OpenAI/Codex keys', async () => {
  const decoys = { CURSOR_API_KEY: 'crsr_decoy', LINEAR_API_KEY: 'lin_decoy', OPENAI_API_KEY: 'sk-decoy', CODEX_HOME: '/tmp/x', ANTHROPIC_API_KEY: 'sk-ant-decoy', CLAUDE_CODE_OAUTH_TOKEN: 'tok', SOME_RANDOM_SECRET: 'x' };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(decoys)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    h.scenario({ models: 'in', listModels: 'ok', lingerMs: 30_000 });
    const { svc, spawns } = buildService(h);
    await svc.refresh('claude');
    await svc.refresh('cursor');
    const BASE = ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'SHELL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'PATH', 'GIT_TERMINAL_PROMPT', 'FAKE_DIR'];
    const CLAUDE = [...BASE, 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'DISABLE_AUTOUPDATER'];
    const CURSOR = [...BASE, 'CURSOR_API_KEY', 'CURSOR_API_ENDPOINT'];
    const ce = Object.keys(spawns[0]!.opts.env);
    const ke = Object.keys(spawns[1]!.opts.env);
    for (const k of ce) assert.ok(CLAUDE.includes(k) || k.startsWith('ANTHROPIC_'), `claude env has ${k}`);
    for (const k of ke) assert.ok(CURSOR.includes(k), `cursor env has ${k}`);
    assert.ok(!ce.some((k) => /^(CURSOR_|LINEAR_|OPENAI_|CODEX_)/.test(k)));
    assert.ok(!ke.some((k) => /^(ANTHROPIC_|CLAUDE_|LINEAR_|OPENAI_|CODEX_)/.test(k)));
    assert.ok(ce.includes('ANTHROPIC_API_KEY'), 'ANTHROPIC_* passthrough is accepted (S15)');
    assert.ok(ke.includes('CURSOR_API_KEY'));
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});

test('R2-2: a planted .mcp.json and a planted symlink are removed before the spawn (never read); the link target survives', async () => {
  const dir = paths.discovery();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { evil: { command: 'touch', args: [join(h.root, 'MARKER')] } } }));
  const target = join(h.root, 'outside.txt');
  writeFileSync(target, 'keep me');
  symlinkSync(target, join(dir, 'link'));
  mkdirSync(join(dir, 'sub', 'deeper'), { recursive: true });
  h.scenario({ models: 'in', lingerMs: 30_000 });
  const before = h.calls().length;
  const { svc } = buildService(h);
  await svc.refresh('claude');
  const call = h.calls().slice(before).find((c) => c.who === 'claude')!;
  assert.deepEqual(call.cwdEntries, [], 'the child saw an empty folder');
  assert.equal(readFileSync(target, 'utf8'), 'keep me');
  assert.equal(existsSync(join(h.root, 'MARKER')), false);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('R2-2: the folder is cleaned again after the child is reaped; only the leftover COUNT is logged', async () => {
  clearCache();
  h.scenario({ models: 'plant', lingerMs: 30_000 });
  const { svc, logs } = buildService(h);
  await svc.refresh('claude');
  assert.deepEqual(readdirSync(paths.discovery()), []);
  const line = logs.find((l) => l.includes('models refresh provider=claude'))!;
  assert.match(line, /leftover=1/);
  assert.ok(!line.includes('left-behind'));
});

test('R2-2: a discovery folder that is a symlink (or a file) is refused and nothing is spawned; a loose mode is tightened', async () => {
  const dir = paths.discovery();
  rmSync(dir, { recursive: true, force: true });
  const elsewhere = join(h.root, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  symlinkSync(elsewhere, dir);
  clearCache();
  const { svc, spawns } = buildService(h);
  const v = await svc.refresh('claude');
  assert.equal(v.state, 'unavailable');
  assert.equal(v.reason, WORKDIR_REASON);
  assert.equal(spawns.length, 0);
  rmSync(dir);
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  const b = buildService(h);
  await b.svc.refresh('claude');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(b.spawns.length, 1);
});

test('serialised: Claude and Cursor refreshing at once never overlap', async () => {
  h.scenario({ models: 'in', listModels: 'ok', lingerMs: 30_000 });
  const { svc, spawns } = buildService(h);
  await Promise.all([svc.refresh('claude'), svc.refresh('cursor'), svc.refresh('claude'), svc.refresh('cursor')]);
  assert.equal(spawns.length, 2);
  const [a, b] = spawns.sort((x, y) => x.startedAt - y.startedAt);
  assert.ok(a!.endedAt! <= b!.startedAt, `overlap: ${a!.endedAt} > ${b!.startedAt}`);
});

test('15 s timeout: the constant, passed as idle and hard deadline; a hung fake is killed and view() never waits for it', async () => {
  assert.equal(DISCOVERY_TIMEOUT_MS, 15_000);
  const seen: number[] = [];
  const probe = buildService(h, { timeoutMs: undefined, spawnImpl: async (o) => (seen.push(o.idleMs, o.hardMs), stubSpawn([])(o)) });
  await probe.svc.refresh('cursor');
  assert.deepEqual(seen, [15_000, 15_000]);
  clearCache();
  h.scenario({ models: 'hang' });
  const { svc, spawns } = buildService(h, { timeoutMs: 1200, graceMs: 200 });
  const p = svc.refresh('claude');
  const t0 = Date.now();
  const during = svc.view('claude');
  assert.ok(Date.now() - t0 < 50);
  assert.equal(during.state, 'reading');
  const v = await p;
  assert.equal(v.state, 'unavailable');
  assert.equal(v.reason, CLAUDE_REASONS.timeout);
  assert.equal(spawns[0]!.result!.timedOut !== null, true);
});

test('stop(): aborts an in-flight discovery (process-group kill) and refuses new ones', async () => {
  h.scenario({ models: 'hang' });
  const { svc, spawns } = buildService(h, { timeoutMs: 20_000, graceMs: 200 });
  const p = svc.refresh('claude');
  await new Promise((r) => setTimeout(r, 300));
  svc.stop();
  await p;
  assert.equal(spawns[0]!.result!.aborted, true);
  assert.ok(spawns[0]!.result!.durationMs < 5000);
  await svc.refresh('cursor');
  assert.equal(spawns.length, 1);
});
