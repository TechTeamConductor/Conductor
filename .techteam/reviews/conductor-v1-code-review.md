# Conductor v1 — post-implementation code review

- **Decision: Changes requested** (2 BLOCKERs, 6 MAJORs, minors below)
- Reviewer: TechTeam Reviewer (independent; did not write this code)
- Date: 2026-10-20 (BST)
- Plan reviewed against: `.techteam/plans/conductor-v1.md` rev 2.1 (AC1–AC11, carry-forwards C1–C6)
- Baseline reviewed: commit `d9801b6` **plus the uncommitted working tree as of ~12:30–12:40 BST** (other specialists were editing `src/linear/client.ts`, `src/linear/ops.ts`, `src/server/{api,auth}.ts`, `src/runtime.ts`, `src/doctor.ts`, `ui/app.js` while I reviewed; I re-read those diffs). `ui/**` and `dev/**` were **not** reviewed in depth (Frontend still working); I only checked `docs/API.md` against `src/server/*`.
- Not done on purpose: no `test/live/*` runs (quota); no edits to source/test/docs.
- Linear: no connector in this session, so the standard Linear handoff comment cannot be posted. This file is the handoff; fix task = the findings below.

## 1. What I ran

| Check | Result |
| --- | --- |
| `npm run check` (`tsc --noEmit`, strict) | exit 0, no output |
| `npm test` (first run, 12:2x) | 435 tests / 51 suites: 432 pass, 0 fail, 3 skipped |
| `npm test` (final run, after the others' edits) | **439 tests / 51 suites: 436 pass, 0 fail, 0 cancelled, 3 skipped** (skips = 2 `LIVE=1` tests + the opt-in Keychain smoke), 27 s |
| Probe tests I wrote (scratchpad only, **not in the repo**) | 6 files, ~17 scenarios against the real engine + fake agents + FakeLinear; every finding marked *probe* below was reproduced. Files: `/private/tmp/claude-501/-Volumes-Sandisk-github-techteam-conductor/7b88419e-600f-4142-ac15-d9bbfc9a540e/scratchpad/probe{1..6}.test.ts` (import the repo's own harness; can be lifted into regression tests) |
| AC1 manual check | Copied the repo **without** `node_modules`/.git, `CONDUCTOR_HOME=<tmp>`, `node bin/conductor.mjs start --no-open --port 4987`: boots; `lsof` shows only `127.0.0.1:4987`; `GET /api/state` without cookie → 401. Killed afterwards. |
| Incident (mine) | During that check I ran `node bin/conductor.mjs open` without `CONDUCTOR_HOME`, so it talked to the **user's real running instance** (pid 58338) and opened a one-time signed-in dashboard tab in their browser. No state changed, nothing leaked (loopback, single-use link). Reporting it for transparency. |

## 2. Acceptance criteria (plan §2)

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC1 clean-copy boot, loopback only, 401/200 | **Met** (manually; no automated `boot-clean-copy` test) | my run above; `src/server/http.ts:65-84,225-229`; `test/server.test.ts:54-66,87-93`; lock `test/core.test.ts:99` |
| AC2 setup wizard fully in UI vs mock Linear | **Partially** | endpoints `src/server/api.ts:240-303`; pieces tested separately (`test/linear/provision.test.ts`, `test/linear/client.test.ts`, `test/server.test.ts:151-166`). No automated key → team → labels → repo sequence; `connectLinear` (`src/runtime.ts:108-117`) is untested and `validateKey` cannot be pointed at the mock. Manual: `.techteam/runs/evidence/setup-wizard-real-install.jpg`. |
| AC3 happy path | **Met** | `test/engine-happy.test.ts:7-55` |
| AC4 fail loop, dedupe, cap | **Met for the main path; Partially overall** | `test/engine-loop.test.ts:8-86`. Re-run/hook/unverifiable/spam paths are broken (M2–M5) and the fix-prompt content is not asserted |
| AC5 usage limit → pause, one comment, notify, auto-resume, fallback | **Partially** | Claude: `test/engine-limit.test.ts:6-53`, `test/agents.test.ts:70`. Cursor limit has `resetsAt: null` (`src/agents/cursor.ts:159`) → repeated 15-min pauses, one comment + notification each, and the run flips to `needs_human` after ~2.4 h (**B2**, probe S14) |
| AC6 isolation fail-closed | **Met** | `src/agents/claude.ts:58-74,187-194`; `test/agents.test.ts:18-47,84-96`; real init fixtures; lead ran `doctor --isolation` live |
| AC7 live Cursor E2E + negatives | **Partially** (not re-run by me) | `test/live/cursor-e2e.test.ts:35-67` is strong (exact file set, 1 commit, no stray branches, remote/main untouched). No secret-in-diff/commit/Linear/log assertion in the live test (only in the fake test `test/engine-safety.test.ts:99-118`); C3 gap below |
| AC8 dashboard | **Not assessed** (UI in flight) | screenshots exist in `.techteam/runs/evidence/`; API contract mismatches listed in minor m11 |
| AC9 security tests | **Met with gaps** | `test/server.test.ts:54-122,143-160`, `test/core.test.ts:142-175`; gaps: tautological assertion `test/server.test.ts:165`, "agent cannot read `~/.conductor`" not asserted (accepted threat model) |
| AC10 tsc + tests + AC→test table | **Met**, table not fully honoured | 439 tests; named tests from plan §5 that do not exist: `boot-clean-copy`, `setup-wizard-e2e`, engine-level `maxAgentRunsPerIssue`, concurrency cap / double-pick, lockfile re-install in `verify()` |
| AC11 `service install --dry-run` | **Met** | `test/core.test.ts:127-140` (`plutil -lint` + content), `src/cli.ts:218-224` |

## 3. Carry-forwards C1–C6

| C | Verdict | Evidence / gap |
| --- | --- | --- |
| C1 created-with-label history semantic | **Met** (live semantics unverified) | `src/linear/attribution.ts:94-117` (no history entry ⇒ creator; latest adder otherwise; truncated/missing history fails closed `:80-84`); all pages drained `src/linear/client.ts:606-630`; tests `test/linear/attribution.test.ts:60-117`, `test/engine-authz.test.ts:23-36`, `test/linear/parity.test.ts:318`. **Live check to do on first real task:** if real Linear records a creation-time history entry with a null `actorId`, claim is refused ("unknown actor") — it will show up in the dashboard `ignored` list |
| C2 failure keys w/o line/col; lockfile re-install | **Met** | `src/git/parse.ts` header + `test/git/parse.test.ts:325-440`, real tsc `test/git/gates.test.ts:205`; re-install `src/pipeline/stages.ts:307-320` and `:688-692`. No engine-level test; install failure in `verify()` is silently ignored (m9) |
| C3 push attack matrix | **Partially** | matrix + `CURSOR_GUARD_DENY` `src/git/worktree.ts:939-950`; `test/live/cursor-nopush.test.ts:41-55` asserts only "remote refs ⊆ {main}" — it passes vacuously if the agent declines to try, and `gh`/`security` outcomes are only printed, not asserted (C3 asked for that), `osascript`/`sudo` are not exercised although `docs/ARCHITECTURE.md` (Isolation table) calls them live-proven. User's PATH git is `/opt/homebrew/bin/git` (verified) but only `/usr/bin/git` is in the deny list (m7) |
| C4 team default-state warning + `pickup.fromBacklog` | **Met** | `src/linear/provision.ts:173-201`; `src/server/api.ts:253-281` (dry-run returns `defaultState`, `unstartedStates`, `warnings`; real create returns `warnings`); tests `test/linear/provision.test.ts:260-298`; UI wired `ui/app.js:2112-2123,2200`; setting default off `src/config.ts:14`, exposed `:149-185`; ignored issues + reason surfaced `src/pipeline/engine.ts:304-327` |
| C5 backup incl. uncommitted work | **Met**, one failure-path hole | `src/git/worktree.ts:747-822` (stash-format commit with untracked as 3rd parent), used `src/pipeline/engine.ts:504` and `src/pipeline/stages.ts:519-524`; probe S3b/S3c show `prev-1` + `stash-1` created. Hole: `stages.ts:521` swallows a backup failure and resets anyway (m8) |
| C6 R4 deferral surfaced | **Partially** | `README.md:53`, `docs/ARCHITECTURE.md:64`. The user-run S5 check ("does the Cursor app list a chat after `agent -p`?") is in neither doc; final report not written yet |

## 4. Findings

### BLOCKER

**B1 — `maxAgentRunsPerIssue` is a permanent dead end** (`src/pipeline/engine.ts:511-545`, `src/pipeline/stages.ts:204-207,564-569`)
- What happens: `agentRuns` is incremented for every agent attempt and **never reset**. When the cap is hit, the run goes `needs_human` with "…move it back to Todo to continue" (`stages.ts:205`). Moving to Todo re-queues it, the very first agent call re-checks `agentRuns >= cap` and the run is `needs_human` again, forever. *Probe S2:* cap=2 → `needs_human`; Todo → still `needs_human`, same message.
- Why it matters: the default cap is 10. One ordinary failing task (plan 1 + review 1 + 3 builds + 3 verifies = 8, +1–2 corrective retries) reaches it; one or two human retries reach it for sure. The only escape is deleting the run directory or filing a new issue — exactly the "struggle with the agents" case the product exists to remove. The README/Architecture advertise the cap as a safety feature, not a trap.
- Fix: on every human-initiated restart (`rerunFromHuman`) either zero `agentRuns` or raise a separate `agentRunBudget` by `maxAgentRunsPerIssue` (same pattern as `loopBudget`, `engine.ts:528`). Make the build-stage message at `stages.ts:568` say how to continue.
- Close with: engine test (cap=2 → needs_human → Todo → pipeline proceeds and completes).

**B2 — Cursor usage limit does not "pause and auto-resume": it spams Linear/notifications and drains the run budget into B1** (`src/pipeline/stages.ts:112-129,204-210,564-568`, `src/agents/cursor.ts:23,154-161`, `src/pipeline/engine.ts:597-610`)
- What happens: a Cursor limit carries `resetsAt: null`, so `pauseForLimit` uses `now + 15 min` (`stages.ts:114`). Each wake-up spends one `agentRuns`, gets rejected, and re-pauses with a **new** effect key `pause:${until}` → a new Linear comment and a desktop notification every 15 minutes. *Probe S14* (injected clock): after 9 cycles (~2.4 h) → 9 "Paused" comments, 10 notifications, then `needs_human: used its limit of 10 agent runs` (→ B1).
- Why it matters: AC5/R7 require pause-not-fail with auto-resume. Real Cursor limits last hours to the rest of the billing period. Same mechanism applies to Claude if the CLI ever omits `resetsAt` (30-min cycles).
- Fix: do not count limit-rejected attempts toward `agentRuns` (increment only after a non-limit outcome, or decrement in `pauseForLimit`/`handleBuildFailure`); back off exponentially when the reset is unknown (15 m → 30 m → 1 h → … cap 6 h); one Linear comment and one notification per pause *episode* (key on stage+rev, update the dashboard text for later cycles instead of commenting); parse a reset time out of Cursor's message if present.
- Close with: test that 20 consecutive limit cycles produce ≤1 comment, status stays `paused`, `agentRuns` unchanged.

### MAJOR

**M1 — Secret regex false-positives wedge commits and garble all text** (`src/redact.ts:8`, used by `src/git/worktree.ts:556-575` and every `redact()` call)
- `/sk-[A-Za-z0-9_-]{24,}/g` has no word boundary, so any kebab-case string containing `sk-` followed by 24+ word chars matches: `task-card-header-title-container`, `risk-assessment-report-generator-service`, `desk-layout-container-wrapper-large` (verified: `looksSecret` → true; `redact` → `ta[redacted]`).
- Effect 1: `commitAll` refuses the build (`reason:'guard'`, `stages.ts:594-595`) → `needs_human`; a retry re-runs the builder, which regenerates the same name → same refusal; no override. Effect 2: `redact()` silently corrupts plan comments, logs, dashboard text, Linear comments containing such strings.
- Fix: anchor (`(?<![A-Za-z0-9_-])sk-`), require provider-shaped bodies (e.g. `sk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}` and at least one digit), add negative tests with the three strings above; give the guard a user-approved override instead of a hard stop.

**M2 — Commit-hook rejection destroys the build instead of feeding the fix loop** (`src/pipeline/stages.ts:519-524,597-603`)
- Plan RC7: "repo hook failure = feedback into the fix loop". After a rejected commit the changes are left in the worktree (unstaged); loop 2's `build()` sees `hasUncommitted`, takes a backup, **hard-resets to the last commit** and logs "Discarded partial work from an interrupted build". The fix builder starts from a clean tree with a prompt that says "Independent verification of your previous build found problems" and "(none recorded — see the verifier summary)" plus the hook text. *Probe S3/S3b:* first build (a.mjs + test) rejected by a pre-commit hook; final branch contains only loop 2's b.mjs; first build survives only in `refs/conductor/TT-1/stash-1`.
- Husky/lint-staged repos hit this routinely. Cost: a full wasted Cursor run, wrong/missing work that the verifier then has to find.
- Fix: when `run.commitNote` is set, skip the interrupted-build cleanup and use a "your commit was rejected by the repo hook: fix in place" prompt; test with a once-failing hook asserting both loop-1 and loop-2 files are in the final diff.

**M3 — Verifier `fail` without an actionable bug causes useless build/verify loops** (`src/pipeline/stages.ts:758-835,661-670`, `prompts/verify.md` "pass only if every AC is met")
- The verify prompt tells the model to answer `fail` unless every AC is `met`, but `decide()` only turns `not_met` ACs into bugs. An `unverifiable` AC (UI, deploy, perf) or only minor/nit bugs gives `verdict:'fail'`, `failing=[]`; the loop goes back to Cursor with "(none recorded — see the verifier summary)" and the summary is never injected. *Probe S12/P6d:* 3 Cursor builds + 3 Claude verifies, then `needs_human: "Verification still finds 0 problem(s), and the loop limit (3) is reached"`.
- Fix: if there is no failing bug and no `not_met` AC, go straight to `needs_human` with `verdict.summary` and the unverifiable ACs (or treat unverifiable as a pass-with-warning, per config); inject `verdict.summary` into the fix prompt; never start a build loop with an empty problem list.

**M4 — Re-run leaves bug sub-issues open in Linear; second failure comment is suppressed** (`src/pipeline/engine.ts:542`, `src/pipeline/stages.ts:816-826,831`)
- `rerunFromHuman` marks open bugs `closed` locally without closing them in Linear; at pass `toClose` only contains bugs whose local status is `open`. *Probe S6b:* fail → loop-2 build in flight → drag to Todo → re-plan passes → run `ready`, local bug `closed`, Linear `[Bug]` sub-issue still in **Todo** under a Ready parent. Also `effects.comment(..., 'verify:${loop}')` ignores `rev`, so a failing verification after a re-plan posts no comment (*probe S7*: 1 comment instead of 2); `bugclose:`/`bugreopen:` keys have the same collision.
- Fix: close sub-issues (effects.close) when the re-run closes bugs, or at `markReady` close every bug with a `linearId`; include `rev` in all per-loop effect keys.

**M5 — No cap on sub-issues per verdict** (`src/pipeline/schemas.ts:91`, `src/pipeline/stages.ts:784-815`)
- `bugs` has no `maxItems` and `decide()` creates one sub-issue per failOn-severity bug. *Probe S9:* 12 bugs → 12 sub-issues in one loop. Fingerprint = LLM title + file, so the same defect worded differently each loop yields new sub-issues (up to loops × N) in a shared workspace.
- Fix: cap (e.g. 5 sub-issues per loop, 12 per run; remainder summarised in one comment or one "additional findings" sub-issue), `maxItems` in `VERDICT_SCHEMA`, comment on the existing sub-issue when a bug is re-observed (the plan said so; code does nothing, `stages.ts:801-813`).

**M6 — "Description changed — move to Todo to re-plan" does not re-plan** (`src/pipeline/stages.ts:501,683`, `src/pipeline/engine.ts:497-500`)
- `integrity()` failures in `build()`/`verify()` are raised with origin `'build'`/`'verify'`, so the Todo retry only re-runs that stage (`retryStage`). *Probe S8:* viewer edits the description, approves → `needs_human` ("…to re-plan with the new text") → Todo → `ready` with `rev` still 1: old plan built/verified against the new description. `test/engine-human.test.ts:123` accepts both outcomes so it cannot see this.
- Fix: raise integrity problems with origin `'plan'` (plan() already does, `stages.ts:361`). Test: edit → Todo → `rev === 2`.

### MINOR

- m1 `src/pipeline/effects.ts:118` crash window not idempotent: `lookup = attempts > 0`, but a process crash between `linear.comment()` and the `done` write leaves `attempts: 0`, so the retry does not look up the marker. *Probe S5:* pending comment whose twin already exists → 2 comments. Plan §2 promises "crash between comment and store ⇒ no duplicate"; `test/engine-safety.test.ts:120-135` only simulates a thrown error. Fix: persist `attempts+1` before the network call. Also `MAX_ATTEMPTS` (`:9,179`) gives up silently and the counter is shared across later state updates.
- m2 Un-park / resume of a non-running run: `engine.ts:432-438` and `:703-707` set `queued` without restoring `next`; a `ready`/`awaiting_approval`/`needs_human` run un-parked by moving to a started status (not Todo) becomes `running` with `next:'none'` and no job (*probe S1*; stuck until Abort). "Resume" on a parked run whose issue is still in Backlog is re-parked by the next poll (*probe S1b*), contradicting `docs/API.md:44`.
- m3 `engine.ts:497-501` retry of a `failed` run is a full restart with reset (probe S15: rev 2, `commitSha` cleared) although `docs/API.md:43` says "retry the origin stage". Restore stage-level retry for `failed`.
- m4 `stages.ts:637` `tries` counts "Build attempt failed" in the whole history: a later loop or human retry gets no automatic retry and reports "Cursor failed twice" after one failure (probe S10).
- m5 `src/agents/spawn.ts:170-171` waits for stdout/stderr `close`; background pipe holders delay the stage (probe: 6 s vs 0.76 s for `src/git/exec.ts:213-224`, which has the drain guard) up to the idle timeout and the result is then classified `timeout_idle` despite success (`cursor.ts:149`). Port the `exit`+drain handling.
- m6 `stages.ts:586-593` if the builder commits by itself, `commitAll` reports `nothing` → "finished without changing any files" even though work is committed (a Todo retry then accepts it via the crash-window rule `:508-518`). Detect HEAD advance after the agent run.
- m7 `src/git/worktree.ts:939-950` deny list covers `/usr/bin/git` only; the user's `git` is `/opt/homebrew/bin/git`. Add other install paths (`Shell(*/git:*push*)` if supported), assert `gh`/`security` denies in the live test (C3), stop calling `osascript`/`sudo` "live-proven" until exercised. Residual under the stated same-user model.
- m8 `stages.ts:521` `backupRefs(...).catch(() => null)` then `resetToCommit` anyway: if the backup fails the work is lost silently. Abort to `needs_human` instead.
- m9 `stages.ts:333,689-691,586`: gates and `commitAll` are not given `secrets`, so env-file values reach `outputTail`/artifacts/dashboard/verifier prompt unredacted (Linear is protected by `effects`); a failed lockfile re-install in `verify()` is ignored.
- m10 `worktree.ts:380,970` permanently appends to the **user's main-repo `.git/info/exclude`** (`/.conductor/`, `node_modules`, copied env files, `/.cursor/cli.json`); not undone by `uninstall`, not documented ("main checkout unchanged").
- m11 API/doc mismatches: `engine.cleanup` never deletes the branch (`engine.ts:731` vs `docs/API.md:46`); global pause still claims issues and writes labels/comments (`engine.ts:739-744` vs "no new claims", `docs/API.md:48`); flipping `linearMode` via settings without provisioning stops all polling (`api.ts:232-237` → `engine.prov()` throws, only a `lastPollError`).
- m12 Protected paths listed in the plan whitelist themselves in the diff-scope guard (`stages.ts:607`), even for auto-approved plans: force manual approval when the plan lists `.github/**`, `.claude/**`, etc.
- m13 `src/service.ts:55` `KeepAlive: true` re-launches every 30 s forever when a second instance exits 0 with "already running" (`cli.ts:104-106`); use `{SuccessfulExit:false}`.
- m14 Claim/ready comments post the local worktree path, `git -C <path>` commands and `http://127.0.0.1:<port>` to the shared Linear workspace (`stages.ts:860-868`, `engine.ts:361-364`); `LIMIT_RE` (`cursor.ts:23`) and the Claude `resets` regex (`claude.ts:221`) can misclassify failures whose text mentions "quota"/"resets"; the 10-min idle default kills builds that run a silent 10+ min test suite.

## 5. Tests that would still pass if the feature were broken (mutation view)

1. `test/server.test.ts:165` — `assert.ok(!r.text.includes('not-a-key') || true)` is a tautology; "the key is never echoed" is not tested (nor on the success path).
2. `test/engine-loop.test.ts:26-29` — comment says the fix prompt carries the finding and the second build uses the fix template; the test only counts two build calls (and resets the scenario to `{}`). Breaking `bugList()` (`stages.ts:661`) or `isFix` (`:535`) keeps it green.
3. `test/engine-safety.test.ts:120-135` — "crash between comment created and recorded" injects a thrown error after the write; the real crash window (`attempts: 0`) duplicates (probe S5).
4. `test/engine-human.test.ts:123` — accepts `awaiting_approval` **or** `ready` after the Todo retry, so re-plan vs plain stage retry is indistinguishable (M6).
5. `test/live/cursor-nopush.test.ts:41-55` — green if the agent runs none of the nine commands; no assertion for `gh`/`security` (C3).
6. `test/engine-limit.test.ts:55-70` covers exactly one Cursor pause/resume cycle; the repeated-pause path (B2) is untested.
7. Untested paths worth a test: `maxAgentRunsPerIssue` at engine level (B1), commit-hook failure through the engine (M2), `unverifiable`/minor-only `fail` (M3), re-plan with open bugs (M4), un-park of non-running runs (m2), lockfile re-install in `verify()`, `looksSecret` false positives (`test/core.test.ts:113-126` only has trivial negatives; M1), `complexity:'L'` approval and `max_turns` retry work (probe P6a–c) but have no committed tests.

## 6. Checked and found sound (so the next reviewer can skip it)

Claim/dedup (`store.create` is `mkdir`-atomic, single-instance lock, per-poll serialisation); creator/label/description attribution and fail-closed truncation; Linear client retry + client-generated ids + `recover()` lookup + key scrubbing + 429 handling; effects serialisation per run; Claude init predicate and abort-on-violation; limit classification from the real event shape; `runProcess` process-group abort and sleep-gap budgeting; backup-ref content (`git stash create` + untracked parent); `compareGates` (failure-set diff, unparseable ⇒ `unverified`, flake re-run); commit hygiene (name/size/content guards, hooks run, no `--no-verify`, identity fallback); diff-scope guard; dashboard auth (Host check, OTP single use, HttpOnly/SameSite=Strict cookie on every route incl. SSE, CSRF + same-origin + JSON-only, exact static whitelist, 1 MB cap); persisted sessions store only SHA-256 hashes (new `auth.ts`); `open` actions (uuid + quoting + whitelist); launchd plist; demo isolation (own `CONDUCTOR_HOME`, fakes).

## 7. Residual risks (accepted or unverifiable here)

- Same-user threat model: a `--force` builder can run anything as the user (README states it).
- Claude live path is fixture-only until after 2026-10-21 14:00 BST: run `doctor --probe` and one real plan+verify before trusting `--json-schema`/`StructuredOutput` handling end to end.
- Linear first contact already surfaced one real-world difference (label removal of absent labels, fixed in the uncommitted `client.update`); expect more. Run one disposable issue through the whole loop before pointing it at real work, and check the dashboard `ignored` list for C1 attribution refusals.
- A crash/`kill -9` leaves detached agent process groups running; on restart a second builder can start in the same worktree (`recover()` + `build()` reset).
- Gate masking: the builder can edit `package.json` scripts/test config so gates pass; only the AI verifier looks at that.
- Bug fingerprints depend on LLM wording (duplicates across loops; bounded by M5 fix).
- Claude-side `Read` can open any file the user can read; isolation removes rules/MCP, not file access.

## 8. Closure rules

I will close each finding only after seeing: the code change, a regression test that fails on the old behaviour (probe files above reproduce B1, B2, M1–M6, m1–m3 and can be lifted), `npm run check` + `npm test` green, and for B2/M1 a short note of which limit/regex cases the test covers. Re-review scope: B1, B2, M1–M6 (+ m1/m2/m8 if touched). No new plan review is needed for these (they implement behaviour the approved plan already specifies).
