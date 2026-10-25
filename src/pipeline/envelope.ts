// The build envelope (M2). EVERYTHING that makes a builder safe to run lives here, once, for every provider:
//   eligibility gate → provider guard (prepare) → git no-push env → git-meta snapshot → run → git-meta restore (even if the provider throws)
//   → provider guard verification → commit with the secret/scope guard → branch-wide scope + secret scan.
// `runBuild` is the ONLY code path that can start a builder (static test): a provider's `build.run` is called nowhere else.
// Extracted from stages.build() — the one intentional behaviour difference is that the git-meta restore now also runs when the provider throws.
import type { AgentResult } from '../types.ts';
import type { BuildPrep, Provider, ProviderId } from '../agents/providers/types.ts';
import type { ResolvedSel } from '../models/select.ts';
import { capabilitiesOf, isRegisteredProvider } from '../agents/providers/registry.ts';
import { buildBaseline } from '../agents/providers/verification.ts';
import type { EmitEvent } from '../agents/claude.ts';
import * as W from '../git/worktree.ts';
import { gitOk } from '../git/exec.ts';
import { scanBranchForSecrets } from '../git/branchscan.ts';
import type { ScanEnvEntry } from '../git/branchscan.ts';
import { testOrFixturePath } from '../git/fixture-hold.ts';
import { revertGitMeta, snapshotGitMeta } from '../git/meta.ts';
import { errMsg, truncate } from '../util.ts';
import type { AccountRef } from '../accounts/types.ts';
import { AccountIsolationError, accountBuildEnv, isolationMessage } from '../accounts/env.ts';

/** Keys NO provider may ever set through `prepare`, even if its allow-list says so (the envelope's own env also always wins). */
const FORBIDDEN_PREP_ENV = /^(GIT_[A-Z0-9_]*|HOME|PATH|USERPROFILE|CODEX_[A-Z0-9_]*|XDG_[A-Z0-9_]*|LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|NODE_OPTIONS)$/i;

const allowed = (k: string, allow: readonly string[]): boolean => allow.some((a) => (a.endsWith('*') ? k.startsWith(a.slice(0, -1)) && a.length > 1 : k === a));

/**
 * An ALLOW-list: `prepare` may add only the keys its adapter declared (`envAllow`: exact names or `PREFIX_*`), minus the never-list above.
 * Tokens, interpreter startup files, agent sockets and the like are therefore dropped by default (Security M2-3).
 */
export function sanitizePrepEnv(env: Record<string, string> | undefined, allow: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !FORBIDDEN_PREP_ENV.test(k) && allowed(k, allow)) out[k] = v;
  }
  return out;
}

export type BuildEligibility = { ok: true } | { ok: false; why: string };

/** Re-asserted INSIDE runBuild against the registry's derived capabilities — never against config or anything an adapter reports. */
export function buildEligibility(p: Provider): BuildEligibility {
  // only objects that came out of the registry count — an object that merely says `id: 'cursor'` is nobody (Security M2-2)
  if (!isRegisteredProvider(p)) return { ok: false, why: 'That provider is not from the registry, so it cannot build.' };
  const caps = capabilitiesOf(p);
  if (!caps.build) return { ok: false, why: `${p.label} has no build capability.` };
  if (!caps.buildIsolationVerified) return { ok: false, why: `${p.label}'s build isolation has not been verified, so Conductor will not let it write code.` };
  // the guard the verification depends on cannot be opted out of by an adapter flag (Security M2-1)
  const base = buildBaseline(p.id);
  const wantsFileGuard = base?.guard === 'file';
  if (!base || !p.build || p.build.guard !== wantsFileGuard) return { ok: false, why: `${p.label} must keep the guard its isolation check depends on.` };
  return { ok: true };
}

export type BuildOutcome =
  | { kind: 'held'; reason: string } // needs a human; nothing was committed by Conductor
  | { kind: 'failed'; res: AgentResult; provider: ProviderId } // the provider returned an error result (limit / aborted / spawn / agent …)
  | { kind: 'nothing'; res: AgentResult } // the builder produced no change for Conductor to commit
  | { kind: 'hook'; detail: string } // the repository's commit hook rejected the build (feedback for the next loop)
  | { kind: 'committed'; sha: string; files: string[] };

export interface BuildInput {
  provider: Provider;
  repoPath: string;
  worktree: string;
  baseSha: string;
  /** Commit subject (first line); the envelope appends the "Built by Conductor (<label>)" trailer. */
  subject: string;
  /** Optional extra final line of the commit message (the task-graph adopt marker). Whole line, single-line text only. */
  trailer?: string;
  rev: number;
  prompt: string;
  name: string;
  onEvent: (ev: EmitEvent) => void;
  signal?: AbortSignal;
  secrets: string[];
  /** The plan's file list (scope check). */
  planPaths: string[];
  /** Called with the provider's guard facts right after `prepare` (the stage records them on the run). */
  onPrepared: (prep: BuildPrep) => void;
  /** Called with the provider's result before the git-meta check (the stage records the session / refunds a limit hit). */
  onResult: (res: AgentResult) => void;
  /** M8-2: the builder's model/effort selection. DATA ONLY: forwarded to the provider untouched; no safety step reads it. */
  sel?: ResolvedSel;
  /** M8-3: the builder's account (absent ⇒ the tool's main sign-in, today's env). */
  account?: AccountRef;
  /**
   * C2 (Complete auto): when the ONLY problem is protected files the plan did not list, Conductor may put them back in this build
   * directory and commit that, once. `allow` is asked first (the stage owns the mode, plan type and once-per-run budget); `onReverted`
   * records what happened. Absent ⇒ the build is held exactly as before.
   */
  scopeRevert?: { key: string; /** Every path the plan lists: a violating path the plan itself asked for is never reverted. */ listed: string[]; allow: () => boolean; onReverted: (r: { paths: string[]; backupRef: string; /** The build commit that was reverted on top of: it stays in history, so Ship must know it is Conductor's. */ originalSha: string }) => void };
  /**
   * The branch scan's .env entries (name + value), so only secret-like values stop a build (C1). Absent ⇒ `secrets` is used as plain values,
   * which fails closed (every value qualifies).
   */
  scanEntries?: ScanEnvEntry[];
  /**
   * Auto push is in effect: credential-shaped text that sits ONLY in test/fixture files does not stop the local commit or the branch check.
   * The Ship scan (which never exempts any path) is where it is caught, and where it is rewritten once.
   */
  deferFixtureShapes?: boolean;
}

const HELD_NO_GUARD = (label: string, why: string) => `${label}'s guard could not be established (${why}). Nothing was started. Review the setup before continuing.`;

export async function runBuild(i: BuildInput): Promise<BuildOutcome> {
  const { provider } = i;
  const label = provider.label;

  // 1 — eligibility, re-asserted here: no spawn for a provider that cannot build or whose isolation is unproven
  const elig = buildEligibility(provider);
  if (!elig.ok) return { kind: 'held', reason: elig.why };
  const b = provider.build!;

  // 2 — the provider's own guard; a throw, a rejection or a missing hook for a provider that declared a guard ⇒ fail closed
  let prep: BuildPrep;
  try {
    if (b.guard && (typeof b.prepare !== 'function' || typeof b.verifyGuard !== 'function')) return { kind: 'held', reason: HELD_NO_GUARD(label, 'it declares a guard but does not provide both prepare and verify') };
    prep = typeof b.prepare === 'function' ? await b.prepare({ worktree: i.worktree }) : { guardSha: null, envOnly: true };
    if (!prep || typeof prep !== 'object') throw new Error('prepare returned nothing');
    // consistency: a file guard that was written must have a hash, and env-only protection cannot come with one
    if (b.guard && prep.envOnly === false && !prep.guardSha) throw new Error('prepare reported a guard but no hash for it');
    if (prep.envOnly === true && prep.guardSha) throw new Error('prepare reported env-only protection together with a guard hash');
  } catch (e) {
    return { kind: 'held', reason: HELD_NO_GUARD(label, truncate(errMsg(e), 160)) };
  }
  i.onPrepared(prep);

  // 3 — the envelope's env: the git no-push env always wins over anything `prepare` supplied. The git settings/hooks must also be
  //     snapshottable BEFORE a builder runs: no env or no snapshot ⇒ no tamper detection ⇒ nothing is started (Security M2-4).
  let env: Record<string, string>;
  let snap: Awaited<ReturnType<typeof snapshotGitMeta>>;
  try {
    env = { ...sanitizePrepEnv(prep.env, b.envAllow), ...(await W.agentGitEnv(i.repoPath)) };
    snap = await snapshotGitMeta(i.repoPath);
  } catch (e) {
    return { kind: 'held', reason: `Conductor could not read the repository's git settings (${truncate(errMsg(e), 120)}), so it did not start the builder. Check the repository, then move the card to To do.` };
  }

  // 3b — M8-3 (B5): a named account's env fragment is resolved HERE from fixed code (never by `prepare`; FORBIDDEN_PREP_ENV is unchanged).
  //      Builds on named accounts are gated off by the router until CURSOR_ACCOUNT_HOME_BUILD_VERIFIED flips (D-G, S17); the binding check on
  //      the final env runs inside the adapter right before the spawn (R2-1).
  let acctEnv: Record<string, string> | undefined;
  try {
    acctEnv = i.account && i.account.provider !== provider.id ? (() => { throw new AccountIsolationError('an account of another tool'); })() : accountBuildEnv(i.account);
  } catch (e) {
    return { kind: 'held', reason: isolationMessage(`added ${label}`, e instanceof AccountIsolationError ? e.cls : 'an account folder that could not be checked') };
  }

  // HEAD before the builder runs. Scope is judged from here, so protected files already on the branch are not blamed on this attempt.
  // Commits the builder makes itself still sit after this point and are still checked. A missing HEAD falls back to the run base (fail closed).
  let attemptBase = i.baseSha;
  try {
    attemptBase = (await gitOk(i.worktree, ['rev-parse', 'HEAD'])).trim() || i.baseSha;
  } catch {
    attemptBase = i.baseSha;
  }

  // 4 — run, with the git-meta restore guaranteed (also when the provider throws, times out or is aborted)
  let res: AgentResult | undefined;
  let thrown: { e: unknown } | undefined;
  try {
    res = await b.run({ cwd: i.worktree, prompt: i.prompt, name: i.name, env, onEvent: i.onEvent, signal: i.signal, secrets: i.secrets, ...(i.sel ? { sel: i.sel } : {}), ...(i.account ? { account: i.account } : {}), ...(acctEnv ? { accountEnv: acctEnv } : {}) }, prep);
  } catch (e) {
    thrown = { e };
  }
  const tampered = await revertGitMeta(snap).catch(() => []);
  if (thrown) {
    if (tampered.length) i.onEvent({ agent: 'conductor', stage: 'build', kind: 'note', text: `${label} crashed after changing git settings/hooks (${tampered.slice(0, 4).join(', ')}) — Conductor restored them.` });
    throw thrown.e;
  }
  i.onResult(res!);
  if (tampered.length) return { kind: 'held', reason: `The builder changed git settings/hooks (${tampered.slice(0, 4).join(', ')}). Conductor restored them; review the worktree before continuing.` };
  if (!res!.ok) return { kind: 'failed', res: res!, provider: provider.id };

  // 5 — the provider's guard must be intact (fail closed on a throw)
  if (b.guard) {
    let chk: { ok: boolean; detail: string };
    try {
      chk = await b.verifyGuard!(prep, { worktree: i.worktree });
    } catch (e) {
      chk = { ok: false, detail: `the guard check itself failed: ${truncate(errMsg(e), 120)}` };
    }
    if (!chk.ok) return { kind: 'held', reason: `The builder tampered with the no-push guard (${chk.detail}). Review the worktree before continuing.` };
  }

  // 6 — Conductor commits (secret + scope guard), never the builder
  const committed = await W.commitAll({ worktree: i.worktree, message: `${i.subject}\n\nBuilt by Conductor (${label}). Plan rev ${i.rev}.${i.trailer ? `\n${i.trailer.replace(/[\r\n]+/g, ' ')}` : ''}`, secrets: i.secrets, ...(i.deferFixtureShapes ? { deferFixtureShapes: true } : {}) });
  if (!committed.ok) {
    if (committed.reason === 'nothing') return { kind: 'nothing', res: res! };
    if (committed.reason === 'guard') return { kind: 'held', reason: `Conductor refused to commit: ${committed.detail}. Nothing was committed.` };
    if (committed.reason === 'hook') return { kind: 'hook', detail: committed.detail };
    return { kind: 'held', reason: `Could not commit the build: ${committed.detail}` };
  }

  // 7 — this attempt's changes must pass the scope check; the branch since the run base must pass the secret scan
  let problem = await postBuildProblem(i.worktree, i.baseSha, i.planPaths, i.scanEntries ?? i.secrets, attemptBase, { deferFixtureShapes: i.deferFixtureShapes });
  let sha = committed.sha;
  let files = committed.files;
  if (problem && problem.kind === 'scope' && i.scopeRevert && !problem.paths.some((p) => planListed(p, i.scopeRevert!.listed)) && i.scopeRevert.allow()) {
    const healed = await revertOutOfScope(i, attemptBase, committed.sha, problem.paths, label);
    if (healed.ok) {
      i.scopeRevert.onReverted({ paths: healed.reverted, backupRef: healed.backupRef, originalSha: committed.sha });
      sha = healed.sha;
      files = files.filter((f) => !healed.reverted.includes(f));
      problem = await postBuildProblem(i.worktree, i.baseSha, i.planPaths, i.scanEntries ?? i.secrets, attemptBase, { deferFixtureShapes: i.deferFixtureShapes });
      if (!problem && files.length === 0) {
        // everything the builder did was out of scope: the directory goes back to where this attempt started (the backup ref keeps the commit)
        await W.resetToCommit(i.worktree, attemptBase).catch(() => undefined);
        return { kind: 'nothing', res: res! };
      }
    }
  }
  if (problem) return { kind: 'held', reason: problem.text };
  return { kind: 'committed', sha, files };
}

/** Exact match or directory prefix, like the scope check's allow list. */
function planListed(path: string, listed: readonly string[]): boolean {
  return listed.map((a) => a.replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean).some((a) => path === a || path.startsWith(a + '/'));
}

/**
 * C2. Only when the build is exactly ONE commit that Conductor just made on top of the attempt base (a builder's own commits are never
 * rewritten), in the build directory Conductor created. A backup ref of the pre-revert HEAD is made first and named by the caller.
 */
async function revertOutOfScope(
  i: BuildInput,
  attemptBase: string,
  conductorSha: string,
  paths: string[],
  label: string,
): Promise<{ ok: true; sha: string; reverted: string[]; backupRef: string } | { ok: false }> {
  try {
    const head = (await gitOk(i.worktree, ['rev-parse', 'HEAD'])).trim();
    const chain = (await gitOk(i.worktree, ['rev-list', `${attemptBase}..HEAD`])).split('\n').map((x) => x.trim()).filter(Boolean);
    if (head !== conductorSha || chain.length !== 1 || chain[0] !== conductorSha) return { ok: false };
    const refs = await W.backupRefs(i.worktree, i.scopeRevert!.key, i.rev);
    const rev = await W.revertPathsTo(i.worktree, attemptBase, paths, { repoRoot: i.repoPath });
    if (!rev.ok) {
      await W.resetToCommit(i.worktree, conductorSha);
      return { ok: false };
    }
    const c = await W.commitAll({ worktree: i.worktree, message: `${i.scopeRevert!.key}: reverted out-of-scope files\n\nBuilt by Conductor (${label}). Plan rev ${i.rev}.`, secrets: i.secrets, ...(i.deferFixtureShapes ? { deferFixtureShapes: true } : {}) });
    if (!c.ok) {
      await W.resetToCommit(i.worktree, conductorSha);
      return { ok: false };
    }
    return { ok: true, sha: c.sha, reverted: rev.reverted, backupRef: refs.headRef };
  } catch {
    try {
      await W.resetToCommit(i.worktree, conductorSha);
    } catch {
      /* the held reason below still stops the run */
    }
    return { ok: false };
  }
}

/** Protected files a plan may list and still pass the post-build scope check: ONLY when a person approved that plan individually. Auto and bulk approvals get none. */
export function exemptPaths(run: { approvedBy?: 'auto' | 'human'; approvedBulk?: boolean }, plan: { filesToChange: { path: string }[] }): string[] {
  return run.approvedBy === 'human' && run.approvedBulk !== true ? plan.filesToChange.map((f) => f.path) : [];
}

/**
 * Scope is the diff since `scopeSince` (the HEAD before this attempt), so protected files already on the branch are not
 * "the builder changed" them. Commits the builder makes during the attempt are still in that diff. The secret scan stays
 * against the run base. Omit `scopeSince` to judge scope from the run base, which is the fail-closed default.
 */
export async function postBuildChecks(worktree: string, baseSha: string, planPaths: string[], secrets: readonly (string | ScanEnvEntry)[], scopeSince?: string, opts?: { deferFixtureShapes?: boolean }): Promise<string | null> {
  return (await postBuildProblem(worktree, baseSha, planPaths, secrets, scopeSince, opts))?.text ?? null;
}

/** The same checks with the cause named, so a caller can heal a scope problem without reading text. `text` is what the card shows. */
export interface PostBuildProblem {
  kind: 'scope' | 'secret';
  /** Scope: the violating paths (rename sources included). Secret: empty (findings never carry the value). */
  paths: string[];
  text: string;
}

export async function postBuildProblem(worktree: string, baseSha: string, planPaths: string[], secrets: readonly (string | ScanEnvEntry)[], scopeSince?: string, opts: { deferFixtureShapes?: boolean } = {}): Promise<PostBuildProblem | null> {
  const scopeBase = scopeSince && /^[0-9a-f]{40}$/i.test(scopeSince) ? scopeSince : baseSha;
  const diff = await W.diffAgainst(worktree, scopeBase);
  // Conductor replaces a tracked `.conductor` symlink with a real directory and writes `.cursor/cli.json` itself.
  // Those paths are not the builder's change, and `commitAll` does not put them in the product commit (B-1).
  const conductorOwned = (p: string) => p === '.conductor' || p.startsWith('.conductor/') || p === '.cursor/cli.json';
  const paths = diff.files.flatMap((f) => [f.path, ...(f.from ? [f.from] : [])]).filter((p) => !conductorOwned(p)); // a rename's SOURCE counts too (M6)
  const violations = W.diffScopeViolations(paths, planPaths);
  if (violations.length) {
    return {
      kind: 'scope',
      paths: violations,
      text: `The builder changed protected files that the plan did not list: ${violations.slice(0, 6).join(', ')}. Review them (they are committed on the branch) before continuing.`,
    };
  }
  let leaks = await scanBranchForSecrets(worktree, baseSha, secrets);
  // Auto push in effect: a credential SHAPE that sits only in test/fixture files waits for Ship (its scan exempts no path). Env values, secret file
  // names, a shape anywhere else, and a scan that could not complete are never deferred.
  if (opts.deferFixtureShapes) leaks = leaks.filter((l) => !/^(.*) \(credential-shaped value\)$/.test(l) || !testOrFixturePath(/^(.*) \(credential-shaped value\)$/.exec(l)![1]!));
  if (leaks.length) {
    return { kind: 'secret', paths: [], text: `The branch contains what looks like a secret (${leaks.slice(0, 4).join('; ')}). Nothing was pushed. Remove it from the branch history before continuing.` };
  }
  return null;
}
