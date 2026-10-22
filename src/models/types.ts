// Model discovery (M8-1, brief F7a): the shapes stored in the cache and served by GET /api/models. Every string in them has been
// through the sanitiser (src/models/sanitize.ts); nothing here is ever built by spreading a CLI or cache object (S8).

import type { ProviderId } from '../agents/providers/types.ts';
export type { ProviderId };
export const MODEL_PROVIDERS: readonly ProviderId[] = ['claude', 'cursor', 'codex'];

export interface ModelEntry {
  /** Matches MODEL_ID_RE. For Claude the `value` (alias or full id). */
  id: string;
  /** ≤ 80 characters, cleaned. */
  label: string;
  /** Claude `resolvedModel` (MODEL_ID_RE) — what "Tool default (…)" names. */
  resolved?: string;
  /** Levels the tool reports, each ∈ EFFORT_TOKENS, canonical order. */
  efforts?: string[];
  /** Codex defaultReasoningEffort. */
  defaultEffort?: string;
  /** Claude `value === 'default'`; Cursor "(current, default)"; Codex server default flag. */
  isDefault?: true;
  fast?: true;
  thinking?: true;
  adaptiveThinking?: true;
  thinkingOff?: true;
  /** Cursor "(NO ZDR)". */
  noZdr?: true;
}

/** Derived from a Cursor list, never stored and never read from disk (S12a: always recomputed). */
export interface CursorFamily {
  /** The id without its -thinking / effort / -fast suffixes. */
  family: string;
  /** Effort tokens seen, canonical order; "" = the base id (the family's own default effort). */
  efforts: string[];
  thinking: boolean;
  fast: boolean;
  label: string;
  noZdr: boolean;
  /** The concrete listed ids in this family (M8-2 composes against these; the union over all families = the listed ids). */
  ids: string[];
}

export type CatalogSource = 'claude-initialize' | 'cursor-list-models' | 'codex-app-server';

export interface Catalog {
  version: 1;
  provider: ProviderId;
  /** "default" in this slice (M8-3 adds others). */
  account: string;
  source: CatalogSource;
  cliVersion: string | null;
  /** Epoch ms. */
  fetchedAt: number;
  /** Claude: account email present / tokenSource ≠ "none"; Cursor: the call succeeded; null = unknown. */
  signedIn: boolean | null;
  /** Claude subscriptionType (cleaned, ≤ 40). */
  plan?: string;
  models: ModelEntry[];
}

export type CatalogState = 'reading' | 'fresh' | 'stale' | 'unavailable';

export interface CatalogView extends Partial<Catalog> {
  provider: ProviderId;
  state: CatalogState;
  /** One human line: static wording + redacted/scrubbed CLI detail, ≤ 200 characters, no absolute paths. */
  reason?: string;
  /** Cursor only. */
  families?: CursorFamily[];
  /** A refresh is running while a cached list is shown (N13). */
  refreshing?: true;
}

/** What one adapter run produced. A failure never carries a partial catalog (R2-5). */
export type DiscoveryOutcome =
  | {
      ok: true;
      source: CatalogSource;
      cliVersion: string | null;
      signedIn: boolean | null;
      plan?: string;
      models: ModelEntry[];
      dropped: number;
      /** Exact identity strings seen in this reply: used ONLY as redact() secrets for this refresh's reason/log lines (S3). */
      identity: string[];
    }
  | {
      ok: false;
      /** Static wording (+ scrubbed stderr detail for Claude), ≤ 200. */
      reason: string;
      kind: 'signed-out' | 'too-large' | 'turn' | 'shape' | 'timeout' | 'spawn' | 'failed' | 'refused' | 'empty';
      identity: string[];
    };
