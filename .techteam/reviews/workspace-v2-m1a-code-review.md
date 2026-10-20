# M1a code review — native board store, versioning framework, v2 home

- Reviewed commit: `15687f9` in `/Volumes/Sandisk/github/techteam-conductor-v2` (exported to a clean directory with `git archive`; the clone's working tree is already ahead with uncommitted M1b work and does not typecheck, so it was not used).
- Reviewed by: Reviewer (independent; read every line of `src/board/*`, `src/schema/*`, the stamp changes in `src/{store,config,paths,types}.ts`, the `worktree.ts` guard, all M1a tests and fixtures). Security checkpoint is a separate gate and is not given here.
- Conditions checked: C1–C5 and adjustments 1–5 from rounds 2–3 (`workspace-v2-plan-review.md`).
- Method: besides reading, I ran the suite and wrote about 40 adversarial probes against the committed code (scratch scripts outside the repo): torn/garbled/NUL-padded/multi-byte journal tails, CRLF, a failed-append aftermath, use after close, compaction failure, returned-object mutation, 25 hostile inputs against `UserBoard`, real `kill -9` at each compaction window, and a full-suite run under a fake `HOME` to catch stray writes.

## Verified claims
- **`npm run check` clean, `npm test`: 515 tests, 511 pass, 4 skipped** — matches the claim (483 + 32 new). Run at `15687f9` with `HOME` pointed at an empty directory: no `~/.conductor-backups` was created, so no test writes to the real backup root. (The suite does create empty `~/.conductor-v2/{logs,run,runs}` when `HOME` is real; a pre-existing habit, see N8.)
- The five kill tests really hit their windows: replicating them, every cycle-1 **and** cycle-2 child ends with `signal === SIGKILL`.
- `compact:after-snapshot-rename` followed by replay of ops `<= snapshot.seq` is correct. I added a case the tests do not have: kill at that window, reopen as writer, append 3 more ops, `kill -9` again, reopen: 5 items, unique keys `CRA-1..5`, the stale journal prefix is skipped on every load and removed by the next compaction.
- Idempotency index after replay, `nextSeq` re-derivation, corrupt-last-ignored / corrupt-middle-refused, read-only open (no lock, no truncation, no write), same-pid second writer refused (`LockHeldError`), a failed open releases the lock, double `close()` is harmless, files 0600 / dir 0700, fsync of every append and of snapshot + directory, version on every journal line and in the snapshot header — all behave as specified.
- Torn-tail byte accounting: exact for a tail cut inside a multi-byte character (é, 😀), for non-ASCII earlier lines, for a NUL-padded tail, for a journal that is only a torn line, and for a complete final line that lost its newline (restored). CRLF-only files load.

## Conditions
| Item | Result |
| --- | --- |
| C1 inert (stamps only, config stays 2, newer refused, unknown keys kept) | **Met.** `schemaVersion: 1` on `run.json`/`state.json`, missing = 1; `config.json` stays `version: 2`, top-level unknown keys round-trip via `extra`; no shape-changing migration registered; `__proto__` is not carried. |
| C2 single-line create + `nextSeq`, re-derivation, torn/corrupt policy, fsync scope, modes | **Met** for the specified behaviours (see B1 for the error path). fsync claim is correctly scoped to the board in `docs/ARCHITECTURE.md`. |
| C3 read-only open | **Met** for the board. `RunStore` has no read-only mode (N2). |
| C4 `UserBoard` | **Met**: forged `author/createdBy/key/external/id/stage`, `kind:'bug'`, Conductor-owned lanes, `__proto__`/`constructor` bodies, array/object-typed fields, 10 000 dependencies, empty titles — none gets through, and `Object.prototype` is not polluted. Gaps in N5. |
| C5 `Milestone` | **Met** (create, status, list, `milestoneId` on items, replay). |
| Adj 1 backup root + `CONDUCTOR_BACKUP_DIR` | **Met**; schema tests set it per test. |
| Adj 2 stamps / missing = 1 | **Met.** |
| Adj 3 wrapper in M1a | **Met.** |
| Adj 4 `~/.conductor-v2` in the worktree guard | **Met** (`worktree.ts:135`). |
| Adj 5 versions on journal + snapshot | **Met** (`v:1` per line, `schemaVersion` header, newer refused with nothing written). |

## Blocking findings

### B1. The write path can lose acknowledged writes and leaves the board in an inconsistent state after an I/O error
`Journal.append` (`journal.ts:137-146`) writes in a loop and `fsync`s, but on any exception it neither rolls the file back nor stops further appends; `Board.commit` (`store.ts:216-226`) rethrows and keeps running.
1. **Poisoned journal.** If a `write` fails after part of the line is on disk (ENOSPC/EIO mid-line — exactly what the failure leaves behind), the next *successful* append lands on the same physical line. Reproduced by appending a partial line to a live writer's journal and then doing normal writes: the combined line is unparsable, so on the next open it is the "torn final line" and **the later, acknowledged write is silently dropped** (`items: ['one']`, the acknowledged `'two'` is gone, `tornBytes=481`); with one more write after it the board **refuses to start** ("line 3 is unreadable and is followed by more data").
2. **Error but durable / seq reuse.** If `write` succeeded and `fsync` threw, the op is in the file but memory was not updated and `seq` was not advanced, so the next op reuses that `seq` and replay applies both. The caller sees a failure for an operation that will reappear after restart.
3. **Compaction failure after a successful commit.** `commit` calls `this.compact()` last (`store.ts:224`); if it throws (ENOSPC on the snapshot temp file), the mutation throws although the op is durable *and* applied in memory (reproduced: `createItem` threw, `items().length === 1`) — a caller that retries creates a duplicate. `close()` already swallows this error; `commit` must too (journal still has everything).
4. **Writes after `close()` succeed without the lock** (`openJournal` reopens the fd lazily; reproduced: no `board.lock`, write accepted).

Required: record the file size before each append; on any error from `write`/`fsync` best-effort `ftruncate` back to it **and** mark the journal *failed* so every later write throws until the board is reopened (reopen performs the existing torn-tail recovery); never reuse a `seq` after a possibly-persisted line; catch and report (health flag) compaction errors inside `commit`; add a `closed` flag that makes every mutation throw. Tests: an injected write failure mid-line (a seam in `Journal`, e.g. a write function option) followed by a normal write must neither lose an acknowledged op nor make the journal unopenable; compaction failure must not fail the mutation; mutation after close throws.

### B2. Returned objects alias board state
`createItem` returns `{ ...item }` (`store.ts:432`), sharing the stored item's `dependsOn` array and `external` object; `item()`/`items()` (`store.ts:435-445`) copy `dependsOn` but still share `external`. Reproduced: `created.dependsOn.push('x')` and `board.item('APP-50').external.url = 'javascript:…'` change in-memory state with no journal line, and the next compaction **persists the mutation** (memory and disk diverge silently). The engine (M1b) will be the first heavy consumer. Required: one `cloneItem()` (deep copy via `structuredClone`) used by every return path, plus a test that mutating any returned entity changes nothing (also for projects/milestones/decisions/comments, which are flat today but should be covered).

### B3. A symlink `node_modules` is tracked in the repository
`git ls-tree 15687f9 node_modules` → mode `120000` → `../techteam-conductor/node_modules`. `.gitignore` has `node_modules/` (directories only), which does not match a symlink. When the clone is landed into the original repo (master M-9, where `node_modules` is a real directory) this either conflicts or replaces it. Required: `git rm --cached node_modules` and ignore `node_modules` (no trailing slash) before M1a is closed.

(B1–B3 are small; once fixed and covered by the tests above I will verify by diff and by running the new tests — no second full review.)

## Non-blocking (fix in M1a if cheap, otherwise before the named milestone)
- **N1 Tests.** `assertConsistent` only checks `items.length >= ceil((acked-1)/2)`; it would pass if a *different* acknowledged item were lost, and it never checks comments. Assert the exact prefix (`item 0..m`, `m >=` acked items) and that every acknowledged comment exists; assert the second cycle `killed`; add my extra cases (kill after snapshot-rename → more appends → kill → reopen; multi-byte tail; missing newline; NUL tail; whitespace line) and the hostile `UserBoard` inputs I tried.
- **N2 `RunStore.readRunFile` mutates on read** (`store.ts:95-110`): a corrupt `run.json` is renamed to `*.corrupt-<ts>` by `get()`/`list()`, so a read-only consumer (`doctor` against the live app, the M1c importer reading the v1 home) would modify the directory it must not write; and `has(key)` then becomes false, so the run is silently re-claimable. Give `RunStore` a read-only mode / move quarantine to an explicit repair step. **Condition on M1c:** the importer must not use the quarantining reader.
- **N3 Journal robustness.** Offsets are computed from string lengths (`journal.ts:84`) — exact for valid UTF-8 (tested) but wrong if an earlier line holds invalid bytes; compute on the `Buffer`. A whitespace-only middle line (e.g. a lone `\r`) is treated as corruption. A same-version op with a bad `e` (e.g. `e: null`) escapes as a raw `TypeError`, not `CorruptFileError`; validate `op.e`. Stale `snapshot.json.*.tmp` files are never cleaned. Fsync the board directory after creating `journal.ndjson` (file fsync alone does not persist the directory entry).
- **N4 Misleading error text.** `CorruptFileError` always says "A backup copy of the file has been kept next to it"; for board files no copy is made (and the same message says "nothing was changed").
- **N5 `UserBoard`.** Wrongly-typed optional fields are silently dropped rather than rejected (`parentId: {}`, `dependsOn: 'abc'`, `autoStart: 'true'`); `createProject` accepts any `repo` string (`'../../etc'`, unbounded length) — validate with the repo-name pattern; `UserBoard.b` is a TS-private field reachable at runtime (use `#b`); pass `UserBoard`, not `Board`, into HTTP dependencies.
- **N6 `claimable()`** includes `ask`/`research` (K4: `work` only until M5).
- **N7 Lock.** A same-pid second open is correctly refused, but a *recycled* pid cannot be told apart from an in-process double open (containers, Windows): a stale `board.lock` whose pid equals the current pid refuses forever. Track held lock paths in-process and treat `held.pid === process.pid && !heldHere` as stale. The error text ("Conductor is already running") is wrong for the board lock.
- **N8 Stray writes.** The suite creates empty `~/.conductor-v2/{logs,run,runs}` (the empty `~/.conductor-v2` that already exists, dated 14:09, is probably from that — I did not trace it); set `CONDUCTOR_HOME` in a test preload so no test depends on the real home.
- **N9** User-facing strings still say `~/.conductor` (`doctor.ts:82,102`, `cli.ts:37`) — cosmetic, M1b.
- **N10** Fixture `runs/ENG-7/run.json` uses `needsHuman.since`; the real field is `at`.

## Decision
All of C1–C5 and adjustments 1–5 are implemented as specified, and the stated suite result is correct. Three small defects remain (B1 data-loss path on I/O errors, B2 aliasing, B3 tracked symlink).

Decision (M1a): Changes requested — blocking items B1, B2, B3; no full re-review needed (diff + the new tests will be checked). M1b may keep proceeding in the meantime but M1a is not closed until they land.
