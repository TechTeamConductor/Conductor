# Troubleshooting

**"Why didn't my card start?"** It must be in **To do** (not Backlog — press *Start*), it must have a repository (the project's repository, or the only registered one), and any cards it depends on must be done. The dashboard's *ignored* list names the reason for cards Conductor deliberately does not run (a card sitting in a Conductor-owned lane without a run is never restarted automatically — move it to To do yourself).

**"Which Claude is this?"** The `claude` command-line tool, not the desktop app — they can be signed into different plans. `npm run doctor` prints the account (e.g. `Signed in as you@company.com · Org · team plan`). Switch: `claude auth logout` then `claude auth login`.

**"Paused — Claude usage limit".** Normal on Claude Pro. Runs resume by themselves after the reset time shown. To keep working meanwhile: Settings → *When Claude hits its limit* → "use Cursor for read-only stages".

**"The board cannot be saved right now" (red banner).** Conductor could not write its board (disk full? permissions on the data folder?). Nothing is lost: pending updates stay queued and are retried. Free space / fix permissions, then restart Conductor (a board that hit a write error refuses further writes until restarted, so it can never corrupt itself).

**"…contains data from Conductor v1 … run conductor migrate".** v2 never uses a v1 folder in place. Use `node bin/conductor.mjs migrate` (dry run first, then `--apply`) to import it into a new folder, or point `CONDUCTOR_HOME` at an empty folder.

**"…was written by a newer Conductor".** A file in the data folder has a data version this build does not understand. Nothing was changed. Upgrade Conductor, or restore a backup from `~/.conductor-backups`.

**"Session expired" in the dashboard.** Run `npm run open` (one-time sign-in link).

**"Conductor is already running".** Only one instance runs per data folder. Use `npm run open` to reach it. (v1 and v2 can run at the same time: they use different data folders, ports, cookies and launchd labels.)

**Cursor CLI hangs / prints nothing.** Conductor kills silent agents after 15 minutes and retries once; run `agent update`. A run that still fails goes to **Needs you** with the reason.

**"Isolation check failed".** The Claude session had tools/MCP servers it should not have (a CLI update changed flags?). Run `npm run doctor -- --isolation` and share the output.

**"…the recorded worktree is not the one Conductor v2 created".** A run record points at a checkout v2 did not create (for example a v1 worktree). v2 refuses to plan, reset or delete in it. Press *Move to To do* to re-plan in a fresh v2 worktree.

**Dependencies fail to install in the worktree.** Set the repo's `setup` command in the data folder's `config.json` (e.g. `pnpm install --frozen-lockfile`), then move the card back to To do.

**Cleaning up.** Dashboard → run → *Remove worktree* removes the worktree (the branch stays unless it is already merged). Backups of discarded work: `git for-each-ref refs/conductor-v2/`. Everything else: `node bin/conductor.mjs uninstall --purge` (service + data folder; refuses folders without the v2 marker).
