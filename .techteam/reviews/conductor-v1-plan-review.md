# Plan review

Reviewer agent only. Silence is not approval. Do not fabricate this record.

- Task / Linear issue: none (no Linear connector this session; tracked in `.techteam/runs/active-run.md`)
- Plan artifact: `.techteam/plans/conductor-v1.md` (**revision 2.1**)
- Reviewed by: Reviewer (independent; did not author the plan)
- Reviewed at: round 1 on 2026-10-20 (Changes requested); round 2 on 2026-10-20 (Changes requested, B1 to B5); **round 3 (final delta re-check) on 2026-10-20**
- Decision: **Approved**

This approves the plan, not any diff. It unlocks implementation in the same session. Approval is conditional only in the sense that the "Carry-forward" items below are binding on implementation and will be checked at the code-review gate. None of them requires a plan re-review. The plan's own status line should now be set to `approved` by the Lead (I did not edit the plan).

## Checklist (round 3)

1. **Codebase analysis is complete enough to implement safely: Yes.** Greenfield. The external-contract analysis is evidence-based and I re-verified it (init events, transcript canaries, Linear SDK types, the deny/push probes). Two unproven assumptions are labelled as such in the plan: Cursor stdin prompt (no saved artefact) and the extra deny entries beyond `Shell(git:push*)`.
2. **Every task requirement is covered: Yes, honestly stated.** R4's Cursor half is explicitly a decision-deferral, not a "platform limit", and needs the user's acceptance. No requirement lacks a planned change plus a verification method.
3. **Proposed architecture is correct: Yes.** The resume matrix, park semantics, backup refs, idempotent effects, failure-set baselines and fail-closed init predicate are sound. Residual refinements are carried below.
4. **Affected-file list is accurate: Yes.** All Create; coherent; `docs/API.md`, `lock.ts`, `redact.ts`, `secrets.ts`, `ops.ts`, evidence and final-report paths are present.
5. **Security, authorization, compliance: Yes, as defence-in-depth under a stated same-user threat model.** creator-only plus history attribution, OTP and cookie on all routes, env allowlist, redaction, deny rules plus env neutralisation plus cli.json hash guard. The plan no longer claims what the live evidence disproves (outside reads by a `--force` builder are not preventable).
6. **Testing strategy is adequate, including negative/authz cases: Yes.** AC to test table, SDL validation, adversarial live E2E, the new B1 to B4 tests (`claude-init-failclosed` on real init events, `baseline-masking`, `flaky-gate`, `drag-to-backlog-parks`, `reset-keeps-backup-ref`, `subissue-never-picked`, attribution tests, `error-max-turns`).
7. **Risks, dependencies, acceptance criteria explicit: Yes, with stale text to fix** (see doc-consistency items; none changes the design).

## Coverage confirmation

- Requirement mapping is complete: **yes**
- Gaps that block approval: **none**

## Round-1 required changes: final status

| RC | Topic | Status | Notes |
| --- | --- | --- | --- |
| RC1 | Trigger authz | **Resolved** | creator-only (server `creator.isMe` plus client re-check); attribution via `issue.history` added in B4. Creation-time semantics carried (C1). |
| RC2 | Claude isolation | **Resolved** | Predicate fixed (B1). Verified against my own runs of the final flag set. |
| RC3 | Cursor isolation, no-push, cross-stage | **Resolved (residual disclosed)** | Cursor cannot be isolated; mitigations and live-proven deny rule are in; guard for `.cursor/cli.json` added. |
| RC4 | Secrets and env | **Resolved** | Env allowlist, Keychain via stdin, redaction, honest threat model. |
| RC5 | Dashboard auth | **Resolved** | OTP to cookie on all routes, whitelist static, runKey-only actions. |
| RC6 | State machine | **Resolved** | Park semantics and backup refs added (B3). |
| RC7 | Verification integrity | **Resolved** | Failure-set baselines, flake rerun, `unverified` policy (B2). Line-number key issue carried (C2). |
| RC8 | R4/R6 honesty and visibility | **Resolved** | R4 and R6 wording corrected (B4, B5). |
| RC9 | Test plan | **Resolved** | |
| RC10 | Completion honesty | **Resolved** | Claude half stays fixture-only until the post-reset checklist. |
| RC11 | Hygiene | **Resolved** | Stale leftovers listed under doc-consistency. |

## Round-2 blocking items: final status

| Item | Status | What I checked |
| --- | --- | --- |
| B1 init predicate | **Resolved** | §2 line 125 gives `tools=={Read,Grep,Glob,StructuredOutput}` ∧ `mcp_servers==[]` ∧ `skills==[]` ∧ `slash_commands==[]` ∧ `permissionMode=="dontAsk"`, with `plugins` and `agents` informational. This matches my own run of the final combination: tools `[Glob,Grep,Read]` (plus `StructuredOutput` with `--json-schema`), `mcp []`, `skills 0`, `slash_commands 0`, `permissionMode dontAsk`, 35 plugins and 5 built-in agents listed. `error_max_turns` handling and per-stage turn caps are added. Nit: define the expected set as the base three plus `StructuredOutput` only when a schema is requested. |
| B2 baseline masking | **Resolved** | §2 line 118: failure-set comparison where parseable; otherwise `baseline-failing, unverified for regressions`; lone count increase counts as regression; failing gate rerun once. Tests `baseline-masking` and `flaky-gate` named. |
| B3 destructive reset and Backlog | **Resolved** | Resume matrix rows: `backlog/triage` park (no action), only `unstarted` re-runs, backup ref `refs/conductor/<key>/prev-<rev>` before any reset, sub-issues never carry the trigger label, poller ignores children of a run, first-approval persisted, complexity L always approved. Tests named. |
| B4 attribution, no-push, R6 | **Resolved** | History attribution specified at claim and each stage. No-push rewritten as defence-in-depth. Matches the live evidence I re-read in `/private/tmp/claude-501/s3b`: probe A (`allow:[]` + `deny:["Shell(git:push*)"]`) left its remote with only `main`; probe B (`Shell(git:push)`) and probe C (no cli.json, explicit URL) both ended with a `probe` branch on the remote. The secret file is a plain readable decoy (the plan says outside reads are not preventable). R6 row now says "defence-in-depth under a same-user threat model". AC7 uses an adversarial prompt, and the cli.json SHA guard is in. |
| B5 R4 honesty | **Resolved** | R4 row and §2 visibility bullet say the Cursor half is deferred by decision (route exists), require the user's acceptance in the final report, add S5, and S1 is runnable now with the user's go-ahead. S2, S3 and S4 are recorded as done in §1. |

## Notes

### Independent re-verification this round

| Claim | Verdict |
| --- | --- |
| Deny form `{"allow":[],"deny":["Shell(git:push*)"]}` blocks push; exact `Shell(git:push)` does not | Corroborated by the remote ref listings in `s3b` (A blocked; B pushed). I did not re-run the model. |
| Explicit-URL push succeeds without the deny rule | Corroborated (probe C remote has `probe`). |
| `--sandbox enabled` blocks neither push nor outside read | Not re-verified (needs a model call); plan correctly does not rely on it. |
| Cursor builder reads `techteam-ops/SKILL.md` and announces "Using SoftCo Lead" | Verified in `fixtures-raw/cursor-build.ndjson`. Retired SoftCo text is still steering Cursor. |
| Ask-mode JSON arrives as prose plus a fenced block | Verified in `fixtures-raw/cursor-ask.ndjson` (`extractJson` must tolerate leading prose). |
| Prompt on stdin works for Claude | Verified (earlier transcript marker). |
| Prompt on stdin works for Cursor (`STDIN-CURSOR-OK`) | **No saved artefact found; not verified.** The plan's Cursor argv builder should re-prove it or stay on argv. |
| Keychain write/read/delete via `security -i` | Not re-verified (no artefact to inspect). |
| `~/.cursor/rules` has 7 `.mdc` files | Verified. |

### Decisions I was asked to challenge (final)

- Labels-only default, deferral of Cloud Agents / My Machines, `--safe-mode` plus injected conventions, and manual approval for the first plan per repo: all agreed. The deferral is acceptable only with the user's explicit acceptance (see C6).

## Carry-forward into implementation (binding; verified at code review, no plan re-review needed)

**Must-carry (functional or safety):**

- **C1. Attribution at creation time.** An issue created with the trigger label (or description) has no `issue.history` entry for it. Define "no history entry for the label or description ⇒ creation-time ⇒ attributed to the creator (viewer)", fetch all history pages, and add a fixture test `created-with-label-empty-history ⇒ accepted`. As written literally, "label added by the viewer" would make Conductor ignore every issue created with the label already on it.
- **C2. Failure-set keys must not include line or column numbers.** For tsc and eslint use `file + code + normalised message` (multiset count if duplicates), otherwise a pre-existing error shifts line number after the builder edits the file and is reported as a new regression. Add a `baseline-line-shift` test. Re-install dependencies before post-build gates when the lockfile or manifest changed.
- **C3. No-push matcher bypasses.** The `Shell(git:push*)` deny is a prefix glob. The AC7 adversarial prompt should also try `git -c k=v push`, `/usr/bin/git push`, `env git push` and `sh -c 'git push …'`, and report the outcome either way. The other deny entries (`gh`, `security`, `osascript`, `sudo`) are extrapolated from the proven form; assert at least `Shell(security:*)` and `Shell(gh:*)` in AC7 or label them unproven.
- **C4. Pickup state.** Pickup stays `unstarted` only by default (my B3 required this), but many Linear teams create new issues in `backlog`. The Setup wizard must read the team's default new-issue state and tell the user ("new issues land in Backlog: drag to Todo, or enable `pickup.fromBacklog`"), and must check that an `unstarted` state exists. Make `pickup.fromBacklog` a setting (default off). Otherwise "create an issue with the label" silently does nothing for those teams.
- **C5. Backup ref and dirty trees.** `refs/conductor/<key>/prev-<rev>` points at HEAD only. When discarding uncommitted work, also capture it (for example `git stash create` stored under the same ref namespace).
- **C6. R4 decision with the user, early.** The user explicitly asked to see tasks in the Cursor app. Do not wait for the final report: ask the user to run S5 (1 minute) and to accept or reject the deferral before Phase 5 UI work, because S5's answer may remove or change the v1.1 scope.

**Doc-consistency fixes (do at the start of P0; verified at the first code-review gate):**

1. §2 line 84 still says native state type `unstarted/backlog` means retry/re-plan. The resume matrix is authoritative: `backlog/triage` is park.
2. §6 line 252 still says "no push (structural)" and line 254 still says the deny syntax and `--sandbox` are unproven although S3 is done.
3. AC7 (line 153) says "secrets path unreadable/unreferenced", which contradicts §1, §2 and §5 (outside reads by a `--force` builder cannot be prevented). Reword to "no secret value appears in the diff, commit, Linear comment or logs (redaction); outside read documented, not asserted".
4. §4 P7 line 211 still says "spikes S1–S4"; only S1 and S5 remain.
5. The revision log rows for RC3 ("structural no-push") and RC8 ("R6 now fully covered") are superseded by B4; mark them historical.

**Suggestions:** `doctor --isolation` greps an internal transcript format (keep it doctor-only, add a `--debug-file` fallback); cookie is host-scoped not port-scoped (consider a per-origin header token); prefer copy-only Terminal actions; move any remaining live spikes before the code that depends on them; if time slips, cut `service install`, then demo polish, then the plan-review pass for M complexity.

## Residual risks accepted

Prompt injection into a `--force` builder is reduced, not removed; a same-user builder can read any file the user can. Cursor isolation relies on mitigations, not flags. The Claude half stays fixture-only until the post-reset checklist (after 2026-10-21 14:00 BST); `--json-schema` result placement in stream-json is still unverified (text-JSON fallback kept). Linear is not live-tested until the user runs `doctor --linear`.

## Record

- Linear comment or artifact path: `.techteam/reviews/conductor-v1-plan-review.md`
- Next action: **implement in the same session** (Phase 0 onward), carrying C1 to C6 and the doc-consistency fixes. Set the plan status to `approved` and record the approval time in `.techteam/runs/active-run.md`.
