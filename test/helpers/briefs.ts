// M8-6 test helpers: a BriefService (and AskService) wired like the runtime, on top of the fake-agent harness.
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AskService } from '../../src/asks/service.ts';
import { BriefService, type BriefDeps } from '../../src/briefs/service.ts';
import { designCards } from '../../src/runtime.ts';
import type { Run } from '../../src/types.ts';
import type { Harness } from './harness.ts';

export function briefKit(h: Harness, over: Partial<BriefDeps> = {}, askOver: Partial<ConstructorParameters<typeof AskService>[0]> = {}) {
  const scratchParent = realpathSync(mkdtempSync(join(tmpdir(), 'cond-scratch-')));
  const asks = new AskService({
    getConfig: () => h.cfg, agents: h.agents, routeStates: () => h.engine.routeStates(), freshHealth: () => h.engine.freshHealth(),
    cards: { create: (i) => { const p = h.engine.ensureProjectForRepo(i.repo); const it = h.board.createItem({ projectId: p.id, title: i.title, description: i.description, kind: 'work', lane: 'todo', idemKey: i.idemKey }, i.actor); return { key: it.key }; } },
    ...askOver,
  });
  const briefs = new BriefService({
    getConfig: () => h.cfg, agents: h.agents, routeStates: () => h.engine.routeStates(), freshHealth: () => h.engine.freshHealth(),
    secrets: (repo) => (repo ? h.engine.secretsFor({ repo } as Run) : []),
    asks, cards: designCards(h.engine, h.board, () => h.cfg), scratchParent,
    ...over,
  });
  return { briefs, asks, scratchParent };
}

/** Wait until the brief leaves `running`. */
export async function settled(b: BriefService, id: string): Promise<NonNullable<ReturnType<BriefService['get']>>> {
  await b.idle();
  return b.get(id)!;
}

export const workReply = (over: Record<string, unknown> = {}) => ({
  title: 'Add CSV export', summary: 'Users can export the table as CSV. Done when the button downloads a file.', approach: 'Add `exportCsv()` in `src/index.mjs` and a test.',
  files: [{ path: 'src/index.mjs', why: 'the entry point' }, { path: 'src/export.mjs', why: 'new module' }, { path: 'test/export.test.mjs', why: 'new test' }],
  acceptance: ['A CSV file downloads', 'A test covers it'], risks: ['Large tables may be slow.'],
  parts: [
    { title: 'Export module', summary: 'The CSV writer.', size: 'S', files: ['src/export.mjs'], deps: [] },
    { title: 'Wire the button', summary: 'Call it from the entry point.', size: 'S', files: ['src/index.mjs'], deps: [1] },
    { title: 'Tests', summary: 'Cover it.', size: 'S', files: ['test/export.test.mjs'], deps: [2] },
  ],
  ...over,
});
