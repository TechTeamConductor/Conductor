/**
 * run.json v1 → v2 (M1b). v1 runs were bound to a Linear issue; v2 runs are bound to a board card.
 *  - Linear-only fields move under `legacy` (kept verbatim, never interpreted);
 *  - `itemId` is empty until the importer (M1c) links the run to its imported card;
 *  - `assignedPickup` (a description that was never attribution-checked) becomes `untrusted`, which forces plan approval;
 *  - pending Linear effects are dropped (they cannot be applied to a board) and recorded under `legacy.effects`.
 */
export function migrateRunV1ToV2(raw: any): any {
  const { issueId, teamId, url, assignedPickup, effects, expected, bugs, ...rest } = raw ?? {};
  return {
    ...rest,
    itemId: typeof raw?.itemId === 'string' ? raw.itemId : '',
    untrusted: assignedPickup === true ? true : rest.untrusted,
    expected: { written: !!expected?.stateId || !!expected?.written, stage: expected?.stage },
    effects: {},
    bugs: Array.isArray(bugs)
      ? bugs.map((b: any) => {
          const { linearId, linearKey, ...bug } = b ?? {};
          return { ...bug, itemId: undefined, itemKey: undefined, legacy: linearId || linearKey ? { linearId, linearKey } : undefined };
        })
      : [],
    legacy: { ...(raw?.legacy ?? {}), ...Object.fromEntries(Object.entries({ issueId, teamId, url, effects }).filter(([, v]) => v !== undefined && !(v && typeof v === 'object' && Object.keys(v as object).length === 0))) },
    schemaVersion: 2,
  };
}
