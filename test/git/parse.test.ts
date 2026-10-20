import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFailures, stripAnsi } from '../../src/git/parse.ts';

// Fixtures marked (real) were captured from real tool runs on this machine (node 22.21, tsc 5.9, go 1.2x, cargo) and
// trimmed; the rest are hand-written from the tools' documented formats.

const TAP_REAL = `TAP version 13
# Subtest: suite A
    # Subtest: passes
    ok 1 - passes
      ---
      duration_ms: 0.290458
      type: 'test'
      ...
    # Subtest: fails one
    not ok 2 - fails one
      ---
      duration_ms: 0.454875
      type: 'test'
      location: '/work/a/t.test.mjs:5:3'
      failureType: 'testCodeFailure'
      error: |-
        Expected values to be strictly equal:

        1 !== 2

      code: 'ERR_ASSERTION'
      stack: |-
        TestContext.<anonymous> (file:///work/a/t.test.mjs:5:36)
      ...
    # Subtest: inner
        # Subtest: inner fails
        not ok 1 - inner fails
          ---
          duration_ms: 0.561791
          error: 'boom'
          ...
        # Subtest: inner ok
        ok 2 - inner ok
          ---
          duration_ms: 0.051875
          ...
        1..2
    not ok 3 - inner
      ---
      duration_ms: 0.694
      type: 'suite'
      failureType: 'subtestsFailed'
      error: '1 subtest failed'
      ...
    1..3
not ok 1 - suite A
  ---
  duration_ms: 1.939792
  type: 'suite'
  failureType: 'subtestsFailed'
  error: '2 subtests failed'
  ...
# Subtest: top fails
not ok 2 - top fails
  ---
  duration_ms: 2.399583
  error: |-
    The expression evaluated to a falsy value:

      assert.ok(false)

  ...
# Subtest: skipped
ok 3 - skipped # SKIP
  ---
  duration_ms: 0.048625
  ...
1..3
# tests 6
# suites 2
# pass 2
# fail 3
# cancelled 0
# skipped 1
# todo 0
`;

const SPEC_REAL = `▶ suite A
  ✔ passes (0.279ms)
  ✖ fails one (0.4415ms)
  ▶ inner
    ✖ inner fails (0.533125ms)
    ✔ inner ok (0.076542ms)
  ✖ inner (0.714625ms)
✖ suite A (1.939333ms)
✖ top fails (2.495542ms)
﹣ skipped (0.055292ms) # SKIP
ℹ tests 6
ℹ suites 2
ℹ pass 2
ℹ fail 3
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 52.470083
✖ failing tests:
test at t.test.mjs:5:3
✖ fails one (0.4415ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  1 !== 2
test at t.test.mjs:7:5
✖ inner fails (0.533125ms)
  Error: boom
test at t.test.mjs:11:1
✖ top fails (2.495542ms)
`;

const TSC_REAL = `a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.
a.ts(2,40): error TS2322: Type 'number' is not assignable to type 'string'.
`;

const TSC_PRETTY_REAL =
  '\u001b[96ma.ts\u001b[0m:\u001b[93m1\u001b[0m:\u001b[93m14\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2322: \u001b[0mType \'string\' is not assignable to type \'number\'.\n\n' +
  '\u001b[7m1\u001b[0m export const x: number = "str";\n\u001b[7m \u001b[0m \u001b[91m             ~\u001b[0m\n\n' +
  '\u001b[96ma.ts\u001b[0m:\u001b[93m2\u001b[0m:\u001b[93m40\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2322: \u001b[0mType \'number\' is not assignable to type \'string\'.\n\n' +
  'Found 2 errors in the same file, starting at: a.ts\u001b[90m:1\u001b[0m\n';

const GO_TEST_REAL = `--- FAIL: TestA (0.00s)
    --- FAIL: TestA/sub (0.00s)
        x_test.go:3: bad
--- FAIL: TestB (0.00s)
    x_test.go:4: nope
FAIL
FAIL\texample.com/x\t0.164s
FAIL
`;

const GO_BUILD_REAL = `# example.com/x [example.com/x.test]
./bad.go:2:23: undefined: undefinedVar
FAIL\texample.com/x [build failed]
FAIL
`;

const GO_VET_REAL = `# example.com/x
# [example.com/x]
vet: ./bad.go:2:23: undefined: undefinedVar
`;

const CARGO_TEST_REAL = `   Compiling x v0.1.0 (/work/rs)
    Finished \`test\` profile [unoptimized + debuginfo] target(s) in 3.28s
     Running unittests src/lib.rs (target/debug/deps/x-9a07b71f39cdf46f)

running 3 tests
test tests::ok ... ok
test tests::nested::deep_bad ... FAILED
test tests::bad ... FAILED

failures:

---- tests::nested::deep_bad stdout ----

thread 'tests::nested::deep_bad' (14532519) panicked at src/lib.rs:7:42:
x

failures:
    tests::bad
    tests::nested::deep_bad

test result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

error: test failed, to rerun pass \`--lib\`
`;

const CARGO_BUILD_REAL = `   Compiling x v0.1.0 (/work/rs)
error[E0425]: cannot find value \`missing_thing\` in this scope
 --> src/lib.rs:9:26
  |
9 | pub fn broken() -> i32 { missing_thing }
  |                          ^^^^^^^^^^^^^ not found in this scope

For more information about this error, try \`rustc --explain E0425\`.
error: could not compile \`x\` (lib test) due to 1 previous error
warning: build failed, waiting for other jobs to finish...
error: could not compile \`x\` (lib) due to 1 previous error
`;

const PYTEST = `============================= test session starts ==============================
platform darwin -- Python 3.13.0, pytest-8.3.0, pluggy-1.5.0
collected 6 items

tests/test_math.py .F.                                                   [ 50%]
tests/test_str.py F..                                                    [100%]

=================================== FAILURES ===================================
______________________________ test_add_wrong __________________________________
tests/test_math.py:7: in test_add_wrong
    assert add(1, 2) == 4
E   assert 3 == 4
=========================== short test summary info ============================
FAILED tests/test_math.py::test_add_wrong - assert 3 == 4
FAILED tests/test_str.py::TestK::test_m[1 - 2] - AssertionError: bad
ERROR tests/test_broken.py - ImportError: cannot import name 'x'
========================= 2 failed, 3 passed, 1 error in 0.12s =================
`;

const JEST = ` PASS  src/ok.test.js
 FAIL  src/math.test.js
  ● math › adds numbers

    expect(received).toBe(expected) // Object.is equality

    Expected: 4
    Received: 3

      5 |   expect(add(1, 2)).toBe(4);

      at Object.<anonymous> (src/math.test.js:5:23)

  ● math › nested › subtracts

    expect(received).toBe(expected) // Object.is equality

 FAIL  src/broken.test.js
  ● Test suite failed to run

    Cannot find module './nope' from 'src/broken.test.js'

Summary of all failing tests
 FAIL  src/math.test.js
  ● math › adds numbers

    expect(received).toBe(expected) // Object.is equality

Test Suites: 2 failed, 1 passed, 3 total
Tests:       2 failed, 3 passed, 5 total
`;

const VITEST = ` ❯ src/a.test.ts (3 tests | 1 failed) 5ms
   × math > adds 2ms
   ✓ math > subtracts

 FAIL  src/a.test.ts > math > adds
AssertionError: expected 3 to be 4

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
`;

const ESLINT = `
/work/repo/src/a.js
  3:7   error    'unused' is assigned a value but never used  no-unused-vars
  9:1   warning  Unexpected console statement                 no-console

/work/repo/src/b.js
  1:1  error  Parsing error: Unexpected token

✖ 3 problems (2 errors, 1 warning)
`;

describe('parseFailures: node:test', () => {
  it('(real) TAP: leaf failures only, nested ancestors kept, rollups/skips/yaml ignored', () => {
    const p = parseFailures('test', 'npm run test --silent', TAP_REAL);
    assert.deepEqual(p.failures, ['suite A > fails one', 'suite A > inner > inner fails', 'top fails']);
    assert.equal(p.count, 3);
  });

  it('(real) spec reporter gives the same keys', () => {
    const p = parseFailures('test', 'node --test --test-reporter=spec', SPEC_REAL);
    assert.deepEqual(p.failures, ['suite A > fails one', 'suite A > inner > inner fails', 'top fails']);
    assert.equal(p.count, 3);
  });

  it('TAP: a result-looking line inside a YAML block is not a test; TODO/SKIP failures are excused', () => {
    const out = `TAP version 13
not ok 1 - real failure
  ---
  error: |-
    not ok 99 - fake failure inside yaml
  ...
not ok 2 - expected failure # TODO fix later
ok 3 - skipped one # SKIP because
not ok 4 - name with # hash but no directive
1..4
# fail 3
`;
    const p = parseFailures('test', 'x', out);
    assert.deepEqual(p.failures, ['real failure', 'name with # hash but no directive']);
  });

  it('TAP: a failing test FILE (name is an absolute path) is keyed relative to cwd', () => {
    const out = `TAP version 13\nnot ok 1 - /work/repo/test/broken.test.ts\n  ---\n  failureType: 'testCodeFailure'\n  ...\n1..1\n# fail 1\n`;
    const p = parseFailures('test', 'x', out, { cwd: '/work/repo' });
    assert.deepEqual(p.failures, ['test/broken.test.ts']);
  });

  it('passing TAP output yields no failures', () => {
    const p = parseFailures('test', 'x', 'TAP version 13\nok 1 - a\nok 2 - b\n1..2\n# tests 2\n# pass 2\n# fail 0\n');
    assert.deepEqual(p, { failures: null, count: null });
  });

  it('baseline-masking input: 2 failing tests vs 5 failing tests parse to nested key sets', () => {
    const tap = (names: string[]): string => `TAP version 13\n${names.map((n, i) => `not ok ${i + 1} - ${n}`).join('\n')}\n1..${names.length}\n# fail ${names.length}\n`;
    const a = parseFailures('test', 'x', tap(['t1', 't2']));
    const b = parseFailures('test', 'x', tap(['t1', 't2', 't3', 't4', 't5']));
    assert.deepEqual(a.failures, ['t1', 't2']);
    assert.deepEqual(b.failures?.filter((k) => !a.failures!.includes(k)), ['t3', 't4', 't5']);
  });
});

describe('parseFailures: tsc', () => {
  it('(real) plain format: path + code + message, NO line/column', () => {
    const p = parseFailures('typecheck', 'npm run typecheck', TSC_REAL);
    assert.deepEqual(p.failures, [
      "a.ts TS2322 Type 'string' is not assignable to type 'number'.",
      "a.ts TS2322 Type 'number' is not assignable to type 'string'.",
    ]);
    for (const k of p.failures!) assert.doesNotMatch(k, /\(\d+,\d+\)|:\d+:\d+/);
    assert.equal(p.count, 2);
  });

  it('(real) --pretty format with ANSI colours produces the same keys', () => {
    const plain = parseFailures('typecheck', 'tsc', TSC_REAL).failures;
    const pretty = parseFailures('typecheck', 'tsc --pretty', TSC_PRETTY_REAL);
    assert.deepEqual(pretty.failures, plain);
    assert.match(stripAnsi(TSC_PRETTY_REAL), /error TS2322/);
  });

  it('baseline-line-shift: the same error at a different line/column (and in a different checkout dir) is the same key', () => {
    const base = parseFailures('typecheck', 'tsc', `/tmp/base-wt/src/a.ts(10,5): error TS2345: Argument of type 'x' is not assignable to 'y'.\n`, { cwd: '/tmp/base-wt' });
    const cur = parseFailures('typecheck', 'tsc', `/tmp/cur-wt/src/a.ts(47,13): error TS2345: Argument of type 'x' is not assignable to 'y'.\n`, { cwd: '/tmp/cur-wt' });
    assert.deepEqual(base.failures, ['src/a.ts TS2345 Argument of type \'x\' is not assignable to \'y\'.']);
    assert.deepEqual(cur.failures, base.failures);
  });

  it('duplicates stay distinguishable without line numbers (occurrence index)', () => {
    const out = `a.ts(1,1): error TS2304: Cannot find name 'q'.\na.ts(9,1): error TS2304: Cannot find name 'q'.\nb.ts(1,1): error TS2304: Cannot find name 'q'.\n`;
    assert.deepEqual(parseFailures('typecheck', 'tsc', out).failures, [
      "a.ts TS2304 Cannot find name 'q'.",
      "a.ts TS2304 Cannot find name 'q'. (#2)",
      "b.ts TS2304 Cannot find name 'q'.",
    ]);
  });

  it('global errors without a file and the summary-only count', () => {
    assert.deepEqual(parseFailures('typecheck', 'tsc', "error TS5083: Cannot read file '/x/tsconfig.json'.\n").failures, [
      "TS5083 Cannot read file '/x/tsconfig.json'.",
    ]);
    assert.deepEqual(parseFailures('typecheck', 'tsc', 'Found 3 errors.\n'), { failures: null, count: 3 });
  });
});

describe('parseFailures: eslint', () => {
  it('stylish: rule + path + message, errors only, no line numbers, cwd stripped', () => {
    const p = parseFailures('lint', 'npm run lint', ESLINT, { cwd: '/work/repo' });
    assert.deepEqual(p.failures, [
      "src/a.js no-unused-vars 'unused' is assigned a value but never used",
      'src/b.js Parsing error: Unexpected token',
    ]);
    assert.equal(p.count, 2);
  });

  it('baseline-line-shift for eslint', () => {
    const at = (l: number): string => `/work/repo/src/a.js\n  ${l}:7  error  'x' is defined but never used  no-unused-vars\n`;
    assert.deepEqual(parseFailures('lint', 'eslint .', at(3), { cwd: '/work/repo' }).failures, parseFailures('lint', 'eslint .', at(300), { cwd: '/work/repo' }).failures);
  });

  it('warnings alone are not failures; compact and unix formats work', () => {
    const warnOnly = `/work/repo/src/a.js\n  9:1  warning  Unexpected console statement  no-console\n\n✖ 1 problem (0 errors, 1 warning)\n`;
    assert.deepEqual(parseFailures('lint', 'eslint .', warnOnly), { failures: null, count: null });
    const compact = `/w/a.js: line 3, col 7, Error - 'x' is defined but never used (no-unused-vars)\n/w/a.js: line 9, col 1, Warning - Unexpected console statement (no-console)\n`;
    assert.deepEqual(parseFailures('lint', 'eslint -f compact', compact).failures, ["/w/a.js no-unused-vars 'x' is defined but never used"]);
    const unix = `/w/a.js:3:7: 'x' is defined but never used [Error/no-unused-vars]\n/w/a.js:9:1: Unexpected console statement [Warning/no-console]\n`;
    assert.deepEqual(parseFailures('lint', 'eslint -f unix', unix).failures, ["/w/a.js no-unused-vars 'x' is defined but never used"]);
  });
});

describe('parseFailures: jest / vitest / pytest', () => {
  it('jest: ● blocks (deduped), suite-failed-to-run, file prefix, summary count', () => {
    const p = parseFailures('test', 'jest', JEST);
    assert.deepEqual(p.failures, [
      'src/math.test.js > math > adds numbers',
      'src/math.test.js > math > nested > subtracts',
      'src/broken.test.js suite failed to run',
    ]);
    assert.equal(p.count, 3);
  });

  it('jest: summary without parseable blocks gives count only', () => {
    assert.deepEqual(parseFailures('test', 'jest', 'Tests:       3 failed, 5 passed, 8 total\n'), { failures: null, count: 3 });
  });

  it('vitest: FAIL file > suite > test', () => {
    const p = parseFailures('test', 'vitest run', VITEST);
    assert.deepEqual(p.failures, ['src/a.test.ts > math > adds']);
  });

  it('pytest: FAILED path::name keys (message and bracketed params preserved), ERROR entries, summary count', () => {
    const p = parseFailures('test', 'python3 -m pytest -q -rf', PYTEST);
    assert.deepEqual(p.failures, ['tests/test_math.py::test_add_wrong', 'tests/test_str.py::TestK::test_m[1 - 2]', 'ERROR tests/test_broken.py']);
    assert.equal(p.count, 3);
  });

  it('pytest -q without the "=" decoration still yields the summary count', () => {
    assert.deepEqual(parseFailures('test', 'pytest', '..F\n2 failed, 5 passed in 0.31s\n'), { failures: null, count: 2 });
  });
});

describe('parseFailures: go / cargo', () => {
  it('(real) go test: leaf tests keyed by package (parent test dropped when a subtest failed)', () => {
    const p = parseFailures('test', 'go test ./...', GO_TEST_REAL);
    assert.deepEqual(p.failures, ['example.com/x TestA/sub', 'example.com/x TestB']);
  });

  it('(real) go build failure: compile error without line/col + package marker', () => {
    const p = parseFailures('test', 'go test ./...', GO_BUILD_REAL);
    assert.deepEqual(p.failures, ['bad.go undefined: undefinedVar', 'example.com/x [build failed]']);
  });

  it('(real) go vet', () => {
    const p = parseFailures('lint', 'go vet ./...', GO_VET_REAL);
    assert.deepEqual(p.failures, ['bad.go undefined: undefinedVar']);
  });

  it('go: baseline-line-shift', () => {
    const at = (l: number, c: number): string => `# p\n./x.go:${l}:${c}: undefined: foo\nFAIL\tp [build failed]\n`;
    assert.deepEqual(parseFailures('test', 'go test', at(2, 3)).failures, parseFailures('test', 'go test', at(80, 14)).failures);
  });

  it('(real) cargo test: failed test paths and the summary count', () => {
    const p = parseFailures('test', 'cargo test', CARGO_TEST_REAL);
    assert.deepEqual(p.failures, ['tests::nested::deep_bad', 'tests::bad']);
  });

  it('(real) cargo compile error: file + code + message (no line), rollup errors ignored', () => {
    const p = parseFailures('test', 'cargo test', CARGO_BUILD_REAL);
    assert.deepEqual(p.failures, ['src/lib.rs E0425 cannot find value `missing_thing` in this scope']);
  });

  it('cargo: baseline-line-shift', () => {
    const at = (l: number): string => `error[E0425]: cannot find value \`q\` in this scope\n --> src/lib.rs:${l}:26\n`;
    assert.deepEqual(parseFailures('test', 'cargo test', at(9)).failures, parseFailures('test', 'cargo test', at(900)).failures);
  });
});

describe('parseFailures: unknown formats', () => {
  it('returns failures:null and count:null when nothing is recognisable', () => {
    assert.deepEqual(parseFailures('test', 'make check', 'Something exploded\nat foo.c:12\nmake: *** [check] Error 2\n'), { failures: null, count: null });
    assert.deepEqual(parseFailures('other', 'x', ''), { failures: null, count: null });
    assert.deepEqual(parseFailures('build', 'make', 'ld: symbol(s) not found\n'), { failures: null, count: null });
  });

  it('never throws on binary / huge garbage', () => {
    const junk = '\u0000\u0001✖ ▶ not ok \n'.repeat(20_000);
    const p = parseFailures('test', 'x', junk);
    assert.ok(p.failures === null || Array.isArray(p.failures));
  });
});
