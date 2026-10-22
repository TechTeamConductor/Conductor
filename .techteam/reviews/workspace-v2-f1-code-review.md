# Code review: F1 Claude `settings.json` isolation (A+C)

- Plan: `.techteam/plans/workspace-v2-f1-claude-settings.md` (rev 2; plan_status approved)
- Plan review: `.techteam/reviews/workspace-v2-f1-plan-review.md` — **Approved** (not re-litigated)
- Security design: `.techteam/reviews/workspace-v2-f1-security-design.md` — Approved with conditions
- Security code (prior): `.techteam/reviews/workspace-v2-f1-security-code.md` — Changes requested (B1 High = doctor `isolationProbe`; L1 evidence choke-point acceptable after B1)
- Diff (F1-only focus): `src/agents/claude-settings.ts`; wired in `src/agents/claude.ts`, `src/models/claude.ts`, `src/agents/providers/claude.ts`, `src/doctor.ts`; tests `test/agents/claude-settings.test.ts`, `test/preload.ts`, `test/models/{service,spawn}.test.ts` stubs; `docs/ARCHITECTURE.md`; evidence `.techteam/runs/evidence/l3c-f1-postfix.md` (+ probe)
- Working tree also contains **unrelated M8-5 UI/API** edits — noted; not reviewed; no F1 conflict observed
- Reviewed by: TechTeam Reviewer
- Reviewed at: 2026-10-21 (initial) · **re-review 2026-10-21**
- Checks run by Reviewer (re-review):
  - `node --test --import ./test/preload.ts test/agents/claude-settings.test.ts` — **9/9 pass** (includes doctor isolationProbe + `.claude.json` symlink cases)
  - Full `npm test` / `npm run check` not re-run in this review

**Decision: Approved**

## Re-review (post Changes-requested fixes)

| Prior finding | Status | Evidence |
| --- | --- | --- |
| **M1** Doctor `isolationProbe` bypasses A+C | **Closed** | `src/doctor.ts` `isolationProbe`: `assertClaudeConfigDirSafe(env)` before spawn; on `ClaudeSettingsError` returns failed `IsolationReport` with class message (no spawn); `withProjectSettingsNeutralized(repo, () => runProcess(...))` wraps the canary. Test `F1-C via doctor isolationProbe: planted config-dir helper → note + zero spawn` — marker absent, note matches `/key helper/`. |
| **M2** `.claude.json` link skip (fail-open) | **Closed** | `assertClaudeConfigDirSafe`: symlink → `a link in place of a settings file`; non-file / `nlink !== 1` → `a settings file Conductor cannot trust` (same family as settings files). Test `F1-C: .claude.json symlink refuses (fail closed)`. Hardlink covered by shared `nlink !== 1` path (no separate `.claude.json` hardlink test — acceptable; same branch as settings refuse). |
| **M3** AC1 evidence choke-point-only | **Not re-blocked** | Security code L1: postfix choke-point evidence **acceptable after B1 closes**; full live L3c matrix optional / nice-to-have. No inventory gap found on re-review (doctor now in tally). Escalate only if Security code re-check finds a new miss. |

### Blocking

**None.**

### Spawn inventory (re-tally)

| Site | A | C | Status |
| --- | --- | --- | --- |
| `runClaude` (stages / research / probe / self-test) | Yes | Yes | OK |
| `discoverClaude` | N/A (empty cwd) | Yes | OK |
| Provider `auth` | N/A | Yes | OK |
| Provider `detect` (`--version`) | N/A | Exempt | OK |
| `isolationProbe` (doctor) | Yes (neutralize around canary cwd) | Yes (assert before spawn) | **OK** (was M1) |
| Named-account logout | N/A | N/A (folder refuse) | OK |
| Login | gated off | — | OK |

## Checklist (code vs plan)

| Item | Result |
| --- | --- |
| Quarantine + restore + per-cwd mutex | **Pass** |
| Refuse semantics (C) | **Pass** — settings + `.claude.json` helper/env; links/hardlinks fail closed |
| Spawn inventory (Security cond. 2) | **Pass** — doctor canary now A+C |
| Test coverage | **Pass** for M1/M2 fix deltas; prior N2–N3 (mutex / managed-settings plant) remain non-blocking minors |
| Conventions | **Pass** |
| Plan self-approve | N/A |

## Residual minors (non-blocking; carry forward)

- **N1.** User-facing C errors are bare class strings; prefer a single wrapper sentence + class for doctor copy (still no paths/secrets).
- **N2.** No automated test for per-cwd mutex serialization.
- **N3.** `managed-settings.json` named but not planted in unit tests.
- **N4.** Quarantine `lstat` + `renameSync` TOCTOU class — residual for Security, not a rework trigger.
- **N5.** `isolationProbe` still raw `runProcess` under A+C wrappers (not `runClaude`); acceptable per Security unblock (“`runClaude` or explicit C assert”). Uncaught `ClaudeSettingsError` from A on a hostile canary tree would throw rather than map to `IsolationReport` — canary is Conductor-temp empty of project settings, so practical risk is nil.

## What looks solid

- Shared helper; `runClaude` applies **C then A**; isolation → `errorKind: 'isolation'`.
- Doctor probe now refuses planted config-dir helpers with zero spawn (unit-proven).
- `.claude.json` links no longer fail open.
- Named-account profile refuse unchanged; suite throw-away `CLAUDE_CONFIG_DIR` intact.

## M8-5 note

Uncommitted M8-5 UI/API files remain alongside F1. Do not block F1 on M8-5; keep commits/reviews separate.

## Record

- Artifact: `.techteam/reviews/workspace-v2-f1-code-review.md`
- Next action: Security code checkpoint re-check (expect Approved if B1 closed and no new High/Critical); then F1 close / commit hygiene as Lead decides
- Prior decision (initial review): Changes requested (M1–M3)
- **Re-review decision: Approved**

## Handoff

**Handoff: COMPLETE** (Reviewer code gate)

- Delivered: F1 code re-review after M1/M2 fixes; Decision **Approved**
- Artifact(s): `.techteam/reviews/workspace-v2-f1-code-review.md`
- Acceptance criteria: A+C wiring + doctor inventory + `.claude.json` fail-closed met; M3 evidence not re-blocked (Security L1)
- Checks run: `claude-settings` tests 9/9 pass; no full suite
- Decisions/assumptions: Security L1 ⇒ choke-point evidence OK post-B1; do not invent live L3c matrix requirement for Reviewer approve
- Risks or known gaps: residual N1–N5; Security code re-check still required for F1 ship gate (C12)
- Next owner/task: Security (code checkpoint re-check)
- Exact next action: re-dispatch Security on doctor + `.claude.json` deltas; expect Approved if B1 gone
