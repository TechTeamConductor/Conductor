# Master plan — Conductor Workspace v2 ("AI-native engineering workspace")

- Task / Linear issue: none (Linear is being removed). Tracked in `.techteam/runs/active-run.md` (v2 checkpoint).
- Author: TechTeam Lead
- Date: 2026-10-20 (revision 2 — addresses `.techteam/reviews/workspace-v2-plan-review.md`, Decision: Changes requested, 12 blocking items)
- Plan status: pending_reviewer (rev 2)
- Requirement text: `.techteam/plans/workspace-v2-requirements.md` (verbatim; V1…V10 = its sections 1…10). All coverage below is checked against that file.
- Approval scope requested (rolling wave, per Reviewer's conditional path): **this master plan = direction for M3–M7**; **sub-plans `workspace-v2-m1.md` (M1a–M1d) and `workspace-v2-m2.md` (M2) are fully specified and are what is submitted for approval to start source edits.** Every later milestone gets its own sub-plan + Reviewer approval (+ Security sign-off where listed) before its first source edit.

## Working agreements (new, from the review)

1. **Isolation from the user's live tool.** A Conductor instance is running from `/Volumes/Sandisk/github/techteam-conductor` against the real `~/.conductor` (BAR-363 is in it). All v2 work happens in a **separate local clone** `/Volumes/Sandisk/github/techteam-conductor-v2` (its own `main`; no branch is created in the original repo; nothing is pushed) so the live tool's `ui/`, `src/` and `prompts/` are never edited under it. **Every test and manual run uses a throw-away `CONDUCTOR_HOME`**. The real `~/.conductor` is migrated only by an explicit, user-triggered, backed-up cut-over (`conductor migrate`, M1c). Last v1 commit is tagged `v1.0.0-rc2`; a timestamped copy of the real config/state/runs exists under `~/.conductor-backups/`.
2. **Gates per milestone.** Each milestone: sub-plan → Reviewer approval → implement → `npm run check` + `npm test` → Reviewer code review + Security review (Security sign-off on the *design* before the first edit for M2, M5, M7) → checkpoint commit (local, no push) → `active-run.md` updated.
3. **Honesty rule.** The final report states exactly what ran where. Windows is "preview / unverified" until run on a real Windows host.
4. **Downloads need explicit user permission** (Electron, electron-builder + fpm/NSIS, Docker images, repairing the broken Codex install). Asked at the start of M7 (and for Codex repair in M2), not now. Runtime stays zero-dependency.

## 1. Current State (corrected)

**v1 (commit 56c7f2d / tag `v1.0.0-rc2`; 483 tests, 479 pass, 4 opt-in skips; `npm run check` clean; live suite 3/3 pass today).** Zero-runtime-dependency Node 22.18+ app, TypeScript via type stripping, `src/` ≈ 11 k lines.

- **Pipeline:** Linear issue → Claude read-only plan → optional review → Cursor `--force` build in a git worktree → deterministic gates → Claude read-only verify → bug sub-issues → fix loop → "ready". One `Run` per issue key (`types.ts:178-237`): one worktree/branch/baseSha/commitSha/loop/bugs/sessions/`agentRuns`/`next`; one job loop per key (`engine.ts:693-715`, 60-iteration cap); `maxAgentRunsPerIssue` default 10 (`config.ts:28`).
- **Linear coupling is wider than the port.** `LinearPort` is `types.ts:378`, but Linear semantics are also compiled into `engine.ts` (imports `linear/attribution` + `linear/provision`; claim, reconcile/resume matrix, `moveIsMine`, approval-by-comment, `prov()`, `completedStateId()`), `stages.ts` (`applyStage` = labels + workflow state; imports `attribution`, `names`; limit labels), `effects.ts` (marker helpers from `attribution`, write-ahead remote effects), `context.ts` (`Provisioned`), `api.ts`/`runtime.ts`/`demo.ts`/`cli.ts`/`doctor.ts`/`secrets.ts` (Linear key, wizard, probes, `uninstall`), and types (`Run.issueId/teamId`, `BugRec.linearId/linearKey`, `EffectRec.linearId`, `Config.linear`, `Settings.linearMode`, setup-step ids, `RunStatus 'finished'` = "human completed the Linear issue"). `attribution.ts` mixes a multi-user *threat* model (goes away) with a *function* the board still needs: which comments are user intent vs Conductor output (`viewerComments`, `stages.ts:395`) and the idempotency markers.
- **`src/linear/fake.ts` is an emulator of Linear** (private `#` state, imports `LinearApiError` from the real client, Linear history quirks, pinned by `test/linear/parity.test.ts`). It is **not** a basis for a persisted board; the native board is written fresh (M1a).
- **Providers:** two-agent assumption is in `types.ts:7` (`AgentName`), `LogEvent.agent`, `SessionRec.agent`, `LimitInfo.provider`, `Settings.stages`, `config.ts:95-99`, `provider.ts`, `engine.ts:614-628,769,839`, `env.ts`, `doctor.ts`, `view.ts:45`, and provider-name labels (`stages.ts:129,148` would call a Codex limit "Cursor"). The builder safety envelope lives **outside** the provider in `stages.ts` (`writeCursorGuard`/`checkCursorGuard`, `agentGitEnv`, `snapshotGitMeta/revertGitMeta`, `postBuildChecks`).
- **Versioning:** real `~/.conductor/config.json` is `"version": 1`; `normalizeConfig` upgrades in memory, rewrites `version: 2`, and rebuilds from known keys only (unknown/newer keys are dropped on save); `run.json` and `RunStore` have no schema version. There is no migration framework.
- **Platform assumptions** (Windows/Linux breakers): macOS Keychain (`secrets.ts`), launchd (`service.ts`), `osascript` (`notify.ts`), `/usr/bin/open` + POSIX `SAFE_PATH` (`open.ts`), unix control socket + 0600 (`http.ts`), `startsWith('/')` path checks (`api.ts`), `sh -c` for gates and dependency installs (`gates.ts:131`, `worktree.ts:446`), `.cmd` shim spawning, POSIX-only child env allow-list (`env.ts:5-8`), `/usr/bin/false` + `/dev/null` in `agentGitEnv` (`worktree.ts:926-930`), macOS tools in `CURSOR_GUARD_DENY`, `process.kill(-pid)` (`spawn.ts`, `exec.ts`), `resolveBin` without PATHEXT, `shellQuote` (`util.ts:19`).
- **Environment (verified today):** `codex` npm shim v0.128.0 present but native binary missing (`ENOENT …/codex-darwin-arm64/vendor/…`); `~/.codex` has `hooks.json`, `hooks/` and a `config.toml` defining two MCP servers; `docker` present, `wine` absent; Node v22.21.1. Codex docs (fetched today) confirm `codex exec --json`, `--output-schema`, `-o`, `--sandbox read-only|workspace-write|danger-full-access`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config` (documented only for `config.toml`), `--ignore-rules` (**removes** execpolicy forbid rules), `exec resume`, `CODEX_API_KEY`; **not documented:** `-C`, `--model`, `--search`, approval flags, network behaviour in `workspace-write`, exit codes, limit text. electron-builder: `.deb` via bundled `fpm` works on macOS/Linux hosts; Windows NSIS from non-Windows needs Wine. Electron `safeStorage`: DPAPI on Windows; Linux needs kwallet/libsecret and silently falls back to plaintext (`getSelectedStorageBackend()==='basic_text'`).

## 2. Expected State

Eight milestones; each independently reviewable and ending green. **No milestone is "shippable v1 + v2" simultaneously**: v1 stays available as the tagged snapshot (the running instance), and v2 becomes the product at the M1c cut-over.

| M | Name | Scope (one line) | Plan |
| --- | --- | --- | --- |
| M1a | Native board store + versioning framework | persisted board; schemaVersion/migrations/backups for config, state, run.json, board; **no engine change** | `workspace-v2-m1.md` (full) |
| M1b | Engine cut-over to a native `BoardPort` | engine/stages/effects/context/view/api/runtime/demo ported; harness rewritten; test matrix applied | `workspace-v2-m1.md` (full) |
| M1c | Importer + cut-over command + minimal wizard/UI | `conductor migrate` (dry-run, backup, BAR-363 semantics), Linear-free wizard, New task → board | `workspace-v2-m1.md` (full) |
| M1d | Retire Linear | delete `src/linear/**`, Linear tests/mocks, docs; static import-graph test | `workspace-v2-m1.md` (full) |
| M2 | Providers, roles, Codex (gated) | provider interface incl. build-guard lifecycle; 10 roles; fallback/complexity routing; Codex runner (not an implementer yet) | `workspace-v2-m2.md` (full) |
| M3 | Plan v2 + task-graph execution | decomposition, deps, per-item runtime, limits that scale | direction below → sub-plan before edits |
| M4 | Project context engine | scanner, incremental manifest, staleness, packs, outcome digests, offline pause | direction below → sub-plan |
| M5 | Quick Ask + Deep Research | modes, research profile, report schema, convert-to-plan | direction below → sub-plan (+ Security design sign-off) |
| M6 | Automation policy, board UI, onboarding | policies/limits/risky rules, hierarchy UI, wizard v2, sample task | direction below → sub-plan |
| M7a/b/c | Desktop | (a) build-to-`dist` + cross-platform strategy layer, (b) Electron shell, (c) packaging/CI | direction below → sub-plans (+ Security design sign-off) |

**Must remain unchanged (v1 invariants — each has a surviving test, see M1 matrix):** Claude fail-closed isolation predicate; Cursor no-push guard + git env + git-meta snapshot/restore + branch secret scan + diff-scope/protected-path hold (also for builder self-commits); redaction before every sink; allow-listed child env; symlink-safe writes; loopback-only server with OTP/CSRF/Host/Sec-Fetch checks; Conductor never pushes/opens PRs/merges; usage-limit pause/back-off; restart rate-limit; question → answer path (`deliverable:'answer'` stays as the safety net for questions filed as Engineering Work).

### Direction for M3–M7 (binding requirements their sub-plans must satisfy)

**M3 — Plan v2 + execution runtime (V4, V7).** Sub-plan must specify: (a) *data model*: a parent `Run` owns `items[]` sub-run records `{id, workItemKey, dependsOn[], role, state, worktree?, branch?, baseSha, commitSha?, loop, loopBudget, bugs[], files[], criteria[], agentRuns}`; the board holds the human-facing hierarchy; (b) *state diagram* for item states and graph states, incl. what "ready" means for a partially complete graph and what Retry means; (c) *failure semantics*: item N fails after its loop budget → dependents `blocked`, independents continue, graph ends `needs_human` with an exact unblock action; (d) *crash recovery* mid-graph and mid-item; (e) *budgets that scale with item count* (`maxAgentRunsPerIssue` and the 60-iteration `runJob` cap become per-graph = f(items) with a hard ceiling — both are V7 "limits"); (f) per-item verification diff base + who owns a regression introduced by item 2 and found at item 4 (final whole-graph verify owns it, bug filed against the introducing item via `git blame` over the item commits); (g) approval/protected-path hold evaluated on the **union** of declared item files at plan time and per item at execution; (h) **per-item worktree-ready model**: `files`, `parallelGroup`, `dependsOn` are all recorded so disjoint-file items can later build in separate worktrees and be merged sequentially — **parallel build is *not* in v2.0 (decision D1) and V4's "parallel where safe" is reported Partial**; read-only items (requirements/architecture/research/review) may run concurrently, with a deterministic barrier-based test; (i) one named test per failure mode.

**M4 — Context engine (V5).** Store under `~/.conductor/projects/<projectId>/context/` (never inside a repo, never read from a checkout/worktree, integrity-protected with a content hash + schemaVersion). Deterministic scanner facts (languages, frameworks, commands, module map, test inventory, important files) are the only context that may go **verbatim into builder prompts**; LLM-written summaries/outcome digests are `fence()`d as untrusted in read-only stages, are never placed in builder prompts, are **off by default** (opt-in per project with a token budget that counts against agent-run limits) and are redacted + size-capped. Incremental updates via git (`ls-files -s`, mtime/size fast path); staleness = generated-at + git HEAD + per-module flags. **Offline:** connectivity probe; a provider call failing for network reasons puts the run into an `offline` pause (like the usage-limit pause: no `agentRuns` burn, auto-resume, one notification) — tested; the UI/API label each operation `offline-ok` / `needs-network (provider)`.

**M5 — Modes (V6).** One shared, run-independent agent caller extracted from `callReadOnly` (schema validation + one corrective re-ask, limit pause/back-off, abort, redaction, event log, quota) used by stages, Ask and Research. *Quick Ask*: states cwd (user's checkout, read-only), Cursor `--trust` consequence, Claude read deny-list applies; no worktree/branch; escalates to Engineering Work via "Turn into work". *Deep Research (hardened)*: default cwd = empty scratch directory (repo knowledge only via a redacted, budgeted deterministic pack; repo-aware research is an explicit per-task opt-in shown in the UI, with the credential-file deny-list kept); per-profile fail-closed tool predicate (plan/review/verify profile must still reject web tools — negative test per profile); verify that `--tools` + `dontAsk` actually permits `WebSearch/WebFetch` and widen nothing beyond; only providers flagged `webResearchIsolated` may hold the role; **citation integrity is structural**: every `sources[].url` must appear in an observed WebSearch/WebFetch tool event of that session else the finding moves to `unverified`; http/https only, rendered as text, opened externally via https allow-list; the report is `<untrusted>` data and any research-seeded work item **forces plan approval regardless of policy**.

**M6 — Policy, UI, onboarding (V7, V8).** Policies `full-auto | approve-plan | approve-risky | manual-stages`; **default = v1 behaviour (auto with forced holds for complexity `L` and protected files) and `full-auto` never removes those holds (decision D5)**. Enforceable controls only: plan-level static rules (protected paths, secret files, deploy/destructive-looking planned commands), post-hoc diff-scope + secret scan, provider-native deny lists, per-stage/total time + retry + parallelism limits. **Not enforceable and documented as such:** Conductor cannot intercept a `--force` builder's own shell calls. UI verification method: API-level tests + scripted Browser-pane checks with screenshots saved under `.techteam/runs/evidence/` (desktop + mobile, console clean); no new dev-dependency.

**M7 — Desktop (V1, V9). Binding requirements for the M7 sub-plans** (from review F-9): (1) Windows: `sh -c` for gates/install replaced by an explicit per-OS runner decision; `.cmd` shims resolved to the underlying executable or data passed via files/stdin — **never `shell:true` with agent/schema-derived argv**; Windows base env keys in the allow-list (`USERPROFILE/APPDATA/LOCALAPPDATA/SystemRoot/PATHEXT/TEMP/COMSPEC`); no `/usr/bin/false`·`/dev/null` assumptions; tree-kill via `taskkill /T`; named-pipe control channel with an explicit restrictive DACL or no control channel in desktop mode; `doctor` self-test must exercise the no-push guard on the host OS; Windows declared **preview/unverified** until run on a real host. (2) Electron: `safeStorage` reachable from the main process only (never via preload), delivered to the sidecar over IPC (never argv/env); desktop session = sidecar sends `{port, otp}` to main over IPC and main loads `/auth?otp=…` (single-use; **no new HTTP route, no static token, nothing on any command line**); BrowserWindow hardening (`contextIsolation`, `sandbox`, `nodeIntegration:false`, `webviewTag:false`, `will-navigate`/`setWindowOpenHandler` locked to the exact loopback origin, `shell.openExternal` https-only, permission handler deny-all, dedicated session partition); prefer `utilityProcess` over `ELECTRON_RUN_AS_NODE` (if the latter is kept, record why — it needs the RunAsNode fuse); one safeStorage policy chosen (refuse silent plaintext; explicit consent screen on `basic_text`) and a written **secret inventory** (what is stored, where, injected how, redacted how); `.deb` Electron sandbox/AppArmor smoke test in a container under Xvfb or reported unverified; **CI workflow is written but never executed (no push) — reported as unvalidated YAML**.

### Measurable acceptance criteria (rev 2)

| ID | Criterion (and how it is verified) |
| --- | --- |
| AC1 | On a fresh `CONDUCTOR_HOME` with no Linear key, a project → work item → plan → build → verify → "ready" run completes with fake CLIs (E2E test). A static test asserts **no `src/**` file imports `linear/`** after M1d (mechanical, not asserted by prose). |
| AC2 | Board items/comments/decisions/history survive restart; kill -9 mid-build resumes; config/state/run.json/board all carry `schemaVersion`; a **v1** real-shaped config (copy of the real file) migrates v1→v2→v3 with a timestamped backup before the first write; unknown keys survive a save; a newer-than-known version is refused (not downgraded); corrupt file → backup + safe start. **Rollback test:** v1 code (`v1.0.0-rc2`) opens a restored v1 snapshot. |
| AC3 | Three providers implement one interface; `detect/authStatus/selfTest` classify `missing | broken-install | not-logged-in | ok | unknown`. (`limited` is *reported when observed* — Claude via `rate_limit_event`; Cursor/Codex only from a real limit response — never probed by spending quota.) "Shim present, binary missing" (this machine's Codex) is a test fixture. |
| AC4 | Roles→providers: every role assignable only to providers whose capability flags permit it (build-capable, `buildIsolationVerified`, `webResearchIsolated`…); unsupported pairings rejected with a reason; **fallback chains never promote a provider whose build isolation is unproven**; fallback order and complexity routing honoured (unit + engine tests). |
| AC5 | (M3) validated task graph (cycle, dangling dep, empty criteria, item-count cap rejected with corrective re-ask); small request ⇒ exactly 1 item; execution respects `dependsOn`; read-only items run concurrently — **deterministic** (barrier/handshake in the fake agent, not wall-clock); one named test per M3 failure mode. V4 "parallel where safe" reported **Partial** (parallel build deferred, D1). |
| AC6 | (M4) scan of a fixture repo; edit one file ⇒ only its module re-analysed (counter test); HEAD change flips staleness; pack never exceeds budget and prefers relevant modules; context lives outside the repo and is never read from a worktree; a repo that commits a fake `.conductor/context/` is not trusted (test); network-off ⇒ engine `offline` pause without burning `agentRuns`, auto-resume (test). |
| AC7 | (M5) Quick Ask: no worktree/branch, one provider call; Research: report validates against schema; **every `sources[].url` appears in an observed tool event or the finding is `unverified`** (structural test with a stubbed tool-event stream); offline ⇒ flagged, no sources; research-seeded item forces approval; web tools absent from every non-research profile (negative test per profile). |
| AC8 | (M6) policies enforce what is enforceable: plan-level risky-rule matrix, post-hoc scope/secret scan, protected-path/`L` holds under every policy (incl. `full-auto`), limits (retries/parallel/time) — engine tests; docs state what is **not** enforceable. |
| AC9 | (M6) wizard flows verified at the API level (each CLI missing / broken / not-logged-in / ok → actionable guidance, never a dead end; sample task reaches "ready") **plus** scripted Browser-pane screenshots (desktop + mobile, console clean) saved under `.techteam/runs/evidence/`. |
| AC10 | (M7) `npm run build` output runs under plain `node` (no type stripping); Electron + builder config exist; `.deb` built and **inspected** only if the user permits the toolchain/Docker download; the Windows `.exe` row is **Gap**: build-only at best (Wine container, with permission) or CI; "installs/runs on Windows" is *not claimed*; CI YAML reported unvalidated. |
| AC11 | Security: no new network listener; new spawn/IPC paths tested; Codex never `danger-full-access`; Codex roles/flags pinned explicitly (see M2); research web tools only in the research profile; secrets never in argv/logs; safeStorage `basic_text` surfaced. |
| AC12 | **Test retention (no loophole):** v1 tests may only be retired or migrated **as listed in the approved M1 test matrix**; every property marked *survives* keeps an assertion of equal strength; post-M1 test count is stated in advance (M1 sub-plan) and any shortfall must be explained in the checkpoint. `npm run check` clean at every milestone; docs updated in the same milestone as the behaviour change. |

## 3. Files to Be Changed (master level; each sub-plan has its own exact table)

| File path | Action | Milestone | Note |
| --- | --- | --- | --- |
| `src/board/**` *new* | Create | M1a | native board |
| `src/schema/**` *new* (`version.ts`, `migrate.ts`, `backup.ts`) | Create | M1a | versioning for config/state/run.json/board |
| `src/pipeline/{engine,stages,effects,context,view,prompts}.ts`, `src/store.ts`, `src/types.ts`, `src/runtime.ts`, `src/config.ts`, `src/server/{api,http,open}.ts`, `src/{cli,doctor,demo,secrets,notify,util}.ts`, `src/git/{worktree,gates}.ts`, `dev/mock-api.mjs` | Modify | M1b–M1d, M2, M7 | exact lines in sub-plans |
| `src/linear/**`, `test/linear/**`, `test/helpers/mock-linear-server.ts` | Delete | M1d only | after nothing imports them |
| `src/agents/providers/**`, `src/agents/codex.ts`, `fixtures/fake-codex.mjs` *new* | Create | M2 | |
| `src/pipeline/graph.ts`, `src/context/**` (code only; data lives in `~/.conductor/projects/**`), `src/modes/**`, `src/policy.ts` *new* | Create | M3–M6 | |
| `ui/**`, `docs/**`, `README.md`, `AGENTS.md`, `CLAUDE.md` | Modify | each milestone | docs change with behaviour |
| `tsconfig.build.json`, `scripts/build.mjs`, `desktop/**`, `.github/workflows/desktop.yml` *new* | Create | M7 | |

**Redaction sinks the new work must cover (CLAUDE.md invariant, board = the new "Linear"):** board titles/descriptions/comments/child items from plan v2 and bug reports, the decision log, outcome digests, context summaries, research reports and citations, diagnostics export, notifications, log files, API responses, UI.

## 4. Implementation TODO (ordered)

- [x] Tag `v1.0.0-rc2`; back up real config/state/runs to `~/.conductor-backups/<ts>/`.
- [ ] Create `/Volumes/Sandisk/github/techteam-conductor-v2` (local clone; `node_modules` symlinked, no download); v2 run checkpoint.
- [ ] Reviewer re-review of this master plan + `workspace-v2-m1.md` + `workspace-v2-m2.md`.
- [ ] M1a → M1b → M1c → M1d (each: tests green, Reviewer + Security checkpoint, commit).
- [ ] M2 (Security design sign-off first).
- [ ] Sub-plans M3, M4, M5, M6, M7a/b/c — each reviewed before its first edit.
- [ ] Final report `.techteam/runs/final-report-workspace-v2.md`.

## 5. Testing Strategy (global)

Unit + integration with fake CLIs and real git on throw-away `CONDUCTOR_HOME`s; every survived v1 property keeps its assertion; negative security tests per new surface (endpoints, spawn, IPC, profiles); opt-in live suites re-run after M2 (`cursor-e2e`, `cursor-nopush`, `cursor-question`, `doctor --isolation`); Codex live probe only with a repaired binary and user permission, else reported **not run**; packaging checks as in AC10. Each sub-plan lists its own matrix.

## 6. Risks and Dependencies

- **Scale/time** (multi-week). Mitigation: rolling-wave approval, small milestones, hard gates, explicit out-of-scope: parallel *build* execution (D1), native Windows service, auto-update, code signing, macOS DMG, SQLite storage (decision recorded: JSON + journal now; revisit if the board outgrows it).
- **Live user data**: BAR-363 in the real `~/.conductor`. Mitigation: isolated clone, throw-away homes, tag + backup, user-triggered migration with dry-run and rollback test.
- **Safety regression** from refactoring: extract-then-change; v1 safety tests are gates; builder-guard lifecycle moved into the provider contract (M2) before any new provider can build.
- **Codex unproven** (broken binary, undocumented flags, no isolation predicate, user config with hooks + MCP on this machine). Mitigation in M2: capability flags + canary + fallback gating; Codex does **not** hold implementation/debugging/build-fallback until a live no-push suite passes.
- **Windows/Linux unverifiable on this Mac.** Mitigation: strategy objects + injected-platform unit tests, `doctor` host self-test, CI workflow (unexecuted), honest labels.
- **Prompt-injection via persisted context and research** — see M4/M5 binding rules.
- **Linear data**: importer is history-only; nothing is ever written back to Linear (D7).

### Decisions (autonomous defaults; raised to the user in the status report, not blocking)

| # | Decision | Default taken | Why |
| --- | --- | --- | --- |
| D1 | Parallel *build* in v2.0 | **Deferred**, data model ready, V4 labelled Partial | merge-conflict + safety surface; Reviewer recommends defer |
| D2 | Conductor runs CLI installers | **No** — guidance + copyable command only | "download and execute from external source" needs per-action consent |
| D3 | Windows release bar | **Preview / unverified** + mandatory `doctor` push-guard self-test | no Windows host here |
| D4 | Downloads | **Ask at M7 / M2**, not now | permission |
| D5 | Automation default | **auto with v1 forced holds**; `full-auto` never removes them | safety |
| D6 | Research privacy / LLM summaries | **No repo access unless opted in per task; summaries off** | exfiltration + quota |
| D7 | Linear data | **Import history only; never written back** | one source of truth |
| D8 | Default Codex role | **research-capable reviewer/fallback for read-only roles only**, not an implementer | unproven isolation |

## 7. Requirement Coverage Matrix (against the verbatim requirement)

| Req (verbatim section) | Planned change | Verification | Status |
| --- | --- | --- | --- |
| V1 Windows `.exe` + Linux `.deb`, automation + context + configurable workflows | M7 + all | AC10 | **Gap for `.exe`** (build-only at best); **Partial** for `.deb` (built/inspected if permitted) |
| V2 detect / install-or-guidance / auth / availability / connection test for 3 CLIs | M2 providers + M6 wizard | AC3, AC9 | **Partial** — "installation" is guidance by design (D2); Codex isolation unproven |
| V2 per-responsibility assignment, same CLI for many stages, fallbacks, complexity routing | M2 roles/routing | AC4 | Covered (with build-isolation gating) |
| V3 internal PM system, no Linear; projects, work items, deps, approval states, status, verification, failures/retries, assignments/logs, decisions/milestones | M1a–d, M3 | AC1, AC2 | Covered after M1d (milestones/decisions as board entities) |
| V4 plan-before-execution, analysis, decomposition, deps, completion criteria, assumptions, ask only when material, auto or approval | M3 | AC5 | Covered |
| V4 "opportunities for parallel execution" / V7 "run independent tasks in parallel where safe" | M3 (read-only parallel; data-model-ready) | AC5 | **Partial** (D1) |
| V5 persistent context, incremental, staleness, offline | M4 | AC6 | Covered (offline = local layer + offline pause; provider calls still need network) |
| V6 Quick Ask / Engineering Work / Deep Research (+ convert to plan, online-unavailable clarity) | M5 | AC7 | Covered (hardened) |
| V7 automation, policies, limits, sensitive-op rules | M6 | AC8 | **Partial** — only enforceable controls claimed |
| V8 onboarding (9 steps, sample task, defaults first) | M6 | AC9 | Covered |
| V9 persistent data, secure credentials, background execution, logs, interrupted-op safety, versioned migrations, validate CLI capabilities | M1a, M2, M7 | AC2, AC3, AC10, AC11 | Covered (Windows unverified) |
| V10 principles | all | AC1, AC8, AC12 | Covered |
