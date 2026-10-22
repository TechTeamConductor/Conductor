import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GateDef, GateResult, GateRun } from '../../src/types.ts';
import { compareGates, detectGates, rerunFlaky, runGate, runGates } from '../../src/git/gates.ts';
import { isolateGitHome, makeRepo, tmpDir } from '../helpers/tmp-repo.ts';

isolateGitHome();

const FAKE_TOKEN = 'ghp_' + 'a1B2c3D4'.repeat(5);
const TSC_BIN = new URL('../../node_modules/.bin/tsc', import.meta.url).pathname;

function project(files: Record<string, string>): string {
  const d = tmpDir('gates');
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(d, f, '..'), { recursive: true });
    writeFileSync(join(d, f), c);
  }
  return d;
}
const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}): string => JSON.stringify({ name: 'x', scripts, ...extra });
const names = (gs: GateDef[]): string[] => gs.map((g) => g.name);

// ───────────────────────────── detectGates ─────────────────────────────

describe('detectGates', () => {
  it('npm (package-lock): typecheck + lint + test via `npm run X --silent`', async () => {
    const d = project({ 'package.json': pkg({ typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'node --test' }), 'package-lock.json': '{}' });
    assert.deepEqual(await detectGates(d), [
      { name: 'typecheck', cmd: 'npm run typecheck --silent', kind: 'typecheck' },
      { name: 'lint', cmd: 'npm run lint --silent', kind: 'lint' },
      { name: 'test', cmd: 'npm run test --silent', kind: 'test' },
    ]);
  });

  it('no lockfile defaults to npm', async () => {
    const d = project({ 'package.json': pkg({ test: 'node --test' }) });
    assert.deepEqual(await detectGates(d), [{ name: 'test', cmd: 'npm run test --silent', kind: 'test' }]);
  });

  it('pnpm / yarn / bun package-manager mapping', async () => {
    const scripts = { 'type-check': 'tsc', lint: 'eslint .', test: 'vitest run' };
    const pnpm = await detectGates(project({ 'package.json': pkg(scripts), 'pnpm-lock.yaml': '' }));
    assert.deepEqual(pnpm.map((g) => g.cmd), ['pnpm run type-check', 'pnpm run lint', 'pnpm run test']);
    const yarn = await detectGates(project({ 'package.json': pkg(scripts), 'yarn.lock': '' }));
    assert.deepEqual(yarn.map((g) => g.cmd), ['yarn type-check', 'yarn lint', 'yarn test']);
    const bun = await detectGates(project({ 'package.json': pkg(scripts), 'bun.lockb': '' }));
    assert.deepEqual(bun.map((g) => g.cmd), ['bun run type-check', 'bun run lint', 'bun run test']);
    const bun2 = await detectGates(project({ 'package.json': pkg(scripts), 'bun.lock': '' }));
    assert.deepEqual(bun2.map((g) => g.cmd), ['bun run type-check', 'bun run lint', 'bun run test']);
  });

  it('skips npm\'s placeholder test script, empty scripts, and picks only one typecheck alias', async () => {
    const d = project({
      'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1', typecheck: 'tsc --noEmit', tsc: 'tsc', lint: '  ' }),
      'package-lock.json': '{}',
    });
    assert.deepEqual(await detectGates(d), [{ name: 'typecheck', cmd: 'npm run typecheck --silent', kind: 'typecheck' }]);
    const tscOnly = await detectGates(project({ 'package.json': pkg({ tsc: 'tsc --noEmit' }) }));
    assert.deepEqual(tscOnly, [{ name: 'typecheck', cmd: 'npm run tsc --silent', kind: 'typecheck' }]);
  });

  it('survives a malformed package.json and a package.json without scripts', async () => {
    assert.deepEqual(await detectGates(project({ 'package.json': '{not json' })), []);
    assert.deepEqual(await detectGates(project({ 'package.json': '{"name":"x"}' })), []);
  });

  it('python: pytest config or a tests dir with python tests', async () => {
    const gate = { name: 'pytest', cmd: 'python3 -m pytest -q -rf', kind: 'test' };
    assert.deepEqual(await detectGates(project({ 'pytest.ini': '[pytest]\n' })), [gate]);
    assert.deepEqual(await detectGates(project({ 'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-q"\n' })), [gate]);
    assert.deepEqual(await detectGates(project({ 'setup.cfg': '[tool:pytest]\n' })), [gate]);
    assert.deepEqual(await detectGates(project({ 'tests/test_a.py': 'def test_a(): pass\n' })), [gate]);
    assert.deepEqual(await detectGates(project({ 'test/a_test.py': 'def test_a(): pass\n' })), [gate]);
    assert.deepEqual(await detectGates(project({ 'conftest.py': '' })), [gate]);
    assert.deepEqual(await detectGates(project({ 'tests/unit/deep/test_a.py': 'def test_a(): pass\n' })), [gate], 'nested test files');
    assert.deepEqual(await detectGates(project({ 'tests/node_modules/x/test_a.py': 'x' })), [], 'node_modules is never searched');
    assert.deepEqual(await detectGates(project({ 'tests/helpers.txt': 'x' })), [], 'tests dir without python tests is not a pytest project');
    assert.deepEqual(await detectGates(project({ 'pyproject.toml': '[project]\nname="x"\n' })), []);
  });

  it('go: vet + test; rust: cargo test', async () => {
    assert.deepEqual(await detectGates(project({ 'go.mod': 'module x\n' })), [
      { name: 'go-vet', cmd: 'go vet ./...', kind: 'lint' },
      { name: 'go-test', cmd: 'go test ./...', kind: 'test' },
    ]);
    assert.deepEqual(await detectGates(project({ 'Cargo.toml': '[package]\nname="x"\n' })), [{ name: 'cargo-test', cmd: 'cargo test', kind: 'test' }]);
  });

  it('polyglot repos get every gate with unique names; empty repos get none', async () => {
    const d = project({
      'package.json': pkg({ test: 'node --test' }),
      'package-lock.json': '{}',
      'go.mod': 'module x\n',
      'Cargo.toml': '[package]\n',
      'pytest.ini': '',
    });
    const gs = await detectGates(d);
    assert.deepEqual(names(gs), ['test', 'pytest', 'go-vet', 'go-test', 'cargo-test']);
    assert.equal(new Set(names(gs)).size, gs.length);
    assert.deepEqual(await detectGates(tmpDir()), []);
  });
});

// ───────────────────────────── runGate / runGates ─────────────────────────────

const T = 20_000;
const def = (cmd: string, kind: GateDef['kind'] = 'test', name = 'g'): GateDef => ({ name, cmd, kind });

describe('runGate', () => {
  it('passing gate: exit 0, failures [] and count 0', async () => {
    const r = await runGate(def('echo hello'), { cwd: tmpDir(), timeoutMs: T });
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
    assert.deepEqual(r.failures, []);
    assert.equal(r.failureCount, 0);
    assert.match(r.outputTail, /hello/);
    assert.ok(r.durationMs >= 0);
    assert.equal(r.name, 'g');
    assert.equal(r.cmd, 'echo hello');
  });

  it('failing but unparseable gate: failures null, count null, output kept', async () => {
    const r = await runGate(def('echo "boom: something odd"; exit 2'), { cwd: tmpDir(), timeoutMs: T });
    assert.equal(r.exitCode, 2);
    assert.equal(r.failures, null);
    assert.equal(r.failureCount, null);
    assert.match(r.outputTail, /boom: something odd/);
  });

  it('merges stderr into the output, preserving order', async () => {
    const r = await runGate(def('echo first; echo second >&2; echo third; exit 1'), { cwd: tmpDir(), timeoutMs: T });
    assert.match(r.outputTail, /first\nsecond\nthird/);
  });

  it('timeout: kills the group, exitCode null, timedOut true, no parse', async () => {
    const t0 = Date.now();
    const r = await runGate(def('sleep 30'), { cwd: tmpDir(), timeoutMs: 300 });
    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, null);
    assert.equal(r.failures, null);
    assert.equal(r.failureCount, null);
    assert.match(r.outputTail, /timed out/);
    assert.ok(Date.now() - t0 < 6000);
  });

  it('abort: exitCode null', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const r = await runGate(def('sleep 30'), { cwd: tmpDir(), timeoutMs: T, signal: ac.signal });
    assert.equal(r.exitCode, null);
    assert.equal(r.timedOut, false);
    assert.match(r.outputTail, /aborted/);
  });

  it('environment: allowlist + CI defaults + explicit env; no inherited secrets', async () => {
    process.env.LINEAR_API_KEY = 'lin_api_' + 'z'.repeat(30);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-' + 'z'.repeat(30);
    try {
      const r = await runGate(def('env'), { cwd: tmpDir(), timeoutMs: T, env: { MY_GATE_VAR: 'visible' } });
      assert.match(r.outputTail, /^MY_GATE_VAR=visible$/m);
      assert.match(r.outputTail, /^CI=true$/m);
      assert.match(r.outputTail, /^NO_COLOR=1$/m);
      assert.match(r.outputTail, /^PATH=/m);
      assert.doesNotMatch(r.outputTail, /LINEAR_API_KEY|ANTHROPIC_API_KEY/);
    } finally {
      delete process.env.LINEAR_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('redacts token shapes and exact secrets from the output tail; tail is capped at ~8 KB and keeps the END', async () => {
    const r = await runGate(def(`echo "token ${FAKE_TOKEN}"; echo "pw=hunter2hunter2"; i=0; while [ $i -lt 4000 ]; do echo "padding line $i xxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done; echo THE-END; exit 1`), {
      cwd: tmpDir(),
      timeoutMs: T,
      secrets: ['hunter2hunter2'],
    });
    assert.ok(r.outputTail.length <= 8 * 1024 + 8, `tail is ${r.outputTail.length} chars`);
    assert.match(r.outputTail, /THE-END/);
    const small = await runGate(def(`echo "token ${FAKE_TOKEN}"; echo "pw=hunter2hunter2"; exit 1`), { cwd: tmpDir(), timeoutMs: T, secrets: ['hunter2hunter2'] });
    assert.match(small.outputTail, /token \[redacted\]/);
    assert.match(small.outputTail, /pw=\[redacted\]/);
    assert.doesNotMatch(small.outputTail, /ghp_|hunter2/);
  });

  it('(real node:test) failing run is parsed into stable keys; cwd stripped', async () => {
    const d = project({
      'a.test.mjs': `import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
test('good one', () => {});
test('bad one', () => { assert.equal(1, 2); });
describe('group', () => { test('bad two', () => { throw new Error('x'); }); test('good two', () => {}); });
`,
    });
    const r = await runGate(def('node --test', 'test', 'test'), { cwd: d, timeoutMs: 60_000 });
    assert.equal(r.exitCode, 1);
    assert.deepEqual([...(r.failures ?? [])].sort(), ['bad one', 'group > bad two']);
    assert.equal(r.failureCount, 2);

    const spec = await runGate(def('node --test --test-reporter=spec', 'test', 'test'), { cwd: d, timeoutMs: 60_000 });
    assert.deepEqual([...(spec.failures ?? [])].sort(), ['bad one', 'group > bad two']);
  });

  it('(real tsc) baseline-line-shift: the same error after inserting lines is the SAME key', async () => {
    const tsconfig = '{"compilerOptions":{"strict":true,"noEmit":true,"target":"ES2022","module":"nodenext"},"include":["*.ts"]}';
    const a = project({ 'tsconfig.json': tsconfig, 'a.ts': 'export const x: number = "str";\n' });
    const b = project({ 'tsconfig.json': tsconfig, 'a.ts': '// comment\n// another\n\n\nexport const y = 1;\nexport const x: number = "str";\n' });
    const cmd = `${TSC_BIN} -p .`;
    const ra = await runGate(def(cmd, 'typecheck', 'typecheck'), { cwd: a, timeoutMs: 60_000 });
    const rb = await runGate(def(cmd, 'typecheck', 'typecheck'), { cwd: b, timeoutMs: 60_000 });
    assert.equal(ra.exitCode, 2);
    assert.deepEqual(ra.failures, ["a.ts TS2322 Type 'string' is not assignable to type 'number'."]);
    assert.deepEqual(rb.failures, ra.failures, 'different line AND different directory ⇒ identical key');
    assert.deepEqual(compareGates({ at: 0, sha: 's', results: [ra] }, { at: 1, sha: 't', results: [rb] }).preExisting, ['typecheck']);
  });
});

describe('runGates', () => {
  it('runs gates sequentially, records the HEAD sha, honours abort', async () => {
    const r = makeRepo();
    const run = await runGates([def('echo one', 'test', 'a'), def('exit 1', 'lint', 'b'), def('echo three', 'test', 'c')], { cwd: r.dir, timeoutMs: T });
    assert.equal(run.sha, r.head());
    assert.deepEqual(run.results.map((x) => [x.name, x.exitCode]), [['a', 0], ['b', 1], ['c', 0]]);
    assert.ok(Math.abs(run.at - Date.now()) < 60_000);

    const ac = new AbortController();
    ac.abort();
    const stopped = await runGates([def('echo x', 'test', 'a')], { cwd: r.dir, timeoutMs: T, signal: ac.signal });
    assert.deepEqual(stopped.results, []);
  });

  it('sha is "unknown" outside a git repo', async () => {
    const run = await runGates([def('true', 'test', 'a')], { cwd: tmpDir(), timeoutMs: T });
    assert.equal(run.sha, 'unknown');
  });
});

// ───────────────────────────── rerunFlaky ─────────────────────────────

describe('flaky-gate: rerunFlaky', () => {
  const flakeCmd = (dir: string): string => `if [ -f "${dir}/seen" ]; then echo ok; exit 0; else touch "${dir}/seen"; echo "not ok 1 - flaky test"; exit 1; fi`;

  it('a gate that fails once and passes on the rerun is a flake: the pass wins', async () => {
    const d = tmpDir('flake');
    const g = def(flakeCmd(d), 'test', 'test');
    const first = await runGate(g, { cwd: d, timeoutMs: T });
    assert.equal(first.exitCode, 1);
    const final = await rerunFlaky(g, { cwd: d, timeoutMs: T }, first);
    assert.equal(final.exitCode, 0);
    const cmp = compareGates({ at: 0, sha: 's', results: [{ ...final, exitCode: 0 }] }, { at: 1, sha: 't', results: [final] });
    assert.deepEqual(cmp, { regressions: [], preExisting: [], unverified: [], passed: ['test'] });
  });

  it('a gate that fails twice returns the SECOND failure', async () => {
    const d = tmpDir('flake');
    const g = def(`echo run >> "${d}/count"; echo "not ok 1 - always bad"; exit 1`, 'test', 'test');
    const first = await runGate(g, { cwd: d, timeoutMs: T });
    const final = await rerunFlaky(g, { cwd: d, timeoutMs: T }, first);
    assert.equal(final.exitCode, 1);
    assert.notEqual(final, first);
    assert.equal((await import('node:fs')).readFileSync(join(d, 'count'), 'utf8').trim().split('\n').length, 2, 'exactly one rerun');
  });

  it('a passing first result is returned as-is, without any rerun', async () => {
    const d = tmpDir('flake');
    const g = def(`echo run >> "${d}/count"`, 'test', 'test');
    const first = await runGate(g, { cwd: d, timeoutMs: T });
    const final = await rerunFlaky(g, { cwd: d, timeoutMs: T }, first);
    assert.equal(final, first);
    assert.equal((await import('node:fs')).readFileSync(join(d, 'count'), 'utf8').trim().split('\n').length, 1);
  });

  it('timeouts are not re-run', async () => {
    const d = tmpDir('flake');
    const g = def(`echo run >> "${d}/count"; sleep 30`, 'test', 'test');
    const first = await runGate(g, { cwd: d, timeoutMs: 300 });
    assert.equal(first.timedOut, true);
    const final = await rerunFlaky(g, { cwd: d, timeoutMs: 300 }, first);
    assert.equal(final, first);
    assert.equal((await import('node:fs')).readFileSync(join(d, 'count'), 'utf8').trim().split('\n').length, 1);
  });

  it('runGates({rerunFailed:true}) applies the flake guard to every failing gate', async () => {
    const d = makeRepo().dir;
    const run = await runGates([def(flakeCmd(d.replace(/'/g, '')), 'test', 'test')], { cwd: d, timeoutMs: T, rerunFailed: true });
    assert.equal(run.results[0]!.exitCode, 0);
    assert.ok(existsSync(join(d, 'seen')));
  });
});

// ───────────────────────────── compareGates ─────────────────────────────

function res(name: string, o: { exit?: number | null; failures?: string[] | null; count?: number | null; timedOut?: boolean } = {}): GateResult {
  const exit = o.exit === undefined ? (o.failures && o.failures.length > 0 ? 1 : 0) : o.exit;
  const failures = o.failures === undefined ? (exit === 0 ? [] : null) : o.failures;
  return {
    name,
    cmd: `run ${name}`,
    exitCode: exit,
    timedOut: o.timedOut ?? false,
    durationMs: 1,
    outputTail: '',
    failures,
    failureCount: o.count !== undefined ? o.count : failures ? failures.length : null,
  };
}
const gateRun = (...results: GateResult[]): GateRun => ({ at: 0, sha: 'x', results });
const passing = (n: string): GateResult => res(n, { exit: 0 });

describe('compareGates', () => {
  it('everything passes ⇒ passed only', () => {
    assert.deepEqual(compareGates(gateRun(passing('test')), gateRun(passing('test'), passing('lint'))), {
      regressions: [],
      preExisting: [],
      unverified: [],
      passed: ['test', 'lint'],
    });
  });

  it('no baseline / gate absent at baseline: a failing gate is a regression with all keys', () => {
    const cur = gateRun(res('test', { failures: ['t1', 't2'] }));
    assert.deepEqual(compareGates(null, cur).regressions, [{ gate: 'test', newFailures: ['t1', 't2'] }]);
    assert.deepEqual(compareGates(gateRun(passing('lint')), cur).regressions, [{ gate: 'test', newFailures: ['t1', 't2'] }]);
  });

  it('no baseline + unparseable failure ⇒ regression with note "unparseable"', () => {
    const cur = gateRun(res('test', { exit: 1, failures: null }));
    assert.deepEqual(compareGates(null, cur).regressions, [{ gate: 'test', newFailures: [], note: 'unparseable' }]);
  });

  it('baseline passed, now fails ⇒ regression with all failure keys (or unparseable)', () => {
    const base = gateRun(passing('test'), passing('lint'));
    const cur = gateRun(res('test', { failures: ['a', 'b'] }), res('lint', { exit: 1, failures: null }));
    assert.deepEqual(compareGates(base, cur).regressions, [
      { gate: 'test', newFailures: ['a', 'b'] },
      { gate: 'lint', newFailures: [], note: 'unparseable' },
    ]);
  });

  it('timeout now ⇒ regression (never silently passed)', () => {
    const cmp = compareGates(gateRun(passing('test')), gateRun(res('test', { exit: null, timedOut: true, failures: null })));
    assert.equal(cmp.regressions.length, 1);
    assert.equal(cmp.regressions[0]!.gate, 'test');
    assert.deepEqual(cmp.passed, []);
  });

  it('baseline-masking: baseline fails 2 tests, now 5 ⇒ regression lists exactly the 3 NEW names', () => {
    const base = gateRun(res('test', { failures: ['t1', 't2'] }));
    const cur = gateRun(res('test', { failures: ['t1', 't2', 't3', 't4', 't5'] }));
    const cmp = compareGates(base, cur);
    assert.deepEqual(cmp.regressions, [{ gate: 'test', newFailures: ['t3', 't4', 't5'] }]);
    assert.deepEqual(cmp.preExisting, []);
    assert.deepEqual(cmp.unverified, []);
  });

  it('baseline-masking (real node:test runs): 2 failing at baseline + 3 added by the builder ⇒ the 3 new names', async () => {
    const r = makeRepo({
      files: {
        'a.test.mjs': `import { test } from 'node:test';
test('pre-existing 1', () => { throw new Error('x'); });
test('pre-existing 2', () => { throw new Error('x'); });
test('fine', () => {});
`,
      },
    });
    const g = def('node --test', 'test', 'test');
    const baseline = await runGates([g], { cwd: r.dir, timeoutMs: 60_000 });
    assert.equal(baseline.results[0]!.failureCount, 2);

    writeFileSync(
      join(r.dir, 'a.test.mjs'),
      `import { test, describe } from 'node:test';
test('pre-existing 1', () => { throw new Error('x'); });
test('pre-existing 2', () => { throw new Error('x'); });
test('fine', () => {});
test('new bad 1', () => { throw new Error('y'); });
describe('suite', () => { test('new bad 2', () => { throw new Error('y'); }); test('new bad 3', () => { throw new Error('y'); }); });
`,
    );
    const current = await runGates([g], { cwd: r.dir, timeoutMs: 60_000 });
    assert.equal(current.results[0]!.failureCount, 5);
    const cmp = compareGates(baseline, current);
    assert.equal(cmp.regressions.length, 1);
    assert.deepEqual([...cmp.regressions[0]!.newFailures].sort(), ['new bad 1', 'suite > new bad 2', 'suite > new bad 3']);
  });

  it('baseline failing, nothing new (same or fewer failures) ⇒ preExisting only', () => {
    const base = gateRun(res('test', { failures: ['t1', 't2'] }));
    assert.deepEqual(compareGates(base, gateRun(res('test', { failures: ['t1', 't2'] }))), { regressions: [], preExisting: ['test'], unverified: [], passed: [] });
    assert.deepEqual(compareGates(base, gateRun(res('test', { failures: ['t2'] }))).preExisting, ['test']);
  });

  it('a renamed failing test counts as new (only that key is reported)', () => {
    const base = gateRun(res('test', { failures: ['old name', 'stays'] }));
    const cmp = compareGates(base, gateRun(res('test', { failures: ['new name', 'stays'] })));
    assert.deepEqual(cmp.regressions, [{ gate: 'test', newFailures: ['new name'] }]);
  });

  it('baseline failing + unparseable (either side) ⇒ unverified, not "pre-existing"', () => {
    const unparse = (c: number | null = null): GateResult => res('test', { exit: 1, failures: null, count: c });
    assert.deepEqual(compareGates(gateRun(unparse()), gateRun(unparse())), { regressions: [], preExisting: [], unverified: ['test'], passed: [] });
    assert.deepEqual(compareGates(gateRun(unparse()), gateRun(res('test', { failures: ['x'] }))).unverified, ['test']);
    assert.deepEqual(compareGates(gateRun(res('test', { failures: ['x'] })), gateRun(unparse())).unverified, ['test']);
  });

  it('unverified but failureCount increased ⇒ ALSO a regression with a note', () => {
    const cmp = compareGates(gateRun(res('test', { exit: 1, failures: null, count: 3 })), gateRun(res('test', { exit: 1, failures: null, count: 5 })));
    assert.deepEqual(cmp.unverified, ['test']);
    assert.equal(cmp.regressions.length, 1);
    assert.equal(cmp.regressions[0]!.gate, 'test');
    assert.deepEqual(cmp.regressions[0]!.newFailures, []);
    assert.match(cmp.regressions[0]!.note!, /increased from 3 to 5/);
    const same = compareGates(gateRun(res('test', { exit: 1, failures: null, count: 3 })), gateRun(res('test', { exit: 1, failures: null, count: 3 })));
    assert.deepEqual(same.regressions, []);
    const unknown = compareGates(gateRun(res('test', { exit: 1, failures: null, count: null })), gateRun(res('test', { exit: 1, failures: null, count: 9 })));
    assert.deepEqual(unknown.regressions, [], 'no baseline count ⇒ cannot claim an increase');
  });

  it('multiple gates are classified independently', () => {
    const base = gateRun(passing('typecheck'), res('lint', { failures: ['l1'] }), res('test', { exit: 1, failures: null }));
    const cur = gateRun(res('typecheck', { failures: ['TS1'] }), res('lint', { failures: ['l1'] }), res('test', { exit: 1, failures: null }), passing('extra'));
    assert.deepEqual(compareGates(base, cur), {
      regressions: [{ gate: 'typecheck', newFailures: ['TS1'] }],
      preExisting: ['lint'],
      unverified: ['test'],
      passed: ['extra'],
    });
  });
});
