import { existsSync, readFileSync, renameSync } from 'node:fs';
import { atomicWriteFile } from '../util.ts';
import { backupPaths } from './backup.ts';
import { CorruptFileError, NewerVersionError } from './errors.ts';

export type Migration = (data: any) => any;

export interface VersionSpec {
  /** Human name used in error messages ("config", "run record", …). */
  kind: string;
  /** Name of the version field inside the JSON object. */
  field: 'schemaVersion' | 'version';
  /** The version this build reads and writes. */
  current: number;
  /** Version assumed when the field is absent (legacy files). */
  assumeWhenMissing: number;
  /** `migrations[n]` upgrades data from version n to n+1. Pure functions. */
  migrations?: Record<number, Migration>;
}

export interface Loaded<T> {
  data: T;
  /** Version found on disk (assumeWhenMissing when the file had none). */
  fromVersion: number;
  /** True when at least one migration ran (⇒ saveVersioned takes a backup before the first write). */
  migrated: boolean;
  /** False when the file did not exist (data = fallback). */
  existed: boolean;
}

/**
 * Read a JSON file under a version contract. NEVER writes.
 *  - newer than this build understands ⇒ throws NewerVersionError (the caller must not write);
 *  - older ⇒ runs the registered migrations in order, in memory;
 *  - unparsable ⇒ throws CorruptFileError (no silent reset).
 */
export function loadVersioned<T extends Record<string, any>>(file: string, spec: VersionSpec, fallback: () => T): Loaded<T> {
  if (!existsSync(file)) return { data: fallback(), fromVersion: spec.current, migrated: false, existed: false };
  const text = readFileSync(file, 'utf8'); // an I/O error (EACCES, EIO …) is NOT corruption: it propagates and nothing is touched (S-4)
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new CorruptFileError(spec.kind, file, `not valid JSON (${(e as Error).message})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CorruptFileError(spec.kind, file, 'expected a JSON object');
  if (raw[spec.field] !== undefined && !(Number.isInteger(raw[spec.field]) && raw[spec.field] >= 1)) throw new CorruptFileError(spec.kind, file, `"${spec.field}" is not a positive integer`);
  const v = raw[spec.field] === undefined ? spec.assumeWhenMissing : (raw[spec.field] as number);
  if (v > spec.current) throw new NewerVersionError(spec.kind, file, v, spec.current);
  let data = raw;
  let migrated = false;
  for (let n = v; n < spec.current; n++) {
    const step = spec.migrations?.[n];
    if (step) {
      data = step(data);
      migrated = true;
    }
  }
  return { data: data as T, fromVersion: v, migrated, existed: true };
}

/**
 * Write a versioned JSON file atomically, stamping the version field. When the data came from a migration, a
 * timestamped backup of the ORIGINAL file is taken first (once per process per file).
 */
const backedUp = new Set<string>();
export function saveVersioned(file: string, data: Record<string, any>, spec: VersionSpec, opts: { migratedFrom?: Loaded<any>; mode?: number; backupRoot?: string } = {}): void {
  if (opts.migratedFrom?.migrated && opts.migratedFrom.existed && !backedUp.has(file)) {
    backupPaths([file], { root: opts.backupRoot, label: `pre-migration-${spec.kind.replace(/[^a-z0-9]+/gi, '-')}` });
    backedUp.add(file);
  }
  assertNotNewer(file, spec);
  const out = { ...data, [spec.field]: spec.current };
  atomicWriteFile(file, JSON.stringify(out, null, 2) + '\n', opts.mode ?? 0o600);
}

/**
 * Refuse to overwrite a file that a NEWER build has written since we loaded it (S-9). Unreadable/garbled files do not block a write
 * (they were handled at load time); only a clearly newer version does.
 */
export function assertNotNewer(file: string, spec: VersionSpec): void {
  if (!existsSync(file)) return;
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(file, 'utf8'))?.[spec.field];
  } catch {
    return;
  }
  if (typeof v === 'number' && Number.isFinite(v) && v > spec.current) throw new NewerVersionError(spec.kind, file, v, spec.current);
}

/** Keep a corrupt file next to itself for forensics before anything else touches it. */
export function quarantine(file: string): string | null {
  if (!existsSync(file)) return null;
  const dest = `${file}.corrupt-${Date.now()}`;
  try {
    renameSync(file, dest);
    return dest;
  } catch {
    return null;
  }
}

/** Test seam: forget which files were already backed up in this process. */
export function _resetBackupMemory(): void {
  backedUp.clear();
}
