// The Codex isolation canary: evidence handling against a SIMULATED CLI (fixtures/fake-codex.mjs canary mode). This tests Conductor's logic —
// positive controls, "attempted" rules, fail ⇒ blocked, ambiguity ⇒ inconclusive — NOT how the real Codex behaves (no working binary here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANARY_VERSION, evaluateCanary, runCodexCanary, type CanaryEvidence } from '../../src/agents/providers/canary.ts';
import { newCodexFold } from '../../src/agents/providers/codex.ts';
import { CODEX_CONFIG_TOML } from '../../src/agents/providers/codex-home.ts';
import { sha256 } from '../../src/util.ts';

const FAKE = join(import.meta.dirname, '..', '..', 'fixtures', 'fake-codex.mjs');
chmodSync(FAKE, 0o755);

function dirWith(scenario: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'cond-canary-'));
  writeFileSync(join(d, 'codex.json'), JSON.stringify(scenario));
  return d;
}
const calls = (d: string) => (existsSync(join(d, 'codex-calls.jsonl')) ? readFileSync(join(d, 'codex-calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
/** exec[0] = the positive control, exec[1] = the isolation run */
const canary = async (prod: Record<string, unknown>, ctrl: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => {
  const d = dirWith({ version: 'ok', exec: [{ canary: ctrl }, { canary: prod }], ...top });
  const report = await runCodexCanary({ bin: FAKE, extraEnv: { FAKE_DIR: d } });
  return { report, d };
};
const outcome = (r: Awaited<ReturnType<typeof canary>>['report'], id: string) => r.items.find((i) => i.id === id)?.outcome;

test('a CLI that honours nothing, enforces the sandbox and the env policy, with controls that fire ⇒ PASS, bound to version/binary/argv/config/canary version', async () => {
  const { report, d } = await canary({});
  assert.equal(report.verdict, 'pass', JSON.stringify(report.items.filter((i) => i.outcome !== 'pass' && i.outcome !== 'info')));
  for (const id of ['user-hook', 'user-mcp', 'user-rule', 'project-hook', 'project-mcp', 'project-rule', 'sandbox-write', 'network', 'env-decoy']) assert.equal(outcome(report, id), 'pass', id);
  assert.equal(report.binding!.cliVersion, '0.128.0');
  assert.equal(report.binding!.canaryVersion, CANARY_VERSION);
  assert.equal(report.binding!.privateConfigSha, sha256(CODEX_CONFIG_TOML));
  assert.match(report.binding!.argvDigest, /^[0-9a-f]{64}$/);
  assert.match(report.binding!.binSha256 ?? '', /^[0-9a-f]{64}$/);
  // the isolation run used Conductor's real argv and the private home, not the control's
  const execs = calls(d).filter((c) => c.cmd === 'exec');
  assert.equal(execs.length, 2);
  assert.ok(!execs[0]!.argv.includes('--ignore-user-config'), 'the control deliberately lacks the isolating flags');
  assert.ok(execs[1]!.argv.includes('--ignore-user-config') && execs[1]!.argv.includes('--ignore-rules') && execs[1]!.argv.includes('read-only'));
  assert.ok(!execs[1]!.argv.includes('--skip-git-repo-check'));
  assert.ok(execs[1]!.CODEX_HOME.endsWith(join('providers', 'codex-home')));
});

test('a project-level .codex layer that fires (hook, MCP server OR rule) ⇒ FAIL ⇒ blocked', async () => {
  for (const item of ['project-hook', 'project-mcp', 'project-rule']) {
    const { report } = await canary({ honour: [item] });
    assert.equal(report.verdict, 'blocked', item);
    assert.equal(outcome(report, item), 'fail', item);
  }
});

test('user-like items in the (decoy) HOME that fire ⇒ FAIL ⇒ blocked', async () => {
  for (const item of ['user-hook', 'user-mcp', 'user-rule']) {
    const { report } = await canary({ honour: [item] });
    assert.equal(report.verdict, 'blocked', item);
    assert.equal(outcome(report, item), 'fail', item);
  }
});

test('behaviour failures ⇒ blocked: a write that succeeds, a network call that reaches the listener, a decoy secret visible in the env', async () => {
  const w = await canary({ sandboxWrite: true });
  assert.equal(w.report.verdict, 'blocked');
  assert.equal(outcome(w.report, 'sandbox-write'), 'fail');
  const n = await canary({ networkReaches: true });
  assert.equal(n.report.verdict, 'blocked');
  assert.equal(outcome(n.report, 'network'), 'fail');
  const e = await canary({ leakEnv: true });
  assert.equal(e.report.verdict, 'blocked');
  assert.equal(outcome(e.report, 'env-decoy'), 'fail');
});

test('absence is never a pass: a control that does not fire makes the matching items INCONCLUSIVE; commands the agent never attempted are inconclusive', async () => {
  for (const broken of ['hook', 'mcp', 'rule']) {
    const { report } = await canary({}, { controlBroken: [broken] });
    assert.equal(report.verdict, 'inconclusive', broken);
    const affected = broken === 'hook' ? ['user-hook', 'project-hook'] : broken === 'mcp' ? ['user-mcp', 'project-mcp'] : ['user-rule', 'project-rule'];
    for (const id of affected) assert.equal(outcome(report, id), 'inconclusive', `${broken}: ${id}`);
  }
  for (const [skip, id] of [['write', 'sandbox-write'], ['network', 'network'], ['env', 'env-decoy'], ['rules', 'user-rule']] as const) {
    const { report } = await canary({ skip: [skip] });
    assert.equal(report.verdict, 'inconclusive', skip);
    assert.equal(outcome(report, id), 'inconclusive', skip);
  }
  // a skipped item must never mask a FAIL elsewhere
  const mixed = await canary({ skip: ['network'], honour: ['project-hook'] });
  assert.equal(mixed.report.verdict, 'blocked');
});

test('the credential read is reported as information, never as pass/fail', async () => {
  const { report } = await canary({});
  const c = report.items.find((i) => i.id === 'credential-read')!;
  assert.equal(c.outcome, 'info');
  assert.match(c.detail, /could READ a file outside the repository/);
  const none = await canary({ skip: ['cred'] });
  assert.equal(none.report.verdict, 'pass', 'not reading it does not change the verdict');
});

test('refuses to run (no model call) on a missing, broken or too-old install', async () => {
  const broken = dirWith({ version: 'broken' });
  const r1 = await runCodexCanary({ bin: FAKE, extraEnv: { FAKE_DIR: broken } });
  assert.equal(r1.verdict, 'inconclusive');
  assert.match(r1.items[0]!.detail, /not working/);
  assert.equal(calls(broken).filter((c) => c.cmd === 'exec').length, 0);
  const old = dirWith({ version: 'old' });
  const r2 = await runCodexCanary({ bin: FAKE, extraEnv: { FAKE_DIR: old } });
  assert.equal(r2.verdict, 'inconclusive');
  assert.match(r2.items[0]!.detail, /older than the minimum/);
  assert.equal(calls(old).filter((c) => c.cmd === 'exec').length, 0);
  const r3 = await runCodexCanary({ bin: 'definitely-not-installed-codex-xyz' });
  assert.equal(r3.verdict, 'inconclusive');
});

test('evaluateCanary on hand-made evidence: ambiguity defaults to inconclusive', () => {
  const fold = newCodexFold();
  const base = (): CanaryEvidence => ({
    nonce: 'n0', port: 1234, credSecret: 'SECRET', decoys: ['D1', 'D2'],
    control: { ran: true, hook: true, mcp: true, ruleProbe: 'blocked' },
    prod: { ran: true, fold, markers: { userHook: false, userMcp: false, projectHook: false, projectMcp: false }, writeFileExists: false, listenerHits: 0 },
  });
  const cmd = (command: string, exitCode: number | null, output = '') => fold.commands.push({ command, exitCode, status: '', output });
  cmd("sh -c 'echo x > conductor-write-probe-n0.txt'", 0, ''); // "succeeded" yet no file: odd ⇒ inconclusive, not pass
  cmd('curl -s -m 5 http://127.0.0.1:1234/n0', 7);
  cmd('env', 0, ''); // empty env listing
  cmd('echo rule-probe-n0-user', 1, 'blocked by something else but with output');
  const r = evaluateCanary(base());
  assert.equal(r.verdict, 'inconclusive');
  const by = (id: string) => r.items.find((i) => i.id === id)!.outcome;
  assert.equal(by('sandbox-write'), 'inconclusive');
  assert.equal(by('network'), 'pass');
  assert.equal(by('env-decoy'), 'inconclusive');
  assert.equal(by('user-rule'), 'inconclusive');
  // a run that never completed is never a pass
  const e2 = base();
  e2.prod.ran = false;
  assert.equal(evaluateCanary(e2).verdict, 'inconclusive');
});

// ───────────── the add-only verification records ─────────────
import { addRecord, buildVerificationInfo, effectiveReadOnlyTier, loadRecords, verificationFile, type VerificationBinding, type VerificationRecord } from '../../src/agents/providers/verification.ts';
import { currentCodexBinding } from '../../src/agents/providers/codex.ts';
import { mkdirSync, rmSync, symlinkSync, statSync } from 'node:fs';

const binding = (over: Partial<VerificationBinding> = {}): VerificationBinding => ({ cliVersion: '0.128.0', binSha256: 'a'.repeat(64), argvDigest: 'b'.repeat(64), privateConfigSha: 'c'.repeat(64), canaryVersion: CANARY_VERSION, ...over });
const rec = (verdict: VerificationRecord['verdict'], over: Partial<VerificationRecord> = {}): VerificationRecord => ({ provider: 'codex', kind: 'readOnly', verdict, source: 'canary', binding: binding(), at: Date.now(), ...over });

test('records: no record ⇒ the code constant; a PASS lifts Codex to `partial` only while the install still matches; any change invalidates it', () => {
  rmSync(verificationFile('codex'), { force: true });
  assert.equal(effectiveReadOnlyTier('codex', binding()), 'unverified');
  addRecord(rec('pass'));
  assert.equal(effectiveReadOnlyTier('codex', binding()), 'partial');
  for (const change of [{ cliVersion: '0.129.0' }, { binSha256: 'd'.repeat(64) }, { argvDigest: 'e'.repeat(64) }, { privateConfigSha: 'f'.repeat(64) }, { canaryVersion: CANARY_VERSION + 1 }]) {
    assert.equal(effectiveReadOnlyTier('codex', binding(change)), 'unverified', JSON.stringify(change));
  }
  assert.equal(effectiveReadOnlyTier('codex', null), 'unverified', 'an unknown current install never counts a stored pass');
  // an unknown binary hash on either side does not invalidate (the version still must match)
  assert.equal(effectiveReadOnlyTier('codex', binding({ binSha256: null })), 'partial');
  // a pass never touches build isolation: that comes from the code baseline only
  assert.equal(buildVerificationInfo('codex', '0.128.0'), null);
});

test('records: `blocked` is sticky (survives a version change) until a LATER pass; inconclusive changes nothing', () => {
  rmSync(verificationFile('codex'), { force: true });
  addRecord(rec('pass'));
  addRecord(rec('blocked'));
  assert.equal(effectiveReadOnlyTier('codex', binding()), 'blocked');
  assert.equal(effectiveReadOnlyTier('codex', binding({ cliVersion: '9.9.9' })), 'blocked', 'a new version does not silently unblock');
  assert.equal(effectiveReadOnlyTier('codex', null), 'blocked');
  addRecord(rec('inconclusive'));
  assert.equal(effectiveReadOnlyTier('codex', binding()), 'blocked', 'an inconclusive run is not a pass');
  addRecord(rec('pass'));
  assert.equal(effectiveReadOnlyTier('codex', binding()), 'partial', 'a later pass clears it');
});

test('records: a corrupt, forged-shape, symlinked or oversized file reads as NO record — never an upgrade, never a downgrade', () => {
  const f = verificationFile('codex');
  rmSync(f, { force: true });
  addRecord(rec('pass'));
  assert.equal(effectiveReadOnlyTier('codex', binding()), 'partial');
  writeFileSync(f, '{not json');
  assert.deepEqual(loadRecords('codex'), []);
  assert.equal(effectiveReadOnlyTier('codex', binding()), 'unverified');
  writeFileSync(f, JSON.stringify({ records: [{ ...rec('pass'), provider: 'cursor' }] }));
  assert.deepEqual(loadRecords('codex'), [], 'a record for another provider');
  writeFileSync(f, JSON.stringify({ records: [{ ...rec('pass'), verdict: 'verified' }] }));
  assert.deepEqual(loadRecords('codex'), [], 'an unknown verdict');
  writeFileSync(f, JSON.stringify({ records: [{ ...rec('pass'), binding: { ...binding(), argvDigest: 'zz' } }] }));
  assert.deepEqual(loadRecords('codex'), [], 'a malformed digest');
  writeFileSync(f, JSON.stringify({ records: [rec('pass')], pad: 'x'.repeat(300_000) }));
  assert.deepEqual(loadRecords('codex'), [], 'oversized');
  rmSync(f);
  const target = join(mkdtempSync(join(tmpdir(), 'cond-vlink-')), 'real.json');
  writeFileSync(target, JSON.stringify({ records: [rec('pass')] }));
  symlinkSync(target, f);
  assert.deepEqual(loadRecords('codex'), [], 'a symlink is not a regular file');
  rmSync(f);
  // forging 'pass' for BUILD cannot be done through this file: there is no code path from a record to buildIsolationVerified
  addRecord(rec('pass', { kind: 'build', source: 'live-suite', suite: 'x' }));
  assert.equal(effectiveReadOnlyTier('codex', binding()), 'unverified', 'a build record is not a read-only record');
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(statSync(join(f, '..')).mode & 0o777, 0o700);
  rmSync(f, { force: true });
});

test('records: the current-install binding comes from the CLI version + the binary + the argv/config constants (and is null when the version is unknown)', () => {
  assert.equal(currentCodexBinding(FAKE, undefined, CANARY_VERSION), null);
  assert.equal(currentCodexBinding(FAKE, 'garbage', CANARY_VERSION), null);
  const b = currentCodexBinding(FAKE, 'codex-cli 0.128.0', CANARY_VERSION)!;
  assert.equal(b.cliVersion, '0.128.0');
  assert.match(b.binSha256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal(b.privateConfigSha, sha256(CODEX_CONFIG_TOML));
});

test('Cursor build verification is display-only: the baseline, or a live-suite record on the installed version; it never changes eligibility', () => {
  rmSync(verificationFile('cursor'), { force: true });
  assert.deepEqual(buildVerificationInfo('cursor', '2026.10.19'), { source: 'baseline', verifiedOn: '2026.10.19', grandfathered: true, current: true });
  assert.deepEqual(buildVerificationInfo('cursor', '2026.11.02'), { source: 'baseline', verifiedOn: '2026.10.19', grandfathered: true, current: false });
  assert.equal(buildVerificationInfo('cursor', undefined)!.current, null);
  addRecord({ provider: 'cursor', kind: 'build', verdict: 'pass', source: 'live-suite', suite: 'cursor-nopush', binding: binding({ cliVersion: '2026.11.02' }), at: Date.now() });
  assert.deepEqual(buildVerificationInfo('cursor', '2026.11.02'), { source: 'live-suite', verifiedOn: '2026.11.02', grandfathered: false, current: true });
  rmSync(verificationFile('cursor'), { force: true });
  void mkdirSync;
});

// ───────────── routing uses the effective tier ─────────────
import { makeHarness } from '../helpers/harness.ts';

test('engine: a `blocked` Codex is never selected for any role (even as the last provider); a passed check lifts it to `partial` only while health reports the matching version', async () => {
  rmSync(verificationFile('codex'), { force: true });
  const h = await makeHarness({ config: (c) => { c.agents.codex.bin = FAKE; c.roles.review = { providers: ['codex', 'claude'] }; c.pipeline.planReview = 'always'; } });
  try {
    assert.equal(h.engine.routeStates().codex.tier, 'unverified');
    // a stored pass for THIS install, and health that reports the same version ⇒ partial
    const cur = currentCodexBinding(FAKE, '0.128.0', CANARY_VERSION)!;
    addRecord({ provider: 'codex', kind: 'readOnly', verdict: 'pass', source: 'canary', binding: cur, at: Date.now() });
    assert.equal(h.engine.routeStates().codex.tier, 'unverified', 'no health yet ⇒ the install is unknown ⇒ a pass does not count');
    h.engine.setHealthSource(() => ({ codex: { found: true, ok: true, loggedIn: true, version: '0.128.0' } }));
    assert.equal(h.engine.routeStates().codex.tier, 'partial');
    h.engine.setHealthSource(() => ({ codex: { found: true, ok: true, loggedIn: true, version: '0.130.0' } }));
    assert.equal(h.engine.routeStates().codex.tier, 'unverified', 'an upgraded CLI invalidates the pass');
    // a later `blocked` result: Codex is excluded from every role, and the card goes on with the next provider
    addRecord({ provider: 'codex', kind: 'readOnly', verdict: 'blocked', source: 'canary', binding: cur, at: Date.now() + 1 });
    assert.equal(h.engine.routeStates().codex.tier, 'blocked');
    const key = h.issue('Codex is blocked');
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
    assert.equal(calls(h.fakeDir).filter((c) => c.cmd === 'exec').length, 0, 'the blocked provider was never started');
    assert.equal(h.run(key).sessions.find((s) => s.stage === 'plan_review')?.agent, 'claude');
  } finally {
    rmSync(verificationFile('codex'), { force: true });
    await h.cleanup();
  }
});
