# Security code review: M8-3 Accounts and automatic switching

- Reviewer: TechTeam Security Engineer (the author of the design review; independent of the implementer, the Backend agent af7354a4c9c53397b)
- Date: 2026-10-21
- Scope: the uncommitted M8-3 changes on top of `dbd6048` in `/Volumes/Sandisk/github/techteam-conductor-v2`. M8-4's run-mode edits are in the same tree but are **not** reviewed here.
- Measured against: `.techteam/reviews/workspace-v2-m8-3-security-design.md`, conditions S1–S24 and R2-1 to R2-5.
- Read:
  - `src/accounts/{env,profile,service,store,types}.ts`;
  - the diffs of `src/agents/providers/{claude,cursor}.ts`, `src/agents/routing.ts` and `src/server/http.ts`;
  - `accountRoute` in `src/server/api.ts`;
  - `ModelService.runOnce` (`envFor`/`afterDiscovery`);
  - `docs/ARCHITECTURE.md` (accounts section);
  - test names and key assertions in `test/accounts/*.test.ts`, `test/engine-accounts.test.ts` and `test/routing-accounts.test.ts`;
  - the live evidence `.techteam/runs/evidence/m8-3-live.md`.
- Ran: `node --test test/accounts/*.test.ts test/routing-accounts.test.ts test/engine-accounts.test.ts`, which gave **57 pass, 0 fail**. I did not re-run the full `npm test` (the implementer reports 1071 pass, 0 fail) or `npm run check`. I ran no CLI and no live check.

## Decision

**Approved with conditions.**
- Every in-scope condition is implemented, with tests or a fail-closed code constant.
- There is no Critical or High finding *in M8-3's code*.
- The conditions below keep the two gates closed until the remaining live checks have run.
- One **pre-existing** High finding (F1), revealed by this slice's L3(b) evidence, goes to the Lead as its own gate. It does not block M8-3, because M8-3's named accounts are protected by the pre-flight.

## Condition-by-condition

| # | Status | Evidence |
| --- | --- | --- |
| S1 | Met | `accountEnv` strips the drop lists from both `src` and `extra`, and also strips the composed output a second time.<br>Named Claude keeps the real `src.HOME`, even when `extra.HOME` is forged, and sets `CLAUDE_CONFIG_DIR` last.<br>Named Cursor sets `HOME` plus `AGENT_CLI_CREDENTIAL_STORE=file` last.<br>`CURSOR_CONFIG_DIR` is never set (L4e has not run).<br>`dropForNamedBuild` removes `HOME`/`CURSOR_*`/`AGENT_CLI_*`/`CLAUDE_CONFIG_DIR`/`XDG_*` from `req.env`.<br>`FORBIDDEN_PREP_ENV` is untouched. |
| S2 / R2-1 / R2-2 | Met | `assertAccountEnv` checks the final env:<br>• named Claude refuses `CLAUDE_CODE_USE_*`, `AWS_*`, `XDG_*` and more (R2-2);<br>• the Cursor build asserts the **composed** env inside `cursor.build.run` (R2-1);<br>• read-only, research and discovery pass the asserted object to the spawn unchanged;<br>• default accounts get the reverse check.<br>The router uses only default accounts, or named ones with `auth === 'ok'`. The step-5 fallback picks a default only.<br>An isolation failure returns `errorKind:'isolation'`, which `advances()` does not move past. |
| S3 / S4 | Met | `accountFolder`: provider enum plus `namedIdOk`, `path.relative` containment, no folder for `default` or Codex.<br>Parents are created non-recursively, then `verifyDir` checks each one (real dir, owner, 0700, tightened then re-checked).<br>The leaf `mkdir` refuses `EEXIST`.<br>Parents and leaf are re-verified in every pre-flight.<br>Messages name classes only. |
| S5 | Met | The allow-list is exactly the L1 five entries; `.credentials.json` is refused.<br>Refusal list, unknown entries, depth-2 no-link rule, `nlink === 1`, and the `.claude.json` key check (own-property, 4 MB, static parse message).<br>The pre-flight runs inside `accountEnv`, so no spawn path skips it.<br>Static test: no source opens a credential file (`env-profile.test.ts:330`). |
| S6 | Met for L1/L3 | Evidence holds names, counts and booleans only.<br>L3(a) is automated (`env-profile.test.ts:221`).<br>L3(b) is recorded honestly: the pre-flight alone guards every named-Claude shape except `--version`. That is acceptable under S6 because L3(a) passes and the static test holds. See F1 for the wider consequence. |
| S7 | Met (disabled) | `login` is gated by `ACCOUNT_LOGIN_ENABLED = false`. When it is enabled it runs the pre-flight and the assertion and inherits stdio. |
| S8 / S19 | Met | Removal order: mark removing → engine restarts → abort calls → wait until idle → sign out (`allowRemoving` only here) → wait until idle → delete folder (no-follow; a link is unlinked) → cache plus `forget` → save.<br>The response gives `signedOut` and a static note.<br>Ids carry a random 4-hex suffix.<br>The orphan sweep checks ownership, never follows links, and is counted. |
| S9 | Met | The lease is taken in the same tick as the pre-flight (`childEnv`, `envFor`, logout, named build) and released when the child has been reaped.<br>Cursor cleaning runs only when `!accountBusy`; otherwise the pre-flight is check-only. |
| S10 | Met | Candidate tools are a subset of the chain ∪ the complexity pick (property test). Same/wait do not leave the head tool. |
| S11 | Met | `CONTROL_ROUTES` is an exact allow-list. `controlDirOk` runs before listen. Bodies are capped at 16 KB and must be `application/json`. Handlers are the shared `accountRoute`. There is no login route.<br>`keepSignin` is accepted only on the socket; HTTP removal always signs out. |
| S12 | Met | Credential-like keys ⇒ 400; email-shaped labels ⇒ 400 (replaced in `normalize`); the view is allow-listed; `signInCommand` regex; usage is clamped (per the implementer, with tests in `api-cli`). |
| S13 | Met | Direct mode holds the lock for the whole command (per the implementer; not re-traced here). |
| S14 | Met (strictest form) | The `.cursor` allow-list is **empty** until L4c (user decision), so planted hooks/mcp/rules, and even `cli-config.json`, are refused.<br>Content rule for `cli-config.json`: `allow` must be empty.<br>Top-level entries are removed when the account is idle, with shell start-up and credential-style note classes.<br>`auth.json` gets `lstat`/`chmod` only.<br>Consequence (accepted): a named Cursor account becomes `unavailable` after its first check, visibly. |
| S15 | Partly run | **L4a passes** (no fallback to the shared Keychain login).<br>L4b–e have not run: login stays disabled and the `.cursor` allow-list stays empty, which is the fail-closed state. |
| S16 | Met | `sk-ant-oat01-…` / `sk-ant-ort01-…` redaction test (`engine-accounts.test.ts:440`). The Cursor token shape waits for L4d. |
| S17 | Met | `CURSOR_ACCOUNT_HOME_BUILD_VERIFIED = false` feeds `buildOk`, so the router skips named Cursor accounts for build roles. The engine test shows a build with only named Cursor accounts left pauses. |
| S18 | Met | Test at `env-profile.test.ts:301`: `toolEnv` never carries an account HOME or `AGENT_CLI_*`. |
| S20 | Met | `docs/ARCHITECTURE.md` (a)–(c), including the R2-5 sentence; the Settings "Add an account" panel (per the implementer). |
| S22 | Met | Decoy `DECOY_TOKEN_…` test (`api-cli.test.ts:287`). `registerSecretEnv` is unused in `src/accounts` (static test). |
| S23 | Forward | Belongs to M8-5. |
| S24 | Met | A named Codex account throws in `accountEnv`, has no folder, is disabled in `routeStates`, and add is refused. |
| R2-3 / R2-4 | Met | S14.3 removes rather than refuses; `cli-config.json` requires an empty `allow`. |
| R2-5 | Deferred, consistent | `ACCOUNT_TOOLCHAIN_VARS` is not implemented (it ships with the S17 flip). `TOOLCHAIN_HOMES` are stripped and asserted absent, which is R2-5(e). The flip commit must implement R2-5(a)–(d) and comes back to Security. |

## Findings

**F1 (High, PRE-EXISTING, outside M8-3; routed to the Lead as its own gate): `--safe-mode` does not neutralise `settings.json` `apiKeyHelper` or `env`.**
- L3(b) shows that a `settings.json` in the config dir ran its `apiKeyHelper` (code execution) and honoured `env.ANTHROPIC_BASE_URL` (traffic redirect) for `auth status`, discovery `initialize`, read-only stages and research, all under `--safe-mode`.
- Named accounts are protected by the M8-3 pre-flight. Two paths are not:
  - (a) **The default account.** The user's real `~/.claude/settings.json` can be written by any same-user process, including the Cursor builder running untrusted repository content. A planted `apiKeyHelper` then runs in the next Claude stage, and a planted `env.ANTHROPIC_BASE_URL` sends Claude's requests, including the bearer credential, to an attacker host.
  - (b) **Project-level settings, not yet measured.** If a repository's own `.claude/settings.json` (or `.claude/settings.local.json`) in the stage cwd is honoured the same way, an untrusted repository alone could redirect the signed-in session. That would be **Critical** for every read-only stage. The `setting-sources project,local` isolation mode loads project settings by design. The M8-1 S5 and earlier marker checks covered hooks and MCP, not `apiKeyHelper`/`env`.
- Required, with the user's permission:
  - live check **L3c** (zero quota, signed out, loopback listener): a planted project `.claude/settings.json` and `.claude/settings.local.json` with `apiKeyHelper` plus `env.ANTHROPIC_BASE_URL` in the stage cwd, for `buildClaudeArgs` under both `safe-mode` and `setting-sources`, and for research.
- If either is honoured, the remedy is a Security-gated change. Options:
  - a pre-flight that refuses or strips `apiKeyHelper`/`env` from the read-only snapshot and worktree before a Claude stage;
  - a stricter CLI flag, if one exists;
  - an explicit `--settings` override.
- Separately, Security and the Lead should decide whether to pre-flight the default account's `~/.claude/settings.json` for `apiKeyHelper`/`env.ANTHROPIC_BASE_URL` (warn, or refuse when added since the last run).

**F2 (Low, note): removal waits for an in-flight discovery rather than aborting it.** `waitAccountIdle` covers the discovery lease, so a removal can wait up to the discovery bound (about 21 s, M8-1 S10). It is bounded and correct. Abort it through M8-1's per-account stop if the delay is noticed.

**F3 (Low, note): every clean removes `Library/` from a Cursor account HOME.** L4a showed the CLI creating `Library/Caches/cursor-compile-cache/` on each run, so each Cursor spawn re-creates it and the next idle clean deletes it. That is harmless (a cache), but L4c should decide whether `Library` joins `CURSOR_HOME_ALLOWED`. If it does, apply the same depth-2 link check to it.

## Conditions (binding)

1. `ACCOUNT_LOGIN_ENABLED` stays `false` until **L2** (Claude, staged per S21) and **L4b–e** (Cursor) have passed with the user's permission. Enabling it is its own commit, reviewed by Security, together with:
   - the L2(vi)-measured additions to `CLAUDE_PROFILE_ALLOWED` (`.credentials.json` only if measured);
   - the L4c-measured `CURSOR_DOT_ALLOWED`, `CURSOR_CLI_CONFIG_KEYS` and `CURSOR_HOME_ALLOWED`;
   - the L4d token pattern (S16), if one is needed;
   - the L4e decision on `CURSOR_CONFIG_DIR`.
2. `CURSOR_ACCOUNT_HOME_BUILD_VERIFIED` stays `false` until **L5** passes. The flip commit implements R2-5(a)–(d) and is reviewed by Security.
3. F1 is opened as its own Lead-owned item, with L3c as the first step. It is not bundled into M8-3.

## Round-2 deltas (2026-10-21): no change to the verdict

I checked the deltas Backend reported after the Reviewer's B1/B2/N items.
- **B2 `crossOnLimit`** is now relative to the previous candidate (`routing.ts:199`). Under same/wait, a limit still cannot cross from the head tool to another tool. Candidate tools are still a subset of the chain ∪ the complexity pick (S10 property test green). Met.
- **B1:** the brief calls pass `rule` and an `onLimit`, and `rule` is now a required field. This tightens the code. Met.
- **N2:** `conductor start` starts **without** a control socket when `<home>/run` is not private. That is fail-closed for the socket. I confirmed the CLI cannot become a second config writer: with no socket it takes the direct path, `acquireLock` throws `LockHeldError` while the server runs, and nothing is written. The comment at `cli.ts:180` ("the CLI then writes directly") is misleading: the CLI refuses. Reword it (Low, cosmetic).
- **N3:** the sweeps run only after a current-version `config.json` was loaded. That closes the gap where a config recovery could delete live sign-in folders. A good tightening of S8.
- **N5 / N6** (refund on a removal abort; re-queue only running/queued runs) are integrity-neutral. Accepted.

## Unblock

M8-3 may be committed locally as it is, with the two gates closed. The remaining live checks and the two gate-opening commits each need the user's permission and a Security review.

Verdict: Approved with conditions
