// Approval policy (M6): who has to click. ONE decision function; the envelope and the isolation gates never depend on it.
import type { Config, Plan } from '../types.ts';
import { planFixtureRewrite } from '../git/fixture-hold.ts';
import { riskHits, type RiskHit } from './rules.ts';

export type Policy = 'full-auto' | 'approve-plan' | 'approve-risky' | 'manual-stages';
export const POLICIES: readonly Policy[] = ['full-auto', 'approve-plan', 'approve-risky', 'manual-stages'];
export const isPolicy = (v: unknown): v is Policy => typeof v === 'string' && (POLICIES as readonly string[]).includes(v);

/**
 * M8-4 (C2): the global run mode. EXACT equality only — a missing field or any other value (wrong case, padding, non-string) is
 * Per settings, the safe side.
 */
export const isCompleteAuto = (cfg: Config): boolean => cfg?.pipeline?.runMode === 'complete-auto';

/** The STORED policy of a project: its own setting, else the legacy `planApproval: manual`, else the global default (`full-auto` = v1 behaviour). */
export function storedPolicy(cfg: Config, projectKey: string | null): Policy {
  const own = projectKey ? cfg.projects?.[projectKey]?.policy : undefined;
  if (isPolicy(own)) return own;
  if (cfg.pipeline.planApproval === 'manual') return 'approve-plan';
  return isPolicy(cfg.pipeline.policy) ? cfg.pipeline.policy : 'full-auto';
}

/** The policy that applies right now: `full-auto` under Complete auto (M8-4 overlay; the stored value is never written), else the stored one. */
export function effectivePolicy(cfg: Config, projectKey: string | null): Policy {
  return isCompleteAuto(cfg) ? 'full-auto' : storedPolicy(cfg, projectKey);
}

/** The legacy per-repo "first plan waits" rule (`planApproval: 'first'`), switched off by Complete auto (it is not a forced hold). */
export function effectiveFirstPlanHold(cfg: Config, approvedCount: number): boolean {
  return !isCompleteAuto(cfg) && cfg.pipeline.planApproval === 'first' && approvedCount === 0;
}

/** Complete auto lifts every forced hold. Stages passes this through; it never names the mode itself. */
export const effectiveLiftsHolds = (cfg: Config): boolean => isCompleteAuto(cfg);

/**
 * Complete auto, once: credential-shaped text that is only in tests or fixtures. Callers never name the mode.
 * A secret file name, a copied .env value, or the same shape in any other path returns null.
 */
export function effectiveFixtureRewrite(cfg: Config, used: number | undefined, reason: string) {
  if (!isCompleteAuto(cfg)) return null;
  return planFixtureRewrite(used, reason);
}

export interface ApprovalInput {
  plan: Plan;
  policy: Policy;
  /** Forced holds — no policy removes them. */
  forced: { protectedPaths: boolean; untrusted: boolean; bigGraph: boolean };
  /** The per-repo "first plan waits" rule (legacy `planApproval: 'first'`). */
  firstPlanHold: boolean;
  /** Complete auto: every forced hold (large change, protected files, unverified source, big graph) is lifted; the post-build guards still run (see Stages). */
  completeAuto?: boolean;
}
export interface ApprovalDecision {
  auto: boolean;
  /** Human-readable reasons shown on the card. */
  reasons: string[];
  /** Risk-rule hits: approving them needs an explicit confirmation. */
  risks: RiskHit[];
  /** True when the hold is forced (cannot be turned off by any setting). */
  forcedHold: boolean;
}

export function decideApproval(i: ApprovalInput): ApprovalDecision {
  const reasons: string[] = [];
  let forcedHold = false;
  const ca = i.completeAuto === true;
  if (!ca && i.plan.complexity === 'L') { reasons.push('large change'); forcedHold = true; }
  if (!ca && i.forced.protectedPaths) { reasons.push('the plan touches protected files such as CI or agent config'); forcedHold = true; }
  if (!ca && i.forced.untrusted) { reasons.push('the task text came from an unverified source'); forcedHold = true; }
  if (!ca && i.forced.bigGraph) { reasons.push('more than 8 tasks'); forcedHold = true; }
  const risks = riskHits(i.plan); // always computed: a plan held for another reason still shows what it would run
  if (i.policy === 'approve-plan' || i.policy === 'manual-stages') reasons.push('your approval policy asks for every plan');
  if (i.policy === 'approve-risky' && risks.length) reasons.push(`risky: ${risks.map((r) => r.rule).join(', ')}`);
  if (i.firstPlanHold) reasons.push('first plan for this repo');
  const auto = reasons.length === 0;
  return { auto, reasons, risks: auto ? [] : risks, forcedHold };
}

/**
 * M8-4 N8: did Complete auto make the difference? True when the effective decision is `auto` but the STORED settings (the same forced
 * inputs, the stored policy and first-plan rule) would have held the plan. Pure: two `decideApproval` calls; forced inputs are the
 * caller's, unchanged.
 */
export function decidedByRunMode(cfg: Config, input: Omit<ApprovalInput, 'policy' | 'firstPlanHold'>, projectKey: string | null, approvedCount: number): boolean {
  if (!isCompleteAuto(cfg)) return false;
  const effective = decideApproval({ ...input, completeAuto: true, policy: effectivePolicy(cfg, projectKey), firstPlanHold: effectiveFirstPlanHold(cfg, approvedCount) });
  if (!effective.auto) return false;
  const stored = decideApproval({ ...input, completeAuto: false, policy: storedPolicy(cfg, projectKey), firstPlanHold: cfg.pipeline.planApproval === 'first' && approvedCount === 0 });
  return !stored.auto;
}
