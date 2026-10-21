# Plan review: M8-U2 (Board research cards, "Part n/N" chip, model-written label)

- **Plan:** `.techteam/plans/workspace-v2-m8-u2.md`, checked against clone HEAD `f384078`.
- **Contract sources:**
  - `workspace-v2-m8-6.md` §2.5 and §2.6;
  - `reviews/workspace-v2-m8-6-security-design.md` S15 and S16;
  - `workspace-v2-m8-u.md` §2c.
- **Reviewed by:** Reviewer. Independent: I edited no plan, source or test file and wrote only this review.
- **Author:** TechTeam Frontend (`ae4ac80ef883da1c9`).
- **Reviewed at:** 2026-10-21.

Verdict: Approved with conditions

## Current-state claims checked against the code

All are correct:
- `boardView()` returns `items` (the last 2,000) with an optional `design{briefId, part, parts}` and `research: ResearchCardView[]` (`api.ts:375-381`).
- Lane mapping in `asks/service.ts:345`: `running|paused → active`, `failed → needs_you`, `canceled`, converted or dismissed → `done`, otherwise `review`.
- `dismiss` accepts research `done` only, is idempotent and gives a 409 otherwise (`:331-339`).
- `designOrigin` parses the strict idemKey and returns nothing once the brief is gone (`briefs/service.ts:417`).
- `claimable` requires every dependency in lane `done` (`board/store.ts:555-558`).
- Asks emit no SSE event.
- `DELETE /api/asks/:id` exists (`remove`, `:358`).

## Key choices

| # | Choice | Judgement |
| --- | --- | --- |
| 1 | Read `GET /api/board` on the Board view only, refetched at most every 2 s after an SSE `state` event, every 5 s while research is active, every 20 s otherwise, one request in flight, last good data kept on failure | **Accepted.** It is the only source and the server needs no change. Pause polling while `document.hidden`, as the 60 s state poll does (N1). |
| 2 | Research lanes: active → Planning, review → Ready for review, needs_you → Needs you; done and canceled not drawn | **Accepted for active and review.** The needs_you mapping is accepted only with C2. |
| 3 | "Waits for KEY to be done." instead of the design's "to be ready" | **Accepted.** It is the honest wording: the server waits for lane `done`. |
| 4 | The report dialog reuses `renderReport` and the existing convert | **Accepted.** No new renderer; URLs stay `<code>`. The disclaimer text and the convert toast are the existing ones. |
| 5 | Failed research has no board action | **Not acceptable as is.** See C2. |

The safety rules are kept:
- no new sink or URL attribute;
- strings only through text, `title` or `aria-label`;
- ids checked against a regex and always passed through `enc()`;
- a new static path-encoding check with a negative self-test.

## Conditions

- **C1. The S16 untrusted label must not depend on the chip.**
  - S16 says the constant untrusted label is shown on each design card. In the plan it sits next to the "Part n/N" chip, and that chip appears only when `parts > 1` and while the brief still exists (`designOrigin` returns nothing after the brief is deleted).
  - So a one-part design card, or one whose brief was deleted, would carry no label.
  - Fix: drive the "Written by a model" badge from `item.createdBy === 'design'`, which is always present. Keep the Part chip on the stricter `design` test.
  - Add unit cases for `parts === 1` and for a missing `design` field: both get the badge, neither gets the chip.
- **C2. A failed research card needs a way out, or must not count as "needs you".**
  - A `needs_you` card has no action, so nothing in the UI can ever clear it. Interrupted runs become `failed` at startup (`failInterrupted`), so these cards pile up (up to 50).
  - They would also raise the Needs you column count and the summary's "need you" count, permanently.
  - Before coding, pick one and record it in the plan:
    - **(a) Recommended:** a **Remove** action on failed research cards. It calls the existing `DELETE /api/asks/<enc(id)>` after a `confirmDialog` ("Remove this failed research? The question and its error are deleted."), through `runAction`, then refetches. No server change.
    - **(b)** Draw them in Needs you but leave them out of the attention and summary counts, with a visible "Nothing to do here: start a new research from Home" line.
  - Put the choice to the Lead, as the plan itself suggests.

## Non-blocking notes

- **N1. Polling.**
  - Skip the timer while `document.hidden`, and refetch on `visibilitychange`, as `init()` already does for state.
  - The response can carry up to 2,000 items, so keep the 5 s rate strictly to while research is `active`.
- **N2. Paused research.** `active` includes `status: 'paused'` (usage limit). Show "Waiting for Claude's usage limit" instead of "Claude is researching" when `status === 'paused'`, so the timer does not suggest progress.
- **N3. Counts tooltip.** The counts are per **finding** (`counts` come from `findings[].status`), not per source. Title the chip "Findings in the report by source state", or word it "N findings opened · …".
- **N4. Unresolved dependencies.** Items are sliced to the last 2,000, so an old dependency id can be unresolvable. When some ids cannot be resolved, say "Waits for other cards to be done." rather than nothing.
- **N5. Coordination.** The plan's regions (`app.js` board section plus a block after `renderReport`, and an appended CSS section) overlap no M8-3 or M8-4 region as described. Re-check `git diff` for foreign hunks before the code review, so the review sees only M8-U2.

## Record

- Next action: write the C2 decision (Lead) into the plan, then implement. Code review and the Security checkpoint follow.
