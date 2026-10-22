# L3c / L3(b)-style — F1 post-fix (2026-10-21)

- Zero quota. Throw-away temp `CLAUDE_CONFIG_DIR` + cwd (not `~/.claude`). Temp removed: **true**.
- Probe: `.techteam/runs/evidence/l3c-f1-postfix-probe.ts` (Conductor choke points A+C).
- Counts only. No email, token, or home path.

## Results

| Check | Result |
| --- | --- |
| F1-C config-dir plant (`apiKeyHelper` + `env`) | **refused** before spawn; file **unchanged** |
| F1-A via `runClaude` (project `settings.json` + `settings.local.json` planted) | settings **absent** during child; **restored** after |
| Helper firings during Conductor A path | **0** |
| Listener connections during Conductor A path | **0** |
| Real `claude --version` under planted project (inert baseline) | helper **0**, listener **0** |

Raw probe JSON:

```json
{"C_RESULT":"refused","C_unchanged":true,"A_PRESENT_during_child":"no","A_RESTORED":"yes","A_helper_delta":0,"A_listener_delta":0,"version_helper_delta":0,"version_listener_delta":0,"helper_total":0,"listener_total":0}
```

## Verdict

**AC1 / AC2 met for Conductor-owned paths.** Pre-F1 L3c (`.techteam/runs/evidence/l3c-project-settings.md`) remains the baseline that `--safe-mode` alone is insufficient; F1 A+C close the gap for every spawn that goes through `runClaude` / `assertClaudeConfigDirSafe`.

Automated coverage: `test/agents/claude-settings.test.ts` (unit + `runClaude` integration). Named-account suite unchanged (`test/accounts/env-profile.test.ts`).
