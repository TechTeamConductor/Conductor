import type { Harness } from './harness.ts';

/** Bodies of every comment on a card (user and Conductor). */
export async function comments(h: Harness, key: string): Promise<string[]> {
  return h.board.comments(key).map((c) => c.body);
}
export const laneOf = (h: Harness, key: string) => h.board.item(key)!.lane;
export const stageOf = (h: Harness, key: string) => h.board.item(key)!.stage;
