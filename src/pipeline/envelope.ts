// The build envelope (M2). EVERYTHING that makes a builder safe to run lives here, once, for every provider:
//   eligibility gate → provider guard (prepare) → git no-push env → git-meta snapshot → run → git-meta restore (even if the provider throws)
//   → provider guard verification → commit with the secret/scope guard → branch-wide scope + secret scan.
// `runBuild` is the ONLY code path that can start a builder (static test): a provider's `build.run` is called nowhere else.
// Extracted from stages.build() — the one intentional behaviour difference is that the git-meta restore now also runs when the provider throws.
import type { AgentResult } from '../types.ts';
import type { BuildPrep, Provider, ProviderId } from '../agents/providers/types.ts';
import { capabilitiesOf } from '../agents/providers/registry.ts';
import type { EmitEvent } from '../agents/claude.ts';
import * as W from '../git/worktree.ts';
import { scanBranchForSecrets } from '../git/branchscan.ts';
import { revertGitMeta, snapshotGitMeta } from '../git/meta.ts';
import { errMsg, truncate } from '../util.ts';

/** Keys a provider's `prepare` may never inject into the builder's environment (the envelope's own env also always wins). */
const FORBIDDEN_PREP_ENV = /^(GIT_[A-Z0-9_]*|HOME|PATH|USERPROFILE|CODEX_[A-Z0-9_]*|XDG_[A-Z0-9_]*|LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|NODE_OPTIONS)$/i;

export function sanitizePrepEnv(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (typeof v === 'string' && !FORBIDDEN_PREP_ENV.test(k)) out[k] = v;
  }
  return out;
}

export type BuildEligibility = { ok: true } | { ok: false; why: string };

/** Re-asserted INSIDE runBuild against the registry's derived capabilities — never against config or anything an adapter reports. */
export function buildEligibility(p: Provider): BuildEligibility {
  const caps = capabilitiesOf(p);
  if (!caps.build) return { ok: false, why: `${p.label} has no build capability.` };
  if (!caps.buildIsolationVerified) return { ok: false, why: `${p.label}'s build isolation has not been verified, so Conductor will not let it write code.` };
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
  } catch (e) {
    return { kind: 'held', reason: HELD_NO_GUARD(label, truncate(errMsg(e), 160)) };
  }
  i.onPrepared(prep);

  // 3 — the envelope's env: the git no-push env always wins over anything `prepare` supplied
  const env = { ...sanitizePrepEnv(prep.env), ...(await W.agentGitEnv(i.repoPath)) };

  // 4 — run, with the git-meta restore guaranteed (also when the provider throws, times out or is aborted)
  const snap = await snapshotGitMeta(i.repoPath).catch(() => null);
  let res: AgentResult | undefined;
  let thrown: { e: unknown } | undefined;
  try {
    res = await b.run({ cwd: i.worktree, prompt: i.prompt, name: i.name, env, onEvent: i.onEvent, signal: i.signal, secrets: i.secrets }, prep);
  } catch (e) {
    thrown = { e };
  }
  const tampered = snap ? await revertGitMeta(snap).catch(() => []) : [];
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
  const committed = await W.commitAll({ worktree: i.worktree, message: `${i.subject}\n\nBuilt by Conductor (${label}). Plan rev ${i.rev}.`, secrets: i.secrets });
  if (!committed.ok) {
    if (committed.reason === 'nothing') return { kind: 'nothing', res: res! };
    if (committed.reason === 'guard') return { kind: 'held', reason: `Conductor refused to commit: ${committed.detail}. Nothing was committed.` };
    if (committed.reason === 'hook') return { kind: 'hook', detail: committed.detail };
    return { kind: 'held', reason: `Could not commit the build: ${committed.detail}` };
  }

  // 7 — everything the BRANCH now contains must pass the scope and secret checks
  const problem = await postBuildChecks(i.worktree, i.baseSha, i.planPaths, i.secrets);
  if (problem) return { kind: 'held', reason: problem };
  return { kind: 'committed', sha: committed.sha, files: committed.files };
}

/** Everything the BRANCH now contains (incl. commits the agent made itself) must pass the scope and secret checks. */
export async function postBuildChecks(worktree: string, baseSha: string, planPaths: string[], secrets: string[]): Promise<string | null> {
  const diff = await W.diffAgainst(worktree, baseSha);
  const paths = diff.files.flatMap((f) => [f.path, ...(f.from ? [f.from] : [])]); // a rename's SOURCE counts too (M6)
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
