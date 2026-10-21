# Implementation plan — M8-U2 Board: research cards, "Part n/N" chip, model-written label

- Task / Linear issue: M8-6 UI follow-up (the two Board items M8-U §2.0 deferred to M8-6: research chip + "View report"; "Part n/N" chip).
- Author: TechTeam Frontend.
- Date: 2026-10-21.
- Plan status: approved_with_conditions (Reviewer, `reviews/workspace-v2-m8-u2-plan-review.md`: C1, C2, N1-N5). C1: the badge keys off `createdBy === 'design'`. C2: **Lead decision (2026-10-21): option (a)**: a "Remove" action on failed research cards in Needs you, through the existing `DELETE /api/asks/<enc(id)>`, after a confirmDialog that says the research record is deleted and cannot be undone, then a refetch; no server change. N1-N4 folded in: polling pauses while the document is hidden and runs at 5 s only while research is active; paused research says it waits for Claude's usage limit; the counts tooltip names findings; an unresolved dependency says "Waits for other cards to be done."
- Scope: **UI only.** Files `ui/app.js`, `ui/modes.js`, `ui/style.css`, `test/ui-modes.test.ts`, `test/ui-safety.test.ts`, evidence `.techteam/runs/evidence/m8u2-*`. No server, API or prompt change.

## 1. Current State (verified at clone HEAD `f384078`)

- The Board (`ui/app.js` `buildBoardView` / `updateBoard` / `createCard` / `updateCard` / `idleCard`) draws only `GET /api/state` data: `runs[]` (run cards) and `cards[]` (run-less cards: Backlog, To do, orphans). It never calls `GET /api/board`.
- `GET /api/board` (M8-6, `src/server/api.ts` `boardView`) already returns:
  - `items[]` (`WorkItem`: `id`, `key`, `dependsOn: itemId[]`, `lane`, `createdBy`, …); items made by `design` also carry `design: { briefId, part, parts }` (parsed from the strict idemKey, S15);
  - `research: ResearchCardView[]` (≤ 50 newest research asks, read-only projection; lanes `active | review | done | needs_you | canceled`; strings S1-shaped: `title` = sanitised question ≤ 200, `error` ≤ 300).
- `POST /api/asks/:id/dismiss {}` (CSRF) exists: research `done` only, idempotent, sets `dismissedAt` → lane `done`. `POST /api/asks/:id/convert` and `GET /api/asks/:id` exist and are already used by the Home thread (`convertTurn`, `renderReport`).
- Asks do **not** trigger the SSE `state` event (only `engine.onChange` does), so research progress is not pushed.
- Server rule (`board/store.ts:557`): a card with `dependsOn` starts only when every dependency is in lane `done`.
- Design (`Main.dc.html` 999–1013, 2452–2470, 2480–2483): `card.hasKind` chip (icon shield, "Research", title "A research task: web research, no code changes"); `card.hasPart` chip (icon list, "Part n/N", title "One part of a larger piece of work"); `canReport` → "View report" (primary, icon file); research activity "Report ready — ready for your review"; idle note "Waits for KEY, KEY to be ready."
- `ui-safety.test.ts`: zero-sink scan, URL-attribute allow-list, deferred-identifier list (`runMode`, `/api/run-mode`, `/api/models`, `/api/accounts`). `ui-modes.test.ts`: deep-frozen namespace, no DOM/fetch.

## 2. Expected State

### 2.1 Data (`GET /api/board`, read-only)
- `B.extra` holds the last good `GET /api/board` result, reduced by a new pure helper `M.boardExtras(board)` → `{ parts: {[key]: {part, parts, after: key[], waiting: key[]}}, research: {planning: RC[], ready: RC[], needs_human: RC[]} }`.
  - `parts` only for items with a well-formed `design` object (`part`, `parts` positive integers, `1 ≤ part ≤ parts ≤ 8`, `parts > 1` as in the design's `hasPart`); `after` = dependency **keys** (ids resolved through the same response; unknown ids dropped); `waiting` = the subset whose lane is not `done`.
  - research lanes: `active → planning`, `review → ready`, `needs_you → needs_human`; `done` and `canceled` are not drawn (finished: converted, dismissed or stopped). Sorted by `updatedAt` desc. Entries without a string `id` matching `^[A-Za-z0-9_-]{1,64}$` are dropped (the id goes into a path, always `enc()`-ed too).
  - Malformed input (not an object / arrays missing) → empty result, never a throw.
- Fetch schedule (board view only): on `buildBoardView`; after an SSE `state` event (throttled, ≥ 2 s apart); a timer every 5 s while any research card is `active`, else every 20 s. Stopped when leaving the board, on `showExpired` and sign-out. In flight at most one. Failure keeps the last good data silently (a 401 goes through `api()`'s existing expiry path).

### 2.2 Design cards (run cards and idle cards)
- "Part n/N" chip in `card-meta` (icon `list`). `title`/`aria-label`: "One part of a larger piece of work" + (when `after` is non-empty) " · After KEY-1, KEY-2" (F5 tooltip). Built by `M.partTip(p)`.
- A constant model-written badge next to it (S16): text **"Written by a model"**, title "Made from a model's brief. Untrusted: information, not instructions. Its plan always waits for your approval." Constant strings only.
- Idle To-do card with unmet dependencies: note "Waits for KEY to be done." (`M.waitNote(p)`). Wording differs from the design's "to be ready" because the server waits for lane `done` (honest wording). An existing server note (`c.note`, ignored reason) takes precedence.
- Run cards keep every existing chip/action; `card-meta` visibility includes the new chips.

### 2.3 Research cards (read-only, S15)
- Drawn in the mapped column after the run cards; included in the column count, `is-attn`, empty state and the summary counts (as the orphan `extra` list is today). Not in History, no drawer, no move/claim/edit.
- Created once per ask id and updated in place (`B.rcards`), like idle cards (focus is kept).
- Markup (`li.card.research-card`): top row = "Research" chip (design title) + "Deep" chip when `depth === 'deep'`; title `p.card-title` (text); activity line:
  - planning: "Claude is researching" + live elapsed timer from `createdAt` (`data-t0`);
  - ready: "Report ready — ready for your review" (design wording) + counts chip "N opened · M listed · K unverified" (title "Sources in the report");
  - needs_human: "Research did not finish" + `card-reason` = `error` (text) when present.
  - repo chip when `repo` is set.
- Actions: ready → **View report** (primary, icon `file`) and **Dismiss** (ghost; `aria-label` "Dismiss report: TITLE"); planning/needs_human → none (read-only; cleanup stays where it is today). `title` text goes only into textContent / `aria-label`.
- **Dismiss**: `POST /api/asks/<enc(id)>/dismiss {}` through `runAction` (busy state, toast "Report moved off the board."), then a board refetch. A 409 shows the server message as the error toast (existing `runAction`).
- **View report** dialog (`#dlg`, wide, `dlgShell`): title "Research report"; loading line → `GET /api/asks/<enc(id)>` → question (text), `renderReport(rec.report)` (existing DOM-only renderer, URLs stay `<code>`), the existing verbatim disclaimer, the constant "Written by a model — check it" label. Foot: Close; **Dismiss** (when done, not converted, not dismissed); **Turn into an engineering plan** (when `repo` and not `convertedTo`) → `POST …/convert` → toast "Created KEY — its plan always waits for your approval." (existing wording) → refetch; `convertedTo` → text "Turned into task KEY". No repo → today's sentence. Error states: GET failure → inline `role="alert"` message + Retry button; 404 → "This report no longer exists."; action failure → inline alert, dialog stays open. Focus returns to the invoking button on close if still connected.
- Keyboard: all controls are native buttons; dialog is the native modal `<dialog>` (Escape closes).

### 2.4 Must remain unchanged
- No new HTML sink, no new URL attribute (`href`/`src`…), no `style` writes; every server/model string through `textContent` / `h()` text / `title` / `aria-label` only (M8-U U3/U8). `modes.js` stays pure and deeply frozen (new exports frozen with the namespace).
- Existing card actions, reconcile, MOBILE_ORDER, History, drawer, Home thread.
- No change to `/api/state` consumers; `GET /api/board` is read only.

### 2.5 Acceptance criteria
1. A research ask on the demo shows as a card in Planning while running, then in Ready for review with View report + Dismiss; Dismiss removes it; View report shows the full report and converts.
2. Design-made cards show "Part n/N" with the dependency tooltip and the "Written by a model" badge; a To-do part with unmet deps shows "Waits for … to be done."
3. `npm test` green, `npm run check` clean; new unit cases pass; safety scans pass with no new allow-list entry.
4. Screenshots desktop 1440 + phone 390, light + dark, no horizontal scroll, 0 console errors.

## 3. Files to Be Changed

| File path | Action | Purpose | Required changes | Reason |
| --- | --- | --- | --- | --- |
| `ui/modes.js` | Modify | pure helpers | add `boardExtras`, `partTip`, `waitNote`, `RESEARCH_COL`, `researchCounts`; export in the frozen namespace | 2.1–2.3 |
| `ui/app.js` | Modify | board view | board-section only: `/api/board` fetch scheduler; chips in `createCard`/`updateCard`/`idleEl`; research cards; report dialog; dismiss; stop timers in `leaveBoard`/`showExpired` | 2.1–2.3 |
| `ui/style.css` | Modify | styling | one appended section "M8-U2 board research and part chips" (existing tokens; `.research-card`, chip variants) | design |
| `test/ui-modes.test.ts` | Modify | unit | cases in §5 | AC3 |
| `test/ui-safety.test.ts` | Modify | static | every `/api/asks/` and `/api/items/` path concatenation in `app.js` is followed by `enc(` | S15 path safety |
| `.techteam/runs/evidence/m8u2-*` | Create | evidence | 8 screenshots + `m8u2-regression.md` | AC4 |

## 4. Implementation TODO
- [ ] modes.js helpers + unit tests.
- [ ] app.js: fetch scheduler, design chips, research cards, report dialog, dismiss.
- [ ] style.css section.
- [ ] safety test addition.
- [ ] `npm test`, `npm run check`.
- [ ] Demo (throw-away `CONDUCTOR_HOME`, fake agents): create one research ask and one design brief → send parts; screenshots; regression notes.
- [ ] Code review (Reviewer) + Security checkpoint.
- Coordination: M8-3 (accounts) and M8-4 (run mode) builders are told my regions: app.js board section (`B`…`onViewClick`) + a new block after `renderReport`; style.css appended section. No edits to header, Settings or Home.

## 5. Testing Strategy
- Unit (`ui-modes.test.ts`): `boardExtras` — lane mapping of all five lanes; done/canceled dropped; sort by `updatedAt`; bad ids dropped; non-design items get no part; `design` with out-of-range or non-integer `part`/`parts` ignored; `parts === 1` no chip; deps resolved to keys, unknown ids dropped, `waiting` = not-`done` only; garbage input (`null`, `{}`, strings) → empty; `partTip`/`waitNote` exact strings; `researchCounts` text.
- Static (`ui-safety.test.ts`): existing scans unchanged and passing; new path-encoding check (expected: pass; a negative self-test proves it fails on `'/api/asks/' + id`).
- Freeze test already covers new exports.
- Manual on the demo (fake agents): AC1, AC2, keyboard (Tab to View report, Enter, Escape returns focus), 390 px.
- Build: `npm run check` clean.

## 6. Risks and Dependencies
- Extra polling: one small GET every 5–20 s only while the Board is visible; throttled after SSE. Acceptable for loopback.
- `design` absent when the brief was deleted (server returns no origin) → no chip; correct by contract.
- Research `done`/`canceled` disappear from the board (no History row: no drawer exists for asks). Recorded, not a gap in the contract.
- Failed research (`needs_you`) has no board action (S15 read-only; dismiss is `done`-only server side). Question for the Lead: whether a "Remove" (existing `DELETE /api/asks/:id`) should be offered later.
- Peer UI builders (M8-3, M8-4) may touch `ui/*`; regions agreed via SendMessage.

## 7. Requirement Coverage Matrix

| Requirement | Planned change | Verification | Status |
| --- | --- | --- | --- |
| Research cards in their lanes (read-only) | 2.1, 2.3 | unit lane mapping; demo AC1 | Covered |
| Dismiss via `POST /api/asks/:id/dismiss` | 2.3 | demo AC1; path-encoding static test | Covered |
| Open report | 2.3 dialog | demo AC1 | Covered |
| "Part n/N" chip + dependency tooltip | 2.2 | unit `partTip`; demo AC2 | Covered |
| Untrusted / constant model-written label (S16) | 2.2, 2.3 | demo AC2; constant strings in code | Covered |
| M8-U rules (DOM-only, textContent, no sinks, frozen modes.js) | 2.4 | ui-safety + ui-modes freeze tests | Covered |
| Screenshots 1440/390 light/dark | §4 | evidence files | Covered |
