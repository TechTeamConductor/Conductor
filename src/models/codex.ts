// Codex model list PARSER ONLY (M8-1 rev 2, B4/S17). There is deliberately no spawn code, no binary lookup and no home preparation
// in this slice: enabling Codex discovery is its own plan and Security gate (S18 — private CODEX_HOME via prepareCodexHome under
// withCodexHomeLock, scratch HOME, codexEnv, JSON-RPC limited to initialize / initialized / model/list, ≤ 10 pages, kill after the last
// page, live zero-quota check).
import type { ModelEntry } from './types.ts';
import { LABEL_MAX, MAX_MODELS, cleanEffort, cleanEfforts, cleanId, cleanText, own } from './sanitize.ts';

/** A code constant, not config. Flipping it requires the S18 gate. */
export const CODEX_DISCOVERY_ENABLED = false;
export const CODEX_UNAVAILABLE_REASON = 'Codex model discovery is not available yet';
export const CODEX_MAX_PAGES = 10;

export interface ParsedCodexList {
  models: ModelEntry[];
  dropped: number;
  pages: number;
  /** More pages were offered than CODEX_MAX_PAGES. */
  truncated: boolean;
  /** The cursor for the next page (cleaned, ≤ 256), or null when the list is complete. */
  nextCursor: string | null;
}

/**
 * Fold `model/list` result pages (each `{ data: Model[], nextCursor }`) into one list. Field-by-field (S8), first id wins, ≤ 1,000
 * models, ≤ 10 pages. The id is the `model` slug (what `--model` takes), falling back to `id`.
 */
export function parseCodexModelList(pages: readonly unknown[]): ParsedCodexList {
  const models: ModelEntry[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let n = 0;
  let nextCursor: string | null = null;
  for (const page of pages) {
    if (n >= CODEX_MAX_PAGES) break;
    n++;
    const data = own(page, 'data');
    const nc = own(page, 'nextCursor');
    nextCursor = typeof nc === 'string' && nc ? cleanText(nc, 256) || null : null;
    if (!Array.isArray(data)) continue;
    for (const m of data) {
      if (models.length >= MAX_MODELS) {
        dropped++;
        continue;
      }
      const id = cleanId(typeof own(m, 'model') === 'string' ? own(m, 'model') : own(m, 'id'), 'codex');
      if (!id || seen.has(id)) {
        dropped++;
        continue;
      }
      seen.add(id);
      const e: ModelEntry = { id, label: cleanText(own(m, 'displayName'), LABEL_MAX) || id };
      const efforts = cleanEfforts(own(m, 'supportedReasoningEfforts'));
      if (efforts.length) e.efforts = efforts;
      const de = cleanEffort(own(m, 'defaultReasoningEffort'));
      if (de) e.defaultEffort = de;
      if (own(m, 'isDefault') === true) e.isDefault = true;
      models.push(e);
    }
    if (!nextCursor) break;
  }
  return { models, dropped, pages: n, truncated: n >= CODEX_MAX_PAGES && nextCursor !== null, nextCursor };
}
