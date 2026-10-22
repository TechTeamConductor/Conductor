# Implementation plan — M8-5 UI: run mode, approve-waiting, Settings polish, evidence

- Task: brief F5/F6/F9/F10 leftover UI (`product-layer.md`); M8-4 Security UI contract; M8-4 Reviewer N3/N9; M8-U deferred `runMode` / `/api/run-mode` grep; remaining plan A1.
- Author: TechTeam Lead
- Date: 2026-10-21
- Plan status: **approved** (Reviewer rev 2, 2026-10-21 — `reviews/workspace-v2-m8-5-plan-review.md`)
- Clone HEAD baseline: `256159c` (M8-3 + M8-4 backend landed; UI has no `runMode` yet — `test/ui-safety.test.ts` still forbids the strings)

## 1. Current State

- **Backend (done):** `PUT /api/run-mode` (confirm to turn on Complete auto), `POST /api/runs/approve-waiting` (listed `{key,rev}` + `confirm:true` only), `settings.runMode`, `settings.overriddenByRunMode`, `settings.limitRule` / `limitRuleEffective`, `engine.runMode` / `runModeChangedAt` on SSE state, run summaries expose `forcedHold`, `risky`, `rev`, `title` while `awaiting_approval`.
- **Gap:** `waiting: { total, bulkApprovable, eligible[] }` is returned only from `PUT /api/run-mode`, not from `GET /api/state` / SSE `live()`. The Security UI contract requires building the approve list from `waiting.eligible` (server truth includes tainted-actor skips that `forcedHold===false && !risky` alone does not).
- **UI today:** Board summary has no run-mode switch. Settings has Planning / Who does what / Accounts and limits / Limits — no Run mode group; `planApproval` and `limitRule` are never disabled from `overriddenByRunMode`. Accounts UI exists (M8-3) but lacks scripted browser evidence. `LIMIT_RULE_LABEL.switch` still says “another tool” without “in the job’s list” in the **label** (hint already has chain-only wording).
- **Safety / UI rules to keep:** `h()` + `safeAttr` only; no `innerHTML`; CSRF via existing `api()`; titles/keys as text nodes; Escape closes dialogs; feature-detect `typeof settings.runMode === 'string'` so older servers never crash.

## 2. Expected State

### 2.1 Additive API (tiny, same session) — Reviewer B1

`waiting` must appear on **every** path the UI reads, not only `live()`:

1. `Api.live()` returns `waiting` (same shape as private `waiting()`: `{ total, bulkApprovable, eligible: { key, rev, title }[] }`).
2. `Api.state()` copies `waiting: live.waiting` (it cherry-picks fields today — a `live()`-only change does **not** reach `GET /api/state`).
3. `ApiState.waiting` in `src/types.ts`.
4. `ui/app.js` `onStateEvent`: when `d.waiting` is present, `S.state.waiting = d.waiting` (same pattern as `accounts`).
5. `docs/API.md`: document `waiting` on `GET /api/state` **and** on the SSE `state` event merge list.

Titles stay redacted/truncated server-side. No new write path. No change to approve-waiting or run-mode route semantics.

### 2.2 Run mode switch (Board + Settings)

- Segmented control: **Per settings** | **Complete auto**, visible when `settings.runMode` is a string.
- Board: in the Board summary row (next to the “Board” heading / summary items).
- Settings: new **Run mode** fieldset **first** (F10). Writes **immediately** via `PUT /api/run-mode` — not part of the Settings Save draft. Never send `runMode` on `PUT /api/settings`.
- Switching **to** Complete auto: confirm dialog showing the **updated** `COMPLETE_AUTO_CONFIRM` text (see §2.5 / B2), then `PUT` with `{ runMode: 'complete-auto', confirm: true }`. On 400 `confirm_required`, show the server body (same string after B2).
- Switching **off**: `PUT { runMode: 'per-settings' }` (no confirm).
- On successful `PUT /api/run-mode`: apply response `settings` + `waiting` into `S.state` immediately (Reviewer N1), then toast; do not wait for SSE.
- On change: if `waiting.total > 0`, toast/banner: N plans still waiting; if `bulkApprovable > 0`, offer **Approve waiting plans**.
- Optional muted line when `engine.runModeChangedAt` is set: “Complete auto turned on at …” (locale time).
- SSE / `loadState` keeps the control in sync (`engine.runMode` preferred when present).

### 2.3 Approve waiting plans

- Opens a dialog listing **every** `waiting.eligible` entry as key + title (text nodes).
- Confirm sends `POST /api/runs/approve-waiting` with `{ runs: eligible.map(({key,rev}) => ({key,rev})), confirm: true }` — **only** from the last server `waiting.eligible` snapshot used to render the list (never “all awaiting” from the client’s own filter).
- After response: toast approved count; list each `skipped` key with a fixed reason label (`forced` / `risky` / `stale` / `not_waiting` / `missing`).
- Button available in either mode when `waiting.bulkApprovable > 0` (M8-4: not tied to Complete auto only); primary surface = Complete-auto toast/banner + a control near the Board run-mode switch when count > 0.

### 2.4 Overridden Settings fields

When `overriddenByRunMode` contains:
- `planApproval` → disable Plan approval select; hint that Complete auto is in effect.
- `limitRule` → disable “At a usage limit”; show stored vs `limitRuleEffective` (already partially done).
- `policy` → disable per-project policy controls if present in this dialog (global policy lives elsewhere; if no control exists in Settings today, only document — do not invent a policy editor).

### 2.5 Wording (M8-4 N3 + Reviewer B2 — preferred path)

- `LIMIT_RULE_LABEL.switch` → `Next account, then the next tool in the job's list`.
- **Update** `COMPLETE_AUTO_CONFIRM` in `src/server/api.ts` so it says moves work to “the next account, then the next tool **in the job's list**” (no semantic change to the route — string only). Update any test that pins the exact string (`test/run-mode.test.ts`).
- UI pre-confirm dialog uses that same string; AC7 then matches the server 400 body. No separate UI-only confirm wording.

### 2.6 Pure helpers in `modes.js`

Add frozen helpers (vm-tested): e.g. `isCompleteAuto(runMode)`, `runModeOverridden(overridden, key)`, `approveWaitingBody(eligible)`, `skipReasonLabel(reason)` — no DOM/network.

### 2.7 Evidence + tests (Reviewer B3)

- Update `test/ui-safety.test.ts`: remove **only** `runMode` and `/api/run-mode` from the deferred ban. **Keep `/api/models`** — the UI does not call it (catalogs arrive via `/api/roles`). Grep that approve-waiting request bodies are built only from `waiting.eligible` keys.
- `test/ui-modes.test.ts`: pure helpers.
- Optional thin API test: `GET /api/state` includes `waiting`.
- Scripted browser checks (desktop + phone widths, light + dark) with screenshots under `.techteam/runs/evidence/m8-5/`: run-mode toggle + confirm, overridden fields disabled, approve-waiting list + skip display, accounts Settings smoke. Console clean. Prefer existing harness patterns (`test/ui-static.test.ts` / any browser helper already in repo); if no browser automation exists, use Cursor browser MCP once against `npm run demo` and save screenshots — document exact steps in evidence.

### Must remain unchanged

Safety invariants; CSRF/cookie; no HTML sinks; approve-waiting server rules; forced holds; zero runtime deps; argv / engine behaviour.

### Acceptance criteria

| ID | Criterion |
| --- | --- |
| AC1 | Feature-detect: without `settings.runMode`, no run-mode UI. |
| AC2 | Complete auto on requires confirm + `confirm:true`; off does not. |
| AC3 | Settings Save never sends `runMode`. |
| AC4 | Approve dialog lists only `waiting.eligible`; POST body matches that list + `confirm:true`. |
| AC5 | Skipped reasons shown; titles/keys as text nodes. |
| AC6 | `overriddenByRunMode` disables the matching controls. |
| AC7 | Chain-only wording in label/hint/confirm. |
| AC8 | `npm run check` + `npm test` green; ui-safety deferred list updated. |
| AC9 | Evidence screenshots saved for the listed surfaces. |

## 3. Files to Be Changed

| File | Action | Purpose |
| --- | --- | --- |
| `src/server/api.ts` | Modify | `waiting` on `live()`; copy into `state()`; update `COMPLETE_AUTO_CONFIRM` (B2) |
| `src/types.ts` | Modify | `ApiState.waiting` type |
| `ui/modes.js` | Modify | Pure helpers + LIMIT_RULE_LABEL wording |
| `ui/app.js` | Modify | Run-mode switch, approve dialog, Settings Run mode group, overrides; `onStateEvent` merges `waiting` |
| `ui/style.css` | Modify | Minimal styles for segmented control / banner (match design tokens already in file) |
| `test/ui-safety.test.ts` | Modify | Lift deferred ban; add path/body guards |
| `test/ui-modes.test.ts` | Modify | Helper unit tests |
| `test/run-mode.test.ts` or small addition | Modify | `waiting` on GET /api/state |
| `docs/API.md` | Modify | Document `waiting` on state |
| `.techteam/runs/evidence/m8-5/*` | Create | Screenshots |
| `.techteam/plans/workspace-v2-m8-remaining.md` | Modify | Mark A1 in progress / done |
| `.techteam/runs/active-run.md` | Modify | Checkpoint |

No changes to `pipeline/engine.ts`, providers, or approve-waiting logic except reading the existing private `waiting()`.

## 4. Implementation TODO

- [ ] Commit 1 — API: `waiting` on `live()` + `state()`; `COMPLETE_AUTO_CONFIRM` chain-only string; types; run-mode string test; API.md (state + SSE)
- [ ] Commit 2 — `modes.js` helpers + label wording + ui-modes tests; lift ui-safety deferred ids for `runMode` / `/api/run-mode` only (keep `/api/models`)
- [ ] Commit 3 — Board + Settings run-mode UI + `onStateEvent` waiting merge + override disabling + approve-waiting dialog; apply PUT response settings/waiting immediately
- [ ] Commit 4 — Evidence screenshots + remaining.md / active-run update
- [ ] `npm run check` && `npm test`
- [ ] Reviewer code review + Security checkpoint (UI contract)

## 5. Testing Strategy

- Unit: modes helpers; state.waiting shape.
- Static: ui-safety (no innerHTML; approve body built only from eligible keys; runMode allowed).
- Manual / MCP browser against `npm run demo` (fake agents): toggle mode, confirm path, approve list empty and non-empty (seed via demo if possible; else document API-level simulation).
- Regression: full `npm test`.

## 6. Risks and Dependencies

| Risk | Mitigation |
| --- | --- |
| Client invents eligible set | Only use server `waiting.eligible`; refresh before open |
| Stale list between open and confirm | Re-fetch state immediately before POST; if eligible set changed, re-render and ask again |
| Confirm text drift from server | Prefer server `confirm_required` message body when 400 |
| Browser evidence flaky | Static tests are the gate; screenshots are evidence not CI |
| Scope creep into F1 / M8-7 | Out of scope |

Depends on: M8-3 + M8-4 at `256159c` (done). Does not depend on L3c/F1.

## 7. Requirement Coverage Matrix

| Req | Planned change | Verification | Status |
| --- | --- | --- | --- |
| F6 run mode UI | §2.2 | AC1–AC3, AC6, AC9 | Covered |
| Q1 Approve waiting | §2.3 + waiting on state | AC4–AC5 | Covered |
| F10 Settings structure | Run mode first | AC6, evidence | Covered |
| F9 accounts evidence | Screenshot pass | AC9 | Covered (UI already built) |
| F5 wording / tool names | LIMIT_RULE + existing colHints | AC7 | Covered |
| M8-4 Security UI contract | eligible-only POST | AC4, ui-safety | Covered |
| M8-4 N3 chain-only wording | label/hint | AC7 | Covered |
| M8-U deferred grep | lift runMode | AC8 | Covered |
