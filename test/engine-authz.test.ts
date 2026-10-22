import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from './helpers/harness.ts';

// The multi-user claim-attribution tests (teammate-created cards, trigger label, description, backlog pick-up) retired with Linear
// (M1 matrix): a single local user is the only author. What survives is repository resolution.
test('a project without a repository → needs_human with the registered names; binding the project to a repo + To do fixes it', async () => {
  const h = await makeHarness({
    config: (c) => {
      c.repos.push({ ...c.repos[0]!, name: 'other' });
    },
  });
  try {
    const orphan = h.board.createProject({ key: 'NOP', name: 'No repository yet', repo: '' });
    const key = h.board.user.createItem({ projectId: orphan.id, title: 'Which repo?', description: 'Please implement: Which repo?' }).key;
    await h.settle();
    assert.equal(h.run(key).status, 'needs_human');
    assert.ok(h.run(key).needsHuman?.reason.includes('repository'));
    assert.ok(h.run(key).needsHuman?.reason.includes('demo') && h.run(key).needsHuman?.reason.includes('other'), 'lists the registered repos');
    h.board.setProject(orphan.id, { repo: 'demo' });
    await h.engine.applyHumanMove(key, 'todo');
    await h.settle();
    assert.equal(h.run(key).status, 'ready');
    assert.equal(h.run(key).repo, 'demo');
  } finally {
    await h.cleanup();
  }
});
