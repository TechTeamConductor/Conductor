import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CEILINGS, localDay, take, used } from '../src/limits/budget.ts';

process.env.TZ = 'America/Los_Angeles'; // the day rule is the LOCAL date: pin a non-UTC zone so a UTC regression fails
const home = () => { const h = mkdtempSync(join(tmpdir(), 'bud-')); process.env.CONDUCTOR_HOME = h; return h; };

test('counters: per-day window on the LOCAL date, ceilings are constants, restart-safe, old windows dropped', () => {
  home();
  const d1 = new Date(2026, 2, 8, 23, 30).getTime(), d2 = new Date(2026, 2, 9, 0, 30).getTime();
  assert.equal(localDay(d1), '2026-03-08');
  assert.ok(take('contextRunsPerDay', 2, { now: d1 }) && take('contextRunsPerDay', 2, { now: d1 }));
  assert.equal(take('contextRunsPerDay', 2, { now: d1 }), false);
  assert.equal(used('contextRunsPerDay', { now: d1 }), 2);
  assert.equal(used('contextRunsPerDay', { now: d2 }), 0, 'a new local day');
  assert.equal(take('contextRunsPerDay', 10 ** 6, { now: d2, n: CEILINGS.contextRunsPerDay + 1 }), false, 'config cannot lift the ceiling');
  assert.ok(take('contextRunsPerDay', 10 ** 6, { now: d2, n: CEILINGS.contextRunsPerDay }));
  assert.equal(take('contextRunsPerDay', 10 ** 6, { now: d2 }), false);
});

test('scopes are validated; a damaged or hostile file is quarantined / sanitised, never trusted', () => {
  const h = home();
  assert.throws(() => take('asksPerHour', 5, { scope: '../x' }), /bad counter scope/);
  writeFileSync(join(h, 'limits.json'), JSON.stringify({ version: 1, counters: { 'asksPerHour': { [new Date().toISOString().slice(0, 10) + 'T00']: -5, bad: 3 }, evil: { x: 1 } } }));
  assert.equal(used('asksPerHour'), 0);
  writeFileSync(join(h, 'limits.json'), '{broken');
  assert.equal(used('asksPerHour'), 0);
  assert.ok(readdirSync(h).some((n) => n.startsWith('limits.json.corrupt-')));
  assert.ok(take('asksPerHour', 1));
});
