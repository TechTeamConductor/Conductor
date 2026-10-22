// The version Conductor reports. It comes from the package.json that ships next to the app (a checkout, the installed copy and the
// desktop payload all have one), never from a constant, so `conductor version` always matches the release that was installed.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]*[0-9A-Za-z])?$/;
export const DEV_VERSION = '0.0.0-dev';

/** The `version` of the package.json at `pkgPath`, or the dev placeholder when it is missing, unreadable or not a plain version. */
export function readVersion(pkgPath: string): string {
  try {
    const v = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' && SEMVER.test(v) ? v : DEV_VERSION;
  } catch {
    return DEV_VERSION;
  }
}

export const VERSION = readVersion(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));
