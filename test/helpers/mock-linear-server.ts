/**
 * Test helpers for the Linear layer (offline only):
 *
 *  - `MockLinearServer`: a real local `http.createServer` GraphQL stub that records every request and answers with
 *    scripted JSON (or a default responder). By default it validates every incoming document AND its variables
 *    against the vendored official Linear SDL, so a client bug (unknown field, wrong variable type) fails loudly.
 *  - `fakeBackedResponder(fake)`: a responder that EXECUTES the incoming GraphQL document against the official
 *    schema with resolvers backed by a `FakeLinear`. The issue filter is evaluated here from the wire (independent
 *    of `FakeLinear.candidates`), so the FakeLinear <-> LinearClient parity suite is not tautological.
 *
 * Note: reads go through `fake.snapshot()` (they are not logged in `fake.calls` and not affected by
 * `fake.failNext`); mutations go through the fake's port methods (logged, failable).
 */
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSchema, execute, getVariableValues, Kind, parse, validate } from 'graphql';
import type { GraphQLSchema, OperationDefinitionNode } from 'graphql';
import type { LinearHistoryEntry, LinearIssue } from '../../src/types.ts';
import type { FakeLinear, FakeSnapshot } from '../../src/linear/fake.ts';
import { LinearApiError } from '../../src/linear/client.ts';

// ───────────────────────────── schema ─────────────────────────────

const SDL_PATH = fileURLToPath(new URL('../fixtures/linear-schema.graphql', import.meta.url));
let schemaCache: GraphQLSchema | undefined;

/** The vendored official Linear schema (built once per process). */
export function loadLinearSchema(): GraphQLSchema {
  schemaCache ??= buildSchema(readFileSync(SDL_PATH, 'utf8'), { assumeValidSDL: true });
  return schemaCache;
}

// ───────────────────────────── server ─────────────────────────────

export interface RecordedRequest {
  index: number;
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  rawBody: string;
  json: { query?: string; variables?: Record<string, unknown> } | null;
  /** Name of the operation in the document (e.g. "Candidates"), when parseable. */
  operation: string | null;
  query: string;
  variables: Record<string, unknown>;
}

export interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  /** Serialised as JSON. */
  json?: unknown;
  /** Raw body (overrides json). */
  text?: string;
  /** Delay before answering. */
  delayMs?: number;
  /** Destroy the socket instead of answering (network error). */
  destroySocket?: boolean;
}
export type Responder = (req: RecordedRequest) => MockResponse | Promise<MockResponse>;

/** `{data}` response. */
export const ok = (data: unknown, extra: Partial<MockResponse> = {}): MockResponse => ({ status: 200, json: { data }, ...extra });

/** `{errors:[{message, extensions}]}` response (default HTTP 200). */
export const gqlError = (message: string, extensions?: Record<string, unknown>, status = 200, extra: Partial<MockResponse> = {}): MockResponse => ({
  status,
  json: { errors: [{ message, ...(extensions ? { extensions } : {}) }], data: null },
  ...extra,
});

/** Page helper: `{nodes, pageInfo}`. */
export const page = <T>(nodes: T[], endCursor: string | null = null): { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } => ({
  nodes,
  pageInfo: { hasNextPage: endCursor !== null, endCursor },
});

export interface MockServerOptions {
  /** Validate every document + variables against the official schema (default true). */
  validate?: boolean;
}

export class MockLinearServer {
  readonly url: string;
  readonly requests: RecordedRequest[] = [];
  /** Schema-validation failures of incoming requests (must stay empty in a healthy test). */
  readonly schemaErrors: string[] = [];
  #server: Server;
  #sockets = new Set<Socket>();
  #queue: (MockResponse | Responder)[] = [];
  #default: Responder | undefined;
  #validate: boolean;

  private constructor(server: Server, url: string, validateDocs: boolean) {
    this.#server = server;
    this.url = url;
    this.#validate = validateDocs;
  }

  static async start(opts: MockServerOptions = {}): Promise<MockLinearServer> {
    let self: MockLinearServer | undefined;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void self!.#handle(req.method ?? 'GET', req.url ?? '/', req.headers, Buffer.concat(chunks).toString('utf8'), res);
      });
    });
    const sockets = new Set<Socket>();
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    self = new MockLinearServer(server, `http://127.0.0.1:${port}/graphql`, opts.validate !== false);
    self.#sockets = sockets;
    return self;
  }

  /** Default responder for requests not covered by `enqueue`. */
  respondWith(fn: Responder): void {
    this.#default = fn;
  }

  /** One-shot scripted responses, consumed in order before the default responder. */
  enqueue(...responses: (MockResponse | Responder)[]): void {
    this.#queue.push(...responses);
  }

  reset(): void {
    this.requests.length = 0;
    this.schemaErrors.length = 0;
    this.#queue = [];
    this.#default = undefined;
  }

  async close(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  async #handle(method: string, url: string, headers: IncomingHttpHeaders, rawBody: string, res: import('node:http').ServerResponse): Promise<void> {
    let json: RecordedRequest['json'] = null;
    try {
      json = JSON.parse(rawBody) as RecordedRequest['json'];
    } catch {
      json = null;
    }
    const query = typeof json?.query === 'string' ? json.query : '';
    let operation: string | null = null;
    try {
      const def = parse(query).definitions.find((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION);
      operation = def?.name?.value ?? null;
    } catch {
      operation = null;
    }
    const rec: RecordedRequest = {
      index: this.requests.length,
      method,
      url,
      headers,
      rawBody,
      json,
      operation,
      query,
      variables: (json?.variables ?? {}) as Record<string, unknown>,
    };
    this.requests.push(rec);

    let response: MockResponse;
    try {
      const problems = this.#validate ? this.#schemaProblems(rec) : [];
      if (problems.length > 0) {
        this.schemaErrors.push(...problems.map((p) => `${operation ?? '?'}: ${p}`));
        response = { status: 400, json: { errors: problems.map((message) => ({ message })) } };
      } else {
        const next = this.#queue.shift();
        const responder = next ?? this.#default;
        if (!responder) response = gqlError('mock server: no scripted response', undefined, 500);
        else response = typeof responder === 'function' ? await responder(rec) : responder;
      }
    } catch (e) {
      response = gqlError(`mock server responder crashed: ${e instanceof Error ? e.message : String(e)}`, undefined, 500);
    }

    if (response.delayMs) await new Promise((r) => setTimeout(r, response.delayMs));
    if (response.destroySocket) {
      res.socket?.destroy();
      return;
    }
    const body = response.text ?? JSON.stringify(response.json ?? {});
    res.writeHead(response.status ?? 200, { 'Content-Type': 'application/json', ...(response.headers ?? {}) });
    res.end(body);
  }

  #schemaProblems(rec: RecordedRequest): string[] {
    const schema = loadLinearSchema();
    let doc;
    try {
      doc = parse(rec.query);
    } catch (e) {
      return [`unparseable document: ${e instanceof Error ? e.message : String(e)}`];
    }
    const out = validate(schema, doc).map((e) => e.message);
    const op = doc.definitions.find((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION);
    if (op) {
      const vars = getVariableValues(schema, op.variableDefinitions ?? [], rec.variables);
      if ('errors' in vars && vars.errors) out.push(...vars.errors.map((e) => e.message));
    }
    return out;
  }
}

// ───────────────────────────── FakeLinear-backed GraphQL execution ─────────────────────────────

export interface FakeResponderOptions {
  /** Connection order. Real Linear lists newest first; the client must not depend on it. Default 'desc'. */
  order?: 'asc' | 'desc';
}

type Args = Record<string, unknown>;

function cursorOf(n: number): string {
  return `cur-${n}`;
}

function connection<T>(all: T[], args: Args, order: 'asc' | 'desc'): { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  const list = order === 'desc' ? [...all].reverse() : [...all];
  const first = typeof args.first === 'number' ? args.first : 50;
  let start = 0;
  if (typeof args.after === 'string') {
    const m = /^cur-(\d+)$/.exec(args.after);
    if (!m) throw new Error(`bad cursor ${args.after}`);
    start = Number(m[1]) + 1;
  }
  const nodes = list.slice(start, start + first);
  const end = start + nodes.length;
  const hasNextPage = end < list.length;
  return { nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? cursorOf(end - 1) : null } };
}

// ---- IssueFilter / IssueLabelFilter evaluation (strict: unknown keys throw) ----

interface Ctx {
  snap: FakeSnapshot;
}

function cmp(c: unknown, value: string | null, where: string): boolean {
  if (typeof c !== 'object' || c === null) throw new Error(`mock: bad comparator at ${where}`);
  for (const [op, arg] of Object.entries(c as Args)) {
    const v = value ?? '';
    switch (op) {
      case 'eq':
        if (value !== arg) return false;
        break;
      case 'eqIgnoreCase':
        if (value === null || value.toLowerCase() !== String(arg).toLowerCase()) return false;
        break;
      case 'neq':
        if (value === arg) return false;
        break;
      case 'in':
        if (!(arg as string[]).includes(v)) return false;
        break;
      case 'nin':
        if ((arg as string[]).includes(v)) return false;
        break;
      case 'null':
        if ((value === null) !== (arg === true)) return false;
        break;
      default:
        throw new Error(`mock: unsupported comparator "${op}" at ${where}`);
    }
  }
  return true;
}

function userFilter(f: unknown, userId: string | null, ctx: Ctx, where: string): boolean {
  for (const [k, v] of Object.entries(f as Args)) {
    switch (k) {
      case 'isMe': {
        const eq = (v as Args).eq;
        if (Object.keys(v as Args).some((x) => x !== 'eq')) throw new Error(`mock: unsupported isMe comparator at ${where}`);
        if ((userId === ctx.snap.viewer.id) !== (eq === true)) return false;
        break;
      }
      case 'id':
        if (!cmp(v, userId, `${where}.id`)) return false;
        break;
      case 'or':
        if (!(v as unknown[]).some((x) => userFilter(x, userId, ctx, `${where}.or`))) return false;
        break;
      case 'and':
        if (!(v as unknown[]).every((x) => userFilter(x, userId, ctx, `${where}.and`))) return false;
        break;
      default:
        throw new Error(`mock: unsupported user filter key "${k}" at ${where}`);
    }
  }
  return true;
}

function labelFilter(f: unknown, label: { id: string; name: string; teamId: string | null }, where: string): boolean {
  for (const [k, v] of Object.entries(f as Args)) {
    switch (k) {
      case 'name':
        if (!cmp(v, label.name, `${where}.name`)) return false;
        break;
      case 'id':
        if (!cmp(v, label.id, `${where}.id`)) return false;
        break;
      case 'team': {
        for (const [tk, tv] of Object.entries(v as Args)) {
          if (tk === 'id') {
            if (!cmp(tv, label.teamId, `${where}.team.id`)) return false;
          } else if (tk === 'null') {
            if ((label.teamId === null) !== (tv === true)) return false;
          } else throw new Error(`mock: unsupported team filter key "${tk}" at ${where}`);
        }
        break;
      }
      case 'or':
        if (!(v as unknown[]).some((x) => labelFilter(x, label, `${where}.or`))) return false;
        break;
      case 'and':
        if (!(v as unknown[]).every((x) => labelFilter(x, label, `${where}.and`))) return false;
        break;
      default:
        throw new Error(`mock: unsupported label filter key "${k}" at ${where}`);
    }
  }
  return true;
}

function issueFilter(f: unknown, issue: LinearIssue, ctx: Ctx, where = 'filter'): boolean {
  for (const [k, v] of Object.entries(f as Args)) {
    switch (k) {
      case 'team':
        for (const [tk, tv] of Object.entries(v as Args)) {
          if (tk !== 'id') throw new Error(`mock: unsupported team filter key "${tk}"`);
          if (!cmp(tv, issue.teamId, `${where}.team.id`)) return false;
        }
        break;
      case 'labels': {
        for (const [lk, lv] of Object.entries(v as Args)) {
          if (lk === 'some') {
            if (!issue.labels.some((l) => labelFilter(lv, l, `${where}.labels.some`))) return false;
          } else if (lk === 'every') {
            if (!issue.labels.every((l) => labelFilter(lv, l, `${where}.labels.every`))) return false;
          } else if (lk === 'name') {
            // shorthand: some label matches
            if (!issue.labels.some((l) => cmp(lv, l.name, `${where}.labels.name`))) return false;
          } else throw new Error(`mock: unsupported labels filter key "${lk}"`);
        }
        break;
      }
      case 'state':
        for (const [sk, sv] of Object.entries(v as Args)) {
          if (sk === 'type') {
            if (!cmp(sv, issue.state.type, `${where}.state.type`)) return false;
          } else if (sk === 'name') {
            if (!cmp(sv, issue.state.name, `${where}.state.name`)) return false;
          } else throw new Error(`mock: unsupported state filter key "${sk}"`);
        }
        break;
      case 'creator':
        if (!userFilter(v, issue.creatorId, ctx, `${where}.creator`)) return false;
        break;
      case 'assignee':
        if (!userFilter(v, issue.assigneeId, ctx, `${where}.assignee`)) return false;
        break;
      case 'or':
        if (!(v as unknown[]).some((x) => issueFilter(x, issue, ctx, `${where}.or`))) return false;
        break;
      case 'and':
        if (!(v as unknown[]).every((x) => issueFilter(x, issue, ctx, `${where}.and`))) return false;
        break;
      default:
        throw new Error(`mock: unsupported IssueFilter key "${k}" at ${where}`);
    }
  }
  return true;
}

/**
 * Responder that executes the document against the official schema with FakeLinear-backed resolvers.
 * Resolvers implemented: viewer, teams, team, issueLabels, issues, issue, comment (lookup), and the five mutations.
 */
export function fakeBackedResponder(fake: FakeLinear, opts: FakeResponderOptions = {}): Responder {
  const order = opts.order ?? 'desc';
  const schema = loadLinearSchema();

  const issueNode = (rec: FakeSnapshot['issues'][number], ctx: Ctx): Record<string, unknown> => {
    const i = rec.issue;
    return {
      id: i.id,
      identifier: i.identifier,
      title: i.title,
      description: i.description === '' ? null : i.description,
      url: i.url,
      priority: i.priority,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
      state: { ...i.state },
      labels: (a: Args) => connection(i.labels.map((l) => ({ id: l.id, name: l.name, team: l.teamId ? { id: l.teamId } : null })), a, 'asc'),
      creator: i.creatorId ? { id: i.creatorId } : null,
      assignee: i.assigneeId ? { id: i.assigneeId } : null,
      parent: i.parentId ? { id: i.parentId } : null,
      project: i.projectName ? { name: i.projectName } : null,
      team: { id: i.teamId },
      comments: (a: Args) =>
        connection(
          rec.comments.map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, user: c.userId ? { id: c.userId } : null })),
          a,
          order,
        ),
      history: (a: Args) => connection(rec.history.map((h) => historyNode(h)), a, order),
      children: (a: Args) =>
        connection(
          ctx.snap.issues.filter((x) => x.issue.parentId === i.id).map((x) => issueNode(x, ctx)),
          a,
          order,
        ),
    };
  };

  const historyNode = (h: LinearHistoryEntry): Record<string, unknown> => ({
    id: h.id,
    createdAt: h.createdAt,
    actorId: h.actorId,
    addedLabelIds: h.addedLabelIds,
    removedLabelIds: h.removedLabelIds,
    updatedDescription: h.descriptionUpdatedBy.length > 0,
    descriptionUpdatedBy: h.descriptionUpdatedBy.map((id) => ({ id })),
    fromStateId: h.fromStateId ?? null,
    toStateId: h.toStateId ?? null,
  });

  const findIssue = (ctx: Ctx, ref: string): FakeSnapshot['issues'][number] => {
    const rec = ctx.snap.issues.find((r) => r.issue.id === ref || r.issue.identifier.toLowerCase() === ref.toLowerCase());
    if (!rec) throw new LinearApiError(`Entity not found: Issue - Could not find referenced Issue (${ref}).`, { status: 200, op: 'issue' });
    return rec;
  };

  const root = (): Record<string, unknown> => {
    const ctx: Ctx = { snap: fake.snapshot() };
    const stateNode = (s: { id: string; name: string; type: string; position?: number }): Record<string, unknown> => ({
      id: s.id,
      name: s.name,
      type: s.type,
      position: s.position ?? 0,
    });
    return {
      viewer: () => ({ ...ctx.snap.viewer }),
      teams: (a: Args) => connection([ctx.snap.team], a, 'asc'),
      team: (a: Args) => {
        if (a.id !== ctx.snap.team.id) throw new LinearApiError(`Entity not found: Team - Could not find referenced Team (${String(a.id)}).`, { status: 200, op: 'team' });
        const def = ctx.snap.states.find((s) => s.id === ctx.snap.defaultIssueStateId);
        return {
          id: ctx.snap.team.id,
          key: ctx.snap.team.key,
          name: ctx.snap.team.name,
          defaultIssueState: def ? stateNode(def) : null,
          states: (sa: Args) => connection(ctx.snap.states.map(stateNode), sa, 'asc'),
        };
      },
      issueLabels: (a: Args) => {
        const labels = ctx.snap.labels.filter((l) => (a.filter ? labelFilter(a.filter, l, 'issueLabels.filter') : true));
        return connection(labels.map((l) => ({ id: l.id, name: l.name, team: l.teamId ? { id: l.teamId } : null })), a, 'asc');
      },
      issues: (a: Args) => {
        const matching = ctx.snap.issues.filter((r) => (a.filter ? issueFilter(a.filter, r.issue, ctx) : true));
        return connection(matching.map((r) => issueNode(r, ctx)), a, order);
      },
      issue: (a: Args) => issueNode(findIssue(ctx, String(a.id)), ctx),
      comment: (a: Args) => {
        for (const r of ctx.snap.issues) {
          const c = r.comments.find((x) => x.id === a.id);
          if (c) return { id: c.id, body: c.body, createdAt: c.createdAt, user: c.userId ? { id: c.userId } : null };
        }
        throw new LinearApiError(`Entity not found: Comment - Could not find referenced Comment (${String(a.id)}).`, { status: 200, op: 'comment' });
      },

      // ---- mutations (through the fake's port methods) ----
      issueUpdate: async (a: Args) => {
        const input = a.input as Args;
        const known = new Set(['stateId', 'addedLabelIds', 'removedLabelIds', 'description']);
        for (const k of Object.keys(input)) if (!known.has(k)) throw new Error(`mock: unsupported IssueUpdateInput key "${k}"`);
        await fake.update(String(a.id), {
          stateId: input.stateId as string | undefined,
          addLabelIds: input.addedLabelIds as string[] | undefined,
          removeLabelIds: input.removedLabelIds as string[] | undefined,
          description: input.description as string | undefined,
        });
        return { success: true };
      },
      commentCreate: async (a: Args) => {
        const input = a.input as Args;
        const { id } = await fake.comment(String(input.issueId), String(input.body), { id: input.id as string | undefined });
        return { success: true, comment: { id } };
      },
      issueCreate: async (a: Args) => {
        const input = a.input as Args;
        const created = await fake.createIssue(
          {
            teamId: String(input.teamId),
            title: String(input.title),
            description: input.description as string | undefined,
            parentId: input.parentId as string | undefined,
            labelIds: input.labelIds as string[] | undefined,
            stateId: input.stateId as string | undefined,
            projectId: input.projectId as string | undefined,
          },
          { id: input.id as string | undefined },
        );
        const ctx2: Ctx = { snap: fake.snapshot() };
        return { success: true, issue: issueNode(findIssue(ctx2, created.id), ctx2) };
      },
      issueLabelCreate: async (a: Args) => {
        const input = a.input as Args;
        if (typeof input.teamId !== 'string') throw new Error('mock: workspace label creation is not supported');
        const l = await fake.createLabel(input.teamId, { name: String(input.name), color: String(input.color ?? '#000000') }, { id: input.id as string | undefined });
        return { success: true, issueLabel: { id: l.id, name: l.name, team: l.teamId ? { id: l.teamId } : null } };
      },
      workflowStateCreate: async (a: Args) => {
        const input = a.input as Args;
        const s = await fake.createState(
          String(input.teamId),
          { name: String(input.name), type: input.type as 'started', color: String(input.color) },
          { id: input.id as string | undefined },
        );
        return { success: true, workflowState: { id: s.id, name: s.name, type: s.type } };
      },
    };
  };

  return async (req) => {
    let document;
    try {
      document = parse(req.query);
    } catch (e) {
      return { status: 400, json: { errors: [{ message: e instanceof Error ? e.message : String(e) }] } };
    }
    const result = await execute({ schema, document, rootValue: root(), variableValues: req.variables });
    const errors = result.errors?.map((e) => {
      const original = e.originalError as { errors?: { code?: string }[] } | undefined;
      const code = original?.errors?.[0]?.code;
      return { message: e.message, path: e.path, ...(code ? { extensions: { code } } : {}) };
    });
    return { status: 200, json: { data: result.data ?? null, ...(errors ? { errors } : {}) } };
  };
}
