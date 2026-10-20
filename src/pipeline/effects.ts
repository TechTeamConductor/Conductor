import type { EffectRec, Run } from '../types.ts';
import type { RunStore } from '../store.ts';
import type { Board } from '../board/index.ts';
import { BoardError } from '../board/types.ts';
import { laneForRun } from '../board/lanes.ts';
import { errMsg, truncate } from '../util.ts';
import { redact } from '../redact.ts';
import { logger } from '../log.ts';

const log = logger('effects');
const COMMENT_LIMIT = 30_000;
/** An effect still failing this long after its first failure is reported as a storage problem (a brief hiccup is not). */
const STUCK_MS = 15_000;
/** BoardError codes that no amount of retrying fixes. Everything else (storage_failed, closed, read_only, full, raw I/O errors) is transient. */
const PERMANENT = new Set(['not_found', 'bad_input', 'too_long', 'bad_key', 'bad_parent', 'bad_dependency', 'archived', 'cycle', 'too_deep', 'too_many', 'exists', 'forbidden', 'forbidden_lane']);

/** Agent-written text is untrusted: no remote images (tracking/exfil) in rendered markdown. */
function neutralise(s: string): string {
  return s.replace(/!\[/g, '!\\[');
}

type SubIssuePayload = { fp: string; title: string; description: string };
/** One subtask card per task-graph item (M3). `dependsOn` are the SIBLING ITEM ids (T1, T2, …) — mapped to board ids at apply time. */
type SubtaskPayload = { rev: number; itemId: string; title: string; description: string; dependsOn: string[] };
export type EffectInput =
  | { kind: 'comment'; payload: { body: string; itemId?: string } }
  | { kind: 'state'; payload: { stage?: string } }
  | { kind: 'subissue'; payload: SubIssuePayload }
  | { kind: 'close'; payload: { itemId: string; lane: 'done' | 'todo' } }
  | { kind: 'subtask'; payload: SubtaskPayload }
  /** A superseded graph's card (the plan was replaced): canceled, with a note. The target is a board id that Conductor itself created. */
  | { kind: 'subtask-cancel'; payload: { itemId: string; rev: number } };

export interface EffectsDeps {
  store: RunStore;
  board: Board;
  secrets: (run: Run) => string[];
  now?: () => number;
}

/**
 * Conductor's writes to the board (crash protocol, workspace-v2-m1.md):
 *   1. the effect is recorded as `pending` in run.json — for the transitions that matter in the SAME `RunStore.update` as the
 *      status change (`Effects.enqueue`, used inside the caller's patch; condition K1);
 *   2. it is applied to the board with an idempotency key `<RUN>:<effKey>` (a replay is a no-op);
 *   3. it is marked `done`. `flush()` re-applies anything still pending (every tick and once at startup).
 * A local write cannot half-fail across a network, so there are no marker lookups and no give-up counter; a persistent
 * storage failure is surfaced (`storageProblem`) and retried with back-off instead of every tick (condition K3).
 */
export class Effects {
  private deps: EffectsDeps;
  private nextTry = new Map<string, number>(); // `${key}|${effKey}` → epoch ms (back-off for failing writes)
  private lastFailure: string | null = null;
  private failedSince = new Map<string, number>(); // `${key}|${effKey}` → first transient failure (ms)

  constructor(deps: EffectsDeps) {
    this.deps = deps;
  }
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * Non-null while some effect has been failing to reach the board for ≥ 15 s and is still pending; clears by itself once every
   * such effect has gone through. (A success of a *different* effect does not hide a stuck one.)
   */
  storageProblem(): string | null {
    if (!this.lastFailure) return null;
    const now = this.now();
    for (const [k, since] of [...this.failedSince]) {
      const [key, effKey] = k.split('|') as [string, string];
      if (this.deps.store.get(key)?.effects[effKey]?.status !== 'pending') {
        this.failedSince.delete(k);
        continue;
      }
      if (now - since >= STUCK_MS) return `The board could not be written: ${this.lastFailure}`;
    }
    if (!this.failedSince.size) this.lastFailure = null;
    return null;
  }

  /** Mutate `run` (inside the caller's `store.update`) so the effect is recorded atomically with the caller's own changes. */
  static enqueue(run: Run, effKey: string, input: EffectInput, secrets: readonly string[] = []): void {
    const cur = run.effects[effKey];
    const alwaysRepend = input.kind === 'state'; // state intents are re-applied under the same key: the latest one wins
    if (cur?.status === 'done' && !alwaysRepend) return;
    let payload: unknown = input.payload;
    if (input.kind === 'comment') {
      const p = input.payload;
      payload = { ...p, body: neutralise(truncate(redact(p.body, secrets), COMMENT_LIMIT)) };
    } else if (input.kind === 'subissue') {
      const p = input.payload;
      payload = { fp: p.fp, title: truncate(redact(p.title, secrets), 200), description: truncate(redact(p.description, secrets), 20_000) };
    } else if (input.kind === 'subtask') {
      const p = input.payload;
      payload = {
        rev: p.rev,
        itemId: p.itemId,
        title: truncate(redact(p.title, secrets), 160),
        description: neutralise(truncate(redact(p.description, secrets), 4_000)),
        dependsOn: p.dependsOn.slice(0, 12),
      };
    }
    run.effects[effKey] = { ...cur, kind: input.kind, status: 'pending', payload, attempts: alwaysRepend ? 0 : cur?.attempts ?? 0 } as EffectRec;
  }

  private enqueueAndApply(key: string, effKey: string, input: EffectInput): void {
    const run = this.deps.store.get(key);
    if (!run) return;
    if (input.kind !== 'state' && run.effects[effKey]?.status === 'done') return;
    this.deps.store.update(key, (r) => Effects.enqueue(r, effKey, input, this.deps.secrets(r)));
    this.apply(key, effKey);
  }

  async comment(key: string, effKey: string, body: string): Promise<void> {
    this.enqueueAndApply(key, effKey, { kind: 'comment', payload: { body } });
  }
  /** A comment on a *different* item (e.g. a bug child). */
  async commentOn(key: string, effKey: string, itemId: string, body: string): Promise<void> {
    this.enqueueAndApply(key, effKey, { kind: 'comment', payload: { body, itemId } });
  }
  /** Project the run's stage label (and lane — derived from the run's CURRENT status at apply time) onto the board. */
  async state(key: string, effKey: string, payload: { stage?: string }): Promise<void> {
    this.enqueueAndApply(key, effKey, { kind: 'state', payload });
  }
  /** File a bug child item once; returns its id when known. */
  async subIssue(key: string, effKey: string, payload: SubIssuePayload): Promise<{ id: string; key?: string } | null> {
    const run = this.deps.store.get(key);
    if (!run) return null;
    const cur = run.effects[effKey];
    if (cur?.status === 'done' && cur.refId) return { id: cur.refId };
    this.enqueueAndApply(key, effKey, { kind: 'subissue', payload });
    const after = this.deps.store.get(key)?.effects[effKey];
    return after?.refId ? { id: after.refId, key: this.deps.board.item(after.refId)?.key } : null;
  }
  /** Create (once) the subtask card for one task-graph item. */
  async subtask(key: string, effKey: string, payload: SubtaskPayload): Promise<void> {
    this.enqueueAndApply(key, effKey, { kind: 'subtask', payload });
  }
  /** Cancel a superseded graph's card. */
  async subtaskCancel(key: string, effKey: string, itemId: string, rev: number): Promise<void> {
    this.enqueueAndApply(key, effKey, { kind: 'subtask-cancel', payload: { itemId, rev } });
  }
  /** Move a bug child (close = done, reopen = todo). */
  async close(key: string, effKey: string, itemId: string, lane: 'done' | 'todo' = 'done'): Promise<void> {
    this.enqueueAndApply(key, effKey, { kind: 'close', payload: { itemId, lane } });
  }

  /** Re-attempt every pending effect of a run. */
  async flush(key: string): Promise<void> {
    const run = this.deps.store.get(key);
    if (!run) return;
    for (const [effKey, rec] of Object.entries(run.effects)) {
      if (rec.status !== 'pending') continue;
      if ((this.nextTry.get(`${key}|${effKey}`) ?? 0) > this.now()) continue;
      this.apply(key, effKey);
    }
  }

  /** True when the run has any pending effect (the startup flush covers exactly these runs). */
  hasPending(run: Run): boolean {
    return Object.values(run.effects).some((e) => e.status === 'pending');
  }
  pendingCount(key: string): number {
    const run = this.deps.store.get(key);
    return run ? Object.values(run.effects).filter((e) => e.status === 'pending').length : 0;
  }

  /** A run's board effects may touch ONLY its own card and that card's children (never an id that came from a stored record). */
  private assertOwnChild(run: { itemId: string }, target: string): void {
    const t = this.deps.board.item(target);
    if (!t) throw new BoardError('not_found', 'That card no longer exists.');
    if (t.parentId !== run.itemId) throw new BoardError('forbidden', 'A run may only act on its own bug cards.');
  }

  private apply(key: string, effKey: string): void {
    const run = this.deps.store.get(key);
    const rec = run?.effects[effKey];
    if (!run || !rec || rec.status === 'done') return;
    const board = this.deps.board;
    const mk = `${run.key}:${effKey}`;
    try {
      let refId: string | undefined = rec.refId;
      if (rec.kind === 'comment') {
        const p = rec.payload as { body: string; itemId?: string };
        if (p.itemId && p.itemId !== run.itemId) this.assertOwnChild(run, p.itemId);
        refId = board.addComment(p.itemId ?? run.itemId, String(p.body), 'conductor', { idemKey: mk }).id;
      } else if (rec.kind === 'state') {
        const p = rec.payload as { stage?: string };
        const lane = laneForRun(run);
        board.setLane(run.itemId, lane, 'conductor', { stage: p.stage });
        this.deps.store.update(key, (r) => {
          r.expected = { written: true, stage: p.stage ?? r.expected.stage };
        });
      } else if (rec.kind === 'subissue') {
        const p = rec.payload as SubIssuePayload;
        const parent = board.item(run.itemId);
        if (!parent) throw new BoardError('not_found', 'The parent card no longer exists.');
        const created = board.createItem({ projectId: parent.projectId, title: p.title, description: p.description, kind: 'bug', parentId: parent.id, lane: 'todo', autoStart: false, idemKey: mk }, 'conductor');
        refId = created.id;
        this.deps.store.update(key, (r) => {
          const b = r.bugs.find((x) => x.fp === p.fp);
          if (b) {
            b.itemId = created.id;
            b.itemKey = created.key;
          }
        });
      } else if (rec.kind === 'close') {
        const p = rec.payload as { itemId: string; lane: 'done' | 'todo' };
        this.assertOwnChild(run, p.itemId);
        board.setLane(p.itemId, p.lane, 'conductor');
      } else if (rec.kind === 'subtask') {
        const p = rec.payload as SubtaskPayload;
        const parent = board.item(run.itemId);
        if (!parent) throw new BoardError('not_found', 'The parent card no longer exists.');
        // sibling cards that already exist (created by an earlier effect of the same graph): item id → board id. A sibling that was deleted
        // by a human simply has no mapping — the dependency edge is dropped (the graph itself, in run.json, remains the source of truth).
        const g = run.graph;
        const siblings = new Map<string, string>();
        for (const it of g && g.rev === p.rev ? g.items : []) if (it.key) {
          const card = board.item(it.key);
          if (card && card.parentId === run.itemId) siblings.set(it.id, card.id);
        }
        // cards are created in dependency order; if a prerequisite's card is merely not written YET, wait (transient) rather than drop the edge
        for (const d of p.dependsOn) {
          if (!siblings.has(d) && run.effects[`subtask:${p.rev}:${d}`]?.status === 'pending') throw new Error(`waiting for the card of ${d}`);
        }
        const deps = p.dependsOn.map((d) => siblings.get(d)).filter((d): d is string => !!d);
        const created = board.createItem(
          { projectId: parent.projectId, title: `${p.itemId} · ${p.title}`, description: p.description, kind: 'subtask', parentId: parent.id, dependsOn: deps, lane: 'todo', autoStart: false, idemKey: mk },
          'conductor',
        );
        refId = created.id;
        this.deps.store.update(key, (r) => {
          const it = r.graph && r.graph.rev === p.rev ? r.graph.items.find((x) => x.id === p.itemId) : undefined;
          if (it) it.key = created.key;
        });
      } else if (rec.kind === 'subtask-cancel') {
        const p = rec.payload as { itemId: string; rev: number };
        this.assertOwnChild(run, p.itemId);
        board.setLane(p.itemId, 'canceled', 'conductor');
        board.addComment(p.itemId, `Superseded — the plan was replaced (revision ${p.rev + 1} or later). This task is no longer part of the work.`, 'conductor', { idemKey: mk });
      }
      this.nextTry.delete(`${key}|${effKey}`);
      this.failedSince.delete(`${key}|${effKey}`);
      this.deps.store.update(key, (r) => {
        const e = r.effects[effKey];
        if (e) {
          e.status = 'done';
          e.refId = refId ?? e.refId;
          e.lastError = undefined;
          e.attempts = 0;
        }
      });
    } catch (e) {
      const msg = redact(errMsg(e), this.deps.secrets(run));
      // Only errors that retrying can never fix are permanent (the target card vanished, the text is invalid). Storage failures —
      // a failed/closed/read-only board, a full board, any I/O error — are transient: the effect stays pending and is surfaced (K3).
      const permanent = e instanceof BoardError && PERMANENT.has(e.code);
      log.warn(`${key} effect ${effKey} failed${permanent ? ' (giving up)' : ''}: ${msg}`);
      this.deps.store.update(key, (r) => {
        const x = r.effects[effKey];
        if (!x) return;
        x.lastError = truncate(msg, 300);
        x.attempts = (x.attempts ?? 0) + 1;
        if (permanent) x.status = 'done';
      });
      if (!permanent) {
        const n = this.deps.store.get(key)?.effects[effKey]?.attempts ?? 1;
        this.nextTry.set(`${key}|${effKey}`, this.now() + Math.min(5 * 60_000, 2_000 * 2 ** Math.min(n, 8)));
        this.lastFailure = truncate(msg, 160);
        if (!this.failedSince.has(`${key}|${effKey}`)) this.failedSince.set(`${key}|${effKey}`, this.now());
      }
    }
  }
}
