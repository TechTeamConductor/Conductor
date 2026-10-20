/**
 * `conductor migrate` — side-by-side import of a v1 data folder into a NEW v2 data folder (workspace-v2-m1.md, M1c).
 *
 *  - The v1 folder is opened READ-ONLY and never written (nor locked): rollback is "do nothing"; v1 keeps working on its data.
 *  - Everything is built in a sibling staging folder, validated by re-opening it with the v2 loaders, and published with ONE rename.
 *    A crash leaves either nothing or a complete v2 folder.
 *  - Every v1 run becomes a card on the new board + a run record. Imported runs NEVER reuse v1's worktree/branch (the v2 namespace is
 *    different, see git/worktree.ts), anything that was in flight in v1 is parked as "needs you" (so v2 can never start the same work
 *    twice), runs whose description was never attribution-checked are flagged `untrusted` (plan approval is forced), and nothing is
 *    ever written to Linear.
 *  - A backup copy of what was read goes to ~/.conductor-backups (outside both homes) before anything is published.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Run, RunStatus } from './types.ts';
import { Board } from './board/index.ts';
import { laneForRun } from './board/lanes.ts';
import { BRANCH_PREFIX } from './git/worktree.ts';
import { CONFIG_SPEC, normalizeConfig } from './config.ts';
import { RunStore } from './store.ts';
import { loadVersioned } from './schema/version.ts';
import { backupPaths } from './schema/backup.ts';
import { redact } from './redact.ts';
import { sha256, slug, atomicWriteFile, truncate } from './util.ts';
import { deriveProjectKey } from './pipeline/engine.ts';

const KEY_RE = /^([A-Za-z][A-Za-z0-9]{0,15})-(\d{1,9})$/;
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ARTIFACT_RE = /^(plan-\d+\.(json|md)|review-\d+\.json|verdict-\d+\.json|gates-\d+\.json|baseline\.json|events\.ndjson(\.1)?)$/;
const SKELETON = new Set(['logs', 'run', 'runs', 'board']);

export interface MigrateOptions {
  from: string;
  to: string;
  /** false = dry run: read, plan and validate in memory; nothing is written anywhere. */
  apply: boolean;
  now?: () => number;
  backupRoot?: string;
  /** Test seam: called at named points (a test can throw, mutate v1 or SIGKILL the process here). */
  hooks?: { at?: (point: 'read' | 'staged' | 'validated' | 'before-publish') => void };
}
export interface MigratedRun {
  oldKey: string;
  newKey: string;
  project: string;
  status: RunStatus;
  lane: string;
  note?: string;
}
export interface MigrateReport {
  dryRun: boolean;
  from: string;
  to: string;
  runs: MigratedRun[];
  projects: { key: string; repo: string; cards: number }[];
  repos: string[];
  warnings: string[];
  backupDir?: string;
  published?: boolean;
  /** Files read from v1 that changed while we were importing (a live v1 appended meanwhile). Apply refuses to publish when non-empty. */
  changedDuringImport: string[];
}

export class MigrateError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MigrateError';
    this.code = code;
  }
}

function hashFile(p: string): string {
  return sha256(readFileSync(p));
}

/** A target that may be (re)used: absent, or a v2 skeleton that holds nothing yet. */
function checkTarget(to: string): { replaceEmpty: boolean } {
  if (!existsSync(to)) return { replaceEmpty: false };
  const entries = readdirSync(to).filter((n) => !n.startsWith('.'));
  const data = entries.filter((n) => {
    if (n === 'home.json') return false;
    if (!SKELETON.has(n)) return true;
    try {
      return readdirSync(join(to, n)).length > 0;
    } catch {
      return true;
    }
  });
  if (data.length) throw new MigrateError('target_exists', `${to} already holds data (${data.slice(0, 4).join(', ')}). migrate only creates a NEW v2 folder; point --to at an unused folder.`);
  return { replaceEmpty: true };
}

export async function migrate(opts: MigrateOptions): Promise<MigrateReport> {
  const now = opts.now ?? Date.now;
  const { from, to } = opts;
  if (from === to) throw new MigrateError('same_folder', '--from and --to are the same folder.');
  if (!existsSync(from)) throw new MigrateError('no_source', `${from} does not exist.`);
  if (existsSync(join(from, 'home.json'))) throw new MigrateError('already_v2', `${from} is already a v2 data folder.`);
  if (!existsSync(join(from, 'config.json')) && !existsSync(join(from, 'runs'))) throw new MigrateError('not_v1', `${from} does not look like a Conductor v1 data folder (no config.json, no runs/).`);
  const { replaceEmpty } = checkTarget(to);

  const report: MigrateReport = { dryRun: !opts.apply, from, to, runs: [], projects: [], repos: [], warnings: [], changedDuringImport: [] };

  // ── 1. read v1, read-only, remembering a hash of every file we read (K7 i)
  const readHashes = new Map<string, string>();
  const readFile = (p: string): string => {
    const buf = readFileSync(p);
    readHashes.set(p, sha256(buf));
    return buf.toString('utf8');
  };
  let v1Config: any = {};
  const cfgPath = join(from, 'config.json');
  if (existsSync(cfgPath)) {
    try {
      v1Config = JSON.parse(readFile(cfgPath));
    } catch (e) {
      throw new MigrateError('bad_config', `${cfgPath} is not valid JSON (${(e as Error).message}); nothing was changed.`);
    }
  }
  const cfg = normalizeConfig(loadVersionedInMemory(v1Config));
  report.repos = cfg.repos.map((r) => r.name);
  let v1State: any = {};
  const statePath = join(from, 'state.json');
  if (existsSync(statePath)) {
    try {
      v1State = JSON.parse(readFile(statePath));
    } catch {
      report.warnings.push('state.json could not be read; first-plan approval counters start from zero.');
    }
  }
  const v1Runs = existsSync(join(from, 'runs')) ? new RunStore(join(from, 'runs'), { readOnly: true }).list() : [];
  const artifactDirs = new Map<string, string[]>();
  for (const r of v1Runs) {
    const dir = join(from, 'runs', r.key);
    const names = readdirSync(dir).filter((n) => ARTIFACT_RE.test(n) && lstatSync(join(dir, n)).isFile());
    for (const n of names) readFile(join(dir, n));
    artifactDirs.set(r.key, names);
    readFile(join(dir, 'run.json'));
  }

  opts.hooks?.at?.('read');
  // ── 2. build the whole v2 state in memory + in a staging folder
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const staging = `${to}.staging-${stamp}`;
  const plan = planImport(v1Runs, cfg.repos.map((r) => r.name), report);
  if (!opts.apply) {
    report.projects = plan.projects.map((p) => ({ key: p.key, repo: p.repo, cards: plan.entries.filter((e) => e.projectKey === p.key).length }));
    report.runs = plan.entries.map((e) => ({ oldKey: e.run.key, newKey: e.newKey, project: e.projectKey, status: e.status, lane: laneForRun({ status: e.status }), note: e.note }));
    return report;
  }

  // backup first: a copy of exactly what the importer reads (config, state, runs) — outside both homes, verified
  const sources = [cfgPath, statePath, join(from, 'runs')].filter((p) => existsSync(p));
  const backup = backupPaths(sources, { root: opts.backupRoot, label: 'migrate-v1-to-v2', now });
  report.backupDir = backup.dir;
  for (const s of backup.skipped) report.warnings.push(`backup skipped ${s.path}: ${s.why}`);

  try {
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    for (const d of ['runs', 'logs', 'run']) mkdirSync(join(staging, d), { recursive: true, mode: 0o700 });
    writeFileSync(join(staging, 'home.json'), JSON.stringify({ kind: 'conductor-home', generation: 2, createdAt: now(), importedFrom: from }) + '\n', { mode: 0o600 });

    // config v3 (legacy.linear preserved) + state
    const outCfg = { ...cfg };
    atomicWriteFile(join(staging, 'config.json'), JSON.stringify({ ...(cfg.extra ?? {}), ...stripExtra(outCfg) }, null, 2) + '\n', 0o600);
    const repos: Record<string, { approvedPlans: number }> = {};
    for (const [k, v] of Object.entries((v1State?.repos ?? {}) as Record<string, any>)) if (REPO_NAME_RE.test(k) && Number.isFinite(v?.approvedPlans)) repos[k] = { approvedPlans: Math.max(0, Math.floor(v.approvedPlans)) };
    atomicWriteFile(join(staging, 'state.json'), JSON.stringify({ repos, schemaVersion: 1 }, null, 2) + '\n', 0o600);

    // board + runs
    const board = Board.open({ dir: join(staging, 'board') });
    const store = new RunStore(join(staging, 'runs'));
    try {
      const ids = new Map<string, string>();
      for (const p of plan.projects) ids.set(p.key, board.createProject({ key: p.key, name: p.key, repo: p.repo }).id);
      for (const e of plan.entries) {
        const projectId = ids.get(e.projectKey)!;
        const url = typeof e.run.legacy?.url === 'string' && /^https:\/\/linear\.app\//.test(e.run.legacy.url) ? e.run.legacy.url : undefined;
        const lane = laneForRun({ status: e.status });
        const item = board.createItem(
          {
            projectId,
            key: e.newKey,
            title: truncate(e.run.title || e.newKey, 200),
            description: e.run.description ?? '',
            kind: 'work',
            lane,
            autoStart: false,
            createdAt: e.run.createdAt,
            external: url ? { system: 'linear', key: e.run.key, url } : undefined,
          },
          'import',
        );
        const history = (e.run.history ?? []).map((h) => `- ${new Date(h.ts).toISOString()} ${h.text}`).join('\n');
        board.addComment(item.id, `Imported from Conductor v1 (${e.run.key}, status "${e.run.status}")${e.note ? `\n\n${e.note}` : ''}\n\n${redact(history, [])}`, 'import');
        const migrated: Run = {
          ...e.run,
          key: e.newKey,
          itemId: item.id,
          status: e.status,
          next: e.status === 'needs_human' || e.status === 'ready' || e.status === 'finished' || e.status === 'aborted' || e.status === 'parked' || e.status === 'awaiting_approval' ? e.run.next : 'none',
          worktree: '',
          baseSha: '',
          commitSha: undefined,
          branch: `${BRANCH_PREFIX}${slug(e.newKey)}`,
          effects: {},
          restartTimes: [],
          agentRuns: 0,
          expected: {},
          needsHuman: e.status === 'needs_human' && e.reset ? { reason: e.note ?? 'Imported while in progress', origin: 'plan', at: now() } : e.run.needsHuman,
          legacy: { ...(e.run.legacy ?? {}), v1Key: e.run.key }, // v1Branch / v1Worktree / v1BaseSha / v1CommitSha were set aside by the run migration
        };
        store.create(migrated);
        const srcDir = join(from, 'runs', e.run.key);
        const dstDir = join(staging, 'runs', e.newKey);
        for (const n of artifactDirs.get(e.run.key) ?? []) {
          copyFileSync(join(srcDir, n), join(dstDir, n));
          if (hashFile(join(dstDir, n)) !== readHashes.get(join(srcDir, n))) throw new MigrateError('copy_mismatch', `copy of ${n} does not match its source`);
        }
        report.runs.push({ oldKey: e.run.key, newKey: e.newKey, project: e.projectKey, status: e.status, lane, note: e.note });
      }
      report.projects = plan.projects.map((p) => ({ key: p.key, repo: p.repo, cards: plan.entries.filter((x) => x.projectKey === p.key).length }));
    } finally {
      board.close();
    }

    opts.hooks?.at?.('staged');
    // validate: reopen the staged folder with the v2 loaders
    const check = Board.open({ dir: join(staging, 'board'), readOnly: true });
    if (check.items().length !== plan.entries.length) throw new MigrateError('validation', 'the staged board does not contain every card');
    check.close();
    const chk = new RunStore(join(staging, 'runs'), { readOnly: true }).list();
    if (chk.length !== plan.entries.length) throw new MigrateError('validation', 'the staged runs do not match the board');
    loadVersioned(join(staging, 'config.json'), CONFIG_SPEC, () => ({}));

    opts.hooks?.at?.('validated');
    // v1 must be exactly as we read it (K7 i): a live v1 appends events/sessions — then we refuse to publish a stale picture
    for (const [p, h] of readHashes) {
      let now2 = '';
      try {
        now2 = hashFile(p);
      } catch {
        now2 = '(missing)';
      }
      if (now2 !== h) report.changedDuringImport.push(p);
    }
    if (report.changedDuringImport.length) {
      throw new MigrateError('changed_during_import', `${report.changedDuringImport.length} v1 file(s) changed while importing (v1 is probably running). Nothing was published — run migrate again.`);
    }

    opts.hooks?.at?.('before-publish');
    // publish: ONE rename (an empty skeleton target is cleared first, directory by directory, never recursively)
    if (replaceEmpty) {
      for (const n of readdirSync(to)) {
        const p = join(to, n);
        if (n === 'home.json') rmSync(p);
        else rmdirSync(p);
      }
      rmdirSync(to);
    }
    renameSync(staging, to);
    report.published = true;
  } catch (e) {
    try {
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    } catch {
      /* leave it: it is a sibling folder with an obvious name */
    }
    throw e;
  }
  return report;
}

function stripExtra(c: any): any {
  const { extra: _e, ...rest } = c;
  return rest;
}

/** v1/v2 configs → run through the same migrations the loader uses, in memory. */
function loadVersionedInMemory(raw: any): any {
  const v = Number.isInteger(raw?.version) ? raw.version : 1;
  let data = raw;
  for (let n = v; n < CONFIG_SPEC.current; n++) {
    const step = CONFIG_SPEC.migrations?.[n];
    if (step) data = step(data);
  }
  return data;
}

interface Entry {
  run: Run;
  newKey: string;
  projectKey: string;
  status: RunStatus;
  note?: string;
  reset?: boolean;
}

function planImport(runs: Run[], registered: string[], report: MigrateReport): { projects: { key: string; repo: string }[]; entries: Entry[] } {
  const projects = new Map<string, { key: string; repo: string; counts: Map<string, number> }>();
  const taken = new Set<string>();
  const entries: Entry[] = [];
  const usedKeys = new Set<string>();
  const sorted = [...runs].sort((a, b) => a.createdAt - b.createdAt);
  for (const r of sorted) {
    const m = KEY_RE.exec(r.key);
    if (!m) {
      report.warnings.push(`skipped ${String(r.key).slice(0, 40)}: not a valid card key`);
      continue;
    }
    const prefix = m[1]!;
    const repo = REPO_NAME_RE.test(r.repo ?? '') && registered.includes(r.repo) ? r.repo : '';
    let projKey = /^[A-Z]{2,6}$/.test(prefix) ? prefix : deriveProjectKey(repo || prefix, taken);
    let p = projects.get(projKey);
    if (!p) {
      p = { key: projKey, repo, counts: new Map() };
      projects.set(projKey, p);
      taken.add(projKey);
    }
    p.counts.set(repo, (p.counts.get(repo) ?? 0) + 1);
    // keep the key when its prefix IS the project key; otherwise re-key (the original stays as `external.key` / legacy.v1Key)
    let newKey = projKey === prefix ? r.key : `${projKey}-${m[2]}`;
    for (let i = 1; usedKeys.has(newKey); i++) newKey = `${projKey}-${Number(m[2]) + 100000 * i}`;
    usedKeys.add(newKey);
    let status: RunStatus = r.status;
    let note: string | undefined;
    let reset = false;
    if (status === 'queued' || status === 'running' || status === 'paused' || status === 'failed') {
      status = 'needs_human';
      reset = true;
      note = `This run was still active in v1 (${r.status}) when it was imported. v2 never starts the same work twice — press Retry to run it again in v2.`;
    } else if (r.untrusted) note = 'The description of this card was never verified (it was picked up because it was assigned to you): its plan needs your approval.';
    entries.push({ run: r, newKey, projectKey: projKey, status, note, reset });
  }
  // a project's repository = the one most of its runs used
  const outProjects = [...projects.values()].map((p) => {
    let best = p.repo;
    let n = -1;
    for (const [repo, c] of p.counts) if (c > n) { best = repo; n = c; }
    return { key: p.key, repo: best };
  });
  return { projects: outProjects, entries };
}
