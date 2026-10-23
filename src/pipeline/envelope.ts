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
  const committed = await W.commitAll({ worktree: i.worktree, message: `${i.subject}\n\nBuilt by Conductor (${label}). Plan rev ${i.rev}.${i.trailer ? `\n${i.trailer.replace(/[\r\n]+/g, ' ')}` : ''}`, secrets: i.secrets });
  if (!committed.ok) {
    if (committed.reason === 'nothing') return { kind: 'nothing', res: res! };
    if (committed.reason === 'guard') return { kind: 'held', reason: `Conductor refused to commit: ${committed.detail}. Nothing was committed.` };
    if (committed.reason === 'hook') return { kind: 'hook', detail: committed.detail };
    return { kind: 'held', reason: `Could not commit the build: ${committed.detail}` };
  }

  // 7 — this attempt's changes must pass the scope check; the branch since the run base must pass the secret scan
  const problem = await postBuildChecks(i.worktree, i.baseSha, i.planPaths, i.secrets, attemptBase);
  if (problem) return { kind: 'held', reason: problem };
  return { kind: 'committed', sha: committed.sha, files: committed.files };
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
export async function postBuildChecks(worktree: string, baseSha: string, planPaths: string[], secrets: string[], scopeSince?: string): Promise<string | null> {
  const scopeBase = scopeSince && /^[0-9a-f]{40}$/i.test(scopeSince) ? scopeSince : baseSha;
  const diff = await W.diffAgainst(worktree, scopeBase);
  // Conductor replaces a tracked `.conductor` symlink with a real directory and writes `.cursor/cli.json` itself.
  // Those paths are not the builder's change, and `commitAll` does not put them in the product commit (B-1).
  const conductorOwned = (p: string) => p === '.conductor' || p.startsWith('.conductor/') || p === '.cursor/cli.json';
  const paths = diff.files.flatMap((f) => [f.path, ...(f.from ? [f.from] : [])]).filter((p) => !conductorOwned(p)); // a rename's SOURCE counts too (M6)
  const violations = W.diffScopeViolations(paths, planPaths);
  if (violations.length) {
    return `The builder changed protected files that the plan did not list: ${violations.slice(0, 6).join(', ')}. Review them (they are committed on the branch) before continuing.`;
  }
  const leaks = await scanBranchForSecrets(worktree, baseSha, secrets);
  if (leaks.length) {
    return `The branch contains what looks like a secret (${leaks.slice(0, 4).join('; ')}). Nothing was pushed. Remove it from the branch history before continuing.`;
  }
  return null;
}
