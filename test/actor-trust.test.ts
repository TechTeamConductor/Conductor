// M8-4 B3 / M8-6 C5: EVERY board actor is classified. `Record<Actor, …>` makes an unclassified new actor a `npm run check` failure; the
// assertions below make the table, the taint set (forced plan approval), and the journal loader's allow-list agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTOR_INFO, TAINTED_ACTORS, type Actor } from '../src/board/types.ts';
import { ACTORS } from '../src/board/validate.ts';

const TRUST: Record<Actor, 'trusted' | 'tainted'> = {
  user: 'trusted',
  conductor: 'trusted',
  'user-ask': 'trusted',
  import: 'tainted',
  'ask-convert': 'tainted',
  research: 'tainted',
  design: 'tainted',
};

test('actor-trust: every Actor is classified; tainted set === TAINTED_ACTORS; ACTORS === keys(TRUST)', () => {
  const tainted = Object.entries(TRUST).filter(([, v]) => v === 'tainted').map(([k]) => k).sort();
  assert.deepEqual([...TAINTED_ACTORS].sort(), tainted);
  assert.deepEqual([...ACTORS].sort(), Object.keys(TRUST).sort());
  assert.deepEqual(Object.keys(ACTOR_INFO).sort(), Object.keys(TRUST).sort());
  assert.equal(TRUST.design, 'tainted', 'M8-6 C5: "Design the work" cards are model text');
});

test('M8-4 B3: per actor, the source table agrees with TRUST (no actor is trusted by accident), and the trusted set is exactly the user-typed sources', () => {
  for (const a of Object.keys(TRUST) as Actor[]) assert.equal(ACTOR_INFO[a].tainted, TRUST[a] === 'tainted', a);
  assert.deepEqual(Object.entries(TRUST).filter(([, v]) => v === 'trusted').map(([k]) => k).sort(), ['conductor', 'user', 'user-ask']);
  // the run-mode overlay relies on this: every tainted actor's card is a FORCED hold (engine-run-mode.test.ts T2 iterates TAINTED_ACTORS)
  assert.ok(Object.isFrozen(TAINTED_ACTORS) && Object.isFrozen(ACTOR_INFO), 'the taint set cannot be edited at runtime');
});
