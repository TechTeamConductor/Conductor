# M8-U2 regression notes (Board research cards, "Part n/N", model-written badge)

- Date: 2026-10-21. Clone HEAD `f384078` plus the uncommitted M8-U2 diff (`ui/*`, `test/ui-modes.test.ts`, `test/ui-safety.test.ts`).
- Server: `node bin/conductor.mjs demo --port 4471 --no-open` (throw-away `CONDUCTOR_HOME` under the OS temp folder, fake agents only, no real CLI, no quota). The demo's own `fake/scenario.json` got a `research` step list (done, error, long run) so all three research lanes could be shown.
- Seeding through the page's own same-origin API calls: research 1 (done, repo demo-app), research 2 (fake error), a "Design the work" brief on demo-app sent with both parts (DEMO-4, DEMO-5 depends on DEMO-4), research 3 (long run).
- Screenshots: a scratchpad CDP script driving Brave headless at 1440x900 and 390x844 (full page), light and dark, reduced motion.

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Running research shows in Planning: "Research" chip (title "A research task: web research, no code changes"), title, "Claude is researching" with live elapsed time | pass | `m8u2-board-*` |
| 2 | Finished research shows in Ready for review: "Report ready — ready for your review", repo chip, "1 opened · 1 listed · 2 unverified", View report + Dismiss | pass | `m8u2-board-*` |
| 3 | Failed research shows in Needs you: "Research did not finish", the error as the reason, Remove | pass | `m8u2-board-*` |
| 4 | Design cards: "Part 1/2" / "Part 2/2", tooltip "One part of a larger piece of work · After DEMO-4", screen-reader text ", after DEMO-4", "Written by a model" badge on run card and idle card | pass | DOM probe + `m8u2-board-*` |
| 5 | To-do part with an open dependency: the server's own note ("Waiting for the cards it depends on to be done.") wins; `waitNote` is the fallback (unit-tested) | pass | DOM probe |
| 6 | View report: full report (DOM-only renderer, URLs as code), model-written label + verbatim disclaimer, Close / Dismiss / Turn into an engineering plan | pass | `m8u2-report-*` |
| 7 | Dialog closed with Escape/close returns focus to the View report button | pass | CDP: `document.activeElement === button` |
| 8 | Turn into an engineering plan → "Turned into task DEMO-6", toast "Created DEMO-6 — its plan always waits for your approval."; the card leaves the board (lane done) | pass | CDP |
| 9 | Remove → confirm "Remove this research? The research record "…" is deleted, with anything it found. This cannot be undone."; Cancel keeps the card; Remove deletes it (`GET /api/board` no longer lists it) | pass | CDP |
| 10 | Horizontal scroll at 1440 and 390, light and dark | none | `m8u2-shots-report.json` |
| 11 | Console errors / exceptions over all runs | 0 | `m8u2-shots-report.json` |
| 12 | Dismiss from the card (runAction path, POST `/api/asks/<enc(id)>/dismiss`), after a fourth research finished | pass: toast "Report moved off the board.", the card left the board, `GET /api/board` lane `done` (Reviewer N1) | CDP |

Not reachable on the demo: paused research ("Waiting for Claude's usage limit to reset"); deep depth chip (no depth on Quick research path); a design card whose brief was deleted (unit-tested: badge without chip).

Polling: `GET /api/board` on entering the Board, after SSE state events (at most every 2 s), every 5 s while research runs, otherwise every 20 s; stops off the Board, while the tab is hidden, and on session expiry.
