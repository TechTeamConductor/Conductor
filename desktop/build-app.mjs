// Builds the app payload the Electron shell runs: the TypeScript server compiled to plain JS (so it does not depend on the embedded Node's
// type stripping), plus ui/ and prompts/. Output: desktop/app/. No dependency is bundled — the app has none.
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(here, 'payload');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// tsc is run through Node itself (not node_modules/.bin/tsc, which is a .cmd shim on Windows).
const tsc = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json')], { cwd: root, stdio: 'inherit' });
cpSync(join(root, 'ui'), join(out, 'ui'), { recursive: true });
cpSync(join(root, 'prompts'), join(out, 'prompts'), { recursive: true });
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// Release builds pass the version in CONDUCTOR_VERSION (the git tag is the source of truth). It must be a plain X.Y.Z or the build fails;
// without it (local dev builds) the root package.json version is used.
const stamped = process.env.CONDUCTOR_VERSION;
if (stamped !== undefined && stamped !== '' && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(stamped)) throw new Error('CONDUCTOR_VERSION must be X.Y.Z, got ' + JSON.stringify(stamped));
if (process.env.CONDUCTOR_REQUIRE_VERSION === '1' && !stamped) throw new Error('CONDUCTOR_VERSION is required for release builds');
const version = stamped || pkg.version;
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'conductor-app', version, type: 'module', private: true }, null, 2) + '\n');
console.log('app payload built in', out);
