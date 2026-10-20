// Approval policy (M6): who has to click. ONE decision function; the envelope and the isolation gates never depend on it.
import type { Config, Plan } from '../types.ts';
import { riskHits, type RiskHit } from './rules.ts';

export type Policy = 'full-auto' | 'approve-plan' | 'approve-risky' | 'manual-stages';
export const POLICIES: readonly Policy[] = ['full-auto', 'approve-plan', 'approve-risky', 'manual-stages'];
export const isPolicy = (v: unknown): v is Policy => typeof v === 'string' && (POLICIES as readonly string[]).includes(v);

/** The effective policy of a project: its own setting, else the legacy `planApproval: manual`, else the global default (`full-auto` = v1 behaviour). */
export function effectivePolicy(cfg: Config, projectKey: string | null): Policy {
  const own = projectKey ? cfg.projects?.[projectKey]?.policy : undefined;
  if (isPolicy(own)) return own;
  if (cfg.pipeline.planApproval === 'manual') return 'approve-plan';
  return isPolicy(cfg.pipeline.policy) ? cfg.pipeline.policy : 'full-auto';
}

export interface ApprovalInput {
  plan: Plan;
  policy: Policy;
  /** Forced holds — no policy removes them. */
  forced: { protectedPaths: boolean; untrusted: boolean; bigGraph: boolean };
  /** The per-repo "first plan waits" rule (legacy `planApproval: 'first'`). */
  firstPlanHold: boolean;
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
  if (i.plan.complexity === 'L') { reasons.push('large change'); forcedHold = true; }
  if (i.forced.protectedPaths) { reasons.push('the plan touches protected files such as CI or agent config'); forcedHold = true; }
  if (i.forced.untrusted) { reasons.push('the task text came from an unverified source'); forcedHold = true; }
  if (i.forced.bigGraph) { reasons.push('more than 8 tasks'); forcedHold = true; }
  const risks = i.policy === 'approve-risky' || i.policy === 'approve-plan' || i.policy === 'manual-stages' ? riskHits(i.plan) : [];
  if (i.policy === 'approve-plan' || i.policy === 'manual-stages') reasons.push('your approval policy asks for every plan');
  if (i.policy === 'approve-risky' && risks.length) reasons.push(`risky: ${risks.map((r) => r.rule).join(', ')}`);
  if (i.firstPlanHold) reasons.push('first plan for this repo');
  const auto = reasons.length === 0;
  return { auto, reasons, risks: risks.length && (i.policy === 'approve-risky' || !auto) ? risks : [], forcedHold };
}
