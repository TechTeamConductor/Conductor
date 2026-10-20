import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/** Root of all Conductor state. Override with CONDUCTOR_HOME (tests, demo). */
export function conductorHome(): string {
  return process.env.CONDUCTOR_HOME && process.env.CONDUCTOR_HOME.length > 0
    ? process.env.CONDUCTOR_HOME
    : join(homedir(), '.conductor');
}
export const paths = {
  home: () => conductorHome(),
  config: () => join(conductorHome(), 'config.json'),
  secrets: () => join(conductorHome(), 'secrets.json'),
  state: () => join(conductorHome(), 'state.json'),
  runs: () => join(conductorHome(), 'runs'),
  run: (key: string) => join(conductorHome(), 'runs', key),
  logs: () => join(conductorHome(), 'logs'),
  runtime: () => join(conductorHome(), 'run'),
  lock: () => join(conductorHome(), 'run', 'lock.json'),
  control: () => join(conductorHome(), 'run', 'control.sock'),
};
export function ensureHome(): void {
  for (const d of [paths.home(), paths.runs(), paths.logs(), paths.runtime()]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}
