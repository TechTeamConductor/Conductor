// M8-6 B1/S4 (T12): board schema v3. The version lives only in snapshot.json and journal ops stay `v: 1`, so a writable open stamps a v3
// snapshot (after a `pre-board-v3` backup) BEFORE any op can be appended. An older build then refuses the board with NewerVersionError —
// it never sees a `design` op behind a v2 snapshot (which it would cut off as a "torn tail").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Board } from '../../src/board/index.ts';
import { BOARD_SCHEMA_VERSION } from '../../src/board/types.ts';
import { SNAPSHOT_SPEC } from '../../src/board/journal.ts';
import { loadVersioned } from '../../src/schema/version.ts';
import { NewerVersionError } from '../../src/schema/errors.ts';
import { backupRoot } from '../../src/schema/backup.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'cond-board-v3-'));
/** The v2 build's loader contract for the snapshot (what an older Conductor runs first in Journal.load). */
const V2_SPEC = { ...SNAPSHOT_SPEC, current: 2 };
const snapVersion = (dir: string) => JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8')).schemaVersion;
const backupsNow = () => (existsSync(backupRoot()) ? readdirSync(backupRoot()).filter((n) => n.includes('pre-board-v3')) : []);

function seedV2(dir: string, opts: { snapshot: boolean }): string {
  const b = Board.open({ dir });
  const p = b.createProject({ key: 'APP', name: 'App', repo: 'app' });
  b.createItem({ projectId: p.id, title: 'old card' }, 'user');
  b.close(); // compacts: snapshot v3, empty journal
  const snap = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'));
  // rewrite as a v2-era board: v2 snapshot + one journalled item op
  const item = { ...snap.items[0], id: 'it-2', key: 'APP-2', title: 'journalled', createdAt: 2, updatedAt: 2 };
  if (opts.snapshot) writeFileSync(join(dir, 'snapshot.json'), JSON.stringify({ ...snap, schemaVersion: 2 }));
  else rmSync(join(dir, 'snapshot.json')); // a journal-only board
  const ops = opts.snapshot
    ? [{ v: 1, seq: snap.seq + 1, ts: 2, t: 'item', e: item, nextSeq: { projectId: p.id, value: 3 } }]
    : [{ v: 1, seq: 1, ts: 1, t: 'project', e: snap.projects[0] }, { v: 1, seq: 2, ts: 1, t: 'item', e: snap.items[0] }, { v: 1, seq: 3, ts: 2, t: 'item', e: item, nextSeq: { projectId: p.id, value: 3 } }];
  appendFileSync(join(dir, 'journal.ndjson'), ops.map((o) => JSON.stringify(o)).join('\n') + '\n');
  return p.id;
}
test('v2 board opened by v3: backup then compact before the first write', () => {
  const dir = tmp();
  const projectId = seedV2(dir, { snapshot: true });
  const before = backupsNow().length;
  const b = Board.open({ dir });
  assert.equal(snapVersion(dir), BOARD_SCHEMA_VERSION, 'stamped at open, before any write');
  const backups = backupsNow();
  assert.equal(backups.length, before + 1, 'one pre-board-v3 backup');
  const bdir = join(backupRoot(), backups.sort().at(-1)!);
  assert.equal(JSON.parse(readFileSync(join(bdir, 'snapshot.json'), 'utf8')).schemaVersion, 2, 'the backup holds the v2 snapshot');
  assert.match(readFileSync(join(bdir, 'journal.ndjson'), 'utf8'), /journalled/, 'and the v2 journal');
  const card = b.createItem({ projectId, kind: 'work', lane: 'todo', title: 'Part 1', description: 'x', parentId: null, autoStart: true, idemKey: 'design:brf-0123456789abcdef:P1' }, 'design');
  assert.equal(card.createdBy, 'design');
  // the process is dropped WITHOUT close(): no compaction happened after the design op
  assert.equal(snapVersion(dir), 3);
  assert.match(readFileSync(join(dir, 'journal.ndjson'), 'utf8'), /"createdBy":"design"/, 'the design op is only in the journal');
  assert.throws(() => loadVersioned(join(dir, 'snapshot.json'), V2_SPEC, () => ({})), (e: unknown) => e instanceof NewerVersionError, 'the v2 loader spec refuses the snapshot');
  assert.equal(b.items().length, 3);
});

test('absent snapshot with a non-empty journal is backed up and compacted too', () => {
  const dir = tmp();
  seedV2(dir, { snapshot: false });
  assert.ok(!existsSync(join(dir, 'snapshot.json')));
  const before = backupsNow().length;
  const b = Board.open({ dir });
  assert.equal(snapVersion(dir), BOARD_SCHEMA_VERSION);
  assert.equal(backupsNow().length, before + 1);
  assert.equal(b.items().length, 2);
  assert.equal(readFileSync(join(dir, 'journal.ndjson'), 'utf8'), '', 'compacted');
  b.close();
});

test('journal-only downgrade: a v3 design op behind no compaction is refused by a v2 loader (NewerVersionError), nothing truncated', () => {
  const dir = tmp();
  const b = Board.open({ dir }); // brand-new board: stamped v3 at open (no backup — nothing to back up)
  const p = b.createProject({ key: 'APP', name: 'App', repo: 'app' });
  b.createItem({ projectId: p.id, kind: 'work', lane: 'todo', title: 'Part 1', description: 'model text', parentId: null, autoStart: true, idemKey: 'design:brf-0123456789abcdef:P1' }, 'design');
  // abrupt end: no close(), so the design op is the LAST journal line
  const journal = readFileSync(join(dir, 'journal.ndjson'), 'utf8');
  assert.match(journal.trim().split('\n').at(-1)!, /"createdBy":"design"/);
  assert.equal(snapVersion(dir), 3);
  assert.throws(() => loadVersioned(join(dir, 'snapshot.json'), V2_SPEC, () => ({})), (e: unknown) => e instanceof NewerVersionError && !/corrupt/i.test(String((e as Error).message)));
  assert.equal(readFileSync(join(dir, 'journal.ndjson'), 'utf8'), journal, 'the last line is not truncated');
  assert.ok(!readdirSync(dir).some((n) => n.includes('.torn-')), 'no .torn-* file');
});

test('read-only open neither backs up nor stamps', () => {
  const dir = tmp();
  seedV2(dir, { snapshot: true });
  const before = backupsNow().length;
  const r = Board.open({ dir, readOnly: true });
  assert.equal(snapVersion(dir), 2);
  assert.equal(backupsNow().length, before);
  r.close();
});
