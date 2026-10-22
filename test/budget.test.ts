import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CEILINGS, localDay, refund, take, takeKeyed, used } from '../src/limits/budget.ts';

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

test('M8-6 designPerHour: ceiling 30, hourly, persisted; take() rejects a non-integer or < 1 n (S11)', () => {
  home();
  const t = new Date(2026, 2, 8, 10, 15).getTime();
  assert.equal(CEILINGS.designPerHour, 30);
  for (let i = 0; i < 2; i++) assert.ok(take('designPerHour', 2, { now: t }));
  assert.equal(take('designPerHour', 2, { now: t }), false, '429 at N+1');
  assert.equal(used('designPerHour', { now: t }), 2, 'persisted (re-read from limits.json)');
  assert.equal(used('designPerHour', { now: t + 60 * 60_000 }), 0, 'a new hour');
  assert.equal(take('designPerHour', 1000, { now: t, n: 31 }), false, 'config cannot lift the ceiling');
  for (const n of [0, -1, 1.5, Number.NaN]) assert.throws(() => take('designPerHour', 10, { now: t, n }), /integer/);
});

test('M8-6 N12: refund credits the window captured at take time; after the window rolled over it is a no-op', () => {
  home();
  const at1059 = new Date(2026, 2, 8, 10, 59).getTime(), at1100 = new Date(2026, 2, 8, 11, 0).getTime();
  const t1 = takeKeyed('designPerHour', 1, { now: at1059 });
  assert.ok(t1.ok);
  const t2 = takeKeyed('designPerHour', 1, { now: at1100 }); // the 11:00 window starts (and drops 10:xx)
  assert.ok(t2.ok);
  refund('designPerHour', { key: t1.key });
  assert.equal(used('designPerHour', { now: at1100 }), 1, 'no credit for the 11:00 window from a 10:59 take');
  refund('designPerHour', { key: t2.key });
  assert.equal(used('designPerHour', { now: at1100 }), 0, 'refund of the current window');
  refund('designPerHour', { key: t2.key });
  assert.equal(used('designPerHour', { now: at1100 }), 0, 'floored at 0');
  refund('designPerHour', { key: '../x' });
});
