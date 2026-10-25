// The dependants gate lives in Board.claimable(), driven by a predicate the ENGINE injects. The board never decides it alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../src/board/index.ts';

const open = () => Board.open({ dir: mkdtempSync(join(tmpdir(), 'cond-board-ship-')) });

function setup() {
  const b = open();
  const p = b.createProject({ key: 'APP', name: 'App', repo: 'app' });
  const dep = b.createItem({ projectId: p.id, title: 'dep', lane: 'backlog' }, 'user');
  const waiting = b.createItem({ projectId: p.id, title: 'waiting', dependsOn: [dep.id] }, 'user');
  return { b, dep, waiting };
}

test('no predicate: today\'s rule — a dependency that is Done releases its dependant', () => {
  const { b, dep, waiting } = setup();
  assert.equal(b.claimable().some((i) => i.id === waiting.id), false, 'dependency not done');
  b.setLane(dep.id, 'done', 'user');
  assert.equal(b.claimable().some((i) => i.id === waiting.id), true);
  b.close();
});

test('the injected predicate only ever ADDS a condition on a Done dependency, and receives the dependency and the dependant', () => {
  const { b, dep, waiting } = setup();
  const seen: Array<[string, string]> = [];
  let shipped = false;
  const gate = (d: { key: string }, me: { key: string }) => {
    seen.push([d.key, me.key]);
    return shipped;
  };
  assert.equal(b.claimable(['work'], gate).some((i) => i.id === waiting.id), false);
  assert.deepEqual(seen, [], 'a dependency that is not Done is refused before the predicate is asked');
  b.setLane(dep.id, 'done', 'user');
  assert.equal(b.claimable(['work'], gate).some((i) => i.id === waiting.id), false, 'Done but not shipped: waits');
  assert.deepEqual(seen.at(-1), [dep.key, waiting.key]);
  shipped = true;
  assert.equal(b.claimable(['work'], gate).some((i) => i.id === waiting.id), true, 'shipped: released');
  b.close();
});

test('a predicate that throws never deadlocks the board: it falls back to Done-gating', () => {
  const { b, dep, waiting } = setup();
  b.setLane(dep.id, 'done', 'user');
  assert.equal(b.claimable(['work'], () => { throw new Error('boom'); }).some((i) => i.id === waiting.id), true);
  b.close();
});

test('the predicate gets copies: it cannot change the board', () => {
  const { b, dep, waiting } = setup();
  b.setLane(dep.id, 'done', 'user');
  b.claimable(['work'], (d) => {
    d.title = 'tampered';
    return true;
  });
  assert.equal(b.item(dep.id)!.title, 'dep');
  assert.ok(waiting);
  b.close();
});
