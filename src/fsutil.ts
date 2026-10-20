import { closeSync, constants, lstatSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * Write a file INSIDE a worktree without ever following a symlink (security review M9): a repo-committed or
 * agent-planted `.conductor -> /elsewhere` or `diff.patch -> ~/.zshrc` must not make Conductor clobber a file outside it.
 * Intermediate directories that are symlinks (or files) are replaced; the final path is opened O_NOFOLLOW|O_EXCL.
 */
export function safeWriteInside(root: string, rel: string, data: string | Buffer): void {
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.')) throw new Error('unsafe relative path');
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      mkdirSync(cur);
      continue;
    }
    if (!st.isDirectory()) {
      // a symlink (even to a directory) or a plain file is in the way: remove the LINK itself, never what it points to
      rmSync(cur, { force: true });
      mkdirSync(cur);
    }
  }
  const file = join(root, parts.join(sep));
  try {
    lstatSync(file);
    rmSync(file, { recursive: true, force: true }); // removes a symlink itself, not its target
  } catch {
    /* does not exist */
  }
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
  } finally {
    closeSync(fd);
  }
}
