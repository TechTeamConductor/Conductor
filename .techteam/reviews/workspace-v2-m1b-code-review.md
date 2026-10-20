# M1b code review (and verification of the M1a fixes)

- Reviewed commits: `f46f9b8` (M1a fixes) and `4b7b74c` (M1b) in `/Volumes/Sandisk/github/techteam-conductor-v2`, each exported with `git archive` to a clean directory (the clone's working tree may contain later edits).
- Reviewed by: Reviewer (independent). Read in full: `src/pipeline/{engine,effects,context}.ts`, the stage/effect parts of `stages.ts`, `src/server/api.ts` board routes, `src/store.ts`, `src/schema/run-migrations.ts`, `src/paths.ts`, `src/board/{lanes,journal,store}.ts` diffs, runtime/cli/doctor/demo diffs, every changed test and the harness. Security review is a separate gate.
- Compared against: `workspace-v2-m1.md` rev 4 (K1–K4, lane/command/crash protocol, mapping rows 1–16, AC12 matrix).
- Method: I ran the suite under a fake `HOME`, ran each affected test file on its own to check counts against the matrix, and wrote adversarial probes against the committed code (scratch scripts outside the repo): a real board storage failure driven through `Effects`, a "read-only" `RunStore` driven through every mutator, `ensureHome()` against v2-skeleton and v1-like folders.

## Verified facts
- `npm run check` clean; **`npm test` = 560 tests, 556 pass, 4 skipped** (3 live + 1 Keychain smoke) — matches. The suite leaves a fake `HOME` completely empty (the `test/preload.ts` of N8 works).
- Per-file counts match the matrix exactly: `engine-authz` 1 (5 → 4 retired), `engine-human` 6 (1 retired), `engine-security` 10 (3 retired), `engine-regress` 18, `engine-safety` 12, `engine-plan` 4, `engine-limit` 3, `engine-loop` 3, `engine-happy` 1, `core` 14, `server` 20 (1 replaced, 2 added), `setup-wizard` 3, `engine-board` 43, `agents` 20, `board` 28, `schema` 12.
- Nothing in `src/` outside `src/linear/**` imports Linear code: the only references are the `export type * from './linear/types.ts'` shim, `config.linear` (M1c), the `SECRET_LINEAR` constant (M1d) and the importer-facing migration code. `src/linear/**` and its 205 tests are still present and green, as planned.
- Mapping rows 1–16, the desired-lane table (`laneForRun`), the human command matrix semantics (park / restart / finish / cancel / approve-with-rev / retry-on-paused / resume / abort-any-status / cleanup), K1 (single-write transitions: `toNeedsHuman`, `markReady`, `deliverAnswer`, `approvalGate`, `abort`), K2 (HTTP `move` goes through `engine.applyHumanMove`, never `board.setLane`), K4 (orphans flagged not reset; only `work` is claimed) and the `untrusted` approval gate are implemented as specified. `integrity()` keeps the v1 halt-on-description-edit behaviour; the §3 contradiction is gone.

## Part 1 — M1a fixes (B1–B3) verified by diff and test
- **B1** `Journal.append` now records the size before each append, rolls back with `ftruncate`+`fsync` on any `write`/`fsync` error and marks the journal failed; `Board.requireWritable` refuses all later writes (`storage_failed`) and `close()` does not compact a failed journal; compaction failures inside `commit` are swallowed with a back-off (`nextCompactAt`) so a durable write never reports failure; a `closed` flag refuses writes after `close()`. The two new tests inject faults at `journal:mid-append` and `journal:before-fsync`, assert nothing changed in memory, every line on disk is whole, the acknowledged item survives, `recoveredTornBytes === 0`, and the doomed key (`APP-2`) is reissued cleanly. **Closed.**
- **B2** `cloneItem()` (deep copy of `dependsOn` and `external`) is used on every return path and on the way in (`external` is copied from the caller); the test mutates every returned and listed copy, then compacts and reopens. **Closed.**
- **B3** `node_modules` is untracked and `.gitignore` has `node_modules` (no slash): `git ls-files node_modules` is empty, `git check-ignore` matches. **Closed.**
- Also taken and verified: N1 (crash assertions now check each acknowledged item and comment by title/body), N4 (honest message), N6 (`claimable()` = `work`), N8 (preload), N10 (fixture `at`), N3 in part (malformed-op shape check, stale temp cleanup, directory fsync on journal creation), N2 in part (see B2 below).
- Residuals, non-blocking: the test titled "N5 … UserBoard rejects wrongly typed fields" only asserts repo-name validation and `#b`; `UserBoard.createItem` still silently drops `parentId: {}`, `dependsOn: 'abc'`, `autoStart: 'true'`. `test/preload.ts` uses `||=`, so a `CONDUCTOR_HOME` exported in the developer's shell would make `npm test` run against that folder — assign unconditionally. After a failed automatic compaction `nextCompactAt` is not reset by a later manual `compact()`.

## Part 2 — M1b

### What is good
The crash protocol is real code, not prose: status and pending effects land in one `RunStore.update` (K1), effects carry idempotency keys, `flush` runs at startup and every tick with back-off, the lane projection is level-triggered and skips runs that still have pending effects, orphan cards are flagged rather than re-run, a card's lane is only ever written by Conductor after the run record changed, and every claim path funnels through `claimable()` + "no run yet". The tests for windows (a) (really reads `run.json` from disk to prove status + pending effects were written together, then lets a *new* engine converge), (b), (c), (d), (e) and K2 (interleaved ticks) are meaningful. The `untrusted` test proves an imported card waits for approval under auto-approval.

### Blocking

**B1. Effects gives up on real storage failures, losing narration comments and hiding the problem (violates K3 and "no lost narration").**
`Effects.apply` (`effects.ts:193`) classifies `permanent = e instanceof BoardError && e.code !== 'read_only'` and then marks the effect `done`. But a failed or closed board throws exactly `BoardError('storage_failed')` / `BoardError('closed')` (M1a B1 fix). Reproduced against the committed code: inject a journal write failure, then call `effects.comment(...)` twice and `effects.state(...)`: all three effects end `status: done` with `lastError` set ("giving up"), `storageProblem()` stays `null` after 15 s and after 60 s, and the board reports `storage_failed`. Consequences: the needs-you explanation / ready summary are dropped permanently (restart will not re-apply them), the dashboard never shows the storage banner, and the K3 test passes only because it injects a plain `Error` (`engine-safety`: `(h.board as any).addComment = … throw new Error('ENOSPC…')`) — a failure the real board can never produce. Required: permanent only for genuinely unrecoverable semantic errors (`not_found`, `bad_input`, `archived`, `too_deep`, `too_many`, `bad_dependency`, `cycle`); treat `storage_failed`, `closed`, `read_only` and every non-`BoardError` as transient (back-off + `lastFailure` + banner). Add tests that use the real thing: a `Board` opened with a `fault` hook that fails an append, the run's effects stay `pending`, `storageProblem()` is set after the stuck interval, and after "restart" (reopen the board, new engine) the comments and lane are applied exactly once.

**B2. The "read-only" `RunStore` is only read-only for reads.**
The N2 fix guards the constructor `mkdir` and the corrupt-file quarantine, but `create`, `update`, `appendEvent`, `writeArtifact`, `writeText` and `ensureDir` are unguarded. Reproduced: on `new RunStore(root, { readOnly: true })` all five mutators succeeded and `run.json` was rewritten. The M1c importer reads the *v1* home through this class and the plan promises that home is never written. The N2 test only covers `get()` and the constructor, so its title ("never renames, rewrites or creates anything") over-claims. Required: every mutator throws `RunStoreError('read_only')` when the store is read-only, with one test per mutator.

**B3. The command-matrix test does not cover every cell the plan lists, and its mid-run cells are not real states.**
The plan's M1b test requirement is "the human command matrix as a table-driven test (every cell of run.status × command, including the 409s)". `engine-board.test.ts` covers statuses `none, queued, paused, ready, failed, parked, finished, aborted` only: **`running`, `awaiting_approval` and `needs_human` are absent**, and the `queued`/`paused`/`failed` cells are produced by overwriting `run.status` with `store.update` while no job exists. `running` is the cell where jobs are stopped, `awaiting_approval`/`needs_human` are where users act. Individual migrated tests cover some of them (running → cancel, running → todo, needs_human → todo, awaiting_approval → backlog → todo) but not `running → backlog/done`, `awaiting_approval → done/canceled`, `needs_human → backlog/done/canceled`. Required: add the three columns, driving `running` with a hanging fake agent (as `engine-human` does) and the other two through the real pipeline, plus a cell for each of `approve/retry/resume/abort/cleanup`. (AC12's gate says every *listed* new test must exist.)

### Non-blocking (fix before M1b closes if cheap, otherwise in M1c)
- **N1 `assertHomeIsUsable` misdiagnoses an empty v2 skeleton.** A folder holding only empty `logs/ run/ runs/` (what M1a code created, or what a crash between `mkdir` and the marker write leaves) is rejected with "contains data from Conductor v1" (reproduced; so is an M1a home with a board folder). Write the marker first, and treat known empty skeleton directories as usable.
- **N2 `Engine.approve(key, by, rev?)`** accepts a missing `rev`; the API requires it, but internal callers can still approve a stale plan. Make `rev` required for `by: 'human'`.
- **N3 `applyHumanMove` resolves the run with the key it was given.** `board.item()` accepts an id or a key but `store.get(key)` only a key; called with an item *id* of a card that has a run, it takes the no-run branch and writes the lane directly (K2 hole for internal callers; the HTTP layer only passes `KEY_RE` keys). Resolve `item.key` first.
- **N4 `GET /api/board` returns the *oldest* 2000 items** (`items()` is ascending by `createdAt`, then `.slice(0, 2000)`): once there are more than 2000 cards (history imports, bug children) new cards vanish from the dashboard. Return the newest, or filter by lane / paginate.
- **N5 Error mapping:** `boardStatus()` maps `storage_failed` and `closed` to 400; they are server-side conditions (503).
- **N6 `server.test.ts` approve test passes vacuously** (`if (!waiting) return`); assert the 400 (missing `rev`) and 409 (stale `rev`) on the run the E2E test already waits for.
- **N7 Narration that is still two writes:** the pause comment (`pauseForLimit`), the verification-failed summary and the `claimed` comment are written after the status change, not in the same update; a crash between loses that one comment (the lane heals). K1 only named four transitions, so this is acceptable — say so in the checkpoint.
- **N8 UI/docs** are deliberately untouched (dashboard wizard broken until M1c); `docs/API.md` still describes the old endpoints and `approve` without `rev`.
- Cosmetic: a test title still says "Linear comments"; `taskBlock` still prints "Issue key:".

### Matrix check — did every *survives / identical* property keep an assertion of equal strength?
| Property | Result |
| --- | --- |
| engine-safety ×9 (isolation fail-closed, builder env, diff-scope, guard tamper, push attempt, env-secret redaction, crash recovery, no-gates, baseline masking), engine-security M1/M4/M6×2/M8/M9/BAR-363×2 | **Unchanged** (diff touches only imports/titles). |
| engine-security H1 restart rate limit | Kept; same assertion, now via `applyHumanMove`. |
| engine-security H3 (credential in a bug title) | **Stronger**: scans every board item and comment, not only titles. |
| engine-human ×6 (park/backup-ref/cancel/kill-on-cancel/abort+retry/description halt) | Equal; the description-halt test is identical in substance (needs_human "description changed", re-plan rev 2). |
| engine-plan (blocked plan + comment, first plan, approve) | Equal or stronger (text `/approve` never approves; stale rev refused; second approval refused). |
| engine-regress m1 / engine-safety crash adoption | Equal (adoption by idempotency key, two keys). |
| engine-safety outage test | **Weaker than it looks** — injects a plain `Error` the real board cannot throw (see B1). |
| engine-regress m2 (un-park) | Replaced by "restart keeps commits": by design (there is no un-park command), but note a parked `awaiting_approval` run can now only be re-planned, not resumed. |
| Retired: authz ×4, security H1-teammate/H2/M3 ×3, human ×1, server linear-key ×1 | Match the matrix; the properties that survive their subject (bug cards never claimed, backlog cards not claimed, approval cannot be forged by text) are asserted elsewhere. |

## Not reviewed / not run
Live Cursor/Claude suites (spend quota), `ui/` and docs (M1c), K5–K7 (M1c), Windows/Linux. M1b's `Engine` still hard-codes the two providers (M2).

## Decision
The M1a fixes are correct and complete. M1b implements the plan faithfully and the suite is green, but it has one real data-loss-of-narration bug that the tests cannot see (B1), a safety guard that does not guard (B2) and an incomplete AC12 test (B3).

Blocking list (M1b)
1. Effects must not give up on `storage_failed` / `closed` / `read_only`; real-`BoardError` tests incl. restart and banner (B1).
2. Every `RunStore` mutator refuses when read-only, with tests (B2).
3. Complete the command-matrix test: `running`, `awaiting_approval`, `needs_human` columns with real states, plus the approve/retry/resume/abort/cleanup cells (B3).

Decision (M1a fixes): Approved — B1, B2, B3 are closed; N-items as listed above.
Decision (M1b): Changes requested — blocking items 1–3; I will verify by diff and the new tests (no full re-review). M1c may start in parallel for everything that does not touch `RunStore`/`Effects`.
