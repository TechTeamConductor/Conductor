# Final report — Conductor v1

Report of what was implemented and what was actually run. Date: 2026-10-20. Code: commit `56c7f2d`, tag `v1.0.0-rc2` (local only; nothing pushed).

## 1. Implementation Summary

A local, zero-runtime-dependency (Node ≥ 22.18, TypeScript via type stripping) dashboard + engine that turns a Linear issue into a verified branch:

Linear issue (label `conductor`) → Claude read-only plan (+ independent plan review for larger changes) → optional approval → Cursor `--force` build in an isolated git worktree → deterministic gates (baseline vs now) → Claude read-only verification → bug sub-issues → fix loop (max 3) → "ready for review". It never pushes, opens PRs, or merges. Questions that need no code get an **answer** posted to the issue and finish without build/verify (added after the user's BAR-363 report). Claude usage limits pause (or fall back to Cursor for read-only stages); everything is visible in the dashboard (live log of both agents), in Linear (comments/labels/sub-issues), and via copyable `claude --resume` / `agent --resume` commands.

Changes made after plan approval (disclosed): defaults changed to hands-off (`planApproval: auto`, `planReview: auto`, `onClaudeLimit: cursor`, idle timeout 15 min) at the user's "least work" request; cost display removed from the UI at the user's request (plans are flat-rate CLI subscriptions); answer-only tasks; security-review fixes (see §4).

## 2. Architecture Changes

New project (no prior code). See `docs/ARCHITECTURE.md`. Key properties: Linear is authoritative for human intent, the local store (`~/.conductor/runs/<KEY>/`) for execution facts; write-ahead idempotent effects; Claude stages are flag-isolated and fail-closed on the `system/init` predicate; the Cursor builder runs in a worktree with a deny-rule file, a neutralised git environment, git-meta snapshot/restore, a branch-wide secret scan and a protected-path hold; dashboard is loopback-only with one-time sign-in, CSRF/Host/Sec-Fetch checks.

## 3. Files Changed

- Created: the whole tree — `src/**` (~11 k lines), `ui/**`, `prompts/**`, `fixtures/**`, `test/**` (~11 k lines), `docs/**`, `README.md`, `AGENTS.md`, `CLAUDE.md`, `.techteam/**`.
- Modified / Renamed / Deleted: n/a (greenfield). Commits: `968e2e4`, `b304551`, `d9801b6`, `7a1b91d`, `56c7f2d`, docs `b67e015`.

## 4. Security and Compliance

Independent security review: `.techteam/reviews/conductor-v1-security-review.md` (0 CRITICAL, 4 HIGH, 12 MEDIUM, 14 LOW/INFO against `7a1b91d`). Fixed in `56c7f2d` with regression tests: H1 (only the API-key owner can park/restart/approve; 5-restarts/hour limit), H2 (title/project/label attribution), H3 (titles redacted), H4 (sign-in code no longer on a command line: private bridge page + `POST /auth`), M1 (branch-wide secret scan incl. builder self-commits, scope check also for self-commits), M2 (sessions: 14 d absolute / 3 d idle, cross-site reads refused, SSE cap), M3 (`/approve` anchored on our own request comment), M4/M5 (linear-time redaction/JSON extraction, wider secret shapes, Claude denies reading credential files), M6 (wider protected list incl. rename sources), M7 (guard file rewritten each build; `GIT_CONFIG_GLOBAL/SYSTEM` neutralised), M8 (hooks/config snapshot + restore), M9 (symlink-safe writes), M11 (quiet 400 for `//`), M12 (Cursor limit classification structural, per-run episode cap), L3/L5/L7/L8. M10 (defaults changed to hands-off) is a **disclosed product decision**, with a visible run note whenever Cursor does a read-only step because Claude is limited (Cursor's read-only mode has no flag-level tool lock-down). Residual (accepted, documented): same-user threat model (a `--force` builder can run commands as the user; no-push is defence-in-depth, live-proven for the listed attack variants); cookie not port-isolated (M2 residual); tracked `.cursor/cli.json` in a repo (e.g. `keel-ops`) disables the deny-file layer ("env-only" banner). **The Security reviewer has not re-reviewed the fixes; findings are "fixed by Lead, not yet independently closed".**

## 5. Testing Results

| Check | Result | Details |
| --- | --- | --- |
| Type check | Pass | `npm run check` (tsc --noEmit) clean at `56c7f2d` |
| Unit + integration (fake agents, FakeLinear, real git) | Pass | `npm test`: 483 tests, 479 pass, 0 fail, 4 skipped (opt-in live/Keychain) |
| Security regression | Pass | `test/engine-security.test.ts` (13), `test/server.test.ts` (18), `test/git/*`, `test/linear/attribution.test.ts` |
| Live real Cursor | Pass (3/3, 2026-10-20) | `LIVE=1 node --test test/live/*.test.ts`: E2E build in a temp repo, adversarial no-push suite, question task answered |
| Claude isolation on the real CLI | Pass (earlier today, on `7a1b91d`-era code) | `doctor --isolation` → isolated; `--disallowedTools` accepted with the init predicate intact (`claude 2.1.304`) |
| Claude live plan/verify end to end | **Not run** | the user's Claude CLI account was at its weekly limit; Claude path verified once earlier (init/limit events), never through a full plan+verify |
| Linear live | **Partial** | viewer/teams/validateKey/candidates/issue/commentCreate/label creation + one real run (BAR-363: plan via Cursor fallback → build). Full verify→bug→fix lifecycle never run against real Linear |
| macOS Keychain | Pass (opt-in smoke, dummy item) | |
| UI (browser pane) | Pass (earlier) | wizard + dashboard desktop and mobile, console clean; screenshots in `.techteam/runs/evidence/` — **not re-run after the latest UI changes** |
| Windows / Linux | **Not applicable / not run** | macOS-only product |

## 6. Acceptance Criteria (from `.techteam/plans/conductor-v1.md`)

| Criterion | Status | Evidence |
| --- | --- | --- |
| AC1 boots from a clean copy, 127.0.0.1 only | Satisfied | `test/boot.test.ts` |
| AC2 wizard completes against mock Linear | Satisfied | `test/setup-wizard.test.ts` |
| AC3 happy path, main checkout unchanged | Satisfied | `test/engine-happy.test.ts` |
| AC4 fail path → sub-issues → fix → pass; loop cap → needs human | Satisfied | `test/engine-loop.test.ts` |
| AC5 usage limit pause/notify/resume/fallback | Satisfied | `test/engine-limit.test.ts`, `engine-regress` B2 |
| AC6 isolation fail-closed + doctor probe | Satisfied | `test/agents.test.ts`, `engine-safety`; real `doctor --isolation` |
| AC7 live real-Cursor E2E + negatives | Satisfied | `test/live/cursor-e2e`, `cursor-nopush` (8/8 attacks blocked) |
| AC8 dashboard desktop + 390 px, console clean, screenshots | Satisfied (earlier run); **re-verification pending** after the latest UI edits | evidence folder |
| AC9 security tests | Satisfied | see §5 |
| AC10 strict tsc + tests, every AC mapped | Satisfied | |
| AC11 `service install --dry-run` lints | Satisfied | `test/core.test.ts` (plutil) |
| Cursor-app visibility of headless chats | **Incomplete / deferred** | not verifiable; dashboard + Claude app resume + terminal resume cover it; native listing needs Cursor Cloud Agents (v1.1) |

## 7. Outstanding Issues

- User's running instance (pid 11390) is still on pre-fix code; **restart needed** to pick up the BAR-363 fix (restart was blocked by the permission system when attempted from this session; a backup of the real data exists at `~/.conductor-backups/20261020-134302/`). BAR-363 will finish as an answer on "Retry build".
- keel-ops tracks `.cursor/cli.json`, so no-push is env-only there (documented banner; improvement idea: merge deny rules into the tracked file with skip-worktree).
- Security re-review of the fixes; Reviewer re-review of post-approval changes (defaults, answer-only, security batch) — not yet done.
- Open optional checks never answered by the user: does the Cursor app list headless chats (S5); permission to open the Claude desktop app via `claude --desktop --resume` (S1).
- v1 is superseded by the Workspace v2 effort (`workspace-v2*.md`), which removes Linear.

## 8. Review and Approval Status

- Plan status: approved (rev 2.1 with carry-forwards C1–C6) — `.techteam/plans/conductor-v1.md`
- Reviewed by: Reviewer agent (3 plan rounds); independent code review; independent security review
- Review artifacts: `.techteam/reviews/conductor-v1-plan-review.md` (Approved), `conductor-v1-code-review.md`, `conductor-v1-security-review.md` (Changes requested → fixes in `56c7f2d`, **re-review pending**)
- Approved at: 2026-10-20 (plan)
