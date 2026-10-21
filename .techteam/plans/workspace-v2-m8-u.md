# Implementation plan — M8-U Port the approved design into the real UI

- **Task.** On 2026-10-21 the user asked for "the same UI and the code". This plan builds the Version 16 design (`.techteam/design/v16/Main.dc.html`, artifact https://claude.ai/artifact/BRXGZQpV3X33j7AJ6x6ytv) as Conductor's real UI now, wired to the APIs that exist today.
- **Author.** TechTeam Lead (rev 1); TechTeam Frontend (rev 2).
- **Date.** 2026-10-21.
- **Revision.** **rev 2.** It answers the Reviewer's round 1 (`reviews/workspace-v2-m8-u-plan-review.md`: Changes requested, B1–B6, N1–N12). The change log is at the end.
- **Plan status.** **approved_with_conditions** (rev 2.1).
  - Reviewer round 2: Approved with conditions C1–C3 (`reviews/workspace-v2-m8-u-plan-review.md`).
  - Security design: Approved with conditions U1–U10 (`reviews/workspace-v2-m8-u-security-design.md`).
  - Every condition is folded into §2c below. Where §2c conflicts with an earlier section, **§2c wins**.

## 1. Current State (verified 2026-10-21, clone HEAD `8eaab46`)

**UI files**

- `ui/index.html` (88 lines) holds the icon sprite and the shell. It loads `<script src="/app.js" defer>`.
- `ui/style.css` (776 lines) defines tokens on `:root`; dark mode comes from `prefers-color-scheme`.
- `ui/app.js` (2,379 lines) is vanilla JS built on the DOM-only `h()` helper.
  - It has no HTML sinks. A grep finds no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval(` or `new Function`.
  - It has a DOM-only markdown renderer (`renderMarkdown`); its links go through `safeHttp` (http/https only).
- Views in `app.js` today:
  - the setup wizard;
  - the M5 start screen above the board: three mode cards that open the `openAsk('quick'|'research')` / `openNewTask` dialogs, plus "Your tools";
  - the board, reconciled incrementally (`B.cards`, `updateCard`, `reconcile`, `MOBILE_ORDER`);
  - the run drawer (7 tabs, notes, live log);
  - Settings, banners and toasts;
  - SSE with reconnect and resync;
  - hash routing.

**Static serving**

- `src/server/http.ts:26-32` serves an **exact whitelist**: `/`, `/app.js`, `/style.css`, `/favicon.svg`. Any new file returns 404 until it gets an entry.
- `docs/API.md:10` documents that list.
- `desktop/build-app.mjs:14` copies `ui/` recursively, so a new `ui/` file reaches the desktop app when the payload is rebuilt.

**Roles**

- `GET /api/roles` returns `{ roles, choices, needs }`.
- `PUT /api/roles` **replaces each submitted role entry**:
  - `api.ts:270` builds `entry = { providers: [] }`;
  - `autoByComplexity` is kept only if it is sent;
  - unknown keys in a role object are ignored today (M8-2 will make them known and strict);
  - entries already in the chain are not re-judged;
  - a newly assigned `unverified` provider needs `acknowledge`, otherwise the server answers `409 needs_acknowledgement`;
  - the reply carries `notices`, the egress disclosures (`api.ts:295`).
- Settings today edits roles only through the `PUT /api/settings` compatibility layer (`config.ts:270-306`):
  - `stages` goes through `setFirstReadOnlySlot`;
  - `onClaudeLimit` goes through `setCursorFallback` on planning, review and verification.

**Asks**

- `POST /api/ask {question, repo?, allowChange?}` or `{question, repo?, mode:'research'}` returns `202`. The UI then polls `GET /api/asks/:id`; there is no SSE event for asks.
- Quick Ask routes through role `context`. Deep Research always runs on Claude's web-only profile (`asks/service.ts:115`).
- Record fields: `status` (`running|paused|done|failed|canceled`), `basis` (set early for Quick Ask), `provider` (set at done), `tierNote`, `result{kind, answer, change, citations}`, `report`, `error`, `convertedTo`, `repo`.
- Errors fail fast:
  - 429: `asksPerHour`, `researchPerDay`, two at once, research already running;
  - 409: offline, isolation;
  - 409: `convert` without a repo.

**Tasks.** `POST /api/tasks {title ≤ 200, description ≤ 10,000, repo?}`.

**`#/` is hard-wired as "the board" in four places**

- `closeRoute()` (`app.js:301`);
- the brand link (`:470`);
- the wizard links (`:2195`, `:2209`);
- `parseHash()`, which always returns `view:'board'` (`:276-282`).

**The design**

- Structure: CSS at lines 11–610 (269 selectors: 133 already in `style.css`, 136 new); markup at 610–1278; behaviour and view-models at 1279–2870 (`ROLE_ROWS`, `detectMode` at 1550, `vmHeader`, `vmLanding`, `vmBoard`, `vmDialogs`).
- It scopes rules under `.app` with `:where(.app)` resets and switches themes with `.theme-dark` / `.theme-light`. Its token values are byte-identical to `style.css`.
- These class names collide with existing UI: `.hero`, `.step` / `.steps` / `.step-body` (wizard), `.sec`, `.actions`, `.check`, `.cmd`.

## 2. Expected State

### 2.0 Scope (B3: the Reviewer's option (a), Lead decision)

**M8-U builds only what has a backend today, plus the design's whole visual system (CSS).**

- Controls whose backend does not exist get **no code** in this slice: no feature detection and no dead paths.
- Each owning backend slice adds its UI step together with its wiring tests.
- Everything the user can use today is delivered. Where those fields are missing, the design shows nothing in their place anyway.

**Deferred controls and their owners**

| Deferred control (design) | Owning slice | Contract it will use (Lead notes, 2026-10-21) |
| --- | --- | --- |
| Per-role controls in the Who-does-what rows and the Handled-by popover: model, effort, Fast/Thinking, custom model id, "Runs as …". Also the collapsed "Default model for each tool". | **M8-2** | **`GET /api/roles` gains:** `roles[r].{model,custom,effort,fast,thinking}` (null/false when unset), `toolModels`, `roleViews[r].{who,status,notes}`, `models[t].{effortLabel,levels,defaultLabel,options}`.<br>**New endpoint:** `POST /api/roles/preview`.<br>**Errors:** `PUT /api/roles` errors carry `field`.<br>**Feature detection:** keys off `roleViews`. |
| "Refresh models · updated … ago"; model-list states (reading, fresh, stale, unavailable) | **M8-1 UI step** (or M8-2 if the Lead folds it in) | `GET /api/models` → `{ providers: CatalogView[] }` |
| Accounts UI:<br>• Accounts popover on the usage meter<br>• "Accounts and limits" (list, up/down, Remove, Add + Check sign-in)<br>• the limit-rule select that replaces `onClaudeLimit`<br>• account chips on cards<br>• "Restarted" / "Switched tool" chip<br>• account count and "At limit" in Your tools | **M8-3** | its sub-plan (not written yet) |
| Run-mode switch in the Board header and at the top of Settings; overridden Settings fields disabled with an explanation | **M8-4** | `settings.runMode`, `settings.overriddenByRunMode`, `settings.limitRuleEffective`, `engine.runMode`, run `forcedHold`, `PUT /api/run-mode` |
| Work and research briefs:<br>• "Design the work" brief, parts preview, "Send N tasks"<br>• research brief, Standard/Deep depth, "Send as a research task" | **M8-6** (F3, F4) | **Feature detection:** `GET /api/state.home.{design,researchBrief,limits}`.<br>**Endpoints:** `POST /api/briefs {kind:'work'\|'research', line, repo?}` → `BriefView`; `GET /api/briefs[/:id]`; `POST /api/briefs/:id/{cancel,send}`; `DELETE /api/briefs/:id`; `POST /api/asks/:id/dismiss`.<br>**Rendering differences from the design:**<br>• the approval hint on brief cards always says the plan waits for approval;<br>• the scan line says "files in the snapshot";<br>• brief text is plain text with code spans only.<br>(Full shapes: `plans/workspace-v2-m8-6.md`.) |
| Board chips and actions: research chip and the "View report" card action; "Part n/N" chip | **M8-6** (research projection Q3, F3) | `GET /api/board` gains `research[]`; design cards carry `design{briefId,part,parts}` |

**What ships now for deferred controls**

- Their CSS ships now: the classes are present and unused, under commented sections.
- Prototype-only rules are dropped: `.proto-note`, `.acc-demo`, and the "Use up limit" / "Reset now" styling.
- Until M8-6 lands, Build in the composer uses the existing `POST /api/tasks`.

### 2.1 Shell (design `vmHeader`)

**Top bar, in order**

- Brand link: `href="#/"`, accessible name "Conductor, home".
- Nav tabs **Home** / **Board**, with `aria-current="page"` on the active one.
  - The Board badge counts runs in `needs_human` + `plan_ready` (the same count as the page title).
  - The badge's `aria-label` is "N need you".
- Engine pill and pause toggle (unchanged).
- Usage meter: today's non-interactive `quota` with its tooltip. It becomes a button only in M8-3.
- Spacer, then the connection indicator (kept).
- **Ask** button (kept, see §2.6, D-U1). It goes to Home with Ask selected and focuses the composer. Hidden while on Home.
- **New task** (today's `openNewTask` dialog). Shown on the Board view, hidden on Home, as in the design.
- Settings.

**Routing (B6)**

- `#/` (and an empty hash) → Home. Home is the default once setup is complete.
- `#/board` → Board.
- `#/setup` → wizard.
- `#/run/:key[/tab]` → the drawer over the **base view**.
  - `S.baseView` is the last Home or Board view shown.
  - On a fresh load with a direct run link it is **Board**.
- `parseHash()` returns `{ view: 'home'|'board'|'setup', key, tab }`. For a run route, `view = S.baseView`.
- `closeRoute()`:
  - if the drawer was opened by an in-app click (`S.pushedRun`), it calls `history.back()`, as today;
  - otherwise it calls `history.replaceState(null, '', S.baseView === 'home' ? '#/' : '#/board')`.
- Links:
  - the brand goes to `#/`;
  - the wizard's "Back to board" becomes `href="#/board"` (label kept);
  - the wizard's "Go to the board" becomes `#/board` (label kept);
  - the banner "Open setup" stays `#/setup`.

**Banners.** Existing banner logic is unchanged; the design's banner CSS is identical to today's.

**Fail visibly (B2).** At boot, `app.js` checks `window.ConductorModes`. If it is missing:

- `#view` shows "The dashboard did not load completely (modes.js is missing). Reload the page; if it persists, restart Conductor.", with `role="alert"`;
- nothing else is built.

### 2.2 Home (design `vmLanding`)

Home replaces the M5 start screen and its Ask and Research dialogs. Every behaviour of those dialogs is kept (§2.6).

**Idle layout**

- **Hero**: the mark, "What do you want to do?", and one honest line (§2.6 wording).
- **Composer** (`.composer`):
  - `textarea.cmp-input`: `maxlength` 4000, `aria-label` "Your request". It auto-grows through `style.setProperty('--cmp-h', …)` (CSSOM only).
  - Pills **Auto / Ask / Build / Research** in a `role="radiogroup"`. In Auto with text present, the pill reads "Auto · Ask" (etc.), from `detectMode`.
  - **Repo chip** with a menu.
  - **Handled-by chip** with a popover.
  - **Send** button, which becomes Stop while a turn runs.
  - Keys: Enter sends; Shift+Enter inserts a new line; IME composition is respected.
- **Below the composer**:
  - the mode's disclosure line (§2.6);
  - the Ask-only `allowChange` option (§2.6);
  - example lines (the design's `SUGGEST` wording; clicking one only fills the textarea).
- **Three equal-height mode cards.** A click selects the mode and focuses the composer. Each card has a "who" line built from `GET /api/roles`:
  - "Answered by `<lead(context)>`";
  - "Planned by `<lead(planning)>` · built by `<lead(implementation)>`";
  - "Researched by `<lead(research)>`".
- **Your tools** row, built from `providers`:
  - each chip shows the icon, the label and a state badge;
  - the chip's title is "vX · handles …", with the job list taken from roles (`toolJobs`);
  - for a non-`ok` provider, its fixed `hint` (or `detail`) is **visible text** under the row (B4).
- **Recent on the board** (N11):
  - open runs only, so not `closed`; run-less cards are excluded because they have no drawer;
  - ordered by `updatedAt` descending, capped at 4;
  - hidden when empty;
  - a row click opens the run drawer over Home.

**Mode → role (N3)**

| Mode | Role | Note |
| --- | --- | --- |
| Ask | `context` | |
| Research | `research` | Claude only today. The server locks Cursor and Codex research; the popover shows their reasons. |
| Build | `planning` | Planning is the first actor today. Becomes `requirements` when M8-6 adds "Design the work". |

**Repo resolution (pure `resolveRepo` in `modes.js`, N2)**

The menu offers:

- "Auto (best match)";
- each registered repo;
- "No repository": always for Research, and for Ask only when the number of registered repos ≠ 1. The server auto-picks a single repo, exactly as in today's dialog.

Auto resolves in this order:

1. A **unique** repo whose name appears in the text as a whole word, case-insensitive. Names are escaped before going into the word-boundary regex. Two matches mean no match.
2. Otherwise, the last repo used from Home (`sessionStorage 'home:lastRepo'`; only a registered name is stored).
3. Otherwise, the only registered repo.
4. Otherwise, none.

The chip always shows what was resolved: "Auto · demo-app", "demo-app", "No repository", or "Choose repo".

**Handled-by chip and popover (B1)**

- The chip shows the lead tool of the mode's role, for example "Claude".
- The popover is a non-modal `role="dialog"`. It contains:
  - the title "Handled by **Write the plan**";
  - the line "**This is a global setting.** It changes who does this job for every request and every card, not just this one.";
  - tool pills (`radiogroup`) from `choices[role]`. A provider with `ok:false` is `aria-disabled`; choosing it shows the server's `reason` verbatim in a `role="status"` line;
  - an "All roles in Settings" link.
- Picking a tool sends `PUT /api/roles` at once, through the save flow in §2.4.3 (including the acknowledgement step and notices).

**Clear and Stop**

- Clear removes the thread from memory. It is disabled while a turn is running ("Stop it first").
- Stop cancels the running ask.

### 2.3 Home thread (design `turnVM`), from real fields only (N4)

**State**

- The thread lives in `S.home.turns`, in memory for the page's lifetime.
- It survives Home ↔ Board navigation, because `#view` is rebuilt from `S`.
- It is **not** rebuilt from `GET /api/asks` after a reload.
- A turn is `{ id, mode, text, repo, askId, rec, phase, error, created }`.
- `phase` is one of `sending | running | done | failed | canceled | error | sent`.

**Polling**

- Each running turn has its own `setTimeout`, every 1.5 s.
- The timer is cleared:
  - when the turn reaches a final state;
  - on Clear;
  - on `showExpired`.
- Clear never calls `DELETE /api/asks/:id`, and it is disabled while a turn runs.
- `paused` is treated as running.

**Steps.** Steps come only from `status`, `basis` and `provider`. Nothing advances on a timer.

- **Ask**:
  - "Reading a read-only copy of `<repo>`", or "No repository: a general answer". Done once `basis` is set.
  - "Writing the answer". Running while `running`. It ends as done with "Answered by `<provider label>`", or as stopped on failed/canceled.
- **Research**: one step, "Researching on the web. This can take a few minutes." It ends as done with "Report written by Claude", or as stopped.
- **Build**: one step, "Creating the task", which becomes "Sent to the board as KEY".

**Ask done**

- The answer is rendered with `renderMarkdown(result.answer)`, unchanged and DOM-only.
- `kind === 'change'` adds the line "This looks like a request for a change: TITLE (size X). Nothing was changed." (verbatim).
- Citations read "Sources: " followed by `<code>file:lines</code>` chips. They are **text, never links**.
- The basis line reads "Based on BASIS. The answer is model-written — check it before relying on it.", followed by `tierNote` (verbatim, as today).
- Then one of three endings:
  - with `convertedTo`: "Started as task KEY" (fast path) or "Turned into task KEY", plus "View on board";
  - with a repo: **Turn into a task**, plus the design's hint "Nothing was added to the board. Turning it into a task always waits for your approval.";
  - without a repo: "Choose a repository before asking if you want to turn this into a task."

**Research done**

- The full `renderReport`, unchanged:
  - Summary;
  - Findings, with each source's state and quote;
  - Alternatives;
  - Recommendation;
  - Suggested next steps;
  - Limits;
  - "Everything it searched and opened".
- Source URLs stay `<code>` text.
- The model-written / source-state disclaimer, verbatim.
- **Turn into an engineering plan** when the turn has a repo. Otherwise, today's sentence: "Choose a repository before asking if you want to turn the findings into an engineering plan."
- "Turned into task KEY" once converted.

**Failures**

- `rec.error`, or the POST's `ApiFail.message`, is shown verbatim in a `c-bad` callout through `textContent`. This covers:
  - the 429s: per hour, per day, "Two questions…", "A research run is already in progress";
  - the offline and isolation 409s.
- There is no automatic retry.
- The user's text stays in the bubble. The composer is cleared only after a successful POST.

**Build**

- Sends `POST /api/tasks` with `taskFromText(text)`:
  - **title** = the first non-empty line, with whitespace collapsed. If it is longer than 200 characters, it is cut at the last space at or after character 120 (otherwise hard-cut at 199) and "…" is appended;
  - **description** = the full text when it differs from the title (multi-line or clipped); otherwise omitted.
- When no repo is resolved, today's messages apply:
  - more than one repo registered → the inline error "Choose which repository this task belongs to." and the repo menu opens;
  - no repos registered → "Add a repository first (Settings, then Repositories and setup)."
- On success, the turn shows the design's `.sent` block: "Sent to the board", the KEY chip, and "View on board" (→ `#/board`).

**Convert**

- Sends `POST /api/asks/:id/convert`.
- On success: the toast "Created KEY — its plan always waits for your approval." (as today), then the record is re-polled.
- A server 409 (for example, no repo) is shown verbatim.

### 2.4 Settings (design `vmDialogs`), regrouped

#### 2.4.1 Groups, in order

1. **Planning**: plan approval and plan review, with today's hints.
2. **Who does what**:
   - intro line adjusted to today: "Pick the tool for each job. Some tools cannot take some jobs yet; the reason is shown when you pick one.";
   - seven rows (§2.4.2).
3. **Usage limits**: today's `onClaudeLimit` select and wording. M8-3 renames the group to "Accounts and limits" and replaces the select.
4. **Limits**: fix loops (1–10), parallel runs (1–8), and the no-gates behaviour, with the same validation messages.

The footer is unchanged: Sign out, Repositories and setup, Cancel, Save changes. The Run-mode group arrives with M8-4.

#### 2.4.2 Rows (`ROLE_ROWS` in `modes.js`; follower roles decided, B1)

| Row | Role | Followers (mirrored in the same PUT) |
| --- | --- | --- |
| Quick Ask | `context` | — |
| Deep Research | `research` | — |
| Design the work | `requirements` | `architecture` |
| Write the plan | `planning` | — |
| Review the plan | `review` | — |
| Build the code | `implementation` | `debugging`, `documentation` |
| Verify the result | `verification` | — |

**Decision: followers mirror their primary.**

- When a row's lead changes, each follower gets the same lead through `roleEdit`, applied to the follower's **own** current entry. Its own fallbacks and `autoByComplexity` are kept.
- A follower has the same capability class as its primary, so the server's pairing gate is the same.
- The row hint says so (for example, "Also used for debugging and documentation"), so a follower never diverges silently.

**Row behaviour**

- Each row has the design's tool pills (`radiogroup`, roving tabindex).
- A locked provider is `aria-disabled`. When chosen, the server's reason shows verbatim in the row's `role="status"` note; it is also the pill's `title`.
- Rows are a **draft until Save**.
- If `GET /api/roles` fails:
  - the group shows "Couldn't load who does what: MSG" with a Retry button;
  - Save sends no roles.

#### 2.4.3 Chain edit and save flow (B1)

**`roleEdit(entry, to)`** (in `modes.js`)

- Returns a shallow copy of the **whole role object from GET**, with `providers = setLead(entry.providers, to)`.
- Every other field is echoed unchanged: `autoByComplexity`, M8-2's `model` / `custom` / `effort` / `fast` / `thinking`, and any future field. This keeps the helper generic, as the Lead asked for M8-2.

**`setLead(chain, to)`**

- Replaces index 0 with `to`, keeps the remaining entries in order, then de-duplicates (first occurrence wins).
- This is `setFirstReadOnlySlot`'s rule applied to the lead slot, which is what the UI shows as "the tool".

| Chain | Set lead to | Result |
| --- | --- | --- |
| `[claude,cursor]` | `cursor` | `[cursor]` |
| `[claude,cursor]` | `claude` | `[claude,cursor]` (unchanged) |
| `[cursor]` | `claude` | `[claude]` |
| `[claude,codex]` | `cursor` | `[cursor,codex]` |
| `[codex,claude,cursor]` | `claude` | `[claude,cursor]` |

If the lead does not change, the role is not sent.

**`rolesPatch(currentRoles, changes)`** returns `{ roles: { <role>: entry } }`, containing only the roles whose `providers` actually change, followers included.

**Settings Save order**

1. **Validate locally** (fix loops, parallel runs). On failure, focus the field and send nothing.
2. **`PUT /api/settings`** with whichever of `planApproval`, `planReview`, `maxLoops`, `maxParallel`, `noGates`, `onClaudeLimit` changed. **`stages` is no longer sent**, so it cannot overwrite the roles PUT.
3. **If any row changed**:
   - `GET /api/roles`, for fresh chains after `onClaudeLimit` may have added or removed the Cursor fallback;
   - compute `rolesPatch` on the fresh entries;
   - `PUT /api/roles`.
4. **On `409 needs_acknowledgement`**:
   - `confirmDialog` shows the server's message verbatim, with "Use it anyway" (danger style) and Cancel;
   - only on an explicit confirm, the identical body is resent with `acknowledge: [<that one provider id>]`;
   - the provider id comes from the role change the user made, not from parsing the message;
   - acknowledgement is **never** automatic and never covers more than that one provider.
5. **Notices** from the reply: each is shown as a `warn` toast via `textContent`. The Handled-by popover also shows them inline (`role="status"`).
6. **Finish**: reload state and roles, close the dialog, toast "Settings saved."

**What the user sees when only part succeeds**

- Step 2 fails: the server's message shows verbatim as the form error. Nothing else was sent, and the dialog stays open.
- Step 2 succeeds, then step 3 fails or the acknowledgement is declined:
  - the form error reads "Your other settings were saved. Who does what was not changed: MSG";
  - the dialog stays open with the row draft intact;
  - settings state is reloaded, so a second Save sends only the roles.

**Handled-by popover.** Picking a tool runs steps 3–5 at once for its one role (and that role's followers).

- The pills are disabled while the request is in flight.
- On failure, the pill returns to the server's value and the message shows in the popover.

### 2.5 Board (design `vmBoard`)

**Header**

- h1 "Board".
- Summary items, each jumping to its column.
- Spacer, then "Board checked …".
- The run-mode switch arrives with M8-4.

**Column hints from roles** (pure `colHints` in `modes.js`, N5)

- Planning: "`<lead(planning)>` writes the plan".
- Building: "`<lead(implementation)>` writes the code".
- Verifying: "Gates, then `<lead(verification)>` checks".
- If roles could not be loaded, today's static hints are used.

**Empty state.** It uses the design's flow wording, built from roles and `planApproval`:

- the approve step reads:
  - "Plans are approved automatically" (auto);
  - "You confirm the first plan per repo" (first);
  - "You confirm every plan" (manual);
- the tail "or a plan needs approval" is shown unless approval is auto;
- buttons: New task, and "Repositories and setup".

**Cards**

- The design's markup and classes, rendered through the **existing incremental reconcile** (N6): `B.cards`, `updateCard`, `reconcile`, live timers via `data-t0` / `data-ago`, focus preservation, `MOBILE_ORDER`.
- The design's fade-up runs once, on a newly created card only: the class is added at creation and removed on `animationend`. A reorder never re-animates.
- Unchanged: the tool chip, repo, loops, bugs, the unverified badge, and the Approve / Retry / Resume / idle actions.
- The history list is unchanged.
- The M5 mode cards and the tools panel move off the board to Home.

**Unchanged surfaces.** The drawer, wizard, toasts and live log keep their behaviour; only the shared tokens and classes apply to them.

### 2.6 Disposition of the M5 start-screen behaviours (B4)

| # | Behaviour today | Disposition in M8-U |
| --- | --- | --- |
| 1 | `allowChange` checkbox "Let Conductor make the change if it is small", with its hint (Quick Ask dialog) | **Kept** as an Ask-only option under the composer:<br>• shown when the effective mode is Ask **and** a repo resolves (explicit, matched, last-used, or the only repo);<br>• label and hint verbatim from today;<br>• unchecked by default and **reset after every send**;<br>• sent only for Ask. |
| 2 | `tierNote` (weaker-isolation disclosure) | **Kept**, appended to the basis line verbatim. |
| 3 | The `kind === 'change'` line ("…Nothing was changed.") | **Kept** verbatim. |
| 4 | Model-written disclaimer and basis; research source-state disclaimer | **Kept** verbatim. |
| 5 | Quick Ask intro ("Answered from a read-only copy … unless you choose to.") | **Kept** as the composer note when the effective mode is Ask. |
| 6 | Research disclosure ("Searches and reads sources on the web (it cannot see your code) … uses your Claude plan.") | **Kept** as the composer note when the effective mode is Research. |
| 7 | Research without a repo: the select option "No repository (research only)" and the sentence "Choose a repository before asking …" | **Kept**:<br>• "No repository" is always in the repo menu for Research;<br>• the same sentence appears in the turn;<br>• convert is hidden without a repo;<br>• a server 409 from convert is shown verbatim. |
| 8 | `convertedTo` ("Turned into task KEY" / "Started as task KEY") | **Kept**, plus a "View on board" link. |
| 9 | Full research report, all sections | **Kept**: `renderReport` is reused unchanged. |
| 10 | Server errors shown verbatim; no automatic retry | **Kept** as a callout in the turn (`textContent`); no retry. |
| 11 | Build entry: the "Engineering Work" card opened the New task dialog | **Kept and extended**:<br>• Build from the composer (title rule in §2.3);<br>• the **New task dialog stays** (top bar on Board, and the board's empty state);<br>• `openNewTask` is unchanged. |
| 12 | Detected-tools panel: state, version, and `hint` / `detail` for non-ok providers | **Kept** on Home (Your tools) and in the wizard. The job text is now derived from roles (`toolJobs`) instead of the hard-coded strings at `app.js:~1952`. |
| 13 | The header **Ask** button | **Kept**, re-pointed: it opens Home in Ask mode with the composer focused, and is hidden on Home. The design has no such button, so it is listed under "Needs user decision" (D-U1). |
| 14 | Connection indicator (`HDR.conn`) | **Kept**. |
| 15 | M5 mode-card copy | **Kept in substance**: the Home mode cards use the design's titles, while the Build and Research descriptions keep today's honest wording until M8-6 (below). |

**Wording that differs from the design.** The design describes F3 and F4, which are not built yet, so these lines keep honest wording until M8-6 restores the design's text:

- Hero line: "Write one line. Conductor answers it, researches it, or sends it to the board as work."
- Build card: "Features, refactors, bug fixes. Sent to the board as a task: Conductor plans it, splits it into tasks if needed, builds and verifies it."
- Research card: "Compare options and check evidence on the web. A report with sources, shown as opened, listed or unverified."
- Build pill title: "Engineering work: sent to the board as a task".
- Research pill title: "Deep Research: a web report with sources".

**Needs user decision.** Nothing in this list is removed until the user decides.

- **D-U1. Header Ask button.**
  - Facts: the approved design has no Ask button, because Home replaces it.
  - Recommendation: remove it.
  - Until the user decides, it stays, re-pointed to Home.

### 2.7 Visual system (N7, N8)

**CSS port**

- The design's new rules are appended to `style.css` under section comments, using the existing `:root` tokens; the token values are identical.
- One value changes: `.dlg-wide` becomes 780 px (the design's width), for the Settings rows.
- **Rescoped**:
  - no `.app` wrapper;
  - no `:where(.app)` resets, which would restyle the drawer, wizard and dialogs;
  - no `.theme-*` classes; `prefers-color-scheme` stays.
- Colliding design classes are renamed, for the Home thread only:

| Design class | Ported as |
| --- | --- |
| `.hero` / `.hero-mark` | `.home-hero` / `.home-hero-mark` |
| `.steps` / `.step*` | `.tsteps` / `.tstep*` |
| `.sec` (inside the doc) | `.doc-sec` |
| `.actions` | `.turn-actions` |

- The design's variants of `.check` and `.cmd` are not imported; the existing ones are kept.
- The CSS has no `@import` and no external `url()`; the safety test checks this.

**Accessibility (AC7)**

- Radiogroup pills (mode, tool) use a roving `tabindex`: Arrow keys and Home/End move, Space/Enter selects.
- The repo menu is `role="menu"` with `menuitemradio` items: Arrow keys, Home/End, Escape, and Tab closes it.
- The Handled-by popover closes on Escape or an outside click.
- Every popover and menu returns focus to its trigger.
- At ≤ 640 px with a coarse pointer, these targets are at least 44 px: `.pill`, `.nav-tab`, `.chip-btn`, `.send`, `.menu-item`, `.recent-row`.
- `prefers-reduced-motion` is honoured, through the existing global rule plus the design's.

**Icons.** The sprite gains `i-arrow-up`, `i-stop`, `i-file` and `i-sparkle`, using the design's paths.

### 2.8 What must remain unchanged

- Server behaviour. The only `src/` change is the one static whitelist entry in `http.ts`.
- Every API contract.
- Safety:
  - DOM-only rendering (`h()`, `textContent`, the existing renderer);
  - no HTML sinks;
  - no inline scripts, `style` attributes or `on*` attributes;
  - no new dependencies;
  - no network beyond the same origin.
- These keep working as today:
  - the setup wizard;
  - the run drawer (7 tabs) and live log;
  - notes;
  - approvals, including `rev` and `confirmRisks`;
  - toasts;
  - SSE reconnect and resync;
  - the expired-session screen and sign-out.
- `npm test` green and `npm run check` clean after every U-step.

### 2.9 Acceptance criteria

1. **AC1 — Home matches the design.** Hero, composer, pills, repo chip and menu, Handled-by chip and popover, mode cards, Your tools and Recent match the design's layout and states at 1440 and 390 px, light and dark.
   - Screenshots go to `.techteam/runs/evidence/m8u-*`.
   - They are compared **for layout and state, not content**, because the prototype shows canned data (N12).
2. **AC2 — Home works end to end on the demo.** Against `npm run demo` (fake agents), Ask, Research and Build from the composer render the thread turns as in §2.3. Also:
   - "Turn into a task" and "Turn into an engineering plan" create cards;
   - Stop cancels;
   - a forced 429 or 409 shows the server's message verbatim, with no retry;
   - `allowChange` is sent only when ticked, and only for Ask.
3. **AC3 — Board matches the design.** Header, cards, role-based column hints, empty state and history match. Every existing card action still works.
4. **AC4 — Settings regrouped and working.**
   - Row tool changes persist through `PUT /api/roles`, with fallbacks, `autoByComplexity` and unknown fields preserved and followers mirrored (unit tests plus a manual check against the demo).
   - Locked pairings show the server's reason.
   - The acknowledgement flow and notices work.
   - Existing settings save with the same validation messages.
   - The partial-failure message appears when the roles PUT fails.
5. **AC5 — No code for deferred controls (§2.0).** Checked in code review: `ui/app.js` contains no `runMode`, `/api/models`, `/api/accounts`, `/api/briefs`, `roleViews`, or model/effort code.
6. **AC6 — Static safety test, zero exceptions (N1).**
   - `ui/*.js` contains none of: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval(`, `new Function`, `setAttribute('on…`, `setAttribute('style'`, a `style:` key passed to `h()`, `.cssText`, `srcdoc`, `DOMParser`, `createContextualFragment`, `javascript:`.
   - `ui/index.html` has no inline `<script>` body, no `style=` and no `on*=` attributes.
   - `ui/style.css` has no `@import` and no external `url(`.
   - `index.html` loads `/modes.js` and then `/app.js`, both with `defer`.
7. **AC7 — Accessibility.**
   - The console stays clean.
   - Keyboard: a sensible Tab order; Escape closes popovers, menus and dialogs; focus returns to the trigger; radiogroups and menus work with arrow keys.
   - Targets are at least 44 px at 390 px.
   - `prefers-reduced-motion` is respected.
8. **AC8 — Checks and regression.** `npm test` green and `npm run check` clean after each U-step. The §5.4 manual regression checklist is executed and recorded.

## 2b. Security design (sign-off needed before U1, B5)

**Assets**

- The user's config: role chains, which are a global setting.
- The session and CSRF token.
- The integrity of what the user reads: model output must never become markup or a link.

**Threats and controls**

| # | Threat | Control |
| --- | --- | --- |
| T1 | **Model-written text on new surfaces.** Ask answers, research reports, citations, the `change` title, `tierNote`, `error`, `basis`, `provider` and server toast text now render in the Home thread instead of a dialog. | **Rendering:** only `textContent` / `h()` text nodes, or the **existing** DOM-only `renderMarkdown`. No new renderer, no new HTML sink.<br>**Links:** `renderMarkdown`'s links stay behind `safeHttp`: http/https only, with `target=_blank rel="noopener noreferrer"`.<br>**Citations and research source URLs:** rendered as **`<code>` text, never as an `href`**, so no `file:`, `vscode:` or `javascript:` link can appear. The demo fixture's `javascript:` source stays inert text.<br>**Redaction:** unchanged; the asks service redacts answers and reports on the server. |
| T2 | **The user's own text** (bubble, task title and description). | Rendered with `textContent`. Sent only to the same endpoints as today (`/api/ask`, `/api/tasks`). The Build card is created by the user actor, exactly as the New task dialog does: no model text, so no new trust level. |
| T3 | **Provider assignment** (Handled-by popover, Settings rows): a one-click global config change, unverified providers, egress. | **Visibility:** the popover says the change is **global and persisted**. Notices (where the text goes) are always shown via `textContent`.<br>**Locked providers:** pills for `ok:false` choices are `aria-disabled` and never sent; the server would refuse them anyway.<br>**Unverified providers:** `409 needs_acknowledgement` opens a **modal confirm** that shows the server's message verbatim. The request is resent with `acknowledge: [id]` only on an explicit click, only for the one provider the user picked, and the choice is never automatic or remembered.<br>**No data loss:** `roleEdit` echoes the role's other fields, so a UI edit never strips fallbacks, `autoByComplexity` or future M8-2 fields.<br>**Transport:** every write goes through the existing `api()` (CSRF header, same origin); server validation is unchanged and authoritative. |
| T4 | **New static route `/modes.js`.** | **Whitelist:** one exact entry with `public: false` (needs a session, like `/app.js`); same security headers and CSP; no directory serving.<br>**Server test:** signed in → 200 with the JS type and CSP/nosniff headers; signed out → redirect to `/login`; the traversal list stays not-found.<br>**Content:** `modes.js` is pure: no DOM or network, no `import`/`export`, one frozen namespace. |
| T5 | **DOM sinks and CSP.** | The AC6 static test (zero exceptions). CSP unchanged (`script-src 'self'`, `style-src 'self'`). Dynamic sizes use only `style.setProperty('--x', …)` (composer height, meter `--pct`). |
| T6 | **Client storage.** | `sessionStorage` holds only `home:lastRepo` (a registered repo name, validated against `state.repos` when read) and the existing banner dismissals. **Composer text and the thread are never stored**; the thread lives in memory only. |
| T7 | **Fast path (`allowChange`).** | Opt-in per ask, default off, reset after each send, Ask only, with today's wording and hint. Server rules are unchanged: `fastPathPerHour`, actor `user-ask`, approval. |
| T8 | **Automatic repo matching.** | Purely local: it only chooses which registered repo name is sent. The chip shows the resolved repo before Send, so the user sees where the question goes. |

**Out of scope:** server endpoints, auth, redaction and isolation, all unchanged.

**Security checkpoint after implementation:** Security reviews the diff of `ui/*`, the `http.ts` entry and the AC6 test.

## 2c. Conditions from the gates (rev 2.1). These override earlier sections where they differ

**Security U1 (replaces the single-id acknowledgement in §2.4.3 step 4 and §2b T3)**

The server's 409 names only the first unverified provider and has no machine-readable id, so the acknowledgement set is computed **before** the PUT:

- **`acksNeeded(roles, choices, patch)`** (pure, in `modes.js`)
  - Input: the **fresh** `GET /api/roles`.
  - Output: for every provider that the patch **newly adds** to a role's chain (not in that role's current chain) and whose `choices[role][id].needsAck` is true, return `{ provider, roles:[…], rows:[row labels] }`, one entry per provider. Follower roles are included.
- **One modal confirm per provider**
  - The first line is UI-authored: "Use PROVIDER for: ROW, ROW (also ROLE, ROLE)? Its isolation has not been verified on this machine."
  - It then explains that this is a global setting.
  - Cancel on **any** confirm ⇒ no roles are sent at all.
- **`withAck(patch, ids)`** (pure) returns a new body `{ roles, acknowledge: ids }`.
  - `ids` is **exactly** the confirmed set.
  - It never mutates the patch, never adds an id, and is never remembered.
- **If a 409 still comes back** (a race), its message is shown and the flow **stops**.
  - No automatic resend.
  - Ids are never parsed from the message.
- **Unit tests**: two rows moving to two unverified providers; a follower bringing in the provider; a provider already in the chain (no ack needed); `ok:false` choices; no mutation; `withAck` adds no extra id.
- This also covers Reviewer **C2** (the pure part of the acknowledgement decision is unit-tested). The live 409 path is recorded as "not reached on the demo" in `m8u-regression.md`.

**Security U2 (replaces "picking a tool sends PUT at once" in §2.2 and §2.4.3)**

In the Handled-by popover a pill choice is **only a draft**:

- **Applying**:
  - An explicit button, "Use PROVIDER for every ROW job", runs the U1 flow and then the PUT.
  - Escape or an outside click **discards** the draft.
  - The button is disabled while the draft equals the current lead.
- **Notices** appear inline (`role="status"`) **and** as a toast.
- **Freshness**: the popover does a fresh `GET /api/roles` before computing the patch (U9).

**Security U3: closing the attribute-sink gap**

- **(a) Harden `h()`.** It calls a pure `safeAttr(name, value)` in `modes.js`, which:
  - drops `on*` keys whose value is not a function;
  - drops `style`, `srcdoc`, `formaction`, `innerHTML` and `outerHTML`;
  - for `href`, `src`, `action`, `srcset`, `xlink:href` and `poster`, keeps only these values:
    - `#/…`;
    - a same-origin path `/x` (not `//`);
    - a value that passes `safeHttp`, which moves into `modes.js`; the test sandbox provides `URL`.

  `icon()`'s `<use href="#i-NAME">` uses constant names only and is allow-listed.
- **(b) Static URL-attribute check.** `test/ui-safety.test.ts` finds every `href`/`src`/`action`/`formaction`/`srcset`/`xlink:href` occurrence in `ui/*.js` and checks each one against an explicit allow-list of source snippets. Any new occurrence fails until it is reviewed.
- **(c) Run links.** Every `#/run/` link is built with `enc()`.
- **Unit tests for `safeAttr`**:
  - `javascript:`, `vbscript:` and `data:` hrefs are dropped;
  - a string `onclick` is dropped;
  - `style` and `srcdoc` are dropped;
  - `#/board`, `/x`, `https://…` and `http://…` are kept;
  - `//evil` is dropped.

**Security checks during implementation**

- **U4. Send names its action and target.** The Send button's accessible name and tooltip say both:
  - "Ask about demo-app";
  - "Ask (no repository)";
  - "Research on the web";
  - "Send to the board (demo-app)".

  The `allowChange` label names the repo: "Let Conductor make the change in demo-app if it is small". `allowChange` is never sent outside Ask.
- **U5. Clearing on sign-out.** `showExpired()` (every 401) and sign-out clear `S.home.turns`, cancel all poll timers and empty `#view`. Thread text never goes into the title, the URL, history or storage.
- **U6. More negative route tests in `test/ui-static.test.ts`**:
  - `/MODES.JS`, `/modes.js/`, `/./modes.js`, `/modes.js%00`, `/%2fmodes.js` are not served;
  - `/modes.js?x=../app.js` serves `modes.js`, not another file;
  - a test asserts `modes.js` is **deeply** frozen and contains no `import`/`export`, DOM access, `fetch`, `eval` or `Function`.
- **U7. Repo-name handling.**
  - Every regex metacharacter in a repo name is escaped.
  - A performance test checks that 4,000 characters × 50 repos takes < 50 ms.
  - `lastRepo` must match a registered name exactly (case-sensitive).
- **U8. String placement.** Every server- or model-originated string goes only into `textContent`, `title` or `aria-label`, never into a URL or an attribute that is interpreted.
- **U9. Fresh copies.** `roleEdit` deep-copies the fresh GET entry via a JSON round trip. The popover and Settings both GET first.
  - M8-2 note for the Lead: GET `roles[r]` must stay PUT-round-trippable. View-only data belongs in `roleViews`; M8-2 must strip any read-only fields it adds to `roles[r]` before a PUT accepts them. This is also Reviewer R2-N4.
- **U10 (optional, existing behaviour).** Not done in this slice; noted.

**Reviewer conditions**

- **C1.** Security has signed off (`reviews/workspace-v2-m8-u-security-design.md`) **before U0**. Security also reviews the final diff.
- **C2.** Covered by U1 above.
- **C3.** D-U1 goes to the user in the slice report, with a recommendation; it is not settled here.

**Reviewer non-blocking notes, taken**

- **R2-N1.** The Deep Research row hint says "Runs on Claude's web-only profile today (other tools cannot research yet)."
- **R2-N2.** If a Save sets `onClaudeLimit='cursor'` and also moves a read-only row's lead to Cursor, an inline note under the select reads: "Planning now starts on Cursor, so it has no Claude limit to wait for."
- **R2-N3.** Rows whose role has `autoByComplexity` picks show "Some plan sizes use a different tool first (set in the config file)."
- **R2-N5.** `test/ui-safety.test.ts` greps `ui/app.js` for the deferred identifiers: `runMode`, `/api/models`, `/api/accounts`, `/api/briefs`, `roleViews`, `/api/run-mode`. A slice that adds one of them removes it from this list in the same commit.
- **R2-N6.** `S.home.turns` is capped at 20: the oldest **finished** turn is dropped first; running turns are never dropped.

## 3. Files to Be Changed

| File path | Action | Purpose | Required changes | Reason |
| --- | --- | --- | --- | --- |
| `ui/modes.js` | Create | pure helpers, no DOM | **Exports:** `detectMode` (verbatim from the design), `matchRepo`, `resolveRepo`, `taskFromText`, `setLead`, `roleEdit`, `rolesPatch`, `ROLE_ROWS` (with followers), `MODE_META`, `leadOf`, `toolJobs`, `colHints`, `flowText`.<br>**Form:** a single frozen `globalThis.ConductorModes`; no `import`/`export`; loading it only defines that object. | B1, B2, N2, N3 |
| `ui/index.html` | Modify | shell | `<script src="/modes.js" defer>` **before** `/app.js`; 4 sprite symbols | B2, §2.7 |
| `ui/style.css` | Modify | design system | • the design's 136 rules, rescoped and renamed per §2.7<br>• the 44 px rules<br>• `.dlg-wide` at 780 px<br>• remove the M5 `.modes` / `.mode-*` rules<br>• drop the prototype-only rules | §2.7, N7, N8 |
| `ui/app.js` | Modify | views | • header, nav and routing<br>• Home: composer, menus, popover, thread, cards, tools, recent<br>• board restyle and role-based hints<br>• Settings regroup and save flow<br>• remove `openAsk` (its behaviours move per §2.6)<br>• boot check for `ConductorModes` | §2.1–2.6, B6 |
| `src/server/http.ts` | **Modify** | static whitelist | one entry: `'/modes.js': { file: 'modes.js', type: 'text/javascript; charset=utf-8', public: false }` | B2 |
| `test/ui-modes.test.ts` | Create | unit | • loads `ui/modes.js` with `vm.runInNewContext(src, sandbox)`, sandbox `{}`<br>• reads `sandbox.ConductorModes` through a small typed interface<br>• compares results after a JSON round trip, because the objects come from another realm | B1, B2, N2 |
| `test/ui-safety.test.ts` | Create | static | the AC6 checks | N1 |
| `test/ui-static.test.ts` | Create | server | `/modes.js` signed in (200, JS type, CSP, nosniff), signed-out redirect, traversal variants refused; uses `startDemo` like `server.test.ts` | B2 |
| `docs/API.md` | Modify | contract | • line 10: add `/modes.js` to the static list<br>• "UI behaviour requirements" (lines 84–90): Home is the default (`#/`), Board at `#/board`, the composer, roles edited through `PUT /api/roles` | B2, N9 |
| `docs/ARCHITECTURE.md` | Modify | new "Dashboard UI" section | files, routing and base view, Home thread lifecycle, `modes.js`, role-edit rules, deferred controls | N9 |
| `.techteam/runs/evidence/m8u-*` | Create | evidence | screenshots and `m8u-regression.md` (the executed checklist) | AC1, AC8, B6 |

Outside this slice's file set, **the Lead updates** (N9):

- the master plan's slice table: M8-5 and M8-6 lose the parts pulled forward here, and M8-2 owns the model/effort UI step rather than "the row control";
- `active-run.md`.

## 4. Implementation TODO

One commit per U-step, with `npm run check` and `npm test` green on each. The Lead commits.

- [ ] **U0 — foundations**:
  - `ui/modes.js` + `test/ui-modes.test.ts`;
  - the `http.ts` entry + `test/ui-static.test.ts`;
  - the `index.html` script tag;
  - `test/ui-safety.test.ts`;
  - the boot check in `app.js`.
- [ ] **U1 — shell**: CSS port, sprite, header/nav, routing (base view, `closeRoute`, links), an empty Home shell.
- [ ] **U2 — Home idle**:
  - composer, pills;
  - repo chip and menu;
  - Handled-by chip and popover (tool choice, acknowledgement, notices);
  - mode cards, Your tools, Recent;
  - disclosures, `allowChange`.
- [ ] **U3 — Home thread**: Ask, Research and Build turns; polling lifecycle; Stop and Clear; convert; errors.
- [ ] **U4 — Board**: header, role-based hints, empty-state flow, card fade-up; the M5 block leaves the board.
- [ ] **U5 — Settings**: regroup; Who-does-what rows; save order; acknowledgement; notices; partial-failure message.
- [ ] **U6 — finish**:
  - accessibility, phone and dark-mode pass;
  - evidence screenshots and the regression checklist;
  - docs (`API.md`, `ARCHITECTURE.md`).

**Sequencing (N10)**

- M8-2 will later edit `ui/app.js` for its model/effort UI step, and M8-6 for its brief UI step. Both start after M8-U lands; the Lead serialises them.
- M8-1's files (`src/models/`, `src/runtime.ts`, `src/server/api.ts`, `src/agents/spawn.ts`, `src/cli.ts`) do not overlap this slice. A test failure in those files goes to the M8-1 agent; this slice does not fix it.

## 5. Testing Strategy

### 5.1 Unit tests (`test/ui-modes.test.ts`)

**`detectMode`**, using the design's rule table:

- empty text → `work`;
- "find …" → ask;
- "Compare X vs Y" → research;
- "safest way to …" → research;
- a trailing "?" → ask;
- "Add a toggle" → work;
- an ambiguous line, "How do I compare options?" → research (the research rule wins);
- case and surrounding whitespace do not matter.

**`matchRepo` / `resolveRepo`**:

- word boundaries, case-insensitive;
- a short repo name that is also a common word: "api" in "rapid" → no match; "app" in "apply" → no match; "app" in "fix the app" → match;
- two matching repos → none;
- regex metacharacters in a name;
- precedence: chosen, then matched, then last-used, then only-repo;
- a stale last-used name (no longer registered) is ignored.

**`taskFromText`**:

- a single short line;
- multi-line text;
- 250 characters with spaces: cut at a word boundary at or after 120 and within 200, plus "…";
- 250 characters with no spaces: hard cut;
- leading blank lines.

**`setLead` / `roleEdit` / `rolesPatch`**:

- chains `[claude,cursor]`, `[cursor]`, `[claude]`, `[claude,codex]`, `[codex,claude,cursor]`;
- `autoByComplexity` is echoed;
- **unknown fields** (`model`, `effort`, `foo`) are echoed;
- an unchanged lead → the role is not in the patch;
- followers are mirrored on their own chains; a follower already led by the target is not sent;
- the input is never mutated.

**`toolJobs` / `colHints` / `flowText`**: default roles produce today's exact hint strings ("Claude writes the plan", "Cursor writes the code", "Gates, then Claude checks").

### 5.2 Server test (`test/ui-static.test.ts`)

- Signed in: `/modes.js` → 200 with `text/javascript; charset=utf-8`, CSP and `X-Content-Type-Options: nosniff`; the body contains `ConductorModes`.
- Signed out: 302 to `/login`.
- `/ui/modes.js`, `/modes.js/../package.json` and `/%2e%2e/modes.js` → not 200.

### 5.3 Static test (`test/ui-safety.test.ts`)

The AC6 checks, as listed in §2.9.

### 5.4 Manual regression checklist (B6)

This is **manual evidence, not `npm test`**.

**Setup**

- Target: `npm run demo`. The demo creates its own throw-away `CONDUCTOR_HOME` under the OS temp folder and uses fake agents; no real CLI is called.
- Interaction, console and keyboard checks: the agent's built-in **Browser pane** tools.
- Saved screenshots:
  - a scratchpad Node script (not in the repo, no dependency) drives the installed **Brave** headless over the Chrome DevTools Protocol, using Node 22's global `WebSocket`;
  - sizes 1440×900 and 390×844;
  - `prefers-color-scheme` light and dark, emulated.
- Results go to `.techteam/runs/evidence/m8u-regression.md`, one line per item, with pass/fail and notes.

**Checklist**

1. **Setup wizard**:
   - probe with "Test both";
   - add a repo, remove a repo;
   - "Back to board" and "Go to the board" both lead to `#/board`;
   - the tools panel shows role-derived jobs.
2. **Header**:
   - Home/Board tabs and the badge;
   - engine pause/resume;
   - quota meter: 5h/7d, rejected, resets (on the demo's data);
   - the Ask button goes to Home in Ask mode;
   - New task on the Board view;
   - Settings.
3. **Banners**: limit, offline, storage, health, warnings with dismiss; the SSE-down banner and reconnect.
4. **Expired session**: copy, check again, sign out.
5. **Board**:
   - idle cards: Start, Run it, Park, Cancel;
   - run cards: Approve plan (with risk confirm), Retry, Resume now;
   - summary jump-to-column;
   - mobile column order;
   - History opens the drawer;
   - empty state;
   - role-based hints.
6. **Drawer**:
   - all 7 tabs;
   - posting a note;
   - live log: pin, jump, agent filter, tool and thinking toggles, backlog;
   - sessions: copy and open targets;
   - abort, cleanup, park, finish;
   - approve with `rev`;
   - Escape closes.
7. **Routing**:
   - a direct `#/run/KEY` load shows Board underneath; closing goes to `#/board`;
   - Home → Recent → drawer → close returns to Home (`history.back`);
   - Board card → drawer → close returns to Board;
   - the brand goes to Home; the wizard links work;
   - browser back and forward across Home, Board and the drawer.
8. **Home**:
   - Ask with the repo set to Auto, chosen and none: markdown, citations, basis and tierNote render;
   - `allowChange` shows only in Ask mode with a repo, and resets after send;
   - Research with no repo (convert hidden) and with a repo (convert shown);
   - Build: the title rule, and the no-repo error when two repos are registered;
   - Stop; Clear is disabled while a turn runs;
   - the thread survives Home ↔ Board;
   - forced errors: three quick asks while two are running gives the "Two questions…" 429, shown verbatim.
9. **Handled-by popover**:
   - shows the global-setting text;
   - picking a tool persists (confirmed with `GET /api/roles`);
   - a locked tool shows its reason;
   - Escape returns focus to the chip.
10. **Settings**:
    - saving shows the same validation messages (fix loops 1–10, parallel runs 1–8);
    - a row change persists, followers included;
    - `onClaudeLimit` and a row change saved together in one Save;
    - the partial-failure message, forced with a pairing that returns 400;
    - Cancel discards the draft.
11. **Everywhere**:
    - toasts;
    - console clean throughout;
    - keyboard-only pass of Home and Settings;
    - 390 px with no horizontal scroll;
    - dark and light.

**Not reachable on the demo.** These are recorded as not reached, never as passed:

- The `needs_acknowledgement` 409 needs an `unverified` provider, and the demo's Codex is not unverified.
- The acknowledgement path is covered by code review instead, plus a scripted check of the same handler against a stubbed `api()` in the Browser pane, if that turns out to be feasible.

### 5.5 Build checks

- `npm run check` clean and `npm test` green after each U-step.
- The existing server tests for `/api/state`, roles, settings and asks stay unchanged.

## 6. Risks and Dependencies

- **`app.js` size.** It stays one file plus `modes.js`. Splitting it into modules is out of scope (an M8-5 decision).
- **A large rewrite with no automated DOM tests.** Mitigated by:
  - one bisectable commit per U-step;
  - the §5.4 checklist;
  - leaving the drawer, log and wizard code untouched.
- **A one-click popover changes global config.** Mitigated by the explicit "global setting" text, the acknowledgement modal and the notices (§2b, T3).
- **Chain semantics drop a replaced lead.**
  - `[claude,cursor]` → Cursor gives `[cursor]`; switching back gives `[claude]`, without the Cursor fallback.
  - Today's `stages` control produces the same result.
  - The "When Claude hits its usage limit" select in Settings restores the fallback.
- **Contract drift with M8-2, M8-4 and M8-6.** No code for them is written here (§2.0). `roleEdit` echoes unknown fields, so M8-2's per-role fields survive a tool change made in this UI.
- **Desktop app.** Rebuilding the payload ships `modes.js` (`build-app.mjs:14` copies `ui/` recursively). No Electron change.
- **Demo limits.** The fake agents return canned answers, and some states (the acknowledgement 409, real usage limits) cannot be produced. These are recorded as not reachable, not as passed.

## 7. Requirement Coverage Matrix

| Requirement | Planned change | Verification | Status |
| --- | --- | --- | --- |
| Same UI as the design (user, 2026-10-21) | U1–U6, §2.7 | AC1, AC3, AC4: screenshots against the prototype (layout and states) | Covered |
| F1 Home composer (the parts with a backend) | U2–U3 | AC1, AC2, §5.4 #8 | Covered. Gap: F3 parts preview → M8-6 |
| F2 Ask inline | U3 | AC2 | Covered |
| F4 Research intake | U3 (existing research, full report) | AC2 | Covered. Gap: research brief and depth → M8-6 |
| F5 Board wording from roles | U4 | AC3, `colHints` unit tests | Covered. Gaps: account and moved chips → M8-3; research and part chips → M8-6 |
| F6 Run mode | — | — | Gap → M8-4 (no code in this slice) |
| F7 rows: tool choice | U5, U2 popover | AC4, `roleEdit` / `rolesPatch` unit tests | Covered. Gap: model, effort, flags → M8-2 |
| F9 Accounts UI | — | — | Gap → M8-3 |
| F10 Settings structure | U5 | AC4 | Covered for today's groups. Run mode → M8-4; Accounts → M8-3 |
| M5 behaviours kept | §2.6 table | §5.4 #8, AC2 | Covered |
| Safety (DOM sinks, static route) | §2b, U0 | AC6, `ui-static` test, Security checkpoint | Covered |
| Routing ripples | §2.1 | §5.4 #7 | Covered |

## Implementation notes (2026-10-21, Frontend)

**Deviations from the plan text**

- **§5.4 acknowledgement path.** It turned out to be **reachable** on the demo, where Codex is `unverified`. It was exercised live: Cancel sends nothing; Confirm sends exactly `acknowledge:["codex"]`; the notice appears inline and as a toast.
- **R2-N1 wording.** The text now reads: "Deep Research always runs on Claude's web-only research profile today, so this job cannot be moved to another tool yet." The server reports every research pairing as locked, Claude's included.
- **Home tool hints.** A tool's hint is visible text on Home only for tools assigned to a job; otherwise it stays in the tooltip. The wizard still shows it for every tool.
- **U2 and U3 were built as one step.** The thread and the composer share state.
- **Fixes found in the regression pass** are listed in `runs/evidence/m8u-regression.md`. Among them: `confirmDialog` now also settles from the form submit.

- **D-U1 decided by the user (2026-10-21): the header Ask button is removed** to match the design. Removed with it: `HDR.askBtn`, `askFromHeader`, and its visibility toggle. The `i-help` sprite symbol stays, because the Ask pill and the Quick Ask card still use it. There was no button-specific CSS.

- **Security code checkpoint: Approved.** Its low findings L1–L3 were fixed:
  - L1: the sink scan runs on the raw source;
  - L2: the wider URL-attribute set in `safeAttr`;
  - L3: the plain-language 409 line.

## Change log

**rev 2.1 (2026-10-21, Frontend)**: added §2c, which folds in Security U1–U10 and Reviewer C1–C3 and R2-N1…N6.

**rev 2 (2026-10-21, Frontend)**

- **B1**:
  - `roleEdit`, `setLead` and `rolesPatch`, with tests;
  - the acknowledgement and notices flow;
  - Save order and the partial-failure UX;
  - the popover is labelled as a global setting;
  - follower roles are mirrored.
- **B2**:
  - `http.ts` changed to Modify, with a server test;
  - `API.md`;
  - script load order;
  - the `vm` test loader;
  - the fail-visible boot check;
  - the desktop note.
- **B3**: option (a), with the deferred table and owners, including the Lead's contract notes for M8-2, M8-4 and M8-6.
- **B4**: disposition table §2.6, with D-U1 in the needs-user-decision list.
- **B5**: §2b Security design; status set to `pending_security_design`.
- **B6**:
  - the §5.4 checklist, with the tools named;
  - the routing fixes;
  - one commit per U-step.
- **N1–N12** folded in:

| Item | Where |
| --- | --- |
| N1 | AC6 |
| N2 | `detectMode` verbatim and the repo tests |
| N3 | §2.2 |
| N4 | §2.3 |
| N5 | §2.4.2, §2.5 |
| N6 | §2.5 |
| N7, N8 | §2.7 |
| N9 | §3 |
| N10 | §4 |
| N11 | §2.2 |
| N12 | AC1 |
