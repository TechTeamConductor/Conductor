# Plan review: M8-5 UI — run mode, approve-waiting, Settings polish, evidence

Reviewer agent only. Silence is not approval. Do not fabricate this record.

- Task / Linear issue: M8 remaining A1; brief F5/F6/F9/F10 leftover UI; M8-4 Security UI contract + Reviewer N3/N9
- Plan artifact: `.techteam/plans/workspace-v2-m8-5.md` (rev 2)
- Reviewed by: Reviewer
- Reviewed at: 2026-10-21
- Decision: Approved

## Rev 2 — B1–B3 closure

| Item | Plan location | Closed? |
| --- | --- | --- |
| **B1** `waiting`: `live()` → `state()` copy → `ApiState` → `onStateEvent` → API.md (state **and** SSE) | §2.1 steps 1–5; §3 `api.ts` / `app.js` / `types.ts` / `API.md`; Commit 1 “state + SSE” | **Yes** |
| **B2** preferred path: update `COMPLETE_AUTO_CONFIRM` (+ pinned tests); UI pre-confirm = same string; AC7 matches 400 body | §2.5; §2.2 confirm dialog; §3 `api.ts`; Commit 1 | **Yes** |
| **B3** lift only `runMode` and `/api/run-mode`; **keep** `/api/models` | §2.7; Commit 2 | **Yes** |

Prior N1 (apply PUT response `settings` + `waiting` immediately) is also folded into §2.2 — good.

## Checklist (rev 2)

1. Codebase analysis is complete enough to implement safely: **yes**
2. Every task requirement is covered: **yes**
3. Proposed architecture is correct: **yes**
4. Affected-file list is accurate: **yes** (all named files exist; actions match B1–B3)
5. Security, authorization, and compliance implications are addressed: **yes**
6. Testing strategy is adequate: **yes**
7. Risks, dependencies, and acceptance criteria are explicit: **yes**

## Coverage confirmation

- Requirement mapping is complete: **yes**
- Gaps that block approval: **none**

## Blocking items

None. Implementation may proceed in the same session.

## Non-blocking

- **N1 (nit).** §3 `docs/API.md` row says “Document `waiting` on state”; §2.1 step 5 and Commit 1 already require the SSE merge list too — implement both; no plan re-edit required.
- **N2.** Extend the `Modes` type in `test/ui-modes.test.ts` when exporting new helpers.
- **N3.** Evidence via browser MCP is fine; static tests remain the merge gate.

## Notes (rev 1 context, still valid)

- Architecture matches M8-4 C4 / §2.3 / §2.6 option B and the Security approve-waiting UI contract (eligible-only list + POST).
- Scope discipline is good: no engine/approve-waiting logic changes; F1 / M8-7 out of scope.
- Safety invariants (`h`/`safeAttr`, CSRF, feature-detect `typeof settings.runMode === 'string'`) are correctly restated.

## Record

- Linear comment or artifact path: `.techteam/reviews/workspace-v2-m8-5-plan-review.md`
- Next action: implement in the same session
