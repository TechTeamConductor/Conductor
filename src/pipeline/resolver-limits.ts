// Stuck resolver limits: constants only (no imports), so policy.ts and resolver.ts share ONE definition. Every value is a hard
// ceiling in code: nothing the model returns can raise any of them.

/** Resolver invocations per card (persisted as `Run.resolverUsed`). */
export const RESOLVER_MAX_PER_CARD = 3;
/** Invocations per (cause, origin) pair. */
export const RESOLVER_MAX_PER_PAIR = 1;
/** Invocations per cause, across origins. */
export const RESOLVER_MAX_PER_CAUSE = 2;
/** Resolver model calls across ALL cards per rolling hour (in memory; a restart cannot raise it beyond the per-card caps). */
export const RESOLVER_MAX_PER_HOUR = 12;
/** Agent runs the resolver may spend on one card (a call may retry up to 4 times inside `callReadOnly`). */
export const RESOLVER_MAX_AGENT_RUNS = 4;
/** `extend_budget` ceilings, once per kind per card. */
export const EXTEND_RUNS_BY = 2;
export const EXTEND_LOOPS_BY = 1;
/** `wait` horizon in minutes. */
export const WAIT_MAX_MINUTES = 60;
/** Caps on what the model may hand back. */
export const MAX_PATHS = 20;
export const MAX_BUGS = 6;
export const MAX_TEXT = 1_200;
/** Restarts per hour after which the resolver stands down (mirrors the human-restart guard in the engine). */
export const RESTART_GUARD = 5;

/**
 * Causes the resolver never works on: a person's own hold, an engine pause, a safety stop, and things only a person can supply.
 * Named by call sites (or recognised by `classifyCause`), never taken from model output.
 */
export const NON_RESOLVABLE_CAUSES: readonly string[] = Object.freeze(['parked', 'human_hold', 'engine_pause', 'restart_guard', 'no_repo', 'integrity', 'resolver_crash']);
