// Shared builders for task-graph tests: plan items, graph plans and the "approved but paused" starting point.
import type { Harness } from './harness.ts';

export type TestItem = { id: string; title: string; role: string; objective: string; dependsOn: string[]; files: string[]; criteria: string[]; verification: string[] };
export const item = (id: string, over: Partial<TestItem> = {}): TestItem => ({ id, title: `Task ${id}`, role: 'implementation', objective: `Do ${id}`, dependsOn: [], files: [`${id.toLowerCase()}.mjs`], criteria: [], verification: ['npm test'], ...over });
export function graphPlan(items: TestItem[], over: Record<string, unknown> = {}) {
  return {
    acceptanceCriteria: [{ id: 'AC1', text: 'it works', verification: 'node --test' }, { id: 'AC2', text: 'it also works', verification: 'node --test' }],
    filesToChange: items.flatMap((i) => i.files).map((path) => ({ path, action: 'create', change: 'x', reason: 'AC1' })),
    taskGraph: { items },
    ...over,
  };
}
export const two = () => graphPlan([item('T1', { criteria: ['AC1'] }), item('T2', { dependsOn: ['T1'], criteria: ['AC2'] })]);
export const three = () => graphPlan([item('T1', { criteria: ['AC1'] }), item('T2', { dependsOn: ['T1'], criteria: ['AC2'] }), item('T3', { dependsOn: ['T1'] })]);
export const manual = (c: { pipeline: { planApproval: string } }) => void (c.pipeline.planApproval = 'manual');
export const cardsOf = (h: Harness, key: string) => h.board.children(h.board.item(key)!.id).filter((c) => c.kind === 'subtask');
/** A build step that writes one file (and optionally more). */
export const writes = (file: string, content = `export const v = "${file}";\n`, extra: Record<string, string> = {}) => ({ files: { [file]: content, ...extra } });

/** Plan with the given scenario overrides, stop at the approval screen, approve while the engine is paused (nothing builds yet). */
export async function approvedPaused(h: Harness, plan: object, scenario: Record<string, unknown> = {}): Promise<string> {
  h.scenario({ claude: { '*': { plan: [{ json: plan }], ...(((scenario.claude as any) ?? {})['*'] ?? {}) } }, cursor: scenario.cursor ?? {} });
  const key = h.issue('Add the greeting');
  await h.settle();
  if (h.run(key).status !== 'awaiting_approval') throw new Error(`expected the approval screen, run is ${h.run(key).status}`);
  h.engine.setPaused(true);
  h.engine.approve(key, 'human', h.run(key).rev);
  await h.engine.tick();
  return key;
}
export async function resume(h: Harness): Promise<void> {
  h.engine.setPaused(false);
  await h.settle();
}
