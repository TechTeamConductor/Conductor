# Code review: M8-5 UI — run mode, approve-waiting, Settings polish

- Plan: `.techteam/plans/workspace-v2-m8-5.md` (rev 2 Approved)
- Plan review: `.techteam/reviews/workspace-v2-m8-5-plan-review.md`
- Diff: uncommitted vs HEAD `256159c` in `/Volumes/Sandisk/github/techteam-conductor-v2`
- Scope reviewed: `src/server/api.ts`, `src/types.ts`, `ui/app.js`, `ui/modes.js`, `ui/style.css`, `docs/API.md`, `test/ui-safety.test.ts`, `test/ui-modes.test.ts`, `test/run-mode.test.ts` (+ plans/evidence markdown presence)
- Reviewed by: TechTeam Reviewer, 2026-10-21
- M8-4 Security UI contract (eligible-only approve-waiting): verified in this pass

**Decision: Approved**

No blocking items. Non-blocking notes below (including unfinished AC9 evidence) do not block merging the source changes; finish them before closing A1 / M8-5 as Done.

## Evidence I observed

- `npm run check`: clean (`tsc --noEmit`).
- Focused: `node --test test/ui-modes.test.ts test/ui-safety.test.ts test/run-mode.test.ts` → 43/43 pass.
- Full `npm test`: **1081** tests, **1077** pass, **0** fail, **4** skipped.
- `COMPLETE_AUTO_CONFIRM` in `src/server/api.ts` and `ui/modes.js` are byte-identical (chain-only wording).

## Acceptance criteria

| ID | Criterion | Status |
| --- | --- | --- |
| AC1 | Feature-detect: without `settings.runMode`, no run-mode UI | **Met** — `runModeOn()` / `typeof settings.runMode === 'string'`; Board + Settings omit control when false |
| AC2 | Complete auto on requires confirm + `confirm:true`; off does not | **Met** — `window.confirm` then `PUT` with `{ confirm: true }`; off sends `{ runMode: 'per-settings' }` only; 400 `confirm_required` retries with server body |
| AC3 | Settings Save never sends `runMode` | **Met** — Save patch built only from planApproval/planReview/loops/parallel/limits/limitRule |
| AC4 | Approve dialog lists only `waiting.eligible`; POST = that list + `confirm:true` | **Met** — `loadState` → snapshot `snap.eligible` → list as text nodes → `M.approveWaitingBody(eligible)` → POST; no client `forcedHold`/`risky` invent |
| AC5 | Skipped reasons shown; titles/keys as text nodes | **Met** — `h('code')` / `h('span')`; `skipReasonLabel` for forced/risky/stale/not_waiting/missing |
| AC6 | `overriddenByRunMode` disables matching controls | **Met** — planApproval + limitRule disabled; hints updated; no policy editor invented |
| AC7 | Chain-only wording in label/hint/confirm | **Met** — `LIMIT_RULE_LABEL.switch`, hints, `COMPLETE_AUTO_CONFIRM`, Settings run-mode copy |
| AC8 | `npm run check` + `npm test` green; ui-safety deferred list updated | **Met** — see evidence; deferred ban keeps `/api/models` only |
| AC9 | Evidence screenshots under `.techteam/runs/evidence/m8-5/` | **Open** — directory absent (see N1). Plan risk / plan-review N3: static tests are the merge gate |

## M8-4 Security UI contract

| Requirement | Code | Status |
| --- | --- | --- |
| List every card that will be approved (key + title) before confirm | `openApproveWaiting` renders `eligible` only | Met |
| Build request only from `waiting.eligible` (server truth; tainted/forced skips) | Snapshot from `waitingOf().eligible` after `loadState`; helper drops bad entries | Met |
| Send only `{key, rev}` + `confirm: true` | `approveWaitingBody` | Met |
| Show each `skipped` with reason | Toast per skip via `skipReasonLabel` | Met |
| Never “approve all” / client-filtered awaiting set | No path builds body from runs with `forcedHold===false` alone | Met |
| `waiting` on every UI read path | `live()` + `state()` + SSE `onStateEvent` + `ApiState.waiting` + API.md | Met |
| CSRF / no HTML sinks | Existing `api()`; no `innerHTML` in `app.js` | Met |

## Plan §2 / B1–B3

| Item | Status |
| --- | --- |
| B1 `waiting` on live → state → types → onStateEvent → API.md (state + SSE) | Met |
| B2 `COMPLETE_AUTO_CONFIRM` chain-only; UI pre-confirm matches; tests pin string | Met |
| B3 Lift only `runMode` / `/api/run-mode`; keep `/api/models` | Met |
| Apply PUT `/api/run-mode` response `settings` + `waiting` immediately | Met |
| Pure helpers in `modes.js` + ui-modes tests | Met |

## Blocking

None.

## Non-blocking

- **N1. AC9 / Commit 4 still owed.** No `.techteam/runs/evidence/m8-5/` screenshots; `.techteam/plans/workspace-v2-m8-remaining.md` still marks A1 as next; `active-run.md` has no M8-5 checkpoint. Per approved plan risk mitigation and plan-review N3, this does not block code merge — finish before closing A1.
- **N2. ui-safety Security grep is thin.** The new test asserts string presence of `approveWaitingBody` and the route, not that the argument is the `waiting.eligible` snapshot (e.g. assert `approveWaitingBody(eligible)` near `waitingOf` / `.eligible`). Implementation is correct; tighten the pin when convenient.
- **N3. Toast after mode change does not itself offer Approve.** It reports waiting count; the Board/Settings approve control appears via `syncRunModeUi` when `bulkApprovable > 0`. Matches “primary surface = control near switch”; optional toast action would be nicer.
- **N4. Plan-approval field hint is fixed at Settings open.** `applyOverrides` updates `disabled` on mode change while the dialog is open, but the planApproval fld hint string is not rebuilt. Cosmetic.
- **N5. Optional `runModeChangedAt` muted line** not implemented (plan marked optional) — fine.

## Record

- Artifact: `.techteam/reviews/workspace-v2-m8-5-code-review.md`
- Next action: Lead may treat source as merge-ready; complete AC9 evidence + checkpoint, then Security UI checkpoint if still required by the plan. Re-check only N1 when evidence lands.
