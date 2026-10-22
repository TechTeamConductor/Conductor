# Contributing and agent guide

Conductor runs AI coding CLIs as a team on a local board. These are the rules for changing it, whether you are a person or a coding agent.

## Project rules
- Node ≥ 22.18, **TypeScript run by type stripping**: erasable syntax only (no `enum`, `namespace`, parameter properties), `import type`, relative imports end in `.ts`.
- **Zero runtime dependencies.** Dev-only: `typescript`, `@types/node`.
- Safety invariants (do not weaken without an explicit, reviewed design): Claude stages stay read-only + fail-closed init check; builder never pushes; every agent-derived string is redacted before the board/logs/UI; the builder only ever works in the worktree v2 itself created; humans never write Conductor-owned lanes; children get allow-listed env; the dashboard stays loopback + cookie + CSRF.
- Tests: `npm test` (fake agents, no network/quota) must stay green; `npm run check` (tsc) clean. Live tests (`npm run test:live`) are opt-in and use real quota.
- Prompts are plain files in `prompts/` — edit there, not in code.
- Tests and local runs use throw-away `CONDUCTOR_HOME`s (the test suite's preload enforces it); never write to a user's live data in `~/.conductor` (v1) or `~/.conductor-v2`.

## Making a change
- Keep changes small and reviewable; add or update a test with every behaviour change.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`, `chore:` …): releases and their version numbers are generated from them. See [`docs/DESKTOP.md`](docs/DESKTOP.md#automatic-versions-and-releases).
- Do not push, open a PR or merge on someone else's behalf unless asked.

## Where things are
`src/` server and engine · `ui/` dashboard · `prompts/` agent prompts · `test/` and `fixtures/` tests with fake agents · `desktop/` Electron shell · `scripts/` release tooling · `docs/` guide, architecture, API.
