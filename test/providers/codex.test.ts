// M2 commit 3: the Codex adapter (read-only) against a scripted fake binary. NOT evidence about the real CLI — see fixtures/fake-codex.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexArgs, classifyCodexFailure, codexAuth, detectCodex, newCodexFold, normalizeCodexEvent, runCodexReadOnly, versionAtLeast, CODEX_MIN_VERSION } from '../../src/agents/providers/codex.ts';
import { CODEX_CONFIG_TOML, codexHomePath, prepareCodexHome } from '../../src/agents/providers/codex-home.ts';
import { capabilitiesOf, createProviders } from '../../src/agents/providers/registry.ts';
import { readOnlyTier } from '../../src/agents/providers/verification.ts';
import { buildEligibility } from '../../src/pipeline/envelope.ts';
import { normalizeConfig, defaultConfig } from '../../src/config.ts';
import { diffScopeViolations, scanAncestors } from '../../src/git/worktree.ts';
import { sha256 } from '../../src/util.ts';
import { makeHarness, TestClock } from '../helpers/harness.ts';
import { comments } from '../helpers/util.ts';

const FAKE = join(import.meta.dirname, '..', '..', 'fixtures', 'fake-codex.mjs');
chmodSync(FAKE, 0o755);

function fakeDir(scenario: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'cond-fcodex-'));
  writeFileSync(join(d, 'codex.json'), JSON.stringify(scenario));
  return d;
}
const calls = (d: string): any[] => (existsSync(join(d, 'codex-calls.jsonl')) ? readFileSync(join(d, 'codex-calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const execCalls = (d: string) => calls(d).filter((c) => c.cmd === 'exec');
const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } } } as any;
const events: any[] = [];
async function run(d: string, over: Partial<Parameters<typeof runCodexReadOnly>[0]> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'cond-fcodex-cwd-'));
  const evs: any[] = [];
  const res = await runCodexReadOnly({ bin: FAKE, cwd, prompt: '# Stage: PLAN\nIssue key: ENG-1\nTitle: demo\nPlease plan this.', stage: 'plan', schema: SCHEMA, extraEnv: { FAKE_DIR: d }, idleMs: 20_000, hardMs: 30_000, onEvent: (e) => evs.push(e), ...over });
  events.length = 0;
  events.push(...evs);
  return { res, cwd, evs };
}

test('argv: constants plus one validated model name — the exact pinned list, prompt NOT in argv, none of the dangerous flags', () => {
  const a = buildCodexArgs({ model: 'gpt-5.1-codex', schemaFile: '/t/schema.json', outFile: '/t/out.txt' });
  assert.deepEqual(a, [
    'exec', '--json', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', '--ephemeral',
    '-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'shell_environment_policy.inherit="core"', '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', 'shell_environment_policy.exclude=["CODEX_*","*KEY*","*TOKEN*","*SECRET*","*PASSWORD*"]',
    '--model=gpt-5.1-codex', '--output-schema', '/t/schema.json', '-o', '/t/out.txt', '-',
  ]);
  const joined = buildCodexArgs({ outFile: '/o' }).join(' ');
  for (const bad of ['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto', '--approve-for-me', '--add-dir', '--search', '--profile', ' -p ', 'danger-full-access', 'workspace-write', '--skip-git-repo-check', '--config']) {
    assert.ok(!joined.includes(bad), `argv must not contain ${bad}`);
  }
  assert.ok(buildCodexArgs({ outFile: '/o' }).filter((x) => x === '-c').length === 5, 'every -c is one of our constants');
  // the model is the ONLY free-form value: anything unusual is ignored, not passed
  for (const m of ['--yolo', 'a b', 'x;rm -rf /', '-x', '', '../../etc', 'a'.repeat(65), 'm\nn', '$(id)']) {
    assert.ok(!buildCodexArgs({ model: m, outFile: '/o' }).some((x) => x.startsWith('--model')), JSON.stringify(m));
  }
  assert.equal(normalizeConfig({ agents: { codex: { model: 'good-model:1' } } }).agents.codex.model, 'good-model:1');
  assert.equal(normalizeConfig({ agents: { codex: { model: '--yolo' } } }).agents.codex.model, undefined);
});

test('a run: prompt on STDIN, private CODEX_HOME + scratch HOME, minimal env, temp files in a 0700 dir outside the worktree, everything cleaned up', async () => {
  const userCodexHome = mkdtempSync(join(tmpdir(), 'cond-usercodex-'));
  writeFileSync(join(userCodexHome, 'auth.json'), '{"tokens":"USER-SECRET"}');
  writeFileSync(join(userCodexHome, 'hooks.json'), '{"hooks":"user"}');
  const before = statSync(join(userCodexHome, 'auth.json')).mtimeMs;
  process.env.CODEX_HOME = userCodexHome;
  process.env.OPENAI_API_KEY = 'sk-should-never-reach-the-child-1234567890';
  process.env.CODEX_API_KEY = 'also-never-in-m2';
  process.env.ANTHROPIC_API_KEY = 'nor-this-one-1234567890';
  try {
    const d = fakeDir({ exec: [{ mode: 'ok' }] });
    const { res, cwd } = await run(d);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(res.json, JSON.parse(JSON.stringify(res.json)));
    const c = execCalls(d)[0];
    assert.ok(c.promptBytes > 40, 'the prompt arrived on stdin');
    assert.ok(!c.argv.join(' ').includes('Please plan this'), 'and is not in argv');
    assert.equal(c.CODEX_HOME, codexHomePath(), 'Conductor\'s private home, not the user\'s');
    assert.notEqual(c.CODEX_HOME, userCodexHome);
    assert.ok(c.HOME.includes(join('providers', 'tmp', 'home-')), `scratch HOME, got ${c.HOME}`);
    assert.equal(existsSync(c.HOME), false, 'the scratch HOME is removed after the run');
    for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY']) assert.ok(!c.envKeys.includes(k), `${k} must not reach the child`);
    assert.ok(!c.envKeys.some((k: string) => /^(OPENAI|LINEAR|CURSOR|GITHUB|AWS|GH_)/.test(k)));
    assert.ok(c.schemaBytes > 0, 'the schema file existed during the run');
    assert.ok(c.outFile.startsWith(join(tmpdir(), 'conductor-codex-')) && !c.outFile.startsWith(cwd), 'temp files live outside the worktree');
    assert.equal(existsSync(c.outFile), false, 'and are deleted afterwards');
    assert.equal(c.cwd, cwd.startsWith('/private') ? c.cwd : cwd.replace(/^\/var\//, '/private/var/'), 'cwd is the target dir');
  } finally {
    delete process.env.CODEX_HOME;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  }
  assert.equal(statSync(join(userCodexHome, 'auth.json')).mtimeMs, before, 'the user\'s own login file was never touched');
  assert.deepEqual(readdirSync(codexHomePath()).sort(), ['config.toml'], 'nothing was copied or linked into the private home (no auth.json, no hooks)');
  assert.equal(readFileSync(join(codexHomePath(), 'config.toml'), 'utf8'), CODEX_CONFIG_TOML);
});

test('events: documented shapes become log events; unknown types and hostile objects are ignored; secrets are redacted', () => {
  const fold = newCodexFold();
  const ctx = { stage: 'plan' as const, secrets: ['hunter2hunter2'] };
  const feed = (o: unknown) => normalizeCodexEvent(o, ctx, fold);
  assert.equal(feed({ type: 'thread.started', thread_id: 't-1' })[0]!.kind, 'system');
  assert.equal(fold.sessionId, 't-1');
  assert.equal(feed({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking about hunter2hunter2' } })[0]!.text, 'thinking about [redacted]');
  assert.equal(feed({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } })[0]!.kind, 'tool');
  assert.equal(feed({ type: 'item.completed', item: { type: 'command_execution', exit_code: 1 } })[0]!.ok, false);
  assert.equal(feed({ type: 'item.completed', item: { type: 'agent_message', text: 'final answer' } })[0]!.kind, 'text');
  assert.equal(fold.finalText, 'final answer');
  assert.equal(feed({ type: 'item.completed', item: { type: 'file_change', status: 'completed' } })[0]!.tool, 'file_change');
  assert.equal(feed({ type: 'item.started', item: { type: 'web_search', query: 'q' } })[0]!.tool, 'web_search');
  assert.deepEqual(feed({ type: 'future.thing' }), []);
  assert.deepEqual(feed({ type: 'item.completed', item: { type: 'mystery' } }), []);
  for (const bad of [null, undefined, 5, 'x', [], JSON.parse('{"__proto__":{"type":"error"},"type":7}'), { type: { toString: 1 } }]) assert.doesNotThrow(() => feed(bad));
  assert.equal(fold.completed, false);
  feed({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } });
  assert.equal(fold.completed, true);
  assert.deepEqual(fold.usage, { input: 10, cached: 2, output: 3 });
  feed({ type: 'turn.failed', error: { message: 'x'.repeat(2000) } });
  assert.equal(fold.errors[0]!.length <= 500, true, 'structured error messages are capped at 500 characters');
});

test('classification: limit/auth ONLY after a structural failure, from structured errors then stderr — never from model prose', async () => {
  const run1 = async (step: unknown) => {
    const d = fakeDir({ exec: [step] });
    return (await run(d)).res;
  };
  const limit = await run1({ mode: 'limit' });
  assert.equal(limit.errorKind, 'limit');
  assert.equal(limit.limit?.provider, 'codex');
  assert.match(limit.error!, /usage limit/);
  assert.equal((await run1({ mode: 'stderr-limit' })).errorKind, 'limit');
  assert.equal((await run1({ mode: 'auth' })).errorKind, 'auth');
  const forged = await run1({ mode: 'forged-error' });
  assert.equal(forged.errorKind, 'agent', 'a limit phrase hidden after 500 characters of a long error is not trusted');
  assert.equal((await run1({ mode: 'crash' })).errorKind, 'agent');
  // prose: the model SAYS it hit a usage limit, but the turn completed with exit 0 ⇒ a success, never a limit
  const prose = await run1({ mode: 'ok', text: JSON.stringify({ ok: true, note: "I've hit my usage limit and got a 401 unauthorized" }) });
  assert.equal(prose.ok, true);
  assert.equal(prose.errorKind, undefined);
  assert.equal((await run1({ mode: 'ok', text: 'plain words, no json at all' })).errorKind, 'parse');
  assert.equal((await run1({ mode: 'no-completed' })).ok, true, 'a quiet exit 0 with a valid reply is not a failure');
  assert.equal((await run1({ mode: 'unknown-events' })).ok, true, 'unknown event types are ignored');
  // the pure function agrees
  const f = newCodexFold();
  f.completed = true;
  f.errors.push('usage limit');
  assert.equal(classifyCodexFailure(f, 0, 'usage limit'), null, 'turn.completed + exit 0 ⇒ never a failure');
  assert.equal(classifyCodexFailure(newCodexFold(), 0, 'usage limit in stderr but exit 0'), null);
});

test('hygiene pre-flight: anything planted in the private home refuses the run (errorKind isolation, ZERO spawns); config.toml is rewritten; permissions tightened', async () => {
  const home = codexHomePath();
  assert.equal(prepareCodexHome(home).ok, true);
  for (const planted of ['hooks.json', 'hooks', 'rules', 'skills', 'prompts', 'plugins', 'memories', 'AGENTS.md', 'agents.override.md', 'mcp.json', '.codex', 'evil']) {
    writeFileSync(join(home, planted), 'x');
    const d = fakeDir({ exec: [{ mode: 'ok' }] });
    const { res } = await run(d);
    assert.equal(res.errorKind, 'isolation', planted);
    assert.match(res.error!, new RegExp(`entries Conductor did not put there.*${planted.replace('.', '\\.')}`), planted);
    assert.equal(execCalls(d).length, 0, `${planted}: Codex never started`);
    rmSync(join(home, planted), { force: true });
  }
  // a symlink inside the home (even to an allowed name)
  symlinkSync('/tmp', join(home, 'sessions'));
  assert.equal(prepareCodexHome(home).ok, false);
  rmSync(join(home, 'sessions'));
  // tampered config.toml is rewritten, wide permissions tightened, auth.json mode fixed
  writeFileSync(join(home, 'config.toml'), 'model_provider = "evil"\n[mcp_servers.x]\ncommand = "sh"\n');
  writeFileSync(join(home, 'auth.json'), '{"a":1}', { mode: 0o666 });
  chmodSync(home, 0o755);
  chmodSync(join(home, 'auth.json'), 0o666);
  assert.equal(prepareCodexHome(home).ok, true);
  assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), CODEX_CONFIG_TOML);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, 'auth.json')).mode & 0o777, 0o600);
  // the home itself being a symlink is refused
  const link = join(mkdtempSync(join(tmpdir(), 'cond-hlink-')), 'codex-home');
  symlinkSync(home, link);
  assert.equal(prepareCodexHome(link).ok, false);
  rmSync(join(home, 'auth.json'), { force: true });
});

test('runs against the private home are SERIALISED: two concurrent runs never overlap', async () => {
  const d = fakeDir({ exec: [{ mode: 'ok', delayMs: 250 }, { mode: 'ok', delayMs: 250 }, { mode: 'ok', delayMs: 250 }] });
  const rs = await Promise.all([run(d), run(d), run(d)]);
  assert.ok(rs.every((r) => r.res.ok), JSON.stringify(rs.map((r) => r.res.error)));
  assert.equal(calls(d).filter((c) => c.cmd === 'overlap').length, 0, 'no two Codex processes shared the home at once');
  assert.equal(execCalls(d).length, 3);
});

test('detect / auth: missing, broken-install (the shim-without-binary case on this machine), too old, ok; login status maps by exit code', async () => {
  const d = fakeDir({ version: 'ok', login: 'ok' });
  const env = { FAKE_DIR: d };
  const ok = await detectCodex(FAKE, env);
  assert.deepEqual(ok, { state: 'ok', version: '0.128.0', belowMinimum: false });
  assert.equal((await detectCodex('definitely-not-installed-codex-xyz', env)).state, 'missing');
  writeFileSync(join(d, 'codex.json'), JSON.stringify({ version: 'broken' }));
  const broken = await detectCodex(FAKE, env);
  assert.equal(broken.state, 'broken-install');
  assert.match((broken as any).detail, /ENOENT/);
  writeFileSync(join(d, 'codex.json'), JSON.stringify({ version: 'old' }));
  assert.deepEqual(await detectCodex(FAKE, env), { state: 'ok', version: '0.100.0', belowMinimum: true });
  assert.equal(versionAtLeast('codex-cli 0.128.0', CODEX_MIN_VERSION), true);
  assert.equal(versionAtLeast('0.127.9', CODEX_MIN_VERSION), false);
  assert.equal(versionAtLeast('1.0.0', CODEX_MIN_VERSION), true);
  assert.equal(versionAtLeast('garbage', CODEX_MIN_VERSION), false);
  writeFileSync(join(d, 'codex.json'), JSON.stringify({ login: 'ok' }));
  assert.equal(await codexAuth(FAKE, env), 'ok');
  writeFileSync(join(d, 'codex.json'), JSON.stringify({ login: 'out' }));
  assert.equal(await codexAuth(FAKE, env), 'not-logged-in');
  assert.equal(await codexAuth('definitely-not-installed-codex-xyz', env), 'unknown');
  // login status never runs against the user's real home: it saw the private one
  const c = calls(d).filter((x) => x.cmd === 'login-status').pop();
  assert.equal(c.CODEX_HOME, codexHomePath());
});

test('registry: Codex has NO build capability by construction, is read-only capable, unverified, and is never an eligible builder', () => {
  const reg = createProviders({ getConfig: () => defaultConfig(), clock: { now: () => 0 } as any, extraEnv: {} });
  assert.equal(reg.codex.build, undefined);
  assert.equal(reg.codex.label, 'Codex');
  assert.deepEqual(capabilitiesOf(reg.codex), { readOnly: true, build: false, buildIsolationVerified: false });
  assert.equal(readOnlyTier('codex'), 'unverified');
  const e = buildEligibility(reg.codex);
  assert.equal(e.ok, false);
  assert.match(e.ok ? '' : e.why, /no build capability/);
  assert.ok(!JSON.stringify(defaultConfig().roles).includes('codex'), 'Codex is in no default chain (D8)');
});

test('protected paths: .codex, .agents and agents.override.md are protected (and found above a worktree)', async () => {
  for (const f of ['.codex/config.toml', '.codex/hooks.json', 'sub/.codex/rules/x.rules', '.agents/skills/x/SKILL.md', 'agents.override.md', 'pkg/agents.override.md']) {
    assert.deepEqual(diffScopeViolations([f], []), [f], `${f} must be protected`);
  }
  const root = mkdtempSync(join(tmpdir(), 'cond-anc-'));
  mkdirSync(join(root, '.codex'));
  mkdirSync(join(root, '.agents'));
  writeFileSync(join(root, 'agents.override.md'), 'x');
  mkdirSync(join(root, 'wt', 'repo'), { recursive: true });
  const real = realpathSync(root);
  const found = (await scanAncestors(join(root, 'wt', 'repo', 'x'))).filter((p) => p.startsWith(real + '/')).map((p) => p.slice(real.length + 1)).sort();
  assert.deepEqual(found, ['.agents', '.codex', 'agents.override.md']);
});

// ───────────── engine integration ─────────────
test('engine: a read-only role assigned to Codex runs Codex (fake binary), shows as Codex everywhere, and a Codex limit pauses CODEX with Codex wording', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock, config: (c) => { c.agents.codex.bin = FAKE; c.roles.review = { providers: ['codex'] }; c.pipeline.planReview = 'always'; } });
  try {
    writeFileSync(join(h.fakeDir, 'codex.json'), JSON.stringify({ exec: [{ mode: 'limit' }, { mode: 'ok' }] }));
    const key = h.issue('Review by Codex');
    await h.settle();
    assert.equal(h.run(key).status, 'paused', 'a Codex limit pauses the card (no other provider is configured for review)');
    assert.ok(h.engine.status().providerPause.codex, 'the pause is on Codex, not on Claude or Cursor');
    assert.ok((await comments(h, key)).some((t) => /Paused — Codex usage limit reached/.test(t)), 'the comment says Codex');
    assert.ok(h.notes.some((n) => /Usage limit reached/.test(n.title) && /codex/i.test(n.message)));
    assert.ok(h.run(key).history.some((x) => /Paused: codex usage limit/.test(x.text)));
    clock.advance(20 * 60_000);
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
    const rev = h.run(key).sessions.find((s) => s.stage === 'plan_review');
    assert.equal(rev?.agent, 'codex');
    assert.ok(execCalls(h.fakeDir).length >= 2);
  } finally {
    await h.cleanup();
  }
});

test('engine: a BROKEN Codex install (this machine) is skipped by the router with a visible note — the next provider in the chain does the stage', async () => {
  const h = await makeHarness({ config: (c) => { c.agents.codex.bin = FAKE; c.roles.review = { providers: ['codex', 'claude'] }; c.pipeline.planReview = 'always'; } });
  try {
    h.engine.setHealthSource(() => ({ codex: { found: false, ok: false } }));
    const key = h.issue('Codex is broken');
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
    assert.equal(execCalls(h.fakeDir).length, 0, 'the broken provider was never started');
    const rev = h.run(key).sessions.find((s) => s.stage === 'plan_review');
    assert.equal(rev?.agent, 'claude');
    const notes = h.store.readEvents(key, 0, 500).events.filter((e) => e.kind === 'note').map((e) => e.text ?? '');
    assert.ok(notes.some((t) => /Codex is not installed or does not start — Claude is doing this read-only step/.test(t)), notes.join(' | '));
  } finally {
    await h.cleanup();
  }
});
