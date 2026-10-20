import { execFile, spawn } from 'node:child_process';
import type { Config, Run } from '../types.ts';
import { resolveBin } from '../config.ts';
import { isUuid, shellQuote } from '../util.ts';

export const OPEN_TARGETS = ['cursor', 'terminal-claude', 'terminal-cursor', 'claude-desktop', 'finder'] as const;
export type OpenTarget = (typeof OPEN_TARGETS)[number];

export class OpenError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OpenError';
    this.code = code;
  }
}

export interface ExecFn {
  (cmd: string, args: string[], opts?: { cwd?: string; detached?: boolean }): Promise<void>;
}

export const defaultExec: ExecFn = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    if (opts.detached) {
      const c = spawn(cmd, args, { cwd: opts.cwd, detached: true, stdio: 'ignore' });
      c.on('error', reject);
      c.unref();
      setTimeout(resolve, 400);
      return;
    }
    execFile(cmd, args, { cwd: opts.cwd, timeout: 15_000 }, (err) => (err ? reject(err) : resolve()));
  });

const SAFE_PATH = /^\/[^\0\n\r]*$/;

/** Shell command line shown in Terminal: both parts are validated/quoted — never user-controlled free text. */
export function terminalCommand(worktree: string, agent: 'claude' | 'agent', sessionId: string): string {
  if (!SAFE_PATH.test(worktree)) throw new OpenError('bad_path', 'worktree path is not usable');
  if (!isUuid(sessionId)) throw new OpenError('bad_session', 'session id is not a UUID');
  return `cd ${shellQuote(worktree)} && ${agent} --resume ${sessionId}`;
}

/** Whitelisted "open …" actions. Everything is derived from the run record; the client only names a target. */
export async function openRun(run: Run, cfg: Config, target: string, exec: ExecFn = defaultExec): Promise<{ detail: string }> {
  if (!(OPEN_TARGETS as readonly string[]).includes(target)) throw new OpenError('bad_target', `unknown target "${target}"`);
  const t = target as OpenTarget;
  if (!run.worktree || !SAFE_PATH.test(run.worktree)) throw new OpenError('no_worktree', 'This run has no worktree yet (or it was cleaned up).');
  if (t === 'finder') {
    await exec('/usr/bin/open', [run.worktree]);
    return { detail: 'Opened in Finder' };
  }
  if (t === 'cursor') {
    await exec('/usr/bin/open', ['-a', 'Cursor', run.worktree]);
    return { detail: 'Opening the worktree in Cursor' };
  }
  const agent = t === 'terminal-cursor' ? 'cursor' : 'claude';
  const sess = [...run.sessions].reverse().find((s) => s.agent === agent && isUuid(s.id));
  if (!sess) throw new OpenError('no_session', `No ${agent === 'claude' ? 'Claude' : 'Cursor'} session has been recorded for this run yet.`);
  if (t === 'claude-desktop') {
    const bin = resolveBin(cfg.agents.claude.bin);
    if (!bin) throw new OpenError('no_claude', 'The Claude CLI was not found.');
    await exec(bin, ['--desktop', '--resume', sess.id], { cwd: run.worktree, detached: true });
    return { detail: 'Asked the Claude app to open this session' };
  }
  const cmd = terminalCommand(run.worktree, agent === 'claude' ? 'claude' : 'agent', sess.id);
  await exec('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'tell application "Terminal"', '-e', 'activate', '-e', 'do script (item 1 of argv)', '-e', 'end tell', '-e', 'end run', cmd]);
  return { detail: 'Opened Terminal' };
}
