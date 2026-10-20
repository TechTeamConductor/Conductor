# Architecture

One Node process (zero runtime dependencies, TypeScript executed by Node's built-in type stripping). Linear is the **ledger**; `~/.conductor/` is the **technical memory**.

```
            ┌────────────── dashboard (127.0.0.1, cookie auth, SSE) ──────────────┐
            │  server/http.ts · api.ts · auth.ts · open.ts      ui/*              │
            └───────────────┬─────────────────────────────────────────────────────┘
                            │ controls / reads
   Linear (GraphQL) ◄──► pipeline/engine.ts ──► pipeline/stages.ts ──► agents/provider.ts
   linear/client.ts        poll · reconcile ·      plan · review ·        ├─ claude.ts  (read-only, locked down)
                           claim · schedule        approval · build ·     └─ cursor.ts  (build --force / read-only ask)
                                │                  verify
                                ▼                       │
                         store.ts (runs/*.json,    git/worktree.ts · git/gates.ts
                         events.ndjson)            (isolated worktrees, commit hygiene, gates)
```

## State machine

`queued → running(plan → [plan review] → [approval] → build → verify) → ready`, with `needs_human`, `paused` (provider usage limit), `parked` (Backlog), `aborted`, `finished`.

Linear is authoritative for **human intent** (issue exists, trigger label, native state *type*, text, comments). The local store is authoritative for **execution facts** (stage, loop, sessions, SHAs, effects, cost). Conductor records what it last wrote (`expected`) to tell human edits from its own.

| Observed in Linear | Meaning |
| --- | --- |
| `unstarted` (Todo) + trigger label, created by you | pick up |
| issue moved to `unstarted` while a run exists | retry / re-plan (a recoverable backup ref is written first) |
| moved to `backlog`/`triage` | **park** — hold, touch nothing |
| `completed` / `canceled` / label removed / deleted | stop (process group killed) |
| `/approve` comment by you after our approval request | approve the plan |

### Stage details
- **Plan** (Claude, read-only): structured JSON plan (acceptance criteria with verification, files, steps, risks, coverage). Optional independent **plan review** (one revision max).
- **Approval:** manual for the first plan per repo, for `L` complexity, or always — configurable.
- **Build** (Cursor `--force` in the worktree): Conductor commits, not the agent. Guards: secret/size scan before commit, protected-path diff guard (`.claude/`, `.cursor/`, `AGENTS.md`, CI…), no-push guard hash.
- **Verify:** deterministic **gates** first (failure *sets* compared to the baseline taken before the change; regressions are blamed even if the gate was already red), then the Claude verifier (maps each acceptance criterion to evidence, hunts defects). A gate regression overrides a "pass".
- **Answer-only tasks:** if the plan's `deliverable` is `answer` (a question or analysis), the answer is posted to Linear and the run finishes — no build, no verify.
- **Limits:** a rejected (limit) attempt never counts toward the per-issue run budget; unknown reset times back off 15 m → 6 h; one comment + one notification per limit episode. A human retry (Todo) always starts with a fresh budget.
- **Loop:** fail → bug sub-issues (deduped by fingerprint, closed when fixed) → fix prompt → build → verify; capped by `maxLoops` (3).

## Idempotent Linear effects

Every Linear write (comment, state/labels, bug sub-issue, close) is first recorded as a **pending intent** in the run file and applied with a marker (`conductor-ref: <run>:<key>`). After a crash or a dropped connection the retry *looks the marker up first* and adopts the existing comment/issue instead of duplicating. Linear being unreachable never stops local work; effects flush when it comes back.

## Isolation & safety

| Concern | Mechanism |
| --- | --- |
| Your global Claude rules/MCP/skills leaking into headless runs | `--safe-mode --tools "Read,Grep,Glob" --disable-slash-commands --strict-mcp-config --permission-mode dontAsk`; the `system/init` event is checked **fail-closed** on every stage (`tools == {Read,Grep,Glob,StructuredOutput}`, no MCP/skills/slash commands, `dontAsk`). Repo `CLAUDE.md`/`AGENTS.md` are read by Conductor and injected as *untrusted* text. |
| Your global Cursor rules (cannot be disabled by any flag) | the builder prompt overrides plan/review/tracker/agent rules explicitly and states the plan is approved; protected-path guard; live tests assert no ceremony artefacts. |
| Builder pushing | `.cursor/cli.json` deny rules (live-proven under `--force`: plain `git push` **and** wrapper/explicit-URL variants — `env git push <path>`, `/usr/bin/git`, `git -c k=v`, `sh -c` — are blocked; `gh`, `security`, `osascript`, `sudo` too), env neutralisation (push URLs, credential helper, `GIT_SSH_COMMAND`), prompt rule, SHA-256 guard on the deny file. Defence in depth — a `--force` agent still runs as you. |
| Secrets | Linear key in Keychain via `security -i` stdin; children get an allow-listed env (no Linear/other-vendor keys); every string from agents is redacted (token shapes + values from copied `.env` files) before Linear/logs/UI. |
| Dashboard | loopback only, `Host` check (DNS rebinding), single-use sign-in link → `HttpOnly; SameSite=Strict` cookie on every route incl. SSE, CSRF header + same-origin check on mutations, exact static whitelist, 1 MB body cap. |
| Teammates / prompt injection via Linear | only issues **you created** (server-side `creator.isMe` + client re-check); trigger-label and description edits are attributed via issue history; only your comments reach prompts; all issue/repo text is fenced as untrusted data; the verifier is read-only. |
| Cost | `maxParallel` 2, `maxLoops` 3, per-issue cap of 10 agent runs, usage-limit pause. |

## What Conductor changes in your repositories

Nothing in your working tree or branches. It does add: a git **worktree** per task (`<repo parent>/.conductor-worktrees/<repo>/<KEY>`, branch `conductor/<key>`), refs under `refs/conductor/<KEY>/` (base + recoverable backups), and a few lines in the repo's shared **`.git/info/exclude`** (`/.conductor/`, `node_modules`, copied env files, `/.cursor/cli.json`) so those never show up in `git status`. `uninstall` does not remove them; delete the lines by hand if you want.

## Files on disk (`~/.conductor`)

`config.json` (0600) · `state.json` · `runs/<KEY>/{run.json, events.ndjson, plan-N.json|md, review-N.json, verdict-N.json, baseline.json, gates-N.json, prompt-*.md}` · `logs/` · `run/{lock.json, control.sock}`.
Worktrees: `<repo parent>/.conductor-worktrees/<repo>/<KEY>` on branch `conductor/<key>`; recoverable backups under `refs/conductor/<KEY>/…`.

## v2 data home, versions and backups (M1a)

v2 keeps its data in **`~/.conductor-v2`** (override with `CONDUCTOR_HOME`) — never in the v1 `~/.conductor`, so running v2 code can never touch v1 data. Everything it writes carries a data version: `config.json` (`version`), `state.json`/`run.json` (`schemaVersion`), the native board (`board/snapshot.json` header + a `v` on every `board/journal.ndjson` line). Rules: a file from a **newer** build is refused (nothing is written, the app tells you to upgrade or restore); an older file is migrated in memory and its original is copied to **`~/.conductor-backups/<timestamp>/`** (outside every Conductor home, override `CONDUCTOR_BACKUP_DIR`) before the first write; unknown config keys are preserved; a corrupt `config.json`/`state.json`/`run.json` is kept aside as `*.corrupt-<ts>` instead of being overwritten.

**Board storage** (`board/`): an append-only journal (one line per change = the resulting entity; each append is written and `fsync`ed) plus an atomic snapshot (temp file → `fsync` → rename → directory `fsync`), compacted every 500 operations and on clean close. A torn final journal line is ignored; a corrupt middle line makes the board refuse to open. Single writer (lock); `doctor`/dry-runs open it read-only. Durability is scoped to the board: run records still use plain atomic writes.

## Known limits (v1)

- Claude headless sessions are not listed by the Claude app's Code tab; use "Open in Claude app" (`claude --desktop --resume`) or the resume command.
- Cursor's app does not list headless CLI chats (unverified for the Agents window); Cursor Cloud Agents / My Machines would — planned for v1.1.
- Linear is validated against its official schema and a faithful fake, but a first run against your real workspace is the final proof (`conductor doctor --linear`).
- A `--force` builder is not a sandbox; only register repos you trust.
