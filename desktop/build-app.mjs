// Builds the app payload the Electron shell runs: the TypeScript server compiled to plain JS (so it does not depend on the embedded Node's
// type stripping), plus ui/ and prompts/. Output: desktop/app/. No dependency is bundled — the app has none.
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(here, 'payload');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', join(root, 'tsconfig.build.json')], { cwd: root, stdio: 'inherit' });
cpSync(join(root, 'ui'), join(out, 'ui'), { recursive: true });
cpSync(join(root, 'prompts'), join(out, 'prompts'), { recursive: true });
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'conductor-app', version: pkg.version, type: 'module', private: true }, null, 2) + '\n');
console.log('app payload built in', out);
