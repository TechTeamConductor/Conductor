# Plan review

Reviewer agent only. Silence is not approval. Do not fabricate this record.

- Task / Linear issue: M8-U, port the approved Version 16 design into the real UI (`ui/*`), wired to existing APIs
- Plan artifact: `.techteam/plans/workspace-v2-m8-u.md` (rev 1, `pending_reviewer`)
- Reviewed by: Reviewer (independent; I edited no plan, source, test or UI file, and wrote only this review)
- Reviewed at: 2026-10-21, clone HEAD `8eaab46`
- Decision: Round 1 (rev 1) **Changes requested**; Round 2 (rev 2) **Approved with conditions**. See the Round 2 section at the end.

Round 1 result (rev 1): Changes requested. Superseded by Round 2 below.

## Method

I checked every current-state claim in the plan against the code. I read:
- `CLAUDE.md`
- the brief `.techteam/briefs/product-layer.md`, including §0.2, §4 (prototype-only list) and the Decisions section
- `.techteam/plans/workspace-v2-m8.md`, and the field-contract parts of `-m8-1.md`
- `docs/API.md` and `docs/ARCHITECTURE.md`
- `ui/index.html`, `ui/app.js` (header, routing, board, cards, tools, `openAsk`, `openNewTask`, `openSettings`, boot) and `ui/style.css` (theming, motion)
- `src/server/http.ts` (static whitelist, CSP, SSE events)
- `src/server/api.ts` (`roles()`, `putRoles`, `/api/ask`, `/api/asks/*`, `/api/tasks`, `/api/settings`)
- `src/config.ts` (`toSettings`, `applySettings`, `setFirstReadOnlySlot`, `setCursorFallback`), `src/agents/roles.ts`, `src/asks/service.ts`, `src/types.ts` (`ApiState`, `ApiRunSummary`, `ApiCard`, `ApiRoles`, `ApiProvider`), `src/demo.ts`, `fixtures/fake-claude.mjs`, `package.json` and `tsconfig.json`

I also compared the design's CSS (lines 11–610), markup (610–1278) and behaviour (`ROLE_ROWS`, `detectMode`, `submitTurn`, `vm*`).

Claims that are correct:
- `app.js` has 2,379 lines and `style.css` has 776.
- `app.js` uses no HTML sinks today. `h()` writes text nodes only.
- The class counts are right: the design has 269 selectors, 133 of them already in `style.css` and 136 new.
- Every endpoint listed in §1 exists.
- No ask SSE event exists, so polling is the correct choice.
- Demo mode answers both `ask` and `research` with fake agents (`fake-claude.mjs:147-148`).
- Roles are not part of `/api/state`, so a separate `GET /api/roles` is needed.

Claims that are wrong: see B2 (static serving), B3 (contract field names) and B5 ("no server change").

## Checklist

1. **Codebase analysis is complete enough to implement safely: partly.** The inventory of screens and endpoints is good. The plan misses four things in the code that change the design of this slice:
   - the static whitelist is exact (B2);
   - `PUT /api/roles` replaces a role's whole entry (B1);
   - Settings currently edits roles through the `stages` and `onClaudeLimit` compatibility layer (B1);
   - `#/` is hard-wired as "the board" in several places (B6).
2. **Every task requirement is covered: no.**
   - Most of the design's screens are mapped: top bar, Home, Board and Settings.
   - Several shipped M5 behaviours have no stated disposition, including the `allowChange` fast path (B4).
   - Several design elements with no backend today are missing from the feature-detect list (B3).
3. **Proposed architecture is correct: mostly.** Keeping a single file plus a pure `modes.js`, feature-detecting unbuilt controls, and keeping the run drawer are all sound. Three parts need rework:
   - the role-editing semantics (B1);
   - the feature-detection contract (B3);
   - the statement that the board will "port visuals, not the prototype's re-render VM" (N6).
4. **Affected-file list is accurate: no.**
   - `src/server/http.ts` must be Modify, not "Verify only" (B2).
   - `test/server.test.ts` (or a new server test) is missing.
   - `docs/API.md` is missing: it documents the static whitelist at line 10 and the UI behaviour at lines 84–90.
   - `docs/ARCHITECTURE.md` has no UI section to modify; one must be created (N9).
5. **Security, authorization and compliance implications are addressed: no** (B5). The slice renders model-written text on a new surface, changes how role and provider assignments are made (unverified-provider acknowledgement, egress notices), and touches `http.ts`. Brief §0.2 and `CLAUDE.md` require Security sign-off for this.
6. **Testing strategy is adequate: no** (B2, B6).
   - The plan does not say how `modes.js` is loaded under `node --test` with strict `tsc`.
   - "Scripted browser" names no tool, and the repo has no browser dependency.
   - Nothing automated covers `app.js`, so a large rewrite needs an explicit regression checklist.
7. **Risks, dependencies and acceptance criteria are explicit: partly.**
   - The plan says the field contract is "written into those sub-plans", but the M8-2, M8-3 and M8-4 sub-plans do not exist yet.
   - The claim that M8-U runs in parallel on disjoint files conflicts with the master plan, which has M8-2 modifying `ui/app.js` for the row control (N10).

## Blocking items

**B1. Role assignment edits will silently lose configuration.** This affects the Who-does-what rows and the Home "Handled by" popover.

`putRoles` builds each submitted role from scratch (`src/server/api.ts:270` `const entry: RoleConfig = { providers: [] }`; `autoByComplexity` is set only if it is sent, `:293`; then `next[role] = entry`, `:296`). A naive "tool select" that sends `{roles:{planning:{providers:['cursor']}}}` has two effects:
- (a) it drops the fallback chain, so today's default `['claude','cursor']` loses the Cursor takeover that `onClaudeLimit: 'cursor'` means (`config.ts:258`, `:305-306`);
- (b) it deletes any `autoByComplexity` entry.

The current Settings dialog avoids both problems because it goes through `PUT /api/settings` `stages`, which only changes the first claude/cursor slot (`config.ts:270-279`, `setFirstReadOnlySlot`). The plan must specify the following.
- A pure chain-edit helper in `ui/modes.js` with the same semantics as `setFirstReadOnlySlot`: replace the lead, keep the other entries and their order, de-duplicate. It must echo the role's existing `autoByComplexity` unchanged. Unit tests must cover chains `[claude,cursor]`, `[cursor]`, `[claude]`, a chain with a Codex entry, and a role with `autoByComplexity`.
- The 409 `needs_acknowledgement` flow for an `unverified` provider (`api.ts:277-279`, `choices[r][p].needsAck`). The UI must show the server's message and resend with `acknowledge: [id]` only after the user explicitly confirms.
- The response's `notices` (egress disclosures, `api.ts:295`) shown to the user with `textContent`.
- Save order and atomicity in Settings, where one Save now issues two requests:
  - stop sending the `stages` patch (it would overwrite the roles PUT);
  - either send `onClaudeLimit` before the roles PUT and recompute the chains from the server's reply, or state another order that cannot clobber the result;
  - say what the user sees when one request succeeds and the other fails.
- That a change made in the Home "Handled by" popover is a persisted, global config change (it is not per request). The popover must say so, since the design shows it next to a single request.
- The follower roles in the master plan's mapping: Build → `debugging` and `documentation`; Design the work → `architecture`. Either mirror them, or state that they stay unchanged until M8-2. They must not silently diverge.

**B2. Delivering and testing `ui/modes.js` is unspecified, and the plan contradicts itself.**
- `src/server/http.ts:26-32` is an exact whitelist ("there is no directory serving"). `/modes.js` will return 404 unless an entry is added. Change §3 from "Verify only … if needed" to **Modify**: one entry `{ file: 'modes.js', type: 'text/javascript; charset=utf-8', public: false }`. Remove "No server change in this slice (`src/` untouched)" and "No server change" from §2 and §6.
- Add a server test next to `test/server.test.ts:115-122`:
  - `/modes.js` signed in returns 200 with the JS content type and the security headers;
  - signed out, it is not served (same as `/app.js`);
  - the traversal list stays green.
- Update `docs/API.md:10` (the static file list).
- `index.html` must load `<script src="/modes.js" defer>` before `/app.js`; deferred scripts keep document order. `app.js` must fail visibly, not crash silently, if the namespace is missing.
- Specify how `test/ui-modes.test.ts` loads a browser script under the repo's setup:
  - `tsconfig` includes `test/**` with `strict`, and `ui/` is not type-checked;
  - recommended: `vm.runInNewContext(readFileSync('ui/modes.js','utf8'), sandbox)`, with a `sandbox` holding only `globalThis`. Read the one frozen namespace from it through a small typed interface in the test.
  - `modes.js` must not touch `document` or `window` at load time, and must use no `import`/`export`, so that the browser and `vm` load the identical bytes.
- Rebuilding the desktop payload is enough to ship it, because `desktop/build-app.mjs:14` copies `ui/` recursively. Say so in §6.

**B3. The feature-detection contract is not sound as written.**

Field names that do not exist or are wrongly placed:
- `roleViews[r].runsAs` appears in no plan or type.
- `models` is not a field of `/api/state`. It is the M8-1 endpoint `GET /api/models` → `{ providers: CatalogView[] }`, and M8-1 says the UI feature-detects "the §2.1 view fields … no other names". Today that endpoint is a 404, so detection must be "endpoint answered 200 with that shape". It must not be a field check.
- Where `accounts` lives (`/api/state`? its own endpoint?) is unspecified.

Elements with no backend today that are missing from the feature-detect list:
- the research chip and the "report" card action (they need the Q3 research projection);
- the part-of-larger chip and the brief/parts preview (F3);
- the research depth pills and research brief (F4);
- the "Refresh models · updated … ago" control.

A control whose backend does not exist cannot be exercised in this slice. AC5 only proves absence, so this code would never run in any test, and any drift from the eventual shapes (which M8-2 and M8-3 may change during their Security designs) stays hidden. Choose one option and write it down:
- **(a) Recommended.** Do not implement controls whose backend does not exist. Leave no code for them, only the CSS that ships with the design. Each backend slice adds its control together with its wiring tests. M8-U still delivers every screen that has a backend today, which is everything the user can see today: when the fields are missing, the design shows nothing there anyway.
- **(b)** Add a contract appendix to this plan: per control, the endpoint, field path, type and one JSON fixture. Put each control's view-model as a pure function in `modes.js`, unit-tested against those fixtures, so the code is exercised. Record in `active-run.md` that M8-2, M8-3 and M8-4 must adopt the appendix or amend the UI in the same commit.

**B4. Removing the M5 start-screen dialogs needs a behaviour-by-behaviour disposition table.** Each item below exists today and must be kept, moved, or removed as a recorded user decision:
- **`allowChange`, the Quick Ask fast path** (`app.js` checkbox "Let Conductor make the change if it is small"; `api.ts:448`; documented in `docs/API.md:36`; Security-reviewed in M5/M6). The design has no control for it. Recommendation: keep it as a small Ask-only option under the composer, shown only when a repository is chosen, with today's wording and hint. Otherwise, record the removal as a user-visible change and ask the user. It must not disappear silently.
- `tierNote`, the weaker-isolation disclosure (`asks/service.ts:210`). The design omits it, and it must stay.
- `kind === 'change'` answers: the "This looks like a request for a change … Nothing was changed." line.
- The "model-written, check it" disclaimer and basis text (the design keeps these). The research disclosure: web only, cannot see your code, needs the internet, uses your Claude plan.
- Research asked with no repository: today the UI says "Choose a repository before asking …", and `convert` requires a repo (`asks/service.ts:247`). With the repo chip falling back to the last used repo, the chip must be visibly removable for research, and the convert button must handle a missing repo.
- `convertedTo`: "Turned into task KEY" with a link to the card.
- The full report: Summary, Findings with per-source state and quote, Alternatives, Recommendation, Suggested next steps, Limits, "Everything it searched and opened". Section 2.2 names only findings.
- Server errors shown verbatim (`textContent`) in the turn:
  - 429 `asksPerHour` (default 20) and `researchPerDay` (default 5, `config.ts:75-76`);
  - "two questions at once" and "A research run is already in progress";
  - offline 409 and isolation 409.
  - The composer must not retry automatically, because asks fail fast by contract.
- Build from the composer: `POST /api/tasks` caps `title` at 200 characters (`api.ts:471`), and the composer allows 4,000. State the rule, for example: title = the first line clipped at a word boundary to 120–200 characters, description = the full text. State what happens when no repo is chosen and more than one is registered (today: "Choose which repository …").
- The **New task** dialog (title + description + repo): the design keeps "New task" in the top bar and Board header. Say that `openNewTask` stays.
- The detected-tools panel: keep `hint`/`detail` for non-`ok` providers (fixed instructions, `types.ts:430-431`). Derive the per-tool job text from roles, as the design's `toolJobs` does, instead of the hard-coded strings at `app.js:~1952`.
- The header's Ask button is removed (Home replaces it), and the connection indicator (`HDR.conn`) is kept. List both.

**B5. A Security sign-off is required. "No Security design needed" is incorrect.**
- Brief §0.2: "Slices touching … model-written text also need a Security design sign-off before the first edit". `CLAUDE.md`: "Every milestone: sub-plan → Reviewer approval → implement → Reviewer **and** Security checkpoint".
- This slice:
  - renders model-written answers, reports and citations (as file chips) on a new surface;
  - changes the UX for provider-to-role assignment (unverified acknowledgement, egress notices; B1);
  - adds a static route (B2).
- Add a short Security design step before U1 (DOM-sink rules, href handling, ack/notice flow, static route) and a Security checkpoint after implementation. Mark the plan `pending_security_design`.

**B6. Regression coverage for a large `app.js` rewrite is not defined, and the routing change has known ripples.**
- No automated test covers `app.js`. Add to §5 a written regression checklist, executed against `npm run demo` with a throw-away `CONDUCTOR_HOME`, with the results recorded in `.techteam/runs/evidence/m8u-regression.md`. It must cover at least:
  - setup wizard: probe, add/remove repo, sample;
  - engine pause/resume; quota meter (5h/7d, rejected, resets); banners and dismiss; offline banner; expired session plus copy/retry; sign out;
  - board: idle cards Start/Run it/Park/Cancel; run cards Approve plan/Retry/Resume now; summary jump-to-column; mobile column order; History;
  - drawer: all 7 tabs, notes post, live log (pin/jump/filters/backlog), sessions copy and open targets, abort/cleanup/park/finish, approve with `rev`/`confirmRisks`;
  - Settings: save with the same validation messages (fix loops 1–10, parallel 1–8);
  - SSE reconnect and resync; toasts.
- Name the tool. With no new dependencies, this is the agent-driven Browser pane or Chrome. Say plainly that these checks are manual evidence, not `npm test`.
- Routing: making `#/` mean Home breaks four places that assume `#/` is the board:
  - `closeRoute()` → `history.replaceState(null,'','#/')` (`app.js:301`);
  - the brand link "Conductor, back to board" (`:470`);
  - the wizard's "Back to board" and "Go to the board" (`:2195`, `:2209`);
  - `parseHash()` always returns `view:'board'` for `#/run/:key` (`:276-282`).
- Specify the view underneath the drawer (the last Home/Board view; Board for a direct link), where the drawer goes on close, and the updated links. Add these cases to the checklist.
- Commit per U-step, running `npm run check` and `npm test` on each, so a regression can be bisected.

## Non-blocking items

- **N1. AC6 static-safety test.**
  - There is no "existing allowance for the markdown renderer": `grep` finds no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval(` or `new Function` in `ui/app.js` today. Make it zero exceptions.
  - Extend the pattern list to `setAttribute('on`, `setAttribute('style'`, a `style:` key passed to `h()`, `.cssText`, `srcdoc`, `DOMParser`, `createContextualFragment` and `javascript:`.
  - Scan `ui/index.html` for inline `<script>` bodies, `style=` and `on*=` attributes.
  - The design's two inline meters (`style="width: {{…}}"`) must use the existing `style.setProperty('--pct', …)` pattern, because CSP `style-src 'self'` blocks style attributes.
  - Any `href` built from server or model data goes through `safeHttp`. The demo research fixture includes a `javascript:` source; the design renders source URLs as `<code>` text, so keep them that way.
- **N2. Port the design's `detectMode` verbatim** (`Main.dc.html:1550-1556`). The §2.2 paraphrase differs: the design sends "find …" to Ask, and its research rule uses specific phrases. Build the unit table from the design, including ambiguous lines and the empty-text case. Repo auto-match must use word boundaries and be case-insensitive, with a test for a short repo name that is also a common word.
- **N3. Which role "Handled by" shows for Build.** The design uses the "Design the work" row (`requirements`), but F3 is not built. Today the first actor for Build is `planning`. Say which one is shown, and that it changes when M8-6 lands.
- **N4. Thread lifecycle.**
  - Keep thread state in `S`, not in the DOM, so it survives Home ↔ Board navigation (`#view` is replaced on route change).
  - Cancel poll timers on Clear and when an ask reaches a final state.
  - State whether the thread is session-only or rebuilt from `GET /api/asks`.
  - "Clear" must not call `DELETE /api/asks/:id`.
  - Progress steps come from the real `status` and `provider` fields only, with no timed fake progression (brief §4).
- **N5. When roles are fetched.** Fetch `GET /api/roles` on load, after any role PUT, when Settings opens, and on SSE `state` when `providers` change. If it fails, fall back to today's static column hints.
- **N6. Board rendering.** Keep the incremental reconcile (`B.cards`/`updateCard`/`reconcile`, live timers via `data-t0`/`data-ago`, focus preservation, `MOBILE_ORDER`). Port the design's markup and classes, not the prototype's re-render-everything view-model pattern.
- **N7. CSS port.**
  - The design scopes its rules under `.app`, uses `:where(.app)` element resets, and switches themes with `.theme-dark`/`.theme-light` classes. `style.css` uses `:root` and `prefers-color-scheme`.
  - Rescope the new rules. Do not import the element resets wholesale: they would restyle the drawer, wizard and dialogs.
  - Drop prototype-only rules, and confirm there are no `@import` or external `url()` references.
- **N8. Accessibility (AC7).**
  - `role="radiogroup"` pills (mode, tool, run mode, depth) need arrow-key roving `tabindex`, or native radios.
  - `role="menu"` needs arrow keys, Home/End and Escape.
  - Popovers return focus to their trigger.
  - Targets are at least 44 px at 390 px width.
  - Add these to AC7 explicitly.
- **N9. Docs and records.**
  - Update `docs/API.md` §"UI behaviour requirements" (lines 84–90), where Home is the new default.
  - Create a UI section in `ARCHITECTURE.md`.
  - Update the master plan's slice table: M8-5 and M8-6 lose the parts pulled forward here, and M8-2 no longer owns the "row control".
  - Update `active-run.md`.
- **N10. "Disjoint files".** That claim holds against M8-1 only. Under the master plan, M8-2 modifies `ui/app.js`. Sequence M8-2's UI work after M8-U, or say how the two are coordinated.
- **N11. "Recent on the board".** State whether it lists run-less cards (`ApiCard`) as well as `runs`, and its cap and order.
- **N12. Evidence.** Prototype screenshots show canned data. Compare layout and states, not content. Note this so that differences in values are not read as defects.

## Coverage confirmation

- Requirement mapping is complete: **no**.
- Gaps that block approval:
  - B4: M5 behaviours with no disposition, including `allowChange`.
  - B3: design elements with no backend are missing from the feature-detect list, and the contract names are undefined.
  - B1: role-edit semantics.
- The F3 and F4 Gaps already stated in §7 are acceptable as Gaps.

## Notes

- The direction is right. Porting the design onto existing endpoints, keeping the drawer and the setup wizard, keeping the DOM-only rendering rule, and adding a small pure `modes.js` with unit tests are all appropriate for a vanilla, zero-dependency UI.
- Revision 2 needs to fix B1–B6, which are plan text plus one `http.ts` entry. It does not need a new approach. I will re-review rev 2 against these items only, plus any new claims.

## Record

- Artifact: `.techteam/reviews/workspace-v2-m8-u-plan-review.md`
- Next action: revise the plan (rev 2) for B1–B6, get a Security design sign-off (B5), then return it for Reviewer approval. No `ui/*` or `src/*` edits before then.

---

## Round 2 (rev 2, 2026-10-21)

Reviewed: `.techteam/plans/workspace-v2-m8-u.md` rev 2 (823 lines, status `pending_security_design + pending_reviewer`).

I re-checked rev 2's new claims against the code:
- the signed-out static redirect (`http.ts:276-281`: a GET for a non-public whitelist path with no session gets a 302 to `/login`);
- the `startDemo` harness used by `test/server.test.ts`;
- `AskStatus` includes `paused` (`asks/store.ts:15`);
- `basis` is set before the model call (`asks/service.ts:183`);
- the research pairing gate (`routing.ts:52`, `webResearchIsolated`);
- `ROLE_NEEDS` capability classes for the follower roles (`roles.ts`);
- today's `ui/*` against every pattern in the AC6 list: no matches, so U0's safety test passes on the current code.

Verdict: Approved with conditions

### Blocking items from Round 1

| Item | Status | Evidence in rev 2 |
| --- | --- | --- |
| B1 role edits | **Closed** | §2.4.3 `roleEdit`, `setLead`, `rolesPatch`:<br>• the whole GET entry is echoed, so fallbacks, `autoByComplexity` and unknown fields survive;<br>• the case table is correct, including `[codex,claude,cursor]` → `[claude,cursor]`;<br>• an unchanged lead is not sent.<br>Save order: settings without `stages`, then a fresh `GET /api/roles`, then the roles PUT. The 409 path uses an explicit modal with a one-provider `acknowledge`, never automatic. Notices are shown through `textContent`. The partial-failure message and its re-Save behaviour are defined. The popover is labelled as a global setting. Followers are mirrored on their own chains; the capability classes match (`architecture` = `requirements` = {}, `debugging` / `documentation` = build), so the server gate is the same. Unit tests are listed in §5.1. |
| B2 `modes.js` delivery and test | **Closed** | `http.ts` is Modify (one `public:false` entry). `test/ui-static.test.ts`: signed in 200 with headers, signed-out 302 to `/login`, traversal refused. `docs/API.md:10`. Load order checked in AC6. A `vm.runInNewContext` loader with a typed facade and JSON round trip. A pure file with one frozen `globalThis` namespace. A fail-visible boot check. The desktop note. |
| B3 contract | **Closed** | Option (a): no code for controls without a backend. The §2.0 table names the owner slice of every deferred control, including those I listed as missing (research and part chips, depth, Refresh models). AC5 checks for absence. |
| B4 M5 behaviours | **Closed** | The §2.6 table covers all 15 behaviours: `allowChange` kept (Ask only, default off, reset after send), `tierNote`, the change line, disclaimers, disclosures, the no-repo research path, `convertedTo`, the full `renderReport`, verbatim errors with no retry, the Build title rule (`taskFromText`, ≤ 200), the New task dialog kept, tool hints, and the connection indicator. The header Ask button is recorded as user decision D-U1 and kept until the user answers. |
| B5 Security | **Closed as a plan item** | §2b covers T1–T8 and a post-implementation checkpoint; the status is `pending_security_design`. The sign-off itself is still outstanding (C1). |
| B6 regression and routing | **Closed** | §2.1: `S.baseView`, `parseHash` returning home/board/setup, `closeRoute` targets, and the brand and wizard links re-pointed to `#/board`. §5.4: an 11-section manual checklist that names its tools (Browser pane; a scratchpad CDP script driving the installed browser, with no repo dependency), and records unreachable states as "not reached". §4: one commit per U-step, with check and test green on each. |

Round 1 N1–N12 are all addressed: AC6, §2.2, §2.3, §2.5, §2.7, §3, §4, AC1.

### Conditions (to meet during implementation; no further plan round needed)

- **C1. Get the Security sign-off before U0, not U1.**
  - §2b's heading says "sign-off needed before U1", but U0 already edits `src/server/http.ts`, `ui/index.html` and `ui/app.js` (the boot check).
  - The plan's own status line says no `ui/*` or `src/*` file is edited before Security approves. Keep to that: no U0 commit until the §2b sign-off is recorded under `.techteam/reviews/`.
  - Security then reviews the final diff as its checkpoint.
- **C2. Unit-test the acknowledgement decision.**
  - The 409 `needs_acknowledgement` path cannot be reached on the demo (§5.4 says so).
  - Put its pure part in `modes.js`, for example `ackRequest(patch, pickedProvider)`, which returns the resend body with `acknowledge: [pickedProvider]`. Test that it:
    - acknowledges only the provider the user picked;
    - never adds a second id;
    - never mutates the original body.
  - Keep `app.js` to "show the message → on confirm, call `api` with that body".
  - In `m8u-regression.md`, record the live path as "not reached".
- **C3. Ask the user D-U1** (keep or remove the header Ask button) in the slice report, as a decision with your recommendation. Do not settle it yourself.

### Non-blocking notes

- **R2-N1. Deep Research row.** `asks/service.ts:115` calls Claude directly, so the `research` role chain is not consulted today. Only Claude passes the research gate (`webResearchIsolated`), so the row cannot change behaviour. Give the row and popover hint a line such as "Claude only today", so a lock or no-op is never mistaken for a working setting.
- **R2-N2. Same-Save interaction.**
  - Suppose one Save sets `onClaudeLimit: 'cursor'` and also changes the planning lead to Cursor. The result is `[cursor]`, and the reloaded select then shows "Wait" (the value is derived from planning, `config.ts:258`).
  - This is consistent with §6, but surprising. After reload, show a short note in the "Usage limits" group when the derived value differs from what was just saved.
- **R2-N3. `autoByComplexity`.** When a role has complexity picks, the lead shown as "the tool" is not always who runs for S, M or L. Add a hint ("Size-based picks also set: …") where a role has `autoByComplexity`.
- **R2-N4. M8-2 contract note.** `roleEdit` echoes everything inside `roles[r]`. M8-2 must keep `GET roles[r]` PUT-round-trippable once its PUT is strict: view-only data goes in `roleViews`, never in `roles[r]`. Add this line to the Lead's M8-2 contract notes.
- **R2-N5. Automate AC5.** Add the deferred-identifier grep (`runMode`, `/api/models`, `/api/accounts`, `/api/briefs`, `roleViews`) to `test/ui-safety.test.ts` instead of relying on code review. The owning slice deletes the matching check when it lands.
- **R2-N6. Bound the thread.** Cap `S.home.turns`, for example at the last 20 finished turns, so a long-lived tab does not grow without limit. A running turn is never dropped.

## Record (Round 2)

- Next action: get the Security design sign-off on §2b (C1). Then implement U0–U6, one commit per step, with C2 in U0 or U5 and C3 in the slice report. The Reviewer code checkpoint and Security checkpoint follow.
