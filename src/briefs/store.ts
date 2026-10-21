// Brief records (M8-6 §2.7): one JSON file per brief under `<home>/briefs/` (0700 dir, 0600 files, durable atomic writes, versioned, ≤ 256 KB)
// plus a capped index. Created lazily (like `<home>/asks`, N9). Every id is checked before a path is built; every record is re-validated
// and RE-SHAPED on load (T10: the directory is same-user writable). Trust never comes from the file: the card actor is a code constant and
// every send re-validates `parts` against the loaded record.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { paths } from '../paths.ts';
import { atomicWriteFile } from '../util.ts';
import { quarantine } from '../schema/version.ts';
import { sanitizeLine } from '../pipeline/graph.ts';
import { BRIEF_ID_RE, type BriefRecord, type BriefStatus, type BriefStep, type StepId, type StepState } from './types.ts';
import { reshapeStoredWork, shapeResearchBrief } from './schemas.ts';
import { ASK_ID_RE } from '../asks/store.ts';

export const BRIEF_LIMITS = Object.freeze({ line: 4000, file: 256 * 1024, index: 200, events: 100, eventChars: 600, error: 500 });
const STATUSES: readonly BriefStatus[] = ['running', 'ready', 'failed', 'canceled', 'sending', 'sent', 'send_failed'];
const STEP_IDS: readonly StepId[] = ['scan', 'brief', 'parts'];
const STEP_STATES: readonly StepState[] = ['pending', 'running', 'done', 'stopped', 'failed'];
const CARD_KEY_RE = /^[A-Z]{2,6}-\d{1,9}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const briefDir = (): string => join(paths.home(), 'briefs');
export const newBriefId = (): string => `brf-${randomBytes(8).toString('hex')}`;
export function assertBriefId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !BRIEF_ID_RE.test(id)) throw new Error('not a brief id');
}
function ensureDir(): string {
  const d = briefDir();
  mkdirSync(paths.home(), { recursive: true, mode: 0o700 });
  try {
    const st = lstatSync(d);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${d} is not a real directory`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    mkdirSync(d, { mode: 0o700 });
  }
  chmodSync(d, 0o700);
  return d;
}

const own = (o: unknown, k: string): unknown => (o !== null && typeof o === 'object' && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const oneLine = (v: unknown, n: number): string => (typeof v === 'string' ? sanitizeLine(v, n) : '');

/** A record from untrusted bytes; null when it is not one. */
export function validateBrief(raw: unknown, id: string): BriefRecord | null {
  if (own(raw, 'id') !== id || own(raw, 'schemaVersion') !== 1) return null;
  const status = own(raw, 'status') as BriefStatus;
  if (!STATUSES.includes(status)) return null;
  const kind = own(raw, 'kind');
  if (kind !== 'work' && kind !== 'research') return null;
  const line = oneLine(own(raw, 'line'), BRIEF_LIMITS.line);
  if (!line) return null;
  const repo = own(raw, 'repo');
  const steps: BriefStep[] = arr(own(raw, 'steps')).slice(0, 3).flatMap((s) => {
    const sid = own(s, 'id') as StepId;
    const st = own(s, 'state') as StepState;
    return STEP_IDS.includes(sid) && STEP_STATES.includes(st) ? [{ id: sid, label: oneLine(own(s, 'label'), 120), state: st, detail: oneLine(own(s, 'detail'), 300) }] : [];
  });
  const hb = own(raw, 'handledBy');
  const hp = own(hb, 'provider');
  const hr = own(hb, 'role');
  const scan = own(raw, 'scan');
  const sent = own(raw, 'sent');
  const work = own(raw, 'work');
  const research = own(raw, 'research');
  // a brief that claims to be ready/sent must carry a valid body of its kind (an extra 9th part, a forward dep … ⇒ quarantine)
  const shapedWork = kind === 'work' && work !== undefined ? reshapeStoredWork(work) : undefined;
  const shapedResearch = kind === 'research' && research !== undefined ? shapeResearchBrief(research) : undefined;
  if (shapedWork === null || shapedResearch === null) return null;
  if (['ready', 'sending', 'sent', 'send_failed'].includes(status) && !(shapedWork || shapedResearch)) return null;
  const ek = own(raw, 'errorKind');
  const depth = own(sent, 'depth');
  const askId = own(sent, 'askId');
  return {
    schemaVersion: 1,
    id,
    kind,
    line,
    repo: typeof repo === 'string' && REPO_RE.test(repo) ? repo : null,
    status,
    steps,
    handledBy: (hp === 'claude' || hp === 'cursor' || hp === 'codex') && (hr === 'requirements' || hr === 'context') ? { provider: hp, role: hr, ...(typeof own(hb, 'tierNote') === 'string' ? { tierNote: oneLine(own(hb, 'tierNote'), 300) } : {}) } : null,
    scan: scan && typeof scan === 'object' ? { repo: oneLine(own(scan, 'repo'), 64), branch: oneLine(own(scan, 'branch'), 200), sha: /^[0-9a-f]{7}$/.test(String(own(scan, 'sha'))) ? String(own(scan, 'sha')) : '', snapshotFiles: num(own(scan, 'snapshotFiles')), ...(typeof own(scan, 'note') === 'string' ? { note: oneLine(own(scan, 'note'), 300) } : {}) } : null,
    ...(shapedWork ? { work: shapedWork } : {}),
    ...(shapedResearch ? { research: shapedResearch } : {}),
    sent: sent && typeof sent === 'object'
      ? {
          at: num(own(sent, 'at')),
          ...(Array.isArray(own(sent, 'parts')) ? { parts: [...new Set(arr(own(sent, 'parts')).filter((p): p is string => typeof p === 'string' && /^P[1-8]$/.test(p)))] } : {}),
          ...(Array.isArray(own(sent, 'cards')) ? { cards: arr(own(sent, 'cards')).slice(0, 8).flatMap((c) => (typeof own(c, 'part') === 'string' && /^P[1-8]$/.test(own(c, 'part') as string) && typeof own(c, 'key') === 'string' && CARD_KEY_RE.test(own(c, 'key') as string) ? [{ part: own(c, 'part') as string, key: own(c, 'key') as string, dependsOn: arr(own(c, 'dependsOn')).filter((k): k is string => typeof k === 'string' && CARD_KEY_RE.test(k)).slice(0, 8) }] : [])) } : {}),
          ...(depth === 'standard' || depth === 'deep' ? { depth } : {}),
          ...(typeof askId === 'string' && ASK_ID_RE.test(askId) ? { askId } : {}),
          ...(typeof own(sent, 'error') === 'string' ? { error: oneLine(own(sent, 'error'), 300) } : {}),
        }
      : null,
    error: typeof own(raw, 'error') === 'string' ? oneLine(own(raw, 'error'), BRIEF_LIMITS.error) : null,
    ...(ek === 'limited' || ek === 'failed' || ek === 'interrupted' ? { errorKind: ek } : {}),
    ...(typeof own(raw, 'retryAt') === 'number' ? { retryAt: num(own(raw, 'retryAt')) } : {}),
    ...(typeof own(raw, 'takenKey') === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(own(raw, 'takenKey') as string) ? { takenKey: own(raw, 'takenKey') as string } : {}),
    ...(own(raw, 'refunded') === true ? { refunded: true } : {}),
    events: arr(own(raw, 'events')).filter((e): e is string => typeof e === 'string').slice(-BRIEF_LIMITS.events).map((e) => oneLine(e, BRIEF_LIMITS.eventChars)),
    createdAt: num(own(raw, 'createdAt')),
    updatedAt: num(own(raw, 'updatedAt')),
  };
}

export function listBriefIds(): string[] {
  const d = briefDir();
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((n) => n.endsWith('.json') && BRIEF_ID_RE.test(n.slice(0, -5))).map((n) => n.slice(0, -5));
}

export function loadBrief(id: string): BriefRecord | null {
  assertBriefId(id);
  const f = join(briefDir(), `${id}.json`);
  if (!existsSync(f)) return null;
  try {
    if (!lstatSync(f).isFile() || statSync(f).size > BRIEF_LIMITS.file) throw new Error('not a small regular file');
    const rec = validateBrief(JSON.parse(readFileSync(f, 'utf8')), id);
    if (!rec) throw new Error('shape');
    return rec;
  } catch {
    quarantine(f);
    return null;
  }
}

/** Save (durable, atomic). Index pruning (cap 200) NEVER removes a `running` or `sending` record (B2b): they are not victims. */
export function saveBrief(rec: BriefRecord): void {
  assertBriefId(rec.id);
  const dir = ensureDir();
  const text = JSON.stringify(rec) + '\n';
  if (Buffer.byteLength(text) > BRIEF_LIMITS.file) throw new Error('brief record too large');
  atomicWriteFile(join(dir, `${rec.id}.json`), text, 0o600, { durable: true });
  const ids = listBriefIds();
  if (ids.length > BRIEF_LIMITS.index) {
    const recs = ids.map((id) => loadBrief(id)).filter((r): r is BriefRecord => !!r);
    const victims = recs.filter((r) => r.id !== rec.id && r.status !== 'running' && r.status !== 'sending').sort((a, b) => a.updatedAt - b.updatedAt);
    for (const old of victims.slice(0, Math.max(0, recs.length - BRIEF_LIMITS.index))) rmSync(join(dir, `${old.id}.json`), { force: true });
  }
}

export function deleteBrief(id: string): void {
  assertBriefId(id);
  rmSync(join(briefDir(), `${id}.json`), { force: true });
}

export function listBriefs(limit = 50): BriefRecord[] {
  return listBriefIds().map((id) => loadBrief(id)).filter((r): r is BriefRecord => !!r).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}
