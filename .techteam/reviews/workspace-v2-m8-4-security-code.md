# Security code checkpoint: M8-4 run mode (commits 1–3)

- Reviewer: TechTeam Security Engineer.
- Date: 2026-10-21.
- Requested by: TechTeam Backend (a6877ed060447c2d0).
- Scope: the uncommitted `src/server/api.ts` (`PUT /api/run-mode`, `POST /api/runs/approve-waiting`, `notBulkApprovable`, `waiting`), `src/pipeline/stages.ts` (approval block), `src/policy/policy.ts`, `src/board/types.ts` (`TAINTED_ACTORS`), `src/config.ts`, `src/migrate.ts`, and the tests `test/run-mode.test.ts` and `test/engine-run-mode.test.ts`.
- Method: I read the code and ran the two test files (19/19 pass). I did not run the full suite; the builder reports `test/asks.test.ts:127` failing because of M8-3 work in progress, which is not part of M8-4.

## Verified

1. **`PUT /api/run-mode`**
   - The body is strict: its prototype must be `Object.prototype`, and its own property names, read with `getOwnPropertyNames`, must be a subset of {runMode, confirm}. A `__proto__` or `constructor` key is therefore refused.
   - The mode is an enum, and `confirm` must be a boolean. `complete-auto` needs `confirm === true`, with a static message (`COMPLETE_AUTO_CONFIRM`).
   - The change is built on a `deepClone`, then `saveConfig` writes it, persisting before memory is swapped. On failure it returns 500 with a static message, and the error goes to the log.
   - The log line carries modes and counts only.
   - `PUT /api/settings` refuses `runMode` and `runModeChangedAt`, so this route is the one writer of the run mode.
2. **`POST /api/runs/approve-waiting`**
   - The body is strict in the same way: own keys {runs, confirm}; each entry has own keys {key, rev}; there are 1–50 entries with unique keys; `KEY_RE` applies; `rev` is a positive integer. `confirm` must be exactly `true`.
   - Only the listed keys are acted on; there is no "all".
   - For each run, the checks and `engine.approve(key, 'human', rev, false)` happen synchronously, with no `await` between them.
   - `notBulkApprovable` fails closed:
     - the run is not waiting;
     - `forcedHold !== false`, which covers an absent value, i.e. holds created before this slice;
     - `untrusted === true`;
     - the card's `createdBy` is unknown or a member of `TAINTED_ACTORS` (S9b);
     - the run carries risk hits, which is reported as `risky` and keeps the per-card "I understand" confirmation, because `confirmRisks` is false.
   - A stale rev, or an `EngineError` from the engine, is reported as a skip.
   - The history line is fixed text, the log carries counts only, and the titles in `eligible` are passed through `redact` and truncated to 200 characters.
3. **Forced holds do not depend on the mode.**
   - In `stages.ts`, the `forced` inputs are built only from protected paths, `untrusted` and the graph size.
   - The mode reaches the decision only through `effectivePolicy` / `effectiveFirstPlanHold`.
   - `decideApproval` sets `forcedHold` for complexity L, protected paths, untrusted input and a big graph, whatever the policy.
   - `isCompleteAuto` uses exact equality, and a migration import is forced back to per-settings (`migrate.ts` N2).
   - The static test that `stages.ts` never reads `runMode` is listed in `run-mode.test.ts`.
4. **CSRF, cookie and loopback.** Both routes are mutations behind the existing `http.ts` gate, and the HTTP tests assert 401 without a cookie and 403 without or with a wrong CSRF header.

## Findings

None at Medium or above.

- **L1 (Low, note).** An approval through `approve-waiting` is recorded as a human approval (`'human'`), together with the history line "from the waiting list". This is correct: the user listed the keys and confirmed. Keep the UI listing the exact keys and titles it sends, so that a single confirm cannot approve anything the user did not see.

Verdict: Approved
