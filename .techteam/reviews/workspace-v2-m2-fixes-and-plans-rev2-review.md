# Verification of the M2 code-review fixes (f608422) and review of the M3-M7 plans rev 2 (f2b0bc7)

- Reviewer: independent; by diff and targeted probes, no full re-review. Code read from a `git archive` export of `f608422` (the working tree was not used). Plans read at `f2b0bc7` against my `workspace-v2-m3-m7-plan-review.md`, the Security design document, and the code.
- Method for part 1: `npm run check` and `npm test` under a fake `HOME`; the diff `d08e05f..f608422` plus the final state of each touched file (some of B1/B3 landed in the Security commit `d08e05f`, so I checked the final code, not only the last diff); seven mutation tests (the fix re-broken in each way); one scratch probe. Nothing outside the scratchpad was written.

## Part 1 — M2 code blockers B1-B5 and the majors (f608422)

Facts: `npm run check` clean; **587 tests, 583 pass, 4 opt-in skips**; the fake `HOME` stayed empty.

| Item | Result | Evidence |
| --- | --- | --- |
| B1 health waits for the home lock | **Closed** | `codexAuth` no longer takes the lock and never purges (`prepareCodexHome(undefined, {purge:false})`); `agentHealth` is now composed from `detect()` + `auth()`. Tests B1 and F-2 start a 2.5 s fake stage, then require health in under 1.5 s. Mutant (the lock put back) fails both |
| B2 broken install at exec / stale health | **Closed** | `classifyCodexFailure`, `runClaude` and `runCursor` return `spawn` when a non-zero exit produced no events and stderr matches the broken-launcher shapes; the contract suite proves it for all three providers (`[claude] [cursor] [codex] a broken install is a START failure`). `Engine.freshHealth()` refreshes a missing/stale reading itself before every read-only and build route (bounded to 8 s; `runtime.ts` wires `readAgents`), so a dashboard is no longer required. Test B2 covers both the "nobody looked" path and the refresh path. Mutants (spawn classification removed; `freshHealth` call removed) are killed |
| B3 canary control cannot pass | **Closed** | The control layer (hook, MCP server, rule) is now written into the **private home** (which is signed in), under the lock, run without the isolating flags, and removed in a `finally`, after which `prepareCodexHome(..., {purge:true})` restores the config and verifies nothing of ours is left. The fake CLI now needs `$CODEX_HOME/auth.json` (an unauthenticated control would fail the tests; mutant: control back in a scratch home ⇒ the canary tests fail). The canary checks sign-in first and stops before any model call with a message that names the sign-in command. `doctor --clear-block codex` appends an add-only `user-clear` record, after which the code constant applies again; the test covers a new block after a clear. `canaryValidated()` is false, so even a matching PASS does **not** lift the tier until the matchers have been checked against a real transcript, while a block still blocks (mutant that removes the guard is killed). Honest and fail-safe |
| B4 AC3 / contract suite / engine tests | **Closed** | `Provider` now has `detect`, `auth`, `selfTest` (one vocabulary: `missing | broken-install | not-logged-in | ok | unknown`); `ApiProvider.state` uses `unknown`; `test/providers/contract.test.ts` is 22 tests (7 behaviours × 3 providers plus a "every registry provider is covered" guard); two engine tests prove plan complexity changes who reviews and that a limit on the first provider moves the stage and records the pause (the second card then skips the paused provider) |
| B5 settings back-mapping | **Closed** | `setCursorFallback` never moves a chain; my probe case `['cursor','codex','claude']` + `onClaudeLimit:'cursor'` now stays; the round-trip and both append/remove cases are in the test; mutant (the old remove-and-append) killed |
| Majors | **Closed** | `--output-schema` removed from the argv (the exact-argv test updated; the comment records why); the canary write item needs a recognisable denial (`WRITE_DENIED`; mutant killed); `auth` failures stop the stage with the sign-in command (`case 'auth'`); the whole role map GET→PUT works (already-assigned entries are not re-judged; I confirmed it with a scratch API test: 200 and the map unchanged); README/plan/message wording fixed; the dead "Providers panel" reference replaced |

Residuals (none blocking):
- `BROKEN_RE` (shared by all three adapters) includes `vendor` and `not found`. It is only consulted after a non-zero exit with no result/events, which keeps it narrow in practice, but a CLI that fails with "model not found" and prints no result would be reported as a start failure and hop to the next provider. Consider limiting it to `ENOENT`, `cannot find module`, `native binary`, `missing optional dependency`.
- There is no committed API-level test of the whole-map GET→PUT round trip (the settings-level round trip is tested). I verified it with a scratch test; please add it.
- `test/server.test.ts` (demo scenarios) was edited so DEMO-2 is approved if it is waiting, because the old assertion depended on the order two parallel plans finished in. The reason is sound and the assertion that matters (`loop === 2`) is kept, but it is a changed v1-era test that is not on the M2 matrix; list it there.
- A crash in the middle of the canary leaves the control `hooks.json` in the private home; the hygiene pre-flight then refuses Codex (fail closed) until the user removes it by hand. Optional: let the next canary/doctor run delete the canary's own known file names.

**Decision (M2 fixes): Approved** — B1-B5 and the majors are closed; the 11 mutants of last round and the 7 of this round are all killed.

---

## Part 2 — M3-M7 plans rev 2

I checked each rev 2 against my numbered conditions, against Security's, and against the code. Where a rev 2 sentence is still stale or two plans disagree I say so. None of those is blocking.

### M3 — task graph: **Approved**
- M3-1 (retry in real triggers) is §2b-1 and matches `rerunFromHuman` (origin `build` keeps done items; origin `plan`, a description edit, a new revision and the untrusted-unapproved rule discard the graph); the superseded subtask cards are canceled instead of orphaned. M3-2 (adopt) is §2b-2: exactly one commit with parent `startHead`, clean tree, **a per-attempt nonce recorded before the builder starts**, then `postBuildChecks` and the item gates before `done`; anything else backs up and resets; the crash-window block is bypassed for graph runs; forge tests listed. M3-3 (characterization first) is Commit 0 and the claim is restated to what can be guaranteed. M3-4 is the transition table with `ready` derived and `allSettled` for concurrent analysis items. M3-5 puts `planToMarkdown` and the plan-review prompt in §3. M3-6 is a global analysis semaphore. The trust classes (§2b-7), safe attribution, string hygiene and the hard 12-item ceiling are in.
- Small wording points to fix when convenient (they do not block Commit 0):
  1. §2b-1 says "Backlog park/unpark keeps it". In the engine, moving a parked card back to To do goes through `rerunFromHuman`, which re-plans (revision + 1), so the graph is discarded then; say "parking keeps it while parked, un-parking re-plans like any re-plan".
  2. A usage-limit pause on a **running build item** is not in the transition list. Say it stays `running`, and on resume it is treated like crash recovery (no new commit ⇒ back up and reset to `startHead`).
  3. The per-attempt nonce is in `run.json`, which a `--force` builder running as the user can read. State that it is not a secret against the builder and that the checks that follow adoption are the backstop.
  4. §2.5 still says `maxItems` range 1-20; §2b-9 (1-12) overrides it. Edit the older sentence.

### M4 — context engine and offline: **Approved**
- M4-1 is a real one-by-one table (source, trust class, builder/read-only/UI) and every board-derivable row is covered deterministically; only the model-written understanding is Partial. M4-2 computes builder-facing facts from git objects at use time and demotes the store to a cache for read-only stages and the UI. M4-3 covers a hung offline CLI (cached probe before spawning; timeouts reclassified when the probe says offline), the proxy case (any set proxy variable ⇒ `unknown`), a cumulative 24 h ceiling and an episode cap, and a structural-fields-only classifier. M4-4 puts per-project settings in `config.projects[KEY]` (config v5). Security's git hygiene (`GIT_NO_LAZY_FETCH=1`, hardened env, `cat-file --batch`), charset-limited strings, explicit 0700 and fenced history are in.
- Conditions to carry (text, not blockers):
  1. **Accounting sequencing.** `contextRunsPerDay` (M4), `asksPerHour`/`researchPerDay` (M5) and the per-graph/daily budgets all go through the single module that M6 §2b-4 says it owns (`src/limits/budget.ts`), but M6 is built after M4 and M5. Either create that module in the first milestone that needs a counter (M4) and have M6 extend it, or say the counters are in memory until M6 (a restart would reset them). Decide before M4's summaries commit.
  2. State the residual that survives §2b-2: a compromised builder can still rewrite `summaries.json` and `history.ndjson`, and those reach *read-only* stages (fenced, off by default for summaries) and from there influence an approved plan. The structural backstops are the plan holds (`L`, protected paths, untrusted) and the scans.
  3. Row 6 gives builders the titles of open work cards. Exclude cards that are `untrusted` (imports, research/ask-convert) and anything that is not `kind:'work'` created by a human (subtask and bug titles are planner/agent text).

### M5 — Quick Ask and Deep Research: **Approved with conditions** (Security design sign-off is satisfied by its conditions being in §2b; nothing else gates the first edit)
- M5-1 (fast path): opt-in per ask (`allowChange`, default off); eligibility decided on the **planner's plan**, not on the model's `change` claim; the card's description is the user's literal question; plan review is the only thing skipped; approval/holds/policy go through the single approval decision; post-build scope is diff ⊆ plan files for all paths; the server-only fields are stripped from the HTTP schemas with a per-field test; fast-path rate limits. M5-2: default research tools are exactly `{WebSearch, WebFetch, StructuredOutput}`; file tools only for the repo-aware opt-in; the default prompt is the question only. M5-3: the permission mechanism is pre-defined (bare `WebSearch` and `WebFetch` in `--allowedTools`, nothing else) and "widening" is enumerated, so the stop rule is testable; research is offered only with a passing, version-bound probe record. M5-4: `verified` now means "a cited URL was actually opened in this session" (a `read` class from structured WebFetch input), a `listed`-only source is "listed, not opened", `quote` is labelled model-reported, and one normalisation function is pinned. M5-5: asks fail fast with no queue and are never re-run after shutdown. The snapshot is built by Conductor's own extractor (regular files only, `O_NOFOLLOW`, entry-name rules, caps measured before writing, agent-config directories omitted, hardened git env). I accept the `git archive`-style snapshot as a deliberate and safer departure from the master text, with the labels the plan now requires.
- Conditions (text):
  1. §3 still says the fast path will "auto-approve unless hold" (the `stages.ts` row); change it to match §2b-2.
  2. Consider saying "opened" instead of "verified" in the UI and report footer; the word invites exactly the misreading the footer then has to correct. If "verified" stays, the footer sentence must sit next to every report as written.
  3. The accounting sequencing point from M4: M5's persisted counters need the module before M6 exists.

### M6 — policy, board, onboarding: **Approved with conditions**
- M6-1 is fixed properly: forced holds (`L`, protected path, `untrusted`, graph > 8) are the only holds `full-auto` keeps, `approve-risky` adds the risk rules, `approve-plan` and `manual-stages` are as stated, the default is `full-auto` = v1 behaviour, `planApproval` maps (`auto` → `full-auto`, `manual` → `approve-plan`, `first` → `full-auto` plus a separate first-plan hold), and the sweep test now distinguishes the four policies. M6-2: risk rules read structured fields only and each has negative cases. M6-3: one accounting module with a local-day key; `maxRunMinutes` counts running time only; a limit means finish the stage, then hold. M6-4: identity set in the new repository's local config; nested work tree refused; rollback removes only what Conductor created (`dev/ino` checked). M6-5: the sample lives outside the Conductor home. M6-6 and Security's single approval choke point (`decideApproval`, `approvedBy: human | policy:<name>`, with a structural test over every transition into `build`) are in.
- Conditions (text):
  1. §2.4 step 5 still says the wizard's default policy is `approve-risky`, while the table says the default is `full-auto`. State which: for example "projects created in onboarding get `approve-risky` explicitly; existing and imported projects keep `full-auto`".
  2. Project creation says "`mkdir` non-recursive (EEXIST fails)" but the target is described elsewhere as "must not exist or be empty". Pick one (not existing is simplest).
  3. The sample repository is "a user-visible folder the user confirms" in one sentence and "one constant directory exactly" in another. A constant default the user can confirm, registered through the normal `inspectRepo` path, needs no special registration route.
  4. "Deploy manifests" in the CI/deploy risk rule needs a constant list of file names.
  5. The accounting sequencing point (the module must exist before M4/M5 need it).

### M7 — desktop: **Approved** (M7a may start; M7b/M7c remain gated on the user's download permission)
- R-M7-1: the build baseline is per platform in code (macOS only today), a host self-test record can only restrict and is bound to host details, and a record copied from another machine does not count. R-M7-2: the real secret inventory is written (no stored credentials; env passthrough, session OTP/cookie/CSRF, the CLIs' own stores) and the `safeStorage` plumbing is built only when a stored secret exists. R-M7-3: no bare-name spawns (absolute resolved paths only), no `shell:true`, argv-only gates with a conservative token whitelist and an explicit per-gate Windows override, `.cmd` handling with a private command file, and every agent argv value listed with its Windows handling. R-M7-4: Electron pinned and the embedded Node proven, fuses, `asar: false` or an `asarUnpack` list tested from a relocated directory, `tsconfig.build.json` listed. The session hand-off uses the **existing** `POST /auth` form route (I confirmed it exists, `http.ts`), so no new route and no OTP in a URL. The frozen hardening spec, IPC rules, download gate (pinned digests and checksums, nothing before a yes in chat), CI hardening, container build restrictions and honesty labels are all in.
- Conditions (text):
  1. The §2.2 table cell for the Windows no-push row still says "cannot build (the build capability is gated on a passed host self-test record)". §2b-1 overrides it; edit the cell so no reader takes a record as the thing that enables building.
  2. **Say plainly what the product can do on Linux and Windows.** With build disabled until each platform has committed live evidence, a `.deb` or `.exe` that installs and runs can plan, review and verify but cannot build. Update the M7 coverage rows and the final-report wording to "Partial: build disabled on this platform", and raise it to the user as a decision (a D-number like the others) so it is not discovered after packaging.

### Cross-plan, rev 2
- Accounting module sequencing (M4/M5 before M6): above.
- Stale sentences that §2b overrides (M3 §2.5, M5 §3, M6 §2.4, M7 §2.2): edit so the body no longer contradicts the binding text; a future reader should not need the precedence rule.
- The rest of the cross-plan items from my earlier review are resolved: one location for per-project settings (config v5), the trust classes (M3 §2b-7), the fast path vs policy precedence (M5 §2b-2, M6 §2b-1).

---

## Answer to your question: may M3 (commit 0) and M4 start now?

**Yes to both.** My M3 and M4 conditions are written in and I read the text as written; the remaining points above are wording or sequencing, and none changes what commit 0 (the characterization test) or M4's first commit (store + scanner + incremental, pure modules) has to do. Please make the M3 wording fixes and decide the accounting-module placement before M4's summaries commit; neither needs to wait for the other.

## Decisions

Decision (M2 fixes): **Approved**.
Decision (M3): **Approved**.
Decision (M4): **Approved**.
Decision (M5): **Approved with conditions** (the three text items above; Security's before-edit conditions are already in §2b).
Decision (M6): **Approved with conditions** (the five text items above).
Decision (M7): **Approved** (M7a may start; the two table/coverage text items above; M7b/M7c need the user's download permission).
