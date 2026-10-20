/**
 * run.json v1 → v2 (M1b). v1 runs were bound to a Linear issue; v2 runs are bound to a board card.
 *  - Linear-only fields move under `legacy` (kept verbatim, never interpreted);
 *  - `itemId` is empty until the importer (M1c) links the run to its imported card;
 *  - `assignedPickup` (a description that was never attribution-checked) becomes `untrusted`, which forces plan approval;
 *  - pending Linear effects are dropped (they cannot be applied to a board) and recorded under `legacy.effects`.
 */
export function migrateRunV1ToV2(raw: any): any {
  const { issueId, teamId, url, assignedPickup, effects, expected, bugs, worktree, branch, baseSha, commitSha, ...rest } = raw ?? {};
  return {
    ...rest,
    // v1's checkout/branch/commits live in v1's namespace: v2 never inherits them (security review B-2) — kept only as information
    worktree: '',
    branch: '',
    baseSha: '',
    commitSha: undefined,
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
    legacy: { ...(raw?.legacy ?? {}), ...Object.fromEntries(Object.entries({ issueId, teamId, url, effects, v1Worktree: worktree, v1Branch: branch, v1BaseSha: baseSha, v1CommitSha: commitSha }).filter(([, v]) => v !== undefined && !(v && typeof v === 'object' && Object.keys(v as object).length === 0))) },
    schemaVersion: 2,
  };
}

/**
 * run.json v2 → v3 (M2). The builder guard fields stop being Cursor-named:
 *   cursorGuardSha → guardSha, noPushEnvOnly → guardEnvOnly.
 * Old values are carried verbatim. When NEITHER field exists (a hand-edited or damaged record) `guardEnvOnly` defaults to TRUE —
 * the fail-safe reading: "assume only the git env protected this run".
 */
export function migrateRunV2ToV3(raw: any): any {
  const { cursorGuardSha, noPushEnvOnly, ...rest } = raw ?? {};
  const out: any = { ...rest, schemaVersion: 3 };
  if (rest.guardSha === undefined && typeof cursorGuardSha === 'string') out.guardSha = cursorGuardSha;
  if (typeof rest.guardEnvOnly !== 'boolean') out.guardEnvOnly = typeof noPushEnvOnly === 'boolean' ? noPushEnvOnly : true;
  return out;
}
