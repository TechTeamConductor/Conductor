# Plan review — M8-6 "Design the work" (F3) + Deep Research intake (F4): backend + API

- Task / Linear issue: brief F3, F4 (`.techteam/briefs/product-layer.md` §3, §6 Decisions Q2/Q3, §7 "Home"); slice M8-6 of `workspace-v2-m8.md`
- Plan artifact: `.techteam/plans/workspace-v2-m8-6.md` (status pending_reviewer, author ab2e0292471932d82)
- Reviewed by: Reviewer (TechTeam)
- Reviewed at: 2026-10-21, against the clone at `8eaab46` plus the uncommitted M8-1 working tree
- Decision: Approved with conditions. B1 and B2 must be written into the plan text before the first edit, and the code review checks them through the named tests. The Security design sign-off, which runs in parallel, is still required before the first edit. This review does not replace it.

Verdict: Approved with conditions

## Checklist

1. **Codebase analysis is complete enough to implement safely: yes, with small inaccuracies.** I checked these claims against the code and they hold:
   - `TAINTED_ACTORS` (`src/board/types.ts:19`); `ACTORS` checked on journal load (`validate.ts:8,42`); `BOARD_SCHEMA_VERSION = 2`.
   - `Board.text()` redacts only for `conductor|ask-convert|research` (`store.ts:301`).
   - `createItem`: `idemKey` dedupe (`store.ts:427-430`), `checkDeps` (same project, acyclic, ≤ 50).
   - `claimable()` requires every dependency in lane `done` (`store.ts:511-516`).
   - `maybeClaim` sets `run.untrusted` (`engine.ts:453`). `approvalGate` sets `forced.untrusted` (`stages.ts:720`), and `decideApproval` turns it into a forced hold.
   - Only `author==='user'` comments reach the planner (`stages.ts:581`). `taskBlock` uses the `task-card` fence. `fence()` escaping works.
   - `callAgent` makes one shared retry. The corrective re-ask comes on a validation or parse failure.
   - `runResearch` hard-codes `maxTurns: 30` and `hardMs: minutes(20)`.
   - `take(..., {n})` already exists in `budget.ts:63`, and there is no `refund`.
   - `safeEntryName`, `sanitizeLine`, the research `block()`, the private `isProtectedPath` (`worktree.ts:712`), and the `# Stage:` matcher in the fake CLI (`fake-claude.mjs:133`).
   - `validateAsk` rebuilds records field by field. CSRF, Host and Sec-Fetch apply to every mutation (`http.ts:294-298`).

   Inaccuracies, none of them blocking:
   - (a) `HOME_SKELETON` does not exist at `8eaab46`. It is uncommitted M8-1 work in `src/paths.ts:18`. `asks` is **not** in it, so "like asks" is wrong (see N9).
   - (b) "`untrusted` is sticky until a human approves" is wrong. `run.untrusted` is never cleared. `engine.ts:523-524` only forces a re-plan after a restart. The real behaviour is stricter, because every plan revision is held again. The text should say so.
   - (c) "An older build refuses the snapshot" is only partly true (B1).
2. **Every task requirement is covered: yes.** The §7 matrix maps F3, F4, Q2 and Q3, the caps, the prompts and the §7 "Home" items to named tests. The "Ask via existing API" item maps to the unchanged suites. The UI is correctly out of scope (M8-U).
3. **Proposed architecture is correct: yes, with B2.**
   - `deps` as 1-based earlier-part numbers makes the graph acyclic by construction. The server assigns part ids, and the send body carries part ids only.
   - The actor is a code constant, `design`, which is in `TAINTED_ACTORS`. That forces the hold under every policy, and M8-4's T2 loop covers run mode on its own.
   - The research brief runs question-only in an empty cwd on the read-only profile. Research stays in the asks store and the board gets a projection.
   - Dependency semantics match today's board and engine:
     - A dependent card can be claimed only when every dependency card is in lane `done`.
     - A finished run stops in `review`, and a person moves it to Done (`engine.ts:799`). Conductor never merges.
     - The worktree is cut from `repo.baseBranch` at claim time (`worktree.ts:380`).
     - So "merge part 1, then move it to Done" is the real contract, and the card text says so (see N3).
4. **Affected-file list is accurate: yes.** Every Modify target exists. `isProtectedPath` is correctly listed as "export only". `budget.ts` needs only `designPerHour` and `refund`, because `n` already exists.
5. **Security, authorization, compliance: yes, with B1 and N1/N2/N5/N6.** T1–T13 are concrete and each has a test. The `selRole` pass-through does not bypass `route()` (detail under Notes). The parallel Security design review owns SD-1…SD-4.
6. **Testing strategy is adequate: yes, with additions.** Negative cases are covered: strict bodies per forbidden key, CSRF 403, id regex, hostile JSON, fences, paths, planted token and a hand-edited record. B1 and B2 each need named tests (below).
7. **Risks, dependencies, acceptance criteria are explicit: yes.** C1–C4 have fallbacks. Q-A…Q-E are reversible defaults. AC-6.1…6.12 can be measured.

## Blocking (conditions to fold into the plan before the first edit)

**B1 — The board schema v3 bump does not deliver the T12 "downgrade refused" guarantee, and there is no backup.** The version lives only in `snapshot.json`. It is stamped only when the board compacts, which happens every 500 ops or at a clean close (`store.ts:261-287`). Journal ops stay `v: 1` (`journal.ts:126`).

The failure case:
- The v3 build creates a `design` card, then crashes or is killed before compacting.
- A v2 build then opens the board. It finds a v2 snapshot, which it accepts, and a journal whose `design` line fails `validateEntity`.
- If that line is the **final** line, `Journal.load` treats it as a torn tail and **truncates it** (`journal.ts:129-135`, 147-156). The card disappears silently, with only a `.torn-*` copy left.
- If the line sits mid-journal, the load refuses, which is correct.

M5's v2 bump has the same hole, and this slice can close both. `loadVersioned` registers no migration, so `saveVersioned`'s pre-migration backup never runs. `Journal.compact` does not use `saveVersioned` anyway.

Required:
- (a) On a writable `Board.open`, when the on-disk snapshot is older than `BOARD_SCHEMA_VERSION`, or is absent while the journal is non-empty: first `backupPaths([snapshot.json, journal.ndjson], {label: 'pre-board-v3'})`, then `compact()`, before any write. A v3-only op can then never sit behind a v2 snapshot.
- (b) A test: open a v2-stamped board with the v3 build, create a `design` card, kill without `close()`. Assert that `snapshot.json` already says `schemaVersion: 3` and that a backup exists.
- (c) Update the fixture `test/board/board.test.ts:283`, which uses `schemaVersion: 3` as "newer", to `BOARD_SCHEMA_VERSION + 1`.
- (d) Docs: "no downgrade after Design the work". Restoring needs the pre-board-v3 backup.

**B2 — The send state machine is not fully specified, so "crash mid-send resumes without duplicates" (AC-6.4) and T11 are only partly true.** The write-ahead record plus per-part `idemKey` is the right core. These gaps remain:
- (a) **Nothing resumes a `sending` brief.** It stays `sending` until the UI happens to replay the same selection. The selection is already recorded and replay is idempotent, so the service should finish `sending` briefs at boot (`resumeSending()` next to `failInterrupted()`). A visible "Finish sending" path is the alternative. State which one and test it.
- (b) **`DELETE /api/briefs/:id` and index pruning (cap 200) can remove a `sending` record.** That loses the write-ahead and leaves orphan cards. Refuse DELETE with 409 `bad_state` while the brief is `sending`, and never prune `running` or `sending` records.
- (c) **A deterministic `createItem` failure mid-send** (project archived, board `full` or byte cap, repo unregistered after the check) leaves the brief `sending` forever with k < n cards. Pre-check before the write-ahead: the project is not archived and the board has capacity. Define the terminal state for a failure after the first card, for example `sent` with `sent.error` and the cards created so far, or `sending` with an error and a retry. Test it.
- (d) **The research send has no write-ahead.** A crash between `startResearch` and saving `sent.askId` leaves the brief `ready` while an ask is running. A second Send then starts a second research run and takes `researchPerDay` twice. Write `sending` first and adopt the ask with `ask.briefId` on replay or boot. Also define what happens when the brief is already `sent`: replay the stored `{askId}`, or 409.

## Non-blocking

- **N1 — Research brief profile pinned by a test.** `selRole` must only pick the model and effort. It must never reach the Claude `profile` choice: `claude.ts:47` switches to `WebSearch,WebFetch` when `profile === 'research'`. Add to "brief call has empty cwd and no facts": the argv has `--tools Read,Grep,Glob` and no `WebSearch`/`WebFetch`. `selRole` is a code constant in `BriefService`, never taken from an HTTP body.
- **N2 — `/api/ask` stays closed to the new fields.** `startResearch` gains `brief`, `depth` and `briefId`. Add a test that `POST /api/ask {mode:'research', brief|depth|briefId}` returns 400. The research brief must come only from the stored, re-validated record. Prefer an internal method or a second argument that the HTTP handler cannot reach.
- **N3 — Card wording on dependencies.** Conductor neither verifies merges nor fetches. Say "merged into your local `<baseBranch>`, then moved to Done". Optional improvement for a later slice: at claim time, hold a dependent card when its dependency's commit is not an ancestor of `baseBranch`. A dependency that is canceled leaves the dependent card in To do with no explanation. Surface that in the card view.
- **N4 — Deep wall clock is double what SD-3 states.** `runResearch` re-runs once on a schema failure (`service.ts:122-125`), so Deep can take 2 × 35 min and 2 × 50 turns, and Standard 2 × 20 min. State this in SD-3 and the docs, or cap the re-ask.
- **N5 — Pick the sanitiser per field.** `block()` strips only Cf/Co/Cn, so C0 controls (ESC, CR) survive. Use `stripInvisible` (`graph.ts:23`) for `approach`, which keeps newlines, and `sanitizeLine` for every other field. Add a table of field → function → cap to §2.3.
- **N6 — Keep model text out of validation messages.** Validation messages go back into the model prompt (`caller.ts:60`) and into the user-visible `error`. Messages name the field and the rule only and never quote model text. Add a test.
- **N7 — `exists` is wrong for omitted files.** The snapshot omits agent config, files over 25 MB and symlinks. So `.husky/pre-commit`, `.mcp.json` or a large asset shows `exists:false`, as if it were new, though it is in the repo. Compute it from the commit's `ls-tree` list, which `buildSnapshot` already reads, as `file | symlink | omitted | absent`. Or label omitted paths "not in the snapshot".
- **N8 — `GET /api/board` cost.** `listAsks()` loads and validates every ask file (up to 500 × 512 KB) on every board fetch. Deriving `design?` per item would load briefs too. Cache the research projection, invalidated when an ask is saved. Derive `{briefId, part}` from the item's `idemKey` (`design:<briefId>:<Pn>`) and the part count from a small cached index.
- **N9 — `HOME_SKELETON` dependency and semantics.** It comes from M8-1, which is uncommitted. Membership means "an empty folder of this name is not data". Add `briefs` only if `<home>/briefs` is created eagerly. Otherwise leave it out (then even an empty folder counts as data), as `asks` is today. Fix the "like asks" wording.
- **N10 — Scratch dirs follow the M5 rules.** Per M5-11 and M5-13: the brief snapshot or scratch dir lives under the swept scratch parent with an owned prefix, and the service asserts that `cwd` is under it. Shutdown **aborts** running briefs rather than only waiting for them in `idle()`. DELETE of a running brief aborts it and removes its snapshot.
- **N11 — `selRole` must follow M8-2's per-candidate rule.** C2's wording, "head is that row's tool, else default", differs from M8-2 §2.5, `selectionFor(req.selRole ?? req.role, cand.id)` per candidate. Defer to M8-2 verbatim. When M8-3 lands, its "account lacks the model" filter must use the same `selRole` as the selection.
- **N12 — `refund()` window.** Refund the window key captured at `take` time, and do nothing if the window has since rolled over. Decrementing the current window gives an unearned credit.
- **N13 — Research choices in the request.** Say that `choose_repo` does not apply to `kind:'research'`. The repo is optional there and is needed only for convert. The UI should disable Deep when `researchUsed + 2 > researchPerDay`, since `state.home.limits` already carries the numbers.
- **N14 — Convert card title.** When a brief exists, "Turn into an engineering plan" makes the card title model-written (the brief `title`). Today the title is the user's question. Keep the user's words, or prefix "Research:" so a model-written title cannot pass for the user's own.
- **N15 — M8-U contract record.** `workspace-v2-m8-u.md` does not yet name `state.home.design`/`researchBrief` or the §2.6 fields. Record C1 there, or in an M8-U addendum, so the UI's feature detection and wording rules (fixed approval hint, "files in the snapshot", no "Context from the repo") are in its own plan.

## Coverage confirmation

- Requirement mapping is complete: yes
- Gaps that block approval: none in coverage. B1 and B2 are correctness and spec gaps inside covered rows (T12, T11/AC-6.4).
- Brief §7 "Home" → tests:
  - Ask via existing API → unchanged `asks`/`research` suites plus the "unchanged" test.
  - N linked cards → `briefs-send.test.ts` (5 named tests; add the B2 tests).
  - Cap 8 → schema, service and send tests.
  - Schema-validated → one test per invalid class, plus "exactly 2 design calls".
  - Untrusted → the createdBy/untrusted test and the 4 policies × 2 run modes matrix (M8-4 T2 also iterates `TAINTED_ACTORS`).
  - Research respects daily caps → pre-check 429, Deep 2 / Standard 1, one at a time, persisted, refund.

## Notes

- **Does `selRole` bypass `route()`? No.** `route()` gets `role:'context'`, so the capability and tier gates of `context` apply. The research gate (`webResearchIsolated`) concerns web tools, which this call never gets. `selRole` picks the model and effort only. M8-2 §2.5 re-checks each pick against the catalog and `MODEL_ID_RE` per candidate. The remaining safety condition is N1.
- **Is model text ever truncated into shape? No, for structure.** Parts over 8, a bad dependency or a bad path is an error, which triggers the one re-ask and then `failed`. String caps after validation are display limits, not structure. `extractJson`'s 300 KB tail window is existing behaviour.
- **Description length.** User line ≤ 4000, plus approach ≤ 2000, acceptance 12 × 300 and risks 10 × 300, can exceed the 8,000 cap. The "Untrusted" marker sits before all model text, so truncation never removes it. State that model text is cut from the end.
- **Autostart cost.** Every sent part without dependencies starts planning at once and stops at the forced hold. That is expected, but it spends planning quota for up to 8 cards. The Send confirmation could say "N plans will be written now".

## Record

- Artifact path: `/Volumes/Sandisk/github/techteam-conductor-v2/.techteam/reviews/workspace-v2-m8-6-plan-review.md`
- Next action:
  1. Lead or the author folds B1 and B2 (and preferably N1, N2, N4, N5, N10) into the plan text.
  2. The Security design sign-off is recorded.
  3. Implementation then starts in the same session. No second plan review is needed if the folded text matches B1 and B2.
  4. At code review, the B1 and B2 tests and the T1–T13 tests must be present.
