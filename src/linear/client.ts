/**
 * Linear GraphQL client implementing `LinearPort` over global `fetch` (zero runtime dependencies).
 *
 * Behaviour (plan RC6 / R3):
 *  - personal API key sent as `Authorization: <key>` (NOT `Bearer`); the key lives in a JS private field and is
 *    scrubbed from every error text;
 *  - pagination everywhere (candidates, teams, states, labels, children, comments (cap 200), history (cap 500));
 *  - HTTP 429 / GraphQL `RATELIMITED` => exponential backoff honouring `Retry-After` / `X-RateLimit-*-Reset`
 *    (each wait capped at 10 min, injectable sleep), then a typed `LinearRateLimitError`;
 *  - GraphQL errors surfaced verbatim as `LinearApiError`; network/timeouts as `LinearNetworkError`;
 *  - 5xx retried (default x3); request timeout 30 s;
 *  - create mutations carry a client-generated UUID (`input.id`) so a retry after an ambiguous failure can never
 *    create a duplicate: if a later attempt errors after an earlier one may have been applied, the entity is looked
 *    up by that id and returned if it exists.
 */
import { randomUUID } from 'node:crypto';
import type {
  LinearComment,
  LinearHistoryEntry,
  LinearIssue,
  LinearLabel,
  LinearPort,
  LinearState,
  TeamSetupInfo,
} from '../types.ts';
import { redact } from '../redact.ts';
import type { IssueWithFlags } from './attribution.ts';
import { sleep as realSleep } from '../util.ts';
import * as ops from './ops.ts';

export const DEFAULT_ENDPOINT = 'https://api.linear.app/graphql';
export const COMMENTS_CAP = 200;
export const HISTORY_CAP = 500;
export const RATE_LIMIT_CAP_MS = 10 * 60 * 1000;

// ───────────────────────────── errors ─────────────────────────────

export interface GraphQLErrorItem {
  message: string;
  code?: string;
  path?: (string | number)[];
  extensions?: Record<string, unknown>;
}

export class LinearApiError extends Error {
  /** HTTP status of the response that carried the error (200 for GraphQL-level errors). */
  readonly status: number;
  /** The `errors[]` of the response, verbatim (key-scrubbed). */
  readonly errors: GraphQLErrorItem[];
  /** Name of the port operation (e.g. "candidates"). */
  readonly op: string;
  /** True when Linear says the referenced entity does not exist (deleted issue, bad id). */
  readonly notFound: boolean;
  /** True for authentication / authorisation failures (bad key, missing permission). */
  readonly forbidden: boolean;
  constructor(message: string, init: { status: number; errors?: GraphQLErrorItem[]; op: string }) {
    super(message);
    this.name = 'LinearApiError';
    this.status = init.status;
    this.errors = init.errors ?? [];
    this.op = init.op;
    this.notFound = /entity not found|not found/i.test(message) || this.errors.some((e) => /not.?found/i.test(e.code ?? ''));
    this.forbidden =
      init.status === 401 ||
      init.status === 403 ||
      /forbidden|permission|authentication|unauthori[sz]ed/i.test(message) ||
      this.errors.some((e) => /^(AUTHENTICATION_ERROR|FORBIDDEN|AUTHORIZATION_ERROR)$/i.test(e.code ?? ''));
  }
}

export class LinearRateLimitError extends LinearApiError {
  /** Wait (ms) Linear asked for, if it said (Retry-After / X-RateLimit-*-Reset); otherwise null. */
  readonly retryAfterMs: number | null;
  /** How many retries were attempted before giving up. */
  readonly attempts: number;
  constructor(
    message: string,
    init: { status: number; errors?: GraphQLErrorItem[]; op: string; retryAfterMs: number | null; attempts: number },
  ) {
    super(message, init);
    this.name = 'LinearRateLimitError';
    this.retryAfterMs = init.retryAfterMs;
    this.attempts = init.attempts;
  }
}

export class LinearNetworkError extends Error {
  readonly op: string;
  readonly timedOut: boolean;
  constructor(message: string, init: { op: string; timedOut: boolean; cause?: unknown }) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'LinearNetworkError';
    this.op = init.op;
    this.timedOut = init.timedOut;
  }
}

export const isNotFoundError = (e: unknown): boolean => e instanceof LinearApiError && e.notFound;
export const isRateLimitError = (e: unknown): boolean => e instanceof LinearRateLimitError;
/** True for errors that look like "you may not do that" (used by provisioning to list manual steps). */
export const isPermissionError = (e: unknown): boolean => e instanceof LinearApiError && !(e instanceof LinearRateLimitError) && !e.notFound;

// ───────────────────────────── wire shapes (internal) ─────────────────────────────

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}
interface Connection<T> {
  nodes: T[];
  pageInfo: PageInfo;
}
interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number | null;
  createdAt: string;
  updatedAt: string;
  state: { id: string; name: string; type: string };
  labels?: { nodes: { id: string; name: string; team?: { id: string } | null }[] } | null;
  creator?: { id: string } | null;
  assignee?: { id: string } | null;
  parent?: { id: string } | null;
  project?: { name: string } | null;
  team: { id: string };
}
interface CommentNode {
  id: string;
  body: string;
  createdAt: string;
  user?: { id: string } | null;
}
interface HistoryNode {
  id: string;
  createdAt: string;
  actorId?: string | null;
  addedLabelIds?: string[] | null;
  removedLabelIds?: string[] | null;
  updatedDescription?: boolean | null;
  descriptionUpdatedBy?: { id: string }[] | null;
  fromStateId?: string | null;
  toStateId?: string | null;
}

/** Marker used when Linear says the description changed but names no user (bot / integration / import). */
export const UNATTRIBUTED_ACTOR = 'unattributed';

export function mapIssue(n: IssueNode): LinearIssue {
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    description: n.description ?? '',
    url: n.url,
    priority: n.priority ?? 0,
    state: { id: n.state.id, name: n.state.name, type: n.state.type as LinearState['type'] },
    labels: (n.labels?.nodes ?? []).map((l) => ({ id: l.id, name: l.name, teamId: l.team?.id ?? null })),
    creatorId: n.creator?.id ?? null,
    assigneeId: n.assignee?.id ?? null,
    parentId: n.parent?.id ?? null,
    projectName: n.project?.name ?? null,
    teamId: n.team.id,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

export function mapComment(n: CommentNode): LinearComment {
  return { id: n.id, body: n.body, userId: n.user?.id ?? null, createdAt: n.createdAt };
}

export function mapHistory(n: HistoryNode): LinearHistoryEntry {
  let by = (n.descriptionUpdatedBy ?? []).map((u) => u.id);
  // Fail closed: a description edit without a named user must never look viewer-attributed.
  if (n.updatedDescription && by.length === 0) by = [n.actorId ?? UNATTRIBUTED_ACTOR];
  return {
    id: n.id,
    createdAt: n.createdAt,
    actorId: n.actorId ?? null,
    addedLabelIds: n.addedLabelIds ?? [],
    removedLabelIds: n.removedLabelIds ?? [],
    descriptionUpdatedBy: by,
    fromStateId: n.fromStateId ?? null,
    toStateId: n.toStateId ?? null,
  };
}

const byCreatedAt = <T extends { createdAt: string; id: string }>(a: T, b: T): number => {
  const d = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (d !== 0 && !Number.isNaN(d)) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

// ───────────────────────────── client ─────────────────────────────

export interface LinearClientOptions {
  apiKey: string;
  endpoint?: string;
  fetchFn?: typeof fetch;
  /** Injectable sleep (tests). */
  sleepFn?: (ms: number) => Promise<void>;
  /** Injectable clock (tests) used to turn reset-epoch headers into waits. */
  nowFn?: () => number;
  /** Retries for 5xx, network errors/timeouts and rate limits. Default 3. */
  maxRetries?: number;
  /** Per-request timeout. Default 30 000 ms. */
  timeoutMs?: number;
  /** Base of the exponential backoff. Default 1000 ms (1 s, 2 s, 4 s). */
  baseBackoffMs?: number;
  /** Cap for one rate-limit wait. Default 10 min. */
  rateLimitCapMs?: number;
  commentsCap?: number;
  historyCap?: number;
}

interface ReqOpts<T> {
  /** Called when the request finally fails after an earlier attempt may have been applied; return the entity if it exists. */
  recover?: () => Promise<T | undefined>;
}

interface GqlBody {
  data?: unknown;
  errors?: unknown;
}

function normaliseErrors(raw: unknown): GraphQLErrorItem[] {
  if (!Array.isArray(raw)) return [];
  const out: GraphQLErrorItem[] = [];
  for (const e of raw) {
    if (e && typeof e === 'object') {
      const o = e as Record<string, unknown>;
      const ext = o.extensions && typeof o.extensions === 'object' ? (o.extensions as Record<string, unknown>) : undefined;
      const item: GraphQLErrorItem = { message: typeof o.message === 'string' ? o.message : JSON.stringify(e) };
      if (ext) {
        item.extensions = ext;
        if (typeof ext.code === 'string') item.code = ext.code;
      }
      if (Array.isArray(o.path)) item.path = o.path as (string | number)[];
      out.push(item);
    } else {
      out.push({ message: String(e) });
    }
  }
  return out;
}

function isRateLimited(errors: GraphQLErrorItem[]): boolean {
  return errors.some((e) => {
    if ((e.code ?? '').toUpperCase() === 'RATELIMITED') return true;
    const type = e.extensions?.type;
    return typeof type === 'string' && /rate.?limit/i.test(type);
  });
}

/** Epoch-seconds / epoch-ms / relative-seconds header value -> ms from now (or null). */
function resetHeaderToWaitMs(value: string | null, now: number): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1e8) return n * 1000; // relative seconds
  if (n < 1e11) return Math.max(0, n * 1000 - now); // epoch seconds
  return Math.max(0, n - now); // epoch ms
}

function retryAfterToWaitMs(value: string | null, now: number): number | null {
  if (value === null || value.trim() === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const when = Date.parse(value);
  return Number.isNaN(when) ? null : Math.max(0, when - now);
}

export class LinearClient implements LinearPort {
  readonly endpoint: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;
  readonly #baseBackoffMs: number;
  readonly #rateLimitCapMs: number;
  readonly #commentsCap: number;
  readonly #historyCap: number;

  constructor(opts: LinearClientOptions) {
    if (typeof opts.apiKey !== 'string' || opts.apiKey.trim() === '') throw new Error('LinearClient: apiKey is required');
    this.#apiKey = opts.apiKey.trim();
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.#fetch = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.#sleep = opts.sleepFn ?? realSleep;
    this.#now = opts.nowFn ?? Date.now;
    this.#maxRetries = Math.max(0, opts.maxRetries ?? 3);
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#baseBackoffMs = opts.baseBackoffMs ?? 1000;
    this.#rateLimitCapMs = opts.rateLimitCapMs ?? RATE_LIMIT_CAP_MS;
    this.#commentsCap = opts.commentsCap ?? COMMENTS_CAP;
    this.#historyCap = opts.historyCap ?? HISTORY_CAP;
  }

  /** Never reveal the key (JSON.stringify / util.inspect / String()). */
  toJSON(): { endpoint: string } {
    return { endpoint: this.endpoint };
  }

  // ───────────────────────────── transport ─────────────────────────────

  #scrub(text: string): string {
    let out = text;
    if (this.#apiKey.length >= 4) out = out.split(this.#apiKey).join('[redacted]');
    return redact(out, [this.#apiKey]);
  }

  #backoff(attempt: number): number {
    return Math.min(this.#rateLimitCapMs, this.#baseBackoffMs * 2 ** attempt);
  }

  #rateLimitWait(headers: Headers, attempt: number): { wait: number; asked: number | null } {
    const now = this.#now();
    let asked = retryAfterToWaitMs(headers.get('retry-after'), now);
    if (asked === null) {
      const candidates: number[] = [];
      for (const kind of ['requests', 'complexity']) {
        const remaining = headers.get(`x-ratelimit-${kind}-remaining`);
        const exhausted = remaining === null || Number(remaining) <= 0;
        const w = resetHeaderToWaitMs(headers.get(`x-ratelimit-${kind}-reset`), now);
        if (exhausted && w !== null) candidates.push(w);
      }
      if (candidates.length > 0) asked = Math.max(...candidates);
    }
    const wait = Math.min(this.#rateLimitCapMs, asked ?? this.#backoff(attempt));
    return { wait: Math.max(0, wait), asked };
  }

  async #send(
    op: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ status: number; headers: Headers; text: string }> {
    const ac = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
        reject(new Error('timeout'));
      }, this.#timeoutMs);
    });
    // Never an unhandled rejection if the request settles first.
    timeout.catch(() => undefined);
    try {
      const res = await Promise.race([
        this.#fetch(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: this.#apiKey, Accept: 'application/json' },
          body: JSON.stringify({ query, variables }),
          signal: ac.signal,
        }),
        timeout,
      ]);
      const text = await Promise.race([res.text(), timeout]);
      return { status: res.status, headers: res.headers, text };
    } catch (e) {
      const reason = timedOut ? `request timed out after ${this.#timeoutMs} ms` : e instanceof Error ? e.message : String(e);
      const cause = (e as { cause?: { message?: string; code?: string } } | undefined)?.cause;
      const detail = !timedOut && cause && (cause.code || cause.message) ? ` (${cause.code ?? cause.message})` : '';
      throw new LinearNetworkError(this.#scrub(`Linear ${op}: ${reason}${detail}`), { op, timedOut });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #request<T>(op: string, query: string, variables: Record<string, unknown>, o: ReqOpts<T> = {}): Promise<T> {
    const state = { ambiguous: false };
    try {
      return await this.#attempts<T>(op, query, variables, state);
    } catch (e) {
      if (state.ambiguous && o.recover) {
        let found: T | undefined;
        try {
          found = await o.recover();
        } catch {
          found = undefined;
        }
        if (found !== undefined) return found;
      }
      throw e;
    }
  }

  async #attempts<T>(op: string, query: string, variables: Record<string, unknown>, state: { ambiguous: boolean }): Promise<T> {
    let attempt = 0;
    for (;;) {
      let sent: { status: number; headers: Headers; text: string };
      try {
        sent = await this.#send(op, query, variables);
      } catch (e) {
        state.ambiguous = true; // the server may have processed it
        if (attempt < this.#maxRetries) {
          await this.#sleep(this.#backoff(attempt));
          attempt++;
          continue;
        }
        throw e;
      }

      const { status, headers, text } = sent;
      let body: GqlBody | undefined;
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object') body = parsed as GqlBody;
      } catch {
        body = undefined;
      }
      const errors = normaliseErrors(body?.errors).map((e) => this.#scrubError(e));

      if (status === 429 || isRateLimited(errors)) {
        const { wait, asked } = this.#rateLimitWait(headers, attempt);
        if (attempt < this.#maxRetries) {
          await this.#sleep(wait);
          attempt++;
          continue;
        }
        const msg = errors.length > 0 ? this.#messageFor(errors) : `HTTP ${status}: rate limited`;
        throw new LinearRateLimitError(msg, { status, errors, op, retryAfterMs: asked, attempts: attempt });
      }

      if (status >= 500) {
        state.ambiguous = true;
        if (attempt < this.#maxRetries) {
          await this.#sleep(this.#backoff(attempt));
          attempt++;
          continue;
        }
        const msg = errors.length > 0 ? this.#messageFor(errors) : `HTTP ${status}: ${this.#snippet(text)}`;
        throw new LinearApiError(msg, { status, errors, op });
      }

      if (errors.length > 0) throw new LinearApiError(this.#messageFor(errors), { status, errors, op });
      if (status < 200 || status >= 300) {
        throw new LinearApiError(`HTTP ${status}: ${this.#snippet(text)}`, { status, errors, op });
      }
      if (!body || body.data === undefined || body.data === null) {
        throw new LinearApiError(`Linear ${op}: response contained no data (${this.#snippet(text)})`, { status, errors, op });
      }
      return body.data as T;
    }
  }

  /** Key-scrub every string of a GraphQL error (message and extensions) before it can reach an Error object. */
  #scrubError(e: GraphQLErrorItem): GraphQLErrorItem {
    const out: GraphQLErrorItem = { ...e, message: this.#scrub(e.message) };
    if (e.extensions) {
      try {
        out.extensions = JSON.parse(this.#scrub(JSON.stringify(e.extensions))) as Record<string, unknown>;
      } catch {
        delete out.extensions;
      }
    }
    return out;
  }

  #messageFor(errors: GraphQLErrorItem[]): string {
    const parts = errors.map((e) => e.message);
    const hints: string[] = [];
    for (const e of errors) {
      const h = e.extensions?.userPresentableMessage;
      if (typeof h === 'string' && h && !e.message.includes(h)) hints.push(this.#scrub(h));
    }
    return hints.length > 0 ? `${parts.join('; ')} — ${hints.join('; ')}` : parts.join('; ');
  }

  #snippet(text: string): string {
    const t = text.replace(/\s+/g, ' ').trim();
    return this.#scrub(t.length > 200 ? `${t.slice(0, 200)}…` : t || '(empty body)');
  }

  async #pages<D, N>(
    op: string,
    doc: string,
    vars: Record<string, unknown>,
    pick: (data: D) => Connection<N> | undefined | null,
    cap = Number.POSITIVE_INFINITY,
  ): Promise<{ nodes: N[]; truncated: boolean; first: D }> {
    const nodes: N[] = [];
    let after: string | null = null;
    let first: D | undefined;
    for (let page = 0; page < 1000; page++) {
      const data: D = await this.#request<D>(op, doc, after === null ? vars : { ...vars, after });
      if (first === undefined) first = data;
      const conn = pick(data);
      if (!conn) throw new LinearApiError(`Linear ${op}: unexpected response shape`, { status: 200, op });
      nodes.push(...conn.nodes);
      if (!conn.pageInfo?.hasNextPage) return { nodes, truncated: false, first };
      if (nodes.length >= cap) return { nodes, truncated: true, first };
      const next = conn.pageInfo.endCursor;
      if (!next || next === after) throw new LinearApiError(`Linear ${op}: pagination cursor did not advance`, { status: 200, op });
      after = next;
    }
    throw new LinearApiError(`Linear ${op}: too many pages`, { status: 200, op });
  }

  // ───────────────────────────── LinearPort ─────────────────────────────

  async viewer(): Promise<{ id: string; name: string; email: string }> {
    const d = await this.#request<{ viewer: { id: string; name: string; email: string } }>('viewer', ops.Q_VIEWER, {});
    return { id: d.viewer.id, name: d.viewer.name, email: d.viewer.email };
  }

  async teams(): Promise<{ id: string; key: string; name: string }[]> {
    const { nodes } = await this.#pages<{ teams: Connection<{ id: string; key: string; name: string }> }, { id: string; key: string; name: string }>(
      'teams',
      ops.Q_TEAMS,
      {},
      (d) => d.teams,
    );
    return nodes.map((t) => ({ id: t.id, key: t.key, name: t.name }));
  }

  async teamSetup(teamId: string): Promise<TeamSetupInfo> {
    type StatesData = {
      team: { id: string; defaultIssueState: { id: string } | null; states: Connection<{ id: string; name: string; type: string; position?: number }> };
    };
    const st = await this.#pages<StatesData, { id: string; name: string; type: string; position?: number }>(
      'teamSetup.states',
      ops.Q_TEAM_STATES,
      { teamId },
      (d) => d.team?.states,
    );
    const states = [...st.nodes]
      .map((s, i) => ({ s, i }))
      .sort((a, b) => (a.s.position ?? 0) - (b.s.position ?? 0) || a.i - b.i)
      .map(({ s }) => ({ id: s.id, name: s.name, type: s.type as LinearState['type'] }));
    const lb = await this.#pages<{ issueLabels: Connection<{ id: string; name: string; team?: { id: string } | null }> }, { id: string; name: string; team?: { id: string } | null }>(
      'teamSetup.labels',
      ops.Q_TEAM_LABELS,
      { filter: ops.teamLabelsFilter(teamId) },
      (d) => d.issueLabels,
    );
    const labels: LinearLabel[] = lb.nodes.map((l) => ({ id: l.id, name: l.name, teamId: l.team?.id ?? null }));
    return { states, labels, defaultIssueStateId: st.first.team?.defaultIssueState?.id ?? null };
  }

  async createLabel(teamId: string, input: { name: string; color: string }): Promise<LinearLabel> {
    const id = randomUUID();
    type D = { issueLabelCreate: { success: boolean; issueLabel: { id: string; name: string; team?: { id: string } | null } | null } };
    const d = await this.#request<D>('createLabel', ops.M_ISSUE_LABEL_CREATE, { input: { id, name: input.name, color: input.color, teamId } });
    const p = d.issueLabelCreate;
    if (!p?.success || !p.issueLabel) throw new LinearApiError('issueLabelCreate returned success=false', { status: 200, op: 'createLabel' });
    return { id: p.issueLabel.id, name: p.issueLabel.name, teamId: p.issueLabel.team?.id ?? null };
  }

  async createState(teamId: string, input: { name: string; type: LinearState['type']; color: string }): Promise<LinearState> {
    const id = randomUUID();
    type D = { workflowStateCreate: { success: boolean; workflowState: { id: string; name: string; type: string } | null } };
    const d = await this.#request<D>('createState', ops.M_WORKFLOW_STATE_CREATE, {
      input: { id, name: input.name, type: input.type, color: input.color, teamId },
    });
    const p = d.workflowStateCreate;
    if (!p?.success || !p.workflowState) throw new LinearApiError('workflowStateCreate returned success=false', { status: 200, op: 'createState' });
    return { id: p.workflowState.id, name: p.workflowState.name, type: p.workflowState.type as LinearState['type'] };
  }

  async candidates(teamId: string, triggerLabel: string, opts?: { includeAssigned?: boolean }): Promise<LinearIssue[]> {
    const filter = ops.candidatesFilter(teamId, triggerLabel, opts?.includeAssigned === true);
    const { nodes } = await this.#pages<{ issues: Connection<IssueNode> }, IssueNode>('candidates', ops.Q_CANDIDATES, { filter }, (d) => d.issues);
    return nodes.map(mapIssue).filter((i) => i.state.type !== 'completed' && i.state.type !== 'canceled');
  }

  async issue(id: string): Promise<LinearIssue> {
    type D = { issue: IssueNode & { comments: Connection<CommentNode>; history: Connection<HistoryNode> } };
    const d = await this.#request<D>('issue', ops.Q_ISSUE, { id });
    const node = d.issue;
    if (!node) throw new LinearApiError(`Entity not found: Issue ${id}`, { status: 200, op: 'issue' });
    const issue: IssueWithFlags = mapIssue(node);

    const comments = await this.#drain<{ issue: { comments: Connection<CommentNode> } }, CommentNode>(
      'issue.comments',
      ops.Q_ISSUE_COMMENTS_PAGE,
      id,
      node.comments,
      (d) => d.issue?.comments,
      this.#commentsCap,
    );
    const history = await this.#drain<{ issue: { history: Connection<HistoryNode> } }, HistoryNode>(
      'issue.history',
      ops.Q_ISSUE_HISTORY_PAGE,
      id,
      node.history,
      (d) => d.issue?.history,
      this.#historyCap,
    );

    issue.comments = comments.nodes.map(mapComment).sort(byCreatedAt);
    issue.history = history.nodes.map(mapHistory).sort(byCreatedAt);
    if (comments.truncated) issue.commentsTruncated = true;
    if (history.truncated) issue.historyTruncated = true;
    return issue;
  }

  /** Fetch the remaining pages of a connection that was already partly read (first page of `issue()`). */
  async #drain<D, N>(
    op: string,
    doc: string,
    id: string,
    first: Connection<N>,
    pick: (data: D) => Connection<N> | undefined | null,
    cap: number,
  ): Promise<{ nodes: N[]; truncated: boolean }> {
    const nodes: N[] = [...first.nodes];
    let page: PageInfo | undefined = first.pageInfo;
    while (page?.hasNextPage) {
      if (nodes.length >= cap) return { nodes, truncated: true };
      const after: string | null = page.endCursor;
      if (!after) throw new LinearApiError(`Linear ${op}: hasNextPage without endCursor`, { status: 200, op });
      const data: D = await this.#request<D>(op, doc, { id, after });
      const conn = pick(data);
      if (!conn) throw new LinearApiError(`Linear ${op}: unexpected response shape`, { status: 200, op });
      nodes.push(...conn.nodes);
      if (conn.pageInfo?.hasNextPage && conn.pageInfo.endCursor === after) {
        throw new LinearApiError(`Linear ${op}: pagination cursor did not advance`, { status: 200, op });
      }
      page = conn.pageInfo;
    }
    return { nodes, truncated: false };
  }

  async update(
    id: string,
    patch: { stateId?: string; addLabelIds?: string[]; removeLabelIds?: string[]; description?: string },
  ): Promise<void> {
    let effective = patch;
    if ((patch.addLabelIds?.length ?? 0) > 0 || (patch.removeLabelIds?.length ?? 0) > 0) {
      // Linear errors on removing a label that is not on the issue (and may on re-adding one that is): send only real changes.
      const cur = await this.#request<{ issue: { labels: { nodes: { id: string }[] } } | null }>('update.labels', ops.Q_ISSUE_LABEL_IDS, { id });
      const present = new Set((cur.issue?.labels.nodes ?? []).map((l) => l.id));
      effective = {
        ...patch,
        addLabelIds: (patch.addLabelIds ?? []).filter((l) => !present.has(l)),
        removeLabelIds: (patch.removeLabelIds ?? []).filter((l) => present.has(l)),
      };
    }
    const input = ops.issueUpdateInput(effective);
    if (Object.keys(input).length === 0) return;
    const d = await this.#request<{ issueUpdate: { success: boolean } }>('update', ops.M_ISSUE_UPDATE, { id, input });
    if (!d.issueUpdate?.success) throw new LinearApiError('issueUpdate returned success=false', { status: 200, op: 'update' });
  }

  async comment(issueId: string, body: string): Promise<{ id: string }> {
    const id = randomUUID();
    type D = { commentCreate: { success: boolean; comment: { id: string } | null } };
    const d = await this.#request<D>(
      'comment',
      ops.M_COMMENT_CREATE,
      { input: { id, issueId, body } },
      {
        recover: async () => {
          const r = await this.#request<{ comment: { id: string } | null }>('comment.lookup', ops.Q_COMMENT_LOOKUP, { id });
          return r.comment ? { commentCreate: { success: true, comment: { id: r.comment.id } } } : undefined;
        },
      },
    );
    const p = d.commentCreate;
    if (!p?.success || !p.comment) throw new LinearApiError('commentCreate returned success=false', { status: 200, op: 'comment' });
    return { id: p.comment.id };
  }

  async createIssue(input: {
    teamId: string;
    title: string;
    description?: string;
    parentId?: string;
    labelIds?: string[];
    stateId?: string;
    projectId?: string;
  }): Promise<LinearIssue> {
    const id = randomUUID();
    const payload: Record<string, unknown> = { id, teamId: input.teamId, title: input.title };
    if (input.description !== undefined) payload.description = input.description;
    if (input.parentId !== undefined) payload.parentId = input.parentId;
    if (input.labelIds !== undefined) payload.labelIds = input.labelIds;
    if (input.stateId !== undefined) payload.stateId = input.stateId;
    if (input.projectId !== undefined) payload.projectId = input.projectId;
    type D = { issueCreate: { success: boolean; issue: IssueNode | null } };
    const d = await this.#request<D>(
      'createIssue',
      ops.M_ISSUE_CREATE,
      { input: payload },
      {
        recover: async () => {
          const r = await this.#request<{ issue: IssueNode | null }>('createIssue.lookup', ops.Q_ISSUE_CORE, { id });
          return r.issue ? { issueCreate: { success: true, issue: r.issue } } : undefined;
        },
      },
    );
    const p = d.issueCreate;
    if (!p?.success || !p.issue) throw new LinearApiError('issueCreate returned success=false', { status: 200, op: 'createIssue' });
    return mapIssue(p.issue);
  }

  async children(issueId: string): Promise<LinearIssue[]> {
    const { nodes } = await this.#pages<{ issue: { children: Connection<IssueNode> } }, IssueNode>(
      'children',
      ops.Q_ISSUE_CHILDREN,
      { id: issueId },
      (d) => d.issue?.children,
    );
    return nodes.map(mapIssue);
  }
}

/**
 * Validate a personal API key with two read-only calls (`viewer`, `teams`). Throws `LinearApiError`
 * (bad key => Linear's verbatim authentication error) or `LinearNetworkError`.
 */
export async function validateKey(
  apiKey: string,
  opts: Omit<LinearClientOptions, 'apiKey'> = {},
): Promise<{ viewer: { id: string; name: string; email: string }; teams: { id: string; key: string; name: string }[] }> {
  const client = new LinearClient({ ...opts, apiKey });
  const viewer = await client.viewer();
  const teams = await client.teams();
  return { viewer, teams };
}
