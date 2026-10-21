# Code review: M8-U2 (Board research cards, "Part n/N" chip, model-written badge)

- **Plan:** `.techteam/plans/workspace-v2-m8-u2.md`. The plan review was Approved with conditions C1 and C2.
- **Author:** TechTeam Frontend (`ae4ac80ef883da1c9`).
- **Reviewed by:** Reviewer. Independent: I edited no source, test or evidence file and wrote only this review.
- **Reviewed at:** 2026-10-21, against the uncommitted diff on HEAD `f384078`.
- **Scope:** the author's files only: `ui/app.js`, `ui/modes.js`, `ui/style.css`, `test/ui-modes.test.ts`, `test/ui-safety.test.ts` (5 files, +405/−15), plus the `m8u2-*` evidence. Other modified files belong to the M8-3 and M8-4 builders and are not part of this review.

Verdict: Approved

## What I ran

- `node --test` on `test/ui-modes`, `ui-safety` and `ui-static`: 33/33 pass.
- `tsc --noEmit`: 0 errors at the time of my run.
- Full `npm test`: I did not re-run it. The author reports failures only in routing and engine tests that the concurrent M8-3/M8-4 work touches. They are not in M8-U2's files, but the Lead must clear them before any commit.

## Checks

| Area | Result |
| --- | --- |
| **C1: badge independent of the chip** | ✅ `boardExtras` records `model: true` for every item with `createdBy === 'design'`. The Part chip needs a valid `design` with `1 ≤ part ≤ parts ≤ 8` and `parts > 1`. `setDesignChips` shows the badge from `model`. Unit cases cover `parts === 1` and a missing `design`. The badge is on both run cards and idle cards. |
| **C2: Remove for failed research** | ✅ (Lead chose option a) A Remove button on failed cards only. A `confirmDialog` states that the deletion cannot be undone; the title goes in as text. Then `DELETE /api/asks/' + enc(id)` through `runAction`, then a refetch. Cancel keeps the card (evidence #9). |
| **Read-only projection** (S15) | ✅ No drawer, move or edit for research cards. They are keyed by ask id and updated in place. The id is checked on the client with the server's own `ASK_ID_RE` (`asks/store.ts:15`) before it goes into a path, and the click handler checks it again. |
| **Path encoding** | ✅ A new static test: every `/api/asks/` and `/api/items/` concatenation is followed by `enc(`, with positive and negative self-tests. |
| **Polling** (N1) | ✅ One request in flight, guarded by a generation counter so a response that arrives after leaving the board is ignored. Polls every 5 s while research runs, otherwise every 20 s. After an SSE event, a refetch is throttled to every 2 s at most. Polling stops off the Board, while the tab is hidden (`visibilitychange` restarts it), and on expiry (`leaveBoard` in `showExpired` and on view changes). On failure, the last good data is kept. |
| **Wording** (N2–N4) | ✅ Paused research says "Waiting for Claude's usage limit to reset". The counts tooltip says "Findings in the report, by the state of their sources". `waitNote` falls back to "Waits for other cards to be done.", and the server's own note takes precedence. |
| **Report dialog** | ✅ Reuses `renderReport` (DOM-only; URLs stay `<code>`) with the constant model-written badge and the verbatim disclaimer. Dismiss appears only for `done`, not converted, not dismissed; convert only with a repo, using the existing toast wording. A 404 shows "no longer exists"; other errors show an inline alert with Retry; the dialog stays open on an action error. Focus returns to the opener (evidence #7). |
| **Counts and summary** | ✅ Research cards count in their columns and in the summary. With C2 in place, a failed card can now be cleared. |
| **DOM safety** | ✅ No new sink, URL attribute or style write. Every server string goes through text nodes, `title` or `aria-label`. The safety scans pass with no new allow-list entry. |
| **Evidence** | ✅ 8 screenshots (1440/390, light and dark), 0 console errors, no horizontal scroll. The regression table records unreachable states (paused, deep, deleted brief) as not reached, and the deleted-brief case is unit-tested. |

## Non-blocking notes

- **N1.** Evidence #12: Dismiss **from the card** (the `runAction` path) was not clicked. It shares the endpoint with the dialog but not the code. Click it once on the demo before the commit and add a line to `m8u2-regression.md`.
- **N2.** The header's Board badge still counts runs only, while the board summary now also counts failed research as "needs you". This is acceptable, because the badge's meaning ("runs need you") is unchanged. Align the two if the design wants a single number.

## Record

- Next action:
  - the Security checkpoint on this diff;
  - the Lead commits M8-U2 on its own, separate from the M8-3/M8-4 builders, once `npm test` and `npm run check` are green on the tree that gets committed.
