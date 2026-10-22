// The release pipeline runs with a write token on every push to main, so its workflows are checked statically: no expression
// injection into shell steps, no pull_request_target, pinned actions, one writing job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { checkDir, findViolations } from '../../scripts/check-workflows.ts';

const OK = `name: x
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
      - uses: ./.github/workflows/ci.yml
      - env:
          MSG: \${{ github.event.head_commit.message }}
        run: echo "$MSG"
`;

test('the real workflows pass the gate', () => {
  assert.deepEqual(checkDir(join(import.meta.dirname, '..', '..', '.github', 'workflows')), []);
});

test('a clean workflow passes', () => {
  assert.deepEqual(findViolations('ok.yml', OK), []);
});

test('an expression inside a block run: is rejected', () => {
  const bad = OK.replace('run: echo "$MSG"', 'run: |\n          echo "${{ github.event.head_commit.message }}"');
  assert.match(findViolations('bad.yml', bad).join('\n'), /interpolated into run/);
});

test('an expression inside an inline run: is rejected', () => {
  assert.match(findViolations('bad.yml', OK.replace('run: echo "$MSG"', 'run: echo ${{ github.head_ref }}')).join('\n'), /interpolated into run/);
});

test('pull_request_target, a missing permissions block, an unpinned action and two writers are rejected', () => {
  assert.match(findViolations('a.yml', OK.replace('name: x', 'name: x\non:\n  pull_request_target:')).join('\n'), /pull_request_target/);
  assert.match(findViolations('b.yml', OK.replace('permissions:\n  contents: read\n', '')).join('\n'), /permissions/);
  assert.match(findViolations('c.yml', OK.replace('@11d5960a326750d5838078e36cf38b85af677262', '@v4')).join('\n'), /not pinned/);
  assert.match(findViolations('d.yml', `${OK}    permissions:\n      contents: write\n    x:\n      permissions:\n        contents: write\n`).join('\n'), /granted 2 times/);
});
