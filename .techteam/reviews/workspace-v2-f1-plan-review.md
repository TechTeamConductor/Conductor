# Plan review — F1 Claude `settings.json` isolation (rev 2)

- Task / Linear issue: F1 (Critical/High) — Claude settings isolation; no Linear root in this clone (`active-run.md`: Linear removed)
- Plan artifact: `.techteam/plans/workspace-v2-f1-claude-settings.md` (rev 2, `pending_reviewer`)
- Security design (binding): `.techteam/reviews/workspace-v2-f1-security-design.md` — **Approved with conditions**
- Reviewed by: Reviewer
- Reviewed at: 2026-10-21
- Decision: **Approved**

## Checklist

1. Codebase analysis is complete enough to implement safely: **yes** — current-state cites L3c / L3(b), named-account M8-3 refusals, Quick Ask omit, empty temp cwd N/A for A; choke-point preference matches Security locked file areas.
2. Every task requirement is covered (100% mapped unless the project states a stricter bar): **yes** — coverage matrix maps F1(a)/F1(b), named accounts, setting-sources, docs, optional B (Gap until L3d). Security C6–C12 appear as AC / TODO / live evidence gates.
3. Proposed architecture is correct: **yes** — locked control **A + C**; shared pre-flight before spawn; B evidence-gated; D rejected; fail-closed `setting-sources`.
4. Affected-file list is accurate (no invented existing files): **yes** — listed paths exist (`src/agents/claude.ts`, `src/accounts/{profile,env}.ts`, `src/models/{claude,service}.ts`, `src/agents/providers/claude.ts`, `src/asks/{snapshot,service}.ts`, `test/engine-safety.test.ts`, `test/accounts/env-profile.test.ts`, `docs/ARCHITECTURE.md`). New helper `src/agents/claude-settings.ts` is explicitly optional/new.
5. Security, authorization, and compliance implications are addressed: **yes** — conditions 1–5 folded as binding plan text (verified below); C6–C12 carried into AC / TODO / checkpoints; no rewrite of real `~/.claude`; redaction/static messages; named-account strength preserved.
6. Testing strategy is adequate, including negative and authz cases when relevant: **yes** — plant file + symlink/hardlink refuse; spy zero-spawn or helper/listener 0; throw-away `CLAUDE_CONFIG_DIR`; named suite; live L3c + L3(b)-style.
7. Risks, dependencies, and acceptance criteria are explicit: **yes** — product refuse of default-account helpers; missed spawn → Security code blocker; mutex/restore races; AC1–AC5 + C7–C12.

## Security conditions 1–5 (BEFORE-EDIT) — verification

| Cond | Required | Plan location | Met? |
| --- | --- | --- | --- |
| 1 Control lock | A+C required; D rejected; B optional only after L3d helper/listener 0 on L3c matrix; B may replace A's disk quarantine only with evidence | §2 “Security condition 1 (control lock)” | **yes** |
| 2 Spawn inventory | Every Claude `runProcess` site marked A / C / both / N/A; minimum sites listed; miss of L3-affected site = Security code blocker | §2 table “Security condition 2” | **yes** |
| 3 A mechanics | lstat/no-follow; refuse symlink/hardlink/non-file; quarantine or `{}`; restore via rename + `finally`; per-cwd mutex; targets under `<cwd>/.claude/` only | §2 “A — … Security condition 3” items 2–5 | **yes** |
| 4 C mechanics | Refuse `apiKeyHelper` or any settings `env` own-property; no mutation of real config dir; size-capped parse; static messages; covers auth status / discovery / stages / research | §2 “C — … Security condition 4” | **yes** |
| 5 setting-sources | Apply A + keep AC1 row, **or** refuse `isolation: 'setting-sources'` fail-closed | §2 A item 7 + matrix row | **yes** |

No BEFORE-EDIT Security condition gaps that block plan approval.

## Coverage confirmation

- Requirement mapping is complete: **yes**
- Gaps that block approval: **none**
- Non-blocking Gap (allowed): optional control **B** until L3d evidence — correctly marked Gap; must not delay A+C.

## Findings

| Sev | Note |
| --- | --- |
| — | No blockers. |
| Nit | Doctor / self-test row says “Inventory at implement time” — acceptable because the minimum inventory is present and a missed L3-affected site remains a Security **code** blocker, not a plan hole. |

## Notes

- Rev 2 satisfies Security Unblock step 1 (fold conditions 1–5). Implementation may proceed in the same session after this approval.
- Post-implementation: Security + Reviewer **code** checkpoints (C12) still required before F1 is closed; plan approval is not code approval.
- Do not weaken named-account full-file refuse (C11). Do not ship `setting-sources` without A or runtime refuse (C5).

## Record

- Linear comment or artifact path: `.techteam/reviews/workspace-v2-f1-plan-review.md`
- Next action: **implement in the same session** (A + C; optional B only with L3d)

## Handoff

**Handoff: COMPLETE**
- Delivered: plan review of F1 rev 2; Decision **Approved**
- Artifact(s): `.techteam/reviews/workspace-v2-f1-plan-review.md`
- Acceptance criteria: Security conditions 1–5 present as binding plan text; plan-review checklist complete — met
- Checks run: read plan + security design + spot-check listed source/test paths exist; no source edits; no tests executed
- Decisions/assumptions: B remains Gap until L3d; doctor/self-test inventory may tighten at implement time under the code-blocker rule
- Risks or known gaps: none blocking plan approval
- Next owner/task: implementer (A+C) → live evidence → Security + Reviewer code checkpoints
- Exact next action: set plan `plan_status: approved` and implement A+C
