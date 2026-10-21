# Code review: M8-U (port the approved V16 design into `ui/*`)

- **Reviewed by:** Reviewer. Independent: I edited no source, test or evidence file and wrote only this review.
- **Plan:** `.techteam/plans/workspace-v2-m8-u.md` rev 2.1. It covers §2c (Security U1–U10, Reviewer C1–C3, R2-N1…N6) and the implementation notes. My plan reviews are in `reviews/workspace-v2-m8-u-plan-review.md`.
- **Author:** TechTeam Frontend (`ae49c55b92c8dd875`).
- **Scope:**
  - `ui/modes.js` (new);
  - `ui/app.js`, `ui/index.html`, `ui/style.css`;
  - the one-line entry in `src/server/http.ts`;
  - `test/ui-{modes,static,safety}.test.ts`;
  - the M8-U hunks of `docs/API.md` and `docs/ARCHITECTURE.md`;
  - `.techteam/runs/evidence/m8u-*`.
  - `src/models/**` and the other M8-1 files were ignored.
- **Reviewed at:** 2026-10-21, against uncommitted files. **The files changed while I was reviewing** (`ui/app.js`, `ui/modes.js` and `ui/style.css` were all rewritten at 12:16). The review applies to this snapshot (sha256 prefixes):

| File | sha256 prefix |
| --- | --- |
| `ui/app.js` | `3e1ca5f2d2e6` |
| `ui/modes.js` | `488c25031c38` |
| `ui/index.html` | `5efd17c21c03` |
| `ui/style.css` | `febb3d88f713` |
| `src/server/http.ts` | `1f46c15c147d` |
| `test/ui-modes.test.ts` | `cadb0191efb6` |
| `test/ui-safety.test.ts` | `d0e2a693b974` |
| `test/ui-static.test.ts` | `e0073c0605c8` |

Round 1 result: Approved with conditions (C1–C4). Superseded by Round 2 at the end.

## What I ran

| Check | Result |
| --- | --- |
| `node --test` on `test/ui-modes`, `ui-safety` and `ui-static` (on the snapshot above) | 24/24 pass. `ui-modes` passed alone 3 times in a row. |
| The same three files plus `test/server.test.ts` (earlier snapshot) | 44/44 pass |
| Full `npm test` | 845 tests, 840 pass, **1 fail**, 4 skipped. The failure was `ui-modes` "modes.js defines one frozen namespace…". `modes.js` was rewritten at 12:16 while the suite was running (it started about 12:07), and the test passes on the settled file. A final full run is still owed (C2). |
| `npm run check` (`tsc`) | 3 errors, all in `test/models/sanitize.test.ts`. That file belongs to M8-1, not M8-U, but AC8 needs a clean tree before commit (C2). No error in any M8-U file. |
| Screenshots read | `m8u-home-desktop-light.png` and `m8u-settings-phone-dark.png`. Layout and states match the design; nothing overflows at 390 px. |

## Checks against the plan and my conditions

| Area | Verdict | Evidence |
| --- | --- | --- |
| **Role edits keep the rest of each role** (B1, U9) | ✅ | `roleEdit` deep-copies the fresh GET entry and changes only `providers`. `setLead` replaces the lead, keeps order and de-duplicates. `rolesPatch` sends only real changes and mirrors followers on their **own** chains. Unit tests cover the five chains, echoing of `autoByComplexity` and unknown fields, and no mutation (`test/ui-modes.test.ts:131-168`). |
| **Save order** | ✅ | `openSettings` → `onSubmit`:<br>1. local validation (same messages);<br>2. `PUT /api/settings` without `stages`, then `await loadState()`;<br>3. `applyRoleChanges`: a fresh GET, then the patch, then the acknowledgements, then the PUT.<br>Partial failure gives "Your other settings were saved. Who does what was not changed: …"; the dialog stays open and the draft is kept. Evidence #10 shows a second Save sends only GET + PUT roles. |
| **Acknowledgement flow** (U1, my C2) | ✅ | `acksNeeded` is computed from the fresh GET before the PUT: newly added providers only, `ok && needsAck`, followers included. There is one UI-authored modal per provider, "Cancel" has `autofocus`, and a Cancel on any of them sends nothing. `withAck` adds exactly the confirmed ids. A 409 that still arrives is shown and the flow stops, with no ids parsed from the message.<br>Unit-tested (`:194-229`) and exercised live on the demo, where Codex is unverified: Cancel sent no PUT; Confirm sent exactly `acknowledge:["codex"]` (evidence #9). |
| **Handled-by popover** (U2) | ✅ | A pill choice is a draft. Applying needs the explicit "Use X for every … job" button, which is disabled while the draft equals the current lead. Escape or the scrim discards the draft. It shows "This is a global setting." Notices appear inline and as a toast. The research and size-pick notes are present. |
| **`h()` attribute sinks** (U3) | ✅ | Every other attribute goes through `M.safeAttr`, which:<br>• drops handler strings and `style`, `srcdoc`, `srcset`, `formaction` and `is`;<br>• for URL attributes, keeps only `#/…`, a same-origin `/…`, or an http(s) URL from `safeHttp`.<br>`ui-safety` adds the URL-attribute allow-list plus a zero-exception sink grep, and `index.html` / `style.css` checks. I confirmed the grep list matches nothing in today's `ui/*`. |
| **Static route** (B2, U4/U6) | ✅ | One `public:false` entry. `ui-static` checks: signed in → 200 with JS type, CSP and nosniff, and the body equals the file; signed out → 302 to `/login`; case, trailing-slash, NUL, encoded-slash, traversal and `.map` variants are not served; a query string never selects another file. `modes.js` is deeply frozen, has no DOM, network, `eval` or `import`/`export` (`:56-67`), and loads in `vm` with only `URL` in the sandbox. A fail-visible boot check is present. |
| **Routing** (B6) | ✅ | `parseHash` returns home/board/setup; a run route opens over `S.baseView` (Board for a direct link). `closeRoute` uses `history.back()` when pushed, otherwise `replaceState(baseHash())`. The brand link reads "Conductor, home"; the wizard links go to `#/board`. Evidence #7 covers all paths, including back/forward. |
| **M5 disposition table** (B4) | ✅ | All kept and verbatim:<br>• `allowChange`: Ask only, needs a repo, the label names the repo, reset after send;<br>• `tierNote`, the `kind:'change'` line, the model-written disclaimer, basis, citations as `<code>` text;<br>• the research disclaimer and the full `renderReport` (reused unchanged);<br>• the no-repo convert hint, `convertedTo`;<br>• server errors verbatim, with no retry; the composer text is kept on failure;<br>• the Build title rule (`taskFromText`, tested);<br>• the New task dialog, tool hints, the connection indicator. |
| **Deferred controls absent** (B3, AC5) | ✅ | Automated: `ui-safety` checks that `app.js` mentions none of `runMode`, `/api/run-mode`, `/api/models`, `/api/accounts`, `/api/briefs`, `roleViews`. The only thing that ships for those controls is their CSS, as the plan allows. |
| **Thread lifecycle** (N4, U5, R2-N6) | ✅ | The thread lives in `S.home.turns`, in memory only, and survives navigation (`leaveHome` keeps the turns). Polls are cleared on a final state, on Clear and on expiry; a 5xx backs off and never re-asks. `dropHome` + `#view` emptied on sign-out/401. Capped at 20, dropping only finished turns. Steps come only from `status`, `basis` and `provider`. |
| **Regression coverage** (B6) | ✅ | `m8u-regression.md` runs the 11-section checklist on the demo with the tools named. Unreachable states are marked ➖ and not claimed as passes. A partial failure was forced with a test-only stub. 32 screenshots plus a JSON report: 0 console errors, no horizontal scroll at either width, light and dark. |
| **Accessibility** (N8, AC7) | ✅ (notes N3, N5) | Radiogroups use a roving tabindex with arrows and Home/End. The repo menu supports arrows, Home/End, Escape and Tab. Popover and menus return focus to their trigger. `aria-current` is on the nav tabs and the badge has an `aria-label`. Targets are at least 44 px at ≤ 640 px or with a coarse pointer, `.send` included. Reduced motion is honoured except for the progress spinner (N5). The Send accessible name says the action and target (U4). |
| **Docs** | ✅ | `API.md`: the static list (with sign-in behaviour) and the UI behaviour for Home, roles editing and no `stages`. `ARCHITECTURE.md`: the new "Dashboard UI (M8-U)" section (routes, `modes.js`, thread, who-does-what, not-built list). |

## Deviations listed in the handoff

| Deviation | Judgement |
| --- | --- |
| U2 and U3 built as one step | **Accepted.** The composer and the thread share state, so splitting them would have produced a non-working intermediate step. Bisectability is covered by C3. |
| `confirmDialog` also settles from the form's `submit` | **Accepted.** For every caller (risk approve, abort, cleanup, remove repo, acknowledgements), the result is the submitter's value, the same as `returnValue` gave before. `close` is still the path for Escape (→ false). Cancel keeps `autofocus`, so the safe default holds. See N1 for back-to-back confirms. |
| Card fade-up timer fallback (800 ms) | **Accepted.** It only removes a class. It is also needed when reduced motion or a background tab means `animationend` never fires. |
| Research-row wording | **Accepted and more accurate.** The server reports every research pairing as locked, because research runs on its own profile (`asks/service.ts:115`). The text says the job cannot be moved yet. |
| Tool hints visible only for tools in use | **Accepted with a note (N3).** It reduces noise from a tool that is not installed and not used; the wizard still shows every hint. But the hint of a tool not in use is then only a `title` on a non-focusable span. |
| D-U1: header Ask button removed, "decided by the user" | **Conditional (C4).** C3 required the user to decide. The plan and evidence record a user decision, which I cannot verify from the files. |

## Blocking items

None.

## Conditions (before commit, or as part of the commit)

- **C1. "No repository" goes stale across a mode change.**
  - `S.home.repo` keeps `ConductorModes.NONE` when the mode changes, through a pill, a card, or Auto detection.
  - `resolveRepo` then returns `{name:null, how:'none'}` even where `noneAllowed(mode)` is false. Two results:
    - With one repo registered, Ask shows the chip "No repository" and the Send name "Ask (no repository)", hides `allowChange`, and sends no `repo`. The server then **auto-picks the single repo** (`asks/service.ts:75`), so Send's name does not match the real target (Security U4).
    - Build with one repo fails with "Choose which repository this task belongs to." although there is only one.
  - Fix: treat `NONE` as Auto when the effective mode does not allow it. Do this in `resolveRepo` (pass whether "none" is allowed) or by normalising `S.home.repo` in `updateHome` and `homeSubmit`. Add a unit case.
- **C2. Run the gates on the final tree.** The files changed during this review.
  - Before committing, run `npm test` on the settled tree; it must be fully green. My run had one failure caused by the mid-run rewrite of `modes.js`.
  - Run `npm run check` and get it clean. The 3 errors are in M8-1's `test/models/sanitize.test.ts`: either fix them in M8-1 first, or commit M8-U on a tree without them.
  - Security's checkpoint on the final diff still applies.
  - Any change to `ui/*` after the snapshot above, other than Security-checkpoint fixes, needs a quick re-review.
- **C3. Commit hygiene.**
  - Commit M8-U separately from M8-1: `ui/*`, the `http.ts` line, `test/ui-*`, the M8-U doc hunks (stage `docs/*` hunk by hunk) and the evidence.
  - The per-U-step commits the plan promised were not made. One slice commit (or two: U0 foundations, then the views) is accepted.
- **C4. Where the D-U1 decision came from.**
  - The slice report must cite the user's own message deciding D-U1 (date and wording).
  - If that decision did not come from the user, restore the re-pointed Ask button as the plan specified and put D-U1 to the user.

## Non-blocking notes

- **N1. Back-to-back confirms.** With settle-on-submit, `applyRoleChanges` opens the next acknowledgement while the first `<dialog>` may still be open. It then relies on `showModal()` doing nothing on an already-open modal (older engines threw `InvalidStateError`), and on the detached first form not closing the dialog. Today only Codex can be `unverified`, so the two-provider path cannot be reached. Recommendation: at the start of `confirmDialog`, `if (dlg.open) dlg.close()`. The previous promise has already settled, so this changes nothing else.
- **N2. Stop during a Build.** While a Build POST is in flight the Send button shows **Stop**, but `stopRunningTurn` finds no ask id and does nothing. Disable the button for `sending` Build turns, or keep it as Send-disabled.
- **N3. Hints not reachable by keyboard.** A hint for a tool that is not in use is only a `title` on a non-focusable `.tool-chip`, so keyboard and touch users cannot read it. Consider `tabindex="0"` with an `aria-describedby`, or rely on the wizard and say so.
- **N4. `allowChange` survives a mode switch.** The box shows ticked again on return to Ask, possibly with a different resolved repo. Sending is correct (Ask only, with the repo-naming label), but U4's intent is better served by resetting it when the mode or the resolved repo changes.
- **N5. Spinner under reduced motion.** The `.tstep-ic .spin` override keeps the spinner rotating. This is acceptable as an essential progress indicator; a short CSS comment saying so would help.
- **N6. Focus when roles are loading.** The popover's loading state calls `pop.focus()` on a div without `tabindex`, so focus stays on the chip. Add `tabindex="-1"` to the popover.
- **N7. Unused CSS for deferred controls.** `.acct-*`, `.menu-acc`, `.eff*` ship unused, as the plan allows. The owning slices (M8-2, M8-3) should reuse these classes instead of adding parallel ones.

## Record

- Artifact: `.techteam/reviews/workspace-v2-m8-u-code-review.md`.
- Next action: Frontend fixes C1 (plus any of N1, N2, N6 it chooses). Then the Lead runs C2 on the settled tree, the Security checkpoint completes, the Lead commits per C3, and the slice report covers C4.

---

## Round 2: follow-up fixes (2026-10-21)

Re-checked files: `ui/app.js`, `ui/modes.js`, `ui/style.css` and `test/ui-*.test.ts`. M8-1 is now committed (`98174a4`, `c5a8b20`).

Verdict: Approved

| Item | Status | Evidence |
| --- | --- | --- |
| C1 "No repository" goes stale | **Closed** | `noneAllowed(mode, repoCount)` moved into `modes.js`. `resolveRepo` takes `allowNone`, and a `NONE` that is not allowed counts as Auto. `app.js:897` passes `noneAllowed(effMode())`. The chip text now comes from `res.how` (`:988`), so the chip, the Send name and the request body all agree. The repo menu checks "No repository" only where it is allowed (`:1090`). Unit test at `test/ui-modes.test.ts:261` covers each mode with one repo and with several. |
| C2 Gates on the final tree | **Closed** | M8-1 is committed. `tsc --noEmit` has 0 errors (my run). The `ui-*` tests pass 25/25 (my run). The author reports full `npm test` at 851 tests, 847 pass, 0 fail. |
| C3 Commit hygiene | **Open, for the Lead at commit time** | Commit M8-U on its own, separate from the in-progress M8-2 and M8-6 builders: stage `docs/*` hunk by hunk, and include `ui/*`, the `http.ts` line, `test/ui-*` and the evidence. |
| C4 Who decided D-U1 | **Closed** | The Lead reports the user's own answer in chat: "Remove it, match the design (Recommended)". `HDR.askBtn` and `askFromHeader` are gone (0 matches in `app.js`). |
| N1 Back-to-back confirms | Fixed | `confirmDialog` closes an open confirm before reusing the dialog (`:2597`). |
| N2 Stop during a Build | Fixed | `canStop` drives Stop. A Build that is sending shows Send, disabled. |
| N4 `allowChange` survives a mode switch | Fixed | The tick resets whenever the mode or the resolved repo changes (`allowKey`, `:1019`). |
| N5 Spinner under reduced motion | Fixed | A CSS comment says the spinner keeps turning on purpose. |
| N6 Popover focus while loading | Fixed | The popover has `tabindex="-1"`. |
| N3 Hints not reachable by keyboard | Not taken; **accepted** | The author's reason holds: a focusable span with no role is an accessibility anti-pattern. The wizard shows every hint as visible text. |
| Security L1–L3 | Not judged here | These belong to Security's own checkpoint. The added test cases pass. |

Next action: the Lead commits M8-U per C3 and finishes the slice report.
