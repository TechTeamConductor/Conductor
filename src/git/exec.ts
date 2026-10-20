/**
 * Process execution primitives for the git layer.
 *
 * - `run`     : argv-only spawn, whole-process-group kill on timeout/abort (SIGTERM, then SIGKILL after 5 s),
 *               wall-clock deadlines, tail-capped output.
 * - `git`     : `run('git', …)` with a non-interactive, locale-pinned, allowlisted environment.
 * - `gitOk`   : like `git` but returns trimmed stdout and throws `GitError` on a non-zero exit.
 * - `safeEnv` : allowlisted environment for every child process (never forwards API keys / tokens).
 *
 * Erasable TypeScript only; node:* built-ins only.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { redact } from '../redact.ts';
import { tail } from '../util.ts';

export interface RunOpts {
  cwd: string;
  /** Complete child environment. Defaults to `safeEnv()` — the parent environment is NEVER inherited wholesale. */
  env?: Record<string, string>;
  /** Wall-clock deadline for the whole process group. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Written to the child's stdin (then closed). Without it stdin is /dev/null. */
  input?: string;
  /** Per-stream cap in bytes; the TAIL is kept. Default 4 MB. */
  maxBytes?: number;
}

export interface RunResult {
  /** null when the process was killed by a signal (timeout / abort). */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** True when the head of the stream was dropped to honour `maxBytes`. */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/** SIGTERM → SIGKILL grace. */
export const KILL_GRACE_MS = 5000;
/** After the leader exits, how long stray pipe holders (background grandchildren) may keep the streams open. */
const DRAIN_GRACE_MS = 750;

const ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'SHELL'] as const;

/**
 * Allowlisted environment for child processes. Only the names above are forwarded from `process.env`;
 * `extra` is layered on top (callers are responsible for what they add). Secrets such as LINEAR_API_KEY,
 * CURSOR_API_KEY, ANTHROPIC_*, CLAUDE_CODE_*, GH_TOKEN, GITHUB_TOKEN are never forwarded implicitly.
 */
export function safeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOW) {
    const v = process.env[k];
    if (typeof v === 'string' && v.length > 0) env[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (typeof v === 'string') env[k] = v;
  }
  return env;
}

/** Bounded buffer that keeps the tail of a byte stream. */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private max: number;
  truncated = false;

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  push(b: Buffer): void {
    this.chunks.push(b);
    this.size += b.length;
    while (this.chunks.length > 1 && this.size - this.chunks[0]!.length >= this.max) {
      const first = this.chunks.shift()!;
      this.size -= first.length;
      this.truncated = true;
    }
  }

  toString(): string {
    let buf = Buffer.concat(this.chunks);
    if (buf.length > this.max) {
      buf = buf.subarray(buf.length - this.max);
      this.truncated = true;
    }
    if (this.truncated) {
      // do not start in the middle of a multi-byte UTF-8 sequence
      let i = 0;
      while (i < 3 && i < buf.length && (buf[i]! & 0xc0) === 0x80) i++;
      if (i > 0) buf = buf.subarray(i);
    }
    return buf.toString('utf8');
  }
}

export function run(cmd: string, args: string[], opts: RunOpts): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const empty = (aborted: boolean): RunResult => ({
      code: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    if (opts.signal?.aborted) {
      resolve(empty(true));
      return;
    }

    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const out = new TailBuffer(maxBytes);
    const err = new TailBuffer(maxBytes);

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? safeEnv(),
        stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        detached: true, // own process group (and session ⇒ no controlling tty to prompt on)
      });
    } catch (e) {
      reject(e);
      return;
    }

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let terminating = false;
    let killTimer: NodeJS.Timeout | undefined;
    let drainTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;
    let pollTimer: NodeJS.Timeout | undefined;
    const deadline = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : Infinity;

    const killGroup = (sig: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };

    const terminate = (): void => {
      if (terminating) return;
      terminating = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    };

    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    const onDeadline = (): void => {
      if (timedOut || settled) return;
      timedOut = true;
      terminate();
    };

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (pollTimer) clearInterval(pollTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        stdout: out.toString(),
        stderr: err.toString(),
        timedOut,
        aborted,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
      });
    };

    child.stdout!.on('data', (b: Buffer) => out.push(b));
    child.stderr!.on('data', (b: Buffer) => err.push(b));
    child.stdout!.on('error', () => {});
    child.stderr!.on('error', () => {});

    child.on('error', (e: Error) => {
      if (child.pid === undefined && !settled) {
        // spawn failure (ENOENT for cmd or cwd, EACCES, …)
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (pollTimer) clearInterval(pollTimer);
        opts.signal?.removeEventListener('abort', onAbort);
        reject(e);
      }
    });

    child.on('exit', (code) => {
      if (settled) return;
      // Streams normally close right after exit. If a background grandchild still holds them, reap the group.
      const grace = terminating ? KILL_GRACE_MS + 500 : DRAIN_GRACE_MS;
      drainTimer = setTimeout(() => {
        if (settled) return;
        killGroup('SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code);
      }, grace);
    });

    child.on('close', (code) => {
      // If we terminated, make sure no group member survives the leader.
      if (terminating) killGroup('SIGKILL');
      finish(code);
    });

    if (opts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        /* child closed stdin early (EPIPE) */
      });
      child.stdin.end(opts.input);
    }

    opts.signal?.addEventListener('abort', onAbort, { once: true });

    if (Number.isFinite(deadline)) {
      const ms = opts.timeoutMs as number;
      deadlineTimer = setTimeout(onDeadline, ms);
      // Wall-clock check: setTimeout does not advance while the machine sleeps; Date.now() does.
      pollTimer = setInterval(() => {
        if (Date.now() >= deadline) onDeadline();
      }, Math.max(20, Math.min(1000, Math.floor(ms / 4))));
    }
  });
}

// ───────────────────────────── git ─────────────────────────────

export class GitError extends Error {
  code: number | null;
  stderr: string;
  args: string[];
  constructor(message: string, code: number | null, stderr: string, args: string[]) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.stderr = stderr;
    this.args = args;
  }
}

/** Non-interactive git environment additions (never prompt, stable English output, no editor). */
export const GIT_BASE_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
  GIT_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
  GIT_PAGER: 'cat',
});

/**
 * Run `git <args>` in `cwd`. `opts.env` is treated as EXTRA variables layered over `safeEnv()` + `GIT_BASE_ENV`
 * (unlike `run`, where `env` replaces the environment). Resolves for any exit code; rejects only if git cannot be spawned.
 */
export function git(cwd: string, args: string[], opts: Partial<RunOpts> = {}): Promise<RunResult> {
  const { env: extra, ...rest } = opts;
  return run('git', args, {
    ...rest,
    cwd,
    env: safeEnv({ ...GIT_BASE_ENV, ...(extra ?? {}) }),
  });
}

/** Like `git` but returns TRIMMED stdout and throws `GitError` for a non-zero exit / timeout / abort. */
export async function gitOk(cwd: string, args: string[], opts: Partial<RunOpts> = {}): Promise<string> {
  const r = await git(cwd, args, opts);
  if (r.code !== 0) {
    const why = r.timedOut ? 'timed out' : r.aborted ? 'aborted' : `exit ${r.code}`;
    const detail = redact(tail((r.stderr || r.stdout).trim(), 600));
    throw new GitError(`git ${redact(args.join(' '))} failed (${why}): ${detail}`, r.code, redact(r.stderr), args);
  }
  return r.stdout.trim();
}
