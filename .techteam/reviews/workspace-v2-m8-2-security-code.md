# Security code review: M8-2 Who does what — tool, model and effort (F7)

- Reviewer: TechTeam Security Engineer (independent of the implementer, agent a7f57a8ad83fcab5f)
- Date: 2026-10-21
- Scope: the uncommitted M8-2 changes in `/Volumes/Sandisk/github/techteam-conductor-v2`, checked against:
  - `.techteam/reviews/workspace-v2-m8-2-security-design.md` (S1–S14 and the N9 ruling);
  - the M8-1 S9 widening ruling (W1–W7) in `workspace-v2-m8-1-security-design.md`.
- M8-6 work shares the tree. Only its points of contact with M8-2 were looked at: `onlyProviders`, research depth, and `ApiFail.extra`.
- Code read:
  - `src/agents/model-args.ts`, `src/models/{sanitize,levels,select}.ts`, `src/server/roles-plan.ts`;
  - `src/config.ts` (`moveAgentModels`, `normalizeToolModels`, `legacyModelNotices`, `CONFIG_SPEC`);
  - `src/agents/{claude,cursor,provider}.ts`, `src/agents/providers/{claude,cursor,codex}.ts`;
  - `src/server/api.ts` (`/api/roles` GET/PUT, `/api/roles/preview`), `src/server/http.ts` (`fail`);
  - `src/pipeline/{stages,graph-build,envelope}.ts` (`sel` plumbing), `src/asks/service.ts` (research), `src/agents/routing.ts` (comment);
  - a check of the `ui/app.js` diff for new HTML sinks.
- Evidence I ran myself: `npm run check` is clean, and `npm test` gives 988 tests, 984 pass, 0 fail, 4 live tests skipped. No real CLI was run.

## Decision

**Approved.** Every binding condition is met in code and backed by a named test. I found no Critical, High or Medium issue. Two Low notes follow; neither blocks release.

## Condition-by-condition

| Cond. | What I checked in the code | Test evidence (green) | Status |
| --- | --- | --- | --- |
| S1 | `resolveSelection` rule 7 (`select.ts`): Cursor `modelArg` must be a listed id whatever its source. The exemption applies only to Claude/Codex with `pick.custom`. With no list, a Cursor custom id gives `list-unavailable` and no `--model`. A family is sent only as an element of `family.ids`, through `cursorVariantId`. | select.test S1 ×3 | Met |
| S2 | `planRoles` is pure: it deep-copies `cfg.roles` and `toolModels`, and imports no fs, spawn or service. The preview route calls only `planRolesFor(...,'preview')` and `catalogFor`, which reads `viewAll()` only. Save happens only on the PUT branch, after `normalizeConfig`. Both routes go through the generic mutation gate in `http.ts`. | server-roles-models "preview is pure…" (bytes, mtime and in-memory config unchanged, recorder bin never spawned, refresh/noteVersion/noteUnknownModel = 0, no backup); "preview without CSRF ⇒ 403; cross-site ⇒ 403…"; shared-plan test | Met |
| S3 | `Agents.readOnly`: `route()`, `onlyProviders`, the candidate loop, `runReadOnly` and the provider's profile and turns all use `req.role`. `selRole` and `toolDefaultOnly` feed only `selectionFor`. Both are typed server-side fields; no HTTP path sets them. | agents-selection S3; toolDefaultOnly/R2-N1 | Met |
| S4 | `moveAgentModels`: warnings name the tool and reason only. `toolModels` wins over `agents.*.model`. Kept values go only to `legacy.v5.agentsModel`. `normalizeToolModels` reads own-property registry keys and builds entries from literals. `legacyModelNotices` holds static text only. `agents.*.model` is gone from the type, so tsc proves nobody reads it. | config-v6 S4a/S4b/S4d/§2g; server-roles-models B3b/S4c | Met (see L2) |
| W1–W7 | `modelIdOk(provider, id)` is the single entry point. `CLAUDE_MODEL_RE` allows only one `[a-z0-9]{1,8}` suffix, and JS `$` without `m` allows no trailing newline. Codex and Cursor use the narrow base rule. Codex `--model=` never takes brackets. No further widening was made. | select.test W5 table; argv-model W6; config-v6 W6 | Met |
| S5 | `claudeModelArgs` emits only a `CLAUDE_EFFORTS` element. `codexModelArgs` emits only `CODEX_EFFORT_ARG[e]` for an `EFFORTS` element. `cursorModelArgs` has no effort. The builders re-check every value, so forged input is omitted. | argv-model S5 ×2 | Met |
| S6 / N9 | `buildCodexArgs` = constants + `codexModelArgs(...)` + `-o <out> -`. `CODEX_EFFORT_ARG` is a frozen table of literals. `CODEX_ARGV_DIGEST` and the canary binding are still computed with `{outFile}` only. The header comment now names the effort token and the N9 limits. | argv-model S6 (every token + hostile set), digest unchanged | Met |
| S7 | `checkClaudeInit` call and options are unchanged. The Claude slice is placed after `-n <name>` and before `--json-schema`. Cursor `--mode`/`--force` don't depend on `sel`. The envelope forwards `sel` as one field. | agents-selection S7 (both profiles); argv-model flag-set ⊆ today ∪ {--model,--effort}; bracketed ids at PUT/load/use; envelope E20 unchanged | Met |
| S8 | `planRoles` checks the top-level, entry, `autoByComplexity` and `toolModels` keys against allow-lists by iterating `Object.keys`. `isRole` uses `Object.hasOwn`, and `isProviderId` is an array `includes`, so prototype keys never match. `field` is built only after the role or tool passes its check; an unknown key appears only in the message, through `q()`. A non-`ApiFail` error becomes a generic 500 with no stack or path. PUT saves only after the whole plan passes. | server-roles-models negatives table | Met |
| S9 | `runsAs` = `RUNS_AS_PREFIX[tool]` + helper output; it never includes the bin, cwd, `--workspace`, `-o`, `-n` or schema. Notes are redacted before `onEvent` and `note()` in `readOnly`, `stages.ts:855`, `graph-build.ts:389` and `asks/service.ts:155`. The UI diff adds no `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`. | argv-model slice + no-path; agents-selection AC8/S9; select.test S9 | Met |
| S10 | `cliRejectedModel` is set only when there is no result event, a `--model` element was actually emitted, and the bounded `stderrTail` matches `UNKNOWN_MODEL_RE` (bounded gaps, linear). `noteRunResult` also requires `sel.modelArg`, and catches errors. The refresh stays under M8-1 back-off. | agents-selection S10 ×2 | Met (BROKEN_RE ruling below) |
| S11 | Research still runs `selectionFor('research','claude')`, then `claude.runResearch` with `profile:'research'` and safe-mode required. `webResearchIsolated` is not set anywhere; only a comment was added in `routing.ts`. | server-roles-models research → cursor still 400; agents-selection research profile | Met |
| S12 | Hostile set on the full fake-CLI argv, from config, PUT, a tampered cache and a forged `ResolvedSel`. `x[1m]` is asserted for Cursor/Codex only, which is correct under W2. | agents-selection S12 | Met |
| S13 | `levels.ts` and `select.ts` import no fs or child_process. `cursorVariantId` returns `family.ids` elements. | levels.test static; select.test identity | Met |
| S14 | Bookkeeping: the implementer's mapping from conditions to tests matches the tests in the suite. | — | Met |

## Ruling requested: `cliRejectedModel` on the BROKEN_RE spawn branch

**Accepted.**

On that branch:
- there was no result event;
- a `--model` was sent;
- the flag is a boolean derived from the CLI's own bounded stderr;
- `errorKind` stays `spawn`, so the chain advances exactly as before M8-2;
- the only consequence is one model-list refresh, limited by the M8-1 S11 back-off, plus the `sel.modelArg` guard in `noteRunResult`.

Neither model prose nor stdout can reach the flag. The ruling holds as long as:
- the flag never changes `errorKind`;
- it never causes a retry or a chain advance of its own;
- it never selects a different model by itself. The next run re-resolves against whatever list discovery returns.

## Notes (Low, non-blocking)

**L1: Cursor membership is enforced at resolution, not in `cursorModelArgs`.**
- The helper re-checks the id rule only. A hand-built `ResolvedSel` with a well-formed but unlisted Cursor id would reach `--model`.
- Today every `ResolvedSel` comes from `resolveSelection`, whose rule 7 enforces membership. S12 covers forged values that fail the id rule.
- This matches the approved design, and the worst case is a well-formed single argv element. Optional hardening: have the Cursor provider re-check `sel.modelArg` against `catalog(cursor)` before spawning.

**L2: `legacyModelNotices` gives the wrong reason in one case.**
- A hand-edited config can have a `toolModels` that omits a tool while that tool still has a valid `agents.<tool>.model`. The value is moved to legacy and the notice says "it is not a valid model id".
- No value leaks; the wording is just wrong. Optional: say "was replaced by 'Default model for each tool'" when it was moved because `toolModels` existed.

## Residual risk accepted

- Claude/Codex custom ids are passed without a list check, by design. The user chooses them behind loopback, cookie and CSRF, and each is a single non-option argv element.
- Codex effort stays dormant until Codex discovery is enabled under its own gate (M8-1 S18).

## Follow-up (2026-10-21, after the implementer's fixes)

- **L2: closed.** The `legacyModelNotices` text no longer gives a reason (`src/config.ts:119`), and it still never contains the old value.
- **CR-N2 (from the Reviewer): verified.** Each provider ignores a `req.sel` whose `tool` is not its own and falls back to its own tool default (`providers/claude.ts:63,80`, `providers/cursor.ts:47,67`, `providers/codex.ts:377`). This also hardens L1 against a selection meant for another tool.
- **CR-N1 (Claude `default` alias never sent): noted.** It is not a security condition.
- **L1: deferred by the implementer, and I accept that.** It was optional. Cursor list membership stays enforced by `resolveSelection` rule 7, which every caller goes through: `Agents.readOnly`, the builds via `selectionFor`, and `toolDefaultResolved` with a null catalog, which never yields a Cursor id. It is recorded as a follow-up.
- **BROKEN_RE ruling: the implementer confirms the conditions hold.** The flag leaves `errorKind` unchanged, causes no retry and no advance, and never selects a model by itself.
- **Tests re-run:** `npm test` gives 988 pass, 0 fail.

Verdict: Approved
