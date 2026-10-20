import type { Harness } from './harness.ts';

export async function comments(h: Harness, key: string): Promise<string[]> {
  const i = h.linear.issueByKey(key);
  return ((await h.linear.issue(i.id)).comments ?? []).map((c) => c.body);
}
export const labelNames = (h: Harness, key: string): string[] => h.linear.issueByKey(key).labels.map((l) => l.name);
export const stateOf = (h: Harness, key: string) => h.linear.issueByKey(key).state;
