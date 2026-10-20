# Plan review — Conductor Workspace v2

Reviewer agent only. Silence is not approval. This is a review of the plan, not of any code (none exists yet).

- Task / Linear issue: none (Linear is being removed; tracked in `.techteam/runs/active-run.md`, which currently still describes `conductor-v1` — a v2 checkpoint has to be created)
- Plan artifact: `.techteam/plans/workspace-v2.md` (status `pending_reviewer`, author TechTeam Lead, 2026-10-20)
- Bar used: `.techteam/templates/implementation-plan.md` (7 sections) + `.techteam/templates/plan-review.md` (7-point checklist)
- Reviewed by: Reviewer (independent agent; did not author or edit the plan or any source)
- Reviewed at: 2026-10-20
- Decision: **Changes requested** (see the final line)

## How I reviewed

I read the plan, then the real code it makes claims about: `src/types.ts`, `src/pipeline/{engine,stages,effects,context,prompts,view}.ts`, `src/store.ts`, `src/runtime.ts`, `src/config.ts`, `src/agents/{provider,claude,cursor,spawn,env}.ts`, `src/linear/{fake,attribution}.ts` and the import graph of `src/linear/**`, `src/server/{api,http,auth,open}.ts`, `src/doctor.ts`, `src/secrets.ts`, `src/lock.ts`, `src/paths.ts`, `src/service.ts`, `src/notify.ts`, `src/cli.ts`, the relevant parts of `src/git/worktree.ts` and `src/git/gates.ts`, `test/helpers/harness.ts`, and the test layout. I also checked the machine: baseline `npm run check` is clean and `npm test` is 483 tests / 479 pass / 4 skipped (matches the plan); `codex` shim at `~/.nvm/.../bin/codex` fails with `spawn …/codex-darwin-arm64/…/codex ENOENT` (matches); `docker` present, `wine`/`electron` absent (matches). I fetched the Codex non-interactive docs page the plan cites.

## Checklist

1. **Codebase analysis is complete enough to implement safely: no.** Several §1 claims are wrong or understated (table below), the Windows/Linux inventory misses the worst offenders, and the decomposition milestone ignores single-run assumptions that are hard-wired into the engine.
2. **Every task requirement is covered (100% mapped): no.** All of V1–V10 have a row, but three rows are labelled "Covered" while the plan itself says part is deferred or unverifiable (V1 `.exe`, V4 parallel, V5 offline execution), V2 "install" is silently "guidance only", the user's existing runs (importer) are mentioned in §6 but appear nowhere in §3/§4/§5/ACs, and the matrix is checked against the Lead's paraphrase of the requirement rather than the requirement text (the verbatim 10 sections are not in the repo).
3. **Proposed architecture is correct: not yet.** M1's central idea (a `LinearPort` over a native board so the engine "runs unchanged") does not survive contact with the code and contradicts the plan's own file table. M3 has no data model. The provider interface in M2 omits the build-guard lifecycle that is today the no-push safety layer.
4. **Affected-file list is accurate: no.** Missing files listed in finding F-7; one claim ("FakeLinear is the basis of a persisted adapter") is not supportable from the code. No invented existing files found — every "verified" path I checked exists.
5. **Security, authorization, compliance addressed: partially.** The plan names the right risks (Codex sandbox, research web tools, summaries as injection, safeStorage plaintext). The mitigations are too thin on four of them (Codex build isolation, research exfiltration, context store location, Electron hardening) and AC8 over-claims.
6. **Testing strategy adequate: partially.** Good: fake CLIs, real git, honesty about Windows/`.exe`. Missing: the retire/migrate matrix for the Linear-coupled tests, UI verification, the offline engine behaviour, determinism of the concurrency test, source-vs-tool-event check for research citations.
7. **Risks, dependencies, acceptance criteria explicit: partially.** Download permissions are correctly gated. Rollback/migration for the user's live data is not designed (and the data is in a different state than the plan assumes).

## 1. §1 "Current State" — claim-by-claim against the code

| Plan claim | Verdict | Evidence |
| --- | --- | --- |
| Engine talks to Linear **only** through `LinearPort` (`types.ts:378`) | **Wrong as stated.** The port interface is at `types.ts:378`, but Linear semantics are also compiled into the engine through three non-port modules and the data types. | `engine.ts:14-15` imports `linear/attribution.ts` + `linear/provision.ts`; `stages.ts:19-20` imports `attribution` + `names`; `effects.ts:5` imports `attribution` (marker helpers); `context.ts:7` imports `Provisioned`; `api.ts:11`, `runtime.ts:9-10`, `demo.ts:9-10` import `provision`/`client`/`fake`. Types: `Run.issueId/teamId` (`types.ts:180-181`), `BugRec.linearId/linearKey`, `EffectRec.linearId`, `Config.linear`, `Settings.linearMode`, `ApiSetupStep` ids `linear\|team`, `RunStatus 'finished'` = "human completed the Linear issue" (`types.ts:23`). |
| `src/linear/fake.ts` is "complete" and a basis for a **persisted** board adapter | **Not supportable.** It is a faithful emulator of *Linear*, not a board: private `#` state with no serialisation, imports `LinearApiError` from the real GraphQL client (`fake.ts:27`) and `sameName` from `names.ts`, emulates provisioning (`createLabel`/`createState`/`Forbidden`), Linear history quirks (creation writes no history, C1), and is pinned to `LinearClient` by `test/linear/parity.test.ts`, not to anything native. Persisting it means rewriting it. | `fake.ts:27-28, 152-159, 243-258, 371-396`; `parity.test.ts:1-60`. |
| Provider selection is hard-coded in `src/agents/provider.ts` | **True but understated.** The two-agent assumption is also in `types.ts:7` (`AgentName`), `LogEvent.agent`, `SessionRec.agent`, `LimitInfo.provider`, `ApiEngine.providerPause`, `Settings.stages`, `config.ts:95-99`, `engine.ts:614-628, 769, 839`, `env.ts` (no Codex env), `doctor.ts`, `view.ts:45` (`AGENT_NAME`), and `stages.ts:129,148` (`limit.provider === 'claude' ? 'Claude' : 'Cursor'` — a Codex limit would be reported as "Cursor"). | as cited |
| Attribution code exists only for multi-user Linear | **Mostly true, but it also carries things the board needs.** `attribution.ts` hosts the idempotency-marker helpers (`markerLine/hasMarker/isConductorComment`, used by `effects.ts:5`) and `viewerComments` / `hasApproveCommand` — i.e. the "human comment → next prompt" channel (`stages.ts:395`). On a single-user board the *threat* disappears, the *function* (which comments are user intent vs Conductor output) does not. "Becomes a no-op" is wrong. | `attribution.ts:26-59, 184-206` |
| Mac-only assumption inventory (Keychain, launchd, osascript, `/usr/bin/open`, unix socket, `startsWith('/')`, 0600, process groups) | **Incomplete — omits the items that will break Windows first.** See F-9. | `gates.ts:131` and `worktree.ts:446` run `sh -c`; `worktree.ts:926-930` `/usr/bin/false`, `/dev/null`; `env.ts:5-8` POSIX-only env allow-list; `config.ts:199-206` `resolveBin` (`includes('/')`, no PATHEXT); `util.ts:19` POSIX `shellQuote`; `open.ts` `SAFE_PATH = /^\/…/`; `CURSOR_GUARD_DENY` macOS tools. |
| v1 stays shippable at every milestone | **False for M1** (Linear is removed from runtime wiring, wizard and config) unless dual backends are kept until cut-over. | plan header vs M1 |
| Test baseline 483 / 479 / 4 | **Verified** (`npm test`: 483, pass 479, skipped 4; `npm run check` clean). | run today |
| Codex shim installed, native binary missing | **Verified** (`ENOENT …/codex-darwin-arm64/vendor/…/codex`). Also relevant and not in the plan: `~/.codex/` here contains `hooks.json`, a `hooks/` dir and a `config.toml` defining **two MCP servers** — a live example of the isolation problem in F-5. | local check |
| Codex flag contract | **Matches the docs page** (`--json`, `--output-schema`, `-o`, default read-only sandbox, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--full-auto` removed; `-C/--cd`, `--model`, `--search` not documented — the plan already says so). Two things the plan does not draw out: `--ignore-user-config` is documented only as "don't load `$CODEX_HOME/config.toml`" (it does **not** say hooks, `AGENTS.md`, or project config are ignored), and `--ignore-rules` skips **user and project execpolicy rules, i.e. it removes forbid rules**. The page says nothing about network access inside `workspace-write`. | WebFetch of the docs page |
| `~/.conductor` data is at "schemaVersion N-1" (AC2) | **Wrong premise.** The real `~/.conductor/config.json` on this machine is `"version": 1`; `normalizeConfig` upgrades v1 implicitly in memory (`config.ts:57-61`), forces `version: 2` on every normalise (`config.ts:62`) and rebuilds the object from known keys only, so unknown/newer keys are silently dropped on the next save. `run.json` and `RunStore` have no version at all (`store.ts`). There is no migration framework today; the plan's "v2→v3" starts one step too late and would silently drop v3 keys if a v2 binary ever saved. | `config.ts:49-63`; `~/.conductor/config.json`; `~/.conductor/runs/BAR-363/run.json` |
| A live instance? | Not mentioned in the plan. A Conductor instance (pid 11390, `node bin/conductor.mjs start --no-open`, port 4317) is running from this tree against the real `~/.conductor`, with `BAR-363` in `needs_human` bound to a Linear issue. | `~/.conductor/run/lock.json`, `ps` |

## 2. M1 — "implement `LinearPort` over a native board so the engine runs unchanged"

This is the load-bearing idea of the plan and it is not viable as written. Also, the plan contradicts itself: the milestone text says the engine runs unchanged, while §3 lists `engine.ts`, `stages.ts`, `effects.ts` as **Modify** ("Candidate source = board; … Replace `linear.candidates` polling with board events").

What an adapter would have to fake so that the existing engine believes it is talking to Linear:

- **Provisioning**: `prov()` (`engine.ts:144-154`) needs team labels/states from `resolveProvisioned`; `applyStage` (`stages.ts:79-94`) expresses pipeline stage as *labels + workflow state*, `completedStateId` (`engine.ts:156-165`) reads `teamSetup`. The board would need teams, labels, a Backlog/Todo/In Progress/In Review/Done workflow, and `createLabel/createState`.
- **Claim**: `candidates(teamId, triggerLabel)` + creator==viewer + history-based attribution (`engine.ts:310-378`; `attribution.ts` fails closed when history is missing, `attribution.ts:80-84`). The board must synthesise history entries with actor ids, or every item is "ignored".
- **Park / restart / finish by moving state**: `engine.ts:426-436` (backlog/triage ⇒ park, unstarted ⇒ re-run), `moveIsMine` via history actor (`engine.ts:477-494`), finish via Linear `completed` (`engine.ts:417-422`).
- **Approve by comment**: `/approve` anchored on the stored id of Conductor's own approval-request comment (`engine.ts:447-469`) — on a board this is simply a button that already exists (`api.ts:219-224`).
- **Bug sub-issues**: labels, states, `PER_LOOP/PER_RUN` limits, marker-based adoption via `children()` (`stages.ts:936-963`, `effects.ts:157-192`).
- **Identity**: `viewerId()` throws when unknown (`engine.ts:138-142`); `SECRET_LINEAR` is the *only* redaction secret and the *only* thing `secrets.ts` stores (`secrets.ts:120`, `runtime.ts:91`).

Result: the board would carry a hidden Linear-shaped model for the engine and a second, native model (kind, parentId, dependsOn, decisions) for the UI, with a mapping layer both ways — the opposite of "one source of truth" (V10). "Port semantics copied from `FakeLinear`" also means the native board inherits Linear quirks (no history on creation, `LinearApiError`).

**Moving `src/linear/` to `legacy/linear/` at M1 breaks the build**: `engine.ts`, `stages.ts`, `effects.ts`, `context.ts`, `api.ts`, `runtime.ts`, `demo.ts` import from it (list above), and `test/helpers/harness.ts:12-13,105,124` builds every engine test on `FakeLinear` + `provisionTeam` (~71 `h.linear` references across 12 test files). "FakeLinear stays as a test double only until the engine tests are re-pointed" is not a plan, it is the milestone.

The sane order is a strangler seam: (1) define a `BoardPort` with native semantics (items, status, parent/children, comments with author kind, decisions, events), (2) port engine/stages/effects/context/api/runtime to it while a Linear-backed implementation still exists so v1 stays shippable and the 483 tests stay green, (3) add the native board, (4) cut over, (5) retire Linear and its tests. Deleting "at M7" is fine; moving at M1 is not.

## 3. Findings

Severity: **B** = blocking (must be fixed in the plan before approval), **M** = major (fix in plan or in the first sub-plan that touches it), **m** = minor.

### F-1 (B) M1 premise and sequencing — see §2
Replace "engine unchanged" with the `BoardPort` seam and a table mapping every Linear-coupled behaviour above to its native replacement or deletion. Keep v1/Linear working behind the seam until cut-over, or delete the "v1 stays shippable" claim. Specify the board key scheme: it must satisfy `KEY_RE` in `store.ts` (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`) and `api.ts:53` (`^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,9}$`) and the branch/worktree naming (`worktree.ts` `assertKey`/`branchFor`), or change all three deliberately.

### F-2 (B) Test retire/migrate matrix is missing; AC12 has a loophole
AC12 allows tests to be "intentionally migrated with the same assertions". Roughly 120+ of the 483 tests sit in `test/linear/*` (attribution 22, client 39, fake 25, ops-validate 12, provision 23, parity generated per factory) plus `mock-linear-server.ts`; `engine-authz` (5), the H1/H2/M3 parts of `engine-security`, and Linear steps of `setup-wizard`/`server` tests are about teammates and will retire. But `engine-security` also carries properties that **survive** and must not be lost with the harness rewrite: M1 (secret committed by the builder), M4 (redaction performance), M6 (protected file in a self-made commit, rename sources), M8 (git hook/`core.hooksPath`/alias planted), M9 (symlink-safe writes), H3 (credential in a bug title redacted before it reaches the sink — the board's child-item/title sink is the new Linear), the restart-rate limit (5/hour), BAR-363 answer-only tests. Required: a table `test file → retire (why, which property becomes n/a) | migrate (identical assertions) | replace`, approved by the Reviewer before the harness is touched, and the expected post-M1 test count stated so "479 pass" is not silently halved.

### F-3 (B) M3 has no runtime/data model and collides with single-run assumptions
The plan says "executor runs items in dependency order on the integration worktree (commit per item, verify per item and once at the end)" but the engine is one `Run` per key with one `worktree/branch/baseSha/commitSha/loop/loopBudget/bugs/sessions/agentRuns/next` (`types.ts:178-237`) and one job loop per key (`engine.ts:693-715`). Not addressed:
- Where per-item state lives (sub-run records? `items{}` inside the run? separate `Run`s sharing a worktree?), and how `schedule()`/`maxParallel` (counts *runs*, `engine.ts:654`) apply.
- **Hard caps that make any non-trivial plan unrunnable**: `maxAgentRunsPerIssue` default **10** (`config.ts:28`, clamp 2–60 at `:103`; enforced `stages.ts:234, 627`) — per item you spend at least build + verify = 2 runs, so ≥5 items cannot finish even before plan/review/fix; `runJob`'s `for (i < 60)` iteration cap (`engine.ts:694`). Budgets must scale with item count (and be one of the V7 "limits").
- Per-item verification diff base: `verify()` diffs against `run.baseSha` (`stages.ts:825`), the crash-window logic in `build()` is keyed on a single `commitSha` (`stages.ts:561-570`), baseline gates are recorded once per run. Per item you need a per-item base, per-item AC, and a rule for who owns a regression introduced by item 2 but detected at item 4.
- Approval/hold: `approvalGate` decides on one plan's `filesToChange` and complexity (`stages.ts:519-520`); `postBuildChecks` scopes to the plan's files (`stages.ts:716`). Define it on the **union** of item files, and per item at execution time.
- Failure semantics: item 2 of 4 fails after its loop budget; item 3 depends on it — skip, block, or re-plan? What is "ready" for a partially done graph? What does Retry mean?
- Crash recovery mid-graph and mid-item; the idempotent-effects story for per-item board writes.
Required: data model + state diagram + one named test per failure mode above (AC5 only tests graph validation and read-only concurrency).

### F-4 (B→user) "Parallel build deferred" is a silent downgrade of V4
"Run independent tasks in parallel where safe" is a stated requirement. Deferring *build* parallelism leaves only parallel *read-only* items, which is nearly vacuous: in a decomposed plan the independent items are overwhelmingly implementation items; read-only items (requirements/architecture/research) are rare and cheap. AC5's concurrency test therefore verifies a feature with almost no user value. The plan already collects the inputs for a safe version (`files`, `parallelGroup`, `dependsOn`): items whose declared file sets are disjoint can build in separate worktrees/branches and be merged into the integration branch sequentially, falling back to serial on any conflict or any undeclared-file touch (the diff-scope machinery in `worktree.ts` already detects the latter). That is a bounded, testable design; I do not think it must be in v2.0, but:
- relabel the V4 row **Partial**, not "Covered", and
- **ask the user** (it is a scope/schedule decision, §6 below), and
- keep the M3 data model compatible with per-item worktrees so deferral is not a rewrite.
Make the AC5 concurrency test deterministic (barrier/handshake in the fake agent), not wall-clock timing.

### F-5 (B) Codex: the provider interface drops the no-push guard lifecycle, and Codex isolation is unproven
- Today the builder's safety layers are **outside** the provider: `writeCursorGuard` before the build (`stages.ts:585-591`), `checkCursorGuard` after (`stages.ts:650-652`), run fields `cursorGuardSha`/`noPushEnvOnly`, `agentGitEnv` (`worktree.ts:926-931`), `snapshotGitMeta/revertGitMeta` (`stages.ts:630-646`), `postBuildChecks`. The M2 interface (`detect/authStatus/selfTest/capabilities/runReadOnly/runBuild`) has no `prepareBuild`/`verifyGuard` hook, so "extract Claude/Cursor behind the interface without behaviour change" either leaves Cursor-specific code in `stages.ts` (the Codex build path then has no guard) or loses it. Add the hook and make the git-env/meta-snapshot/diff-scope/secret-scan layers provider-agnostic and mandatory for every builder.
- **Builder never pushes is a v1 invariant.** Cursor's guarantee was proven by a live adversarial suite (`test/live/cursor-nopush.test.ts`, 8 attacks; `CURSOR_GUARD_DENY` doc comment in `worktree.ts` records that the env layer alone let 5 of 9 variants through — security review C3). For Codex there is no equivalent and, with the binary broken, none can be produced now. The plan's defaults list Codex as an **implementation fallback**, which means a Cursor limit would silently route a `--force`-class build to an unproven provider. Required: Codex may not hold the `implementation`/`debugging` roles (rejected by the AC4 pairing check) until `selfTest` includes a no-push canary and a live adversarial suite has passed against a working binary; fallback chains never promote a provider whose build isolation is unproven.
- Pin, don't default: explicit `--sandbox`, an explicit approval policy (the docs page only mentions `--approve-for-me`; do not rely on exec's implicit behaviour), and network access explicitly disabled in `workspace-write` (the docs are silent on it, so "network is off by default" is an unverified assumption). Note that in a linked worktree the git dir lives under the main repo's `.git/worktrees/`, **outside** a `workspace-write` writable root — decide and test what that does to the agent's own `git status`/`diff`.
- **No init predicate exists for Codex.** Claude is fail-closed via `checkClaudeInit` (`claude.ts:63-79`) and `isolationProbe` (`doctor.ts:135-204`); Cursor accepts weaker isolation, knowingly (`stages.ts:244`). Codex's JSONL has no tools/MCP/skills inventory, and `--ignore-user-config` is documented only for `config.toml`. This machine's `~/.codex` has `hooks.json`, `hooks/` and two MCP servers, so this is not hypothetical. Required: a canary-based Codex isolation probe (user hooks/MCP/global+ancestor `AGENTS.md` not honoured) in `doctor` and as a pre-flight, and treat Codex as the Cursor tier (documented weaker lock-down) for read-only roles until it passes. Also `--ignore-rules` **removes** execpolicy forbid rules — justify it or drop it.
- Read-only roles cannot deny credential-file reads (Claude can: `CLAUDE_DENIED_READS`, `claude.ts:13`). Keep the secret-redaction path mandatory on every Codex output and document the tier.
- Limit/auth classification must follow the M12 rule (classify from CLI-reported error events/stderr only, never from model prose; `cursor.ts:154-157`).
- Add `.codex/**` to the protected sets (`stages.ts:26` `PROTECTED`, `worktree.ts:700-702` `PROTECTED_DIR_SEGMENTS`) and `.codex` rules to `ANCESTOR_DIRS` (`worktree.ts:872`); add a Codex env allow-list in `env.ts` (`CODEX_API_KEY`, `CODEX_HOME`) — never pass `OPENAI_*` wholesale.
- Fix the provider-name leaks listed in §1 (`stages.ts:129,148`, `view.ts:45`, `engine.ts:769,839`).

### F-6 (B) Deep Research tool profile creates an exfiltration + injection channel
`WebSearch,WebFetch,Read,Grep,Glob` in one session means the model can read repository files and put their content in a search query or fetch URL, while reading attacker-controlled web pages that steer it. "Output is data, never executed" and "isolation predicate parameterised" do not address that. Required:
- Default research cwd is an empty scratch directory; repository knowledge comes only from a redacted, budgeted context pack. Repo-aware research (Read on the checkout) is an explicit per-task opt-in, shown in the UI, with `CLAUDE_DENIED_READS` kept.
- Verify that `--tools` + `--permission-mode dontAsk` actually permits `WebSearch/WebFetch` (an allow rule may be needed) and widen nothing beyond that; the predicate (`CLAUDE_EXPECTED_TOOLS`, `claude.ts:10`) becomes a per-profile fail-closed allow-list with a negative test per profile (the Plan profile must still reject a session that has web tools).
- AC7's "contains no fabricated sources" cannot be tested with a stub as written. Make it structural: every `sources[].url` must appear in an observed WebSearch/WebFetch `tool`/`tool_result` event of that session, otherwise the finding moves to `unverified`. Validate URL scheme (http/https only), render as text, open externally only through the https allow-list.
- "Convert to plan" turns web-derived text into a task for a `--force` builder. Treat the research report as `<untrusted>`, and force **plan approval** for any research-seeded item regardless of automation policy.
- Only providers with a verified tool lock-down may hold the `research` role (`capabilities.webResearchIsolated`); AC4's pairing check should enforce it.

### F-7 (M) §3 affected-file list is incomplete
Add (all exist today): `src/git/worktree.ts` (PROTECTED sets, ancestors, `agentGitEnv`, `CURSOR_GUARD_DENY`, `sh -c` install at `:446`, `/dev/null`), `src/git/gates.ts` (`sh -c` at `:131`), `src/server/open.ts` (`/usr/bin/open`, `SAFE_PATH`, Terminal/Cursor/Finder targets, `linear` target), `src/util.ts` (`shellQuote`), `src/cli.ts` (`openBrowser`, control socket client, `service`, `uninstall` removes the Linear key), `src/pipeline/view.ts` (agent labels, columns, `finished`), `src/pipeline/context.ts` (the `Provisioned` import), `src/demo.ts`, `dev/mock-api.mjs`, `docs/API.md`/`ARCHITECTURE.md` (listed generically). Also `src/store.ts` (schemaVersion on `run.json`; today unversioned) and `src/log.ts`/redaction callers (new sinks).
Also state the redaction sinks explicitly (CLAUDE.md invariant "every agent-derived string is redacted before Linear/logs/UI"): board child items/titles from plan v2, decision log, outcome digests, context summaries, research reports, diagnostics export, notifications. The board is the new "Linear"; H3 (title leaked a credential) must have a test on it.

### F-8 (B) Context engine: store location and trust boundary
- `<project>/.conductor/context/` is inside the user's repository. v1 never writes to the main checkout (it only creates worktrees); this breaks that, dirties `git status`, and `.conductor/` is git-ignored only in *this* repo's `.gitignore`. Worse, a hostile repo can **commit** a pre-populated `.conductor/context/` (`git add -f`); anything Conductor later reads back as "its own cache" is attacker text inside a privileged section of the next prompt. Store under `~/.conductor/projects/<id>/context/` (or the git common dir), keyed by repo identity, never read context from a worktree/checkout, and integrity-protect it.
- Summaries and outcome digests are LLM-written, persisted, and reused across runs — persistence is what turns a one-off injection into a standing one. Rule: LLM-derived context never goes verbatim into **builder** prompts; builder prompts get only deterministic scanner facts (commands, module map, test inventory). Packs for read-only stages are `fence()`d as untrusted (`prompts.ts:30`). Default LLM summarisation **off** (it spends the user's quota in the background); opt-in per project with a budget, and count it against agent-run limits.
- V5 "offline-capable": AC6 tests the context layer offline, but when the network drops mid-run today the engine counts provider errors toward `failCounts` and `needs_human` (`engine.ts:717-732`, `stages.ts:300-307`). Specify an `offline` pause (like usage-limit pause) that does not burn `agentRuns`, and test it.

### F-9 (M, gate M7) Windows/Linux and Electron: inventory and security design are not at implementable depth
Windows-specific blockers not in the plan:
- `sh -c` for repo gates and dependency installs (`gates.ts:131`, `worktree.ts:446`): `sh` is not on a stock Windows PATH, so every run would end `needs_human` in `ensureWorkspace`. Decide: require Git Bash, or run via `cmd /c`/PowerShell with per-OS quoting.
- Spawning `.cmd` shims: modern Node refuses `.cmd/.bat` without `shell: true`; with `shell: true`, argv such as `--json-schema <JSON>` (`claude.ts:55`) becomes a command-injection surface. Resolve shims to the underlying executable or pass data via files/stdin; never `shell:true` with agent/schema-derived argv.
- Child env allow-list (`env.ts:5-8`) has no `USERPROFILE/APPDATA/LOCALAPPDATA/SystemRoot/PATHEXT/TEMP/COMSPEC`; every child would break, and "just pass everything" would void the C1 allow-list guarantee. Needs a Windows base-key set.
- `agentGitEnv` uses `/usr/bin/false` and `/dev/null` (`worktree.ts:926-930`); `CURSOR_GUARD_DENY` lists macOS tools (`osascript`, `security`); `process.kill(-pid)` (`spawn.ts:43,53`, `exec.ts:151`). **The whole no-push/kill-tree/env-isolation envelope is unproven on Windows**; M7 must say so and ship a Windows `doctor` self-test that exercises the push guard.
- Control channel: unix socket + `chmod 0600` (`http.ts:104-134`) has no Windows equivalent; a named pipe's default DACL is not "owner only" — specify an explicit restrictive DACL or no control channel in desktop mode. Same for `FileStore` 0600 semantics.
Electron:
- **Do not expose `safeStorage` (or any secret) through the preload bridge.** The renderer shows agent-/web-derived text; main-only access, delivered to the sidecar over the IPC channel (not argv/env).
- **Desktop session injection needs no auth change:** the sidecar sends `{port, otp}` to main over IPC and main loads `/auth?otp=…` (single-use, 60 s, `auth.ts:52-68`). No new HTTP route, no static token, nothing on any command line. The plan lists `auth.ts` as Modify; the design above should be mandated and tested (second use of the OTP fails; no route mints sessions).
- BrowserWindow hardening checklist: `contextIsolation`, `sandbox`, `nodeIntegration:false`, `webviewTag:false`, `will-navigate`/`setWindowOpenHandler` locked to the exact loopback origin, `shell.openExternal` https-only, permission handler deny-all, dedicated session partition (cookie is not port-isolated — security review M2), keep the server CSP/CORP headers.
- Prefer Electron's `utilityProcess` over `ELECTRON_RUN_AS_NODE`: the latter requires leaving the RunAsNode fuse on, which makes the app binary a generic Node runner for any local process (relevant even unsigned). If `ELECTRON_RUN_AS_NODE` stays, record why. (The allow-listed child env already drops it for grandchildren — good.)
- `safeStorage` on Linux: §3 says "refuses silent downgrade", §6 says "require explicit consent or fall back". Pick one. Also fix the contradiction "Conductor stores no provider credentials at all in v2; only optional API keys": once Linear is gone, the secret inventory is provider API keys entered in a GUI app that no longer inherits the shell environment (`env.ts` currently passes `CURSOR_API_KEY` etc. only from `process.env`). Write the inventory, storage, injection (one child's env, never argv) and redaction list.
- Linux `.deb`: Electron's sandbox helper/AppArmor user-namespace restrictions on recent Ubuntu can stop the app launching; plan a container smoke test (Xvfb) and report launch as unverified if not run.
I am **not** asking for all of this to be designed now. I am asking that M7 be held behind its own reviewed sub-plan (see F-12) and that the list above be carried into it.

### F-10 (B) Migration, importer and rollback are not designed
- Add the importer to §3/§4/§5/ACs (currently only a sentence in §6). Define semantics for the real data: `BAR-363` (needs_human, Linear `issueId`/`url`, no pending effects). Terminal runs → read-only history items; in-flight runs → items with pending Linear effects dropped, Linear URL kept as an external link; keys preserved subject to F-1.
- Introduce versioning everywhere state is written: `config.json`, `state.json`, `run.json`/artifacts, board. Preserve unknown keys on save (fix `normalizeConfig`'s rebuild-from-known-keys), refuse newer-than-known versions for every file, take a timestamped backup of `~/.conductor/{config.json,state.json,runs/}` before the **first** v2 write. The real config is v1; test v1→v2→v3.
- Development safety: a live instance (pid 11390, :4317) runs on the real `~/.conductor`. All milestone work and tests must use a throwaway `CONDUCTOR_HOME` (the harness already does); the real data is migrated only by an explicit, user-triggered cut-over step after backup. Tag the last v1 commit before M1 so rollback = `git checkout <tag>` + restore backup, and **test that rollback** once (v1 code opens a restored v1 snapshot).

### F-11 (M) Acceptance criteria that over-claim or cannot be run
- **AC8** "Sensitive operations never auto-run under any policy": the builder is `--force` (Cursor) or `workspace-write` (Codex); Conductor cannot intercept its shell calls. What can be enforced: plan-level static rules (protected paths, secret files, deploy/destructive-looking planned commands), post-hoc diff-scope and secret scan, and provider-native deny lists. Rewrite the AC to those, with tests for each, and say what is *not* enforceable. Also state that `full-auto` does not remove the v1 forced holds (complexity `L`, protected files: `stages.ts:520`) and which policy is the default for new projects.
- **AC3** `limited` classification: say how it is detected without spending quota (Claude has `rate_limit_event`; Cursor/Codex do not) or drop it from selfTest.
- **AC1** add a static import-graph test (no `src/**` import of `linear/` or `legacy/`) so "Linear is not imported by the runtime" is mechanical.
- **AC9** (wizard) and the M6 board/hierarchy/research views: there is no DOM test tooling and dev-dependencies are limited by `CLAUDE.md`. State the verification: API-level tests plus a scripted Browser-pane check with screenshots saved under `.techteam/runs/evidence/`, desktop and mobile, console clean; or explicitly request one more dev-dependency.
- **AC10** and the V1 matrix row: `.exe` has no verification method on this machine, so the status is **Gap (build-only at best)**, not "Covered (with stated limits)". Note Docker is present: an `electronuserland/builder:wine`-style container could *build* the NSIS installer locally (with the user's permission for the image pull); it still would not prove it installs or runs. A `.deb` can additionally be installed and launched headlessly in a container.
- The CI workflow is written but never executed (no push): report it as unvalidated YAML.
- **AC12**: see F-2.

### F-12 (B, process) Milestone sizing and review gates
- M1 (store + seam + wizard + importer + harness rewrite), M3, M4, M6 and M7 are each far beyond what can be code-reviewed as one diff, and the plan defers Reviewer/Security re-review to "after plan approval, of everything" at the end (§4 last item). For a multi-week build, that is the failure mode the TechTeam gate exists to prevent. Required: Reviewer **and** Security checkpoint at every milestone boundary, and for M2 (providers/Codex), M5 (research) and M7 (Electron/Windows) a Security sign-off on the design *before* the first source edit of that milestone.
- Split: M1a board store + migrations (no engine change) → M1b `BoardPort` seam with Linear still behind it → M1c cut-over + importer + wizard → M1d retire Linear. M3 = schema/validator/graph, then executor. M7 = build-to-`dist` + cross-platform strategy layer, then Electron shell, then packaging/CI.
- Rolling-wave approval: this plan is approved as *direction* for M3–M7 only; each of those gets its own 7-section sub-plan reviewed before its first source edit. That is consistent with CLAUDE.md ("plan → distinct Reviewer approval → implement").
- Create the v2 run checkpoint (`.techteam/templates/run-checkpoint.md`) — `active-run.md` still describes `conductor-v1`.

### F-13 (m) Smaller points
- Quick Ask/Research bypass the engine (`src/modes/*`), so they also bypass everything `callReadOnly` provides: schema validation + one corrective re-ask, limit pause/back-off, abort, redaction, event log, quota recording (`stages.ts:220-312`). Extract that into a shared, run-independent caller instead of re-implementing it. Keep the v1 `deliverable:'answer'` path (`stages.ts:440-453, 670-686`) as the safety net for a question filed as Engineering Work.
- Quick Ask/Research run in the user's real checkout (no worktree): state the cwd, the Cursor `--trust` consequence (repo `.cursor/` rules load), and that Claude's read deny-list applies.
- `normalizeConfig`/`Settings` plumbing for roles must keep clamping and ignore unknown keys (`api.ts` `PUT /api/settings` is currently safe because only whitelisted fields are applied — keep that for roles/policy; security review A19).
- New endpoints (projects, work items, modes, roles, context, integrations, onboarding): add per-endpoint input limits, key/regex validation (`safeDecode`, `KEY_RE`), and the CSRF/Host/OTP negative tests the plan already lists; the `/api/setup/repo` path check (`api.ts:306` `startsWith('/')`) is POSIX-only.
- Capability detection by parsing `codex exec --help` is fragile; prefer a minimum version plus feature probes in `selfTest`, and record the fixtures once a working binary exists.
- `docs/API.md` and `ARCHITECTURE.md` must change with M1; the README still says Linear throughout.

## 4. Requirement coverage re-check (V1–V10)

| Req | Plan status | My status | Why |
| --- | --- | --- | --- |
| V1 Win `.exe` + Linux `.deb` | Covered (limits) | **Partial / Gap for `.exe`** | `.deb` buildable + inspectable with permission; `.exe` has no verification here; Windows safety envelope unproven (F-9) |
| V2 detect/install/auth/test per CLI | Covered | **Partial** | "install" is guidance only; Codex isolation unproven (F-5); say it is by design and ask the user (§6) |
| V2 per-responsibility assignment, fallback, complexity routing | Covered | Covered **if** F-5 gating (no unproven build provider via fallback) is added | AC4 pairing check is the right place |
| V3 internal board replaces Linear | Covered | **Not yet** | M1 as designed is not viable (F-1); importer missing (F-10) |
| V4 plan-before-execution, decomposition, deps | Covered | **Not yet** | no runtime model (F-3) |
| V4 parallel where safe | Covered (build deferred) | **Partial** | F-4 |
| V4 ask only if decision-material | Covered | Covered | structure-validated; judgement is the model's — fine, say so |
| V5 persistent, incremental, offline, staleness | Covered | **Partial** | store location/trust (F-8); engine offline behaviour unspecified |
| V6 three modes | Covered | **Not yet** | research safety (F-6); ask/research bypass the shared agent caller (F-13) |
| V7 automation policies, limits, sensitive-op rules | Covered | **Partial** | AC8 over-claims (F-11); limits scale (F-3) |
| V8 onboarding with sample task | Covered | Covered | UI verification method needed (F-11) |
| V9 data, secrets, recoverable state, migrations | Covered | **Partial** | migration framework absent, real data is v1 (F-10); secret inventory contradictory (F-9) |
| V9 validate each CLI's capabilities | Covered | Covered | provided Codex limits are stated |
| V10 principles | Covered | Covered | one source of truth is violated by the adapter design until F-1 is fixed |

Caveat: I could only check coverage against the plan's V1–V10 shorthand and the brief I was given; the verbatim requirement text is not in the repo. Required: commit the original 10 sections verbatim (e.g. `.techteam/plans/workspace-v2-requirements.md`) so "100% mapped" is checkable.

## 5. Safety property check (v1 invariants the plan must preserve)

| Invariant | Preserved by the plan? |
| --- | --- |
| Claude stages read-only + fail-closed init predicate | Only if the per-profile predicate (F-6) is fail-closed and the Plan/Review/Verify profile keeps rejecting web tools |
| Builder never pushes (Cursor guard + git env + meta restore + secret scan + scope hold) | **At risk**: guard lifecycle not in the provider interface; Codex build unproven; Windows unproven (F-5, F-9) |
| Redaction before every sink | **At risk**: new sinks not enumerated (F-7) |
| Allow-listed child env | At risk on Windows (F-9); Codex env missing (F-5) |
| Loopback + cookie + CSRF + Host checks | Preservable; desktop injection must reuse OTP over IPC (F-9) |
| No PR/merge/push by Conductor | Unchanged |
| Write-ahead idempotent effects, usage-limit pause | Preserved by M1b if effects stay; offline pause missing (F-8) |
| Workspace isolation: Conductor never writes into the user's main checkout | **Broken** by `<project>/.conductor/context/` (F-8) |

## 6. Decisions the plan should put to the user (it should decide everything else itself)

True business/permission decisions — raise them, with a recommendation:
1. **Parallel build in v2.0, or defer?** (F-4) Recommendation: defer, but design for it and label V4 Partial.
2. **Should Conductor ever run CLI installers for the user** (npm/curl-pipe-shell), or only show guidance? That is the "download and execute from an external source" class of action and needs per-action consent by design. Recommendation: guidance + copyable command, no auto-install.
3. **Windows release bar.** Ship an unverified, unsigned `.exe` (SmartScreen warnings, no auto-update) or hold the Windows claim until the user has run a checklist on a real Windows host? Recommendation: ship as "preview" with the `doctor` push-guard self-test mandatory.
4. **Downloads** (Electron, electron-builder, fpm/NSIS tooling, Docker images, optionally repairing the broken Codex install): the plan correctly gates these; ask at the start of M7 (and for Codex repair at M2), not now.
5. **Automation default.** Recommendation: keep v1 behaviour (auto, with forced holds for `L` and protected files) as the default, and never let `full-auto` remove those holds. Confirm.
6. **Research privacy default** (no repository access unless opted in per task) and **LLM context summaries default off**. Recommendation: both as stated; confirm.
7. **Existing Linear data**: confirm the importer keeps history only and that nothing is written back to Linear (the plan's default is no Linear import/sync).

The plan's own "unresolved" list (default Codex role, optional Linear import) is not a business decision; decide it (Codex: not an implementer until F-5 is satisfied).

## 7. Coverage confirmation

- Requirement mapping is complete: **no** (see §4; plus verbatim requirement text missing)
- Gaps that block approval: F-1, F-2, F-3, F-4 (relabel + user decision), F-5, F-6, F-8, F-10, F-12; F-9 and the remaining majors may be carried into sub-plans if F-12 is adopted.

## 8. What I would approve, and when

I am **not** approving this plan. I would approve, as a revised plan, on these conditions:
- **M1a–M1b and M2** fully specified and approvable once items 1, 2, 5, 8 (partly), 9, 10, 12 below are done. They are the foundation and the highest regression risk.
- **M3–M7** approved as direction only, each behind its own reviewed sub-plan and a Security sign-off where listed in F-12.
- Nothing may touch the real `~/.conductor` or the running instance before the user triggers a backed-up cut-over.

## Required changes (blocking) — numbered

1. **Rewrite M1** around a `BoardPort` seam (not "LinearPort over a board, engine unchanged"): include the behaviour mapping table from §2, keep Linear working behind the seam until cut-over (or drop "v1 stays shippable"), specify the key scheme against `store.ts`/`api.ts:53`/branch naming, and do not move `src/linear/**` until nothing imports it. (F-1)
2. **Add the test retire/migrate matrix** (file → retire/migrate/replace, property that survives, expected post-M1 count) and remove the AC12 "intentionally migrated" loophole. (F-2)
3. **Specify the M3 runtime model**: per-item state, worktree/branch/diff-base per item, scaled `maxAgentRunsPerIssue` and the `runJob` 60-iteration cap, approval/protected-path hold on the union of item files, failure and crash-recovery semantics, one test per failure mode. (F-3)
4. **Resolve V4 parallel**: relabel Partial, ask the user, keep the data model per-item-worktree-ready, make the concurrency test deterministic. (F-4)
5. **Fix the provider interface and Codex gating**: add `prepareBuild/verifyGuard`, make git-env/meta-snapshot/scope/secret layers provider-agnostic; Codex may not hold implementation/debugging (nor be a build fallback) until a no-push canary and live adversarial suite pass; pin sandbox/approval/network flags explicitly; add a Codex isolation canary (hooks/MCP/AGENTS.md) and treat Codex as the weaker-isolation tier meanwhile; justify or drop `--ignore-rules`; add `.codex/**` to protected/ancestor lists and a Codex env allow-list; fix provider-name leaks. (F-5)
6. **Harden the research profile**: empty scratch cwd by default, per-profile fail-closed predicate with negative tests, citations validated against observed tool events, https-only URLs, research-seeded work forces plan approval, only lock-down-verified providers may hold `research`. (F-6)
7. **Move the context store out of the repository** (`~/.conductor/projects/<id>/…`), never read context from checkouts/worktrees, keep LLM-derived context out of builder prompts, default LLM summaries off with a budget, and specify the offline pause behaviour of the engine. (F-8)
8. **Design migration and rollback**: versioned `config/state/run.json/board`, preserve unknown keys, refuse newer, timestamped backup before first write, start from the real v1 config, importer in §3/§4/§5/AC with BAR-363 semantics, isolated `CONDUCTOR_HOME` for all work, tag before M1, tested rollback. (F-10)
9. **Correct and complete §1/§3**: fix the inaccurate claims in §1 (table above), add the missing files (F-7) and enumerate redaction sinks including the board. (F-7)
10. **Correct AC8, AC3, AC1, AC9, AC10 and the V1/V2/V4/V5 matrix statuses** as in F-11; commit the verbatim 10-section requirement and re-map against it. (F-11, §4)
11. **Add per-milestone Reviewer + Security checkpoints, split M1/M3/M7, adopt rolling-wave sub-plans for M3–M7**, and create the v2 run checkpoint. (F-12)
12. **Carry the F-9 list into the M7 sub-plan as binding requirements** (Windows `sh`/shim/env/guard issues, named-pipe DACL, Electron main-only secrets, OTP-over-IPC session injection, window hardening, `utilityProcess` vs `ELECTRON_RUN_AS_NODE`, safeStorage policy, secret inventory), and declare Windows support "preview/unverified" until run on a real host. (F-9)

## Suggestions (non-blocking)

1. Prefer Electron `utilityProcess` over `ELECTRON_RUN_AS_NODE` (F-9).
2. Build the NSIS `.exe` locally in a Wine container with the user's permission; smoke-test the `.deb` in a container under Xvfb. Report both honestly.
3. Extract `callReadOnly` into a shared agent caller used by stages, Ask and Research (F-13).
4. Replace `--help` parsing for Codex capability detection with a minimum version + feature probes in `selfTest`; commit real fixtures when a working binary exists.
5. Keep the v1 `deliverable:'answer'` path as the safety net for questions filed as Engineering Work.
6. Add a static test that no `src/**` file imports `linear/` or `legacy/` after cut-over.
7. State the cwd, `--trust` effect and read deny-list for Quick Ask/Research in the user's checkout.
8. Keep the whitelist-only `PUT /api/settings` pattern for roles/policy and add per-endpoint limits for new routes.
9. Consider whether a plain JSON store with a journal needs compaction rules before the board grows; `node:sqlite` is available in Node 22 but experimental — fine to defer, but write the decision down.
10. Update `README.md`, `docs/API.md`, `docs/ARCHITECTURE.md` in the same milestone as the behaviour change, not at the end.

## Record

- Linear comment or artifact path: this file
- Next action: revise the plan (items 1–12), then re-submit for Reviewer approval; no source edits until then

Decision: Changes requested


---

# Round 2 — re-review of rev 2 (master + M1 + M2 + requirement + checkpoint)

- Reviewed at: 2026-10-20 (after commit `b67e015`; clone `techteam-conductor-v2` is at `e7e7707`, `src/` byte-identical to v1 — no v2 source has been edited)
- Reviewed by: Reviewer (independent; did not edit any plan or source). Security design sign-off for M2 is **not** given here — it is a separate gate.
- Documents: `workspace-v2.md` (master, direction for M3–M7), `workspace-v2-m1.md` (M1a–M1d), `workspace-v2-m2.md`, `workspace-v2-requirements.md`, `.techteam/runs/active-run.md`.
- Method: I did not anchor on the Lead's summary. I re-read the code paths each plan relies on, ran every Linear-coupled and engine test file individually to get real counts (all pass), checked tag/backup/clone state on disk, re-fetched the Codex docs pages (non-interactive mode and CI/CD auth), and checked the verbatim requirement bullet by bullet.

## R2.1 Round-1 blockers — status

| # | Round-1 item | Status | Note |
| --- | --- | --- | --- |
| 1 | M1 premise (no "LinearPort over a board") | **Closed in concept** | Native `BoardPort`, no FakeLinear reuse, Linear deleted last. New problems are in M1b's spec (R2.4). |
| 2 | Test retire/migrate matrix | **Open — numbers wrong** | Structure is right and the engine-file counts are exact; the Linear counts are not (R2.3 item 1). |
| 3 | M3 runtime model | **Closed (as direction)** | Binding list (a)–(i) in the master covers every failure mode I raised. Needs its own sub-plan. |
| 4 | V4 parallel | **Closed** | Labelled Partial, D1, per-item-worktree-ready model, deterministic test. |
| 5 | Provider interface / Codex gating | **Mostly closed** | Guard lifecycle is now in the contract; pinned flags; canary; gating; `.codex` protected. Open: Codex auth design, canary criteria, `-c` verification (R2.5). |
| 6 | Research hardening | **Closed (as binding M5 direction)** | Complete: scratch cwd, per-profile predicate, structural citations, forced approval, `webResearchIsolated`. |
| 7 | Context store/trust/offline | **Closed (as direction)** | Location, builder-prompt rule, summaries off, offline pause all present. |
| 8 | Migration/rollback/importer | **Mostly closed** | Framework, backups, newer-refusal, importer, rehearsal, tag+backup (verified on disk). Open: cut-over safety (R2.4 item 4). |
| 9 | §1/§3 accuracy | **Closed** | Spot-checked; two small errors in M1 (R2.2). |
| 10 | ACs / matrix labels / verbatim requirement | **Mostly closed** | Verbatim file committed. Three rows still say Covered when they are not (R2.6). |
| 11 | Milestone gates / splits / rolling wave | **Closed** | |
| 12 | M7 binding list | **Closed** | Covers every Windows/Electron item from F-9. Two gaps vs the requirement (R2.6 M-5). |

## R2.2 Factual claims — verified / wrong / unverifiable

**Verified true**
- Tag `v1.0.0-rc2` = `56c7f2d`. `~/.conductor-backups/20261020-134302/{config.json,state.json,runs}` exists and is byte-identical to the live files today (`cmp` / `diff -rq`). The live instance (pid 11390, :4317) is still running pre-fix code, as the checkpoint says.
- Every `file:line` in the M1 "Current State" and the M1 mapping-table rows 1–16 matches the code (`engine.ts:256-378, 406-475, 815-833`; `stages.ts:79-94, 395, 936-963`; `effects.ts:157-192`; `api.ts:53`; `store.ts` `KEY_RE`).
- Key-scheme constraints: `store.ts` `KEY_RE`, `api.ts:53`, `worktree.ts` `assertKey` (same class + no `..`, no trailing `.`/`.lock`), `branchFor` = `conductor/<key lower-cased>`, worktree path `<root>/<repo>/<KEY>`. A `PROJECT-n` key with `[A-Z]{2,6}` satisfies all of them.
- Engine-test counts in the M1 matrix are exact: authz 5, happy 1, human 7, limit 3, loop 3, plan 4, regress 18, safety 12, security 13, core 14, server 18, setup-wizard 3. Surviving-test assignments (e.g. `engine-security` 9 migrate / 3 retire / 1 adapt = 13) add up.
- M2: `AgentName` is used where the plan lists; the build envelope really is in `stages.build` (`stages.ts:585-710`) and `Run.cursorGuardSha/noPushEnvOnly` exist; `commitAll`, `postBuildChecks`, `snapshotGitMeta/revertGitMeta`, `agentGitEnv` are provider-agnostic as claimed.
- Codex docs (re-fetched): prompt from stdin and `codex exec -` documented; `CODEX_API_KEY` documented for `codex exec`; JSONL event kinds `thread.started`, `turn.started/completed/failed`, `item.*`, `error` and the item types (agent message, reasoning, command execution, file change, MCP tool call, web search, plan update) documented; `CODEX_HOME` is documented only as the location of `config.toml`/`auth.json`.

**Wrong**
- **Linear test counts (M1 §1, §2 "Expected counts").** Real per-file counts: `attribution` 22, `client` 39, `fake` 25, `ops-validate` **44** (plan: 12), `parity` **52** (generated per factory), `provision` 23 = **205** in `test/linear/` (plan: "≈121"). Retired in total ≈ **214**, replaced 5 (wizard 3, safety 2). Survivors = 483 − 214 − 5 = **264** (260 pass + 4 skipped). With the plan's ≈110 new tests the post-M1d total is ≈ **374**, not "≥ 455 passing". (My round-1 "≈120+" was a static `test(` grep that missed the generated tests; the Lead copied it. The target is arithmetically unreachable and, as written, would make the AC12 gate meaningless.) Also "71 `h.linear` refs in 12 files" is 69 refs in 9 files — immaterial.
- **Keychain entry name (M1c).** "`conductor-linear`" does not exist: service is `techteam-conductor`, account `linear-api-key` (`secrets.ts:13,120`).
- **Backup location is stated three different ways**: `~/.conductor-backups/<ts>/` (master, exists), `<home>/backups/<ts>/` (M1a), `~/.conductor/backups/migrate-<ts>/` (M1c). `uninstall --purge` deletes the home (`cli.ts:243`), so backups must live outside it.
- **"Linear tests stay green/unchanged through M1c"** is not achievable as specified: `test/linear/attribution.test.ts:7`, `parity.test.ts:13` and `helpers/mock-linear-server.ts:21` import Linear types from `src/types.ts`, which M1b moves to `src/linear/types.ts`.
- **M2 "tests pass unchanged"** is true for commit 1 only (see R2.5 item 3).

**Unverifiable here (stated so nobody mistakes them for checked)**
- Live Cursor/Claude suites "3/3 pass today" (spends quota; I did not re-run).
- Every Codex `-c` key and value: `approval_policy`, `sandbox_workspace_write.network_access`. The docs pages I fetched do not mention `-c/--config` at all, nor approval flags other than `--approve-for-me`. Also `--sandbox read-only` as an explicit value appears only implicitly (the page names `workspace-write`/`danger-full-access` and says read-only is the default).
- Codex behaviour in `workspace-write`, limit/auth message text, `codex login status`. All correctly marked unverified by the plan.
- Windows/Linux packaging behaviour.

## R2.3 Master plan (direction for M3–M7) — review

I checked coverage against the **verbatim** requirement, bullet by bullet. Sections 1, 2 (except below), 4, 5, 9 (except below), 10 are mapped to a planned change and a verification method; the M3–M7 binding lists are specific enough to review sub-plans against. The decisions D1–D8 are sensible defaults and are not blocking the user. What does not hold:

- **M-1 (V2, the user's own example).** The requirement says "a user might choose Codex for implementation". The plan forbids Codex implementation until a Codex port of the adversarial no-push suite passes, but **no milestone builds that suite or designs Codex `workspace-write`**: M2 says "not implemented in M2 beyond the record format + gating", M3–M7 never mention it. So the row "per-responsibility assignment … Covered" is false for the headline example; Codex-as-implementer is unreachable in v2.0. Relabel Partial and either schedule it (e.g. M2b: workspace-write design, behavioural network/push canary, adversarial suite, verification record) or add it to the decisions put to the user (D9).
- **M-2 (V6 Mode A).** The requirement: Quick Ask is for "small questions, explanations, **focused changes, and simple fixes**" and should "respond **or execute**". M5 defines Quick Ask as one read-only call with no worktree, escalating to Engineering Work. Focused changes/simple fixes therefore always go through the full pipeline. Either specify an S-complexity fast path (one-item graph, still in a worktree, still verified, no plan review, auto-approved only when no protected-path/`L` hold applies) or label V6 Partial.
- **M-3 (V3 "decisions and milestones").** The coverage row says "milestones/decisions as board entities"; the M1 board model has `Decision` but no milestone. Add the entity (or a `kind` on `Decision`) in M1a.
- **M-4 (consistency).** D8 says Codex is a "research-capable reviewer/fallback for read-only roles"; M2 §2 says "Codex appears in no default chain". Pick one (M2's is the safer reading).
- **M-5 (V9).** (a) "Clear execution logs and **diagnostic information**": the diagnostics export from rev 1 disappeared from rev 2 (only listed as a redaction sink). (b) "**Background task execution**": the plan has no answer for what happens when the desktop window closes (tray + sidecar keeps running, or work stops; native service is out of scope). Add both to the M7 binding list.
- **M-6 (V7).** "Configurable limits for … **resource usage**": M6 lists time/retries/parallelism only. Add an agent-run/token budget per project/graph.
- **M-7 (V8 step 5).** "Open **or create** a project": `inspectRepo` rejects a repo with no commits (security review A14), so "create" needs `git init` + initial commit (with an identity) — specify in M6.
- **M-8 (V5).** The eight knowledge items must be mapped one by one in the M4 sub-plan; "previously completed tasks and outcomes", "objectives and outstanding work", "known issues/unresolved decisions" can be deterministic board-derived facts, but anything containing agent-authored text is untrusted and stays out of builder prompts.
- **M-9 (process).** The final landing of the v2 clone into the original repo (local fast-forward/merge after the user stops the live instance) is not described; no PR/push is implied, but say so.
- Minor: AC12 refers to "the approved M1 test matrix" — keep, but its numbers are wrong (R2.2).

## R2.4 M1 (M1a–M1d) — review

### What is good
Native model with its own persistence; versioning framework with refuse-newer, backup-before-first-write and unknown-key preservation; every Linear coupling has a row; the retire/migrate/replace matrix is the right artefact; Linear deleted last behind an import-graph test; importer is history-only (D7); rollback rehearsal; isolated clone. The journal-plus-snapshot design is a sound fit at this scale (single process, tens of thousands of items at most).

### Blocking items for M1b–M1d

1. **Fix the counts and restate the AC12 gate** (R2.2): `test/linear/` = 205, retired ≈ 214, replaced 5, survivors 264, new ≈ 110 ⇒ ≈ 374 total. The gate becomes "all 260 surviving tests pass unchanged where the matrix says *identical* **and** the listed new tests exist", not a headline number that cannot be met.
2. **`integrity()` semantics contradict the migrated test.** M1 §3 says the board `integrity()` treats user edits as "legitimate and picked up", but the matrix migrates `engine-human.test.ts:108` "description edited by the viewer mid-run halts at the next stage boundary" with *identical* assertions — which require `needs_human` (`/description changed/`) and a rev-2 re-plan on Todo (lines 119-125). The v1 behaviour is the right one: the approved plan and acceptance criteria were written against the old text, and the builder reads `run.description` (a snapshot). Keep the description hash on the item/run, halt at the stage boundary, re-plan on restart. Fix the sentence in §3.
3. **Specify the column/status transition table and the board↔run-store consistency protocol; the current text is not implementable as a spec.**
   - *Human moves.* In v1 the only thing distinguishing a human move from Conductor's own write is that the two use disjoint Linear **state types** (Conductor never writes `unstarted`/`backlog`); `expected.stateId` is used only as a boolean "Conductor has written at least once" (`engine.ts:432`). Row 5 says the same matrix is "keyed on board column with `run.expected.column` to ignore Conductor's own writes" — that is a new comparison design and the table of columns is larger (`todo, backlog, in_progress, needs_you, review, done, canceled`; plus run statuses `paused`, `failed`, `parked`, `needs_human` with no column mapping in row 2). Write the full matrix `run.status × column-now × human-move → effect`, and enforce at the API which columns a human may set (I suggest only `backlog`, `todo`, `done`, `canceled`; Conductor owns `in_progress/needs_you/review`). With that rule `expected.column` is not needed to detect intent. Also resolve the name clash with the existing `BoardColumn` dashboard type (`types.ts:29`).
   - *Replacing write-ahead effects.* v1's `pending` effect records (`effects.ts:51-56, 115-124`) are the **only** thing that re-drives a half-applied projection when no stage re-runs; `recover()` only touches `running` runs (`engine.ts:216-225`). Row 8 and §6 ("startup reconcile heals drift … item without run in `in_progress`; run without item") cover gross existence drift but not: run.json says `ready`/`needs_human`, crash before the board column/comment write (card stuck "in progress", the "ready" summary or the needs-you explanation never posted); board column written, `run.expected.column` not (misread as a human move); bug child created, `BugRec` not updated (covered by idemKey only if the stage re-runs — `decide()` does not re-run after `recover()` unless the run was `running`). Specify the write order (record intent in run store first, board second, both synchronous so no `await` sits between), a **level-triggered projection** (desired column and required narration comments computed from run state, applied at start and every tick, idempotent), or keep a minimal pending record. Add a crash-injection test per window (the plan already has kill -9 machinery).
   - Claim rules: v1 skipped children of **any** Conductor run (`engine.ts:319`, `store.list()` incl. finished); the plan says "child of an *active* run". Use `parentId === null` for claimable. Approve: "stale approve for an old rev is rejected" needs `rev` in the API request — add to the contract and `docs/API.md`.
4. **M1c cut-over safety.**
   - In-place swap by successive renames (`runs`→`runs.v1-<ts>`, config rewrite) is not atomic; error injection per step (the plan's test) does not model a crash between renames. Use an intent/journal file with a defined recovery rule, and crash-test between each rename.
   - **The v1 code cannot protect migrated data.** `normalizeConfig` treats any `version >= 2` as current and rebuilds from known keys (`config.ts:57-63`) and `RunStore` has no version, so the old tree (still present, still the live tool) opened on a migrated `~/.conductor` silently drops the moved `linear` block and misreads renamed `run.json` fields, then saves over it. "Refuse newer" only protects v2 code. **Recommended:** migrate **side-by-side** — copy into a separate v2 home, leave `~/.conductor` byte-identical; rollback is then "do nothing", BAR-363 stays openable in v1, the swap-atomicity problem disappears. If in-place is kept, state how v1 code is made to fail closed (e.g. leave a tombstone it cannot parse) and test it with the tagged code.
   - Single backup location outside the home; correct the Keychain name (R2.2).
   - Importer: carry `assignedPickup` as an *untrusted/unattributed* flag (those descriptions were never attribution-checked) so a re-run forces plan approval; validate imported keys against `KEY_RE`; define the project key when the Linear prefix is not `[A-Z]{2,6}`.

### Conditions on M1a (approved to start; checked at M1a code review)
- **C1 inert migrations.** M1a says "no engine change", but registering config v3 (`linear`→`legacy.linear`) or run.json v2 (`issueId→itemId`, etc.) would break the unported engine and the 483 tests at the M1a checkpoint. In M1a ship the framework and **version stamps only**; register the shape-changing migrations in M1b (run.json) / M1c (config) with the code that consumes them.
- **C2 persistence invariants written down and tested:** creating an item is **one** journal line that includes the project's `nextSeq` bump, or `nextSeq` is re-derived from max key on load (two lines can tear between them and re-issue a key); policy for a corrupt *middle* line (refuse to start and report, never skip silently); durability statement — `atomicWriteFile` does not fsync (`util.ts:50-55`), so the guarantee is process-crash-safe, not power-loss-safe, unless fsync on journal + snapshot + directory is added; files 0600, dirs 0700 like `RunStore`.
- **C3 read-only open mode** for `doctor` (`createRuntime({ephemeral:true})`, `cli.ts:180`), migrate dry-run and diagnostics; "a second process refuses" must not break `conductor doctor` while the app runs.
- **C4 server-side authorship:** `author`, `createdBy`, `kind`, `column` are never taken from request bodies (API ignores/validates them) — otherwise `author:'conductor'` forged by the client breaks the "user intent vs Conductor output" split that replaces `isConductorComment`.
- **C5 `Milestone` entity** (M-3).

### Minor (fix in text, no re-review needed)
- Types shim: keep `export type * from './linear/types.ts'` in `types.ts` until M1d, or admit those three test files are edited in M1b.
- `test/fixtures/real-v1/`: generate synthetic fixtures with the real *shape*; the real `run.json`/artifacts carry a client workspace slug (`bargainn-services` in `url`) and local repo paths.
- `neutralise()` (images/@mentions) is a Linear-specific protection; harmless on a textContent-rendered board, keep or drop deliberately.
- `external.url` shown in the UI must be validated `https://linear.app/…` before becoming a link (the old `open.ts` check goes away).
- Repo delete guard (`api.ts` `in_use`) must also consider board projects referencing the repo.

## R2.5 M2 — review

### What is good
Provider contract with the build guard lifecycle (`build.prepare/run/verifyGuard`); provider-agnostic envelope extracted first, "no behaviour change" with an argv snapshot and live Cursor suites as the exit check; capability flags with `buildIsolationVerified` / `webResearchIsolated` driving routing; fallback never promotes an unproven builder; Codex read-only only, `workspace-write` absent, `danger-full-access` never constructible; prompt on stdin; classification from CLI-reported events only; `.codex` protected; env allow-list without `OPENAI_*`; `broken-install` fixture for this machine's case. The ordering (extract → roles/routing → Codex → canary) is the right one, and M2 correctly waits for M1.

### Blocking items

1. **Codex auth design contradicts the vendor's guidance and can log the user out of their own Codex.** The plan symlinks the user's `~/.codex/auth.json` into a private `CODEX_HOME`. The official CI/CD auth page says Codex "writes the new tokens … back to `auth.json`" on refresh and "Do not share the same file across concurrent jobs or multiple machines. Use one `auth.json` per runner". Refresh is a write-back (very likely temp-file + rename, which would **replace the symlink with a divergent regular file**, leaving the user's real file with a rotated-out token). Conductor runs concurrently with the user's interactive Codex. Replace with: a one-time login **into the private home** (wizard step, user-run `codex login` with `CODEX_HOME` set) or `CODEX_API_KEY`; never link/copy the user's credentials. The private `config.toml` must also pin `cli_auth_credentials_store = "file"` (the docs say keyring storage is possible; on keyring there is no `auth.json` to use).
2. **Config v4 breaks the Settings API and the dashboard between M2 and M6.** `Settings.stages` and `Settings.onClaudeLimit` (`types.ts:287-297`) are produced by `toSettings`, accepted by `PUT /api/settings` (`applySettings`, `config.ts:156-191`) and consumed by `ui/app.js:318, 570-584, 1814-1819`; health is keyed to two names (`app.js:310-311, 1889, 1992-1996`) and `AGENT_LABEL[…]` would render a Codex session as `undefined` (`app.js:38`). The plan says "UI is M6; M2 exposes API + doctor only" while moving `stages/onClaudeLimit` to `legacy`. Specify the compatibility layer (derive `stages`/`onClaudeLimit` from `roles`, map `PUT` back, keep `health.claude/cursor` and add `codex`) and a minimal UI change so the product the user is running after M1c does not lose its settings panel.
3. **M2 needs its own AC12 test matrix.** Commit 2 changes tests that are not "unchanged": `core.test.ts:29,39` (`onClaudeLimit`, `stages.plan`), `engine-limit.test.ts:8,40` (set `c.pipeline.onClaudeLimit`), `engine-regress.test.ts:321-328` (v1→v2 config upgrade semantics), `test/helpers/harness.ts` config. List them as migrate/replace with the property each carries. Keep the API field `noPushEnvOnly` (`view.ts:145`, `ui/app.js:1138`) as a derived view of the generic guard field.
4. **Canary pass criteria and the tier contradiction.** Codex loads repo `AGENTS.md` and project `.codex/` by design; the canary says it asserts "none … honoured" including a repo canary `AGENTS.md`, which will fail for a healthy Codex and leave it permanently unverified. Define the pass condition: user-home items (hooks, MCP, global instructions, user `AGENTS.md`) **must not** load; repo-level instructions **may** (same tier as Cursor, mitigated by the preamble and `<untrusted>` fencing). §2 says an unverified canary leaves `readOnlyIsolation='unverified'` and usable; §6 says a failed probe makes Codex "unselectable for any role" — pick one. Also: `-c key=value` overrides with a wrong or unknown key are typically accepted silently, so "try the flag, classify the failure" cannot prove a pinned `-c` took effect; any future builder enablement must verify **behaviourally** (attempt network/push from inside the sandbox). State that, and that `selfTest('cheap')` must not make a model call (probe by exit before the API call, otherwise it is `canary` and needs confirmation).
5. **Cursor's `buildIsolationVerified` has no source of truth.** The new gate admits only `build && buildIsolationVerified` providers for implementation; for Cursor the proof is the live suite against version 2026.10.19 (`worktree.ts` comment). Define it (recorded verification with CLI version, same file format as Codex; warn on version change) and state the default so a fresh v2 install does not reject the v1 default implementer. Add the test that an **isolation failure never falls back** to a weaker provider (v1 sends it to `needs_human`, `stages.ts:279-282`); the routing text advances on `limit/spawn/auth` only — keep it that way.

### Minor
- Commit 1 (envelope + contract + registry + rename + labels) is large; split into 1a envelope extraction and 1b contract/registry/rename so each can be diffed against "no behaviour change".
- "Defaults reproduce v1 exactly" is slightly overstated: advancing on `spawn`/`auth` errors and skipping unhealthy providers are new behaviours (acceptable, visible); say so.
- A contract test that the fake-Codex "canary honoured" negative control proves only Conductor's wiring, not Codex; the plan says so — keep that sentence in the docs.
- `--sandbox read-only` as an explicit value is documented only implicitly; include it in the probe list.

## R2.6 Decisions

**Master plan (direction for M3–M7): Approved as direction only.** Nothing in it unlocks source edits. Conditions: M-1…M-4 are text corrections the Lead applies to the master (no re-review needed; I will check them when the first sub-plan is submitted); M-5…M-9 are binding requirements for the named sub-plans (M7, M6, M6, M4, process).

**M1:** **Changes requested** for M1b–M1d. **M1a is Approved to start** (board store + versioning framework, no engine change) under conditions C1–C5 above, which are checked at the M1a code review. M1b must not start until blocking items 1–4 are reflected in `workspace-v2-m1.md` and re-approved; M1c until item 4 is resolved (side-by-side recommended).

**M2:** **Changes requested** (blocking items 1–5). Depends on M1 anyway; Security design sign-off is still required before the first edit.

Blocking list (numbered, consolidated)
1. M1: correct the test counts and the AC12 gate (205 Linear tests, ≈214 retired, 264 survivors, ≈374 after M1d).
2. M1: keep v1 description-edit semantics (halt at the stage boundary, re-plan on restart); fix §3 `integrity()`.
3. M1: write the column/status transition table, restrict human-settable columns, and specify the board↔run-store write order, level-triggered projection and a crash test per window (replaces "startup reconcile heals drift").
4. M1c: crash-safe cut-over (intent file) **and** a plan for v1 code being unable to protect migrated data — preferably side-by-side migration; single backup location; correct the Keychain name; importer untrusted flag and key validation.
5. M2: do not link/copy the user's `auth.json`; private-home login or `CODEX_API_KEY`; pin file credential storage.
6. M2: Settings/UI/health compatibility layer for config v4 (stages/onClaudeLimit/health) with a minimal UI change.
7. M2: own AC12 matrix for the tests commit 2 changes; keep `noPushEnvOnly` API field.
8. M2: canary pass criteria (user-home vs repo-level), resolve the unverified/unselectable contradiction, behavioural verification for `-c` pins, zero-quota meaning of `cheap`.
9. M2: source of truth for Cursor's `buildIsolationVerified` + "isolation failure never falls back" test.

Conditions on M1a: C1 inert migrations · C2 persistence invariants (single-line create/nextSeq, corrupt-middle policy, durability + modes) · C3 read-only open mode · C4 server-side authorship · C5 `Milestone` entity.

Master edits: M-1 Codex-as-implementer unreachable (Partial + schedule/decide) · M-2 Quick Ask "execute" (fast path or Partial) · M-3 milestones entity · M-4 D8 vs M2 · M-5…M-9 as listed in R2.3.

Suggestions (non-blocking): side-by-side v2 home even as the long-term default for this user; split M2 commit 1; add a `doctor --verify-build cursor` that runs the existing live suite and writes the same verification record as Codex; keep per-file test counts in the checkpoint after each milestone so the AC12 shortfall review is mechanical.

Decision (master): Approved (direction for M3–M7 only; text corrections M-1…M-4 to be applied, M-5…M-9 binding on sub-plans)
Decision (M1): Changes requested (M1a approved to start under C1–C5; M1b–M1d blocked until blocking items 1–4 are fixed in the plan)
Decision (M2): Changes requested (blocking items 5–9 above; Security design sign-off still required)


---

# Round 3 — re-review of master rev 3 + M1 rev 3 + M2 rev 2 (clone commit `a23dc0f`)

- Reviewed at: 2026-10-20. Documents read in `/Volumes/Sandisk/github/techteam-conductor-v2/.techteam/plans/`: `workspace-v2.md`, `workspace-v2-m1.md` (rev 3), `workspace-v2-m2.md` (rev 2); diffed against the rev-2 text; claims re-checked against the code (`src/` is still byte-identical to v1 in the original tree; the clone has only the untracked M1a directories `src/board/` and `src/schema/`, which I have **not** reviewed — that is the M1a code review, a separate gate).
- Reviewer did not edit any plan or source.

## R3.1 Round-2 blockers — status

| # | Round-2 blocker | Status | Where it still bites |
| --- | --- | --- | --- |
| 1 | M1 counts / AC12 gate | **Closed.** 205 / ≈214 / 5 / 264 / ≈374 and the "survivors pass + listed new tests exist" gate are right; sums re-checked (214 = 205+4+3+1+1; 483−214−5 = 264; new 40+25+15+20+9+1 = 110). | one label typo: `engine-human` says "migrate 5" but lists 6 (7 tests − 1 retired = 6; the totals are right). |
| 2 | `integrity()` semantics | **Closed in §2, contradicted in §3.** | the §3 files-table row for `stages.ts` still says "user edits are legitimate and picked up" (T1). |
| 3 | Lane ownership / commands / crash protocol | **Substantially closed — good design.** Human-settable lanes only, no lane diffing, run-store-first order, pending records kept, level-triggered projection, 7 crash tests, `rev` on approve, `claimable` = `parentId===null`. | stale lines contradict it (T2–T4); gaps K1–K4 below. |
| 4 | Cut-over safety | **Closed in design — side-by-side is the right call** (v1 home opened read-only, new home published by one rename, rollback = do nothing, single backup root, Keychain name now correct, `assignedPickup` untrusted, key validation). | worktree/branch isolation mechanism does not work as written (K5); rehearsal safety (K6); details (K7). |
| 5 | Codex auth | **Closed.** Own login in the private home or `CODEX_API_KEY`; `cli_auth_credentials_store = "file"` is a real documented key (re-checked on the vendor CI/CD auth page). | §5 still tests an `auth.json` symlink (M2-1). |
| 6 | Settings/UI/health compat | **Closed in text** (derive `stages`/`onClaudeLimit`, map back, add `codex`, minimal UI change, `noPushEnvOnly` derived). | the §3 files table lists no `ui/**` row (M2-2); back-mapping must not clobber other chain entries (M2-5). |
| 7 | M2 test matrix | **Closed.** Lines match the code (`core.test.ts:29,39`, `engine-limit.test.ts:8,40`, `engine-regress.test.ts:321-328`, harness). | — |
| 8 | Canary criteria / tiers / `cheap` | **Mostly closed.** User-home must not load, repo `AGENTS.md` may; `blocked` vs `unverified` resolves the contradiction; `cheap` makes no model call. | the behavioural check and hook/MCP canaries need evidence rules (M2-3); the "exit-before-API probe" is unspecified (M2-4). |
| 9 | `buildIsolationVerified` source of truth / no fallback on isolation failure | **Closed.** One `verification.json` per provider, Cursor bundled baseline (the 2026.10.19 version matches the repo's live-suite evidence), `isolation` never advances the chain (matches `stages.ts:279-282`). | Codex record must be version-bound (M2-6). |

Master rev 3: M-1 (M2b + D9 + V2 row Partial), M-2 (S-complexity fast path in M5), M-3 (`Milestone` in the M1a model and the matrix), M-4 (D8 now matches M2) are applied; M-5…M-9 are recorded as binding. One regression from the home change: **M4 still stores context under `~/.conductor/projects/…`** (master §2 M4 and the §3 `src/context/**` row) — that is now the *v1* home, which the plan promises is never written (T7).

## R3.2 M1b–M1d

### Text corrections required (mechanical; I will verify by `git diff`/`grep`, no re-review) — before M1b's first edit
- **T1** M1 §3 `stages.ts` row: remove "user edits are legitimate and picked up"; state "description edit halts at the next stage boundary (§2 `integrity()` paragraph)".
- **T2** M1 §3 `effects.ts` row: "thin idempotent board writer; drop write-ahead/attempt records" contradicts the crash protocol. Replace with "pending records + idempotent board writes + `flush`; remote attempts/give-up/marker lookup removed".
- **T3** `setColumn` → `setLane` in mapping row 9 and in §7 ("M1b `setColumn` by engine"). Also reword "the two writers use disjoint lanes": Conductor also writes `done`/`canceled`/`backlog` (finished/aborted/parked projection); the property that matters is *the engine never reacts to lane changes it did not command*.
- **T4** M1 §6 "Run-store ↔ board consistency" still describes the old design ("startup reconcile heals drift (item without run in `in_progress` → re-queue …)"); replace with a pointer to the crash protocol section.
- **T5** M1 §2 Versioning framework: backup path `<home>/backups/<ts>/` → the single root `~/.conductor-backups/<ts>/`, overridable with `CONDUCTOR_BACKUP_DIR`; the test harness must set it to a temp dir so tests can never write to the user's real backup directory.
- **T6** Command matrix completeness (it claims "every cell"): add `resume` (v1 `engine.resume`, `api.ts:219,230`; parked ⇒ error whose text still matches `/Backlog/`, migrated test `engine-regress.test.ts:268`), `abort` (v1 allows it in any status; the matrix only has `move→canceled`, which 409s on `finished`), `cleanup`; reconcile `retry` on `paused` (v1 allows it, `engine.ts:745` list includes `paused`; the matrix says 409); fix "migrate 5" → 6.
- **T7** Master: M4 context path and the `src/context/**` row → `<v2 home>/projects/<projectId>/context/`; Working agreement 1 ("the real `~/.conductor` is migrated …") → "read-only imported, side-by-side"; AC2 "backup before first write / rollback test" → matches side-by-side (v1 home is never written; the rollback test becomes "v1 tag runs unchanged on a copy of its home").

### Design conditions to record in the TODO before the stated first edit
- **K1 (M1b) one write for transition + pending effect.** Today a transition is `patch(status…)` and then `effects.*` → `setRec` as a second `RunStore.update` (e.g. `toNeedsHuman` `stages.ts:101-115`, `markReady` `:992-1020`), so a crash between them leaves the status changed and no pending record: the lane is healed by the level-triggered projection but the narration comment (needs-you reason, ready summary) is lost. Require status/next **and** the pending effect records in a single `RunStore.update`, and add a crash test between the old two writes — or state explicitly that narration loss in that window is accepted.
- **K2 (M1b) lanes are written only by the engine, after the run record changed.** The HTTP handler for `PATCH /api/items/:key {lane}` must call `engine.applyHumanMove`, never `board.setLane` directly (a direct write followed by an async `stopJob` lets a projection tick revert the human's move). Add a test: a human move is not reverted by the projection under interleaving.
- **K3 (M1b) persistent write failure must surface, not spin.** v1 capped retries so a failing effect "never loops forever" (`effects.ts:209`); the new text deletes attempt counters entirely. Keep a failure counter per effect (reporting only), and on a persistently failing board write (disk full, journal refused) set an engine-level "storage problem" state/banner and stop the retry-every-tick loop. "Recently-terminal runs" in the startup flush needs a definition (simplest: every run that has any `pending` record).
- **K4 (M1b) two behaviours that would silently start agents.** (i) The orphan rule "item in active/needs_you/review without a run ⇒ lane reset to `todo`" re-queues a `--force` build after any data loss (v1 would have ignored an In-Progress issue it had no run for, `engine.ts:319`); flag it on the dashboard, never auto-reset. (ii) `claimable()` kinds `work/ask/research`: until M5 provides ask/research runners, claim only `work` (otherwise an `ask` item runs through the build pipeline).
- **K5 (M1c) worktree/branch isolation is not implementable as specified.** The plan says imported in-flight runs get `worktree` cleared and `branch` renamed `conductor/<key>-v2` "so v1 and v2 can never fight over one checkout". But `createWorktree` derives the path (`<root>/<repo>/<key>`), the branch (`branchFor(key)`) and the base ref (`refs/conductor/<key>/base`) from the key alone (`worktree.ts:339-340, 43`), re-attaches an already-registered worktree for that key (`:349-353`), and `ensureWorkspace` overwrites `run.branch` from what it returns (`stages.ts:328-335`). So an imported `BAR-363` would re-attach **v1's checkout**. Specify a mechanism and test it: either a v2-wide namespace (default `worktreeRoot` `<repo-parent>/.conductor-v2-worktrees`, branches `conductor-v2/<key>`, base ref `refs/conductor-v2/<key>/base` — touching `worktree.ts` and its tests) or re-keying imported in-flight runs. Test: a v1-registered worktree for the same key exists ⇒ v2 creates its own and never touches it.
- **K6 (M1c) rehearsal safety.** "Run the tagged v1 code against the untouched v1 home" would start a v1 engine with the real Keychain entry (service `techteam-conductor`, `secrets.ts:13`) and talk to the user's real Linear workspace (comment/move BAR-363). Rehearse only on a **copy** of the home with `CONDUCTOR_NO_KEYCHAIN=1` and no `LINEAR_API_KEY`; assert in the test that no Linear key is resolvable.
- **K7 (M1c) migrate details.** (i) The "v1 home byte-identical before/after" manifest cannot hold while v1 is running (it appends events/sessions): compare only the files the importer read, report "changed during import — re-run", and assert byte-identity in the quiescent test. (ii) "refuses if the target exists" blocks migration after v2 has been started once (startup creates the home): allow an empty/uninitialised target or detect a marker. (iii) Cookie name: it is host-scoped, not port-scoped (security review M2), so v1 on :4317 and v2 on :4318 sign each other out; give v2 a distinct cookie name (and keep the port scan).

### M1d
Delete Linear code/tests/fixtures/`graphql` devDependency + import-graph test + docs (`CLAUDE.md` dev-dependency line): no conditions beyond the matrix.

## R3.3 M1a — adjustments to the conditions you are coding against now
C1–C5 stand. Adjust/clarify before the M1a checkpoint:
1. **Backup root** (T5): `src/schema/backup.ts` is being written now — use `~/.conductor-backups/<ts>/` with the `CONDUCTOR_BACKUP_DIR` override; tests set it to a temp dir.
2. **Stamp values (C1):** M1a stamps `schemaVersion: 1` on `state.json`/`run.json`/board and treats *missing* as 1, so v1-shaped files are current at M1a; M1b raises `run.json` current to 2 with its migration (the plan's M1a text says stamps, §2 says M1b "adds `schemaVersion`" — make them one story).
3. **C4 wrapper in M1a:** the whitelist/validation layer for untrusted input (title, description, comment body, lane ∈ {backlog,todo,done,canceled}, no `author`/`createdBy`/`kind`) should exist and be tested in M1a, not only in the M1b handlers; the core `Board` may accept constants.
4. **Default home change:** `worktree.ts:135` hard-codes `~/.conductor` in the "refuse a repo inside a Conductor home" guard — add `~/.conductor-v2` explicitly (the guard only covers `conductorHome()` when `CONDUCTOR_HOME` is not overridden).
5. **Journal format version:** put `schemaVersion` in the snapshot header and a version field on journal lines (or the file header) so future migrations can replay old journals; C2(3) fsync claim is scoped to the board (`RunStore` uses `atomicWriteFile` without fsync, `util.ts:50-55`) — say so, so nobody reads it as a whole-system power-loss guarantee.

## R3.4 M2 (rev 2)
All five round-2 blockers are substantively fixed. Text/spec corrections before the first M2 edit (checked at the Security design sign-off, which is still required and is not mine to give):
- **M2-1** §5 Codex test bullet still asserts a private home with "`auth.json` symlink" — the exact thing §2 now forbids. Replace with: private home contains only our `config.toml` (+ its own login file); a test that the user's `~/.codex/auth.json` is never read, linked or copied.
- **M2-2** §3 files table has no `ui/**` row although the minimal UI change is promised in M2 (`ui/app.js:38` `AGENT_LABEL`, the health/setup rows, chips) and `docs/API.md` field changes.
- **M2-3** Canary evidence rules. A model asked to write a file may simply not try, so "the write must fail" cannot be a pass unless the JSONL shows an **attempted** write (a `command_execution`/`file_change` item) that was **denied**; no attempt ⇒ inconclusive (`unverified`), not pass. Hook/MCP canaries must have a **side effect** (the hook script or MCP server touches a marker file) and "not honoured" = marker absent; absence of transcript events proves nothing because Codex may emit no event for hooks.
- **M2-4** `selfTest('cheap')` "exit-before-API probe of the pinned flags (`--help`-level parse acceptance)" is unspecified and contradicts §2's "not `--help` parsing". A parse-level probe can show a flag is *recognised*, not that a `-c` pin took effect (unknown `-c` keys are typically accepted). Until designed against a working binary, `cheap` = `--version` + `login status` only, and the docs must not say the flags are verified.
- **M2-5** Compat layer back-mapping: `PUT /api/settings` of `stages`/`onClaudeLimit` must change only the first claude|cursor slot / the cursor-append rule and leave other chain entries (e.g. a Codex entry) intact; add that case to the round-trip test.
- **M2-6** A Codex `verification.json` record is valid only for the recorded CLI version (Cursor's grandfathered baseline is the deliberate exception); build that rule into the record format now so M2b inherits it.

## R3.5 Decisions

Verified in this round: counts and arithmetic; Keychain name; side-by-side design intent; `cli_auth_credentials_store`; the M2 matrix line references; `stages.ts:279-282`; Cursor baseline version; master M-1…M-4 applied. Not verified (unchanged): live suites, Codex `-c` keys and `login status`, anything Windows/Linux.

Decision (master): Approved — direction for M3–M7 only (unchanged); text fix T7 to be applied before the M4 sub-plan.
Decision (M1b–M1d): Approved — conditional. **M1b must not start until T1–T7 are committed and K1–K4 are in the M1b TODO; M1c must not start until K5–K7 are in the M1c TODO; M1d has no extra conditions.** (I will check by diff, not by a new review.) M1a: C1–C5 stand with adjustments 1–5 above.
Decision (M2): Approved — conditional on M2-1…M2-6 being applied before the first M2 edit; Security design sign-off still required.
