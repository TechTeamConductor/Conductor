# Conductor — the full guide

**One dashboard for Claude Code and Cursor, with its own board.** Create a task → **Claude plans it** → **Cursor builds it** → **Claude independently verifies it** → bugs go back to Cursor, automatically, until it passes (or asks you).

You do the thinking; Conductor does the shuffling between the two tools. Everything runs on your computer. **The builder never pushes, and Conductor does not switch or merge branches.** **Ship** is the only code that pushes. Under **Complete auto**, once you have accepted the Complete auto confirmation (asked once), Ship pushes each finished card to the branch currently checked out in the repository, on that repository’s push remote (default `origin`), by commit id, as the git name and email you had configured before the build started, with the ticket key at the start of every commit subject. It never pushes to your default branch, a protected name (`main`, `master`, `develop`, `release…`), a detached HEAD, or by force; if the checked-out branch cannot be used (protected, default, detached, or the remote has moved on) it pushes to `conductor/<branch>` instead and the card says where it went. Only commits Conductor made are pushed, after the secret and protected-file scans. Outside Complete auto nothing is pushed until you click **Push** on a Done card, which goes through the same Ship checks. A card that cannot be pushed (no remote, a secret-looking value, a commit of your own below it, an agent name) stays **Done** and says why on the card; **Retry** tries the push again, and **Unblock dependants** lets waiting cards start anyway. To stop a repository from ever pushing, set its push remote to none. There is no external tracker: the board is built in and stored locally.

> **Status.** Built: the native board (no Linear), versioned data with backups, side-by-side import of v1 data, roles and providers, model and effort per job, model discovery, task graphs, a project-context engine, Quick Ask / Deep Research, approval policies, several accounts per tool, run mode, "Design the work", one-command installers for macOS (supported) and Windows / Linux (experimental). Not built: signed desktop apps, Codex as a builder, sign-in for extra accounts. See the [README](../README.md) for the overview.

```
Task card (To do)
   │
   ▼  Claude — read-only analysis & plan   (+ independent plan review for bigger changes)
   ▼  plans run automatically — only large plans, ones touching CI/agent config, or imported/unverified text wait for your OK
   ▼  Cursor — builds in an isolated worktree
   ▼  Gates (your tests/lint/typecheck) — deterministic ground truth
   ▼  Claude — independent verifier (read-only): acceptance criteria → evidence, bugs
   │      └─ fail → bug cards on the board → back to Cursor (max 3 loops, then the Stuck resolver decides)
   ▼  Done — then Pushed: Ship pushes the checked-out branch as you (Complete auto, after your one-time consent), or you click Push
```

## Quick start (about 5 minutes, once)

1. **Install Conductor** (needs Node.js 22.18 or newer). macOS, in Terminal: `curl -fsSL https://github.com/TechTeamConductor/Conductor/releases/latest/download/install.sh | bash`. Windows (experimental), in PowerShell: `irm https://github.com/TechTeamConductor/Conductor/releases/latest/download/install.ps1 | iex`. Update later with `conductor update` (or run the same command again); `conductor stop` / `conductor restart` stop and restart it. Details, uninstall and pinning a version: the [README](../README.md#install) and [`DESKTOP.md`](DESKTOP.md).
2. **Install the two CLIs and sign in** (you probably already have them): Claude Code (`claude`) and the Cursor CLI (`agent login`).
3. **Try it without any keys:** `conductor demo` — a dashboard with scripted agents so you can click around.
4. **Start for real:** `conductor start` — the dashboard opens in your browser and walks you through two steps: check Claude + Cursor are signed in, then add a repo folder (tests/lint are auto-detected).
5. **Press New task.** That's it. Cards live on the board (Backlog · To do · Queued · Planning · Plan review · Building · Verifying · Stuck resolver · Done · Pushed).

Zero runtime dependencies, nothing else to install. Data lives in `~/.conductor-v2` (override with `CONDUCTOR_HOME`); the default port is 4327.

> **Windows is experimental.** The installer and the dashboard are checked in CI for each release (the release notes say whether that check passed), but registering repositories, running gates and launching the `claude` / `agent` CLIs are not ported to native Windows yet. Use WSL2 (run the macOS command inside Ubuntu) or a Mac for the full product. Linux uses the macOS command and is experimental.

Working from a clone instead (contributors)? `npm start`, `npm run open` and `npm run demo` do the same as `conductor start` / `open` / `demo`.

### Coming from Conductor v1 (Linear)?

v1 and v2 run **side by side**: v2 never writes to the v1 folder (`~/.conductor`); `migrate` refuses a `--to` that is inside it (or the reverse).

```
conductor migrate            # dry run: shows exactly what would be imported, writes nothing
conductor migrate --apply    # creates ~/.conductor-v2 (built aside, then one rename) and a backup copy in ~/.conductor-backups (kept until YOU delete it; it holds your v1 run records and plan/verdict files)
```

Every v1 run becomes a card (keys kept, e.g. `BAR-363`). Anything that was still active in v1 shows up in **Stuck resolver** — v2 never starts the same work twice; press Retry to run it in v2. **Every imported card is treated as unverified text**: v1's approval is dropped, and when you press Retry (or move it to To do) it starts again at the **plan**, which waits for your approval before anything is built. The dry run also lists exactly what the imported settings will *run* on your machine (gate and setup commands, agent binaries, environment variables, copied files) — only migrate a folder you created. Files over 50 MB, symlinks and non-regular files in the v1 folder are skipped with a warning, never read. Nothing is ever written to Linear, and your old Linear key stays in the macOS Keychain until you delete it yourself.

## Everyday use

| You want to… | Do this |
| --- | --- |
| start a task | **New task** (it starts right away), or create a card in *Backlog* and press **Start** later |
| design a bigger change first | **Home → Build**: Conductor checks your line against a read-only copy of the repo, writes a detailed brief and splits it into up to 8 tasks. Untick what you don't want and press **Send N tasks**. Every task made this way is model-written, so its plan **always waits for your approval**. A task that depends on another starts after that one is Done; tasks with no such dependency can run together |
| ask about your code | **Home → Ask**: a quick answer from a read-only copy of the repo, with the files it relied on. Ask **follow-up questions** in the same thread ("why?", "what about the tests?"): the answered Ask just above is kept as context (up to 4 earlier question/answer pairs, in the same repository), and the answer shows a **Follow-up** tag. The line under the box says when the next question continues the conversation; press **New topic** to start fresh (**Clear** also resets it). A Build or Research turn in between, another repository, or a failed answer starts a new conversation. Use the **copy icon** on an answer or a research report to copy it as plain text |
| ask or research online, or against your code | The **Code | Online** toggle in the composer picks where a request looks. **Code**: *Ask* (quick answer from a read-only copy of the repo), *Build*, and *Research* = a deeper investigation of your repository with a cited report in which every cited file, line and quote is checked against the copy (marked **Verified** or **Unverified**; costs 3 of the hourly question budget, one at a time). **Online**: *Ask* = a quick web-searched answer with its sources marked Opened / Listed / Unverified (no repository is read), and *Research* = the Deep Research brief and web report below. **Build is not offered when Online is selected**, and **Auto** never starts code research (use the Research chip). Your choice is remembered per browser tab |
| research before deciding | **Home → Research**: Claude first writes a short research brief from your question only (no repository access); check it, pick Standard or Deep (Deep takes longer and counts as two of the day's research runs), then **Send as a research task** |
| approve a plan | usually nothing — plans run automatically. Large (`L`) plans, plans touching CI/agent config, and imported cards wait: press **Approve plan** |
| ask a question | create the card as usual — if no code change is needed, Claude's **answer** appears as a note on the card and it finishes (no build/verify) |
| work on a bigger change | nothing special — if the plan splits it into tasks, a **Tasks** tab shows them (one card per task under the run's card). Tasks that do not share files and do not depend on each other build at the same time, up to the parallel cap. Each is gated by your repo's tests; if one fails, the others that don't depend on it continue, and **Retry** re-runs only the failed ones. Plans with more than 8 tasks wait for your approval |
| answer a question / retry after a failure | add a **note** on the card (your notes are read by the next plan), then press **Retry** |
| pause a card without losing work | **Park in Backlog** (nothing runs); **Move to To do** restarts it, re-planning but keeping the work |
| stop it | **Abort run** (or **Cancel** on a card that has not started) |
| finish it | review the branch in the worktree, merge it yourself, then **Mark done** |

## Providers and roles

Every job has a **role** (planning, review, verification, implementation, debugging, documentation, requirements, context, architecture, research) and each role has an **ordered list of providers**. The defaults are exactly what v1 did: Claude plans, reviews and verifies (Cursor takes over those read-only stages if Claude is at its usage limit, or not installed / signed in), Cursor builds. The Settings panel still shows the simple choices; behind it `GET/PUT /api/roles` (see [`API.md`](API.md)) assign providers per role.

- **Who may hold which role is decided by code, not by a setting.** A role that writes code (implementation, debugging, documentation) accepts only a provider whose no-push isolation has been *proven* — today only Cursor (proven by the live adversarial suite). Everything else is refused with the reason.
- **Codex is optional and read-only.** It is in no default chain. It runs in Conductor's **own private Codex home** (`~/.conductor-v2/providers/codex-home`), never your `~/.codex` — so your hooks, MCP servers and rules are not in play. Sign in yourself, once: `CODEX_HOME=~/.conductor-v2/providers/codex-home codex login` (Conductor never runs a login or an install for you). It is labelled **unverified**; assigning it needs an explicit acknowledgement. `conductor doctor --isolation codex --yes` can mark it **blocked** for every role when it sees a violation — but even a *pass* does not lift the label yet: the check's matchers were written from documentation and have never seen a real Codex transcript, so a pass is recorded and shown ("not yet trusted") without changing the tier. *The Codex check has not yet been run against a real Codex binary — everything about it is written from the vendor documentation and tested against a scripted stand-in.*
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

- **Local only.** The dashboard listens on `127.0.0.1` only and has **no login**: any process or user on this machine can use it, including the Complete auto switch and the push remote (`confirm` is friction, not authentication). Websites in your browser are blocked by `Host`/`Origin` checks and a CSRF header. Do not run Conductor on a shared machine.
- **Claude stages are locked down:** read-only (`Read`, `Grep`, `Glob`), no MCP servers, no skills/plugins, your global Claude rules are not loaded, credential files are denied. Conductor checks this on every run and refuses to continue if the session is not what it asked for.
- **Cursor builds with `--force`** inside a dedicated git worktree in a **v2-only namespace** (`conductor-v2/<key>` branches, `refs/conductor-v2/…`, `.conductor-v2-worktrees`), so v1 and v2 can never touch each other's checkouts. It cannot push (deny rule + environment), but — like any coding agent — it can run commands as you. Only register repos you trust.
- **The builder cannot leave things behind:** git hooks/config are snapshotted and restored around every build; the whole branch (including commits the agent made itself) is scanned for secrets and for changes to protected files (`.claude/`, `.cursor/`, `AGENTS.md`, CI config, …), which are held for you.
- **Briefs are model text.** A "Design the work" brief and its parts are labelled as written by a model; cards made from them always wait for your plan approval (see [`ARCHITECTURE.md`](ARCHITECTURE.md) for the residual risks). After the first use the board is stored as schema 3: an older Conductor refuses it, and the way back is the `pre-board-v3` backup in `~/.conductor-backups` (cards made since are lost).
- **Your data is versioned and backed up:** every data file carries a version; files from a newer Conductor are refused (never downgraded); an older file is backed up to `~/.conductor-backups` before it is upgraded.
- **Usage limits are handled:** when Claude says "weekly limit", **Cursor takes over the read-only stages automatically** (setting `onClaudeLimit`); repeated limits back off (15 min → 6 h).
- **Which Claude?** Conductor calls the `claude` command-line tool, which is signed in separately from the Claude desktop app. `npm run doctor` shows which account and plan it uses.

## Several accounts per tool

Settings → "Accounts and limits", or `conductor accounts list | add <claude|cursor> --name "Work" | check [<id>] | move <id> up|down | remove <id> [--keep-signin]`. Your own sign-in is the `default` account and nothing changes for it. At a usage limit, Conductor moves to the next account, then to the next tool, but only to a tool that is in that job's list. You can change this to "same tool only" or "wait". Signing extra accounts in (`conductor accounts login <id>`) is not enabled yet: it waits for a live check. Read "Accounts per tool" in [`ARCHITECTURE.md`](ARCHITECTURE.md) before you add one.

## Commands

```
conductor start            run + open the dashboard   (--no-open, --port <n>)
conductor stop             stop the running Conductor and free its port   (--port <n>: the Conductor on that port, --force)
conductor restart          stop it and start it again on the same port
conductor update           update to the latest release   (--check only reports; stop Conductor first)
conductor demo             scripted demo (no keys / quota)
conductor doctor           check the setup   (--isolation proves Claude is locked down, --probe)
conductor doctor --isolation codex --yes      the Codex isolation check (uses quota; marks Codex partial or blocked)
conductor doctor --verify-build cursor --yes  re-run the live no-push suite on the installed Cursor and record it (uses quota)
conductor migrate [--from <dir>] [--to <dir>] [--apply]   import a v1 folder side by side
conductor service install|uninstall|status    keep it running in the background (macOS only; v2's own launchd label)
conductor uninstall [--purge]                 remove the service (--purge also deletes a v2 data folder)
conductor version
```

The installer's own uninstall (removes the app, never your data) is described in the [README](../README.md#install). Contributors working from a clone also have:

```
npm test                   unit + end-to-end tests (fake agents)
npm run test:live          LIVE=1 tests against the real Cursor CLI (uses a little quota)
```

More: [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) · [`API.md`](API.md) · [`DESKTOP.md`](DESKTOP.md)

## Stuck resolver, in short

- Under **Complete auto**, a card that would stop (the verifier cannot pass because the repo was already red, a merge refused over untracked files, a test fixture flagged as a secret, an empty build, a loop limit) first goes to the **Stuck resolver**. It asks a read-only model what is wrong and applies **one action from a closed list**: retry a stage, replan, rebuild with named bugs, accept a red baseline, rewrite a flagged fixture to a placeholder, revert or exclude paths from the run's own diff, switch to another configured tool or account, extend a budget once, wait up to 60 minutes, or give up.
- It is bounded: at most 3 resolver runs per card (1 per cause and stage, 2 per cause), 12 per hour across all cards, and a `give_up` leaves the card in the **Stuck resolver** column with the analysis until you act. Under **Per settings** the resolver never runs and the card stops as before.
- It fixes the cause and never turns a safety check off. It cannot touch the scan, your git identity, the push target or any setting, cannot move a card to Done or Pushed, and never resumes a card you parked.
- Things only you can supply (an expired sign-in, no git identity, no network) stay in the column with the exact reason and are retried automatically.

## Pushing, in short

- Complete auto is on by default for a new install: it approves and builds plans, including protected files and large changes, without asking. An install that already had a config file keeps Per settings until you switch. To use Per settings, choose it in the run-mode control at the top of the board.
- Complete auto pushes finished work only after you accept the Complete auto confirmation once (an existing install in Complete auto asks again on upgrade because the text changed). Per settings never pushes by itself.
- It pushes the branch checked out in the repository, as you, with the ticket key in the commit subject; to `conductor/<branch>` when that branch is protected, the default, detached, or has moved on. Never by force.
- Cards that depend on another wait until it is **Pushed**. If the push is held (no remote, scan, identity), they start on the code already on your checkout instead of waiting forever.
- A credential-looking string that only appears in a test or fixture file does not stop the build; the push scan catches it, the fixture is rewritten to a placeholder once, and the pushed commits never contain it.
- Your own untracked files in the checkout are never deleted, stashed or pushed, and Conductor never resets or checks out your branch. Your local branch and the remote may differ afterwards.
- A repository with no push remote (`pushRemote` set to none) never pushes: this is the per-repository kill switch.
- Server-side branch protection on your default branch is still recommended: a secret shape the scan does not know cannot be recalled once pushed.
