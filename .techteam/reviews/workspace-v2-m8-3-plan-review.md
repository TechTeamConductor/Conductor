# Plan review: M8-3 Accounts and automatic switching (F8 engine + API/CLI)

Reviewer agent only. Silence is not approval. Do not fabricate this record.

- Task: brief F8 plus API/CLI. Slice 3 of M8 (`.techteam/plans/workspace-v2-m8.md`).
- Plan artifact: `.techteam/plans/workspace-v2-m8-3.md`, rev 2 plus the R2 fixes (file time 2026-10-21 11:25). Author: agent abc732b6677fdd931.
- Reviewed by: TechTeam Reviewer (independent of the author)
- Reviewed at: 2026-10-21
- Rounds:
  - rev 1: five blocking findings (B1–B5), sent to the author by message;
  - rev 2: two new blocking findings (R2-B1, R2-B2);
  - final text: every blocking item is closed. I checked each fix in the plan text myself, not only the author's summary.
- Decision: Approved with conditions. The conditions are the non-blocking items N1–N8 below. The Lead may fold them in without another Reviewer round, and I check them at the code review.

Verdict: Approved with conditions

## Inputs

- `CLAUDE.md`, the brief `.techteam/briefs/product-layer.md` (F8, F9, §6, Decisions, §7).
- Plans: `workspace-v2-m8.md`, `-m8-1.md`, `-m8-2.md` (rev 2, approved with conditions: `select.ts`, config v6), `-m8-4.md` and its review (C1 / B2a), `-m8-6.md` (C3 `accountsGate`).
- Security design: `.techteam/reviews/workspace-v2-m8-3-security-design.md` (S1–S25; approved with conditions).
- User decisions relayed by the Lead on 2026-10-21:
  - D-A: chain-only;
  - Q4: each tool's own CLI login. Claude uses a per-account `CLAUDE_CONFIG_DIR`. Cursor uses a per-account HOME plus `AGENT_CLI_CREDENTIAL_STORE=file`. No API keys.
- Code read at clone HEAD `8eaab46` plus the working-tree M8-1 diff:
  - agents: `src/agents/{routing,roles,env,provider,caller,claude}.ts`, `src/agents/providers/{claude,cursor,codex,static,verification}.ts`;
  - pipeline: `src/pipeline/{engine,stages,envelope}.ts`;
  - other: `src/asks/service.ts`, `src/limits/budget.ts`, `src/secrets.ts`, `src/config.ts`, `src/runtime.ts`, `src/server/http.ts`, `src/cli.ts`, `src/lock.ts`, `src/models/{service,sanitize,cache}.ts`.

## Current-state claims verified against the code

| Plan claim | Code | Result |
| --- | --- | --- |
| `route()` pure; gate → complexity pick (never a weaker tier for read-only roles) → health filter | `routing.ts:70-118`, tier rule at :93 | Correct |
| Pauses only when EVERY unhealthy provider is paused; otherwise the first non-paused one runs | `routing.ts:111-117` | Correct (this was rev-1 B1) |
| Research is not routed; no `webResearchIsolated` from `routeStates` | `asks/service.ts:~110-124` calls `claude.runResearch` directly; `providers/claude.ts:45-56` uses `claudeEnv`; `engine.ts:181-198` never sets `webResearchIsolated` (grep: only `routing.ts:22,53`) | Correct (rev-1 B2) |
| `Engine.pauses` keyed by provider, 24 h cap; `quotaMap` keyed by provider | `engine.ts:87,97,138-141,200-207` | Correct |
| Read-only hops call only `onLimit` ⇒ `recordLimitPause`; the tool hop leaves a `fallback:` comment | `provider.ts:106-120`, `stages.ts:231-235,399,413-417` | Correct (rev-1 B3a) |
| `pauseForLimit` streak/episode, cap 6, refunds | `stages.ts:242-271,337-339` | Correct |
| `blockedByPause` sets no kind; `resume()` clears all pauses; `summariseCall` uses a no-op `onLimit` | `engine.ts:649-690,856-862,373` | Correct |
| Envelope env: `FORBIDDEN_PREP_ENV` plus `envAllow`, and the git env wins; Cursor build composes `cursorEnv({...extraEnv, ...req.env})` | `envelope.ts:22-29,103-113`, `providers/cursor.ts:65-69` | Correct |
| Control socket serves only `/otp` and `/status`, mode 0600 | `server/http.ts:104-134` | Correct |
| `CONFIG_SPEC` v5, backup before the first save, `assertNotNewer` | `config.ts:46,219-241` | Correct |
| Default chains: context/requirements/architecture/research are Claude-only; planning/review/verification are `[claude, cursor]` | `roles.ts:55-69` | Correct. This is why rev-1 D-A (go beyond the chain) broke AC1. Chain-only closes it. |
| M8-1 seams `view/refresh/noteUnknownModel(…, account)`, `forget`, `envFor`, `accountIds`; `ACCOUNT_RE` exported | `models/service.ts:45-47,120-255,315`; `models/sanitize.ts:17` | Present in the working tree |
| The M8-2 selection table is copied verbatim | diff of M8-2 lines 327-333 against M8-3 §2.C (indentation ignored) | Identical |

## Checklist

1. **The codebase analysis is complete enough to implement safely: yes.** Every load-bearing claim in §1 checks out (table above). Rev 2 adds the facts that rev 1 missed: research is not routed, today's step-5 rule, the envelope env path, and that Conductor commits with its own git process.
2. **Every task requirement is covered: yes.**
   - Every brief §7 router item has a named test in §5:
     - same-tool next account;
     - next chain tool with its default model and fitted effort;
     - an account lacking the model is skipped (Q7) and D-D;
     - an ineligible tool is never chosen;
     - `same`/`wait` never change tool, including mid-call;
     - nothing usable ⇒ pause until the earliest reset, including the S-set case;
     - reset or new account ⇒ resume;
     - removed account ⇒ restart.
   - Every other F8 clause also has a named test: restart on limit, refunds, a reset never interrupts a stage, Home never queues, one toast and one comment per episode, purity, store/migration/backup, env allow-list, and name sanitising.
   - Two gaps are stated honestly: named-Cursor builds wait for L5 (D-G/S17), and Codex accounts stay dormant (Q5).
3. **The proposed architecture is correct: yes.** It keeps the existing shape. The router stays pure, and accounts are candidates under providers. Pauses are keyed by account. One `effectiveLimitRule` is the only reader of `pipeline.limitRule`. The envelope owns the account build env, and `FORBIDDEN_PREP_ENV` is unchanged. Hygiene is invoked inside `accountEnv`, so no spawn path can skip it.
4. **The affected-file list is accurate: yes.** Every "Modify" path exists. `src/models/service.ts` is correctly "no change expected", because its seams are present. `src/accounts/*` is new.
5. **Security, authorization and compliance are addressed: yes.**
   - §2S binds S1–S25 and says the Security file wins.
   - Credentials are never read by Conductor. A static test and a decoy grep (S22) check this.
   - A fresh nonce per add prevents re-using an old folder (B4/S8).
   - Removal signs out by default.
   - Control-socket routes come from an exact allow-list (S11).
   - CSRF on every HTTP mutation.
6. **The testing strategy is adequate: yes.**
   - Golden byte-identity for default-only accounts (AC1), including the rev-1 B1 example.
   - Negative and authorization cases: strict bodies, CSRF 403, credential fields, traversal ids, planted entries, a forged env with zero spawn, decoy greps.
   - Live checks L1–L5 are stop conditions, run only with the user's permission.
7. **Risks, dependencies and acceptance criteria are explicit: yes.** See the sequencing section below.

## Focus items requested by the Lead

- **`route()` purity and determinism with accounts.** Account states (auth, pause, `offersModel`, `buildOk`) are computed by the caller and passed in, and `now` and `rule` are inputs. Nothing in the router reads the clock, config or I/O. The tool order is the chain order (chain-only), so object-key order no longer matters. The extended purity test is planned. **OK.**
- **Brief §7 router tests.** All present (checklist 2). The mid-call `same`/`wait` tests and the S-set test were added in the R2 round. **OK.**
- **D-A assessment.**
  - Rev 1's "switch to any tier ≥ partial tool" matched the prototype but widened who runs a role. Claude-only roles (context = Quick Ask, requirements, architecture) would move automatically to Cursor ask mode. That is a weaker tier, which the existing complexity-pick rule (`routing.ts:93`) deliberately refuses.
  - With Codex, a same-user-writable canary record (`verification.ts` comment) would also have auto-enrolled Codex, contrary to D8.
  - And because the migration sets `switch` globally, it broke "default routes are v1's" (AC1).
  - The user chose chain-only, and S10 pins it with a static and property test (candidate tools ⊆ chain ∪ complexity pick). **Closed.**
  - Product consequence, now documented: `switch` cannot move a Claude-only row to Cursor unless the user adds Cursor to that row's chain. M8-5 may want a hint (N7).
- **Byte-identical behaviour with default accounts only.**
  - Chain-only, today's step-5 rule (kept exactly for default-only, and extended by the S set for named accounts), and default env = exactly `claudeEnv`/`cursorEnv`/`codexEnv` together give byte-identity.
  - The S2 reverse assertion holds for the default account: no `AGENT_CLI_CREDENTIAL_STORE` and no named path.
  - AC1 golden tests run over role × complexity × health fixtures. **OK.**
- **v7 migration.**
  - `limitRule = 'switch'` always: chain-only `switch` with one account per tool is today's chain walk.
  - `onClaudeLimit` stays as a derived, deprecated read field for one version, and `PUT {onClaudeLimit}` keeps editing chains (documented effect under `same`/`wait`).
  - A backup is taken by the existing `backupBeforeNextSave`, and a newer file is refused.
  - **OK.** Rev 1's chain-length-based derivation was dropped correctly once D-A became chain-only.
- **Engine changes.** All of these are specified, each with a test:
  - per-account pauses (24 h cap);
  - per-account quota;
  - `onLimitHit` (re-route ⇒ restart or pause);
  - tick re-check of every `pauseKind:'limit'` run regardless of `pausedUntil`;
  - `blockedByPause` sets `pauseKind`;
  - restart on removal (abort + refund + same `next`, not counted as a human restart, partial edits documented);
  - scoped `resume`;
  - one comment and one notify per episode on every path, merged with the `fallback:` comment;
  - the cap counts only episodes that end in a pause, so successful switches never park a run;
  - rejected attempts refunded (existing `refundIfLimit`; hops inside one read-only call are one attempt);
  - the limit account always taken from the candidate the caller ran.
- **CLI over the control socket vs direct under the lock.**
  - With a server: the same strict handlers on the 0600 socket with an exact route allow-list, and no login route (S11).
  - Without one: the lock is held for the whole read-modify-write and the removal sequence (S13).
  - `login` writes no config.
  - This matches the existing `discover` pattern (`cli.ts:207-231`). **OK.**
- **Contracts.**
  - M8-2: `sel.tool` binding and tri-state `modelOffered` match M8-2 rev 2. The table is identical. M8-3 passes the target account's `CatalogView`.
  - M8-4: C1 is in §2.C, covering everything the M8-4 review's B2a lists. That is the type, `effectiveLimitRule(cfg)` in `src/accounts/limit-rule.ts`, the stored field and its `'switch'` default, the two view fields, M8-4's first-line branch, the static single-reader test, and the meaning of `switch`.
  - M8-6: `accountsGate(role, sel?)`; 409 `limited` + `retryAt`; mid-call ⇒ `failed` + refund; `refund()` owned by M8-3 with a fixed signature.
  - M8-1: seams present; `ACCOUNT_RE` imported; `forget()` called on cache delete.
  - **OK.**
- **Sequencing.**
  - M8-4 depends on `src/accounts/limit-rule.ts`, which is in M8-3 commit 1.
  - M8-3 commit 1 needs M8-2's config v6 (N8).
  - The Security unblock gates are in §2S: TODO 1–3 after this approval; `profile.ts`/`env.ts`/login after L1, L3 and L4a–e; named-Claude login after L2; named-Cursor builds after L5 and the reviewed flip.

## Blocking findings and their closure

| # | Finding | Fixed in | Evidence |
| --- | --- | --- | --- |
| B1 (rev 1) | §2.2 step 5 changed today's "every unhealthy is paused" rule to "any paused", and D-A auto-switched Claude-only roles. Either way AC1 / "default routes are v1's" was false | §2.2 steps 1 and 5, D-A chain-only, AC1 | Step 5 keeps today's rule for default-only accounts. The AC1 fixture "Claude signed out + Cursor paused ⇒ Claude runs" is included |
| B2 (rev 1) | Research bypassed routing (`claude.runResearch` with `claudeEnv`). `route('research')` was always `ineligible` because `routeStates` never sets `webResearchIsolated`, so `accountsGate('research')` would always refuse or disagree with the run | §2.2 (`webResearchIsolated` from code), §2.3 Research | `ResearchRunReq.account`; gate and run share one route; `research-*` tests; side effect on `PUT /api/roles` tested |
| B3 (rev 1) | Episodes were undefined for read-only and research hops. The cap would park runs after 6 successful switches. `blockedByPause` set no kind | §2.3 Episodes, Auto-resume | `AgentOutcome.hops`; merged fallback comment; `limitPauses` counts only paused episodes; tests "7 successful switches ⇒ never needs_human" and "3 hops ⇒ 1 comment, 1 notify" |
| B4 (rev 1) | `<tool>-<slug>` ids reuse the same folder, so a re-added account inherits the old sign-in (Claude's Keychain item is keyed by config dir; Cursor's `auth.json` sits in the folder) | §2.0 naming, §2.6, S8 | 4-hex nonce per add, never reused; sign-out on remove by default; test "re-add ⇒ new id, not signed in" |
| B5 (rev 1) | Per-account Cursor HOME (new Q4) needed its env, builder consequences, config-file hygiene and assert rules | §2.4, D-G, S14, S17, S18 | Envelope-owned `accountBuildEnv`; `FORBIDDEN_PREP_ENV` unchanged; git/ssh unaffected (envelope git env, Conductor commits itself); hygiene of HOME and `.cursor`; named-Cursor builds fail closed until L5 |
| R2-B1 | The step-5 "every health-skipped account is paused" test counted never-signed-in named accounts. With every credentialed account paused plus one fresh, never-signed-in account, the result became `ineligible` (build ⇒ needs_human, ask ⇒ failed) instead of a pause | §2.2 step 5 (S set) | S = defaults plus named accounts with `auth === 'ok'`; the rule equals today's for default-only accounts; "adding an account never turns a pause into a failure"; named test added |
| R2-B2 | Under `same`/`wait`, a limit on the head's last usable account during `Agents.readOnly` could advance to the next chain tool (`advances('limit')`). Leaving later tools out would lose today's spawn/auth fallback instead | §2.2 step 3 (`Candidate.crossOnLimit`, mid-call rule) | Applies to `Agents.readOnly`, the research loop and `onLimitHit`. A limit advances only to a `crossOnLimit` candidate; spawn/auth still advance. Three named mid-call tests |

## Non-blocking findings (conditions; fold in or honour during implementation)

- **N1 One rule for `cli-config.json`.** §2.4 says `permissions.allow` must be absent or empty (stricter, accepted by Security R2-4). §2S's S14 summary still says "empty or a subset of the L4c-measured defaults", and §2S is declared to win. Make §2S state the R2-4 rule so the looser text cannot win by precedence. AC6 already tests the stricter rule.
- **N2 `crossOnLimit` under `wait`.** Under `wait` the pool is the head's first account only (step 2), so "false for every other account of the head tool" (step 3) never applies. Keep one statement, and make sure the code never builds those candidates.
- **N3 Abort ordering on removal.** S8 step 2 now aborts in-flight asks, research, briefs and checks. The account folder must not be deleted (S8 step 4) until every one of those children has been reaped. That is the per-account lock (S9). Test: "remove during a running ask ⇒ ask failed and refunded, folder deleted after the child exits".
- **N4 Auto-resume cost.** `schedule()` re-routes every limit-paused run on every tick, and `routeStates(role)` calls `modelOffered` per account. Compute the states once per tick per role, not per run.
- **N5 `moved` when the first account is signed out.** When the head tool's first account is never signed in or signed out, every run will carry `moved:'account'`. The note must say "is not signed in" (real reason, as specified), and the F5 chip should not show "Switched" for a non-limit skip. This is an M8-5 wording check; keep `Skipped.kind` in the run record.
- **N6 Starting state for named accounts.** A named account with `auth:'unknown'` (before its first check) is unusable. Make sure the startup check fan-out (M8-1 `accountIds`) runs at startup and that its completion calls `invalidate()` + `tickSoon()` (now stated). Otherwise a restart leaves named accounts idle until a manual check.
- **N7 Product hint for chain-only (M8-5).** Under `switch`, a Claude-only row (Quick Ask, Design the work, Deep Research) can only move between Claude accounts. The Accounts panel and the rule hint should say "another tool only if it is in that job's list". This avoids the user expecting design-style "another tool" behaviour.
- **N8 Sequencing gate.** M8-3 commit 1 (types, `limit-rule.ts`, config v7) must land after M8-2's config v6 commit. If M8-4 commit 1 needs `limit-rule.ts` earlier, the Lead records the order in `active-run.md`. Before M8-4's first edit, the Lead checks the landed names against C1 (M8-4 review B2b).

## Coverage confirmation

- Requirement mapping is complete: yes. Every row of §7 maps to a planned change and a verification method.
- Stated gaps that are accepted and do not block:
  - named-Cursor builds until L5 and the reviewed flip (D-G/S17);
  - Codex accounts until Q5 and a separate Security gate;
  - the live checks L1–L5, which the user runs.
- Gaps that block approval: none.

## Notes

- Security design is approved with conditions S1–S25 (`.techteam/reviews/workspace-v2-m8-3-security-design.md`). §2S binds them, and the unblock gates in §2S apply on top of this approval.
- This approves the plan, not the diff. At code review I will check:
  - every blocking fix above;
  - N1–N8;
  - the static tests (single reader of `pipeline.limitRule`; chain-only; no credential file reads; `accountBuildEnv` called only by the envelope);
  - the AC1 golden fixtures.

## Record

- Artifact: `.techteam/reviews/workspace-v2-m8-3-plan-review.md`
- Next action: implement in the same session.
  - TODO 1–3 (types/C1/store/migration, router, engine/stages/research/asks) may start now, after M8-2's v6 lands (N8).
  - TODO 4 and later follow the §2S live-check gates.
  - Then the Reviewer code review and the Security code review.
