// Linear wire types — LEGACY (deleted in M1d). The engine no longer uses any of this.

export interface LinearState {
  id: string;
  name: string;
  type: 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';
}
export interface LinearLabel {
  id: string;
  name: string;
  teamId: string | null; // null = workspace-level label
}
export interface LinearComment {
  id: string;
  body: string;
  userId: string | null;
  createdAt: string; // ISO
}
export interface LinearHistoryEntry {
  id: string;
  createdAt: string; // ISO
  actorId: string | null;
  addedLabelIds: string[];
  removedLabelIds: string[];
  /** Users who edited the description in this entry (empty/undefined if not edited). */
  descriptionUpdatedBy: string[];
  /** Who changed the issue TITLE / PROJECT in this entry (security review H2: both reach agent prompts). */
  titleUpdatedBy?: string[];
  projectUpdatedBy?: string[];
  fromStateId?: string | null;
  toStateId?: string | null;
}
export interface LinearIssue {
  id: string;
  identifier: string; // "ENG-123"
  title: string;
  description: string;
  url: string;
  priority: number;
  state: LinearState;
  labels: LinearLabel[];
  creatorId: string | null;
  assigneeId: string | null;
  parentId: string | null;
  projectName: string | null;
  teamId: string;
  createdAt: string;
  updatedAt: string;
  comments?: LinearComment[]; // present on `issue()` only
  history?: LinearHistoryEntry[]; // present on `issue()` only; ALL pages
}
export interface TeamSetupInfo {
  states: LinearState[];
  labels: LinearLabel[]; // team + workspace labels
  /** Team's default state for new issues (C4), if Linear exposes it. */
  defaultIssueStateId: string | null;
}
export interface LinearPort {
  viewer(): Promise<{ id: string; name: string; email: string }>;
  teams(): Promise<{ id: string; key: string; name: string }[]>;
  teamSetup(teamId: string): Promise<TeamSetupInfo>;
  createLabel(teamId: string, input: { name: string; color: string }): Promise<LinearLabel>;
  createState(teamId: string, input: { name: string; type: LinearState['type']; color: string }): Promise<LinearState>;
  /** Open issues (state type not completed/canceled) in the team carrying `triggerLabel`; creator/assignee/parent/state/labels populated. */
  candidates(teamId: string, triggerLabel: string, opts?: { includeAssigned?: boolean }): Promise<LinearIssue[]>;
  /** One issue with comments and ALL history pages. */
  issue(id: string): Promise<LinearIssue>;
  update(
    id: string,
    patch: { stateId?: string; addLabelIds?: string[]; removeLabelIds?: string[]; description?: string },
  ): Promise<void>;
  comment(issueId: string, body: string): Promise<{ id: string }>;
  createIssue(input: {
    teamId: string;
    title: string;
    description?: string;
    parentId?: string;
    labelIds?: string[];
    stateId?: string;
    projectId?: string;
  }): Promise<LinearIssue>;
  /** Sub-issues of an issue (for marker-based dedupe). */
  children(issueId: string): Promise<LinearIssue[]>;
}

