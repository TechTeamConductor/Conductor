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
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { NextStep, RepoConfig, Run, RunStatus } from './types.ts';
import { Board } from './board/index.ts';
import { laneForRun } from './board/lanes.ts';
import { BRANCH_PREFIX } from './git/worktree.ts';
import { CONFIG_SPEC, normalizeConfig } from './config.ts';
import { RUN_SCHEMA_VERSION, RunStore } from './store.ts';
import { migrateRunV1ToV2, migrateRunV2ToV3 } from './schema/run-migrations.ts';
import { loadVersioned } from './schema/version.ts';
import { backupPaths } from './schema/backup.ts';
import { redact } from './redact.ts';
import { sha256, slug, atomicWriteFile, truncate } from './util.ts';
import { deriveProjectKey } from './pipeline/engine.ts';
import { HOME_SKELETON } from './paths.ts';

const KEY_RE = /^([A-Za-z][A-Za-z0-9]{0,15})-(\d{1,9})$/;
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ARTIFACT_RE = /^(plan-\d+\.(json|md)|review-\d+\.json|verdict-\d+\.json|gates-\d+\.json|baseline\.json|events\.ndjson(\.1)?)$/;
/** v1 data is untrusted INPUT (security review C-3): regular files only, bounded size, validated fields. */
const JSON_CAP = 8 * 1024 * 1024;
const ARTIFACT_CAP = 50 * 1024 * 1024;
const MAX_KEY_NUMBER = 99_999_999;
const STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'awaiting_approval', 'needs_human', 'paused', 'parked', 'ready', 'aborted', 'failed', 'finished']);
const NEXT_STEPS: ReadonlySet<string> = new Set(['plan', 'plan_review', 'approval', 'build', 'verify', 'none']);

export interface MigrateOptions {
  from: string;
  to: string;
  /** false = dry run: read, plan and validate in memory; nothing is written anywhere. */
  apply: boolean;
  now?: () => number;
  backupRoot?: string;
  /** Test seam: called at named points (a test can throw, mutate v1 or SIGKILL the process here). */
  hooks?: { at?: (point: 'read' | 'staged' | 'validated' | 'before-publish' | 'parsed', detail?: string) => void };
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
  /** C-5: what the imported config will EXECUTE as you (gates, setup, agent binaries …) — show it before apply. */
  willRun?: { repos: { name: string; path: string; gates: string[]; setup?: string; envPassthrough: string[]; copyFiles: string[] }[]; agentBins: { claude: string; cursor: string } };
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

function fsyncFile(p: string): void {
  const fd = openSync(p, 'r'); // works for directories too on POSIX
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Leftovers of an earlier crashed/killed import: siblings named `<to>.staging-…` that carry our marker are removed (nothing else is ever touched). */
function sweepStaleStaging(to: string): void {
  const parent = dirname(to);
  const prefix = `${basename(to)}.staging-`;
  let names: string[] = [];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const p = join(parent, n);
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      const marker = JSON.parse(readFileSync(join(p, 'home.json'), 'utf8'));
      if (marker?.kind === 'conductor-home' && typeof marker.importedFrom === 'string') rmSync(p, { recursive: true, force: true });
    } catch {
      /* not ours: leave it */
    }
  }
}

function hashFile(p: string): string {
  return sha256(readFileSync(p));
}

/** The real path of `p`, even when it (or its tail) does not exist yet: realpath of the deepest existing ancestor + the rest. */
function realish(p: string): string {
  const abs = resolve(p);
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return abs;
      rest.push(cur.slice(up.length + 1));
      cur = up;
    }
  }
}
const isInside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

type Stat = { ok: true; size: number } | { ok: false; why: string };
/** A v1 path we are willing to read: an existing REGULAR file (no symlink, FIFO, device) within the cap. */
function readable(p: string, cap: number): Stat {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return { ok: false, why: 'missing' };
  }
  if (st.isSymbolicLink()) return { ok: false, why: 'a symbolic link (never followed)' };
  if (!st.isFile()) return { ok: false, why: 'not a regular file' };
  if (st.size > cap) return { ok: false, why: `larger than ${Math.round(cap / 1024 / 1024)} MB` };
  return { ok: true, size: st.size };
}

/** An entry is the empty skeleton a v2 start creates (and nothing else): safe to replace. */
function isEmptySkeleton(dir: string): boolean {
  try {
    for (const n of readdirSync(dir)) {
      if (n.startsWith('.')) continue;
      if (n === 'home.json') continue;
      if (!HOME_SKELETON.has(n)) return false;
      if (readdirSync(join(dir, n)).length > 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}
/** Remove an (already verified) empty skeleton directory by directory — never recursively. */
function clearSkeleton(dir: string): void {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (n === 'home.json') rmSync(p);
    else rmdirSync(p);
  }
  rmdirSync(dir);
}

/** A target that may be (re)used: absent, or a v2 skeleton that holds nothing yet. */
function checkTarget(to: string): { replaceEmpty: boolean } {
  if (!existsSync(to)) return { replaceEmpty: false };
  const entries = readdirSync(to).filter((n) => !n.startsWith('.'));
  const data = entries.filter((n) => {
    if (n === 'home.json') return false;
    if (!HOME_SKELETON.has(n)) return true;
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
  // C-1: by REAL path (symlinks resolved), neither folder may contain the other — the importer writes a staging sibling and the target,
  // and v1 must never be written to.
  {
    const rf = realish(from);
    const rt = realish(to);
    if (isInside(rt, rf) || isInside(rf, rt) || isInside(dirname(rt), rf)) {
      throw new MigrateError('overlap', `--from (${from}) and --to (${to}) overlap: one is inside the other. The v1 folder is never written to — choose a --to outside it.`);
    }
  }
  if (existsSync(join(from, 'home.json'))) throw new MigrateError('already_v2', `${from} is already a v2 data folder.`);
  if (!existsSync(join(from, 'config.json')) && !existsSync(join(from, 'runs'))) throw new MigrateError('not_v1', `${from} does not look like a Conductor v1 data folder (no config.json, no runs/).`);
  const { replaceEmpty } = checkTarget(to);

  const report: MigrateReport = { dryRun: !opts.apply, from, to, runs: [], projects: [], repos: [], warnings: [], changedDuringImport: [] };

  // ── 1. read v1, read-only, remembering a hash of every file we read (K7 i). v1 data is untrusted INPUT (C-3).
  const readHashes = new Map<string, string>();
  const remember = (p: string, buf: Buffer): void => void readHashes.set(p, sha256(buf));
  const readText = (p: string, cap: number): string => {
    const buf = readFileSync(p);
    remember(p, buf);
    return buf.toString('utf8');
  };
  let v1Config: any = {};
  const cfgPath = join(from, 'config.json');
  if (existsSync(cfgPath) || lstatExists(cfgPath)) {
    const ok = readable(cfgPath, JSON_CAP);
    if (!ok.ok) throw new MigrateError('bad_config', `${cfgPath} cannot be imported (${ok.why}); nothing was changed.`);
    try {
      v1Config = JSON.parse(readText(cfgPath, JSON_CAP));
    } catch (e) {
      throw new MigrateError('bad_config', `${cfgPath} cannot be read as JSON (${(e as Error).message}); nothing was changed.`);
    }
    if (!v1Config || typeof v1Config !== 'object' || Array.isArray(v1Config)) throw new MigrateError('bad_config', `${cfgPath} is not a JSON object; nothing was changed.`);
  }
  const cfg = normalizeConfig(loadVersionedInMemory(v1Config, cfgPath));
  report.repos = cfg.repos.map((r) => r.name);
  report.willRun = willRun(cfg.repos, cfg.agents);
  let v1State: any = {};
  const statePath = join(from, 'state.json');
  if (lstatExists(statePath)) {
    const ok = readable(statePath, JSON_CAP);
    if (!ok.ok) report.warnings.push(`state.json was not imported (${ok.why}); first-plan approval counters start from zero.`);
    else {
      try {
        v1State = JSON.parse(readText(statePath, JSON_CAP));
      } catch {
        report.warnings.push('state.json could not be read; first-plan approval counters start from zero.');
      }
    }
  }
  const runsDir = join(from, 'runs');
  const runsListing = listRunsDir(runsDir, report);
  const v1Runs: Run[] = [];
  const artifactDirs = new Map<string, string[]>();
  for (const name of runsListing) {
    const dir = join(runsDir, name);
    const runFile = join(dir, 'run.json');
    const ok = readable(runFile, JSON_CAP);
    if (!ok.ok) {
      report.warnings.push(`skipped run ${name}: run.json is ${ok.why}`);
      continue;
    }
    let raw: any;
    try {
      raw = JSON.parse(readText(runFile, JSON_CAP));
    } catch {
      report.warnings.push(`skipped run ${name}: run.json is not valid JSON`);
      continue;
    }
    opts.hooks?.at?.('parsed', name);
    const run = coerceV1Run(raw, name, report);
    if (!run) continue;
    v1Runs.push(run);
    const names: string[] = [];
    for (const n of readdirSync(dir)) {
      if (!ARTIFACT_RE.test(n)) continue;
      const a = readable(join(dir, n), ARTIFACT_CAP);
      if (!a.ok) {
        report.warnings.push(`run ${name}: artifact ${n} was not imported (${a.why})`);
        continue;
      }
      try {
        remember(join(dir, n), readFileSync(join(dir, n)));
      } catch (e) {
        report.warnings.push(`run ${name}: artifact ${n} was not imported (${(e as NodeJS.ErrnoException).code ?? 'unreadable'})`);
        continue;
      }
      names.push(n);
    }
    artifactDirs.set(run.key, names);
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

  sweepStaleStaging(to);
  // backup first: a copy of exactly what the importer reads (config, state, runs) — outside both homes, verified
  const sources = [cfgPath, statePath, join(from, 'runs')].filter((p) => existsSync(p));
  const backup = backupPaths(sources, { root: opts.backupRoot, label: 'migrate-v1-to-v2', now, maxFileBytes: ARTIFACT_CAP, keep: (abs) => !abs.startsWith(runsDir + sep) || /\/(run\.json|plan-\d+\.(json|md)|review-\d+\.json|verdict-\d+\.json|gates-\d+\.json|baseline\.json|events\.ndjson(\.1)?)$/.test(abs) });
  report.backupDir = backup.dir;
  for (const s of backup.skipped) report.warnings.push(`backup skipped ${s.path}: ${s.why}`);

  try {
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    for (const d of ['runs', 'logs', 'run']) mkdirSync(join(staging, d), { recursive: true, mode: 0o700 });
    atomicWriteFile(join(staging, 'home.json'), JSON.stringify({ kind: 'conductor-home', generation: 2, createdAt: now(), importedFrom: from }) + '\n', 0o600, { durable: true });

    // config v3 (legacy.linear preserved) + state
    const outCfg = { ...cfg, ui: { ...cfg.ui, port: cfg.ui.port === 4317 ? 4327 : cfg.ui.port } }; // v1's default port is v1's: v2 and v1 run side by side
    atomicWriteFile(join(staging, 'config.json'), JSON.stringify({ ...(cfg.extra ?? {}), ...stripExtra(outCfg) }, null, 2) + '\n', 0o600, { durable: true });
    const repos: Record<string, { approvedPlans: number }> = {};
    for (const [k, v] of Object.entries((v1State?.repos ?? {}) as Record<string, any>)) if (REPO_NAME_RE.test(k) && Number.isFinite(v?.approvedPlans)) repos[k] = { approvedPlans: Math.max(0, Math.floor(v.approvedPlans)) };
    atomicWriteFile(join(staging, 'state.json'), JSON.stringify({ repos, schemaVersion: 1 }, null, 2) + '\n', 0o600, { durable: true });

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
          // C-4: nothing inherited from v1 vouches for this card in v2 — every import is unverified text, v1's approval is dropped, and a
          // Retry of a parked card starts at the PLAN (never straight at a build from the imported plan), so approval is asked for again.
          untrusted: true,
          planApproved: false,
          approvedBy: undefined,
          // …and whatever the status (a v1 "Park in Backlog" keeps the old needsHuman + parkedFrom), no import can resume at a later stage (R-1)
          needsHuman: e.status === 'needs_human' ? { reason: e.reset ? e.note ?? 'Imported while in progress' : e.run.needsHuman?.reason ?? 'Imported from v1', origin: 'plan', at: now() } : e.run.needsHuman ? { ...e.run.needsHuman, origin: 'plan' } : undefined,
          parkedFrom: undefined,
          legacy: { ...(e.run.legacy ?? {}), v1Key: e.run.key }, // v1Branch / v1Worktree / v1BaseSha / v1CommitSha were set aside by the run migration
        };
        store.create(migrated);
        const srcDir = join(from, 'runs', e.run.key);
        const dstDir = join(staging, 'runs', e.newKey);
        for (const n of artifactDirs.get(e.run.key) ?? []) {
          copyFileSync(join(srcDir, n), join(dstDir, n));
          chmodSync(join(dstDir, n), 0o600); // C-6: never inherit v1's file modes
          fsyncFile(join(dstDir, n));
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
    if (listRunsDir(runsDir, { warnings: [] } as unknown as MigrateReport).join('\0') !== runsListing.join('\0')) report.changedDuringImport.push(`${runsDir} (a run was added or removed)`);
    if (report.changedDuringImport.length) {
      throw new MigrateError('changed_during_import', `${report.changedDuringImport.length} v1 file(s) changed while importing (v1 is probably running). Nothing was published — run migrate again.`);
    }

    // make the staged tree itself durable before the rename that publishes it
    for (const d of [join(staging, 'runs'), join(staging, 'board'), join(staging, 'logs'), join(staging, 'run'), staging]) {
      try {
        fsyncFile(d);
      } catch {
        /* a filesystem that cannot fsync a directory: the files are durable on their own */
      }
    }
    for (const n of readdirSync(join(staging, 'runs'))) {
      try {
        fsyncFile(join(staging, 'runs', n));
      } catch {
        /* same */
      }
    }

    opts.hooks?.at?.('before-publish');
    // publish. An absent target: ONE rename. An empty-skeleton target (v2 was started once): it is renamed ASIDE first (atomic),
    // re-checked, the staging folder renamed into place, and the aside removed — never cleared in place (C-2: a v2 that starts in
    // this window keeps its folder intact because the re-check fails and the rename is rolled back).
    if (replaceEmpty) {
      const aside = `${to}.old-${stamp}`;
      renameSync(to, aside);
      try {
        if (!isEmptySkeleton(aside)) throw new MigrateError('target_changed', `${to} stopped being empty while importing (a v2 was probably started). Nothing was changed.`);
        renameSync(staging, to);
      } catch (e) {
        if (!existsSync(to)) renameSync(aside, to);
        else if (isEmptySkeleton(to)) {
          clearSkeleton(to);
          renameSync(aside, to);
        } else report.warnings.push(`the original ${to} is at ${aside} — move it back by hand`);
        throw e;
      }
      try {
        clearSkeleton(aside);
      } catch {
        report.warnings.push(`could not remove the old empty folder ${aside}; it is safe to delete`);
      }
    } else {
      renameSync(staging, to);
    }
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

/** v1/v2 configs → run through the same migrations the loader uses, in memory. The stamp is validated like the real loader does (C-3). */
function loadVersionedInMemory(raw: any, path: string): any {
  let v = 1;
  if (raw?.version !== undefined) {
    if (!Number.isInteger(raw.version) || raw.version < 1) throw new MigrateError('bad_config', `${path}: "version" must be a whole number of at least 1; nothing was changed.`);
    v = raw.version;
  }
  if (v > CONFIG_SPEC.current) throw new MigrateError('bad_config', `${path} was written by a newer Conductor (config version ${v}); nothing was changed.`);
  let data = raw;
  for (let n = v; n < CONFIG_SPEC.current; n++) {
    const step = CONFIG_SPEC.migrations?.[n];
    if (step) data = step(data);
  }
  return data;
}

function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The names of the real run directories in v1's runs/ (no symlinks, no files, only card-shaped names). Sorted. */
function listRunsDir(runsDir: string, report: MigrateReport): string[] {
  if (!lstatExists(runsDir)) return [];
  const st = lstatSync(runsDir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    report.warnings.push('runs/ is not a plain directory (symbolic link or file) — no runs were imported.');
    return [];
  }
  const out: string[] = [];
  for (const n of readdirSync(runsDir)) {
    if (n.startsWith('.')) continue;
    const e = lstatSync(join(runsDir, n));
    if (e.isSymbolicLink() || !e.isDirectory()) {
      report.warnings.push(`skipped runs/${n.slice(0, 40)}: not a plain directory`);
      continue;
    }
    if (!KEY_RE.test(n)) {
      report.warnings.push(`skipped runs/${n.slice(0, 40)}: not a valid card key`);
      continue;
    }
    out.push(n);
  }
  return out.sort();
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * One v1 run record → a validated v2-shaped Run, or null (skipped with a warning). The key comes from the DIRECTORY NAME and must
 * equal the record's own key; every field the importer interprets is type-checked, so one hostile run never blocks the others (C-3).
 */
function coerceV1Run(raw: unknown, dirName: string, report: MigrateReport): Run | null {
  if (!isPlain(raw)) {
    report.warnings.push(`skipped run ${dirName}: run.json is not an object`);
    return null;
  }
  if (raw.key !== dirName) {
    report.warnings.push(`skipped run ${dirName}: its run.json names a different card`);
    return null;
  }
  const ver = raw.schemaVersion === undefined ? 1 : raw.schemaVersion;
  if (!Number.isInteger(ver) || (ver as number) < 1) {
    report.warnings.push(`skipped run ${dirName}: schemaVersion is not a whole number of at least 1`);
    return null;
  }
  if ((ver as number) > RUN_SCHEMA_VERSION) {
    report.warnings.push(`skipped run ${dirName}: written by a newer Conductor (record version ${String(ver)})`);
    return null;
  }
  const title = str(raw.title, 400);
  const description = raw.description === undefined ? '' : str(raw.description, 200_000);
  if (title === null || description === null) {
    report.warnings.push(`skipped run ${dirName}: title/description are not text`);
    return null;
  }
  if (!Array.isArray(raw.history) && raw.history !== undefined) {
    report.warnings.push(`skipped run ${dirName}: history is not a list`);
    return null;
  }
  let m: any = { ...raw, schemaVersion: ver };
  if ((ver as number) < 2) m = migrateRunV1ToV2(m);
  if ((ver as number) < 3) m = migrateRunV2ToV3(m);
  const history = (Array.isArray(m.history) ? m.history : []).filter((h: any) => isPlain(h) && Number.isFinite(h.ts) && typeof h.text === 'string').map((h: any) => ({ ts: h.ts as number, text: String(h.text).slice(0, 2000) }));
  const createdAt = Number.isFinite(m.createdAt) ? (m.createdAt as number) : 0;
  const repo = typeof m.repo === 'string' ? m.repo : '';
  let status = m.status as string;
  let unknownStatus = false;
  if (typeof status !== 'string' || !STATUSES.has(status)) {
    unknownStatus = true;
    status = 'needs_human';
  }
  const next = typeof m.next === 'string' && NEXT_STEPS.has(m.next) ? (m.next as NextStep) : 'none';
  return {
    ...m,
    key: dirName,
    title,
    description,
    history,
    createdAt,
    repo,
    status: status as RunStatus,
    next,
    sessions: Array.isArray(m.sessions) ? m.sessions : [],
    // a v1 record must never aim Conductor's own board effects at another card: bug→card links are dropped whatever the record's version (R-2)
    bugs: Array.isArray(m.bugs) ? m.bugs.filter(isPlain).map((b: any) => ({ ...b, itemId: undefined, itemKey: undefined })) : [],
    legacy: isPlain(m.legacy) ? { ...m.legacy, ...(unknownStatus ? { v1Status: String(raw.status).slice(0, 40) } : {}) } : unknownStatus ? { v1Status: String(raw.status).slice(0, 40) } : undefined,
  } as Run;
}

/** C-5: everything the imported config will execute as the user, spelled out for the dry run and the apply summary. */
function willRun(repos: RepoConfig[], agents: { claude: { bin: string }; cursor: { bin: string } }): NonNullable<MigrateReport['willRun']> {
  return {
    repos: repos.map((r) => ({
      name: r.name,
      path: r.path,
      gates: (r.gates ?? []).map((g) => g.cmd),
      setup: r.setup,
      envPassthrough: [...(r.envPassthrough ?? [])],
      copyFiles: [...(r.copyFiles ?? [])],
    })),
    agentBins: { claude: agents.claude.bin, cursor: agents.cursor.bin },
  };
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
    if (Number(m[2]) > MAX_KEY_NUMBER) {
      report.warnings.push(`skipped ${r.key}: its number is unreasonably large`);
      continue;
    }
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
    if (r.legacy && typeof (r.legacy as any).v1Status === 'string') {
      status = 'needs_human';
      reset = true;
      note = `v1 recorded an unknown status ("${String((r.legacy as any).v1Status)}") for this run, so it is parked for you.`;
    }
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
