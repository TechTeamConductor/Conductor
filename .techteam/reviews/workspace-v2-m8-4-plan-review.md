# Plan review: M8-4 run mode, "Per settings | Complete auto" (brief F6)

Reviewer agent only. Silence is not approval. Do not fabricate this record.

- Task / Linear issue: M8 slice 4, brief F6 (`.techteam/briefs/product-layer.md` §3 F6, §0.4, §6 Q1/Q6, §7 "Run mode", Decisions)
- Plan artifact: `.techteam/plans/workspace-v2-m8-4.md` (author: TechTeam Backend, agent a8915fe35fec852a0)
- Reviewed by: Reviewer
- Reviewed at: 2026-10-21, against the clone `techteam-conductor-v2` at `8eaab46` (plus the untracked M8-1 work in `src/models/`, which this slice does not touch)
- Decision: Approved with conditions

Verdict: Approved with conditions

Implementation may start once **B1–B3** are in the plan text and the M8-3 gate in B2 is met. The Lead may apply them without another Reviewer round. I will check them at the code review, together with the Security code checkpoint.

## What I verified in the code

| Plan claim | Code | Result |
| --- | --- | --- |
| `decideApproval` is pure; forced causes set `forcedHold`; `auto = reasons.length === 0` | `src/policy/policy.ts:35-48` | Correct. The plan's line numbers (175-188, 150-155) are wrong: `effectivePolicy` is at 10-15 (N1). |
| `effectivePolicy` order: project, then legacy `planApproval: manual`, then `pipeline.policy` | `policy.ts:10-15` | Correct |
| Only call site is `approvalGate`; reads `cfg` fresh; forced inputs computed there; `firstPlanHold` inline at :721 | `src/pipeline/stages.ts:708-748`, `GRAPH_BIG_ITEMS` at :55 | Correct. `effectivePolicy`/`decideApproval` have no other caller in `src/`. |
| `decision.forcedHold` is not stored | `stages.ts:736-745` | Correct |
| `forcedHold` "cleared … in `markApproved`" alongside `holdReasons` | `stages.ts:1281-1293` | **Wrong.** `markApproved` does not clear `holdReasons` (only the auto patch at :728 does). The clear is a new line in `markApproved`, not something that already exists there (N1). |
| `TAINTED_ACTORS = ['import','ask-convert','research']`; `maybeClaim` sets `untrusted` | `src/board/types.ts:19`, `src/pipeline/engine.ts:453` | Correct. Migrated runs: `src/migrate.ts:363` and `src/schema/run-migrations.ts:18`. |
| `recover()` only re-queues `running` | `engine.ts:270-280` | Correct. `awaiting_approval` is untouched. The only other writer of `awaiting_approval` is the v1 import (`migrate.ts:352`), which carries no `forcedHold` and is always `untrusted`. |
| `Engine.approve` is rev-bound; risks need `confirmRisks` | `engine.ts:821-828` | Correct |
| `PUT /api/settings` is lenient; `applySettings` ignores unknown keys | `api.ts:575-580`, `config.ts:297-322` | Correct. `applySettings` spreads `next.pipeline` and re-normalises, so a `runMode` added to `normalizeConfig` survives every settings write. `PUT /api/roles` (`api.ts:535-536`) and the repo writers (`:601`, `:641`) also keep `pipeline`. |
| Per-project settings are strict with `confirmFullAuto` | `api.ts:417-427` | Correct |
| CSRF on every mutation; SSE `state` = `api.live()` on `engine.onChange` | `http.ts:294-297`, `:98`, `:195-205` | Correct. `engine.invalidate()` is the change notification (`engine.ts:222-224`). |
| `pipeline` is rebuilt from known keys | `config.ts:134-160`; only top-level unknown keys go to `extra` (:162-166) | Correct. An unknown `pipeline.runMode` is dropped on load. |
| Design references (`setAutoMode`, `afterPlan`, `policy()`, hints) | `Main.dc.html:2094-2101, 1975, 1998, 2767-2771` | Correct. Note the design's hint wording understates the forced holds (N9). |
| `src/accounts/limit-rule.ts` exists | `src/accounts/` does not exist; there is no `workspace-v2-m8-3.md` and no `workspace-v2-m8-2.md` yet | Expected. The plan says it depends on M8-3. See B2. |

## Checklist

1. **Codebase analysis is complete enough to implement safely: yes**, with two factual slips (N1). Every load-bearing claim checks out: one decision function, one call site, forced inputs computed outside the policy, `recover()` ignores waiting runs, and settings writers keep `pipeline`.
2. **Every task requirement is covered: yes.** F6 is mapped item by item in §7: one global switch, effective `full-auto`, effective limit rule `switch`, never writing stored policy, never removing forced holds, never approving waiting plans plus the toast count, disabling overridden fields (API half here, UI in M8-U/M8-5), and the optional Q1 button. Brief §7 "Run mode" (forced holds still stop, stored policy unchanged, strict CSRF API) maps to T1–T4.
3. **Proposed architecture is correct: yes.** An overlay on the *inputs* of an unchanged `decideApproval` is the right shape. See "Core invariant" below.
4. **Affected-file list is accurate: almost.** `src/accounts/limit-rule.ts` is correctly marked "created by M8-3". B1 adds `src/runtime.ts`. B3 may add an export in `src/board/validate.ts`.
5. **Security, authorization and compliance are addressed: mostly.** There is strict CSRF, an explicit `confirm`, a single writer, and fail-closed exact equality. The persistence ordering is not fail-safe (B1).
6. **Testing strategy is adequate: mostly.** The T1 matrix plus T2 per cause proves the invariant for the actors listed *today*. It does not prove it for an actor added later, such as M8-6's `design` (B3). Smaller gaps are in N4–N7.
7. **Risks, dependencies and acceptance criteria are explicit: yes.** The M8-3 dependency needs a firmer gate (B2).

## Core invariant: does every forced hold still stop under Complete auto?

**Yes, by construction.** In `decideApproval`, each forced cause (L, protected paths, untrusted, big graph) pushes a reason and sets `forcedHold`, *independently of* `policy` and `firstPlanHold`. `auto` is `reasons.length === 0`, so no value of the two overlaid inputs can make a forced cause auto-approve. The overlay changes only `policy` (to `full-auto`, which adds no reasons) and `firstPlanHold` (to `false`). The forced inputs (`touchesProtected`, `run.untrusted === true`, `bigGraph`, `plan.complexity`) are computed in `approvalGate` from data the mode never reads.

The guarantee can therefore break in only three ways, and the plan covers each:
- someone edits `decideApproval`: the existing M6-AC1 matrix (`test/policy.test.ts:31`) plus T1;
- someone edits the forced inputs in `approvalGate`: T2 runs each cause at engine level under Complete auto, and T9 is static;
- an untrusted source is not marked `untrusted`: **this is not covered for future actors (B3).**

T1 composes the overlay with `decideApproval` in the test itself, so T1 alone would not catch a wiring change in `stages.ts`. T2 and T9 are what pin the call site; keep both.

## Blocking items (conditions; must be in the plan text before the first source edit)

**B1. A failed save must not leave Complete auto switched on in memory.**
- §2.3 says the handler "writes `cfg.pipeline.runMode` … then calls `saveConfig`". `getConfig()` returns the live object (`runtime.ts:56`). The runtime's `save` assigns `cfgRef.current = c` **before** `saveConfig(c)` (`runtime.ts:57-60`). `saveConfig` can throw: `assertNotNewer` (S-9), a failed pre-upgrade backup (S-7), or a disk error (`config.ts:234-245`).
- Result: the API returns an error, the user believes the switch is still off, and the engine is already deciding under `full-auto` for every project, including `approve-plan` projects. In the other direction, a failed "off" leaves memory off while the disk still says on, so Complete auto silently comes back after a restart.
- Required:
  - the handler builds a new config without mutating the live object, for example `normalizeConfig({ ...cfg, pipeline: { ...cfg.pipeline, runMode } })`;
  - the in-memory switch happens only after the disk write succeeds. Recommended: reorder the runtime `save` to persist first, then swap. That makes every writer safer, so add `src/runtime.ts` to §3;
  - on failure, return 500 with the effective mode unchanged, no log line and no SSE change.
- Add to T4: an injected failing `saveConfig` returns 500, `getConfig().pipeline.runMode` is unchanged, and a harmless plan under stored `approve-plan` still waits.

**B2. Make the M8-3 dependency (C1) a hard gate with a defined fallback.**
- The C1 contract lives only in an agent conversation. There is no M8-3 sub-plan, no `src/accounts/`, and M8-2 (v6) is not planned yet either. Sequencing M8-3 before M8-4 is sound (master §2, master review Part A), but only if:
  - (a) C1 is copied verbatim into the M8-3 sub-plan and approved there. That covers `LimitRule = 'switch' | 'same' | 'wait'`, `effectiveLimitRule(cfg)` in `src/accounts/limit-rule.ts`, stored `cfg.pipeline.limitRule`, `settings.limitRule` / `settings.limitRuleEffective`, M8-4 owning the first-line branch, and T9's "nothing else reads `pipeline.limitRule`". It must also say that `switch` means "next account, then another eligible tool" (brief F6/F8).
  - (b) Before M8-4's first edit, the Lead checks the *landed* names against C1 and records the check in `active-run.md`. Any difference means a delta re-review of §2.1 C1, AC5, T5 and T9.
- Replace "commit 1 can land without the C1 branch only with Reviewer consent" with a rule. Commit 1 (the inert overlay, types and `forcedHold`) may land before M8-3. **`PUT /api/run-mode`, the only supported way to turn the mode on, must not ship until the limit-rule branch is in.** Brief F6 defines Complete auto as both halves, and the confirm text promises "moves work to the next account or tool". A switch that does only half of that is mislabelled.

**B3. Prove "untrusted sources" for actors that do not exist yet.**
- T2 iterates `TAINTED_ACTORS`, so it proves only that the actors *on that list* stop. Suppose M8-6 adds `design` to `Actor`/`ACTORS` but forgets `TAINTED_ACTORS`, or any later slice adds an actor. Then T2 still passes while brief-derived cards build without a click under Complete auto. That breaks the user's decision Q2 ("forced approval under every policy and mode").
- Required: an exhaustive classification that fails closed. For example, in the test, `const TRUST: Record<Actor, 'trusted' | 'tainted'> = { user: 'trusted', conductor: 'trusted', 'user-ask': 'trusted', import: 'tainted', 'ask-convert': 'tainted', research: 'tainted' }`:
  - `npm run check` fails when a new `Actor` member is unclassified;
  - the test asserts that the tainted set equals `TAINTED_ACTORS`;
  - it also asserts that the runtime `ACTORS` list (`src/board/validate.ts:8`; export it) equals the keys of `TRUST`.
- Record in §6 that M8-6 must classify `design` as tainted in this table, which closes the loop with M8-6's own test.

## Non-blocking

- **N1. Fact fixes.**
  - `policy.ts` line references: `decideApproval` is at 35-48 and `effectivePolicy` at 10-15.
  - `markApproved` does not clear `holdReasons` today. Say that `forcedHold` is cleared in the auto patch (`stages.ts:727-729`) and, newly, in `markApproved`. `holdReasons` stays as it is, because the view already hides it outside `awaiting_approval`.
- **N2. Config version: no bump accepted (C3 stands).**
  - A build between M8-3 and M8-4 (same v7) loads the file and silently drops `pipeline.runMode`, because `pipeline` is rebuilt from known keys. It then runs Per settings, and its next save erases the field. That is the safe direction.
  - Pre-M8 builds refuse a v7 file anyway (`assertNotNewer`). A bump would only make the M8-3 build refuse to save, with no safety gain.
  - One addition: the v1 import (`migrate.ts:233`) passes v1 `pipeline` through `normalizeConfig`, so a hand-edited v1 file carrying `runMode: 'complete-auto'` would arrive switched on without any `confirm`. v1 data is untrusted input (C-3). Force `per-settings` on import and add one test.
- **N3. Q1 option B (`approve-waiting`) is safe as specified.** It takes only listed runs, uses exact `forcedHold === false` (`undefined` counts as forced, so runs held before this slice and v1 imports need a per-card approval), adds the `untrusted` belt and braces, is rev-bound, excludes risky runs, never expands "all", and goes through the existing `engine.approve`, which re-checks status and rev. Refinements:
  - (a) Run each run's checks and `engine.approve` synchronously, with no `await` between them, and say so.
  - (b) Write a distinct history line ("Plan approved (you, from the waiting list)") so a bulk approval can be told apart from a card-by-card one.
  - (c) The UI cannot list eligible cards cheaply. `holdReasons`/`forcedHold` are on the detail view (`view.ts:188`, `toDetail`), not on `toSummary`. Either put `forcedHold` and a `risky` flag on the summary while waiting, or return the eligible `[{ key, rev, title }]` in the run-mode response.
  - (d) `waiting.bulkApprovable` belongs to commit 3. If commit 3 is dropped, omit the field.
  - (e) Make sure no run-store loader defaults `forcedHold` to `false`.
- **N4. T1 dimensions.** Add `runMode` values that must mean Per settings: missing, `''`, `'Complete-Auto'`, `'complete-auto '`, `true`, `null`. Add a project-level policy as well as the global one. This pins "exact equality only".
- **N5. T2/T3 directions.**
  - Add a stored `planApproval: 'first'` with 0 approved plans, which builds under Complete auto (AC2 lists only `approve-plan` and `approve-risky`).
  - Add the off direction: a run approved under Complete auto and queued for `build` keeps going after the mode is turned off, and is never re-held.
- **N6. AC3 comparison.** The first `saveConfig` after load can re-format or normalise unrelated fields. Save once before the baseline, or compare parsed objects with `pipeline.runMode` removed. Otherwise "byte-identical" will be flaky or will hide a real write.
- **N7. Extend T9.** Outside `config.ts`, `types.ts`, `policy.ts`, `limit-rule.ts` and the `api.ts` handler and view, nothing reads `runMode` or `isCompleteAuto`. In particular, `stages.ts` must not reference it, so the forced inputs can never become mode-dependent.
- **N8. Strict body detail.**
  - `confirm`, when present, must be a boolean. It is not required to turn the mode off.
  - The confirm message omits "more than 8 tasks". List all four forced holds.
  - The history-line logic ("Complete auto made the difference") should be a pure helper in `policy.ts` (two `decideApproval` calls), so `stages.ts` only gains the call.
- **N9. UI wording contract (C4).**
  - The design's `paHint`/`modeHint` say only "Plans from research reports still ask". In production, large changes, protected files, more than 8 tasks and every unverified source also stop. C4 should say that the wording names all forced holds and is not copied verbatim.
  - C4 should also say that the run-mode control at the top of Settings writes immediately through `PUT /api/run-mode` and is not part of the Settings draft. M8-U drafts until Save, and `PUT /api/settings` now returns 400 on `runMode`.
  - `overriddenByRunMode: 'policy'`: `Settings` has no `policy` field today. Say that it refers to the per-project policy controls and the global default.
- **N10. Security design before the edit: agreed, not needed for commits 1–2.** Brief §0.2 lists isolation, credentials, model discovery and model-written text, and this slice touches none of them. The forced-hold invariant is structurally protected (see above). Commit 3 adds a new bulk human route into `build`. It goes through the existing choke point, but ask Security for a one-line acknowledgement before commit 3's edit, or at the latest have the Security code checkpoint cover it explicitly, as the plan says.
- **N11. Audit.** M6-S6 asked for an audit entry on approval-setting changes, and none exists in code today. The one log line (counts only) is acceptable. Optionally add a timestamped entry the dashboard can show ("Complete auto turned on at 14:02").

## Coverage confirmation

- Requirement mapping is complete: yes. The UI half (disabled fields, header switch, toast) is in M8-U/M8-5 against C4.
- Gaps that block approval: none beyond B1–B3, which are plan-text changes plus the B2 gate on M8-3.

## Notes

- The run-mode overlay, the single writer, `confirm`, and leaving waiting plans alone together meet F6 and Q1/Q6.
- Not writing stored policy is guaranteed by the one-writer handler (T8) and the AC3 file comparison (with N6).
- `recover()` needs no change: it touches only `running`, and a run that was mid-plan at a restart is decided at its gate under the mode in force then. That is correct and is what §2.2 says.

## Record

- Artifact: `.techteam/reviews/workspace-v2-m8-4-plan-review.md`
- Next action: the Lead folds B1–B3 into the plan, and N-items optionally. Implementation of commits 1–2 starts after M8-3's `limit-rule.ts` has landed and matches C1 (B2); commit 1 may go first under B2's rule. Then the Reviewer code review, and the Security code checkpoint including commit 3 if kept.
