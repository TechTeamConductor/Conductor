# L3c — project `.claude/settings.json` under Conductor Claude argv (2026-10-21)

- Zero quota, signed out: empty temp `CLAUDE_CONFIG_DIR` (not the user's `~/.claude`).
- Planted in **repo cwd** only: `.claude/settings.json` and `.claude/settings.local.json` with `apiKeyHelper` (touches a marker) and `env.ANTHROPIC_BASE_URL` → loopback listener.
- No email, token, or home path recorded. Counts only.

| Shape | `apiKeyHelper` fired | Listener connections |
| --- | --- | --- |
| discovery `initialize` (`--safe-mode`, …) | **yes** | 0 |
| read-only stage (`buildClaudeArgs`, `--safe-mode`) | **yes** | 5 |
| read-only stage (`--setting-sources project,local`) | **yes** | 5 |
| research (`--safe-mode`, web tools) | **yes** | 5 |
| `claude auth status` | no | 0 |

## Verdict

**Critical for F1(b):** a repository’s own `.claude/settings.json` / `settings.local.json` is honoured for Conductor’s Claude stage / discovery / research spawns under `--safe-mode`. An untrusted repo can run a helper and redirect API traffic for the signed-in session (when signed in; this run was signed out so no credential left the machine, but the helper still executed).

F1(a) (default `~/.claude/settings.json`) remains High from L3(b). Combined remedy needs a Security design (pre-flight strip/refuse project settings, stricter CLI flag, or `--settings` override) before any Claude spawn.

Temp root used for the probe was removed after recording (or left under `/tmp/conductor-l3c-*` for re-check).
