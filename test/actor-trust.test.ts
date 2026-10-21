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
