# M8-U manual regression checklist: results (2026-10-21)

These checks are **manual evidence, not `npm test`**.

**Where they ran**
- Server: `node bin/conductor.mjs demo --port 4391 | 4392 --no-open`. Each run creates a throw-away `CONDUCTOR_HOME` under the OS temp folder and uses fake agents. No real CLI was called and no quota was used.
- Ports: 4318 was already taken by another demo process, which was left alone.

**Tools**
- Interaction, keyboard and console checks used the agent's built-in Browser pane. The pane was hidden, so the page ran as a background page; see the notes at the end.
- Screenshots came from a scratchpad Node script (not in the repo, no dependency). It drives the installed Brave headless over the Chrome DevTools Protocol at 1440×900 and 390×844, with `prefers-color-scheme` light and dark emulated (and `prefers-reduced-motion: reduce`).
  - 32 PNGs plus `m8u-shots-report.json`, all named `m8u-*`.
  - Horizontal page scroll: none, on every view at both widths.
  - Console errors: 0.

**How to compare with the prototype.** The prototype shows canned data, so compare layout and states, not values (N12).

Legend: ✅ pass · ➖ not reachable on the demo (recorded, not claimed).

| # | Item | Result | Notes |
| --- | --- | --- | --- |
| 1 | Setup wizard: "Back to board" / "Go to the board" → `#/board`; tools panel shows role-derived jobs | ✅ | Links read `#/board:Back to board` and `#/board:Go to the board`. Tools: "Claude … handles Quick Ask, Deep Research, Design the work, Write the plan, Review the plan, Verify the result". Probe, add repo and remove repo are unchanged code (wizard untouched); they were not re-run on the demo, whose setup is already complete. |
| 2 | Header: Home/Board tabs + badge, pause/resume, New task on Board only, Settings | ✅ | Badge = needs_human + plan_ready. Pause → "Paused", Resume → "Running · 0/2 busy". The header Ask button was **removed** after the user's D-U1 decision (2026-10-21), to match the design: Home is the way to ask. ➖ Quota meter: the demo reports no quota (unchanged code). |
| 3 | Banners | ✅ / ➖ | ✅ "Live updates paused — reconnecting automatically…" after the demo server was stopped. ➖ Limit, offline, storage and health banners: no such state on the demo (banner code unchanged). |
| 4 | Expired session; sign out | ✅ | Restarting the server (new auth) → 401 → the "Session expired" screen. `#view` was emptied and the Home thread dropped (Security U5). Sign out from Settings → same result; the thread text was no longer anywhere in the page. ➖ "Copy command" / "Check again": not clicked (unchanged code). |
| 5 | Board: idle cards Park / Start / Cancel; Approve plan; summary; mobile column order; empty state; role hints | ✅ | With the engine paused, a new card in To do → Park → Backlog → Cancel; toasts are verbatim. Approve from the drawer (with `rev`) → "Plan for DEMO-5 approved. Cursor starts building." Hints: "Claude writes the plan", "Cursor writes the code", "Gates, then Claude checks". Phone order starts with Needs you, then Plan ready (screenshot). |
| 6 | Drawer: all tabs, note post, actions | ✅ | Tabs shown: Overview, Live log, Plan, Verification, Sessions, Timeline; the URL followed each tab. A note was posted. Abort → confirm → Retry / Remove worktree; cleanup → removed. Escape closes. ➖ The risk confirm on approve did not trigger (no risky plan on the demo; unchanged code). ➖ Sessions copy / open targets: not clicked (unchanged code). |
| 7 | Routing | ✅ | Escape on a board-opened drawer → `#/board`. Home → Recent row → drawer with Home underneath → close → `#/`. Back → `#/board`; forward → `#/`. A direct `#/run/KEY` load → Board underneath. Brand → Home. History row → drawer. |
| 8 | Home: Ask / Research / Build; errors; Stop; Clear | ✅ | **Ask**: steps "Reading a read-only copy of demo-app" (with `main @ sha`) → "Answered by Claude"; answer, basis line, and Turn into a task with its hint. **Research**: the full report (Summary, Findings with per-source state, Alternatives, Recommendation, Steps, Limits, Searched/opened), the disclaimer, and Turn into an engineering plan → "Turned into task DEMO-4" plus a toast. **Build** (2 lines) → card DEMO-5 with title "Add a dark mode toggle to the settings page" and the full text as description, actor `user`. Send's name was "Send to the board (demo-app)". **Error**: two asks started by direct API calls, then one from Home → "Not sent" plus the verbatim 429 "Two questions are already being answered — try again in a moment."; the composer text was kept; no retry. **Stop**: Send became Stop and the turn ended "Stopped."; Clear was disabled while running. `allowChange` was shown only in Ask mode with a repo, labelled "Let Conductor make the change in demo-app if it is small". |
| 9 | Handled-by popover | ✅ | Shows "This is a global setting. …". A pill pick is only a draft; the explicit "Use Codex for every Write the plan job" button applies it. **Acknowledgement path (reachable: the demo's Codex is `unverified`)**: the confirm was UI-authored ("Use Codex for: Write the plan? Codex's isolation has not been verified…"). Cancel → no PUT. Confirm → `PUT /api/roles {"roles":{"planning":{"providers":["codex","cursor"]}},"acknowledge":["codex"]}`, and the notice appeared inline and as a toast. Reverted to Claude → `["claude","cursor"]`. Escape closes and focus returns to the chip. The repo menu works with Arrow / End / Escape and returns focus. Mode pills move with Arrow keys. |
| 10 | Settings | ✅ | Seven rows. A locked pick shows the reason verbatim ("Claude: Claude cannot write code (no build capability)."). Fix loops 11 → "Fix loops must be a whole number from 1 to 10.". Saving Review → Cursor together with `onClaudeLimit` → cursor and fix loops → 4 shows the limit note, persists both, and gives the toast "Settings saved.". **Partial failure** (test-only page stub returning 400 for `PUT /api/roles`) → "Your other settings were saved. Who does what was not changed: Forced test failure: pairing refused."; the dialog stayed open; fix loops were saved; the second Save sent only `GET` + `PUT /api/roles`. |
| 11 | Console, keyboard, 390 px, light/dark | ✅ | Console errors: 0 (CDP run). No horizontal scroll. Light and dark screenshots for Home, the Handled-by popover, Ask / Research / Build turns, Board and Settings (plus its lower half). |

**Fixes made during this pass** (all in the final diff)

- `confirmDialog` now settles from the form's submit as well as from `close`. In a background page the `close` event was delayed, so "Use it anyway" never resolved.
- Card fade-up: a timer fallback removes `is-entering`.
- The thread gets 30 px between turns and scrolls to a new turn.
- The research row's note is clear that the job cannot be moved yet. The server reports every research pairing as locked, Claude's included, because Deep Research runs on its own profile.
- A locked current choice stays readable.
- Home shows a tool's hint as visible text only when the tool is assigned to a job.
- The phone dialog footer wraps.

**After the Security code checkpoint (Approved; low findings fixed)**

- **L1. The sink and eval scan reads the raw source.** It no longer strips comments. The `app.js` header comment was reworded so the raw scan stays clean. A test proves that `'a // b'` inside a string cannot hide a sink.
- **L2. `safeAttr` checks more URL attributes.** The set now covers `ping`, `background`, `cite`, `longdesc`, `manifest`, `codebase`, `data`, `icon`, `lowsrc`, `dynsrc`, `archive`, `classid`, `usemap`, `profile` and `itemtype`. `srcset`, `imagesrcset` and `is` are dropped outright. Unit tests were added.
- **L3. A 409 from the roles PUT now opens with a plain-language line**: "The tool settings changed while you were editing. Reload Settings and try again." The server's text follows as detail, and nothing is resent. This path was code-reviewed only; it is not reachable on the demo once the fresh-GET acknowledgement flow runs.

**After the Reviewer's code review (Approved with conditions)**

- **C1 (fixed).** "No repository" no longer sticks where the mode does not allow it. `noneAllowed` moved into `modes.js`, and `resolveRepo` takes `allowNone`. Unit cases cover each mode with one repo and with several. Live check on the demo (one repo): Research → "No repository", then Build → chip "Auto · demo-app", Send "Send to the board (demo-app)"; Ask → "Auto · demo-app", "Ask about demo-app".
- **N1.** `confirmDialog` closes an open confirm before opening the next.
- **N2.** While a request is in flight, Send reads "Sending…" and is disabled. Stop appears only for a running ask. Live check: a Build POST in flight showed Send disabled, not Stop.
- **N4.** The `allowChange` tick resets when the mode or the resolved repo changes. Live check: ticked in Ask, switched to Build and back, and it was unticked.
- **N5.** A CSS comment explains why the spinner keeps turning under reduced motion.
- **N6.** The Handled-by popover has `tabindex="-1"`, so it takes focus while roles load.
- **N3 (optional) not taken.** A focusable span with no role is an accessibility anti-pattern. The hint of a tool not in use stays in its tooltip on Home and is visible text in the setup wizard.
