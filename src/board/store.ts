import { randomUUID } from 'node:crypto';
import { redact as defaultRedact } from '../redact.ts';
import { paths } from '../paths.ts';
import { logger } from '../log.ts';
import { validateEntity } from './validate.ts';
import { truncate } from '../util.ts';
import { Journal, type FaultHook } from './journal.ts';
import { backupPaths } from '../schema/backup.ts';
import {
  BOARD_SCHEMA_VERSION,
  BoardError,
  HUMAN_LANES,
  LANES,
  REDACTED_ACTORS,
  USER_KINDS,
  type Actor,
  type BoardChange,
  type BoardComment,
  type BoardSnapshot,
  type Decision,
  type ItemKind,
  type JournalOp,
  type Lane,
  type Milestone,
  type Project,
  type WorkItem,
  type ExternalLink,
} from './types.ts';

const log = logger('board');
export const LIMITS = { title: 200, description: 50_000, comment: 100_000, decisionBody: 50_000, maxDepth: 6, maxDeps: 50, maxItems: 50_000, maxCommentsPerItem: 2_000, maxBytes: 120_000_000 };
const PROJECT_KEY_RE = /^[A-Z]{2,6}$/;
/** Same shape the HTTP API and the run store accept (api.ts KEY_RE ∩ store.ts KEY_RE ∩ branch naming). */
const ITEM_KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/;
const AUTO_START_KINDS = new Set<ItemKind>(['work', 'ask', 'research']);
/** Actors an older (v2) build cannot read: an op carrying one needs a current-version snapshot on disk first. */
const V3_ONLY_ACTORS: ReadonlySet<Actor> = new Set<Actor>(['design']);

export interface BoardOptions {
  dir?: string;
  readOnly?: boolean;
  now?: () => number;
  /** Applied to everything Conductor writes (actor 'conductor'). Defaults to the token-shape redactor. */
  redact?: (s: string) => string;
  fault?: FaultHook;
  /** Compact (snapshot + empty journal) after this many journal ops. */
  compactEvery?: number;
}

export interface NewItem {
  projectId: string;
  title: string;
  description?: string;
  kind?: ItemKind;
  parentId?: string | null;
  dependsOn?: string[];
  milestoneId?: string;
  lane?: Lane;
  stage?: string;
  autoStart?: boolean;
  idemKey?: string;
  /** import only */
  key?: string;
  external?: ExternalLink;
  createdAt?: number;
}

export interface ItemFilter {
  projectId?: string;
  lane?: Lane | Lane[];
  parentId?: string | null;
  kind?: ItemKind;
}

const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Items are the only entity with nested values (dependsOn, external): copy them on every way out and in (no aliasing of board state). */
function cloneItem(i: WorkItem): WorkItem {
  return { ...i, dependsOn: [...i.dependsOn], external: i.external ? { ...i.external } : undefined };
}
const clean = (s: string): string => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u034F\u115F\u1160\u3164\uFFA0\u2800]+/gu, ' ').trim();
const asString = (v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new BoardError('bad_input', `"${name}" must be a string.`);
  return v;
};

/**
 * The native board: projects, milestones, work items (hierarchy + dependencies), comments, decisions.
 * Synchronous and single-process. Persistence = journal + snapshot (see journal.ts). Every public mutation takes an
 * `actor`; HTTP handlers must only ever use `board.user` (fixed actor, whitelisted fields) so a request body can never
 * carry authorship, kind or a Conductor-owned lane (condition C4).
 */
export class Board {
  readonly dir: string;
  readonly readOnly: boolean;
  /** Bytes of a torn final journal line that were ignored when this board was opened. */
  readonly recoveredTornBytes: number;
  private journal: Journal;
  private now: () => number;
  private redactFn: (s: string) => string;
  private compactEvery: number;
  private seq = 0;
  private opsSinceSnapshot = 0;
  private nextCompactAt = 0;
  private closed = false;
  private listeners = new Set<(c: BoardChange) => void>();
  private projectsById = new Map<string, Project>();
  private milestonesById = new Map<string, Milestone>();
  private itemsById = new Map<string, WorkItem>();
  private itemsByKey = new Map<string, WorkItem>();
  private itemIdem = new Map<string, string>();
  private commentsByItem = new Map<string, BoardComment[]>();
  private commentIdem = new Map<string, string>(); // `${itemId}|${idemKey}` → comment id
  private decisionsById = new Map<string, Decision>();
  /** Rough size of all text held (titles, descriptions, comments, decisions): keeps compaction far below V8's string limit (S-6). */
  private approxBytes = 0;
  /** True until a current-version snapshot is on disk for a board that started empty (B1/S4). */
  private stampPending = false;

  private constructor(opts: BoardOptions) {
    this.dir = opts.dir ?? paths.board();
    this.readOnly = opts.readOnly === true;
    this.now = opts.now ?? (() => Date.now());
    this.redactFn = opts.redact ?? ((s) => defaultRedact(s));
    this.compactEvery = opts.compactEvery ?? 500;
    this.nextCompactAt = this.compactEvery;
    this.journal = new Journal(this.dir, { readOnly: this.readOnly, fault: opts.fault });
    this.journal.lock({});
    try {
      const loaded = this.journal.load();
      if (loaded.snapshot) this.loadSnapshot(loaded.snapshot);
      for (const op of loaded.ops) {
        this.applyOp(op);
        this.seq = Math.max(this.seq, op.seq);
      }
      this.opsSinceSnapshot = loaded.ops.length;
      this.recoveredTornBytes = loaded.tornBytes;
      this.rederiveNextSeq();
      this.approxBytes = this.measure();
      // B1/S4 (M8-6): the version lives only in the snapshot, and journal ops stay `v: 1`. So on a WRITABLE open whose snapshot is older
      // than this build (or absent), back up what is there and stamp a current snapshot synchronously, BEFORE any op can be appended.
      // A newer-only op (e.g. a `design` card) can then never sit behind an older snapshot, where an older build would read it as a
      // torn tail and cut it off. An older build now refuses the whole board with NewerVersionError.
      if (!this.readOnly && (loaded.snapshotVersion === null || loaded.snapshotVersion < BOARD_SCHEMA_VERSION)) {
        if (loaded.snapshotVersion !== null || loaded.journalBytes > 0 || loaded.tornBytes > 0) {
          // existing older data: back up, then stamp — fail closed (an open that cannot stamp must not accept a v3-only op)
          try {
            backupPaths([this.journal.snapshotFile, this.journal.journalFile], { label: `pre-board-v${BOARD_SCHEMA_VERSION}` });
          } catch (e) {
            // m5: fail closed, with a message a person can act on (the board is not upgraded and nothing was written)
            throw new Error(`Conductor could not back up the board before upgrading it to schema ${BOARD_SCHEMA_VERSION} (${(e as Error).message}). Nothing was changed. Free some disk space or set CONDUCTOR_BACKUP_DIR to a writable folder, then start again.`);
          }
          this.journal.compact(this.snapshot());
          this.opsSinceSnapshot = 0;
        } else {
          // a brand-new board: nothing to back up; a failed stamp is retried, and REQUIRED before the first v3-only op (commit())
          this.stampPending = true;
          this.tryStamp();
        }
      }
    } catch (e) {
      this.journal.close();
      throw e;
    }
  }

  static open(opts: BoardOptions = {}): Board {
    return new Board(opts);
  }

  // ─────────────────────────── persistence plumbing ───────────────────────────
  private loadSnapshot(s: BoardSnapshot): void {
    for (const p of s.projects ?? []) this.projectsById.set(p.id, p);
    for (const m of s.milestones ?? []) this.milestonesById.set(m.id, m);
    for (const i of s.items ?? []) this.indexItem(i);
    for (const c of s.comments ?? []) this.indexComment(c);
    for (const d of s.decisions ?? []) this.decisionsById.set(d.id, d);
    this.seq = s.seq ?? 0;
  }

  private snapshot(): BoardSnapshot {
    const comments: BoardComment[] = [];
    for (const l of this.commentsByItem.values()) comments.push(...l);
    return {
      schemaVersion: BOARD_SCHEMA_VERSION,
      seq: this.seq,
      projects: [...this.projectsById.values()],
      milestones: [...this.milestonesById.values()],
      items: [...this.itemsById.values()],
      comments,
      decisions: [...this.decisionsById.values()],
    };
  }

  private indexItem(i: WorkItem): void {
    const prev = this.itemsById.get(i.id);
    if (prev && prev.key !== i.key) this.itemsByKey.delete(prev.key);
    this.itemsById.set(i.id, i);
    this.itemsByKey.set(i.key, i);
    if (i.idemKey) this.itemIdem.set(i.idemKey, i.id);
  }
  private indexComment(c: BoardComment): void {
    const list = this.commentsByItem.get(c.itemId) ?? [];
    if (!list.some((x) => x.id === c.id)) list.push(c);
    this.commentsByItem.set(c.itemId, list);
    if (c.idemKey) this.commentIdem.set(`${c.itemId}|${c.idemKey}`, c.id);
  }

  /** Replay/apply an operation to memory. Pure upsert — the same code path for live writes and for replay. */
  private applyOp(op: JournalOp): void {
    switch (op.t) {
      case 'project':
        this.projectsById.set(op.e.id, op.e);
        break;
      case 'milestone':
        this.milestonesById.set(op.e.id, op.e);
        break;
      case 'item':
        this.indexItem(op.e);
        if (op.nextSeq) {
          const p = this.projectsById.get(op.nextSeq.projectId);
          if (p) p.nextSeq = Math.max(p.nextSeq, op.nextSeq.value);
        }
        break;
      case 'comment':
        this.indexComment(op.e);
        break;
      case 'decision':
        this.decisionsById.set(op.e.id, op.e);
        break;
    }
  }

  private measure(): number {
    let n = 0;
    for (const i of this.itemsById.values()) n += i.title.length + i.description.length;
    for (const l of this.commentsByItem.values()) for (const c of l) n += c.body.length;
    for (const d of this.decisionsById.values()) n += d.title.length + d.body.length;
    return n;
  }
  private reserve(bytes: number): void {
    if (this.approxBytes + bytes > LIMITS.maxBytes) throw new BoardError('full', 'The board holds as much text as it safely can. Archive or clean up old work first.');
  }

  /** nextSeq can never lag behind an existing key (guards a torn write between an item and its counter). */
  private rederiveNextSeq(): void {
    for (const i of this.itemsById.values()) {
      const p = this.projectsById.get(i.projectId);
      const m = /-(\d+)$/.exec(i.key);
      if (p && m && i.key.startsWith(`${p.key}-`)) p.nextSeq = Math.max(p.nextSeq, Number(m[1]) + 1);
    }
  }

  private emit(c: BoardChange): void {
    for (const l of this.listeners) {
      try {
        l(c);
      } catch {
        /* a listener must never break the board */
      }
    }
  }

  private requireWritable(): void {
    if (this.readOnly) throw new BoardError('read_only', 'This board was opened read-only.');
    if (this.closed) throw new BoardError('closed', 'This board is closed.');
    if (this.journal.failed) throw new BoardError('storage_failed', 'The board stopped accepting writes after a storage error. Restart Conductor to recover.');
  }

  private tryStamp(): boolean {
    try {
      this.journal.compact(this.snapshot());
      this.opsSinceSnapshot = 0;
      this.stampPending = false;
      return true;
    } catch (e) {
      log.warn(`board snapshot could not be stamped yet: ${(e as Error).message}`);
      return false;
    }
  }

  /** Durable first, memory second: a failed append leaves memory untouched. */
  private commit<T extends JournalOp>(build: (seq: number, ts: number) => T, change: BoardChange): T {
    this.requireWritable();
    const op = build(this.seq + 1, this.now());
    // an op only this schema version understands must never be journalled behind an older/absent snapshot (B1/S4)
    if (this.stampPending && op.t === 'item' && V3_ONLY_ACTORS.has(op.e.createdBy) && !this.tryStamp()) {
      throw new BoardError('storage_failed', 'The board could not be prepared for this card (see the Conductor log for the system error).');
    }
    // never write what the loader would refuse (B-4): a 400-char idemKey must fail NOW, not brick the next start
    const bad = validateEntity(op.t, op.e);
    if (bad) throw new BoardError('bad_input', `That ${op.t} is not valid (${bad}).`);
    try {
      this.journal.append(op);
    } catch (e) {
      // the journal rolled itself back and is now failed: nothing was acknowledged, nothing changed in memory
      // the raw message can carry a filesystem path: keep the detail in the log, not in anything an API/UI client sees
      log.warn(`board write failed: ${(e as Error).message}`);
      throw new BoardError('storage_failed', 'The board could not be written (see the Conductor log for the system error).');
    }
    this.seq = op.seq;
    this.applyOp(op);
    this.opsSinceSnapshot++;
    this.emit(change);
    if (this.opsSinceSnapshot >= this.nextCompactAt) {
      try {
        this.compact();
        this.nextCompactAt = this.compactEvery;
      } catch {
        // the op is durable and in memory; a failed compaction only means a longer journal — never fail the write, retry later
        this.nextCompactAt = this.opsSinceSnapshot + this.compactEvery;
      }
    }
    return op;
  }

  /** Snapshot + empty journal. Called automatically and on close. */
  compact(): void {
    this.requireWritable();
    this.journal.compact(this.snapshot());
    this.opsSinceSnapshot = 0;
  }

  close(): void {
    if (this.closed) return;
    if (!this.readOnly && !this.journal.failed && this.opsSinceSnapshot > 0) {
      try {
        this.compact();
      } catch {
        /* the journal still has everything */
      }
    }
    this.closed = true;
    this.journal.close();
  }

  onChange(cb: (c: BoardChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ─────────────────────────── text hygiene ───────────────────────────
  private text(actor: Actor, v: string, max: number, name: string, opts: { oneLine?: boolean; allowEmpty?: boolean } = {}): string {
    let s = opts.oneLine ? clean(v) : v;
    if (REDACTED_ACTORS.includes(actor)) s = this.redactFn(s); // agent-derived text never reaches the board unredacted (H3)
    if (!opts.allowEmpty && s.trim().length === 0) throw new BoardError('bad_input', `"${name}" cannot be empty.`);
    if (s.length > max) {
      if (actor === 'user') throw new BoardError('too_long', `"${name}" is too long (max ${max} characters).`);
      s = truncate(s, max);
    }
    return s;
  }

  // ─────────────────────────── projects ───────────────────────────
  createProject(input: { key: string; name: string; repo?: string }): Project {
    const key = asString(input.key, 'key');
    if (!PROJECT_KEY_RE.test(key)) throw new BoardError('bad_key', 'A project key is 2–6 capital letters (e.g. APP).');
    if ([...this.projectsById.values()].some((p) => p.key === key)) throw new BoardError('exists', `Project ${key} already exists.`);
    if (input.repo !== undefined && input.repo !== '' && !REPO_NAME_RE.test(input.repo)) throw new BoardError('bad_input', 'A repository name uses letters, numbers, dots, dashes and underscores only.');
    const p: Project = { id: randomUUID(), key, name: this.text('user', asString(input.name, 'name'), 120, 'name', { oneLine: true }), repo: input.repo ?? '', nextSeq: 1, createdAt: this.now() };
    this.commit((seq, ts) => ({ v: 1, seq, ts, t: 'project', e: p }), { type: 'project', id: p.id });
    return { ...p };
  }
  setProject(id: string, patch: { name?: string; repo?: string; archived?: boolean }): Project {
    const cur = this.projectsById.get(id);
    if (!cur) throw new BoardError('not_found', 'Unknown project.');
    const next: Project = { ...cur, ...(patch.name !== undefined ? { name: this.text('user', patch.name, 120, 'name', { oneLine: true }) } : {}), ...(patch.repo !== undefined ? { repo: this.checkRepo(patch.repo) } : {}), ...(patch.archived !== undefined ? { archived: !!patch.archived } : {}) };
    this.commit((seq, ts) => ({ v: 1, seq, ts, t: 'project', e: next }), { type: 'project', id });
    return { ...next };
  }
  private checkRepo(r: string): string {
    if (r !== '' && !REPO_NAME_RE.test(String(r))) throw new BoardError('bad_input', 'A repository name uses letters, numbers, dots, dashes and underscores only.');
    return String(r);
  }
  project(idOrKey: string): Project | undefined {
    const p = this.projectsById.get(idOrKey) ?? [...this.projectsById.values()].find((x) => x.key === idOrKey);
    return p ? { ...p } : undefined;
  }
  projects(): Project[] {
    return [...this.projectsById.values()].sort((a, b) => a.createdAt - b.createdAt).map((p) => ({ ...p }));
  }

  // ─────────────────────────── milestones & decisions ───────────────────────────
  createMilestone(input: { projectId: string; title: string; description?: string; dueAt?: number }, actor: Actor = 'user'): Milestone {
    if (!this.projectsById.has(input.projectId)) throw new BoardError('not_found', 'Unknown project.');
    const m: Milestone = {
      id: randomUUID(),
      projectId: input.projectId,
      title: this.text(actor, asString(input.title, 'title'), LIMITS.title, 'title', { oneLine: true }),
      description: this.text(actor, input.description ?? '', LIMITS.description, 'description', { allowEmpty: true }),
      dueAt: typeof input.dueAt === 'number' && Number.isFinite(input.dueAt) ? input.dueAt : undefined,
      status: 'open',
      createdAt: this.now(),
    };
    this.commit((seq, ts) => ({ v: 1, seq, ts, t: 'milestone', e: m }), { type: 'milestone', id: m.id });
    return { ...m };
  }
  setMilestoneStatus(id: string, status: 'open' | 'done'): Milestone {
    const cur = this.milestonesById.get(id);
    if (!cur) throw new BoardError('not_found', 'Unknown milestone.');
    if (cur.status === status) return { ...cur };
    const next = { ...cur, status };
    this.commit((seq, ts) => ({ v: 1, seq, ts, t: 'milestone', e: next }), { type: 'milestone', id });
    return { ...next };
  }
  milestones(projectId?: string): Milestone[] {
    return [...this.milestonesById.values()].filter((m) => !projectId || m.projectId === projectId).sort((a, b) => a.createdAt - b.createdAt).map((m) => ({ ...m }));
  }

  addDecision(input: { projectId: string; itemId?: string; title: string; body?: string }, actor: Actor = 'user'): Decision {
    if (!this.projectsById.has(input.projectId)) throw new BoardError('not_found', 'Unknown project.');
    if (input.itemId && !this.itemsById.has(input.itemId)) throw new BoardError('not_found', 'Unknown item.');
    const d: Decision = {
      id: randomUUID(),
      projectId: input.projectId,
      itemId: input.itemId,
      title: this.text(actor, asString(input.title, 'title'), LIMITS.title, 'title', { oneLine: true }),
      body: this.text(actor, input.body ?? '', LIMITS.decisionBody, 'body', { allowEmpty: true }),
      author: actor === 'user' ? 'user' : 'conductor',
      ts: this.now(),
    };
    this.reserve(d.title.length + d.body.length);
    this.commit((seq, ts) => ({ v: 1, seq, ts, t: 'decision', e: d }), { type: 'decision', id: d.id });
    this.approxBytes += d.title.length + d.body.length;
    return { ...d };
  }
  decisions(projectId?: string): Decision[] {
    return [...this.decisionsById.values()].filter((d) => !projectId || d.projectId === projectId).sort((a, b) => a.ts - b.ts).map((d) => ({ ...d }));
  }

  // ─────────────────────────── items ───────────────────────────
  private checkDeps(projectId: string, selfId: string | null, deps: string[]): string[] {
    if (deps.length > LIMITS.maxDeps) throw new BoardError('too_many', `An item can depend on at most ${LIMITS.maxDeps} others.`);
    const uniq = [...new Set(deps)];
    for (const d of uniq) {
      const t = this.itemsById.get(d);
      if (!t) throw new BoardError('not_found', 'A dependency does not exist.');
      if (t.projectId !== projectId) throw new BoardError('bad_dependency', 'Dependencies must be in the same project.');
      if (selfId && d === selfId) throw new BoardError('cycle', 'An item cannot depend on itself.');
    }
    if (selfId) {
      // is `selfId` reachable from any dependency (i.e. would adding these edges close a cycle)?
      const seen = new Set<string>();
      const stack = [...uniq];
      while (stack.length) {
        const id = stack.pop()!;
        if (id === selfId) throw new BoardError('cycle', 'That dependency would create a cycle.');
        if (seen.has(id)) continue;
        seen.add(id);
        for (const n of this.itemsById.get(id)?.dependsOn ?? []) stack.push(n);
      }
    }
    return uniq;
  }

  private depth(parentId: string | null): number {
    let d = 0;
    let cur = parentId;
    const seen = new Set<string>();
    while (cur) {
      if (seen.has(cur)) throw new BoardError('cycle', 'Parent chain contains a cycle.');
      seen.add(cur);
      d++;
      cur = this.itemsById.get(cur)?.parentId ?? null;
    }
    return d;
  }

  createItem(input: NewItem, actor: Actor): WorkItem {
    this.requireWritable();
    if (input.idemKey) {
      const existing = this.itemIdem.get(input.idemKey);
      if (existing) return cloneItem(this.itemsById.get(existing)!);
    }
    if (this.itemsById.size >= LIMITS.maxItems) throw new BoardError('full', `The board holds at most ${LIMITS.maxItems} cards.`);
    const project = this.projectsById.get(input.projectId);
    if (!project) throw new BoardError('not_found', 'Unknown project.');
    if (project.archived) throw new BoardError('archived', 'This project is archived.');
    const kind: ItemKind = input.kind ?? 'work';
    if (actor === 'user' && !USER_KINDS.includes(kind)) throw new BoardError('forbidden', `You cannot create an item of kind "${kind}".`);
    const lane: Lane = input.lane ?? 'todo';
    if (!LANES.includes(lane)) throw new BoardError('bad_input', 'Unknown lane.');
    if (actor === 'user' && lane !== 'todo' && lane !== 'backlog') throw new BoardError('forbidden_lane', 'New items start in Backlog or To do.');
    if (input.key !== undefined && actor !== 'import') throw new BoardError('forbidden', 'Only the importer may choose an item key.');
    if (input.external !== undefined && actor !== 'import') throw new BoardError('forbidden', 'Only the importer may attach an external link.');
    const parentId = input.parentId ?? null;
    if (parentId) {
      const parent = this.itemsById.get(parentId);
      if (!parent) throw new BoardError('not_found', 'Unknown parent item.');
      if (parent.projectId !== project.id) throw new BoardError('bad_parent', 'A parent must be in the same project.');
      if (this.depth(parentId) + 1 > LIMITS.maxDepth) throw new BoardError('too_deep', `Items can be nested at most ${LIMITS.maxDepth} levels deep.`);
    }
    if (input.milestoneId) {
      const m = this.milestonesById.get(input.milestoneId);
      if (!m || m.projectId !== project.id) throw new BoardError('not_found', 'Unknown milestone.');
    }
    const deps = this.checkDeps(project.id, null, input.dependsOn ?? []);
    let n = project.nextSeq;
    let key: string;
    if (input.key !== undefined) {
      key = asString(input.key, 'key');
      if (!ITEM_KEY_RE.test(key) || !key.startsWith(`${project.key}-`)) throw new BoardError('bad_key', `Item keys look like ${project.key}-12.`);
      if (this.itemsByKey.has(key)) throw new BoardError('exists', `${key} already exists.`);
      n = Math.max(n, Number(key.slice(project.key.length + 1)) + 1);
    } else {
      key = `${project.key}-${n}`;
      n += 1;
    }
    const ts = actor === 'import' && typeof input.createdAt === 'number' ? input.createdAt : this.now();
    const item: WorkItem = {
      id: randomUUID(),
      key,
      projectId: project.id,
      parentId,
      dependsOn: deps,
      milestoneId: input.milestoneId,
      kind,
      title: this.text(actor, asString(input.title, 'title'), LIMITS.title, 'title', { oneLine: true }),
      description: this.text(actor, input.description ?? '', LIMITS.description, 'description', { allowEmpty: true }),
      lane,
      stage: input.stage,
      autoStart: input.autoStart ?? AUTO_START_KINDS.has(kind),
      createdBy: actor,
      createdAt: ts,
      updatedAt: ts,
      external: input.external ? { ...input.external } : undefined,
      idemKey: input.idemKey,
    };
    // ONE journal line carries the item and the project's bumped counter (C2): a torn write can never re-issue a key.
    this.reserve(item.title.length + item.description.length);
    this.commit((seq, t) => ({ v: 1, seq, ts: t, t: 'item', e: item, nextSeq: { projectId: project.id, value: n } }), { type: 'item', id: item.id });
    this.approxBytes += item.title.length + item.description.length;
    return cloneItem(item);
  }

  item(idOrKey: string): WorkItem | undefined {
    const i = this.itemsById.get(idOrKey) ?? this.itemsByKey.get(idOrKey);
    return i ? cloneItem(i) : undefined;
  }
  items(f: ItemFilter = {}): WorkItem[] {
    const lanes = f.lane === undefined ? null : Array.isArray(f.lane) ? f.lane : [f.lane];
    return [...this.itemsById.values()]
      .filter((i) => (!f.projectId || i.projectId === f.projectId) && (!lanes || lanes.includes(i.lane)) && (f.parentId === undefined || i.parentId === f.parentId) && (!f.kind || i.kind === f.kind))
      .sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key, undefined, { numeric: true }))
      .map(cloneItem);
  }
  children(id: string): WorkItem[] {
    return this.items({ parentId: id });
  }

  /**
   * Items the engine may start: top-level, in To do, auto-start, all dependencies done (and, when the engine injects `dependencyShipped`, pushed). Only `work` by default (K4: ask/research
   * cards have no runner until M5 — otherwise they would run through the build pipeline). The engine also requires "no run yet".
   */
  claimable(kinds: readonly ItemKind[] = ['work'], dependencyShipped?: (dep: WorkItem, dependant: WorkItem) => boolean): WorkItem[] {
    return this.items({ lane: 'todo', parentId: null }).filter((i) => {
      if (!i.autoStart || !kinds.includes(i.kind) || !AUTO_START_KINDS.has(i.kind)) return false;
      // `dependencyShipped` is supplied by the engine and only ever ADDS a condition on a dependency that is already Done. Absent ⇒ today's rule.
      return i.dependsOn.every((d) => {
        const dep = this.itemsById.get(d);
        if (dep?.lane !== 'done') return false;
        if (!dependencyShipped) return true;
        try {
          return dependencyShipped(cloneItem(dep), cloneItem(i));
        } catch {
          return true; // a broken predicate never deadlocks the board: fall back to Done-gating
        }
      });
    });
  }

  setLane(id: string, lane: Lane, actor: Actor, opts: { stage?: string } = {}): WorkItem {
    const cur = this.itemsById.get(id) ?? this.itemsByKey.get(id);
    if (!cur) throw new BoardError('not_found', 'Unknown item.');
    if (!LANES.includes(lane)) throw new BoardError('bad_input', 'Unknown lane.');
    if (actor === 'user' && !HUMAN_LANES.includes(lane)) throw new BoardError('forbidden_lane', `You can move cards to ${HUMAN_LANES.join(', ')} only — Conductor owns the other lanes.`);
    const stage = opts.stage !== undefined ? opts.stage : lane === cur.lane ? cur.stage : undefined;
    if (cur.lane === lane && cur.stage === stage) return cloneItem(cur); // idempotent: no journal line
    const next: WorkItem = { ...cur, lane, stage, updatedAt: this.now() };
    this.commit((seq, ts) => ({ v: 1, seq, ts, t: 'item', e: next }), { type: 'item', id: cur.id });
    return cloneItem(next);
  }

  setFields(id: string, patch: { title?: string; description?: string; milestoneId?: string | null }, actor: Actor): WorkItem {
    const cur = this.itemsById.get(id) ?? this.itemsByKey.get(id);
    if (!cur) throw new BoardError('not_found', 'Unknown item.');
    let next = { ...cur };
    if (patch.title !== undefined) next.title = this.text(actor, asString(patch.title, 'title'), LIMITS.title, 'title', { oneLine: true });
    if (patch.description !== undefined) next.description = this.text(actor, asString(patch.description, 'description'), LIMITS.description, 'description', { allowEmpty: true });
    if (patch.milestoneId !== undefined) {
      if (patch.milestoneId !== null) {
        const m = this.milestonesById.get(patch.milestoneId);
        if (!m || m.projectId !== cur.projectId) throw new BoardError('not_found', 'Unknown milestone.');
        next.milestoneId = patch.milestoneId;
      } else next = { ...next, milestoneId: undefined };
    }
    if (next.title === cur.title && next.description === cur.description && next.milestoneId === cur.milestoneId) return cloneItem(cur);
    next.updatedAt = this.now();
    this.commit((seq, ts) => ({ v: 1, seq, ts, t: 'item', e: next }), { type: 'item', id: cur.id });
    return cloneItem(next);
  }

  setDependsOn(id: string, deps: string[], _actor: Actor): WorkItem {
    const cur = this.itemsById.get(id) ?? this.itemsByKey.get(id);
    if (!cur) throw new BoardError('not_found', 'Unknown item.');
    const next: WorkItem = { ...cur, dependsOn: this.checkDeps(cur.projectId, cur.id, deps), updatedAt: this.now() };
    this.commit((seq, ts) => ({ v: 1, seq, ts, t: 'item', e: next }), { type: 'item', id: cur.id });
    return cloneItem(next);
  }

  // ─────────────────────────── comments ───────────────────────────
  addComment(itemId: string, body: string, actor: Actor, opts: { idemKey?: string } = {}): BoardComment {
    this.requireWritable();
    const item = this.itemsById.get(itemId) ?? this.itemsByKey.get(itemId);
    if (!item) throw new BoardError('not_found', 'Unknown item.');
    if (opts.idemKey) {
      const hit = this.commentIdem.get(`${item.id}|${opts.idemKey}`);
      if (hit) return { ...this.commentsByItem.get(item.id)!.find((c) => c.id === hit)! };
    }
    const c: BoardComment = {
      id: randomUUID(),
      itemId: item.id,
      author: actor === 'user' ? 'user' : 'conductor',
      body: this.text(actor, asString(body, 'body'), LIMITS.comment, 'body'),
      ts: this.now(),
      idemKey: opts.idemKey,
    };
    if ((this.commentsByItem.get(item.id)?.length ?? 0) >= LIMITS.maxCommentsPerItem) throw new BoardError('full', `A card can hold at most ${LIMITS.maxCommentsPerItem} comments.`);
    this.reserve(c.body.length);
    this.commit((seq, ts) => ({ v: 1, seq, ts, t: 'comment', e: c }), { type: 'comment', id: c.id });
    this.approxBytes += c.body.length;
    return { ...c };
  }
  comments(itemId: string): BoardComment[] {
    const item = this.itemsById.get(itemId) ?? this.itemsByKey.get(itemId);
    return item ? (this.commentsByItem.get(item.id) ?? []).map((c) => ({ ...c })) : [];
  }

  /** M8-6 B2c pre-check: could `count` more items holding about `bytes` of text be created now? (Advisory: createItem still enforces.) */
  hasRoom(count: number, bytes: number): boolean {
    return this.itemsById.size + count <= LIMITS.maxItems && this.approxBytes + bytes <= LIMITS.maxBytes;
  }

  stats(): { projects: number; items: number; comments: number; seq: number; opsSinceSnapshot: number } {
    let comments = 0;
    for (const l of this.commentsByItem.values()) comments += l.length;
    return { projects: this.projectsById.size, items: this.itemsById.size, comments, seq: this.seq, opsSinceSnapshot: this.opsSinceSnapshot };
  }

  // ─────────────────────────── the only surface HTTP handlers may use (C4) ───────────────────────────
  readonly user: UserBoard = new UserBoard(this);
}

/**
 * Fixed-actor facade for request-driven writes. It copies only whitelisted fields out of untrusted input and validates
 * the rest, so authorship (`author`, `createdBy`), `kind`, `key`, `external` and Conductor-owned lanes can never come
 * from a request body.
 */
export class UserBoard {
  #b: Board; // truly private: not reachable from a request-driven caller
  constructor(b: Board) {
    this.#b = b;
  }
  private obj(v: unknown): Record<string, unknown> {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BoardError('bad_input', 'Expected a JSON object.');
    return v as Record<string, unknown>;
  }
  createProject(input: unknown): Project {
    const o = this.obj(input);
    return this.#b.createProject({ key: asString(o.key, 'key'), name: asString(o.name, 'name'), repo: typeof o.repo === 'string' ? o.repo : undefined });
  }
  createItem(input: unknown): WorkItem {
    const o = this.obj(input);
    const kind = o.kind === undefined ? 'work' : (o.kind as ItemKind);
    if (!USER_KINDS.includes(kind)) throw new BoardError('forbidden', 'That kind of item cannot be created from the dashboard.');
    const lane = o.lane === undefined ? 'todo' : (o.lane as Lane);
    if (lane !== 'todo' && lane !== 'backlog') throw new BoardError('forbidden_lane', 'New items start in Backlog or To do.');
    return this.#b.createItem(
      {
        projectId: asString(o.projectId, 'projectId'),
        title: asString(o.title, 'title'),
        description: o.description === undefined ? '' : asString(o.description, 'description'),
        kind,
        lane,
        parentId: typeof o.parentId === 'string' ? o.parentId : null,
        dependsOn: Array.isArray(o.dependsOn) ? o.dependsOn.map((d) => asString(d, 'dependsOn[]')) : [],
        milestoneId: typeof o.milestoneId === 'string' ? o.milestoneId : undefined,
        autoStart: typeof o.autoStart === 'boolean' ? o.autoStart : undefined,
      },
      'user',
    );
  }
  comment(itemId: string, body: unknown): BoardComment {
    return this.#b.addComment(itemId, asString(body, 'body'), 'user');
  }
  setFields(itemId: string, input: unknown): WorkItem {
    const o = this.obj(input);
    return this.#b.setFields(itemId, { title: o.title == null ? undefined : asString(o.title, 'title'), description: o.description == null ? undefined : asString(o.description, 'description'), milestoneId: o.milestoneId === null ? null : typeof o.milestoneId === 'string' ? o.milestoneId : undefined }, 'user');
  }
  /** Plain lane change for items WITHOUT a run. (The HTTP layer routes items that have a run through the engine's commands first.) */
  moveLane(itemId: string, lane: unknown): WorkItem {
    if (typeof lane !== 'string' || !LANES.includes(lane as Lane)) throw new BoardError('bad_input', 'Unknown lane.');
    return this.#b.setLane(itemId, lane as Lane, 'user');
  }
  setDependsOn(itemId: string, deps: unknown): WorkItem {
    if (!Array.isArray(deps)) throw new BoardError('bad_input', '"dependsOn" must be an array.');
    return this.#b.setDependsOn(itemId, deps.map((d) => asString(d, 'dependsOn[]')), 'user');
  }
  createMilestone(input: unknown): Milestone {
    const o = this.obj(input);
    return this.#b.createMilestone({ projectId: asString(o.projectId, 'projectId'), title: asString(o.title, 'title'), description: typeof o.description === 'string' ? o.description : '', dueAt: typeof o.dueAt === 'number' ? o.dueAt : undefined }, 'user');
  }
  addDecision(input: unknown): Decision {
    const o = this.obj(input);
    return this.#b.addDecision({ projectId: asString(o.projectId, 'projectId'), itemId: typeof o.itemId === 'string' ? o.itemId : undefined, title: asString(o.title, 'title'), body: typeof o.body === 'string' ? o.body : '' }, 'user');
  }
}

