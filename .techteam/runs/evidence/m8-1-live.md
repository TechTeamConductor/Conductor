# M8-1 live discovery evidence (AC9)

- Date: 2026-10-21. Machine: the developer Mac. `claude` 2.1.304, `agent` 2026.10.19-6bbf2c4. Codex not touched (S17).
- Zero quota only: the Claude `initialize` handshake (no prompt) and `agent --list-models`. No login, no prompt, no model turn.
- Counts and flags only (R2-4). No identity, no repository paths, no key names.
- Every temp folder below lived under the session scratchpad and was removed afterwards. No temp `.claude.json` was copied anywhere (S6).

## Run 1: `conductor models --refresh --json`, throw-away `CONDUCTOR_HOME`, real config dirs, before the id-rule ruling

| Provider | state | kept | dropped | cliVersion | signedIn | families |
| --- | --- | --- | --- | --- | --- | --- |
| claude | fresh | 4 | 1 | 2.1.304 | true | — |
| cursor | fresh | 265 | 0 | 2026.10.19-6bbf2c4 | true | 47 |
| codex | unavailable ("not available yet") | — | — | — | — | — |

**Stop condition hit (plan §2c B5c).** Conductor's allow-listed Claude env (`claudeEnv`) got a 5-entry list. One entry, `claude-fable-5-1[1m]`, failed the narrow id rule and was dropped.

Diagnosis:
- The 13-entry recording `fixtures/real/claude-initialize-2.1.304.json` was captured inside a Claude Code session, whose env sets `CLAUDE_CODE_ENTRYPOINT`.
- Adding only that variable to the allow-listed env brings back the 13-entry list.
- Conductor's env (terminal, launchd or desktop app start) gets the 5-entry list.

The user chose to allow a short bracket suffix. Security ruled W1–W7 (`reviews/workspace-v2-m8-1-security-design.md`, "S9 widening ruling"): the suffix is allowed for Claude only.

## Run 2: the same command after applying the ruling (per-provider rule)

| Provider | state | kept | dropped | cliVersion | signedIn | families |
| --- | --- | --- | --- | --- | --- | --- |
| claude | fresh | 5 | 0 | 2.1.304 | true | — |
| cursor | fresh | 265 | 0 | 2026.10.19-6bbf2c4 | true | 47 |
| codex | unavailable ("not available yet") | — | — | — | — | — |

- Claude ids: `default`, `opus`, `claude-fable-5-1[1m]`, `sonnet`, `haiku`.
- Exit 0, empty stderr.
- The discovery folder had 0 entries afterwards.
- `models/` and the provider folders are 0700; the cache files are 0600.
- The new fixture `fixtures/real/claude-initialize-2.1.304-conductor-env.json` was recorded with `claudeEnv` (no `CLAUDE_CODE_ENTRYPOINT`) and reduced per S7. AC1 pins it at 5 kept / 0 dropped.

## Footprint in the user's Claude config (N2, counts only)

| Check | Before run 1 | After run 1 | Before run 2 | After run 2 |
| --- | --- | --- | --- | --- |
| `~/.claude.json` project keys | 13 | 13 | 13 | 13 |
| key for the discovery folder | no | no | no | no |
| `~/.claude/projects` entries | 23 | 23 | 23 | 23 |
| entry for the discovery folder | no | no | no | no |

## S5: Claude hook / MCP marker check (temp `CLAUDE_CONFIG_DIR`, signed out)

**Setup**
- A temp config dir with:
  - `settings.json` holding SessionStart, SessionEnd, UserPromptSubmit, PreToolUse (matcher `*`) and Stop hooks, each touching its own marker;
  - `.claude.json` with a stdio MCP server that touches a marker.
- A temp cwd holding a `.mcp.json` stdio server that touches a marker.

**Test: discovery argv** (`CLAUDE_DISCOVERY_ARGS`, `claudeEnv` + the temp `CLAUDE_CONFIG_DIR`, the one `initialize` line)
- Exit 0. The only stdout line type was `control_response` (5 models, signed out).
- **0 of 7 markers** appeared.
- `sessions/` had 0 entries.
- The cwd held only the planted `.mcp.json`.

**Positive control: same handshake without `--safe-mode --strict-mcp-config --disable-slash-commands --no-session-persistence`** (a second temp config dir and cwd)
- stdout showed `system/hook_started` and `system/hook_response`.
- **4 markers appeared:** SessionStart, SessionEnd, the user MCP server and the project MCP server.
- So the planted configuration is live, and it is the discovery flags that keep it out.
- UserPromptSubmit, PreToolUse and Stop need a turn, and neither run had one.

**Through the service:** `conductor models --refresh` with the temp `CLAUDE_CONFIG_DIR` gave:
- Claude fresh, 5 aliases, `signedIn: false`.
- **0 markers**, `sessions/` with 0 entries.
- The discovery folder was emptied before the spawn, as R2-2 requires.

**Not attempted: a local plugin with a SessionStart hook.** It needs a marketplace install, `--safe-mode` disables plugins, and the hook control above already proves hooks are kept out.

## S16: Cursor marker check (temp HOME, signed out)

**Setup:** a temp HOME with:
- `~/.cursor/hooks.json`: beforeSubmitPrompt, beforeShellExecution, beforeMCPExecution, beforeReadFile, afterFileEdit and stop hooks, each touching a marker;
- `~/.cursor/mcp.json`: a stdio server touching a marker.

**Run:** `conductor models --refresh` through the service, under `env -i` with PATH, HOME=temp, USER, TMPDIR, CONDUCTOR_HOME and the S5 `CLAUDE_CONFIG_DIR`.

**Result:**
- Cursor `unavailable`, reason "Sign in to Cursor to see its models" (static text).
- **0 of 7 markers.**
- Exit 0, empty stderr.

**No Cursor positive control was run.** The only allowed live Cursor command is `--list-models`. Signed-in runs 1 and 2 used the user's real HOME, which sign-in needs; S16 accepts that residual risk.

## S7 / R2-4

`test/models/fixtures-hygiene.test.ts` scans this file and every model fixture for email shapes and for the keys `userID`, `machineID`, `oauthAccount`, `commands` and `agents`.
