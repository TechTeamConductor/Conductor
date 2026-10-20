import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LogEvent, Run } from './types.ts';
import { paths } from './paths.ts';
import { atomicWriteFile, deepClone } from './util.ts';
import { NewerVersionError } from './schema/errors.ts';
import { assertNotNewer, quarantine, type VersionSpec } from './schema/version.ts';
import { migrateRunV1ToV2 } from './schema/run-migrations.ts';
import { logger } from './log.ts';

/** Version of the run.json shape this build reads and writes. (Shape-changing migrations are registered with the code that consumes them — M1b.) */
export const RUN_SCHEMA_VERSION = 2;
const RUN_SPEC: VersionSpec = { kind: 'run record', field: 'schemaVersion', current: RUN_SCHEMA_VERSION, assumeWhenMissing: 1 };
const log = logger('store');

export type StoreEvent = { type: 'run'; key: string } | { type: 'log'; key: string; event: LogEvent };
export type StoreListener = (e: StoreEvent) => void;

const MAX_EVENT_FILE = 20 * 1024 * 1024;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class RunStoreError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RunStoreError';
    this.code = code;
  }
}

/** Crash-safe, single-process run store (JSON files + ndjson event logs). */
export class RunStore {
  private root: string;
  /** Read-only consumers (doctor, the importer reading a v1 home) must never rename or rewrite anything (review N2). */
  private readOnly: boolean;
  private seq = new Map<string, number>();
  private listeners = new Set<StoreListener>();
  private cache = new Map<string, Run>();

  constructor(root: string = paths.runs(), opts: { readOnly?: boolean } = {}) {
    this.root = root;
    this.readOnly = opts.readOnly === true;
    if (!this.readOnly) mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  static validKey(key: string): boolean {
    return KEY_RE.test(key);
  }
  private dir(key: string): string {
    if (!KEY_RE.test(key)) throw new RunStoreError('bad_key', `invalid run key: ${key}`);
    return join(this.root, key);
  }
  private runFile(key: string): string {
    return join(this.dir(key), 'run.json');
  }

  on(l: StoreListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit(e: StoreEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* listener errors must not break the store */
      }
    }
  }

  /** Atomically claims a key: throws RunStoreError('exists') if a run already exists. */
  create(run: Run): void {
    const dir = this.dir(run.key);
    try {
      mkdirSync(dir, { recursive: false, mode: 0o700 }); // EEXIST = already claimed
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        if (existsSync(this.runFile(run.key))) throw new RunStoreError('exists', `run ${run.key} already exists`);
      } else if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        mkdirSync(this.root, { recursive: true, mode: 0o700 });
        mkdirSync(dir, { recursive: false, mode: 0o700 });
      } else throw e;
    }
    run.schemaVersion = RUN_SCHEMA_VERSION;
    atomicWriteFile(this.runFile(run.key), JSON.stringify(run, null, 2) + '\n', 0o600);
    this.cache.set(run.key, deepClone(run));
    this.emit({ type: 'run', key: run.key });
  }

  /** Read run.json under the version contract: newer ⇒ refuse (NewerVersionError); corrupt ⇒ keep the bad file aside and report "no run". */
  private readRunFile(key: string): Run | null {
    const f = this.runFile(key);
    if (!existsSync(f)) return null;
    let text: string;
    try {
      text = readFileSync(f, 'utf8');
    } catch (e) {
      // an I/O error (permissions, EIO) is not corruption: leave the file exactly where it is — has() stays true, so the key is never re-claimed (S-4)
      log.warn(`${key}: run.json cannot be read (${(e as Error).message}) — left untouched and ignored`);
      return null;
    }
    let raw: any;
    try {
      raw = JSON.parse(text);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
      if (raw.schemaVersion !== undefined && !(Number.isInteger(raw.schemaVersion) && raw.schemaVersion >= 1)) throw new Error('schemaVersion is not a positive integer');
    } catch (e) {
      const kept = this.readOnly ? null : quarantine(f);
      log.warn(`${key}: run.json is unreadable (${(e as Error).message})${kept ? ` — kept as ${kept}` : ' — left in place'} and ignored`);
      return null;
    }
    const v = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1;
    if (v > RUN_SCHEMA_VERSION) throw new NewerVersionError('run record', f, v, RUN_SCHEMA_VERSION);
    return (v < 2 ? migrateRunV1ToV2(raw) : raw) as Run;
  }

  has(key: string): boolean {
    return existsSync(this.runFile(key));
  }

  get(key: string): Run | null {
    const hit = this.cache.get(key);
    if (hit) return deepClone(hit);
    const r = this.readRunFile(key);
    if (r) this.cache.set(key, deepClone(r));
    return r ? deepClone(r) : null;
  }

  /** Synchronous read-modify-write. `fn` may mutate the run in place. */
  update(key: string, fn: (run: Run) => void): Run {
    const cur = this.get(key);
    if (!cur) throw new RunStoreError('missing', `run ${key} not found`);
    fn(cur);
    cur.updatedAt = Date.now();
    cur.schemaVersion = RUN_SCHEMA_VERSION;
    assertNotNewer(this.runFile(key), RUN_SPEC); // a newer build wrote this record meanwhile: do not overwrite it (S-9)
    atomicWriteFile(this.runFile(key), JSON.stringify(cur, null, 2) + '\n', 0o600);
    this.cache.set(key, deepClone(cur));
    this.emit({ type: 'run', key });
    return deepClone(cur);
  }

  list(): Run[] {
    const out: Run[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(this.root);
    } catch {
      return out;
    }
    for (const n of names) {
      if (!KEY_RE.test(n)) continue;
      const r = this.get(n);
      if (r) out.push(r);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  // ───────────── events ─────────────
  private eventsFile(key: string): string {
    return join(this.dir(key), 'events.ndjson');
  }
  private nextSeq(key: string): number {
    let s = this.seq.get(key);
    if (s === undefined) {
      s = 0;
      try {
        const f = this.eventsFile(key);
        if (existsSync(f)) {
          const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
          const last = lines[lines.length - 1];
          if (last) s = (JSON.parse(last) as LogEvent).seq ?? 0;
        }
      } catch {
        s = 0;
      }
    }
    s += 1;
    this.seq.set(key, s);
    return s;
  }

  appendEvent(key: string, ev: Omit<LogEvent, 'seq' | 'ts'> & { ts?: number }): LogEvent {
    const full: LogEvent = { ...ev, ts: ev.ts ?? Date.now(), seq: this.nextSeq(key) };
    const f = this.eventsFile(key);
    try {
      mkdirSync(this.dir(key), { recursive: true, mode: 0o700 });
      if (existsSync(f) && statSync(f).size > MAX_EVENT_FILE) renameSync(f, `${f}.1`);
      appendFileSync(f, JSON.stringify(full) + '\n', { mode: 0o600 });
    } catch {
      /* disk problems must not crash a run */
    }
    this.emit({ type: 'log', key, event: full });
    return full;
  }

  readEvents(key: string, after = 0, limit = 500): { events: LogEvent[]; next: number } {
    const f = this.eventsFile(key);
    const events: LogEvent[] = [];
    let next = after;
    if (!existsSync(f)) return { events, next };
    const lim = Math.min(Math.max(1, limit), 2000);
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as LogEvent;
        if (e.seq > after) {
          events.push(e);
          next = Math.max(next, e.seq);
          if (events.length >= lim) break;
        }
      } catch {
        /* skip torn line */
      }
    }
    return { events, next };
  }

  // ───────────── artifacts (plan, verdicts, gates, …) ─────────────
  writeArtifact(key: string, name: string, data: unknown): void {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new RunStoreError('bad_name', 'bad artifact name');
    const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n';
    atomicWriteFile(join(this.dir(key), name), body, 0o600);
  }
  readArtifact<T>(key: string, name: string, fallback: T): T {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) return fallback;
    const p = join(this.dir(key), name);
    try {
      if (!existsSync(p)) return fallback;
      const raw = readFileSync(p, 'utf8');
      return name.endsWith('.json') ? (JSON.parse(raw) as T) : (raw as unknown as T);
    } catch {
      return fallback;
    }
  }
  artifactNames(key: string): string[] {
    try {
      return readdirSync(this.dir(key));
    } catch {
      return [];
    }
  }
  /** Touch helper for tests/doctor: ensure a key directory exists. */
  ensureDir(key: string): string {
    const d = this.dir(key);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }
  /** Write a raw text artifact (prompts etc.) without JSON encoding. */
  writeText(key: string, name: string, text: string): void {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new RunStoreError('bad_name', 'bad artifact name');
    mkdirSync(this.dir(key), { recursive: true, mode: 0o700 });
    writeFileSync(join(this.dir(key), name), text, { mode: 0o600 });
  }
}

/** Factory for a blank run record. */
export function newRun(seed: Pick<Run, 'key' | 'itemId' | 'title' | 'description' | 'descHash' | 'repo' | 'branch' | 'worktree' | 'baseSha'> & { loopBudget: number }): Run {
  const now = Date.now();
  return {
    ...seed,
    status: 'queued',
    next: 'plan',
    stage: null,
    loop: 1,
    rev: 1,
    agentRuns: 0,
    createdAt: now,
    updatedAt: now,
    unverified: false,
    noPushEnvOnly: false,
    planApproved: false,
    planReviewDone: false,
    planReviewRounds: 0,
    expected: {},
    sessions: [],
    bugs: [],
    effects: {},
    costUsd: 0,
    verdict: null,
    history: [{ ts: now, text: 'Claimed by Conductor' }],
    lastEventSeq: 0,
    commentsSeen: [],
  };
}
