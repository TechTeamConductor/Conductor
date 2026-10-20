# M1a security review — native board store, versioning framework, v2 home

- Reviewed: commit `15687f9` in `/Volumes/Sandisk/github/techteam-conductor-v2` (`src/board/{types,journal,store,index}.ts`, `src/schema/{errors,backup,version}.ts`, the stamps in `src/store.ts` and `src/config.ts`, `src/paths.ts`, the `worktree.ts` guard line, `test/board`, `test/schema`), plus the pre-existing `src/lock.ts`, `src/util.ts` (`atomicWriteFile`) and `src/redact.ts` that M1a now depends on.
- Method: read every line, then tried to break it. Every claim marked "reproduced" was run against a pristine `git archive 15687f9` export (the clone's working tree is ahead with uncommitted M1b work and fixes in progress, so it was not the subject of this review). All scripts used throw-away `CONDUCTOR_HOME` / `CONDUCTOR_BACKUP_DIR` / `HOME` temp dirs; no real CLI was run, `~/.conductor` and `~/.conductor-v2` were not touched, no process was killed except the test suite's own `kill -9` children. Scripts: `/private/tmp/claude-501/-Volumes-Sandisk-github-techteam-conductor/7b88419e-600f-4142-ac15-d9bbfc9a540e/scratchpad/sec/clean/*.ts` (E1 framing, E2 newer-op tail, E3 compaction, E5 pollution, E6 backups, E7/E8 quarantine, E10 tampered entities, E11 UTF-8 drift, E13 garbled tail, VER version bypass, DOS, lock race, partial write with `ulimit -f`).
- Baseline: `node --test test/board test/schema` on the pristine export under a fake `HOME`: 32/32 pass (matches the commit message).
- Threat model used: same-user local process; hostile repo/agent output reaching board text; a request body reaching the board through `board.user`; corrupt/malicious data files; symlink/TOCTOU on the board and backup dirs; crash/ENOSPC; DoS. A same-user attacker who can write the board files can do anything (see N1) — findings below are rated on what they add beyond that, or on what a non-malicious fault does.
- The Reviewer's separate M1a code review (`workspace-v2-m1a-code-review.md`, B1-B3, N1-N10) overlaps findings S-1, S-3 (partly), S-4 (partly) and S-8. Where I reproduced the same defect I say so; the other findings here are new.

## Summary

No Critical finding. Two High, two Medium findings are blocking for closing M1a (they are small and local). The rest are binding conditions on M1b/M1c, none of which can be exercised yet because the board is not wired in.

| ID | Severity | Area | One line | Gate |
| --- | --- | --- | --- | --- |
| S-1 | High | journal | A failed/short append leaves a partial line; the next acknowledged write is silently dropped or the board refuses to open. Compaction errors fail already-durable writes. | **Blocks M1a** |
| S-2 | High | version | A journal op written by a NEWER build at the file tail is treated as a "torn line" and deleted by an older build; "newer refused" is bypassed. | **Blocks M1a** |
| S-3 | Medium | lock | The pid-lock is not mutual exclusion: stale takeover and the create/write window let two writers hold it. | **Blocks M1a** |
| S-4 | Medium | schema/store | I/O errors are classified as corruption; `run.json` is renamed away on read, which re-opens the key for re-claim over stale artifacts. A regression versus v1. | **Blocks M1a** |
| S-5 | Medium | board | Entities are loaded from disk with no validation (keys, lanes, URLs, types). | before M1b |
| S-6 | Medium | board | No item/comment/byte quotas; inline compaction; snapshot can exceed the V8 string limit and brick writes and reload. | before M1b |
| S-7 | Medium | backup | Label traversal, basename collisions, symlink following, unverified copy, `saveConfig` fails open, no secrets exclusion/retention story. | before M1c (first real-data backup) |
| S-8 | Low-Med | journal | A complete-but-garbled final line is deleted with no copy kept; invalid UTF-8 shifts truncation offsets. | before M1b |
| S-9 | Low-Med | version | Save paths do not re-check the on-disk version; non-numeric stamps are accepted as v1. | before M1b |
| S-10 | Low | config | `config.extra` keeps own `__proto__`/`constructor` keys: safe now, a pollution foot-gun for the first consumer (M2 compatibility layer). | before M2 |
| S-11 | Medium | redaction | The board's default redactor is token-shape only (no exact-value secrets); `import` actor and `stage`/`repo` fields are not redacted. | M1b wiring condition |
| S-12 | Low | perms | Existing files with loose modes are not tightened; no `O_NOFOLLOW`/`wx` on temp files; no ownership check. | M1b |
| N1-N6 | Info | various | Same-user integrity, macOS fsync, read-only view consistency, misleading error text, resource note, redaction policy verdict. | notes |

## Verified safe (tried, did not break)

- Journal framing (E1). Titles, descriptions and comment bodies containing `\n`, `\r\n`, NUL, U+2028/2029, a lone surrogate, a string that closes the JSON object and starts a forged op line, and a string containing a newline plus a v2 op: 22 operations produced exactly 22 journal lines, all parse, reload shows no forged entity. `JSON.stringify` escapes every framing byte; `\n` is the only separator. Titles are additionally passed through `clean()`.
- Prototype pollution. `normalizeConfig(JSON.parse('{"extra":{"__proto__":…},"__proto__":…,"constructor":{"prototype":…}}')` does not pollute `Object.prototype`; board entities live in `Map`s keyed by id/key, so `__proto__` ids are inert; `UserBoard` reads named properties only (never iterates a request body).
- Path traversal. Item keys are `PROJECT-n` from `[A-Z]{2,6}` or, for the importer, `ITEM_KEY_RE`; `../../x-1` and `OTH-1` are refused; backup file names derive from `basename()`/`relative()`; quarantine names are `<file>.corrupt-<ms>`. (Caveat for loaded data: S-5.)
- `UserBoard` (C4). Forged `author`, `createdBy`, `key`, `external`, `id`, `stage`, `kind:'bug'`, Conductor-owned lanes, non-object bodies: all refused or ignored (test + my E1 variants).
- Modes. Board dir 0700, `journal.ndjson`/`snapshot.json`/`board.lock` 0600, backup dir 0700 and `manifest.json` 0600, even under `umask 000` (E6e). Copied files keep the source mode inside a 0700 dir.
- Read-only open. Takes no lock, never truncates, refuses all mutations (tested; also re-checked in my run).
- Redaction ReDoS. Adversarial 400 KB inputs (`BEGIN PRIVATE KEY` x14k, `sk-` prefixes, `://user:pass`, JWT-ish, `AIza` near-misses): 3-4 ms each except the BEGIN-marker case at 494 ms (bounded; acceptable).
- Crash windows. The five `kill -9` tests hit their windows; ops with `seq <= snapshot.seq` are skipped on replay.

## Findings

### S-1 (High, blocks M1a) — a failed or short journal append poisons the journal; compaction failure fails durable writes
Location: `src/board/journal.ts:137-146` (`append`), `src/board/store.ts:216-226` (`commit`).
Evidence (reproduced):
- Real short write: running the board under `ulimit -f 16` (RLIMIT_FSIZE) gives `EFBIG` at op 11 and a journal of exactly 8192 bytes that does not end with a newline. The fd stays open and the writer keeps going.
- Consequence (partial line injected into the live fd to replay what the failure leaves, then acknowledged writes, then a crash): with one later acknowledged write the board reopens with `items: ['acked-1']` and `LOST acknowledged: ['acked-later-0']` (the glued line is the "torn final line" and is deleted); with three later writes the board refuses to open (`CorruptFileError: line 3 … followed by more data`).
- E3: `compactEvery: 3` plus an `ENOSPC` at snapshot time makes 4 of 4 `createItem` calls throw while all 5 items are durable and in memory. A caller that retries creates duplicates; every later write throws too.
- The Reviewer reproduced the same defects (B1, including write-after-`close()` without the lock and `seq` reuse after `write` ok / `fsync` threw).
Impact: silent loss of acknowledged data, or a board that will not start, after the one event a journal must survive (disk full / EIO).
Fix: record the size before each append; on any exception from `write`/`fsync` best-effort `ftruncate` back and mark the journal failed (all later appends throw until reopen); never reuse a `seq` after a possibly-persisted line; catch and surface compaction errors inside `commit` (like `close()` does) with a health flag; `closed` flag so a write after `close()` throws. Tests: injected mid-line write failure then normal writes; compaction failure must not fail the mutation.
Status in the uncommitted working tree: a rollback + `failed` flag is in progress. I re-ran the real `ulimit -f 16` experiment against it: after `EFBIG` the journal is cut back to a clean line boundary (8046 bytes, ends with newline) and the error is `storage_failed`; E3 no longer throws. Not part of the reviewed commit; verify on commit.

### S-2 (High, blocks M1a) — "newer version refused" is bypassed at the journal tail, and the newer data is destroyed
Location: `src/board/journal.ts:90-107`.
Evidence (reproduced, E2): a journal whose last line is `{"v":2,"seq":50,"ts":1,"t":"label","e":{…}}` (a new op kind from a newer build) opens without error on `15687f9`; the journal shrinks (667 -> 588 bytes) and the v2 line is gone. Same for a `v:2` op without a numeric `seq`. Cause: the structural check (`typeof seq === 'number' && OP_KINDS.has(t)`) runs before the `v > 1` check; a failing line that is also the last non-empty line is "torn" and `ftruncate`d. In the middle of the file the same line gives a `CorruptFileError` (refuses, wrong message, but safe).
Impact: a downgrade (older build started after a newer one ran) deletes the newest acknowledged operation(s) at the tail; the guarantee "newer ⇒ refuse, nothing written" is false for the journal.
Fix: after `JSON.parse` succeeds and yields an object, read `v` first; `v` present and `> 1` (or present and not a safe integer) ⇒ `NewerVersionError`, before any structural validation and before any truncation. Treat only an unparsable last line (JSON syntax error) as torn. Add the test: newer op with unknown `t` at the tail ⇒ refused, file byte-identical.

### S-3 (Medium, blocks M1a) — the single-writer lock is not mutual exclusion
Location: `src/lock.ts:44-76` (pre-existing v1 code, newly load-bearing: it guards the board journal, and still guards the instance lock at `cli.ts:101`).
Evidence (reproduced): N processes started at the same instant, each calling `acquireLock` and holding it 150 ms, then checking the file still names them. With a pre-existing stale lock (dead pid) and 3 contenders: 68 of 80 iterations ended with more than one simultaneous holder; with 2 contenders: 12 of 40. With no pre-existing lock and 5 contenders: 2 of 150 iterations. Two mechanisms: (a) stale takeover is read-then-`unlink`: B's `unlink` can delete A's freshly created lock; (b) `openSync(path,'wx')` creates an EMPTY file and the pid is written afterwards, so a contender that hits `EEXIST` in that window reads an unparsable lock, treats it as stale and unlinks the live one.
Impact: two writers on one board = interleaved/colliding `seq`, duplicate keys (both issue `APP-5`), lost updates, then a refused open. Realistic trigger: launchd restart plus a manual `conductor start` after a crash (the only time a stale lock exists).
Fix (any of): write the full lock content to a temp file then `link(tmp, lockPath)` (atomic, no empty window); serialise takeover with an `O_EXCL` `board.lock.takeover` marker (with mtime expiry) so only one process may unlink-and-create; after acquiring, re-read and verify the file still names this pid, and re-verify before the first append. Treat an unparsable lock as "not mine, not stale" for a short grace period. Add a contended-start test (several processes, stale lock, exactly one winner).

### S-4 (Medium, blocks M1a) — I/O errors are treated as corruption; quarantining `run.json` on read re-opens the key
Location: `src/schema/version.ts:41-46` (`loadVersioned`), `src/store.ts:94-111` (`readRunFile`), `src/config.ts:160-172`, `config.ts:251-262`.
Evidence (reproduced, E7/E8): `chmod 000 config.json` (EACCES, standing in for EMFILE/EIO/a permission race) makes `loadConfig()` return defaults (port 4317 instead of 5555) and rename the file to `config.json.corrupt-<ts>`; the same for `run.json`: `get()` returns `null`, the file is renamed, `has(key)` becomes false. Then `create()` for the same key succeeds (the directory exists, no `run.json`), and the old run's `plan.json` ("approved: true") is readable by the new run (`readArtifact`).
Why it matters: (1) the try block wraps `readFileSync` and `JSON.parse` together, so any read error is reported as "not valid JSON"; (2) v1's `readJsonFile` returned null without renaming and left `has()` true, so a bad `run.json` was never re-claimable: M1a changed that behaviour; (3) a re-claim re-plans/re-builds an issue whose branch/PR work may exist and inherits stale approval artifacts. (The Reviewer's N2 notes the read-time mutation and re-claimability.)
Fix: only a `SyntaxError` (or a non-object result) is corruption; any other error is rethrown as an I/O error (config: refuse to start; run: report "unreadable", keep the file in place). Do not rename on read; quarantine only in an explicit repair step. If a run record is quarantined, keep the key reserved (a tombstone) so `has()` stays true and `create()` refuses while stale artifacts exist.

### S-5 (Medium, before M1b) — entities loaded from disk are not validated
Location: `src/board/store.ts:130-137` (`loadSnapshot`), `:168-190` (`applyOp`).
Evidence (reproduced, E10): an edited snapshot with an item `key: "../../../etc/x"`, `createdBy: "conductor"`, `autoStart: true`, `external.url: "javascript:alert(1)"` is accepted and returned by `claimable()`; `projects: {}` gives a raw `TypeError: object is not iterable`; a journal op `{t:'item', e:null}` gives `TypeError` (the in-progress tree treats the last-line case as torn, which hides it).
Impact: today none (the board is not consumed). In M1b the run store joins `paths.run(key)` (guarded by its own KEY_RE) and the UI renders `external.url` and titles; a key/lane/URL from a tampered or newer-shaped file must not reach those sinks on trust.
Fix: `validateEntity()` at load and replay using the same constants (`ITEM_KEY_RE`, `LANES`, kinds, `https://linear.app/` for `external.url`, arrays are arrays, numbers finite); reject with `CorruptFileError` naming the file/seq. Engine-side: `project.repo` is a registered repo NAME looked up in `cfg.repos` at claim time, never a path; validate `repo` on write (Reviewer N5) and again at claim time.

### S-6 (Medium, before M1b) — no quotas; compaction is inline and unbounded
Location: `src/board/store.ts` (no counts), `journal.ts:149-179` (`compact`), `store.ts:160-165` (`indexComment`).
Evidence (measured): 1500 items x 50 KB descriptions = 75 MB snapshot, RSS 435 MB, the compaction runs inside the triggering write (one op took 282 ms). 10 000 such items would be ~500 MB: `JSON.stringify` of the snapshot approaches V8's ~512 MB string limit; once it fails, every write fails (S-1 item 3 without the fix), the journal grows without bound, and `readFileSync(...).toString()` of a journal that large cannot load. Comment replay uses `list.some()` per comment: 30 000 comments on one item reload in 1.7 s (quadratic: ~19 s at 100 000). Writes cost ~3-4 ms (fsync): 10 000 comments took 30 s.
Impact: self-inflicted or request-flood (each request <= 1 MB, session-authenticated) can brick the board. User-text limits exist per field but not in aggregate.
Fix: caps (items per project, comments per item, total snapshot bytes; reject with a clear error); stream/chunk the snapshot or fail compaction gracefully with a visible health state; make comment dedupe a Set. Also: compaction runs on the event loop — fine at normal sizes, state the ceiling.

### S-7 (Medium, before M1c) — backup framework hazards
Location: `src/schema/backup.ts`, `src/config.ts:175-185`, `src/schema/version.ts:59-68`.
Evidence (reproduced, E6):
- (a) `label` is concatenated into a path: `label: 'x/../../../../<tmp>/ESCAPED'` creates the backup directory outside the root. Not attacker-reachable today (labels are constants or derived from `spec.kind`) but `backupPaths` is a public function.
- (b) Two file sources with the same basename collide silently (`runs/A/run.json`, `runs/B/run.json` -> one file, content of B, manifest lists `run.json` twice).
- (c) `listFiles`/`statSync` follow symlinks: a symlinked directory inside a source is copied with its target contents (`runs/X-1/link/id_rsa` appeared in the backup); a self-loop gives `ELOOP` (fail-closed).
- (d) The manifest hash is computed by re-reading the SOURCE after the copy; the copy is never verified, and a source that changes mid-copy yields a manifest that does not describe the backup.
- (e) `saveConfig` fails open: if the backup throws (ENOTDIR in my run), it logs a warning and overwrites the config anyway; `backupBeforeNextSave` is already cleared, so the original v1 file is never preserved. (`saveVersioned` correctly throws before writing.)
- (f) A pre-existing backup root with mode 0755 stays 0755 (the per-backup dir is 0700, so contents stay private today).
Impact: the backup is the rollback story for AC2 and for the M1c import of the user's REAL v1 data; it must not be the weakest link. Backups contain run descriptions, plans, repo paths; they live outside every home and survive `uninstall --purge`, so they need an explicit retention/purge path and must not include `secrets.json`, `run/sessions.json` (dashboard session tokens), `run/control.sock`, `logs/`.
Fix: validate `label` against `^[A-Za-z0-9._-]{1,64}$`; derive manifest names from the relative path (reject collisions); `lstat`, never follow symlinks (skip and record them); hash the copy (read back) and compare to the source hash taken from the same bytes; create the backup directory with a non-recursive `mkdir` loop on `EEXIST`; enforce 0700 on the root (chmod when owned by us, refuse otherwise); in `saveConfig` abort the upgrade write when the backup fails; give `backupPaths` an explicit exclude list used by the M1c importer; document `conductor backups prune`.

### S-8 (Low-Medium, before M1b) — journal tail handling destroys bytes without a copy; offsets use decoded strings
Location: `src/board/journal.ts:72-127`.
Evidence (reproduced): E13 — a newline-terminated but unparsable final line (a damaged sector with the newline intact; a torn write cannot contain the newline) is treated as torn: the acknowledged item is gone (items 1 -> 0), the file shrinks (586 -> 172) and no copy of the removed bytes exists. E11 — one invalid UTF-8 byte in an earlier line (bit rot) makes `Buffer.byteLength(decodedLine)` 2 bytes too long; a later torn tail is cut 2 bytes too late (`{"` survives) and the next acknowledged op is written glued to it (`{"{"v":1,…`), i.e. S-1's failure again.
Fix: split and count on the raw `Buffer` (index of `0x0a`), not on the decoded string; before truncating, write the cut bytes to `journal.ndjson.torn-<ts>` (0600) and log once; for a newline-terminated unparsable final line (not a plausible tear) prefer refusing with repair instructions, or truncate only after the copy exists. Expose `recoveredTornBytes` in health (it is only a property today).

### S-9 (Low-Medium, before M1b) — version checks happen at load only; stamps are not strict
Location: `src/schema/version.ts:47`, `src/config.ts:175-190`, `src/config.ts:264-267`, `src/store.ts:94-111`.
Evidence (reproduced, VER-a..d): a `config.json` written by a newer build AFTER this process started is overwritten by `saveConfig` (version 3 -> 2, the future key dropped); same for `state.json` (`schemaVersion: 4` -> 1); `schemaVersion: "2"` (string) is accepted as v1 and the next compaction drops an unknown newer collection; `version: "3"` in config is normalised as v1. `RunStore.update` works from its cache and never re-reads the stamp.
Impact: a long-running older instance downgrades newer data; low probability (two builds alternating) but it is exactly what the stamp is for.
Fix: `saveConfig`/`saveState`/`RunStore.update` re-read the stamp (cheap `readFileSync`) and throw `NewerVersionError` before writing; a present-but-not-safe-integer stamp is corruption (not "missing").

### S-10 (Low, before M2) — `config.extra` is a pollution foot-gun
Location: `src/config.ts:131-135`.
Evidence (reproduced, E5): `extra` keeps own `__proto__` and `constructor` entries (the `__proto__` filter applies only to the top-level loop, not to `i.extra`). Nothing consumes `extra` yet, but `Object.assign(target, cfg.extra)` and `for (const [k,v] of Object.entries(extra)) target[k] = v` both replace `target`'s prototype (verified). The M2 compatibility layer and the v3->v4 migration are the first consumers.
Fix: build `extra` with `Object.create(null)`, skip `__proto__`/`constructor`/`prototype` at every depth (a `JSON.parse` reviver), and never merge `extra` into live objects; migrations read named keys only.

### S-11 (Medium, M1b wiring condition) — redaction coverage
- Conductor text is redacted by `text()` for `actor === 'conductor'` (title, description, comment, decision body, milestone fields), redact-then-truncate (good). Tested.
- The default redactor is `redact(s)` with NO `secrets` argument: token shapes only. The engine redacts agent output with exact-match values from the repo's `.env` files (`engine.ts:128-135`, `secretsFor`), which are not token-shaped. Unless the board is opened with `redact: (s) => redact(s, engine.secretsFor(...))`, a hostile agent's output that echoes a `.env` value into a plan/bug/comment reaches the journal unredacted. Condition: M1b constructs the Board with the secret-aware redactor and a test proves a non-token-shaped `.env` value is masked in a board comment written via the engine.
- `import` actor text (Linear titles/descriptions/comments written by other people) is not redacted and not rejected when too long (only truncated). Recommend the same redaction as `conductor`.
- `stage`, `repo`, `idemKey`, `external` are stored unfiltered (S-5/N5).
- Verdict on "user text is not redacted": acceptable. It is the user's own input, stored 0600; rewriting it would corrupt intent. Conditions: (a) every EGRESS of board text (prompts to providers, notifications, logs, API/UI, diagnostics export) redacts at the sink, not at storage; (b) the UI states that text typed into a task is sent to the assigned provider; (c) user text inside prompts is fenced as untrusted data (already the plan's rule).

### S-12 (Low) — filesystem hardening
- `Journal` opens `journal.ndjson`/`board.lock` with `'a'`/`'wx'` and creates modes only at creation; existing files with loose modes (restored backup, `cp`) are not tightened. Add `fchmod(0o600)` and an `fstat` owner/mode check on open.
- No `O_NOFOLLOW`: if `journal.ndjson` is replaced by a symlink while Conductor is stopped, appends go to the link target. Snapshot temp files open with `'w'` (follows a planted link; name is pid + 32 random bits). Use `O_NOFOLLOW` and `'wx'`. Same-user only; defence in depth.
- Stale `snapshot.json.*.tmp` are never cleaned (the in-progress tree adds cleanup).
- `atomicWriteFile` (config/state/run.json) does not fsync; a power cut can leave a zero-length file, which S-4's quarantine then renames. The plan already scopes durability to the board.

## Notes (not rated)

- N1. No integrity or authenticity on the board files. Any same-user process (including a `--force` Cursor builder with shell access) can append ops: forge `author:'conductor'` comments, create `autoStart` items with hostile descriptions, move lanes. This matches v1 (a builder can edit `run.json`, `config.json` gate commands). Consequence for design: approvals and anything gating a build must come from the run store / engine state, never from reading board comments or lanes alone (the M1 plan's K2 already points this way). An HMAC would not help against the same user.
- N2. macOS: `fsync(2)` does not flush the drive cache (`F_FULLFSYNC` is not reachable from Node). "Survives power loss" is true for process crash and OS crash, not guaranteed for sudden power loss on macOS; docs should say so.
- N3. Read-only open can see an old snapshot with a post-compaction empty journal (a stale view) while a writer compacts. Fine for display; do not use a read-only view to make decisions or to back up.
- N4. `CorruptFileError`'s text says "A backup copy of the file has been kept next to it" / "nothing was changed"; for board files no copy exists (reproduced). It gives false assurance (Reviewer N4).
- N5. A lock file naming a live pid that is not Conductor (`pid: 1`) makes the board refuse to open until the file is removed (DoS by the same user only). `LockHeldError` text says "Conductor is already running" for the board lock (Reviewer N7).
- N6. The v1->v2 defaults upgrade in `normalizeConfig` (`planApproval 'first' -> 'auto'`, `onClaudeLimit 'wait' -> 'cursor'`) rewrites an explicit hardening choice made by a v1 user (it cannot tell a choice from a default) and the rewrite happens on the next save. Pre-existing product decision; surface it once in the UI.

## Required before M1a is closed (blocking)

1. S-1: journal append atomicity (rollback + failed state), compaction errors must not fail a durable write, write-after-close refused, tests for each (Reviewer B1; the in-progress tree is on the right track and was verified against a real `EFBIG`, but is uncommitted).
2. S-2: version check before structural validation and before any truncation; newer-version ops at the tail are refused, file untouched, with a test.
3. S-3: lock acquire/takeover made race-free (or detect-and-abort), with a contended-start test; the same fix covers `cli.ts:101`.
4. S-4: only syntax errors are corruption; I/O errors surface; no quarantine on read; a quarantined run keeps its key reserved. Tests: unreadable `config.json`/`run.json` (chmod 000) must not be renamed or reset.

## Binding conditions for later milestones (not blocking M1a)

5. Before M1b's first edit: S-5 entity validation on load, S-6 quotas and graceful compaction failure, S-8 torn-tail preservation and Buffer-based offsets, S-9 re-check stamps at write time and strict stamps, S-12 hardening, and S-11 (Board constructed with the engine's secret-aware redactor, `import` actor redacted, egress-redaction rule restated in the M1b TODO).
6. Before M1c's first real-data backup: all of S-7, plus an explicit exclude list (`secrets.json`, `run/`, `logs/`), a retention/prune command, and a test that the importer's backup of a home with symlinks and duplicate basenames is complete and verified by hash of the copy.
7. Before M2's first edit: S-10 (`extra` sanitised; consumers read named keys only).
8. M1b: approvals and gating decisions never derive from board comments/lanes alone (N1); `project.repo` resolves through `cfg.repos` by exact name at claim time; the HTTP layer receives `board.user` (not `Board`).

Decision (M1a security): Changes requested
