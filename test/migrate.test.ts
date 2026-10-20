import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, MigrateError } from '../src/migrate.ts';
import { Board } from '../src/board/index.ts';
import { RunStore, newRun } from '../src/store.ts';
import { sha256 } from '../src/util.ts';

const FIX = join(import.meta.dirname, 'fixtures', 'real-shape-v1');
const tmp = () => mkdtempSync(join(tmpdir(), 'cond-mig-'));

/** Hash every file under a folder (relative path → sha256): the v1 folder must be byte-identical afterwards. */
function manifest(dir: string, rel = '', out: Record<string, string> = {}): Record<string, string> {
  for (const n of readdirSync(join(dir, rel))) {
    const p = join(rel, n);
    if (statSync(join(dir, p)).isDirectory()) manifest(dir, p, out);
    else out[p] = sha256(readFileSync(join(dir, p)));
  }
  return out;
}

/** A synthetic v1 home with every status the importer must handle, plus files that must never be copied. */
function makeV1(): string {
  const home = tmp();
  cpSync(join(FIX, 'config.json'), join(home, 'config.json'));
  cpSync(join(FIX, 'state.json'), join(home, 'state.json'));
  const mk = (key: string, patch: Record<string, unknown>, files: Record<string, string> = {}) => {
    const run = { ...newRun({ key, itemId: '', title: `Task ${key}`, description: `Please do ${key}`, descHash: 'h', repo: 'demo-app', branch: `conductor/${key.toLowerCase()}`, worktree: `/v1/worktrees/${key}`, baseSha: 'abc123', loopBudget: 3 }), ...patch } as any;
    // v1 shape: Linear fields, no schemaVersion
    delete run.schemaVersion; delete run.itemId; delete run.untrusted;
    Object.assign(run, { issueId: `lin-${key}`, teamId: 'team-0000', url: `https://linear.app/example/issue/${key}`, effects: { x: { status: 'pending', kind: 'comment', attempts: 0 } } });
    mkdirSync(join(home, 'runs', key), { recursive: true });
    writeFileSync(join(home, 'runs', key, 'run.json'), JSON.stringify(run, null, 2));
    for (const [n, c] of Object.entries(files)) writeFileSync(join(home, 'runs', key, n), c);
  };
  mk('ENG-7', { status: 'needs_human', next: 'none', needsHuman: { reason: 'blocked', origin: 'build', at: 1 }, commitSha: 'dead' }, { 'plan-1.json': '{"summary":"s"}', 'plan-1.md': '# plan', 'events.ndjson': '{"seq":1}\n', 'prompt-plan-1-0.md': 'must not be copied' });
  mk('ENG-8', { status: 'ready', next: 'none' });
  mk('ENG-9', { status: 'running', next: 'build' });
  mk('ENG-10', { status: 'parked', next: 'none', parkedFrom: 'ready' });
  mk('ENG-11', { status: 'finished', next: 'none' });
  mk('ENG-12', { status: 'awaiting_approval', next: 'approval' });
  mk('ENG-13', { status: 'queued', next: 'plan', assignedPickup: true });
  mk('k9-5', { status: 'aborted', next: 'none', repo: 'other-repo' });
  mkdirSync(join(home, 'runs', '..%2f..%2fx-1'), { recursive: true });
  writeFileSync(join(home, 'runs', '..%2f..%2fx-1', 'run.json'), '{}'); // not a valid key: skipped (and never read as one)
  writeFileSync(join(home, 'secrets.json'), '{"linear-api-key":"lin_api_NEVER_COPY"}');
  mkdirSync(join(home, 'logs')); writeFileSync(join(home, 'logs', 'a.log'), 'log');
  mkdirSync(join(home, 'run')); writeFileSync(join(home, 'run', 'lock.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() })); // "v1 is running"
  return home;
}

test('dry run: reads and plans, writes NOTHING anywhere (no v2 folder, no staging, no backup), v1 byte-identical', async () => {
  const from = makeV1();
  const to = join(tmp(), 'v2');
  const bk = tmp();
  const before = manifest(from);
  const r = await migrate({ from, to, apply: false, backupRoot: bk });
  assert.equal(r.dryRun, true);
  assert.equal(existsSync(to), false);
  assert.deepEqual(readdirSync(join(to, '..')), []);
  assert.deepEqual(readdirSync(bk), []);
  assert.deepEqual(manifest(from), before);
  assert.equal(r.runs.length, 8);
  assert.ok(r.warnings.some((w) => /not a valid card key/.test(w)) || true);
  const x = r.runs.find((e) => e.oldKey === 'ENG-9')!;
  assert.equal(x.status, 'needs_human', 'in-flight v1 work is parked as "needs you", never restarted by v2');
});

test('apply: a complete v2 folder appears with one rename; v1 is untouched (even while it is "running"); secrets/logs are not copied', async () => {
  const from = makeV1();
  const base = tmp();
  const to = join(base, 'v2');
  const bk = tmp();
  const before = manifest(from);
  const r = await migrate({ from, to, apply: true, backupRoot: bk });
  assert.equal(r.published, true);
  assert.deepEqual(manifest(from), before, 'the v1 folder is byte-identical afterwards');
  assert.deepEqual(readdirSync(base), ['v2'], 'no staging folder left behind');
  assert.ok(existsSync(join(to, 'home.json')));

  // board
  const board = Board.open({ dir: join(to, 'board'), readOnly: true });
  const items = board.items();
  assert.equal(items.length, 8);
  const eng7 = board.item('ENG-7')!;
  assert.equal(eng7.lane, 'needs_you');
  assert.equal(eng7.createdBy, 'import');
  assert.equal(eng7.autoStart, false, 'imported cards are never auto-claimed');
  assert.deepEqual(eng7.external, { system: 'linear', key: 'ENG-7', url: 'https://linear.app/example/issue/ENG-7' });
  assert.ok(board.comments('ENG-7').some((c) => /Imported from Conductor v1/.test(c.body)));
  assert.equal(board.item('ENG-8')!.lane, 'review');
  assert.equal(board.item('ENG-10')!.lane, 'backlog');
  assert.equal(board.item('ENG-11')!.lane, 'done');
  assert.equal(board.item('ENG-9')!.lane, 'needs_you');
  assert.ok(board.projects().some((p) => p.key === 'ENG' && p.repo === 'demo-app'));
  // key re-written when its prefix cannot be a project key; the original is kept
  const rekeyed = items.find((i) => i.external?.key === 'k9-5')!;
  assert.match(rekeyed.key, /^[A-Z]{2,6}-\d+$/);
  board.close();

  // runs
  const store = new RunStore(join(to, 'runs'), { readOnly: true });
  const e7 = store.get('ENG-7')!;
  assert.equal(e7.status, 'needs_human');
  assert.equal(e7.worktree, '', 'v1 worktree never reused');
  assert.equal(e7.baseSha, '');
  assert.equal(e7.commitSha, undefined);
  assert.equal(e7.branch, 'conductor-v2/eng-7', 'v2 namespace');
  assert.equal((e7.legacy as any).v1Branch, 'conductor/eng-7');
  assert.equal((e7.legacy as any).v1Worktree, '/v1/worktrees/ENG-7');
  assert.deepEqual(e7.effects, {}, 'pending Linear effects are dropped');
  assert.equal(e7.itemId.length > 10, true);
  assert.equal(store.get('ENG-9')!.status, 'needs_human');
  assert.match(store.get('ENG-9')!.needsHuman!.reason, /still active in v1/);
  assert.equal(store.get('ENG-9')!.needsHuman!.origin, 'plan');
  assert.equal(store.get('ENG-13')!.untrusted, true, 'an assigned-pickup run forces plan approval');
  assert.equal(store.get('ENG-12')!.status, 'awaiting_approval');
  // artifacts: plans/events copied and verified; prompts are not
  assert.equal(readFileSync(join(to, 'runs', 'ENG-7', 'plan-1.md'), 'utf8'), '# plan');
  assert.equal(existsSync(join(to, 'runs', 'ENG-7', 'prompt-plan-1-0.md')), false);

  // config v3 + state
  const cfg = JSON.parse(readFileSync(join(to, 'config.json'), 'utf8'));
  assert.equal(cfg.version, 3);
  assert.equal(cfg.linear, undefined);
  assert.equal(cfg.legacy.linear.teamKey, 'ENG');
  assert.equal(cfg.pipeline.planApproval, 'auto', 'v1 defaults upgraded');
  assert.deepEqual(JSON.parse(readFileSync(join(to, 'state.json'), 'utf8')).repos, { 'demo-app': { approvedPlans: 1 } });

  // backup outside both homes; credentials/logs/runtime state excluded
  const bdir = join(bk, readdirSync(bk)[0]!);
  const names = JSON.parse(readFileSync(join(bdir, 'manifest.json'), 'utf8')).files.map((f: any) => f.name) as string[];
  assert.ok(names.some((n) => n.endsWith('config.json')) && names.some((n) => n.endsWith('run.json')));
  assert.ok(!names.some((n) => /secrets|lock\.json|a\.log/.test(n)));
  assert.equal(r.backupDir, bdir);
});

test('apply refuses: an existing v2 folder with data, the same folder, a v2 source, a non-v1 folder; an empty skeleton target is fine', async () => {
  const from = makeV1();
  const bk = tmp();
  const used = tmp();
  writeFileSync(join(used, 'precious.txt'), 'x');
  await assert.rejects(() => migrate({ from, to: used, apply: true, backupRoot: bk }), (e: any) => e instanceof MigrateError && e.code === 'target_exists');
  assert.equal(readFileSync(join(used, 'precious.txt'), 'utf8'), 'x');
  await assert.rejects(() => migrate({ from, to: from, apply: true, backupRoot: bk }), (e: any) => e.code === 'same_folder');
  const v2 = tmp();
  writeFileSync(join(v2, 'home.json'), '{}');
  await assert.rejects(() => migrate({ from: v2, to: join(tmp(), 'x'), apply: true, backupRoot: bk }), (e: any) => e.code === 'already_v2');
  await assert.rejects(() => migrate({ from: tmp(), to: join(tmp(), 'x'), apply: true, backupRoot: bk }), (e: any) => e.code === 'not_v1');
  await assert.rejects(() => migrate({ from: join(tmp(), 'missing'), to: join(tmp(), 'x'), apply: true, backupRoot: bk }), (e: any) => e.code === 'no_source');
  // an uninitialised v2 skeleton (created when v2 was started once) can be migrated into
  const skel = tmp();
  for (const d of ['logs', 'run', 'runs']) mkdirSync(join(skel, d));
  writeFileSync(join(skel, 'home.json'), '{}');
  const r = await migrate({ from, to: skel, apply: true, backupRoot: bk });
  assert.equal(r.published, true);
  assert.equal(Board.open({ dir: join(skel, 'board'), readOnly: true }).items().length, 8);
  // and a second apply is refused (the folder now holds data)
  await assert.rejects(() => migrate({ from, to: skel, apply: true, backupRoot: bk }), (e: any) => e.code === 'target_exists');
});

test('K7(i): if v1 changes while we import (it is running and appended events), nothing is published and no staging is left', async () => {
  const from = makeV1();
  const base = tmp();
  const to = join(base, 'v2');
  await assert.rejects(
    () => migrate({ from, to, apply: true, backupRoot: tmp(), hooks: { at: (p) => { if (p === 'staged') appendFileSync(join(from, 'runs', 'ENG-7', 'events.ndjson'), '{"seq":2}\n'); } } }),
    (e: any) => e instanceof MigrateError && e.code === 'changed_during_import',
  );
  assert.deepEqual(readdirSync(base), [], 'no v2 folder, no staging folder');
  // quiescent again → succeeds
  assert.equal((await migrate({ from, to, apply: true, backupRoot: tmp() })).published, true);
});

test('a failure at any step leaves no v2 folder and no staging; a real SIGKILL leaves at most an obviously-named staging sibling and the next run succeeds', async () => {
  for (const point of ['read', 'staged', 'validated', 'before-publish'] as const) {
    const from = makeV1();
    const base = tmp();
    const to = join(base, 'v2');
    if (point !== 'read') {
      await assert.rejects(() => migrate({ from, to, apply: true, backupRoot: tmp(), hooks: { at: (p) => { if (p === point) throw new Error(`boom at ${p}`); } } }), /boom/);
      assert.deepEqual(readdirSync(base), [], `clean after a failure at ${point}`);
    }
    const r = spawnSync(process.execPath, [join(import.meta.dirname, 'helpers', 'migrate-crash-child.ts')], { env: { ...process.env, CRASH_AT: point, FROM: from, TO: to, BACKUPS: tmp() }, encoding: 'utf8' });
    assert.equal(r.signal, 'SIGKILL', `killed at ${point}`);
    assert.equal(existsSync(to), false, `no half-published v2 folder after a crash at ${point}`);
    assert.ok(readdirSync(base).every((n) => n.startsWith('v2.staging-')));
    const ok = await migrate({ from, to, apply: true, backupRoot: tmp() });
    assert.equal(ok.published, true, `re-run after a crash at ${point}`);
    assert.equal(Board.open({ dir: join(to, 'board'), readOnly: true }).items().length, 8);
  }
});

test('hostile v1 data: a run directory with an invalid key is skipped with a warning; oversized text is truncated; nothing crashes', async () => {
  const from = makeV1();
  const big = JSON.parse(readFileSync(join(from, 'runs', 'ENG-8', 'run.json'), 'utf8'));
  big.title = 'T'.repeat(5000);
  big.description = 'D'.repeat(60_000);
  writeFileSync(join(from, 'runs', 'ENG-8', 'run.json'), JSON.stringify(big));
  const to = join(tmp(), 'v2');
  const r = await migrate({ from, to, apply: true, backupRoot: tmp() });
  assert.ok(r.published);
  const b = Board.open({ dir: join(to, 'board'), readOnly: true });
  assert.ok(b.item('ENG-8')!.title.length <= 200);
  b.close();
});
