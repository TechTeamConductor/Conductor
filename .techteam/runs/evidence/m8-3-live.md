# M8-3 live checks: evidence (counts, entry names and yes/no only)

- Date: 2026-10-21. Machine: the user's Mac. Claude Code 2.1.304, Cursor agent 2026.10.19-6bbf2c4.
- Authorised by the user (via the Lead): **L1, L3 and L4a only**. These are no-sign-in, zero-quota checks. Each ran in an empty temp folder (a temp `CLAUDE_CONFIG_DIR` or a temp Cursor HOME), and every temp folder was removed afterwards (`tempRemoved: true` each time).
- Not run (awaiting user permission): **L2, L4b, L4c, L4d, L4e, L5**. No login of any kind was run.
- Nothing below holds an email, an organisation, a token, a hash value, a Keychain service suffix or a path under `$HOME`. The scripts printed only booleans, exit codes, counts and entry names. Uuid-like and long-number names are masked as `<uuid>` / `<n>`, and the transcript project folder as `<project-dir>`.
- The env was the base allow-list (`HOME USER LOGNAME LANG LC_* TERM TMPDIR SHELL PATH`) plus `GIT_TERMINAL_PROMPT=0`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `DISABLE_AUTOUPDATER=1` and the account key (`CLAUDE_CONFIG_DIR`, or `HOME` + `AGENT_CLI_CREDENTIAL_STORE=file`). It held no `ANTHROPIC_*`, no `CLAUDE_CODE_OAUTH_TOKEN` and no `CURSOR_*`.

## L1 (S6): Claude spawn shapes, signed out, empty profile folder (zero quota)

| Shape (Conductor's exact argv) | Exit | Signed out | Top-level entries afterwards | Depth 2 |
| --- | --- | --- | --- | --- |
| `--version` | 0 | n/a | (none) | n/a |
| `auth status` | 1 | yes (`loggedIn:false`) | `.claude.json` (file), `.claude.json.lock` (dir), `backups` (dir) | `backups/.claude.json.backup.<n>`; `.claude.json.lock/` empty |
| discovery `initialize` (`CLAUDE_DISCOVERY_ARGS`) | 0 | yes (`tokenSource:none`, no email); 5 models listed; no turn event | + `sessions` (dir) | `sessions/` empty |
| read-only stage (`buildClaudeArgs`, safe-mode, schema) | 1 | yes (guarded: ran only after `auth status` said `loggedIn:false`); result `is_error`, cost 0 | + `projects` (dir) | `projects/<project-dir>/<uuid>.jsonl` |
| research (`profile: 'research'`) | 1 | yes; result `is_error`, cost 0 | same | `projects/<project-dir>/<uuid>.jsonl` (×2) |

Allow-list derived from this (`CLAUDE_PROFILE_ALLOWED`, `src/accounts/profile.ts`):
- `.claude.json` (regular file, key check applies);
- `.claude.json.lock` (dir, as L1 measured it; if L2 shows it as a file when signed in, the allow-list kind changes with it);
- `backups` (dir);
- `sessions` (dir);
- `projects` (dir).

Things L1 did **not** show, so they are not allowed:
- `.credentials.json`: not created signed out; only L2 can show whether a macOS login creates it;
- `shell-snapshots`, `statsig`, `todos`, `plugins`.

Anything a signed-in session adds (L2(vi), not authorised) is refused as "unknown" until L2 runs. That follows the stop rule.

## L3 (S6): planted config

**(a) The pre-flight refuses with zero spawns.** These are automated `npm test` cases against the real `profile.ts`/`env.ts` with a `runProcess` spy: `test/accounts/env-profile.test.ts` (Claude: `settings.json`, `CLAUDE.md`, `hooks/`, `.mcp.json`, `.claude.json` with `mcpServers`; Cursor `.cursor/hooks.json`, `.cursor/mcp.json`). The result is recorded in the handoff.

**(b) A scratch copy with the pre-flight bypassed, signed out.** The markers are harmless `touch` commands in the temp folder, and a loopback TCP listener stood in for `env.ANTHROPIC_BASE_URL`.

Claude planted set:
- `settings.json` with hooks on SessionStart, SessionEnd, UserPromptSubmit, PreToolUse and Stop, plus `apiKeyHelper` (a script that touches a marker) and `env.ANTHROPIC_BASE_URL` pointing at the listener;
- `CLAUDE.md`;
- `hooks/`;
- `.mcp.json`;
- `.claude.json` with `mcpServers`.

| Shape | Markers that appeared | Listener connections |
| --- | --- | --- |
| claude `--version` | none | 0 |
| claude `auth status` | none | **1** |
| claude discovery `initialize` (`--safe-mode`) | **`apiKeyHelper`** | **1** |
| claude read-only stage (`--safe-mode`) | **`apiKeyHelper`** | **8** (killed at 45 s) |
| claude research (`--safe-mode`) | **`apiKeyHelper`** | **8** (killed at 45 s) |
| cursor `status` (planted `.cursor/hooks.json`, `.cursor/mcp.json`) | none | 0 (signed out) |
| cursor `--list-models` (same) | none | 0 (signed out) |

What this means:
- No planted hook, `CLAUDE.md` or MCP server ran for any shape.
- **However, `--safe-mode` does NOT stop a planted `settings.json` `apiKeyHelper` (code execution) or `env.ANTHROPIC_BASE_URL` (traffic redirect).** This held for `auth status`, discovery `initialize`, read-only stages and research.
- So, per S6 ("record which"): for every named-Claude spawn shape except `--version`, **the pre-flight alone** stands between planted config and code execution or redirection. This is acceptable under S6 only because L3(a) passes (zero spawns on a planted entry) and the S5 static test holds. `settings.json` is on the always-refused list.
- Cursor: neither the planted hooks nor MCP were loaded by `status` or `--list-models` while signed out.

## L4a (S15): no fallback to the shared Cursor login (zero quota)

| Step | Result |
| --- | --- |
| default Cursor (real HOME, Keychain) `agent status` | signed in: **yes** (exit 0) |
| named env (empty account HOME + `AGENT_CLI_CREDENTIAL_STORE=file`) `agent status` | signed in: **no**; reports not signed in: yes (exit 0) |
| named env `agent --list-models` | listed models: **no**; reports not signed in: yes (exit 1) |
| default `agent status` afterwards | still signed in: **yes** |

**L4a PASS**: the file store does not fall back to the shared Keychain login.

What the two signed-out calls created under the empty account HOME (entry names only; the content and key names of `cli-config.json` were not read):
- `.cursor/cli-config.json`;
- `Library/Caches/cursor-compile-cache/`.

**Consequence (flagged to the Lead and Security):**
- The user decision keeps the `.cursor` allow-list **empty** until L4c.
- So after a named Cursor account's first check, the account HOME holds `.cursor/cli-config.json`. The next pre-flight refuses that entry, and the account shows as `unavailable` ("an unknown Cursor config file"), not as silently usable.
- Named Cursor accounts were already unusable in this slice (sign-in disabled, builds gated by `CURSOR_ACCOUNT_HOME_BUILD_VERIFIED = false`), so nothing is lost. L4c must decide whether `cli-config.json` (under the S14.2 content rule) and `Library/` join the allow-lists.
