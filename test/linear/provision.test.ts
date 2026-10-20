/**
 * provision-idempotent and friends, against FakeLinear (the same code path the engine and the setup wizard use).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FakeLinear } from '../../src/linear/fake.ts';
import { LinearApiError, LinearRateLimitError } from '../../src/linear/client.ts';
import { provisionTeam, resolveProvisioned } from '../../src/linear/provision.ts';
import { BUG_LABEL, STAGE_KEYS, STAGE_LABEL, STATE_DEFS, TRIGGER_LABEL_DEFAULT } from '../../src/linear/names.ts';

const TRIGGER = TRIGGER_LABEL_DEFAULT;
const ALL_LABELS = [TRIGGER, BUG_LABEL, ...STAGE_KEYS.map((k) => STAGE_LABEL[k])];

describe('names', () => {
  test('constants match the plan', () => {
    assert.equal(TRIGGER_LABEL_DEFAULT, 'conductor');
    assert.equal(BUG_LABEL, 'conductor-bug');
    assert.deepEqual(STAGE_LABEL, {
      planning: 'conductor:planning',
      plan_ready: 'conductor:plan-ready',
      building: 'conductor:building',
      verifying: 'conductor:verifying',
      needs_human: 'conductor:needs-human',
      ready: 'conductor:ready',
    });
    assert.deepEqual(
      STATE_DEFS.map((s) => [s.name, s.type, s.color]),
      [
        ['Planning', 'started', '#8b5cf6'],
        ['Plan Ready', 'started', '#f59e0b'],
        ['Building', 'started', '#3b82f6'],
        ['Verifying', 'started', '#06b6d4'],
        ['Needs Human', 'started', '#ef4444'],
        ['Ready for Review', 'started', '#22c55e'],
      ],
    );
  });
});

describe('provisionTeam: labels mode', () => {
  test('creates conductor, conductor-bug and the 6 stage labels; no states; returns resolved ids', async () => {
    const fake = new FakeLinear();
    const r = await provisionTeam(fake, fake.teamId, 'labels', TRIGGER);
    assert.deepEqual(r.willCreate.sort(), [...ALL_LABELS].sort());
    assert.deepEqual(r.created.sort(), [...ALL_LABELS].sort());
    assert.deepEqual(r.manual, []);
    assert.equal(fake.callsOf('createState').length, 0, 'labels mode never touches workflow states');
    assert.equal(fake.callsOf('createLabel').length, 8);
    const p = r.provisioned!;
    assert.ok(p);
    assert.equal(p.triggerLabelId, fake.requireLabel(TRIGGER).id);
    assert.equal(p.bugLabelId, fake.requireLabel(BUG_LABEL).id);
    for (const k of STAGE_KEYS) assert.equal(p.stageLabelIds[k], fake.requireLabel(STAGE_LABEL[k]).id, k);
    assert.equal(p.stageStateIds, undefined);
    assert.equal(p.inProgressStateId, fake.requireState('In Progress').id);
    assert.equal(p.inReviewStateId, fake.requireState('In Review').id);
    assert.equal(p.todoStateId, fake.requireState('Todo').id);
    assert.deepEqual(p.unstartedStateIds, [fake.requireState('Todo').id]);
    assert.deepEqual(p.defaultState, fake.requireState('Todo'));
    assert.deepEqual(r.unstartedStates, ['Todo']);
    assert.deepEqual(r.defaultState, fake.requireState('Todo'));
    // created labels are team-level with the planned colours
    const colours = new Map(fake.callsOf('createLabel').map((c) => [(c.args as { input: { name: string } }).input.name, (c.args as { input: { color: string } }).input.color]));
    assert.equal(colours.get('conductor:planning'), '#8b5cf6');
    assert.equal(colours.get('conductor:ready'), '#22c55e');
    assert.equal(fake.requireLabel(TRIGGER).teamId, fake.teamId);
  });

  test('provision-idempotent: the second run creates nothing', async () => {
    const fake = new FakeLinear();
    const first = await provisionTeam(fake, fake.teamId, 'labels', TRIGGER);
    const callsAfterFirst = fake.callsOf('createLabel').length;
    const second = await provisionTeam(fake, fake.teamId, 'labels', TRIGGER);
    assert.deepEqual(second.created, []);
    assert.deepEqual(second.willCreate, []);
    assert.deepEqual(second.manual, []);
    assert.equal(fake.callsOf('createLabel').length, callsAfterFirst);
    assert.deepEqual(second.provisioned, first.provisioned);
    assert.ok(second.items.every((i) => i.status === 'exists'));
    assert.equal(fake.allLabels().length, 8);
  });

  test('reuses an existing workspace-level label (any case) instead of creating a team one', async () => {
    const fake = new FakeLinear();
    const ws = fake.seedLabel('Conductor', { workspace: true });
    const bug = fake.seedLabel('CONDUCTOR-BUG');
    const r = await provisionTeam(fake, fake.teamId, 'labels', TRIGGER);
    assert.ok(!r.created.includes(TRIGGER));
    assert.ok(!r.created.includes(BUG_LABEL));
    assert.equal(r.created.length, 6);
    assert.equal(r.provisioned!.triggerLabelId, ws.id);
    assert.equal(r.provisioned!.bugLabelId, bug.id);
    assert.equal(fake.allLabels().filter((l) => l.name.toLowerCase() === 'conductor').length, 1);
  });

  test('a team-level label wins over a workspace-level one of the same name', async () => {
    const fake = new FakeLinear();
    fake.seedLabel('conductor', { workspace: true });
    const team = fake.seedLabel('conductor');
    const p = await resolveProvisioned(fake, fake.teamId, 'labels', TRIGGER);
    assert.equal(p, null, 'stage labels still missing');
    const r = await provisionTeam(fake, fake.teamId, 'labels', TRIGGER);
    assert.equal(r.provisioned!.triggerLabelId, team.id);
  });

  test('dryRun creates nothing and lists willCreate; provisioned is null until the labels exist', async () => {
    const fake = new FakeLinear();
    const r = await provisionTeam(fake, fake.teamId, 'labels', TRIGGER, { dryRun: true });
    assert.deepEqual(r.willCreate.sort(), [...ALL_LABELS].sort());
    assert.deepEqual(r.created, []);
    assert.deepEqual(r.manual, []);
    assert.equal(r.provisioned, null);
    assert.equal(fake.callsOf('createLabel').length, 0);
    assert.equal(fake.allLabels().length, 0);
    assert.ok(r.items.every((i) => i.status === 'will_create'));

    await provisionTeam(fake, fake.teamId, 'labels', TRIGGER);
    const again = await provisionTeam(fake, fake.teamId, 'labels', TRIGGER, { dryRun: true });
    assert.deepEqual(again.willCreate, []);
    assert.ok(again.provisioned, 'dry run on a fully provisioned team resolves ids');
  });

  test('permission denied => exact names in `manual`, nothing thrown, rest continues', async () => {
    const fake = new FakeLinear();
    fake.denyCreate('label');
    const r = await provisionTeam(fake, fake.teamId, 'labels', TRIGGER);
    assert.deepEqual([...r.manual].sort(), [...ALL_LABELS].sort());
    assert.deepEqual(r.created, []);
    assert.equal(r.provisioned, null);
    assert.equal(fake.callsOf('createLabel').length, 8, 'every item was attempted (no early abort)');
    assert.ok(r.warnings.some((w) => w.includes('Could not create label "conductor"') && /permission/i.test(w)));
    assert.ok(r.items.every((i) => i.status === 'manual' && i.error));

    // permission granted later: the retry creates exactly what is missing
    fake.denyCreate('label', false);
    const retry = await provisionTeam(fake, fake.teamId, 'labels', TRIGGER);
    assert.equal(retry.created.length, 8);
    assert.ok(retry.provisioned);
  });

  test('partial permission failure: only the failing item is manual', async () => {
    const fake = new FakeLinear();
    fake.failNext('createLabel', new LinearApiError('Forbidden: label limit reached', { status: 200, op: 'createLabel' }), 1);
    const r = await provisionTeam(fake, fake.teamId, 'labels', TRIGGER);
    assert.deepEqual(r.manual, [TRIGGER]);
    assert.equal(r.created.length, 7);
    assert.equal(r.provisioned, null);
    assert.ok(r.warnings.some((w) => w.includes('label limit reached')));
  });

  test('infrastructure errors (rate limit, plain Error) are rethrown, not turned into manual steps', async () => {
    const fake = new FakeLinear();
    fake.failNext('createLabel', new LinearRateLimitError('Rate limit exceeded', { status: 400, op: 'createLabel', retryAfterMs: 1000, attempts: 3 }));
    await assert.rejects(provisionTeam(fake, fake.teamId, 'labels', TRIGGER), LinearRateLimitError);
    const fake2 = new FakeLinear();
    fake2.failNext('createLabel', new Error('boom'));
    await assert.rejects(provisionTeam(fake2, fake2.teamId, 'labels', TRIGGER), /boom/);
    const fake3 = new FakeLinear();
    await assert.rejects(provisionTeam(fake3, 'no-such-team', 'labels', TRIGGER), (e: unknown) => e instanceof LinearApiError && e.notFound);
  });

  test('a custom trigger label name is honoured', async () => {
    const fake = new FakeLinear();
    const r = await provisionTeam(fake, fake.teamId, 'labels', 'robot-ready');
    assert.ok(r.created.includes('robot-ready'));
    assert.ok(!r.created.includes('conductor'));
    assert.equal(r.provisioned!.triggerLabelId, fake.requireLabel('robot-ready').id);
  });

  test('resolveProvisioned: null before provisioning, resolved after', async () => {
    const fake = new FakeLinear();
    assert.equal(await resolveProvisioned(fake, fake.teamId, 'labels', TRIGGER), null);
    await provisionTeam(fake, fake.teamId, 'labels', TRIGGER);
    const p = await resolveProvisioned(fake, fake.teamId, 'labels', TRIGGER);
    assert.ok(p);
    assert.equal(p.inProgressStateId, fake.requireState('In Progress').id);
  });
});

describe('provisionTeam: states mode', () => {
  test('additionally creates the 6 statuses, all type started, with their colours', async () => {
    const fake = new FakeLinear();
    const r = await provisionTeam(fake, fake.teamId, 'states', TRIGGER);
    assert.equal(r.created.length, 8 + 6);
    assert.deepEqual(r.manual, []);
    const calls = fake.callsOf('createState').map((c) => (c.args as { input: { name: string; type: string; color: string } }).input);
    assert.deepEqual(
      calls.map((c) => [c.name, c.type, c.color]),
      [
        ['Planning', 'started', '#8b5cf6'],
        ['Plan Ready', 'started', '#f59e0b'],
        ['Building', 'started', '#3b82f6'],
        ['Verifying', 'started', '#06b6d4'],
        ['Needs Human', 'started', '#ef4444'],
        ['Ready for Review', 'started', '#22c55e'],
      ],
    );
    for (const d of STATE_DEFS) assert.equal(fake.requireState(d.name).type, 'started');
    const p = r.provisioned!;
    assert.ok(p.stageStateIds);
    for (const d of STATE_DEFS) assert.equal(p.stageStateIds![d.key], fake.requireState(d.name).id);
    // "In Progress" is still the team's own started state, never one of Conductor's statuses
    assert.equal(p.inProgressStateId, fake.requireState('In Progress').id);
    // the native unstarted set (the human "retry" signal) is untouched
    assert.deepEqual(p.unstartedStateIds, [fake.requireState('Todo').id]);
  });

  test('idempotent in states mode; resolveProvisioned needs the statuses', async () => {
    const fake = new FakeLinear();
    await provisionTeam(fake, fake.teamId, 'labels', TRIGGER);
    assert.equal(await resolveProvisioned(fake, fake.teamId, 'states', TRIGGER), null, 'statuses missing in states mode');
    assert.ok(await resolveProvisioned(fake, fake.teamId, 'labels', TRIGGER));
    await provisionTeam(fake, fake.teamId, 'states', TRIGGER);
    const n = fake.callsOf('createState').length;
    const again = await provisionTeam(fake, fake.teamId, 'states', TRIGGER);
    assert.deepEqual(again.created, []);
    assert.equal(fake.callsOf('createState').length, n);
    assert.ok(await resolveProvisioned(fake, fake.teamId, 'states', TRIGGER));
  });

  test('dryRun lists the 6 statuses in willCreate and creates none', async () => {
    const fake = new FakeLinear();
    const r = await provisionTeam(fake, fake.teamId, 'states', TRIGGER, { dryRun: true });
    for (const d of STATE_DEFS) assert.ok(r.willCreate.includes(d.name), d.name);
    assert.equal(fake.callsOf('createState').length, 0);
    assert.equal(fake.allStates().length, 6, 'only the native workflow');
  });

  test('status creation denied => the 6 exact names are manual, labels are still created', async () => {
    const fake = new FakeLinear();
    fake.denyCreate('state');
    const r = await provisionTeam(fake, fake.teamId, 'states', TRIGGER);
    assert.deepEqual([...r.manual].sort(), STATE_DEFS.map((d) => d.name).sort());
    assert.equal(r.created.length, 8);
    assert.equal(r.provisioned, null);
    assert.ok(r.warnings.some((w) => w.includes('Could not create status "Planning"')));
  });

  test('an existing status with the right name but a non-started type is a conflict, never reused', async () => {
    const fake = new FakeLinear({
      states: [
        { name: 'Backlog', type: 'backlog' },
        { name: 'Todo', type: 'unstarted' },
        { name: 'Planning', type: 'unstarted' },
        { name: 'In Progress', type: 'started' },
        { name: 'Done', type: 'completed' },
      ],
    });
    const r = await provisionTeam(fake, fake.teamId, 'states', TRIGGER);
    assert.ok(r.manual.includes('Planning'));
    assert.ok(!r.created.includes('Planning'));
    assert.ok(r.created.includes('Building'));
    assert.equal(r.provisioned, null);
    assert.ok(r.warnings.some((w) => /"Planning" already exists with type "unstarted"/.test(w)));
    assert.equal(fake.stateByName('Planning')!.type, 'unstarted');
  });
});

describe('provisionTeam: warnings (C4)', () => {
  test('default new-issue state is Backlog => warns that labelled issues will not be picked up', async () => {
    const fake = new FakeLinear({ defaultStateName: 'Backlog' });
    const r = await provisionTeam(fake, fake.teamId, 'labels', TRIGGER);
    assert.equal(r.defaultState!.name, 'Backlog');
    const w = r.warnings.find((x) => x.includes('default status for new issues'));
    assert.ok(w, JSON.stringify(r.warnings));
    assert.match(w!, /"Backlog" \(backlog\)/);
    assert.match(w!, /NOT be picked up/);
    assert.match(w!, /pickup\.fromBacklog/);
    assert.match(w!, /"Todo"/);
  });

  test('default state Triage warns the same way; Todo default does not warn', async () => {
    const triage = new FakeLinear({
      states: [
        { name: 'Triage', type: 'triage' },
        { name: 'Todo', type: 'unstarted' },
        { name: 'In Progress', type: 'started' },
        { name: 'Done', type: 'completed' },
      ],
      defaultStateName: 'Triage',
    });
    const t = await provisionTeam(triage, triage.teamId, 'labels', TRIGGER);
    assert.ok(t.warnings.some((w) => /\(triage\)/.test(w) && /pickup\.fromBacklog/.test(w)));

    const todo = new FakeLinear();
    const r = await provisionTeam(todo, todo.teamId, 'labels', TRIGGER);
    assert.ok(!r.warnings.some((w) => /pickup\.fromBacklog/.test(w)), JSON.stringify(r.warnings));
    assert.ok(!r.warnings.some((w) => /unstarted/.test(w)));
  });

  test('the warning also appears on a dry run and on a second run (it is about the team, not about creation)', async () => {
    const fake = new FakeLinear({ defaultStateName: 'Backlog' });
    const dry = await provisionTeam(fake, fake.teamId, 'labels', TRIGGER, { dryRun: true });
    assert.ok(dry.warnings.some((w) => /pickup\.fromBacklog/.test(w)));
    await provisionTeam(fake, fake.teamId, 'labels', TRIGGER);
    const again = await provisionTeam(fake, fake.teamId, 'labels', TRIGGER);
    assert.ok(again.warnings.some((w) => /pickup\.fromBacklog/.test(w)));
  });

  test('no unstarted status => explicit warning, unstartedStates empty, todoStateId null', async () => {
    const fake = new FakeLinear({
      states: [
        { name: 'Backlog', type: 'backlog' },
        { name: 'In Progress', type: 'started' },
        { name: 'Done', type: 'completed' },
      ],
      defaultStateName: 'Backlog',
    });
    const r = await provisionTeam(fake, fake.teamId, 'labels', TRIGGER);
    assert.deepEqual(r.unstartedStates, []);
    assert.equal(r.provisioned!.todoStateId, null);
    assert.deepEqual(r.provisioned!.unstartedStateIds, []);
    const w = r.warnings.find((x) => x.includes('no "unstarted"'));
    assert.ok(w, JSON.stringify(r.warnings));
    assert.match(w!, /Conductor only picks up issues in an unstarted status/);
  });

  test('no In Review status => informational warning and inReviewStateId null', async () => {
    const fake = new FakeLinear({
      states: [
        { name: 'Todo', type: 'unstarted' },
        { name: 'In Progress', type: 'started' },
        { name: 'Done', type: 'completed' },
      ],
    });
    const r = await provisionTeam(fake, fake.teamId, 'labels', TRIGGER);
    assert.equal(r.provisioned!.inReviewStateId, null);
    assert.ok(r.warnings.some((w) => /In Review/.test(w)));
  });

  test('inProgress prefers a state whose name contains "progress"; no started state => warning and provisioned null', async () => {
    const pref = new FakeLinear({
      states: [
        { name: 'Todo', type: 'unstarted' },
        { name: 'Doing', type: 'started' },
        { name: 'In Progress', type: 'started' },
        { name: 'Done', type: 'completed' },
      ],
    });
    const p = await provisionTeam(pref, pref.teamId, 'labels', TRIGGER);
    assert.equal(p.provisioned!.inProgressStateId, pref.requireState('In Progress').id);

    const none = new FakeLinear({ states: [{ name: 'Todo', type: 'unstarted' }, { name: 'Done', type: 'completed' }] });
    const r = await provisionTeam(none, none.teamId, 'labels', TRIGGER);
    assert.equal(r.provisioned, null);
    assert.ok(r.warnings.some((w) => /no "started" status/.test(w)));
  });

  test('unknown default state (Linear did not report it) is called out', async () => {
    const fake = new FakeLinear();
    // simulate a port that reports no default state
    const port = Object.create(fake) as FakeLinear;
    port.teamSetup = async (id: string) => ({ ...(await fake.teamSetup(id)), defaultIssueStateId: null });
    const r = await provisionTeam(port, fake.teamId, 'labels', TRIGGER, { dryRun: true });
    assert.equal(r.defaultState, null);
    assert.ok(r.warnings.some((w) => /did not report the team's default status/.test(w)));
  });
});
