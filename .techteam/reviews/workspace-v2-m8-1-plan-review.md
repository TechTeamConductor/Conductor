# Plan review

Reviewer agent only. Silence is not approval. Do not fabricate this record.

- Task / Linear issue: M8 "product layer" master direction + M8-1 model discovery (brief F7a)
- Plan artifact: `.techteam/plans/workspace-v2-m8.md` (master), `.techteam/plans/workspace-v2-m8-1.md` (slice 1, gates code)
- Reviewed by: Reviewer (independent; nothing in `src/`, `test/`, `fixtures/` or the plans was edited)
- Reviewed at: 2026-10-21, clone HEAD `8eaab46`
- Decision: Round 1 (rev 1) **Changes requested**; Round 2 (rev 2) **Approved with conditions**: see the Round 2 section at the end. Master: **Approved** (direction), with notes M1–M4.

Round 1 result (rev 1): Changes requested. Superseded by Round 2 below.

Method: every "current state" claim in both plans was checked against the code. I read the brief (§0–§7), `CLAUDE.md`, `docs/ARCHITECTURE.md`, and `src/agents/{roles,routing,env,spawn,claude,cursor}.ts`, `src/agents/providers/{types,probe,codex,codex-home,registry}.ts`, `src/config.ts`, `src/paths.ts`, `src/migrate.ts` (skeleton logic), `src/schema/version.ts`, `src/server/{api,http}.ts`, `src/runtime.ts`, `src/service.ts`, `src/doctor.ts`, `src/redact.ts`, `fixtures/fake-{claude,agent}.mjs`, `test/helpers/harness.ts`, `test/setup-wizard.test.ts`, `test/preload.ts` and `package.json`. I did not run any real CLI.

Security design sign-off is still a separate step (M8-1 is `pending_security_design`, and brief §0.2 requires it). This review does not replace it.

---

## Part A: master plan `workspace-v2-m8.md`: direction verdict

**Approved (direction and slice order).** The order matches brief §5: F7a, then F7, F8, F6, then UI, then Home, with F11 last. The dependency column is right: M8-2 needs the catalogue, M8-4's limit rule needs M8-3, and the Codex pairings need Q5. Security-design flags match brief §0.2. The role mapping matches the brief's proposal. Brief §4 (prototype-only items) is respected by "Port UX, wording and CSS tokens; not its code".

Current-state claims I checked:
- Correct: 10 roles and `RoleConfig {providers, autoByComplexity?}`; `ProviderState` fields, including `webResearchIsolated`; `CODEX_MODEL_RE` at `src/config.ts:40`; `--model` at `claude.ts:58`, `cursor.ts:20` and `codex.ts:66`; `CONFIG_SPEC` v5 with migrations 2→5 at `config.ts:45`; `PUT /api/roles`, `PUT /api/settings`, `POST /api/providers/:id/test`.
- Minor: `routeStates()` is at `engine.ts:181`, not 182.

Notes for the master plan. These are not blocking, but each sub-plan should pick them up:
- **M1.** "Health … cached by the service" is wrong about the file. The health cache is `lastHealth` in `src/runtime.ts:77-96`, plus the 60 s cache in `src/doctor.ts:36-52`. `src/service.ts` is the launchd plist installer. Add `src/runtime.ts` to the §3 table for every slice that wires a service, and expect `src/agents/spawn.ts` to change (see B2).
- **M2.** In the §2 table, the "User decisions needed first" column conflicts with M8-1 going ahead on assumed answers to Q9 and Q10. Either rename the column ("decisions the slice assumes, to confirm in the slice report") or ask the user first.
- **M3.** M8-3 will change the cache key from `default` to real account ids. The M8-1 cache layout already allows this. Say in M8-3 that existing `default.json` caches are moved over or discarded, since they are only a cache.
- **M4.** Add a cross-slice rule: no slice may start background CLI spawns inside `npm test` unless they point at a fake. This is the lesson from B1 below.

---

## Part B: M8-1 model discovery: checklist

1. **Codebase analysis is complete enough to implement safely: partly.** Most claims are accurate: `runProcess` writes stdin and closes it, has idle and hard timeouts, kills the process group and keeps 64 KB tails; `cliOut` has a 20 s bound; the env allow-lists match; `loadVersioned`, `saveVersioned` and `quarantine` exist; CSRF lives in `http.ts:294-297`; the Claude and Cursor model strings are not validated. Two claims are wrong:
   - Runtime wiring does not live in `src/service.ts` (B1).
   - There is no SSE "changed" event. `http.ts` only broadcasts `state`, `log`, `toast` and `ping`, and `state` is sent only on store or engine changes (N1).
2. **Every task requirement is covered: mostly.** F7a is mapped item by item. Two §7 items have no acceptance criterion: "no hooks" (B5a) and email kept out of CLI-derived reason/log text (B5b). "No longer available" is correctly deferred to M8-2 as a Gap.
3. **Proposed architecture is correct: yes, with B2–B4.** The pieces are well separated (pure sanitiser and families, adapters, cache, service), argv is constants only, discovery is never on the board's critical path, and only `models` and `account` are kept. The Codex transport as written cannot work (B4).
4. **Affected-file list is accurate: no.** `src/service.ts` is the wrong file (B1). `src/agents/spawn.ts` is missing if B2 is solved there. `src/runtime.ts` is missing.
5. **Security, authorization and compliance are addressed: mostly.** Email and organisation are never stored, constants-only argv, allow-listed env, empty cwd, 15 s timeout, caps, strict refresh API behind CSRF. Gaps: `redact()` has no email pattern (B5b); the footprint in the user's real Claude config (N2); Codex hygiene and lock (B4).
6. **Testing strategy is adequate: not yet.** The fakes are not wired through to the service (B1), the size caps can't be tested as written (B2), and the real-fixture drop count is not pinned (B5c).
7. **Risks, dependencies and acceptance criteria are explicit: yes.** The Q9/Q10 assumptions are stated and reversible (N5).

### The specific points I was asked to check

- **Nothing changes stage argv in this slice: holds.** The only shared edit is `CODEX_MODEL_RE`, which becomes a re-export with the same value. `buildClaudeArgs`, `buildCursorArgs` and `buildCodexArgs` are untouched. But the existing tests check pieces of the argv, not the whole thing (`test/agents.test.ts:61-67`), so "snapshot tests unchanged" protects less than it sounds (N8).
- **Spawn approach (stdin written, then EOF): feasible for Claude** (the Lead measured it on 2.1.304) **and Cursor** (no stdin). **Not feasible for Codex** pagination or the JSON-RPC handshake (B4). The output caps don't fit the current `runProcess` API (B2).
- **Cache versioning with `src/schema`: does not fit as written** (B3).
- **API strictness matches `PUT /api/roles`: yes, and it is stricter.** `putRoles` checks for a plain object, own-property role names and registry ids, but ignores extra top-level keys. The refresh endpoint's "only `provider`" rule is stricter, which is fine. CSRF, the JSON content type and the same-origin check are applied by `http.ts` to every mutation, so nothing new is needed there. Make `ApiDeps.models` optional and answer 501 when it is absent, the same as `asks` (N9).
- **Project rules:** no new dependency. Type-stripping-safe syntax is implied. `sanitize.ts` must stay a leaf module (no imports from `config.ts`) to avoid an ESM cycle and a TDZ error, because `config.ts` will re-export from it (N12).
- **How fakes are selected in tests:** not specified, and it matters (B1).
- **`HOME_SKELETON`:** adding `models` is right, but has a side effect (N3).
- **Concurrency:** handled within one process (shared promise, 10 s debounce), but not between the CLI and the server (N6).
- **Startup must not block:** the intent is right, but there is no rule for catching errors or shutting down (B1).

---

## Blocking items

**B1. Runtime wiring is in the wrong file, and nothing stops `npm test` from spawning the real CLIs.**
- `src/service.ts` only builds and installs the launchd plist. The runtime is `createRuntime` in `src/runtime.ts`. Health is computed there (`readAgents`, `health`, `engine.setHealthSource`), and that is where `startup()` and `noteVersion()` must hook in.
- `test/setup-wizard.test.ts:45-52` creates a full runtime with `normalizeConfig(defaultConfig())` (bins `claude` and `agent`, the real ones) and an injected `health` that says both tools are found and ok. If the plan's startup gate ("cheap detect says ok") reads that health, the suite spawns the developer's real `claude` and `agent`. That breaks the `npm test` rule (fake agents only). In CI it slows tests or fails them.

The revised plan must specify:
- (a) `ModelService` deps: `getConfig`, `extraEnv`, `clock`, and an optional spawn seam. Bins come from `resolveBin(cfg.agents.<id>.bin)`, so tests and `conductor demo` reach the fakes. `FAKE_DIR` travels in `extraEnv`, the same way `Agents` gets it in `test/helpers/harness.ts:130` and `src/demo.ts:85`.
- (b) A `RuntimeOptions.models` seam (inject a service, or `false` to disable). Automatic startup discovery runs only when the runtime uses real health, meaning `opts.health` is not injected, or when a test opts in explicitly.
- (c) A guard test: creating a runtime the way the existing tests do spawns no discovery process.
- (d) `startup()` runs after `listen` as `void p.catch(log)`. An unhandled rejection must never take the process down.
- (e) `Runtime.close()` aborts in-flight discovery through an `AbortSignal` and removes the temp folders. Tests create several runtimes per process, and the 15 s timeout would otherwise leave children running.

**B2. The output caps can't be enforced with today's `runProcess` API.**
- `onLine` only receives complete lines. A reply with no newline builds up in the splitter until 4 MB, is cut back to its last 1 MB (`spawn.ts:159`), and `onLine` never sees it. Raw byte counts are not exposed.
- So "per-line cap 512 KB, total cap 2 MB, beyond ⇒ kill + 'the reply was too large'" can't be implemented as written.

Choose one:
- Add an optional, backwards-compatible `maxStdoutBytes` (or `onChunk`) to `SpawnOpts`. List `src/agents/spawn.ts` among the files, and add a test that existing callers behave the same.
- Or restate the caps in terms of what `onLine` delivers plus the 15 s hard bound, and test "5 MB with no newline ⇒ `unavailable` within the timeout, no crash, nothing stored".

In both cases, say how the kill happens (an `AbortController` whose signal is passed to `runProcess`) and how `aborted` is reported versus `timedOut`.

**B3. Cache versioning doesn't fit `src/schema/version.ts`.**
- `VersionSpec` requires `field: 'schemaVersion' | 'version'` and `assumeWhenMissing`. The planned `Catalog` stores `v: 1`, and the planned spec `{kind:'models', current: 1}` won't type-check. Use `schemaVersion` (or `version`) and give the full spec.
- Define each failure:
  - A corrupt file (`CorruptFileError`): `quarantine()`, then treat as no cache.
  - A newer file (`NewerVersionError`): do **not** quarantine it and do **not** overwrite it. `saveVersioned` calls `assertNotNewer`, which throws, so a naive refresh would fail forever and show as "stale" with a confusing reason. Keep the fresh result in memory only, give a reason, and log once (rule S-9).
- Test both cases.
- `atomicWriteFile` creates parent folders with the default mode. Create `<home>/models/<provider>/` with mode 0700 yourself.

**B4. The Codex transport as planned can't work. Shrink it to parser plus fixture.**
- Paginated `model/list` needs the `nextCursor` from each reply before it can send the next request. "Write all requests, then EOF" can't do that.
- A JSON-RPC app-server also normally expects an `initialized` notification after `initialize`, and may exit on EOF before it answers.
- The plan also leaves out the private-home hygiene pre-flight and the per-home queue that every Codex spawn uses today: `prepareCodexHome`, `withCodexHomeLock` and `makeScratchHome` in `codex-home.ts`.

So "enabling it is a one-line change" is not true. For this slice:
- Ship the pure parser and pagination folding, tested against the fixture. Label the fixture with the source and version it was written from (N11).
- `CatalogView` `unavailable` with the planned reason.
- **No Codex spawn code at all.**

Enabling Codex discovery becomes its own small plan: an interactive stdin transport, the handshake, hygiene plus lock, `generate-json-schema` checked, and a live check after Q5. AC3 then tests only "parser plus the service never spawns".

**B5. The acceptance criteria miss three §7 / F7a items.**
- **(a) No hooks.** Add the plan §6 hook-marker check to AC9 (a temporary `CLAUDE_CONFIG_DIR` holding a SessionStart hook; the marker file must stay absent; evidence file under `.techteam/runs/evidence/`). Add a unit test that the Claude discovery argv contains `--safe-mode`, `--strict-mcp-config` and `--disable-slash-commands` and nothing beyond the constant list.
- **(b) No email in logs.** `redact()` has no email pattern; `src/redact.ts` only removes `user:password@` from URLs. A `reason` or log detail built from CLI stderr or stdout can carry the email (both CLIs print "Logged in as …" style text). Add an email-shaped scrub for every CLI-derived `reason` and log string. Add a fake scenario that prints the account email on stderr, and have AC7 grep the cache file, the `GET /api/models` body and the log for it.
- **(c) Real-fixture integrity.** AC1 must assert that the recorded 2.1.304 signed-in fixture yields **13 kept and 0 dropped**, the signed-out fixture 5 and 0, and the Cursor fixture 265 and 0. If any real id fails `MODEL_ID_RE` (for example a bracketed context variant), do not drop it silently. Stop and put it to the user, because the id rule is the user's (brief F7).

---

## Non-blocking items

- **N1. Live updates.** There is no SSE "changed" event. Pick one approach:
  - The UI polls `GET /api/models` while a refresh is running.
  - `ModelService.onChange` triggers `DashboardServer.scheduleState()`, and `live()` carries a small models summary.

  Fix the §2.7 wording to match.
- **N2. Footprint in the user's Claude config.** A fresh `mkdtemp` cwd for every discovery probably adds a `projects` entry to the user's `~/.claude.json`. Without `--no-session-persistence` it may also leave a session file under `~/.claude/projects/` each time. Discovery runs at every startup and every refresh, so this grows without limit.
  - Prefer one stable discovery folder (0700, checked empty before each run).
  - Keep `--no-session-persistence` if the live check accepts it.
  - Record a before/after listing in the AC9 evidence.
  - Clear leftover `run/discovery-*` folders at startup.
- **N3. `HOME_SKELETON`.** Adding `models` correctly makes an *empty* `models/` count as skeleton (`paths.ts:14`, `migrate.ts:152-189`). Once a cache file exists, `migrate`'s `checkTarget` treats the home as holding data. That matches how `run/` already behaves, so accept it and document it; the cache can be rebuilt. Don't create `models/` in `ensureHome`. Re-run `test/schema/schema.test.ts:247` and the migrate C-2 tests.
- **N4. Discovery always uses `--safe-mode`,** even when `agents.claude.isolation = 'setting-sources'`. That is acceptable (if the CLI lacks the flag, discovery fails closed to `unavailable`), but write it down.
- **N5. Q9 and Q10.** Proceeding on the recommended answers is reversible, but brief §0.5 says the user decides. Put both questions to the user in the slice report as provisional.
- **N6. CLI and server at the same time.** `conductor models --refresh` run while the server is up means two processes discover at once, and the server's in-memory view goes stale. Choose one:
  - The CLI reads the cache, and `--refresh` goes through the running server.
  - The CLI refreshes on its own, and the server re-reads the cache file when its modification time changes.

  The CLI command must also call `assertHomeIsUsable`.
- **N7. The "no catalogue in `src/`" grep test.** Write the pattern down (model-family-shaped literals such as `claude-(opus|sonnet|haiku)`, `gpt-\d`, `composer-\d`, `gemini-`). Cover `src/**` and `ui/**`, and exclude `fixtures/` and `test/`.
- **N8. Golden argv tests.** Add exact-argv tests now for all three builders with the default config (no model). That gives M8-2's "byte-identical when unset" promise a baseline. Today's tests check pieces only.
- **N9. API details.**
  - Make `ApiDeps.models` optional (501 when absent), so the five tests that build `new Api({...})` directly still compile.
  - Treat an empty JSON body `{}` on refresh as "all providers".
  - 202 works through `ApiResult.status`.
- **N10. Cursor parsing.**
  - From the recording, confirm whether zero-width characters appear inside *ids* or only in labels. If inside ids, the cleaned id must still be one Cursor accepts; note the finding next to the fixture.
  - The §2.2 table says Cursor signed-out is both `unavailable` and "previous cache kept and marked stale". Define it as `stale` (with the sign-in reason) when a cache exists, and `unavailable` otherwise. Apply the same rule everywhere.
- **N11. Codex fixture source.** Brief F7a says "build against schema". Label the fixture with the document or schema version it came from, and say it was not generated from `generate-json-schema`.
- **N12. Module and value hygiene.**
  - `sanitize.ts` stays a leaf module.
  - `claude_code_version` and `cliVersion` are untrusted: clean them to ≤ 40 characters and require a version-shaped match.
  - Define `signedIn`: `tokenSource === 'none'` ⇒ false; an API-key user with no email ⇒ true. Test both.
- **N13. The `reading` state.** Define the view when a refresh is running and a cache already exists. My suggestion: keep `fresh`/`stale` and add `refreshing: true`; use `reading` only when there is no cache. Test it.
- **N14. The 10 s debounce must not swallow forced triggers** (version change, unknown model). When a forced trigger is debounced, queue one follow-up refresh.

## Coverage confirmation

- Requirement mapping is complete: **no** (see B5a–c; "No longer available" is correctly a Gap owned by M8-2)
- Gaps that block approval: B1–B5

## Record

- Artifact path: `.techteam/reviews/workspace-v2-m8-1-plan-review.md`
- Next action: **revise the plan** (M8-1 rev 2 addressing B1–B5; N-items may be folded in or answered in the plan). No source edits until a Reviewer approves rev 2 **and** Security signs off the design. Master plan: proceed, folding M1–M4 into the sub-plans.

---

## Round 2: plan rev 2 (re-review)

- Reviewed: `.techteam/plans/workspace-v2-m8-1.md` rev 2 (§2b Security conditions S1–S20, §2c answers to round 1), together with `.techteam/reviews/workspace-v2-m8-1-security-design.md` (Approved with conditions). Checked again against the code at `8eaab46`: `src/schema/version.ts`, `src/runtime.ts`, `src/lock.ts`, `src/pipeline/engine.ts` (health source), `src/agents/spawn.ts`, `test/` (runtime creators).
- Fact check accepted, and pinned by AC1/AC2 (§2c B5c): all 13 Claude values and all 265 Cursor ids pass `MODEL_ID_RE`; the zero-width characters sit at the end of 4 Cursor labels. My round-1 bracketed-id concern (and the matching note under Security S9) does not apply to the current CLIs.

Verdict: Approved with conditions

Implementation may start once C1–C3 are in the plan text. The Lead may apply them without another Reviewer round. I will check them at the code review, together with the Security code review, which must confirm S1–S17.

### Round-1 blocking items: closed

| Item | Rev 2 answer | Checked against code | Status |
| --- | --- | --- | --- |
| B1 wiring and tests reaching real CLIs | `src/runtime.ts` wiring; deps `{getConfig, clock, extraEnv, bins via resolveBin, spawn, log}`; `RuntimeOptions.models` seam; automatic discovery only with real health; refuses to spawn inside `NODE_TEST_CONTEXT` without injected deps; `void startup().catch`; `close()` → `stop()`; guard test | `createRuntime` builds `lastHealth`/`readAgents` at `runtime.ts:75-96`; `extraEnv` reaches `Agents` the same way (harness:130, demo:85); `src/service.ts` no longer touched | Closed (notes R2-N1, R2-N2) |
| B2 byte caps | `SpawnOpts.maxOutputBytes` counted on raw `data` events before line splitting, kills the group, `overflow` flag; off by default; per-line 512 KB in `onLine`; flood and many-lines tests | A 2 MB total cap trips before the splitter's 4 MB runaway guard, and existing callers pass nothing, so they are unchanged | Closed |
| B3 cache on `src/schema` | `field:'version'`, corrupt ⇒ quarantine (≤ 3 kept), newer ⇒ neither quarantined nor overwritten (kept in memory, with a reason), 0700 folders checked (S12) | One claim is wrong, see **C2** | Closed, subject to C2 |
| B4 Codex | parser and fixture only; no spawn, no home preparation, no binary lookup (S17); enabling is a separate plan and Security gate (S18) | n/a | Closed (stale text in §2.2 remains, see C3) |
| B5 acceptance gaps | (a) exact Claude discovery argv pinned and S5/S16 marker evidence; (b) `scrubIdentity` for every reason/log line, plus a fake that prints the email on stderr; (c) real-fixture kept/dropped counts | `redact()` still has no email rule, so the new scrub is needed and is planned | Closed |

Round-1 non-blocking items taken: N1 (polling with `refreshing`), N2 (see C1), N3, N6, N8, N10, N13, and master N4. N14 is superseded by S11 (≤ 1 per `cliVersion` per process and a 5-minute back-off after failure). Not taken, and still non-blocking: N7 (the grep pattern for "no catalogue in src"), N9 (optional `ApiDeps.models` ⇒ 501; empty body means all providers).

### Conditions (must be in the plan text before the first source edit)

**C1. The discovery cwd rule conflicts with binding Security condition S10.** Three places say different things:
- §2.2 says a fresh `mkdtemp(<home>/run/discovery-)`, removed afterwards;
- §2c N2 says one stable `<home>/run/discovery`, made empty before each run;
- S10 (binding) says `mkdtemp`, removed in `finally` after reaping, plus a startup sweep of `discovery-*` older than 1 h.

Choose one and write it in all three places:
- **Option (a), recommended because it keeps the N2 benefit (one `~/.claude.json` project entry instead of one per refresh):** use one stable folder **per provider**, `run/discovery-claude` and `run/discovery-cursor`. Claude and Cursor discoveries can run at the same time, and one must never empty the other's cwd. Before each run: `lstat` shows a real directory owned by the current uid, mode 0700; any entries are removed without following links. The 1-hour sweep is dropped. Because this departs from S10, record Security's acknowledgement (one line in the security design file, or a note in §2b).
- **Option (b):** keep S10 exactly as written, and accept the per-refresh project entries, which S11 bounds. Then remove §2c N2.

**C2. B3's mechanism does not do what §2c claims.** With `assumeWhenMissing: 0` and no migration registered for 0, `loadVersioned` does **not** fail. `version.ts:48` takes `v = 0`; the migration loop finds no step for 0; and line 59 returns the unversioned data with `fromVersion: 0, migrated: false` and no error. A hand-written cache with no `version` field and well-formed entries would therefore be accepted, which breaks S12 ("a file without the field is treated as corrupt").

Fix: the cache loader treats `loaded.fromVersion !== 1` as corrupt and quarantines it (≤ 3 kept). Do this explicitly, or use `assumeWhenMissing: 0` together with this check. Add an AC5 test: a cache file without `version` is quarantined and served as "no cache".

Also state that the S12 `lstat` (regular file, not a symlink, ≤ 4 MB) runs **before** `loadVersioned`, because `loadVersioned` uses `readFileSync`, which follows links. Accept that a narrow TOCTOU remains between the two calls, or open with `O_NOFOLLOW` and read through the descriptor.

**C3. Superseded text still contradicts §2b/§2c, and the AC list was not rewritten as S20 requires.** The implementer and the Security code review both work from §2.2, the AC list and §5, so these must agree. Add one line ("§2b and §2c supersede §1–§7 where they differ"), **and** fix these places:
- §2.2 Claude row: "dropped if it breaks the handshake" contradicts S6, which makes `--no-session-persistence` mandatory and says unavailable if the flag is rejected.
- §2.2 Cursor row: "unavailable … previous cache kept and marked stale" contradicts the N10 rule (stale with a cache, unavailable without).
- §2.2 Codex row, the "Spawn … `codexEnv`" bullet and the `CODEX_DISCOVERY_ENABLED` bullet's transport description contradict B4/S17. No Codex spawn exists in this slice.
- §2.2 "stdout captured via `onLine` … total cap of 2 MB" contradicts B2/S4, which use `maxOutputBytes`.
- §2.2 cwd: see C1.
- §2.5 "a corrupt or newer file is quarantined/ignored" contradicts B3, where a newer file is never quarantined.
- §2.6: add the S11 back-off and the S3 scrub to the service bullets.
- §2.7 "or receives the existing SSE 'changed' event": there is no such event (N1).
- §4 "wiring in `service.ts`" should be `runtime.ts`.
- §6 "a SessionStart hook" is superseded by the broader S5 marker set.
- The **AC list** must itself carry the following, and §5 must name the tests:
  - AC5 += S12/S12a cases (symlink, oversize, forged `fetchedAt`, provider/account mismatch, missing `version` from C2);
  - AC6 += the S1 tripwire, S4 overflow (both shapes), the B5a exact argv, and the B1 guard test;
  - AC7 += S2 decoys and S3 email-on-stderr across cache, API, log, reason and the evidence file;
  - AC8 += S13 GET key allow-list, 202 inside the 10 s window, no absolute paths;
  - AC9 += S5 and S16 marker evidence and the `~/.claude.json` before/after count (N2);
  - a new AC for the N8 golden full-argv tests of the three stage builders;
  - a new AC for S11 (repeated failures plus 20 health refreshes ⇒ 1 spawn) and S17 (Codex: zero spawn, zero binary lookup).

### Non-blocking (round 2)

- **R2-N1. Startup may never fire on a headless start.** §2c triggers `startup()` from "the first REAL health result". `readAgents` runs only when someone calls `health()` (`GET /api/state` or `/api/providers`) or when the engine calls `freshHealth()`, which happens on demand only (e.g. `engine.ts:372`). A `conductor start` with no browser and no work would never discover. Start one background, zero-quota health read after `listen` in `cli.ts` start and in `desktop-sidecar.ts`, or have `startup()` run its own `detect`.
- **R2-N2. The guard test can't spy on `runProcess` itself.** It is an ES module export, so its binding cannot be replaced without `mock.module`. Count spawns through the `deps.spawn` seam, or a counter on `ModelService`, plus the `NODE_TEST_CONTEXT` refusal. Also, only `test/setup-wizard.test.ts` creates a runtime in the suite today; the "server" runtime test named in §2c does not exist. Include `src/demo.ts` (fake bins plus `FAKE_DIR`) in a boot check.
- **R2-N3. Live tests also run under `NODE_TEST_CONTEXT`.** `npm run test:live` uses `node --test`, so live discovery tests must inject `spawn` explicitly or they will be refused. Say so in §5.
- **R2-N4. N6 server check.** Use `readLock()` plus a pid-liveness check, as `cli.ts` already does around `acquireLock`. When no server runs, hold the lock for the duration of the CLI refresh, so a server starting at the same moment cannot race it. Otherwise accept last-writer-wins, which is safe because writes are atomic renames.
- **R2-N5.** N7 and N9 from round 1 are still open; fold them in at implementation time.

### Coverage confirmation (round 2)

- Requirement mapping is complete: **yes**, once C3 puts the S20/B5 additions into the AC list. "No longer available" stays a declared Gap owned by M8-2.
- Gaps that block approval: none beyond C1–C3, which are text changes the Lead applies before the first edit. C1 option (a) also needs a one-line Security acknowledgement.

### Record (round 2)

- Next action: the Lead applies C1–C3 to the plan (and gets the Security acknowledgement if C1 option (a) is chosen), then implements in the same session. The Reviewer code review and the Security code review (S1–S17, plus the S5/S16 evidence) gate the release of the slice.

### Round 2: conditions check (plan §2e, read 2026-10-21)

This check observed the plan text only; the verdict above is unchanged.
- **C1 closed.** The plan now uses one stable folder, `<home>/run/discovery`, and all discovery spawns go through one service-wide queue, so they never overlap. The folder is checked before every run under §2d R2-2: a real directory, owned by the user, mode 0700, emptied without following links, then re-checked empty. Security's rev-2 text (security design file, line 195 onwards) accepts the stable folder with these rules. The cost is that a hung Claude discovery (worst case about 21 s) delays the Cursor one, which is acceptable.
- **C2 closed.** The cache reader opens the file with `O_RDONLY | O_NOFOLLOW`, then checks it through `fstat` on the open handle: regular file, owned by the user, at most 4 MB. It reads through that handle and requires `version === 1`; a missing version counts as corrupt and is quarantined. A newer file is left untouched and the result stays in memory only. Parse errors are never logged. Writes use `saveVersioned`, and only when no newer file exists. The missing-version case is listed in AC5.
- **C3 closed.** A precedence line (plan line 22) names each superseded rev-1 statement, and §2e AC1–AC13 replaces the AC list with a named test file per AC. §4 and §5 still hold rev-1 wording, which the precedence line covers.
- **Code-review watch items:**
  - AC12 and the R2-N2 spawn counter must be exercised by real tests, not just asserted.
  - §5 still says "spy on `runProcess`"; that is impossible for an ES module export, so use the injected spawn dependency.
  - Serialisation must not let a hung discovery block `view()` or the API.
