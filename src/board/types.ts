// Native board model (M1a). Pure data types — no behaviour. See .techteam/plans/workspace-v2-m1.md §2.

/**
 * 2: items may be authored by `user-ask` / `ask-convert` / `research` — an older build refuses such a snapshot (no downgrade after Quick Ask is used).
 * 3 (M8-6): items may be authored by `design` ("Design the work"). A writable open stamps the snapshot to this version BEFORE any write
 * (backup first, see `Board.open`), so an older build refuses the board with NewerVersionError instead of mistaking a new op for a torn tail.
 */
export const BOARD_SCHEMA_VERSION = 3;

/** `lane` (not "column": `BoardColumn` already names a dashboard type). Humans may set only HUMAN_LANES; Conductor owns the rest. */
export type Lane = 'backlog' | 'todo' | 'active' | 'needs_you' | 'review' | 'done' | 'canceled';
export const LANES: readonly Lane[] = ['backlog', 'todo', 'active', 'needs_you', 'review', 'done', 'canceled'];
export const HUMAN_LANES: readonly Lane[] = ['backlog', 'todo', 'done', 'canceled'];

export type ItemKind = 'work' | 'ask' | 'research' | 'subtask' | 'bug';
export const USER_KINDS: readonly ItemKind[] = ['work', 'ask', 'research', 'subtask'];
/**
 * Who wrote a thing. `user-ask`, `ask-convert`, `research` and `design` are SERVER-ASSIGNED (never accepted from an HTTP body): a card started
 * from a Quick Ask the user ticked "let Conductor make this change" on / a card made from an ask answer (model text, untrusted) / from
 * research / a part of a "Design the work" brief (M8-6: model text, untrusted).
 */
export type Actor = 'user' | 'conductor' | 'import' | 'user-ask' | 'ask-convert' | 'research' | 'design';
/**
 * THE one table of actors (M8-6 S9): every list below is derived from it, so the journal loader's allow-list, the taint set (forced plan
 * approval) and the redaction set always change together. `tainted` = text is not the user's own ⇒ `run.untrusted`; `redact` = the board
 * redacts the actor's text on write.
 */
export const ACTOR_INFO: Readonly<Record<Actor, { tainted: boolean; redact: boolean }>> = Object.freeze({
  user: { tainted: false, redact: false },
  conductor: { tainted: false, redact: true },
  import: { tainted: true, redact: false },
  'user-ask': { tainted: false, redact: false },
  'ask-convert': { tainted: true, redact: true },
  research: { tainted: true, redact: true },
  design: { tainted: true, redact: true },
});
export const ACTORS: readonly Actor[] = Object.freeze(Object.keys(ACTOR_INFO) as Actor[]);
/** Actors whose text is model-derived (or imported) and therefore tainted: their cards' plans always wait for a human. */
export const TAINTED_ACTORS: readonly Actor[] = Object.freeze(ACTORS.filter((a) => ACTOR_INFO[a].tainted));
/** Actors whose text the board redacts on write (agent-derived text never reaches the board unredacted, H3). */
export const REDACTED_ACTORS: readonly Actor[] = Object.freeze(ACTORS.filter((a) => ACTOR_INFO[a].redact));

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
