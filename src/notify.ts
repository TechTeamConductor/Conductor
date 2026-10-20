import { execFile } from 'node:child_process';
import { truncate } from './util.ts';

let lastKey = '';
let lastAt = 0;
let override: ((title: string, message: string) => void) | null = null;

/** Tests/demo can capture notifications instead of showing them. */
export function setNotifier(fn: ((title: string, message: string) => void) | null): void {
  override = fn;
}

/**
 * macOS notification. Text is passed to osascript as *arguments* (never interpolated into the script).
 * De-duplicates identical messages within 30 s. No-op elsewhere or when CONDUCTOR_NO_NOTIFY=1.
 */
export function notify(title: string, message: string): void {
  const t = truncate(title, 80);
  const m = truncate(message, 200);
  const key = `${t}|${m}`;
  const now = Date.now();
  if (key === lastKey && now - lastAt < 30_000) return;
  lastKey = key;
  lastAt = now;
  if (override) {
    override(t, m);
    return;
  }
  if (process.platform !== 'darwin' || process.env.CONDUCTOR_NO_NOTIFY === '1') return;
  execFile(
    '/usr/bin/osascript',
    ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run', m, t],
    { timeout: 10_000 },
    () => {
      /* ignore failures */
    },
  );
}
