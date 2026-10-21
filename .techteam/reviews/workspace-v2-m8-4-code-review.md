# Code review: M8-4 run mode, "Per settings | Complete auto" (commits 1–3, uncommitted)

- Plan: `.techteam/plans/workspace-v2-m8-4.md` (§2b B1–B3 binding, plus the N-items), approved in `.techteam/reviews/workspace-v2-m8-4-plan-review.md`
- Builder: TechTeam Backend (a6877ed060447c2d0)
- Reviewed by: Reviewer, 2026-10-21, working tree of `techteam-conductor-v2` on top of `dbd6048`. Only M8-4's hunks were judged; the M8-3 hunks in the same files were not.
- Security code checkpoint: Approved (reported by the Lead)

Verdict: Approved

No blocking items. The non-blocking notes below can be handled later or in M8-3/M8-5.

## Evidence I observed

- `npm run check`: clean.
- M8-4 suites plus regressions, with the preload (`run-mode`, `engine-run-mode`, `actor-trust`, `policy`, `engine-policy`, `briefs-send`, `server`): 63/63 pass.
- Full `npm test`: 1017 tests, 1013 pass, **0 fail**, 4 skipped. The earlier `asks.test.ts:127` failure caused by M8-3 no longer reproduces.
- B2(b) gate: the Lead's C1 name check is recorded in `.techteam/runs/active-run.md:36`. M8-3's approved plan carries C1 (`workspace-v2-m8-3.md:116, 366`).

## Conditions from the plan review

| Item | Code | Status |
| --- | --- | --- |
| Core invariant: `decideApproval` unchanged, overlay on inputs only | `policy.ts`: `decideApproval` byte-identical; `isCompleteAuto` exact `===`; `storedPolicy` = old body; `effectivePolicy`/`effectiveFirstPlanHold` overlay. `stages.ts` approvalGate builds `forced` once from `touchesProtected`, `run.untrusted === true` and `bigGraph`, with no mode reference. | Met. T9 statically pins `stages.ts` (no `runMode`, `isCompleteAuto` or `storedPolicy`, no stored approval reads) and pins that `decideApproval` takes no config. |
| **B1** persist then swap | `runtime.ts` `save`: `saveConfig` first, then `cfgRef.current = c`. `PUT /api/run-mode` builds `next = deepClone(cfg)` and never mutates the live object. Save failure ⇒ 500 `save_failed` with a static message, no change log line and no `invalidate()`. | Met. Tested in both directions: the direct API test, the runtime `assertNotNewer` case, the engine follow-up (a harmless `approve-plan` plan still waits), and HTTP with a `version: 999` file. |
| **B2** M8-3 gate | `limit-rule.ts` first line `if (cfg.pipeline.runMode === 'complete-auto') return 'switch'`. C1 verified and recorded. The limit-rule reader rule is in T9. | Met. T5 covers the pure function (every stored rule × canonical and non-canonical modes) and the engine: stored `wait` pauses under Per settings and moves to the next tool under Complete auto. |
| **B3** every actor classified | `test/actor-trust.test.ts` uses `TRUST: Record<Actor, …>` (from M8-6), with `design` tainted. The new test asserts that `ACTOR_INFO` agrees with `TRUST`, that the trusted set is exactly `{conductor, user, user-ask}`, and that the taint tables are frozen. T2 iterates `TAINTED_ACTORS` at engine level. | Met |
| N1 clear `forcedHold` | auto patch: `r.forcedHold = undefined`; `markApproved`: same; `holdReasons` unchanged | Met |
| N2 v1 import | `migrate.ts` forces `per-settings` and deletes `runModeChangedAt`; T12 | Met |
| N3 a–e (commit 3) | (a) synchronous checks and `engine.approve`, no `await`; (b) distinct history line; (c) summary `forcedHold`/`risky`, plus `eligible[{key, rev, title redacted}]`; (d) fields only in the run-mode response; (e) N3e test loads a pre-slice run without `forcedHold` and finds it treated as forced | Met. The eligibility check also requires the card author to be non-tainted (S9b) and treats a missing card as forced, which fails closed. |
| N4 non-canonical modes | T13: 12 values × 3 policy shapes, plus loader normalisation | Met |
| N5 directions | T2 (`first` with 0 approved builds), T3/N5 (off after approval keeps building, never re-held) | Met |
| N6 AC3 on parsed config | the HTTP test baselines after one save and compares with `runMode`/`runModeChangedAt` stripped, on → off | Met |
| N7 readers of the mode | T9 allow-list of files that may name `runMode`/`isCompleteAuto` | Met |
| N8 body, confirm text, helper | `confirm` must be boolean if present and is not needed to turn off; the text names all four forced holds; `decidedByRunMode` is pure in `policy.ts` | Met |
| N9 UI contract | Server side met (`PUT /api/settings` returns 400 on `runMode`/`runModeChangedAt`; `overriddenByRunMode`); the wording is M8-5's | Server side met |
| T1 matrix | 1,200 cells: Per settings (explicit and missing) deep-equals the literal pre-slice composition; Complete auto deep-equals `full-auto` without the first-plan rule; forced ⇒ held with `forcedHold`, and risks still shown | Met |

## Decisions the builder asked me to confirm

1. **`deepClone(cfg)` instead of `normalizeConfig(...)`: accepted.** The live config is already normalised, so re-normalising adds nothing for safety and could disturb AC3. `deepClone` is a JSON round-trip (`util.ts:88`), and the static T8 test checks the handler. It still meets B1's real requirements: a new object, and no mutation of the live one.
2. **View `forcedHold: run.forcedHold !== false` while waiting: accepted.** "Absent counts as forced" fails closed and matches the server-side `notBulkApprovable`, so the UI can never offer a run the server would refuse.
3. **Bulk history line written after `engine.approve`: accepted.** It runs synchronously in the same loop iteration (`engine.approve` only schedules a tick), so no build can start in between. The run gets two lines, "Plan approved (human)" and then "Plan approved (you, from the waiting list)"; see nit N2.
4. **`runModeChangedAt` in live state and settings: accepted.** It is a number only, and only the handler writes it (T8). The loader keeps it only if it is a positive finite number.
5. **T9 allowance for M8-3's `listing()` read of `pipeline.limitRule`: accepted.** It is a settings view next to `limitRuleEffective`, and the allowance is pinned by a regex to the single form `limitRule: cfg.pipeline.limitRule`.

## Non-blocking

- **N1. B1 protects only writers that build a new config.** The runtime reorder is correct. But the per-project policy handler (`api.ts:516-520`, `cfg.projects = …` on the live object) and the context-settings handler still mutate `getConfig()` before `saveConfig`. A refused save leaves memory changed there, which could even be a `full-auto` project policy. This was there before M8-4 and is outside its file scope. Track it as a follow-up for the API/M8-3 owner: build a new object as the run-mode handler does. Check the M8-3 account writers the same way (`accounts/service.ts`, the `store(...)` helper).
- **N2. Nit: double history line on a bulk approval.** Optionally, let `markApproved` take a history text, or replace the generic line. It is cosmetic.
- **N3. Wording vs C1 semantics.** In M8-3 (decision D-A), `switch` stays inside the role's tool chain, but the confirm text and the docs say "next account or tool". That is true, but say "the next tool in the job's list" in docs/UI (M8-5), so users don't expect a tool that the job's row does not list.

## Record

- Artifact: `.techteam/reviews/workspace-v2-m8-4-code-review.md`
- Next action: M8-4 may be committed. Keep its hunks separable from M8-3's if the Lead commits them apart. Fold N1 into the API/M8-3 follow-ups and N3 into M8-5's wording.
