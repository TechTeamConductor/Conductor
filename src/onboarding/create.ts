// Safe project creation (M6 §2b-2, Security M6-S4) and the one-constant sample project. Writes to the user's disk from an HTTP body, so:
// the name and the parent are validated first (absolute, exists, a directory, owned by the user, no symlink in the chain, not `/`, not the
// home itself, not inside the Conductor home or a system directory); `mkdir` is NON-recursive (an existing target is refused); git runs with a
// hardened environment (no global/system config, empty template, no hooks); the identity is argv-validated; a failure removes ONLY what
// Conductor created (dev/ino verified). No remote, no push.
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep, isAbsolute } from 'node:path';
import { paths } from '../paths.ts';

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export class CreateError extends Error {}
const SYSTEM_DIRS = ['/', '/etc', '/usr', '/bin', '/sbin', '/var', '/System', '/Library', '/private/etc', '/private/var/db', '/private/var/root', '/dev', '/proc', '/sys', '/boot', '/opt'];
const ID_RE = /^(?!-)[^\n\r<>\p{Cc}\p{Cf}]{1,100}$/u;
export interface Identity { name: string; email: string }
export const CONDUCTOR_IDENTITY: Identity = { name: 'Conductor', email: 'conductor@localhost' };
export function validateIdentity(i: unknown): Identity {
  const o = i as Partial<Identity> | undefined;
  if (!o || typeof o.name !== 'string' || typeof o.email !== 'string' || !ID_RE.test(o.name) || !ID_RE.test(o.email) || !o.email.includes('@')) throw new CreateError('The name or e-mail for the first commit is not valid.');
  return { name: o.name.trim(), email: o.email.trim() };
}

const gitEnv = (hooks: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TEMPLATE_DIR: '',
});
function git(cwd: string, args: string[], id: Identity, hooks: string): string {
  return execFileSync('git', ['-c', `user.name=${id.name}`, '-c', `user.email=${id.email}`, '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${hooks}`, ...args], { cwd, env: gitEnv(hooks), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
}

function checkParent(parent: string): string {
  if (typeof parent !== 'string' || !isAbsolute(parent) || /[\u0000-\u001f]/.test(parent)) throw new CreateError('The parent folder must be a full path.');
  let real: string;
  try {
    real = realpathSync(parent);
  } catch {
    throw new CreateError('The parent folder does not exist.');
  }
  if (resolve(parent) !== real) throw new CreateError('The parent folder path contains a link — use the real path.');
  const st = statSync(real);
  if (!st.isDirectory()) throw new CreateError('The parent is not a folder.');
  const home = realpathSync(homedir());
  const conductor = (() => { try { return realpathSync(paths.home()); } catch { return resolve(paths.home()); } })();
  if (real === home || SYSTEM_DIRS.includes(real) || SYSTEM_DIRS.some((d) => d !== '/' && real.startsWith(d + sep))) throw new CreateError('Choose a folder for your projects (not a system folder or your home folder itself).');
  if (real === conductor || real.startsWith(conductor + sep)) throw new CreateError('A project cannot live inside the Conductor data folder.');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new CreateError('The parent folder is not yours.');
  // a target inside another git work tree is refused
  for (let d = real; d !== resolve(d, '..'); d = resolve(d, '..')) if (existsSync(join(d, '.git'))) throw new CreateError('That folder is already inside a git repository.');
  return real;
}

/** Create `<parent>/<name>` as a new git repository with one initial commit. Returns the real path. */
export function createProject(input: { parent: unknown; name: unknown; identity?: unknown; readme?: string }): { path: string } {
  if (typeof input.name !== 'string' || !NAME_RE.test(input.name)) throw new CreateError('A project name may use letters, numbers, dots, dashes and underscores (up to 64).');
  const parent = checkParent(input.parent as string);
  const id = input.identity === undefined ? CONDUCTOR_IDENTITY : validateIdentity(input.identity);
  const target = join(parent, input.name);
  let made: { dev: number; ino: number } | null = null;
  try {
    mkdirSync(target, { mode: 0o755 }); // NOT recursive: an existing target fails with EEXIST
    const st = lstatSync(target);
    made = { dev: st.dev, ino: st.ino };
    if (realpathSync(target) !== join(parent, input.name)) throw new CreateError('The new folder resolved somewhere unexpected.');
    const hooks = join(target, '.git-empty-hooks-never-created');
    git(target, ['init', '-q', '-b', 'main', '--template='], id, hooks);
    writeFileSync(join(target, 'README.md'), `# ${input.name}\n\nCreated with Conductor.\n`, { flag: 'wx' });
    git(target, ['config', '--local', 'user.name', id.name], id, hooks);
    git(target, ['config', '--local', 'user.email', id.email], id, hooks);
    git(target, ['add', '-A'], id, hooks);
    git(target, ['commit', '-q', '-m', 'Initial commit'], id, hooks);
    return { path: realpathSync(target) };
  } catch (e) {
    if (made) {
      try {
        const st = lstatSync(target);
        if (st.dev === made.dev && st.ino === made.ino) rmSync(target, { recursive: true, force: true }); // only what we made
      } catch { /* already gone */ }
    }
    if (e instanceof CreateError) throw e;
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new CreateError('That folder already exists — choose another name.');
    throw new CreateError(`Could not create the project: ${String((e as Error).message ?? e).split('\n')[0]!.slice(0, 160)}`);
  }
}

// ───────────────────────── the sample project ─────────────────────────
export const SAMPLE_KEY = 'SAMPLE';
export const sampleDir = (): string => join(realpathSync(homedir()), 'Conductor-Sample');
export const SAMPLE_FILES: Readonly<Record<string, string>> = Object.freeze({
  'package.json': JSON.stringify({ name: 'conductor-sample', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'greeting.mjs': 'export function greeting(name) {\n  return `Hello, ${name}!`;\n}\n',
  'greeting.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greeting } from './greeting.mjs';\n\ntest('greeting', () => assert.equal(greeting('World'), 'Hello, World!'));\n",
  'README.md': '# Conductor sample\n\nA tiny project to try Conductor on. Its one test passes.\n',
});
export const SAMPLE_TASK = { title: 'Add a farewell function', description: 'Add `farewell(name)` to greeting.mjs returning "Goodbye, <name>!" and add a test for it.' };

/** Parameterless on purpose: the path is derived, never taken from a request. Refuses a folder that exists with other content. */
export function createSample(): { path: string; created: boolean } {
  const dir = sampleDir();
  if (existsSync(dir)) {
    const names = readdirSync(dir).filter((n) => n !== '.git').sort();
    const same = names.join() === Object.keys(SAMPLE_FILES).sort().join() && Object.entries(SAMPLE_FILES).every(([n, c]) => { try { return readFileSync(join(dir, n), 'utf8') === c; } catch { return false; } });
    if (!same || !existsSync(join(dir, '.git'))) throw new CreateError('A folder named Conductor-Sample already exists and is not the sample project — Conductor will not touch it.');
    return { path: realpathSync(dir), created: false };
  }
  const parent = realpathSync(homedir());
  mkdirSync(dir, { mode: 0o755 });
  try {
    const hooks = join(dir, '.git-empty-hooks-never-created');
    git(dir, ['init', '-q', '-b', 'main', '--template='], CONDUCTOR_IDENTITY, hooks);
    for (const [n, c] of Object.entries(SAMPLE_FILES)) writeFileSync(join(dir, n), c, { flag: 'wx' });
    for (const [k, v] of [['user.name', CONDUCTOR_IDENTITY.name], ['user.email', CONDUCTOR_IDENTITY.email]] as const) git(dir, ['config', '--local', k, v], CONDUCTOR_IDENTITY, hooks);
    git(dir, ['add', '-A'], CONDUCTOR_IDENTITY, hooks);
    git(dir, ['commit', '-q', '-m', 'Initial commit'], CONDUCTOR_IDENTITY, hooks);
    void parent;
    return { path: realpathSync(dir), created: true };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new CreateError(`Could not create the sample project: ${String((e as Error).message ?? e).split('\n')[0]!.slice(0, 160)}`);
  }
}
