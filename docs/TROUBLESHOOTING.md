# Troubleshooting

**"Why didn't my issue get picked up?"** Check, in order: it has the label `conductor` · it is in **Todo** (not Backlog — or enable "pick up from Backlog" in Settings) · **you** created it (and added the label yourself or created it with the label) · you registered the repo, and the issue maps to it (label `repo:<name>`, or a Linear project named like the repo, or first line `repo: <name>`; with a single repo it is automatic) · the dashboard's *ignored issues* list names the reason.

**"Paused — Claude usage limit".** Normal on Claude Pro. Runs resume by themselves after the reset time shown. To keep working meanwhile: Settings → *When Claude hits its limit* → "use Cursor for read-only stages". Check the account: `claude auth status`.

**"Session expired" in the dashboard.** Run `npm run open` (one-time sign-in link).

**"Conductor is already running".** Only one instance runs at a time (so the background service and a dev copy can't double-pick). Use `npm run open` to reach it.

**Cursor CLI hangs / prints nothing.** Conductor kills silent agents after 10 minutes and retries once; run `agent update`. A run that still fails goes to **Needs you** with the reason.

**Labels could not be created (permissions).** The setup step lists the exact names to create by hand: `conductor`, `conductor-bug`, `conductor:planning`, `conductor:plan-ready`, `conductor:building`, `conductor:verifying`, `conductor:needs-human`, `conductor:ready`.

**"Isolation check failed".** The Claude session had tools/MCP servers it should not have (a CLI update changed flags?). Run `npm run doctor -- --isolation` and share the output.

**Dependencies fail to install in the worktree.** Set the repo's `setup` command in `~/.conductor/config.json` (e.g. `pnpm install --frozen-lockfile`), then move the issue back to Todo.

**Cleaning up.** Dashboard → run → *Clean up* removes the worktree (the branch stays). Backups of discarded work: `git for-each-ref refs/conductor/`. Everything else: `npm run uninstall` (service + key) or delete `~/.conductor`. Conductor never deletes Linear labels or issues.

**Uninstall / rollback.** `node bin/conductor.mjs uninstall [--purge]`. Linear labels `conductor*` can be deleted in Linear → Settings → Labels.
