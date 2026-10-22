// The one stable discovery working folder `<home>/run/discovery` (M8-1 C1, Security R2-2). All discovery spawns share it and are
// serialised by ModelService's queue, so cleaning it can never pull the floor out from under a live child.
//  (a) `<home>/run` and the folder are real directories (lstat), owned by the user, mode 0700 (tightened) — otherwise refuse;
//  (b) before every spawn every entry is removed without following links (a symlink is removed itself, never its target), then the
//      folder must be empty — otherwise refuse and do not spawn;
//  (c) after every run, once the child is reaped, it is cleaned again; only the leftover COUNT is logged, never names.
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths.ts';

export const WORKDIR_REASON = 'the discovery folder is not a plain private folder';

/**
 * A real directory owned by the user with mode 0700, tightened if looser — WITHOUT following a link (Security code review L1): the folder
 * is opened O_DIRECTORY|O_NOFOLLOW, checked and chmod-ed through that handle (fchmod), then the path is re-lstat-ed and must still be
 * the same object (dev + ino). A link or a swap in between ⇒ refused. `create` makes a missing folder 0700 first. Shared with cache.ts.
 */
export function securePrivateDir(dir: string, create: boolean): 'ok' | 'missing' | 'bad' {
  try {
    lstatSync(dir);
  } catch {
    if (!create) return 'missing';
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch {
      return 'bad';
    }
  }
  let fd: number;
  try {
    fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    return 'bad'; // ELOOP (a symlink), ENOTDIR (a file), …
  }
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory()) return 'bad';
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null && st.uid !== uid) return 'bad';
    if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o700);
    const again = lstatSync(dir);
    if (again.isSymbolicLink() || !again.isDirectory() || again.dev !== st.dev || again.ino !== st.ino) return 'bad';
    return 'ok';
  } catch {
    return 'bad';
  } finally {
    closeSync(fd);
  }
}

function plainPrivateDir(dir: string, create: boolean): boolean {
  return securePrivateDir(dir, create) === 'ok';
}

/** Remove every entry (links themselves, never their targets). Returns how many entries remain afterwards. */
export function emptyDir(dir: string): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return -1;
  }
  for (const n of names) {
    try {
      rmSync(join(dir, n), { recursive: true, force: true });
    } catch {
      /* counted below */
    }
  }
  try {
    return readdirSync(dir).length;
  } catch {
    return -1;
  }
}

/** Prepare the folder for one spawn: checked, emptied, re-checked empty. */
export function prepareDiscoveryDir(): { ok: true; dir: string } | { ok: false; reason: string } {
  const run = paths.runtime();
  const dir = paths.discovery();
  if (!plainPrivateDir(run, true) || !plainPrivateDir(dir, true)) return { ok: false, reason: WORKDIR_REASON };
  if (emptyDir(dir) !== 0) return { ok: false, reason: WORKDIR_REASON };
  if (!plainPrivateDir(dir, false)) return { ok: false, reason: WORKDIR_REASON }; // re-check: nothing swapped it meanwhile
  return { ok: true, dir };
}

/** After the child is reaped: clean again; returns the leftover count (for the log line, never names). */
export function cleanDiscoveryDir(): number {
  const dir = paths.discovery();
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return -1;
  } catch {
    return 0;
  }
  const before = (() => {
    try {
      return readdirSync(dir).length;
    } catch {
      return 0;
    }
  })();
  emptyDir(dir);
  return before;
}
