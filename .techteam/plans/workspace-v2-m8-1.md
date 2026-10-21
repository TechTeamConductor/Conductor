# Implementation plan — M8-1 Model discovery (F7a)

- Task: brief F7a ("ask each tool, never assume"), slice 1 of M8 (`workspace-v2-m8.md`).
- Author: TechTeam Lead
- Date: 2026-10-21
- Plan status: **approved** (Reviewer round 2: Approved with conditions C1–C3, applied in §2e; rev 1: Changes requested, `reviews/workspace-v2-m8-1-plan-review.md`, B1–B5 addressed in §2c) · Security design: **Approved with conditions** (rev 2 check: Approved with conditions R2-1…R2-5, folded in as §2d) (`.techteam/reviews/workspace-v2-m8-1-security-design.md`); conditions folded in as §2b

## 1. Current State (verified 2026-10-21)

- No model discovery anywhere. Models are a free-text `cfg.agents.<tool>.model` (`src/config.ts:114-129`), appended as `--model` by the three argv builders. Codex's is checked by `CODEX_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/` (`src/config.ts:40`); Claude's and Cursor's are not validated.
- Spawning: `runProcess(SpawnOpts)` (`src/agents/spawn.ts`) — `stdin` is a string written then closed, `onLine` per complete line, idle + hard timeouts, process-group kill, 64 KB tails. Zero-quota probes go through `cliOut` (20 s bound) in `src/agents/providers/probe.ts`.
- Child env allow-lists: `claudeEnv`, `cursorEnv`, `codexEnv({codexHome, home})` in `src/agents/env.ts`. Codex's private home: `src/agents/providers/codex-home.ts`.
- Versioned files: `src/schema/version.ts` (`loadVersioned`, `saveVersioned` with backup, `quarantine`, `assertNotNewer`).
- Redaction: `redact()` in `src/redact.ts`. CSRF on every mutation in `src/server/http.ts:294-297`.
- Live facts measured today (zero quota):
  - `claude` 2.1.304, argv `-p --input-format stream-json --output-format stream-json --verbose --safe-mode --strict-mcp-config --disable-slash-commands`, cwd = an empty folder, stdin = the one `initialize` line and then EOF: exit 0 in 1.3 s; stdout = 1 `system/ui_invalidate` line + 1 `control_response` line (7.3 KB); nothing written to the cwd, **but the config dir IS written** (`.claude.json`, `backups/`, an empty `sessions/`) even with `--no-session-persistence` — same as the existing read-only stages. `response.response` keys: `commands, agents, output_style, …, models, account, pid, claude_code_version, …`. 13 models; each has `value`, `resolvedModel`, `displayName`, `description`, optional `supportedEffortLevels` (e.g. `["low","medium","high","xhigh","max"]`; Opus 4.6 / Sonnet 4.6 have no `xhigh`; Haiku 4.5 has none), `supportsFastMode`, `supportsAdaptiveThinking`, `supportsThinkingOff`. The `default` entry resolves to `claude-opus-5-5`. `account` = `{email, organization, subscriptionType, apiProvider}`.
  - `agent` 2026.10.19-6bbf2c4 `--list-models`: exit 0; line 1 "Available models", blank line, then 265 `id - Label` lines, then a "Tip:" line mentioning the parameterised form `--model 'id[effort=high,fast=false]'`. Default marked `auto - Auto (current, default)`; 40+ labels end `(NO ZDR)`.
  - `codex --version`: `ENOENT` (native binary missing) — discovery cannot be exercised here.

## 2. Expected State

> **Precedence (R2-1, C3):** where §2–§6 (rev 1 text) conflict with §2b, §2c, §2d or §2e, those sections win. Superseded rev-1 statements: §2.2 Claude row "dropped if it breaks the handshake" (S6: mandatory); §2.2 Cursor row unavailable-vs-stale (N10 rule); §2.2 Codex row, the `mkdtemp`/`codexEnv` spawn bullet and the enable bullet (B4/S17/S18: no Codex spawn in this slice); §2.2 caps "via `onLine`" (B2 `maxOutputBytes`); §2.3 character list (S9); §2.5 `kind` name and "newer file quarantined" (B3/C2: newer = untouched, memory-only); §2.6 refresh without back-off/identity scrub (S11, S3/B5b); §2.7 SSE "changed" event (does not exist — N1 polling); §4 `service.ts` (it is `src/runtime.ts`); §5/AC6 "temp dir removed" (§2d R2-2); §6 SessionStart-only marker (S5 set). The authoritative AC list is §2e.

A `src/models/` module that asks each installed CLI which models it offers, caches the answer per (provider, account), refreshes it in the background, and serves it over the API. **Nothing consumes it for argv yet** (that is M8-2), so no stage behaviour changes in this slice.

### 2.1 Catalog shape (stored and served; every string already sanitised)

```ts
type ProviderId = 'claude' | 'cursor' | 'codex';
interface ModelEntry {
  id: string;                 // matches MODEL_ID_RE; for Claude the `value` (alias or full id)
  label: string;              // ≤ 80 chars, cleaned
  resolved?: string;          // Claude `resolvedModel` (MODEL_ID_RE) — what "Tool default (…)" names
  efforts?: string[];         // levels the tool reports (Claude supportedEffortLevels; Codex supportedReasoningEfforts); each ∈ EFFORT_TOKENS
  defaultEffort?: string;     // Codex defaultReasoningEffort
  isDefault?: true;           // Claude `value === 'default'`; Cursor "(current, default)"; Codex server default flag
  fast?: true; thinking?: true; adaptiveThinking?: true; thinkingOff?: true; // reported capability flags (stored; surfacing is M8-2/§6 Q10)
  noZdr?: true;               // Cursor "(NO ZDR)"
}
interface CursorFamily {      // derived, never stored from the CLI directly
  family: string;             // e.g. "gpt-5.3-codex"
  efforts: string[];          // tokens seen, in canonical order; "" = the base id (family's own default effort)
  thinking: boolean; fast: boolean; label: string; noZdr: boolean;
}
interface Catalog {
  version: 1; provider: ProviderId; account: string;      // account = "default" in this slice (M8-3 adds others)
  source: 'claude-initialize' | 'cursor-list-models' | 'codex-app-server';
  cliVersion: string | null; fetchedAt: number;      // epoch ms
  signedIn: boolean | null;   // Claude: account.email present / tokenSource ≠ "none"; Cursor: call succeeded; null = unknown
  plan?: string;              // Claude subscriptionType (cleaned, ≤ 40) — shown later next to the account
  models: ModelEntry[];
}
interface CatalogView extends Partial<Catalog> {
  provider: ProviderId;
  state: 'reading' | 'fresh' | 'stale' | 'unavailable';
  reason?: string;            // one human line, static wording + redacted CLI detail ≤ 200 chars
  families?: CursorFamily[];  // Cursor only
}
```

**The email and organisation are never stored, logged or served** (only `signedIn` and `plan`). M8-3 decides whether an account label may show the email (Security).

### 2.2 Adapters (one per tool; constants-only argv)

| Tool | argv (constant) | stdin | Parse | Signed out |
| --- | --- | --- | --- | --- |
| Claude | `-p --input-format stream-json --output-format stream-json --verbose --safe-mode --strict-mcp-config --disable-slash-commands --no-session-persistence` (the last flag verified live during implementation; dropped if it breaks the handshake, with a note) | `{"type":"control_request","request_id":"r1","request":{"subtype":"initialize"}}\n` then EOF | the first stdout line that parses to `type:"control_response"` with `response.request_id === "r1"` and `response.subtype === "success"`; read ONLY `response.response.models` and `response.response.account`; everything else is discarded unparsed-into-memory beyond `JSON.parse` of that one line | catalog stored with `signedIn:false` (5 aliases) — state `fresh`, the UI says "signed out" |
| Cursor | `--list-models` | none | lines matching `^([^\s]+) - (.+)$` after cleaning; header/blank/"Tip:" lines ignored; flags `(current, default)` and `(NO ZDR)` stripped from the label into fields | stderr/stdout contains "Authentication required" (or non-zero exit) ⇒ state `unavailable`, reason "Sign in to Cursor to see its models", previous cache kept and marked stale |
| Codex | `app-server` with JSON-RPC `initialize` then `model/list` (paginated, ≤ 10 pages) | the requests, then EOF | per the documented shape (`data[] {id, model, displayName, supportedReasoningEfforts, defaultReasoningEffort, isDefault}`, `nextCursor`) | — |

- **Codex is disabled in production in this slice** (`CODEX_DISCOVERY_ENABLED = false`, a code constant, not config): the adapter + parser exist and are tested against a fixture written from the documented shape, but the service returns `unavailable` "Codex model discovery has not been checked on a working Codex install yet" and the UI (M8-2) offers only "Tool default" and "Custom model id…". Enabling it is **a separate Security gate** (S18): `prepareCodexHome` + `withCodexHomeLock`, scratch HOME, `codexEnv`, JSON-RPC limited to `initialize`/`initialized`/`model/list` (≤ 10 pages, never `thread/*`, `turn/*`, `exec*`), kill after the last page, live zero-quota check — and the user's permission to repair Codex (not given: the user answered "no preference").
- **Version guard**: the Claude adapter records `claude_code_version`/`--version`; a reply without a `models` array, or with entries lacking a string `value`, is `unavailable` ("this Claude Code version answered in an unexpected shape"), the last cache kept. No invented fallback list ever.
- Spawn: `runProcess` with `cwd` = a fresh empty dir `mkdtemp(<home>/run/discovery-)`, removed afterwards; env = `claudeEnv(extraEnv)` / `cursorEnv(extraEnv)` / `codexEnv({codexHome, home: emptyDir})` — the existing allow-lists unchanged; `idleMs = hardMs = 15_000`; stdout captured via `onLine` with a per-line cap of 512 KB and a total cap of 2 MB (beyond ⇒ kill + `unavailable` "the reply was too large").

### 2.3 Sanitiser (`src/models/sanitize.ts`)

- `MODEL_ID_RE` = the existing rule (moved here; `CODEX_MODEL_RE` stays exported from `config.ts` as an alias so nothing else changes).
- `cleanText(s, max)`: NFC; strip C0/C1 controls, zero-width (U+200B–U+200D, U+2060, U+FEFF), bidi controls (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069); collapse whitespace; truncate to `max` (labels 80, plan 40).
- Ids: cleaned, then must match `MODEL_ID_RE`, else the entry is dropped and counted (`dropped` in the log line). Duplicate ids: first wins.
- Effort tokens: kept only if ∈ `EFFORT_TOKENS = ['none','minimal','low','medium','high','xhigh','max']`, de-duplicated, canonical order.
- Caps: ≤ 1,000 models kept (the rest dropped and counted).

### 2.4 Cursor families (`src/models/cursor-families.ts`, pure)

Parse each id right-to-left: optional `-fast`, optional effort token (`-low|-medium|-high|-xhigh|-max|-none|-minimal`), optional `-thinking`; the rest is the family. Group ids by family; a family with one id and no tokens is a standalone model (e.g. `auto`, `composer-2`). An id that does not parse is standalone; **no id is ever dropped by grouping** (test: union of family ids = input ids). Family label = the base id's label, else the shortest label with effort/Fast/Thinking words removed. Composition and lookup (`family[-thinking][-effort][-fast]` must exist in the list) are M8-2.

### 2.5 Cache (`src/models/cache.ts`)

- File: `<home>/models/<provider>/<account>.json` (`account` matches `^[a-z0-9][a-z0-9-]{0,31}$`; only `default` in this slice). `VersionSpec {kind:'models', field:'version', current: 1}` (no version field ⇒ corrupt); written via `saveVersioned` (atomic, mode 0600); a corrupt or newer file is quarantined/ignored and treated as "no cache".
- Read path re-validates every field with the sanitiser (a hand-edited cache is untrusted too).

### 2.6 Service (`src/models/service.ts`)

- `view(provider)`, `viewAll()`, `refresh(provider, reason)`, `startup()` (background, not awaited; only for providers whose cheap detect says `ok`), `noteVersion(provider, version)` (refresh when it differs from the cache's `cliVersion`), `noteUnknownModel(provider)` (hook for M8-2; refresh, rate-limited).
- One discovery in flight per (provider, account): a second call returns the same promise. A refresh within 10 s of the last finished one returns the cached view (button hammering).
- A failed refresh keeps the last catalog, sets `state: 'stale'` and `reason` ("showing the list from 10:42 — <why>"); no cache ⇒ `unavailable` with the reason.
- Logs: one line per refresh: provider, account, outcome, model count, dropped count, cliVersion, duration. CLI detail text only after `redact()` + truncate 200. Never the email/organisation.
- Never blocks the board: no engine call awaits discovery.

### 2.7 API and CLI

- `GET /api/models` → `{ providers: CatalogView[] }` (Cursor includes `families`).
- `POST /api/models/refresh` body `{ provider?: 'claude'|'cursor'|'codex' }` — strict (plain object, own-property, only that key, registry id) → 202 `{ providers }` after starting the refresh (the client polls `GET /api/models` or receives the existing SSE "changed" event). CSRF as every mutation.
- CLI: `conductor models [--refresh] [--json]` — prints per provider: state, count, fetched time, CLI version.

### What must remain unchanged

- Every existing argv (no consumer of the catalog in this slice) — snapshot tests unchanged.
- Env allow-lists unchanged (discovery reuses them).
- `npm test` green, `npm run check` clean, zero runtime deps, live tests untouched.

### Acceptance criteria

1. AC1 Claude adapter parses the recorded signed-in fixture (13 models, efforts per model, default → `claude-opus-5-5`) and a signed-out fixture (5 aliases, `signedIn:false`).
2. AC2 Cursor adapter parses the recorded 265-id fixture (with zero-width chars kept in the fixture), finds the `auto` default and the NO-ZDR flags; "Authentication required" ⇒ `unavailable` with the sign-in reason.
3. AC3 Codex parser handles a fixture of the documented shape incl. pagination; the service reports `unavailable` while `CODEX_DISCOVERY_ENABLED` is false and never spawns Codex.
4. AC4 Hostile output: oversized line, > 2 MB total, control/bidi/zero-width chars, duplicate ids, > 1,000 models, ids failing the regex, non-JSON, wrong `request_id`, missing `models` ⇒ capped/dropped/unavailable as specified; nothing crashes; nothing unvalidated is stored.
5. AC5 Cache per (provider, account), versioned, re-validated on read; a failed refresh keeps the list and marks it stale with a reason; a version change triggers a refresh; one discovery in flight per account.
6. AC6 Spawn isolation: argv equals the constants; env keys ⊆ the tool's allow-list (no cross-tool credential); cwd is an empty temp dir removed afterwards; the fake CLI records **zero prompts** (no model turn) and the 15 s timeout kills a hung fake.
7. AC7 Email/organisation never appear in the cache file, the API response, or the log (test greps all three).
8. AC8 `GET /api/models`, strict `POST /api/models/refresh` (unknown key, non-object, `__proto__`, unknown provider ⇒ 400; no CSRF ⇒ 403).
9. AC9 Live (manual, zero quota, recorded in evidence): real `claude` and `agent` discovery through the service on this machine.


## 2b. Security design conditions — BINDING (`.techteam/reviews/workspace-v2-m8-1-security-design.md`)

The review file is the authoritative text; summary of what the code must do:
- **S1** Any stdout line of type `assistant|user|result|stream_event|rate_limit_event` or `system/init` ⇒ kill the process group, `unavailable`, nothing cached, no retry. Kill the child as soon as the matching `control_response` is parsed. Fake scenario `turn`.
- **S2** Only `models` and `account` survive parsing; `stdoutTail` never used for Claude reason text (stderr only, redacted, scrubbed, ≤ 200). Decoy commands/agents/email test across cache, API, log, reason.
- **S3** From `account` keep only `signedIn` and `plan` (`^[A-Za-z0-9 _-]{1,40}$`); never `tokenSource`, `apiProvider`, `organization`, `email`, `userID`, `machineID`. Email/organisation passed to `redact()` as secrets for the refresh, plus an email-shape scrub on every reason/log line for all providers.
- **S4** Raw-byte caps: add optional `maxOutputBytes` to `SpawnOpts` (off by default; existing calls unchanged) that kills the group when exceeded ⇒ `unavailable`. Tests: no-newline flood and many lines.
- **S5** Live zero-quota marker check with a temp `CLAUDE_CONFIG_DIR` holding SessionStart/SessionEnd/UserPromptSubmit/PreToolUse/Stop hooks, a stdio MCP server in `.claude.json` and `.mcp.json` in cwd (+ local plugin if feasible) ⇒ no markers, empty `sessions/`. Any marker blocks Claude discovery. Evidence in `.techteam/runs/evidence/`.
- **S6** `--no-session-persistence` mandatory; writing the user's `~/.claude.json` per refresh accepted (bounded by S11); temp config dirs removed, never copied into fixtures/evidence. (M8-3: per-account config dirs 0700.)
- **S7** Fixture keys from an allow-list; a test asserts fixtures/evidence contain no email shape and none of `userID`, `machineID`, `oauthAccount`, `commands`, `agents`.
- **S8** Field-by-field parsing (`Object.hasOwn` + `typeof`), flags only `=== true`, efforts ∈ allow-list (≤ 7); `__proto__`/`constructor` pollution test.
- **S9** `cleanText`: NFC, strip `\p{Cc}`, `\p{Cf}`, `\p{Zl}`, `\p{Zp}`, `\p{Co}`, lone surrogates; truncate by code point. Ids/labels/families never used in a path, shell string, regex or HTML.
- **S10** Temp cwd removed in `finally` after reaping, only if `lstat` shows a real dir at that path; `ModelService.stop()` aborts in-flight; startup sweeps `discovery-*` older than 1 h; worst-case kill ≈ 21 s documented.
- **S11** Automatic refreshes (`startup`, `noteVersion`, `noteUnknownModel`): ≤ 1 per provider/account per 5 min after a failure and ≤ 1 per distinct `cliVersion` per process; a failed refresh never updates the cached `cliVersion`; only manual refresh uses the 10 s window; `noteUnknownModel` only from structural CLI errors. Test: repeated failures + 20 health refreshes ⇒ 1 spawn.
- **S12** Models dir and provider subdirs 0700, real dirs, owned by the user; path built only from the provider enum + account regex and asserted inside the models dir; file must be a regular non-symlink ≤ 4 MB; never log `CorruptFileError`/`JSON.parse` messages. **S12a** `provider`/`account` must match the path; `fetchedAt` finite and ≤ now + 5 min; families recomputed, never read; ≤ 3 quarantined files kept per cache file.
- **S13** API strict as planned; refresh within 10 s ⇒ 202 with the cached view; GET keys from an allow-list; no absolute paths in reasons; no 500 with a path.
- **S14** One log line per refresh, counts only (no ids/labels); CLI `--json` prints the same allow-listed view.
- **S15** `runProcess` spy env assertions: Claude = allow-list + `ANTHROPIC_*`, no `CURSOR_`/`LINEAR_`/`OPENAI_`/`CODEX_`; Cursor = no `ANTHROPIC_`/`CLAUDE_`/`LINEAR_`/`OPENAI_`/`CODEX_`.
- **S16** Cursor runs in the real HOME (accepted); zero-quota evidence with a temp HOME holding `~/.cursor/hooks.json` and `~/.cursor/mcp.json` markers, signed out ⇒ no markers; static reason text.
- **S17** Codex dormant: no binary lookup, no home preparation, no spawn (spy sees zero calls).
- **S18** Enabling Codex = separate Security gate (see §2.2).
- **S19** For M8-2/M8-3: argv only from ids re-validated at use, each its own argv element; Cursor ids composed and checked against the list; labels via `textContent`; NO-ZDR warning only; account regex + S3 kept.
- **S20** ACs extended: AC5 += S12 cases; AC6 += S1, S4; AC7 += S2, S3 (reason strings and the AC9 evidence file too); AC9 += S5 and S16 evidence.
- Release of the slice needs the Security **code** review confirming S1–S17 with tests.

### UI contract (from M8-U)
`GET /api/models` view fields as in §2.1 are what the UI feature-detects; no other names.


## 2c. Rev 2 — Reviewer round 1 (B1–B5 and the non-blocking items taken)

**B1 Wiring and tests never reach real CLIs.**
- The runtime is `createRuntime` in `src/runtime.ts` (health cache at lines 75–113). `ModelService` deps: `{ getConfig, clock, extraEnv, bins: () => ({claude: resolveBin(cfg.agents.claude.bin), cursor: resolveBin(cfg.agents.cursor.bin)}), spawn: runProcess, log }` — `extraEnv` is the same object `Agents` receives, so tests/demo with `FAKE_DIR` reach the fakes.
- `RuntimeOptions.models?: false | Partial<ModelServiceDeps>`. Automatic discovery (`startup`, `noteVersion`) runs only when the runtime uses REAL health (no `opts.health`) and `opts.models !== false`. Belt and braces: inside a test run (`NODE_TEST_CONTEXT`) the service refuses to spawn unless deps were passed explicitly (`opts.models` with a `spawn`), and logs nothing else.
- Startup is triggered after the server listens, by the first real health result: `void models.startup().catch(log)` — never awaited by anything on the request path.
- `Runtime.close()` calls `models.stop()` (aborts in-flight discovery, S10).
- Guard test: a `runProcess` spy across the existing runtime-creating tests (setup wizard, server, demo boot) records **zero** discovery spawns.

**B2 Byte caps.** `SpawnOpts.maxOutputBytes?: number` (S4): counts raw bytes of stdout+stderr `data` events before line splitting; exceeding it kills the process group and sets `SpawnResult.overflow = true`. Undefined by default ⇒ every existing call is unchanged (existing spawn tests stay green). Discovery uses 2 MB total; the per-line cap (512 KB) is checked in `onLine`. Tests: 5 MB with no newline ⇒ `unavailable`; 50,000 short lines ⇒ `unavailable`.

**B3 Cache on `src/schema/version.ts`.** `VersionSpec { kind: 'model cache', field: 'version', current: 1, assumeWhenMissing: 0 }` with no migration from 0 ⇒ a file without `version` fails to load and is quarantined (S12). Rules: corrupt ⇒ quarantined (≤ 3 kept, S12a), treated as no cache; **newer** ⇒ neither quarantined nor overwritten — the fresh result stays in memory only and the view reason says "a newer Conductor wrote this list; showing this session's copy"; folders created 0700 and checked (S12).

**B4 Codex.** This slice ships only `parseCodexModelList(pages)` + a fixture of the documented shape (labelled not recorded from a real binary). **No Codex spawn code, no home preparation.** The service returns `unavailable` "Codex model discovery is not available yet" without touching Codex (S17). Enabling = its own small plan (transport needs a request/response loop: `initialize` → `initialized` notification → `model/list` page by page using `nextCursor`; `prepareCodexHome` + `withCodexHomeLock` + `makeScratchHome`; S18) after the user permits the repair.

**B5 Acceptance additions.**
- (a) Unit test pins the Claude discovery argv exactly (incl. `--safe-mode`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`, no prompt argument, no `--model`). AC9 adds the S5 hook/MCP marker live check and the S16 Cursor marker check.
- (b) `scrubIdentity(text)` removes email-shaped strings (and the refresh's exact email/organisation) from every reason and log line for all providers; a fake prints the email on stderr ⇒ absent from cache, API, log, reason (AC7).
- (c) AC1/AC2 pin real-fixture counts: Claude signed in **13 kept / 0 dropped**, signed out **5 / 0**; Cursor **265 / 0** (all ids verified against the id rule on 2026-10-21; zero-width chars sit at the end of 4 labels). If a future real id fails the rule, implementation stops and the Lead asks the user — never a silent drop of a real id (the parser still drops it at runtime, counted and logged, because the rule is the safety gate).

**Non-blocking items taken.**
- N1 No SSE event exists for this: the UI polls `GET /api/models` every 1.5 s while any provider has `refreshing: true` (max 20 s).
- N2 One stable discovery cwd `<home>/run/discovery` (0700, real dir, verified empty before each run; if it is not empty its entries are removed after an `lstat` check) instead of a new temp dir each time — avoids a new `~/.claude.json` project entry per refresh. The AC9 evidence records the `~/.claude.json` project-key count and `~/.claude/projects` listing before/after one refresh.
- N3 `models` added to `HOME_SKELETON`; a home with a cache file counts as holding data for `migrate` (as `run/` already does) — documented.
- N6 `conductor models --refresh` refuses while a server holds the lock ("Conductor is running — use Refresh models in Settings") and prints the cached view; without a server it refreshes and writes the cache.
- N8 Golden full-argv tests for the three stage builders are added now (pin today's argv before M8-2 changes them).
- N10 One rule: a failed refresh with a cache ⇒ `stale` + reason (e.g. "Sign in to Cursor to see its models"); without a cache ⇒ `unavailable` + reason.
- N13 `reading` only when there is no cache yet; with a cache, a refresh shows the cached state plus `refreshing: true`.
- Master N4 adopted for all slices: no slice may spawn real CLIs inside `npm test`.
- Q9/Q10 are taken as provisional defaults and reported to the user as such.

## 2d. Security rev-2 check — BINDING (R2-1…R2-5)

- **R2-2 Discovery folder `<home>/run/discovery`** (replaces the temp-dir parts of S10; the `discovery-*` sweep is dropped): `<home>/run` and the folder must each be a real directory (`lstat`), owned by the user, mode 0700 — otherwise refuse. Before every spawn: remove every entry (a symlink is removed itself, never its target), re-check empty, else refuse and do not spawn. After every run, once the child is reaped: clean again; log only the leftover count. **All discovery spawns are serialised** by one service-wide queue (one at a time across providers and accounts). Tests: planted `.mcp.json` is removed and never read; planted symlink is removed while its target survives; two providers refreshing at once ⇒ spawns never overlap.
- **R2-3 Version rule:** the loader treats any `version !== 1` (incl. missing) as corrupt ⇒ quarantine. The S12 checks (real dir, regular non-symlink file, ≤ 4 MB) run **before** `loadVersioned`; `CorruptFileError`/`JSON.parse` text is never logged. Test: a file without `version` is quarantined and never served.
- **R2-4 AC9 N2 evidence = counts only:** number of `~/.claude.json` project keys and of `~/.claude/projects` entries before/after, plus yes/no whether a key for the discovery folder exists. No names (they are the user's repo paths). S7 identity grep applies to the evidence file.
- **R2-5 Overflow ⇒ always `unavailable`;** any partial reply received before the overflow is discarded; no partial catalog is ever cached.

## 2e. Reviewer round 2 conditions (C1–C3) and the authoritative acceptance list

- **C1 Working folder — one rule:** a single stable folder `<home>/run/discovery` with **all discovery spawns serialised** by one service-wide queue (Security R2-2 offered this or per-provider folders; serialisation was chosen and is what Security's R2-2 text acknowledges). Checked before every run (real dir by `lstat`, owned by the user, 0700, emptied without following links, re-checked empty), cleaned after reaping. No temp dirs, no `discovery-*` sweep.
- **C2 Cache read without following links:** `cache.ts` reads itself, not through `loadVersioned`: `open(path, O_RDONLY | O_NOFOLLOW)` → `fstat` on the handle (regular file, owner = user, ≤ 4 MB) → read through that handle → `JSON.parse` → **`version === 1` required** (missing or other ⇒ corrupt ⇒ quarantine, ≤ 3 kept); a version > 1 ⇒ newer ⇒ left untouched, memory-only result. Writing uses `saveVersioned` (atomic, 0600, `VersionSpec { kind: 'model cache', field: 'version', current: 1, assumeWhenMissing: 1 }`) only when no newer file exists. Error texts from parsing are never logged.
- **Round-2 non-blocking taken:** R2-N1 one background zero-quota health read after `listen` in `cli.ts start` and `desktop-sidecar.ts` so headless starts discover; R2-N2 spawn counting through the injected `spawn` dep / a service counter (ESM exports cannot be spied), guard covers `test/setup-wizard.test.ts` + a `src/demo.ts` boot check; R2-N3 live discovery tests inject `spawn` explicitly; R2-N4 CLI uses `readLock` + pid-alive, holds the lock during its own refresh; R2-N5 a test asserts no model-id literals from the fixtures appear in `src/` (N7) and `ApiDeps.models` optional ⇒ 501 when absent, empty refresh body = all providers (N9).

### Acceptance criteria (authoritative, rev 2 — replaces the rev-1 AC list)

| AC | What | Named test file |
| --- | --- | --- |
| AC1 | Claude fixtures: signed in 13 kept / 0 dropped, efforts per model, default → `claude-opus-5-5`; signed out 5 / 0, `signedIn:false` | `test/models/claude-parse.test.ts` |
| AC2 | Cursor fixture 265 / 0, `auto` default, NO-ZDR flags, zero-width labels cleaned; families union = ids; auth-required ⇒ stale (with cache) / unavailable (without) | `test/models/cursor-parse.test.ts`, `cursor-families.test.ts` |
| AC3 | Codex parser on the documented-shape fixture incl. pagination; service never looks up or spawns Codex (S17) | `test/models/codex-parse.test.ts`, `service.test.ts` |
| AC4 | Hostile output: control/`\p{Cf}`/bidi/lone surrogates, duplicates, > 1,000 models, regex failures, non-JSON, wrong `request_id`, missing `models`, `__proto__`/`constructor` pollution (S8, S9) | `test/models/sanitize.test.ts`, `hostile.test.ts` |
| AC5 | Cache: per provider/account, 0700 dirs, path containment, symlink/non-regular/> 4 MB refused, missing `version` ⇒ quarantined and never served (C2), newer ⇒ untouched, ≤ 3 quarantines, `fetchedAt` future cap, families recomputed (S12, S12a); failed refresh keeps list ⇒ stale | `test/models/cache.test.ts` |
| AC6 | Spawn isolation: exact Claude discovery argv; env per tool (S15); S1 tripwire (`turn` scenario ⇒ killed, nothing cached); S4 overflow both shapes ⇒ unavailable, no partial catalog (R2-5); discovery folder rules incl. planted `.mcp.json` and symlink (R2-2); serialised spawns never overlap; 15 s timeout; zero prompts recorded | `test/models/spawn.test.ts`, `test/spawn-overflow.test.ts` |
| AC7 | Identity: decoy commands/agents/email in the reply and email on stderr ⇒ absent from cache, API, log, reason, CLI `--json` (S2, S3) | `test/models/identity.test.ts` |
| AC8 | API: `GET /api/models` allow-listed keys; strict refresh (non-object, unknown key, `__proto__`, unknown provider ⇒ 400; no CSRF ⇒ 403); 10 s window ⇒ 202 cached view; 501 when no service; no absolute paths (S13) | `test/models/api.test.ts` |
| AC9 | Live, zero quota, evidence in `.techteam/runs/evidence/m8-1-*`: real Claude + Cursor discovery via `conductor models --refresh` (throw-away home); S5 hook/MCP marker check; S16 Cursor marker check; `~/.claude.json` project-key count and `~/.claude/projects` entry count before/after (counts only, R2-4); S7 identity grep over the evidence | manual + `test/models/fixtures-hygiene.test.ts` |
| AC10 | Golden full-argv tests for the three stage builders (pin today's argv) | `test/argv-golden.test.ts` |
| AC11 | S11 back-off: repeated failures + 20 health refreshes ⇒ 1 spawn; one per distinct `cliVersion`; manual refresh 10 s window | `test/models/backoff.test.ts` |
| AC12 | No real CLI in `npm test`: runtime/demo boot with injected health ⇒ 0 discovery spawns; service refuses to spawn under the test context without an injected `spawn` | `test/models/no-real-cli.test.ts` |
| AC13 | `npm run check` clean, `npm test` green, zero runtime deps | CI commands |

## 3. Files to Be Changed

| File path | Action | Purpose | Required changes | Reason |
| --- | --- | --- | --- | --- |
| `src/models/types.ts` | Create | catalog/view types | §2.1 | F7a |
| `src/models/sanitize.ts` | Create | id rule, text cleaning, caps, effort tokens | §2.3 | F7a safety |
| `src/models/claude.ts` | Create | Claude `initialize` adapter + parser | §2.2 | F7a |
| `src/models/cursor.ts` | Create | Cursor `--list-models` adapter + parser | §2.2 | F7a |
| `src/models/cursor-families.ts` | Create | pure family grouping | §2.4 | F7a |
| `src/models/codex.ts` | Create | Codex `model/list` **parser only** — no spawn code in this slice (rev 2, B4) | §2c B4 | F7a |
| `src/models/cache.ts` | Create | versioned per-account cache | §2.5 | F7a |
| `src/models/service.ts` | Create | refresh orchestration, dedupe, staleness | §2.6 | F7a |
| `src/config.ts` | Modify | `CODEX_MODEL_RE` re-exported from `models/sanitize.ts` (same value) | 1 line | single id rule |
| `src/agents/spawn.ts` | Modify | optional `maxOutputBytes` (off by default) | S4 | output caps |
| `src/paths.ts` | Modify | `paths.models()`; `models` added to `HOME_SKELETON` | 2 lines | cache location |
| `src/runtime.ts` | Modify | construct `ModelService` (deps per §2c B1), `RuntimeOptions.models` seam, startup after the first REAL health result, `close()` → `stop()` | small | wiring (rev 2: `src/service.ts` is the launchd installer — not touched) |
| `src/server/api.ts` | Modify | `GET /api/models`, `POST /api/models/refresh` | §2.7 | F7a |
| `src/cli.ts` | Modify | `conductor models` | §2.7 | evidence + ops |
| `fixtures/fake-claude.mjs` | Modify | answer the `initialize` control request (scenario: `models: 'in'|'out'|'garbage'|'hang'|'huge'`), count prompts | small | tests |
| `fixtures/fake-agent.mjs` | Modify | `--list-models` from a fixture file (scenario: ok / auth-required / hostile / hang) | small | tests |
| `fixtures/real/claude-initialize-2.1.304.json`, `…-signed-out.json` | Create | recorded replies, **reduced to `models` + `account` with email/organisation replaced by placeholders** | — | AC1 |
| `fixtures/real/cursor-list-models-2026.10.19.txt` | Create | recorded list, verbatim (zero-width chars kept) | — | AC2 |
| `fixtures/codex-model-list.json` | Create | documented-shape fixture (labelled "not recorded from a real binary") | — | AC3 |
| `test/models/*.test.ts` | Create | AC1–AC8 | — | tests |
| `docs/API.md`, `docs/ARCHITECTURE.md` | Modify | endpoints, module, honesty notes | — | docs |

## 4. Implementation TODO

- [ ] Record fixtures (signed-out Claude via `CLAUDE_CONFIG_DIR=<empty temp dir>` — zero quota; Cursor not-signed-in via an env without credentials if it reproduces, else the error text from the brief) and scrub them.
- [ ] `sanitize.ts`, `types.ts`, `cursor-families.ts` + unit tests.
- [ ] Adapters + parsers + hostile tests; fakes extended.
- [ ] Cache + service + tests (dedupe, staleness, version change, timeout).
- [ ] API + CLI + tests; wiring in `service.ts`.
- [ ] Docs; live zero-quota check through `conductor models --refresh` with a throw-away `CONDUCTOR_HOME`; evidence file.
- [ ] `npm run check`, `npm test`; checkpoint update. Commits: (1) sanitiser/types/families, (2) adapters + fakes, (3) cache/service/API/CLI/docs.

## 5. Testing Strategy

- Unit: sanitiser (each character class, caps, regex), families (union property, `gpt-5.3-codex` base-without-effort, `auto`, thinking/fast), parsers per fixture.
- Integration: service against the fake CLIs (fresh, stale after failure, unavailable, version change, dedupe with 5 concurrent calls ⇒ 1 spawn, hang ⇒ timeout ⇒ stale).
- API: shape, strictness, CSRF, 202.
- Security: env keys ⊆ allow-list (spy on `runProcess`), argv === constants, cwd empty and removed, no prompt recorded by fakes, no email/org in cache/API/log.
- Regression: all existing argv snapshot tests untouched and green.
- Build: `npm run check`; `npm test`.

## 6. Risks and Dependencies

- Claude `initialize` is undocumented/alpha: adapter isolated, shape-checked, fixture-pinned; failure ⇒ "unavailable" + last cache, never a guess.
- `--safe-mode` in the discovery spawn is what keeps hooks/plugins/MCP out; the brief reports no hooks ran. Verified again during implementation with a temporary `CLAUDE_CONFIG_DIR` holding a SessionStart hook that writes a marker file ⇒ marker must not appear (zero quota).
- Cursor list parsing depends on `id - Label` text format: lines that don't match are ignored and counted; zero matches ⇒ `unavailable`, never an empty "fresh" list.
- Codex: unverifiable here; disabled in production.
- §6 user decisions touched: Q9 (assumed recommended: unavailable ⇒ only Tool default + Custom; refresh at startup/add/version change/on demand), Q10 (flags stored, not surfaced). Both reversible.

## 7. Requirement Coverage Matrix

| Requirement (brief) | Planned change | Verification | Status |
| --- | --- | --- | --- |
| F7a ask each tool, nothing hard-coded | adapters; no catalogue constants in `src/` | grep test: no model ids in `src/models/*` except fixtures/tests | Covered |
| Claude via `initialize`, keep only models + account | `models/claude.ts` | AC1, AC4, AC7 | Covered |
| Cursor via `--list-models`, families, NO ZDR, zero-width | `models/cursor.ts`, `cursor-families.ts` | AC2, AC4 | Covered |
| Codex via app-server; until verified only Tool default + Custom | `models/codex.ts` disabled | AC3 | Covered |
| Per-account cache, fetchedAt/cliVersion/source, refresh triggers, never block, stale handling | `cache.ts`, `service.ts` | AC5 | Covered (account = default until M8-3) |
| Safety caps, textContent, constants argv, allow-listed env, empty cwd, 15 s, one in flight, redaction, no email in logs | sanitiser + service | AC4, AC6, AC7 | Covered |
| "No longer available" + visible fallback | consumer side | M8-2 | Gap (M8-2) |
| UI states reading/fresh/stale/unavailable | `CatalogView.state` served | AC5, AC8 (UI in M8-2/M8-5) | Covered (API) |

## 2f. S9 widening ruling (Security, 2026-10-21, W1–W7) — BINDING, user decision "allow a short [..] suffix"

- Per-provider id rules (W1): `MODEL_ID_BASE_RE` = the rule above, unchanged; `CLAUDE_MODEL_RE = ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}(?:\[[a-z0-9]{1,8}\])?$` (Claude only); `CODEX_MODEL_RE` stays narrow. One entry point `modelIdOk(provider, id)` for discovered ids, custom ids and `toolModels`, re-checked at use. No global wide rule.
- Codex: bracketed values refused at load/save and never reach argv (widening needs its own ruling with a real Codex id). Cursor (W4): narrow rule + must be in the discovered list; bracketed values refused even as custom ids.
- W5 accept/reject table per provider (accept for Claude only: `claude-fable-5-1[1m]`, `opus[1m]`; reject everywhere: `x[1m][2m]`, `x[1M]`, `x[effort=high]`, `x[1m,fast]`, `x[ 1m]`, `x[]`, `x[123456789]`, `x[1m]y`, `[1m]`, `-x[1m]`, `x[1m]\n`, `x[1m] `, 75 chars; 74 chars passes for Claude). Fixtures keep the `[1m]` entry with 0 dropped; AC1 counts updated from the Conductor-env recording.
- W6 (M8-2): one Claude argv snapshot with `--model claude-fable-5-1[1m]`. W7: any further widening returns to Security.
