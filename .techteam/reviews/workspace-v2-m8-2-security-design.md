# Security design sign-off: M8-2 Who does what — tool, model and effort (F7)

- Reviewer: TechTeam Security Engineer (independent of the plan author, agent ac46c5e50f0c8606c)
- Date: 2026-10-21
- Input: `.techteam/plans/workspace-v2-m8-2.md` (status pending_reviewer; §2e lists the items for sign-off)
- Also read: `CLAUDE.md` (safety invariants), `.techteam/briefs/product-layer.md` (F7, F7a safety bullets), `.techteam/plans/workspace-v2-m8-1.md` §2b, `.techteam/reviews/workspace-v2-m8-1-security-design.md` (S8, S9, S13, S19), `.techteam/plans/workspace-v2-m8-6.md` (C2, research brief).
- Code read in the clone working tree:
  - `src/agents/claude.ts`: `buildClaudeArgs`, `checkClaudeInit`, `runClaude`
  - `src/agents/cursor.ts`: `buildCursorArgs`
  - `src/agents/providers/codex.ts`: `buildCodexArgs`, `CODEX_ARGV_DIGEST`
  - `src/agents/providers/{claude,cursor}.ts`, `src/agents/providers/canary.ts`, `src/agents/providers/verification.ts`
  - `src/agents/provider.ts` (`readOnly`), `src/agents/caller.ts`, `src/agents/roles.ts`, `src/agents/routing.ts`
  - `src/asks/service.ts` (research)
  - `src/config.ts`: `CODEX_MODEL_RE`, `normalizeConfig` agents block, `CONFIG_SPEC`, backup
  - `src/server/api.ts`: `roles`, `putRoles`, routes; `src/server/http.ts` (mutation gate)
  - M8-1 `src/models/sanitize.ts` (`MODEL_ID_RE`, `EFFORT_TOKENS`, `own`) and `src/models/cursor-families.ts` (`parseCursorId`)
- Method: I treated the plan as a design and checked every code claim it relies on. I ran no CLI and edited no plan or source.
- Severity:
  - **High**: an untrusted or hand-edited value could reach argv as an option, weaken an isolation profile or the init check, or reach a shell, a path or secrets.
  - **Medium**: the plan text is ambiguous in a way that a literal implementation could get wrong on a fail-closed path.
  - **Low**: hygiene, logging or test completeness.
- Tags:
  - **[BEFORE-EDIT]**: the plan text must change before the first source edit.
  - **[DURING]**: an implementation or test constraint. The Security code review checks it.

## Decision

**Approved with conditions.** I found no Critical or High issue. The core design is sound:
- argv values are re-validated at use against `MODEL_ID_RE`, whose first character must be alphanumeric and which allows no space, `=`, `[` or quote;
- every value is its own argv element (Codex `--model=` is the single fused form S19 allows);
- spawn is shell-less;
- efforts come from a constant array;
- Cursor ids come from a lookup in the listed ids;
- the init check reads the CLI's own `init` event, so a model choice cannot change what it checks.

Three Medium items (S1–S3) are wording gaps on fail-closed paths and must be fixed in the plan text before the first edit. The rest are DURING.

## Threat model (summary)

| Surface | Threat | Where the plan stands |
| --- | --- | --- |
| Claude argv `--model <v> --effort <l>` | Option injection, or a value consumed as another flag | `MODEL_ID_RE` at load, at PUT and at use; each value is its own element; it sits after `-n <name>`, which takes exactly one value, so no variadic option before it (`--disallowedTools` is variadic, but `--disable-slash-commands` closes it earlier). Effort must also be in Claude's own set (S5). |
| Cursor argv `--model <id>` (last) | A parameterised `id[k=v,…]` form or a composed id the CLI never listed | Brackets and `=` fail the id rule. The composed id is a lookup in `family.ids`, never concatenation. Custom ids fail closed. **Gap:** the rule 7 exemption wording could let a migrated Cursor value through (S1). |
| Codex argv `--model=<id>` + `-c model_reasoning_effort="<l>"` | A config-override injection (a different `-c` key, TOML injection, overriding the sandbox or approval keys) | The key is a constant. The value is a constant `[a-z]+` token, so no quote can break the TOML string. `--ignore-user-config` is kept. Dormant until Codex discovery exists. The argv tail must be pinned structurally (S6). |
| Isolation (Claude read-only and research profiles, Cursor ask/plan, Cursor build guard, Codex sandbox) | A model id, effort, Fast or Thinking changes tools, permission mode or sandbox | `checkClaudeInit` checks the session's real `tools`, `mcp_servers`, `skills`, `slash_commands` and `permissionMode`. It does not depend on argv, so it holds for any `--model`/`--effort`. Cursor's mode/`--force` and Codex's `--sandbox read-only` stay constants. Claude Fast/Thinking are never sent. The parameterised Cursor form is refused. Holds (S7). |
| Config v5→v6 migration | An unchecked legacy value (today `agents.claude.model` and `agents.cursor.model` are free text, `src/config.ts:115,125`) reaches argv, or a log echoes it | Valid values become `custom`; invalid ones go to `legacy.v5` and are never sent. Cursor custom ids must be listed. **Gaps:** the log line content, and both keys being present (S4). |
| `PUT /api/roles` | Prototype keys, unknown keys, a value smuggled via an unchanged entry | Allow-lists at both levels and own-property checks. The unchanged-entry path is safe because use-time re-validation is independent of PUT (S8). |
| `POST /api/roles/preview` | A spawn, a write, a cache refresh or in-memory config mutation; leaking paths | Plan says "never saves". **Gap:** what else it must never do is not stated (S2). |
| `runsAs` / `who` / notes | Paths, bin location, cwd, secrets, markup | Static prefix plus model-arg helper output only; redacted; `textContent`. Holds if pinned (S9). |
| `selRole` (M8-6 research brief) | Using a `context` route to run what the research gate forbids | Not a bypass if `selRole` only selects model data (S3, side-finding section). |

## Binding conditions

### Before the first edit (plan text)

**S1 [BEFORE-EDIT] (Medium): Cursor membership has no exemption, whatever the source.**

§2.3 rule 7 says the model "must be in the catalog unless it is a Claude/Codex custom id **or comes from `toolModels` custom**". Read literally, the second clause exempts a migrated `toolModels.cursor = { model, custom: true }` from the membership check. That contradicts rule 3, §6 ("fail closed per S19") and §2e item 4.

Reword rule 7 as: *"For Cursor, `modelArg` must equal an id in the current catalog's listed ids, regardless of source (role, `toolModels`, migration, custom). The membership exemption applies to Claude and Codex custom ids only, and only after `MODEL_ID_RE`."*

Tests:
- A migrated `agents.cursor.model: 'gpt-5'` with no Cursor list ⇒ no `--model` and the `list-unavailable` note.
- The same value with a list that lacks it ⇒ `not-in-list`.
- A family name that is not itself a listed id (no base id) is never sent as-is.

**S2 [BEFORE-EDIT] (Medium): The preview endpoint must be provably pure.** Add this to §2.6.

- (a) `PUT` and `preview` share one pure planning function, e.g. `planRoles(body, cfg, states, catalogs) → { next, notices, problems }`. It works on a deep copy, as `putRoles` does today (`JSON.parse(JSON.stringify(cfg.roles))`). `PUT` = plan + save. `preview` = plan only.
- (b) `preview` never:
  - calls `saveConfig`, `setConfig` or the backup;
  - calls `ModelService.refresh`, `noteVersion` or `noteUnknownModel`;
  - resolves a binary;
  - spawns.

  It reads the catalog only through the synchronous `view()`.
- (c) Every route under `/api/roles*` other than `GET /api/roles` passes the existing mutation gate in `http.ts` (JSON content type, `x-conductor-csrf`, Sec-Fetch-Site). A request without CSRF gets 403.
- (d) Tests, to add to AC10:
  - `config.json` bytes and mtime are unchanged;
  - the in-memory `getConfig()` object is deep-equal before and after;
  - a `runProcess` spy sees zero calls;
  - a `ModelService` spy sees zero refresh or `noteUnknownModel` calls;
  - no backup file is created;
  - preview without CSRF ⇒ 403.

**S3 [BEFORE-EDIT] (Medium): `selRole` selects model data only, and only server code sets it.** Add this to §2.5 and to the M8-6 contract in §2.9.

- (a) `selRole` is used only as the first argument of `selectionFor(...)`. Everything else keys off `req.role` and never off `selRole`:
  - `route()`;
  - `validatePairing`, `ROLE_NEEDS` and the capability, tier and `webResearchIsolated` gates;
  - candidate order and tier notes;
  - which provider method runs (`runReadOnly`, never `runResearch`);
  - the Claude `profile` (never `'research'`) and `maxTurns`;
  - the `checkClaudeInit` options.
- (b) `selRole` is a typed `Role` set by server code only. No HTTP body, query or stored record supplies it. If it ever crosses a boundary, check it with `isRole`.
- (c) Test: `readOnly({ role: 'context', selRole: 'research' })`
  - routes exactly like `readOnly({ role: 'context' })`, with the same candidates and the same refusal when `context` is ineligible;
  - spawns the file-tool profile (`--tools Read,Grep,Glob`, no `WebSearch`/`WebFetch`, no `--allowedTools`);
  - runs `checkClaudeInit` without `profile: 'research'`;
  - differs from the plain call only in the `--model`/`--effort` slice.

### During implementation

**S4 [DURING] (Low): Migration hygiene.**
- (a) The warning for an invalid legacy value names the tool and the reason only, e.g. "agents.cursor.model was not a valid model id; kept in legacy.v5, not used". It never includes the value, its length or a prefix: hand-edited config text can be anything, including a pasted key.
- (b) If both `agents.<tool>.model` and `toolModels` are present (a hand edit), `toolModels` wins. The old key is moved to `legacy.v5` under the same rule and is never read.
- (c) `legacy.v5.agentsModel` is never returned by any API, rendered or logged. Today no server route returns `legacy`; keep it that way.
- (d) `toolModels` is normalised field by field, as M8-1 S8 requires:
  - own-property registry tool keys only (`__proto__` is inert);
  - `model` must match `MODEL_ID_RE`;
  - `custom` counts only when `=== true`;
  - entries are built from literals, never spread.
- (e) After v6 no code reads `agents.<tool>.model`. Removing the field from the type makes `npm run check` prove this.
- (f) Non-binding product note: Claude values such as `opus[1m]` fail the id rule. They will move to `legacy` and silently stop being sent. Surface them in the migration notice to the user. Widening the rule needs to come back to Security (M8-1 S9 note).

**S5 [DURING] (Low): Effort values are constant tokens that each CLI accepts.**
- Claude `--effort`: the fitted level must be in `levels` (discovered) **and** in a constant `CLAUDE_EFFORTS = ['low','medium','high','xhigh','max']` (from `--help`). `none` and `minimal`, even if discovered, are never sent to Claude.
- Codex: the fitted level must be in `levels` and in `EFFORT_TOKENS`.
- In both cases the argv string comes from the constant array element (or a literal table), never from the stored or request string.
- Cursor never gets an effort argument; its effort lives only in the listed id.
- Test: a forged `ResolvedSel { effortArg: 'high --yolo' }` or `'none'` handed straight to the builders produces no `--effort`/`-c` element (builder-level re-check).

**S6 [DURING] (Low): The Codex argv tail is pinned structurally, and the canary binding is unchanged.**
- `buildCodexArgs({model, effort, outFile})` equals the constant argv with **only** `--model=<id>` and/or the pair `-c`, `model_reasoning_effort="<tok>"` inserted immediately before `-o`.
- A table test over every token and a hostile set checks:
  - that the inserted `-c` value equals one of the literal strings exactly;
  - that no other `-c` key is ever added;
  - that the existing "absent flags" test still passes.
- `CODEX_ARGV_DIGEST` and the canary binding (`canary.ts:288`, `verification.ts:133`) stay computed over the constant argv without model or effort, so a model or effort choice never invalidates or forges an isolation verdict.
- Update the header comment at `codex.ts:45` ("no … string except the validated model name") to name the effort token.

**S7 [DURING] (Low): The isolation predicates are unaffected, with tests.**

`checkClaudeInit` must be called with the same options whatever the selection. Tests:
- A fake Claude run with `--model sonnet --effort low` and a good init passes.
- The same selection with an init that reports an extra tool, an MCP server, a skill, or `permissionMode !== 'dontAsk'` is still refused, for both the read-only and research profiles.

Constraints on the argv:
- Claude `fast`/`thinking` are refused at PUT, dropped at load and use, and no builder ever emits a fast, thinking, max-thinking-tokens or similar flag. Assert that the Claude argv flag set ⊆ today's set ∪ {`--model`, `--effort`}.
- Cursor read-only stays `--mode ask|plan` and build stays `--force`, independent of `sel`.
- `envelope.ts` forwards `sel` untouched, and its static no-push test is unchanged.
- Cursor custom ids and composed ids are never in the bracketed form, which the id rule already refuses. A test feeds `'gpt-5[effort=high]'` and `'x,fast=true'` at PUT, load and use.

**S8 [DURING] (Low): Strict `PUT /api/roles` details.**
- Top-level and role-entry keys are checked against allow-lists by iterating `Object.keys`. `__proto__`, `constructor` and `prototype` are refused with 400.
- `toolModels` keys must be registry ids checked with `Object.hasOwn`.
- Error messages and the `field` value contain only allow-listed role, key and tool names. An unknown key is reported as `JSON.stringify(key.slice(0, 30))` in the message and is never put in `field`.
- Values are not echoed beyond what the id rule already allows.
- Nothing is saved on any 4xx. An unexpected exception is a generic 500 with no stack and no path. The plan's "no 500s" means that the negatives table must yield 4xx.
- The unchanged-entry rule ("not re-judged") is acceptable because use-time resolution (§2.3) re-validates independently. Keep that independence: no code path may treat "accepted by PUT" as "safe for argv".

**S9 [DURING] (Low): `runsAs`, `who`, notes and labels.**
- `runsAs` is exactly `RUNS_AS_PREFIX[tool]` (a static string) + `' '` + the model-args helper output.
  - It never includes the configured `bin`, `cwd`, `--workspace`, `-o <outFile>`, `-n <name>`, the schema or any env.
  - The slice test (AC2) proves it is contiguous in the real argv.
  - A second test asserts that `runsAs` contains no `/` path segment taken from `cfg.agents.*.bin` or the test home.
- `who`, `notes`, `notices` and `problems[].message` are static wording plus cleaned catalog labels or `MODEL_ID_RE` ids.
- Each run-timeline note goes through `redact(text, secrets)` before `onEvent`, as the plan says.
- The UI (M8-U) renders all of these with `textContent`, consistent with M8-1 S19.
- `models[t].reason` is copied from the M8-1 view (already S13-clean). It is never rebuilt from an error object.

**S10 [DURING] (Low): The unknown-model classification is structural and bounded.**
- `cliRejectedModel` is set only when there is no `result` event, no isolation violation and no limit classification, and the selection actually carried a `modelArg`.
- `UNKNOWN_MODEL_RE` runs on the already-bounded stderr tail only, never on stdout or model text.
- It yields a boolean; the stderr text is not stored anywhere new.
- The regex is linear (bounded `.{0,40}`).
- The refresh this triggers stays under M8-1 S11's back-off. Test: a result whose prose says "unknown model" never sets the flag.

**S11 [DURING] (Low): The research row stays Claude-only.**
- `asks/service.ts` computes `selectionFor('research', 'claude')` and still calls `claude.runResearch` with `profile: 'research'`.
- No code in this slice sets `ProviderState.webResearchIsolated` or routes research through `route()`.
- PUT may change the research row's model and effort, but its `providers` keep today's refusal path (`validatePairing` refuses every research pairing, and an unchanged `['claude']` passes as unchanged).
- Test: a PUT that sets `research.providers: ['cursor']` is still 400.

**S12 [DURING] (Low): The hostile-input matrix (AC11) covers each entry point.** The values must never reach argv from any of:
- a hand-edited `config.json`;
- a PUT;
- a stale, tampered cache entry that passes `MODEL_ID_RE` but is not in the list at use;
- a forged `ResolvedSel` handed to a builder.

Hostile values to use:
- `--yolo`, `-c`;
- `opus --dangerously-skip-permissions`;
- `a=b`, `x y`, `gpt-5[effort=high]`;
- a 65-character id;
- an id with U+202E or a zero-width character;
- `__proto__`.

The assertion is on the **full argv** that the fake CLI records (`fixtures/fake-claude.mjs` and `fake-agent.mjs`), not only on helper output.

**S13 [DURING] (Low): The new pure modules stay pure.** `levels.ts` and `select.ts` do no I/O and no spawning. Model ids, families and labels are never used to build a file path, a regex, a shell string or HTML (M8-1 S9). `cursorVariantId` compares parsed tuples and returns an element of `family.ids` by reference/equality; it never returns a newly built string.

**S14 [DURING] (Low): Bookkeeping.** Add S1–S13 to §2e, §5 and AC11, and record this file as the authoritative text. The Security code review checks each one against a named test.

## Side finding: `route()` refuses `research` in production, and the `selRole` workaround

**Finding: confirmed, and not a vulnerability.**
- `routing.ts:53` refuses any role with `needs.research` unless `ProviderState.webResearchIsolated` is true, and no production code sets it.
- So the routing gate is fail-closed dead code in production, and `validatePairing` also refuses every research re-pairing at PUT.
- Deep Research is protected by other means. `asks/service.ts:118` hard-codes the Claude provider, and `runResearch` hard-codes `profile: 'research'` with safe-mode required. `checkClaudeInit(…, {profile:'research'})` then enforces the web-only tool set at run time.
- That is the M5 design Security approved. The four F11 locks (Cursor and Codex research among them) currently rest on that hard-coding plus the PUT refusal, not on `route()`.

Recommendation:
- Do **not** "fix" this in M8-2 by setting `webResearchIsolated`.
- Making research routable lets a non-Claude provider into the web profile. That is an F11-class change and needs its own Security design and a per-provider isolation predicate. S11 pins the current behaviour.
- Consider a one-line comment at `routing.ts:21` saying the flag is intentionally unset in production until F11.

**`selRole` for the M8-6 research brief: not a gate bypass, under S3.**
- The `webResearchIsolated` gate exists to keep web tools away from a provider whose web access is not isolated.
- The brief call routes as `context` and runs the read-only **file-tool** profile with no web tools. Its cwd is an empty `mkdtemp`, and its prompt holds only the fenced question (M8-6 §2.5: no repo snapshot, no facts, no file names).
- `selRole: 'research'` changes only which model and effort the selection picks. Under S3 nothing else follows from it: not eligibility, not the provider method, not the profile, not the init-check options.
- So no capability is gained that the `context` role does not already have.
- Two residual points, both acceptable:
  - (a) If the user's `context` chain includes Cursor, the brief may run in Cursor ask mode (the `partial` tier) with the usual visible tier note. The cwd is empty, so there is nothing to read.
  - (b) The brief is model-written text that later enters the web session prompt. M8-6 already fences it, treats it as untrusted, and requires the user to review it before Send (SD-4).

## Non-findings (checked, no change needed)

- **CSRF and loopback:** every non-GET route passes `http.ts:294-298` (JSON only, `x-conductor-csrf`, same-origin Sec-Fetch-Site). Cross-site GETs are refused. The body is capped. An agent with the user's uid that could read the CSRF token could already re-route providers today; letting it change a model adds no isolation capability.
- **`custom` Claude/Codex ids** pass through unchecked against a list, as today's free-text `agents.<tool>.model` does. That is the user's own choice behind CSRF. The id rule still guarantees a single non-option argv element. Claude's base URL and credentials come from the allow-listed env, never from the model id.
- **A stale catalog counts as discovered:** the M8-1 cache is re-validated on read (S8, S12) and lives under the 0700 Conductor home. An attacker who can write it can already write `config.json`. The worst case is a valid-shaped id, the same as a custom id.
- **`(NO ZDR)`** is warn-only (user decision Q8), consistent with M8-1 S19.
- **The Codex TOML value** `model_reasoning_effort="<tok>"`: the token is `[a-z]+` from a constant, so no quote, newline or table syntax can appear.

## Unblock condition

Source edits may start once S1, S2 and S3 are in the plan text and the Reviewer has approved the plan. Release of the slice needs the Security code review to confirm S1–S13 with named tests, including the full-argv hostile matrix (S12) and the preview purity spies (S2d).

Verdict: Approved with conditions

## Ruling on Reviewer N9: Codex effort override and `CODEX_ARGV_DIGEST` (2026-10-21, on the author's request)

**Accepted.** The digest stays computed over the constant argv only, without model or effort. A digest variant per selection is not required.

Why:
- The canary attests the sandbox, approval and shell-env pins. Those come from the constant `-c` keys plus `--sandbox read-only` and `--ignore-user-config`.
- `model_reasoning_effort` is a different literal key, so it cannot override any of them.
- Its value is a constant `[a-z]+` token, so nothing can break out of the TOML string.
- `--model=<id>` is a single `MODEL_ID_RE` element. It selects a model, not a sandbox, approval policy or model provider. `--ignore-user-config` means no user profile can map a model id to a different provider.
- So neither element can change what the canary checked.

This acceptance holds only while all of the following are true. They are S6, restated:
1. The variable tail is exactly `--model=<id>` and/or the pair `-c`, `model_reasoning_effort="<tok>"`, inserted immediately before `-o`. A structural test proves the rest of the argv equals the digested constant argv element for element.
2. The effort element is one of a fixed set of literal strings. No other `-c` key, and no other flag, ever comes from a selection.
3. Any future selection-derived Codex argument (a profile, a provider, a sandbox-adjacent key, `--oss`, `--search`, etc.) voids this ruling and must come back to Security. Option: fold the variable tail's *shape* into the digest then.
4. While Codex discovery is dormant (M8-1 S17/S18), no effort is sent. Enabling Codex discovery is still its own Security gate.
