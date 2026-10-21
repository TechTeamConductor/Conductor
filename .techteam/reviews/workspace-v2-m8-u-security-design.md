# Security design sign-off: M8-U (port the approved V16 design into `ui/*`), plan rev 2

- Reviewer: TechTeam Security Engineer (independent of the plan authors)
- Date: 2026-10-21
- Inputs:
  - `.techteam/plans/workspace-v2-m8-u.md` rev 2: §2b T1–T8, plus §2.0, §2.2, §2.3, §2.4.3, §2.6, AC6 and §5.
  - Code at 8eaab46:
    - `ui/app.js`: `h()`, `safeHttp`, `mdInline` / `renderMarkdown`, `toast`, `api()`, `confirmDialog`, `storeGet` / `storeSet`, `showExpired`;
    - `src/server/http.ts`: `SECURITY_HEADERS` (CSP), `STATIC`, the auth gate;
    - `src/server/api.ts`: `putRoles`, `needs_acknowledgement`, `EGRESS` notices.
- Method: I read the plan as a design and checked every claim it makes about today's behaviour against the code. I edited no plan or source text.
- Severity:
  - **High**: model or repo text could become markup, script or an active link, or a user setting could change without a deliberate act.
  - **Medium**: a defect that is likely if the plan text stays as is: a wrong acknowledgement, an accidental egress change, or a sink the static test misses.
  - **Low**: hygiene or defence in depth.
- Tags:
  - **[BEFORE-EDIT]**: add the condition to the plan text before U1.
  - **[DURING]**: a constraint on implementation or tests, checked at the Security checkpoint after implementation.

## Decision

**Approved with conditions.** There is no Critical or High finding.

The design keeps the existing safety properties:
- one DOM-only renderer, links behind `safeHttp`, citations and source URLs as text;
- CSP `script-src 'self'; style-src 'self'` unchanged; inline handlers are therefore blocked at the browser too;
- an exact-whitelist static route with `public:false`;
- every write goes through `api()` with the CSRF header;
- the server stays authoritative for role pairing, tier and acknowledgement.

Three Medium items (U1–U3) must go into the plan text before U1.

## Threat review (T1–T8)

| # | Verdict | Notes |
| --- | --- | --- |
| T1 model text | Holds | The same `renderMarkdown` / `mdInline` is reused, with no new sink. Code check: `mdInline` turns a non-http(s) link into plain text "label (url)" and never into an anchor. The Home thread is only a new place for the same renderer. One existing residual, not new: model-written http(s) links (an answer, or a prompt-injected repo) open in a new tab with `noopener noreferrer`. U10 is an optional mitigation. |
| T2 user text | Holds | `textContent` only, same endpoints. Auto-detected Build creates a board task from a casual line; U4 makes the destination explicit. |
| T3 provider assignment | **Gaps**: U1, U2, U9 | (a) The server answers `needs_acknowledgement` for the **first** unverified provider only, and the 409 carries no provider field. A Settings save that moves two rows to two different unverified providers, or a row whose followers also need the same acknowledgement, does not fit "resend with [that one id]". (b) A one-click pick in the Home popover is a persisted, global change of **where repository content is sent** (egress), made from a chip on the request composer. |
| T4 `/modes.js` | Holds | Code check: `STATIC` is an exact map, served by `readFileSync(join(uiDir, file))` with a constant `file`. A non-public entry redirects to `/login` when signed out. U6 extends the negative tests. |
| T5 sinks / CSP | **Gap**: U3 | `h()` passes every unknown attribute key to `setAttribute`. So `href`/`src`/`action`/`formaction` taken from data are sinks that the AC6 word list does not catch. `h()` also sets `on*` keys whose value is not a function as **string attributes**; CSP blocks them, but the static test does not check for them. |
| T6 storage | Holds | Only a registered repo name is stored, validated on read. U5 adds clearing the thread when the session ends. |
| T7 fast path | Holds | Opt-in, reset after every send, server rules unchanged. U4 makes the target repo visible on the option. |
| T8 repo auto-match | Holds | Local only; the chip shows the result. U7 covers regex escaping and its cost. |

## Binding conditions

**U1 [BEFORE-EDIT] (Medium): The acknowledgement covers exactly what the user confirmed, one provider at a time, and never loops.**
- Before `PUT /api/roles`, compute the set of **newly added** providers in the patch whose `choices[role][id].needsAck` is true. Take it from the fresh `GET /api/roles` of step 3, including followers' roles.
- For each such provider, show one modal confirm, before the PUT. It contains:
  - a UI-authored first line: "<Provider> has not passed Conductor's isolation check on this Mac. Use it for <row names, including followers> anyway?";
  - the "Use it anyway" (danger) and Cancel buttons.
- Send `acknowledge` = exactly the set of providers the user confirmed in this save. Cancelling any one of them sends nothing for the roles.
- If the server still answers `409 needs_acknowledgement` (its state changed between the GET and the PUT), show the server message verbatim through `textContent` and stop. **Never resend automatically**, never add a provider id parsed from the message, and never acknowledge a provider that was already in the role's chain.
- An acknowledgement is never remembered across saves or popover picks.
- Unit tests (pure, in `modes.js`):
  - `acksNeeded(rolesGet, patch)` returns exactly the newly added `needsAck` providers;
  - two unverified providers in one patch ⇒ two confirms;
  - one provider across a row and its followers ⇒ one confirm naming all three rows;
  - an already-assigned unverified provider ⇒ no confirm.
- Manual check against the demo: a forced 409 after the confirm stops with the message and does not resend.

**U2 [BEFORE-EDIT] (Medium): The Handled-by popover is a draft plus an explicit Apply, not a one-click global change.**
- Picking a pill only selects it. A separate button, "Use <Provider> for every <job>", sends the PUT, after U1 if an acknowledgement is needed.
- Escape, an outside click, or closing the popover discards the draft.
- After success, the reply's `notices` (where the text now goes) are shown inline in the popover's `role="status"` line **and** as a toast, so the egress disclosure is not missed when the popover closes.
- The popover's job role never has followers today (`context`, `research`, `planning`). If a mode is later mapped to a role with followers, the Apply label must name them.
- Reason: Settings rows are already a draft until Save. The popover sits on the request composer, where a stray click must not silently move repository content to another vendor for every future request.

**U3 [BEFORE-EDIT] (Medium): Close the attribute-sink gap in `h()` and in the AC6 test.**
- (a) Harden `h()`. The behaviour change is additive and every current call site is unaffected:
  - a key starting with `on` whose value is not a function is dropped, never passed to `setAttribute`;
  - the keys `style`, `srcdoc`, `formaction` and `innerHTML` are dropped;
  - `href`, `src` and `action` are kept only when the value is a string starting with `#/` or `/` (same origin), or when it already passed `safeHttp`. Enforce this in `h()` itself by re-running `safeHttp` for absolute URLs.
- (b) Add to AC6 a scan of `ui/*.js` for every `href`, `src`, `action`, `formaction`, `srcset` and `xlink:href` occurrence, in `h()` attribute objects and in `setAttribute` calls. Each occurrence is checked against an explicit allow-list in the test: a file:line pattern plus one of these value kinds:
  - a literal `#/…`;
  - `'#/run/' + enc(…)`;
  - a `safeHttp(…)` result;
  - the sprite's `'#i-' + name`.
  A new occurrence fails the test until a reviewer adds it.
- (c) Every `#/run/` link built from a server key (for example "Started as task KEY", "View on board", Recent rows) uses `enc()` (`encodeURIComponent`), as `app.js:297` does today.
- Add a unit test for `h()`: `{onclick:'x'}`, `{href:'javascript:x'}`, `{href:'vbscript:x'}`, `{style:'x'}` and `{srcdoc:'x'}` each produce no such attribute.

**U4 [DURING] (Low): Make the destination explicit before Send.**
- The Send button's accessible name and visible tooltip name the effective action and target, for example "Ask about demo-app", "Send to the board (demo-app)" or "Start web research". This also applies when the mode came from Auto detection.
- The `allowChange` label names the resolved repo ("…if it is small, in demo-app").
- Auto never turns `allowChange` on, and Build or Research never sends it. Unit test: the request builder never puts `allowChange` in a non-Ask body.

**U5 [DURING] (Low): Clear the thread when the session ends.**
- `showExpired()`, sign-out and any 401 clear `S.home.turns`, cancel every poll timer, and empty `#view`, so answers and reports do not stay in the DOM behind the expired screen.
- Thread text never goes into `document.title`, the URL or hash, `history.state`, or storage.

**U6 [DURING] (Low): Static route tests.**
- Extend §5.2 so these are not served with 200: `/MODES.JS`, `/modes.js/`, `/./modes.js`, `/modes.js%00`, `/modes.js?x=../app.js` (the query must not change the file), and `/%2fmodes.js`.
- `modes.js` itself:
  - assigns one `Object.freeze`d namespace, with its tables (`ROLE_ROWS` and others) frozen too;
  - contains no `import`/`export`, DOM, `fetch`, `eval` or `Function`;
  - is covered by the AC6 scan.
- The desktop build copies it; B2's fail-visibly check covers the case where it is missing.

**U7 [DURING] (Low): The repo-match regex is safe.**
- Escape every regex metacharacter (`[.*+?^${}()|[\]\\]`) before building the word-boundary regex. Build it once per repo list.
- Tests (§5.1 already lists metacharacters): names like `a.b`, `c++` and `x(y)`, and a 4,000-character input with 50 repos completing well under 50 ms.
- `home:lastRepo` is accepted only if it exactly equals a registered name.

**U8 [DURING] (Low): Server and model strings stay text.**
- Everything in T1 and T3 (server messages, `reason`, `notices`, `tierNote`, `basis`, `error`, `change.title`, citations, source URLs, provider labels, repo names, run titles) is set with `textContent` or `h()` text children. None of it goes into an attribute other than `title` / `aria-label`, and never into a URL.
- The 409 / 429 callouts never parse server text for actions; the U1 rule applies.

**U9 [DURING] (Low): `roleEdit` copies safely and works from fresh data.**
- `roleEdit` builds on a deep copy of the **fresh** GET entry (`structuredClone` or a JSON round trip), and never mutates its input. A unit test already exists for this.
- The popover performs the same fresh `GET /api/roles` as Settings step 3 before computing the patch.
- Echoing unknown fields is acceptable because the server ignores them today and M8-2 makes them strict. If M8-2's GET adds read-only fields, M8-2 must strip them in `roleEdit`; note this in the M8-2 hand-off.

**U10 [optional, Low]: Show where model-written links go.** In the Home thread, `mdInline` anchors could show the link's host after the link text, as text, for example "docs (example.com)". This makes a prompt-injected look-alike link visible. The behaviour exists today, so this is not required for M8-U.

## Unblock condition

U1 may start once the Reviewer has approved and U1–U3 are in the plan text (§2.2, §2.4.3, §2b, AC6 and §5). The Security checkpoint after implementation checks U1–U9 against the `ui/*` diff, the `http.ts` entry and the AC6 test.

Verdict: Approved with conditions

---

## M8-U code checkpoint (2026-10-21)

**Scope.** I reviewed the uncommitted diff of:

- `ui/modes.js` (new)
- `ui/app.js`
- `ui/index.html`
- `ui/style.css`
- the `/modes.js` entry in `src/server/http.ts` (a single line)
- `test/ui-{modes,static,safety}.test.ts`

**Method.** I read the code and ran the three UI test files: 23/23 pass. `tsc --noEmit` is clean. I did not run the full `npm test`; that is the Lead's gate.

### U1–U9 verified in code

| # | Evidence | Status |
| --- | --- | --- |
| U1 ack flow | `applyRoleChanges` (app.js ~763) first does a **fresh** `GET /api/roles`, then `rolesPatch`, then `acksNeeded(fresh.roles, fresh.choices, patch)`. It shows one modal `confirmDialog` per provider. The confirm is UI-authored text that names the rows and the extra follower roles. Cancelling any confirm returns `canceled` before any PUT. The body is `withAck(patch, confirmed)`, carrying exactly the confirmed ids. A 409 (or any other error) that still comes back is returned as `error` and shown, with no resend; there is no id parsing and no memory between saves. The unit tests cover two providers in one patch, followers, already-assigned providers, `ok:false`, no-mutation, and no-duplicate cases. | Met |
| U2 popover | `fillWhoMenu`: a pill only sets `draft`. The PUT runs only from the explicit "Use X for every <job> job" button, which is disabled when there is no change. Escape, a scrim click or close discards the menu and its draft. Notices are shown inline (`.warn-note`, `role=status`) and as `warn` toasts. | Met |
| U3 sinks | `h()` sends every non-special key through `M.safeAttr`. That function:<br>• drops every `on*` key that is not a function;<br>• drops `style`, `srcdoc`, `formaction`, `innerHTML` and `outerHTML`;<br>• for `href`/`src`/`action`/`srcset`/`xlink:href`/`poster`, keeps only `#/…`, a same-origin `/path`, or a `safeHttp` value.<br>Unit tests cover `javascript:` (including mixed case and a leading space), `vbscript:`, `data:`, `//host`, `file:` and handler strings. The AC6 URL-attribute scan uses a reviewed allow-list, and every `h('a', {href})` in app.js is a constant `#/…` route or a `safeHttp` result. A raw grep finds no `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`/`eval`/`new Function`/`cssText`/`window.open`/`location=` (the only hit is a comment, see L1). Dynamic style uses only `style.setProperty('--…')`, three places. | Met |
| U4 destination | The Send button's `aria-label` and title are "Send to the board (<repo>)" (or the equivalent ask/research names). They are recomputed on every update, including when the mode comes from Auto. The `allowChange` label reads "…make the change in <repo> if it is small". The option shows only when the mode is Ask and a repo resolves. The turn takes `allowChange` only when `mode === 'ask' && repo`, the body includes it only then, and it resets after every send. | Met |
| U5 expiry | `api()` on 401 calls `showExpired()` → `dropHome()`, which clears every turn timer and resets `S.home`. `#view` is emptied and open dialogs are closed. Sign-out takes the same path. `pollTurn` stops on `S.expired` or when the turn is gone. Thread text never goes into the title, hash, history or storage. Storage holds only `home:lastRepo` and banner dismissals. | Met |
| U6 route | `STATIC` has one exact entry with `public:false`. The tests cover signed in (200, JS type, CSP, nosniff, exact bytes), signed out (302 to `/login`), and the negative variants (`/MODES.JS`, `/modes.js/`, `%00`, `%2f`, `..`, `.mjs`, `.map`, the query, dot segments). `index.html` loads `/modes.js` before `/app.js`, both deferred. `modes.js` is deep-frozen (tested recursively) and contains no import/export, DOM or network code. | Met |
| U7 regex | `escRe` escapes `[.*+?^${}()|[\]\\]`. The regex is built per name with literal boundaries. Tests cover metacharacters (`web.v2`) and 4,000 characters × 50 repos in under 50 ms. `lastRepo()` accepts only an exact registered name. | Met |
| U8 text only | Answers go through the unchanged DOM-only `renderMarkdown`, and reports through `renderReport`. Citations are `<code>` text (`file:lines`). Basis, `tierNote`, `error`, server messages, notices, reasons and repo or provider names are set as text nodes or `title`/`aria-label`, and never as a URL. | Met |
| U9 roleEdit | `roleEdit` makes a JSON deep copy of the fresh GET entry and changes only `providers`; there is a no-mutation test. The popover goes through the same `applyRoleChanges` and therefore the same fresh GET. | Met |

No new HTML sink, inline script, style attribute or inline handler was found. `index.html` passes its test. The CSS has no `@import` and no external `url()`. The CSP is unchanged.

### Findings (all Low, none blocking)

- **L1 (Low): the AC6 comment stripper can hide a finding.** `code()` drops everything after a `//` that does not directly follow `:`, a quote or a backslash. A string such as `'a // b'` followed by a sink on the same line would therefore be hidden from the banned-word scan.
  - Fix: scan the **raw** source for the HTML-sink and eval words (`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval(`, `new Function`).
  - Reword the one comment at app.js:2 that mentions `innerHTML` ("no HTML-string DOM APIs").
  - Follow-up in the next UI slice (M8-2 UI step) at the latest.
- **L2 (Low, hardening): `safeAttr` uses a deny-list of URL attributes.** Attributes outside `URL_ATTR` (for example `ping`, `background`, `cite`, `formtarget`) pass through as plain strings.
  - Not exploitable today: no call site sets them, `data` is intercepted by `h()` as dataset, and `formaction` is dropped.
  - Before M8-6 adds richer brief rendering, consider adding `ping` and `background` to `URL_ATTR`, or switching to an attribute allow-list.
- **L3 (Note): the remaining 409 text is developer wording.** If the server state changes between GET and PUT, the 409 message ("Send "acknowledge": …") is shown verbatim. This is safe (text only, never acted on) but reads oddly. A UX follow-up could prefix it with "Its isolation state changed; try again."

**Release gate:** satisfied for the Security part. U1–U9 are met, with no Critical, High or Medium finding. L1 and L2 are tracked as follow-ups.

Verdict: Approved
