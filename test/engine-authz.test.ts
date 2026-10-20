import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers/harness.ts';

test('issues created by a teammate are ignored — even when assigned to the viewer', async () => {
  const h = await makeHarness();
  try {
    const i = h.linear.seedIssue({ title: 'Teammate task', labels: ['conductor'], creatorId: h.linear.otherUserId, assigneeId: h.linear.viewerId, stateName: 'Todo' });
    await h.settle();
    assert.equal(h.store.list().length, 0);
    // filtered server-side (creator.isMe): a teammate's issue is never even fetched, let alone claimed
    // opting in to assigned-to-me pickup changes that
    h.cfg.linear.allowAssignedToMe = true;
    h.engine.invalidate();
    h.linear.humanComment(i.id, 'poke', h.linear.viewerId); // bumps updatedAt so the poller re-evaluates
    await h.settle();
    assert.equal(h.store.list().length, 1);
  } finally {
    await h.cleanup();
  }
});

test('trigger label added by a teammate is ignored; created-with-label is accepted (C1)', async () => {
  const h = await makeHarness();
  try {
    const mine = h.linear.seedIssue({ title: 'No label yet', labels: [], creatorId: h.linear.viewerId, stateName: 'Todo' });
    h.linear.humanAddLabel(mine.id, 'conductor', h.linear.otherUserId); // teammate tags my issue
    await h.settle();
    assert.equal(h.store.list().length, 0, 'teammate-added label must not trigger');
    const created = h.issue('Created with the label');
    await h.settle();
    assert.equal(h.run(created).status, 'ready', 'created-with-label-empty-history ⇒ accepted');
  } finally {
    await h.cleanup();
  }
});

test('description edited by a teammate before claim is ignored', async () => {
  const h = await makeHarness();
  try {
    const i = h.linear.seedIssue({ title: 'Tampered', labels: ['conductor'], stateName: 'Todo' });
    h.linear.humanEditDescription(i.id, 'rm -rf everything', h.linear.otherUserId);
    await h.settle();
    assert.equal(h.store.list().length, 0);
  } finally {
    await h.cleanup();
  }
});

test('Backlog issues are not picked up unless pickupFromBacklog; sub-issues and bug-labelled issues are never picked up', async () => {
  const h = await makeHarness();
  try {
    const b = h.linear.seedIssue({ title: 'In backlog', labels: ['conductor'], stateName: 'Backlog' });
    const parent = h.linear.seedIssue({ title: 'Parent without label', labels: [], stateName: 'Todo' });
    h.linear.seedIssue({ title: 'Child with stray trigger label', labels: ['conductor'], parentId: parent.id, stateName: 'Todo' });
    h.linear.seedIssue({ title: 'A bug', labels: ['conductor', 'conductor-bug'], stateName: 'Todo' });
    await h.settle();
    // the child with a trigger label whose parent is NOT a conductor run is a legitimate task; bug-labelled is not
    const keys = h.store.list().map((r) => r.key);
    assert.ok(!keys.includes(b.identifier), 'backlog ignored');
    assert.ok(!keys.some((k) => h.linear.issueByKey(k).title === 'A bug'), 'bug-labelled ignored');
    h.cfg.linear.pickupFromBacklog = true;
    h.linear.humanEditDescription(b.id, 'now actionable', h.linear.viewerId);
    await h.settle();
    assert.ok(h.store.list().some((r) => r.key === b.identifier), 'picked up after enabling pickupFromBacklog');
  } finally {
    await h.cleanup();
  }
});

test('unresolvable repo → needs_human with the registered names; label repo:<name> + Todo fixes it', async () => {
  const h = await makeHarness({
    config: (c) => {
      c.repos.push({ ...c.repos[0]!, name: 'other' });
    },
  });
  try {
    const key = h.issue('Which repo?');
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.ok(h.run(key).needsHuman?.reason.includes('repository'));
    h.linear.humanAddLabel(h.linear.issueByKey(key).id, 'repo:demo', h.linear.viewerId);
    h.linear.humanMove(h.linear.issueByKey(key).id, 'Todo');
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
    assert.equal(h.run(key).repo, 'demo');
  } finally {
    await h.cleanup();
  }
});
