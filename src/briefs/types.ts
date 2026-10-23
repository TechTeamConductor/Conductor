// "Design the work" (F3) and the Deep Research brief (F4), M8-6. Pure data types. Everything a model wrote is UNTRUSTED data: it is shaped,
// capped and redacted before it is stored, rendered as text, fenced when shown to any provider, and never executed.

export type BriefKind = 'work' | 'research';
export type BriefStatus = 'running' | 'ready' | 'failed' | 'canceled' | 'sending' | 'sent' | 'send_failed';
export type StepId = 'scan' | 'brief' | 'parts';
export type StepState = 'pending' | 'running' | 'done' | 'stopped' | 'failed';
export type PartSize = 'S' | 'M' | 'L';
export type Depth = 'standard' | 'deep';
/** `file` = a regular blob in the committed snapshot; `omitted` = in the repo but not materialised (agent config, > 25 MB, symlink, gitlink); `absent` = new. */
export type FileState = 'file' | 'omitted' | 'absent';

export const BRIEF_ID_RE = /^brf-[0-9a-f]{16}$/;
export const PART_ID_RE = /^P[1-8]$/;
export const MAX_PARTS = 8;
export const SOURCE_TYPES = ['official-docs', 'release-notes', 'source-code', 'standards', 'papers', 'issue-trackers', 'benchmarks', 'community'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export interface BriefFile { path: string; why: string; state: FileState; protected: boolean; secretLike: boolean }
export interface BriefPart { id: string; title: string; summary: string; size: PartSize; files: string[]; deps: string[]; parallelGroup?: string }
export interface WorkBrief { title: string; summary: string; approach: string; files: BriefFile[]; acceptance: string[]; risks: string[]; parts: BriefPart[] }
export interface ResearchBrief { title: string; objective: string; questions: string[]; scope: { in: string[]; out: string[]; timeWindow?: string }; sourceTypes: SourceType[]; deliverable: string }

export interface BriefStep { id: StepId; label: string; state: StepState; detail: string }
export interface BriefScan { repo: string; branch: string; sha: string; snapshotFiles: number; note?: string }
export interface BriefSentCard { part: string; key: string; dependsOn: string[] }
export interface BriefSent {
  at: number;
  parts?: string[];
  cards?: BriefSentCard[];
  depth?: Depth;
  askId?: string;
  /** send_failed only: a static, redacted reason (≤ 300). */
  error?: string;
}

/** What is stored in `<home>/briefs/brf-<hex16>.json`. */
export interface BriefRecord {
  schemaVersion: 1;
  id: string;
  kind: BriefKind;
  /** The user's own words. */
  line: string;
  repo: string | null;
  status: BriefStatus;
  steps: BriefStep[];
  handledBy: { provider: 'claude' | 'cursor' | 'codex'; role: 'requirements' | 'context'; tierNote?: string } | null;
  scan: BriefScan | null;
  work?: WorkBrief;
  research?: ResearchBrief;
  sent: BriefSent | null;
  error: string | null;
  errorKind?: 'limited' | 'failed' | 'interrupted';
  retryAt?: number | null;
  /** The `designPerHour` window key this brief was counted in (refund target, N12). */
  takenKey?: string;
  /** S11: a brief is refunded at most once. */
  refunded?: boolean;
  events: string[];
  createdAt: number;
  updatedAt: number;
}

export interface BriefView extends Omit<BriefRecord, 'schemaVersion' | 'takenKey' | 'refunded' | 'events'> {
  /** Constant: the UI labels every brief "written by a model — check it". */
  untrusted: true;
}
export type BriefSummary = Pick<BriefView, 'id' | 'kind' | 'line' | 'repo' | 'status' | 'createdAt' | 'updatedAt'> & { title: string | null };

export interface ResearchCardView {
  id: string;
  title: string;
  lane: 'active' | 'review' | 'done' | 'needs_you' | 'canceled';
  status: string;
  depth: Depth;
  repo: string | null;
  createdAt: number;
  updatedAt: number;
  counts: { opened: number; listed: number; unverified: number };
  convertedTo: string | null;
  error: string | null;
}
