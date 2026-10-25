// Complete auto self-heal: causes Conductor may fix itself instead of parking a card on "Needs you".
// Causes are STRUCTURED (named by the call site), never recovered by parsing text. Every heal is bounded by a counter that lives on
// the run, so a persistent problem parks the card after one attempt. Nothing here widens a safety rule: scans and guards still run.

export type HealCause = 'scope_revert' | 'empty_attempt' | 'ship_fixture';

/** Per-cause budget. Every value is 1: one automatic attempt, then a person decides. */
export const HEAL_BUDGET: Readonly<Record<HealCause, number>> = Object.freeze({ scope_revert: 1, empty_attempt: 1, ship_fixture: 1 });

/** Static wording handed to the next build after an attempt that changed nothing. Never contains agent text. */
export const EMPTY_ATTEMPT_NOTE = 'The previous attempt changed nothing. Implement the task, or say in your answer why nothing is needed.';
// Whether a heal is allowed right now (Complete auto only) is `effectiveHeal` in src/policy/policy.ts: stages never name the run mode.
