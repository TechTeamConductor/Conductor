# Troubleshooting

## Installing and starting

**"`conductor`: command not found" after installing.** The launcher folder is not on your PATH yet. macOS/Linux: run it by full path (`~/.local/bin/conductor start`) or add the line the installer printed to `~/.zshrc` (or `~/.bashrc`) and open a new terminal. Windows: the installer added the folder to your user PATH, but only new terminals see it, so open a **new** PowerShell window.

**"Node.js 22.18 or newer is required".** Install a newer Node from [nodejs.org](https://nodejs.org) (macOS: `brew install node`; Windows: `winget install OpenJS.NodeJS.LTS`; or `nvm install 22`), open a new terminal and run the install command again. Check with `node -v`.

**The install command fails with "could not find the latest release".** There is no published release yet, or the repository is private (the download links only work for everyone once the repository is public). Pin a version if you know one exists: macOS `curl -fsSL <install.sh url> | CONDUCTOR_INSTALL_VERSION=1.2.3 bash` (the variable goes in front of `bash`), Windows `$env:CONDUCTOR_INSTALL_VERSION='1.2.3'; irm <install.ps1 url> | iex`.

**"checksum mismatch … Nothing was installed."** The download did not match `SHA256SUMS.txt` (a corrupted or tampered download). Run the command again; if it keeps failing, do not use that release and report it.

**"Another install seems to be running (or crashed)".** Delete the `.conductor-install.lock` file or folder the message names (it sits next to the install folder) and run the command again.

**"another `conductor` already exists … not created by this installer".** Something else is called `conductor` in the launcher folder. Move it away and run the command again. The installer never overwrites files it did not create.

**"Conductor cannot run from inside a node_modules folder".** Conductor was installed with `npm install -g` or `npx`. Node cannot run its TypeScript there. Use the installer instead (see the [README](../README.md#install)).

**Update or reinstall.** Run the install command again. **Uninstall:** see the [README](../README.md#install); your data folder is never removed by it.

**Windows: SmartScreen / "running scripts is disabled".** `irm … | iex` runs the script text directly, so the execution policy does not apply to it. If you downloaded `install.ps1` and run it as a file, use `powershell -ExecutionPolicy Bypass -File .\install.ps1`.

**Windows: repositories cannot be added, gates or agents do not run.** Native Windows is experimental: only the installer and the dashboard work. Use WSL2 (open Ubuntu, install Node, run the macOS install command inside it) or a Mac.

**The browser did not open.** Conductor prints a link; open it yourself (the plain `http://127.0.0.1:4327` address works, there is no sign-in). On a headless machine or in CI set `CONDUCTOR_NO_OPEN=1` (exactly `1`): Conductor then never launches a browser and only prints the link.

## Using Conductor

**"Why didn't my card start?"** It must be in **To do** (not Backlog — press *Start*), it must have a repository (the project's repository, or the only registered one), and any cards it depends on must be done. The dashboard's *ignored* list names the reason for cards Conductor deliberately does not run (a card sitting in a Conductor-owned lane without a run is never restarted automatically — move it to To do yourself).

**"Which Claude is this?"** The `claude` command-line tool, not the desktop app — they can be signed into different plans. `conductor doctor` prints the account (e.g. `Signed in as you@company.com · Org · team plan`). Switch: `claude auth logout` then `claude auth login`.

**"Waiting for the usage limit" (in Stuck resolver).** Normal on Claude Pro. There is no separate Paused column: a card waiting for a limit shows in **Stuck resolver** and resumes by itself after the reset time shown. To keep working meanwhile: Settings → *When Claude hits its limit* → "use Cursor for read-only stages".

**"The board cannot be saved right now" (red banner).** Conductor could not write its board (disk full? permissions on the data folder?). Nothing is lost: pending updates stay queued and are retried. Free space / fix permissions, then restart Conductor (a board that hit a write error refuses further writes until restarted, so it can never corrupt itself).

**"…contains data from Conductor v1 … run conductor migrate".** v2 never uses a v1 folder in place. Use `conductor migrate` (dry run first, then `--apply`) to import it into a new folder, or point `CONDUCTOR_HOME` at an empty folder.

**"Codex is installed but does not start" / Codex shows as broken.** The `codex` command exists but its native program is missing (a shim whose platform package did not install — `…/@openai/codex-darwin-arm64/vendor/…/codex ENOENT`). Conductor only reports it; it never installs or repairs anything. Reinstall it yourself (`npm i -g @openai/codex`), then sign in to Conductor's private home: `CODEX_HOME=~/.conductor-v2/providers/codex-home codex login`. A broken Codex is skipped by the router (the next provider in the chain does the stage).

**"Codex was not started: the private Codex home holds entries Conductor did not put there".** Something other than Codex's own files is in `~/.conductor-v2/providers/codex-home` (hooks, rules, skills, memories, `AGENTS.md`, a symbolic link …). Conductor refuses to run Codex with instructions or code it did not write. Move the named entries out of that folder; `config.toml` is rewritten by Conductor every run, and `memories/` and `rules/` are only accepted while empty.

**Codex shows "blocked".** The isolation check (`conductor doctor --isolation codex --yes`) saw a project hook / MCP server / rule fire, a write succeed, the network reached, or a decoy secret in the agent's shell. Codex is unusable for every role until a later check passes — typically after a Codex update or a change on your side; run the check again then.

**Backups pile up.** Every data upgrade and every `migrate --apply` copies what it read into `~/.conductor-backups/<timestamp>-<label>/` (mode 0700; prompt-audit and gate-output files are not copied by the importer). Nothing prunes them: delete old folders yourself when you no longer need them — they hold your run records and plan/verdict text.

**"…was written by a newer Conductor".** A file in the data folder has a data version this build does not understand. Nothing was changed. Upgrade Conductor, or restore a backup from `~/.conductor-backups`.

**"Conductor is already running".** Only one instance runs per data folder. `conductor start` then opens the running dashboard for you (use `conductor start --no-open` to just see the message). (v1 and v2 can run at the same time: they use different data folders, ports and launchd labels.)

**The page says `UI file index.html is missing` (or looks broken) although you just installed.** An older Conductor is still running from a folder that has since been moved, deleted or replaced, and it is holding the port. Run `conductor stop --port 4327` (use the port from the "already running" message). It stops that process only if it really is a Conductor server of yours, and leaves anything else alone. Then run `conductor start` again. (If you prefer, `ps -p <pid> -o command=` shows what a pid is, and `kill <pid>` stops it.)

**How `conductor stop` decides what to stop.** Plain `conductor stop` stops the Conductor that belongs to this data folder (the one named in its lock file). It only signals a process whose command line is a Conductor server (`node …/bin/conductor.mjs start` or `restart`), that you own, and whose start time has not changed since it was checked; otherwise it kills nothing and tells you the `kill <pid>` command. It asks the server to shut down cleanly and waits up to 30 seconds; a hard kill happens only with `--force`. It never edits the lock file and reports only what it observed (process gone, port free). If it finds no instance for this data folder but sees other Conductors on ports 4327-4336, it lists them with the exact `conductor stop --port <n>` command and stops nothing. `conductor restart` aborts if the stop step refused. If Conductor was started by the background service, `stop` only asks it to quit gracefully (never a hard kill), and the service stays installed and starts again at your next login (`conductor service uninstall` removes it). On Windows `stop` and `restart` only print how to stop it yourself.

**`conductor update` refuses to run.** "Not made by the installer": you are running a git clone, update it with `git pull`. "Conductor is running": run `conductor stop` first. "Could not find the latest release": no network, a proxy in the way, a private repository, or no published release yet. `conductor update --check` only reports whether a newer version exists. The update downloads that release's `install.sh`, verifies its SHA-256 against the release's `SHA256SUMS.txt`, and runs it; the installer then verifies the app package again.



**A card sits in "Stuck resolver".** Complete auto is the default run mode for a new install, but an install whose config already existed stays on Per settings until you switch, and the resolver runs only under Complete auto: check the run-mode control first. Under Complete auto the resolver already tried (the card shows its analysis). It is bounded (3 runs per card, 12 per hour) and never turns a safety check off, so what remains needs you or an outside change: fix the cause, then press **Retry** (a person restart gives it a fresh resolver budget). Under Per settings the resolver does not run.

**A Done card does not become Pushed.** Open the card: it says why it was not pushed. Common causes: Complete auto consent not accepted yet (accept the confirmation once), no push remote or `pushRemote` set to none, your git name looks like an agent, a commit of your own below it, or a secret-looking value. **Retry** runs Ship again; **Unblock dependants** lets waiting cards start. It was pushed to a `conductor/…` branch? Your checked-out branch was protected, the remote default, detached, or had moved on.

**Cursor CLI hangs / prints nothing.** Conductor kills silent agents after 15 minutes and retries once; run `agent update`. A run that still fails goes to **Stuck resolver** with the reason.

**"Isolation check failed".** The Claude session had tools/MCP servers it should not have (a CLI update changed flags?). Run `conductor doctor --isolation` and share the output.

**"…the recorded worktree is not the one Conductor v2 created".** A run record points at a checkout v2 did not create (for example a v1 worktree). v2 refuses to plan, reset or delete in it. Press *Move to To do* to re-plan in a fresh v2 worktree.

**Dependencies fail to install in the worktree.** Set the repo's `setup` command in the data folder's `config.json` (e.g. `pnpm install --frozen-lockfile`), then move the card back to To do.

**Cleaning up.** Dashboard → run → *Remove worktree* removes the worktree (the branch stays unless it is already merged). Backups of discarded work: `git for-each-ref refs/conductor-v2/`. Everything else: `conductor uninstall --purge` (service + data folder; refuses folders without the v2 marker; the app itself is removed with the installer's uninstall, see the [README](../README.md#install)).
