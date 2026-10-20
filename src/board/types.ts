// Native board model (M1a). Pure data types — no behaviour. See .techteam/plans/workspace-v2-m1.md §2.

export const BOARD_SCHEMA_VERSION = 1;

/** `lane` (not "column": `BoardColumn` already names a dashboard type). Humans may set only HUMAN_LANES; Conductor owns the rest. */
export type Lane = 'backlog' | 'todo' | 'active' | 'needs_you' | 'review' | 'done' | 'canceled';
export const LANES: readonly Lane[] = ['backlog', 'todo', 'active', 'needs_you', 'review', 'done', 'canceled'];
export const HUMAN_LANES: readonly Lane[] = ['backlog', 'todo', 'done', 'canceled'];

export type ItemKind = 'work' | 'ask' | 'research' | 'subtask' | 'bug';
export const USER_KINDS: readonly ItemKind[] = ['work', 'ask', 'research', 'subtask'];
export type Actor = 'user' | 'conductor' | 'import';

export interface Project {
  id: string;
  key: string; // [A-Z]{2,6}
  name: string;
  repo: string; // registered repo name ('' until bound)
  nextSeq: number;
  createdAt: number;
  archived?: boolean;
}

export interface Milestone {
  id: string;
  projectId: string;
  title: string;
  description: string;
  dueAt?: number;
  status: 'open' | 'done';
  createdAt: number;
}

export interface ExternalLink {
  system: 'linear';
  key: string;
  /** Only ever rendered as a link when it is https://linear.app/… (UI check). */
  url: string;
}

export interface WorkItem {
  id: string;
  key: string; // <PROJECT>-<n>
  projectId: string;
  parentId: string | null;
  dependsOn: string[]; // item ids (same project, acyclic)
  milestoneId?: string;
  kind: ItemKind;
  title: string;
  description: string;
  lane: Lane;
  /** Fine-grained engine label (planning, plan_review, awaiting_approval, building, verifying, …) for the UI. */
  stage?: string;
  autoStart: boolean;
  createdBy: Actor;
  createdAt: number;
  updatedAt: number;
  external?: ExternalLink;
  idemKey?: string;
}

export interface BoardComment {
  id: string;
  itemId: string;
  author: 'user' | 'conductor';
  body: string;
  ts: number;
  idemKey?: string;
}

export interface Decision {
  id: string;
  projectId: string;
  itemId?: string;
  title: string;
  body: string;
  author: 'user' | 'conductor';
  ts: number;
}

export type BoardChange =
  | { type: 'project' | 'milestone' | 'item' | 'comment' | 'decision'; id: string }
  | { type: 'reset' };

export class BoardError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BoardError';
    this.code = code;
  }
}

/** Snapshot file content. */
export interface BoardSnapshot {
  schemaVersion: number;
  seq: number;
  projects: Project[];
  milestones: Milestone[];
  items: WorkItem[];
  comments: BoardComment[];
  decisions: Decision[];
}

/** One journal line = the RESULTING entity (replay is plain upsert), plus a monotonically increasing seq. */
export type JournalOp =
  | { v: 1; seq: number; ts: number; t: 'project'; e: Project }
  | { v: 1; seq: number; ts: number; t: 'milestone'; e: Milestone }
  | { v: 1; seq: number; ts: number; t: 'item'; e: WorkItem; nextSeq?: { projectId: string; value: number } }
  | { v: 1; seq: number; ts: number; t: 'comment'; e: BoardComment }
  | { v: 1; seq: number; ts: number; t: 'decision'; e: Decision };
