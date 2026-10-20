# Sub-plan M1 — Native board, versioned data, Linear retired (M1a–M1d)

- Parent: `.techteam/plans/workspace-v2.md` (rev 2). Requirement: `workspace-v2-requirements.md` §3, §9.
- Author: TechTeam Lead · Date: 2026-10-20 · Plan status: pending_reviewer
- Work happens in the isolated clone `/Volumes/Sandisk/github/techteam-conductor-v2` with throw-away `CONDUCTOR_HOME`s. The real `~/.conductor` is touched only by the user-triggered `conductor migrate` (M1c).

## 1. Current State (verified in code)

- Engine claim path: `Engine.pollOnce` → `linear.candidates(teamId, triggerLabel)` → `reconcileRun` for existing runs → `maybeClaim` for new ones (`engine.ts:256-378`). Claim requires: state type `unstarted` (or `backlog` with `pickupFromBacklog`), `creatorId === viewerId`, trigger label + description + title + project/label attribution from issue **history** (`attribution.ts`), not a bug-labelled child, not a child of a Conductor run.
- Resume matrix `reconcileRun` (`engine.ts:406-475`): missing issue ⇒ abort/finish; state type backlog/triage ⇒ park (only if `moveIsMine`); `unstarted` ⇒ re-run from human when `run.expected.stateId` shows a human move; `started` + parked ⇒ un-park; `awaiting_approval` ⇒ approved by moving to the "building" state (states mode) or by a `/approve` comment anchored on Conductor's own approval comment.
- `Stages.applyStage` (`stages.ts:79-94`) expresses the pipeline stage as Linear **labels + workflow state** via `effects.state`; `integrity()` (`stages.ts:~195-210`) re-checks description/title attribution at every stage; `plan()` feeds `viewerComments(issue, viewerId)` into the prompt (`stages.ts:395`); bug children via `effects.subIssue` with labels, limits `PER_LOOP/PER_RUN`, marker adoption (`stages.ts:936-963`, `effects.ts:157-192`).
- `Effects` (`effects.ts`): write-ahead `pending` record in `run.effects` before every remote call, marker lookup on retry, give-up after 12 attempts, redaction + `neutralise()` on every body/title.
- `createTask` (`engine.ts:815-833`) creates a trigger-labelled Linear issue; `api.ts` setup steps `linear|team|repo` and endpoints for key/team/provision; `runtime.ts` loads the Linear key from the Keychain; `doctor.ts` probes Linear; `cli.ts uninstall` deletes the Linear key; `demo.ts` runs on `FakeLinear`.
- Types carrying Linear: `Run.issueId/teamId/url/assignedPickup/expected.stateId`, `BugRec.linearId/linearKey`, `EffectRec.linearId`, `Config.linear`, `Settings.linearMode/pickupFromBacklog`, `ApiSetupStep` ids, `LinearPort/LinearIssue/…` (`types.ts:~300-404`), `RunStatus 'finished'` (= human completed the issue).
- Key constraints: `store.ts` `KEY_RE = ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`; `api.ts:53 KEY_RE = ^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$`; branch `conductor/<slug(key)>`; worktree path `<root>/<repo>/<KEY>`.
- Versioning: `config.json` `version` (real file: 1; code writes 2, rebuilds from known keys only → unknown keys lost); `state.json` and `run.json` unversioned; no migration or backup framework.
- Tests touching Linear (from `grep`): `test/linear/*` (attribution 22, client 39, fake 25, ops-validate 12, provision 23, parity), `test/helpers/{harness,mock-linear-server}.ts`, and 71 `h.linear` refs in 12 engine/server/core/setup test files.

## 2. Expected State

**Board (M1a).** Fresh, persisted, versioned (not derived from `FakeLinear`).
```
Project  {id, key[A-Z]{2,6}, name, repo (registered repo name), nextSeq, createdAt, archived?}
WorkItem {id, key=<PROJECT>-<n>, projectId, parentId|null, dependsOn[], kind: work|ask|research|subtask|bug,
          title, description, column: backlog|todo|in_progress|needs_you|review|done|canceled, stage?,
          autoStart, createdBy: user|conductor|import, createdAt, updatedAt, external?{system:'linear',id,key,url} (imported history only), idemKey?}
Comment  {id, itemId, author: user|conductor, body, ts, idemKey?}
Decision {id, projectId, itemId?, title, body, author, ts}      // project-level decisions & milestones (V3)
```
Storage: `<CONDUCTOR_HOME>/board/{snapshot.json, journal.ndjson}`; every mutation appends one NDJSON line of the **resulting entity** (`{t:'item'|'comment'|'project'|'decision'|'del', v}`) with a monotonically increasing `seq`; snapshot compaction (atomic temp+rename, then new journal) every 500 ops and on clean shutdown; load = snapshot + replay journal entries with `seq > snapshot.seq`, a torn final line is ignored and reported. Idempotency: `comment(…, {idemKey})` and `create(…, {idemKey})` are no-ops returning the existing entity when the key is already present (index rebuilt on load). Keys: `PROJECT-n` satisfy both `KEY_RE`s and branch naming; the importer preserves existing keys (e.g. `BAR-363`) and sets `nextSeq = max+1`. All Conductor-authored titles/bodies are redacted + neutralised before they enter the board (H3 survives).

**Versioning framework (M1a).** `src/schema/`: `readVersioned(file, {kind, current, migrations})` — missing version = 1; **newer than known ⇒ throws `NewerVersionError` and nothing is written (runtime refuses to start with a clear message)**; older ⇒ ordered migrations in memory, and **before the first write of a migrated file a timestamped backup is taken** (`<home>/backups/<ts>/…`, with sha256 manifest). Unknown keys are preserved on save (`config.extra`). Applied to `config.json` (real file v1 → 2 → 3), `state.json` (→ v1 explicit), `run.json` (→ v2), `board/*` (v1).
- config v3: `linear` section moved verbatim to `legacy.linear` (ignored; preserved), `agents/stages/pipeline/repos/ui/worktreeRoot` unchanged.
- run.json v2: `issueId→itemId`; `teamId`, `url`, `assignedPickup`, `effects`, `BugRec.linearId/linearKey` moved under `legacy`; `expected.stateId → expected.column`; adds `schemaVersion`.

**Engine on a native `BoardPort` (M1b).** Synchronous, local, single-user. Human intent arrives as **explicit commands** (dashboard/API: create, comment, approve, retry, park/un-park, abort, mark done) and as board column changes made through the same API; there is no remote actor, so `attribution.ts`, `moveIsMine`, `moveCache`, provisioning, labels-as-stages, `states` mode, `/approve` comments, `ignoredMap`, `pollSeconds`/backoff for Linear, `viewerId` plumbing and `SECRET_LINEAR` are deleted. What stays (function, not threat): which comments are user intent (`author==='user'` → next prompt), idempotency of Conductor's own writes (board idempotency keys replace `run.effects` + markers), the resume matrix semantics, the restart rate-limit, `rerunFromHuman`, answer-only tasks.

### Behaviour mapping table (every Linear-coupled behaviour → native replacement)

| # | v1 (Linear) | v2 (native) | Surviving test property |
| --- | --- | --- | --- |
| 1 | `prov()`, `resolveProvisioned`, `createLabel/State`, `teamSetup`, `completedStateId()` | deleted; fixed columns | n/a (provision tests retire) |
| 2 | `applyStage` = labels + state via `effects.state` | `board.setColumn(item, column, stage)` via `Effects.state()`; table: planning/plan_review/building/verifying→`in_progress`; awaiting_approval/needs_human→`needs_you`; ready→`review`; finished→`done`; parked→`backlog`; aborted→`canceled`; queued(new)→`todo` | stage/column shown on board (view test) |
| 3 | claim: `candidates` + creator/trigger/description/title/project attribution | `board.claimable()` = items with `column==='todo'`, `autoStart`, no run yet, not `kind:bug`, not a child of an active run | happy path; bug children never claimed |
| 4 | repo from label `repo:`/project/first line | `item.project.repo`; creation requires a project; importer parses old first-line `repo:` once | unresolvable repo → `needs_human` (migrated test) |
| 5 | park/restart/finish/cancel by moving Linear state + `moveIsMine` history | same matrix keyed on **board column** with `run.expected.column` to ignore Conductor's own writes; all writers are the local user | park/un-park/restart/cancel/abort tests (migrated, identical assertions) |
| 6 | approve by `/approve` comment anchored on our approval comment; or by moving state (states mode) | **only** `engine.approve(key)` (button/API) while `awaiting_approval` for the current `rev`; a stale approve (wrong status/rev) throws | new test: approve outside `awaiting_approval` or for an old rev is rejected |
| 7 | human comment → next prompt (`viewerComments`) | `comments(item).filter(author==='user')` | "viewer comment + retry → re-plan includes the comment" (migrated) |
| 8 | `Effects` write-ahead + marker adoption + 12-attempt give-up | board ops with idempotency keys (`<RUN>:<effKey>`); `Effects` keeps its API (`comment/commentOn/state/subIssue/close`) as a thin redact+neutralise+idempotent-write wrapper; `flush/pendingCount` removed | "crash between write and record ⇒ no duplicate comment/child" (migrated, now via idempotency keys) |
| 9 | bug sub-issues: label `conductor-bug`, `children()`, PER_LOOP 5 / PER_RUN 8 | `board.create({kind:'bug', parentId, idemKey})`; same limits and overflow summary; closed via `setColumn(done)` | loop test + H3 title redaction (migrated) |
| 10 | `Run.issueId/teamId/url`, `BugRec.linear*`, `EffectRec.linearId`, `expected.stateId` | renamed/moved by run.json v2 migration | migration tests |
| 11 | `RunStatus 'finished'` = Linear issue completed | = user clicked **Mark done** (or moved the card to `done`) | finished-run test (migrated) |
| 12 | `viewerId()`, viewer discovery | none (single local author constant) | n/a |
| 13 | redaction secret = Linear key | repo env values + optional provider API keys (`secrets()` seam stays) | secrets-from-env-file redaction test (migrated) |
| 14 | `createTask` → Linear issue | `board.create(...)` (+ project, repo validation kept) | server E2E "New task works" (migrated) |
| 15 | Linear outage tolerance (`effects` flush when Linear recovers) | n/a (local) — replaced by journal crash tests | crash/kill-9 tests (new) |
| 16 | setup wizard `linear/team` steps; `/api/setup/linear-key`, team, provision; `doctor` Linear probe; `uninstall` removes Linear key | removed; wizard = agents → project(repo); `uninstall` prints how to delete the old key (never deletes it automatically) | wizard tests (replaced) |

### Test matrix (retire / migrate / replace) — AC12 binding

| File (tests) | Action | Detail |
| --- | --- | --- |
| `test/linear/attribution.test.ts` (22) | **retire in M1d** | threat model gone; the marker helpers' behaviour is re-asserted by the board idempotency tests |
| `test/linear/client.test.ts` (39), `fake.test.ts` (25), `ops-validate.test.ts` (12), `provision.test.ts` (23), `parity.test.ts`, `helpers/mock-linear-server.ts` | **retire in M1d** | subject deleted; still green/unchanged through M1a–M1c |
| `engine-authz.test.ts` (5) | **retire** (4) / **migrate** (1) | teammate/trigger/description/backlog-pickup tests are n/a; "unresolvable repo → needs_human" migrates |
| `engine-security.test.ts` (13) | **migrate** M1, M4, M6×2, M8, M9, H3, BAR-363×2 (identical assertions on the board harness) · **retire** H1 teammate-move, H2 title-by-teammate, M3 spoofed/stale approve · **keep + adapt** H1 restart-rate-limit (5/hour); **add** "stale/old-rev approve rejected" (row 6) |
| `engine-human.test.ts` (7) | **migrate** 5 (park/un-park, backup-ref before reset, cancel stops run, kill agent on cancel, dashboard abort+retry, viewer edits description mid-run halts at stage boundary) · **retire** 1 (teammate edits description) | |
| `engine-plan.test.ts` (4) | **migrate** 4 (blocked plan + comment, first-plan approval then auto, dashboard approve, one plan-review revision) — the "teammate /approve" assertion becomes "approve outside `awaiting_approval` is rejected" | |
| `engine-safety.test.ts` (12) | **migrate** 9 unchanged (isolation fail-closed, builder env, diff-scope, guard tamper, push attempt, env-file secret redaction, crash recovery, no-gates, noGates=block, baseline masking) · **replace** 2 (crash-adopt-existing-comment, Linear-outage flush → idempotency-key + journal-crash tests) | |
| `engine-happy/limit/loop` (1/3/3) | **migrate** all (7) | |
| `engine-regress.test.ts` (18) | **migrate** all that do not assert Linear specifics; Linear-specific assertions rewritten on the board (same intent) | |
| `core.test.ts` (14) | **keep** (config clamping extended for v3, store, lock, redact, service, open, view, prompts, util, auth ×2, secrets, keychain smoke) — config tests extended, `applySettings` test adjusted | |
| `server.test.ts` (18) | **migrate** 17 · **retire** `linear-key` shape test; add board endpoints + CSRF/Host negative tests for each new route | |
| `setup-wizard.test.ts` (3) | **replace** with agents→project wizard tests (AC1 fresh install path) | |
| `agents/boot/git/live` | **keep unchanged** | |

**Expected counts (stated in advance):** start 483 (479 pass, 4 opt-in skip). Retired ≈ 130 (≈ 121 in `test/linear/*` + ≈ 9 teammate/provision-specific). New ≈ 110 (board store/journal/idempotency ≈ 40; schema/migrations/backup/newer-version/unknown-key ≈ 25; importer + rollback ≈ 15; engine-on-board additions ≈ 15; wizard/API ≈ 10; import-graph 1). **Post-M1d target ≥ 455 passing; any shortfall must be explained line-by-line in the checkpoint.**

## 3. Files to Be Changed

| File | Action | Milestone | Change |
| --- | --- | --- | --- |
| `src/board/{types,store,journal,stages,index}.ts` | Create | M1a | model, journal+snapshot persistence, idempotency, column mapping, `Board` class (sync API above), change events |
| `src/schema/{version,migrate,backup,errors}.ts` | Create | M1a | `readVersioned`, `NewerVersionError`, timestamped backup + manifest, unknown-key preservation helpers |
| `src/config.ts` | Modify | M1a/M1c | v1→v2→v3 as registered migrations; `extra` preserved; refuse newer; `legacy.linear` |
| `src/store.ts` | Modify | M1a/M1b | `run.json` `schemaVersion` 2, migration on read, backup before first write, refuse newer |
| `src/types.ts` | Modify | M1b | `BoardPort`, board types; Run/BugRec/EffectRec/Config/Settings/Api* field changes; move Linear types to `src/linear/types.ts` |
| `src/pipeline/engine.ts` | Modify | M1b | claim from `board.claimable()`; reconcile on columns; remove attribution/prov/viewer/backoff; `createTask`→board; commands for park/un-park/done; tick on board change + 5 s timer |
| `src/pipeline/stages.ts` | Modify | M1b | `applyStage`→board; `integrity()` board-based (item exists, not canceled; title/description re-read, user edits are legitimate and picked up); `viewerComments`→`comments(author==='user')`; bug children via `board.create`; provider-name labels become data-driven (prep for M2) |
| `src/pipeline/effects.ts` | Modify | M1b | thin idempotent board writer; drop write-ahead/attempt records |
| `src/pipeline/{context,view,prompts}.ts` | Modify | M1b | `Provisioned` removal; columns/labels; `url` removal; prompt wording "board" not "Linear" |
| `prompts/*.md` | Modify | M1b | remove Linear wording |
| `src/runtime.ts`, `src/demo.ts`, `src/cli.ts`, `src/doctor.ts`, `src/secrets.ts` | Modify | M1b/M1c | no Linear client/key/probe; `migrate` command; `uninstall` guidance; demo on a temp-home board |
| `src/server/api.ts`, `http.ts` | Modify | M1b/M1c | new routes (projects, items, comments, move, done), setup steps `agents|project`; every route: input limits, `safeDecode`, KEY_RE, CSRF/Host/Sec-Fetch rules unchanged |
| `src/import/linear-history.ts`, `src/migrate.ts` *new* | Create | M1c | importer + staged, backed-up, dry-runnable cut-over |
| `ui/{index.html,app.js,style.css}`, `dev/mock-api.mjs` | Modify | M1c | Linear-free wizard, New task→board, board columns, comments panel, remove "Open in Linear" |
| `test/helpers/harness.ts`, `test/**` | Modify/Create/Delete | M1b–M1d | per matrix |
| `src/linear/**`, `test/linear/**`, `test/helpers/mock-linear-server.ts`, `test/fixtures/linear-schema.graphql`, `graphql` devDependency | Delete | **M1d only** | after the import-graph test proves nothing imports them |
| `README.md`, `docs/{API,ARCHITECTURE,TROUBLESHOOTING}.md`, `AGENTS.md`, `CLAUDE.md` | Modify | M1c/M1d | same milestone as the behaviour |

## 4. Implementation TODO

- [ ] **M1a** board types + journal/snapshot + idempotency + torn-line tolerance; `schema/` framework; config/state/run.json versioning (real-shaped v1 fixtures committed under `test/fixtures/real-v1/` with secrets scrubbed); tests; **no engine change**; Reviewer + Security checkpoint.
- [ ] **M1b** types + engine/stages/effects/context/view/runtime/demo/api port; harness rewrite; apply the matrix; keep `src/linear/**` in tree but unreferenced by runtime; `npm run check` + `npm test` green at the expected counts; Reviewer + Security checkpoint.
- [ ] **M1c** `conductor migrate` (dry-run default; `--yes` applies): refuses while a Conductor instance is running (lock); backup (`config.json`, `state.json`, `runs/`) with sha256 manifest into `~/.conductor/backups/migrate-<ts>/`; builds the new state in a **staging dir**; swaps with renames (`runs`→`runs.v1-<ts>`); on any error nothing in place is modified. Importer semantics: terminal runs ⇒ read-only history items (`column: done|canceled`, `external` link kept, run.history imported as one "Imported history" comment); in-flight runs (e.g. **BAR-363, `needs_human`**) ⇒ live items (`needs_you`) with pending Linear effects dropped (documented); project per repo, key from the issue prefix (`BAR`), `nextSeq=max+1`; nothing is ever written to Linear (D7); Keychain `conductor-linear` entry is **not** deleted. Wizard + UI cut-over; docs. Then the one-time **rollback rehearsal**: restore backup into a temp home and open it with the tagged v1 code (`git archive v1.0.0-rc2`), record evidence.
- [ ] **M1d** delete Linear code/tests/fixtures/`graphql` devDependency; add `test/import-graph.test.ts` (no `src/**` import of `linear/`); docs scrubbed; Reviewer + Security checkpoint; checkpoint commit.

## 5. Testing Strategy

- **Board (unit):** CRUD + invariants (no cycle in `dependsOn`/`parentId`, key uniqueness across projects, `nextSeq` monotonic); journal replay equals live state (property test over random op sequences); torn last line; kill -9 mid-append (child process killed, reopened, state consistent); snapshot compaction crash-safety (temp file left behind is ignored); idempotency keys survive reload; redaction of Conductor-authored text; 1 MB comment bodies; 10 k items load time bound.
- **Schema:** each migration step; real-shaped v1 `config.json` fixture → v3 with unknown keys preserved; newer version refused with nothing written; corrupt JSON → backup + safe start; backup taken exactly once before first write; run.json v1 → v2 field moves exactly as the mapping lists.
- **Engine on board (fake CLIs, real git):** every migrated test per matrix; new: approve rejected outside `awaiting_approval`/old rev; restart-rate-limit; board change wakes the engine; column move to `backlog`/`todo`/`canceled` obeys the resume matrix; Conductor's own column writes do not retrigger (`expected.column`); idempotent comment/child on crash-replay.
- **Importer:** dry-run writes nothing; apply on a copy of the real BAR-363 shape; staged failure injected at each step leaves originals byte-identical; refuses while locked; rollback restores byte-identical files (sha256 manifest).
- **API/server:** new routes: no cookie 401, wrong CSRF 403, cross-site 403, oversize 413, malformed `%` 400, `//` 400, over-long title/body rejected, unknown key 404; wizard steps.
- **Security regression:** all v1 safety tests (matrix) unchanged; H3 on board child titles; redaction of board comments from env-file secrets.
- **Static:** `npm run check`; import-graph test; `grep` for `Linear|linear` in `src/`, `ui/`, `prompts/`, `docs/` returns only `legacy.linear` handling and the importer.
- **Live (opt-in, M1b exit):** re-run `cursor-e2e`, `cursor-nopush`, `cursor-question` against a throw-away home.
- **UI:** scripted Browser-pane run of the wizard and board (desktop + mobile) with screenshots to `.techteam/runs/evidence/`, console clean.

## 6. Risks and Dependencies

- **Big-bang inside M1b** (types change everywhere). Mitigation: harness rewritten first; matrix is the checklist; v1 tag + backup + isolated clone; M1a lands independently.
- **Losing a v1 safety property when retiring tests.** Mitigation: matrix lists survivors with identical assertions; Reviewer checks the diff of retired test names against the matrix.
- **Journal correctness** (the new persistence layer). Mitigation: property test + kill -9 test; snapshot is atomic; single-writer (lock) assumed — a second process opening the board refuses (reuses `lock.ts`).
- **User's live data**: only `conductor migrate --yes` touches it, only when the user runs it, after dry-run, with backup and rollback rehearsal evidence. Until then the live instance keeps running v1 untouched.
- **Run-store ↔ board consistency** (two files). Mitigation: board is the human-facing ledger, run store is execution state; every cross-write uses idempotency keys so replay after a crash converges; a startup reconcile heals drift (item without run in `in_progress` → re-queue; run without item → mark orphan, keep files).
- **Assumptions:** single local user; JSON + journal is enough (SQLite decision recorded in master); keys `PROJECT-n`; dashboard is the only writer besides Conductor.
- **Not in M1:** hierarchy execution, dependencies *execution* (fields exist, executed in M3), provider roles (M2), context (M4).

## 7. Requirement Coverage Matrix (M1 slice)

| Requirement | Planned change | Verification | Status |
| --- | --- | --- | --- |
| V3 remove Linear as backend dependency | M1b–M1d | AC1 import-graph test, E2E on fresh home | Covered after M1d |
| V3 internal system owns tasks, workflow state, dependencies (fields), execution history, projects, decisions | M1a board model | board unit tests | Covered (dependency *execution* = M3) |
| V3 board native; users manage via board; engine updates progress automatically | M1b `setColumn` by engine; M1c UI | engine tests + UI evidence | Covered |
| V9 persistent local data, recoverable state | M1a journal | kill -9 tests | Covered |
| V9 versioned configuration and data migrations | M1a schema framework | AC2 tests | Covered |
| V9 safe handling of interrupted/failed operations | existing recovery + idempotency | crash tests | Covered |
| (user data) existing runs preserved | M1c importer + rollback | importer tests + rehearsal evidence | Covered |
