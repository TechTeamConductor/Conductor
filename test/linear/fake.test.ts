/** FakeLinear: the in-memory Linear used by the engine tests and `conductor demo`. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock, FakeLinear } from '../../src/linear/fake.ts';
import { LinearApiError, isNotFoundError } from '../../src/linear/client.ts';

const ME = 'user-viewer';
const OTHER = 'user-other';

describe('FakeLinear basics', () => {
  test('viewer, teams, default workflow and deterministic ids', async () => {
    const fake = new FakeLinear({ key: 'ENG' });
    assert.deepEqual(await fake.viewer(), { id: ME, name: 'Viewer', email: 'viewer@example.test' });
    assert.deepEqual(await fake.teams(), [{ id: 'team-1', key: 'ENG', name: 'Team ENG' }]);
    assert.deepEqual(
      fake.allStates().map((s) => [s.name, s.type]),
      [
        ['Backlog', 'backlog'],
        ['Todo', 'unstarted'],
        ['In Progress', 'started'],
        ['In Review', 'started'],
        ['Done', 'completed'],
        ['Canceled', 'canceled'],
      ],
    );
    const a = fake.seedIssue({ title: 'a' });
    const b = fake.seedIssue({ title: 'b' });
    assert.deepEqual([a.identifier, b.identifier], ['ENG-1', 'ENG-2']);
    assert.deepEqual([a.id, b.id], ['issue-1', 'issue-2']);
    assert.equal(a.state.name, 'Todo', 'default state is Todo');
    assert.equal(a.creatorId, ME);
    assert.equal(fake.issueByKey('eng-2').title, 'b', 'lookup by key is case-insensitive');
    assert.equal(fake.issueByKey('issue-1').identifier, 'ENG-1', 'and by id');
  });

  test('every returned object is a copy', async () => {
    const fake = new FakeLinear();
    const seeded = fake.seedIssue({ title: 'a', labels: ['conductor'] });
    const got = await fake.issue(seeded.id);
    got.title = 'MUTATED';
    got.labels.length = 0;
    got.history!.push({ id: 'x', createdAt: '', actorId: null, addedLabelIds: [], removedLabelIds: [], descriptionUpdatedBy: [] });
    const again = await fake.issue(seeded.id);
    assert.equal(again.title, 'a');
    assert.equal(again.labels.length, 1);
    assert.equal(again.history!.length, 0);
  });

  test('timestamps come from the injectable clock and are strictly increasing', async () => {
    const clock = new FakeClock(Date.UTC(2030, 0, 1), 10);
    const fake = new FakeLinear({ clock });
    const i = fake.seedIssue({ title: 'x' });
    assert.equal(i.createdAt, '2030-01-01T00:00:00.000Z');
    await fake.comment(i.id, 'one');
    await fake.comment(i.id, 'two');
    const issue = await fake.issue(i.id);
    assert.deepEqual(
      issue.comments!.map((c) => c.createdAt),
      ['2030-01-01T00:00:00.010Z', '2030-01-01T00:00:00.020Z'],
    );
    clock.set(Date.UTC(2031, 5, 1));
    fake.humanComment(i.id, 'later');
    assert.equal((await fake.issue(i.id)).comments!.at(-1)!.createdAt, '2031-06-01T00:00:00.000Z');
  });
});

describe('FakeLinear history is generated like Linear', () => {
  test('creation with labels and a description writes NO history (C1)', async () => {
    const fake = new FakeLinear();
    const i = fake.seedIssue({ title: 'x', description: 'initial text', labels: ['conductor', 'other'] });
    const issue = await fake.issue(i.id);
    assert.deepEqual(issue.history, []);
    assert.equal(issue.description, 'initial text');
    // and through the port as well
    const created = await fake.createIssue({ teamId: fake.teamId, title: 'via port', labelIds: [fake.requireLabel('conductor').id], description: 'd' });
    assert.deepEqual((await fake.issue(created.id)).history, []);
  });

  test('label add/remove, description edit and state changes each produce attributed entries', async () => {
    const fake = new FakeLinear();
    const i = fake.seedIssue({ title: 'x', description: 'orig' });
    fake.humanAddLabel(i.id, 'conductor', OTHER);
    fake.humanEditDescription(i.id, 'edited', OTHER);
    fake.humanMove(i.id, 'In Progress', OTHER);
    fake.humanRemoveLabel(i.id, 'conductor', ME);
    const h = (await fake.issue(i.id)).history!;
    assert.equal(h.length, 4);
    const label = fake.requireLabel('conductor').id;
    assert.deepEqual([h[0]!.actorId, h[0]!.addedLabelIds], [OTHER, [label]]);
    assert.deepEqual([h[1]!.actorId, h[1]!.descriptionUpdatedBy], [OTHER, [OTHER]]);
    assert.deepEqual([h[2]!.fromStateId, h[2]!.toStateId], [fake.requireState('Todo').id, fake.requireState('In Progress').id]);
    assert.deepEqual([h[3]!.actorId, h[3]!.removedLabelIds], [ME, [label]]);
    assert.ok(h.every((e, k) => k === 0 || Date.parse(e.createdAt) > Date.parse(h[k - 1]!.createdAt)));
  });

  test('port writes are attributed to the viewer; one entry per update; no-op updates write nothing', async () => {
    const fake = new FakeLinear();
    const i = fake.seedIssue({ title: 'x' });
    const lab = fake.seedLabel('conductor:building');
    const prog = fake.requireState('In Progress');
    await fake.update(i.id, { stateId: prog.id, addLabelIds: [lab.id], description: 'new' });
    await fake.update(i.id, { stateId: prog.id, addLabelIds: [lab.id], description: 'new' }); // identical => no change
    await fake.update(i.id, {});
    const h = (await fake.issue(i.id)).history!;
    assert.equal(h.length, 1);
    assert.deepEqual(
      { actorId: h[0]!.actorId, added: h[0]!.addedLabelIds, to: h[0]!.toStateId, by: h[0]!.descriptionUpdatedBy },
      { actorId: ME, added: [lab.id], to: prog.id, by: [ME] },
    );
    await fake.update(i.id, { removeLabelIds: [lab.id] });
    const after = await fake.issue(i.id);
    assert.deepEqual(after.labels, []);
    assert.deepEqual(after.history!.at(-1)!.removedLabelIds, [lab.id]);
  });

  test('update never clobbers other labels; unknown label/state ids are not-found errors', async () => {
    const fake = new FakeLinear();
    const i = fake.seedIssue({ title: 'x', labels: ['human-label'] });
    const stage = fake.seedLabel('conductor:planning');
    await fake.update(i.id, { addLabelIds: [stage.id] });
    assert.deepEqual(
      (await fake.issue(i.id)).labels.map((l) => l.name).sort(),
      ['conductor:planning', 'human-label'],
    );
    await assert.rejects(fake.update(i.id, { addLabelIds: ['nope'] }), (e: unknown) => isNotFoundError(e));
    await assert.rejects(fake.update(i.id, { stateId: 'nope' }), (e: unknown) => isNotFoundError(e));
  });
});

describe('FakeLinear.candidates', () => {
  test('open + trigger label + viewer-created; excludes completed/canceled and foreign creators', async () => {
    const fake = new FakeLinear();
    const mine = fake.seedIssue({ title: 'mine', labels: ['conductor'] });
    fake.seedIssue({ title: 'no label' });
    fake.seedIssue({ title: 'done', labels: ['conductor'], stateName: 'Done' });
    fake.seedIssue({ title: 'canceled', labels: ['conductor'], stateName: 'Canceled' });
    fake.seedIssue({ title: 'foreign', labels: ['conductor'], creatorId: OTHER });
    fake.seedIssue({ title: 'foreign assigned', labels: ['conductor'], creatorId: OTHER, assigneeId: ME });
    const backlog = fake.seedIssue({ title: 'backlog', labels: ['Conductor'], stateName: 'Backlog' });
    const got = await fake.candidates(fake.teamId, 'conductor');
    assert.deepEqual(got.map((i) => i.id).sort(), [mine.id, backlog.id].sort());
    assert.equal(got.find((i) => i.id === backlog.id)!.state.type, 'backlog', 'backlog is returned (the engine parks it)');
    assert.equal(got[0]!.comments, undefined);
    assert.equal(got[0]!.history, undefined);
  });

  test('includeAssigned adds issues assigned to the viewer; other teams excluded', async () => {
    const fake = new FakeLinear();
    const mine = fake.seedIssue({ title: 'mine', labels: ['conductor'] });
    const asg = fake.seedIssue({ title: 'assigned', labels: ['conductor'], creatorId: OTHER, assigneeId: ME });
    fake.seedIssue({ title: 'assigned to other', labels: ['conductor'], creatorId: OTHER, assigneeId: OTHER });
    const got = await fake.candidates(fake.teamId, 'conductor', { includeAssigned: true });
    assert.deepEqual(got.map((i) => i.id).sort(), [mine.id, asg.id].sort());
    assert.deepEqual(await fake.candidates('other-team', 'conductor'), []);
  });

  test('serverSideCreatorFilter=false returns foreign issues so the engine\'s client-side re-check can be tested', async () => {
    const fake = new FakeLinear({ serverSideCreatorFilter: false });
    const foreign = fake.seedIssue({ title: 'foreign', labels: ['conductor'], creatorId: OTHER });
    const got = await fake.candidates(fake.teamId, 'conductor');
    assert.deepEqual(got.map((i) => i.id), [foreign.id]);
    assert.equal(got[0]!.creatorId, OTHER);
  });

  test('parentId/assigneeId/projectName/labels are populated', async () => {
    const fake = new FakeLinear();
    const parent = fake.seedIssue({ title: 'p', labels: ['conductor'] });
    const project = fake.seedProject('Roadmap');
    const kid = await fake.createIssue({ teamId: fake.teamId, title: 'kid', parentId: parent.id, labelIds: [fake.requireLabel('conductor').id], projectId: project.id });
    const got = (await fake.candidates(fake.teamId, 'conductor')).find((i) => i.id === kid.id)!;
    assert.equal(got.parentId, parent.id);
    assert.equal(got.projectName, 'Roadmap');
    assert.equal(got.creatorId, ME);
    assert.equal(got.teamId, fake.teamId);
    assert.deepEqual(got.labels.map((l) => l.name), ['conductor']);
  });
});

describe('FakeLinear human simulation', () => {
  test('humanMove accepts a state name or a state type', async () => {
    const fake = new FakeLinear();
    const i = fake.seedIssue({ title: 'x' });
    fake.humanMove(i.id, 'started');
    assert.equal(fake.issueByKey(i.id).state.name, 'In Progress');
    fake.humanMove(i.id, 'In Review');
    assert.equal(fake.issueByKey(i.id).state.name, 'In Review');
    fake.humanMove(i.id, 'completed');
    assert.equal(fake.issueByKey(i.id).state.type, 'completed');
    assert.throws(() => fake.humanMove(i.id, 'Nope'), /no state named or typed/);
    assert.equal((await fake.candidates(fake.teamId, 'conductor')).length, 0);
  });

  test('humanComment defaults to the viewer; teammate comments carry their user id', async () => {
    const fake = new FakeLinear();
    const i = fake.seedIssue({ title: 'x' });
    fake.humanComment(i.id, '/approve');
    fake.humanComment(i.id, 'noise', OTHER);
    const c = (await fake.issue(i.id)).comments!;
    assert.deepEqual(c.map((x) => [x.userId, x.body]), [[ME, '/approve'], [OTHER, 'noise']]);
  });

  test('humanDelete: the issue disappears from candidates/issue(); children lose their parent', async () => {
    const fake = new FakeLinear();
    const p = fake.seedIssue({ title: 'p', labels: ['conductor'] });
    const kid = fake.seedIssue({ title: 'kid', parentId: p.id });
    fake.humanDelete(p.id);
    assert.deepEqual(await fake.candidates(fake.teamId, 'conductor'), []);
    await assert.rejects(fake.issue(p.id), (e: unknown) => e instanceof LinearApiError && e.notFound);
    await assert.rejects(fake.children(p.id), (e: unknown) => isNotFoundError(e));
    assert.equal(fake.issueByKey(kid.id).parentId, null);
    assert.equal(fake.findIssueByKey(p.identifier), undefined);
    assert.throws(() => fake.issueByKey(p.identifier), /Entity not found/);
  });

  test('seedIssue stateName / parentId / projectName / creatorId:null', () => {
    const fake = new FakeLinear();
    const p = fake.seedIssue({ title: 'p' });
    const c = fake.seedIssue({ title: 'c', stateName: 'In Progress', parentId: p.identifier, projectName: 'Alpha', creatorId: null });
    assert.equal(c.state.name, 'In Progress');
    assert.equal(c.parentId, p.id);
    assert.equal(c.projectName, 'Alpha');
    assert.equal(c.creatorId, null);
  });
});

describe('FakeLinear port semantics: comment / createIssue / children', () => {
  test('comment appends to the issue as the viewer; unknown issue => not found', async () => {
    const fake = new FakeLinear();
    const i = fake.seedIssue({ title: 'x' });
    const { id } = await fake.comment(i.id, 'hello');
    assert.deepEqual((await fake.issue(i.id)).comments!.map((c) => [c.id, c.userId, c.body]), [[id, ME, 'hello']]);
    await assert.rejects(fake.comment('missing', 'x'), (e: unknown) => isNotFoundError(e));
  });

  test('createIssue: parent/children, default state follows setDefaultState, explicit stateId wins, creator is the viewer', async () => {
    const fake = new FakeLinear();
    const parent = fake.seedIssue({ title: 'parent' });
    fake.setDefaultState('Backlog');
    const a = await fake.createIssue({ teamId: fake.teamId, title: 'a', parentId: parent.id });
    assert.equal(a.state.name, 'Backlog');
    const b = await fake.createIssue({ teamId: fake.teamId, title: 'b', parentId: parent.identifier, stateId: fake.requireState('Todo').id, description: 'x\n\nconductor-ref: k' });
    assert.equal(b.state.name, 'Todo');
    assert.equal(b.creatorId, ME);
    assert.equal(b.parentId, parent.id);
    const kids = await fake.children(parent.id);
    assert.deepEqual(kids.map((k) => k.id).sort(), [a.id, b.id].sort());
    assert.equal(kids.find((k) => k.id === b.id)!.description, 'x\n\nconductor-ref: k');
    await assert.rejects(fake.createIssue({ teamId: fake.teamId, title: 'x', parentId: 'nope' }), (e: unknown) => isNotFoundError(e));
    await assert.rejects(fake.createIssue({ teamId: 'other', title: 'x' }), (e: unknown) => isNotFoundError(e));
  });

  test('client-supplied ids are honoured and duplicates rejected (mirrors Linear)', async () => {
    const fake = new FakeLinear();
    const i = fake.seedIssue({ title: 'x' });
    const c = await fake.comment(i.id, 'one', { id: 'fixed-comment' });
    assert.equal(c.id, 'fixed-comment');
    await assert.rejects(fake.comment(i.id, 'again', { id: 'fixed-comment' }), /duplicate id/);
    const k = await fake.createIssue({ teamId: fake.teamId, title: 'k' }, { id: 'fixed-issue' });
    assert.equal(k.id, 'fixed-issue');
    await assert.rejects(fake.createIssue({ teamId: fake.teamId, title: 'k2' }, { id: 'fixed-issue' }), /duplicate id/);
  });

  test('createLabel / createState: duplicates and workspace clashes are rejected; denyCreate => Forbidden', async () => {
    const fake = new FakeLinear();
    fake.seedLabel('shared', { workspace: true });
    await assert.rejects(fake.createLabel(fake.teamId, { name: 'Shared', color: '#fff' }), /already exists/);
    const l = await fake.createLabel(fake.teamId, { name: 'fresh', color: '#fff' });
    assert.deepEqual(l, { id: l.id, name: 'fresh', teamId: fake.teamId });
    await assert.rejects(fake.createState(fake.teamId, { name: 'todo', type: 'started', color: '#000' }), /already exists/);
    const s = await fake.createState(fake.teamId, { name: 'Planning', type: 'started', color: '#000' });
    assert.equal(fake.stateByName('planning')!.id, s.id);
    fake.denyCreate('label');
    fake.denyCreate('state');
    await assert.rejects(fake.createLabel(fake.teamId, { name: 'zzz', color: '#fff' }), (e: unknown) => e instanceof LinearApiError && e.forbidden && /Forbidden/.test(e.message));
    await assert.rejects(fake.createState(fake.teamId, { name: 'ZZZ', type: 'started', color: '#000' }), (e: unknown) => e instanceof LinearApiError && e.forbidden);
    fake.denyCreate('label', false);
    await fake.createLabel(fake.teamId, { name: 'zzz', color: '#fff' });
  });

  test('teamSetup returns states, team + workspace labels (workspace teamId null) and the default state id', async () => {
    const fake = new FakeLinear({ defaultStateName: 'Backlog' });
    const ws = fake.seedLabel('ws', { workspace: true });
    const tl = fake.seedLabel('tl');
    const setup = await fake.teamSetup(fake.teamId);
    assert.deepEqual(setup.labels.sort((a, b) => a.name.localeCompare(b.name)), [
      { id: tl.id, name: 'tl', teamId: fake.teamId },
      { id: ws.id, name: 'ws', teamId: null },
    ]);
    assert.equal(setup.defaultIssueStateId, fake.requireState('Backlog').id);
    assert.equal(setup.states.length, 6);
    await assert.rejects(fake.teamSetup('nope'), (e: unknown) => isNotFoundError(e));
  });
});

describe('FakeLinear failure injection and call log', () => {
  test('failNext rejects the next N calls of one op, then recovers; other ops are unaffected', async () => {
    const fake = new FakeLinear();
    const i = fake.seedIssue({ title: 'x' });
    fake.failNext('comment', new Error('boom'), 2);
    await assert.rejects(fake.comment(i.id, 'a'), /boom/);
    await assert.rejects(fake.comment(i.id, 'b'), /boom/);
    assert.equal((await fake.issue(i.id)).comments!.length, 0, 'failed calls had no effect');
    await fake.comment(i.id, 'c');
    assert.equal((await fake.issue(i.id)).comments!.length, 1);
  });

  test('failNext {after:true} applies the effect and THEN fails (lost response)', async () => {
    const fake = new FakeLinear();
    const i = fake.seedIssue({ title: 'x' });
    fake.failNext('comment', new Error('timeout after write'), 1, { after: true });
    await assert.rejects(fake.comment(i.id, 'a'), /timeout after write/);
    assert.deepEqual((await fake.issue(i.id)).comments!.map((c) => c.body), ['a']);
  });

  test('failNext validates the op name', () => {
    const fake = new FakeLinear();
    assert.throws(() => fake.failNext('commnet', new Error('x')), /unknown op/);
  });

  test('calls logs every port call in order with cloned args; test-control actions are not logged', async () => {
    const fake = new FakeLinear();
    const i = fake.seedIssue({ title: 'x', labels: ['conductor'] });
    fake.humanComment(i.id, 'human');
    await fake.candidates(fake.teamId, 'conductor', { includeAssigned: true });
    await fake.comment(i.id, 'bot');
    await fake.update(i.id, { stateId: fake.requireState('In Progress').id });
    assert.deepEqual(
      fake.calls.map((c) => c.op),
      ['candidates', 'comment', 'update'],
    );
    assert.deepEqual(fake.calls[0]!.args, { teamId: fake.teamId, triggerLabel: 'conductor', opts: { includeAssigned: true } });
    assert.equal(fake.callsOf('comment').length, 1);
  });

  test('a failed call is still logged', async () => {
    const fake = new FakeLinear();
    fake.failNext('viewer', new Error('x'));
    await assert.rejects(fake.viewer());
    assert.equal(fake.callsOf('viewer').length, 1);
  });
});
