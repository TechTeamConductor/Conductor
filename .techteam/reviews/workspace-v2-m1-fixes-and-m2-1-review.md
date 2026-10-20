# Review: M1c/M1d fixes (492141b) and M2 plan rev 3 + commits 1a/1b (7bf6cce, 17f18ac)

- Reviewer: independent. Security review is a separate gate (`workspace-v2-m1c-d-security-review.md` and the M2 design sign-off).
- Method: each commit exported with `git archive` to a clean directory (the clone's working tree has moved on: a later commit `3afd0aa` and uncommitted M2-2 work; none of it was reviewed). `npm run check` and `npm test` under a fake `HOME`; mutation tests on the envelope; the real `conductor migrate` CLI on hostile v1 data; the dashboard driven in the Browser pane against a scratch demo that I seeded with orphan cards, a tombstoned run and an idle card. Scratch demo stopped, viewport reset, nothing written outside the scratchpad.
- Not verified by me: the live Cursor suites after the extraction (the coordinator runs those; plan AC (c)), Windows/Linux, any real Codex binary (none exists on this machine).

## Facts
- `492141b`: `npm run check` clean; **487 tests, 483 pass, 4 opt-in skips** (= 474 + the 13 in `migrate-hardening`). Fake `HOME` stayed empty.
- `17f18ac`: **474 tests, 470 pass, 4 skipped**. `7bf6cce` (the pre-extraction code): `test/envelope.test.ts` = 13 cases, 12 pass, E13 fails as the documented `todo`.
- Test changes between 1edccfa and 492141b: only new tests, `schema.test.ts` (stronger: asserts the C-10 refusal first, then the real default), and a two-line seam rename in the live `cursor-nopush` test. Nothing weakened.

## Part A — M1c/M1d blocking items 1–5 (492141b, `test/migrate-hardening.test.ts`, 13 cases)

| # | My finding | Status | Evidence |
| --- | --- | --- | --- |
| 1 | importer built paths from `run.json` content | **Closed** | `listRunsDir` keeps only plain directories whose NAME matches `KEY_RE`; `coerceV1Run` skips any record whose `key` differs from the directory; every later path uses the directory name. Real CLI on my hostile data (`key: "../../../nonexistent-dir"`, a record naming another card, a truncated record): all skipped with a warning each, no raw error, nothing read outside v1 |
| 2 | K7(i) hole, silent skips | **Closed in code** (test is weak, see A-2) | `readText()` reads each file once, hashes those bytes, and the parse uses the same string; `runs/` is re-listed before publish (`changedDuringImport` names it); every skipped folder and artifact is in `report.warnings` and printed by the CLI (6 distinct warnings in my run) |
| 3 | idle cards rebuilt every state event | **Closed** | `idleEl()` caches by `key\|lane`, updates title/note in place, removes vanished entries. Browser pane, 14 s on a live demo: same 4 `.idle-card` elements, the focused *Park* button still in the DOM and still focused (before: 8 replacements in 15 s) |
| 4 | orphan/ignored cards invisible | **Closed** | run-less cards in `active/needs_you/review` render in Planning / Needs you / Plan ready with the engine's reason and Run it / Park / Cancel; ignored runs without a card (tombstone) get an error banner. Seen in the Browser pane: banner "One card is being ignored — DEMO-77: This run's record was unreadable…", DEMO-92 (active orphan) in Planning, DEMO-90 in Needs you, DEMO-93 idle in To do. Text goes through `h()`/`textContent`; no HTML sink in `ui/app.js` |
| 5 | docs vs behaviour for `untrusted` | **Closed** | every imported run: `untrusted: true`, `planApproved: false`, `approvedBy` dropped, `needsHuman.origin: 'plan'` (a Retry re-plans: `engine.ts` takes the `rev += 1; next = 'plan'` branch, and `stages.ts:517` forces approval for `untrusted`). My rehearsal on the copy of the real BAR-363 data shows exactly that. README and ARCHITECTURE now say it |

Non-blocking items:
- **Approve rev** — fixed. `runRev` prefers the open drawer's `detail.rev` for the same key (detail is cleared when the drawer closes, so no stale rev is used from a card).
- **ui.port** — fixed (`4317 → 4327`, test).
- **package.json description** — fixed.
- **Staging sweep** — fixed, with a look-alike-folder safety test.
- **fsync** — partly fixed (A-3).
- **Screenshot** — A-4.
- Also verified, since the commit carried Security's C-1…C-10: overlap check by real path (symlink case tested), skeleton rename-aside with rollback (tests race three ways), regular-file/size caps, `willRun` printed in the dry run, 0600 artifacts, key-number cap, unknown status parked, backup allow-list, `conductorHome()` refusing the real home inside a test run, `assertOwnedWorktree` refusing a symlink or detached HEAD. Mine only confirms they exist and pass; Security owns the judgment.

Residuals (all non-blocking):
- **A-1 (minor)** — one unreadable artifact aborts the whole import with a raw error. Repro: `chmod 000 runs/BAR-404/plan-1.json`, then `migrate` prints `conductor: EACCES: permission denied, open '<path>'` and stops. It fails closed (nothing written), but the "skip with a warning" promise holds for symlinks/FIFOs/oversize/bad JSON and not for permission errors; `readFileSync` for an artifact sits outside the `try`. Wrap it and warn.
- **A-2 (minor, test quality)** — the K7(i) test hooks `read`, i.e. after the whole read phase, so it passes against the OLD importer too (I ran the new test against `1edccfa`'s `migrate.ts`: passes). The code is right; the test does not prove it. Add a hook between parse and hash, or unit-test the reader.
- **A-3 (minor)** — only the copied artifacts are fsynced. `config.json`, `state.json` and every `run.json` go through `atomicWriteFile` (write + rename, no fsync) and no directory is fsynced before or after the publish rename; after a power loss the new home can hold zero-length files. v1 and the backup are intact, so the user can delete the folder and re-run, but the commit message overstates it.
- **A-4 (nit)** — `board-orphans-demo-2026-10-20.jpg` shows the plain demo board (two Plan ready cards); it does not show an orphan or idle card. My Browser check above does; re-save a screenshot that does.

## Part B — M2 plan rev 3 against rev 2 and my M2-1…M2-6

No contradiction with what I approved:
- **M2-1** (no `auth.json` link/copy): rev 3 makes the private `config.toml` login-time only and exec independent of it; §5 still carries the "never read, linked or copied" test.
- **M2-2** (`ui/**` and docs rows): still in §3.
- **M2-3** (canary evidence rules): kept verbatim and tightened (positive control first, project-layer item is a FAIL → `blocked`, inconclusive on any ambiguity).
- **M2-4** (`cheap` = `--version` + `login status`): unchanged; `minVersion` is derivable from `--version`.
- **M2-5** (settings back-mapping): untouched.
- **M2-6** (version-bound record): strengthened (binary hash, argv-pin digest, config hash, canary version; Cursor's code-constant baseline is the one named exception).
- The only rev-2 sentence that changed meaning is "repo-level `.codex/` may load"; rev 3 reverses it on purpose and edits the canary bullet to match.

Plan-text findings (docs only; none blocks code):
- **P-1** §4 TODO still defines 1a = extract envelope and 1b = contract/registry; the work was done as 1a = characterization tests, 1b = envelope + contract + `ProviderId` in one commit (which is what §2b-1(f) asks for, and defensible because the characterization tests exist). Update §4.
- **P-2** §2b-8 says "§3 gains the missing rows", but §3 was not edited: `src/secrets.ts`, the key route/CLI, `providers/verification.ts`, `providers/codex-home.ts`, `test/providers/canary.test.ts` are listed only inside §2b-8.
- **P-3** the §2 code block still shows `capabilities(cfg)` on the provider and a declared `Capabilities.build`; §2b-1(c) supersedes it (derived), and commit 1b implements the derived form. Mark the block superseded.
- **P-4** the §2 argv line omits the pins §2b-2/3 require (`-c cli_auth_credentials_store="file"` at exec, `-c shell_environment_policy.*`, `--model=<v>`); §6 still says the credential-store pin lives in the config file, which `--ignore-user-config` makes invisible at exec. Write the exact argv once, in one place.
- **P-5 (risk, not a contradiction)** §2b-4 makes a firing repo-level `.codex/` item a canary FAIL → `blocked`. Plausibly Codex ignores project config for untrusted projects (the private home has no trust entries), but that is unverified with no working binary. If Codex honours it by design, Codex read-only ends up permanently `blocked`. Record that outcome as acceptable, or name the mitigation, before commit 3.

## Part C — M2 commits 1a / 1b against §2b-1 (a)–(i)

| Cond. | Result | Evidence |
| --- | --- | --- |
| (f) characterization first, unchanged after | **Met** | 1a: 13 cases green on the pre-extraction code (12 pass; E13 = documented todo). 1b changes the file only by the mock seam (`agents.build` → `provider('cursor').build.run`), the renamed fields, and removing E13's `todo`; E14–E22 are additions. Cases from §2b-1(f): hook/`core.hooksPath`/alias/pushurl E1; guard modified/deleted E2; secret E3; protected unlisted E4; rename source E5; provider throws E12; `verifyGuard` throws E14; `prepare` overriding env E18; provider without `prepare` E17; limit E10; abort E11; builder self-commits a protected file is covered by the existing `engine-security` (`commitSelf` + `.vscode/tasks.json`), which passes unchanged. **Gap: no timeout case** (see m-4) |
| (a) single choke point | **Met, weakly** | `runBuild` is the only caller of `build.run`; E20 scans `src/` |
| (b) gate re-asserted in the envelope | **Met in substance** | `buildEligibility(provider)` runs inside `runBuild` before `prepare`; ineligible ⇒ `held`, zero spawns (E19). See m-1 |
| (c) derived capabilities | **Met** | `build` = `typeof p.build?.run === 'function'`; `buildIsolationVerified` only from the frozen code baseline; no file/route can set it. The `registry.codex.build === undefined` test belongs to commit 3 |
| (d) fail closed, env merge | **Met except the merge order** | `prepare` throw/reject, missing `prepare` or `verifyGuard` on a declared guard, and `verifyGuard` throw all ⇒ `held` (E14–E16); `sanitizePrepEnv` drops `GIT_*/HOME/PATH/CODEX_*/XDG_*/LD_*/DYLD_*/NODE_OPTIONS`; the git no-push env wins (E18). See m-2 |
| (e) meta restore on every path | **Met** | restore runs after any result and now also when the provider throws (E13); declared in the 1b message as the one intentional difference |
| (g) run.json migration | **Met** | `migrateRunV2ToV3` carries old values, defaults `guardEnvOnly` to true when neither exists, never overwrites new fields (E21); API keeps `noPushEnvOnly` as a derived view (E22); `RUN_SCHEMA_VERSION` 3. See M-1 |
| (h) env-only for a tracked `.cursor/cli.json` | **Met** | same `writeCursorGuard`, same note text, E7 |
| (i) label from the registry | **Met** | trailer `Built by Conductor (Cursor). Plan rev N.` is byte-identical to before (E8); failure notes use `providerLabel` |

Mutation check on `17f18ac` (does the pinned behaviour actually bite): prep env allowed to override git env → E18 fails; restore skipped on throw → E13 fails; eligibility skipped → E19 fails; `verifyGuard` result ignored → E2 and E14 fail; `verifyGuard` throw treated as ok → E14 fails; "declares a guard but lacks hooks" refusal removed → E16 fails. **All six mutants killed.**

Behaviour of the extraction vs the old `stages.build`: same order of guard → snapshot → run → restore → tamper check → failure routing → guard check → commit → branch scans; stages now only record facts (`guardSha`, `guardEnvOnly`, session, refund) and route the outcome. Differences: E13 (declared) and the nits below.

### Findings
- **M-1 (major, carry-over, not caused by 1b but made live by it)** — upgrading a run record takes **no backup**, and the docs say it does. `ARCHITECTURE.md` ("Data folder, versions and backups") promises that `state.json`/`run.json` originals are copied to `~/.conductor-backups` before the first write after an in-memory migration. `RunStore` never calls `backupPaths`/`saveVersioned`. Probe: a v2 `run.json`, one `RunStore.update` ⇒ rewritten as v3 in place, backup directory empty. An older build then refuses the file (`NewerVersionError`). v2 is local and unreleased, so nothing is lost today, but 1b adds a second run-schema bump and the guarantee is a stated product promise. Fix in commit 2 (it adds config v4 anyway): back up a run record once per process before its first write at an older schema, or correct the docs.
- **m-1 (minor)** — the eligibility gate keys on `provider.id` of the object it is handed, which is adapter-supplied. Probe: `buildEligibility({ id: 'cursor', label: 'x', build: { guard: false, run } }).ok === true`. Today only registry objects reach `runBuild`, so there is no exposure; §2b-1(b) says "against the provider registry". Before commit 2 routes providers from config, make `runBuild` take a `ProviderId` (or assert `provider === registry[provider.id]`).
- **m-2 (minor)** — merge order is `extraEnv < providerEnv < envelope` in code (`cursor.ts`: `{ ...d.extraEnv, ...req.env }` with `req.env` already carrying the sanitized `prepare` env), while §2b-1(d) and the `types.ts` comment say `providerEnv < extraEnv < envelope`. No effect now (Cursor's `prepare` returns no env; `extraEnv` is test-only). Fix the order or amend the sentence.
- **m-3 (minor)** — E20 is a lexical scan. I added two bypasses to a copy (`const go = cap.run; go.call(...)` and `cap['run'](...)`): the test still passes; the plain `.build!.run(` call fails it as intended. Also `Agents.provider(id)` hands out the mutable provider object, so any module with an `Agents` can reach `build.run`. Acceptable as a lint; for commit 2, return a sealed handle that only `envelope.ts` can open, or freeze the objects outside tests.
- **m-4 (minor)** — characterization gaps against §2b-1(f): no timeout result case, and no "tamper + limit/abort result ⇒ restored" case (the code path is shared and unconditional, but untested).
- **m-5 (minor, pre-existing)** — if `snapshotGitMeta` fails the builder still runs and no tamper check exists (`.catch(() => null)`). Now that this is the single choke point, hold instead.
- **Nits** — `onResult` resets `buildFails` before the tamper check (the old code did it after), an undeclared and harmless difference; a zero-spawn refusal still charges one `agentRuns`; `capabilitiesOf` returns `readOnly: true` as a constant (derive it when a provider can lack read-only); `stages.ts:141,160` still hold the Claude/Cursor name ternary (commit 2/3 work per AC (f)); the live Cursor suites after the extraction are claimed ("3/3 earlier today") but no run record is saved under `.techteam/runs/`.

## Decisions

Conditions carried into M2 commit 2 (I will verify by diff, no full re-review): (1) M-1 backup or docs; (2) m-1 identity binding; (3) m-2 order or wording; (4) plan-text fixes P-1…P-4 and a recorded stance on P-5; (5) save the live Cursor suite run record for AC (c). Recommended with them: A-1, A-2, A-3, m-3, m-4, m-5.

Decision (M1c/M1d fixes): Approved — all five blocking items are closed and independently reproduced; only non-blocking residuals A-1…A-4 remain.
Decision (M2: plan rev 3 and commits 1a/1b): Approved — conditional on (1)–(5) above being met in commit 2; rev 3 does not contradict M2-1…M2-6, and 1a/1b follow §2b-1 (a)–(i) with the deviations listed.
