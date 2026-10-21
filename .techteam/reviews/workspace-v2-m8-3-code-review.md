# Code review: M8-3 Accounts and automatic switching

- Plan: `.techteam/plans/workspace-v2-m8-3.md` (rev 2; §2N N1–N8 and §2S S1–S25 are binding). Plan review: `.techteam/reviews/workspace-v2-m8-3-plan-review.md`.
- Diff: uncommitted on top of `dbd6048` in `/Volumes/Sandisk/github/techteam-conductor-v2`. M8-4's files in the same tree are not part of this review.
- Requested by: TechTeam Backend (agent af7354a4c9c53397b).
- Reviewed by: TechTeam Reviewer, 2026-10-21.
- I ran both gates myself:
  - `npm run check`: clean (exit 0).
  - `npm test`: 1075 tests, 1071 pass, 0 fail, 4 skipped (exit 0).

Verdict: Approved

Round 1 had two blocking findings (B1, B2). Round 2, 2026-10-21: both are fixed and verified; see "Re-check (round 2)" at the end. Round 1 text is kept below for the record. Everything else checks out against the plan, the contracts and the Security conditions I could verify in code. Send the fixes back and I will re-check only them.

## Blocking

### B1. Brief calls ignore the user's limit rule and never record account pauses

Where: `src/briefs/service.ts`, both `callAgent(...)` calls (work brief: role `requirements`; research brief: role `context`).

- Neither call passes `rule`. `Agents.readOnly` then calls `route()` with `rule: undefined`, and `route()` defaults to `'switch'`. "Design the work" and the research intake therefore always switch on a limit, even when the stored or effective rule is `same` or `wait`.
- That breaks two things:
  - the C1 contract: callers apply `effectiveLimitRule`;
  - the brief's F8 rule that `same`/`wait` never change tool.
- Neither call passes `onLimit` either, so `callAgent` uses its no-op default. A mid-call hop past a limited account records no pause on that account, and later stages and asks try that account again.
- Fix:
  - pass `rule: effectiveLimitRule(cfg)` (through a dep, as `AskService` does) and an `onLimit` that records the account pause;
  - make `rule` **required** in `ReadOnlyReq` and `CallAgentReq`, with no silent `'switch'` default at the call boundary, so `tsc` catches the next caller. The T9 static test only proves nobody reads `pipeline.limitRule` directly. It cannot prove a caller passes the rule.
  - add a test: under `same`, a brief whose head account hits a limit mid-call does not hop to another tool, and the account pause is recorded.

### B2. Under `same`, a limit on a fallback tool's account pauses the run, then resumes it on the next tick

Where: `src/agents/routing.ts` (step 3: `crossOnLimit` is false for every candidate of a later tool), together with `Stages.onLimitHit` and `Engine.schedule`/`blockedByPause`.

Scenario: rule `same`; planning chain `[claude, cursor]`; Claude is not installed (a non-limit reason, so the later tool follows, D-B); Cursor has `default` and a signed-in `cursor-personal-xxxx`.

1. Mid-call: Cursor `default` hits a limit. The next candidate, Cursor personal, has `crossOnLimit: false`, so no hop happens. The stage returns a limit.
2. `onLimitHit` re-routes. `candidates[0]` is Cursor personal with `crossOnLimit: false`, so the run is **paused**: a "Paused — … usage limit reached" comment, a notify, and `limitPauses + 1`.
3. On the next tick, `blockedByPause` gets `route().ok`. The run "continues on Cursor · Personal" and starts at once.

So under `same`, a fallback tool's account switch becomes a pause/resume flap. The comment and notification are wrong, and each flap counts toward the cap of 6 paused episodes (needs_human). Moving to another account of the **same** tool is exactly what `same` allows. The flag is too strict, and `onLimitHit` and the scheduler disagree about what may run.

Fix (either option is fine):

- (a) Under `same`, set `crossOnLimit` on a later tool's candidate from "is it the same tool as the candidate it would follow", or simply let callers advance after a limit when `next.id === current.id` (not under `wait`).
- (b) Make `onLimitHit` restart, rather than pause, whenever the re-route has a candidate the scheduler would start, so the two decisions are one decision.

Add the named test: "same: head not installed, Cursor default limited mid-call ⇒ continues on Cursor · Personal; no Paused comment; limitPauses unchanged". Add the same case through `onLimitHit` (build path).

## Non-blocking (fold in or answer)

- **N1. Escalate to Security: `--safe-mode` does not stop a planted `settings.json`.**
  - The L3(b) evidence (`.techteam/runs/evidence/m8-3-live.md`) shows a planted `apiKeyHelper` runs and `env.ANTHROPIC_BASE_URL` is honoured. This held for `auth status`, discovery, read-only stages and research, all under `--safe-mode`.
  - For named folders the pre-flight now refuses `settings.json`, which is correct.
  - But the same applies to the **default** account's real `~/.claude/settings.json`, which every stage and discovery reads today. Any same-user process can write that file, including a Cursor builder's shell running untrusted repository content.
  - This is pre-existing and not an M8-3 regression. It still contradicts the M8-1 S5 assumption ("no hooks under `--safe-mode`") and needs a Security ruling. Options:
    - scan or refuse a risky default `settings.json` at stage start;
    - or document it as an accepted residual.
  - Also record the related TOCTOU: a planted file in a named folder between the pre-flight and a running session that hot-reloads its settings.
- **N2. `listenControl` now throws on a bad `<home>/run`.** That ends `conductor start` (`cli.ts:177`), while S11 says "no socket". Either catch the error, log it and start without the control socket, or confirm the stricter behaviour with Security and say so in the start error.
- **N3. The startup sweep can delete every named folder after a config recovery.** `sweepOrphanFolders` removes folders whose id is not in config. If `config.json` was quarantined or reset (corrupt or newer file, or a fresh default), every named folder is deleted without sign-out, which can orphan Claude Keychain items. Skip the folder sweep whenever the config was not loaded cleanly from an existing v7 file, or move it to the next clean start.
- **N4. Misleading "unavailable" wording.** A named Cursor account always becomes `unavailable` after its first check, because `cli-config.json` is not allowed while `CURSOR_DOT_ALLOWED` is empty (deviation 2). The view then says "Its folder failed a safety check. Remove and add it again." Re-adding fails the same way. While the cause is the empty L4c allow-list, show "Not supported yet (awaiting a live check)".
- **N5. Brief aborts on removal are labelled `limited`** (deviation 5). That only reuses the refund, but `limited` drives the "Try again at HH:MM" UI, with no `retryAt` here. Refund through the same path, but end with its own reason (or `errorKind: 'failed'` plus the refund), so the UI does not show a limit.
- **N6. `accountRemoved` can overwrite another transition.** It sets every hit run to `queued` unless it is terminal. If the aborted attempt raced into `needs_human` or `awaiting_approval` (for example, an unrelated failure in the same moment), that state is overwritten. Re-queue only when the run is still `running` (or `queued`).
- **N7. Evidence and docs nits.**
  - `m8-3-live.md` cites `test/accounts/profile.test.ts`; the file is `test/accounts/env-profile.test.ts`.
  - The L1 table lists `.claude.json.lock` as a dir. Keep the allow-list kind in step if L2 shows it as a file.
- **N8. `recover()` re-seeds only `run.account`.** When the pause covered several accounts, the others are retried once after a restart, and those attempts are refunded. That is acceptable under D-E. Mention it in ARCHITECTURE next to "pauses stay in memory".

## The deviations you asked me to judge

| # | Deviation | Ruling |
| --- | --- | --- |
| 1 | TODO 4 only as far as L1/L3/L4a allow: `ACCOUNT_LOGIN_ENABLED = false`, `CURSOR_DOT_ALLOWED` empty, `CURSOR_ACCOUNT_HOME_BUILD_VERIFIED = false`, `ACCOUNT_TOOLCHAIN_VARS` deferred | **Accepted.** This follows the §2S unblock gates. All are code constants with static messages. |
| 2 | Named Cursor becomes `unavailable` after its first check (L4a: the CLI writes `cli-config.json`) | **Accepted** as fail-closed and visible. Fix the wording (N4). |
| 3 | The router honours provider-level health for every account (default auth = provider auth; pause = max(account, provider)) | **Accepted.** `routeStates` derives the provider pause only when every enabled account is paused, so the max never extends an account beyond its own pause. AC1 runs with and without `accounts[]`. |
| 4 | An ineligible research route keeps today's behaviour (Claude default directly) | **Accepted.** `startResearch` refuses a non-safe-mode isolation first, so this only applies to hand-edited roles. |
| 5 | Brief aborted on removal ends `limited` so it is refunded | **Accepted with N5.** |
| 6 | HTTP DELETE refuses `keepSignin`; it is CLI-only through the socket | **Accepted.** This matches §2.6 and S8. `accountRoute` refuses the key unless `opts.cli`. |
| 7 | UI: popover, banners, Settings "Accounts and limits", card chips | **Accepted for code.** The diff adds no `innerHTML`, `insertAdjacentHTML`, `outerHTML` or inline handlers (grep). The `ui-safety` test is green. Scripted browser checks belong to M8-5 and the UI evidence round. |

## What I verified (beyond the green suite)

- **AC1 byte-identity.**
  - `test/routing-accounts.test.ts` carries a verbatim copy of the pre-M8-3 `route()`. I diffed it mechanically against `git show dbd6048:src/agents/routing.ts`: only local type names, blank lines and comments differ.
  - It runs 6000 seeded cases × {without, with `accounts[]`} = 12 000 comparisons.
  - It compares `ok`, `kind`, `reason`, `pauseUntil`, `provider`, `usedComplexityPick`, candidates (`id`, `tier`) and skipped (`id`, `why`). Every candidate is `default`.
  - Default skip wording stays the bare tool label (`who()`).
  - The argv goldens are untouched.
- **Step 5 (S set).**
  - Only credentialed accounts enter `sick`, meaning defaults and named accounts with `auth === 'ok'`. Never-signed-in and signed-out named accounts go to `later`.
  - Paused requires a non-empty S set in which every member is paused. The fallback picks only a non-paused default; otherwise the route is `ineligible`.
  - Named tests cover "never turns a pause into a failure" and the B1 example.
- **Step 3 and the mid-call rule.**
  - Under `same`/`wait`, a limited head with nothing usable returns `paused` before later tools are added.
  - `Agents.readOnly`, the research loop (`asks/service.ts`) and `onLimitHit` all check `crossOnLimit` after a limit. Spawn and auth errors still advance.
  - Gap: briefs (B1) and the sibling case (B2).
- **C1.**
  - `limit-rule.ts` matches the plan text verbatim, with M8-4's first-line branch present.
  - The engine, stages, graph-build, the summary call, asks and research all pass `effectiveLimitRule`; briefs do not (B1).
  - `toSettings` reports `limitRule` and `limitRuleEffective`. `PUT /api/settings` is strict for `limitRule` and refuses `limitRuleEffective`.
- **v7 migration.** `migrateConfigV6ToV7` gives every tool its `default` account and `limitRule: 'switch'`. It is idempotent, `CONFIG_SPEC.current` is 7, and the backup and newer-file refusal are tested (`store.test.ts`).
- **Engine.**
  - Pauses are keyed by account, with a 24 h cap. `quotaMap` is keyed by account, and `status().quota.claude` uses the Claude head account.
  - `routeStates(role)` sets `webResearchIsolated` from code (Claude in safe-mode only).
  - `schedule()` computes states once per role per tick (N4, tested). It re-routes limit-paused runs regardless of `pausedUntil`, writes one "continues on" history line, and `blockedByPause` sets `pauseKind: 'limit'`.
  - `resume()` is scoped to the role's chain and complexity pick.
  - A human restart resets `limitPauses`.
  - `recordLimitPause` and `onLimitHit` throw without an account, so the account is never silently `'default'`.
- **Episodes.**
  - `limitEpisodeFromHops` writes one `limit:ep<n>` comment and one notify per opening episode. It merges the fallback comment (including the tier sentence) when the tool changed on a limit, and leaves non-limit tool hops with today's fallback comment.
  - The cap counts `limitPauses` once per episode (`limitPausedEpisode`).
  - Tests cover three hops ⇒ 1 + 1, and 7 successful switches ⇒ never needs_human.
- **Env and folders (S1–S5, S9, S14, S17, S18, S24).**
  - `accountEnv(default)` is exactly `claudeEnv`/`cursorEnv`, plus the reverse assertion.
  - Named accounts drop the credential lists from both `src` and `extra`, and set the credential-locating keys last.
  - The pre-flight runs inside `accountEnv`, so no spawn path can skip it.
  - `assertAccountEnv` runs on the final env in every adapter, including the Cursor build after the envelope fragment and the stripped git env.
  - The leaf folder is created with a non-recursive mkdir; `EEXIST` ⇒ refuse.
  - The `.claude.json` key check, the depth-2 link check, `nlink === 1`, and `auth.json` (lstat and chmod only) are all in place.
  - The S9 lease is taken in `childEnv`, in `logout`, and in discovery via `envFor`/`afterDiscovery`.
  - Named Codex is refused in `accountEnv` and disabled in `routeStates`.
  - `accountBuildOk` returns false for named accounts.
- **Removal (S8, N3).** The order is: mark removing ⇒ `engine.accountRemoved` (stop, refund, re-queue with a moved note) ⇒ abort asks, research and briefs ⇒ `waitAccountIdle` ⇒ logout (constant argv, 20 s, its own lease) ⇒ wait idle ⇒ delete the folder with no-follow ⇒ delete the cache and call `forget` ⇒ save config. A test removes an account during a running ask.
- **Home.**
  - `gate()` runs before `takeKeyed`.
  - Mid-call exhaustion ends `failed`/`limited` with `retryAt`, and refunds exactly once (`takenKey` / `refunded`).
  - The ask store validates the new fields with own-property checks and a pattern for `takenKey`.
- **API and control socket (S11–S13).**
  - `accountRoute` is the one shared method + path table.
  - HTTP mutations go through the existing CSRF gate (403 tested).
  - The control socket has an exact route allow-list, a ≤ 16 KB JSON body, a 0700 run-dir check and no login route.
  - Strict bodies refuse unknown keys, credential-shaped keys and `__proto__`.
  - Views are rebuilt from an allow-list of keys.
  - The CLI's direct mode holds the lock for the whole command.
  - Writers are persist-then-swap, and a failed add removes its folder.

## Record

- Artifact: `.techteam/reviews/workspace-v2-m8-3-code-review.md`
- Next action: Backend fixes B1 and B2 (each with a named test) and answers N1–N8, or folds them in. N1 goes to Security. Then re-request; I will re-check B1 and B2 and the related tests only.

## Re-check (round 2, 2026-10-21)

- Gates, run myself: `npm run check` clean; `npm test` 1079 tests, 1075 pass, 0 fail, 4 skipped.
- **B1 fixed.**
  - `rule: LimitRule` is now required in `ReadOnlyReq` (`src/agents/provider.ts:51`) and `CallAgentReq` (`src/agents/caller.ts:34`), so tsc enforces it at every caller.
  - Both brief calls pass `effectiveLimitRule(cfg)` plus an `onLimit` that records the account pause (`src/briefs/service.ts:310,379`; `accountPause` wired in `runtime.ts`).
  - AskService has no silent default any more.
  - Test: "code review B1: briefs apply the limit rule and record account pauses".
- **B2 fixed.**
  - `crossOnLimit` is now relative to the previous candidate (`routing.ts:199`). Under same/wait, only the step from a head candidate to another tool is blocked.
  - A fresh route's first candidate is therefore always reachable, so `onLimitHit` restarts exactly when the scheduler would start.
  - Tests:
    - routing: "code review B2: under same, a limit may move between accounts of a FALLBACK tool";
    - engine: "code review B2: same — head not installed, Cursor default limited mid-call ⇒ continues on Cursor · Personal; no Paused comment; limitPauses unchanged", which covers the read-only path and `onLimitHit`.
- **N1–N8:** answered or folded in, per the backend's report.
  - N6 has a test.
  - N1 is with Security as F1 (pre-existing, High) and routed to the Lead; it is not an M8-3 gate.
  - I did not re-test N2–N5 and N7–N8 beyond the green suite. I check them in the final integration diff.
- **New note (non-blocking).** With a chain of three or more tools, a head that is unusable for a non-limit reason, and a limit on the first fallback tool, the run may still move to a second fallback tool under same/wait. This matches the plan's D-B text ("the restriction applies to the head tool") and today's non-limit fallback. If the user wants "never change tool on a limit" to cover fallback tools too, that is a one-line change plus a test.
- Decision: **Approved.** The live gates in §2S still apply: login stays disabled, and named-Cursor builds stay off until L5.
