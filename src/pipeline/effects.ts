import type { EffectRec, LinearPort, Run } from '../types.ts';
import type { RunStore } from '../store.ts';
import { errMsg, truncate } from '../util.ts';
import { redact } from '../redact.ts';
import { hasMarker, markerLine } from '../linear/attribution.ts';
import { logger } from '../log.ts';

const log = logger('effects');
const MAX_ATTEMPTS = 12;
const COMMENT_LIMIT = 30_000;

type StatePayload = { stateId?: string; addLabelIds?: string[]; removeLabelIds?: string[] };
type SubIssuePayload = { fp: string; title: string; description: string; labelIds: string[]; stateId?: string; teamId: string };

export interface EffectsDeps {
  store: RunStore;
  linear: () => LinearPort | null;
  secrets: (run: Run) => string[];
}

/**
 * Idempotent Linear side effects (RC6). Every effect is written to the run record as `pending` BEFORE it is
 * attempted; on retry (or after a crash) a marker lookup adopts a half-completed write instead of duplicating it.
 */
export class Effects {
  private deps: EffectsDeps;
  private chains = new Map<string, Promise<unknown>>();

  constructor(deps: EffectsDeps) {
    this.deps = deps;
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(key, next.catch(() => undefined));
    return next;
  }

  private marker(run: Run, effKey: string): string {
    return `${run.key}:${effKey}`;
  }

  private setRec(key: string, effKey: string, patch: Partial<EffectRec> & { kind: EffectRec['kind'] }): void {
    this.deps.store.update(key, (r) => {
      const cur = r.effects[effKey];
      r.effects[effKey] = { ...cur, ...patch, status: patch.status ?? cur?.status ?? 'pending', attempts: cur?.attempts ?? 0 };
    });
  }

  /** Post a comment once per (run, effKey). */
  comment(key: string, effKey: string, body: string): Promise<void> {
    return this.serial(key, async () => {
      const run = this.deps.store.get(key);
      if (!run || run.effects[effKey]?.status === 'done') return;
      const safe = truncate(redact(body, this.deps.secrets(run)), COMMENT_LIMIT);
      this.setRec(key, effKey, { kind: 'comment', payload: { body: safe } });
      await this.apply(key, effKey);
    });
  }

  /** Update state/labels; also records `run.expected`. */
  state(key: string, effKey: string, payload: StatePayload, stageName?: string): Promise<void> {
    return this.serial(key, async () => {
      const run = this.deps.store.get(key);
      if (!run) return;
      // state effects are naturally idempotent: always re-apply the latest intent under the same key
      this.setRec(key, effKey, { kind: 'state', status: 'pending', payload: { ...payload, stageName } });
      await this.apply(key, effKey);
    });
  }

  /** Create a bug sub-issue once; returns its id/identifier when known. */
  subIssue(key: string, effKey: string, payload: SubIssuePayload): Promise<{ id: string; identifier?: string } | null> {
    return this.serial(key, async () => {
      const run = this.deps.store.get(key);
      if (!run) return null;
      const cur = run.effects[effKey];
      if (cur?.status === 'done' && cur.linearId) return { id: cur.linearId };
      this.setRec(key, effKey, { kind: 'subissue', payload });
      await this.apply(key, effKey);
      const after = this.deps.store.get(key)?.effects[effKey];
      return after?.linearId ? { id: after.linearId } : null;
    });
  }

  /** Move a Linear issue (e.g. a bug sub-issue) to a completed state. */
  close(key: string, effKey: string, issueId: string, doneStateId: string): Promise<void> {
    return this.serial(key, async () => {
      const run = this.deps.store.get(key);
      if (!run || run.effects[effKey]?.status === 'done') return;
      this.setRec(key, effKey, { kind: 'close', payload: { issueId, doneStateId } });
      await this.apply(key, effKey);
    });
  }

  /** Re-attempt every pending effect of a run (called each poll). */
  flush(key: string): Promise<void> {
    return this.serial(key, async () => {
      const run = this.deps.store.get(key);
      if (!run) return;
      for (const [effKey, rec] of Object.entries(run.effects)) {
        if (rec.status === 'pending') await this.apply(key, effKey);
      }
    });
  }

  pendingCount(key: string): number {
    const run = this.deps.store.get(key);
    return run ? Object.values(run.effects).filter((e) => e.status === 'pending').length : 0;
  }

  private async apply(key: string, effKey: string): Promise<void> {
    const linear = this.deps.linear();
    const run = this.deps.store.get(key);
    const rec = run?.effects[effKey];
    if (!linear || !run || !rec || rec.status === 'done') return;
    const lookup = (rec.attempts ?? 0) > 0; // a previous attempt may have half-succeeded
    const mk = this.marker(run, effKey);
    try {
      let linearId: string | undefined = rec.linearId;
      if (rec.kind === 'comment') {
        const body = String((rec.payload as { body: string }).body);
        let found: string | undefined;
        if (lookup) {
          const issue = await linear.issue(run.issueId);
          found = issue.comments?.find((c) => hasMarker(c.body, mk))?.id;
        }
        linearId = found ?? (await linear.comment(run.issueId, `${body}\n\n${markerLine(mk)}`)).id;
      } else if (rec.kind === 'state') {
        const p = rec.payload as StatePayload & { stageName?: string };
        await linear.update(run.issueId, { stateId: p.stateId, addLabelIds: p.addLabelIds, removeLabelIds: p.removeLabelIds });
        this.deps.store.update(key, (r) => {
          r.expected = { stateId: p.stateId ?? r.expected.stateId, stage: p.stageName ?? r.expected.stage };
        });
      } else if (rec.kind === 'subissue') {
        const p = rec.payload as SubIssuePayload;
        let found: string | undefined;
        if (lookup) found = (await linear.children(run.issueId)).find((c) => hasMarker(c.description ?? '', mk))?.id;
        if (found) linearId = found;
        else {
          const created = await linear.createIssue({
            teamId: p.teamId,
            title: truncate(p.title, 200),
            description: `${truncate(redact(p.description, this.deps.secrets(run)), 20_000)}\n\n${markerLine(mk)}`,
            parentId: run.issueId,
            labelIds: p.labelIds,
            stateId: p.stateId,
          });
          linearId = created.id;
          this.deps.store.update(key, (r) => {
            const b = r.bugs.find((x) => x.fp === p.fp);
            if (b) {
              b.linearId = created.id;
              b.linearKey = created.identifier;
            }
          });
        }
      } else if (rec.kind === 'close') {
        const p = rec.payload as { issueId: string; doneStateId: string };
        await linear.update(p.issueId, { stateId: p.doneStateId });
      }
      this.deps.store.update(key, (r) => {
        const e = r.effects[effKey];
        if (e) {
          e.status = 'done';
          e.linearId = linearId ?? e.linearId;
          e.lastError = undefined;
        }
      });
    } catch (e) {
      const msg = redact(errMsg(e), this.deps.secrets(run));
      log.warn(`${key} effect ${effKey} failed: ${msg}`);
      this.deps.store.update(key, (r) => {
        const x = r.effects[effKey];
        if (!x) return;
        x.attempts = (x.attempts ?? 0) + 1;
        x.lastError = truncate(msg, 300);
        if (x.attempts >= MAX_ATTEMPTS) x.status = 'done'; // give up; never loop forever
      });
    }
  }
}
