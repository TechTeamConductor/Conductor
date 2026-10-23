// M2 commit 1a — CHARACTERIZATION of the build envelope (Security design condition 1f).
// These tests are written against the code as it is BEFORE the envelope is extracted from stages.build() and must pass
// UNCHANGED after the extraction (commit 1b). They pin what the envelope guarantees for ANY builder: git no-push env,
// git-meta restore, guard verification, secret/scope checks, failure routing and the run fields the API derives from.
// Cases that depend on a provider contract that does not exist yet (verifyGuard/prepare throwing, prepare overriding
// GIT_CONFIG_GLOBAL, a provider without prepare) are added in 1b.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeHarness, TestClock, type Harness } from './helpers/harness.ts';
import { postBuildChecks } from '../src/pipeline/envelope.ts';

const fail = (h: Harness, key: string) => h.run(key).needsHuman?.reason ?? '';
const cursorCalls = (h: Harness) => h.calls().filter((c) => c.who === 'cursor' && c.stage === 'build');

test('E1: a builder that plants a hook, core.hooksPath, an alias AND a pushurl is stopped; every one is restored; nothing is committed', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ cursor: { '*': { build: [{ tamperGit: true, tamperPushUrl: true }] } } });
    const key = h.issue('Innocent task');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.match(fail(h, key), /git settings\/hooks/);
    assert.match(fail(h, key), /pushurl/i, 'the reason names the pushurl change');
    assert.equal(existsSync(join(h.repoDir, '.git', 'hooks', 'post-commit')), false);
    assert.doesNotMatch(readFileSync(join(h.repoDir, '.git', 'config'), 'utf8'), /hookspath|alias|pushurl|evil/i);
    assert.equal(h.run(key).commitSha, undefined, 'a tampering builder never gets a commit recorded');
  } finally {
    await h.cleanup();
  }
});

test('E2: the guard file modified OR deleted by the builder is detected, and the run is held (not committed, not verified)', async () => {
  for (const op of [{ tamperGuard: true }, { deleteGuard: true }]) {
    const h = await makeHarness();
    try {
      h.scenario({ cursor: { '*': { build: [op] } } });
      const key = h.issue('Guard tamper');
      await h.settle();
      assert.equal(h.run(key).status, 'needs_human', JSON.stringify(op));
      assert.match(fail(h, key), /no-push guard/, JSON.stringify(op));
      assert.equal(h.run(key).commitSha, undefined);
    } finally {
      await h.cleanup();
    }
  }
});

test('E3: a secret written to a file by the builder is refused at commit time (reason never repeats the secret)', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ cursor: { '*': { build: [{ files: { 'src/config.mjs': "export const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd';\n" } }] } } });
    const key = h.issue('Add config');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.match(fail(h, key), /refused to commit|secret/i);
    assert.doesNotMatch(fail(h, key), /sk-ant/);
    assert.equal(h.run(key).commitSha, undefined);
  } finally {
    await h.cleanup();
  }
});

test('E4: a protected file the plan did not list (uncommitted) is held for a human', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ cursor: { '*': { build: [{ files: { 'feature.mjs': 'export const x = 1;\n', '.github/workflows/ci.yml': 'name: x\n' } }] } } });
    const key = h.issue('Add feature');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.match(fail(h, key), /protected files/);
    assert.match(fail(h, key), /\.github\/workflows\/ci\.yml/);
  } finally {
    await h.cleanup();
  }
});

test('E4b: protected files already on the branch at the start of the attempt are not blamed on the builder', async () => {
  const h = await makeHarness({ gates: false });
  try {
    const dir = h.repoDir;
    const base = git(dir, 'rev-parse', 'HEAD');
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'old.yml'), 'name: old\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'ci already on the branch');
    const attempt = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'feature.mjs'), 'export const x = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'the build');
    assert.equal(await postBuildChecks(dir, base, [], [], attempt), null);
    const blamed = await postBuildChecks(dir, base, [], []);
    assert.match(blamed ?? '', /\.github\/workflows\/old\.yml/);
    writeFileSync(join(dir, '.github', 'workflows', 'new.yml'), 'name: new\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'builder touched CI');
    assert.match((await postBuildChecks(dir, base, [], [], attempt)) ?? '', /\.github\/workflows\/new\.yml/);
  } finally {
    await h.cleanup();
  }
});

test('E5: renaming a protected tracked file away counts the rename SOURCE (builder moves .npmrc out of its protected name)', async () => {
  const h = await makeHarness({ repoFiles: { '.npmrc': 'registry=https://registry.npmjs.org/\n' } });
  try {
    h.scenario({ cursor: { '*': { build: [{ files: { 'feature.mjs': 'export const x = 1;\n' }, rename: { '.npmrc': 'src/npmrc.txt' } }] } } });
    const key = h.issue('Rename');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.match(fail(h, key), /protected files/);
    assert.match(fail(h, key), /\.npmrc/);
  } finally {
    await h.cleanup();
  }
});

test('E6: the builder environment carries the no-push git env, allow-listed keys only, and no secret-looking variables', async () => {
  const h = await makeHarness();
  try {
    process.env.CONDUCTOR_ENVELOPE_PROBE_TOKEN = 'must-not-reach-the-builder';
    process.env.GITHUB_TOKEN = 'must-not-reach-the-builder-either';
    const key = h.issue('Env probe');
    await h.settle();
    const call = cursorCalls(h)[0];
    assert.ok(call, 'a build call happened');
    assert.equal(call.env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(call.env.GIT_ASKPASS, '/usr/bin/false');
    assert.ok(!call.envKeys.includes('CONDUCTOR_ENVELOPE_PROBE_TOKEN'));
    assert.ok(!call.envKeys.includes('GITHUB_TOKEN'));
    assert.ok(!call.envKeys.some((k: string) => /^(LINEAR|OPENAI|CODEX)/.test(k)));
    assert.ok(key);
  } finally {
    delete process.env.CONDUCTOR_ENVELOPE_PROBE_TOKEN;
    delete process.env.GITHUB_TOKEN;
    await h.cleanup();
  }
});

test('E7: guard bookkeeping — a normal repo records the guard hash and is NOT env-only; a repo with a tracked .cursor/cli.json is env-only with no hash', async () => {
  const a = await makeHarness();
  try {
    const key = a.issue('Normal repo');
    await a.settle();
    assert.equal(a.run(key).guardEnvOnly, false);
    assert.match(a.run(key).guardSha ?? '', /^[0-9a-f]{64}$/);
  } finally {
    await a.cleanup();
  }
  const b = await makeHarness({ repoFiles: { '.cursor/cli.json': '{"permissions":{"allow":[],"deny":[]}}\n' } });
  try {
    const key = b.issue('Repo with its own cli.json');
    await b.settle();
    assert.equal(b.run(key).guardEnvOnly, true);
    assert.equal(b.run(key).guardSha, undefined);
    assert.ok(b.run(key).history.length > 0);
  } finally {
    await b.cleanup();
  }
});

test('E8: the commit trailer names the builder, and a clean build is committed exactly once on the run branch', async () => {
  const h = await makeHarness();
  try {
    const key = h.issue('Trailer');
    await h.settle();
    const run = h.run(key);
    assert.ok(run.commitSha);
    const msg = git(run.worktree, 'log', '-1', '--format=%B', run.commitSha!);
    assert.match(msg, /Built by Conductor \(Cursor\)\. Plan rev 1\./);
    assert.equal(git(run.worktree, 'rev-list', '--count', `${run.baseSha}..HEAD`), '1');
  } finally {
    await h.cleanup();
  }
});

test('E9: a builder that returns an ordinary error is retried once, then held — never committed, never verified', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ cursor: { '*': { build: [{ error: 'boom: something odd' }] } } });
    const key = h.issue('Failing builder');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.match(fail(h, key), /Cursor failed twice/);
    assert.equal(cursorCalls(h).length, 2, 'exactly one retry');
    assert.equal(h.run(key).commitSha, undefined);
  } finally {
    await h.cleanup();
  }
});

test('E10: a builder usage limit pauses the card, the attempt is refunded, and nothing is committed', async () => {
  const clock = new TestClock();
  const h = await makeHarness({ clock });
  try {
    h.scenario({ cursor: { '*': { build: [{ limit: true }, {}] } } });
    const key = h.issue('Limited builder');
    await h.settle();
    assert.equal(h.run(key).status, 'paused');
    assert.equal(h.run(key).commitSha, undefined);
    assert.equal(h.run(key).agentRuns, 1, 'only the plan call counts — the limited build attempt is refunded');
    assert.ok(h.engine.status().providerPause.cursor);
  } finally {
    await h.cleanup();
  }
});

test('E11: canceling a card while its builder is running ends it as canceled with nothing committed', async () => {
  const h = await makeHarness();
  try {
    h.scenario({ cursor: { '*': { build: [{ hang: true }] } } });
    const key = h.issue('Hanging builder');
    for (let i = 0; i < 40 && cursorCalls(h).length === 0; i++) {
      await h.engine.tick();
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(cursorCalls(h).length, 1, 'the builder started');
    await h.engine.abort(key);
    await h.settle();
    assert.equal(h.run(key).status, 'aborted');
    assert.equal(h.run(key).commitSha, undefined);
  } finally {
    await h.cleanup();
  }
});

test('E12: the provider throwing (a bug, not a result) never produces a commit or a pass', async () => {
  const h = await makeHarness();
  try {
    let thrown = 0;
    h.agents._testMutate('cursor', (p) => {
      p.build!.run = async () => {
        thrown++;
        throw new Error('provider crashed');
      };
    });
    const key = h.issue('Thrown builder');
    await h.settle(12);
    assert.ok(thrown >= 1);
    assert.notEqual(h.run(key).status, 'finished');
    assert.equal(h.run(key).commitSha, undefined);
    assert.notEqual(h.run(key).stage, 'done');
  } finally {
    await h.cleanup();
  }
});

// Condition 1e: today the meta restore is not in a `finally`, so a provider that throws AFTER the builder planted a hook
// leaves the hook behind. The envelope extraction fixes this on purpose; it was a `todo` in the characterization commit.
test('E13: the provider throwing AFTER the builder planted a hook/config still restores them (Security 1e — the one intentional behaviour difference of the extraction)', async () => {
  const h = await makeHarness();
  try {
    const real = h.agents.provider('cursor').build!.run;
    h.agents._testMutate('cursor', (p) => {
      p.build!.run = async (req, prep) => {
        await real(req, prep);
        throw new Error('provider crashed after the builder ran');
      };
    });
    h.scenario({ cursor: { '*': { build: [{ tamperGit: true, tamperPushUrl: true }] } } });
    const key = h.issue('Thrown after tamper');
    await h.settle(12);
    assert.equal(existsSync(join(h.repoDir, '.git', 'hooks', 'post-commit')), false, 'the planted hook is gone');
    assert.doesNotMatch(readFileSync(join(h.repoDir, '.git', 'config'), 'utf8'), /hookspath|alias|pushurl|evil/i);
    assert.ok(key);
  } finally {
    await h.cleanup();
  }
});

// ───────────── contract cases that only exist with the provider seam (M2 commit 1) ─────────────
import { readdirSync, readFileSync as readF, statSync } from 'node:fs';
import { relative } from 'node:path';
import { buildEligibility, sanitizePrepEnv } from '../src/pipeline/envelope.ts';
import { capabilitiesOf, createProviders, mutatedProviderForTests, providerLabel } from '../src/agents/providers/registry.ts';
import { defaultConfig } from '../src/config.ts';
import { runBuild } from '../src/pipeline/envelope.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isBuildIsolationVerified } from '../src/agents/providers/verification.ts';
import { migrateRunV2ToV3 } from '../src/schema/run-migrations.ts';

const mutate = (h: Harness, fn: (b: NonNullable<ReturnType<Harness['agents']['provider']>['build']>) => void): void => h.agents._testMutate('cursor', (p) => fn(p.build!));

test('E14: verifyGuard THROWING fails closed — the run is held, nothing is committed', async () => {
  const h = await makeHarness();
  try {
    mutate(h, (b) => {
      b.verifyGuard = async () => {
        throw new Error('hash check blew up');
      };
    });
    const key = h.issue('Guard check throws');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.match(fail(h, key), /guard/i);
    assert.match(fail(h, key), /guard check itself failed/);
    assert.equal(h.run(key).commitSha, undefined);
  } finally {
    await h.cleanup();
  }
});

test('E15: prepare THROWING (or rejecting) fails closed with ZERO builder spawns', async () => {
  for (const mode of ['throw', 'reject'] as const) {
    const h = await makeHarness();
    try {
      mutate(h, (b) => {
        b.prepare = mode === 'throw' ? () => { throw new Error('cannot write the guard'); } : () => Promise.reject(new Error('cannot write the guard'));
      });
      const key = h.issue('Prepare fails');
      await h.settle();
      assert.equal(h.run(key).status, 'needs_human', mode);
      assert.match(fail(h, key), /guard could not be established/, mode);
      assert.equal(cursorCalls(h).length, 0, `${mode}: the builder was never started`);
    } finally {
      await h.cleanup();
    }
  }
});

test('E16: a provider that declares a guard but lacks prepare OR verifyGuard is refused (zero spawns)', async () => {
  for (const missing of ['prepare', 'verifyGuard'] as const) {
    const h = await makeHarness();
    try {
      mutate(h, (b) => void ((b as any)[missing] = undefined));
      const key = h.issue('Half a guard');
      await h.settle();
      assert.equal(h.run(key).status, 'needs_human', missing);
      assert.match(fail(h, key), /does not provide both prepare and verify/, missing);
      assert.equal(cursorCalls(h).length, 0, missing);
    } finally {
      await h.cleanup();
    }
  }
});

test('E17: an adapter cannot opt out of the guard its verification depends on (guard flag, hooks removed) — held, zero spawns (Security M2-1)', async () => {
  const h = await makeHarness();
  try {
    mutate(h, (b) => {
      b.guard = false;
      b.prepare = undefined;
      b.verifyGuard = undefined;
    });
    const key = h.issue('No provider guard');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.match(fail(h, key), /must keep the guard its isolation check depends on/);
    assert.equal(cursorCalls(h).length, 0);
  } finally {
    await h.cleanup();
  }
});

test('E17b: the registry is sealed — production code cannot edit a provider, and an object merely claiming id "cursor" is not a provider (M2-1, M2-2)', () => {
  const frozen = createProviders({ getConfig: () => defaultConfig(), clock: { now: () => 0 } as any, extraEnv: {} });
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.cursor) && Object.isFrozen(frozen.cursor.build));
  assert.throws(() => { (frozen.cursor.build as any).guard = false; }, TypeError);
  assert.throws(() => { (frozen.cursor as any).label = 'x'; }, TypeError);
  const impostor = { ...frozen.claude, id: 'cursor' as const, label: 'Cursor', build: { guard: true, envAllow: [], prepare: async () => ({ guardSha: 'a', envOnly: false }), verifyGuard: async () => ({ ok: true, detail: '' }), run: async () => ({ ok: true, text: '', exitCode: 0 }) } };
  const r = buildEligibility(impostor);
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.why, /not from the registry/);
  assert.equal(buildEligibility(frozen.cursor).ok, true);
});

test('E17c: contradictory prepare results are refused (a guard reported without a hash; env-only reported together with a hash)', async () => {
  for (const prep of [{ guardSha: null, envOnly: false }, { guardSha: 'abc', envOnly: true }]) {
    const h = await makeHarness();
    try {
      mutate(h, (b) => void (b.prepare = async () => prep));
      const key = h.issue('Contradictory prep');
      await h.settle();
      assert.equal(h.run(key).status, 'needs_human', JSON.stringify(prep));
      assert.match(fail(h, key), /guard could not be established/);
      assert.equal(cursorCalls(h).length, 0);
    } finally {
      await h.cleanup();
    }
  }
});

test('E17d: if the repository\'s git settings cannot be snapshotted, the builder is NOT started (Security M2-4)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cond-notgit-'));
  let ran = 0;
  const base = createProviders({ getConfig: () => defaultConfig(), clock: { now: () => 0 } as any, extraEnv: {} }).cursor;
  const p = mutatedProviderForTests(base, (d) => {
    d.build!.prepare = async () => ({ guardSha: 'abc', envOnly: false });
    d.build!.verifyGuard = async () => ({ ok: true, detail: '' });
    d.build!.run = async () => { ran++; return { ok: true, text: '', exitCode: 0 }; };
  });
  const out = await runBuild({ provider: p, repoPath: dir, worktree: dir, baseSha: 'x', subject: 's', rev: 1, prompt: 'p', name: 'n', onEvent: () => undefined, secrets: [], planPaths: [], onPrepared: () => undefined, onResult: () => undefined });
  assert.equal(out.kind, 'held');
  assert.match(out.kind === 'held' ? out.reason : '', /could not read the repository's git settings/);
  assert.equal(ran, 0);
});

test('E18: `prepare` cannot override the git no-push env or HOME/PATH/CODEX_HOME — and harmless keys pass through', async () => {
  const h = await makeHarness();
  try {
    const real = h.agents.provider('cursor').build!.prepare!;
    mutate(h, (b) => {
      b.prepare = async (ctx) => ({ ...(await real(ctx)), env: { GIT_CONFIG_GLOBAL: '/tmp/evil-gitconfig', GIT_ASKPASS: '/tmp/evil', CURSOR_PROBE_OK: '1', HOME: '/tmp/evil-home', PATH: '/tmp/evil-bin', CODEX_HOME: '/tmp/evil-codex', GH_TOKEN: 'ghp_x', SSH_AUTH_SOCK: '/tmp/agent.sock', BASH_ENV: '/tmp/evil.sh', NODE_PATH: '/tmp/evil', PYTHONSTARTUP: '/tmp/evil.py' } });
    });
    const key = h.issue('Env override');
    await h.settle();
    const call = cursorCalls(h)[0];
    assert.ok(call);
    assert.equal(call.env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(call.env.GIT_ASKPASS, '/usr/bin/false');
    assert.equal(call.env.CURSOR_PROBE_OK, '1', 'a key inside the adapter\'s allow-list (CURSOR_*) is honoured');
    for (const k of ['GH_TOKEN', 'SSH_AUTH_SOCK', 'BASH_ENV', 'NODE_PATH', 'PYTHONSTARTUP']) assert.ok(!call.envKeys.includes(k), `${k} is not on the allow-list, so it never reaches the builder`);
    assert.ok(key);
  } finally {
    await h.cleanup();
  }
  assert.deepEqual(sanitizePrepEnv({ GIT_DIR: 'x', git_work_tree: 'x', HOME: 'x', Path: 'x', CODEX_HOME: 'x', CODEX_API_KEY: 'x', XDG_CONFIG_HOME: 'x', LD_PRELOAD: 'x', DYLD_INSERT_LIBRARIES: 'x', NODE_OPTIONS: 'x', FINE: 'ok', CURSOR_X: 'y', 'BAD KEY': 'z' }, ['FINE', 'CURSOR_*', 'GIT_*', 'HOME', 'CODEX_*']), { FINE: 'ok', CURSOR_X: 'y' }, 'allow-list only; the never-list wins even over a declared pattern');
  assert.deepEqual(sanitizePrepEnv({ ANY: 'x' }), {}, 'no declared allow-list ⇒ nothing passes');
  assert.deepEqual(sanitizePrepEnv({ A: 'x' }, ['*']), {}, 'a bare * is not a pattern');
});

test('E19: eligibility is derived and re-asserted inside the envelope — no build function, or unverified isolation ⇒ held with zero spawns', async () => {
  // derived from code, never from config
  assert.equal(capabilitiesOf({ id: 'claude', label: 'Claude' } as any).build, false);
  assert.equal(isBuildIsolationVerified('claude'), false);
  assert.equal(isBuildIsolationVerified('cursor'), true);
  const reg = createProviders({ getConfig: () => defaultConfig(), clock: { now: () => 0 } as any, extraEnv: {} });
  assert.equal(buildEligibility(reg.claude).ok, false);
  assert.match((buildEligibility(reg.claude) as any).why, /no build capability/);
  const claudeWithBuild = mutatedProviderForTests(reg.claude, (d) => void (d.build = { guard: false, envAllow: [], run: async () => ({ ok: true, text: '', exitCode: 0 }) }));
  assert.equal(buildEligibility(claudeWithBuild).ok, false, 'a build function alone is not enough: isolation must be verified');
  const h = await makeHarness();
  try {
    h.agents._testMutate('cursor', (p) => void (p.build = undefined)); // "the build capability disappears"
    const key = h.issue('Ineligible');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.match(fail(h, key), /no build capability/);
    assert.equal(cursorCalls(h).length, 0);
  } finally {
    await h.cleanup();
  }
});

test('E20: static — only the Cursor adapter starts a Cursor run, and only the envelope calls a provider\'s build.run', () => {
  const ROOT = join(import.meta.dirname, '..', 'src');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(n)) files.push(p);
    }
  };
  walk(ROOT);
  const runCursorUsers = files.filter((f) => /\brunCursor\(/.test(readF(f, 'utf8'))).map((f) => relative(ROOT, f)).sort();
  assert.deepEqual(runCursorUsers, ['agents/cursor.ts', 'agents/providers/cursor.ts', 'doctor.ts'], 'runCursor( may appear only in its definition, the doctor probe (ask mode) and the Cursor adapter');
  for (const f of ['doctor.ts']) assert.doesNotMatch(readF(join(ROOT, f), 'utf8'), /mode:\s*'build'/, `${f} must never start a Cursor build`);
  const buildRunUsers = files.filter((f) => /\bb\.run\(|\.build(\?|!)?\.run\(/.test(readF(f, 'utf8'))).map((f) => relative(ROOT, f)).sort();
  assert.deepEqual(buildRunUsers, ['pipeline/envelope.ts'], 'build.run is called by the envelope only');
  assert.equal(providerLabel('cursor'), 'Cursor');
  assert.equal(providerLabel('nope'), 'The agent');
});

test('E21: run.json v2 → v3 carries cursorGuardSha/noPushEnvOnly; with neither, guardEnvOnly defaults to TRUE (fail-safe)', () => {
  assert.deepEqual(migrateRunV2ToV3({ key: 'A-1', schemaVersion: 2, cursorGuardSha: 'abc', noPushEnvOnly: false }), { key: 'A-1', schemaVersion: 3, guardSha: 'abc', guardEnvOnly: false });
  assert.deepEqual(migrateRunV2ToV3({ key: 'A-1', schemaVersion: 2, noPushEnvOnly: true }), { key: 'A-1', schemaVersion: 3, guardEnvOnly: true });
  assert.deepEqual(migrateRunV2ToV3({ key: 'A-1', schemaVersion: 2 }), { key: 'A-1', schemaVersion: 3, guardEnvOnly: true }, 'neither field ⇒ assume env-only');
  assert.deepEqual(migrateRunV2ToV3({ key: 'A-1', schemaVersion: 3, guardSha: 'new', guardEnvOnly: false }), { key: 'A-1', schemaVersion: 3, guardSha: 'new', guardEnvOnly: false }, 'already-new fields are never overwritten');
});

test('E22: the API keeps `noPushEnvOnly` as a derived view of guardEnvOnly', async () => {
  const h = await makeHarness({ repoFiles: { '.cursor/cli.json': '{"permissions":{"allow":[],"deny":[]}}\n' } });
  try {
    const key = h.issue('Derived view');
    await h.settle();
    const { toDetail } = await import('../src/pipeline/view.ts');
    const d = toDetail(h.store, h.run(key), h.cfg, Date.now());
    assert.equal(d.noPushEnvOnly, true);
    assert.equal((d as any).guardEnvOnly, undefined, 'the generic name is not leaked into the API yet');
  } finally {
    await h.cleanup();
  }
});

test('E25: whatever the builder\'s RESULT is — limit, abort, timeout, error — a planted hook/config is restored before anything else happens (Reviewer m-4)', async () => {
  const results: { name: string; res: any }[] = [
    { name: 'limit', res: { ok: false, text: '', exitCode: 1, errorKind: 'limit', error: 'usage limit', limit: { provider: 'cursor', resetsAt: null, message: 'usage limit' } } },
    { name: 'aborted', res: { ok: false, text: '', exitCode: null, errorKind: 'aborted', error: 'aborted' } },
    { name: 'timeout_hard', res: { ok: false, text: '', exitCode: null, errorKind: 'timeout_hard', error: 'timed out' } },
    { name: 'agent', res: { ok: false, text: '', exitCode: 1, errorKind: 'agent', error: 'crashed' } },
  ];
  for (const { name, res } of results) {
    const h = await makeHarness();
    try {
      h.scenario({ cursor: { '*': { build: [{ tamperGit: true, tamperPushUrl: true }] } } });
      const real = h.agents.provider('cursor').build!.run;
      h.agents._testMutate('cursor', (p) => {
        p.build!.run = async (req, prep) => {
          await real(req, prep); // the builder really plants hook / hooksPath / alias / pushurl …
          return res; // … and the provider then reports this result
        };
      });
      const key = h.issue(`Tamper then ${name}`);
      await h.settle(8);
      assert.equal(existsSync(join(h.repoDir, '.git', 'hooks', 'post-commit')), false, `${name}: the planted hook is gone`);
      assert.doesNotMatch(readFileSync(join(h.repoDir, '.git', 'config'), 'utf8'), /hookspath|alias|pushurl|evil/i, `${name}: the planted config is gone`);
      assert.equal(h.run(key).commitSha, undefined, `${name}: nothing committed`);
      assert.notEqual(h.run(key).status, 'ready', `${name}: never a pass`);
    } finally {
      await h.cleanup();
    }
  }
});
