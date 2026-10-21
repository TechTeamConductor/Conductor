# Implementation plan — M8-2 Who does what: tool, model and effort (F7)

- Task: brief F7 ("Who does what: tool, model and effort"), slice 2 of M8 (`workspace-v2-m8.md`). Consumes M8-1 (F7a discovery, `src/models/`).
- Author: TechTeam Architect
- Date: 2026-10-21
- Plan status: **rev 2 — Approved with conditions C1, C2 (Reviewer round 2); C1 and C2 applied below (§2f B1b, §2.3, §2.6, AC9). No re-review needed.**
  - Rev 1 got Changes requested (`.techteam/reviews/workspace-v2-m8-2-plan-review.md`). B1–B5 and N1–N14 are answered in **§2f**, and the affected lines below are corrected in place.
  - Security design: **Approved with conditions** (`.techteam/reviews/workspace-v2-m8-2-security-design.md` is the authoritative text, including the "Ruling on Reviewer N9"). The BEFORE-EDIT conditions S1–S3 are folded into §2.3, §2.5, §2.6 and §2.9; the DURING conditions S4–S13 are in §2e, §5 and AC11 (S14).
- **Precedence:** where §2f and older text conflict, §2f wins.
  - **§2g** (Security's S9 widening ruling, 2026-10-21, W1–W7) wins over both for anything about the model id rule.
  - Wherever this plan says `MODEL_ID_RE`, read `modelIdOk(tool, id)` (§2g).
- Lead decisions (2026-10-21):
  - Codex stays dormant (no repair permission).
  - Open questions 1–3 are accepted as this plan's defaults: a migrated Cursor value must be listed; custom-id effort is the union of the reported levels; fallback tools run on their own default model with the effort fitted.
  - The optional live check is **not authorised**.
  - ~~The Lead tells the user about Claude values like `opus[1m]` being dropped~~. **Superseded by §2g:** Claude `[1m]`-style values are now kept. Only Codex and Cursor bracketed values are refused.

## 1. Current State (verified against the code at clone HEAD `8eaab46`, 2026-10-21)

Rev 2 drift: `src/models/` now partly exists (M8-1 in progress: `types`, `sanitize`, `cursor-families`, `cursor`, `claude`, `cache`, `workdir`; no `service.ts` yet). Because of M8-1's edits, `putRoles` now sits at about `api.ts:259-305`. `ApiFail` has no `field`, and `http.ts:220,324` serialises only `{code, message}`.

- **Roles**: `src/agents/roles.ts` — `RoleConfig = { providers: ProviderId[]; autoByComplexity? }`, 10 roles, `normalizeRoles()` strict on shape (own-property, registry ids, build-class filter, ≤ 4 per chain). No model, effort or flag per role.
- **Routing**: `src/agents/routing.ts` — pure `route()`; returns ordered `candidates`. The `research` role needs `ProviderState.webResearchIsolated`, which **no production code sets** (only `test/routing.test.ts`). As a result `route({role:'research'})` is always `ineligible` in production, and the asks service calls `claude.runResearch` directly (`src/asks/service.ts:116-124`).
- **Models today**: one global free-text `cfg.agents.{claude,cursor,codex}.model` (`src/config.ts:114,124,129`; `src/types.ts:321-331`). Only Codex's model is validated (`CODEX_MODEL_RE`, `src/config.ts:40`). The builders append the model:
  - Claude: `buildClaudeArgs` pushes `--model <v>` after `-n <name>` and before `--json-schema` (`src/agents/claude.ts:58`).
  - Cursor: `buildCursorArgs` appends `--model <v>` last (`src/agents/cursor.ts:20`).
  - Codex: `buildCodexArgs` pushes `--model=<v>` before `-o <out> -` (`src/agents/providers/codex.ts:66`).
  - No effort flag exists anywhere.
  - Providers read the model straight from config: `providers/claude.ts:53,67`, `providers/cursor.ts:48,67`, `providers/codex.ts:368`, and `src/doctor.ts:132,201,212`.
- **Call sites that pick a provider for a role**:
  - `Agents.readOnly` (`src/agents/provider.ts:96-121`) is used by stages (`src/pipeline/stages.ts:395`), `callAgent` (`src/agents/caller.ts:40`, which serves asks and graph analysis items) and the context summary (`src/pipeline/engine.ts:373`).
  - Builds: `stages.ts:844-853` (role `implementation`/`debugging`) and `graph-build.ts:330-336` (item role, or `debugging` on loop > 1), both through `runBuild` (`src/pipeline/envelope.ts:81`, `b.run(...)` at about line 117).
  - Research: `asks/service.ts:120,124` → `claude.runResearch`.
- **Config**: `CONFIG_SPEC` current **5**, migrations 2→3, 3→4, 4→5 (`src/config.ts:45`). `normalizeConfig` also applies the v3→v4 transform idempotently when it sees old keys (precedent for this slice). `KNOWN_CONFIG_KEYS` at `src/config.ts:46`. `src/migrate.ts:474-481` runs the same migrations for the v1 home import.
- **API**:
  - `roles()` (`src/server/api.ts:236`) returns `{roles, choices, needs}` (`ApiRoles`, `src/types.ts:444`).
  - `putRoles()` (`api.ts:254-299`) is strict on the top level and on `providers`/`autoByComplexity`, but **silently ignores unknown keys inside a role entry**. The route is at `api.ts:534-540`; it saves after `normalizeConfig`. CSRF covers every mutation (`src/server/http.ts`).
- **CLI facts checked today (zero quota, `--help` only)**:
  - Claude Code 2.1.304: `--effort <level>` "(low, medium, high, xhigh, max)", and `--model <model>` takes an alias ("fable", "opus", "sonnet") or a full name.
  - Cursor `agent --help`: `--model <model>`, also a parameterised form `'id[context=1m,effort=high,fast=false]'`. **This slice does not use the parameterised form**: brackets and `=` fail the id rule. It uses only listed ids.
  - Codex is broken here (`ENOENT`, M8-1 §1).
- **M8-1 output this slice consumes** (confirmed with the M8-1 builder, see §2.9):
  - `ModelService.view(provider): CatalogView`: synchronous, memory only, never spawns.
  - `CatalogView.state ∈ reading|fresh|stale|unavailable`, plus `refreshing?: true`.
  - `models: ModelEntry[]` with `{id, label, resolved?, efforts?, defaultEffort?, isDefault?, fast?, thinking?, noZdr?}`.
  - Cursor `families: CursorFamily[]` with `{family, efforts ('' = base id), thinking, fast, label, noZdr, ids}`.
  - `parseCursorId(id)`, plus `MODEL_ID_RE` and `EFFORT_TOKENS = [none, minimal, low, medium, high, xhigh, max]`.
  - `noteUnknownModel(provider)`, rate-limited.
  - Codex discovery is dormant: its view is always `unavailable`.

## 2. Expected State

Every role carries an optional model selection: model, effort, Fast and Thinking. "Default model for each tool" replaces `agents.<tool>.model`. Stage argv is built from selections that are re-validated against the discovered list when the stage starts. Settings shows each row in the tool's own words, with a "Runs as …" line that the real argv builders produce. **With nothing set, every argv is byte-identical to today.**

### 2.1 Data model — config v6

```ts
// src/agents/roles.ts
export type EffortToken = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';  // = EFFORT_TOKENS (models/sanitize.ts)
export interface RoleModelSel {
  /** rev 2 (B2): the tool this choice was made for. Required whenever model/custom/fast/thinking is set; applied ONLY when that tool runs. */
  tool?: ProviderId;
  /** Unset = "Tool default". Claude/Codex: a discovered model id or a custom id. Cursor: a discovered FAMILY name (or, with custom, a listed id). */
  model?: string;          // MODEL_ID_RE
  custom?: true;           // the user typed the id ("Custom model id…"); only with `model`
  effort?: EffortToken;    // unset = the tool decides (no flag)
  fast?: true;             // Cursor only in this slice (Claude flags stored by M8-1, not surfaced — Q10)
  thinking?: true;         // Cursor only in this slice
}
export interface RoleConfig extends RoleModelSel { providers: ProviderId[]; autoByComplexity?: Partial<Record<Complexity, ProviderId>> }

// src/types.ts — Config
agents: { claude: { bin; isolation; maxTurns }; cursor: { bin }; codex: { bin } };   // `model` removed
toolModels: Partial<Record<ProviderId, { model: string; custom?: true }>>;           // "Default model for each tool"; absent = the tool chooses
```

- **Binding rule (rev 2, B2)**: a role's model, custom, Fast and Thinking belong to `sel.tool`, the tool they were chosen for. PUT and preview write `tool = selTool(role, providers)`, which is `'claude'` for `research` (N1) and `providers[0]` otherwise.
  - When the running tool is `sel.tool`, the role's own selection is used.
  - Any other tool gets its tool default, with the role's effort fitted to it. This covers a chain fallback, a complexity pick, M8-3's account or tool switch (brief F8), and a head changed by any other path (`PUT /api/settings stages.*`, `normalizeRoles` dropping a head, hand edits).
  - The effort is a role-level wish and is fitted to whichever tool runs.
- **On disk**, only set fields are written. A config that uses none of this has no new keys except `toolModels: {}`.
- **`normalizeRoles`** (load time, no catalog) checks shape only:
  - `model` must match `MODEL_ID_RE`.
  - `custom` and `fast`/`thinking` count only when `=== true`.
  - `effort` must be in `EFFORT_TOKENS`.
  - `custom` without `model` is dropped.
  - (rev 2, B2) If model, custom, Fast or Thinking are present without a registry-id `tool`, those fields are dropped and reported; `effort` is kept. A `tool` that is not the current head is kept as-is: the selection is simply not applied while another tool leads.
  - Every dropped value is reported via `report()`, the same way the code already does.
- **Migration `migrateConfigV5ToV6`** (pure, registered as `migrations[5]`; `CONFIG_SPEC.current = 6`):
  - For each tool whose `agents.<tool>.model` is a non-empty string matching `MODEL_ID_RE`, set `toolModels[tool] = { model, custom: true }`. It is custom because the value was free text that was never discovered, and `custom` keeps today's argv for Claude and Codex.
  - A value that fails the rule moves to `legacy.v5.agentsModel[tool]`, verbatim, with a log warning. It is never sent to a CLI.
    - **S4a**: the warning names only the tool and the reason ("agents.cursor.model was not a valid model id; kept in legacy.v5, not used"). It never contains the value, its length or a prefix.
    - **S4c**: `legacy.v5.agentsModel` is never returned by any API, rendered or logged.
  - Then `agents.<tool>.model` is deleted.
  - `normalizeConfig` applies the same transform when the input has `agents.*.model` and no `toolModels` (hand-edited file or direct call). This matches the v3→v4 precedent and is idempotent.
    - **S4b**: if both are present (a hand edit), `toolModels` wins. The old key moves to `legacy.v5` under the same rule and is never read.
  - **S4d**: `toolModels` is normalised field by field:
    - own-property registry tool keys only (`__proto__` is inert);
    - `model` must match `MODEL_ID_RE`;
    - `custom` counts only when `=== true`;
    - entries are built from literals, never spread.
  - **S4e**: after v6 no code reads `agents.<tool>.model`. The field is removed from the type, so `npm run check` proves it.
  - **S4f (as amended by §2g)**: the migration checks each value with `modelIdOk(tool, value)`.
    - A Claude `opus[1m]` / `sonnet[1m]` passes `CLAUDE_MODEL_RE` and is kept as `toolModels.claude = { model, custom: true }`.
    - A Codex `x[1m]` or a Cursor `id[effort=high]` fails and moves to `legacy.v5`, with a `legacyNotices` entry. That entry is the "human message" W6 requires.
    - Any further widening goes back to Security (W7).
  - `defaultConfig().version = 6`, and `'toolModels'` is added to `KNOWN_CONFIG_KEYS`.
  - The first save after loading a v5 file takes the existing pre-upgrade backup (`backupBeforeNextSave`). `src/migrate.ts` picks up `migrations[5]` automatically.

### 2.2 Levels, fitting and wording — `src/models/levels.ts` (pure, no I/O)

- `EFFORT_LABEL = { claude: 'Effort', codex: 'Reasoning effort', cursor: 'Model effort' }`.
- `LEVEL_LABEL = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }`.
- `RANK = { none: -1, minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }`.
- `levelsFor(tool, catalog, sel): EffortToken[] | null` returns **exactly the discovered levels**. `null` means "this model has no effort setting", and no flag is sent.
  - Claude/Codex, discovered model: the entry's `efforts`. Absent or empty means `null`.
  - Tool default: the levels of the default model's entry. That is `toolModels[tool]` if set, else Claude's `isDefault` entry (or Codex's).
  - Custom id (Claude/Codex): the union of every level the tool's catalog reports (decision, §6). With no catalog, `null`.
  - Cursor family: `family.efforts` minus `''`. `hasBase = efforts.includes('')`. Cursor custom ids, Cursor tool default, and families with no tokens (`auto`, `composer-*`) give `null`.
- `fitEffort(levels, wanted): { effort?: EffortToken; adjusted: boolean }` follows the design's `fitEffort` with production semantics:
  - `levels === null` ⇒ `{ effort: undefined, adjusted: wanted !== undefined }`.
  - `wanted` in `levels` ⇒ kept.
  - `wanted === undefined` ⇒ stays unset, which keeps argv byte-identical. Exception: a Cursor family with no base id needs a token, so it fits toward `medium`.
  - Otherwise ⇒ the nearest level by `RANK`; on a tie, the higher one.
  - Real cases from `fixtures/real/claude-initialize-2.1.304.json`, where `claude-sonnet-4-6` and `claude-opus-4-6` report `low, medium, high, max`:
    - `xhigh` on Sonnet 4.6 ⇒ a tie between high and max ⇒ `max`;
    - `max` on Sonnet 4.6 ⇒ kept;
    - any effort on `claude-haiku-4-5-20251001` (no levels) ⇒ dropped.
- `effortNote(tool, modelLabel, from, to)` returns the one-line note, for example "Sonnet 4.6 has no Extra high, so the effort is now Max." or "Haiku 4.5 has no effort setting." Static wording plus cleaned labels only.
- (rev 2, N3) **Cursor base id**: the prototype's `mediumBase` assumption (base id = medium) is deliberately not ported, because production cannot know it. Where `hasBase`, `models.cursor.options[i]` carries `hasBase: true`, and the UI shows a first effort option "Default" (value `null`) that selects the base id. A request for `medium` on a family without a `-medium` id fits by the rule above (a tie goes to the higher level).
- (rev 2, N14) `levels.ts` holds a unit check that the `EffortToken` union and M8-1's `EFFORT_TOKENS` are the same set, plus a type-level `satisfies` check.

### 2.3 Selection resolution — `src/models/select.ts` (pure; the shared contract with M8-3 and M8-6, §2.9)

```ts
export interface ResolvedSel {
  tool: ProviderId;
  modelArg?: string;        // exact argv value for --model (Cursor: a listed variant id); undefined ⇒ no model flag
  effortArg?: EffortToken;  // Claude --effort / Codex model_reasoning_effort; always undefined for Cursor (it lives in the id)
  label: string;            // display: "Opus", "Tool default (Opus 5.5)", "GPT-5.3 Codex" — cleaned catalog label or the id
  effort?: EffortToken; fast: boolean; thinking: boolean;
  source: 'role' | 'tool-default';
  fallback?: 'no-longer-offered' | 'list-unavailable' | 'not-in-list';   // the stored choice could not be used ⇒ tool default used
  noZdr?: true;             // Cursor "(NO ZDR)" — warn only (decision Q8)
  notes: string[];          // one-line, static wording + cleaned labels; shown in roleViews and as a run-timeline note
}
export function toolDefaultSelection(cfg: Config, tool: ProviderId): RoleModelSel;          // { model, custom } from cfg.toolModels[tool]; {} if unset
export function resolveSelection(tool: ProviderId, sel: RoleModelSel, catalog: CatalogView | null, source: ResolvedSel['source']): ResolvedSel;
export function selectionForTool(role: Role, tool: ProviderId, cfg: Config, catalog: CatalogView | null): ResolvedSel;
//   cfg.roles[role].tool is set AND tool === it (rev 2, B2) ⇒ resolveSelection(tool, roleSel, …, 'role')
//   else — including a role with no `tool` (effort only, or nothing) ⇒ resolveSelection(tool, { ...toolDefaultSelection(cfg, tool), effort: roleSel.effort }, …, 'tool-default')  (effort fitted, flags dropped)
export function modelOffered(tool: ProviderId, catalog: CatalogView | null, sel: RoleModelSel): true | false | null;   // rev 2 (B4): null = list unknown; see the §2.9 table
export function fitEffort(levels: readonly string[] | null, wanted?: string): { effort?: EffortToken; adjusted: boolean };   // plain strings at the boundary (M8-3), validated inside
```

Resolution rules, applied in order and the same for every caller:

1. **No model** (Tool default): `modelArg` comes from `toolModels[tool]` and is resolved by these same rules. If that is unset, `modelArg` is undefined.
   - (rev 2, N2) Fast and Thinking are dropped.
   - The role's effort is fitted to the default model's levels (rule 5). For Cursor, the fitted effort selects a variant of the default family through rule 4.
2. **Discovered model** (`custom` absent):
   - Claude/Codex: the id must be in `catalog.models` and the catalog state must be `fresh` or `stale` (stale still counts as discovered).
   - Cursor: `model` must be a `family` in `catalog.families`.
   - Not found with a catalog present ⇒ `fallback: 'no-longer-offered'`, use rule 1, and add the note "<label> is no longer offered by <Tool> — using the tool default."
   - No catalog (`reading`/`unavailable`) ⇒ `fallback: 'list-unavailable'`, use rule 1, and add a note.
3. **Custom id**: must match `MODEL_ID_RE`.
   - Claude/Codex: passed as-is. This is today's behaviour for a migrated `agents.<tool>.model`.
   - **Cursor fails closed**: the id must be one of the listed ids. Otherwise ⇒ `fallback: 'not-in-list'`, use rule 1. With no list at all ⇒ `'list-unavailable'`.
   - A Cursor custom id carries no effort, Fast or Thinking.
4. **Cursor composition**: `cursorVariantId(family, {thinking, effort, fast})` returns **the id in `family.ids` whose `parseCursorId` tuple equals the request**. It is a lookup, never string concatenation. The result is therefore always a listed id. This also covers ids like `…-max-thinking` that do not round-trip (M8-1 note). If no listed id matches the tuple, the variant is not offered:
   - At resolution: fall back, in order, to (a) the same tuple without `fast`, (b) without `thinking`, (c) the nearest effort that exists without flags. Each step adds a note. Note (c) never applies when `effort` is unset and `hasBase`.
   - At `PUT`: refused (§2.6).
5. **Effort**: `fitEffort(levelsFor(...), sel.effort)`. If adjusted, add `effortNote`. `effortArg` is set only for Claude and Codex, and only to a token from the `EFFORT_TOKENS` constant array (indexed by the fitted value, never the stored string).
6. **Fast/Thinking**: kept only for Cursor and only if the family reports them. Otherwise dropped, with a note when they were set.
7. **Final gate (defence in depth; Security S1, binding)**: `modelArg` must match `MODEL_ID_RE`.
   - **For Cursor, `modelArg` must equal an id in the current catalog's listed ids, whatever its source** (role, `toolModels`, migration, custom).
   - A Cursor family name that is not itself a listed id (a family with no base id) is never sent as-is.
   - The membership exemption applies **only to Claude and Codex custom ids (role or `toolModels`)**, and only after `MODEL_ID_RE` (rev 2, B5c). A Cursor `toolModels` custom id is never exempt.
   - Failing this ⇒ no `modelArg`, plus the note "the model id was refused" (or the `list-unavailable` / `not-in-list` note).
   - S1 tests:
     - a migrated `agents.cursor.model: 'gpt-5'` with no Cursor list ⇒ no `--model` and a `list-unavailable` note;
     - the same value with a list that lacks it ⇒ `not-in-list`;
     - a family name with no base id is never sent;
     - (B5c) a migrated `toolModels.cursor` that is not listed ⇒ no `--model` and a note.

### 2.4 Argv (same builders, new pure pieces)

| Tool | New pure helper (exported) | Placement in the full argv | Unset ⇒ |
| --- | --- | --- | --- |
| Claude | `claudeModelArgs({model, effort}) → ['--model', m]? + ['--effort', e]?` | exactly where `--model` is today: after `-n <name>`, before `--json-schema` | `[]` ⇒ argv byte-identical |
| Cursor | `cursorModelArgs({model}) → ['--model', id]?` | last, as today | `[]` |
| Codex | `codexModelArgs({model, effort}) → ['--model=<id>']? + ['-c', 'model_reasoning_effort="<e>"']?` | where `--model=` is today, before `-o <out> -` | `[]`; `CODEX_ARGV_DIGEST` unchanged |

- `buildClaudeArgs`/`buildCursorArgs`/`buildCodexArgs` call these helpers. The builders keep their current `model?` parameter (existing tests unchanged) and gain `effort?` (Claude, Codex).
- Each helper re-checks `MODEL_ID_RE`; an id that fails is omitted. Each value is its own argv element. The Codex `--model=` single element is unchanged.
- **Efforts (S5)**: the fitted level must be in the discovered `levels` **and** in a constant set:
  - Claude: `CLAUDE_EFFORTS = ['low','medium','high','xhigh','max']`, from `--help`. `none` and `minimal` are never sent to Claude.
  - Codex: `EFFORT_TOKENS`.
  - The argv string is the constant array element (or a literal table), never the stored or request string.
  - The builders re-check it, so a forged `effortArg` (`'high --yolo'`, or `'none'` for Claude) produces no element.
  - Cursor never gets an effort argument.
- **Codex (S6)**: the effort goes in as the single literal `-c` value `model_reasoning_effort="<tok>"`, consistent with the existing `-c` constants.
  - The argv equals the constant argv with only `--model=<id>` and/or that `-c` pair inserted immediately before `-o`. No other `-c` key is ever added.
  - `CODEX_ARGV_DIGEST` and the canary/verification binding stay computed over the constant argv without model or effort.
  - The header comment at `codex.ts:45` is updated to name the effort token.
  - Dormant until Codex discovery is enabled (no catalog ⇒ no levels ⇒ no flag).
- **Claude Fast/Thinking (S7)**: no builder ever emits a fast, thinking or thinking-token flag. Claude's argv flag set is ⊆ today's set ∪ {`--model`, `--effort`}. Cursor stays `--mode ask|plan` / `--force`, independent of `sel`.
- **`runsAs(tool, resolved): string`** = `RUNS_AS_PREFIX[tool]` (`'claude'`, `'agent'`, `'codex exec'`, static — never the configured bin path) + `' '` + `<tool>ModelArgs(resolved).join(' ')`. A test asserts that the helper's output appears as a contiguous slice of the full stage argv for every tool, so the preview cannot drift from what runs.

### 2.5 Plumbing (who resolves, who receives)

- `Agents` gains `opts.catalog?: (tool: ProviderId) => CatalogView | null`. The default `() => null` means tests and doctor have no catalog. `src/runtime.ts` wires `(t) => models.view(t)` after M8-1's `ModelService` exists.
- New method `agents.selectionFor(role, tool): ResolvedSel` = `selectionForTool(role, tool, cfg, catalog(tool))`.
- **Read-only**: `Agents.readOnly` resolves per candidate: `selectionFor(req.selRole ?? req.role, cand.id)`. It passes `sel` in `ReadOnlyRunReq` and emits each `notes[]` line once as a `kind:'note'` event (agent `conductor`, redacted) before the run.
  - New optional `ReadOnlyReq.selRole?: Role` (agreed with M8-6, §2.9). **Security S3, binding**:
    - (a) `selRole` is used **only** as the first argument of `selectionFor(...)`. Everything else keys off `req.role`, never `selRole`:
      - `route()`;
      - `validatePairing`, `ROLE_NEEDS`, and the capability, tier and `webResearchIsolated` gates;
      - candidate order and tier notes;
      - the provider method that runs (`runReadOnly`, never `runResearch`);
      - the Claude `profile` (never `'research'`) and `maxTurns`;
      - the `checkClaudeInit` options.
    - (b) `selRole` is a typed `Role` set by server code only. No HTTP body, query or stored record supplies it. If it ever crosses a boundary, it is checked with `isRole`.
    - (c) Test: `readOnly({ role: 'context', selRole: 'research' })`
      - routes exactly like `readOnly({ role: 'context' })`, with the same candidates and the same refusal when `context` is ineligible;
      - spawns the file-tool profile (`--tools Read,Grep,Glob`, no `WebSearch`/`WebFetch`, no `--allowedTools`);
      - runs `checkClaudeInit` without `profile: 'research'`;
      - differs from the plain call only in the `--model`/`--effort` slice.
- **Builds**: `stages.ts` and `graph-build.ts` compute `sel = agents.selectionFor(role, rt.candidates[0].id)` and pass `sel` in `BuildInput`. `runBuild` forwards it unchanged into `b.run({..., sel})`. The envelope does not look at it, and none of its safety steps change.
- **Research (S11)**: `asks/service.ts` passes `sel: agents.selectionFor('research', 'claude')` and still calls `claude.runResearch` with `profile: 'research'`.
  - This slice never sets `ProviderState.webResearchIsolated` and never routes research through `route()`. Making research routable is F11-class and has its own Security design.
  - Optional one-line comment at `routing.ts:21`: the flag is intentionally unset in production until F11.
- **Providers**: `ReadOnlyRunReq`, `ResearchRunReq` and `BuildRunReq` gain `sel?: ResolvedSel`. Claude, Cursor and Codex use `req.sel?.modelArg` / `req.sel?.effortArg`. When `sel` is absent, they use `resolveSelection(tool, toolDefaultSelection(cfg, tool), null, 'tool-default')`, which for an untouched config gives no flags. They never read `cfg.agents.<tool>.model` again (the field is gone; `npm run check` proves it).
  - `doctor.ts` uses the same tool-default resolution.
  - Provider `selfTest` canaries run on the tool default.
- **Unknown-model failure** → `models.noteUnknownModel(tool)`:
  - `runClaude`/`runCursor` set `AgentResult.cliRejectedModel = true` only when there was **no result event** (a structural failure) and the CLI's own stderr tail matches `UNKNOWN_MODEL_RE` (`/\b(unknown|invalid|unsupported|not (found|available))\b.{0,40}\bmodel\b|\bmodel\b.{0,40}\b(not (found|available|supported)|unknown|invalid)\b/i`).
  - It is never set from model prose (M12 principle).
  - The caller then calls `noteUnknownModel`, and only when `sel.modelArg` was set. Rate limiting is M8-1's (S11).

### 2.6 API

**`GET /api/roles`** (extends `ApiRoles`; existing keys unchanged):

```ts
roles: Record<Role, { providers: ProviderId[]; autoByComplexity: Partial<Record<Complexity, ProviderId>> | null; tool: ProviderId | null; model: string|null; custom: boolean; effort: string|null; fast: boolean; thinking: boolean }>;  // GET form: every key always present (null/false when unset) — PUT-round-trippable (R2-N4, C2)
toolModels: Record<ProviderId, { model: string|null; custom: boolean }>;
roleViews: Record<Role, { tool: ProviderId; runsAs: string; who: string /* "Claude · Opus · High" */; status: 'ok'|'no-longer-available'|'list-unavailable'|'not-in-list'|'other-tool'|'signed-out'; notes: string[] }>;   // rev 2: research.tool is always 'claude'
rows: { id: string; roles: Role[] }[];                     // rev 2 (N10): ROLE_ROWS, one server constant
legacyNotices: { tool: ProviderId; message: string }[];   // rev 2 (B3b): static wording, never the old value
models: Record<ProviderId, {
  effortLabel: string; levels: { value: EffortToken; label: string }[];          // label map for this tool
  state: CatalogView['state']; refreshing: boolean; fetchedAt: number|null; reason?: string;   // copied from the M8-1 view (already sanitised)
  defaultLabel: string;                                                          // inner text of "Tool default (…)": cleaned label, or "the tool chooses"
  options: { value: string; label: string; efforts: EffortToken[]|null; hasBase: boolean; fast: boolean; thinking: boolean; noZdr: boolean }[];
  // Claude/Codex: models (Claude's `default` alias entry is NOT listed — it is what "Tool default" means); Cursor: families
}>;
```

**`PUT /api/roles`** (strict; CSRF as today):

- **Top-level keys**: `roles?`, `toolModels?`, `acknowledge?`. At least one of `roles`/`toolModels` must be present. Any other key ⇒ 400.
- **Role entry keys**: `providers` (required, 1–4, as today), `autoByComplexity`, `tool` (server-derived, echo only; §2f B1b), `model`, `custom`, `effort`, `fast`, `thinking`. **Any other key ⇒ 400.** This is new; today unknown keys are ignored.
- **Values**:
  - `model`: `null` or a string matching `MODEL_ID_RE`.
  - `custom`: boolean. `true` is accepted only with a string `model`; `false` is always accepted, so the GET shape `{model: null, custom: false, effort: null, fast: false, thinking: false}` round-trips (R2-N4).
  - `effort`: `null` or in `EFFORT_TOKENS`.
  - `fast`/`thinking`: boolean or null.
  - `__proto__`/`constructor` are refused by the existing `isPlain`/own-property pattern.
- **Key absent** means keep the stored value. `null`/`false` means unset. Rev 2 extends this to every key except `providers`, including `autoByComplexity` (§2f B1).
- **Semantic checks** against the role's new head tool and its current catalog, through the same `select.ts` code:
  - discovered model not listed ⇒ 400 `unknown_model`;
  - catalog unavailable and a discovered model is requested ⇒ 400 `models_unavailable` ("refresh models, choose Tool default or type a custom id");
  - Cursor custom id not listed, or no Cursor list at all ⇒ 400 `unknown_model` / `models_unavailable`;
  - Cursor custom with effort or flags ⇒ 400;
  - effort not in `levelsFor` ⇒ 400 `effort_not_offered`;
  - `fast`/`thinking` on Claude/Codex, or on a Cursor family without them ⇒ 400 `not_offered`;
  - Cursor composed variant not listed ⇒ 400 `unknown_model`, naming the tuple.
  - Error bodies carry `{ field: "roles.<role>.<key>" }` so the UI can focus the control ("Save refused with focus").
- **Implicit rules** (UI-free callers get the same behaviour):
  - **The head tool changes and the body omits the model fields** ⇒ model, custom, fast and thinking are cleared, and the effort is fitted to the new tool's default. This happens in today's tool-only PUT from the M8-U row.
  - **The model changes and the body omits `effort`** ⇒ the stored effort is fitted.
  - Either case adds a one-line entry to `notices`.
- **Unchanged entries** (rev 2, B1b): an entry is not re-judged only when its selection tool is the same as the stored `tool` **and** its normalised model fields equal the stored ones. A GET→PUT round trip therefore works even when a stored model is "No longer available". Model fields echoed after a head change count as omitted (§2f B1).
- **`toolModels`**: `{ [tool]: { model: string|null, custom?: boolean } }`. Registry ids only. The same model checks apply, without effort or flags.
- **Response**: `{ ok, roles, toolModels, roleViews, notices }`.

**`POST /api/roles/preview`** (new; CSRF; body exactly as PUT; **never saves**):

- Returns `{ roles, toolModels, roleViews, notices, problems: [{ field, message }] }`.
- The `roles` in the response are fitted: the implicit rules above have been applied, and a draft that names a variant gets its effort and flags fitted with notes instead of a 400.
- Purpose: the UI shows "Runs as …" and the fitting notes for a **draft** from the same server code. It never re-implements fitting or argv in `ui/`.
- **Purity (Security S2, binding)**:
  - (a) `PUT` and `preview` share one pure planning function, `planRoles(body, cfg, states, catalogs) → { next, notices, problems }`. It works on a deep copy (as `putRoles` does today with `JSON.parse(JSON.stringify(cfg.roles))`). `PUT` = `planRoles` + save; `preview` = `planRoles` only. (In PUT mode, problems become the 400s described above.)
  - (b) `preview` never:
    - calls `saveConfig`, `setConfig` or the backup;
    - calls `ModelService.refresh`, `noteVersion` or `noteUnknownModel`;
    - resolves a binary;
    - spawns.

    It reads the catalog only through the synchronous `view()`.
  - (c) Every `/api/roles*` route other than `GET /api/roles` passes the existing mutation gate in `http.ts` (JSON content type, `x-conductor-csrf`, same-origin Sec-Fetch-Site). A request without CSRF gets 403.
  - (d) Tests: see AC10.
- Status 200 even when there are `problems`. A malformed body (wrong types or keys) is still 400.

### 2.7 "No longer available" (brief F7a, last-but-one bullet)

- `roleViews[r].status = 'no-longer-available'` (plus the note) when the stored discovered model is missing from a present catalog. The UI renders the select's current option as "<model> — No longer available".
- At run time, the step runs on the tool default. The run timeline gets the note "<model> is no longer offered by <Tool> — this step ran on the tool default."
- A list that becomes unavailable (`list-unavailable`) behaves the same way, with its own wording.

### 2.8 Role rows (mapping confirmed)

Quick Ask → `context`; Deep Research → `research`; Design the work → `requirements` + `architecture`; Write the plan → `planning`; Review the plan → `review`; Build the code → `implementation` + `debugging` + `documentation`; Verify the result → `verification`.

The server stays role-level and does **not** mirror. The UI (`ui/modes.js`, M8-U) writes the same tool and selection to every role of a row in one PUT. When the roles of a row differ (hand-edited config), the row shows the first role and its `roleViews` note "Build the code and Debugging differ — saving applies this to all."

### 2.9 Contracts agreed with peers (2026-10-21)

- **M8-3 accounts**:
  - M8-3 calls M8-2's exports from `src/models/select.ts` and `levels.ts` and does not re-implement them:
    - `toolDefaultSelection(cfg, tool)`;
    - `levelsFor`;
    - `fitEffort(levels: readonly string[] | null, wanted?: string) → {effort?, adjusted}`;
    - `selectionForTool(role, tool, cfg, catalog: CatalogView | null)`;
    - `modelOffered(tool, catalog: CatalogView | null, sel) → true | false | null`.
  - M8-3 passes the **target account's** `CatalogView`.
  - **Rev 2 (B4), confirmed by the M8-3 author on 2026-10-21.** M8-3 copies the table below verbatim into its §2.C, and its D-D now reads: "unknown ⇒ modelOffered null ⇒ counts as offering for ordering (`!== false`); the selection itself falls back to the tool default with a note". The candidate's `offersModel = modelOffered(tool, accountView, tool === sel.tool ? roleSel : toolDefaultSelection(cfg, tool))`.

    **Model selection semantics.** Each cell is `modelArg` / `fallback` / `modelOffered`. "Default" means the tool-default resolution: `toolModels[tool]` resolved by these same rules; unset ⇒ no `--model`. Effort is always fitted to whatever model is actually used.

    | catalog state | Claude/Codex discovered id | Claude/Codex custom id | Cursor family | Cursor custom id | Tool default |
    |---|---|---|---|---|---|
    | null (no view), `reading`, `unavailable` | default / `list-unavailable` / null | the id / – / true | default / `list-unavailable` / null | default / `list-unavailable` / null | toolModels value if it may be sent under these rules, else no `--model` / – / true |
    | `stale` or `fresh`, choice listed | the id / – / true | the id / – / true | listed variant id for (thinking, effort, fast). Missing tuple: fitted variant (drop fast → drop thinking → nearest effort) with notes / – / true | the id / – / true | as above / – / true |
    | `stale` or `fresh`, choice NOT listed | default / `no-longer-offered` (signed-out wording when `signedIn === false`) / false | the id / – / true | default / `no-longer-offered` / false | default / `not-in-list` / false | as above / – / true |

    Effort row (applies everywhere): `levelsFor` gives exactly the discovered levels. Custom Claude/Codex ids use the union of the tool's reported levels. With no list, or a model that has no levels, effort is dropped with a note.
  - The config key is `cfg.toolModels`, not `agents.<tool>.defaultModel`.
  - (As built, code review deviation #8.) `resolveSelection(tool, sel, catalog, source, toolDefault?)` takes an optional 5th `toolDefault` (the `toolModels[tool]` selection used when `sel` falls back), and `fitEffort(levels, wanted?, { needsToken? })` an optional 3rd argument (a Cursor family with no base id fits toward `medium`). Both are optional: M8-3 calls `selectionForTool`, which passes them. `toolDefaultResolved(cfg, tool)` is the no-catalog tool-default resolution the providers use when no `sel` is passed. `models[t]` also carries view-only `defaultEfforts` / `customEfforts`.
  - Argv builders stay account-agnostic. M8-3 adds `req.account` beside M8-2's `req.sel`.
  - **M8-2 claims config v6; M8-3 takes v7.**
  - A Cursor custom id is not automatically "offered" (fail closed).
- **M8-6 home**:
  - F3 "Design the work" uses role `requirements` and gets its resolved selection; `architecture` is a UI mirror only and is never called by F3.
  - The F4 research brief cannot use `agents.readOnly({role:'research'})`, because research is always ineligible in production routing (§1). It uses `agents.readOnly({ role: 'context', selRole: 'research' })`. M8-2 adds `selRole`.
  - Under Security S3, `selRole` changes only the model and effort. Routing, gates, provider method, profile (file tools, never web), `maxTurns` and init check all follow `role: 'context'`, and only server code sets it.
  - Security's side finding: this is not a bypass of the research gate.
- **M8-1 discovery**:
  - M8-1 provides `view()` (sync, memory only), `families[].ids`, `parseCursorId`, `MODEL_ID_RE`, `EFFORT_TOKENS` and `noteUnknownModel`.
  - M8-2 adds only new files under `src/models/` (`select.ts`, `levels.ts`) and does not edit M8-1's files.
- **M8-U UI**:
  - It feature-detects `roles[r].{model,effort,fast,thinking}`, `roleViews[r].runsAs` and `models`. These keys are always present from M8-2 on; unset is `null`/`false`, not `undefined`.
  - **Additions to the contract**: `roles[r].custom`, `toolModels`, `roleViews[r].{who,status,notes}`, `models[t].{effortLabel,levels,defaultLabel,options}`, `POST /api/roles/preview`, and error `field` on PUT.
  - Labels are rendered with `textContent` only.
  - **Round-trip rule (M8-U review R2-N4)**: `GET /api/roles` `roles[r]` must stay PUT-round-trippable. The UI echoes the role object back on PUT, keeping unknown fields.
    - `roles[r]` therefore holds exactly the PUT-accepted keys: `providers`, `autoByComplexity`, `tool` (rev 2), `model`, `custom`, `effort`, `fast`, `thinking`. In GET form `autoByComplexity` and `tool` are `null` when unset.
    - All view-only data (`who`, `status`, `notes`, `runsAs`, labels, levels) lives in `roleViews[r]` or `models[t]`, never in `roles[r]`. Likewise `toolModels[t]` holds only `{model, custom}`.
    - Strict PUT refuses unknown keys, so any later slice (e.g. M8-3) that adds a key to `roles[r]` must add it to the PUT allow-list in the same change.
    - Tests: `test/server-roles-models.test.ts` → "GET roles echoed unchanged on PUT is accepted and changes nothing (incl. a no-longer-available model)"; "roles[r] keys ⊆ PUT role-entry allow-list; toolModels[t] keys ⊆ {model, custom}".

### 2f. Rev 2 — Reviewer round 1 (B1–B5 resolved; N1–N14 each taken or declined). Lead decisions applied.

**B1 — `PUT /api/roles` merge semantics.** One rule for the whole entry; `planRoles` is shared with preview.

- **(a) Absent and null.**
  - `providers` is required (1–4) and replaces the chain, as today.
  - Every other key (`autoByComplexity`, `tool`, `model`, `custom`, `effort`, `fast`, `thinking`): absent ⇒ keep the stored value; `null` ⇒ clear it. `false` also clears the booleans.
  - `autoByComplexity`: an object replaces it (validated as today); `null` clears it.
  - Test: "a model-only PUT keeps the chain and autoByComplexity".
- **(b) What "unchanged" means** (round-2 C1 applied).
  - Normalise the body's model fields first: `null`/`false` ⇒ absent.
  - `newHead = selTool(role, body.providers)` and `oldHead = selTool(role, stored.providers)`. Both use `selTool`, which is `'claude'` for `research`. **"Head changed" always compares `newHead` with `oldHead`, never with the stored `sel.tool`.**
  - **`tool` is server-derived.** It is accepted only as an echo:
    - absent, or equal to the stored `tool` ⇒ fine;
    - `null` while the body still carries a model, custom, Fast or Thinking value ⇒ 400 `bad_request`, field `roles.<r>.tool` ("tool is set by Conductor; send it back as received or leave it out");
    - `null` with no such fields ⇒ the selection is cleared.
  - **Unchanged** ⇒ not re-judged, and the stored selection, including an inert other-tool one, is kept byte for byte. All three must hold:
    - `newHead === oldHead`;
    - the normalised fields equal the stored ones;
    - the body `tool` is absent or equal to the stored `tool`.
  - **Head changed and the fields equal the stored ones** (an echo from GET→edit→PUT) ⇒ treated as **omitted**:
    - model, custom, Fast and Thinking are cleared;
    - `tool := newHead`;
    - the effort is fitted to `newHead`'s default;
    - one entry is added to `notices`.
  - **Fields differ from the stored ones** (whether or not the head changed) ⇒ judged as a new selection for `newHead`.
    - `tool := newHead`.
    - `tool_mismatch` (400, field `roles.<r>.tool`) applies **only here**, when the body `tool` is present, not null, and differs from `newHead`.
  - Tests:
    - "head change + echo ⇒ cleared with notice";
    - "head change + new Cursor selection ⇒ judged against Cursor";
    - **"PUT /api/settings moves planning's head to Cursor, then the GET roles are echoed unmodified ⇒ 200, config bytes unchanged, roleViews.planning.status stays other-tool"** (C1);
    - "tool:null with model kept ⇒ 400 field roles.<r>.tool";
    - "tool_mismatch only for a new selection".
- **(c) The GET form round-trips.**
  - `custom:false`, `fast:false`, `thinking:false`, `effort:null`, `model:null`, `tool:null|<id>` and `autoByComplexity:null` are always accepted.
  - Only a `true` or a string value triggers the offer checks.
  - Test: "PUT of the whole GET `roles` object, unmodified ⇒ 200, config bytes unchanged". It covers a role whose stored model is "No longer available" and a role whose `tool` is no longer the head.
- **(d) Preview error mapping.**
  - In preview, the following become entries in `problems[]` (`{field, code, message}`) with status 200:
    - `409 needs_acknowledgement`;
    - `400 unsupported_pairing`, `tool_mismatch` and the semantic 400s (`unknown_model`, `models_unavailable`, `effort_not_offered`, `not_offered`).
  - Only a malformed body (a wrong type or an unknown key) gives 400.
- **(e) Error `field` on the wire.**
  - `ApiFail` gains an optional `field` (constructor `(status, code, message, field?)`).
  - `http.ts` `fail()` writes `{ error: { code, message, field? } }`, with `field` omitted when undefined, so every existing negative test still passes unchanged. `src/server/http.ts` is added to §3.
  - `field` only ever holds allow-listed names (S8).

**B2 — selection bound to a tool.**
- Taken as recommended: `RoleModelSel.tool` (§2.1). Model, custom, Fast and Thinking apply only when the running tool is `sel.tool`. v6 is new, so no extra migration is needed.
- `roleViews[r]` when `sel.tool` is not the head: `status: 'other-tool'`, note "Chosen for Claude; Cursor now leads, so Cursor's default model is used."
- Each path is tested, and none of them binds the old choice to the new head:
  - "PUT /api/settings {stages:{plan:'cursor'}} on a planning role with a Claude model ⇒ the Cursor run has no Claude id; roleViews says other-tool";
  - "normalizeRoles drops an ineligible build head ⇒ the selection is not applied to the new head";
  - "hand-edited config: tool missing ⇒ fields dropped and reported; tool ≠ head ⇒ not applied";
  - "a Claude id that equals a Cursor family name is never applied to Cursor".
- `applySettings` itself needs no logic change, because the binding makes the old choice inert.

**B3 — visible, never silent.**
- **(a) Research.**
  - Before calling `runResearch`, `asks/service.ts` writes `sel.notes` (redacted, capped like other events) into the ask record's `events`, prefixed "conductor:".
  - When a fallback happened, it adds one line to the report's `basis`: "model: tool default (<reason>)".
  - AC8 is extended to research.
- **(b) Migration loss.**
  - `GET /api/roles` gains `legacyNotices: { tool: ProviderId; message: string }[]`. It is derived only from the presence of `legacy.v5.agentsModel[tool]`, and only while `toolModels[tool]` is unset.
  - The message is static: "Your earlier <Tool> model setting was not kept (it is not a valid model id), so <Tool> now uses its default. Choose a model under 'Default model for each tool'." It **never contains the old value** (S4a/S4c).
  - `conductor doctor` prints the same line as a warning.
  - AC6 adds these cases (§2g): Claude `sonnet[1m]` kept; Codex `x[1m]` and Cursor `id[effort=high]` moved to legacy with a notice.
- **(c) §6 corrected:** Claude and Codex keep today's argv only for values that pass their tool's id rule (§2g).

**B4 — semantics table.**
- One table, agreed and confirmed with the M8-3 author (§2.9). Both plans carry it verbatim.
- `modelOffered` returns `true | false | null`.
- The exported signatures take `CatalogView | null`.
- `fitEffort` takes plain strings at the boundary.
- M8-2 keeps fail-to-default: an undiscovered id is never sent. M8-3's D-D is changed to match.

**B5 — proof obligations.**
- **(a) AC1 is end to end.**
  - Commit 0 (test-only, **before the first M8-2 source edit**): `test/argv-golden-e2e.test.ts` runs each real path against the fakes with a throw-away home and compares the **full argv from `calls.jsonl`** against **literal arrays** committed in that file. The arrays are captured from today's code, and the test never calls the builders to compute them. The paths are:
    - `Agents.readOnly` for Claude plan / plan_review / verify;
    - Cursor ask;
    - Codex exec (`fake-codex.mjs`);
    - `runBuild` for Cursor;
    - `AskService` research (Claude);
    - the doctor Claude and Cursor probes;
    - provider `selfTest` canaries (Claude, Cursor).
  - The same commit pins `CODEX_ARGV_DIGEST()` to a committed hex literal.
  - After M8-2, the test must pass unchanged for (a) defaults, (b) a v5 file without models, and (c) migrated `opus` / `gpt-5.1-codex` (literal arrays with today's `--model`).
- **(b) AC4 uses the real fixture cases** in §2.2 (`xhigh` → `max` on Sonnet 4.6; `max` kept; Haiku 4.5 drops effort with one note).
- **(c) Rule 7's exemption is limited to Claude/Codex** (§2.3), with the `toolModels.cursor` test added.

**N items.**
- **N1, taken.**
  - `roleViews.research.tool` is fixed to `claude`, and PUT judges research model fields against Claude (`selTool`).
  - Tests: "route() always receives req.role; skipped and fallback notes come from req.role whatever selRole is" and "roleViews.research.tool === 'claude' whatever research.providers is".
  - The false "web access is not isolated yet" reason in `choices.research.claude` is **recorded as a follow-up that needs Security** (set `webResearchIsolated` for Claude from `isolation === 'safe-mode'`, or say "Claude only: runs in Claude's isolated web profile" for that row). It is **not fixed here**, as the Lead decided.
- **N2, taken** (§2.3 rule 1).
- **N3, taken** (§2.2).
- **N4, taken:** the engine's context summary (`engine.ts:373`) is pinned to the tool default. A server-only `ReadOnlyReq.toolDefaultOnly?: true` makes `selectionFor` use `toolDefaultSelection` with no role effort. It is under the same S3 discipline as `selRole`: model selection only, set only by server code. `src/pipeline/engine.ts` is added to §3. Test: "context summary runs without the Quick Ask --model/--effort".
  - (R2-N1) If both `toolDefaultOnly` and `selRole` are set, **`toolDefaultOnly` wins** and `selRole` is ignored.
  - The S3 test also covers `toolDefaultOnly`: it changes only the `--model`/`--effort` slice, never the route, profile or init options.
- **R2-N2, legacy pruning:** `legacy.v5.agentsModel[tool]` is **never pruned automatically**. It stays on disk as the user's record (never served, logged or rendered, S4c). Only its `legacyNotices` entry stops showing, once `toolModels[tool]` is set.
- **N5, taken.**
  - PUT and preview return `roles` in GET form.
  - When `ApiDeps.models` is absent, `roles()` uses `null` catalogs (never a 501). `models[t].state` is then `unavailable` with the reason "Model lists are not available in this mode."
- **N6, taken** (AC10): same body cap and CSRF as PUT; preview output fed back into PUT ⇒ 200 with the same `runsAs`.
- **N7, taken** (= S4b): in a v6 input that has both keys, the stray `agents.<tool>.model` moves to `legacy.v5` with a warning (tool + reason only), and `legacyNotices` applies.
- **N8, taken as a known limit.** Claude may report an unknown `--model` as an `is_error` result event, in which case `cliRejectedModel` never fires. That is fail-safe (no refresh; the run fails visibly). The live check that would confirm it is not authorised, so it is recorded here and in §6.
- **N9, taken.** Security ruled "accepted" (review file, "Ruling on Reviewer N9"): the digest stays over the constant argv, under its four restated conditions. Any future selection-derived Codex argument voids the ruling. The `codex.ts:45` comment is updated.
- **N10, taken:** the row map becomes one server constant, `ROLE_ROWS` in `src/models/select.ts` (row id → roles, in the §2.8 order). `GET /api/roles` serves it as `rows`, so the row-level "differ" note has one owner. The server still never mirrors writes.
- **N11, taken (display only):** a custom id equal to a discovered id is shown as that discovered option in `roleViews`/`who`. Storage and argv are unchanged.
- **N12, taken:** `models[t]` gains `customEffortHint`: "With a custom model id, every level the tool reports is offered; the model may not support all of them."
- **N13, taken:** when `signedIn === false`, the note reads "<model> is not offered while <Tool> is signed out — using the tool default", with `status: 'signed-out'`.
- **N14, taken** (§2.2).

### 2g. Model id rule per tool — Security "S9 widening ruling" (2026-10-21, Approved with conditions; text at the end of `.techteam/reviews/workspace-v2-m8-1-security-design.md`)

- **W1: one entry point.** Every model value M8-2 handles is checked with `modelIdOk(tool, id)`, from M8-1's `src/models/sanitize.ts`. There is no global "wide" rule.
  - Rules:
    - `MODEL_ID_BASE_RE` = the old `MODEL_ID_RE` value, unchanged;
    - `CLAUDE_MODEL_RE` = `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}(?:\[[a-z0-9]{1,8}\])?$`;
    - `CODEX_MODEL_RE` stays narrow.
  - Places that use it, re-checked at use (S19):
    - `normalizeRoles` (via `sel.tool`);
    - `toolModels` normalisation;
    - the v5→v6 migration;
    - `PUT` / preview;
    - resolution rules 3 and 7;
    - the argv helpers.
  - A role selection is checked against `sel.tool`. A value with no valid `tool` is already dropped (§2.1).
- **W2: Claude.** `CLAUDE_MODEL_RE` applies to discovered ids, custom ids and `toolModels.claude`. `--model claude-fable-5-1[1m]` is one separate argv element, with no shell.
- **W3: Codex** keeps the narrow rule, and `--model=<id>` never carries brackets.
  - A Codex `x[1m]` in roles or `toolModels` (custom or migrated) is refused with a human message:
    - at PUT, 400 with `field`;
    - at load, the value is dropped or moved to `legacy.v5` and reported, with `legacyNotices`.
  - `codexModelArgs` re-checks it, so it never reaches argv.
- **W4: Cursor** keeps the narrow rule **and** list membership (S1). A bracketed Cursor value is refused even as a custom id. `id[effort=…]` stays impossible.
- **W5: tests.** One accept/reject table per provider is run through `modelIdOk`, PUT, load and the argv helpers. In `test/models/select.test.ts` → "modelIdOk per provider: W5 table":
  - Claude only: `claude-fable-5-1[1m]` and `opus[1m]` are accepted for Claude and rejected for Codex and Cursor.
  - Rejected for all three:
    - malformed suffixes: `x[1m][2m]`, `x[1M]`, `x[effort=high]`, `x[1m,fast]`, `x[ 1m]`, `x[]`, `x[123456789]`, `x[1m]y`;
    - bad starts: `[1m]`, `-x[1m]`;
    - trailing whitespace: `x[1m]\n`, `x[1m] `;
    - length: a 75-character value. A 74-character value passes for Claude.
- **W6: argv snapshot.** `test/argv-model.test.ts` → "Claude --model claude-fable-5-1[1m] is one argv element". `test/config-v6.test.ts` → "Codex x[1m] refused at load/save with a human message, never in argv".
  - The real Claude fixture's `[1m]` entry is kept with 0 dropped. The counts come from M8-1's updated recording.
- **W7:** any later widening (other bracket contents, other providers) goes back to Security.
- **M8-1 interface update (from the M8-1 builder, 2026-10-21):**
  - `sanitize.ts` exports `MODEL_ID_BASE_RE`, `CLAUDE_MODEL_RE`, `modelIdOk(provider, id)` and `cleanId(s, provider)`. `cleanId` checks the raw value with no trimming or repair.
  - `MODEL_ID_RE` remains, but it is the narrow rule; M8-2 never uses it for Claude. `CODEX_MODEL_RE` is also narrow.
- **Fixtures:**
  - `fixtures/real/claude-initialize-2.1.304-conductor-env.json` (5 entries: `default`, `opus`, `claude-fable-5-1[1m]`, `sonnet`, `haiku`, all reporting `low…max`) is what Conductor really sees. It drives:
    - the "Tool default (…)" label (`default` → `claude-opus-5-5`);
    - the W6 `[1m]` argv case;
    - the `roleViews` and API tests.
  - The 13-entry `claude-initialize-2.1.304.json` (recorded with `CLAUDE_CODE_ENTRYPOINT` set) stays real data for the fitting shapes AC4 needs: Sonnet 4.6 without `xhigh`, and Haiku 4.5 with no levels. It is labelled in the test as "a real reply shape, not Conductor's own env". With Conductor's env, those cases would only arise if the CLI lists such models.
- The S12 hostile matrix keeps `gpt-5[effort=high]` and adds `x[1m]` for Codex and Cursor.

### 2e. Security design — Approved with conditions (`.techteam/reviews/workspace-v2-m8-2-security-design.md`, authoritative)

**Binding conditions.** The review file is the authoritative text. Each condition has a named test in §5, and the Security code review checks each one.

Before the first edit (folded into the plan text):

| # | Condition | Where |
| --- | --- | --- |
| S1 | A Cursor `modelArg` must be a listed id whatever its source; the custom exemption covers Claude/Codex only | §2.3 rule 7 |
| S2 | Preview is provably pure: one shared `planRoles` on a deep copy; no save, backup, refresh, `noteUnknownModel`, bin resolution or spawn; `view()` only; CSRF | §2.6 |
| S3 | `selRole` selects the model only; set server-side only | §2.5, §2.9 |

During implementation:

| # | Condition | Where |
| --- | --- | --- |
| S4 | Migration hygiene: the warning never shows the value; `toolModels` wins over the old key; `legacy.v5` is never served; field-by-field `toolModels`; no reader of `agents.*.model`; per-tool id rule (§2g) with `legacyNotices` for refused values | §2.1, §2g |
| W1–W7 | Per-tool id rule (`modelIdOk`): brackets for Claude only; Codex/Cursor narrow; Cursor also list-checked; W5 table; W6 snapshot | §2g |
| S5 | Effort = discovered levels ∩ constant set (`CLAUDE_EFFORTS` / `EFFORT_TOKENS`); the argv string comes from the constant; builders re-check; never for Cursor | §2.4 |
| S6 (+ N9 ruling) | Codex tail pinned structurally (only `--model=` and/or one literal `-c` pair before `-o`); `CODEX_ARGV_DIGEST` and canary binding unchanged; header comment updated. The N9 ruling ("accepted") holds only under its four conditions: (1) structural tail test, element for element; (2) the effort is a literal from a fixed set and no other selection-derived `-c` or flag exists; (3) any future selection-derived Codex argument voids the ruling and goes back to Security; (4) no effort while discovery is dormant | §2.4 |
| S7 | Isolation predicates unaffected: `checkClaudeInit` gets the same options and still refuses bad inits with a model set (read-only and research); Claude flag set ⊆ today ∪ {`--model`, `--effort`}; Cursor modes constant; envelope forwards `sel` untouched; bracketed ids refused at PUT, load and use | §2.4, §2.5 |
| S8 | Strict PUT: allow-lists via `Object.keys`; `__proto__`/`constructor`/`prototype` ⇒ 400; `field` only from allow-listed names (an unknown key is shown as `JSON.stringify(key.slice(0,30))` in the message only); nothing saved on 4xx; generic 500 without stack or path; "accepted by PUT" never means "safe for argv" | §2.6 |
| S9 | `runsAs` = static prefix + helper output only (no bin, cwd, `--workspace`, `-o`, `-n`, schema or env); `who`/notes/notices/problems are static wording + cleaned labels/ids; notes redacted before `onEvent`; `models[t].reason` copied from the M8-1 view | §2.4, §2.6 |
| S10 | `cliRejectedModel` only with no `result` event, no isolation violation, no limit, and a `modelArg` present; bounded stderr tail only; boolean only; linear regex | §2.5 |
| S11 | Research row stays Claude-only via `runResearch`; no `webResearchIsolated` set; `research.providers: ['cursor']` PUT still 400 | §2.5 |
| S12 | Hostile matrix at every entry point, asserted on the **full argv the fake CLI records** | AC11 |
| S13 | `levels.ts`/`select.ts` pure; ids/labels never in a path, regex, shell string or HTML; `cursorVariantId` returns an element of `family.ids`, never a newly built string | §2.2, §2.3 |

Earlier list of items submitted for sign-off (all accepted, kept for traceability):

1. Argv elements derived from discovered text pass three checks: (a) `MODEL_ID_RE`, which rules out a leading `-`, spaces, `=`, `[` and quotes; (b) membership in the current catalog (§2.3 rule 7); (c) one element each.
2. Effort values come only from the constant token array.
3. Cursor ids come from a lookup in `family.ids`, never concatenation.
4. Cursor custom ids fail closed.
5. A hand-edited config cannot inject: shape is checked at load, and membership and rule are re-checked at use.
6. `runsAs`, `who` and notes contain only static wording plus cleaned ids and labels, are redacted before the run log, and are rendered with `textContent`.
7. "(NO ZDR)" is warn-only (decision Q8).
8. The read-only and research isolation predicates (`checkClaudeInit`, research profile) are unaffected by `--model`/`--effort`. A test runs `checkClaudeInit` on a fake init with a model set.
9. The builder's no-push envelope is unchanged: `sel` is forwarded as data, and the envelope's static test is unchanged.
10. `UNKNOWN_MODEL_RE` reads only CLI stderr on a structural failure.
11. Strict `PUT /api/roles` and `POST /api/roles/preview` (CSRF, own-property, key allow-lists, no 500s).

### What must remain unchanged

- With no role selection and no `toolModels`, every stage argv is byte-identical, for read-only, research and build on all three tools, including the Codex digest. This is pinned end to end by `test/argv-golden-e2e.test.ts` (B5a: literal arrays and a digest literal committed before the first M8-2 edit) and by M8-1's builder golden tests (N8), both passing unmodified.
- Routing (`route()` stays pure and its inputs are unchanged).
- The envelope and every safety invariant in `CLAUDE.md`.
- The env allow-lists.
- `ProviderState`.
- Existing `PUT /api/roles` tests (body shapes they send are still valid).
- `npm test` green, `npm run check` clean, zero runtime deps, live tests untouched.

### Acceptance criteria

1. **AC1 Byte-identical, end to end (B5a)**: the full argv recorded in `calls.jsonl` by the fakes equals literal arrays committed in commit 0, before any M8-2 source edit.
   - Paths: `Agents.readOnly` Claude plan/plan_review/verify; Cursor ask; Codex exec; Cursor `runBuild`; AskService research; the doctor probes; provider `selfTest` canaries.
   - Configs: (a) `defaultConfig()`; (b) a v5 config with no models; (c) a v5 config with `agents.claude.model: 'opus'` and `agents.codex.model: 'gpt-5.1-codex'`, migrated to v6, giving the same `--model` as today.
   - `CODEX_ARGV_DIGEST()` equals a committed hex literal.
2. **AC2 Argv with selections**:
   - Claude `--model <id> --effort <l>` sits at today's `--model` position.
   - Codex `--model=<id> -c model_reasoning_effort="<l>"` sits before `-o`.
   - Cursor `--model <listed variant id>` comes last.
   - `runsAs` equals a contiguous slice of the real argv for each tool.
3. **AC3 Cursor composition** against the recorded 265-id fixture (M8-1):
   - Every listed id in a multi-id family is reachable from its tuple through `cursorVariantId`.
   - A missing tuple ⇒ PUT 400, and at run time falls back fast → thinking → effort with notes.
   - Ids such as `…-max-thinking` resolve to themselves.
   - The output is always a listed id.
4. **AC4 Effort fitting**:
   - Table tests over `fitEffort`: kept, nearest, tie → higher, `null` levels ⇒ dropped, unset stays unset, and a Cursor family without a base id fits toward `medium`.
   - Real fixture cases (B5b): `xhigh` on `claude-sonnet-4-6` ⇒ `max` with one note; `max` on Sonnet 4.6 ⇒ kept; any effort on `claude-haiku-4-5-20251001` ⇒ dropped with one note.
   - Each adjustment produces exactly one note.
5. **AC5 Custom ids**: the rule is applied at PUT (400 + field), at load (dropped + reported) and at use (omitted).
   - Claude/Codex custom ids pass through.
   - A Cursor custom id that is not listed fails closed.
6. **AC6 Migration v5→v6**: pure function tests, plus a load/save round trip with the pre-upgrade backup.
   - An invalid old model goes to `legacy.v5`.
   - Per §2g, a Claude `sonnet[1m]` is **kept** (`toolModels.claude`, same `--model sonnet[1m]` as today).
   - A Codex `x[1m]` and a Cursor `id[effort=high]` each produce a `legacyNotices` entry in `GET /api/roles` and a `conductor doctor` warning, and neither contains the value (B3b, W6).
   - A v6 input carrying both keys: `toolModels` wins and the stray value moves to `legacy.v5` (N7).
   - A v6 file is refused by a v5 build (`NewerVersionError`, existing behaviour).
   - `normalizeConfig` is idempotent.
   - `src/migrate.ts` imports a v5 home to v6.
7. **AC7 Strict PUT /api/roles**: the negatives table below gives 400s, the unchanged-entry round trip works, the implicit tool-change and model-change rules apply with notices, CSRF is checked, and nothing is saved on refusal.
   - Negatives: unknown entry key, unknown top-level key, bad types, `__proto__`, effort not offered, flags not offered, unknown model, models unavailable, Cursor custom with effort, `tool_mismatch`.
   - Every refusal carries `error.field`.
   - Rev 2 (B1): the GET form round-trips unmodified; a model-only PUT keeps the chain and `autoByComplexity`; `null` clears; a head change plus an echo ⇒ cleared with a notice; a head change plus a new selection ⇒ judged against the new head.
   - B2 paths: `PUT /api/settings stages.*`, `normalizeRoles` head drop, hand edits.
8. **AC8 "No longer available"**: a fixture catalog in which the saved model disappears ⇒ `roleViews.status` is `no-longer-available`, the run uses the tool default (no `--model`, or the `toolModels` value), and the run log has the visible note.
   - An unavailable list ⇒ `list-unavailable`.
   - Signed out ⇒ `signed-out` wording (N13).
   - **Research (B3a)**: the note is in the ask record's events, and the fallback line is in the report's basis.
9. **AC9 Tool switch contract**: a fallback candidate, a complexity pick, or a head that is not `sel.tool` runs with the tool default plus the fitted effort and no flags. Tests cover `selectionForTool` and `modelOffered` directly (used by M8-3's router tests).
10. **AC10 Preview (S2d)**: `POST /api/roles/preview` returns fitted selections and notes. The `runsAs` it returns equals what a saved config produces. A preview call leaves everything untouched:
    - `config.json` bytes and mtime are unchanged;
    - the in-memory `getConfig()` object is deep-equal before and after;
    - a `runProcess` spy sees zero calls;
    - a `ModelService` spy sees zero `refresh`/`noteVersion`/`noteUnknownModel` calls;
    - no backup file is created;
    - without CSRF ⇒ 403;
    - same body cap as PUT;
    - 409/400 pairing outcomes come back as `problems` with a 200 (B1d);
    - preview output fed back into PUT ⇒ 200 with the same `runsAs` (N6).
11. **AC11 Security (S1–S13; S14)**: every condition in §2e has a named test (§5 table). In particular:
    - S12: the hostile values below never reach the **full argv recorded by the fake CLIs**. The values are `--yolo`, `-c`, `opus --dangerously-skip-permissions`, `a=b`, `x y`, `gpt-5[effort=high]`, a 65-character id, an id with U+202E or a zero-width character, and `__proto__`. The entry points are a hand-edited config, a PUT, a stale tampered cache entry that passes the rule but is not listed at use, and a forged `ResolvedSel`.
    - `checkClaudeInit` is unaffected (S7).
    - The preview is pure (S2).
    - `selRole` does not change routing or profile (S3).
12. **AC12**: `npm run check` clean, `npm test` green, no new dependency, no real CLI spawned in `npm test` (M8-1 B1 guard).

## 3. Files to Be Changed

| File path | Action | Purpose | Required changes | Reason |
| --- | --- | --- | --- | --- |
| `src/models/levels.ts` | Create | effort labels, ranks, `levelsFor`, `fitEffort`, `effortNote` | §2.2 | F7 fitting |
| `src/models/select.ts` | Create | `ResolvedSel`, `toolDefaultSelection`, `resolveSelection`, `selectionForTool`, `modelOffered`, `cursorVariantId`, `runsAs`, view builders for `roleViews`/`models` | §2.3, §2.6 | F7 + M8-3 contract |
| `src/agents/roles.ts` | Modify | `RoleModelSel`, `EffortToken`; `normalizeRoles` shape checks for the new fields | §2.1 | config v6 |
| `src/config.ts` | Modify | `migrateConfigV5ToV6`; `CONFIG_SPEC.current = 6`; `toolModels` normalised; `agents.*.model` removed; `KNOWN_CONFIG_KEYS` | §2.1 | migration |
| `src/types.ts` | Modify | `Config.toolModels`, `agents` without `model`, `ApiRoles` additions, `AgentResult.cliRejectedModel?` | §2.1, §2.6 | types |
| `src/agents/claude.ts` | Modify | `claudeModelArgs`, `effort?` in `buildClaudeArgs`/`ClaudeCall`; `cliRejectedModel` | §2.4, §2.5 | argv |
| `src/agents/cursor.ts` | Modify | `cursorModelArgs`; `cliRejectedModel` | §2.4 | argv |
| `src/agents/providers/codex.ts` | Modify | `codexModelArgs`, `effort?` in `CodexArgvOpts`; model from `req.sel` | §2.4 | argv |
| `src/agents/providers/{claude,cursor}.ts` | Modify | take `req.sel`, fall back to the tool-default resolution | §2.5 | plumbing |
| `src/agents/providers/types.ts` | Modify | `sel?: ResolvedSel` on the three run requests | §2.5 | plumbing |
| `src/agents/provider.ts` | Modify | `opts.catalog`, `selectionFor`, per-candidate `sel`, notes, `selRole`, `noteUnknownModel` callback | §2.5 | plumbing |
| `src/pipeline/stages.ts`, `src/pipeline/graph-build.ts` | Modify | compute `sel` for the builder candidate; emit notes | §2.5 | builds |
| `src/pipeline/envelope.ts` | Modify | `BuildInput.sel?` forwarded to `b.run` unchanged (one field) | §2.5 | builds |
| `src/asks/service.ts` | Modify | `sel` for research | §2.5 | research row |
| `src/doctor.ts` | Modify | tool-default resolution instead of `cfg.agents.*.model` | §2.5 | removed field |
| `src/runtime.ts` | Modify | `new Agents(getConfig, { catalog: (t) => models.view(t), onUnknownModel: (t) => models.noteUnknownModel(t) })` | §2.5 | wiring |
| `src/server/api.ts` | Modify | `roles()` additions (incl. `rows`, `legacyNotices`, null catalogs without `ApiDeps.models`); `planRoles` shared by strict `putRoles` and `POST /api/roles/preview`; `ApiFail.field` | §2.6, §2f B1 | API |
| `src/server/http.ts` | Modify | `fail()` serialises `{ error: { code, message, field? } }` (field omitted when undefined) | §2f B1e | Save refused with focus |
| `src/pipeline/engine.ts` | Modify | context summary `readOnly({..., toolDefaultOnly: true})` | §2f N4 | quota |
| `src/doctor.ts` (also) | Modify | `legacyNotices` warning line | §2f B3b | visible migration loss |
| `test/argv-golden-e2e.test.ts` | Create (**commit 0, before any source edit**) | literal full-argv arrays per real path + `CODEX_ARGV_DIGEST` hex literal | — | B5a / AC1 |
| `test/models/levels.test.ts`, `test/models/select.test.ts` | Create | AC3, AC4, AC5, AC8, AC9 | — | tests |
| `test/argv-model.test.ts` | Create | AC1, AC2, runsAs slice property | — | tests |
| `test/config-v6.test.ts` | Create | AC6 | — | tests |
| `test/server-roles-models.test.ts` | Create | AC7, AC10, API side of AC8 | — | tests |
| `test/agents-selection.test.ts` | Create | per-candidate selection, notes, `selRole`, unknown-model hook (fake agents) | — | tests |
| `test/roles-config.test.ts`, `test/providers/codex.test.ts` | Modify | expectations `version: 5 → 6`; `agents.codex.model` → `toolModels.codex` | — | regression |
| `fixtures/fake-claude.mjs`, `fixtures/fake-agent.mjs` | Modify | record received `--model`/`--effort`; scenario `unknown-model` (stderr, no result) | small | tests |
| `docs/API.md`, `docs/ARCHITECTURE.md`, `README.md` (config section) | Modify | new fields, preview endpoint, migration, binding rule | — | docs |

Not touched: `ui/*` (M8-U wires the controls), M8-1's files in `src/models/`, `env.ts`, `spawn.ts`, `test/live/`. `routing.ts` gets at most the one-line comment from S11 and no logic change. `src/agents/providers/codex.ts` also gets the S6 header comment update.

## 4. Implementation TODO

- [ ] 0. Gate: Reviewer approval of this plan (S1–S3 are already in the text, Security approved with conditions). M8-1 merged (this slice imports `src/models/*`).
- [ ] 0b. Commit 0 (test-only): `test/argv-golden-e2e.test.ts` with literal arrays captured from today's code and the digest literal; green on today's code.
- [ ] 1. `levels.ts` + `select.ts` + unit tests (pure; real Claude/Cursor fixtures from M8-1, Codex documented-shape fixture).
- [ ] 2. Config v6: types, `normalizeRoles` fields, `migrateConfigV5ToV6`, `toolModels`; fix the two existing tests; `npm run check` shows every `agents.*.model` reader → fix each (providers, doctor).
- [ ] 3. Argv helpers + builders + golden/slice tests (AC1, AC2).
- [ ] 4. Plumbing: `Agents` catalog/selectionFor/selRole/notes; providers; stages/graph-build/envelope `sel`; research; runtime wiring; unknown-model hook. Fake-agent tests.
- [ ] 5. API: `roles()` additions, strict `putRoles`, `preview`; API tests.
- [ ] 6. Docs; `npm run check`; `npm test`; checkpoint in `.techteam/runs/active-run.md`. Commits: (1) levels/select, (2) config v6, (3) argv + plumbing, (4) API + docs.
- [ ] 7. Live: none. The argv is unit-tested against the CLIs' `--help` facts and the recorded lists. The opt-in live check (it spends quota) is **not authorised** (Lead, 2026-10-21) and is not run. `test/live/` is not touched.
- [ ] 8. Security code review: S1–S13, each against its named test (§5).

## 5. Testing Strategy

The brief's §7 "Model and effort" items, plus the M8-2 share of the "Discovery" and "Router" items, map to named tests:

| Brief §7 item | Test file → test name |
| --- | --- |
| argv snapshots | `test/argv-model.test.ts` → "Claude/Codex/Cursor argv with model+effort: exact elements at today's --model position"; "runsAs is a contiguous slice of the real argv (every tool, every selection kind)" |
| unset ⇒ byte-identical | `test/argv-golden-e2e.test.ts` (commit 0) → "full argv from calls.jsonl equals the committed literals on every path (defaults / v5 without models / migrated opus + gpt-5.1-codex)"; "CODEX_ARGV_DIGEST equals the committed literal"; M8-1 golden tests (N8) unmodified |
| Cursor composition against the recorded list | `test/models/select.test.ts` → "cursorVariantId reaches every listed id of the 265-id fixture from its tuple"; "missing tuple: PUT refuses, run falls back fast→thinking→effort with notes"; "composed output is always a listed id" |
| effort fitting | `test/models/levels.test.ts` → "fitEffort table (kept/nearest/tie-higher/null/unset)"; "xhigh on claude-sonnet-4-6 (real fixture) becomes max with one note; max kept"; "Haiku 4.5 drops effort with one note"; "Cursor family without base id fits toward medium"; "EffortToken set equals EFFORT_TOKENS" |
| custom id validation | `test/models/select.test.ts` → "custom id rule at use; Cursor custom fails closed"; `test/server-roles-models.test.ts` → "PUT custom id: rule refused with field"; `test/config-v6.test.ts` → "hand-edited bad model dropped and reported at load" |
| migration from `agents.<tool>.model` | `test/config-v6.test.ts` → "v5→v6 moves models to toolModels (custom), invalid to legacy.v5"; "load+save round trip keeps a pre-upgrade backup"; "normalizeConfig idempotent"; "migrate.ts imports a v5 home as v6" |
| strict `PUT /api/roles` | `test/server-roles-models.test.ts` → "negatives table: 400/403 with error.field, nothing saved"; "GET form round-trips unmodified"; "model-only PUT keeps chain and autoByComplexity; null clears"; "head change + echo ⇒ cleared with notice"; "head change + new selection judged against the new head"; "tool_mismatch"; "model change fits stored effort"; "PUT /api/settings stages.plan=cursor leaves the Claude selection inert (other-tool)"; existing `test/server-providers.test.ts` unchanged and green |
| disappearing model ⇒ "No longer available" + visible fallback (Discovery) | `test/models/select.test.ts` → "saved model missing from catalog ⇒ fallback no-longer-offered"; "§2.9 semantics table: every cell (modelArg/fallback/modelOffered)"; "signed out ⇒ signed-out wording"; `test/agents-selection.test.ts` → "run uses tool default and the timeline shows the note"; "research fallback note in ask events and basis"; "context summary pinned to tool default (N4)"; "route() always gets req.role; roleViews.research.tool is claude (N1)"; `test/server-roles-models.test.ts` → "roleViews status no-longer-available"; "legacyNotices without the value" |
| next tool uses its default model + fitted effort (Router; M8-3 builds on it) | `test/models/select.test.ts` → "selectionForTool: non-head tool gets toolModels default + fitted effort, flags dropped"; "modelOffered per catalog"; `test/agents-selection.test.ts` → "fallback candidate runs with the tool default" |

Security conditions (review file `workspace-v2-m8-2-security-design.md`) → named tests:

| Condition | Test file → test name |
| --- | --- |
| S1 | `test/models/select.test.ts` → "Cursor migrated value with no list: no --model, list-unavailable"; "Cursor migrated value not in list: not-in-list"; "family name without a base id is never sent" |
| S2 | `test/server-roles-models.test.ts` → "preview is pure: config bytes/mtime/in-memory unchanged, zero spawn, zero refresh/noteUnknownModel, no backup"; "preview without CSRF ⇒ 403"; "PUT and preview share planRoles (same fitted output)" |
| S3 | `test/agents-selection.test.ts` → "selRole changes only the --model/--effort slice: same route, same refusal, file-tool profile, init check without research"; "toolDefaultOnly likewise, and wins over selRole" (R2-N1) |
| S4 | `test/config-v6.test.ts` → "invalid legacy model: warning has tool+reason only, never the value"; "toolModels wins over agents.*.model"; "legacy.v5 never in any API response"; "toolModels normalised field by field (__proto__ inert)"; "Claude opus[1m] kept; Codex x[1m] and Cursor id[effort=high] go to legacy with a notice (§2g)" |
| W1–W7 (§2g) | `test/models/select.test.ts` → "modelIdOk per provider: W5 table (via modelIdOk, PUT, load, argv helpers)"; `test/argv-model.test.ts` → "Claude --model claude-fable-5-1[1m] is one argv element"; `test/config-v6.test.ts` → "Codex x[1m] refused at load/save with a human message, never in argv" |
| S5 | `test/argv-model.test.ts` → "forged effortArg ('high --yolo', 'none' for Claude) yields no --effort/-c element"; "Cursor argv never carries an effort argument" |
| S6 | `test/argv-model.test.ts` → "Codex argv = constants + only --model= and/or one literal -c before -o (every token, hostile set)"; "CODEX_ARGV_DIGEST unchanged"; existing absent-flags test green |
| S7 | `test/agents-selection.test.ts` → "checkClaudeInit with --model/--effort: good init passes; extra tool/MCP/skill/permissionMode still refused (read-only and research)"; `test/argv-model.test.ts` → "Claude flag set ⊆ today ∪ {--model,--effort}"; "Cursor mode flags independent of sel"; "bracketed ids refused at PUT, load and use"; envelope static test unchanged |
| S8 | `test/server-roles-models.test.ts` → "negatives table: 4xx, nothing saved, field only allow-listed names, unknown key truncated in message, no 500" |
| S9 | `test/argv-model.test.ts` → "runsAs is a contiguous argv slice"; "runsAs has no bin path, cwd, workspace, -o, -n, schema"; `test/agents-selection.test.ts` → "timeline notes are redacted" |
| S10 | `test/agents-selection.test.ts` → "cliRejectedModel only on a structural stderr failure with a modelArg"; "result prose saying 'unknown model' never sets it"; "noteUnknownModel respects back-off" |
| S11 | `test/server-roles-models.test.ts` → "research.providers ['cursor'] still 400"; `test/agents-selection.test.ts` → "research runs through runResearch with the research profile and the row's sel" |
| S12 | `test/agents-selection.test.ts` → "hostile matrix: config / PUT / tampered cache / forged ResolvedSel never reach the full argv recorded by fake CLIs"; (R2-N3) hand-edited `tool` values `'__proto__'`, `'CLAUDE'`, `'cursor '`, `'--yolo'`, `42` and `{}` ⇒ selection fields dropped and reported, nothing extra in argv |
| S13 | `test/models/select.test.ts` → "cursorVariantId returns an element of family.ids (identity), never a built string"; static test: `levels.ts`/`select.ts` import no `node:fs`, `node:child_process` or spawn |
- **Regression**: the full `npm test`, including the engine, envelope and provider contract suites.
- **Build**: `npm run check`.

## 6. Risks and Dependencies

- **Depends on M8-1** (`src/models/*`, `ModelService` in `runtime.ts`) and on the **Security design sign-off** (§2e). M8-3 depends on this slice's `select.ts` exports and takes config v7.
- **Behaviour change for a migrated Cursor model**: today `agents.cursor.model` is passed unvalidated. After v6 it is a Cursor custom id that must be in the discovered list, otherwise the step runs on Cursor's default with a note. The same happens when no Cursor list exists yet (first start before discovery). This is fail closed per S19 and mandatory under the M8-2 Security condition S1; the Lead accepted it on 2026-10-21.
- **Migration loss (rev 2, B3c; amended by §2g)**: Claude and Codex keep today's argv **only for values that pass their tool's id rule**.
  - Claude `sonnet[1m]` / `opus[1m]` pass `CLAUDE_MODEL_RE` and are kept.
  - A Codex `x[1m]` or a Cursor `id[effort=high]` moves to `legacy.v5` and is no longer sent, so that tool runs on its default.
  - This is made visible through `legacyNotices` (Settings) and `conductor doctor`.
- **Unknown-model refresh (N8)**: if Claude reports an unknown `--model` as an `is_error` result event, `cliRejectedModel` does not fire and no refresh is triggered. The run still fails visibly. This is a known limit; the live check that would settle it is not authorised.
- **Follow-up (N1, needs Security; not in this slice)**: `choices.research.claude` shows the false reason "web access is not isolated yet", because `webResearchIsolated` is never set in production.
- **Effort with no discovered list**: a selected effort is not sent when the model's levels are unknown (Codex until it is repaired; Claude while signed out with a cold cache). Effort silently has no effect beyond a note. Fail closed, by design ("exactly the discovered model's levels").
- **Strict PUT is stricter**: unknown keys inside a role entry are now refused. Only Conductor's own UI calls this API; the existing tests send only known keys.
- **Downgrade**: a v6 `config.json` makes a v5 build refuse to start (existing `NewerVersionError`). The pre-upgrade backup is the way back. Documented.
- **Cursor id grammar**: lookup by `parseCursorId` tuple, never string building, so odd orderings are safe. A family whose tuples collide (two ids with the same tuple) takes the first listed and is logged once.
- **Codex**: dormant discovery ⇒ "Tool default" + "Custom model id…" only, and no effort flag. Enabling it needs Q5 (repair permission) and M8-1's S18 gate.
- **Claude Fast/Thinking**: stored by M8-1, not surfaced or sent (Q10 default). PUT refuses `fast`/`thinking` for Claude.
- **Decisions** ((a) and (b) were accepted by the Lead on 2026-10-21; (c) and (d) are bound by Security S6 and S3):
  - (a) A fallback or complexity-pick tool runs on its tool default (design `selForTool` semantics).
  - (b) Custom-id effort options = the union of the tool's discovered levels.
  - (c) Codex effort uses the TOML-quoted form.
  - (d) The research brief (M8-6) routes via `context` with `selRole: 'research'` until research routing is made eligible in production (a separate, Security-relevant change, not taken here).

## 7. Requirement Coverage Matrix

| Requirement (brief F7 / §7) | Planned change | Verification | Status |
| --- | --- | --- | --- |
| Seven rows; tool + model + effort in the tool's own words | `models[t].effortLabel/levels`, `roleViews`, row mapping §2.8 | API tests; UI in M8-U | Covered (API) |
| "Tool default (…)" names what the tool picks | `models[t].defaultLabel` from `isDefault`/`resolved`/`toolModels` | select tests with real fixtures | Covered |
| Discovered models + "Custom model id…" with the id rule; Save refused with focus | `options`, custom rule, PUT `field` | AC5, AC7 | Covered |
| Effort options = exactly the discovered levels; none for Cursor Auto/Composer | `levelsFor` | AC4 | Covered |
| Fast/Thinking only where reported | §2.3 rule 6; PUT `not_offered` | AC3, AC7 | Covered (Claude: Q10) |
| "Default model for each tool" replaces `agents.<tool>.model` (migrate) | `toolModels`, v5→v6 | AC6 | Covered |
| A tool switch (F8) uses that tool's default model | `selectionForTool`, `toolDefaultSelection` | AC9 | Covered (consumed by M8-3) |
| Tool change resets model; model change keeps/nearest effort + one-line note; flags dropped | implicit PUT rules, preview, `effortNote` | AC4, AC7, AC10 | Covered |
| Claude `--model --effort`; Codex `--model=` + `-c model_reasoning_effort`; Cursor composed id must exist (fail closed) | §2.4, `cursorVariantId` | AC2, AC3, AC11 | Covered |
| Fields in `roles[role]` with versioned migration; unset ⇒ byte-identical | §2.1, §2.4 | AC1, AC6 | Covered |
| Strict `PUT /api/roles` | §2.6 | AC7 | Covered |
| "Runs as …" from the same argv builder | `runsAs` + slice test, preview | AC2, AC10 | Covered |
| "No longer available" + visible fallback (F7a) | §2.7 | AC8 | Covered |
| After an unknown-model failure, refresh (F7a trigger) | `cliRejectedModel` → `noteUnknownModel` | agents-selection test | Covered |
| "(NO ZDR)" warn only (Q8) | `noZdr` → note | select test | Covered |
| Settings row UI, Handled-by popover editing model/effort | M8-U (feature-detected) | M8-U AC4/AC5 | Gap (M8-U) |
| Per-account offering, routing skips accounts lacking the model | `modelOffered` export | M8-3 router tests | Gap (M8-3) |
