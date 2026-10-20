/**
 * FakeLinear <-> LinearClient parity suite.
 *
 * ONE set of behavioural assertions runs against both implementations of `LinearPort`:
 *   - FakeLinear used directly;
 *   - LinearClient talking HTTP to a local GraphQL stub whose resolvers are backed by a FakeLinear and which
 *     executes the real documents against the official Linear schema (the issue filter is evaluated from the wire,
 *     independently of FakeLinear.candidates).
 * A final test replays one identical script on both and requires byte-identical (id-normalised) observable state.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { LinearIssue, LinearPort } from '../../src/types.ts';
import { LinearApiError, LinearClient, isNotFoundError } from '../../src/linear/client.ts';
import { FakeLinear } from '../../src/linear/fake.ts';
import { attributeDescription, attributeTrigger, hasApproveCommand, viewerComments, withMarker } from '../../src/linear/attribution.ts';
import { MockLinearServer, fakeBackedResponder } from '../helpers/mock-linear-server.ts';

const KEY = 'lin_api_PARITYKEYPARITYKEYPARITYKEY0123';
const ME = 'user-viewer';
const OTHER = 'user-other';

interface Harness {
  name: string;
  port: LinearPort;
  fake: FakeLinear;
  server?: MockLinearServer;
  close(): Promise<void>;
}

async function fakeHarness(): Promise<Harness> {
  const fake = new FakeLinear();
  return { name: 'FakeLinear', port: fake, fake, close: async () => undefined };
}

async function clientHarness(order: 'asc' | 'desc'): Promise<Harness> {
  const fake = new FakeLinear();
  const server = await MockLinearServer.start(); // validates every document + variables against the official SDL
  server.respondWith(fakeBackedResponder(fake, { order }));
  const port = new LinearClient({ apiKey: KEY, endpoint: server.url, maxRetries: 0, sleepFn: async () => undefined });
  return {
    name: `LinearClient over FakeLinear-backed GraphQL (connections ${order})`,
    port,
    fake,
    server,
    close: async () => {
      assert.deepEqual(server.schemaErrors, [], 'client sent something the official schema rejects');
      await server.close();
    },
  };
}

const factories: [string, () => Promise<Harness>][] = [
  ['fake', fakeHarness],
  ['client/desc', () => clientHarness('desc')],
  ['client/asc', () => clientHarness('asc')],
];

async function withHarness(make: () => Promise<Harness>, fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await make();
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

const ids = (list: { id: string }[]): string[] => list.map((i) => i.id).sort();

for (const [label, make] of factories) {
  describe(`LinearPort parity: ${label}`, () => {
    const t = (name: string, fn: (h: Harness) => Promise<void>) => test(name, () => withHarness(make, fn));

    t('viewer and teams', async ({ port, fake }) => {
      assert.deepEqual(await port.viewer(), { id: ME, name: 'Viewer', email: 'viewer@example.test' });
      assert.deepEqual(await port.teams(), [{ id: fake.teamId, key: 'TT', name: 'Team TT' }]);
    });

    t('teamSetup: states, team + workspace labels (workspace teamId null), default state', async ({ port, fake }) => {
      const ws = fake.seedLabel('workspace-label', { workspace: true });
      const tl = fake.seedLabel('team-label');
      fake.setDefaultState('Backlog');
      const s = await port.teamSetup(fake.teamId);
      assert.deepEqual(
        s.states.map((x) => [x.name, x.type]),
        [
          ['Backlog', 'backlog'],
          ['Todo', 'unstarted'],
          ['In Progress', 'started'],
          ['In Review', 'started'],
          ['Done', 'completed'],
          ['Canceled', 'canceled'],
        ],
      );
      assert.deepEqual(
        s.labels.sort((a, b) => a.name.localeCompare(b.name)),
        [
          { id: tl.id, name: 'team-label', teamId: fake.teamId },
          { id: ws.id, name: 'workspace-label', teamId: null },
        ],
      );
      assert.equal(s.defaultIssueStateId, fake.requireState('Backlog').id);
      await assert.rejects(port.teamSetup('nope'), (e: unknown) => isNotFoundError(e));
    });

    t('candidates: trigger label, open states, viewer-created only; includeAssigned adds viewer-assigned', async ({ port, fake }) => {
      const mine = fake.seedIssue({ title: 'mine', labels: ['conductor'] });
      fake.seedIssue({ title: 'no label' });
      fake.seedIssue({ title: 'done', labels: ['conductor'], stateName: 'Done' });
      fake.seedIssue({ title: 'canceled', labels: ['conductor'], stateName: 'Canceled' });
      fake.seedIssue({ title: 'foreign', labels: ['conductor'], creatorId: OTHER });
      const assigned = fake.seedIssue({ title: 'foreign assigned', labels: ['conductor'], creatorId: OTHER, assigneeId: ME });
      fake.seedIssue({ title: 'foreign assigned elsewhere', labels: ['conductor'], creatorId: OTHER, assigneeId: OTHER });
      const backlog = fake.seedIssue({ title: 'in backlog', labels: ['Conductor'], stateName: 'Backlog' });
      const started = fake.seedIssue({ title: 'running', labels: ['conductor', 'conductor:building'], stateName: 'In Progress' });
      fake.seedIssue({ title: 'other label', labels: ['conductor-bug'] });

      const plain = await port.candidates(fake.teamId, 'conductor');
      assert.deepEqual(ids(plain), ids([mine, backlog, started]));
      const withAssigned = await port.candidates(fake.teamId, 'conductor', { includeAssigned: true });
      assert.deepEqual(ids(withAssigned), ids([mine, backlog, started, assigned]));
      assert.deepEqual(await port.candidates('another-team', 'conductor'), []);
      assert.deepEqual(await port.candidates(fake.teamId, 'no-such-label'), []);
      // candidates never carry comments/history
      assert.ok(plain.every((i) => i.comments === undefined && i.history === undefined));
    });

    t('candidates: all identity fields are populated', async ({ port, fake }) => {
      const parent = fake.seedIssue({ title: 'parent' });
      fake.seedProject('Roadmap');
      fake.seedIssue({
        title: 'child',
        description: 'body',
        labels: ['conductor', 'extra'],
        assigneeId: OTHER,
        parentId: parent.id,
        projectName: 'Roadmap',
        stateName: 'In Progress',
        priority: 2,
      });
      const [got] = await port.candidates(fake.teamId, 'conductor');
      assert.ok(got);
      assert.equal(got.title, 'child');
      assert.equal(got.description, 'body');
      assert.equal(got.identifier, 'TT-2');
      assert.equal(got.url, 'https://linear.app/fake/issue/TT-2');
      assert.equal(got.priority, 2);
      assert.equal(got.creatorId, ME);
      assert.equal(got.assigneeId, OTHER);
      assert.equal(got.parentId, parent.id);
      assert.equal(got.projectName, 'Roadmap');
      assert.equal(got.teamId, fake.teamId);
      assert.deepEqual(got.state, { id: fake.requireState('In Progress').id, name: 'In Progress', type: 'started' });
      assert.deepEqual(
        got.labels.map((l) => [l.name, l.teamId]).sort(),
        [
          ['conductor', fake.teamId],
          ['extra', fake.teamId],
        ],
      );
      assert.ok(Date.parse(got.createdAt) > 0 && Date.parse(got.updatedAt) > 0);
    });

    t('candidates: a workspace-level trigger label is matched and reported with teamId null', async ({ port, fake }) => {
      fake.seedLabel('conductor', { workspace: true });
      const i = fake.seedIssue({ title: 'ws', labels: ['conductor'] });
      const [got] = await port.candidates(fake.teamId, 'conductor');
      assert.equal(got!.id, i.id);
      assert.deepEqual(got!.labels, [{ id: fake.requireLabel('conductor').id, name: 'conductor', teamId: null }]);
    });

    t('candidates: more than one page (120 issues) are all returned', async ({ port, fake }) => {
      const all: LinearIssue[] = [];
      for (let n = 0; n < 120; n++) all.push(fake.seedIssue({ title: `i${n}`, labels: ['conductor'] }));
      const got = await port.candidates(fake.teamId, 'conductor');
      assert.equal(got.length, 120);
      assert.deepEqual(ids(got), ids(all));
    });

    t('a deleted issue leaves candidates and issue() reports not-found', async ({ port, fake }) => {
      const i = fake.seedIssue({ title: 'x', labels: ['conductor'] });
      assert.equal((await port.candidates(fake.teamId, 'conductor')).length, 1);
      fake.humanDelete(i.id);
      assert.equal((await port.candidates(fake.teamId, 'conductor')).length, 0);
      await assert.rejects(port.issue(i.id), (e: unknown) => isNotFoundError(e));
      await assert.rejects(port.comment(i.id, 'x'), (e: unknown) => isNotFoundError(e));
      await assert.rejects(port.children(i.id), (e: unknown) => isNotFoundError(e));
    });

    t('issue(): by id or identifier, with comments and history arrays', async ({ port, fake }) => {
      const i = fake.seedIssue({ title: 'x', description: 'd' });
      const byId = await port.issue(i.id);
      const byKey = await port.issue(i.identifier);
      assert.deepEqual(byId, byKey);
      assert.deepEqual(byId.comments, []);
      assert.deepEqual(byId.history, []);
      assert.equal(byId.description, 'd');
    });

    t('update: add/remove label ids never clobber other labels; state and description change; idempotent re-add', async ({ port, fake }) => {
      const i = fake.seedIssue({ title: 'x', labels: ['human-label', 'conductor'] });
      const planning = fake.seedLabel('conductor:planning');
      const building = fake.seedLabel('conductor:building');
      const prog = fake.requireState('In Progress');
      await port.update(i.id, { addLabelIds: [planning.id], stateId: prog.id });
      let now = await port.issue(i.id);
      assert.deepEqual(now.labels.map((l) => l.name).sort(), ['conductor', 'conductor:planning', 'human-label']);
      assert.equal(now.state.id, prog.id);

      await port.update(i.id, { addLabelIds: [building.id], removeLabelIds: [planning.id] });
      now = await port.issue(i.id);
      assert.deepEqual(now.labels.map((l) => l.name).sort(), ['conductor', 'conductor:building', 'human-label']);

      await port.update(i.id, { addLabelIds: [building.id] }); // already there
      now = await port.issue(i.id);
      assert.equal(now.labels.filter((l) => l.id === building.id).length, 1);

      await port.update(i.id, { description: 'rewritten\n\nconductor-ref: k' });
      assert.equal((await port.issue(i.id)).description, 'rewritten\n\nconductor-ref: k');

      await port.update(i.id, {}); // no-op
      await assert.rejects(port.update('missing', { stateId: prog.id }), (e: unknown) => isNotFoundError(e));
      await assert.rejects(port.update(i.id, { stateId: 'no-such-state' }), (e: unknown) => e instanceof LinearApiError);
    });

    t('comment: appended as the viewer, oldest first, body preserved verbatim', async ({ port, fake }) => {
      const i = fake.seedIssue({ title: 'x' });
      const body = withMarker('## Plan\n\n- [ ] one\n- "quoted" ünïcode ✓\n\n```ts\nconst a = 1;\n```', 'run1:plan:1:comment');
      const c1 = await port.comment(i.id, body);
      fake.humanComment(i.id, '/approve');
      fake.humanComment(i.id, 'teammate noise', OTHER);
      const c2 = await port.comment(i.id, 'second');
      const issue = await port.issue(i.id);
      assert.deepEqual(
        issue.comments!.map((c) => [c.userId, c.body]),
        [
          [ME, body],
          [ME, '/approve'],
          [OTHER, 'teammate noise'],
          [ME, 'second'],
        ],
      );
      assert.equal(issue.comments![0]!.id, c1.id);
      assert.equal(issue.comments![3]!.id, c2.id);
      // marker comments are Conductor's; /approve from the viewer is detected; teammate's is not
      assert.deepEqual(
        viewerComments(issue, ME).map((c) => c.body),
        ['/approve', 'second'],
      );
      assert.equal(hasApproveCommand(issue.comments!, ME), true);
      assert.equal(hasApproveCommand(issue.comments!.filter((c) => c.userId === OTHER), ME), false);
    });

    t('comment: more than one page (130 comments) are all returned', async ({ port, fake }) => {
      const i = fake.seedIssue({ title: 'x' });
      for (let n = 0; n < 130; n++) fake.humanComment(i.id, `c${n}`);
      const issue = await port.issue(i.id);
      assert.equal(issue.comments!.length, 130);
      assert.deepEqual(
        issue.comments!.map((c) => c.body),
        Array.from({ length: 130 }, (_, n) => `c${n}`),
      );
    });

    t('createIssue + children: parent link, labels, explicit state, project, description marker; created by the viewer', async ({ port, fake }) => {
      const parent = fake.seedIssue({ title: 'parent', labels: ['conductor'] });
      const bug = fake.seedLabel('conductor-bug');
      fake.seedProject('Roadmap');
      const project = fake.snapshot().projects[0]!;
      const todo = fake.requireState('Todo');
      const created = await port.createIssue({
        teamId: fake.teamId,
        title: 'Bug: x',
        description: withMarker('details', 'run1:verify:1:bug:abc'),
        parentId: parent.id,
        labelIds: [bug.id],
        stateId: todo.id,
        projectId: project.id,
      });
      assert.equal(created.title, 'Bug: x');
      assert.equal(created.parentId, parent.id);
      assert.equal(created.creatorId, ME);
      assert.equal(created.projectName, 'Roadmap');
      assert.deepEqual(created.state, todo);
      assert.deepEqual(created.labels.map((l) => l.name), ['conductor-bug']);
      assert.ok(created.identifier.startsWith('TT-'));

      const kids = await port.children(parent.id);
      assert.deepEqual(ids(kids), [created.id]);
      assert.equal(kids[0]!.description, 'details\n\nconductor-ref: run1:verify:1:bug:abc');
      assert.equal(kids[0]!.parentId, parent.id);
      assert.deepEqual(await port.children(created.id), []);

      // a sub-issue that does not carry the trigger label is never a candidate
      assert.deepEqual(ids(await port.candidates(fake.teamId, 'conductor')), [parent.id]);

      // default state when none is given follows the team default; no parent/labels/project
      fake.setDefaultState('Backlog');
      const plain = await port.createIssue({ teamId: fake.teamId, title: 'plain' });
      assert.equal(plain.state.name, 'Backlog');
      assert.equal(plain.parentId, null);
      assert.equal(plain.projectName, null);
      assert.deepEqual(plain.labels, []);
      assert.equal(plain.description, '');
      await assert.rejects(port.createIssue({ teamId: fake.teamId, title: 'x', parentId: 'missing' }), (e: unknown) => e instanceof LinearApiError);
    });

    t('children: more than one page (60 sub-issues)', async ({ port, fake }) => {
      const p = fake.seedIssue({ title: 'p' });
      const kids: LinearIssue[] = [];
      for (let n = 0; n < 60; n++) kids.push(fake.seedIssue({ title: `k${n}`, parentId: p.id }));
      assert.deepEqual(ids(await port.children(p.id)), ids(kids));
    });

    t('history semantics: creation writes none; later edits are attributed; oldest first (C1)', async ({ port, fake }) => {
      const label = fake.seedLabel('conductor');
      const i = fake.seedIssue({ title: 'x', description: 'orig', labels: ['conductor'] });
      assert.deepEqual((await port.issue(i.id)).history, [], 'created with the label and a description: no history entry');

      fake.humanEditDescription(i.id, 'orig + teammate text', OTHER);
      fake.humanMove(i.id, 'In Progress', OTHER);
      fake.humanRemoveLabel(i.id, 'conductor', OTHER);
      fake.humanAddLabel(i.id, 'conductor', OTHER);
      await port.update(i.id, { stateId: fake.requireState('Todo').id, description: 'viewer rewrite' });

      const h = (await port.issue(i.id)).history!;
      assert.equal(h.length, 5);
      assert.ok(h.every((e, k) => k === 0 || Date.parse(e.createdAt) > Date.parse(h[k - 1]!.createdAt)), 'oldest first');
      assert.deepEqual(h[0]!.descriptionUpdatedBy, [OTHER]);
      assert.equal(h[0]!.actorId, OTHER);
      assert.deepEqual([h[1]!.fromStateId, h[1]!.toStateId], [fake.requireState('Todo').id, fake.requireState('In Progress').id]);
      assert.deepEqual([h[2]!.actorId, h[2]!.removedLabelIds], [OTHER, [label.id]]);
      assert.deepEqual([h[3]!.actorId, h[3]!.addedLabelIds], [OTHER, [label.id]]);
      assert.equal(h[4]!.actorId, ME, 'port writes are attributed to the viewer');
      assert.deepEqual(h[4]!.descriptionUpdatedBy, [ME]);
      assert.deepEqual([h[4]!.fromStateId, h[4]!.toStateId], [fake.requireState('In Progress').id, fake.requireState('Todo').id]);
      assert.deepEqual(h[0]!.addedLabelIds, []);
    });

    t('history: more than one page (130 entries) are all returned, oldest first', async ({ port, fake }) => {
      const i = fake.seedIssue({ title: 'x' });
      for (let n = 0; n < 65; n++) {
        fake.humanAddLabel(i.id, 'noisy', OTHER);
        fake.humanRemoveLabel(i.id, 'noisy', OTHER);
      }
      fake.humanAddLabel(i.id, 'conductor', ME);
      const h = (await port.issue(i.id)).history!;
      assert.equal(h.length, 131);
      assert.deepEqual(
        h.map((e) => e.id),
        [...h].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map((e) => e.id),
      );
      assert.equal(h.at(-1)!.actorId, ME);
    });

    t('attribution on top of the port (C1): empty history accepted, teammate-added rejected, edits rejected', async ({ port, fake }) => {
      const trigger = fake.seedLabel('conductor');
      const own = fake.seedIssue({ title: 'own', labels: ['conductor'], description: 'mine' });
      const mate = fake.seedIssue({ title: 'mate-label' });
      fake.humanAddLabel(mate.id, 'conductor', OTHER);
      const edited = fake.seedIssue({ title: 'edited', labels: ['conductor'], description: 'mine' });
      fake.humanEditDescription(edited.id, 'mine, plus injected instructions', OTHER);

      const a = await port.issue(own.id);
      assert.deepEqual(attributeTrigger(a, trigger.id, ME), { ok: true });
      assert.deepEqual(attributeDescription(a, ME), { ok: true });
      const b = await port.issue(mate.id);
      assert.equal(attributeTrigger(b, trigger.id, ME).ok, false);
      const c = await port.issue(edited.id);
      assert.equal(attributeTrigger(c, trigger.id, ME).ok, true);
      const d = attributeDescription(c, ME);
      assert.equal(d.ok, false);
      assert.match(d.reason!, /user-other/);
    });

    t('createLabel / createState: created entities are visible in teamSetup; duplicates and denied permissions are errors', async ({ port, fake }) => {
      const l = await port.createLabel(fake.teamId, { name: 'conductor', color: '#5e6ad2' });
      assert.deepEqual({ name: l.name, teamId: l.teamId }, { name: 'conductor', teamId: fake.teamId });
      const s = await port.createState(fake.teamId, { name: 'Planning', type: 'started', color: '#8b5cf6' });
      assert.deepEqual({ name: s.name, type: s.type }, { name: 'Planning', type: 'started' });
      const setup = await port.teamSetup(fake.teamId);
      assert.ok(setup.labels.some((x) => x.id === l.id));
      assert.ok(setup.states.some((x) => x.id === s.id));
      await assert.rejects(port.createLabel(fake.teamId, { name: 'Conductor', color: '#000000' }), (e: unknown) => e instanceof LinearApiError);

      fake.denyCreate('label');
      fake.denyCreate('state');
      await assert.rejects(port.createLabel(fake.teamId, { name: 'x', color: '#000000' }), (e: unknown) => e instanceof LinearApiError && e.forbidden);
      await assert.rejects(port.createState(fake.teamId, { name: 'X', type: 'started', color: '#000000' }), (e: unknown) => e instanceof LinearApiError && e.forbidden);
    });
  });
}

describe('LinearPort parity: identical script, identical observable state', () => {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, canon(x)]),
      );
    }
    return v;
  };

  /**
   * Entity ids differ by construction (the client mints UUIDs for creates, the fake counts). Replace every id by a
   * placeholder numbered in order of first appearance (keys are canonically ordered, so both runs number alike).
   */
  function normalise(value: unknown): unknown {
    const map = new Map<string, string>();
    const idRe = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\b(?:label|state|issue|comment|hist|project)-\d+\b/g;
    const text = JSON.stringify(canon(value)).replace(idRe, (m) => {
      if (!map.has(m)) map.set(m, `<id-${map.size + 1}>`);
      return map.get(m)!;
    });
    return JSON.parse(text);
  }

  async function script(h: Harness): Promise<unknown> {
    const { port, fake } = h;
    const planning = await port.createLabel(fake.teamId, { name: 'conductor:planning', color: '#8b5cf6' });
    fake.seedLabel('conductor');
    const a = fake.seedIssue({ title: 'A', description: 'alpha', labels: ['conductor'] });
    const b = fake.seedIssue({ title: 'B', labels: ['conductor', 'x'], stateName: 'In Progress', assigneeId: OTHER });
    fake.seedIssue({ title: 'C', labels: ['conductor'], creatorId: OTHER });
    await port.update(a.id, { addLabelIds: [planning.id], stateId: fake.requireState('In Progress').id });
    await port.comment(a.id, withMarker('plan', 'r:plan:1:comment'));
    fake.humanComment(a.id, '/approve');
    fake.humanAddLabel(a.id, 'extra', OTHER);
    fake.humanEditDescription(b.id, 'beta edited', OTHER);
    const kid = await port.createIssue({ teamId: fake.teamId, title: 'Bug', parentId: a.id, labelIds: [fake.requireLabel('conductor').id], description: withMarker('d', 'r:v:1:bug') });
    await port.update(kid.id, { removeLabelIds: [fake.requireLabel('conductor').id], stateId: fake.requireState('Done').id });
    fake.humanMove(b.id, 'Done');
    const sorted = <T extends { identifier: string }>(l: T[]): T[] => [...l].sort((x, y) => x.identifier.localeCompare(y.identifier));
    return normalise({
      setup: await port.teamSetup(fake.teamId),
      candidates: sorted(await port.candidates(fake.teamId, 'conductor')),
      candidatesAssigned: sorted(await port.candidates(fake.teamId, 'conductor', { includeAssigned: true })),
      a: await port.issue(a.id),
      b: await port.issue(b.id),
      kid: await port.issue(kid.id),
      children: sorted(await port.children(a.id)),
    });
  }

  test('FakeLinear and LinearClient (desc and asc connection order) agree on every observable', async () => {
    const results: unknown[] = [];
    for (const [, make] of factories) {
      await withHarness(make, async (h) => {
        results.push(await script(h));
      });
    }
    assert.deepEqual(results[1], results[0], 'client(desc) != fake');
    assert.deepEqual(results[2], results[0], 'client(asc) != fake');
  });
});
