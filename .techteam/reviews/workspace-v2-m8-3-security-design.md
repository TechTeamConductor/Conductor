# Security design sign-off: M8-3 Accounts and automatic switching (F8 engine + API/CLI)

- Reviewer: TechTeam Security Engineer (independent of the plan author, agent abc732b6677fdd931)
- Date: 2026-10-21
- Inputs:
  - `.techteam/plans/workspace-v2-m8-3.md` rev 1 (status pending_reviewer; §2T T1–T15; §2.0 Q4; AC10 L1–L4);
  - the **user decisions relayed by the Lead on 2026-10-21**, which supersede parts of rev 1 (see "Inputs that changed");
  - `.techteam/briefs/product-layer.md` (F8, Q4), `.techteam/plans/workspace-v2-m8-1.md` and `.techteam/reviews/workspace-v2-m8-1-security-design.md` (S3, S6, S13, S16, S19, R2-2), `CLAUDE.md` safety invariants.
- Code read at clone HEAD `8eaab46` plus the working-tree M8-1 diff: `src/agents/{env,spawn,routing,claude,cursor,provider}.ts`, `src/agents/providers/{claude,cursor,codex-home,registry,verification,types}.ts`, `src/secrets.ts`, `src/redact.ts`, `src/log.ts`, `src/pipeline/{engine,envelope}.ts`, `src/git/worktree.ts` (`agentGitEnv`, Cursor guard), `src/git/branchscan.ts`, `src/server/{api,http}.ts`, `src/lock.ts`, `src/paths.ts`, `src/runtime.ts`, `src/cli.ts`, `src/models/{service,sanitize}.ts`, `test/live/cursor-nopush.test.ts`.
- Method: design review only. I ran no CLI and edited no plan or source text. This file is the only thing I wrote.
- Severity: **Critical** = would ship a credential to the wrong process or a push path. **High** = an untrusted process or file could obtain a credential, redirect work to another identity, or run code in a Conductor-spawned child. **Medium** = a likely integrity or privacy defect if the text stays as it is. **Low** = hygiene.
- Tags: **[BEFORE-EDIT]** = must be in the plan text (rev 2) before the first source edit. **[DURING]** = a constraint on implementation and tests, checked by the Security code review. **[LIVE]** = a stop condition that the user runs, with permission.

## Inputs that changed after rev 1 (user decisions, binding on rev 2)

1. **D-A: chain-only.** Switching never goes beyond the role's configured chain. This closes T15. My ruling on the rev 1 option is kept below for the record.
2. **Q4: sign-in only through each tool's own CLI login. No pasted keys or tokens.**
   - Claude: per-account `CLAUDE_CONFIG_DIR` plus `claude auth login` (= C1). C2 is out.
   - Cursor: **K1 is rejected.** Instead, each named Cursor account gets its own private HOME (0700) and `AGENT_CLI_CREDENTIAL_STORE=file`. With these, cursor-agent 2026.10.19 keeps the login at `<HOME>/.cursor/auth.json` instead of the shared Keychain entry, and the user signs in with `agent login`. `CURSOR_CONFIG_DIR` moves config separately. Spawns for that account, builds included, run with `HOME=<account home>`.
   - Consequences: §2.5 (`AccountSecrets`, Keychain item `account.cursor.<id>.apiKey`, no-echo key entry) disappears. **Conductor now holds no account credential at all.** T5/T7 shrink. T6 changes shape (S14–S20 below). The build envelope's HOME rule is now affected (S17).

## Decision

**Approved with conditions.**
- There is no Critical finding in the design as amended by the user's decisions.
- There are six High items. Each is closed by plan text plus a live stop condition: S2 (fallback to the default sign-in), S5 (planted Claude config), S14/S15 (Cursor account HOME hygiene and planted config), S17 (changed isolation profile for Cursor builds), and S21 (staged live checks that could otherwise overwrite the user's own sign-in).
- The isolation that per-account folders give protects against **accidental** credential crossing: the parent env, a wrong folder, or a fallback to the default sign-in. It is **not** a boundary against a hostile same-user process. The Cursor builder and repository gate code run as the same user without a sandbox (`src/git/worktree.ts:979`: "defence in depth under a same-user threat model, not a sandbox"). They can read any account folder by absolute path, and they can read Conductor's own Keychain items through `/usr/bin/security` without a prompt. The plan, the docs and the Accounts UI must say this plainly (S20).

## Q4 recommendation (security standpoint)

| Tool | Ruling | Why |
| --- | --- | --- |
| Claude | **C1 (per-account `CLAUDE_CONFIG_DIR` + `claude auth login`). Approved, with S3–S7 and L1–L3.** | No token ever passes through Conductor, an env var or argv. Claude refreshes its own login. The measured "empty dir ⇒ `tokenSource:"none"`" fact is the right fail-closed default. The cost is a config folder that must be policed (S5), and Keychain keying per folder that has not been verified (L2, S21). |
| Claude | C2 (long-lived `setup-token` in `CLAUDE_CODE_OAUTH_TOKEN`). **Not recommended** (and now excluded by the user) | Conductor would hold a subscription token valid for about a year. It would sit in every child env (`ps eww`), be inherited by anything the child spawns, and need manual rotation. It would be acceptable only as a fallback if L2 fails, and then only under a new Security review. |
| Cursor | K1 (API key in Conductor's store → env). **Rejected by the user.** From a security standpoint it was acceptable with conditions. | Its exposure was the key in the builder's env, plus Keychain items readable through `security`. |
| Cursor | K2 (`CURSOR_AUTH_TOKEN` copied from a session). **Not acceptable.** | Conductor would extract and hold a session token. That is fragile, the token expires, and it is a pasted token (excluded by the user anyway). |
| Cursor | **Per-account HOME + `AGENT_CLI_CREDENTIAL_STORE=file` + `agent login` (user's choice; K3 variant). Approved, with S14–S20 and L4–L5.** | Conductor holds nothing, and each account's login is the CLI's own. The new costs: (a) the token is a **plaintext file** that any same-user process can read silently. Today the default Cursor login sits in a Keychain entry that cursor-agent created, which other binaries cannot read without a prompt, so this is a real downgrade for named accounts and must be disclosed (S20). (b) The builder now runs with a HOME it can write, and that HOME holds Cursor's user-level config (S14/S15). (c) The build isolation was proven with the real HOME (S17). |
| Codex | **X1 dormant: approved as specified.** | Adding a named Codex account is refused in this slice. Enabling it is its own Security gate (S24). |

## Rulings on the decisions in §2T

- **D-A / T15: chain-only (user decision), and I concur.**
  - The rev 1 widening would have broken the existing rule that an automatic choice never lowers the isolation tier for read-only roles (`routing.ts`: a complexity pick "NEVER at a lower isolation tier than the chain head").
  - It would have moved Claude-only roles (Quick Ask, requirements, architecture) from `verified` (Claude, fail-closed init) to `partial` (Cursor ask mode, with workspace trust) without the user choosing that.
  - If the design ever reopens this: an auto-joined tool must have tier ≥ the chain head's tier for read-only roles. That makes the widening a no-op for every default chain. S10 makes chain-only binding.
- **T2: accepted as proposed.** The `default` account stays byte-identical, including the parent passthrough of `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `CURSOR_API_KEY` and `CURSOR_API_ENDPOINT`.
  - Named accounts drop all of them, from `src` **and** from `extra` (S1).
  - Product note (non-binding): a user who routes Claude through a local proxy with `ANTHROPIC_BASE_URL` will find that named accounts bypass it. That is the safe direction. Document it.
- **T4: top level alone is not enough.** Ruling in S5:
  - an exact top-level allow-list (L1);
  - no symlinks at depth ≤ 2;
  - no hard-linked top-level files;
  - a key check on `.claude.json`.
  Transcript contents are not inspected.
- **T6: re-framed by the user's Cursor choice.**
  - The account's credential no longer sits in the builder's env. It sits in the builder's HOME (`~/.cursor/auth.json`), and other accounts' credentials are one absolute path away.
  - Option (b) "named accounts read-only only" would remove the main value (switching builds on a limit) and would not stop absolute-path reads. It is rejected **except** as the fail-closed state until L5 passes (S17).
  - Accepted residual with S16 (redaction by shape), S19 (logout on removal) and S20 (disclosure).
- **T9:** M8-3 adds no new identity surface (S12). The existing `providers[].detail` "Signed in as <email> · <org>" (`providers/claude.ts:28`) and the limit reason that embeds it (`server/api.ts:149-152`) go to **M8-5 as a forward condition** (S23). They are not a blocker for M8-3.
- **T10: accepted.** The unix control socket's same-user boundary stands. It is the same boundary as `POST /otp`, which already gives a same-user process a full dashboard session. The new routes add no power beyond that, under S11.
- **T12: not acceptable as written.**
  - Removing an account and later re-adding one with the same name gives the same id, so the same folder path and therefore the same Claude Keychain key. The old sign-in comes back silently, possibly a different person or organisation (a T1 crossing).
  - Ruling (S8): ids carry a random suffix and are never reused; removal signs out by default.

## Binding conditions

### Account identity and paths

**S1 [BEFORE-EDIT] (High): The named-account env is built in one place, the credential env keys are set last, and nothing upstream can supply them.**

`accountEnv(provider, ref, extra, src)`:
- **Default** ⇒ exactly today's `claudeEnv` / `cursorEnv` / `codexEnv` (golden test, as AC1).
- **Named Claude** ⇒
  - remove `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, every `ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, `AWS_*` and `CURSOR_*` from **both** `src` and `extra`;
  - then set `CLAUDE_CONFIG_DIR = profileDir(ref)` last.
- **Named Cursor** ⇒
  - remove `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`, `CURSOR_API_ENDPOINT`, `CURSOR_CONFIG_DIR`, `AGENT_CLI_*`, `HOME`, `XDG_*`, `ANTHROPIC_*` and `CLAUDE_*` from both `src` and `extra`;
  - then set `HOME = accountHome(ref)`, `AGENT_CLI_CREDENTIAL_STORE = 'file'` and, if L4 shows it is needed, `CURSOR_CONFIG_DIR = accountHome(ref)/.cursor`, all last.
- **Default Cursor** never contains `AGENT_CLI_CREDENTIAL_STORE` or `CURSOR_CONFIG_DIR`. Neither is in today's allow-list, so this holds already; keep a test.
- The build path (`req.env` from the envelope) can never carry `HOME`, `CURSOR_*`, `AGENT_CLI_*` or `CLAUDE_CONFIG_DIR` into a named-account child. They are dropped before the account keys are set, and `FORBIDDEN_PREP_ENV` keeps refusing `HOME`/`XDG_*` from `prepare`.

**S2 [BEFORE-EDIT] (High): `assertAccountEnv` runs inside every adapter immediately before `runProcess`, and it fails closed with zero spawn.** This covers stage, build, research, discovery/check, `auth status`, `--version`, login and logout.

For a named account it throws (`errorKind: 'isolation'`, static message, no values) unless all of the following hold:
- Claude:
  - `CLAUDE_CONFIG_DIR` equals the expected profile path;
  - none of `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, `AWS_*`, `CURSOR_*` or `AGENT_CLI_*` is present.
- Cursor:
  - `HOME` equals the expected account home;
  - `AGENT_CLI_CREDENTIAL_STORE === 'file'`;
  - `CURSOR_CONFIG_DIR` is absent or equals `<home>/.cursor`;
  - none of `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`, `CURSOR_API_ENDPOINT`, `XDG_*`, `ANTHROPIC_*` or `CLAUDE_*` is present.
- For the default account, the assertion checks the reverse: no `AGENT_CLI_CREDENTIAL_STORE`, and `HOME` / `CLAUDE_CONFIG_DIR` are exactly what the default functions produce.

Rules:
- An isolation failure **never advances** to the next account or tool (`advances()` unchanged).
  - A stage ⇒ the run goes to `needs_human` with "The <label> account folder failed its safety check (<entry class>). Nothing was started."
  - An ask ⇒ `failed`.
  - A check ⇒ the account is `unavailable`.
- A named account with no credential on disk is `not-signed-in` and is **never spawned for work**. The only spawns allowed for it are login and the zero-quota check. Where the rev 1 fallback says "the first eligible tool's first enabled account runs and reports its own error", it must pick the chain head's **default** account, or a named account whose last check said signed in. It never picks a never-signed-in named account (its CLI might fall back to the shared login, which is the L4 question).

**S3 [BEFORE-EDIT] (Medium): Paths come only from the enum plus the id, and the `default` id has no folder.**
- `profileDir(ref)` / `accountHome(ref)` = `<home>/accounts/<provider>/<id>`. `<provider>` comes from the `ProviderId` enum, and `<id>` must match M8-1's exported `ACCOUNT_RE` **and** `^<provider>-[a-z0-9-]+$`.
- `id === 'default'` throws: the default account has no folder, and `<home>/accounts/<provider>/default` is never created or used.
- The joined path is asserted with `path.relative` to stay inside `<home>/accounts/<provider>/`.
- Paths never appear in API responses, reasons, events, board comments or CLI JSON (M8-1 S13). A static message names only the entry *class* (for example "a settings file", "a hooks file", "a link"), never the absolute path.

**S4 [BEFORE-EDIT] (Medium): Folder creation and verification.**
- `<home>/accounts` and `<home>/accounts/<provider>` are created with mode 0700, then verified by `lstat`: a real directory (not a symlink), owned by `process.getuid()`, mode tightened to 0700.
- The leaf folder is created with a **non-recursive** `mkdirSync(leaf, {mode: 0o700})`. `EEXIST` ⇒ refuse with 409/500 and a static message. A pre-existing folder at a fresh id is planted or stale, and is never adopted.
- Before every spawn: re-verify the leaf and both parents (real directory, owner, 0700).

### Claude profile folder (C1)

**S5 [BEFORE-EDIT] (High): Hygiene pre-flight for the Claude profile folder, invoked by `accountEnv` itself.**

`accountEnv` for a named Claude account cannot return an env without passing the pre-flight, so no spawn path can skip it. The rules:

1. **Top level.** Only entries on `CLAUDE_PROFILE_ALLOWED` may exist. This list comes from **L1 measurements on this platform** and is a code constant.
   - Rev 1 lists `.credentials.json`. It is allowed **only if L1/L2 show Claude creates it on macOS**.
   - Reason: a planted `.credentials.json` holding someone else's token sends the user's repository content to that person's account.
   - Always refused, fail closed:
     - files: `settings.json`, `settings.local.json`, `CLAUDE.md`, `.mcp.json`, `managed-settings.json`;
     - folders: `agents`, `commands`, `hooks`, `plugins`, `skills`, `output-styles`;
     - anything unknown.
   - If L1 shows Claude creating a refused name itself (for example an empty `plugins/`), the plan returns to Security with an exact content rule (such as "allowed only when empty"). It is never silently allow-listed.
2. **Entries and depth.** Every top-level entry and every child of an allowed folder (depth 2) must be a non-symlink, owned by the user.
   - This stops a planted `projects/<cwd>` → elsewhere link that would make Claude write transcripts outside the folder.
   - Top-level regular files must have `nlink === 1`, so a hard link to `~/.zshrc` and similar cannot be rewritten in place.
3. **`.claude.json` key check.** If present, it must be a regular file of 4 MB or less. It is parsed with own-property reads, and the pre-flight refuses if it holds:
   - a non-empty `mcpServers` at the top level or under any `projects.*`;
   - `primaryApiKey`;
   - `customApiKeyResponses` with any approved entry;
   - `env`;
   - `apiKeyHelper`.
   Parse errors produce a static message, never the V8 snippet (M8-1 S12).
4. **`shell-snapshots`.** It is not on the allow-list unless L1 shows it is created under Conductor's argv (stages have no Bash tool). If it is allow-listed, it is emptied before every spawn, because snapshots are sourced by Claude's Bash tool.
5. **Never read the credential.** Conductor never opens, reads, copies, hashes or logs `.credentials.json`, nor any `Claude Code-credentials*` Keychain item. A static test checks that no source file reads those names, except `lstat` in `profile.ts`.

Stages keep `--safe-mode` (or `--setting-sources project,local`) and the fail-closed init predicate, unchanged. The pre-flight is defence in depth on top of them, and it is the only protection for the non-safe-mode spawns: `auth status`, `auth login`, `auth logout` and `--version`. Those can evaluate `apiKeyHelper` or `env` from `settings.json`.

**S6 [LIVE] (High): L1 and L3 run before the commit that adds `profile.ts`. Results are recorded as counts and names only.**
- **L1:** Run every named-account spawn shape Conductor will use, signed out (zero quota), with an empty profile folder: the discovery `initialize`, `auth status` and `--version`. List the top-level entry names and the depth-2 entry names. These become the allow-list.
- **L3:** Plant `settings.json` (hooks on SessionStart, SessionEnd, UserPromptSubmit, PreToolUse and Stop, plus `apiKeyHelper` and `env.ANTHROPIC_BASE_URL` pointing at a loopback listener), `CLAUDE.md`, `hooks/`, `.mcp.json`, and an `mcpServers` entry in `.claude.json`.
  - (a) The pre-flight refuses before any spawn (a `runProcess` spy sees zero calls).
  - (b) In a scratch copy with the pre-flight bypassed, signed out: no marker appears, and the loopback listener sees no connection, for each spawn shape. This includes `auth status`, which is not in safe mode.
  - If (b) fails for a non-safe-mode shape, the pre-flight alone stands between planted config and code execution. That is acceptable **only** if (a) passes and the static test in S5 holds. Record which.

**S7 [DURING] (Medium): The Claude login is the CLI's own, captures nothing, and passes the pre-flight.**
- `conductor accounts login <id>` spawns `claude auth login` with `accountEnv` (S1/S2), the pre-flight passed, and stdio **inherited**.
- Conductor reads none of its output. It never runs in the server and never in `npm test`.
- Afterwards it runs the zero-quota check. That check stores only `signedIn` and `plan` (M8-1 S3): never the email, organisation, `userID` or `tokenSource`.

**S8 [BEFORE-EDIT] (Medium): Ids are never reused, and removal signs out by default (T12).**
- Generated id = `<provider>-<slug>-<4 random hex>`, matching the S3 regexes, so re-adding "Work" gives a new folder path and therefore a new Claude Keychain key.
- `normalizeAccounts` drops (and reports) named ids that do not match `^<provider>-`.
- **Removal order** (API, CLI and control socket alike):
  1. mark the account as removing; the router and discovery treat it as disabled from that moment;
  2. abort and await the running jobs (§2.3 restart) and any in-flight discovery or check for that account (M8-1 `stop` per account);
  3. **sign out by default** when the tool is installed and the pre-flight passes: `claude auth logout` / `agent logout` with the account env, zero quota, 20 s timeout; `--keep-signin` opts out;
  4. delete the folder (S4 checks; `rmSync` recursive, which never follows links);
  5. delete the model cache file (lstat) and call `forget`;
  6. save the config.
- The response says whether the sign-out succeeded. If it did not, it adds a static note: "the tool may still hold a saved sign-in; sign out from the tool or revoke the session in your account settings."
- Startup sweep: folders under `<home>/accounts/<provider>/` that match no configured id are removed (lstat, owner, no follow) and logged as a count. They may hold live sign-ins, so the docs state that orphaned folders are deleted without a sign-out.

### Router and engine

**S9 [DURING] (Low): Spawns for one account are serialised during hygiene work.** Removing or cleaning entries (S14) and removing a folder (S8) only happen when no process of that account is alive. Use a per-account lock, the way `withCodexHomeLock` is used. Concurrent jobs on the same account are allowed; while another job runs, the pre-flight runs in check-only mode and cleans nothing.

**S10 [BEFORE-EDIT] (Medium): Chain-only switching is pinned.** Under every rule, the set of candidate tools is a subset of (the role's configured chain ∪ its configured complexity pick), after the existing gates.
- Static and property test: for every role, rule, chain and health fixture, no candidate's tool lies outside that set.
- The rev 1 D-A text (other registry tools with tier ≥ `partial`) is removed from §2.0, §2.2 and §6.
- `same`/`wait` keep D-B.
- Ping-pong stays bounded: hops ≤ candidates, the 24 h pause cap, and the episode cap of 6.
- An `isolation` failure never advances (S2).

### API, CLI, control socket

**S11 [BEFORE-EDIT] (Medium): Control-socket account routes (T10, accepted under these rules).**
- `listenControl` first verifies that `<home>/run` is a real directory, owned by the user, mode 0700. If not, it refuses to open the socket. The socket keeps its 0600 chmod. Because the parent is 0700, the umask window before the chmod is closed.
- The routes are an exact method + path allow-list: `GET /accounts`, `POST /accounts`, `PUT /accounts/order`, `PUT /accounts/<id>`, `POST /accounts/<id>/check` and `DELETE /accounts/<id>`. They call **the same strict handlers** as the HTTP API (shared functions, not copies).
- Bodies are capped at 16 KB and must be `application/json`. Anything else ⇒ 4xx.
- No route accepts or returns a credential, a path or an email. **No route runs `login`**: login is CLI-only and in-process, never through the server.
- Same-user code can already reach a full session through `/otp` and can edit `config.json`. These routes add nothing beyond that. Docs record the boundary.

**S12 [BEFORE-EDIT] (Low): Strict, minimal views and inputs.**
- `AccountView` keys are an allow-list (test per key).
- `signInCommand` is composed only from constants plus an id matching S3, and a test asserts `^conductor accounts login [a-z0-9][a-z0-9-]{0,31}$`. It is safe to paste into a shell.
- `usage` fields are finite numbers, clamped (`utilization*` to 0–100, `resetsAt` to now ± 8 days), or omitted.
- `plan` follows M8-1 S3.
- Labels:
  - cleaned with `cleanText`, 40 characters at most, rendered with `textContent` only;
  - an **email-shaped label is refused** with 400 "Use a short name, not an email address" (labels flow into board comments and history; M8-1 S3 keeps identities out);
  - the same rule applies in `normalizeAccounts` (an email-shaped label is replaced by "Account N" and reported).
- Every rule in AC8 stands, including no CSRF ⇒ 403. Any `apiKey`/`token`/`key`/`password` field ⇒ 400 (strict unknown key).

**S13 [DURING] (Low): CLI single-writer.** Accepted as in §2.8. In direct mode (no server), the CLI holds the lock for the whole read-modify-write and the removal sequence of S8. `accounts list --json` prints the same allow-listed view.

### Cursor per-account HOME (user decision: file credential store + `agent login`)

**S14 [BEFORE-EDIT] (High): Hygiene for the Cursor account HOME, which the builder can write.**

Under this design, the Cursor builder and every shell command it runs have `HOME = account home`. A hostile repository or prompt can plant files there that later runs **of any repository** on that account will load. Today the same builder can plant in the user's real HOME, which is worse (it reaches the user's own terminal). So this is not a regression, but the folder now carries credentials and Cursor's user config, and it must be policed.

Before every named-Cursor spawn (`accountEnv`, check-only while another job of the account runs, S9):

1. **`.cursor/` allow-list.**
   - Allowed: only entries from the L4 measurement (expected: `auth.json`, `cli-config.json`, plus whatever `agent` creates for its own state, for example `projects/` or `chats/`).
   - Always refused, fail closed: `hooks.json`, `mcp.json`, `rules/`, `commands/`, `agents/`, `skills/`, `environment.json`, `cli.json`, and anything unknown.
   - A refusal ⇒ S2 isolation failure (visible, `needs_human`), never a silent clean.
2. **`cli-config.json` content rule.**
   - Size ≤ 256 KB, parsed with own-property reads.
   - Its `permissions.allow` must be empty or a subset of the L4-measured defaults that `agent login` writes. `permissions.deny` may only tighten.
   - Refused: MCP/hook/approval keys (for example `approvalMode`, `mcp*`, `hooks`) and any `sandbox`/`network` loosening.
   - Unknown top-level keys: refused, unless they are in the L4-measured set.
3. **Top level of the account HOME.**
   - Keep only `.cursor` plus the L4-measured entries (for example `.config/cursor` or `Library/` if `agent` creates them).
   - Everything else (builder caches such as `.npm`, `.cache`, and planted `.zshenv`, `.zshrc`, `.bashrc`, `.profile`, `.npmrc`, `.gitconfig`, `.ssh`, `.netrc`) is **removed** before the spawn, with no-follow `rmSync`, when no other job of the account is alive.
   - Log the count plus a fixed class ("shell start-up file", "credential-style file", "cache") per entry, never names.
   - When a shell start-up or credential-style file was removed, add one visible note to the run that triggered the clean.
4. **Links and modes.** Same as S4/S5: no symlink at any level checked, owner = user, folders 0700. `auth.json`, when present, is a regular file with `nlink === 1`, its mode tightened to 0600, and it is **never opened** by Conductor (static test as in S5).

**S15 [LIVE] (High): L4 replaces rev 1's L4 (K1 is gone). It is zero-quota apart from the user's own login, and it is a stop condition.**
- **L4a (no fallback to the shared login):** the default Cursor account is signed in (shared Keychain entry). A named env with an **empty** account HOME and `AGENT_CLI_CREDENTIAL_STORE=file` runs `agent status` and `agent --list-models`. Both must report **not signed in**. If either reports signed in, the file store falls back to the shared login, and the design is **unsafe: stop and return to Security**.
- **L4b (no write to the shared login):** record a hash of the default account's identity (from `agent status`, hashed, never printed). The user runs `conductor accounts login <id>` for one named account. Afterwards:
  - the default identity hash is unchanged;
  - the named account reports a **different** identity hash;
  - `<home>/.cursor/auth.json` exists as a regular 0600 file (yes/no);
  - the shared Keychain entry's modification date is unchanged (metadata from `security find-generic-password -s <service>` **without** `-w`; record only "unchanged: yes/no").
  - If the default identity changed, stop. The user re-runs `agent login` for the default.
- **L4c:** list the entry names that `agent login`, `status` and `--list-models` create under the account HOME and its `.cursor`. These become the S14 allow-lists. Also record the key set of `cli-config.json` as names only (S14.2).
- **L4d:** whether the credential value in `auth.json` matches an existing `TOKEN_PATTERNS` shape. A script answers yes/no without printing it. If no, S16 applies.
- **L4e:** whether `CURSOR_CONFIG_DIR` must be set for `cli-config.json` to come from the account HOME rather than the real one. Decide S1's optional key from this.

**S16 [DURING] (Medium): Redaction by shape, because Conductor never knows the values.**
- No account credential passes through Conductor, so exact-value redaction cannot apply. Agent output that echoes one (for example a builder that runs `cat ~/.cursor/auth.json`) is caught only by `TOKEN_PATTERNS`, which `redact()`, the commit guard (`looksSecret`) and `scanBranchForSecrets` all use.
- Add tests that Claude OAuth shapes (`sk-ant-oat01-…`, `sk-ant-ort01-…`, caught by the existing `sk-ant-` pattern) and the Cursor shape found in L4d are redacted in events, board comments and logs, and are refused by the commit guard.
- If L4d says no pattern matches, add a bounded, anchored pattern for that shape. It must not be derived from or committed with a real value.
- Do **not** make Conductor read `auth.json` to obtain an exact value. "Conductor never reads a credential" is the stronger property.

**S17 [BEFORE-EDIT, LIVE] (High): A Cursor build under an account HOME is a changed isolation profile, so it is gated.**
- `buildIsolationVerified` for Cursor rests on `test/live/cursor-nopush.test.ts`, run on 2026.10.19 **with the real HOME** (code baseline, `verification.ts`).
- An account HOME changes the user-level Cursor config the guard sits next to. The project-level `.cursor/cli.json` deny rules must still win over whatever `cli-config.json` the account holds.
- Therefore:
  - (a) Add a code constant `CURSOR_ACCOUNT_HOME_BUILD_VERIFIED = false`. While false, named Cursor accounts are **ineligible for build roles**, so their `AccountState` is skipped for `ROLE_NEEDS.build`, visibly ("<label> can run read-only work only until its build isolation is checked"). Builds keep the `default` account. A build limit with only named accounts left ⇒ pause, as today.
  - (b) **L5** (spends quota; the user's permission is needed): run `cursor-nopush.test.ts` with the env from `accountEnv('cursor', named)`. That means an account HOME holding a real `agent login` and the L4c-measured `cli-config.json`. Also run a variant with a deliberately loosened account `cli-config.json` (`permissions.allow: ["Shell(*)"]`, planted in a scratch copy with S14 bypassed). Every push attempt must still be denied and the remote left untouched.
  - (c) Only after L5 passes is the constant flipped, in its own commit, and Security reviews that commit.
- Confirmed as non-findings: `agentGitEnv` does not depend on HOME (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, no-push `pushurl`, `GIT_SSH_COMMAND=/usr/bin/false`), and the envelope's GIT_* still wins. A private HOME also *removes* the builder's view of `~/.ssh`, `~/.npmrc` and `~/.aws` via `~`, though not by absolute path. That is a gain.
- Expected product cost (non-binding): repositories that need a private registry or an SSH remote during a build fail on a named account. The Accounts UI should say so.

**S18 [DURING] (Medium): Gates and dependency installs never run under an account HOME.**
- `toolEnv(repo.envPassthrough)` keeps the real HOME and never receives `AGENT_CLI_*`, `CURSOR_CONFIG_DIR` or a named account's HOME.
- Test: a spy on the gate and install spawns during a named-account build.

**S19 [DURING] (Low): Cursor sign-out on removal.** S8 step 3 uses `agent logout` with the named env. The point is to invalidate the session server-side, in case a builder copied `auth.json`. If `agent logout` only deletes the file, say so in the response note and point the user to the session list in their Cursor account settings.

**S20 [BEFORE-EDIT] (Medium): Disclose the residuals in plan §6, `docs/ARCHITECTURE.md` and the Accounts UI "Add an account" panel.**
- (a) Signing in another account stores that tool's login in a private folder under the Conductor home. For Cursor this is a plaintext file (`auth.json`, 0600), not the Keychain. Code that the Cursor builder or repository checks run can read it (as your own user), just as it can read your other files. Add only accounts you accept that exposure for, and revoke sessions if a build looked hostile.
- (b) Under "Next account, then another tool", work from **any** project may run on **any** listed account, including a personal one. Use "same"/"wait", or do not add the account, if a project must stay on one organisation's account.
- (c) Folders of removed accounts are deleted. Sign-out is attempted, but Claude may keep a Keychain item for a folder that no longer exists.

Non-binding: suggest `tmutil addexclusion` for `<home>/accounts` in the docs, so plaintext sessions are not copied into backups. This is the user's choice; Conductor does not run it.

### Secrets, redaction, logs

**S21 [LIVE] (High): The live checks are staged so they cannot overwrite the user's own sign-in.**
- Rev 1's L2 asks the user to sign in **two** Claude accounts. If Claude's Keychain keying is **not** per folder, the first named login would overwrite the user's default credentials. Run L2 in this order:
  - (i) record the default account's identity hash (`claude auth status` with the default env, hashed);
  - (ii) record the Keychain metadata of `Claude Code-credentials*` items: names and modification dates only, never `-w`;
  - (iii) the user signs in **one** named account;
  - (iv) the default hash is unchanged, **a new item exists** whose service name differs from the default's, and the default item's modification date is unchanged;
  - (v) only then a second named account, with the check repeated;
  - (vi) list the profile entry names after login (feeds S5/S6).
- Any "changed" ⇒ stop. The user re-runs `claude auth login` for the default, and C1 returns to Security; C2 is excluded by the user.
- Evidence (`.techteam/runs/evidence/m8-3-*`) holds only yes/no, counts, entry names and hash-equality booleans. It never holds a hash value, email, organisation, token, Keychain service suffix or path under `$HOME`. An S7-style identity grep runs over the evidence files.

**S22 [DURING] (Low): Redaction, now that no Conductor-held secret exists.**
- §2.5 and AC7's Keychain/`putSecret` parts are removed. The `getSecret` env override (`registerSecretEnv`) must **not** be registered for anything account-related.
- AC7 becomes:
  - no account folder path, label-to-identity mapping, email, organisation or token in config, the API, logs, events, board comments, the run record or CLI JSON (decoy grep with a planted `auth.json` / `.credentials.json` holding `DECOY_TOKEN_…` in a **test** folder);
  - the decoy never appears anywhere Conductor writes.
- `assertAccountEnv` and pre-flight messages are static. The engine, `AskService` (`secrets: () => []` today), `ModelService` and logger redaction lists keep working on their existing inputs.

### Forward conditions (recorded)

**S23 [forward → M8-5] (Low):**
- Drop the email and organisation from `providers[].detail` (`providers/claude.ts:28`) and from the limit reason built from it (`server/api.ts:149-152`). Show "Signed in" plus the plan.
- Until then the text is reachable only behind loopback, cookie and CSRF. It never reaches board comments (verify in the M8-5 review).

**S24 [forward] (Medium when enabled): Named Codex accounts (X1) are dormant in fact.**
- No code path resolves, prepares or spawns for a named Codex id. Test with a `runProcess` and `prepareCodexHome` spy that sees zero calls.
- API and CLI refuse to add one.
- Enabling them is a separate Security gate. It needs:
  - Q5;
  - `prepareCodexHome` per account (`auth.json` is plaintext there too, so S20 applies);
  - `withCodexHomeLock` per account;
  - the M8-1 S18 rules;
  - a live check that a named `CODEX_HOME` never falls back to the default home.

**S25 [BEFORE-EDIT] (Low): Plan bookkeeping for rev 2.**
- Fold S1–S24 into §2.4, §2.6, §2.7, §2T, §5 and the AC list.
- Rewrite:
  - Q4 as decided;
  - §2.5 as removed;
  - D-A as chain-only;
  - AC10 as L1, L2 (staged per S21), L3 (with Cursor planted-config markers added: `~/.cursor/hooks.json` and `~/.cursor/mcp.json` in an account HOME ⇒ refused by S14; bypassed in a scratch copy and signed out ⇒ no marker), L4a–e and L5.
- Mark every live check "only with the user's permission".
- Name this file as the authoritative text for S1–S25.

## Non-findings (checked, no change needed)

- **Option and shell injection from ids and labels.** Ids match `[a-z0-9-]` with a leading alphanumeric, `spawn` uses no shell, and labels never reach argv, paths or HTML (`textContent`).
- **CSRF, loopback and cookie on the new HTTP mutations.** The existing gate in `server/http.ts` applies to every mutation. The plan routes all account mutations through it.
- **Limit-message forgery (T11).** Classification stays on CLI-reported text (Cursor M12 rule). Each forged limit pauses only the account it names, and the bound is candidates ≤ 3 × 8 with the episode cap of 6.
- **Hand-edited config (T14).** The own-property, regex, cap, null-prototype and `default`-enforced plan holds. S8 tightens the id shape.
- **Pauses in memory (D-E).** Accepted. Persisting them would add an untrusted input.
- **Migration v6 → v7, backup, and newer-file refusal.** Accepted as specified.

## Unblock condition

Implementation may start after the Reviewer approves, once rev 2 contains S1–S5, S8, S10–S12, S14, S17, S20 and S25.
- The router, engine and API work (rev 1 TODO steps 1–3) may begin straight away.
- `profile.ts` / `env.ts` / login (TODO step 4) start only after **L1 and L3 (S6)** and **L4a–e (S15)** pass with the user's permission.
- **L2 (S21)** must pass before named Claude accounts can be signed in through the shipped CLI.
- Named Cursor accounts may **build** only after **L5 (S17)** passes and the constant-flip commit has been reviewed by Security.
- Release of the slice needs the Security code review to confirm S1–S24 with test evidence.

## Rev 2 check (2026-10-21)

Input: `.techteam/plans/workspace-v2-m8-3.md` rev 2 (734 lines). I read §2.0 D-G, §2.4–§2.6, §2S, AC7, AC10, §2T and §6. No code changed.

**What rev 2 satisfies**
- §2S restates S1–S25 correctly and names this file as authoritative (it wins over conflicting text).
- The BEFORE-EDIT set is present: S1–S5, S8, S10–S12, S14, S17, S20 and S25.
- D-G implements S17 as `buildOk` plus the `CURSOR_ACCOUNT_HOME_BUILD_VERIFIED` constant, and the flip is a separately reviewed commit.
- AC10 carries L1, L2 staged per S21, L3 with the Cursor markers, L4a–e and L5, each marked user-permission-only and as a stop condition.
- §2.5 states that Conductor holds no account secret.
- The unblock order matches this file.
- The B5 "the envelope resolves `accountBuildEnv`" design is accepted as a reviewed exception: `FORBIDDEN_PREP_ENV` is unchanged, and `prepare` still cannot supply HOME.

**Text fixes (DURING; the Security code review checks them; no new plan round needed)**
- **R2-1 (Medium):** in a build, `req.env` is applied after `req.accountEnv`. So the assertion that counts is the one on the **final composed env inside `cursor.build.run`**, immediately before `runProcess`, as S2 requires: "inside every adapter". The envelope-side assertion on the fragment is an extra layer, not the guard. Test: a forged `req.env` carrying `HOME`/`AGENT_CLI_CREDENTIAL_STORE` gives zero spawn.
- **R2-2 (Low):** the §2.4 named-Claude assert list must also refuse `CLAUDE_CODE_USE_*` and `AWS_*` (S2).
- **R2-3 (Low):** the §2T T7 row still proposes *refusing* unknown HOME top-level entries. S14.3 (remove while idle, with a visible note for shell start-up and credential-style files) is the ruling. Refusing would brick every account after its first build that writes a cache. Align the row.
- **R2-4 (Low):** §2.4 allows `cli-config.json` only with an empty or absent `permissions.allow`, while S14.2 allows a subset of the L4c-measured defaults. The stricter §2.4 rule is acceptable. If L4c shows `agent login` writing allow entries, the §2.4 stop rule applies (back to Security), not a silent widening.

**R2-5 (Medium) Ruling on `ACCOUNT_TOOLCHAIN_VARS`: accepted in narrowed form.**
- Reasoning:
  - The bridge gives the builder **no capability it lacks today**. The builder runs as the user without a sandbox and can already write `~/.cargo` etc. by absolute path, and today's default-account builder resolves exactly these folders through the real HOME.
  - What the private HOME buys is a narrower *natural* reach of `~` and no persistence through planted shell start-up files. Bridging cache variables leaves both intact.
  - The higher-risk parts of a toolchain home are the `bin/` folders on the user's PATH and config that runs code. So a cache-only variable is used wherever one exists.
- Conditions:
  - (a) The fixed list is: `npm_config_cache` → `<realHome>/.npm`; **`GOMODCACHE` → `<realHome>/go/pkg/mod`** (instead of `GOPATH`, so `go install` cannot write into the user's `~/go/bin`); `RUSTUP_HOME` → `<realHome>/.rustup`; `CARGO_HOME` → `<realHome>/.cargo`. Cargo has no cache-only equivalent, and Rust builds need it; it is accepted at parity with today's default-account builds.
  - (b) `<realHome>` comes from `os.userInfo().homedir`, never from `process.env.HOME`. Each value is a fixed relative path under it, and each target must be a real directory by `lstat` (not a symlink), owned by the user, and outside the Conductor home. Otherwise that variable is omitted.
  - (c) Bridged only into **builds** of named Cursor accounts. Never into read-only stages, discovery, login or checks.
  - (d) A parent-env value for any of these is never passed through; the bridge always uses the computed default. This matches today: the allow-list drops them, so today's builder already uses the real-home defaults.
  - (e) `assertAccountEnv` requires each of the four keys to be absent or exactly equal to its computed value, and every other toolchain-home key (`GOPATH`, `GOBIN`, `PYENV_ROOT`, `NVM_DIR`, …) to be absent.
  - (f) S20(a) gains one sentence: "Builds on added Cursor accounts share your npm, Go-module and Rust caches and toolchains with your own shell, as builds on your main account already do."
- An empty list is also acceptable if the Lead prefers it. S14.3 then cleans the caches, and the cost is build speed only.

Rev 2 meets this file's plan-text unblock condition. The Reviewer's approval and the live gates (L1, L3, L4a–e before TODO 4; L2; L5) still apply as stated above.

Verdict: Approved with conditions
