# Final report — F1 Claude settings isolation (A+C)

See also `.techteam/templates/final-report.md` (same content for this close-out).

## Outcome

F1 **closed**. Security + Reviewer code checkpoints **Approved**. `npm test` 1086 pass / 0 fail / 4 skip; `npm run check` clean.

## Key controls

- **A** — quarantine project `.claude/settings*.json` around `runClaude` + doctor `isolationProbe`
- **C** — refuse config-dir `apiKeyHelper` / any settings `env` (no rewrite of `~/.claude`); `.claude.json` links refused

## Artifacts

- Plan: `.techteam/plans/workspace-v2-f1-claude-settings.md`
- Security: `.techteam/reviews/workspace-v2-f1-security-code.md` (Approved)
- Reviewer: `.techteam/reviews/workspace-v2-f1-code-review.md` (Approved)
- Evidence: `.techteam/runs/evidence/l3c-f1-postfix.md`

## Note

Working tree may still hold uncommitted M8-5 UI work beside F1. Commit only when asked.

Default-account users who keep `env` / `apiKeyHelper` in Claude settings (e.g. a local proxy) will see Conductor refuse Claude until those keys are removed from the config dir Conductor reads.
