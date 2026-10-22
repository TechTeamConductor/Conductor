# Architecture

One Node process (zero runtime dependencies, TypeScript executed by Node's built-in type stripping). The native **board** (`src/board/`) is the ledger of work; `~/.conductor-v2/` (or `CONDUCTOR_HOME`) is the technical memory.

```
            ┌────────────── dashboard (127.0.0.1, cookie auth, SSE) ──────────────┐
            │  server/http.ts · api.ts · auth.ts · open.ts      ui/*              │
            └───────────────┬─────────────────────────────────────────────────────┘
                            │ commands (applyHumanMove · approve(rev) · retry · abort …) / reads
   board/  ◄────────────► pipeline/engine.ts ──► pipeline/stages.ts ──► agents/provider.ts
   projects · cards ·       claim · project lanes ·  plan · review ·        ├─ claude.ts  (read-only, locked down)
   comments · decisions     flush effects ·          approval · build ·     └─ cursor.ts  (build --force / read-only ask)
   journal + snapshot       schedule                 verify
                                │                       │
                         store.ts (runs/*/run.json,    git/worktree.ts · git/gates.ts
                         events.ndjson) + effects.ts   (isolated worktrees, commit hygiene, gates)
```

## State machine

`queued → running(plan → [plan review] → [approval] → build → verify) → ready`, with `needs_human`, `paused` (provider usage limit), `parked` (Backlog), `aborted`, `finished`.

**Lanes.** A card has a lane: `backlog · todo · active · needs_you · review · done · canceled`. **Humans may set only `backlog`, `todo`, `done`, `canceled`; Conductor owns `active`, `needs_you`, `review`.** Human intent therefore arrives only as explicit commands (the engine never diffs lanes to guess what you meant), and the card's lane is always a *projection* of the run's state, recomputed on every tick:

| Run status | Lane |
| --- | --- |
| (no run yet) | `todo` / `backlog` (human-owned) |
| queued · running · paused · failed | `active` |
| awaiting_approval · needs_human | `needs_you` |
| ready | `review` |
| finished · aborted · parked | `done` · `canceled` · `backlog` |

| Command | Effect |
| --- | --- |
| move → Backlog | **park**: stop the job, keep everything (nothing runs until you move it to To do) |
| move → To do (or Retry) | restart: backup ref first, re-plan (or retry the failed stage), fresh agent-run budget; at most 5 per hour |
| move → Done · Canceled | finish · abort (the agent's process group is killed) |
| Approve `{rev}` | only while `awaiting_approval` **and** only for the current plan revision |
| a note (comment) | included in the next plan prompt; never changes state |

`engine.applyHumanMove` is the only code path that moves a card that has a run; the HTTP layer never writes a lane for it.

The board is authoritative for **human intent and the card's text**; the run store is authoritative for **execution facts** (stage, loop, sessions, SHAs, effects, cost). Editing a card's description mid-run halts the run at the next stage boundary (the approved plan was written against the old text); a restart re-plans with the new text.

### Stage details
- **Plan** (Claude, read-only): structured JSON plan (acceptance criteria with verification, files, steps, risks, coverage). Optional independent **plan review** (one revision max).
- **Approval:** manual for the first plan per repo, for `L` complexity, for plans that touch protected files, and for cards whose text came from an unverified source (**every imported card and run**); or always — configurable.
- **Build** (Cursor `--force` in the worktree): Conductor commits, not the agent. Guards: secret/size scan before commit, protected-path diff guard (`.claude/`, `.cursor/`, `AGENTS.md`, CI…), no-push guard hash.
- **Verify:** deterministic **gates** first (failure *sets* compared to the baseline taken before the change; regressions are blamed even if the gate was already red), then the Claude verifier (maps each acceptance criterion to evidence, hunts defects). A gate regression overrides a "pass".
- **Answer-only tasks:** if the plan's `deliverable` is `answer` (a question or analysis), the answer is posted as a note on the card and the run finishes — no build, no verify.
- **Limits:** a rejected (limit) attempt never counts toward the per-card run budget; unknown reset times back off 15 m → 6 h; one comment + one notification per limit episode. A human restart always starts with a fresh budget.
- **Task graph:** a plan may split the work into 2–12 dependent tasks (`plan.taskGraph`; validated structurally — no cycles, every acceptance criterion and every planned file owned, analysis tasks read-only; a one-task graph is just a single task). When the plan is **approved** the run gets a `graph` and one Conductor-owned `subtask` card per task (created by idempotent effects; their lanes are a projection of the task states — a card you move is moved back, and the dashboard refuses the move with a reason). More than 8 tasks always waits for your approval. The build then runs **one scheduling step per call** (`pipeline/graph-build.ts`): read-only *analysis* tasks first, concurrently (up to `pipeline.readOnlyParallel`, one cap shared by every run), then exactly **one build task at a time** through the same build envelope, on one branch, **one commit per task** (the message carries a `Conductor-Item: T<n> <nonce>` line). After each commit the repository gates run against the baseline; a regression gives that task another attempt (its failures are fenced into the prompt), and a task that uses up its attempts **fails** — its commits are backed up under `refs/conductor-v2/<KEY>/…` and the branch goes back to where the task began, so independent tasks continue on good code while dependents are blocked. When nothing else can run the run asks you; **Retry runs only the failed and blocked tasks again** (finished tasks and their commits are kept), while moving the card to To do behaves like Retry here (to re-plan, edit the card description, or stop the run and Retry). When every task is done the whole change is verified once, exactly as a single task would be; a finding is attributed to the task whose commit last touched the file (only for a path that is really in the diff) and the fix prompt names it. After a crash an interrupted task is **adopted only** if exactly one commit sits on its recorded start, the tree is clean and the commit message carries its id and its per-attempt nonce — and the scope/secret checks and the task's gates still run before it counts; anything else is backed up and reset. The agent-run budget and the iteration cap scale with the task count up to hard ceilings (150 runs / 400 iterations); a graph-less run keeps its original numbers.
- **Loop:** fail → bug cards (children of the task card, deduped by fingerprint, closed when fixed) → fix prompt → build → verify; capped by `maxLoops` (3).

## Providers, roles and the build envelope

- **Registry** (`src/agents/providers/`): `claude`, `cursor`, `codex`, each a sealed (deep-frozen) object that only `createProviders` can make. A provider's **capabilities are derived, never declared**: `readOnly` = it has `runReadOnly`; `build` = it has `build.run`; `buildIsolationVerified` = a code-constant baseline (Cursor, proven by `test/live/cursor-nopush.test.ts` on 2026.10.19) — never config, never an adapter flag, never an HTTP route. Display names come from one table.
- **Roles → chains → router** (`agents/roles.ts`, `agents/routing.ts`): `config.roles[role] = { providers[], autoByComplexity? }`. `route()` is a pure function of the chains, CLI-reported health/auth/limit pauses, derived capabilities and the plan's complexity. A provider that may not hold a role (a build role needs `build && verified`; `research` needs isolated web access; a `blocked` tier is never usable) is dropped and **never run, even as the last one left**; unhealthy ones are skipped with a reason; if every eligible provider is at a usage limit the stage waits (v1 semantics). A complexity pick can never lower the isolation tier. Only `limit` / `spawn` / `auth` errors advance the chain.
- **Config v4** replaces `stages` + `pipeline.onClaudeLimit` with `roles` (old keys kept under `legacy.v3`). The Settings API keeps `stages` / `onClaudeLimit` as **derived** fields. A hand-edited config is untrusted input: unknown ids, prototype keys and ineligible build owners are dropped at load.
- **The build envelope** (`pipeline/envelope.ts`) is the ONLY code that starts a builder: provider eligibility re-asserted (only registry objects count), the provider's own guard (`prepare` / `verifyGuard`, fail closed, bound to what its verification depends on), the git no-push env (always wins; a provider may add only the env keys it declared), the git-meta snapshot/restore (also when the provider throws), Conductor's own commit with the secret/scope guard, then branch-wide scope and secret scans. If the git settings cannot be snapshotted the builder is not started.
- **Codex** (`providers/codex.ts`, read-only only): constants-only argv (`exec --json --sandbox read-only --ignore-user-config --ignore-rules --ephemeral` plus pinned `-c` values; prompt on stdin), a private `CODEX_HOME` and a per-run empty `HOME`, a minimal env, run serialisation per home, and a hygiene pre-flight that refuses to run if anything Conductor did not put there (hooks, rules, skills, memories, AGENTS.md …) is in the private home. Limit / auth are read **only after a structural failure** from the CLI's own (capped) error events and stderr — never from model prose. Its isolation canary (`providers/canary.ts`) has positive controls for every item and counts absence of evidence as *inconclusive*; results are add-only records (`providers/<id>/verification.json`) bound to the CLI version, binary hash, argv and config — a pass lifts Codex to `partial` for read-only roles only while the install matches **and only once the matchers have been validated against a real Codex transcript (`canaryValidated`, false today — a pass is recorded and shown as "not yet trusted" but changes nothing)**; a `blocked` result is sticky. **No record can ever grant build isolation.** The control layer of the check is placed temporarily INSIDE the private home (so it runs signed in), under the home lock, and removed in a `finally`; the network item needs a connection-failure exit *and* a listener that provably records a control connection from Conductor; `binSha256` hashes the resolved launcher (an npm shim), the CLI version being the real binding; `CODEX_MIN_VERSION` is the version the author's machine has, not a vendor-changelog floor.

## Project context and limits
- **Context** (`src/context/`): facts about each project (languages, frameworks, scripts, modules, tests, CI) derived from git objects only; stored under `<home>/projects/<KEY>/context/` (0700/0600, versioned, hashed and re-validated on every load — the cache is not trusted because a builder could rewrite it). Builder prompts get identifier-class facts recomputed from git at the run's base commit (no command text, no history, no model text); read-only stages additionally get script commands, outcome history and — only when a project opts in — model-written directory summaries, all fenced as untrusted. The residual: a builder can rewrite the history/summaries cache and so influence a later plan; bounded by opt-in, fencing and the approval gates.
- **Offline** (`src/net/offline.ts`): a provider failure with no result and a network error on stderr pauses the run (`offline`), refunds the attempt, backs off and resumes when the probe is back; `unknown` counts as online.
- **Limits** (`src/limits/budget.ts`): the one persisted counter module (local-day windows, code-constant ceilings, validated on load).

## Crash-safe board writes ("effects")

Every write Conductor makes to the board (a note, the stage/lane projection, a bug card, a bug card's closing) is first recorded as a **pending effect in `run.json`** — for the transitions that matter (needs you, ready, answered, awaiting approval, abort) in the **same write** as the status change — then applied to the board under an idempotency key (`<RUN>:<effect>`) and marked done. On startup and every tick, anything still pending is re-applied (replays are no-ops), and a level-triggered projection pulls each card's lane back to what its run says. A crash at any point therefore converges with no lost narration and no duplicates. A board that cannot be written (disk full, journal refused) keeps effects pending, retries with back-off and raises a dashboard banner; restart Conductor to recover.

**Board storage** (`board/`): an append-only journal (one line per change = the resulting entity; each append is written and `fsync`ed; a failed append is rolled back and the board then refuses writes until restarted) plus an atomic snapshot (temp file → `fsync` → rename → directory `fsync`), compacted every 500 operations and on clean close. A torn final journal line is ignored (a copy is kept); a corrupt middle line, an unknown version or an invalid entity makes the board refuse to open. Single writer (a real mutual-exclusion lock); `doctor`/dry-runs never open it for writing.

## Data folder, versions and backups

v2 keeps its data in **`~/.conductor-v2`** (override with `CONDUCTOR_HOME`), marked by `home.json` — a non-empty folder without the marker (e.g. a v1 folder) is **refused**, never used in place. Everything carries a data version: `config.json` (`version`, now 3: the old Linear block lives under `legacy`), `state.json`/`run.json` (`schemaVersion`), the board (snapshot header + a `v` on every journal line). A file from a **newer** build is refused (nothing is written); an older file is migrated in memory and its original is copied to **`~/.conductor-backups/<timestamp>/`** (outside every Conductor home) before the first write; unknown config keys are preserved; a corrupt `config.json`/`state.json`/`run.json` is kept aside as `*.corrupt-<ts>` (a corrupt run also leaves a tombstone so its key cannot be re-claimed). **Importing v1** is `conductor migrate` (side by side: built in a staging sibling, validated, then ONE rename for a new target — an untouched empty skeleton is renamed aside, re-checked and replaced, and rolled back if a v2 started meanwhile; v1 is read-only input: regular files only, size-capped, keys taken from the directory names, bad runs skipped with a warning; every imported run is `untrusted` with v1's approval dropped, and a parked import retries from the plan).

## Isolation & safety

| Concern | Mechanism |
| --- | --- |
| Your global Claude rules/MCP/skills leaking into headless runs | `--safe-mode --tools "Read,Grep,Glob" --disable-slash-commands --strict-mcp-config --permission-mode dontAsk`; the `system/init` event is checked **fail-closed** on every stage (`tools == {Read,Grep,Glob,StructuredOutput}`, no MCP/skills/slash commands, `dontAsk`). Repo `CLAUDE.md`/`AGENTS.md` are read by Conductor and injected as *untrusted* text. |
| Claude `settings.json` `apiKeyHelper` / `env` | `--safe-mode` alone does **not** stop these. Conductor **quarantines** project `<cwd>/.claude/settings*.json` around every stage/research spawn (restore after; links refused), and **refuses** to start Claude when the default config dir's settings (or `.claude.json`) carry `apiKeyHelper` or a settings `env` entry outside the allow-list — without rewriting `~/.claude`. Allowed `env` entries: `ANTHROPIC_BASE_URL` pointing at this machine only (`127.0.0.1` / `localhost` / `::1`, http/https, no userinfo — e.g. a local proxy such as Headroom) and plain `ENABLE_*` / `DISABLE_*` switches with short inert values; everything else refuses. Residual: if that local proxy is not running, any local process could listen on its port and receive prompts and the sign-in credential. Named accounts already refuse settings files entirely. |
| Your global Cursor rules (cannot be disabled by any flag) | the builder prompt overrides plan/review/tracker/agent rules explicitly and states the plan is approved; protected-path guard; live tests assert no ceremony artefacts. |
| Builder pushing | `.cursor/cli.json` deny rules (live-proven under `--force`: plain `git push` **and** wrapper/explicit-URL variants — `env git push <path>`, `/usr/bin/git`, `git -c k=v`, `sh -c` — are blocked; `gh`, `security`, `osascript`, `sudo` too), env neutralisation (push URLs, credential helper, `GIT_SSH_COMMAND`), prompt rule, SHA-256 guard on the deny file. Defence in depth — a `--force` agent still runs as you. |
| Secrets | children get an allow-listed env (no other-vendor keys); every string from agents is redacted (token shapes + values from copied `.env` files) before it reaches the board, the logs and the event stream; the board redacts everything Conductor writes a second time. `run.json`, the verdict/plan artifacts and the run-detail API (`GET /api/runs/:key`) still carry agent text as the agent produced it (see Known limits). |
| Dashboard | loopback only, `Host` check (DNS rebinding), single-use sign-in link → `HttpOnly; SameSite=Strict` cookie on every route incl. SSE, CSRF header + same-origin check on mutations, exact static whitelist, 1 MB body cap. |
| Prompt injection / hostile content | all card and repo text is fenced as untrusted data; only notes authored by *you* (server-side authorship; a request body can never carry `author`) reach prompts; the verifier is read-only; every imported card is `untrusted` (plan approval is forced, v1's approval is not inherited); `.conductor` symlinks planted by a repo are replaced, never followed; a run only ever works in the checkout v2 itself created. |
| Cost | `maxParallel` 2, `maxLoops` 3, per-card cap of 10 agent runs, usage-limit pause. |

## What Conductor changes in your repositories

Nothing in your working tree or branches. It does add: a git **worktree** per task (`<repo parent>/.conductor-v2-worktrees/<repo>/<KEY>`, branch `conductor-v2/<key>`), refs under `refs/conductor-v2/<KEY>/` (base + recoverable backups), and a few lines in the repo's shared **`.git/info/exclude`** (`/.conductor/`, `node_modules`, copied env files, `/.cursor/cli.json`) so those never show up in `git status`. v1's `conductor/…` branches, `refs/conductor/…` and `.conductor-worktrees` are never touched by v2. `uninstall` does not remove any of it; delete the lines by hand if you want.

## Who does what: tool, model and effort

- **Config v6.** Each role may carry a model choice: `tool` (the tool it was chosen for — server-derived), `model`, `custom`, `effort`, `fast`, `thinking` (`agents/roles.ts`). "Default model for each tool" is `config.toolModels[tool] = { model, custom? }` and replaces v5's free-text `agents.<tool>.model`. The v5 → v6 migration (also applied by `normalizeConfig`, idempotently) keeps a value that passes that tool's id rule as a custom default and moves any other value verbatim to `legacy.v5.agentsModel` — never sent, served, rendered or logged; the warning names the tool and the reason only. `legacyNotices` (Settings) and `conductor doctor` say so in static words. With nothing set, every stage argv is byte-identical to v5 (`test/argv-e2e-golden.test.ts`).
- **Binding rule.** A role's model, custom, Fast and Thinking apply only when the tool that runs is `sel.tool`. Any other tool (a chain fallback, a complexity pick, a head changed via `PUT /api/settings`, a dropped build head, a hand edit) runs on its own default with the role's effort fitted.
- **Resolution** (`models/select.ts`, `models/levels.ts`, pure): at every stage start the choice is re-validated against the discovered list (`ModelService.view`, memory only). A discovered model no longer listed, or no list, ⇒ the tool default plus a visible note in the run log ("… is no longer offered by Claude — using the tool default."). Efforts are exactly the discovered levels, fitted to the nearest (ties go higher), one note per adjustment. Cursor ids are found by looking up the parsed `(thinking, effort, fast)` tuple in the family's **listed** ids — never built by concatenation — and a Cursor id (custom, migrated or default) is only ever sent if it is listed. Claude/Codex custom ids pass after the per-tool id rule (`modelIdOk`: Claude may carry one `[1m]`-style suffix; Codex and Cursor never brackets).
- **Argv.** `agents/model-args.ts` is the only place the model/effort slice is built: Claude `--model <id> --effort <level>` after `-n <name>` (efforts from `CLAUDE_EFFORTS` only), Cursor `--model <listed id>` last (never an effort argument), Codex `--model=<id>` and/or the one literal `-c model_reasoning_effort="<tok>"` just before `-o`. `CODEX_ARGV_DIGEST` stays computed over the constant argv. "Runs as …" (`runsAs`) is the static command name plus exactly that slice, so Settings cannot drift from what runs.
- **Plumbing.** `Agents.readOnly` resolves per candidate (`selRole`, server-only, picks only the model/effort — route, gates, profile and init check key off `role`; `toolDefaultOnly` pins the context summary to the tool default). Builds pass `sel` through the envelope untouched. Deep Research stays Claude-only via `runResearch` with the research row's choice. A run whose CLI rejected the `--model` (no result event; its own stderr says so) asks discovery for a fresh list, rate-limited by model discovery.
- **API.** `GET /api/roles` serves the choices in a PUT-round-trippable form plus view data; `PUT /api/roles` is strict and shares one pure `planRoles` (`server/roles-plan.ts`) with `POST /api/roles/preview`, which never saves, refreshes or spawns.

## Model discovery

`src/models/` asks each installed CLI which models it offers. Nothing is hard-coded: a test checks that no model id from the recorded fixtures appears in `src/` or `ui/`. Per-job model selection consumes the catalogue for argv (see above); `test/argv-golden.test.ts` pins the builders' full argv with nothing selected.
- **Adapters, constants-only argv.**
  - Claude runs `claude -p --input-format stream-json --output-format stream-json --verbose --safe-mode --strict-mcp-config --disable-slash-commands --no-session-persistence`. It gets ONE `initialize` control request on stdin, then EOF, and never a prompt. Only `models` and `account` are read from the reply. From `account`, only `signedIn` and `plan` are kept.
  - A turn tripwire watches the output: any `assistant` / `user` / `result` / `stream_event` / `rate_limit_event` / `system:init` line kills the process group, and nothing is cached. The child is also killed as soon as the reply is parsed.
  - Cursor runs `agent --list-models`; lines of the form `id - Label` are parsed, and its reasons are fixed text.
  - **Codex** has a parser only (`CODEX_DISCOVERY_ENABLED = false`, a code constant). Nothing looks up, prepares or spawns Codex. Enabling it is a separate Security gate.
- **Sanitiser** (`sanitize.ts`, a leaf module; `config.ts` re-exports its id rule as `CODEX_MODEL_RE`).
  - `cleanText`: NFC, then strip `\p{Cc}` `\p{Cf}` `\p{Zl}` `\p{Zp}` `\p{Co}` and lone surrogates, collapse whitespace, truncate by code point.
  - Ids are checked **raw**, never repaired, through `modelIdOk(provider, id)`, which picks a rule per provider (Security S9 widening ruling W1–W7):
    - Cursor and Codex use `MODEL_ID_BASE_RE`: first character alphanumeric, so an id can never read as an option; then `[A-Za-z0-9._:/-]`, ≤ 64 characters. Codex's `CODEX_MODEL_RE` is this same rule.
    - Claude uses `CLAUDE_MODEL_RE`: the base rule plus one optional `[a-z0-9]{1,8}` bracket suffix, ≤ 74 characters. This is because Claude 2.1.304 lists an `<id>[1m]` context-size variant when run with Conductor's env.
    - Brackets are Cursor's parameter syntax, so a bracketed Cursor id is refused. Any further widening goes back to Security.
  - Efforts must be in `EFFORT_TOKENS`.
  - Parsing is field by field and own-property only.
  - `scrubIdentity` runs on every reason and log detail. It strips the refresh's exact email/organisation, any email shape, and absolute paths.
- **Process.**
  - Discovery reuses the existing env allow-lists (`claudeEnv` / `cursorEnv`), with a 15 s idle + hard deadline (≈ 21 s worst case with the SIGTERM→SIGKILL grace and pipe drain).
  - `runProcess`'s optional `maxOutputBytes` caps output at 2 MB raw, plus a 512 KB per-line cap. Overflow is always `unavailable`, even if a reply arrived first.
  - Every discovery runs in the one stable folder `<home>/run/discovery`. It must be a real 0700 folder owned by the user. It is emptied without following links before each spawn and cleaned after reaping; only the leftover count is logged. One service-wide queue serialises all discoveries.
  - Inside `npm test` the service refuses to spawn unless a `spawn` dependency was injected.
- **Cache** (`cache.ts`): `<home>/models/<provider>/<account>.json`.
  - The path is built only from the provider enum and the account regex, and is asserted inside `models/`. Folders are 0700 and owned by the user.
  - Reads go through `O_NOFOLLOW` + `fstat` (regular file, ≤ 4 MB), then `version === 1`. Any other version, or a missing one, means corrupt: the file is quarantined, with ≤ 3 copies kept. A newer version is left untouched, and the fresh list stays in memory only.
  - Every field is re-validated. `provider`/`account` must match the path, and a `fetchedAt` in the future is shown stale. Families are always recomputed. Writes are atomic (temp + rename, 0600, version stamped) after a newer-version check made through the same no-follow handle. `saveVersioned` is not used, because its own check re-reads the path following links. Folder modes are tightened through an `O_NOFOLLOW` handle (`fchmod`), and the path is then re-checked to still be the same folder.
- **Service** (`service.ts`, wired in `runtime.ts`).
  - `view()`/`viewAll()` are memory-only (default-account caches are read once at construction) and never wait for a discovery. `refresh()` lets a second call join the one in flight per (provider, account); a manual refresh inside 10 s returns the cached view.
  - Automatic triggers (startup after the first REAL health read, a version change, the `noteUnknownModel` trigger) are rate-limited: ≤ 1 per 5 min after a failure and ≤ 1 per distinct CLI version per process. A runtime with injected health (tests, demo) never discovers by itself.
  - `conductor start` and the desktop sidecar do one background health read after `listen` (`Runtime.warmUp`). `Runtime.close()` stops discovery (process-group kill).
  - CLI: `conductor models [--refresh] [--json]`. It does not refresh while a server holds the lock, and holds the lock during its own refresh.
- **Known footprint:** each Claude discovery writes the user's Claude config dir (`.claude.json` and a backup), the same as every read-only stage does. Measured live on 2026-10-21 over two refreshes: the `~/.claude.json` project-key count and the `~/.claude/projects` entry count did not change, and no entry for the discovery folder was added. Cursor runs with the real HOME, which sign-in needs.

## Dashboard UI

Vanilla JS with no build step and no dependencies. It ships as exact static files: `/` → `ui/index.html`, `/modes.js`, `/app.js`, `/style.css`, `/favicon.svg`. `modes.js` loads first, and both scripts are `defer`.

**Files**
- **`ui/modes.js`**: pure helpers with no DOM or network access, exposed as one deeply frozen `ConductorModes`. The same bytes run in `test/ui-modes.test.ts` through `vm`. It holds:
  - `detectMode` (verbatim from the design);
  - repo matching and resolution;
  - the Build title rule (`taskFromText`);
  - the seven "Who does what" rows (`ROLE_ROWS`) and their follower roles;
  - the role-chain edit (`setLead`, `roleEdit`, `rolesPatch`), the acknowledgement set (`acksNeeded`, `withAck`), and wording derived from roles;
  - `safeAttr` / `safeHttp`, which guard every attribute the DOM helper writes.

  If it is missing, `app.js` shows an alert and stops.
- **`ui/app.js`**: the views.
  - It renders only through `h()`, which creates text nodes and passes attributes through `safeAttr`, or through the DOM-only markdown renderer.
  - `test/ui-safety.test.ts` enforces that there are no HTML sinks and that every URL attribute is on a reviewed allow-list.

**Routing**

| Hash | Shows |
| --- | --- |
| `#/` | Home (the default once setup is complete) |
| `#/board` | Board |
| `#/setup` | the setup wizard |
| `#/run/:key[/tab]` | the run drawer, over the last Home/Board view; Board for a direct link |

Closing the drawer goes back in history if it was opened in the app. Otherwise it replaces the hash with the base view.

**Home**
- One composer with the modes Auto / Ask / Build / Research. Auto uses `detectMode` and shows the result ("Auto · Ask").
- Requests:
  - Ask and Research go to `POST /api/ask` and are polled through `GET /api/asks/:id`, every 1.5 s, until they finish.
  - Build goes to `POST /api/tasks`: the title is the first line, at most 200 characters, and the full text becomes the description.
- The repo chip always shows where a request goes. The order is:
  1. an explicit choice;
  2. a unique whole-word match of a repo name in the text;
  3. the last repo used (a session value, only a registered name);
  4. the only repo.
- The conversation is held in memory only. It survives Home ↔ Board navigation; it is never stored, and it is dropped on sign-out or session expiry.
- Steps come only from the record's real fields. A running turn turns Send into Stop.

**Who does what** (Settings rows and the Home "Handled by" popover)
- A change replaces the lead of the role's chain and keeps every other entry and field.
- Followers are mirrored: Build → `debugging` and `documentation`; Design the work → `architecture`.
- The change is computed from a fresh `GET /api/roles`.
- Unverified providers are confirmed one by one. Only the confirmed ids go into `acknowledge`, and the server's `notices` are shown.
- In the popover, a pick is a draft until "Use X for every … job".
- Settings saves `PUT /api/settings` first (it no longer sends `stages`), then the roles.


## Design the work and research briefs

- **One line in, a reviewed brief out; nothing reaches the board until you press Send.** `src/briefs/` (`schemas.ts` pure validation and shaping, `cards.ts` pure card planning, `store.ts` records under `<home>/briefs/`, `service.ts` orchestration) is wired in `src/runtime.ts`. The only writer of `design` cards is the runtime facade `designCards()` (kind `work`, lane To do, top level, auto-start, code-built title and description, dependency ids from the same send, idemKey `design:<briefId>:P<n>`).
- **Trust.** Every brief string is model text: shaped (one-line fields `sanitizeLine`, multi-line `stripInvisible`, `\n` only), capped, then redacted with the repository's real secret values, again on load. Cards are authored by the tainted actor `design` (`ACTOR_INFO` in `src/board/types.ts` is the one table behind `ACTORS`, `TAINTED_ACTORS` and the redaction list), so `run.untrusted` is set at claim and the plan is held under every policy and on every re-plan. In the card description your own line comes first; every model line is quoted with `> ` between a code-written header and `— end of model-written text —`.
- **Residual risks (stated):** (R1) after you approve a plan, the builder sees the model-written part text inside the task fence, exactly as shown on the card (as for Quick Ask / research conversions); (R2) with Cursor or Codex on the Design row the read-only isolation is weaker (the brief says so); (R3) each card builds from the base branch, so a later part needs the earlier one merged and moved to Done first — Conductor does not merge or check this; (R4) `files[].state` proves a path is (or is not) in the committed snapshot, not that the brief's reasoning is right.
- **Research brief.** Written by Claude only (`onlyProviders: ['claude']`, a narrowing filter in `Agents.readOnly`) from the question only, on the read-only file-tool profile in an empty folder; `selRole: 'research'` (a code constant) borrows the Deep Research row's model/effort and nothing else. The web session receives exactly the stored brief, fenced as `research-brief`, and the prompt says it cannot change the rules. **Depth:** Standard = 30 turns / 20 min (unchanged argv), Deep = 50 turns / 35 min (`RESEARCH_DEPTH`, ≤ 60 asserted); with the one schema re-run the worst case is 2 × 35 min / 2 × 50 turns. Research stays in the asks store; the board shows a read-only projection.
- **Send is a write-ahead state machine:** `ready → sending → sent | send_failed`; cards are adopted through their idemKey on replay, `resumeSending()` finishes interrupted sends at start, `DELETE` is refused while sending, and pruning never removes a running or sending record. A research Send stamps `briefId` in the ask's first save, so a replay adopts the run instead of starting (and counting) a second one.
- **Board schema 3, no downgrade.** The version lives only in `snapshot.json` (journal ops stay `v: 1`), so a writable open whose snapshot is older (or absent with a journal) backs it up as `pre-board-v3` and compacts **before** any write; a brand-new board is stamped before its first `design` op. An older build therefore refuses the board with `NewerVersionError` instead of cutting a new op off as a torn tail. Restore = the backup.
- **Limits:** `designPerHour` (default 10, ceiling 30, refunded once to the window it was taken in when a call ends on a usage limit), ≤ 2 briefs at once, ≤ 8 parts and cards per send, `researchPerDay` checked before a research brief and taken at Send (Deep = 2). Scratch folders (`conductor-brief-…`) are removed on every outcome; a start-up sweep removes owned `conductor-{ask,research,brief}-` folders untouched for more than 3 hours (the temp folder is shared with other Conductor homes, and a Deep research with its re-run can last 70 minutes).
- **Fetch-target filter residual:** a research brief may not introduce URLs, IP literals (including short/hex/private-decimal IPv4 and IPv6 forms), local or cloud-metadata host names or wildcard-DNS names you did not type; plain public host names in prose are not caught (they collide with ordinary wording). The brief is written from your question only and you review it before Send.

## Run mode: Per settings | Complete auto

- **An overlay, read at decision time; it writes nothing else.** `pipeline.runMode` (`per-settings` default; exact equality — any other value is Per settings). Under `complete-auto`, `effectivePolicy` returns `full-auto` for every project, `effectiveFirstPlanHold` is off, and `effectiveLimitRule` returns `switch` (the next account, then the next tool in the job's list — never a tool outside it). `storedPolicy`, `planApproval`, `limitRule` and per-project policies are never written by the switch, and the settings view reports stored and effective values separately (`overriddenByRunMode`).
- **What Complete auto never does.** It never removes a forced hold: `decideApproval` is unchanged and its forced inputs (large change, protected files, more than 8 tasks, an untrusted source — imports, Ask conversions, research, `design` cards) are computed in `stages.ts`, which never reads the mode (static test). It never approves a plan that is already waiting; a hold records `run.forcedHold` (absent = forced), so the separate "Approve waiting plans" action (a human approval) can skip forced, risky, stale and tainted-author cards.
- **One writer, persist then swap.** Only `PUT /api/run-mode` changes the mode (CSRF + `confirm` to turn it on). Every config writer goes through the runtime's `save`, which writes `config.json` first and switches memory only after the write succeeded. A v1 import always arrives as Per settings.

## Accounts per tool and the limit rule

- **Accounts.** Each tool has an ordered list of sign-ins (`config.accounts`, config v7). `default` is your own sign-in, with today's environment, the real HOME and the Keychain, byte for byte. Added accounts are named `<tool>-<label>-<4 hex>`, with a fresh suffix at every add, so a re-added name never reuses an old folder. Each gets a private 0700 folder `<home>/accounts/<tool>/<id>/`:
  - Claude: its own `CLAUDE_CONFIG_DIR`;
  - Cursor: its own HOME plus `AGENT_CLI_CREDENTIAL_STORE=file`.
- **No secrets in Conductor.** Each tool keeps the login in its own store. Conductor never opens `.credentials.json` or `auth.json` (static test) and stores no key or token. Views show labels and Ready / Not signed in only: never a path, an email or an organisation.
- **Signing in extra accounts is not enabled yet.** `conductor accounts login <id>` answers "awaiting a live check" until the live sign-in checks for Claude and Cursor pass. Added accounts can be listed, checked (zero quota), reordered and removed.
- **The limit rule** (`pipeline.limitRule`, read ONLY through `effectiveLimitRule`):
  - `switch` (default): the next account of the same tool, then the next tool **in that job's list**. Conductor never moves work to a tool that is not in the job's list, so a Claude-only job never moves to Cursor.
  - `same`: only the first tool's accounts; a limit never changes the tool.
  - `wait`: only the first account.
  - Under every rule, non-limit fallbacks (a tool that is not installed, signed out, or does not start) follow the chain as before.
  - With one sign-in per tool and `switch`, every route, argv and env is byte-identical to the previous build (property test against a verbatim copy of the old router).
- **Engine behaviour.**
  - Pauses are kept per account, in memory, for at most 24 hours. After a restart, only the account a limit-paused run last hit is paused again (from the run record). Other accounts that were paused are tried once more, and a rejected attempt is refunded.
  - A read-only stage and Deep Research move to the next allowed account inside the same call.
  - A build that hits a limit starts again at once on the next allowed account. When nothing is usable, the run pauses until the earliest reset. A limit-paused run is re-routed on every tick: it resumes as soon as an account is free, added and signed in, reordered, or the rule changes.
  - A reset never interrupts a running stage.
  - Each limit episode gets one board comment and one notification. Only episodes that end in a pause count toward the cap of 6.
  - Removing the account a stage runs on stops that stage and restarts it on the next account. A removed builder's uncommitted edits stay in the worktree, as after a timeout retry.
  - Home calls (Quick Ask, Research, briefs) never queue. When every account is at its limit they answer `409 limited` with `retryAt`, before any counter is taken. When the limit hits mid-call they end `failed`/`limited` and the counter is refunded.
- **Safety checks before every spawn of an added account.**
  - The folder and its parents must be real 0700 directories owned by you.
  - Claude's folder may hold only the entries measured live (measured signed out): `.claude.json`, `.claude.json.lock`, `backups`, `sessions`, `projects`. `settings.json`, `CLAUDE.md`, `.mcp.json`, `hooks`, `plugins`, `skills`, unknown entries, links and hard links are refused, and so is a `.claude.json` with MCP servers, an API key, `env` or `apiKeyHelper`. Testing showed that `--safe-mode` alone does not stop a planted `settings.json` `apiKeyHelper` or `env`; named-account pre-flight plus the project-settings quarantine are what stand in front of those for Conductor spawns.
  - The Cursor `.cursor` allow-list is empty until its live check passes, so an added Cursor account becomes `unavailable` after its first check. Stray top-level HOME entries are removed while the account is idle.
  - Every child env is asserted right before the spawn. A failure is an `isolation` error with nothing started, and it never falls back.
- **Builds on added Cursor accounts are off** (`CURSOR_ACCOUNT_HOME_BUILD_VERIFIED = false`) until the no-push suite passes under an account HOME. They do read-only work only.
- **Please read (residual risks):**
  - (a) Signing in another account stores that tool's login in a private folder under the Conductor home. For Cursor this is a plaintext file (`auth.json`, 0600), not the Keychain. Code that the Cursor builder or repository checks run can read it as your own user, just as it can read your other files. Add only accounts you accept that exposure for, and revoke sessions if a build looked hostile. Builds on added Cursor accounts (once enabled) share your npm, Go-module and Rust caches and toolchains with your own shell, as builds on your main account already do.
  - (b) Under "Next account, then another tool", work from **any** project may run on **any** listed account, including a personal one. If a project must stay on one organisation's account, use same/wait or do not add the account.
  - (c) Folders of removed accounts are deleted. Sign-out is attempted, but Claude may keep a Keychain item for a folder that no longer exists. Orphan folders found at start-up are deleted without a sign-out.
  - Added Claude accounts bypass an `ANTHROPIC_BASE_URL` proxy set in your shell, which is the safe direction.
  - You may exclude `<home>/accounts` from Time Machine (`tmutil addexclusion`); Conductor does not do it for you.
- **Isolation scope.** Per-account folders protect against accidental crossing of sign-ins. They are not a boundary against a hostile process running as you. The CLI talks to a running server over the 0600 control socket in a 0700 `run/` folder, which exposes an exact route list and no login route.

## Files on disk (`~/.conductor-v2`)

`home.json` · `config.json` (0600) · `state.json` · `board/{snapshot.json, journal.ndjson, board.lock}` · `runs/<KEY>/{run.json, events.ndjson, plan-N.json|md, review-N.json, verdict-N.json, baseline.json, gates-N.json, prompt-*.md}` · `logs/` · `run/{lock.json, control.sock, sessions.json, discovery/}` · `briefs/brf-<hex16>.json` (briefs, 0600, ≤ 200 kept; created on first use) · `accounts/<tool>/<id>/` (added sign-ins, 0700; never for `default`) · `models/<provider>/<account>.json` (model lists; a cache — an empty `models/` counts as skeleton, a cache file makes the home "hold data" for `migrate`, like `run/`).

## Known limits (v2 so far)
- The board view does not draw the research projection or the "Part n/N" chip yet: `GET /api/board` serves both (`research[]`, `items[].design`), the Home thread shows briefs, parts, research briefs and reports.
- **Codex has not yet been exercised against a real binary:** its argv pins, event shapes and canary are written from the vendor documentation and tested against a scripted stand-in (`fixtures/fake-codex.mjs`). A project-level `.codex/` layer that the real CLI loads despite `--ignore-user-config` will make the canary report `blocked` — the intended safe outcome. There is no Codex API-key mode (login in the private home only) until the environment policy can be proven on a working binary.
- The verification record file is same-user writable (bookkeeping, not tamper-proofing); the only thing forging it could grant is `partial` for read-only roles.

- Claude headless sessions are not listed by the Claude app's Code tab; use "Open in Claude app" (`claude --desktop --resume`) or the resume command.
- Cursor's app does not list headless CLI chats (unverified for the Agents window); Cursor Cloud Agents / My Machines would — planned.
- macOS is the supported platform. Windows and Linux can install (one-command installers) and start the dashboard, but are **experimental**: Keychain secret storage (a 0600 file is used elsewhere), the launchd service and notifications are macOS-only, and on native Windows repo paths must start with `/`, gates run through `sh -c`, process groups use `kill(-pid)`, the control socket is a unix socket and the `claude` / `agent` `.cmd` shims cannot be launched. Use WSL2 on Windows. Desktop apps (`.dmg`, `.exe`) are parked.
- Only Claude and Cursor build (Codex is read-only). Per-task parallel builds (each task in its own worktree) are planned.
- `run.json` and the verdict/plan artifacts contain agent text unredacted at rest, and `GET /api/runs/:key` returns it as stored (board comments, bug cards, logs and live events are redacted). Redact-on-read for the detail API is planned; until then treat the dashboard as local-only (it already is: loopback + session cookie).
- A `--force` builder is not a sandbox; only register repos you trust.
