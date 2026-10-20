import { LANES, type BoardComment, type Decision, type ItemKind, type Milestone, type Project, type WorkItem } from './types.ts';

/** Structural validation of everything read back from disk (security review S-5): a hand-edited or hostile file must not smuggle in bad keys, lanes or links. */
const PROJECT_KEY_RE = /^[A-Z]{2,6}$/;
const ITEM_KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/;
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KINDS: readonly ItemKind[] = ['work', 'ask', 'research', 'subtask', 'bug'];
const ACTORS = ['user', 'conductor', 'import', 'user-ask', 'ask-convert', 'research'];

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function validateProject(p: unknown): string | null {
  if (!obj(p)) return 'project is not an object';
  if (!str(p.id, 100) || !p.id) return 'project.id';
  if (!str(p.key, 6) || !PROJECT_KEY_RE.test(p.key)) return 'project.key';
  if (!str(p.name, 500)) return 'project.name';
  if (!str(p.repo, 64) || (p.repo !== '' && !REPO_NAME_RE.test(p.repo))) return 'project.repo';
  if (!Number.isInteger(p.nextSeq) || (p.nextSeq as number) < 1) return 'project.nextSeq';
  if (!num(p.createdAt)) return 'project.createdAt';
  return null;
}
export function validateMilestone(m: unknown): string | null {
  if (!obj(m)) return 'milestone is not an object';
  if (!str(m.id, 100) || !m.id || !str(m.projectId, 100) || !str(m.title, 1000) || !str(m.description, 200_000) || !num(m.createdAt)) return 'milestone fields';
  if (m.status !== 'open' && m.status !== 'done') return 'milestone.status';
  return null;
}
export function validateItem(i: unknown): string | null {
  if (!obj(i)) return 'item is not an object';
  if (!str(i.id, 100) || !i.id) return 'item.id';
  if (!str(i.key, 40) || !ITEM_KEY_RE.test(i.key)) return `item.key (${String(i.key).slice(0, 40)})`;
  if (!str(i.projectId, 100)) return 'item.projectId';
  if (i.parentId !== null && !str(i.parentId, 100)) return 'item.parentId';
  if (!Array.isArray(i.dependsOn) || i.dependsOn.length > 200 || !i.dependsOn.every((d) => str(d, 100))) return 'item.dependsOn';
  if (!KINDS.includes(i.kind as ItemKind)) return 'item.kind';
  if (!str(i.title, 1000) || !str(i.description, 200_000)) return 'item.title/description';
  if (!LANES.includes(i.lane as never)) return 'item.lane';
  if (i.stage !== undefined && !str(i.stage, 64)) return 'item.stage';
  if (typeof i.autoStart !== 'boolean') return 'item.autoStart';
  if (!ACTORS.includes(i.createdBy as string)) return 'item.createdBy';
  if (!num(i.createdAt) || !num(i.updatedAt)) return 'item.createdAt/updatedAt';
  if (i.milestoneId !== undefined && !str(i.milestoneId, 100)) return 'item.milestoneId';
  if (i.idemKey !== undefined && !str(i.idemKey, 300)) return 'item.idemKey';
  if (i.external !== undefined) {
    const e = i.external;
    if (!obj(e) || e.system !== 'linear' || !str(e.key, 64) || !str(e.url, 500) || !/^https:\/\/linear\.app\//.test(e.url)) return 'item.external';
  }
  return null;
}
export function validateComment(c: unknown): string | null {
  if (!obj(c)) return 'comment is not an object';
  if (!str(c.id, 100) || !c.id || !str(c.itemId, 100) || !str(c.body, 400_000) || !num(c.ts)) return 'comment fields';
  if (c.author !== 'user' && c.author !== 'conductor') return 'comment.author';
  if (c.idemKey !== undefined && !str(c.idemKey, 300)) return 'comment.idemKey';
  return null;
}
export function validateDecision(d: unknown): string | null {
  if (!obj(d)) return 'decision is not an object';
  if (!str(d.id, 100) || !d.id || !str(d.projectId, 100) || !str(d.title, 1000) || !str(d.body, 200_000) || !num(d.ts)) return 'decision fields';
  if (d.author !== 'user' && d.author !== 'conductor') return 'decision.author';
  if (d.itemId !== undefined && !str(d.itemId, 100)) return 'decision.itemId';
  return null;
}
export function validateEntity(t: string, e: unknown): string | null {
  switch (t) {
    case 'project': return validateProject(e);
    case 'milestone': return validateMilestone(e);
    case 'item': return validateItem(e);
    case 'comment': return validateComment(e);
    case 'decision': return validateDecision(e);
    default: return 'unknown entity';
  }
}
export type { BoardComment, Decision, Milestone, Project, WorkItem };
