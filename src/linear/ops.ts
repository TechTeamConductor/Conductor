/**
 * Every GraphQL document Conductor sends to Linear, as an exported string constant, plus the pure builders for
 * the filter / input variables. Keeping them in ONE module lets `test/linear/ops-validate.test.ts` check every
 * document against the vendored official schema (`test/fixtures/linear-schema.graphql`) with `graphql.validate()`.
 *
 * Rules for this file:
 *  - every exported `string` is a complete, valid operation document (the validate test iterates over them);
 *  - non-document exports are functions or non-string values only;
 *  - field names come from the official SDL (IssueHistory, IssueFilter, ...), never guessed.
 *
 * Erasable TypeScript only.
 */

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';

/** Selection shared by every query/mutation that returns an issue (no comments / history). */
const ISSUE_FIELDS = `
    id
    identifier
    title
    description
    url
    priority
    createdAt
    updatedAt
    state { id name type }
    labels(first: 50) { nodes { id name team { id } } }
    creator { id }
    assignee { id }
    parent { id }
    project { name }
    team { id }`;

const COMMENT_FIELDS = 'id body createdAt user { id }';

/**
 * `IssueHistory` fields used for attribution (RC1/C1). `descriptionUpdatedBy` is a list of `User` objects in the
 * real schema; `updatedDescription` is fetched so an unattributed description edit (bot / integration) fails closed.
 */
const HISTORY_FIELDS = `id createdAt actorId addedLabelIds removedLabelIds updatedDescription descriptionUpdatedBy { id } fromStateId toStateId`;

// ───────────────────────────── read-only queries ─────────────────────────────

export const Q_VIEWER = `query Viewer { viewer { id name email } }`;

export const Q_TEAMS = `query Teams($after: String) {
  teams(first: 50, after: $after) {
    nodes { id key name }
    ${PAGE_INFO}
  }
}`;

/** Team workflow states (paginated) and the team's default state for new issues (C4). */
export const Q_TEAM_STATES = `query TeamStates($teamId: String!, $after: String) {
  team(id: $teamId) {
    id
    defaultIssueState { id name type }
    states(first: 100, after: $after) {
      nodes { id name type position }
      ${PAGE_INFO}
    }
  }
}`;

/** Team labels AND workspace-level labels (filter built by {@link teamLabelsFilter}). */
export const Q_TEAM_LABELS = `query TeamLabels($filter: IssueLabelFilter!, $after: String) {
  issueLabels(first: 100, after: $after, filter: $filter) {
    nodes { id name team { id } }
    ${PAGE_INFO}
  }
}`;

/** Open trigger-labelled issues of a team, scoped server-side to the viewer (filter: {@link candidatesFilter}). */
export const Q_CANDIDATES = `query Candidates($filter: IssueFilter!, $after: String) {
  issues(first: 50, after: $after, filter: $filter) {
    nodes {${ISSUE_FIELDS}
    }
    ${PAGE_INFO}
  }
}`;

/** One issue with the first page of comments and of history; further pages via the *_PAGE documents. */
export const Q_ISSUE = `query Issue($id: String!) {
  issue(id: $id) {${ISSUE_FIELDS}
    comments(first: 100) {
      nodes { ${COMMENT_FIELDS} }
      ${PAGE_INFO}
    }
    history(first: 100) {
      nodes { ${HISTORY_FIELDS} }
      ${PAGE_INFO}
    }
  }
}`;

export const Q_ISSUE_COMMENTS_PAGE = `query IssueCommentsPage($id: String!, $after: String) {
  issue(id: $id) {
    id
    comments(first: 100, after: $after) {
      nodes { ${COMMENT_FIELDS} }
      ${PAGE_INFO}
    }
  }
}`;

export const Q_ISSUE_HISTORY_PAGE = `query IssueHistoryPage($id: String!, $after: String) {
  issue(id: $id) {
    id
    history(first: 100, after: $after) {
      nodes { ${HISTORY_FIELDS} }
      ${PAGE_INFO}
    }
  }
}`;

/** Sub-issues of an issue (marker dedupe, bug sub-issues). */
export const Q_ISSUE_CHILDREN = `query IssueChildren($id: String!, $after: String) {
  issue(id: $id) {
    id
    children(first: 50, after: $after) {
      nodes {${ISSUE_FIELDS}
      }
      ${PAGE_INFO}
    }
  }
}`;

/** Lookup of one issue (used to recover after an ambiguous `issueCreate`). */
export const Q_ISSUE_CORE = `query IssueCore($id: String!) {
  issue(id: $id) {${ISSUE_FIELDS}
  }
}`;

/** Lookup of one comment (used to recover after an ambiguous `commentCreate`). */
export const Q_COMMENT_LOOKUP = `query CommentLookup($id: String!) { comment(id: $id) { id } }`;

// ───────────────────────────── mutations ─────────────────────────────

/** `input`: {@link issueUpdateInput}. */
export const M_ISSUE_UPDATE = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

export const M_COMMENT_CREATE = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id } }
}`;

export const M_ISSUE_CREATE = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {${ISSUE_FIELDS}
    }
  }
}`;

export const M_WORKFLOW_STATE_CREATE = `mutation WorkflowStateCreate($input: WorkflowStateCreateInput!) {
  workflowStateCreate(input: $input) { success workflowState { id name type } }
}`;

export const M_ISSUE_LABEL_CREATE = `mutation IssueLabelCreate($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) { success issueLabel { id name team { id } } }
}`;

// ───────────────────────────── variable builders (pure; validated in tests) ─────────────────────────────

/** `IssueFilter` for candidates. Server-side creator scoping is the first line of RC1 defence. */
export function candidatesFilter(teamId: string, triggerLabel: string, includeAssigned = false): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    team: { id: { eq: teamId } },
    labels: { some: { name: { eqIgnoreCase: triggerLabel } } },
    state: { type: { nin: ['completed', 'canceled'] } },
  };
  if (includeAssigned) {
    filter.or = [{ creator: { isMe: { eq: true } } }, { assignee: { isMe: { eq: true } } }];
  } else {
    filter.creator = { isMe: { eq: true } };
  }
  return filter;
}

/** `IssueLabelFilter`: labels of this team plus workspace-level labels (no team). */
export function teamLabelsFilter(teamId: string): Record<string, unknown> {
  return { or: [{ team: { id: { eq: teamId } } }, { team: { null: true } }] };
}

/** `IssueUpdateInput` from a port patch; empty label arrays are omitted. */
export function issueUpdateInput(patch: {
  stateId?: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
  description?: string;
}): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (patch.stateId !== undefined) input.stateId = patch.stateId;
  if (patch.addLabelIds && patch.addLabelIds.length > 0) input.addedLabelIds = [...new Set(patch.addLabelIds)];
  if (patch.removeLabelIds && patch.removeLabelIds.length > 0) input.removedLabelIds = [...new Set(patch.removeLabelIds)];
  if (patch.description !== undefined) input.description = patch.description;
  return input;
}
