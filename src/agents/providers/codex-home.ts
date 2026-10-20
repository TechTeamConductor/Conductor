// Conductor's PRIVATE Codex home (M2, Security conditions 2/3/8). The user's real ~/.codex — config.toml, hooks, rules, MCP servers,
// credentials — is never loaded, linked, copied or read: Codex runs with CODEX_HOME pointing here and HOME pointing at a throw-away
// empty directory. Before every run the home is checked (hygiene pre-flight): anything that could carry instructions or code that
// Conductor did not put there makes the run refuse with errorKind 'isolation'.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { conductorHome } from '../../paths.ts';
import { sha256 } from '../../util.ts';

export function codexHomePath(): string {
  return join(conductorHome(), 'providers', 'codex-home');
}

/** The ONLY thing Conductor writes into the private home besides the credential file Codex creates on `codex login`. Login-time only: exec never relies on it. */
export const CODEX_CONFIG_TOML = '# Written by Conductor. Do not edit: it is rewritten before every Codex run.\ncli_auth_credentials_store = "file"\n';
const CONFIG_SHA = sha256(CODEX_CONFIG_TOML);

/**
 * Entries Codex is known to create for itself in its home. Anything else — notably hooks*, rules, skills, prompts, plugins, memories,
 * AGENTS.md / agents.override.md, mcp* — is treated as planted and refused (fail closed; the message names it and how to clear it).
 */
export const CODEX_HOME_ALLOWED: ReadonlySet<string> = new Set([
  'auth.json', 'config.toml', 'history.jsonl', 'log', 'logs', 'sessions', 'archived_sessions', 'version.json', 'installation_id', 'cache', 'tmp', '.tmp', 'models_cache.json', 'shell_snapshots',
  '.personality_migration', 'logs_2.sqlite', 'logs_2.sqlite-shm', 'logs_2.sqlite-wal',
]);
/** Directories Codex creates for itself (seen on a real install) that CAN carry instructions or rules: allowed only while EMPTY. */
export const CODEX_HOME_EMPTY_ONLY: ReadonlySet<string> = new Set(['memories', 'rules']);

export interface HomeCheck {
  ok: boolean;
  problem?: string;
}

const uid = (): number | null => (typeof process.getuid === 'function' ? process.getuid() : null);

/** Create (0700) / verify the private home and rewrite its config. Never follows a symlink; never trusts an unexpected entry. */
/** Regenerable entries Codex recreates itself; they can only carry stale or planted text, so they are removed before each run (under the home lock). */
const REGENERABLE = ['models_cache.json', 'shell_snapshots', 'cache', 'tmp', '.tmp'];

export function prepareCodexHome(home: string = codexHomePath(), opts: { purge?: boolean } = {}): HomeCheck {
  try {
    const parent = join(home, '..');
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (!existsSync(home)) mkdirSync(home, { mode: 0o700 });
    const st = lstatSync(home);
    if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, problem: `${home} is not a plain directory (symbolic link or file)` };
    const me = uid();
    if (me !== null && st.uid !== me) return { ok: false, problem: `${home} is owned by another user` };
    if ((st.mode & 0o077) !== 0) chmodSync(home, 0o700);
    if ((lstatSync(home).mode & 0o077) !== 0) return { ok: false, problem: `${home} is accessible to other users and could not be tightened` };

    if (opts.purge) for (const n of REGENERABLE) rmSync(join(home, n), { recursive: true, force: true });
    const names = readdirSync(home);
    const stray = names.filter((n) => !CODEX_HOME_ALLOWED.has(n) && !CODEX_HOME_EMPTY_ONLY.has(n));
    if (stray.length) return { ok: false, problem: `the private Codex home holds entries Conductor did not put there (${stray.slice(0, 5).map((n) => JSON.stringify(n.slice(0, 40))).join(', ')}); move them out of ${home} to continue` };
    for (const n of names) {
      if (lstatSync(join(home, n)).isSymbolicLink()) return { ok: false, problem: `${join(home, n)} is a symbolic link` };
    }
    for (const n of names) {
      if (!CODEX_HOME_EMPTY_ONLY.has(n)) continue;
      const st2 = lstatSync(join(home, n));
      if (!st2.isDirectory() || readdirSync(join(home, n)).length > 0) return { ok: false, problem: `${join(home, n)} must be an empty directory (it can carry instructions or rules Conductor did not write); move its contents out to continue` };
    }
    const auth = join(home, 'auth.json');
    if (existsSync(auth)) {
      const a = lstatSync(auth);
      if (!a.isFile()) return { ok: false, problem: `${auth} is not a regular file` };
      if ((a.mode & 0o077) !== 0) chmodSync(auth, 0o600);
    }
    const cfg = join(home, 'config.toml');
    let same = false;
    try {
      same = existsSync(cfg) && lstatSync(cfg).isFile() && sha256(readFileSync(cfg)) === CONFIG_SHA;
    } catch {
      same = false;
    }
    if (!same) {
      rmSync(cfg, { force: true });
      writeFileSync(cfg, CODEX_CONFIG_TOML, { mode: 0o600 });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, problem: `the private Codex home could not be prepared (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  }
}

/** A throw-away EMPTY directory used as the child's HOME for ONE run (so `~/.codex`, `~/.agents`, `~/.config` of the user never exist for it). */
export function makeScratchHome(): { dir: string; dispose(): void } {
  const base = join(conductorHome(), 'providers', 'tmp');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(base, 'home-'));
  return {
    dir,
    dispose() {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a leftover empty scratch dir is harmless */
      }
    },
  };
}
export function scratchTmp(): { dir: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-codex-'));
  chmodSync(dir, 0o700);
  return { dir, dispose: () => void rmSync(dir, { recursive: true, force: true }) };
}

/** Runs against ONE private home are serialised (a queue of 1): two Codex processes never share it, and the canary uses the same lock. */
const queues = new Map<string, Promise<unknown>>();
export function withCodexHomeLock<T>(fn: () => Promise<T>, key: string = codexHomePath()): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}
