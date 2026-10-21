// M8-2 test catalogs built from M8-1's REAL recordings through M8-1's own parsers (never hand-written lists), plus small shaped views.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REAL } from './helpers.ts';
import { parseClaudeInitialize } from '../../src/models/claude.ts';
import { parseCursorList } from '../../src/models/cursor.ts';
import { cursorFamilies } from '../../src/models/cursor-families.ts';
import type { CatalogView, ModelEntry } from '../../src/models/types.ts';

function claudeFrom(file: string, state: CatalogView['state'] = 'fresh'): CatalogView {
  const raw = JSON.parse(readFileSync(join(REAL, file), 'utf8'));
  const p = parseClaudeInitialize(raw.response.response)!;
  return { provider: 'claude', state, version: 1, account: 'default', source: 'claude-initialize', cliVersion: '2.1.304', fetchedAt: 1_760_000_000_000, signedIn: p.signedIn ?? true, models: p.models };
}
/** What Conductor really sees (5 entries incl. `claude-fable-5-1[1m]`). */
export const claudeEnvView = (state: CatalogView['state'] = 'fresh'): CatalogView => claudeFrom('claude-initialize-2.1.304-conductor-env.json', state);
/** A REAL reply shape, not Conductor's own env (13 entries; Sonnet 4.6 without xhigh; Haiku 4.5 without levels). */
export const claude13View = (state: CatalogView['state'] = 'fresh'): CatalogView => claudeFrom('claude-initialize-2.1.304.json', state);

export function cursorView(state: CatalogView['state'] = 'fresh'): CatalogView {
  const lines = readFileSync(join(REAL, 'cursor-list-models-2026.10.19.txt'), 'utf8').split('\n');
  const models = parseCursorList(lines).models;
  return { provider: 'cursor', state, version: 1, account: 'default', source: 'cursor-list-models', cliVersion: '2026.10.19', fetchedAt: 1_760_000_000_000, signedIn: true, models, families: cursorFamilies(models) };
}

/** A documented-shape Codex list (discovery is dormant, so no real recording exists). */
export function codexView(): CatalogView {
  const models: ModelEntry[] = [
    { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', isDefault: true },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
  ];
  return { provider: 'codex', state: 'fresh', version: 1, account: 'default', source: 'codex-app-server', cliVersion: '0.50.0', fetchedAt: 1_760_000_000_000, signedIn: true, models };
}

export const unavailable = (provider: CatalogView['provider']): CatalogView => ({ provider, state: 'unavailable', reason: 'not yet' });

/** A catalog lookup for Agents/ApiDeps from a map. */
export const catalogs = (m: Partial<Record<CatalogView['provider'], CatalogView | null>>) => (t: CatalogView['provider']): CatalogView | null => m[t] ?? null;
