# Security design sign-off: M8-1 Model discovery (F7a)

- Reviewer: TechTeam Security Engineer (independent of the plan author)
- Date: 2026-10-21
- Inputs: `.techteam/plans/workspace-v2-m8-1.md` (status pending_reviewer + pending_security_design), `.techteam/briefs/product-layer.md` (F7a safety bullets), `CLAUDE.md` (safety invariants). Code read at 8eaab46: `src/agents/env.ts`, `src/agents/spawn.ts`, `src/agents/providers/{probe,claude,cursor,codex,codex-home}.ts`, `src/agents/claude.ts`, `src/redact.ts`, `src/schema/version.ts`, `src/util.ts` (`atomicWriteFile`), `src/fsutil.ts`, `src/paths.ts`, `src/server/http.ts`, `src/server/api.ts`.
- Extra live facts from the Lead (2026-10-21, zero quota). They change S5 and S6. (a) The discovery argv plus `--no-session-persistence`, with `CLAUDE_CONFIG_DIR` set to an empty temp folder (signed out), exits 0 with 5 aliases and `account {tokenSource:'none', apiProvider:'firstParty'}`. Claude still **writes into the config dir**: `.claude.json` (keys `oauthAccount, firstStartTime, firstStartVersion, machineID, migration flags, seenNotifications, userID, pluginUsage`), `backups/.claude.json.backup.<ts>`, and an empty `sessions/`. No transcript is written. (b) Cursor signed out (`env -i`, empty HOME) exits 1 with "Error: Authentication required. Run 'agent login', …".
- Method: I read the plan as a design and checked every code claim it relies on against the clone. I ran no CLI and edited no plan or source text.
- Severity: **High** = untrusted CLI output, or a hostile file under the home, could reach argv, a shell, user files or secrets, or could spend quota. **Medium** = a privacy, integrity or liveness defect that is likely if the plan text stays as it is. **Low** = hygiene.
- Tags: **[BEFORE-EDIT]** = add the condition to the plan text before the first source edit. **[DURING]** = a constraint on implementation or tests. The Security code review checks it.

## Decision

**Approved with conditions.** No Critical or High finding. The design is sound: argv is built from constants only, the existing env allow-lists are reused, the cwd is an empty temp dir, Codex is disabled by a code constant, and the sanitiser runs on both write and read. Nine Medium items must be closed: S1–S4, S6, S8, S9, S11 and S12. S1–S7, S9, S11–S13 and S20 are BEFORE-EDIT.

## Threat model (summary)

| Asset | Threat | Where the plan stands |
| --- | --- | --- |
| User quota | Discovery spawn starts a model turn (a CLI change, or stdin read as a prompt) | No prompt is sent; the fake counts prompts. **Missing:** a live tripwire that kills the child on any session or turn event (S1) |
| User's Claude/Cursor setup (hooks, plugins, MCP, agents, commands) | Discovery runs user code, or leaks names of user agents/commands | `--safe-mode --strict-mcp-config --disable-slash-commands`; marker test planned for SessionStart only. The `initialize` reply carries `commands`/`agents`, and the raw stdout is kept in `stdoutTail` (S2, S5) |
| Account identity (email, organisation, userID) | Stored, logged, served, or committed in fixtures | Plan excludes email/org from the catalog. **Missing:** a scrub of reason/log text, fixture key allow-list, temp config dir disposal (S3, S7) |
| Claude config dir | Discovery writes `.claude.json` / backups / `sessions/` on every refresh | New fact (a). Same class as the existing read-only stages. Frequency must be bounded and `--no-session-persistence` made mandatory (S6, S11) |
| Future argv (M8-2) | A hostile id or effort reaches `--model`/`-c` | `MODEL_ID_RE` (first char alnum ⇒ no option injection), effort allow-list, `spawn` without a shell. **Missing:** "ids never become paths", own-property parsing, a stricter Unicode class (S8, S9) |
| Conductor home | Hand-edited, symlinked or huge cache file; traversal through provider/account | Enum provider, account regex, versioned atomic write, re-validation on read. **Missing:** lstat/no-follow, a size cap, and a parse-error message that can echo file bytes (S12) |
| Process / host | Hung child, output flood, refresh hammering, auto-trigger loop | 15 s bound, one in flight, 10 s manual window. **Missing:** raw-byte cap enforcement (runProcess has no byte hook), a back-off for automatic triggers, abort on shutdown (S4, S10, S11) |
| Dashboard | CSRF, cross-site GET, lax body | Existing loopback + cookie + CSRF + Sec-Fetch-Site. Strict body planned (S13) |

## Binding conditions

### Claude `initialize` spawn

**S1 [BEFORE-EDIT] (Medium): Fail-closed tripwire against a turn.** The adapter treats any stdout object as a protocol violation if it has `type` ∈ {`assistant`, `user`, `result`, `stream_event`, `rate_limit_event`}, or `type:"system"` with `subtype:"init"`. On a violation it aborts at once through the `signal` (process-group kill), and the outcome is `unavailable` with the reason "Claude started a session during model discovery; discovery stopped". It never retries automatically. As soon as the matching `control_response` has been parsed, the adapter also aborts the child; it does not wait for a natural exit. Tests: a fake scenario `models:'turn'` emits `system/init` and then an `assistant` line, and the test expects kill + `unavailable` + zero cache write. The existing `models:'in'` scenario must show the child terminated right after the reply.

**S2 [BEFORE-EDIT] (Medium): Only `models` and `account` are read; the raw reply never leaves the adapter.** The parsed `control_response` object is reduced at once to (a) `response.response.models` and (b) the four booleans or short strings S3 allows. The object's other keys (`commands`, `agents`, `output_style`, `pid`, …) must never reach a log, a `reason`, an event, the cache, the API or an error. `SpawnResult.stdoutTail` is **never** used for Claude discovery text. Any CLI detail in a reason comes only from `stderrTail`, put through `redact()` plus the S3 scrub and truncated to 200. Test: the fake's reply contains a decoy `commands:[{"name":"DECOY_CMD_7f3"}]`, `agents:["DECOY_AGENT_7f3"]` and an `@`-shaped string. The test greps the cache file, the API JSON, the log file and `reason` for `DECOY_` and expects zero hits.

**S3 [BEFORE-EDIT] (Medium): Identity scrub covers every output path.**
- From `account`, keep only: `signedIn` (a boolean computed from `typeof email === 'string' && email.length > 0`, or `tokenSource` present and `!== 'none'`), and `plan` (`subscriptionType`, cleaned, kept only if it matches `^[A-Za-z0-9 _-]{1,40}$`, else omitted).
- Never store raw `tokenSource`, `apiProvider`, `organization`, `email`, `userID` or `machineID`.
- For the duration of that refresh, pass `email` and `organization` to `redact()` as exact-match secrets. `redact` ignores values shorter than 8 characters, so additionally apply an email-shape scrub (`[^\s@]{1,64}@[^\s@]{1,255}` → `[email]`, bounded) to every reason and log detail from **all three** providers.
- AC7 is extended to cover the reason strings and the evidence file of AC9.

**S4 [BEFORE-EDIT] (Medium): The output caps are enforced on raw bytes and they kill the child.** `runProcess` has no per-chunk hook. `onLine` only sees complete lines, and the existing runaway guard silently keeps up to about 4 MB of an unterminated line. Pick one of these (Reviewer's choice) and write it into the plan:
- (a) Add an optional `maxOutputBytes` (or `onChunk`) to `SpawnOpts`, default undefined so every existing call is byte-identical. On breach it sets a flag and terminates the group.
- (b) Count bytes in `onLine` and abort through `signal` at 2 MB total or 512 KB per line. The plan must also accept that an unterminated flood is bounded only by the 4 MB guard plus the 15 s timeout, and must state that bound.

Either way the outcome is `unavailable` "the reply was too large", and nothing is cached. Test: the fake `huge` scenario covers both a no-newline flood and many lines.

**S5 [BEFORE-EDIT] (Low, evidence): Hook/plugin/MCP marker test, broadened, and the plan text corrected.**
- Correct §1 "nothing written to the cwd" to also say: "the config dir IS written (`.claude.json`, `backups/`, `sessions/`)".
- The live check (zero quota) uses a temp `CLAUDE_CONFIG_DIR` containing:
  - `settings.json` with `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse` and `Stop` hooks that each touch a distinct marker;
  - an `mcpServers` stdio entry, in `.claude.json` and in a `.mcp.json` placed in the temp **cwd**, whose command touches a marker;
  - if feasible, a local plugin with a SessionStart hook.
- Pass: no marker exists after the run, `sessions/` is empty, and the cwd holds nothing except the planted `.mcp.json`.
- Record the result in the evidence file. If any marker appears, discovery stays disabled for Claude, and that is a hard block back to Security.

**S6 [BEFORE-EDIT] (Medium): Config-dir writes are bounded and accepted explicitly.**
- `--no-session-persistence` is **mandatory** in the constant argv. The Lead verified the handshake still works with it, so the plan's "dropped if it breaks" escape is removed. If a future version rejects the flag, the outcome is `unavailable`; the flag is never silently omitted.
- Residual risk accepted for this slice: each refresh writes the user's real `~/.claude.json` and a backup, exactly as every read-only stage already does. The automatic-refresh budget in S11 bounds how often.
- In tests and fixture recording, `CLAUDE_CONFIG_DIR` points at a temp dir under the scratch/test home. It is removed afterwards. Its `.claude.json` (it holds `userID`/`machineID`) is never copied into `fixtures/` or evidence.
- M8-3 note, not binding here: per-account config dirs must be 0700 Conductor-owned folders. Discovery writes into them on every refresh.

**S7 [BEFORE-EDIT] (Low): Fixtures are scrubbed and checked by test.** The recorded Claude fixtures contain only the top-level keys needed to reproduce the reply envelope, plus `models` and an `account` with placeholder values. A test asserts that the fixture's key set is an allow-list, and that no fixture or evidence file matches the email shape or contains the keys `userID`, `machineID`, `oauthAccount`, `commands` or `agents`.

Optional, not binding: if the installed `claude --help` lists a no-tools option (e.g. `--tools ""`) or `--max-turns 1` and the handshake still works with it, add it as belt and braces. Otherwise note in the plan why not.

### Sanitiser and data model

**S8 [DURING] (Medium): Parse untrusted objects field by field.**
- Read every CLI/cache value through `Object.hasOwn` plus a `typeof` check. Reuse the `own()` pattern in `providers/codex.ts`.
- Never spread or `Object.assign` a CLI or cache object into a `ModelEntry`/`Catalog`. Build each entry from literals.
- Flags are stored only when the source value `=== true`.
- `efforts` and `defaultEffort` must each be in `EFFORT_TOKENS`, de-duplicated, with at most 7 entries.
- Tests: a reply containing `"__proto__":{"isDefault":true}` and `"constructor"` keys leaves no polluted prototype and no extra fields.

**S9 [BEFORE-EDIT] (Medium): A stronger Unicode rule and safe truncation in `cleanText`.**
- Order: NFC first, then strip every code point in `\p{Cc}`, `\p{Cf}`, `\p{Zl}`, `\p{Zp}`, `\p{Co}`, and lone surrogates (regex flag `u`).
- `\p{Cf}` already covers the plan's zero-width and bidi lists plus soft hyphen, U+2061–2064, U+FFF9–FFFB and the tag block U+E0000–E007F (used for ASCII smuggling). `Zl`/`Zp` (U+2028/2029) break log lines.
- Collapse whitespace, then truncate by **code point**, never by UTF-16 unit, so no lone surrogate is created.
- Ids are cleaned and must then match `MODEL_ID_RE` exactly. The id rule keeps a leading alphanumeric character, so no id can be read as an option.
- Model ids, labels and families are **never** used to build a file path, a shell string, a regex or an HTML string. Spawn stays shell-less.
- Test per character class. Non-binding product note for the Reviewer: Claude `value`s such as `opus[1m]`, if present, would be dropped by today's rule. If the rule is widened (e.g. an optional `\[[a-z0-9]{1,8}\]` suffix), keep the leading alphanumeric, keep spawn shell-less, and bring it back to Security.

### Process lifecycle

**S10 [DURING] (Low): Clean up the process and the temp dir.**
- The temp cwd is `mkdtemp(paths.runtime()/discovery-)` (0700). It is removed in a `finally` **after** `runProcess` resolves, which means the group has been killed or reaped. Remove it only if `lstat` shows a real directory at exactly that path.
- `ModelService.stop()` aborts in-flight discoveries through their `AbortSignal`, and the service shutdown calls it.
- On startup, stale `discovery-*` dirs older than 1 h are swept: lstat-checked, owned by the current user, not followed.
- Test: the hung fake is killed by the 15 s budget. The worst case is 15 s + 5 s grace + 0.75 s drain, so state it as about 21 s in the docs. The temp dir is gone afterwards, and the service still answers `view()` while discovery is hung.

**S11 [BEFORE-EDIT] (Medium): A back-off for automatic triggers, so no refresh loop can occur.**
- `noteVersion`, `startup` and `noteUnknownModel` each refresh at most once per provider and account per 5 minutes after a **failed** discovery, and at most once per distinct `cliVersion` value per process.
- Reason: when discovery keeps failing, the cache's `cliVersion` never updates, so a naive "version differs" check would respawn on every health refresh. Cursor also self-updates.
- Only the manual `POST /api/models/refresh` (and the CLI `--refresh`) may go down to the 10 s window.
- `noteUnknownModel` may be called only from a structural CLI error classification, never from model prose (the house rule from the Codex adapter).
- Tests: fake discovery failing repeatedly plus 20 health refreshes ⇒ 1 spawn. Five concurrent calls ⇒ 1 spawn (already AC5).

### Cache integrity

**S12 [BEFORE-EDIT] (Medium): Cache files are opened without following links, size-capped, and the parse error is not echoed.**
- `paths.models()` and `models/<provider>/` are created 0700. Each must be a real directory per `lstat` (not a symlink) and owned by the current uid; otherwise the outcome is `unavailable` "the model cache folder is not a plain folder". Follow the `prepareCodexHome` pattern.
- The file path is built only from the `ProviderId` enum and an account matching `^[a-z0-9][a-z0-9-]{0,31}$`. Assert the joined path is inside `paths.models()`.
- Before reading: `lstat` must show a regular file (not a symlink), and its size must be ≤ 4 MB. Otherwise it counts as "no cache". A symlink is unlinked or quarantined; its target is never touched.
- Do not surface `CorruptFileError` / `JSON.parse` messages. V8 includes a snippet of the file text in the message, so a symlink to `~/.ssh/id_*` or a hand-edited file would echo content into the log. Log a static "the model cache file was unreadable and was set aside".
- The catalog's version field must use `VersionSpec.field` (`'version'` or `'schemaVersion'`; the plan's `v` does not fit the type). A file without the field is treated as corrupt, not migrated.
- Writes use `saveVersioned` (mode 0600). `atomicWriteFile`'s rename replaces a link at the final path rather than following it; this is acceptable once the directories have been verified.

**S12a [DURING] (Low): Read-path cross-checks.**
- The stored `provider` must equal the provider in the directory name, and `account` must equal the file name.
- `fetchedAt` must be a finite integer that is not more than 5 minutes in the future (otherwise the entry is "stale" with no age shown). A forged far-future `fetchedAt` must not make a cache look fresh forever.
- `source` comes from the enum. `cliVersion` is cleaned and ≤ 60 characters.
- No more than 1,000 models after re-validation.
- `families` are always recomputed and never read from disk.
- Repeated quarantines are capped: keep the newest 3 `.corrupt-*` per file.

### API, CLI, logs

**S13 [BEFORE-EDIT] (Low): The API is strict and minimal.**
- `POST /api/models/refresh` requires: `isPlain(body)`; every own key ⊆ {`provider`}; `provider` absent, or a registry `ProviderId` checked with `Object.hasOwn`; no prototype keys. Anything else is 400. It goes through the existing CSRF and Sec-Fetch-Site path, so a missing CSRF header is 403 (AC8).
- A manual refresh inside the 10 s window returns 202 with the cached view. It does not return 429, so the UI need not handle a new error.
- `GET /api/models` serves only `CatalogView` fields. There is a test that the JSON key set is an allow-list per level.
- No absolute paths appear in any `reason`.
- An I/O error is a static reason, never a 500 carrying a path.

**S14 [DURING] (Low): Logs.** Write one line per refresh with exactly the plan's fields. Labels and ids are never logged; counts only. CLI detail is included only after `redact()` + the S3 scrub + truncate to 200. `conductor models --json` prints the same allow-listed view as the API.

### Environment

**S15 [DURING] (Low): Env assertions per tool.** The env is exactly `claudeEnv(d.extraEnv)` or `cursorEnv(d.extraEnv)`, with no new keys. Tests spy on `runProcess`:
- Claude env keys ⊆ BASE ∪ CLAUDE_KEYS ∪ `ANTHROPIC_*` ∪ {`PATH`, `GIT_TERMINAL_PROMPT`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `DISABLE_AUTOUPDATER`}. It contains no `CURSOR_*`, `LINEAR_*`, `OPENAI_*` or `CODEX_*`.
- Cursor env keys ⊆ BASE ∪ CURSOR_KEYS ∪ {`PATH`, `GIT_TERMINAL_PROMPT`}. It contains no `ANTHROPIC_*`, `CLAUDE_*`, `LINEAR_*`, `OPENAI_*` or `CODEX_*`.

`ANTHROPIC_*` passthrough (including `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL`) is accepted. It matches the stages, and no tokens are spent without a turn (S1). The variable values are never logged.

**S16 [DURING] (Low): Cursor residual risk and its evidence.** `agent --list-models` runs with the user's real HOME, which is needed for sign-in. This is the same exposure the read-only stages already accept.
- Zero-quota evidence: with a temp HOME holding a `~/.cursor/hooks.json` whose hooks touch markers, and a `~/.cursor/mcp.json` stdio server that touches a marker, run signed out (exit 1, "Authentication required"). No marker may appear.
- The Cursor reason is the static "Sign in to Cursor to see its models". The CLI message is not echoed, apart from the S3-scrubbed detail if the plan keeps it.
- The cwd is the empty temp dir, so no repo `.cursor/` can apply.

### Codex

**S17 [DURING] (Low): Codex is dormant in fact, not just hidden.** While `CODEX_DISCOVERY_ENABLED === false`, the service must not resolve the binary, prepare the home or spawn. AC3 must use a `runProcess` spy that sees zero calls.

**S18 [BEFORE-EDIT text, enforced later] (Medium when enabled): Enabling Codex discovery is a separate Security gate.** It is not "a one-line change". It requires all of the following:
- the private `CODEX_HOME` through `prepareCodexHome()` (hygiene pre-flight, fail closed), under `withCodexHomeLock`;
- `HOME` from `makeScratchHome()`, env from `codexEnv`;
- JSON-RPC methods restricted to an allow-list: `initialize`, the `initialized` notification, `model/list` (≤ 10 pages, cursor ≤ 256 characters, cleaned);
- never any `thread/*`, `turn/*` or `exec*` request;
- the process killed once the last page arrives, because an app-server may not exit on EOF;
- a live zero-quota check that no turn starts and that the private home is unchanged apart from allowed entries.

Amend §2.2 "Enabling it is a one-line change" accordingly.

### Forward constraints for M8-2 / M8-3 (recorded now so the cache shape does not have to change)

**S19 [DURING, recorded] (Low):**
- M8-2 builds argv only from a catalog entry re-validated at use time (`MODEL_ID_RE`, effort ∈ the entry's `efforts`), or from a custom id validated by the same rule.
- Every id is passed as its own argv element; Codex's `--model=<id>` is the one fused form allowed.
- Cursor ids are composed and must exist in the discovered list (fail closed).
- Labels are rendered with `textContent` only.
- `noZdr` is only ever shown as a warning (§6 Q8 pending).
- M8-3 keeps the account regex and S3 (email display is a separate Security decision).

**S20 [BEFORE-EDIT] (Low): Plan bookkeeping.** Add S1–S19 to §2/§5 and to the AC list. AC6 gains the S1 tripwire and the S4 byte cap. AC7 gains the S2/S3 decoys. Add the S12 symlink/size/forged-`fetchedAt` cases to AC5. Add the S5/S16 marker evidence to AC9.

## Non-findings (checked, no change needed)

- CSRF, loopback and cookie: mutations go through the existing gate in `src/server/http.ts` (content type, `x-conductor-csrf`, Sec-Fetch-Site/Origin). GETs refuse cross-site Sec-Fetch-Site. The body is capped at 1 MB.
- Option injection: the ids' first character must be alphanumeric, `spawn` uses no shell, and the argv is constants. Discovery itself takes no runtime value into argv.
- Process-group kill on timeout and on Conductor exit: `runProcess` is detached, uses `killGroup` SIGTERM→SIGKILL, and has an exit hook.
- Codex parser regex DoS: the Cursor line regex `^([^\s]+) - (.+)$` is linear, and lines are capped.

## Unblock condition

Implementation may start once the Reviewer has approved and S1–S7, S9, S11–S13, S18 (text) and S20 are in the plan text. Release of the slice needs the Security code review to confirm S1–S17 with test evidence, plus the S5/S16 marker evidence recorded in `.techteam/runs/evidence/`.

Verdict: Approved with conditions

---

## Rev 2 check (2026-10-21)

Input: `.techteam/plans/workspace-v2-m8-1.md` rev 2, sections §2b (S1–S20 restated as binding, with this file named as the authoritative text) and §2c (Reviewer round-1 changes B1–B5 and N1–N13). I read the full plan again; no code changed.

**What rev 2 satisfies**
- **S1–S9, S11–S13, S20:** §2b restates each one correctly.
- **S4:** B2 adds `SpawnOpts.maxOutputBytes`. It counts raw stdout+stderr bytes before line splitting, kills the process group, and is off by default. That is option (a) of S4.
- **S17/S18:** B4 is stronger than what I asked for. There is no Codex spawn code and no home preparation, only a parser. Enabling Codex is its own plan plus S18. The §2.2 wording now says "separate Security gate".
- **S15 and S6 (test side):** B1 means `npm test` can never reach a real CLI. The `NODE_TEST_CONTEXT` refusal and the zero-spawn guard test across runtime-creating tests back this up.
- **S3:** B5(b) `scrubIdentity` with a stderr-email fake covers it.
- **S10 (abort part):** B1 `Runtime.close()` → `models.stop()` covers it.
- **N6:** the CLI refuses to refresh while a server is running, so a second process cannot discover in parallel. I accept this.

**N2 (a stable cwd `<home>/run/discovery`) against S10: accepted.** A stable path stops each refresh adding a new project entry to the user's `~/.claude.json` and `~/.claude/projects`. That is a real privacy and hygiene gain over a fresh temp dir. The trade-offs are concurrency between providers and content planted between runs persisting. With R2-2 below, S10 becomes:

**R2-2 [BEFORE-EDIT text, Medium]: Rules for the stable discovery cwd** (this replaces the temp-dir clauses of S10):
- (a) Folder ownership: `<home>/run` and `<home>/run/discovery` must each be a real directory by `lstat`, owned by the current uid, mode 0700. Tighten the mode, otherwise refuse with `unavailable` "the discovery folder is not a plain private folder".
- (b) Cleaning before every spawn: remove every entry with `rmSync(entry, {recursive:true, force:true})`, which removes a symlink itself and never its target. Then re-check that the folder is empty. If it is not empty, refuse (`unavailable`) and do not spawn.
- (c) After every run, once the process group has been reaped: clean the folder again and log only the count of leftover entries, never their names.
- (d) **All discovery spawns that share this folder are serialised (a queue of 1 across providers and accounts).** Without this, Claude and Cursor discoveries running at the same time, or two M8-3 accounts, would clean the folder under a live child. "One in flight per (provider, account)" does not cover this. Alternatively, use per-provider subfolders `<home>/run/discovery/<provider>` with a per-folder lock; either option is acceptable.
- (e) The `discovery-*` sweep in S10 is dropped. The worst-case kill time (about 21 s) is still documented. Add tests for (b), (c) and (d): a planted `.mcp.json`, a planted symlink to an outside file (the target survives), and two providers refreshing at once (the spy shows the spawns never overlap).

**R2-1 [BEFORE-EDIT text, Low]: Stale rev-1 lines contradict §2b/§2c.** Fix each line, or add one sentence saying that §2b and §2c override §2–§7 where they conflict. The stale lines are:
- §2.2 Claude row: "dropped if it breaks the handshake" (contradicts S6: the flag is mandatory).
- §2.2 Spawn bullet: `mkdtemp(...discovery-)`, "removed afterwards", `codexEnv` (contradicts N2, R2-2 and B4).
- §2.3 `cleanText` character list (contradicts S9).
- §2.6 `noteVersion` with no back-off (S11).
- AC6: "empty temp dir removed afterwards" (N2).
- §5: "cwd empty and removed".
- §6: a SessionStart-only marker test (S5).
- §4: "wiring in `service.ts`" (it is `runtime.ts`, per B1).
- §2.5: `kind:'models'` (B3 says `'model cache'`).

**R2-3 [DURING, Medium]: B3's version rule is not what `loadVersioned` does.** With `assumeWhenMissing: 0` and no migration registered for 0, `loadVersioned` returns the data as-is (`fromVersion 0`, `migrated false`). It does **not** throw. The cache loader must therefore explicitly treat `fromVersion !== 1` as corrupt, and quarantine it under the S12a limits. `loadVersioned` also reads with `readFileSync` and no `lstat` or size check. So S12's regular-file, no-symlink and ≤ 4 MB checks must run **before** calling it, and its `CorruptFileError` text must never be logged (S12). Add a test: a cache file without `version` ends up quarantined and not served.

**R2-4 [DURING, Low]: The AC9 evidence for N2 records counts only.** The before/after check of `~/.claude.json` project keys and the `~/.claude/projects` listing records only the counts and a single yes/no: whether a key for `<home>/run/discovery` exists. It never records key names or folder names, because those are the user's repository paths. S7's grep for email and identity keys also applies to this evidence file.

**R2-5 [DURING, Low]: Overflow is final.** When `SpawnResult.overflow` is true, the outcome is `unavailable` even if a valid `control_response` or list lines arrived before the overflow. No partial catalog is ever cached.

Verdict (rev 2): BEFORE-EDIT conditions S1–S7, S9, S11–S13, S18 and S20 are satisfied by §2b/§2c, and N2 is accepted, provided R2-1 and R2-2 are in the plan text before the first source edit. R2-3 to R2-5 are checked at the Security code review.

Verdict: Approved with conditions

---

## S9 widening ruling (2026-10-21)

**Request (from the Lead).** Widen the model id rule to `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}(?:\[[a-z0-9]{1,8}\])?$`. Live finding behind it: Claude 2.1.304's `initialize`, run with Conductor's env, returns `claude-fable-5-1[1m]`, which today's rule drops. The user chose to allow a short bracket suffix.

**Analysis.** The suffix adds no injection surface in our spawn model:
- The first character stays alphanumeric, so no value can be read as an option.
- Each value is its own argv element and no shell is involved, so `[`/`]` are never a glob.
- At most one suffix is allowed, holding only `[a-z0-9]` (no `=`, `,`, space or quote), and the total length is capped at 74.
- The regex is linear: no ReDoS.
- The S9 guarantees still hold: model ids are never used in a path, shell string, regex or HTML; they are logged as counts only and shown via `textContent`.

The suffix does carry **meaning** to a CLI, though: Claude reads `[1m]` as a context-size variant, and Cursor's documented `id[effort=…,fast=…]` shows that Cursor parses brackets as parameters. A wide rule for a tool that never reported such an id only widens what a custom id or a hand-edited `toolModels` value can ask that tool to do.

**Ruling.** I approve the widened rule **for Claude only**:

- **W1: The rule is chosen per provider and named that way.**
  - `MODEL_ID_BASE_RE` = today's rule, value unchanged.
  - `CLAUDE_MODEL_RE` = the proposed rule above.
  - `modelIdOk(provider, id)` is the single entry point; there is no global "wide" rule.
- **W2: Claude.** `CLAUDE_MODEL_RE` applies to discovered Claude ids, custom Claude ids, and Claude's entry in `toolModels`. It is re-checked at use (S19). `--model <x[1m]>` is approved as a separate argv element.
- **W3: Codex.** `CODEX_MODEL_RE` stays **narrow** at its current value. `--model=<id>` stays the one fused form and gets no brackets. No Codex catalog has been observed (discovery is disabled), and Codex has no documented bracket semantics. Widening it needs its own ruling, with evidence of a real Codex id that needs it.
- **W4: Cursor.** The narrow base rule applies to Cursor ids, custom ids and `toolModels`, **and** the id must still exist in the discovered list (fail closed). The recorded 265 ids all pass the narrow rule. Because brackets are Cursor's parameter syntax, a bracketed Cursor value is refused even when it is a custom id.
- **W5: Tests**, one accept/reject table per provider:
  - Accepted for Claude, rejected for Codex and Cursor: `claude-fable-5-1[1m]`, `opus[1m]`.
  - Rejected for all three:
    - malformed suffixes: `x[1m][2m]`, `x[1M]`, `x[effort=high]`, `x[1m,fast]`, `x[ 1m]`, `x[]`, `x[123456789]`, `x[1m]y`;
    - bad starts: `[1m]`, `-x[1m]`;
    - trailing whitespace: `x[1m]\n`, `x[1m] `;
    - length: a 75-character value. A 74-character value passes for Claude.
  - The real signed-in fixture keeps its `[1m]` entry with 0 dropped. AC1's counts are updated from the new live recording.
- **W6:** The M8-2 argv snapshot includes one Claude `--model claude-fable-5-1[1m]` case. A Codex config holding `x[1m]` is refused at config load or save with a human message, and never reaches argv.
- **W7:** Writing the rule names the Claude-specific suffix explicitly in the S9 / §2.3 text. Any later widening (other bracket contents, other providers) comes back to Security.

Verdict: Approved with conditions
