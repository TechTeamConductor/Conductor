/**
 * LinearClient against a real local GraphQL stub (test/helpers/mock-linear-server.ts).
 * Every incoming document and its variables are validated against the vendored official schema by the stub.
 */
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import {
  LinearApiError,
  LinearClient,
  LinearNetworkError,
  LinearRateLimitError,
  isNotFoundError,
  isRateLimitError,
  validateKey,
} from '../../src/linear/client.ts';
import * as ops from '../../src/linear/ops.ts';
import { MockLinearServer, gqlError, ok, page } from '../helpers/mock-linear-server.ts';
import type { MockResponse, RecordedRequest } from '../helpers/mock-linear-server.ts';

const KEY = 'lin_api_TESTKEYTESTKEYTESTKEYTESTKEY0123456789';

let server: MockLinearServer;
before(async () => {
  server = await MockLinearServer.start();
});
after(async () => {
  await server.close();
});
beforeEach(() => server.reset());
afterEach(() => {
  assert.deepEqual(server.schemaErrors, [], 'client sent a document/variables the official schema rejects');
});

interface Harness {
  client: LinearClient;
  sleeps: number[];
}
function makeClient(extra: Partial<ConstructorParameters<typeof LinearClient>[0]> = {}): Harness {
  const sleeps: number[] = [];
  const client = new LinearClient({
    apiKey: KEY,
    endpoint: server.url,
    sleepFn: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { client, sleeps };
}

function issueNode(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `issue-${n}`,
    identifier: `ENG-${n}`,
    title: `Issue ${n}`,
    description: `desc ${n}`,
    url: `https://linear.app/x/issue/ENG-${n}`,
    priority: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    state: { id: 'st-todo', name: 'Todo', type: 'unstarted' },
    labels: { nodes: [{ id: 'lab-1', name: 'conductor', team: { id: 'team-1' } }, { id: 'lab-ws', name: 'ws', team: null }] },
    creator: { id: 'user-me' },
    assignee: { id: 'user-asg' },
    parent: null,
    project: { name: 'Proj' },
    team: { id: 'team-1' },
    ...extra,
  };
}

const opName = (r: RecordedRequest): string | null => r.operation;

describe('LinearClient transport', () => {
  test('sends the raw personal API key as Authorization (no Bearer) via POST JSON', async () => {
    const { client } = makeClient();
    server.enqueue(ok({ viewer: { id: 'u1', name: 'Me', email: 'me@x.test' } }));
    const v = await client.viewer();
    assert.deepEqual(v, { id: 'u1', name: 'Me', email: 'me@x.test' });
    const req = server.requests[0]!;
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, KEY);
    assert.ok(!/bearer/i.test(String(req.headers.authorization)));
    assert.match(String(req.headers['content-type']), /application\/json/);
    assert.equal(req.json?.query, ops.Q_VIEWER);
  });

  test('constructor requires a key; the key is not exposed by JSON/inspect/String', () => {
    assert.throws(() => new LinearClient({ apiKey: '  ' }), /apiKey is required/);
    const { client } = makeClient();
    assert.ok(!JSON.stringify(client).includes(KEY));
    assert.ok(!inspect(client, { depth: 5, showHidden: true }).includes(KEY));
    assert.ok(!String(client).includes(KEY));
  });

  test('GraphQL errors are surfaced verbatim as LinearApiError (status, errors[], no key)', async () => {
    const { client } = makeClient();
    server.enqueue(gqlError('Argument Validation Error', { code: 'INVALID_INPUT', userPresentableMessage: 'teamId must be a UUID' }));
    await assert.rejects(client.viewer(), (e: unknown) => {
      assert.ok(e instanceof LinearApiError);
      assert.ok(!(e instanceof LinearRateLimitError));
      assert.ok(e.message.startsWith('Argument Validation Error'), e.message);
      assert.ok(e.message.includes('teamId must be a UUID'));
      assert.equal(e.status, 200);
      assert.equal(e.op, 'viewer');
      assert.equal(e.errors[0]!.message, 'Argument Validation Error');
      assert.equal(e.errors[0]!.code, 'INVALID_INPUT');
      return true;
    });
    assert.equal(server.requests.length, 1, 'GraphQL errors are not retried');
  });

  test('the API key never appears in error text, even when the server echoes it back', async () => {
    const { client } = makeClient();
    server.enqueue(gqlError(`Authentication failed for token ${KEY}`, { code: 'AUTHENTICATION_ERROR' }, 401));
    await assert.rejects(client.viewer(), (e: unknown) => {
      assert.ok(e instanceof LinearApiError);
      const everything = [e.message, e.stack ?? '', JSON.stringify(e), inspect(e, { depth: 6 })].join('\n');
      assert.ok(!everything.includes(KEY), 'key leaked');
      assert.ok(e.message.includes('[redacted]'));
      assert.equal(e.forbidden, true);
      assert.equal(e.status, 401);
      return true;
    });
    // the key is also scrubbed out of extensions
    server.enqueue(gqlError('Bad request', { code: 'INVALID_INPUT', echoed: `token=${KEY}` }));
    await assert.rejects(client.viewer(), (e: unknown) => {
      assert.ok(e instanceof LinearApiError);
      assert.ok(!JSON.stringify(e.errors).includes(KEY));
      assert.match(JSON.stringify(e.errors), /\[redacted\]/);
      return true;
    });
    // and a non-JSON body that echoes the key
    server.enqueue({ status: 403, text: `<html>denied ${KEY}</html>` });
    await assert.rejects(client.viewer(), (e: unknown) => {
      assert.ok(e instanceof LinearApiError);
      assert.ok(!e.message.includes(KEY));
      assert.match(e.message, /^HTTP 403/);
      return true;
    });
  });

  test('network errors are typed LinearNetworkError (query retried, then surfaced)', async () => {
    const { client, sleeps } = makeClient({ maxRetries: 2 });
    server.respondWith(() => ({ destroySocket: true }));
    await assert.rejects(client.viewer(), (e: unknown) => {
      assert.ok(e instanceof LinearNetworkError);
      assert.equal(e.timedOut, false);
      assert.equal(e.op, 'viewer');
      assert.ok(!e.message.includes(KEY));
      return true;
    });
    assert.equal(server.requests.length, 3);
    assert.deepEqual(sleeps, [1000, 2000]);
  });

  test('request timeout => LinearNetworkError{timedOut}', async () => {
    const { client } = makeClient({ timeoutMs: 80, maxRetries: 0 });
    server.respondWith(() => ok({ viewer: { id: 'u', name: 'n', email: 'e' } }, { delayMs: 600 }));
    const t0 = Date.now();
    await assert.rejects(client.viewer(), (e: unknown) => {
      assert.ok(e instanceof LinearNetworkError);
      assert.equal(e.timedOut, true);
      assert.match(e.message, /timed out after 80 ms/);
      return true;
    });
    assert.ok(Date.now() - t0 < 500, 'did not wait for the slow server');
  });

  test('a fetchFn that ignores the abort signal still times out', async () => {
    const hang: typeof fetch = () => new Promise<Response>(() => undefined);
    const client = new LinearClient({ apiKey: KEY, endpoint: server.url, fetchFn: hang, timeoutMs: 50, maxRetries: 0 });
    await assert.rejects(client.viewer(), (e: unknown) => e instanceof LinearNetworkError && e.timedOut);
  });

  test('5xx is retried x3 with exponential backoff, then succeeds', async () => {
    const { client, sleeps } = makeClient();
    server.enqueue({ status: 502, text: '<html>bad gateway</html>' }, { status: 503, json: {} }, ok({ viewer: { id: 'u', name: 'n', email: 'e' } }));
    const v = await client.viewer();
    assert.equal(v.id, 'u');
    assert.equal(server.requests.length, 3);
    assert.deepEqual(sleeps, [1000, 2000]);
  });

  test('persistent 5xx => LinearApiError after exactly 1 + 3 attempts', async () => {
    const { client, sleeps } = makeClient();
    server.respondWith(() => ({ status: 500, text: 'Internal Server Error' }));
    await assert.rejects(client.viewer(), (e: unknown) => {
      assert.ok(e instanceof LinearApiError);
      assert.equal(e.status, 500);
      assert.match(e.message, /HTTP 500: Internal Server Error/);
      return true;
    });
    assert.equal(server.requests.length, 4);
    assert.deepEqual(sleeps, [1000, 2000, 4000]);
  });

  test('a 200 response without data is an error, not an empty result', async () => {
    const { client } = makeClient();
    server.enqueue({ status: 200, text: 'not json at all' });
    await assert.rejects(client.viewer(), /no data/);
  });
});

describe('LinearClient rate limiting', () => {
  test('HTTP 429 honours Retry-After (seconds) with the injected sleep', async () => {
    const { client, sleeps } = makeClient();
    server.enqueue({ status: 429, headers: { 'Retry-After': '7' }, text: 'slow down' }, ok({ viewer: { id: 'u', name: 'n', email: 'e' } }));
    await client.viewer();
    assert.deepEqual(sleeps, [7000]);
    assert.equal(server.requests.length, 2);
  });

  test('X-RateLimit-Requests-Reset (epoch seconds) is converted using the injected clock', async () => {
    const now = Date.UTC(2026, 5, 1, 12, 0, 0);
    const { client, sleeps } = makeClient({ nowFn: () => now });
    const resetEpochSec = Math.floor(now / 1000) + 42;
    server.enqueue(
      { status: 429, headers: { 'X-RateLimit-Requests-Remaining': '0', 'X-RateLimit-Requests-Reset': String(resetEpochSec) }, text: '' },
      ok({ viewer: { id: 'u', name: 'n', email: 'e' } }),
    );
    await client.viewer();
    assert.deepEqual(sleeps, [42_000]);
  });

  test('without any hint the wait is exponential; one wait is capped at 10 minutes', async () => {
    const { client, sleeps } = makeClient();
    server.enqueue(
      { status: 429, text: '' },
      { status: 429, text: '' },
      { status: 429, headers: { 'Retry-After': '99999' }, text: '' },
      ok({ viewer: { id: 'u', name: 'n', email: 'e' } }),
    );
    await client.viewer();
    assert.deepEqual(sleeps, [1000, 2000, 600_000]);
  });

  test('GraphQL RATELIMITED (HTTP 400, as Linear sends it) backs off then surfaces LinearRateLimitError', async () => {
    const { client, sleeps } = makeClient({ maxRetries: 2 });
    server.respondWith(() =>
      gqlError('Rate limit exceeded', { code: 'RATELIMITED', type: 'ratelimited error' }, 400, { headers: { 'Retry-After': '3' } }),
    );
    await assert.rejects(client.viewer(), (e: unknown) => {
      assert.ok(e instanceof LinearRateLimitError);
      assert.ok(e instanceof LinearApiError);
      assert.ok(isRateLimitError(e));
      assert.equal(e.message, 'Rate limit exceeded');
      assert.equal(e.retryAfterMs, 3000);
      assert.equal(e.attempts, 2);
      assert.equal(e.status, 400);
      return true;
    });
    assert.equal(server.requests.length, 3);
    assert.deepEqual(sleeps, [3000, 3000]);
  });

  test('RATELIMITED recovers when the next attempt succeeds', async () => {
    const { client, sleeps } = makeClient();
    server.enqueue(gqlError('Rate limit exceeded', { code: 'RATELIMITED' }, 400), ok({ viewer: { id: 'u', name: 'n', email: 'e' } }));
    assert.equal((await client.viewer()).id, 'u');
    assert.deepEqual(sleeps, [1000]);
  });
});

describe('LinearClient pagination', () => {
  test('candidates: 3 pages are followed via endCursor and merged; completed/canceled dropped defensively', async () => {
    const { client } = makeClient();
    server.enqueue(
      ok({ issues: page([issueNode(1), issueNode(2)], 'c1') }),
      ok({ issues: page([issueNode(3), issueNode(4, { state: { id: 's', name: 'Done', type: 'completed' } })], 'c2') }),
      ok({ issues: page([issueNode(5, { parent: { id: 'issue-1' }, project: null })]) }),
    );
    const list = await client.candidates('team-1', 'conductor');
    assert.deepEqual(
      list.map((i) => i.identifier),
      ['ENG-1', 'ENG-2', 'ENG-3', 'ENG-5'],
    );
    assert.equal(server.requests.length, 3);
    assert.deepEqual(
      server.requests.map((r) => r.variables.after),
      [undefined, 'c1', 'c2'],
    );
    assert.ok(server.requests.every((r) => opName(r) === 'Candidates'));
    const i5 = list[3]!;
    assert.equal(i5.parentId, 'issue-1');
    assert.equal(i5.projectName, null);
    const i1 = list[0]!;
    assert.equal(i1.creatorId, 'user-me');
    assert.equal(i1.assigneeId, 'user-asg');
    assert.equal(i1.teamId, 'team-1');
    assert.equal(i1.projectName, 'Proj');
    assert.deepEqual(i1.state, { id: 'st-todo', name: 'Todo', type: 'unstarted' });
    assert.deepEqual(i1.labels, [
      { id: 'lab-1', name: 'conductor', teamId: 'team-1' },
      { id: 'lab-ws', name: 'ws', teamId: null },
    ]);
    assert.equal(i1.description, 'desc 1');
    assert.equal(i1.comments, undefined, 'candidates carry no comments/history');
  });

  test('candidates sends the server-side creator isMe filter; includeAssigned switches to or[creator, assignee]', async () => {
    const { client } = makeClient();
    server.enqueue(ok({ issues: page([]) }), ok({ issues: page([]) }));
    await client.candidates('team-1', 'conductor');
    await client.candidates('team-1', 'Conductor', { includeAssigned: true });
    const f1 = server.requests[0]!.variables.filter as Record<string, unknown>;
    assert.deepEqual(f1.creator, { isMe: { eq: true } });
    assert.deepEqual(f1.team, { id: { eq: 'team-1' } });
    assert.deepEqual(f1.state, { type: { nin: ['completed', 'canceled'] } });
    assert.deepEqual(f1.labels, { some: { name: { eqIgnoreCase: 'conductor' } } });
    assert.equal('or' in f1, false);
    const f2 = server.requests[1]!.variables.filter as Record<string, unknown>;
    assert.deepEqual(f2.or, [{ creator: { isMe: { eq: true } } }, { assignee: { isMe: { eq: true } } }]);
    assert.equal('creator' in f2, false);
    assert.deepEqual(f2.labels, { some: { name: { eqIgnoreCase: 'Conductor' } } });
  });

  test('a pagination cursor that does not advance is an error (no infinite loop)', async () => {
    const { client } = makeClient();
    server.respondWith(() => ok({ issues: page([issueNode(1)], 'same') }));
    await assert.rejects(client.candidates('team-1', 'conductor'), /did not advance/);
    assert.equal(server.requests.length, 2);
  });

  test('issue(): ALL history pages and ALL comment pages are fetched, sorted oldest first', async () => {
    const { client } = makeClient();
    const h = (n: number, extra: Record<string, unknown> = {}) => ({
      id: `h${n}`,
      createdAt: `2026-02-0${n}T00:00:00.000Z`,
      actorId: 'user-me',
      addedLabelIds: [],
      removedLabelIds: [],
      updatedDescription: false,
      descriptionUpdatedBy: [],
      fromStateId: null,
      toStateId: null,
      ...extra,
    });
    const c = (n: number) => ({ id: `c${n}`, body: `body ${n}`, createdAt: `2026-03-0${n}T00:00:00.000Z`, user: n === 3 ? null : { id: 'user-me' } });
    server.respondWith((req) => {
      const after = req.variables.after as string | undefined;
      switch (opName(req)) {
        case 'Issue':
          return ok({ issue: { ...issueNode(1), comments: page([c(3)], 'cm1'), history: page([h(5, { addedLabelIds: ['lab-1'] })], 'hs1') } });
        case 'IssueCommentsPage':
          return ok({ issue: { id: 'issue-1', comments: after === 'cm1' ? page([c(2)], 'cm2') : page([c(1)]) } });
        case 'IssueHistoryPage':
          return ok({
            issue: {
              id: 'issue-1',
              history:
                after === 'hs1'
                  ? page([h(4, { updatedDescription: true, descriptionUpdatedBy: [{ id: 'user-other' }] })], 'hs2')
                  : page([h(3, { fromStateId: 'a', toStateId: 'b', updatedDescription: true, descriptionUpdatedBy: [] }), h(1)]),
            },
          });
        default:
          return gqlError(`unexpected ${opName(req)}`, undefined, 500);
      }
    });
    const issue = await client.issue('ENG-1');
    assert.deepEqual(
      server.requests.map((r) => [opName(r), r.variables.after ?? null]),
      [
        ['Issue', null],
        ['IssueCommentsPage', 'cm1'],
        ['IssueCommentsPage', 'cm2'],
        ['IssueHistoryPage', 'hs1'],
        ['IssueHistoryPage', 'hs2'],
      ],
    );
    assert.deepEqual(
      issue.comments!.map((x) => x.id),
      ['c1', 'c2', 'c3'],
    );
    assert.equal(issue.comments![2]!.userId, null);
    assert.equal(issue.comments![0]!.userId, 'user-me');
    assert.deepEqual(
      issue.history!.map((x) => x.id),
      ['h1', 'h3', 'h4', 'h5'],
    );
    const byId = Object.fromEntries(issue.history!.map((x) => [x.id, x]));
    assert.deepEqual(byId.h5!.addedLabelIds, ['lab-1']);
    assert.deepEqual(byId.h4!.descriptionUpdatedBy, ['user-other']);
    assert.equal(byId.h3!.fromStateId, 'a');
    assert.equal(byId.h3!.toStateId, 'b');
    // "description updated" with no named user fails closed: attributed to the actor, never to nobody
    assert.deepEqual(byId.h3!.descriptionUpdatedBy, ['user-me']);
    assert.equal(issue.identifier, 'ENG-1');
    assert.equal((issue as { historyTruncated?: boolean }).historyTruncated, undefined);
  });

  test('issue(): history cap sets historyTruncated (attribution must fail closed)', async () => {
    const { client } = makeClient({ historyCap: 3, commentsCap: 2 });
    const hs = (from: number, n: number) =>
      Array.from({ length: n }, (_, k) => ({
        id: `h${from + k}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, from + k)).toISOString(),
        actorId: 'u',
        addedLabelIds: [],
        removedLabelIds: [],
        updatedDescription: false,
        descriptionUpdatedBy: [],
        fromStateId: null,
        toStateId: null,
      }));
    server.respondWith((req) => {
      const after = req.variables.after as string | undefined;
      if (opName(req) === 'Issue') return ok({ issue: { ...issueNode(1), comments: page([]), history: page(hs(0, 2), 'p1') } });
      if (opName(req) === 'IssueHistoryPage') return ok({ issue: { id: 'issue-1', history: after === 'p1' ? page(hs(2, 2), 'p2') : page(hs(4, 2), 'p3') } });
      return gqlError('unexpected', undefined, 500);
    });
    const issue = await client.issue('issue-1');
    const flags = issue as { historyTruncated?: boolean; commentsTruncated?: boolean };
    assert.equal(flags.historyTruncated, true);
    assert.equal(flags.commentsTruncated, undefined);
    assert.equal(issue.history!.length, 4, 'stops requesting once the cap is reached');
    assert.equal(server.requests.length, 2);
  });

  test('issue(): a deleted issue is a not-found LinearApiError', async () => {
    const { client } = makeClient();
    server.enqueue(gqlError('Entity not found: Issue', { code: 'INVALID_INPUT', userPresentableMessage: 'Could not find referenced Issue.' }));
    await assert.rejects(client.issue('gone'), (e: unknown) => isNotFoundError(e));
  });

  test('children(): paginated, parentId populated', async () => {
    const { client } = makeClient();
    server.enqueue(
      ok({ issue: { id: 'p', children: page([issueNode(2, { parent: { id: 'p' } })], 'k1') } }),
      ok({ issue: { id: 'p', children: page([issueNode(3, { parent: { id: 'p' } })]) } }),
    );
    const kids = await client.children('p');
    assert.deepEqual(
      kids.map((k) => [k.identifier, k.parentId]),
      [
        ['ENG-2', 'p'],
        ['ENG-3', 'p'],
      ],
    );
    assert.equal(server.requests[1]!.variables.after, 'k1');
  });

  test('teams(): paginated', async () => {
    const { client } = makeClient();
    server.enqueue(ok({ teams: page([{ id: 't1', key: 'A', name: 'Alpha' }], 'x') }), ok({ teams: page([{ id: 't2', key: 'B', name: 'Beta' }]) }));
    assert.deepEqual(await client.teams(), [
      { id: 't1', key: 'A', name: 'Alpha' },
      { id: 't2', key: 'B', name: 'Beta' },
    ]);
  });

  test('teamSetup(): states by position, team + workspace labels (workspace teamId null), default issue state', async () => {
    const { client } = makeClient();
    server.respondWith((req) => {
      const after = req.variables.after as string | undefined;
      if (opName(req) === 'TeamStates') {
        const defaultIssueState = { id: 'st-backlog', name: 'Backlog', type: 'backlog' };
        return ok({
          team: {
            id: 'team-1',
            defaultIssueState,
            states: after
              ? page([{ id: 'st-backlog', name: 'Backlog', type: 'backlog', position: 0 }])
              : page(
                  [
                    { id: 'st-done', name: 'Done', type: 'completed', position: 5 },
                    { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 1 },
                  ],
                  'sp',
                ),
          },
        });
      }
      if (opName(req) === 'TeamLabels') {
        return ok({
          issueLabels: after
            ? page([{ id: 'l2', name: 'workspace-wide', team: null }])
            : page([{ id: 'l1', name: 'conductor', team: { id: 'team-1' } }], 'lp'),
        });
      }
      return gqlError('unexpected', undefined, 500);
    });
    const setup = await client.teamSetup('team-1');
    assert.deepEqual(
      setup.states.map((s) => s.name),
      ['Backlog', 'Todo', 'Done'],
    );
    assert.deepEqual(setup.labels, [
      { id: 'l1', name: 'conductor', teamId: 'team-1' },
      { id: 'l2', name: 'workspace-wide', teamId: null },
    ]);
    assert.equal(setup.defaultIssueStateId, 'st-backlog');
    const labelReq = server.requests.find((r) => opName(r) === 'TeamLabels')!;
    assert.deepEqual(labelReq.variables.filter, { or: [{ team: { id: { eq: 'team-1' } } }, { team: { null: true } }] });
  });

  test('teamSetup(): defaultIssueStateId is null when Linear reports none', async () => {
    const { client } = makeClient();
    server.respondWith((req) =>
      opName(req) === 'TeamStates'
        ? ok({ team: { id: 't', defaultIssueState: null, states: page([{ id: 's', name: 'Todo', type: 'unstarted', position: 1 }]) } })
        : ok({ issueLabels: page([]) }),
    );
    assert.equal((await client.teamSetup('t')).defaultIssueStateId, null);
  });
});

describe('LinearClient mutations', () => {
  test('update(): maps addLabelIds/removeLabelIds to addedLabelIds/removedLabelIds; empty patch sends nothing', async () => {
    const { client } = makeClient();
    server.enqueue(ok({ issueUpdate: { success: true } }));
    await client.update('i1', { stateId: 's1', addLabelIds: ['a', 'b'], removeLabelIds: ['c'], description: 'new' });
    assert.deepEqual(server.requests[0]!.variables, {
      id: 'i1',
      input: { stateId: 's1', addedLabelIds: ['a', 'b'], removedLabelIds: ['c'], description: 'new' },
    });
    await client.update('i1', {});
    await client.update('i1', { addLabelIds: [], removeLabelIds: [] });
    assert.equal(server.requests.length, 1);
  });

  test('update(): success=false is an error', async () => {
    const { client } = makeClient();
    server.enqueue(ok({ issueUpdate: { success: false } }));
    await assert.rejects(client.update('i1', { stateId: 's' }), /success=false/);
  });

  test('comment(): sends a client-generated UUID id and returns the comment id', async () => {
    const { client } = makeClient();
    server.enqueue(ok({ commentCreate: { success: true, comment: { id: 'cm-1' } } }));
    const r = await client.comment('issue-1', 'hello\n\nconductor-ref: k');
    assert.deepEqual(r, { id: 'cm-1' });
    const input = server.requests[0]!.variables.input as Record<string, unknown>;
    assert.equal(input.issueId, 'issue-1');
    assert.equal(input.body, 'hello\n\nconductor-ref: k');
    assert.match(String(input.id), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('comment(): 503 then a duplicate-id error => the earlier attempt applied; the comment is looked up and adopted', async () => {
    const { client } = makeClient({ maxRetries: 3 });
    server.enqueue(
      { status: 503, text: 'unavailable' },
      gqlError('Entity already exists with this id'),
      ok({ comment: { id: 'cm-existing' } }),
    );
    const r = await client.comment('issue-1', 'x');
    assert.deepEqual(r, { id: 'cm-existing' });
    const ids = server.requests.filter((q) => opName(q) === 'CommentCreate').map((q) => (q.variables.input as { id: string }).id);
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1], 'retries reuse the same client-generated id');
    assert.equal(server.requests[2]!.variables.id, ids[0]);
  });

  test('comment(): a plain GraphQL error without an earlier ambiguous attempt is NOT recovered by lookup', async () => {
    const { client } = makeClient();
    server.enqueue(gqlError('Entity not found: Issue'));
    await assert.rejects(client.comment('gone', 'x'), (e: unknown) => isNotFoundError(e));
    assert.equal(server.requests.length, 1);
  });

  test('comment(): ambiguous failure whose lookup finds nothing rethrows the original error', async () => {
    const { client } = makeClient();
    server.enqueue({ status: 503, text: 'x' }, gqlError('Argument Validation Error'), gqlError('Entity not found: Comment'));
    await assert.rejects(client.comment('issue-1', 'x'), /Argument Validation Error/);
  });

  test('createIssue(): sends id/teamId/title/parent/labels/state/project; returns a mapped issue', async () => {
    const { client } = makeClient();
    server.enqueue(ok({ issueCreate: { success: true, issue: issueNode(9, { parent: { id: 'issue-1' } }) } }));
    const out = await client.createIssue({
      teamId: 'team-1',
      title: 'Bug: x',
      description: 'd\n\nconductor-ref: k',
      parentId: 'issue-1',
      labelIds: ['bug'],
      stateId: 'st-todo',
      projectId: 'pr-1',
    });
    assert.equal(out.identifier, 'ENG-9');
    assert.equal(out.parentId, 'issue-1');
    const input = server.requests[0]!.variables.input as Record<string, unknown>;
    assert.deepEqual(
      { ...input, id: 'ID' },
      { id: 'ID', teamId: 'team-1', title: 'Bug: x', description: 'd\n\nconductor-ref: k', parentId: 'issue-1', labelIds: ['bug'], stateId: 'st-todo', projectId: 'pr-1' },
    );
    assert.equal(typeof input.id, 'string');
  });

  test('createIssue(): omitted optional fields are not sent', async () => {
    const { client } = makeClient();
    server.enqueue(ok({ issueCreate: { success: true, issue: issueNode(10) } }));
    await client.createIssue({ teamId: 'team-1', title: 'T' });
    const input = server.requests[0]!.variables.input as Record<string, unknown>;
    assert.deepEqual(Object.keys(input).sort(), ['id', 'teamId', 'title']);
  });

  test('createIssue(): network drop then error => looked up by id and adopted (no duplicate sub-issue)', async () => {
    const { client } = makeClient({ maxRetries: 1 });
    server.enqueue({ destroySocket: true }, gqlError('Duplicate id'), ok({ issue: issueNode(11) }));
    const out = await client.createIssue({ teamId: 'team-1', title: 'Bug' });
    assert.equal(out.identifier, 'ENG-11');
  });

  test('createLabel() / createState() send colour, type, team and a client id; map the result', async () => {
    const { client } = makeClient();
    server.enqueue(
      ok({ issueLabelCreate: { success: true, issueLabel: { id: 'l9', name: 'conductor', team: { id: 'team-1' } } } }),
      ok({ workflowStateCreate: { success: true, workflowState: { id: 's9', name: 'Planning', type: 'started' } } }),
    );
    assert.deepEqual(await client.createLabel('team-1', { name: 'conductor', color: '#5e6ad2' }), { id: 'l9', name: 'conductor', teamId: 'team-1' });
    assert.deepEqual(await client.createState('team-1', { name: 'Planning', type: 'started', color: '#8b5cf6' }), { id: 's9', name: 'Planning', type: 'started' });
    const l = server.requests[0]!.variables.input as Record<string, unknown>;
    assert.equal(l.name, 'conductor');
    assert.equal(l.color, '#5e6ad2');
    assert.equal(l.teamId, 'team-1');
    const s = server.requests[1]!.variables.input as Record<string, unknown>;
    assert.equal(s.type, 'started');
    assert.equal(s.teamId, 'team-1');
    assert.equal(s.color, '#8b5cf6');
  });

  test('createLabel(): a permission error is surfaced verbatim (provisioning turns it into a manual item)', async () => {
    const { client } = makeClient();
    server.enqueue(gqlError('Forbidden', { code: 'FORBIDDEN', userPresentableMessage: 'You need to be an admin to create labels.' }));
    await assert.rejects(client.createLabel('team-1', { name: 'x', color: '#fff' }), (e: unknown) => {
      assert.ok(e instanceof LinearApiError);
      assert.equal(e.forbidden, true);
      assert.match(e.message, /^Forbidden/);
      return true;
    });
  });
});

describe('validateKey', () => {
  test('returns viewer and teams for a good key', async () => {
    server.enqueue(ok({ viewer: { id: 'u1', name: 'Me', email: 'm@x.test' } }), ok({ teams: page([{ id: 't1', key: 'ENG', name: 'Eng' }]) }));
    const r = await validateKey(KEY, { endpoint: server.url, sleepFn: async () => undefined });
    assert.deepEqual(r, { viewer: { id: 'u1', name: 'Me', email: 'm@x.test' }, teams: [{ id: 't1', key: 'ENG', name: 'Eng' }] });
    assert.equal(server.requests[0]!.headers.authorization, KEY);
  });

  test('a bad key surfaces Linear\'s authentication error verbatim and never the key', async () => {
    server.enqueue(gqlError('Authentication required, not authenticated', { code: 'AUTHENTICATION_ERROR', type: 'authentication error' }, 401));
    await assert.rejects(validateKey(KEY, { endpoint: server.url, sleepFn: async () => undefined }), (e: unknown) => {
      assert.ok(e instanceof LinearApiError);
      assert.equal(e.message, 'Authentication required, not authenticated');
      assert.equal(e.status, 401);
      assert.equal(e.forbidden, true);
      assert.ok(!inspect(e).includes(KEY));
      return true;
    });
  });
});

// type-level guard: responses used above conform to the helper types
const _unused: MockResponse | undefined = undefined;
void _unused;
