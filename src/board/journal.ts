import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, type LockInfo } from '../lock.ts';
import { loadVersioned, type VersionSpec } from '../schema/version.ts';
import { CorruptFileError, NewerVersionError } from '../schema/errors.ts';
import { randomToken } from '../util.ts';
import { BOARD_SCHEMA_VERSION, type BoardSnapshot, type JournalOp } from './types.ts';

const OP_KINDS = new Set(['project', 'milestone', 'item', 'comment', 'decision']);
export const SNAPSHOT_SPEC: VersionSpec = { kind: 'board snapshot', field: 'schemaVersion', current: BOARD_SCHEMA_VERSION, assumeWhenMissing: 1 };

/** Test seam: called at named crash windows; a test can SIGKILL the process or throw here. */
export type FaultHook = (point: string) => void;

export interface JournalLoad {
  snapshot: BoardSnapshot | null;
  ops: JournalOp[];
  /** Bytes of an unparsable final line that were ignored (and truncated when opened for writing). */
  tornBytes: number;
}

function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* directories cannot be fsynced everywhere (Windows) — best effort */
  }
}

/**
 * Append-only journal + atomic snapshot.
 *  - every `append` is `write` + `fsync` on a descriptor held open, so an acknowledged operation survives a process crash AND power loss;
 *  - a torn FINAL line is ignored (and cut off when opened for writing); a corrupt MIDDLE line refuses to open (never skipped silently);
 *  - snapshots are temp-file + fsync + rename + directory fsync; ops with seq <= snapshot.seq are ignored on replay, so a crash between the
 *    snapshot rename and the journal truncation is harmless.
 */
export class Journal {
  readonly dir: string;
  readonly snapshotFile: string;
  readonly journalFile: string;
  private fd: number | null = null;
  private releaseLock: (() => void) | null = null;
  private fault: FaultHook;
  readonly readOnly: boolean;

  constructor(dir: string, opts: { readOnly?: boolean; fault?: FaultHook } = {}) {
    this.dir = dir;
    this.snapshotFile = join(dir, 'snapshot.json');
    this.journalFile = join(dir, 'journal.ndjson');
    this.readOnly = opts.readOnly === true;
    this.fault = opts.fault ?? (() => undefined);
    if (!this.readOnly) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** Writer: take the single-writer lock. Throws LockHeldError when another live writer exists. */
  lock(info: Partial<LockInfo> = {}): void {
    if (this.readOnly) return;
    this.releaseLock = acquireLock(join(this.dir, 'board.lock'), info).release;
  }

  load(): JournalLoad {
    const snap = loadVersioned<BoardSnapshot>(this.snapshotFile, SNAPSHOT_SPEC, () => null as unknown as BoardSnapshot);
    const snapshot = snap.existed ? snap.data : null;
    const baseSeq = snapshot?.seq ?? 0;
    const ops: JournalOp[] = [];
    let tornBytes = 0;
    if (existsSync(this.journalFile)) {
      const buf = readFileSync(this.journalFile);
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      const last = lines.length - 1; // the segment after the final '\n' (empty when the file ends cleanly)
      // index of the last non-empty segment: only THAT line may be torn
      let lastNonEmpty = -1;
      for (let i = last; i >= 0; i--) if (lines[i]!.length > 0) { lastNonEmpty = i; break; }
      let goodBytes = 0;
      let cursor = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const lineBytes = Buffer.byteLength(line, 'utf8') + (i < last ? 1 : 0);
        if (line.length === 0) {
          cursor += lineBytes;
          if (i < last) goodBytes = cursor;
          continue;
        }
        let op: JournalOp | null = null;
        try {
          op = JSON.parse(line) as JournalOp;
          if (!op || typeof op !== 'object' || typeof (op as any).seq !== 'number' || !OP_KINDS.has((op as any).t)) throw new Error('not an operation');
        } catch {
          op = null;
        }
        if (!op) {
          if (i === lastNonEmpty) {
            tornBytes = buf.length - cursor;
            break; // torn / garbled final line: ignore it
          }
          throw new CorruptFileError('board journal', this.journalFile, `line ${i + 1} is unreadable and is followed by more data (refusing to skip it silently)`);
        }
        if ((op as any).v > 1) throw new NewerVersionError('board journal', this.journalFile, (op as any).v, 1);
        if (op.seq > baseSeq) ops.push(op);
        cursor += lineBytes;
        goodBytes = cursor;
      }
      if (!this.readOnly && tornBytes > 0) {
        // cut the torn tail so the next append starts on a clean line boundary
        const fd = openSync(this.journalFile, 'r+');
        try {
          ftruncateSync(fd, goodBytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } else if (!this.readOnly && buf.length > 0 && buf[buf.length - 1] !== 0x0a && tornBytes === 0) {
        // final line parsed but lost its newline: restore it before appending
        const fd = openSync(this.journalFile, 'a');
        try {
          writeSync(fd, '\n');
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    }
    return { snapshot, ops, tornBytes };
  }

  private openJournal(): number {
    if (this.fd === null) this.fd = openSync(this.journalFile, 'a', 0o600);
    return this.fd;
  }

  append(op: JournalOp): void {
    if (this.readOnly) throw new Error('journal is read-only');
    this.fault('journal:before-append');
    const fd = this.openJournal();
    const line = Buffer.from(JSON.stringify(op) + '\n', 'utf8');
    let off = 0;
    while (off < line.length) off += writeSync(fd, line, off, line.length - off);
    fsyncSync(fd);
    this.fault('journal:after-append');
  }

  /** Write a snapshot (atomic, durable) and then empty the journal. */
  compact(snapshot: BoardSnapshot): void {
    if (this.readOnly) throw new Error('journal is read-only');
    const tmp = `${this.snapshotFile}.${process.pid}.${randomToken(4)}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      const data = Buffer.from(JSON.stringify(snapshot) + '\n', 'utf8');
      let off = 0;
      while (off < data.length) off += writeSync(fd, data, off, data.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.fault('compact:after-snapshot-temp');
    renameSync(tmp, this.snapshotFile);
    fsyncDir(this.dir);
    this.fault('compact:after-snapshot-rename');
    // the journal's ops are all <= snapshot.seq now: start a fresh journal
    if (this.fd !== null) {
      ftruncateSync(this.fd, 0);
      fsyncSync(this.fd);
    } else if (existsSync(this.journalFile) && statSync(this.journalFile).size > 0) {
      const f = openSync(this.journalFile, 'r+');
      try {
        ftruncateSync(f, 0);
        fsyncSync(f);
      } finally {
        closeSync(f);
      }
    }
    this.fault('compact:after-journal-truncate');
  }

  close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = null;
    }
    this.releaseLock?.();
    this.releaseLock = null;
  }
}
