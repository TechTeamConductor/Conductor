# Code review: M8-2 (per-role tool, model and effort)

- Plan: `.techteam/plans/workspace-v2-m8-2.md`. Rev 2 is Approved with conditions C1 and C2, and both are applied in the plan text. §2e, §2f and §2g are binding.
- Reviewed by: Reviewer, independent. I read the diff and the new files and ran the checks myself. The only file I wrote is this one; I also wrote a throw-away probe script in the scratchpad.
- Reviewed at: 2026-10-21. The tree is uncommitted on local `main`, on top of `0e633b1`, the commit-0 end-to-end goldens.
- Scope: only the M8-2 files the builder listed. M8-6's parallel work in the same tree is out of scope: `src/briefs/**`, `src/board/**`, the `src/asks/**` lines other than the research `sel` lines, `prompts/*`, the brief routes, the Home composer, and the `fake-claude.mjs` `design`/`research_brief` stages.

Verdict: Approved

## Checks I ran

- `npm run check` exits 0.
- `npm test`: 988 tests, 984 pass, 0 fail, 4 skipped (the live tests), exit 0.
- `test/argv-e2e-golden.test.ts` is unchanged since commit `0e633b1` (`git diff` is empty) and passes.
- The `test/argv-golden.test.ts` change is type-only: it replaces `cfg.agents.*.model` with an empty `c0`. Every argv literal is byte-identical.

## What I checked against the plan

| Area | Result | Evidence |
| --- | --- | --- |
| Unset ⇒ argv byte-identical (AC1, B5a) | OK | The helpers return `[]` when nothing is set and sit exactly where `--model` was (`claude.ts`, `cursor.ts`, `codex.ts`). Providers fall back to `toolDefaultResolved` (no catalog). The e2e literals and digest are unchanged and green. |
| B2 binding (`sel.tool`) | OK | `selectionForTool` (`select.ts:289-297`) applies the role's own choice only when `rs.tool === tool`. `normalizeRoleSel` (`roles.ts`) drops model fields that come without a registry `tool`. The `applySettings` path is covered by a test. |
| C1 (echo after a settings head change) | OK | `planSelection` (`roles-plan.ts:318-325`) compares the new head with the stored head (both through `selTool`) and accepts `tool` only as an echo. The inert other-tool selection is kept byte for byte. `tool: null` with model fields ⇒ 400 `roles.<r>.tool`. `tool_mismatch` applies only to a new selection. All are tested. |
| B1 merge rules | OK | Absent keeps and null clears for every key except `providers`. `autoByComplexity` is kept when omitted. The GET form round-trips. Head change + echo ⇒ cleared with a notice and the effort fitted. |
| Rule 7 / S1 (Cursor must be listed) | OK | `select.ts:255-268` requires a listed id for Cursor whatever the source, exempts only Claude/Codex custom ids, and drops effort and flags on refusal. The probe agrees: a Cursor custom id that is not listed ⇒ `not-in-list`, no `--model`. |
| S5 / S6 effort | OK | `CLAUDE_EFFORTS` and `CODEX_EFFORT_ARG` are constants, and the argv string is the table element. The Codex tail is only `--model=` and/or one `-c` literal before `-o`. `CODEX_ARGV_DIGEST` is unchanged. The `codex.ts` header comment is updated. |
| §2g W1–W7 per-tool id rule | OK | `modelIdOk(tool, …)` is used on every path: load, `toolModels`, the migration, PUT, resolution and the helpers. A `[1m]` suffix is allowed for Claude only. The W5 table is tested. |
| Migration v5→v6 + B3b | OK | `moveAgentModels` is shared by the migration and `normalizeConfig`, so it is idempotent. The warning names the tool only. `legacyModelNotices` uses static wording and is served in `GET /api/roles` and `doctor`. `legacy.v5` is never served (tested). |
| S2 preview purity | OK | The same `planRoles` handles both routes. The preview route calls no `saveConfig` and no `invalidate`. `catalogFor` → `viewAll()` → `view()` is memory-only (`service.ts:120-161`). Preview goes through the CSRF mutation gate (`http.ts:298-305`). Tests cover zero spawns, zero refreshes and unchanged bytes and mtime. |
| S3 `selRole` / `toolDefaultOnly` | OK | They are used only in `selectionFor(...)` (`provider.ts`). `route`, the tier notes, `runReadOnly` and the profile all key off `req.role`. `toolDefaultOnly` wins over `selRole` (R2-N1). The engine summary is pinned (N4). |
| S10 unknown-model refresh | OK | `cliRejectedModel` is set only when there is no result event, a `--model` was sent, and the bounded stderr matches. `noteRunResult` refreshes only when `modelArg` is set. A result whose text says "unknown model" never sets it (tested). |
| B3a research | OK | Notes go into the ask events with a `conductor:` prefix, redacted and capped. The fallback line goes into the `basis` when the run finishes. |
| Visible fallback | OK | `Agents.readOnly` emits notes per candidate. The builds (`stages.ts`, `graph-build.ts`) write notes to the timeline. `roleViews.status` covers `no-longer-available`, `list-unavailable`, `not-in-list`, `other-tool` and `signed-out`. |
| UI | OK (light pass) | No new HTML sinks in the `ui/app.js` diff. `withSel` drops `tool` and sends GET-form fields. Refusals focus the field named in the error (`fieldRow`). Preview drives "Runs as". |
| §5 test mapping | OK | Every named test in plan §5, for the brief §7 items and S1–S13, exists in `test/models/{levels,select}.test.ts`, `test/argv-model.test.ts`, `test/config-v6.test.ts`, `test/server-roles-models.test.ts` and `test/agents-selection.test.ts`, under that name or a close variant. |

## The builder's deviations

1. **`src/agents/model-args.ts` as a pure leaf module: accepted.** It keeps `select.ts` free of spawn imports (S13), and `runsAs` and the builders share one helper.
2. **`planRoles` in `src/server/roles-plan.ts`: accepted.** It is the S2 shared function.
3. **`Agents.attachModels()`: accepted.** It is a construction-order seam. The default stays `() => null`, so tests and demo builds without a model service get tool defaults.
4. **View-only `models[t].defaultEfforts` / `customEfforts`: accepted.** They are computed by the server's `levelsFor`, so the UI does no fitting. Tell M8-U about them as contract additions.
5. **`ApiFail.extra`: accepted.** `http.ts` drops the keys `code`, `message`, `field` and `__proto__` from `extra`.
6. **`cliRejectedModel` on the `BROKEN_RE` spawn branch: accepted.** `errorKind` stays `spawn` as before, so behaviour is unchanged apart from the refresh hint. Note that a "model not found" stderr still advances the chain, because `spawn` advances (pre-existing).
7. **Fakes not modified for M8-2: accepted.** They already record the full argv. The `fake-claude.mjs` diff in the tree is M8-6's.
8. **Optional 5th `toolDefault` parameter on `resolveSelection` and 3rd `{needsToken}` on `fitEffort`: accepted.** Both are additive, and the M8-3 signatures still work. Record them in the M8-3 contract note (§2.9) so M8-3 passes `toolDefault` when it resolves a role choice directly.
9. **Research fallback line in `basis`: accepted.** It matches §2f B3(a).

## Blocking

None.

## Non-blocking (fix when convenient; no re-review needed)

- **CR-N1. A hand-edited `model: "default"` is sent as `--model default`.**
  - Cause: `pickModel` (`select.ts:142`) and the rule 7 membership check accept Claude's `isDefault` alias entry, while `judgeSelection` rightly refuses it at PUT (`:341`).
  - Confirmed with a probe: `resolveSelection('claude', {tool:'claude', model:'default'}, cat, 'role')` ⇒ `modelArg: 'default'`.
  - Harmless (it is a real alias that means the tool default), but it is inconsistent. Exclude `isDefault` entries in `pickModel` for non-custom ids, so the result is the tool default with no flag.
- **CR-N2. Providers do not check that `req.sel` is for their own tool.**
  - Cause: `providers/{claude,cursor,codex}.ts` use `req.sel.modelArg` without checking `req.sel.tool === <id>`.
  - Today every caller resolves per candidate, so this is defence in depth only. Still, a misrouted `ResolvedSel` (for example a Claude id that passes the narrow rule) would reach Cursor argv without the S1 list check.
  - Suggest `const sel = req.sel?.tool === '<id>' ? req.sel : toolDefaultResolved(cfg, '<id>')`, plus one line in the S12 forged-selection test.
- **CR-N3. Notes repeat on retries.**
  - Cause: `Agents.readOnly` emits `sel.notes` on every call, so `callAgent`'s corrective re-ask or max-turns retry repeats the same "no longer offered" or "NO ZDR" note on the timeline.
  - Cosmetic. Consider de-duplicating per run, or emitting notes only on the first attempt.
- **CR-N4. Misleading legacy notice for a valid old value.**
  - Cause: in `moveAgentModels`, when the input already has `toolModels` (the S4b hand-edit case), even a *valid* old value goes to `legacy.v5`. If that tool's `toolModels` entry is then unset, `legacyModelNotices` says the old setting "is not a valid model id".
  - Rare. Use reason-neutral wording, or record the reason next to the kept value. Do not record the value itself.
- **CR-N5. Research `basis` line is missing on failure.** The fallback line is appended only when research finishes successfully. A failed run keeps the note in its events, which satisfies B3a; adding the line on failure too would be consistent.

## Record

- Artifact: `.techteam/reviews/workspace-v2-m8-2-code-review.md`
- Next action:
  1. The Security code review (S1–S13 against their named tests) is still required before release (plan §4 step 8).
  2. Commit the M8-2 files apart from M8-6's parallel work, in the plan's commit grouping.
  3. Address CR-N1 to CR-N5 at the builder's discretion.

## Follow-up: post-review fixes (2026-10-21)

I checked each fix in the code and re-ran the affected suites myself: `select`, `agents-selection`, `config-v6` and `server-roles-models` (61 pass, 0 fail). The verdict stays Approved.

- **CR-N1: closed.** `choosable()` (`select.ts:55`) excludes Claude's `isDefault` alias from the choosable models. Codex's default entry stays choosable. A new select test covers it.
- **CR-N2: closed.** All five provider call sites (`providers/claude.ts:63,80`, `providers/cursor.ts:47,67`, `providers/codex.ts:377`) use `req.sel` only when `req.sel.tool` equals their own id. Otherwise they use the tool default. A new case is in the S12 hostile-input test.
- **CR-N3: declined, accepted.** Each attempt is its own run, and the note is accurate for it.
- **CR-N4: closed.** The notice wording is now reason-neutral (`config.ts:119`).
- **CR-N5: deferred to a follow-up.** M8-6 is reworking the same research function, so this is left to avoid a conflict. Track it in `active-run.md`.
