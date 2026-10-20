// AC1 (mechanical): Linear is not part of the runtime. No source file imports anything from a linear/ folder or the old shim,
// the Linear modules are gone, and the only remaining mentions are the importer's/migrations' deliberate handling of OLD data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n.startsWith('.')) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|js)$/.test(n)) out.push(p);
  }
  return out;
}

test('no module imports from a linear/ folder (or requires one) anywhere in src, test, ui, dev or bin', () => {
  const bad: string[] = [];
  for (const dir of ['src', 'test', 'ui', 'dev', 'bin']) {
    if (!existsSync(join(ROOT, dir))) continue;
    for (const f of walk(join(ROOT, dir))) {
      if (f.endsWith('import-graph.test.ts')) continue;
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(?:import|export)[^;\n]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? '';
        if (/(^|\/)linear(\/|\.|$)/i.test(spec) || /(^|\/)legacy\//.test(spec)) bad.push(`${relative(ROOT, f)} → ${spec}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('the Linear code, its tests, mocks and the vendored schema are gone; graphql is no longer a dependency', () => {
  for (const p of ['src/linear', 'test/linear', 'test/helpers/mock-linear-server.ts', 'test/fixtures/linear-schema.graphql']) assert.equal(existsSync(join(ROOT, p)), false, p);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.devDependencies?.graphql, undefined);
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], 'still zero runtime dependencies');
});

test('"Linear" survives only where OLD data is handled on purpose (importer, migrations, validation, redaction shape, board link type)', () => {
  const allowed = new Set(['src/migrate.ts', 'src/schema/run-migrations.ts', 'src/config.ts', 'src/board/types.ts', 'src/board/validate.ts', 'src/board/store.ts', 'src/redact.ts', 'src/cli.ts', 'src/types.ts', 'src/agents/env.ts', 'src/git/exec.ts', 'src/paths.ts']);
  const offenders = walk(join(ROOT, 'src'))
    .map((f) => relative(ROOT, f))
    .filter((f) => /linear/i.test(readFileSync(join(ROOT, f), 'utf8')) && !allowed.has(f));
  assert.deepEqual(offenders, []);
  // and the UI / prompts carry no Linear wording at all
  for (const f of ['ui/app.js', 'ui/index.html']) assert.equal(/linear/i.test(readFileSync(join(ROOT, f), 'utf8')), false, f);
  for (const f of readdirSync(join(ROOT, 'prompts'))) assert.equal(/linear/i.test(readFileSync(join(ROOT, 'prompts', f), 'utf8')), false, `prompts/${f}`);
});
