<div align="center">

<img src="docs/assets/banner.svg" alt="Conductor — Claude plans, Cursor builds, Claude verifies" width="100%">

<br>

![Node](https://img.shields.io/badge/node-%E2%89%A522.18-5fa04e?logo=nodedotjs&logoColor=white)
![Runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-5eead4)
![TypeScript](https://img.shields.io/badge/TypeScript-type%20stripping-3178c6?logo=typescript&logoColor=white)
![Local only](https://img.shields.io/badge/runs-100%25%20local-6f72ff)
![Never pushes](https://img.shields.io/badge/git-never%20pushes%20or%20merges-e5484d)
![Platform](https://img.shields.io/badge/macOS-supported-black?logo=apple)
![Status](https://img.shields.io/badge/status-preview-f5a524)

<!-- Live repo metrics: every badge below is fetched from GitHub/shields.io on page load, nothing is hard-coded. -->
<a href="https://github.com/TechTeamConductor/Conductor/releases"><img src="https://img.shields.io/github/v/release/TechTeamConductor/Conductor?style=flat&label=release" alt="Latest release"></a>
<a href="https://github.com/TechTeamConductor/Conductor/actions/workflows/release.yml"><img src="https://github.com/TechTeamConductor/Conductor/actions/workflows/release.yml/badge.svg" alt="Release workflow"></a>
<a href="https://github.com/TechTeamConductor/Conductor/stargazers"><img src="https://img.shields.io/github/stars/TechTeamConductor/Conductor?style=flat&logo=github&label=stars" alt="GitHub stars"></a>
<a href="https://github.com/TechTeamConductor/Conductor/forks"><img src="https://img.shields.io/github/forks/TechTeamConductor/Conductor?style=flat&logo=github&label=forks" alt="GitHub forks"></a>
<a href="https://github.com/TechTeamConductor/Conductor/watchers"><img src="https://img.shields.io/github/watchers/TechTeamConductor/Conductor?style=flat&logo=github&label=watchers" alt="GitHub watchers"></a>
<a href="https://github.com/TechTeamConductor/Conductor/graphs/contributors"><img src="https://img.shields.io/github/contributors/TechTeamConductor/Conductor?style=flat&label=contributors" alt="Contributors"></a>
<a href="https://github.com/TechTeamConductor/Conductor/commits/main"><img src="https://img.shields.io/github/commit-activity/w/TechTeamConductor/Conductor?style=flat&label=commits%20%2F%20week" alt="Commits per week"></a>
<a href="https://github.com/TechTeamConductor/Conductor/commits/main"><img src="https://img.shields.io/github/last-commit/TechTeamConductor/Conductor?style=flat&label=last%20commit" alt="Last commit"></a>
<a href="https://github.com/TechTeamConductor/Conductor/issues"><img src="https://img.shields.io/github/issues/TechTeamConductor/Conductor?style=flat&label=issues" alt="Open issues"></a>
<a href="https://github.com/TechTeamConductor/Conductor"><img src="https://img.shields.io/github/languages/top/TechTeamConductor/Conductor?style=flat&label=top%20language" alt="Top language"></a>
<a href="https://github.com/TechTeamConductor/Conductor"><img src="https://img.shields.io/github/repo-size/TechTeamConductor/Conductor?style=flat&label=repo%20size" alt="Repo size"></a>

**[Quick start](#quick-start)** · **[What you get](#what-you-get)** · **[How it works](#how-it-works)** · **[Screens](#screens)** · **[Safety](#safety-model)** · **[Status](#status)** · **[Docs](#documentation)**

</div>

---

# Conductor

> **Type one line. Claude plans it, Cursor builds it, Claude checks it, and you merge it.**
> One local dashboard that runs your AI coding CLIs as a team, with its own board, and never touches `git push`.

You do the thinking. Conductor does the shuffling between tools: it plans, splits work into dependent tasks, builds in an **isolated git worktree**, runs **your** tests as ground truth, has a **second agent verify** the result, and sends bugs back automatically, up to three times, before it asks you.

```text
   "Add filters by user and date to the audit log"
        │
        ▼  Claude   reads a read-only snapshot, writes the plan   (+ independent plan review for bigger changes)
        ▼  You      approve only what is large, risky or came from model-written text
        ▼  Cursor   builds in its own worktree and branch
        ▼  Gates    your tests · lint · typecheck — deterministic, not an opinion
        ▼  Claude   verifies every acceptance criterion against evidence
        │              └─ bugs? → bug cards → back to Cursor (max 3 loops, then it asks you)
        ▼  Ready for review — a branch waiting for you. Conductor never merges it.
```

## Why Conductor?

- **A second pair of eyes.** The tool that writes the code is never the tool that signs it off.
- **Your tests decide.** Gates run your repo's own checks; the verifier must cite evidence, not vibes.
- **It stays on your machine.** Loopback only, one-time sign-in link, cookie + CSRF. No cloud, no tracker, no account.
- **Safe by construction.** The builder works in a worktree, cannot push, and its branch is scanned for secrets and protected files before you ever see it.
- **Bring your own tools.** Claude Code and Cursor today; roles, models and effort are configurable per job, discovered from the CLIs themselves, never hard-coded.
- **Zero runtime dependencies.** Plain Node. Nothing to `npm install` to run it.

## What you get

| | Feature | What it does |
| --- | --- | --- |
| 💬 | **Home composer** | One box for everything. **Auto** picks Ask, Build or Research from your line, or you choose. Answers appear as a thread, with the branch and commit they were based on. |
| ❓ | **Quick Ask** | Questions about your code, answered from a read-only snapshot with file citations. No task, no worktree. "Turn into a task" when you want a change. |
| 🧭 | **Design the work** | One line → repo check → detailed brief → up to **8 ordered parts with dependencies** → untick what you don't want → **Send N tasks** as linked cards. Always waits for your approval. |
| 🔎 | **Deep Research** | Web-only research in an empty folder: a short brief you review, Standard or Deep depth, and a report where every source is marked **Opened**, **Listed** or **Unverified**. |
| 🗂️ | **Native board** | Backlog · To do · working stages · Needs you · Ready for review. Task graphs, dependencies, notes, retries. No Linear. |
| 🎛️ | **Who does what** | Seven jobs, each with a **tool · model · effort**. A "Runs as …" line shows the exact command it becomes. |
| 🔌 | **Model discovery** | Conductor asks each CLI which models it offers, per account. Stale lists are marked, never invented. |
| 👥 | **Several accounts per tool** | At a usage limit it moves to the next account, then the next tool *in that job's list*, or waits. Pauses and resumes by itself. |
| ⚡ | **Run mode** | **Per settings** or **Complete auto**. Complete auto never removes a safety hold. Large, risky, protected-path and model-written plans still ask. |
| 🧠 | **Project context** | A local, incremental index of your repo so agents don't rescan it every time. Works offline. |
| 🛡️ | **Approval policies** | `full-auto` · `approve-plan` · `approve-risky` · `manual-stages`, per project, with forced holds no setting can remove. |

## Install

You need **Node.js 22.18 or newer** ([nodejs.org](https://nodejs.org)) and the CLIs you already use (Claude Code and Cursor). Then one command installs Conductor, and one command starts it.

**macOS** (Terminal):

```bash
curl -fsSL https://github.com/TechTeamConductor/Conductor/releases/latest/download/install.sh | bash
```

**Windows** (PowerShell, **experimental**, see below):

```powershell
irm https://github.com/TechTeamConductor/Conductor/releases/latest/download/install.ps1 | iex
```

**Start it** (opens the dashboard UI in your browser):

```bash
conductor start
```

That's it. Try it without any keys first with `conductor demo`, and check your setup with `conductor doctor`.

| | |
| --- | --- |
| **Update** | `conductor update` (it checks for a newer release, verifies it and installs it; stop Conductor first with `conductor stop`). Or run the install command again. On Windows, Ctrl+C in its terminal, then run the install command again. |
| **Stop / restart** | `conductor stop` stops the running Conductor and frees its port. `conductor restart` stops it and starts it again. |
| **Uninstall** | macOS: `curl -fsSL https://github.com/TechTeamConductor/Conductor/releases/latest/download/install.sh \| bash -s -- --uninstall`. Windows: `$env:CONDUCTOR_UNINSTALL='1'; irm https://github.com/TechTeamConductor/Conductor/releases/latest/download/install.ps1 \| iex; Remove-Item Env:CONDUCTOR_UNINSTALL`. Your data (`~/.conductor-v2`) is never deleted by it. |
| **Where it goes** | The app is unpacked into `~/.conductor-app` (Windows: `%LOCALAPPDATA%\Conductor\app`) and a `conductor` launcher into `~/.local/bin` (Windows: `%LOCALAPPDATA%\Conductor\bin`, added to your user PATH). If `~/.local/bin` is not on your PATH, the installer prints the one line to add. |
| **Safe by design** | HTTPS only, the download is checked against `SHA256SUMS.txt` before anything is unpacked (this catches corrupted downloads; what you trust is HTTPS plus this GitHub repository), no `sudo`, no edits to your shell profile on macOS. Prefer to read first? Download `install.sh` from the release page, read it, and run `bash install.sh`. |
| **Pin a version** | macOS: `curl -fsSL https://github.com/TechTeamConductor/Conductor/releases/latest/download/install.sh \| CONDUCTOR_INSTALL_VERSION=1.2.3 bash` (the variable goes in front of `bash`, not `curl`). Windows: `$env:CONDUCTOR_INSTALL_VERSION='1.2.3'; irm https://github.com/TechTeamConductor/Conductor/releases/latest/download/install.ps1 \| iex`. |

> **Windows is experimental.** The installer and the dashboard are checked in CI for each release (the release notes say whether that check passed), but registering repositories, running gates and launching the `claude` / `agent` CLIs are not ported to native Windows yet. For the full product use **WSL2** (open Ubuntu and run the macOS command inside it) or a Mac. **Linux** uses the macOS command and is experimental too.

## Quick start

```bash
# 1. Sign in to your tools (you probably already have)
claude            # Claude Code: run once and sign in
agent login       # Cursor CLI

# 2. Try it with scripted agents. No keys, no quota
conductor demo

# 3. Start for real
conductor start   # opens the dashboard and walks you through setup
```

The dashboard checks that Claude and Cursor are signed in, asks you to add a repository folder (tests and lint are auto-detected), and you're ready. Press **Home**, write one line, and go.

| Where | What |
| --- | --- |
| Data | `~/.conductor-v2` (override with `CONDUCTOR_HOME`) |
| Port | `4327` (loopback only, `conductor start --port <n>` to change) |
| Reopen the dashboard | `conductor open` (a fresh signed-in tab while it is running) |
| Coming from v1? | `conductor migrate` (dry run first). v1 and v2 run side by side and v2 never writes to v1's folder |
| Running from a clone | Contributors: `git clone`, then `npm start` / `npm run demo` / `npm run open` do the same as `conductor start` / `demo` / `open` |
| Desktop apps | Parked for a later phase (a macOS `.dmg` and Windows `.exe` can be built by hand, see [`docs/DESKTOP.md`](docs/DESKTOP.md)) |

## Screens

<table>
<tr>
<td width="50%"><img src="docs/assets/home-desktop-dark.png" alt="Home: one composer, three modes, your tools"><br><sub><b>Home.</b> One composer: Auto, Ask, Build or Research.</sub></td>
<td width="50%"><img src="docs/assets/board-desktop-dark.png" alt="The board"><br><sub><b>Board.</b> Cards move by themselves as the agents work.</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/assets/turn-build-desktop-dark.png" alt="A Build request becomes a card"><br><sub><b>Build.</b> A line becomes a planned, gated task.</sub></td>
<td width="50%"><img src="docs/assets/report-desktop-dark.png" alt="A research report with sources marked Opened, Listed or Unverified"><br><sub><b>Research.</b> Every source is marked Opened, Listed or Unverified.</sub></td>
</tr>
<tr>
<td colspan="2"><img src="docs/assets/settings-desktop-dark.png" alt="Settings: who does what, with tool, model and effort"><br><sub><b>Settings.</b> Tool · model · effort per job, with the exact command it runs as.</sub></td>
</tr>
</table>

<sub>Screenshots come from the built-in demo with scripted agents.</sub>

## How it works

```mermaid
flowchart LR
    A([Your line]) --> B{Mode}
    B -->|Ask| Q[Read-only snapshot<br/>answer + citations]
    B -->|Research| R[Web-only session<br/>sourced report]
    B -->|Build| P[Claude plans<br/>read-only]
    P --> H{Approval?}
    H -->|large · risky · model-written| U[You approve]
    H -->|safe| W
    U --> W[Cursor builds<br/>isolated worktree]
    W --> G[Your gates<br/>tests · lint · types]
    G --> V[Claude verifies<br/>criteria → evidence]
    V -->|bugs, ≤ 3 loops| W
    V -->|pass| D([Ready for review<br/>you merge])
```

**Roles, not hard-wired tools.** Every job (planning, review, verification, implementation, debugging, documentation, requirements, context, architecture, research) has an ordered list of providers. Who may hold which job is decided by **code, not a setting**: a job that writes code accepts only a tool whose no-push isolation has been proven.

| Provider | Plans · reviews · verifies | Builds code | Research | Status |
| --- | :---: | :---: | :---: | --- |
| **Claude Code** | ✅ read-only, locked down | 🔒 locked | ✅ web-only profile | Supported |
| **Cursor** | ✅ fallback for read-only stages | ✅ proven by a live adversarial suite | 🔒 locked | Supported |
| **Codex** | ⚠️ optional, read-only, *unverified* | 🔒 locked | 🔒 locked | Experimental |

<sub>🔒 = refused with the real reason, until its own isolation profile and live suite exist.</sub>

## Safety model

Conductor assumes the model can be wrong, and that text it writes can be hostile.

| Rule | How |
| --- | --- |
| **Local only** | Listens on `127.0.0.1`, one-time sign-in link, `HttpOnly` cookie, CSRF on every change. |
| **Read-only stages stay read-only** | Claude runs with `Read`, `Grep`, `Glob` only: no MCP, skills or plugins; credential files denied. A **fail-closed startup check** refuses to continue if the session isn't what was asked for. |
| **The builder cannot push** | Own worktree and branch in a v2-only namespace, deny rule plus environment. Git hooks and config are snapshotted and restored around every build. |
| **Branches are scanned** | Secrets and changes to protected files (`.claude/`, `.cursor/`, `AGENTS.md`, CI config…) are **held for you**. |
| **Model text is untrusted** | Briefs, research and answers are labelled as model-written. Cards made from them **always wait for your approval**, under every policy and mode. |
| **Nothing leaks across accounts** | Each child process gets an allow-listed environment; credentials never reach another account's process, config, logs or UI. |
| **Everything is redacted** | Every agent-derived string is scrubbed before it reaches the board, logs or UI. |
| **Data is versioned and backed up** | Newer files are refused, never downgraded. Older files are backed up before an upgrade. |

Read the safety section of the [full guide](docs/GUIDE.md#safety-model-read-this-once) once before pointing it at a repo.

> **Heads-up.** Like any coding agent, Cursor can run commands as you inside the worktree. Only register repositories you trust.

## Status

**Preview.** Honest labels, no overclaiming:

| Area | State |
| --- | --- |
| Board, planning, build, verify, bug loops | ✅ Done |
| Task graphs, project context, offline mode | ✅ Done |
| Quick Ask, Deep Research, Design the work | ✅ Done (one opt-in live check still pending) |
| Model and effort per job, model discovery | ✅ Done |
| Several accounts, limit rules, run mode | ✅ Done, but **signing in extra accounts is switched off** until its live checks pass |
| New UI (Home, Board, Settings) | ✅ Done and browser-checked on the demo |
| macOS | ✅ One-command install (`install.sh`), then `conductor start` |
| Windows | 🟡 **Experimental**: one-command install (`install.ps1`) and the dashboard work; registering repos, gates and launching the `claude` / `agent` CLIs are not ported yet (use WSL2 or a Mac) |
| Linux | 🟡 **Experimental**: the same installer as macOS; only install and dashboard start are checked in CI |
| Desktop apps (`.dmg`, `.exe`) | ⬜ Parked for a later phase (signing and notarization first) |
| Codex as a builder · Cursor/Codex research | ⬜ Locked on purpose, one pairing at a time |
| Codex on a real install | ⚠️ Not yet exercised against a real Codex binary |

Tested with scripted fake agents and real git: **1,000+ tests, no network, no quota.** Live tests against the real Cursor CLI are opt-in (`npm run test:live`).

## Commands

```bash
conductor start                # run + open the dashboard (--no-open, --port <n>)
conductor open                 # open a fresh signed-in tab while it's running
conductor stop                 # stop the running Conductor (frees its port); --port <n> stops the Conductor on that port, --force as a last resort
conductor restart              # stop it and start it again (same port)
conductor update [--check]     # update to the latest release (--check only reports)
conductor demo                 # scripted agents, no keys, no quota
conductor doctor               # check the setup  (--isolation proves Claude is locked down)
conductor models [--refresh]   # what each CLI says it offers
conductor accounts list | add | check | move | remove
conductor migrate [--apply]    # import a v1 folder side by side
conductor service install | uninstall | status   # keep it running (macOS launchd only)
conductor uninstall [--purge]  # remove the background service (--purge also deletes your data folder)
conductor version
```

`conductor uninstall` removes the background service (and, with `--purge`, your data). To remove the app itself use the installer's uninstall (see [Install](#install)).

Contributors running from a clone: `npm start`, `npm run open`, `npm run demo`, `npm run doctor`, `npm test` (unit + end-to-end tests with fake agents) and `npm run check` (type check).

## Documentation

| Read | For |
| --- | --- |
| [**Full guide**](docs/GUIDE.md) | Everyday use, roles and providers, accounts, every command, the whole safety model |
| [Architecture](docs/ARCHITECTURE.md) | Modules, data on disk, the router, known limits |
| [API](docs/API.md) | Every endpoint, the transport and security rules the UI follows |
| [Releases and installers](docs/DESKTOP.md) | How versions and releases are made, how the installers work, and the parked desktop apps |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | When something looks wrong |

## Star history

<a href="https://www.star-history.com/#TechTeamConductor/Conductor&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=TechTeamConductor/Conductor&type=Date&theme=dark" />
    <img src="https://api.star-history.com/svg?repos=TechTeamConductor/Conductor&type=Date" alt="Star history chart" width="100%" />
  </picture>
</a>

## Built with

Plain **Node ≥ 22.18** running **TypeScript by type stripping** (erasable syntax only, no build step) and a vanilla-JS dashboard. **Zero runtime dependencies**. The only dev dependencies are `typescript` and `@types/node`. Prompts are plain files in [`prompts/`](prompts/): edit them there, not in code.

---

<div align="center">

**Local · reviewed · reversible**

<sub>Nothing is pushed, opened as a PR, or merged unless you do it yourself.</sub>

</div>