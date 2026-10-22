# Security code checkpoint: M8-5 UI (run mode + approve waiting)

- Reviewer: TechTeam Security Engineer.
- Date: 2026-10-21.
- Scope: uncommitted M8-5 UI + thin API surface — `ui/app.js`, `ui/modes.js`, `ui/style.css`, `src/server/api.ts` (`waiting` on `live()`/`state()`, `COMPLETE_AUTO_CONFIRM` string), `src/types.ts`, `docs/API.md`, tests `test/ui-safety.test.ts`, `test/ui-modes.test.ts`, `test/run-mode.test.ts`.
- Method: read the uncommitted diff and traced the mutation paths (`api()`, `setRunMode`, `openApproveWaiting`, `approveWaitingBody`, Settings Save). Did not re-audit M8-4 server approve-waiting / run-mode body parsers (already Approved in `workspace-v2-m8-4-security-code.md`).
- Linear: no root issue in this workspace (`active-run.md`: Linear removed). Handoff recorded below in-repo only.

## Focus checklist (M8-5)

| Check | Result |
| --- | --- |
| Approve waiting uses only server `waiting.eligible` | **Pass** — dialog snapshots `waitingOf().eligible` after `loadState()`; POST body via `M.approveWaitingBody(eligible)` (key+rev only + `confirm:true`). No client-side “all awaiting” filter. Guarded by `test/ui-safety.test.ts`. |
| CSRF via existing `api()` | **Pass** — `PUT /api/run-mode` and `POST /api/runs/approve-waiting` go through `api()`, which sets `X-Conductor-CSRF` on non-GET. Settings Save also uses `api('PUT', '/api/settings', patch)` and never includes `runMode`. |
| No HTML sinks | **Pass** — keys/titles rendered with `h()` + text kids / `setText`; no `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` in the new UI. `ui-safety` still bans sinks; M8-5 adds an explicit `!/innerHTML/` assert on `app.js`. |
| Run-mode confirm | **Pass** — turning on Complete auto requires `window.confirm` of the UI copy of `COMPLETE_AUTO_CONFIRM` (API suffix stripped for display), then `PUT` with `{ runMode: 'complete-auto', confirm: true }`. Off path is `{ runMode: 'per-settings' }` with no confirm. `confirm_required` retry shows the server message and re-sends `confirm: true`. Feature-detect: UI only when `typeof settings.runMode === 'string'`. |
| `COMPLETE_AUTO_CONFIRM` chain-only | **Pass** — `src/server/api.ts` and `ui/modes.js` strings are byte-identical and name “the next tool in the job's list”. `LIMIT_RULE_LABEL.switch` updated similarly. Covered by `test/run-mode.test.ts` + `test/ui-modes.test.ts`. |
| `waiting` on state / SSE | **Pass** — `Api.live()` and `Api.state()` expose `waiting`; `normalizeState` / `onStateEvent` merge it; `docs/API.md` documents both. Tests assert `waiting` on `live()` and `GET /api/state`. |

## Verified (detail)

1. **Approve-waiting UI contract (M8-4 Security carry-over).** `openApproveWaiting` refreshes state, lists every eligible `{key, title}` as text nodes, and posts only that snapshot’s `{key, rev}` plus `confirm: true`. Skipped reasons use a fixed label map (`forced` / `risky` / `stale` / `not_waiting` / `missing`), not raw agent text.
2. **Server truth for eligibility.** Client does not invent eligibility from board columns or `forcedHold` alone; it consumes `waiting.eligible` produced by `Api.waiting()` / `notBulkApprovable` (unchanged semantics from M8-4).
3. **Run-mode writer isolation.** UI writes mode only via `PUT /api/run-mode`. Settings Save builds a patch from planApproval / planReview / loops / parallel / limits / limitRule — never `runMode` / `runModeChangedAt`.
4. **Redaction surface.** Titles in the approve list come from the server’s already-redacted/truncated `waiting.eligible[].title`; UI uses textContent paths only.

## Findings (M8-5)

None at Medium or above. **No M8-5 blockers.**

- **L1 (Low, product/UX — not a security gate).** Board/Settings “Approve waiting plans” visibility is gated on `runModeOn()` as well as `bulkApprovable > 0`. Plan AC4/AC text preferred the button whenever `bulkApprovable > 0` in either mode. Security contract (body from `eligible` only) is still met when the control is shown; QA/product may want the visibility tweak separately.

## Out of scope for this checkpoint (do not block M8-5)

**L3c / Critical F1 (follow-up Security design — separate issue).** Evidence at `.techteam/runs/evidence/l3c-project-settings.md` shows a planted project `.claude/settings.json` / `settings.local.json` `apiKeyHelper` executes under Conductor Claude argv that includes `--safe-mode` (discovery initialize, read-only stage, research). This is a Critical finding against Claude spawn hardening (F1(b)), not introduced by M8-5 UI. Requires a dedicated Security design (strip/refuse project settings, stricter CLI flag, or `--settings` override) before any claim that `--safe-mode` isolates project settings. **Do not hold M8-5 Approval on this.**

## Decision

**Approved**

M8-5 UI meets the Security UI contract for run mode and approve-waiting. Ship this slice pending Reviewer/QA as Lead schedules; open Critical F1 as a separate Claude-settings follow-up.

---

### Handoff: COMPLETE

- Delivered: `.techteam/reviews/workspace-v2-m8-5-security-code.md` — Decision **Approved**; M8-5 blockers: none.
- Artifact(s): this file; evidence note for F1: `.techteam/runs/evidence/l3c-project-settings.md` (separate).
- Acceptance criteria (Security focus): met — eligible-only approve body, CSRF via `api()`, no HTML sinks, confirm on Complete auto, chain-only confirm string, `waiting` on state/SSE.
- Checks run: static review of uncommitted diff + string equality of `COMPLETE_AUTO_CONFIRM` (api.ts ≡ modes.js). Did not re-run `npm test` in this Security pass.
- Decisions/assumptions: M8-4 server routes remain trusted; Linear unavailable for this workspace.
- Risks or known gaps: Critical F1 (project settings under `--safe-mode`) tracked separately; L1 approve-button visibility vs plan AC is non-blocking.
- Next owner/task: Lead — proceed with Reviewer/QA gates; open follow-up Security design for L3c/F1.
- Exact next action: do not block M8-5 merge/land on F1; schedule F1 design before further Claude spawn trust claims.
