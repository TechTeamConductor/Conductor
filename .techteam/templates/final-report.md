# Final report — F1 Claude settings isolation (A+C)

Report only what was implemented and what was actually run. Do not invent results.

## 1. Implementation Summary

Closed Security F1: Conductor Claude spawns no longer honour hostile `settings.json` `apiKeyHelper` / `env` under `--safe-mode` alone.

- **A:** quarantine project `<cwd>/.claude/settings*.json` around every `runClaude` / doctor isolationProbe (restore after; symlink/hardlink refuse; per-cwd mutex).
- **C:** refuse before spawn when the default config dir's settings (or `.claude.json`) carry `apiKeyHelper` or any non-empty settings `env`; never rewrite `~/.claude`.
- Wired: `runClaude`, `discoverClaude`, provider `auth`, `doctor.isolationProbe`. Named-account full-file refuse unchanged.

## 2. Architecture Changes

New shared pre-flight module `src/agents/claude-settings.ts`. Isolation table in `docs/ARCHITECTURE.md` documents that `--safe-mode` alone is insufficient and that F1 A+C closes the gap.

## 3. Files Changed

- Created: `src/agents/claude-settings.ts`, `test/agents/claude-settings.test.ts`, `.techteam/runs/evidence/l3c-f1-postfix.md`, `.techteam/runs/evidence/l3c-f1-postfix-probe.ts`, reviews under `.techteam/reviews/workspace-v2-f1-*.md`
- Modified: `src/agents/claude.ts`, `src/models/claude.ts`, `src/agents/providers/claude.ts`, `src/doctor.ts`, `test/preload.ts`, `test/models/{service,spawn}.test.ts`, `docs/ARCHITECTURE.md`, plan `workspace-v2-f1-claude-settings.md`

## 4. Security and Compliance

Settings isolation fail-closed before spawn (`errorKind: 'isolation'`). Class-only error messages. No rewrite of user config. Reviewer + Security code checkpoints **Approved**.

## 5. Testing Results

| Check | Result | Details |
| --- | --- | --- |
| Unit / F1 tests | Pass | `test/agents/claude-settings.test.ts` 9/9 |
| Full suite | Pass | `npm test` → 1090 tests / 1086 pass / 0 fail / 4 skip |
| Typecheck | Pass | `npm run check` clean |
| Live postfix probe | Pass | `l3c-f1-postfix-probe.ts` → C refused, A absent-during-child, helper/listener 0 |

## 6. Acceptance Criteria

| Criterion | Status | Evidence |
| --- | --- | --- |
| AC1 project settings | Satisfied | Quarantine + postfix + unit |
| AC2 config-dir refuse | Satisfied | assert + postfix + doctor test |
| AC3 named accounts | Satisfied | env-profile suite unchanged green |
| AC4 init fail-closed | Satisfied | still in `runClaudeBody`; suite green |
| AC5 no listener/secrets | Satisfied | postfix counts 0; class-only messages |

## 7. Remaining risks / follow-ups

- Optional L3d / control **B** (`--settings`) after live proof — not required to close F1.
- M8-5 UI work may still be uncommitted alongside F1 — commit when user asks.
- Users with default-account `apiKeyHelper` / settings `env` (e.g. Headroom proxy) will see Conductor refuse Claude until they clear those keys from the config dir Conductor uses.

## Record

- Plan: `.techteam/plans/workspace-v2-f1-claude-settings.md` (approved)
- Security code: `.techteam/reviews/workspace-v2-f1-security-code.md` → **Approved**
- Reviewer code: `.techteam/reviews/workspace-v2-f1-code-review.md` → **Approved**
