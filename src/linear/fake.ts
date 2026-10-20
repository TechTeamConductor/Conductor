/**
 * `FakeLinear`: a deterministic in-memory Linear implementing `LinearPort` for tests and `conductor demo`.
 *
 * Semantics deliberately mirror what the real API does (and what the plan relies on):
 *  - issue history is generated "like Linear": a label added by an actor, a description edit by an actor, a state
 *    change — and creating an issue WITH labels / a description creates NO history entry (C1);
 *  - everything done through the `LinearPort` is done as the viewer (the API-key owner);
 *  - `candidates` only returns open issues carrying the trigger label that the viewer created (or is assigned to,
 *    with `includeAssigned`) — the server-side creator filter (set `serverSideCreatorFilter: false` to let tests
 *    exercise the engine's client-side re-check);
 *  - missing entities reject with a `LinearApiError` whose `notFound` flag is set.
 *
 * Test-control API (simulates humans): seedIssue, humanMove, humanComment, humanEditDescription, humanAddLabel,
 * humanRemoveLabel, humanDelete, failNext, denyCreate, setDefaultState, plus read helpers.
 */
import type {
  LinearComment,
  LinearHistoryEntry,
  LinearIssue,
  LinearLabel,
  LinearPort,
  LinearState,
  TeamSetupInfo,
} from '../types.ts';
import type { Clock } from '../util.ts';
import { deepClone } from '../util.ts';
import { LinearApiError } from './client.ts';
import { sameName } from './names.ts';

/** Clock that returns monotonically increasing ms; each `now()` advances by `autoTickMs` (unique timestamps). */
export class FakeClock implements Clock {
  #t: number;
  autoTickMs: number;
  constructor(startMs: number = Date.UTC(2026, 0, 1, 9, 0, 0), autoTickMs = 1000) {
    this.#t = startMs;
    this.autoTickMs = autoTickMs;
  }
  now(): number {
    const v = this.#t;
    this.#t += this.autoTickMs;
    return v;
  }
  /** Current value without advancing. */
  peek(): number {
    return this.#t;
  }
  set(ms: number): void {
    this.#t = ms;
  }
  advance(ms: number): void {
    this.#t += ms;
  }
}

export const FAKE_PORT_OPS = [
  'viewer',
  'teams',
  'teamSetup',
  'createLabel',
  'createState',
  'candidates',
  'issue',
  'update',
  'comment',
  'createIssue',
  'children',
] as const;
export type FakePortOp = (typeof FAKE_PORT_OPS)[number];

export interface FakeLinearOptions {
  viewerId?: string;
  otherUserId?: string;
  teamId?: string;
  /** Team key; issue identifiers are `KEY-1`, `KEY-2`, ... */
  key?: string;
  clock?: Clock;
  /** Replace the default Backlog/Todo/In Progress/In Review/Done/Canceled workflow (in position order). */
  states?: { name: string; type: LinearState['type']; id?: string }[];
  /** Team default state for new issues. Default "Todo". */
  defaultStateName?: string;
  /** Apply the creator/assignee scoping in `candidates` (default true). */
  serverSideCreatorFilter?: boolean;
}

export interface SeedIssue {
  title: string;
  description?: string;
  /** Label names; missing ones are created as team labels. Creation with labels writes NO history (C1). */
  labels?: string[];
  creatorId?: string | null;
  assigneeId?: string | null;
  stateName?: string;
  parentId?: string | null;
  projectName?: string | null;
  priority?: number;
  /** ISO createdAt override. */
  createdAt?: string;
}

export interface FakeCall {
  op: string;
  args: unknown;
}

interface IssueRec {
  issue: LinearIssue; // never carries comments/history
  comments: LinearComment[];
  history: LinearHistoryEntry[];
}

interface Injected {
  error: Error;
  times: number;
  after: boolean;
}

/** Read-only view for GraphQL-level fakes (test/helpers/mock-linear-server.ts). */
export interface FakeSnapshot {
  viewer: { id: string; name: string; email: string };
  team: { id: string; key: string; name: string };
  states: (LinearState & { position: number })[];
  labels: LinearLabel[];
  defaultIssueStateId: string | null;
  projects: { id: string; name: string }[];
  issues: { issue: LinearIssue; comments: LinearComment[]; history: LinearHistoryEntry[] }[];
  serverSideCreatorFilter: boolean;
}

const OPEN_TYPES: ReadonlySet<string> = new Set(['triage', 'backlog', 'unstarted', 'started']);
const STATE_TYPES: ReadonlySet<string> = new Set(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled']);

const DEFAULT_STATES: { name: string; type: LinearState['type']; id?: string }[] = [
  { name: 'Backlog', type: 'backlog' },
  { name: 'Todo', type: 'unstarted' },
  { name: 'In Progress', type: 'started' },
  { name: 'In Review', type: 'started' },
  { name: 'Done', type: 'completed' },
  { name: 'Canceled', type: 'canceled' },
];

export class FakeLinear implements LinearPort {
  readonly viewerId: string;
  readonly otherUserId: string;
  readonly teamId: string;
  readonly key: string;
  readonly clock: Clock;
  /** Every `LinearPort` call, in order (args are deep-cloned). */
  readonly calls: FakeCall[] = [];
  /** Set false to return issues regardless of creator/assignee (to test the engine's client-side re-check). */
  serverSideCreatorFilter: boolean;

  #states: (LinearState & { position: number })[] = [];
  #labels: LinearLabel[] = [];
  #projects: { id: string; name: string }[] = [];
  #issues = new Map<string, IssueRec>();
  #defaultStateId: string | null = null;
  #deny = new Set<'label' | 'state'>();
  #fail = new Map<string, Injected[]>();
  #seq = { issue: 0, label: 0, state: 0, comment: 0, history: 0, project: 0 };

  constructor(opts: FakeLinearOptions = {}) {
    this.viewerId = opts.viewerId ?? 'user-viewer';
    this.otherUserId = opts.otherUserId ?? 'user-other';
    this.teamId = opts.teamId ?? 'team-1';
    this.key = opts.key ?? 'TT';
    this.clock = opts.clock ?? new FakeClock();
    this.serverSideCreatorFilter = opts.serverSideCreatorFilter ?? true;
    for (const def of opts.states ?? DEFAULT_STATES) {
      const id = def.id ?? `state-${++this.#seq.state}`;
      this.#states.push({ id, name: def.name, type: def.type, position: this.#states.length + 1 });
    }
    const defName = opts.defaultStateName ?? 'Todo';
    this.#defaultStateId = this.#states.find((s) => sameName(s.name, defName))?.id ?? this.#states.find((s) => s.type === 'unstarted')?.id ?? this.#states[0]?.id ?? null;
  }

  // ───────────────────────────── helpers ─────────────────────────────

  #iso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  #notFound(op: string, what: string, id: string): LinearApiError {
    return new LinearApiError(`Entity not found: ${what} - Could not find referenced ${what} (${id}).`, {
      status: 200,
      op,
      errors: [{ message: `Entity not found: ${what}`, code: 'INVALID_INPUT' }],
    });
  }

  #forbidden(op: string, what: string): LinearApiError {
    return new LinearApiError(`Forbidden: you do not have permission to create ${what}`, {
      status: 200,
      op,
      errors: [{ message: `Forbidden: you do not have permission to create ${what}`, code: 'FORBIDDEN' }],
    });
  }

  #invalid(op: string, message: string): LinearApiError {
    return new LinearApiError(message, { status: 200, op, errors: [{ message, code: 'INVALID_INPUT' }] });
  }

  #findRec(ref: string): IssueRec | undefined {
    const direct = this.#issues.get(ref);
    if (direct) return direct;
    const lower = ref.toLowerCase();
    for (const rec of this.#issues.values()) if (rec.issue.identifier.toLowerCase() === lower) return rec;
    return undefined;
  }

  #rec(op: string, ref: string): IssueRec {
    const rec = this.#findRec(ref);
    if (!rec) throw this.#notFound(op, 'Issue', ref);
    return rec;
  }

  #state(id: string): LinearState | undefined {
    const s = this.#states.find((x) => x.id === id);
    return s ? { id: s.id, name: s.name, type: s.type } : undefined;
  }

  #defaultState(): LinearState {
    const s = (this.#defaultStateId ? this.#state(this.#defaultStateId) : undefined) ?? this.#states[0];
    if (!s) throw new Error('FakeLinear: no workflow states');
    return { id: s.id, name: s.name, type: s.type };
  }

  #labelByName(name: string): LinearLabel | undefined {
    // prefer team-level over workspace-level
    return (
      this.#labels.find((l) => l.teamId === this.teamId && sameName(l.name, name)) ??
      this.#labels.find((l) => l.teamId === null && sameName(l.name, name))
    );
  }

  #ensureLabel(name: string): LinearLabel {
    const found = this.#labelByName(name);
    if (found) return found;
    const created: LinearLabel = { id: `label-${++this.#seq.label}`, name, teamId: this.teamId };
    this.#labels.push(created);
    return created;
  }

  #pushHistory(rec: IssueRec, entry: Partial<LinearHistoryEntry> & { actorId: string | null }): void {
    const now = this.#iso();
    rec.history.push({
      id: `hist-${++this.#seq.history}`,
      createdAt: now,
      actorId: entry.actorId,
      addedLabelIds: entry.addedLabelIds ?? [],
      removedLabelIds: entry.removedLabelIds ?? [],
      descriptionUpdatedBy: entry.descriptionUpdatedBy ?? [],
      fromStateId: entry.fromStateId ?? null,
      toStateId: entry.toStateId ?? null,
    });
    rec.issue.updatedAt = now;
  }

  #view(rec: IssueRec, full: boolean): LinearIssue {
    const copy = deepClone(rec.issue);
    if (full) {
      copy.comments = [...rec.comments].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map((c) => deepClone(c));
      copy.history = [...rec.history].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map((h) => deepClone(h));
    }
    return copy;
  }

  /** Apply label add/remove + state + description as `actorId`; one history entry for the whole change. */
  #apply(
    rec: IssueRec,
    actorId: string,
    patch: { stateId?: string; addLabelIds?: string[]; removeLabelIds?: string[]; description?: string },
  ): void {
    const issue = rec.issue;
    const entry: Partial<LinearHistoryEntry> & { actorId: string | null } = { actorId };
    let changed = false;

    if (patch.stateId !== undefined && patch.stateId !== issue.state.id) {
      const next = this.#state(patch.stateId);
      if (!next) throw this.#notFound('update', 'WorkflowState', patch.stateId);
      entry.fromStateId = issue.state.id;
      entry.toStateId = next.id;
      issue.state = next;
      changed = true;
    }
    const added: string[] = [];
    for (const id of patch.addLabelIds ?? []) {
      const label = this.#labels.find((l) => l.id === id);
      if (!label) throw this.#notFound('update', 'IssueLabel', id);
      if (!issue.labels.some((l) => l.id === id)) {
        issue.labels.push({ ...label });
        added.push(id);
      }
    }
    const removed: string[] = [];
    for (const id of patch.removeLabelIds ?? []) {
      const idx = issue.labels.findIndex((l) => l.id === id);
      if (idx >= 0) {
        issue.labels.splice(idx, 1);
        removed.push(id);
      }
    }
    if (added.length > 0) {
      entry.addedLabelIds = added;
      changed = true;
    }
    if (removed.length > 0) {
      entry.removedLabelIds = removed;
      changed = true;
    }
    if (patch.description !== undefined && patch.description !== issue.description) {
      issue.description = patch.description;
      entry.descriptionUpdatedBy = [actorId];
      changed = true;
    }
    if (changed) this.#pushHistory(rec, entry);
  }

  /** Run a port operation with call logging and failure injection. */
  async #op<T>(op: FakePortOp, args: unknown, fn: () => T): Promise<T> {
    this.calls.push({ op, args: deepClone(args) });
    const list = this.#fail.get(op);
    const take = (after: boolean): Error | undefined => {
      if (!list) return undefined;
      const i = list.findIndex((x) => x.after === after && x.times > 0);
      if (i < 0) return undefined;
      const inj = list[i]!;
      inj.times--;
      return inj.error;
    };
    const before = take(false);
    if (before) throw before;
    const result = fn();
    const after = take(true);
    if (after) throw after;
    return result;
  }

  // ───────────────────────────── LinearPort ─────────────────────────────

  viewer(): Promise<{ id: string; name: string; email: string }> {
    return this.#op('viewer', {}, () => ({ id: this.viewerId, name: 'Viewer', email: 'viewer@example.test' }));
  }

  teams(): Promise<{ id: string; key: string; name: string }[]> {
    return this.#op('teams', {}, () => [{ id: this.teamId, key: this.key, name: `Team ${this.key}` }]);
  }

  teamSetup(teamId: string): Promise<TeamSetupInfo> {
    return this.#op('teamSetup', { teamId }, () => {
      if (teamId !== this.teamId) throw this.#notFound('teamSetup', 'Team', teamId);
      return {
        states: this.#states.map((s) => ({ id: s.id, name: s.name, type: s.type })),
        labels: this.#labels.filter((l) => l.teamId === null || l.teamId === this.teamId).map((l) => ({ ...l })),
        defaultIssueStateId: this.#defaultStateId,
      };
    });
  }

  createLabel(teamId: string, input: { name: string; color: string }, opts?: { id?: string }): Promise<LinearLabel> {
    return this.#op('createLabel', { teamId, input, opts }, () => {
      if (this.#deny.has('label')) throw this.#forbidden('createLabel', 'labels');
      if (teamId !== this.teamId) throw this.#notFound('createLabel', 'Team', teamId);
      if (this.#labelByName(input.name)) throw this.#invalid('createLabel', `Label "${input.name}" already exists`);
      if (opts?.id && this.#labels.some((l) => l.id === opts.id)) throw this.#invalid('createLabel', 'duplicate id');
      const label: LinearLabel = { id: opts?.id ?? `label-${++this.#seq.label}`, name: input.name, teamId };
      this.#labels.push(label);
      return { ...label };
    });
  }

  createState(teamId: string, input: { name: string; type: LinearState['type']; color: string }, opts?: { id?: string }): Promise<LinearState> {
    return this.#op('createState', { teamId, input, opts }, () => {
      if (this.#deny.has('state')) throw this.#forbidden('createState', 'workflow states');
      if (teamId !== this.teamId) throw this.#notFound('createState', 'Team', teamId);
      if (!STATE_TYPES.has(input.type)) throw this.#invalid('createState', `Invalid workflow state type "${input.type}"`);
      if (this.#states.some((s) => sameName(s.name, input.name))) {
        throw this.#invalid('createState', `A workflow state named "${input.name}" already exists`);
      }
      if (opts?.id && this.#states.some((s) => s.id === opts.id)) throw this.#invalid('createState', 'duplicate id');
      const state = { id: opts?.id ?? `state-${++this.#seq.state}`, name: input.name, type: input.type, position: this.#states.length + 1 };
      this.#states.push(state);
      return { id: state.id, name: state.name, type: state.type };
    });
  }

  candidates(teamId: string, triggerLabel: string, opts?: { includeAssigned?: boolean }): Promise<LinearIssue[]> {
    return this.#op('candidates', { teamId, triggerLabel, opts }, () => {
      const out: LinearIssue[] = [];
      for (const rec of this.#issues.values()) {
        const i = rec.issue;
        if (i.teamId !== teamId) continue;
        if (!i.labels.some((l) => sameName(l.name, triggerLabel))) continue;
        if (!OPEN_TYPES.has(i.state.type)) continue;
        if (this.serverSideCreatorFilter) {
          const mine = i.creatorId === this.viewerId;
          const assigned = opts?.includeAssigned === true && i.assigneeId === this.viewerId;
          if (!mine && !assigned) continue;
        }
        out.push(this.#view(rec, false));
      }
      return out;
    });
  }

  issue(id: string): Promise<LinearIssue> {
    return this.#op('issue', { id }, () => this.#view(this.#rec('issue', id), true));
  }

  update(
    id: string,
    patch: { stateId?: string; addLabelIds?: string[]; removeLabelIds?: string[]; description?: string },
  ): Promise<void> {
    return this.#op('update', { id, patch }, () => {
      const rec = this.#rec('update', id);
      this.#apply(rec, this.viewerId, patch);
    });
  }

  comment(issueId: string, body: string, opts?: { id?: string }): Promise<{ id: string }> {
    return this.#op('comment', { issueId, body, opts }, () => {
      const rec = this.#rec('comment', issueId);
      return { id: this.#addComment(rec, body, this.viewerId, opts?.id).id };
    });
  }

  #addComment(rec: IssueRec, body: string, userId: string | null, forcedId?: string): LinearComment {
    if (forcedId && rec.comments.some((c) => c.id === forcedId)) throw this.#invalid('comment', 'duplicate id');
    const c: LinearComment = { id: forcedId ?? `comment-${++this.#seq.comment}`, body, userId, createdAt: this.#iso() };
    rec.comments.push(c);
    rec.issue.updatedAt = c.createdAt;
    return c;
  }

  createIssue(
    input: {
      teamId: string;
      title: string;
      description?: string;
      parentId?: string;
      labelIds?: string[];
      stateId?: string;
      projectId?: string;
    },
    opts?: { id?: string },
  ): Promise<LinearIssue> {
    return this.#op('createIssue', { input, opts }, () => {
      if (input.teamId !== this.teamId) throw this.#notFound('createIssue', 'Team', input.teamId);
      if (opts?.id && this.#issues.has(opts.id)) throw this.#invalid('createIssue', 'duplicate id');
      let parentId: string | null = null;
      if (input.parentId !== undefined) {
        parentId = this.#rec('createIssue', input.parentId).issue.id;
      }
      const labels: LinearLabel[] = [];
      for (const id of input.labelIds ?? []) {
        const l = this.#labels.find((x) => x.id === id);
        if (!l) throw this.#notFound('createIssue', 'IssueLabel', id);
        labels.push({ ...l });
      }
      let state = this.#defaultState();
      if (input.stateId !== undefined) {
        const s = this.#state(input.stateId);
        if (!s) throw this.#notFound('createIssue', 'WorkflowState', input.stateId);
        state = s;
      }
      let projectName: string | null = null;
      if (input.projectId !== undefined) {
        const p = this.#projects.find((x) => x.id === input.projectId);
        if (!p) throw this.#notFound('createIssue', 'Project', input.projectId);
        projectName = p.name;
      }
      const rec = this.#newIssue({
        id: opts?.id,
        title: input.title,
        description: input.description ?? '',
        labels,
        state,
        creatorId: this.viewerId,
        assigneeId: null,
        parentId,
        projectName,
        priority: 0,
      });
      return this.#view(rec, false);
    });
  }

  children(issueId: string): Promise<LinearIssue[]> {
    return this.#op('children', { issueId }, () => {
      const parent = this.#rec('children', issueId);
      const out: LinearIssue[] = [];
      for (const rec of this.#issues.values()) if (rec.issue.parentId === parent.issue.id) out.push(this.#view(rec, false));
      return out;
    });
  }

  #newIssue(o: {
    id?: string;
    title: string;
    description: string;
    labels: LinearLabel[];
    state: LinearState;
    creatorId: string | null;
    assigneeId: string | null;
    parentId: string | null;
    projectName: string | null;
    priority: number;
    createdAt?: string;
  }): IssueRec {
    const n = ++this.#seq.issue;
    const identifier = `${this.key}-${n}`;
    const createdAt = o.createdAt ?? this.#iso();
    const rec: IssueRec = {
      issue: {
        id: o.id ?? `issue-${n}`,
        identifier,
        title: o.title,
        description: o.description,
        url: `https://linear.app/fake/issue/${identifier}`,
        priority: o.priority,
        state: { ...o.state },
        labels: o.labels.map((l) => ({ ...l })),
        creatorId: o.creatorId,
        assigneeId: o.assigneeId,
        parentId: o.parentId,
        projectName: o.projectName,
        teamId: this.teamId,
        createdAt,
        updatedAt: createdAt,
      },
      comments: [],
      history: [], // creation (with labels / description) writes NO history (C1)
    };
    this.#issues.set(rec.issue.id, rec);
    return rec;
  }

  // ───────────────────────────── test-control API (simulated humans) ─────────────────────────────

  /** Create an issue as a human would (no port call is logged). Labels/description at creation write NO history. */
  seedIssue(o: SeedIssue): LinearIssue {
    const labels = (o.labels ?? []).map((n) => this.#ensureLabel(n));
    const state = o.stateName ? this.requireState(o.stateName) : this.#defaultState();
    let parentId: string | null = null;
    if (o.parentId) parentId = this.#rec('seedIssue', o.parentId).issue.id;
    const rec = this.#newIssue({
      title: o.title,
      description: o.description ?? '',
      labels,
      state,
      creatorId: o.creatorId === undefined ? this.viewerId : o.creatorId,
      assigneeId: o.assigneeId ?? null,
      parentId,
      projectName: o.projectName ?? null,
      priority: o.priority ?? 0,
      createdAt: o.createdAt,
    });
    return this.#view(rec, false);
  }

  /** Create a label (team-level, or workspace-level with `{workspace:true}`) without going through the port. */
  seedLabel(name: string, o: { workspace?: boolean } = {}): LinearLabel {
    const existing = this.#labels.find((l) => sameName(l.name, name) && l.teamId === (o.workspace ? null : this.teamId));
    if (existing) return { ...existing };
    const label: LinearLabel = { id: `label-${++this.#seq.label}`, name, teamId: o.workspace ? null : this.teamId };
    this.#labels.push(label);
    return { ...label };
  }

  seedProject(name: string): { id: string; name: string } {
    const existing = this.#projects.find((p) => p.name === name);
    if (existing) return { ...existing };
    const p = { id: `project-${++this.#seq.project}`, name };
    this.#projects.push(p);
    return { ...p };
  }

  /** Move an issue to a state given by name (preferred) or by native type (first state of that type). */
  humanMove(issueId: string, stateNameOrType: string, actorId: string = this.viewerId): void {
    const rec = this.#rec('humanMove', issueId);
    const target =
      this.#states.find((s) => sameName(s.name, stateNameOrType)) ?? this.#states.find((s) => s.type === stateNameOrType);
    if (!target) throw new Error(`FakeLinear.humanMove: no state named or typed "${stateNameOrType}"`);
    this.#apply(rec, actorId, { stateId: target.id });
  }

  humanComment(issueId: string, body: string, userId: string = this.viewerId): LinearComment {
    return deepClone(this.#addComment(this.#rec('humanComment', issueId), body, userId));
  }

  humanEditDescription(issueId: string, text: string, userId: string): void {
    this.#apply(this.#rec('humanEditDescription', issueId), userId, { description: text });
  }

  humanAddLabel(issueId: string, labelName: string, userId: string): void {
    const label = this.#ensureLabel(labelName);
    this.#apply(this.#rec('humanAddLabel', issueId), userId, { addLabelIds: [label.id] });
  }

  humanRemoveLabel(issueId: string, labelName: string, userId: string): void {
    const rec = this.#rec('humanRemoveLabel', issueId);
    const on = rec.issue.labels.find((l) => sameName(l.name, labelName));
    if (!on) return;
    this.#apply(rec, userId, { removeLabelIds: [on.id] });
  }

  humanDelete(issueId: string): void {
    const rec = this.#rec('humanDelete', issueId);
    this.#issues.delete(rec.issue.id);
    for (const other of this.#issues.values()) if (other.issue.parentId === rec.issue.id) other.issue.parentId = null;
  }

  /**
   * Make the next `times` calls of port method `op` reject with `error`. With `{after:true}` the effect is applied
   * first and the call THEN fails (a lost response) — for idempotency / crash-window tests.
   */
  failNext(op: string, error: Error, times = 1, opts: { after?: boolean } = {}): void {
    if (!(FAKE_PORT_OPS as readonly string[]).includes(op)) throw new Error(`FakeLinear.failNext: unknown op "${op}"`);
    const list = this.#fail.get(op) ?? [];
    list.push({ error, times, after: opts.after === true });
    this.#fail.set(op, list);
  }

  clearFailures(): void {
    this.#fail.clear();
  }

  /** Simulate missing permissions: createLabel / createState reject with a Forbidden `LinearApiError`. */
  denyCreate(kind: 'label' | 'state', deny = true): void {
    if (deny) this.#deny.add(kind);
    else this.#deny.delete(kind);
  }

  setDefaultState(name: string): void {
    this.#defaultStateId = this.requireState(name).id;
  }

  // ───────────────────────────── read helpers ─────────────────────────────

  /** Snapshot (with comments + history) of an issue by key (`TT-3`) or id; throws if absent. */
  issueByKey(key: string): LinearIssue {
    return this.#view(this.#rec('issueByKey', key), true);
  }
  findIssueByKey(key: string): LinearIssue | undefined {
    const rec = this.#findRec(key);
    return rec ? this.#view(rec, true) : undefined;
  }
  allIssues(): LinearIssue[] {
    return [...this.#issues.values()].map((r) => this.#view(r, true));
  }
  labelByName(name: string): LinearLabel | undefined {
    const l = this.#labelByName(name);
    return l ? { ...l } : undefined;
  }
  requireLabel(name: string): LinearLabel {
    const l = this.labelByName(name);
    if (!l) throw new Error(`FakeLinear: no label "${name}"`);
    return l;
  }
  allLabels(): LinearLabel[] {
    return this.#labels.map((l) => ({ ...l }));
  }
  stateByName(name: string): LinearState | undefined {
    const s = this.#states.find((x) => sameName(x.name, name));
    return s ? { id: s.id, name: s.name, type: s.type } : undefined;
  }
  requireState(name: string): LinearState {
    const s = this.stateByName(name);
    if (!s) throw new Error(`FakeLinear: no state "${name}"`);
    return s;
  }
  allStates(): LinearState[] {
    return this.#states.map((s) => ({ id: s.id, name: s.name, type: s.type }));
  }
  /** Calls to one op (convenience for assertions). */
  callsOf(op: string): FakeCall[] {
    return this.calls.filter((c) => c.op === op);
  }

  /** Raw read-only view for GraphQL-level fakes. */
  snapshot(): FakeSnapshot {
    return {
      viewer: { id: this.viewerId, name: 'Viewer', email: 'viewer@example.test' },
      team: { id: this.teamId, key: this.key, name: `Team ${this.key}` },
      states: this.#states.map((s) => ({ ...s })),
      labels: this.#labels.map((l) => ({ ...l })),
      defaultIssueStateId: this.#defaultStateId,
      projects: this.#projects.map((p) => ({ ...p })),
      issues: [...this.#issues.values()].map((r) => ({
        issue: deepClone(r.issue),
        comments: deepClone(r.comments),
        history: deepClone(r.history),
      })),
      serverSideCreatorFilter: this.serverSideCreatorFilter,
    };
  }
}
