import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board, BoardError, LIMITS } from '../../src/board/index.ts';
import { LockHeldError } from '../../src/lock.ts';
import { CorruptFileError, NewerVersionError } from '../../src/schema/errors.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'cond-board-'));
const open = (dir: string, extra: Record<string, unknown> = {}) => Board.open({ dir, ...extra });
const mk = (b: Board) => b.createProject({ key: 'APP', name: 'App', repo: 'app' });

test('keys are PROJECT-n, monotonic, and satisfy the run-store / API / branch key shapes', () => {
  const dir = tmp();
  const b = open(dir);
  const p = mk(b);
  const keys = [1, 2, 3].map((n) => b.createItem({ projectId: p.id, title: `t${n}` }, 'user').key);
  assert.deepEqual(keys, ['APP-1', 'APP-2', 'APP-3']);
  for (const k of keys) {
    assert.match(k, /^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$/); // api.ts KEY_RE
    assert.match(k, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/); // store.ts KEY_RE
  }
  assert.throws(() => b.createProject({ key: 'app', name: 'x' }), /2–6 capital letters/);
  assert.throws(() => b.createProject({ key: 'APP', name: 'dup' }), /already exists/);
  assert.throws(() => b.createProject({ key: 'A', name: 'short' }), /2–6/);
  b.close();
});

test('state survives a restart — with and without compaction (snapshot + journal replay)', () => {
  const dir = tmp();
  const b = open(dir);
  const p = mk(b);
  const a = b.createItem({ projectId: p.id, title: 'first', description: 'd' }, 'user');
  b.addComment(a.id, 'hello', 'user');
  b.setLane(a.id, 'active', 'conductor', { stage: 'planning' });
  b.createMilestone({ projectId: p.id, title: 'v1' });
  b.addDecision({ projectId: p.id, title: 'Use X', body: 'because' });
  // crash-style: do NOT close → journal only
  const b2 = open(dir, { readOnly: true });
  assert.equal(b2.item('APP-1')!.lane, 'active');
  assert.equal(b2.item('APP-1')!.stage, 'planning');
  assert.equal(b2.comments('APP-1')[0]!.body, 'hello');
  assert.equal(b2.milestones().length, 1);
  assert.equal(b2.decisions()[0]!.title, 'Use X');
  b2.close();
  b.close(); // compacts
  assert.equal(statSync(join(dir, 'journal.ndjson')).size, 0, 'journal emptied after compaction');
  const b3 = open(dir);
  assert.equal(b3.item('APP-1')!.title, 'first');
  assert.equal(b3.createItem({ projectId: p.id, title: 'second' }, 'user').key, 'APP-2', 'counter continues after reload');
  b3.close();
});

test('property: for random operation sequences, reopening reproduces the live state exactly', () => {
  let s = 12345;
  const rnd = (n: number) => ((s = (s * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let round = 0; round < 6; round++) {
    const dir = tmp();
    const b = open(dir, { compactEvery: 7 + round * 5 });
    const p = mk(b);
    const ids: string[] = [];
    for (let i = 0; i < 80; i++) {
      const r = rnd(6);
      try {
        if (r <= 1 || !ids.length) ids.push(b.createItem({ projectId: p.id, title: `t${i}`, parentId: ids.length && rnd(3) === 0 ? ids[rnd(ids.length)]! : null }, 'user').id);
        else if (r === 2) b.setLane(ids[rnd(ids.length)]!, (['backlog', 'todo', 'done', 'canceled'] as const)[rnd(4)]!, 'user');
        else if (r === 3) b.addComment(ids[rnd(ids.length)]!, `c${i}`, rnd(2) ? 'user' : 'conductor');
        else if (r === 4) b.setFields(ids[rnd(ids.length)]!, { title: `renamed ${i}` }, 'user');
        else b.setDependsOn(ids[rnd(ids.length)]!, [ids[rnd(ids.length)]!], 'user');
      } catch (e) {
        assert.ok(e instanceof BoardError, `unexpected ${String(e)}`); // cycles / self-deps are legal rejections
      }
    }
    const dump = (x: Board) => JSON.stringify({ items: x.items(), comments: x.items().flatMap((i) => x.comments(i.id)), projects: x.projects() });
    const live = dump(b);
    const ro = open(dir, { readOnly: true }); // replays snapshot + journal without closing the writer
    assert.equal(dump(ro), live, `round ${round}`);
    ro.close();
    b.close();
  }
});

test('idempotency keys: duplicate create/comment return the original and survive a reload', () => {
  const dir = tmp();
  const b = open(dir);
  const p = mk(b);
  const parent = b.createItem({ projectId: p.id, title: 'parent' }, 'user');
  const bug1 = b.createItem({ projectId: p.id, title: 'bug', kind: 'bug', parentId: parent.id, lane: 'todo', idemKey: 'RUN:bug:fp1' }, 'conductor');
  const bug2 = b.createItem({ projectId: p.id, title: 'bug again', kind: 'bug', parentId: parent.id, idemKey: 'RUN:bug:fp1' }, 'conductor');
  assert.equal(bug2.id, bug1.id);
  assert.equal(b.items().length, 2);
  const c1 = b.addComment(parent.id, 'plan ready', 'conductor', { idemKey: 'RUN:plan:1' });
  const c2 = b.addComment(parent.id, 'plan ready (retry)', 'conductor', { idemKey: 'RUN:plan:1' });
  assert.equal(c2.id, c1.id);
  assert.equal(b.comments(parent.id).length, 1);
  b.close();
  const b2 = open(dir);
  assert.equal(b2.createItem({ projectId: p.id, title: 'x', kind: 'bug', parentId: parent.id, idemKey: 'RUN:bug:fp1' }, 'conductor').id, bug1.id);
  assert.equal(b2.addComment(parent.id, 'again', 'conductor', { idemKey: 'RUN:plan:1' }).id, c1.id);
  assert.equal(b2.comments(parent.id).length, 1);
  b2.close();
});

test('hierarchy and dependencies: cycles, dangling, cross-project and depth are rejected', () => {
  const b = open(tmp());
  const p = mk(b);
  const q = b.createProject({ key: 'OTH', name: 'Other' });
  const a = b.createItem({ projectId: p.id, title: 'a' }, 'user');
  const c = b.createItem({ projectId: p.id, title: 'c', dependsOn: [a.id] }, 'user');
  assert.throws(() => b.setDependsOn(a.id, [c.id], 'user'), /cycle/);
  assert.throws(() => b.setDependsOn(a.id, [a.id], 'user'), /itself/);
  assert.throws(() => b.setDependsOn(a.id, ['nope'], 'user'), /does not exist/);
  const x = b.createItem({ projectId: q.id, title: 'x' }, 'user');
  assert.throws(() => b.setDependsOn(a.id, [x.id], 'user'), /same project/);
  assert.throws(() => b.createItem({ projectId: p.id, title: 'child', parentId: x.id }, 'user'), /same project/);
  let parent = a.id;
  for (let i = 0; i < LIMITS.maxDepth - 1; i++) parent = b.createItem({ projectId: p.id, title: `d${i}`, parentId: parent }, 'conductor').id;
  assert.throws(() => b.createItem({ projectId: p.id, title: 'too deep', parentId: parent }, 'conductor'), /nested at most/);
  assert.equal(b.children(a.id).length, 1);
  b.close();
});

test('claimable(): only top-level To-do items of auto-start kinds whose dependencies are done', () => {
  const b = open(tmp());
  const p = mk(b);
  const dep = b.createItem({ projectId: p.id, title: 'dep', lane: 'backlog' }, 'user');
  const blocked = b.createItem({ projectId: p.id, title: 'blocked', dependsOn: [dep.id] }, 'user');
  const ok = b.createItem({ projectId: p.id, title: 'ok' }, 'user');
  const child = b.createItem({ projectId: p.id, title: 'child', parentId: ok.id }, 'user');
  const bug = b.createItem({ projectId: p.id, title: 'bug', kind: 'bug' }, 'conductor');
  const manual = b.createItem({ projectId: p.id, title: 'manual', autoStart: false }, 'user');
  const ask = b.createItem({ projectId: p.id, title: 'a question', kind: 'ask' }, 'user');
  assert.deepEqual(b.claimable().map((i) => i.key), [ok.key], 'only `work` is claimable by default (K4: ask/research have no runner yet)');
  assert.ok(b.claimable(['work', 'ask']).some((i) => i.id === ask.id), 'other kinds are available when a runner exists');
  b.setLane(dep.id, 'done', 'user');
  assert.deepEqual(b.claimable().map((i) => i.key).sort(), [blocked.key, ok.key].sort());
  assert.ok(![child, bug, manual].some((i) => b.claimable().some((c) => c.id === i.id)));
  b.close();
});

test('C4 — server-side authorship: the user facade ignores forged authorship/key/external and refuses Conductor-owned lanes and kinds', () => {
  const b = open(tmp());
  const p = mk(b);
  const forged = b.user.createItem({ projectId: p.id, title: 'sneaky', author: 'conductor', createdBy: 'conductor', key: 'APP-999', external: { system: 'linear', key: 'X-1', url: 'https://evil.example' }, id: 'chosen', stage: 'ready' });
  assert.equal(forged.createdBy, 'user');
  assert.equal(forged.key, 'APP-1');
  assert.equal(forged.external, undefined);
  assert.notEqual(forged.id, 'chosen');
  assert.throws(() => b.user.createItem({ projectId: p.id, title: 'x', kind: 'bug' }), /cannot be created/);
  assert.throws(() => b.user.createItem({ projectId: p.id, title: 'x', lane: 'review' }), /Backlog or To do/);
  for (const lane of ['active', 'needs_you', 'review']) assert.throws(() => b.user.moveLane(forged.id, lane), /Conductor owns/);
  assert.equal(b.user.moveLane(forged.id, 'done').lane, 'done');
  const c = b.user.comment(forged.id, 'hi');
  assert.equal(c.author, 'user');
  assert.throws(() => b.createItem({ projectId: p.id, title: 'x', key: 'APP-5' }, 'user'), /importer/);
  assert.throws(() => b.createItem({ projectId: p.id, title: 'x', kind: 'bug' }, 'user'), /cannot create/);
  assert.throws(() => b.user.createItem('not an object'), /JSON object/);
  b.close();
});

test('H3 — Conductor-authored text is redacted; user text is stored as typed; limits: user rejected, Conductor truncated', () => {
  const b = open(tmp());
  const p = mk(b);
  const leaky = 'key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd here';
  const c = b.createItem({ projectId: p.id, title: leaky, description: leaky, kind: 'bug' }, 'conductor');
  assert.doesNotMatch(c.title + c.description, /sk-ant/);
  const cm = b.addComment(c.id, leaky, 'conductor');
  assert.doesNotMatch(cm.body, /sk-ant/);
  const u = b.createItem({ projectId: p.id, title: 'plain title with sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd' }, 'user');
  assert.match(u.title, /sk-ant/); // the user's own words are not rewritten
  assert.throws(() => b.createItem({ projectId: p.id, title: 'x'.repeat(LIMITS.title + 1) }, 'user'), /too long/);
  assert.equal(b.createItem({ projectId: p.id, title: 'y'.repeat(LIMITS.title + 50), kind: 'bug' }, 'conductor').title.length, LIMITS.title);
  assert.equal(b.createItem({ projectId: p.id, title: 'multi\nline\u0007title' }, 'user').title, 'multi line title');
  const big = b.addComment(c.id, 'z'.repeat(1_000_000), 'conductor');
  assert.ok(big.body.length <= LIMITS.comment);
  b.close();
});

test('importer actor: preserves an explicit key, bumps the counter past it, validates prefix/shape, may attach an https link', () => {
  const b = open(tmp());
  const bar = b.createProject({ key: 'BAR', name: 'Bargainn' });
  const it = b.createItem({ projectId: bar.id, key: 'BAR-363', title: 'Find', lane: 'needs_you', createdAt: 1700000000000, external: { system: 'linear', key: 'BAR-363', url: 'https://linear.app/x/issue/BAR-363' } }, 'import');
  assert.equal(it.key, 'BAR-363');
  assert.equal(it.createdAt, 1700000000000);
  assert.equal(b.createItem({ projectId: bar.id, title: 'next' }, 'user').key, 'BAR-364');
  assert.throws(() => b.createItem({ projectId: bar.id, key: 'BAR-363', title: 'dup' }, 'import'), /already exists/);
  assert.throws(() => b.createItem({ projectId: bar.id, key: 'OTH-1', title: 'wrong prefix' }, 'import'), /look like BAR-/);
  assert.throws(() => b.createItem({ projectId: bar.id, key: '../../x-1', title: 'hostile' }, 'import'), /look like BAR-/);
  b.close();
});

test('events: every mutation notifies listeners; a throwing listener cannot break the board', () => {
  const b = open(tmp());
  const seen: string[] = [];
  b.onChange((c) => seen.push(c.type));
  b.onChange(() => {
    throw new Error('boom');
  });
  const p = mk(b);
  const i = b.createItem({ projectId: p.id, title: 't' }, 'user');
  b.addComment(i.id, 'c', 'user');
  b.setLane(i.id, 'done', 'user');
  b.setLane(i.id, 'done', 'user'); // no-op: no event, no journal line
  assert.deepEqual(seen, ['project', 'item', 'comment', 'item']);
  b.close();
});

// ───────────────────────────── persistence invariants (C2, C3) ─────────────────────────────
test('C3 — read-only open: no lock, no writes, no truncation, mutations refused; works while a writer is open', () => {
  const dir = tmp();
  const w = open(dir);
  mk(w);
  const ro = open(dir, { readOnly: true });
  assert.equal(ro.projects().length, 1);
  assert.throws(() => ro.createProject({ key: 'ZZZ', name: 'x' }), (e: any) => e instanceof BoardError && e.code === 'read_only');
  assert.throws(() => ro.compact(), /read-only/);
  ro.close();
  w.close();
});

test('single writer: a second writing open refuses (and leaves the board untouched)', () => {
  const dir = tmp();
  const w = open(dir);
  mk(w);
  assert.throws(() => open(dir), (e: any) => e instanceof LockHeldError);
  w.close();
  open(dir).close(); // after a clean close the lock is free
});

test('C2 — a torn FINAL journal line is ignored and cut off; a corrupt MIDDLE line refuses to open', () => {
  const dir = tmp();
  const w = open(dir);
  const p = mk(w);
  w.createItem({ projectId: p.id, title: 'one' }, 'user');
  w.createItem({ projectId: p.id, title: 'two' }, 'user');
  // simulate a power cut mid-write of a third line (no trailing newline)
  appendFileSync(join(dir, 'journal.ndjson'), '{"v":1,"seq":99,"ts":1,"t":"item","e":{"id":"half');
  const r = open(dir, { readOnly: true });
  assert.equal(r.items().length, 2);
  assert.ok(r.recoveredTornBytes > 0);
  const sizeBefore = statSync(join(dir, 'journal.ndjson')).size;
  r.close();
  assert.equal(statSync(join(dir, 'journal.ndjson')).size, sizeBefore, 'read-only open never truncates');
  w.close();
  // (the live writer compacted on close — rebuild the scenario for the writer-open path)
  const dir2 = tmp();
  const w2 = open(dir2);
  const p2 = mk(w2);
  w2.createItem({ projectId: p2.id, title: 'one' }, 'user');
  appendFileSync(join(dir2, 'journal.ndjson'), '{"v":1,"seq":99,"ts":1,"t":"item","e":{"id":"half');
  // do not close w2 (simulated crash) — free the lock the way a dead process would
  for (const f of ['board.lock']) writeFileSync(join(dir2, f), JSON.stringify({ pid: 999999, startedAt: 1 }));
  const w3 = open(dir2);
  assert.equal(w3.items().length, 1);
  w3.createItem({ projectId: p2.id, title: 'after the tear' }, 'user');
  w3.close();
  const w4 = open(dir2, { readOnly: true });
  assert.deepEqual(w4.items().map((i) => i.title), ['one', 'after the tear'], 'the torn tail did not poison the next append');
  w4.close();
  // middle corruption
  const dir3 = tmp();
  const w5 = open(dir3);
  const p3 = mk(w5);
  w5.createItem({ projectId: p3.id, title: 'a' }, 'user');
  w5.createItem({ projectId: p3.id, title: 'b' }, 'user');
  const lines = readFileSync(join(dir3, 'journal.ndjson'), 'utf8').split('\n');
  lines[1] = lines[1]!.slice(0, 20) + '#### garbage';
  writeFileSync(join(dir3, 'journal.ndjson'), lines.join('\n'));
  const before = readFileSync(join(dir3, 'journal.ndjson'), 'utf8');
  writeFileSync(join(dir3, 'board.lock'), JSON.stringify({ pid: 999999, startedAt: 1 }));
  assert.throws(() => open(dir3), (e: any) => e instanceof CorruptFileError && /refusing to skip/.test(e.message));
  assert.equal(readFileSync(join(dir3, 'journal.ndjson'), 'utf8'), before, 'nothing was modified');
});

test('versions: a newer snapshot or journal op is refused (nothing written); legacy snapshot without a version loads', () => {
  const dir = tmp();
  const w = open(dir);
  mk(w);
  w.close();
  const snap = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'));
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify({ ...snap, schemaVersion: 3 }));
  assert.throws(() => open(dir), (e: any) => e instanceof NewerVersionError);
  delete snap.schemaVersion;
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(snap));
  open(dir).close();
  appendFileSync(join(dir, 'journal.ndjson'), JSON.stringify({ v: 2, seq: 500, ts: 1, t: 'comment', e: {} }) + '\n');
  assert.throws(() => open(dir), (e: any) => e instanceof NewerVersionError);
});

test('C2 — counter safety: nextSeq is re-derived from the highest key on load (a lagging counter can never re-issue a key)', () => {
  const dir = tmp();
  const w = open(dir);
  const p = mk(w);
  w.createItem({ projectId: p.id, title: 'a' }, 'user');
  w.createItem({ projectId: p.id, title: 'b' }, 'user');
  w.close();
  const snap = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'));
  snap.projects[0].nextSeq = 1; // a stale counter
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(snap));
  const b = open(dir);
  assert.equal(b.createItem({ projectId: p.id, title: 'c' }, 'user').key, 'APP-3');
  b.close();
});

test('files are private: board dir 0700, snapshot/journal 0600', () => {
  const dir = join(tmp(), 'board');
  const b = open(dir);
  mk(b);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'journal.ndjson')).mode & 0o777, 0o600);
  b.close();
  assert.equal(statSync(join(dir, 'snapshot.json')).mode & 0o777, 0o600);
});

test('scale: 10 000 items + comments reload fast and compaction keeps the journal bounded', () => {
  const dir = tmp();
  const b = open(dir, { compactEvery: 2000 });
  const p = mk(b);
  for (let i = 0; i < 5000; i++) {
    const it = b.createItem({ projectId: p.id, title: `t${i}` }, 'user');
    b.addComment(it.id, `c${i}`, 'user');
  }
  assert.ok(statSync(join(dir, 'journal.ndjson')).size < 2_000_000, 'journal stays small thanks to compaction');
  b.close();
  const t0 = Date.now();
  const r = open(dir);
  assert.equal(r.stats().items, 5000);
  assert.ok(Date.now() - t0 < 3000, `reload took ${Date.now() - t0} ms`);
  r.close();
});

// ───────────────────────────── real kill -9 at each crash window ─────────────────────────────
function crashRun(dir: string, point: string, nth: number, compactEvery = 500): { acked: number; killed: boolean } {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, 'crash-child.ts')], {
    env: { ...process.env, BOARD_DIR: dir, CRASH_POINT: point, CRASH_NTH: String(nth), COMPACT_EVERY: String(compactEvery) },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const acked = (r.stdout.match(/^ACK \d+$/gm) ?? []).length;
  return { acked, killed: r.signal === 'SIGKILL' };
}
function assertConsistent(dir: string, acked: number): void {
  const b = open(dir); // takes over the dead child's stale lock
  const items = b.items();
  const keys = items.map((i) => i.key);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate keys');
  // ack sequence: 1 = project, then per round i: item i (ack 2+2i) and its comment (ack 3+2i)
  for (let i = 0; 2 + 2 * i <= acked; i++) {
    const it = items.find((x) => x.title === `item ${i}`);
    assert.ok(it, `acknowledged item ${i} survived (acked ${acked})`);
    if (3 + 2 * i <= acked) assert.deepEqual(b.comments(it!.id).map((c) => c.body), [`comment ${i}`], `acknowledged comment ${i} survived`);
  }
  const p = b.project('CRA');
  if (items.length) {
    const max = Math.max(...keys.map((k) => Number(k.split('-')[1])));
    assert.ok(p!.nextSeq > max, 'counter is ahead of every issued key');
    assert.equal(b.createItem({ projectId: p!.id, title: 'after crash' }, 'user').key, `CRA-${max + 1}`);
  }
  b.close();
}
for (const [point, nth, ce] of [
  ['journal:before-append', 5, 500],
  ['journal:after-append', 6, 500],
  ['compact:after-snapshot-temp', 1, 4],
  ['compact:after-snapshot-rename', 1, 4],
  ['compact:after-journal-truncate', 2, 4],
] as const) {
  test(`kill -9 at "${point}" (hit ${nth}, compactEvery ${ce}): every acknowledged operation survives, no duplicate keys, counter ahead`, () => {
    const dir = tmp();
    const r = crashRun(dir, point, nth, ce);
    assert.equal(r.killed, true, `the child must have been killed at ${point}`);
    assertConsistent(dir, r.acked);
    // and a second crash+recovery cycle on top of the recovered state
    const r2 = crashRun(dir, point, nth, ce);
    assertConsistent(dir, 0);
    void r2;
  });
}

test('clean run in the child completes and the final state is complete', () => {
  const dir = tmp();
  const r = spawnSync(process.execPath, [join(import.meta.dirname, 'crash-child.ts')], { env: { ...process.env, BOARD_DIR: dir }, encoding: 'utf8' });
  assert.match(r.stdout, /DONE/);
  const b = open(dir);
  assert.equal(b.items().length, 12);
  assert.equal(b.items().flatMap((i) => b.comments(i.id)).length, 12);
  assert.ok(existsSync(join(dir, 'snapshot.json')));
  b.close();
});

// ───────────────────────────── review B1 / B2 ─────────────────────────────
test('B1 — a write that fails mid-line is rolled back, the board then refuses writes, and every acknowledged write survives', () => {
  for (const point of ['journal:mid-append', 'journal:before-fsync']) {
    const dir = tmp();
    let armed = false;
    const b = open(dir, { fault: (p: string) => { if (armed && p === point) throw new Error(`injected I/O error at ${point}`); } });
    const p = mk(b);
    const a = b.createItem({ projectId: p.id, title: 'acknowledged' }, 'user');
    armed = true;
    assert.throws(() => b.createItem({ projectId: p.id, title: 'doomed' }, 'user'), (e: any) => e instanceof BoardError && e.code === 'storage_failed');
    armed = false;
    assert.equal(b.items().length, 1, 'nothing changed in memory');
    assert.throws(() => b.createItem({ projectId: p.id, title: 'after the failure' }, 'user'), (e: any) => e instanceof BoardError && e.code === 'storage_failed', 'later writes are refused, not appended after a half line');
    assert.equal(b.items().length, 1);
    b.close(); // must not compact a failed journal
    const lines = readFileSync(join(dir, 'journal.ndjson'), 'utf8').split('\n').filter(Boolean);
    for (const l of lines) JSON.parse(l); // every line on disk is whole
    const r = open(dir);
    assert.deepEqual(r.items().map((i) => i.title), ['acknowledged'], point);
    assert.equal(r.recoveredTornBytes, 0, 'the half line was rolled back, not left for the next open to ignore');
    assert.equal(r.createItem({ projectId: p.id, title: 'fresh start' }, 'user').key, 'APP-2', 'the doomed key was never issued');
    r.close();
    void a;
  }
});

test('B1 — a failing compaction never fails the write (the op is already durable) and a retry is idempotent', () => {
  const dir = tmp();
  let armed = true;
  const b = open(dir, { compactEvery: 3, fault: (pt: string) => { if (armed && pt === 'compact:after-snapshot-temp') throw new Error('injected compaction failure'); } });
  const p = mk(b);
  const made = [1, 2, 3, 4].map((n) => b.createItem({ projectId: p.id, title: `t${n}`, idemKey: `k${n}` }, 'user')); // crosses the compaction threshold
  assert.equal(b.items().length, 4);
  assert.equal(b.createItem({ projectId: p.id, title: 'retry', idemKey: 'k2' }, 'user').id, made[1]!.id, 'a caller retry does not duplicate');
  armed = false;
  b.close();
  const r = open(dir);
  assert.equal(r.items().length, 4);
  r.close();
});

test('B1 — writes after close() are refused (no lock is held any more)', () => {
  const b = open(tmp());
  const p = mk(b);
  b.close();
  b.close(); // idempotent
  assert.throws(() => b.createItem({ projectId: p.id, title: 'late' }, 'user'), (e: any) => e instanceof BoardError && e.code === 'closed');
  assert.equal(b.projects().length, 1, 'reads still work');
});

test('B2 — objects handed out never alias board state (mutating them changes nothing, even after compaction)', () => {
  const dir = tmp();
  const b = open(dir);
  const bar = b.createProject({ key: 'BAR', name: 'Bar' });
  const dep = b.createItem({ projectId: bar.id, title: 'dep' }, 'user');
  const link = { system: 'linear' as const, key: 'BAR-9', url: 'https://linear.app/x/issue/BAR-9' };
  const made = b.createItem({ projectId: bar.id, key: 'BAR-9', title: 'imp', dependsOn: [dep.id], external: link }, 'import');
  made.dependsOn.push('evil');
  made.external!.url = 'https://evil.example';
  link.url = 'https://evil.example/2'; // the caller's own object is not retained either
  for (const copy of [b.item('BAR-9')!, b.items().find((i) => i.key === 'BAR-9')!]) {
    copy.dependsOn.length = 0;
    copy.external!.key = 'HACKED';
  }
  const fresh = b.item('BAR-9')!;
  assert.deepEqual(fresh.dependsOn, [dep.id]);
  assert.deepEqual(fresh.external, { system: 'linear', key: 'BAR-9', url: 'https://linear.app/x/issue/BAR-9' });
  b.compact();
  b.close();
  const r = open(dir);
  assert.deepEqual(r.item('BAR-9')!.dependsOn, [dep.id]);
  assert.equal(r.item('BAR-9')!.external!.key, 'BAR-9');
  r.close();
});

test('N5 — repository names are validated (no path-like or oversized values), UserBoard rejects wrongly typed fields', () => {
  const b = open(tmp());
  assert.throws(() => b.createProject({ key: 'ABC', name: 'x', repo: '../../etc' }), /letters, numbers/);
  assert.throws(() => b.user.createProject({ key: 'ABC', name: 'x', repo: 'a'.repeat(100) }), /letters, numbers/);
  const p = b.createProject({ key: 'ABC', name: 'x', repo: 'my-app' });
  assert.throws(() => b.setProject(p.id, { repo: 'a/b' }), /letters, numbers/);
  assert.equal(b.setProject(p.id, { repo: 'other_app' }).repo, 'other_app');
  assert.equal((b.user as any).b, undefined, 'the facade does not expose the board');
  b.close();
});
