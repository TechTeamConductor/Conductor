// The model/effort slice of each CLI's argv (M8-2 §2.4). PURE and a LEAF (no spawn, no fs): the argv builders in claude.ts / cursor.ts /
// providers/codex.ts call these, and `runsAs` (models/select.ts) shows exactly their output, so the preview cannot drift from what runs.
// Every helper re-checks its input (S5, S12, W1–W4): a value that fails is OMITTED, never repaired; every value is its own argv element
// (Codex `--model=<id>` is the one fused form S19 allows); effort strings are the constant table entries, never the caller's string.
import { modelIdOk } from '../models/sanitize.ts';
import { CLAUDE_EFFORTS, EFFORTS, type EffortToken } from '../models/levels.ts';

/** Claude: `--model <id>` (CLAUDE_MODEL_RE, a `[1m]`-style suffix allowed — W2) and `--effort <level>` (CLAUDE_EFFORTS only — S5). */
export function claudeModelArgs(o: { model?: unknown; effort?: unknown }): string[] {
  const out: string[] = [];
  if (modelIdOk('claude', o.model)) out.push('--model', o.model);
  const e = CLAUDE_EFFORTS.find((t) => t === o.effort);
  if (e) out.push('--effort', e);
  return out;
}

/** Cursor: `--model <listed id>` only (narrow rule — W4). Cursor never gets an effort argument: its effort lives in the listed id. */
export function cursorModelArgs(o: { model?: unknown }): string[] {
  return modelIdOk('cursor', o.model) ? ['--model', o.model] : [];
}

/** S6: the ONLY selection-derived `-c` value Codex ever receives, one literal per token (TOML-quoted, `[a-z]+` inside). */
export const CODEX_EFFORT_ARG: Readonly<Record<EffortToken, string>> = Object.freeze({
  none: 'model_reasoning_effort="none"',
  minimal: 'model_reasoning_effort="minimal"',
  low: 'model_reasoning_effort="low"',
  medium: 'model_reasoning_effort="medium"',
  high: 'model_reasoning_effort="high"',
  xhigh: 'model_reasoning_effort="xhigh"',
  max: 'model_reasoning_effort="max"',
});

/** Codex: `--model=<id>` (narrow rule, never brackets — W3) and/or `-c model_reasoning_effort="<tok>"`. Inserted before `-o` by the builder. */
export function codexModelArgs(o: { model?: unknown; effort?: unknown }): string[] {
  const out: string[] = [];
  if (modelIdOk('codex', o.model)) out.push(`--model=${o.model}`);
  const e = EFFORTS.find((t) => t === o.effort);
  if (e) out.push('-c', CODEX_EFFORT_ARG[e]);
  return out;
}
