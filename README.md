# Conductor (v2 preview)

**One dashboard for Claude Code and Cursor, with its own board.** Create a task → **Claude plans it** → **Cursor builds it** → **Claude independently verifies it** → bugs go back to Cursor, automatically, until it passes (or asks you).

You do the thinking; Conductor does the shuffling between the two tools. Everything runs on your computer, in separate git worktrees. **It never pushes, opens PRs, or merges.** There is no external tracker: the board is built in and stored locally.

> **Status.** This is the v2 line (see `.techteam/plans/workspace-v2*.md` for the roadmap). Done so far: the native board (Linear removed), versioned data with backups, side-by-side import of v1 data. Planned next: more providers (Codex), per-role tool assignment, task decomposition, a project-context engine, Quick Ask / Deep Research modes, onboarding for three CLIs, desktop installers (Windows `.exe`, Linux `.deb`). Nothing in that second list exists yet.

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
| approve a plan | usually nothing — plans run automatically. Large (`L`) plans, plans touching CI/agent config, and imported cards wait: press **Approve plan** |
| ask a question | create the card as usual — if no code change is needed, Claude's **answer** appears as a note on the card and it finishes (no build/verify) |
| answer a question / retry after a failure | add a **note** on the card (your notes are read by the next plan), then press **Retry** |
| pause a card without losing work | **Park in Backlog** (nothing runs); **Move to To do** restarts it, re-planning but keeping the work |
| stop it | **Abort run** (or **Cancel** on a card that has not started) |
| finish it | review the branch in the worktree, merge it yourself, then **Mark done** |

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
- **Your data is versioned and backed up:** every data file carries a version; files from a newer Conductor are refused (never downgraded); an older file is backed up to `~/.conductor-backups` before it is upgraded.
- **Usage limits are handled:** when Claude says "weekly limit", **Cursor takes over the read-only stages automatically** (setting `onClaudeLimit`); repeated limits back off (15 min → 6 h).
- **Which Claude?** Conductor calls the `claude` command-line tool, which is signed in separately from the Claude desktop app. `npm run doctor` shows which account and plan it uses.

## Commands

```
npm start                  run + open the dashboard
npm run open               open a fresh signed-in tab while it's running
npm run demo               scripted demo (no keys / quota)
npm run doctor             check the setup   (--isolation proves Claude is locked down, --probe)
node bin/conductor.mjs migrate [--from <dir>] [--to <dir>] [--apply]   import a v1 folder side by side
node bin/conductor.mjs service install|uninstall|status                keep it running in the background (v2's own launchd label)
node bin/conductor.mjs uninstall [--purge]                             remove the service (--purge also deletes a v2 data folder)
npm test                   unit + end-to-end tests (fake agents)
npm run test:live          LIVE=1 tests against the real Cursor CLI (uses a little quota)
```

More: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) · [`docs/API.md`](docs/API.md)
