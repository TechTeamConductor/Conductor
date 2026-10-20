import { spawn } from 'node:child_process';
import type { Clock } from '../util.ts';
import { systemClock } from '../util.ts';

export interface SpawnOpts {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  /** Called for every complete stdout/stderr line. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Kill if no output for this long (wall-clock; sleep gaps are discounted). */
  idleMs: number;
  /** Kill after this long regardless. */
  hardMs: number;
  signal?: AbortSignal;
  clock?: Clock;
  graceMs?: number; // SIGTERM → SIGKILL delay (default 5000)
  tickMs?: number; // watchdog period (default 1000)
}
export interface SpawnResult {
  code: number | null;
  signal: string | null;
  timedOut: 'idle' | 'hard' | null;
  aborted: boolean;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  spawnError?: string;
}

const TAIL_BYTES = 64 * 1024;
const active = new Set<number>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const pid of active) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });
}

export function killGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* gone */
    }
  }
}

/** Run a child in its own process group with idle + hard wall-clock deadlines and abort support. */
export function runProcess(opts: SpawnOpts): Promise<SpawnResult> {
  installExitHook();
  const clock = opts.clock ?? systemClock;
  const grace = opts.graceMs ?? 5000;
  const tick = opts.tickMs ?? 1000;
  return new Promise((resolve) => {
    const startedAt = clock.now();
    let stdoutTail = '';
    let stderrTail = '';
    let timedOut: 'idle' | 'hard' | null = null;
    let aborted = false;
    let settled = false;
    let lastOutput = startedAt;
    let lastTick = startedAt;
    let slept = 0; // wall-clock the machine spent asleep: never counted against idle OR hard budgets
    let killTimer: NodeJS.Timeout | null = null;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.bin, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ code: null, signal: null, timedOut: null, aborted: false, stdoutTail: '', stderrTail: '', durationMs: 0, spawnError: String(e) });
      return;
    }
    const pid = child.pid;
    if (pid) active.add(pid);

    const terminate = () => {
      if (!pid) return;
      killGroup(pid, 'SIGTERM');
      if (!killTimer) {
        killTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), grace);
        killTimer.unref();
      }
    };

    const finish = (r: Omit<SpawnResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      if (killTimer) clearTimeout(killTimer);
      if (pid) active.delete(pid);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ ...r, durationMs: clock.now() - startedAt });
    };

    const watchdog = setInterval(() => {
      const now = clock.now();
      const gap = now - lastTick;
      lastTick = now;
      if (gap > tick * 5) {
        lastOutput += gap - tick; // machine slept: don't count it as idle…
        slept += gap - tick; // …or against the total budget
      }
      if (timedOut || aborted) return;
      if (now - startedAt - slept > opts.hardMs) {
        timedOut = 'hard';
        terminate();
      } else if (now - lastOutput > opts.idleMs) {
        timedOut = 'idle';
        terminate();
      }
    }, tick);
    watchdog.unref();

    const onAbort = () => {
      aborted = true;
      terminate();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const lineSplitter = (stream: 'stdout' | 'stderr') => {
      let buf = '';
      return (chunk: Buffer | string) => {
        lastOutput = clock.now();
        const s = String(chunk);
        if (stream === 'stdout') stdoutTail = (stdoutTail + s).slice(-TAIL_BYTES);
        else stderrTail = (stderrTail + s).slice(-TAIL_BYTES);
        if (!opts.onLine) return;
        buf += s;
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (line) {
            try {
              opts.onLine(line, stream);
            } catch {
              /* consumer errors must not kill the run */
            }
          }
        }
        if (buf.length > 4 * 1024 * 1024) buf = buf.slice(-1024 * 1024); // runaway line guard
      };
    };
    child.stdout?.on('data', lineSplitter('stdout'));
    child.stderr?.on('data', lineSplitter('stderr'));

    child.on('error', (e) => finish({ code: null, signal: null, timedOut, aborted, stdoutTail, stderrTail, spawnError: String(e) }));
    // `close` waits for every holder of the stdio pipes; a background grandchild (dev server, watcher) would otherwise keep us
    // waiting until the idle timeout and turn a success into a timeout. After `exit`, give the pipes a short drain window,
    // then reap the whole group and finish with the real exit status.
    let drain: NodeJS.Timeout | null = null;
    child.on('exit', (code, sig) => {
      drain = setTimeout(() => {
        if (pid) killGroup(pid, 'SIGKILL');
        finish({ code, signal: sig, timedOut, aborted, stdoutTail, stderrTail });
      }, 750);
      drain.unref();
    });
    child.on('close', (code, sig) => {
      if (drain) clearTimeout(drain);
      finish({ code, signal: sig, timedOut, aborted, stdoutTail, stderrTail });
    });

    child.stdin?.on('error', () => {
      /* EPIPE if the child exits early */
    });
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    else child.stdin?.end();
  });
}
