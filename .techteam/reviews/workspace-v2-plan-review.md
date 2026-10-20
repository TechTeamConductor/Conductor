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
