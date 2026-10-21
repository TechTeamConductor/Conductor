# Plan review

Reviewer agent only. Silence is not approval. Do not fabricate this record.

- Task / Linear issue: M8-2, "Who does what: tool, model and effort" (brief F7, with the consumer side of F7a)
- Plan artifact: `.techteam/plans/workspace-v2-m8-2.md` (rev 1, then rev 2 with §2f)
- Reviewed by: Reviewer (independent). I edited only this file. Nothing in `src/`, `test/`, `fixtures/`, `ui/` or the plans was changed.
- Reviewed at: 2026-10-21, clone HEAD `8eaab46`, with the in-progress M8-1 files present (`src/models/{types,sanitize,cursor-families,cursor,claude,cache,workdir}.ts`; there is no `service.ts` yet).
- Decision: Round 1 (rev 1) **Changes requested**. Round 2 (rev 2) **Approved with conditions** (C1, C2): see the Round 2 section at the end.

Verdict: Approved with conditions

Round 1 result (rev 1): Changes requested. Superseded by Round 2 below.

## Method

I read:
- `CLAUDE.md`;
- the brief (F7, F7a, §6, Decisions, §7 "Model and effort");
- the master plan, the M8-1 plan (§2.1, §2b S19, §2c, §2d, §2e), the M8-3 / M8-4 / M8-6 / M8-U plans (for the contracts), and the M8-U plan review B1;
- the prototype's `levelsFor` / `fitEffort` / `resolveSel` / `cursorModelId` / `runLine` / `selForTool` / `selForModel` (`.techteam/design/v16/Main.dc.html:1378-1434`).

I checked against the code:
- `src/agents/{roles,routing,claude,cursor,caller,provider}.ts`;
- `src/agents/providers/{claude,cursor,codex,types}.ts`;
- `src/config.ts`, `src/schema/version.ts`, `src/migrate.ts:471-485`, `src/types.ts`;
- `src/server/api.ts` (`roles()`, `putRoles`, the route) and `src/server/http.ts` (error serialisation);
- `src/pipeline/{stages,graph-build,envelope,engine}.ts` (call sites), `src/asks/service.ts`, `src/doctor.ts`;
- `fixtures/fake-{claude,agent}.mjs`, `test/server-providers.test.ts`, `test/envelope.test.ts`;
- the real fixtures `fixtures/real/claude-initialize-2.1.304.json` and `cursor-list-models-2026.10.19.txt`.

I ran no CLI.

The Security design review runs in parallel and is a separate gate. This review does not replace it.

## Current-state claims checked

Correct:
- `RoleConfig` / `normalizeRoles`.
- `webResearchIsolated` is set only in tests (`grep` finds only `routing.ts:22,53`), and the asks service calls `claude.runResearch` directly (`service.ts:110-124`).
- The `--model` sites: `claude.ts` (after `-n`, before `--json-schema`), `cursor.ts:20` (last) and `codex.ts:66` (before `-o`).
- The model readers: `providers/claude.ts:53,67`, `providers/cursor.ts:48,67`, `providers/codex.ts:368` and `doctor.ts:132,201,212`.
- `CONFIG_SPEC` v5 with migrations 2→5, and `KNOWN_CONFIG_KEYS`.
- `migrate.ts` reuses `CONFIG_SPEC.migrations`.
- `putRoles` ignores unknown keys inside an entry.
- Builds use only `rt.candidates[0]` (`stages.ts:844-853`, `graph-build.ts:330-336`).
- `runBuild` calls `b.run(...)`, and the envelope static test pins only the caller (`envelope.test.ts:435`).
- `CODEX_ARGV_DIGEST` is computed with no model (`codex.ts:379`).
- M8-1's `CursorFamily.ids` exists (`src/models/types.ts`), as do `parseCursorId` and `EFFORT_TOKENS`.

Drift (not blocking):
- `putRoles` is now at about `api.ts:259-305`, because of M8-1's edits.
- §1 says `src/models/` "does not exist yet". It partly exists now.
- `ApiFail` has no `field`, and `http.ts:220,324` serialises only `{code, message}` (see B1e).

## Checklist

1. **Codebase analysis is complete enough to implement safely: mostly.** Two existing paths are missed:
   - `applySettings` / `PUT /api/settings stages.*` changes a role's head tool (B2);
   - the engine's context summary (`engine.ts:373`) runs as role `context`, so it inherits the Quick Ask selection (N4).
2. **Every task requirement is covered: yes on paper.** The matrix maps every F7 / §7 "Model and effort" item. Gaps are correctly labelled for M8-U and M8-3. Two requirements are not actually met as specified:
   - "visible, never silent" on the research path and for migration loss (B3);
   - one AC is false against its own fixture (B5b).
3. **Proposed architecture is correct: largely.** These parts are sound:
   - pure `levels.ts` / `select.ts` shared with M8-3;
   - re-validation at use;
   - Cursor ids found by lookup in `family.ids`, never by concatenation;
   - effort taken from constants;
   - the `runsAs` slice property;
   - `sel` forwarded as data through the envelope.

   Two parts are not sound: the binding rule "selection belongs to `providers[0]`" breaks under other head-changing paths (B2), and the PUT merge semantics are underspecified (B1).
4. **Affected-file list is accurate: mostly.** No existing file is invented. Missing:
   - `src/server/http.ts` (to carry the error `field`);
   - `src/pipeline/engine.ts` (if N4 changes anything);
   - `src/config.ts` `applySettings` work (B2), which falls under a listed file but is not described.
5. **Security implications are addressed: yes, with S19 mapped item by item in §2e.** Points for Security are in N9. Rule 7's exemption wording could let a Cursor `toolModels` custom id skip the final gate (B5c).
6. **Testing strategy is adequate: not yet.** The byte-identical proof is not shown to be end-to-end (B5a). AC4 names a case that cannot pass (B5b).
7. **Risks, dependencies and acceptance criteria are explicit: partly.** The M8-3 contract does not match M8-3's own plan (B4). §6 says "Claude and Codex keep today's argv", but that is false for an old Claude value that fails the id rule (B3c).

## Answers to the focus questions

- **Unset ⇒ argv byte-identical: the approach is right, the proof is incomplete (B5a).**
  - Builders gain helpers that return `[]` when unset.
  - Providers fall back to `resolveSelection(tool, toolDefaultSelection, null)`, which gives no flags for an untouched config.
  - The Codex digest is unchanged (no model, no effort).
  - The gap: M8-1 AC10 pins the builders, not the plumbing that now chooses `model` and `effort`.
- **v5→v6 migration: correct shape** (pure step, idempotent `normalizeConfig` path, and the existing `backupBeforeNextSave`).
  - Invalid old values go to `legacy.v5` without being shown to the user (B3c).
  - A v6 file that has both `agents.*.model` and `toolModels` loses the former silently (N7).
  - `NewerVersionError` on downgrade, plus M8-3 = v7 and M8-4 = no bump, are consistent across the plans.
- **Cursor id lookup (fail closed), including the first start before discovery: correct.**
  - Without a list, the result is `list-unavailable`: tool default, no `--model`, and a note.
  - This changes behaviour for a migrated `agents.cursor.model`. §6 flags it for the user.
  - The final-gate wording needs tightening (B5c).
- **Effort fitting: correct production deviation from the prototype.**
  - Unset stays unset (needed for byte-identity), unlike the prototype, which fits to a default.
  - Tie goes to the higher level, as in the prototype.
  - The Cursor "base id" is not mapped to `medium`, unlike the prototype's `mediumBase` (N3).
  - The AC example is wrong (B5b).
- **"No longer available" is visible:** yes for read-only stages (notes from `Agents.readOnly`) and builds (stages and graph-build emit notes). It is silent for Deep Research (B3a).
- **Strict `PUT /api/roles`:**
  - The key whitelist, own-property checks, regex and field-named errors are specified.
  - The M8-U B1 finding (entry rebuilt from scratch, `autoByComplexity` dropped when omitted) is **not addressed**. The plan defines "absent ⇒ keep" only for the model fields (B1a).
  - The round trip of the GET form is not guaranteed (B1c).
- **`POST /api/roles/preview` cannot be abused: by design,** since it is pure compute plus memory-only `view()`. It needs explicit no-spawn, no-refresh and no-write assertions, and a defined behaviour for 409/pairing cases (B1d, N6).
- **Contracts:**
  - M8-6 `selRole`: consistent with M8-6 C2.
  - M8-U field names: consistent (all keys always present, `null`/`false` when unset).
  - M8-3: **inconsistent** (B4).
- **Does the `research` workaround (`role:'context'`, `selRole:'research'`) hide a gate? No, but the dead gate misreports (N1).**
  - The research brief is a read-only call with no web tools in an empty working folder (M8-6 §2.5 / T3). It is correctly gated by the `context` role's read-only and tier gates.
  - Real web research never goes through `route()`. Its gate is `runResearch`'s safe-mode refusal plus `checkClaudeInit(profile:'research')`, which fails closed.
  - `selRole` changes only the model selection, never eligibility. A test must pin that.
  - However, `webResearchIsolated` is a dead gate that tells the user something false:
    - `GET /api/roles` reports `choices.research.claude = {ok:false, "web access is not isolated yet"}`, while Claude does run research.
    - `roleViews.research` would follow `research.providers[0]`, even though research is Claude-only.

## Blocking items

**B1. Define `PUT /api/roles` merge semantics completely** (§2.6). They must work for the M8-U chain-edit helper, for UI-free callers, and for GET→PUT round trips.
- **(a) `autoByComplexity` absent.**
  - Today an entry is rebuilt from scratch (`const entry = { providers: [] }`), so omitting `autoByComplexity` deletes it (M8-U review B1).
  - The plan adds "key absent ⇒ keep" only for the model fields, which leaves two rules inside one entry.
  - State one rule. Recommended: absent ⇒ keep the stored value, `null` ⇒ clear. Add a test: a model-only PUT keeps the chain and `autoByComplexity`.
  - `providers` stays required and replaces the chain, as today. Say so explicitly.
- **(b) What "unchanged" means.**
  - §2.6 skips re-judging when the model fields are deep-equal to the stored ones. That ignores the head tool.
  - Suppose a body changes `providers[0]` from claude to cursor and echoes `model:'opus', effort:'high'` (which is what a GET→edit→PUT client does). The entry is then "unchanged" and a Claude id is stored, unchecked, on a Cursor-headed role.
  - "Unchanged" must mean the same head tool **and** equal normalised model fields.
  - Also state what happens when the head changes and the old fields are echoed. Recommended: treat them as omitted, so the implicit clearing rule applies with a notice. Do not judge them as a new Cursor selection. Test both.
- **(c) Round trip of the GET form.**
  - GET returns `model:null, custom:false, effort:null, fast:false, thinking:false` for every role, Claude-headed ones included.
  - As written, the PUT rules would refuse some of these: "`custom` … only with a string `model`", and "`fast`/`thinking` on Claude/Codex ⇒ 400 `not_offered`".
  - Specify that `custom:false`, `fast:false` and `thinking:false` are always accepted, that only `true` triggers the offer checks, and that the comparison in (b) runs after mapping `null`/`false` to absent.
  - Test: PUT the whole `roles` object returned by GET, unmodified ⇒ 200, nothing changes.
- **(d) Preview error mapping.** "Body exactly as PUT" must say what preview does with `409 needs_acknowledgement` and `400 unsupported_pairing`. Recommended: these become `problems[]` entries with `field`, status 200. Only a malformed body (wrong type or unknown key) gives 400.
- **(e) Error `field`.** `ApiFail` has no `field`, and `http.ts:220,324` serialises only `{code, message}`. Add `src/server/http.ts` to §3. Specify the wire shape `{ error: { code, message, field } }`, and make the existing negatives test keep passing.

**B2. The binding rule ("the selection belongs to `providers[0]`") is broken by head changes outside `PUT /api/roles`.** The implicit "tool change clears the model" rule exists only in `putRoles`. Other paths change the head too:
- `PUT /api/settings` `stages.plan|review|verify` → `applySettings` → `setFirstReadOnlySlot` (`config.ts:299-305`) turns `['claude','cursor']` into `['cursor']`;
- the load-time `normalizeRoles` drops an ineligible build-class head (`roles.ts:94`);
- hand edits.

After any of these, the old selection silently binds to the new head. Either:
- the run-time note says "Opus is no longer offered by Cursor", which is misleading; or
- a Claude-chosen id that happens to equal a Cursor family name (Cursor lists `claude-*` families) is applied to Cursor, a selection the user never made for that tool.

Fix one of two ways.
- **Recommended:** record the tool the selection was made for (`RoleModelSel.tool: ProviderId`, written by PUT and preview; v6 is new, so no extra migration). Apply it only when the candidate is that tool; otherwise use the tool default plus the fitted effort. `roleViews` then says "chosen for Claude; Cursor now leads, so Cursor's default is used".
- **Or:** apply the same clearing and fitting rule in `applySettings` and in `normalizeRoles` whenever the head differs from the previously stored head, with tests for each path.

Either way, add a test: `PUT /api/settings {stages:{plan:'cursor'}}` on a role with a Claude model.

**B3. Fallbacks and losses that stay silent** (the brief: "runs on the tool default with a visible note").
- **(a) Deep Research.**
  - `asks/service.ts` calls `runResearch` directly, so nothing emits `sel.notes`. A "No longer available" research model would run on the default without any visible note.
  - The service must write the notes, redacted, into the ask record's events (and the research report's basis, if that is where the user looks) before the run.
  - Extend AC8 to research.
- **(b) Migration loss.**
  - An old `agents.<tool>.model` that fails `MODEL_ID_RE` goes to `legacy.v5` with only a log line. Values that are plausible and work today are hit by this: Claude's `sonnet[1m]` / `opus[1m]` (1M-context aliases), and Cursor's parameterised `id[effort=high]`. The user's stages would silently change model.
  - Surface it in `GET /api/roles`, for example `toolModels[t].notice: "Your earlier model setting was not kept (not a valid model id) — <Tool> now uses its default"`, and in `conductor doctor`.
  - Correct §6 ("Claude and Codex keep today's argv" holds only for values that pass the rule).
  - Add the case to AC6.

**B4. The M8-3 contract in §2.9 does not match M8-3's plan** (`workspace-v2-m8-3.md:86,126,283-288`):
- **`modelOffered`:** M8-3 needs three states (`offersModel: boolean | null`, `null` = unknown catalog, D-D "counts as offering"). M8-2 returns `boolean`.
- **Catalog type:** M8-3 passes `Catalog|null`; M8-2 takes `CatalogView|null`.
- **`fitEffort`:** M8-3 uses `readonly string[]` / `string`; M8-2 uses `EffortToken`.
- **Unknown catalog:** M8-3 D-D says a model on an account whose catalog is unknown reaches the CLI, and an unknown-model failure then triggers a refresh. M8-2 rule 2 says it falls back to the tool default (`list-unavailable`) and never sends it.

Write one semantics table in §2.9, then have M8-3's author confirm it (SendMessage) and record that in both plans. The table needs:
- rows for the catalog state: null, `reading`, `unavailable`, `stale`, `fresh`;
- columns for the selection kind: Claude/Codex discovered, Claude/Codex custom, Cursor family, Cursor custom, tool default;
- for each cell, `modelArg`, `fallback` and `modelOffered`.

Recommended:
- Keep M8-2's fail-to-default rule (it is visible and fail closed).
- `modelOffered` returns `true | false | null` (Cursor custom with no list ⇒ `false`).
- Exported signatures take `CatalogView | null`.

**B5. Proof obligations in the ACs.**
- **(a) AC1 must prove byte-identity end to end, not only at the builder.**
  - The fakes already record the full argv (`fake-claude.mjs:66`, `fake-agent.mjs:73`, `calls.jsonl`).
  - Assert, against **literal arrays committed before M8-2's first source edit** (not recomputed by calling the builders), the argv through each real path:
    - `Agents.readOnly`: Claude plan / plan_review / verify, Cursor ask, Codex exec;
    - `runBuild` for Cursor;
    - `AskService` research;
    - the doctor probes;
    - provider `selfTest` canaries.
  - Check this for (a) defaults, (b) a v5 file without models, and (c) migrated `opus` / `gpt-5.1-codex`.
  - Also pin `CODEX_ARGV_DIGEST()` to a committed hex literal.
  - M8-1 AC10 is necessary but cannot see the new plumbing.
- **(b) AC4 / §2.2 example is false against the real fixture.**
  - In `claude-initialize-2.1.304.json`, `claude-sonnet-4-6` and `claude-opus-4-6` report `low, medium, high, max`. They have Max and lack Extra high. "Claude `max` → `xhigh` on Sonnet 4.6" therefore cannot happen.
  - Use real cases:
    - `xhigh` on `claude-sonnet-4-6` → tie between high and max → `max` (tie goes higher), one note;
    - any effort on `claude-haiku-4-5-20251001` (no levels) → dropped, one note;
    - `max` on `claude-sonnet-4-6` → kept.
  - Fix the §2.2 sentence too.
- **(c) The rule 7 exemption must be limited to Claude/Codex.**
  - "…unless it is a Claude/Codex custom id or comes from `toolModels` custom" reads as if a Cursor `toolModels` custom id skips the catalog check at the final gate. That contradicts rule 3 and S19.
  - Reword it as "a Claude/Codex custom id (role or `toolModels`)".
  - Test: a migrated `toolModels.cursor` that is not listed ⇒ no `--model` and a note.

## Non-blocking items

- **N1. Research gate.**
  - `selRole` is sound (see the answers above). Add a test that `route()` always gets `req.role`, and that `skipped` and fallback notes are computed from `req.role`, whatever `selRole` is.
  - `roleViews.research.tool` must be `claude` regardless of `research.providers` (`runResearch` is Claude-only), and the PUT model checks for `research` must be judged against Claude.
  - The dead `webResearchIsolated` gate makes `choices.research.claude` false (`ok:false`). Record a follow-up, separate and Security-reviewed: set it for Claude from `isolation === 'safe-mode'`, the precondition `runResearch` already enforces, or have the `research` row show "Claude only: runs in Claude's isolated web profile". Do not leave the false reason in the Settings UI.
- **N2. Tool default with effort.** Rule 1 ("resolved … without effort or flags") conflicts with `selectionForTool` and rule 5, which apply the role's effort to the tool default (Claude `--model <toolModels> --effort high`; Cursor: a variant of the default family). Reword: flags are dropped and the effort is fitted.
- **N3. Cursor base id vs `medium`.**
  - The prototype maps `medium` to the base id for `gpt-5.3-codex` (`mediumBase`). Production cannot know that, so a `medium` request fits to `high` (tie goes higher).
  - Record this as a deliberate deviation. "Default (unset)" is the base option where `hasBase`. Say how `options` / `levels` show it so M8-U renders a "Default" level.
- **N4. Context summaries.** `engine.ts:373` (`role:'context'`) will run on the Quick Ask row's model and effort, for example a high effort on background summaries that are capped per day. Either state that this is intended, with a note, or pin it to the tool default (an explicit `selRole`-style option).
- **N5. API shape.**
  - Say whether the PUT/preview `roles` come back in GET form (nulls) or stored form. Recommended: GET form.
  - `roles()` must use `null` catalogs, not a 501, when `ApiDeps.models` is absent (M8-1 made it optional).
- **N6. Preview tests.** Beyond mtime and bytes:
  - zero spawns (M8-1's spawn counter);
  - no refresh and no `noteUnknownModel` call;
  - the same body cap and CSRF as PUT;
  - preview output fed back into PUT ⇒ 200 with the same `runsAs`.
- **N7. `normalizeConfig`.** For a v6 input that has both `agents.<tool>.model` and `toolModels`, move the stray value to `legacy` with a warning instead of dropping it silently.
- **N8. `UNKNOWN_MODEL_RE`.** It is unverified whether Claude reports an unknown `--model` as a `result` event with `is_error` (likely), in which case the refresh trigger never fires. That is fail-safe. Add it to the step 7 opt-in live check list, and record it as a known limit.
- **N9. For Security.**
  - `-c model_reasoning_effort="<e>"` is a new config override on Codex, outside the `CODEX_ARGV_DIGEST` canary binding. Confirm the binding stays meaningful, or include the effort in a digest variant.
  - Update the invariant comment at the top of `codex.ts` ("constants plus one validated model name").
- **N10. Row-level note.** §2.8 says the server stays role-level, yet `roleViews` carries a row-level note ("Build the code and Debugging differ"). Either the server owns the row map (say so, as one constant) or the note moves to M8-U.
- **N11. Migrated aliases display as custom.** A migrated `opus` is stored as custom, so the UI shows "Custom model id… opus" although "Opus" is a discovered option. Consider showing a custom id that equals a discovered id as the discovered option (display only).
- **N12. Custom-id effort.** Claude/Codex custom-id effort = the union of levels (decision b). It can send `--effort` to a model with none, such as a custom Haiku id. Say so in the hint text.
- **N13. Signed out.** A signed-out Claude catalog (5 aliases) turns every full-id selection into "No longer available". When `signedIn === false`, use wording such as "not offered while Claude is signed out".
- **N14. Types.** `EffortToken` (`roles.ts`) and `EFFORT_TOKENS: readonly string[]` (M8-1, not to be edited) can drift. Add a compile-time or unit check in `levels.ts` that the two sets are equal.

## Coverage confirmation

- Requirement mapping is complete: yes. Every F7 bullet and §7 "Model and effort" item maps to a planned change and a named test. The UI and per-account rows are correctly marked Gap (M8-U, M8-3).
- Gaps that block approval: B1–B5 above. None needs a user decision. All are plan-text and test-spec changes, plus one design choice (B2) where I recommend an option.

## Notes

- The direction is good. In particular:
  - the pure `select.ts` / `levels.ts` contract shared with M8-3;
  - the Cursor lookup by tuple in `family.ids`, never by string building;
  - effort from the constant array;
  - re-validation at use, with the catalog membership check as the final gate;
  - `runsAs` proven as a contiguous slice of the real argv;
  - `sel` passed through the envelope as data only.
- §6's open question for the user stands and should be asked as written: a migrated Cursor model now fails closed when it is not listed, including on the first start before discovery.
- Q10 (Claude Fast/Thinking stored, not sent) is respected, and PUT refuses `fast`/`thinking` for Claude.

## Record (round 1)

- Artifact path: `.techteam/reviews/workspace-v2-m8-2-plan-review.md`
- Next action (round 1): revise the plan (rev 2 addressing B1–B5; N items at the author's discretion, with a note on each taken or declined), then a round-2 review. Implementation stays blocked until the Reviewer approves and the Security design is signed off (§4 step 0).

---

## Round 2 (rev 2): Approved with conditions

- Reviewed at: 2026-10-21, plan rev 2 (§2f takes precedence over older text). I read the whole plan again, not only §2f.
- I checked these claims outside the plan:
  - The §2.9 semantics table appears identically in `workspace-v2-m8-3.md` §2.C (about lines 358-366).
  - M8-3 D-D now reads "`modelOffered` null ⇒ counts as offering for ordering; selection falls back to the tool default with a note" (line 98). `offersModel` is computed with the selection the candidate actually runs (line 151).
  - The Security design (`workspace-v2-m8-2-security-design.md`) says `Verdict: Approved with conditions` and contains "Ruling on Reviewer N9".

### Round-1 items: closure

| Item | Status | Evidence in rev 2 |
| --- | --- | --- |
| B1a absent/null | Closed | §2f B1(a): absent keeps, `null` clears, for every key except `providers`; test "model-only PUT keeps chain and autoByComplexity" |
| B1b "unchanged" | **Closed with condition C1** | §2f B1(b). The rule conflicts with B1(c) when `sel.tool` is no longer the head (see C1). |
| B1c GET-form round trip | Closed (subject to C1) | §2f B1(c) and §2.6 `custom` wording; round-trip test named |
| B1d preview mapping | Closed | §2f B1(d), AC10 |
| B1e `field` on the wire | Closed | §2f B1(e); `http.ts` in §3; `field` omitted when undefined, so existing negatives are unchanged |
| B2 binding | Closed | `RoleModelSel.tool` (§2.1); `selectionForTool` keyed on `cfg.roles[role].tool` (§2.3); `other-tool` status; tests for `PUT /api/settings`, the `normalizeRoles` head drop, hand edits, and a Claude id equal to a Cursor family name |
| B3a research visibility | Closed | §2f B3(a), AC8 research bullet |
| B3b migration loss | Closed | `legacyNotices` (static wording, never the value, S4a/S4c), doctor line, AC6 `sonnet[1m]` / `id[effort=high]` |
| B3c §6 correction | Closed | §6 "Migration loss" |
| B4 M8-3 contract | Closed | One table in both plans; `true \| false \| null`; `CatalogView \| null`; string boundary for `fitEffort`; M8-3 D-D aligned |
| B5a end-to-end AC1 | Closed | Commit 0 `test/argv-golden-e2e.test.ts`: full argv from `calls.jsonl` against literals committed before any source edit, on every path, plus a digest literal (§4 step 0b) |
| B5b real fitting cases | Closed | §2.2 and AC4 match the fixture (I re-checked: Sonnet/Opus 4.6 = low, medium, high, max; Haiku 4.5 has no levels) |
| B5c rule 7 | Closed | §2.3 rule 7, merged with Security S1; `toolModels.cursor` test |
| N1–N14 | All taken | N1 follow-up recorded in §6. N4 adds a server-only `toolDefaultOnly` under the S3 discipline. N8 is a recorded known limit. N9 has a Security ruling. |

### Conditions (must be applied to the plan text before the first source edit; no re-review needed if applied as written)

**C1. Fix the B1(b)/B1(c) contradiction for a role whose `sel.tool` is no longer the head.**

The scenario:
- `PUT /api/settings {stages:{plan:'cursor'}}` changes the planning head to Cursor.
- `planning.tool` stays `claude`, so the stored selection is inert (B2's `other-tool` case).
- GET now returns `{providers:['cursor'], tool:'claude', model:'opus', …}`.

Echoing that unmodified does not do what B1(c) says:
- B1(b) computes `newTool = cursor` and compares it with the stored `tool = claude`. The tools differ, and the fields deep-equal the stored ones.
- B1(b) therefore treats the echo as **omitted**: the selection is cleared and the config bytes change.
- That contradicts B1(c)'s test "PUT of the whole GET `roles` object, unmodified ⇒ 200, config bytes unchanged … covers a role whose `tool` is no longer the head".

Required wording:
- "Head changed" compares the body's `providers[0]` (through `selTool`) with the **stored** `providers[0]` (through `selTool`). It does **not** compare with the stored `sel.tool`.
- An entry is unchanged, and not re-judged, when:
  - the head is unchanged;
  - the normalised model fields equal the stored ones;
  - the body `tool` is absent, `null`, or equal to the stored `tool`.

  An unchanged entry keeps an inert `other-tool` selection byte for byte.
- `tool` is server-derived. A body `tool` is accepted only as such an echo. It never re-binds a selection on its own. `tool_mismatch` (400, field `roles.<r>.tool`) applies only when the entry is judged as a new selection and the body `tool` is neither absent nor `null` nor `selTool(role, body.providers)`.
- `tool: null` with model fields kept must not orphan them: the server re-derives `tool`, or the request is refused. Choose one and state it.
- Add one test: "head changed by `PUT /api/settings`, then the GET roles are echoed unmodified ⇒ 200, bytes unchanged, `roleViews.status` stays `other-tool`".

**C2. Bring the older in-place text in line with §2f.** §2f wins by precedence, but these lines will mislead the implementer:
- §2.6 "Role entry keys" lists `providers, autoByComplexity, model, custom, effort, fast, thinking` and then "Any other key ⇒ 400". It must include `tool`, otherwise the GET-form round trip is refused. §2.9 and §2f already list `tool`.
- §2.6 `GET /api/roles` type: `roles[r]` must show `tool: ProviderId | null` and `autoByComplexity: … | null` (GET form, as §2.9 states).
- AC9: "a fallback candidate or complexity pick that is not `providers[0]`" must become "that is not `sel.tool`" (B2 binding).
- §2.3 `selectionForTool` comment: say that a role with `tool` unset (effort only) takes the tool-default branch with the effort fitted, which is the intended result.

### Non-blocking (round 2)

- **R2-N1.** If both `toolDefaultOnly` and `selRole` are set, say which wins. Recommended: `toolDefaultOnly`. Also add `toolDefaultOnly` to the S3 test list (it changes only the `--model`/`--effort` slice).
- **R2-N2.** `legacyNotices` keys off "`toolModels[tool]` unset". After the user picks a default the notice disappears, which is right. Say whether `legacy.v5.agentsModel` is ever pruned. Recommended: never, since it is verbatim history and never served.
- **R2-N3.** The S12 hostile matrix should include a hand-edited `tool` value (`"__proto__"`, `"gpt"`, an object) to confirm the B2 load path drops the fields and reports them.

### Coverage confirmation (round 2)

- Requirement mapping is complete: yes. Every F7 bullet and §7 "Model and effort" item maps to a change and a named test. The gaps for M8-U (UI) and M8-3 (per-account) are correctly labelled.
- Gaps that block approval: none, provided C1 and C2 are applied.

## Record (round 2)

- Artifact path: `.techteam/reviews/workspace-v2-m8-2-plan-review.md`
- Next action:
  1. The author applies C1 and C2 to the plan text and records them.
  2. Commit 0 (`test/argv-golden-e2e.test.ts`, test-only, green on today's code) comes before any source edit.
  3. Implementation in the same session may then start, once M8-1 is merged (§4 step 0).
  4. Security's DURING conditions S4–S13 are checked in the Security code review; the Reviewer code review follows implementation.
