# Security code review: M8-1 Model discovery (F7a)

- **Reviewer:** TechTeam Security Engineer (independent of the builder, a6f0e675534e1a73a).
- **Date:** 2026-10-21.
- **Scope:** the uncommitted diff in `/Volumes/Sandisk/github/techteam-conductor-v2`:
  - `src/models/**`: sanitize, claude, cursor, codex, cache, service, workdir, cursor-families, types;
  - `src/agents/spawn.ts` (`maxOutputBytes`), `src/paths.ts`, `src/config.ts`, `src/runtime.ts`, `src/cli.ts` (`conductor models`), `src/desktop-sidecar.ts`;
  - `/api/models` and `/api/models/refresh` in `src/server/api.ts`;
  - the fakes, `fixtures/real/claude-initialize-2.1.304{,-signed-out,-conductor-env}.json`, the Cursor fixtures, `fixtures/codex-model-list.json`;
  - `test/models/**`, `test/spawn-overflow.test.ts`;
  - the evidence file `.techteam/runs/evidence/m8-1-live.md`.
- **Baseline:** the design conditions S1–S20, R2-1…R2-5 and W1–W7 in `workspace-v2-m8-1-security-design.md`.
- **Method:**
  - I read every source file in scope line by line.
  - I ran `test/models/*.test.ts`, `test/spawn-overflow.test.ts` and `test/argv-golden.test.ts`: **109/109 pass**. `tsc --noEmit` is clean.
  - I checked the fixtures by parsing their key trees, and grepped the fixtures and the evidence for identity strings.
  - I did not run the full `npm test`; that stays the Lead's gate. I ran no real CLI.

## Verdict

**Approved.** All binding conditions are met in code, with tests or recorded evidence. There is no Critical, High or Medium finding. The four Low findings (L1–L4) are hardening notes and do not block release.

## Conditions, verified

| Cond. | Evidence in code | Test / evidence | Status |
| --- | --- | --- | --- |
| **S1** tripwire | `claude.ts isTurnEvent`: `assistant`, `user`, `result`, `stream_event`, `rate_limit_event`, or `system/init`, triggers `ac.abort()` (process-group kill) and kind `turn`; nothing is cached. The child is also aborted right after the matching reply is parsed. A failure arms the 5-minute back-off, so there is no automatic retry. | `spawn.test` "S1 tripwire" (killed in under 5 s, no cache, `noteVersion` refused, 1 spawn) and "killed right after the reply" | Met |
| **S2** only models + account | `parseClaudeInitialize` reads `models` and `account` only, field by field. The rest of the reply is never stored. `stdoutTail` is never read; the only reason text comes from stderr, scrubbed. | `identity.test` decoy (commands, agents, email, organisation, tokenSource, userID) checked across cache, API, log and reason | Met |
| **S3** identity | Only `signedIn` and `plan` (`PLAN_RE`) are kept. Email and organisation go to `scrubIdentity` as exact secrets (≥ 3 characters), then the email-shape and path scrub is applied to every reason and log line. Cursor reasons are static. | `identity.test` (Claude stderr email and home path; Cursor stderr email) | Met |
| **S4 / B2** byte cap | `runProcess` gained an optional `maxOutputBytes`. It counts raw bytes before line splitting, terminates the group, sets `overflow`, and delivers nothing after the trip. When unset, the result shape is unchanged. Discovery also caps a single line at 512 KB. | `spawn.test` flood / manylines / longline (Claude) and the 5 MB Cursor flood; `spawn-overflow.test`; `argv-golden.test` | Met |
| **S5** markers | Hooks, user MCP and project MCP are planted: **0 of 7** markers fire. The positive control without the flags fires **4**, so the planted configuration is live and the flags are what keep it out. `sessions/` stays empty. | `evidence/m8-1-live.md` §S5 | Met. A plugin hook was not tested; acceptable, since `--safe-mode` disables plugins and hook execution is proven blocked. |
| **S6** session persistence | `--no-session-persistence` is in the frozen argv; there is no fallback. The footprint table shows `~/.claude.json` project keys 13 → 13 and `~/.claude/projects` 23 → 23, with no key for the discovery folder. | `spawn.test` B5a (exact argv); evidence footprint | Met |
| **S7** fixtures | The Claude fixtures have keys `_note`, `type`, `response.{subtype, request_id, response.{models, account, claude_code_version}}`. The account holds `PLACEHOLDER_*` values; the signed-out file holds only `tokenSource` / `apiProvider`. The evidence file is counts only. | `fixtures-hygiene.test` (email shape and the five keys across fixtures + evidence; key allow-list) | Met. The `agents` key and `/Users/me` paths in `claude-stream-*.ndjson` / `cursor-build-*.ndjson` predate this slice and are not model fixtures. |
| **S8** field-by-field | `own()` / `Object.hasOwn` everywhere. Entries are built from literals, flags only when `=== true`, efforts limited to the allow-list. | `hostile.test` (`__proto__` / `constructor`, also through the fake) | Met |
| **S9** cleanText | NFC, then strips `\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}`, explicitly drops lone surrogates, truncates by code point, and bounds input at 4 KB. Ids are checked raw and never "repaired". | `sanitize.test`, `hostile.test` | Met |
| **S10 / R2-2** discovery folder | `workdir.ts`: `<home>/run` and `run/discovery` must be lstat-real, owned by the user, 0700 (tightened). The folder is emptied (`rmSync` on the entry, so a link is removed, never followed) and re-checked empty before the spawn. If it is not plain or not empty, discovery is refused and nothing is spawned. After the child is reaped the folder is cleaned again and only the leftover count is logged. All discoveries are serialised through one service-wide queue. `stop()` aborts discovery; `Runtime.close()` calls it. | `spawn.test` R2-2 ×3 (planted `.mcp.json` and symlink, target survives; post-run clean; symlinked or file folder refused, mode tightened), "never overlap", `stop()` | Met |
| **S11** back-off | `autoAllowed`: no automatic refresh within 5 minutes of a failure, and at most one per distinct `cliVersion` per process. A failure never touches the cached `cliVersion`. `noteUnknownModel` is rate-limited to once per 5 minutes and respects the failure back-off. The 10-second window applies only to manual refreshes. | `backoff.test` (20 health reads ⇒ 1 spawn; version held inside the back-off; 5 concurrent ⇒ 1; windows independent) | Met. `noteUnknownModel` being called only from structural CLI errors is an M8-2 caller obligation. |
| **S12 / S12a / R2-3** cache | `cacheFile`: path from the enum plus `ACCOUNT_RE`, asserted inside `models/`. Folders are lstat-real, owned and 0700. The read path is: lstat (link ⇒ the link is removed; non-file or over 4 MB ⇒ quarantine), then `open(O_RDONLY\|O_NOFOLLOW\|O_NONBLOCK)`, then `fstat` on the handle (regular, owned, ≤ 4 MB), then a bounded read. `catalogFrom` requires `version === 1` exactly, plus matching provider and account, `source` from the enum, and an integer `fetchedAt`; a future `fetchedAt` is shown stale with no age. A newer file is left untouched and the result stays in memory only. Parse errors are never surfaced; the log text is static. At most 3 quarantined copies are kept. Families are recomputed, never read from disk. | `cache.test` (11 cases, including no `version`, 0, "1", 1.5, symlink target survives, fifo-like, over 4 MB, newer, forged date) | Met |
| **S13** API | `POST /api/models/refresh` accepts only a body whose prototype is `Object.prototype` and whose only own property (checked with `getOwnPropertyNames`) is `provider`; `provider` must be a registry id. It returns 202 and never awaits discovery. It runs behind the existing CSRF and same-origin gate. `GET` returns `viewAll()`, which builds each view from literal fields. | `api.test` | Met |
| **S14** logs | One line per refresh with counts, cliVersion, duration and leftover count; no ids or labels. The failure reason is scrubbed. CLI `--json` prints the same views. | `identity.test` S14 | Met |
| **S15** env | `claudeEnv` / `cursorEnv` (or the M8-3 `envFor` seam). | `spawn.test` S15 (key sets per tool) | Met |
| **S16** Cursor | Static reasons (sign-in; exit code only). Temp HOME with hooks and MCP: **0 of 7** markers. | `identity.test` (Cursor); evidence §S16 | Met. No positive control was run; accepted residual risk. |
| **S17** Codex dormant | `codex.ts` is a parser only, with `CODEX_DISCOVERY_ENABLED = false`. `view('codex')` returns the constant before any lookup. `bins()` only ever resolves claude and cursor, and `refresh` / `noteVersion` / `startup` exclude codex. | `backoff.test` "Codex is never touched"; `codex-parse.test` | Met |
| **R2-1** | Plan §1: a precedence note lists every superseded rev-1 statement. | — | Met |
| **R2-4** | Evidence footprint is counts and booleans only. | `fixtures-hygiene.test` scans the evidence | Met |
| **R2-5** | Overflow (cap or line) is checked first and is final, even after a valid reply. | `spawn.test` R2-5 | Met |
| **W1–W5, W7** | `modelIdOk(provider, id)`. `CLAUDE_MODEL_RE` (one `[a-z0-9]{1,8}` suffix) applies to Claude only. `MODEL_ID_BASE_RE` applies to Cursor, Codex and the default. `CODEX_MODEL_RE = MODEL_ID_BASE_RE` (narrow). The cache read re-checks per provider. The rule's comment points further widening back to Security. | `sanitize.test` W5 table (74 passes for Claude; 75, `x[1M]`, `x[effort=high]`, `-x[1m]`, `x[1m]\n` and others rejected); `cache.test` W1 on read; `hostile.test` Cursor W4 | Met |
| **W6** | Claude `[1m]` argv snapshot and Codex refusal at config load/save. | — | M8-2 obligation (no argv consumer in this slice) |
| **B1** no real CLI in tests | `runOnce` refuses inside `NODE_TEST_CONTEXT` without an injected spawn. Automatic discovery runs only with real health. | `no-real-cli.test` (setup wizard, demo boot and service paths: 0 spawns) | Met |

No new HTML sink, shell use, path built from a model id, or credential handling was introduced. Argv is constants only. stdin is the single constant `initialize` line for Claude and nothing for Cursor.

## Findings (Low, non-blocking)

**L1. Same-user TOCTOU windows in `chmodSync`.** This applies to `workdir.ts plainPrivateDir` and `cache.ts checkDir`. Both lstat the directory and then call `chmodSync(path)`, which follows a link. A process running as the same user could swap the directory for a symlink in between, so the chmod would land on the link's target. A same-uid attacker already owns the home, so this has no practical impact.
- Optional hardening: open the directory with `O_DIRECTORY|O_NOFOLLOW` and `fchmodSync` the handle, or re-lstat after the chmod.

**L2. `saveVersioned` follows links when it reads.** `writeCache` removes a link at the cache path first. But `saveVersioned → assertNotNewer` then reads with `readFileSync`, which follows links, so there is a same-uid race window between the two. The temp-then-rename write itself is safe (random temp name, rename replaces a link).
- Optional: skip `assertNotNewer` here, since `writeCache` already performs the newer check through the no-follow reader.

**L3. Cursor sign-in detection also matches stdout.** `AUTH_RE` is tested on stdout lines as well as stderr. A model label containing "Authentication required" would mark the list as signed out. The failure is closed (availability only), so there is no security impact.
- Optional: test stderr, or non-`id - Label` lines, only.

**L4. Recorded environment dependency.** Claude's model list depends on `CLAUDE_CODE_ENTRYPOINT` (13 entries vs 5). Conductor correctly does **not** pass it, since the allow-lists are unchanged. The 13-entry fixture is therefore a recording from inside a Claude Code session, not what production sees; the `-conductor-env` fixture pins what production sees. No action is needed, but do not add `CLAUDE_CODE_ENTRYPOINT` to `CLAUDE_KEYS` without a Security review: it changes what the CLI believes its host is.

## Carry-forward to M8-2 / M8-3 (from S19 and W6, restated)

- M8-2:
  - re-validate with `modelIdOk(provider, id)` at argv build;
  - pass each value as its own argv element (Codex `--model=` is the only fused form, narrow rule);
  - check Cursor ids against the discovered list;
  - add the W6 snapshot plus the Codex refusal at config load/save;
  - call `noteUnknownModel` only from structural CLI errors.
- M8-3:
  - per-account `CLAUDE_CONFIG_DIR` folders 0700, and the `envFor` seam limited to the allow-list;
  - keep `ACCOUNT_RE`;
  - showing the email is a separate Security decision.

Verdict: Approved
