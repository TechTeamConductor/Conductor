# Sub-plan M2 — Providers, roles and Codex (gated)

- Parent: `.techteam/plans/workspace-v2.md` (rev 2). Requirement: `workspace-v2-requirements.md` §2 (and §7 step 1, §9 last paragraph).
- Author: TechTeam Lead · Date: 2026-10-20 · Plan status: pending_reviewer · Depends on: M1 complete (runs on the native board).
- **Gate:** Security signs off this design **before the first source edit of M2** (new executable surface: a third CLI that can write files).

## 1. Current State (verified)

- Providers are hard-coded: `AgentName = 'claude' | 'cursor'` (`types.ts:7`), used by `LogEvent.agent`, `SessionRec.agent`, `LimitInfo.provider`, `Settings.stages` (`plan|review|verify` → `claude|cursor`), `config.ts:95-99`, `provider.ts` (`Agents.readOnly/build`), `engine.ts:614-628` (`providerFor`), `:769` and `:839` (loops over the two names), `env.ts` (`claudeEnv`, `cursorEnv`), `doctor.ts` (`agentHealth(cfg,'claude'|'cursor')`), `view.ts:45` (`AGENT_NAME`), and `stages.ts:129,148` (`limit.provider === 'claude' ? 'Claude' : 'Cursor'` — a Codex limit would be called "Cursor").
- Build is Cursor-only and its safety envelope is **outside** the provider, in `stages.build()` (`stages.ts:~585-700`): `writeCursorGuard` (writes `.cursor/cli.json` deny list, rewritten every build, symlink-safe) → `agentGitEnv` (no-push git env: `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ASKPASS=/usr/bin/false`, … `worktree.ts:~910-930`) → `snapshotGitMeta` → `agents.build` → `revertGitMeta` → `checkCursorGuard` → `commitAll` (secret/scope guard) → `postBuildChecks` (diff-scope incl. rename sources, branch secret scan incl. self-commits). Run fields `cursorGuardSha`, `noPushEnvOnly`. The no-push guarantee of Cursor was **proven by the live adversarial suite** `test/live/cursor-nopush.test.ts` (8 attacks; the env layer alone let 5 of 9 variants through — security review C3).
- Claude read-only isolation is fail-closed (`checkClaudeInit`, `claude.ts`; `isolationProbe`, `doctor.ts`); Cursor read-only runs `--mode ask` with weaker, knowingly accepted isolation (`stages.ts:~244`).
- Limit/auth classification: Claude from `rate_limit_event`/`api_error`; Cursor only from CLI-reported error text (`cursor.ts:LIMIT_RE`, structural since M12).
- `doctor.agentHealth` treats "binary exists" as found and parses `--version` output; it cannot distinguish a working install from a broken one.
- **This machine:** `codex` shim v0.128.0 whose native binary is missing (`spawn …/codex-darwin-arm64/vendor/…/codex ENOENT`); `~/.codex/` holds `auth.json`, `config.toml` (two MCP servers), `hooks.json`, `hooks/`. Docs (fetched today) give `codex exec --json`, `--output-schema`, `-o`, `--sandbox`, `--ephemeral`, `--ignore-user-config` (config.toml only), `--ignore-rules` (drops execpolicy rules), `exec resume`, `CODEX_API_KEY`; undocumented there: `-C`, `--model`, `--search`, approval flags, `workspace-write` network behaviour, exit codes, limit text.

## 2. Expected State

**One provider contract, three providers, ten roles — Codex present but unable to build.**

```ts
type ProviderId = 'claude' | 'cursor' | 'codex';            // registry-driven; no ternaries on names anywhere
interface Capabilities {
  readOnly: boolean; build: boolean; structuredOutput: 'native' | 'prompted';
  webResearch: boolean;                                      // has web tools at all
  readOnlyIsolation: 'verified' | 'partial' | 'unverified';  // fail-closed predicate | known weaker tier (Cursor) | none yet
  buildIsolationVerified: boolean;                           // live no-push suite passed for this provider
  webResearchIsolated: boolean;                              // per-profile tool lock-down proven (M5)
  limitSignal: 'event' | 'cli-text' | 'none'; resume: boolean;
}
interface Provider {
  id; label; detect(cfg): Promise<Detect>;                   // missing | broken-install | ok  (+ version/path/hint)
  auth(cfg): Promise<Auth>;                                  // ok | not-logged-in | unknown
  selfTest(cfg, level: 'cheap' | 'canary'): Promise<SelfTest>;   // 'canary' may spend quota ⇒ explicit confirmation
  capabilities(cfg): Capabilities;
  runReadOnly(req): Promise<AgentResult>;
  build?: { prepare(ctx): Promise<BuildPrep>; run(req, prep): Promise<AgentResult>; verifyGuard(prep, ctx): Promise<{ ok: boolean; detail: string }> };
}
```

- **Build envelope is provider-agnostic and mandatory** (`src/pipeline/envelope.ts`, extracted from `stages.build` with zero behaviour change): git no-push env, `snapshotGitMeta/revertGitMeta`, `commitAll` secret/scope guard, `postBuildChecks`, redaction, allow-listed child env. The provider only adds its *own* guard through `prepare` (e.g. Cursor writes `.cursor/cli.json`, hash recorded) and `verifyGuard` (hash check). The `Run` fields become generic (`guardSha`, `guardEnvOnly`; migrated from `cursorGuardSha/noPushEnvOnly` by a run.json migration).
- **Roles** (`requirements, context, planning, architecture, implementation, review, verification, debugging, documentation, research`): `config.roles[role] = { providers: ProviderId[], autoByComplexity?: { S?, M?, L? } }`. Defaults reproduce v1 exactly: planning/review/verification → `[claude]` + (`cursor` appended iff v1 `onClaudeLimit==='cursor'`, the v1 default); implementation/debugging → `[cursor]`; requirements/context/architecture/research → `[claude]`; documentation → `[cursor]`. **Codex appears in no default chain (D8).** In M2 the engine executes the four existing stage slots (planning, review, verification, implementation; fix loops = debugging); the other roles are validated, stored, and consumed by M3–M5 (an item's `role`).
- **Routing** (`src/agents/routing.ts`, pure): `chain(role, {complexity?, health, pauses, caps})` → ordered candidates: complexity pick first when configured (applies to stages that run **after** the plan is known: review, implementation, verification, debugging — planning uses its fixed chain; a pre-plan estimate is M3), then configured order; drops providers that are missing/broken/not-logged-in/paused unless nothing else remains (then the stage pauses with the exact reason — v1 usage-limit pause semantics unchanged); **filters by capability**: a role needing `build` only admits `build && buildIsolationVerified` providers; `research` only `webResearchIsolated`; read-only roles admit `readOnly` providers of any isolation tier but the UI/run log label `partial/unverified` tiers. Running a stage: first candidate, on `limit` / `spawn` / `auth` error advance to the next, with a visible note (v1's "Cursor takes over read-only stages" is exactly this, now general). **A fallback never promotes a provider whose build isolation is unproven.**
- **Validation of assignments** (`PUT /api/roles`, whitelist-only, clamped, unknown keys ignored — same pattern as `PUT /api/settings`): pairing check against capabilities with a human reason, e.g. "Codex cannot own *Implementation*: its no-push isolation has not been verified on this machine."
- **Codex provider** (`src/agents/codex.ts`; read-only roles only in M2; `build` omitted):
  - **Private `CODEX_HOME`** at `~/.conductor/providers/codex-home/` containing only our `config.toml` (no MCP servers, no hooks) and a symlink to the user's `auth.json` (or `CODEX_API_KEY` when the user configured one). The user's real `~/.codex/{config.toml,hooks.json,hooks/}` are therefore never loaded — this is the structural answer to "this machine has hooks + two MCP servers", not a flag we hope is honoured.
  - argv, all **pinned explicitly** (never defaults): `codex exec --json --sandbox read-only --ignore-user-config --ignore-rules --ephemeral -c approval_policy="never" -c sandbox_workspace_write.network_access=false [--output-schema <tmpfile>] -o <tmpfile> -` with the prompt on **stdin**, `cwd` = the target dir. `--ignore-rules` is **kept on purpose** (project `.rules` files are untrusted repo input that can widen what runs; our own protection is the sandbox + envelope) and documented as such. `danger-full-access` is never constructed (argv test) and `workspace-write` is not used at all in M2.
  - JSONL → `LogEvent` normaliser (`thread.started`→session id; `item.*` agent_message/reasoning/command_execution/file_change/mcp_tool_call/web_search; `turn.completed.usage`; `turn.failed`/`error`). **Limit/auth classification only from CLI-reported `error`/`turn.failed` events and stderr — never from model prose** (M12 rule; test: an `agent_message` saying "usage limit" is not a limit).
  - `.codex/**` added to `PROTECTED_DIR_SEGMENTS` (`worktree.ts`) and the `PROTECTED` prompt text (`stages.ts:26`); ancestor scan covers `.codex`; `codexEnv` allow-list = base + `CODEX_HOME` (ours) + `CODEX_API_KEY` only (**never `OPENAI_*` wholesale**).
  - **Isolation canary** (`doctor --isolation codex`, also a pre-flight when Codex is first assigned): a throw-away repo with a canary `AGENTS.md`, a canary hook/MCP entry in the *user-like* home, and a canary file name; run one tiny read-only `exec` and assert via the JSONL transcript that none of them were honoured. Until it passes on this machine/version, `readOnlyIsolation = 'unverified'` and the UI says so. **Not runnable today (binary broken); reported "not run".**
  - Capability *detection* = minimum version + feature probes in `selfTest` (try the flag, classify the failure), **not** `--help` text parsing; fixtures from a real binary are committed only if/when one exists.
  - `buildIsolationVerified` for Codex = false and can only become true via `doctor --verify-build codex` (a Codex port of the live adversarial no-push suite) recorded in `~/.conductor/providers/codex/verification.json` with the CLI version. Not implemented in M2 beyond the record format + gating; **Codex does not hold implementation/debugging and is never a build fallback** (AC4).
- **Detection/auth** (`doctor` generalised, zero quota): `detect()` executes `<bin> --version` — spawn ENOENT, non-zero exit, or "Cannot find module/native binary" ⇒ `broken-install` with the stderr tail and the repair hint (`npm i -g @openai/codex` — shown, **never run by Conductor**, D2); `auth()` = `claude auth status` JSON / `agent status` / `codex login status` (exit-code first, text second, unknown when unrecognised). The "shim present, binary missing" case is a committed fixture (`fixtures/fake-codex.mjs --broken`).
- **Config v4** (migration from v3): `stages{plan,review,verify}` + `pipeline.onClaudeLimit` → `roles`; adds `agents.codex {bin, model?}`; old keys preserved under `legacy`. API: `GET /api/providers` (detect/auth/capabilities/tier), `POST /api/providers/:id/test` (`cheap` default; `canary` needs `{confirm:true}`), `GET/PUT /api/roles`. UI work is M6 (wizard/settings) — M2 exposes API + doctor output only.
- **Provider-name leaks fixed:** `providerLabel(id)` registry used by `stages.ts`, `view.ts`, `engine.ts`, UI chips; `AgentName`→`ProviderId` across `types.ts`; `quota`/`providerPause` maps keyed by `ProviderId`.

**Must remain unchanged:** Claude read-only profile and fail-closed predicate (byte-identical argv + init check), Cursor build behaviour and its guard files, every v1 safety test, `--force`-class builds only via providers with `buildIsolationVerified`.

**Measurable acceptance criteria (M2):** AC3, AC4, AC11 (Codex part) of the master plan, plus: (a) **extraction is behaviour-preserving** — `test/agents.test.ts` and all engine safety tests pass **unchanged** after the provider/envelope extraction (commit 1), before Codex is added (commit 2); (b) `buildClaudeArgs` snapshot test proves the Claude argv did not change; (c) the Cursor live suites (`cursor-e2e`, `cursor-nopush`, `cursor-question`) pass after extraction; (d) every provider passes one shared **contract test suite** (fakes) — detect/auth/selfTest classification, read-only structured result, limit event, abort, redaction of output, secrets never in argv; (e) Codex argv test: exact pinned flags, no `danger-full-access`, prompt not in argv, private `CODEX_HOME`, env allow-list; (f) provider-name test: a Codex limit is reported as Codex everywhere (comment, notification, dashboard banner).

## 3. Files to Be Changed

| File | Action | Change |
| --- | --- | --- |
| `src/agents/providers/{types,registry,claude,cursor,codex}.ts` | Create | contract, registry (labels, capabilities), thin adapters over existing runners; `codex.ts` contains argv builder + JSONL normaliser + canary |
| `src/agents/routing.ts` | Create | pure chain resolution + capability filtering + pairing validation |
| `src/agents/provider.ts` | Modify | `Agents` becomes the orchestrator over the registry: `readOnly(role, req)` / `build(req)`; v1 `onClaudeLimit` fallback reimplemented as chain advance |
| `src/agents/{claude,cursor}.ts` | Modify (minimal) | export through the contract; **no behaviour change** (argv snapshot test) |
| `src/agents/env.ts` | Modify | `codexEnv`; Windows base keys deferred to M7 |
| `src/pipeline/envelope.ts` | Create | extracted provider-agnostic build envelope (from `stages.build`/`postBuildChecks`) |
| `src/pipeline/stages.ts`, `engine.ts`, `view.ts`, `context.ts` | Modify | use envelope + routing; `providerLabel`; generic guard fields; `providerFor` via roles |
| `src/git/worktree.ts` | Modify | `.codex` in protected + ancestor lists; `writeCursorGuard` stays Cursor-specific, exported through the Cursor provider's `prepare` |
| `src/types.ts`, `src/config.ts`, `src/store.ts` | Modify | `ProviderId`, `Role`, roles config v4 + migration, `legacy`; run.json migration `cursorGuardSha→guardSha`, `noPushEnvOnly→guardEnvOnly` |
| `src/doctor.ts`, `src/cli.ts` | Modify | provider-generic checks; `doctor --isolation <provider>`, `--verify-build <provider>` (record format only for Codex) |
| `src/server/api.ts` | Modify | `/api/providers`, `/api/providers/:id/test`, `/api/roles` (whitelist, clamp, CSRF as all mutations) |
| `fixtures/fake-codex.mjs` | Create | documented event shapes; scenarios: ok, limit (error event), not-logged-in, broken-install, canary-honoured (negative control) |
| `test/providers/*.test.ts`, `test/routing.test.ts`, `test/envelope.test.ts`, existing `test/agents.test.ts` | Create/keep | per §5 |
| `docs/ARCHITECTURE.md`, `docs/API.md`, `README.md` | Modify | providers, roles, tiers, Codex status (unverified), what Conductor never installs |

## 4. Implementation TODO

- [ ] Security design sign-off on this document (**before any edit**).
- [ ] **Commit 1 — extract, no behaviour change:** envelope + provider contract + Claude/Cursor adapters + registry + `ProviderId` rename + provider-name fixes; argv snapshot; all existing tests green **unchanged**; live Cursor suites.
- [ ] **Commit 2 — roles + routing + config v4 + API:** defaults reproduce v1; migration tests from the real v1/v2/v3 config fixtures.
- [ ] **Commit 3 — Codex (read-only):** runner, normaliser, private home, env, protected lists, doctor classification, fake-codex fixture, contract tests.
- [ ] **Commit 4 — canary + verify-build record + docs;** run what can run; list what could not (live Codex).
- [ ] Reviewer code review + Security review of M2; checkpoint commit.
- [ ] **Ask the user** (permission, not before commit 4): repair the broken Codex install (`npm i -g @openai/codex`, a download) so the live probe/canary can run.

## 5. Testing Strategy

- **Contract suite** (all three providers via fakes): detect states (`missing`, `broken-install`, `ok`), auth states, `selfTest('cheap')` spends nothing, structured result validation incl. corrective path, limit event ⇒ `limit` classification with correct provider label, abort kills the process group, redaction of outputs and no secrets in argv/env.
- **Claude regression:** `buildClaudeArgs` snapshot identical to v1; `checkClaudeInit` tests unchanged; `doctor --isolation` real run (opt-in) still `isolated`.
- **Cursor regression:** existing agent/engine-safety tests unchanged; live `cursor-e2e`, `cursor-nopush`, `cursor-question`.
- **Codex:** argv exactness (pinned `--sandbox read-only`, `-c approval_policy`, `network_access=false`, `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, prompt via stdin, no `danger-full-access`, `workspace-write` absent); private `CODEX_HOME` content (only our `config.toml` + `auth.json` symlink; the user's hooks/MCP absent) — canary fixture proves a home-level hook/MCP/`AGENTS.md` is **not** loaded by the fake when the private home is used and **is** (negative control) when the real home is used; env allow-list (no `OPENAI_*`); JSONL normaliser on documented events + unknown event types ignored; limit only from error events, never from `agent_message` prose.
- **Routing/roles:** every role × provider pairing table; build/research gating; fallback never reaches an unverified build provider; complexity routing; paused/missing/not-logged-in skipping; v1-default equivalence (a v1 config produces v1 behaviour — engine test replays the v1 limit-fallback scenario).
- **Config/run.json migration:** v1→v4 on the real-shaped fixture, unknown keys preserved, newer refused.
- **API:** `/api/roles` whitelist, clamp, unsupported pairing rejected with reason, CSRF/Host/cross-site negatives; `/api/providers/:id/test?canary` requires confirm.
- **Static:** `npm run check`; grep: no remaining `=== 'claude' ? 'Claude' : 'Cursor'`-style ternaries on provider names.
- **Not run (stated):** live Codex probe/canary/verify-build (broken binary; needs the user's permission to repair).

## 6. Risks and Dependencies

- **Extraction risk** (moving the guard lifecycle): mitigated by commit-1 "no behaviour change" rule, argv snapshot, unchanged tests, live suites.
- **Codex flags are unverified** (`-c` keys, stdin `-`, `--ephemeral` semantics, `approval_policy` key name, `sandbox_workspace_write.network_access`): each is a *probe-classified* capability in `selfTest`; if a probe fails, Codex is marked `unverified` and cannot be selected for any role; no silent fallback to unpinned defaults.
- **Private `CODEX_HOME` + symlinked `auth.json`:** Codex may rewrite `auth.json` on token refresh through the symlink (intended) — but a CLI that refuses symlinks would fail to log in; the probe covers it and the documented alternative is `CODEX_API_KEY`.
- **Read-only isolation of Codex/Cursor is weaker than Claude's** (no tool inventory to check, cannot deny credential reads): documented tier, redaction mandatory on all outputs, Cursor behaviour unchanged.
- **Quota use:** `selfTest('canary')` and live suites spend provider quota → explicit confirmation, never automatic.
- **Dependencies:** M1 (board; roles/items), a working Codex binary for live verification (user permission to repair).
- **Assumptions:** `AgentName` rename is mechanical; UI shows provider chips from the registry.

## 7. Requirement Coverage Matrix (M2 slice)

| Requirement (verbatim §) | Planned change | Verification | Status |
| --- | --- | --- | --- |
| §2 configure Codex, Claude Code, Cursor CLI | registry + config + API | contract suite | Covered (Codex: fakes + argv tests; live not run) |
| §2 detection, installation **or setup guidance**, auth check, availability, connection test | `detect/auth/selfTest`, repair hints (never auto-run) | contract + fixtures incl. broken-install | Covered (guidance only, D2) |
| §2 configure each CLI independently; decide which tool owns each stage | roles config + API + pairing validation | routing tests | Covered |
| §2 same CLI for multiple stages; fallback providers; auto-selection by task complexity | chains + `autoByComplexity` (post-plan stages) | routing tests | Covered (planning pre-estimate = M3) |
| §2 sensible defaults out of the box | v1-equivalent defaults | v1-equivalence engine test | Covered |
| §9 validate each CLI's actual installation, invocation, auth, capabilities | probes + canary + `broken-install` | tests + opt-in live | Covered (Codex live **not run**) |
| §7 step 1 "Select the appropriate CLI for each stage" | `Agents` over registry | engine tests | Covered for existing stages; per-item roles in M3 |
