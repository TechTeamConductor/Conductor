# Contributing and agent guide

Conductor runs AI coding CLIs as a team on a local board. These are the rules for changing it, whether you are a person or a coding agent.

## Project rules
- Run mode: Complete auto is the default for a brand-new config (an existing config file without a run mode stays Per settings; the importer, backup restore and test/demo homes pin Per settings). The default never sets `completeAutoPushAck`: nothing is pushed until the one-time confirm. Switch to Per settings through `PUT /api/run-mode`.
- Node ≥ 22.18, **TypeScript run by type stripping**: erasable syntax only (no `enum`, `namespace`, parameter properties), `import type`, relative imports end in `.ts`.
- **Zero runtime dependencies.** Dev-only: `typescript`, `@types/node`.
- Safety invariants (do not weaken without an explicit, reviewed design): Claude stages stay read-only + fail-closed init check; builder never pushes (Ship, `src/git/ship.ts`, is the only engine code that runs `git push`, enforced by a static test; Complete auto = a consented push: Ship pushes only after the one-time Complete auto confirm is accepted, by sha, to the checked-out branch on the repo's push remote, with `conductor/<branch>` as the fallback for a protected, default, detached or non-fast-forward branch, never force, only commits Conductor made, as the person's recorded git identity with the ticket key in the subject, after a fail-closed scan, never while an agent job runs in that repository; a repo with `pushRemote: null` never pushes; the Stuck resolver can only pick from a closed action list and can never reach the scan, identity, push target, settings or any guard); every agent-derived string is redacted before the board/logs/UI; the builder only ever works in the worktree v2 itself created; humans never write Conductor-owned lanes; children get allow-listed env; the dashboard stays loopback + Host/Origin checks + CSRF header (NO login: any local process or user can use the dashboard API, including the Complete auto switch and the push remote; `confirm:true` is friction, not authentication).
- Tests: `npm test` (fake agents, no network/quota) must stay green; `npm run check` (tsc) clean. Live tests (`npm run test:live`) are opt-in and use real quota.
- Prompts are plain files in `prompts/` — edit there, not in code.
- Tests and local runs use throw-away `CONDUCTOR_HOME`s (the test suite's preload enforces it); never write to a user's live data in `~/.conductor` (v1) or `~/.conductor-v2`.

## Making a change
- Keep changes small and reviewable; add or update a test with every behaviour change.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`, `chore:` …): releases and their version numbers are generated from them. See [`docs/DESKTOP.md`](docs/DESKTOP.md#automatic-versions-and-releases).
- Do not push, open a PR or merge on someone else's behalf unless asked.
- **Git identity:** commits, tags and pushes are authored as `TechTeamConductor <support@bargainn.io>`, never as Claude, Cursor or another tool. Do not add `Co-Authored-By`, `Generated with` or any tool/agent attribution to commits, PR descriptions or release notes.

## Where things are
`src/` server and engine · `ui/` dashboard · `prompts/` agent prompts · `test/` and `fixtures/` tests with fake agents · `install/` the one-line installers (`install.sh`, `install.ps1`) · `desktop/` Electron shell (parked) · `scripts/` release tooling · `.github/workflows/` CI, packaging, release · `docs/` guide, architecture, API.
