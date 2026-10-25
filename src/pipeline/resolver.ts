// Stuck resolver (Complete auto only). Called from `Stages.toNeedsHuman`, before a card is shown as stuck.
//
// The model sees redacted, truncated, FENCED facts and returns ONE typed action from a closed list. It is untrusted: this module validates
// every field in code, applies the action in ONE run write (marker cleared, `next` set, no stuck card/comment/notification), and on
// `give_up` / anything invalid / a model failure hands back an analysis so the caller parks the card exactly as before.
//
// What this module can NOT do (a static test enforces it): import from server/, config writers, board lane writers, or the push functions
// of ship.ts; call `toNeedsHuman`; touch identity, the push target, or any config. The scan, identity check, default-branch refusal, scope
// guard and force-push ban live elsewhere and no action here reaches them. Commit-changing actions re-scan the range before they apply.
import type { Config, NextStep, Run } from '../types.ts';
import type { Role } from '../agents/roles.ts';
import { isRole } from '../agents/roles.ts';
import { isProviderId } from '../agents/providers/static.ts';
import { validateSchema } from '../agents/json.ts';
import { redact } from '../redact.ts';
import { sha1, truncate } from '../util.ts';
import { effectiveResolve } from '../policy/policy.ts';
import { fixtureContentHold, fixtureRewriteNote, testOrFixturePath } from '../git/fixture-hold.ts';
import { git } from '../git/exec.ts';
import { applyEdits, safeEditPath } from '../git/ship.ts';
import { scanPushRange, type ScanEnvEntry } from '../git/branchscan.ts';
import { fence, loadTemplate, preamble, render } from './prompts.ts';
import { RESOLVER_SCHEMA } from './schemas.ts';
import * as L from './resolver-limits.ts';

const SHA_RE = /^[0-9a-f]{40}$/;

// ───────────────────────────── types ─────────────────────────────
export type ResolverAction =
  | { action: 'retry_stage'; origin: 'build' | 'verify' | 'plan_review' | 'ship' }
  | { action: 'replan'; feedback: string }
  | { action: 'rebuild'; bugs: { title: string; detail: string; file?: string }[] }
  | { action: 'accept_baseline' }
  | { action: 'rewrite_to_placeholder'; paths: string[] }
  | { action: 'revert_paths'; paths: string[] }
  | { action: 'exclude_from_push'; paths: string[] }
  | { action: 'switch_route'; role: Role; provider: string }
  | { action: 'extend_budget'; kind: 'runs' | 'loops' }
  | { action: 'wait'; minutes: number }
  | { action: 'give_up'; reason: string };

export type ResolverCall = { kind: 'ok'; json: unknown } | { kind: 'failed'; reason: string } | { kind: 'handled' };

export type ScanHook = (o: { repoRoot: string; tip: string; excludeTips: string[]; envEntries: ScanEnvEntry[] }) => Promise<{ ok: true } | { ok: false; reason: string }>;

/** Everything the resolver needs from the stage runner. Narrow on purpose: it cannot reach config, lanes, identity or push. */
export interface ResolverHost {
  cfg(): Config;
  run(key: string): Run;
  patch(key: string, fn: (r: Run) => void): Run;
  now(): number;
  secrets(run: Run): string[];
  scanEntries(run: Run): ScanEnvEntry[];
  repoPath(run: Run): string | null;
  readArtifact<T>(key: string, name: string, fallback: T): T;
  /** The read-only structured call (`callReadOnly`, counted in `agentRuns`). `handled` = the host already applied a pause/offline hold or the job was aborted. */
  call(key: string, prompt: string): Promise<ResolverCall>;
  enginePaused(): boolean;
  /** Resolver model calls across all cards in the last hour. */
  hourly: { count(now: number): number; record(now: number): void };
  /** Pause one account for a while (the engine's own in-memory limit pause) so the router falls to the next configured tool. */
  pauseAccount(ref: { provider: string; id: string }, until: number, reason: string): void;
  runsLimit(run: Run): number;
  /** The scan hook of the push side (re-scan after a commit-changing action). Default: `scanPushRange`. */
  rescan?: ScanHook;
  aborted(key: string): boolean;
  note(key: string, text: string): void;
}

export type ResolverOutcome =
  | { kind: 'skipped' }
  | { kind: 'handled' }
  | { kind: 'applied'; action: ResolverAction['action'] }
  | { kind: 'declined'; analysis: string };

// ───────────────────────────── causes and the ONE round rule ─────────────────────────────

/**
 * A stable label for a stop, recognised in code from static wording (call sites may pass an explicit cause instead). It only routes: a
 * non-resolvable label skips the resolver, any other label is a counter key. It never grants anything.
 */
export function classifyCause(reasonRaw: string): string {
  const r = reasonRaw.toLowerCase();
  if (/restarted 5 times|restarted five times/.test(r)) return 'restart_guard';
  if (/could not tell which repository|still no repository|no repository/.test(r)) return 'no_repo';
  if (/description changed|no longer exists on the board|card for this run/.test(r)) return 'integrity';
  if (/tampered|will not discard|is not registered|cannot be verified|foreign/.test(r)) return 'human_hold';
  if (/secret|credential-shaped|refused to commit/.test(r)) return 'secret_scan';
  if (/did not list|out of scope|protected file/.test(r)) return 'scope';
  if (/loop limit/.test(r)) return 'loop_limit';
  if (/limit of \d+ agent runs/.test(r)) return 'run_limit';
  if (/without changing any files|made no changes|nothing to verify/.test(r)) return 'empty_build';
  if (/merge|conflict|untracked/.test(r)) return 'merge_conflict';
  if (/verifier did not pass|found nothing the builder can fix/.test(r)) return 'verify_fail';
  if (/not every task|task graph/.test(r)) return 'graph_failed';
  if (/plan artifact|plan is missing|plan review/.test(r)) return 'plan_problem';
  if (/sign in|signed in|not signed|login|could not start|isolation|auth/.test(r)) return 'agent_start';
  if (/gate|baseline/.test(r)) return 'gate';
  return 'other';
}

/**
 * THE round rule (persisted on the run, so it survives restarts): at most 3 invocations per card, 1 per (cause, origin), 2 per cause.
 * An action that re-enters the stop for the same (cause, origin) is refused here, so resolver -> stop -> resolver always terminates.
 */
export function roundLimit(run: Pick<Run, 'resolverUsed' | 'resolverRounds' | 'resolverCauseUsed'>, cause: string, origin: NextStep): string | null {
  if ((run.resolverUsed ?? 0) >= L.RESOLVER_MAX_PER_CARD) return 'the resolver already worked on this card the most times it may';
  const pair = (run.resolverRounds ?? []).filter((x) => x === `${cause}:${origin}`).length;
  if (pair >= L.RESOLVER_MAX_PER_PAIR) return 'the resolver already tried this cause at this stage';
  if ((run.resolverCauseUsed?.[cause] ?? 0) >= L.RESOLVER_MAX_PER_CAUSE) return 'the resolver already tried this cause as often as it may';
  return null;
}

/** Why the resolver must NOT run now, or null. Cheap and synchronous: nothing has been written yet. */
export function admission(host: ResolverHost, run: Run, cause: string, origin: NextStep): string | null {
  const now = host.now();
  if (!effectiveResolve(host.cfg(), run)) return 'not in Complete auto, or the card budget is spent';
  if (run.status !== 'running' && run.status !== 'queued') return `the card is ${run.status}`; // a parked (person-held) card is never touched
  if (L.NON_RESOLVABLE_CAUSES.includes(cause)) return 'a cause only a person or the engine can change';
  if (run.resolverActive) return 'a resolver call is already in flight for this card';
  const rounds = roundLimit(run, cause, origin);
  if (rounds) return rounds;
  if (host.enginePaused()) return 'the engine is paused';
  if ((run.restartTimes ?? []).filter((t) => now - t < 3_600_000).length >= L.RESTART_GUARD) return 'too many restarts in the last hour';
  if (run.agentRuns >= host.runsLimit(run)) return 'the card used its agent-run limit';
  if ((run.resolverRuns ?? 0) >= L.RESOLVER_MAX_AGENT_RUNS) return 'the resolver used its quota on this card';
  if (host.hourly.count(now) >= L.RESOLVER_MAX_PER_HOUR) return 'the hourly resolver cap is reached';
  return null;
}

// ───────────────────────────── paths ─────────────────────────────

/** Repo-relative, no `..`/absolute/`.git`/`.conductor`/`.cursor`, no control characters. (Symlinks and gitlinks are refused where the tree is read.) */
export function resolverPathOk(p: unknown): p is string {
  if (typeof p !== 'string' || !p || p.length > 400 || /[\x00-\x1f\x7f]/.test(p)) return false;
  if (p.startsWith('./') || p.endsWith('/')) return false;
  if (!safeEditPath(p)) return false;
  return !p.split('/').some((s) => s.toLowerCase() === '.git' || s === '.conductor' || s === '.cursor' || s.toLowerCase() === '.gitmodules');
}

function rangeTip(run: Run): string | undefined {
  const tip = run.shipSha && run.shipBase === run.commitSha ? run.shipSha : run.commitSha;
  return tip && SHA_RE.test(tip) ? tip : undefined;
}

async function diffFiles(repoRoot: string, base: string, tip: string): Promise<string[] | null> {
  if (!SHA_RE.test(base) || !SHA_RE.test(tip)) return null;
  const r = await git(repoRoot, ['diff', '--name-only', '-z', '--no-renames', '--no-color', '--no-ext-diff', base, tip], { maxBytes: 4 * 1024 * 1024 });
  if (r.code !== 0 || r.stdoutTruncated) return null;
  return r.stdout.split('\0').filter(Boolean);
}

// ───────────────────────────── validation (untrusted model output) ─────────────────────────────

export interface ValidationCtx {
  run: Run;
  cfg: Config;
  /** The run's own recorded diff (plus, for a placeholder rewrite, the scan-flagged fixture paths parsed by code). */
  allowed: ReadonlySet<string>;
  /** Paths the stop reason itself names as scan-flagged fixtures (parsed by code, never from the model). A placeholder rewrite may only touch these. */
  flagged?: ReadonlySet<string>;
}

const cap = (s: unknown, n: number, secrets: readonly string[]): string => redact(truncate(String(s ?? '').replace(/\r\n/g, '\n'), n), secrets).trim();

function pathsOf(o: Record<string, unknown>, ctx: ValidationCtx): string[] | string {
  const raw = o.paths;
  if (!Array.isArray(raw) || raw.length === 0) return 'paths are required';
  if (raw.length > L.MAX_PATHS) return 'too many paths';
  const out: string[] = [];
  for (const p of raw) {
    if (!resolverPathOk(p)) return 'a path is not a plain repo-relative path';
    if (!ctx.allowed.has(p)) return 'a path is not in this run\'s own change';
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Closed enum + per-action argument checks. Returns the action, or why it is refused (the caller then falls through to the park code). */
export function validateAction(json: unknown, ctx: ValidationCtx, secrets: readonly string[] = []): { ok: true; action: ResolverAction; analysis: string } | { ok: false; why: string; analysis: string } {
  const errs = validateSchema(RESOLVER_SCHEMA, json);
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const analysis = cap(o.analysis, 600, secrets);
  if (errs.length) return { ok: false, why: `the reply did not match the format (${errs[0]})`, analysis };
  const bad = (why: string) => ({ ok: false as const, why, analysis });
  const run = ctx.run;
  switch (o.action) {
    case 'retry_stage': {
      const origin = o.origin;
      if (origin !== 'build' && origin !== 'verify' && origin !== 'plan_review' && origin !== 'ship') return bad('retry_stage needs a known stage');
      if ((origin === 'verify' || origin === 'ship') && !run.commitSha) return bad('there is nothing built to verify yet');
      if (origin === 'plan_review' && !run.planReviewDone && run.next !== 'plan_review') return bad('there is no plan to review');
      return { ok: true, action: { action: 'retry_stage', origin }, analysis };
    }
    case 'replan': {
      const feedback = cap(o.feedback, L.MAX_TEXT, secrets);
      if (!feedback) return bad('replan needs feedback');
      if (run.graph || run.commitSha) return bad('a plan can only be redone before anything was built');
      return { ok: true, action: { action: 'replan', feedback }, analysis };
    }
    case 'rebuild': {
      const raw = o.bugs;
      if (!Array.isArray(raw) || !raw.length || raw.length > L.MAX_BUGS) return bad('rebuild needs 1 to 6 problems');
      if (run.graph?.final === 'pending') return bad('tasks are still being built one by one; retry the stage instead');
      if (run.loop >= run.loopBudget) return bad('no build/verify loop is left (extend_budget is the way)');
      const bugs: { title: string; detail: string; file?: string }[] = [];
      for (const b of raw) {
        const r = (b ?? {}) as Record<string, unknown>;
        const title = cap(r.title, 160, secrets);
        const detail = cap(r.detail, 700, secrets);
        if (!title || !detail) return bad('a problem needs a title and a detail');
        const file = typeof r.file === 'string' && r.file ? (resolverPathOk(r.file) ? r.file : undefined) : undefined;
        if (typeof r.file === 'string' && r.file && !file) return bad('a problem names an unusable file');
        bugs.push({ title, detail, ...(file ? { file } : {}) });
      }
      return { ok: true, action: { action: 'rebuild', bugs }, analysis };
    }
    case 'accept_baseline':
      return { ok: true, action: { action: 'accept_baseline' }, analysis };
    case 'rewrite_to_placeholder': {
      const paths = pathsOf(o, ctx);
      if (typeof paths === 'string') return bad(paths);
      if (!paths.every((p) => testOrFixturePath(p))) return bad('only test or fixture files can be rewritten to placeholders');
      if (!paths.every((p) => ctx.flagged?.has(p))) return bad('only files the secret scan flagged can be rewritten to placeholders');
      if ((run.resolverRewrites ?? 0) >= 1) return bad('the placeholder rewrite was already used on this card');
      if (run.graph?.final === 'pending') return bad('tasks are still being built one by one; retry the stage instead');
      return { ok: true, action: { action: 'rewrite_to_placeholder', paths }, analysis };
    }
    case 'revert_paths':
    case 'exclude_from_push': {
      const paths = pathsOf(o, ctx);
      if (typeof paths === 'string') return bad(paths);
      if (!run.commitSha) return bad('there are no recorded commits to change');
      if (run.pushedAt) return bad('the commits are already published');
      return { ok: true, action: { action: o.action, paths } as ResolverAction, analysis };
    }
    case 'switch_route': {
      const role = o.role;
      const provider = o.provider;
      if (!isRole(role) || !isProviderId(provider)) return bad('switch_route needs a configured role and tool');
      const chain = ctx.cfg.roles?.[role]?.providers ?? [];
      if (chain.length < 2 || !chain.includes(provider)) return bad('that tool is not configured for that role');
      if (!run.account || !chain.includes(run.account.provider as never) || run.account.provider === provider) return bad('there is no failing tool to move away from');
      return { ok: true, action: { action: 'switch_route', role, provider }, analysis };
    }
    case 'extend_budget': {
      const kind = o.kind;
      if (kind !== 'runs' && kind !== 'loops') return bad('extend_budget needs a kind');
      if (run.resolverExtended?.[kind] !== undefined) return bad(`${kind} were already extended once on this card`);
      return { ok: true, action: { action: 'extend_budget', kind }, analysis };
    }
    case 'wait': {
      const m = o.minutes;
      if (typeof m !== 'number' || !Number.isFinite(m)) return bad('wait needs minutes');
      return { ok: true, action: { action: 'wait', minutes: Math.min(L.WAIT_MAX_MINUTES, Math.max(1, Math.floor(m))) }, analysis };
    }
    case 'give_up':
      return { ok: true, action: { action: 'give_up', reason: cap(o.reason, 400, secrets) }, analysis };
    default:
      return bad('unknown action');
  }
}

// ───────────────────────────── the commit-range edit (exclude_from_push, revert_paths) ─────────────────────────────

interface Info {
  sha: string;
  parents: string[];
  env: Record<string, string>;
  message: string;
}

async function infoOf(repoRoot: string, sha: string): Promise<Info | null> {
  const r = await git(repoRoot, ['log', '--no-walk', '--no-color', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%B', sha]);
  if (r.code !== 0) return null;
  const f = r.stdout.replace(/\n$/, '').split('\x1f');
  if (f.length < 9) return null;
  return {
    sha: f[0]!,
    parents: f[1]!.split(' ').filter(Boolean),
    env: { GIT_AUTHOR_NAME: f[2]!, GIT_AUTHOR_EMAIL: f[3]!, GIT_AUTHOR_DATE: f[4]!, GIT_COMMITTER_NAME: f[5]!, GIT_COMMITTER_EMAIL: f[6]!, GIT_COMMITTER_DATE: f[7]! },
    message: f.slice(8).join('\x1f'),
  };
}

/**
 * Rebuild the unpublished, Conductor-recorded range `base..tip` (oldest first) with plumbing, setting `paths` to their base state in
 * every commit: removed (`exclude`: only files the run ADDED) or restored to the base content (`revert`). Authors, committers, dates and
 * messages are kept; a commit that becomes empty is dropped. Nothing in the checkout, index or any branch is touched.
 */
export async function replayRange(
  repoRoot: string,
  base: string,
  tip: string,
  recorded: ReadonlySet<string>,
  paths: readonly string[],
  mode: 'exclude' | 'revert',
): Promise<{ ok: true; tip: string; map: Record<string, string> } | { ok: false; why: string }> {
  if (!SHA_RE.test(base) || !SHA_RE.test(tip)) return { ok: false, why: 'the commit range is not usable' };
  const listed = await git(repoRoot, ['rev-list', '--topo-order', '--reverse', '--max-count=201', tip, '--not', base]);
  const range = listed.code === 0 ? listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  if (!range.length || range.length > 200) return { ok: false, why: 'the commit range is empty or too long' };
  const infos: Info[] = [];
  for (const sha of range) {
    if (!recorded.has(sha)) return { ok: false, why: 'the range holds a commit Conductor did not record' };
    const i = await infoOf(repoRoot, sha);
    if (!i || i.parents.length !== 1) return { ok: false, why: 'the range holds a merge, root or unreadable commit' };
    infos.push(i);
  }
  const edits: Record<string, string | null> = {};
  for (const p of paths) {
    const inBase = (await git(repoRoot, ['cat-file', '-e', `${base}:${p}`])).code === 0;
    if (!inBase) {
      edits[p] = null;
      continue;
    }
    if (mode === 'exclude') return { ok: false, why: 'only files this run added can be excluded; use revert_paths for a file that already existed' };
    const ent = await git(repoRoot, ['ls-tree', base, '--', p]);
    const m = /^(\d{6}) blob [0-9a-f]{40}\t/.exec(ent.stdout);
    if (ent.code !== 0 || !m || m[1] !== '100644') return { ok: false, why: 'a path is not a plain file in the base (symlink, submodule or executable)' };
    const show = await git(repoRoot, ['show', `${base}:${p}`], { maxBytes: 1024 * 1024 });
    if (show.code !== 0 || show.stdoutTruncated || show.stdout.includes('\0')) return { ok: false, why: 'a path cannot be restored as text' };
    edits[p] = show.stdout;
  }
  const map: Record<string, string> = {};
  let parent = infos[0]!.parents[0]!;
  for (const c of infos) {
    const treeNow = (await git(repoRoot, ['rev-parse', `${c.sha}^{tree}`])).stdout.trim();
    if (!SHA_RE.test(treeNow)) return { ok: false, why: 'a commit tree could not be read' };
    const tree = await applyEdits(repoRoot, treeNow, edits);
    if (!tree) return { ok: false, why: 'the files could not be changed in a commit (symlink, submodule, or an unusable path)' };
    const parentTree = (await git(repoRoot, ['rev-parse', `${parent}^{tree}`])).stdout.trim();
    if (tree === parentTree) continue; // became empty: dropped, never pushed
    const made = await git(repoRoot, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', parent, '-F', '-'], { env: c.env, input: c.message });
    const sha = made.stdout.trim();
    if (made.code !== 0 || !SHA_RE.test(sha)) return { ok: false, why: 'a rebuilt commit could not be written' };
    if (sha !== c.sha) map[c.sha] = sha;
    parent = sha;
  }
  if (parent === tip) return { ok: false, why: 'the change would not alter what is pushed' };
  if (parent === base) return { ok: false, why: 'nothing would be left to push' };
  return { ok: true, tip: parent, map };
}

function recordedShas(run: Run): Set<string> {
  const set = new Set<string>();
  for (const x of [run.commitSha, run.shipSha, ...(run.graph?.items ?? []).map((i) => i.commitSha), ...(run.landedShas ?? [])]) if (typeof x === 'string' && SHA_RE.test(x)) set.add(x);
  return set;
}

// ───────────────────────────── applying an action ─────────────────────────────

type Prepared = { ok: true; text: string; fn: (r: Run) => void } | { ok: false; why: string };

/** Where the run continues after a fix: the stage that stopped (never `none`/`approval`). */
function resumeStep(origin: NextStep, run: Run): NextStep {
  const ok = (s: NextStep) => s === 'plan' || s === 'plan_review' || s === 'build' || s === 'verify';
  if (ok(origin)) return origin;
  return ok(run.next) ? run.next : 'build';
}

function resetFailedItems(r: Run, maxLoops: number): void {
  if (r.graph?.final !== 'pending') return;
  for (const it of r.graph.items) {
    if (it.state !== 'failed' && it.state !== 'blocked') continue;
    it.state = 'pending';
    it.loop = 1;
    it.loopBudget = maxLoops;
    it.feedback = undefined;
    it.note = undefined;
    it.floor = undefined;
    it.startHead = undefined;
    it.nonce = undefined;
  }
  r.commitNote = undefined;
}

async function prepare(host: ResolverHost, key: string, a: ResolverAction, origin: NextStep): Promise<Prepared> {
  const run = host.run(key);
  const cfg = host.cfg();
  const now = host.now();
  const next = resumeStep(origin, run);
  const secrets = host.secrets(run);
  switch (a.action) {
    case 'retry_stage': {
      const step: NextStep = a.origin === 'ship' ? 'verify' : a.origin;
      return {
        ok: true,
        text: `retrying ${step}`,
        fn: (r) => {
          r.next = step;
          r.buildFails = 0;
          if (step === 'build') resetFailedItems(r, cfg.pipeline.maxLoops);
          if (a.origin === 'ship') {
            r.shipHold = undefined;
            r.shipSha = undefined;
            r.shipBase = undefined;
          }
        },
      };
    }
    case 'replan':
      return {
        ok: true,
        text: 'planning again with new feedback',
        fn: (r) => {
          r.rev += 1;
          r.next = 'plan';
          r.loop = 1;
          r.planApproved = false;
          r.planReviewDone = false;
          r.planReviewRounds = 0;
          r.verdict = null;
          r.feedback = `The resolver asked for a new plan:\n${a.feedback}`;
          for (const b of r.bugs) if (b.status === 'open') b.status = 'closed';
        },
      };
    case 'rebuild':
      return {
        ok: true,
        text: `sending ${a.bugs.length} problem(s) back to the builder`,
        fn: (r) => {
          for (const b of a.bugs) {
            const fp = sha1(`resolver|${b.title.toLowerCase()}|${(b.file ?? '').toLowerCase()}`).slice(0, 16);
            const have = r.bugs.find((x) => x.fp === fp);
            if (have) {
              have.status = 'open';
              have.loops.push(r.loop);
              continue;
            }
            r.bugs.push({ fp, title: b.title, severity: 'major', ...(b.file ? { file: b.file } : {}), detail: b.detail, status: 'open', loops: [r.loop] });
          }
          r.loop += 1;
          r.next = 'build';
          r.buildFails = 0;
        },
      };
    case 'accept_baseline': {
      const cmp = host.readArtifact<{ comparison?: { regressions?: unknown[] } } | null>(key, `gates-${run.loop}.json`, null)?.comparison;
      if (!cmp || !Array.isArray(cmp.regressions) || cmp.regressions.length) return { ok: false, why: 'the gates show a regression, or no gate result exists' };
      return { ok: true, text: 'the gate failures were already there before this change; verifying again', fn: (r) => void (r.next = 'verify') };
    }
    case 'rewrite_to_placeholder':
      return {
        ok: true,
        text: `asking the builder once for placeholders in ${a.paths.slice(0, 4).join(', ')}`,
        fn: (r) => {
          r.resolverRewrites = (r.resolverRewrites ?? 0) + 1;
          r.fixtureRewriteNote = fixtureRewriteNote(a.paths); // fixed template + paths: never model text
          r.next = 'build';
        },
      };
    case 'revert_paths':
    case 'exclude_from_push': {
      const repo = host.repoPath(run);
      const tip = rangeTip(run);
      if (!repo || !tip || !SHA_RE.test(run.baseSha)) return { ok: false, why: 'the commit range is not known' };
      const res = await replayRange(repo, run.baseSha, tip, recordedShas(run), a.paths, a.action === 'revert_paths' ? 'revert' : 'exclude');
      if (!res.ok) return res;
      const scan = await (host.rescan ?? scanPushRange)({ repoRoot: repo, tip: res.tip, excludeTips: [run.baseSha], envEntries: host.scanEntries(run) });
      if (!scan.ok) return { ok: false, why: `the secret scan still blocks the changed commits (${redact(truncate(scan.reason, 200), secrets)})` };
      const commitSha = run.commitSha;
      return {
        ok: true,
        text: `${a.action === 'revert_paths' ? 'reverted' : 'left out of the push'} ${a.paths.slice(0, 4).join(', ')} (${Object.keys(res.map).length} unpublished commit(s) rewritten, scan clean, your checkout unchanged)`,
        fn: (r) => {
          const landed = new Set(r.landedShas ?? []);
          for (const s of [...Object.values(res.map), res.tip]) landed.add(s);
          r.landedShas = [...landed].slice(-500);
          r.shipSha = res.tip;
          r.shipBase = commitSha;
          r.next = next;
        },
      };
    }
    case 'switch_route': {
      const acct = run.account!;
      host.pauseAccount({ provider: acct.provider, id: acct.id }, now + 15 * 60_000, 'The resolver moved this run to the next configured tool');
      return { ok: true, text: `moving ${a.role} away from ${acct.provider} to the next configured tool`, fn: (r) => void (r.next = next) };
    }
    case 'extend_budget':
      return {
        ok: true,
        text: a.kind === 'runs' ? `${L.EXTEND_RUNS_BY} more agent runs, once` : `${L.EXTEND_LOOPS_BY} more build/verify loop, once`,
        fn: (r) => {
          r.resolverExtended = { ...(r.resolverExtended ?? {}), [a.kind]: a.kind === 'runs' ? L.EXTEND_RUNS_BY : L.EXTEND_LOOPS_BY };
          if (a.kind === 'loops') r.loopBudget += L.EXTEND_LOOPS_BY;
          r.next = next;
        },
      };
    case 'wait':
      return {
        ok: true,
        text: `waiting ${a.minutes} minute(s) before trying again`,
        fn: (r) => {
          r.status = 'paused';
          r.pausedUntil = now + a.minutes * 60_000;
          r.pauseKind = 'resolver';
          r.pauseReason = 'Waiting before an automatic retry';
          r.next = next;
        },
      };
    case 'give_up':
      return { ok: false, why: a.reason || 'the resolver found nothing it may fix' };
  }
}

// ───────────────────────────── the prompt ─────────────────────────────

const red = (s: unknown, n: number, secrets: readonly string[]): string => redact(truncate(String(s ?? ''), n), secrets);

async function buildPrompt(host: ResolverHost, key: string, reason: string, origin: NextStep, cause: string, allowed: readonly string[]): Promise<string> {
  const run = host.run(key);
  const secrets = host.secrets(run);
  const cfg = host.cfg();
  const hist = run.history.slice(-12).map((h) => `- ${red(h.text, 200, secrets)}`).join('\n');
  const open = run.bugs.filter((b) => b.status === 'open').slice(0, 10);
  const bugs = open.map((b, i) => `${i + 1}. [${b.severity}] ${red(b.title, 160, secrets)}${b.file ? ` (${red(b.file, 120, secrets)})` : ''}\n${red(b.detail, 400, secrets)}`).join('\n\n');
  let verdictText = '';
  for (const n of [run.loop, run.loop - 1]) {
    if (n < 1) continue;
    const v = host.readArtifact<unknown>(key, `verdict-${n}.json`, null);
    if (v) {
      verdictText = red(JSON.stringify(v), 3_500, secrets);
      break;
    }
  }
  let gatesText = '';
  for (const n of [run.loop, run.loop - 1]) {
    if (n < 1) continue;
    const g = host.readArtifact<{ run?: { results?: { name: string; exitCode: number }[] }; comparison?: unknown } | null>(key, `gates-${n}.json`, null);
    if (g) {
      gatesText = red(JSON.stringify({ results: (g.run?.results ?? []).map((x) => ({ name: x.name, exitCode: x.exitCode })), comparison: g.comparison }), 3_000, secrets);
      break;
    }
  }
  const reviewRaw = host.readArtifact<unknown>(key, `review-${run.rev}.json`, null);
  const reviewText = reviewRaw ? red(JSON.stringify(reviewRaw), 2_500, secrets) : '';
  const chains = (['implementation', 'planning', 'verification', 'review'] as Role[]).map((r) => `${r}: ${(cfg.roles?.[r]?.providers ?? []).join(' > ') || '(none)'}`).join('; ');
  const facts = [
    `- Loop ${run.loop} of ${run.loopBudget}; agent runs ${run.agentRuns} of ${host.runsLimit(run)}.`,
    `- Commits recorded: ${run.commitSha ? 'yes' : 'no'}; published: ${run.pushedAt ? 'yes' : 'no'}; task graph: ${run.graph ? run.graph.final : 'none'}.`,
    `- Resolver rounds used on this card: ${run.resolverUsed ?? 0} of ${L.RESOLVER_MAX_PER_CARD}. Budget extensions still available: runs ${run.resolverExtended?.runs === undefined ? 'yes' : 'no'}, loops ${run.resolverExtended?.loops === undefined ? 'yes' : 'no'}.`,
    `- Placeholder rewrite available: ${(run.resolverRewrites ?? 0) < 1 ? 'yes' : 'no'}.`,
    `- Last tool used: ${run.account?.provider ?? 'unknown'}. Configured tools per role: ${chains}.`,
  ].join('\n');
  return render(loadTemplate('resolver'), {
    preamble: preamble('resolver'),
    key: run.key,
    reason: fence('stop-reason', red(reason, 3_000, secrets), 3_200),
    origin,
    cause,
    facts: facts + '\n' + fence('task-card-title', red(run.title, 200, secrets), 300),
    bugs: bugs ? fence('verifier-findings', bugs, 5_000) : '',
    history: hist ? fence('run-history', hist, 3_000) : '',
    verdict: verdictText ? fence('verdict', verdictText, 3_800) : '',
    gates: gatesText ? fence('gates', gatesText, 3_300) : '',
    review: reviewText ? fence('plan-review', reviewText, 2_800) : '',
    files: allowed.length ? fence('changed-files', allowed.slice(0, 200).map((p) => red(p, 200, secrets)).join('\n'), 8_000) : '',
  });
}

// ───────────────────────────── the entry point ─────────────────────────────

/**
 * Try to fix a stop. `skipped` / `declined` / `handled` mean "the caller parks (or has nothing left to do)"; `applied` means the run
 * continues from `next` with no stuck card. Writes: ONE patch before the model call, ONE patch with the outcome. Never throws.
 */
export async function resolve(host: ResolverHost, key: string, input: { reason: string; origin: NextStep; cause?: string }): Promise<ResolverOutcome> {
  let run: Run;
  try {
    run = host.run(key);
  } catch {
    return { kind: 'skipped' };
  }
  const cause = input.cause ?? classifyCause(input.reason);
  if (admission(host, run, cause, input.origin)) return { kind: 'skipped' };

  const t0 = host.now();
  // ONE write, BEFORE the model call: the counters are spent and the marker is set, so a crash can never re-run the resolver for this event
  const before = host.patch(key, (r) => {
    r.resolverUsed = (r.resolverUsed ?? 0) + 1;
    r.resolverRounds = [...(r.resolverRounds ?? []), `${cause}:${input.origin}`].slice(-20);
    r.resolverCauseUsed = { ...(r.resolverCauseUsed ?? {}), [cause]: (r.resolverCauseUsed?.[cause] ?? 0) + 1 };
    r.resolverActive = { at: t0, round: (r.resolverUsed ?? 1), origin: input.origin, cause };
  });
  host.hourly.record(t0);

  const finish = (outcome: ResolverOutcome, fn?: (r: Run) => void, text?: string): ResolverOutcome => {
    try {
      host.patch(key, (r) => {
        r.resolverActive = undefined;
        r.resolverRuns = (r.resolverRuns ?? 0) + Math.max(0, r.agentRuns - before.agentRuns);
        fn?.(r);
        if (text) r.history.push({ ts: host.now(), text: redact(truncate(text, 400), host.secrets(r)) });
      });
    } catch {
      /* the run vanished: nothing left to write */
    }
    return outcome;
  };

  try {
    const secrets = host.secrets(run);
    // the run's own change: the only paths an action may name (plus scan-flagged fixture paths parsed by code from the stop reason)
    const repo = host.repoPath(run);
    const tip = rangeTip(run);
    const files = repo && tip ? await diffFiles(repo, run.baseSha, tip) : null;
    const allowed = new Set<string>((files ?? []).filter(resolverPathOk));
    for (const p of fixtureContentHold(input.reason)?.paths ?? []) if (resolverPathOk(p)) allowed.add(p);

    const prompt = await buildPrompt(host, key, input.reason, input.origin, cause, [...allowed]);
    const called = await host.call(key, prompt);
    if (called.kind === 'handled' || host.aborted(key)) return finish({ kind: 'handled' });
    if (called.kind === 'failed') return finish({ kind: 'declined', analysis: '' }, undefined, `Resolver could not decide: ${red(called.reason, 160, secrets)}`);

    const flagged = new Set<string>((fixtureContentHold(input.reason)?.paths ?? []).filter(resolverPathOk));
    const v = validateAction(called.json, { run: host.run(key), cfg: host.cfg(), allowed, flagged }, secrets);
    if (!v.ok) return finish({ kind: 'declined', analysis: v.analysis }, undefined, `Resolver reply refused: ${v.why}`);
    if (v.action.action === 'give_up') return finish({ kind: 'declined', analysis: v.analysis || v.action.reason }, undefined, `Resolver gave up: ${v.action.reason || v.analysis}`);

    const prep = await prepare(host, key, v.action, input.origin);
    if (!prep.ok) return finish({ kind: 'declined', analysis: v.analysis }, undefined, `Resolver action ${v.action.action} not applied: ${prep.why}`);
    host.note(key, `Resolver: ${prep.text}`);
    return finish({ kind: 'applied', action: v.action.action }, prep.fn, `Resolver (${input.cause ?? cause}): ${prep.text}${v.analysis ? ` — ${truncate(v.analysis, 200)}` : ''}`);
  } catch (e) {
    return finish({ kind: 'declined', analysis: '' }, undefined, `Resolver failed: ${red(e instanceof Error ? e.message : String(e), 160, host.secrets(run))}`);
  }
}
