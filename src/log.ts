import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.ts';
import { redact } from './redact.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogSink {
  (level: Level, line: string): void;
}

let minLevel: Level = (process.env.CONDUCTOR_LOG as Level) || 'info';
let toFile = true;
let extraSecrets: string[] = [];
let sink: LogSink | null = null;

export function configureLog(opts: { level?: Level; file?: boolean; sink?: LogSink | null; secrets?: string[] }): void {
  if (opts.level) minLevel = opts.level;
  if (opts.file !== undefined) toFile = opts.file;
  if (opts.sink !== undefined) sink = opts.sink;
  if (opts.secrets) extraSecrets = opts.secrets;
}

function fileFor(day: string): string {
  return join(paths.logs(), `conductor-${day}.log`);
}

function write(level: Level, scope: string, msg: string): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const ts = new Date().toISOString();
  const line = redact(`${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`, extraSecrets);
  if (sink) {
    sink(level, line);
    return;
  }
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else if (process.env.CONDUCTOR_QUIET !== '1') process.stdout.write(line + '\n');
  if (toFile) {
    try {
      mkdirSync(paths.logs(), { recursive: true, mode: 0o700 });
      appendFileSync(fileFor(ts.slice(0, 10)), line + '\n', { mode: 0o600 });
    } catch {
      /* logging must never throw */
    }
  }
}

export function logger(scope: string) {
  return {
    debug: (m: string) => write('debug', scope, m),
    info: (m: string) => write('info', scope, m),
    warn: (m: string) => write('warn', scope, m),
    error: (m: string) => write('error', scope, m),
  };
}

/** Delete log files older than `days` (default 14). */
export function pruneLogs(days = 14): void {
  try {
    const cutoff = Date.now() - days * 86400_000;
    for (const f of readdirSync(paths.logs())) {
      if (!f.startsWith('conductor-')) continue;
      const p = join(paths.logs(), f);
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    }
  } catch {
    /* ignore */
  }
}
