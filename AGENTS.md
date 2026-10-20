# Agent defaults — techteam-conductor

Human authority: the user decides. Bring problem + options + a recommendation; don't order the user around.

## TechTeam (required)
1. Start with TechTeam Lead / the `techteam-ops` skill. Smallest useful roster; start routine reversible work without waiting.
2. Implementation gate: plan (`.techteam/templates/implementation-plan.md`) → distinct **Reviewer** approval → implement → tests → final report. Never self-approve.
3. Local development only — no push/PR/merge unless the user asks.
4. Durable context lives in `.techteam/` (v1 plan: `.techteam/plans/conductor-v1.md`; **v2 plans: `.techteam/plans/workspace-v2*.md`** (master + M1 + M2 sub-plans, rolling-wave approval); reviews: `.techteam/reviews/`).

## Project rules
- Node ≥ 22.18, **TypeScript run by type stripping**: erasable syntax only (no `enum`, `namespace`, parameter properties), `import type`, relative imports end in `.ts`.
- **Zero runtime dependencies.** Dev-only: `typescript`, `@types/node`.
- Safety invariants (do not weaken without a Reviewer-approved plan): Claude stages stay read-only + fail-closed init check; builder never pushes; every agent-derived string is redacted before the board/logs/UI; the builder only ever works in the worktree v2 itself created; humans never write Conductor-owned lanes; children get allow-listed env; the dashboard stays loopback + cookie + CSRF.
- Tests: `npm test` (fake agents, no network/quota) must stay green; `npm run check` (tsc) clean. Live tests (`npm run test:live`) are opt-in and use real quota.
- Prompts are plain files in `prompts/` — edit there, not in code.

- v2 work happens in the clone `techteam-conductor-v2` with throw-away `CONDUCTOR_HOME`s (the test suite's preload enforces it); the user's live v1 data in `~/.conductor` is never written. Every milestone: sub-plan → Reviewer approval → implement → Reviewer **and** Security checkpoint.
