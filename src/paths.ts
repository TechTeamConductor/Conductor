import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';

/** Root of all Conductor state. Override with CONDUCTOR_HOME (tests, demo). */
export function conductorHome(): string {
  return process.env.CONDUCTOR_HOME && process.env.CONDUCTOR_HOME.length > 0
    ? process.env.CONDUCTOR_HOME
    : join(homedir(), '.conductor-v2'); // v2's own home: running this code can never touch the v1 data in ~/.conductor
}
export const paths = {
  home: () => conductorHome(),
  config: () => join(conductorHome(), 'config.json'),
  secrets: () => join(conductorHome(), 'secrets.json'),
  state: () => join(conductorHome(), 'state.json'),
  runs: () => join(conductorHome(), 'runs'),
  board: () => join(conductorHome(), 'board'),
  run: (key: string) => join(conductorHome(), 'runs', key),
  logs: () => join(conductorHome(), 'logs'),
  runtime: () => join(conductorHome(), 'run'),
  lock: () => join(conductorHome(), 'run', 'lock.json'),
  control: () => join(conductorHome(), 'run', 'control.sock'),
};
/**
 * v2 data folders carry a `home.json` marker. A non-empty folder WITHOUT it is a v1 (or foreign) data folder: v2 refuses to
 * use it in place (its run records would be rewritten in the v2 shape, which v1 cannot read) and points at `conductor migrate`.
 */
export function assertHomeIsUsable(home: string = paths.home()): void {
  if (!existsSync(home)) return;
  if (existsSync(join(home, 'home.json'))) return;
  // an empty skeleton of v2's own folders (what earlier builds created before the marker existed) is not v1 data
  const SKELETON = new Set(['logs', 'run', 'runs', 'board', 'providers', 'projects']);
  const entries = readdirSync(home).filter((n) => {
    if (n.startsWith('.')) return false;
    if (!SKELETON.has(n)) return true;
    try {
      return readdirSync(join(home, n)).length > 0;
    } catch {
      return true;
    }
  });
  if (entries.length === 0) return;
  throw new Error(`${home} contains data from Conductor v1 (or another tool), not a v2 data folder. v2 never modifies it in place — run "conductor migrate" to import it side-by-side, or point CONDUCTOR_HOME at an empty folder.`);
}

export function ensureHome(): void {
  assertHomeIsUsable();
  for (const d of [paths.home(), paths.runs(), paths.logs(), paths.runtime()]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  const marker = join(paths.home(), 'home.json');
  if (!existsSync(marker)) writeFileSync(marker, JSON.stringify({ kind: 'conductor-home', generation: 2, createdAt: Date.now() }) + '\n', { mode: 0o600 });
}
