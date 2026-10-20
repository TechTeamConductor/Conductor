/** Data on disk was written by a NEWER Conductor than this one: refuse to read-modify-write it (never downgrade). */
export class NewerVersionError extends Error {
  kind: string;
  found: number;
  supported: number;
  file: string;
  constructor(kind: string, file: string, found: number, supported: number) {
    super(`${kind} (${file}) was written by a newer Conductor (data version ${found}; this build understands up to ${supported}). Upgrade Conductor, or restore a backup — nothing was changed.`);
    this.name = 'NewerVersionError';
    this.kind = kind;
    this.file = file;
    this.found = found;
    this.supported = supported;
  }
}

/** A file exists but cannot be trusted (corrupt JSON, corrupt journal middle line, impossible state). */
export class CorruptFileError extends Error {
  kind: string;
  file: string;
  constructor(kind: string, file: string, detail: string) {
    super(`${kind} (${file}) is corrupt: ${detail}. Conductor will not guess — nothing was changed. A backup copy of the file has been kept next to it.`);
    this.name = 'CorruptFileError';
    this.kind = kind;
    this.file = file;
  }
}
