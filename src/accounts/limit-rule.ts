// Contract C1 (M8-3 §2.C, M8-4 Reviewer condition B2a — binding). The ONLY reader of `cfg.pipeline.limitRule` outside the settings
// view/edit and the migration: the engine, the router callers and the API call `effectiveLimitRule` (a static test enforces this).
//  - 'switch' = the next account of the same tool, then the next tool IN THE ROLE'S CHAIN (with that tool's accounts in order); never
//    beyond the chain (user decision D-A).
//  - 'same'   = only the head tool's accounts; a usage limit never moves work to another tool.
//  - 'wait'   = only the head tool's first account.
// M8-4 owns one edit here, as the first line of `effectiveLimitRule` (the complete-auto run mode), plus that branch's test.
import type { Config } from '../types.ts';

export type LimitRule = 'switch' | 'same' | 'wait';
export const LIMIT_RULES: readonly LimitRule[] = ['switch', 'same', 'wait'];
export const isLimitRule = (v: unknown): v is LimitRule => v === 'switch' || v === 'same' || v === 'wait';

/** Pure: the rule the engine applies right now. */
export function effectiveLimitRule(cfg: Config): LimitRule {
  if (cfg.pipeline.runMode === 'complete-auto') return 'switch'; // M8-4 (C1): Complete auto = next account, then another tool; stored rule untouched
  return cfg.pipeline.limitRule;
}
