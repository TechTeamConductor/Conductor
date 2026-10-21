# Conductor (v2 preview)

**One dashboard for Claude Code and Cursor, with its own board.** Create a task → **Claude plans it** → **Cursor builds it** → **Claude independently verifies it** → bugs go back to Cursor, automatically, until it passes (or asks you).

You do the thinking; Conductor does the shuffling between the two tools. Everything runs on your computer, in separate git worktrees. **It never pushes, opens PRs, or merges.** There is no external tracker: the board is built in and stored locally.

> **Status.** This is the v2 line (see `.techteam/plans/workspace-v2*.md` for the roadmap). Done so far: the native board (Linear removed), versioned data with backups, side-by-side import of v1 data, **roles and providers** (Claude, Cursor and an opt-in, read-only, *unverified* Codex — see below). Planned next: Codex as an implementer (needs its own isolation proof), task decomposition, a project-context engine, Quick Ask / Deep Research modes, onboarding for three CLIs, desktop installers (Windows `.exe`, Linux `.deb`). Nothing in that second list exists yet.

```
Task card (To do)
   │
   ▼  Claude — read-only analysis & plan   (+ independent plan review for bigger changes)
   ▼  plans run automatically — only large plans, ones touching CI/agent config, or imported/unverified text wait for your OK
   ▼  Cursor — builds in an isolated worktree
   ▼  Gates (your tests/lint/typecheck) — deterministic ground truth
   ▼  Claude — independent verifier (read-only): acceptance criteria → evidence, bugs
   │      └─ fail → bug cards on the board → back to Cursor (max 3 loops, then it asks you)
   ▼  "Ready for review" — branch + worktree waiting for you to merge
```

## Quick start (about 5 minutes, once)

1. **Install the two CLIs and sign in** (you probably already have them): Claude Code (`claude`) and the Cursor CLI (`agent login`).
2. **Try it without any keys:** `npm run demo` — a dashboard with scripted agents so you can click around.
3. **Start for real:** `npm start` — the dashboard opens and walks you through two steps: check Claude + Cursor are signed in, then add a repo folder (tests/lint are auto-detected).
4. **Press New task.** That's it. Cards live on the board (Backlog · To do · the working stages · Needs you · Ready for review).

No `npm install` is needed to run it (zero runtime dependencies; Node 22.18+). Data lives in `~/.conductor-v2` (override with `CONDUCTOR_HOME`); the default port is 4327.

### Coming from Conductor v1 (Linear)?

v1 and v2 run **side by side**: v2 never writes to the v1 folder (`~/.conductor`); `migrate` refuses a `--to` that is inside it (or the reverse).

```
node bin/conductor.mjs migrate            # dry run: shows exactly what would be imported, writes nothing
node bin/conductor.mjs migrate --apply    # creates ~/.conductor-v2 (built aside, then one rename) and a backup copy in ~/.conductor-backups (kept until YOU delete it; it holds your v1 run records and plan/verdict files)
```

Every v1 run becomes a card (keys kept, e.g. `BAR-363`). Anything that was still active in v1 shows up as **Needs you** — v2 never starts the same work twice; press Retry to run it in v2. **Every imported card is treated as unverified text**: v1's approval is dropped, and when you press Retry (or move it to To do) it starts again at the **plan**, which waits for your approval before anything is built. The dry run also lists exactly what the imported settings will *run* on your machine (gate and setup commands, agent binaries, environment variables, copied files) — only migrate a folder you created. Files over 50 MB, symlinks and non-regular files in the v1 folder are skipped with a warning, never read. Nothing is ever written to Linear, and your old Linear key stays in the macOS Keychain until you delete it yourself.

## Everyday use

| You want to… | Do this |
| --- | --- |
| start a task | **New task** (it starts right away), or create a card in *Backlog* and press **Start** later |
| design a bigger change first | **Home → Build**: Conductor checks your line against a read-only copy of the repo, writes a detailed brief and splits it into up to 8 tasks. Untick what you don't want and press **Send N tasks**. Every task made this way is model-written, so its plan **always waits for your approval**; a later task starts only after the earlier one is merged into your base branch and moved to Done |
| research before deciding | **Home → Research**: Claude first writes a short research brief from your question only (no repository access); check it, pick Standard or Deep (Deep takes longer and counts as two of the day's research runs), then **Send as a research task** |
| approve a plan | usually nothing — plans run automatically. Large (`L`) plans, plans touching CI/agent config, and imported cards wait: press **Approve plan** |
| ask a question | create the card as usual — if no code change is needed, Claude's **answer** appears as a note on the card and it finishes (no build/verify) |
| work on a bigger change | nothing special — if the plan splits it into tasks, a **Tasks** tab shows them (one card per task under the run's card). Tasks build one at a time, each gated by your repo's tests; if one fails, the others that don't depend on it continue, and **Retry** re-runs only the failed ones. Plans with more than 8 tasks wait for your approval |
| answer a question / retry after a failure | add a **note** on the card (your notes are read by the next plan), then press **Retry** |
| pause a card without losing work | **Park in Backlog** (nothing runs); **Move to To do** restarts it, re-planning but keeping the work |
| stop it | **Abort run** (or **Cancel** on a card that has not started) |
| finish it | review the branch in the worktree, merge it yourself, then **Mark done** |

## Providers and roles

Every job has a **role** (planning, review, verification, implementation, debugging, documentation, requirements, context, architecture, research) and each role has an **ordered list of providers**. The defaults are exactly what v1 did: Claude plans, reviews and verifies (Cursor takes over those read-only stages if Claude is at its usage limit, or not installed / signed in), Cursor builds. The Settings panel still shows the simple choices; behind it `GET/PUT /api/roles` (see `docs/API.md`) assign providers per role.

- **Who may hold which role is decided by code, not by a setting.** A role that writes code (implementation, debugging, documentation) accepts only a provider whose no-push isolation has been *proven* — today only Cursor (proven by the live adversarial suite). Everything else is refused with the reason.
- **Codex is optional and read-only.** It is in no default chain. It runs in Conductor's **own private Codex home** (`~/.conductor-v2/providers/codex-home`), never your `~/.codex` — so your hooks, MCP servers and rules are not in play. Sign in yourself, once: `CODEX_HOME=~/.conductor-v2/providers/codex-home codex login` (Conductor never runs a login or an install for you). It is labelled **unverified**; assigning it needs an explicit acknowledgement. `conductor doctor --isolation codex --yes` can mark it **blocked** for every role when it sees a violation — but even a *pass* does not lift the label yet: the check's matchers were written from documentation and have never seen a real Codex transcript, so a pass is recorded and shown ("not yet trusted") without changing the tier. *This machine's Codex install is broken (its native binary is missing), so the Codex check has never run against a real binary — everything above is tested against a scripted stand-in.*
- **Model and effort per job (config v6).** Each job can name a model, an effort level and, for Cursor, Fast/Thinking — chosen from what each CLI itself reports (nothing is hard-coded), or a custom model id. "Default model for each tool" replaces the old `agents.<tool>.model` key: a valid old value becomes that tool's default (custom); one that is not a valid model id is set aside in `config.json` under `legacy.v5`, is never used, and Settings and `conductor doctor` tell you to choose again. A choice belongs to the tool it was made for: if another tool runs the job (a fallback, or you switch tools), that tool uses its own default model with your effort fitted. If a saved model is no longer offered, the step runs on the tool default and says so. Settings shows the exact "Runs as …" arguments. A v6 `config.json` is refused by an older build — the pre-upgrade backup in `~/.conductor-backups` is the way back.
- **A provider that is missing, not signed in, or at a usage limit is skipped, visibly** (a note on the card). Only usage-limit / start / sign-in errors move a stage to the next provider; an isolation failure never falls back to a weaker one.

## Seeing the agents work

| Where | What you see |
| --- | --- |
| **Dashboard** | the board, the live log of both agents, the plan, verification, gates, bug cards, notes |
| **Claude app** | "Open in Claude app" runs `claude --desktop --resume <session>` for that run's Claude session |
| **Terminal** | every session has a copyable `claude --resume …` / `agent --resume …` command |
| **Cursor app** | "Open worktree in Cursor" opens the branch. *Headless Cursor CLI chats are not listed by the Cursor app that we could verify.* |

## Safety model (read this once)

- **Local only.** The dashboard listens on `127.0.0.1` only and needs a one-time sign-in link (`npm run open`). The sign-in code never appears on a command line.
- **Claude stages are locked down:** read-only (`Read`, `Grep`, `Glob`), no MCP servers, no skills/plugins, your global Claude rules are not loaded, credential files are denied. Conductor checks this on every run and refuses to continue if the session is not what it asked for.
- **Cursor builds with `--force`** inside a dedicated git worktree in a **v2-only namespace** (`conductor-v2/<key>` branches, `refs/conductor-v2/…`, `.conductor-v2-worktrees`), so v1 and v2 can never touch each other's checkouts. It cannot push (deny rule + environment), but — like any coding agent — it can run commands as you. Only register repos you trust.
- **The builder cannot leave things behind:** git hooks/config are snapshotted and restored around every build; the whole branch (including commits the agent made itself) is scanned for secrets and for changes to protected files (`.claude/`, `.cursor/`, `AGENTS.md`, CI config, …), which are held for you.
- **Briefs are model text.** A "Design the work" brief and its parts are labelled as written by a model; cards made from them always wait for your plan approval (see `docs/ARCHITECTURE.md` for the residual risks). After the first use the board is stored as schema 3: an older Conductor refuses it, and the way back is the `pre-board-v3` backup in `~/.conductor-backups` (cards made since are lost).
- **Your data is versioned and backed up:** every data file carries a version; files from a newer Conductor are refused (never downgraded); an older file is backed up to `~/.conductor-backups` before it is upgraded.
- **Usage limits are handled:** when Claude says "weekly limit", **Cursor takes over the read-only stages automatically** (setting `onClaudeLimit`); repeated limits back off (15 min → 6 h).
- **Which Claude?** Conductor calls the `claude` command-line tool, which is signed in separately from the Claude desktop app. `npm run doctor` shows which account and plan it uses.

## Commands

```
npm start                  run + open the dashboard
npm run open               open a fresh signed-in tab while it's running
npm run demo               scripted demo (no keys / quota)
npm run doctor             check the setup   (--isolation proves Claude is locked down, --probe)
node bin/conductor.mjs doctor --isolation codex --yes     the Codex isolation check (uses quota; marks Codex partial or blocked)
node bin/conductor.mjs doctor --verify-build cursor --yes re-run the live no-push suite on the installed Cursor and record it (uses quota)
node bin/conductor.mjs migrate [--from <dir>] [--to <dir>] [--apply]   import a v1 folder side by side
node bin/conductor.mjs service install|uninstall|status                keep it running in the background (v2's own launchd label)
node bin/conductor.mjs uninstall [--purge]                             remove the service (--purge also deletes a v2 data folder)
npm test                   unit + end-to-end tests (fake agents)
npm run test:live          LIVE=1 tests against the real Cursor CLI (uses a little quota)
```

More: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) · [`docs/API.md`](docs/API.md)
