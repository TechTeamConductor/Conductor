/**
 * F1 — Claude settings isolation (Security A+C).
 * A: neutralize project `<cwd>/.claude/settings*.json` around a spawn (lstat/no-follow; quarantine+restore).
 * C: refuse default-account config-dir settings that carry `apiKeyHelper` or any `env` object.
 * Messages name an entry CLASS only — never a path, script body, or secret.
 */
import { mkdirSync, renameSync, lstatSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export const PROJECT_SETTINGS_NAMES = ['settings.json', 'settings.local.json', 'managed-settings.json'] as const;
const SETTINGS_MAX = 1024 * 1024;
const QUARANTINE_DIR = '.conductor-v2-quarantine';

export class ClaudeSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeSettingsError';
  }
}

const own = (o: unknown, k: string): unknown =>
  o !== null && typeof o === 'object' && !Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined;

/** Size-capped parse: refuse on `apiKeyHelper` or any own-property `env` object. */
export function checkSettingsRisky(text: string): string | null {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return 'an unreadable settings file';
  }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return 'an unreadable settings file';
  if (own(j, 'apiKeyHelper') !== undefined) return 'a key helper in a settings file';
  const env = own(j, 'env');
  if (env === undefined) return null;
  // Security C (narrowed 2026-10-22, user-approved): an env block is allowed only when EVERY entry is a known-safe kind. Null/array/other → refuse.
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return 'environment settings in a settings file';
  for (const k of Object.keys(env)) {
    if (!envEntrySafe(k, (env as Record<string, unknown>)[k])) return 'environment settings in a settings file';
  }
  return null;
}

/** Variables that can move credentials, change endpoints, load code or alter trust — never allowed from a settings file. */
const SENSITIVE_ENV = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CONFIG_DIR$|AWS_|GOOGLE_|GCLOUD|VERTEX|AZURE|OPENAI|NODE_|NPM_|LD_|DYLD_|PATH$|HOME$|SHELL$|SSL_|REQUESTS_CA|CURL_CA|OTEL_)|(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PROXY|CERT|HELPER|URL|URI|ENDPOINT|HOST|AUTH|CRED)/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * One env entry from a settings file. Safe = a plain UPPER_SNAKE name with a short string value that is NOT sensitive, or
 * `ANTHROPIC_BASE_URL` pointing at this machine (loopback http/https, e.g. a local proxy such as Headroom). Everything else refuses.
 */
export function envEntrySafe(key: string, value: unknown): boolean {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) return false;
  if (typeof value !== 'string' || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (key === 'ANTHROPIC_BASE_URL') {
    let u: URL;
    try {
      u = new URL(value);
    } catch {
      return false;
    }
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.has(u.hostname) && u.username === '' && u.password === '';
  }
  // Security ruling (allow-list): only plain ENABLE_/DISABLE_ on/off switches with a short inert value; the deny-list stays as a second filter.
  // Any other variable is added by exact name only, after a Security note.
  if (!/^(ENABLE|DISABLE)_[A-Z0-9_]{1,58}$/.test(key)) return false;
  if (!/^[A-Za-z0-9_.,:-]{0,64}$/.test(value)) return false;
  return !SENSITIVE_ENV.test(key);
}

/** Config dir the Claude child will use (same resolution as the CLI). */
export function resolveClaudeConfigDir(env: Record<string, string>): string {
  const fromEnv = env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === 'string' && fromEnv.length) return fromEnv;
  const home = env.HOME || homedir();
  return join(home, '.claude');
}

/**
 * C — refuse before spawn when the config dir's settings files (or `.claude.json`) carry a helper / env block.
 * Does not mutate the user's config dir.
 */
export function assertClaudeConfigDirSafe(env: Record<string, string>): void {
  const dir = resolveClaudeConfigDir(env);
  for (const name of PROJECT_SETTINGS_NAMES) {
    const p = join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) throw new ClaudeSettingsError('a link in place of a settings file');
    if (!st.isFile() || st.nlink !== 1) throw new ClaudeSettingsError('a settings file Conductor cannot trust');
    if (st.size > SETTINGS_MAX) throw new ClaudeSettingsError('an oversized settings file');
    const bad = checkSettingsRisky(readFileSync(p, 'utf8'));
    if (bad) throw new ClaudeSettingsError(bad);
  }
  // defence in depth: `.claude.json` helper/env (named-account rules) — links/hardlinks refuse (fail closed)
  const cj = join(dir, '.claude.json');
  let st;
  try {
    st = lstatSync(cj);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) throw new ClaudeSettingsError('a link in place of a settings file');
  if (!st.isFile() || st.nlink !== 1) throw new ClaudeSettingsError('a settings file Conductor cannot trust');
  if (st.size > SETTINGS_MAX) throw new ClaudeSettingsError('an oversized .claude.json');
  let j: unknown;
  try {
    j = JSON.parse(readFileSync(cj, 'utf8'));
  } catch {
    return;
  }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return;
  if (own(j, 'apiKeyHelper') !== undefined) throw new ClaudeSettingsError('a key helper in .claude.json');
  if (own(j, 'env') !== undefined) throw new ClaudeSettingsError('environment settings in .claude.json');
}

type Quarantined = { from: string; to: string };

type CwdLock = { chain: Promise<unknown>; n: number };
const cwdLocks = new Map<string, CwdLock>();

async function withCwdLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(cwd);
  let entry = cwdLocks.get(key);
  if (!entry) {
    entry = { chain: Promise.resolve(), n: 0 };
    cwdLocks.set(key, entry);
  }
  entry.n++;
  const prev = entry.chain;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  entry.chain = prev.then(
    () => gate,
    () => gate,
  );
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    entry.n--;
    if (entry.n === 0 && cwdLocks.get(key) === entry) cwdLocks.delete(key);
  }
}

function quarantineOne(cwd: string, name: string, qDir: string): Quarantined | 'skip' {
  const from = join(cwd, '.claude', name);
  let st;
  try {
    st = lstatSync(from);
  } catch {
    return 'skip';
  }
  if (st.isSymbolicLink()) throw new ClaudeSettingsError('a link in place of a settings file');
  if (!st.isFile()) throw new ClaudeSettingsError('a settings file Conductor cannot trust');
  if (st.nlink !== 1) throw new ClaudeSettingsError('a hard-linked settings file');
  mkdirSync(qDir, { recursive: true, mode: 0o700 });
  const to = join(qDir, `${name}.${randomBytes(8).toString('hex')}`);
  renameSync(from, to);
  return { from, to };
}

function restoreOne(q: Quarantined): void {
  try {
    if (existsSync(q.from)) {
      // something else recreated the path — leave the quarantine copy; do not overwrite
      try {
        unlinkSync(q.to);
      } catch {
        /* keep */
      }
      return;
    }
    renameSync(q.to, q.from);
  } catch {
    /* best-effort restore */
  }
}

/**
 * A — quarantine project settings for the duration of `fn`, then restore in `finally`.
 * Empty / missing `.claude` → no-op. Symlink/hardlink → throw (zero spawn).
 */
export async function withProjectSettingsNeutralized<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  return withCwdLock(cwd, async () => {
    const qDir = join(cwd, QUARANTINE_DIR);
    const moved: Quarantined[] = [];
    try {
      for (const name of PROJECT_SETTINGS_NAMES) {
        const r = quarantineOne(cwd, name, qDir);
        if (r !== 'skip') moved.push(r);
      }
      return await fn();
    } finally {
      for (const q of moved.reverse()) restoreOne(q);
    }
  });
}
