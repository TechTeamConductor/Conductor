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
- **Task graph (M3):** a plan may split the work into 2–12 dependent tasks (`plan.taskGraph`; validated structurally — no cycles, every acceptance criterion and every planned file owned, analysis tasks read-only; a one-task graph is just a single task). When the plan is **approved** the run gets a `graph` and one Conductor-owned `subtask` card per task (created by idempotent effects; their lanes are a projection of the task states — a card you move is moved back, and the dashboard refuses the move with a reason). More than 8 tasks always waits for your approval. The build then runs **one scheduling step per call** (`pipeline/graph-build.ts`): read-only *analysis* tasks first, concurrently (up to `pipeline.readOnlyParallel`, one cap shared by every run), then exactly **one build task at a time** through the same build envelope, on one branch, **one commit per task** (the message carries a `Conductor-Item: T<n> <nonce>` line). After each commit the repository gates run against the baseline; a regression gives that task another attempt (its failures are fenced into the prompt), and a task that uses up its attempts **fails** — its commits are backed up under `refs/conductor-v2/<KEY>/…` and the branch goes back to where the task began, so independent tasks continue on good code while dependents are blocked. When nothing else can run the run asks you; **Retry runs only the failed and blocked tasks again** (finished tasks and their commits are kept), while moving the card to To do re-plans from scratch. When every task is done the whole change is verified once, exactly as a single task would be; a finding is attributed to the task whose commit last touched the file (only for a path that is really in the diff) and the fix prompt names it. After a crash an interrupted task is **adopted only** if exactly one commit sits on its recorded start, the tree is clean and the commit message carries its id and its per-attempt nonce — and the scope/secret checks and the task's gates still run before it counts; anything else is backed up and reset. The agent-run budget and the iteration cap scale with the task count up to hard ceilings (150 runs / 400 iterations); a graph-less run keeps its original numbers.
- **Loop:** fail → bug cards (children of the task card, deduped by fingerprint, closed when fixed) → fix prompt → build → verify; capped by `maxLoops` (3).

## Providers, roles and the build envelope

- **Registry** (`src/agents/providers/`): `claude`, `cursor`, `codex`, each a sealed (deep-frozen) object that only `createProviders` can make. A provider's **capabilities are derived, never declared**: `readOnly` = it has `runReadOnly`; `build` = it has `build.run`; `buildIsolationVerified` = a code-constant baseline (Cursor, proven by `test/live/cursor-nopush.test.ts` on 2026.10.19) — never config, never an adapter flag, never an HTTP route. Display names come from one table.
- **Roles → chains → router** (`agents/roles.ts`, `agents/routing.ts`): `config.roles[role] = { providers[], autoByComplexity? }`. `route()` is a pure function of the chains, CLI-reported health/auth/limit pauses, derived capabilities and the plan's complexity. A provider that may not hold a role (a build role needs `build && verified`; `research` needs isolated web access; a `blocked` tier is never usable) is dropped and **never run, even as the last one left**; unhealthy ones are skipped with a reason; if every eligible provider is at a usage limit the stage waits (v1 semantics). A complexity pick can never lower the isolation tier. Only `limit` / `spawn` / `auth` errors advance the chain.
- **Config v4** replaces `stages` + `pipeline.onClaudeLimit` with `roles` (old keys kept under `legacy.v3`). The Settings API keeps `stages` / `onClaudeLimit` as **derived** fields. A hand-edited config is untrusted input: unknown ids, prototype keys and ineligible build owners are dropped at load.
- **The build envelope** (`pipeline/envelope.ts`) is the ONLY code that starts a builder: provider eligibility re-asserted (only registry objects count), the provider's own guard (`prepare` / `verifyGuard`, fail closed, bound to what its verification depends on), the git no-push env (always wins; a provider may add only the env keys it declared), the git-meta snapshot/restore (also when the provider throws), Conductor's own commit with the secret/scope guard, then branch-wide scope and secret scans. If the git settings cannot be snapshotted the builder is not started.
- **Codex** (`providers/codex.ts`, read-only only): constants-only argv (`exec --json --sandbox read-only --ignore-user-config --ignore-rules --ephemeral` plus pinned `-c` values; prompt on stdin), a private `CODEX_HOME` and a per-run empty `HOME`, a minimal env, run serialisation per home, and a hygiene pre-flight that refuses to run if anything Conductor did not put there (hooks, rules, skills, memories, AGENTS.md …) is in the private home. Limit / auth are read **only after a structural failure** from the CLI's own (capped) error events and stderr — never from model prose. Its isolation canary (`providers/canary.ts`) has positive controls for every item and counts absence of evidence as *inconclusive*; results are add-only records (`providers/<id>/verification.json`) bound to the CLI version, binary hash, argv and config — a pass lifts Codex to `partial` for read-only roles only while the install matches **and only once the matchers have been validated against a real Codex transcript (`canaryValidated`, false today — a pass is recorded and shown as "not yet trusted" but changes nothing)**; a `blocked` result is sticky. **No record can ever grant build isolation.** The control layer of the check is placed temporarily INSIDE the private home (so it runs signed in), under the home lock, and removed in a `finally`; the network item needs a connection-failure exit *and* a listener that provably records a control connection from Conductor; `binSha256` hashes the resolved launcher (an npm shim), the CLI version being the real binding; `CODEX_MIN_VERSION` is the version the author's machine has, not a vendor-changelog floor.

## Crash-safe board writes ("effects")

Every write Conductor makes to the board (a note, the stage/lane projection, a bug card, a bug card's closing) is first recorded as a **pending effect in `run.json`** — for the transitions that matter (needs you, ready, answered, awaiting approval, abort) in the **same write** as the status change — then applied to the board under an idempotency key (`<RUN>:<effect>`) and marked done. On startup and every tick, anything still pending is re-applied (replays are no-ops), and a level-triggered projection pulls each card's lane back to what its run says. A crash at any point therefore converges with no lost narration and no duplicates. A board that cannot be written (disk full, journal refused) keeps effects pending, retries with back-off and raises a dashboard banner; restart Conductor to recover.

**Board storage** (`board/`): an append-only journal (one line per change = the resulting entity; each append is written and `fsync`ed; a failed append is rolled back and the board then refuses writes until restarted) plus an atomic snapshot (temp file → `fsync` → rename → directory `fsync`), compacted every 500 operations and on clean close. A torn final journal line is ignored (a copy is kept); a corrupt middle line, an unknown version or an invalid entity makes the board refuse to open. Single writer (a real mutual-exclusion lock); `doctor`/dry-runs never open it for writing.

## Data folder, versions and backups

v2 keeps its data in **`~/.conductor-v2`** (override with `CONDUCTOR_HOME`), marked by `home.json` — a non-empty folder without the marker (e.g. a v1 folder) is **refused**, never used in place. Everything carries a data version: `config.json` (`version`, now 3: the old Linear block lives under `legacy`), `state.json`/`run.json` (`schemaVersion`), the board (snapshot header + a `v` on every journal line). A file from a **newer** build is refused (nothing is written); an older file is migrated in memory and its original is copied to **`~/.conductor-backups/<timestamp>/`** (outside every Conductor home) before the first write; unknown config keys are preserved; a corrupt `config.json`/`state.json`/`run.json` is kept aside as `*.corrupt-<ts>` (a corrupt run also leaves a tombstone so its key cannot be re-claimed). **Importing v1** is `conductor migrate` (side by side: built in a staging sibling, validated, then ONE rename for a new target — an untouched empty skeleton is renamed aside, re-checked and replaced, and rolled back if a v2 started meanwhile; v1 is read-only input: regular files only, size-capped, keys taken from the directory names, bad runs skipped with a warning; every imported run is `untrusted` with v1's approval dropped, and a parked import retries from the plan).

## Isolation & safety

| Concern | Mechanism |
| --- | --- |
| Your global Claude rules/MCP/skills leaking into headless runs | `--safe-mode --tools "Read,Grep,Glob" --disable-slash-commands --strict-mcp-config --permission-mode dontAsk`; the `system/init` event is checked **fail-closed** on every stage (`tools == {Read,Grep,Glob,StructuredOutput}`, no MCP/skills/slash commands, `dontAsk`). Repo `CLAUDE.md`/`AGENTS.md` are read by Conductor and injected as *untrusted* text. |
| Your global Cursor rules (cannot be disabled by any flag) | the builder prompt overrides plan/review/tracker/agent rules explicitly and states the plan is approved; protected-path guard; live tests assert no ceremony artefacts. |
| Builder pushing | `.cursor/cli.json` deny rules (live-proven under `--force`: plain `git push` **and** wrapper/explicit-URL variants — `env git push <path>`, `/usr/bin/git`, `git -c k=v`, `sh -c` — are blocked; `gh`, `security`, `osascript`, `sudo` too), env neutralisation (push URLs, credential helper, `GIT_SSH_COMMAND`), prompt rule, SHA-256 guard on the deny file. Defence in depth — a `--force` agent still runs as you. |
| Secrets | children get an allow-listed env (no other-vendor keys); every string from agents is redacted (token shapes + values from copied `.env` files) before it reaches the board, the logs and the event stream; the board redacts everything Conductor writes a second time. `run.json`, the verdict/plan artifacts and the run-detail API (`GET /api/runs/:key`) still carry agent text as the agent produced it (see Known limits). |
| Dashboard | loopback only, `Host` check (DNS rebinding), single-use sign-in link → `HttpOnly; SameSite=Strict` cookie on every route incl. SSE, CSRF header + same-origin check on mutations, exact static whitelist, 1 MB body cap. |
| Prompt injection / hostile content | all card and repo text is fenced as untrusted data; only notes authored by *you* (server-side authorship; a request body can never carry `author`) reach prompts; the verifier is read-only; every imported card is `untrusted` (plan approval is forced, v1's approval is not inherited); `.conductor` symlinks planted by a repo are replaced, never followed; a run only ever works in the checkout v2 itself created. |
| Cost | `maxParallel` 2, `maxLoops` 3, per-card cap of 10 agent runs, usage-limit pause. |

## What Conductor changes in your repositories

Nothing in your working tree or branches. It does add: a git **worktree** per task (`<repo parent>/.conductor-v2-worktrees/<repo>/<KEY>`, branch `conductor-v2/<key>`), refs under `refs/conductor-v2/<KEY>/` (base + recoverable backups), and a few lines in the repo's shared **`.git/info/exclude`** (`/.conductor/`, `node_modules`, copied env files, `/.cursor/cli.json`) so those never show up in `git status`. v1's `conductor/…` branches, `refs/conductor/…` and `.conductor-worktrees` are never touched by v2. `uninstall` does not remove any of it; delete the lines by hand if you want.

## Files on disk (`~/.conductor-v2`)

`home.json` · `config.json` (0600) · `state.json` · `board/{snapshot.json, journal.ndjson, board.lock}` · `runs/<KEY>/{run.json, events.ndjson, plan-N.json|md, review-N.json, verdict-N.json, baseline.json, gates-N.json, prompt-*.md}` · `logs/` · `run/{lock.json, control.sock, sessions.json}`.

## Known limits (v2 so far)
- **Codex has never run against a real binary here** (this machine's install is broken): its argv pins, event shapes and canary are written from the vendor documentation and tested against a scripted stand-in (`fixtures/fake-codex.mjs`). A project-level `.codex/` layer that the real CLI loads despite `--ignore-user-config` will make the canary report `blocked` — the intended safe outcome. There is no Codex API-key mode (login in the private home only) until the environment policy can be proven on a working binary.
- The verification record file is same-user writable (bookkeeping, not tamper-proofing); the only thing forging it could grant is `partial` for read-only roles.

- Claude headless sessions are not listed by the Claude app's Code tab; use "Open in Claude app" (`claude --desktop --resume`) or the resume command.
- Cursor's app does not list headless CLI chats (unverified for the Agents window); Cursor Cloud Agents / My Machines would — planned for v1.1.
- Windows and Linux are not supported yet (macOS-only pieces: Keychain, launchd, notifications, process groups, `sh -c` gates); installers are on the roadmap, not built.
- Only Claude and Cursor build (Codex is read-only). Per-task parallel builds (each task in its own worktree), the project-context engine and the Quick Ask / Deep Research modes are planned (see `.techteam/plans/workspace-v2*.md`).
- `run.json` and the verdict/plan artifacts contain agent text unredacted at rest, and `GET /api/runs/:key` returns it as stored (board comments, bug cards, logs and live events are redacted). Redact-on-read for the detail API is planned; until then treat the dashboard as local-only (it already is: loopback + session cookie).
- A `--force` builder is not a sandbox; only register repos you trust.
