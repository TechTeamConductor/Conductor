# Conductor

**One master dashboard for Claude Code and Cursor.** Create a Linear issue → **Claude plans it** → **Cursor builds it** → **Claude independently verifies it** → bugs go back to Cursor, automatically, until it passes (or asks you).

You do the thinking; Conductor does the shuffling between the two tools. Everything runs on your Mac, in separate git worktrees. **It never pushes, opens PRs, or merges.**

```
Linear issue (label "conductor")
   │
   ▼  Claude — read-only analysis & plan   (+ independent plan review for bigger changes)
   ▼  plans run automatically — only large plans, or ones touching CI/agent config, wait for your OK
   ▼  Cursor — builds in an isolated worktree
   ▼  Gates (your tests/lint/typecheck) — deterministic ground truth
   ▼  Claude — independent verifier (read-only): acceptance criteria → evidence, bugs
   │      └─ fail → bug sub-issues in Linear → back to Cursor (max 3 loops, then it asks you)
   ▼  "Ready for review" — branch + worktree waiting for you to merge
```

## Quick start (about 5 minutes, once)

1. **Install the two CLIs and sign in** (you probably already have them): Claude Code (`claude`) and the Cursor CLI (`agent login`).
2. **Try it without any keys:** `npm run demo` — opens a dashboard with scripted agents and a fake Linear so you can click around.
3. **Start for real:** `npm start` — the dashboard opens and walks you through setup:
   1. check Claude + Cursor are signed in (one click),
   2. paste a **Linear personal API key** (Linear → Settings → Security & access → Personal API keys),
   3. pick your team → **Create labels** (it shows exactly what it will create; nothing about your workflow statuses changes),
   4. add a repo folder (tests/lint are auto-detected).
4. **Create an issue in Linear, add the label `conductor`, put it in Todo.** Or use **New task** in the dashboard. That's it.

No `npm install` is needed to run it (zero runtime dependencies; Node 22.18+). Optionally keep it running in the background: `node bin/conductor.mjs service install`.

## Everyday use

| You want to… | Do this |
| --- | --- |
| start a task | issue in **Todo** + label `conductor` (created by you), or **New task** in the dashboard |
| approve a plan | usually nothing — plans run automatically. Large (`L`) plans, or plans touching CI/agent config, wait: click **Approve** in the dashboard or comment `/approve` |
| ask a question | create the issue as usual — if no code change is needed, Claude's **answer** is posted as a Linear comment and the issue finishes (no build/verify) |
| answer a question / retry after a failure | comment your answer, then drag the issue back to **Todo** (or click **Retry**) |
| pause an issue without losing work | drag it to **Backlog** (parked; nothing is deleted) |
| stop it | cancel the issue in Linear, or **Abort** |
| review the result | the issue shows **ready**; open the worktree in Cursor from the dashboard, then merge the branch yourself |

Everything Conductor does is also written to the Linear issue as comments, so your team can follow along.

## Seeing the agents work

| Where | What you see |
| --- | --- |
| **Conductor dashboard** (master view) | board of all runs, live log of both agents, plan, verification, gates, bugs |
| **Linear** | status labels, plan/verification comments, bug sub-issues |
| **Claude app** | "Open in Claude app" runs `claude --desktop --resume <session>` for that run's Claude session |
| **Terminal** | every session has a copyable `claude --resume …` / `agent --resume …` command |
| **Cursor app** | "Open worktree in Cursor" opens the branch. *Headless Cursor CLI chats are not listed by the Cursor app that we could verify; native listing needs Cursor Cloud Agents (planned for v1.1).* **1-minute check for you:** after any run, open the Cursor app's Agents/chat history — if you can see the run's chat there, tell us (it changes what v1.1 needs). |

## Safety model (read this once)

- **Local only.** Your Linear key lives in the macOS Keychain. The dashboard listens on `127.0.0.1` only and needs a one-time sign-in link (`npm run open`).
- **Claude stages are locked down:** read-only (`Read`, `Grep`, `Glob`), no MCP servers, no skills/plugins, your global Claude rules are not loaded. Conductor checks this on every run and refuses to continue if the session is not what it asked for.
- **Cursor builds with `--force`** inside a dedicated git worktree. It cannot push (deny rule + environment), but — like any coding agent — it can run commands as you. Only register repos you trust, and only issues **you created** are picked up (not teammates' — see the Linear section of `docs/ARCHITECTURE.md`).
- **Your own global rules** (TechTeam, Cursor rules, …) would normally hijack a headless agent. Claude is isolated from them; Cursor cannot be, so the builder prompt explicitly overrides plan/review/tracker rules, and Conductor holds anything that touches `.claude/`, `.cursor/`, `AGENTS.md`, CI config, etc. for you to look at.
- **Usage limits are handled:** when Claude says "weekly limit", **Cursor takes over the read-only stages automatically** (default `onClaudeLimit: "cursor"`); if you choose "wait" instead, runs pause (not fail) and resume by themselves after the reset. Repeated limits back off (15 min → 6 h) and post one Linear comment per episode.
- **Which Claude?** Conductor calls the `claude` command-line tool, which is signed in separately from the Claude desktop app and can be a different plan. `npm run doctor` and the dashboard show which account and plan it uses; switch with `claude auth logout && claude auth login`.

## Commands

```
npm start                  run + open the dashboard
npm run open               open a fresh signed-in tab while it's running
npm run demo               scripted demo (no keys / quota)
npm run doctor             check the setup   (--isolation proves Claude is locked down, --probe, --linear)
node bin/conductor.mjs service install|uninstall|status   keep it running in the background
node bin/conductor.mjs uninstall [--purge]                remove the service and stored key
npm test                   unit + end-to-end tests (fake agents)
npm run test:live          LIVE=1 tests against the real Cursor CLI (uses a little quota)
```

More: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) · [`docs/API.md`](docs/API.md)
