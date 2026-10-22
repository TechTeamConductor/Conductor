# Security code checkpoint: F1 Claude `settings.json` isolation (A+C)

- Reviewer: TechTeam Security Engineer
- Date: 2026-10-21
- Scope: F1 implementation only (not design — design already **Approved with conditions**).
- Inputs:
  - Plan (approved): `.techteam/plans/workspace-v2-f1-claude-settings.md`
  - Design sign-off: `.techteam/reviews/workspace-v2-f1-security-design.md` (C1–C12)
  - Evidence pre: `.techteam/runs/evidence/l3c-project-settings.md`
  - Evidence post: `.techteam/runs/evidence/l3c-f1-postfix.md` (+ `l3c-f1-postfix-probe.ts`)
  - Prior finding: `.techteam/reviews/workspace-v2-m8-3-security-code.md` F1
  - Code: `src/agents/claude-settings.ts`, `src/agents/claude.ts` (`runClaude`), `src/models/claude.ts` (`discoverClaude`), `src/agents/providers/claude.ts` (`auth` / stages / research), `src/doctor.ts` (`isolationProbe`, `probe`), `docs/ARCHITECTURE.md` F1 row
  - Tests: `test/agents/claude-settings.test.ts`, `test/preload.ts` (`CLAUDE_CONFIG_DIR` throw-away), named-account suite (`test/accounts/env-profile.test.ts` refuse list)
- Method: static inventory + code read against C1–C12 / AC1–AC5. Spot-checked `node --test test/agents/claude-settings.test.ts` → **7 pass / 0 fail**. Did not re-run full `npm test` (Lead reports 1084 pass / 0 fail / 4 skip). **No live CLI probes fabricated** — used recorded evidence only.
- Linear: unavailable for this workspace (`active-run.md`); handoff in-repo only.

## Decision

**Approved** (re-review 2026-10-21 — see [Re-review](#re-review-post-b1--m1-fixes) below)

Prior verdict was **Changes requested** (B1 High `isolationProbe` bypass; M1 Medium `.claude.json` link skip). Both remediated with regressions green. No remaining High/Critical blockers.

## Spawn inventory (C2)

| Site | A | C | Status |
| --- | --- | --- | --- |
| `runClaude` — plan / review / verify | Yes (`withProjectSettingsNeutralized`) | Yes (`assertClaudeConfigDirSafe`) | **Met** |
| `runClaude` — research | Yes (cwd may be empty temp → A no-op) | Yes | **Met** |
| Provider self-test canary | via `runReadOnly` → `runClaude` | via `runClaude` | **Met** |
| `doctor.probe` | via `runClaude` (empty temp) | via `runClaude` | **Met** |
| **`doctor.isolationProbe`** | **No** — direct `runProcess` + `buildClaudeArgs` | **No** — `claudeEnv()` only | **Miss — High / blocker** |
| `discoverClaude` | N/A (empty discovery dir) | Yes | **Met** |
| Provider `auth` / `auth status` | N/A (L3c: project helper 0) | Yes | **Met** |
| Provider `detect` / `--version` | N/A | Exempt (inert; postfix version deltas 0) | **Met** |
| Account `login` | N/A | Gated off (`ACCOUNT_LOGIN_ENABLED`) | **Met** |
| Account `logout` | N/A | Named-only removal path; named pre-flight still refuses settings files entirely | **Met** (N/A for default — cannot remove/logout main) |
| Named-account stages | A via `runClaude` | N/A (folder refuse unchanged) | **Met** (AC3) |

Missing site that uses L3-affected stage argv ⇒ **blocker** under C2.

## Condition / AC matrix

| # | Status | Evidence |
| --- | --- | --- |
| C1 Control lock A+C | Met (plan) | Plan rev 2 locks A+C; D rejected; B optional/L3d only — not used in code. |
| C2 Spawn inventory | **Not met** | See table — `isolationProbe` bypass. |
| C3 A mechanics | Met on `runClaude` | lstat/no-follow; symlink/hardlink/non-file refuse; quarantine+restore under `.conductor-v2-quarantine/`; per-cwd promise mutex; targets `settings.json` / `settings.local.json` / `managed-settings.json`. |
| C4 C mechanics | Met on covered sites | Refuse `apiKeyHelper` or any own-property non-empty `env` object; empty `{}` env allowed; no rewrite of config dir (unit + postfix `C_unchanged`); size cap 1 MiB; class-only messages; covers auth / discovery / `runClaude`. |
| C5 `setting-sources` | Met via A | Stages still pass `isolation` through; A removes loadable project settings for both modes. Research still refuses non-`safe-mode`. |
| C6 AC1–AC5 | **AC1 partial** | Postfix: A path helper/listener **0**, settings absent during child, restored after; C refused before spawn. Full live Claude matrix (discovery / setting-sources / research) not re-run against real CLI — acceptable for A **if** every stage-shaped spawn goes through A; **undermined by isolationProbe miss**. AC2 met (refuse). AC3 named refuse list unchanged. AC4 init fail-closed still in `runClaudeBody`; spot-check F1 tests green. AC5: no new listener; messages class-only; evidence counts only. |
| C7 Isolation never advances | Met | `ADVANCING_ERRORS` = `limit` / `spawn` / `auth` only; F1 returns `errorKind: 'isolation'`. |
| C8–C9 Live evidence | Met for choke points | Pre: `l3c-project-settings.md`. Post: `l3c-f1-postfix.md` JSON deltas all 0 / refused. |
| C10 Docs | Met | `docs/ARCHITECTURE.md` F1 row: `--safe-mode` alone insufficient; A quarantine + C refuse stated. |
| C11 Named refusals | Met | `CLAUDE_REFUSED` / env-profile tests still refuse settings files entirely (not strip-and-allow). |
| C12 This checkpoint | **Open** | Verdict below — High residual ⇒ Changes requested. |

## Findings

### B1 (High / blocker) — `isolationProbe` bypasses A+C

- **Where:** `src/doctor.ts` `isolationProbe` (~L133–152): `runProcess({ args: buildClaudeArgs(...), cwd: repo, env: claudeEnv() })` — does **not** call `runClaude` / `assertClaudeConfigDirSafe` / `withProjectSettingsNeutralized`.
- **Why it matters:** Same stage argv shape L3(b)/L3c proved loads config-dir and (for project cwd) project `apiKeyHelper` / `env`. Canary cwd is Conductor-temp (A mostly N/A), but **C is required**: a planted default-account `settings.json` would still run the helper on `conductor doctor --isolation`. Plan inventory explicitly lists doctor canaries.
- **Remediation:** Route the probe through `runClaude` (preferred — one choke), **or** call `assertClaudeConfigDirSafe(env)` immediately before spawn and keep A N/A documented for the empty canary. Add a regression test that a planted throw-away `CLAUDE_CONFIG_DIR` `apiKeyHelper` yields zero spawn / isolation failure for the probe path.
- **Unblock:** B1 fixed + test green; re-submit Security code checkpoint (no new live matrix required if unit proves refuse-before-spawn on that path).

### M1 (Medium) — `.claude.json` link/hardlink silently skipped under C

- **Where:** `assertClaudeConfigDirSafe` — on `.claude.json`, `isSymbolicLink || !isFile || nlink !== 1` → `return` (allow), unlike settings files which **throw**.
- **Risk:** Defence-in-depth gap if a default config dir replaces `.claude.json` with a link to hostile JSON; Claude may still follow it.
- **Remediation:** Refuse with the same class message as settings links (`a link in place of a settings file` / untrusted file), matching named-account fail-closed posture.

### L1 (Low) — Postfix evidence is choke-point based

- Wrapper/`assertClaudeConfigDirSafe` proof is appropriate for A+C once inventory is complete; full live Claude L3c matrix was not re-executed. Acceptable after B1 closes; optional L3c replay remains nice-to-have, not a second blocker.

### L2 (Low) — No automated per-cwd mutex concurrency test

- Mutex implementation looks correct; a parallel `withProjectSettingsNeutralized` test would harden C3. Non-blocking.

## Verified good (do not regress)

1. **A:** quarantine+restore; symlink/hardlink refuse with zero `fn`; `runClaude` integration proves absent-during-child + restore.
2. **C:** refuse before spawn; config file bytes unchanged; any non-empty `env` object; `apiKeyHelper`; `.claude.json` helper/env (when regular file).
3. **Auth vs detect:** `auth` asserts C; `--version` / `detect` exempt.
4. **Discovery:** C before `ctx.spawn`; empty cwd ⇒ A N/A.
5. **Messages:** class-only strings; no paths/script bodies in `ClaudeSettingsError`.
6. **Test hygiene:** `test/preload.ts` forces throw-away `CLAUDE_CONFIG_DIR`.
7. **Docs honesty (C10):** ARCHITECTURE F1 row correct.

## Threat model notes (narrow, post-fix)

| Path | Residual |
| --- | --- |
| Untrusted repo project settings on stage/research/`runClaude` | **Closed** by A (evidence + tests) |
| Default config-dir helper/env on auth / discovery / `runClaude` | **Closed** by C |
| Default config-dir helper/env on `doctor --isolation` | **Open — B1** |
| Named account settings files | **Still closed** by M8-3 full-file refuse |
| Chain fallback on isolation | **Closed** (`advances` excludes `isolation`) |

## Unblock

1. Fix B1 (`isolationProbe` → `runClaude` or explicit C assert + test).
2. Fix M1 (recommended in the same patch — refuse `.claude.json` links).
3. Re-dispatch Security code checkpoint; expect **Approved** if B1 gone and no new High/Critical.

---

### Handoff: NEEDS-REVIEW (Lead / implementer) — superseded by re-review below

- Delivered: `.techteam/reviews/workspace-v2-f1-security-code.md` — Decision **Changes requested**.
- Artifact(s): this file; evidence relied on: `l3c-project-settings.md`, `l3c-f1-postfix.md`.
- Acceptance criteria: C1, C3–C5, C7, C10–C11 met on primary paths; **C2 / C6 / C12 not met** until B1 fixed.
- Checks run: code+evidence review; `node --test test/agents/claude-settings.test.ts` (7 pass). Full `npm test` not re-run (Lead: 1084/0/4).
- Decisions/assumptions: logout is named-removal-only so C N/A there; postfix choke-point evidence accepted for A once inventory is complete.
- Risks or known gaps: B1 High; M1 Medium.
- Next owner/task: Lead → implementer (B1, ideally M1) → Security code re-check.
- Exact next action: patch `isolationProbe` to use the F1 choke; add refuse test; do not mark F1 closed.

---

## Re-review (post B1 / M1 fixes)

- Reviewer: TechTeam Security Engineer
- Date: 2026-10-21
- Scope: verify remediation of **B1** and **M1** only; re-check spawn inventory C2 and C12 close-out.
- Inputs (delta):
  - `src/doctor.ts` `isolationProbe` (~L133–164)
  - `src/agents/claude-settings.ts` `assertClaudeConfigDirSafe` `.claude.json` branch (~L72–92)
  - `test/agents/claude-settings.test.ts` — `F1-C via doctor isolationProbe…`, `F1-C: .claude.json symlink refuses`
  - Prior section of this artifact (Changes requested)
- Method: code re-read against prior findings; `node --test test/agents/claude-settings.test.ts` → **9 pass / 0 fail**. Spot-checked `.claude.json` hardlink → refuse (`a settings file Conductor cannot trust`). No new live Claude matrix (per prior Unblock: unit refuse-before-spawn on probe path is enough). Linear: handoff in-repo only.

### Decision

**Approved**

B1 and M1 are closed. No remaining High/Critical. C2 spawn inventory is complete for F1; C12 Security code checkpoint is satisfied for F1 A+C. Residual Low items (L1 postfix choke-point evidence, L2 mutex concurrency test) stay non-blocking as before.

### Finding close-out

| ID | Prior | Re-check | Status |
| --- | --- | --- | --- |
| **B1** High | `isolationProbe` raw `runProcess` + `claudeEnv()` — no A/C | Before spawn: `assertClaudeConfigDirSafe(env)`; on `ClaudeSettingsError` → report `ok: false` + class note, no spawn. Child wrapped in `withProjectSettingsNeutralized(repo, …)`. Regression: planted config-dir `apiKeyHelper` + wrapper bin → `r.ok === false`, note matches `/key helper/`, spawn marker absent. | **Closed** |
| **M1** Medium | `.claude.json` symlink/hardlink/non-file → silent `return` | Same refuse as settings: symlink → `a link in place of a settings file`; `!isFile \|\| nlink !== 1` → `a settings file Conductor cannot trust`. Unit: symlink refuses. Spot: hardlink refuses. | **Closed** |
| L1 Low | Postfix choke-point based | Unchanged; acceptable now that inventory includes `isolationProbe`. | Open (non-blocking) |
| L2 Low | No mutex concurrency test | Unchanged. | Open (non-blocking) |

### Spawn inventory (C2) — updated

| Site | A | C | Status |
| --- | --- | --- | --- |
| `runClaude` — plan / review / verify | Yes | Yes | **Met** |
| `runClaude` — research | Yes / N/A empty temp | Yes | **Met** |
| Provider self-test canary | via `runClaude` | via `runClaude` | **Met** |
| `doctor.probe` | via `runClaude` | via `runClaude` | **Met** |
| **`doctor.isolationProbe`** | **Yes** (`withProjectSettingsNeutralized`) | **Yes** (`assertClaudeConfigDirSafe` before spawn) | **Met** (was Miss) |
| `discoverClaude` | N/A | Yes | **Met** |
| Provider `auth` / `auth status` | N/A | Yes | **Met** |
| Provider `detect` / `--version` | N/A | Exempt | **Met** |
| Account login / logout / named | as prior | as prior | **Met** |

Note: remediation used explicit A+C on the probe (allowed alternative in prior Unblock), not re-route through `runClaude`. Equivalent for C2 — stage argv cannot bypass the choke.

### Condition matrix (delta)

| # | Prior | Now |
| --- | --- | --- |
| C2 Spawn inventory | Not met | **Met** |
| C6 AC1 | Partial (undermined by probe miss) | **Met** for gate purposes (probe refuse-before-spawn proven; primary path postfix unchanged) |
| C12 This checkpoint | Open / Changes requested | **Closed — Approved** |

### Threat model (narrow residual)

| Path | Residual |
| --- | --- |
| Untrusted repo project settings on stage/research/`runClaude` | Closed by A |
| Default config-dir helper/env on auth / discovery / `runClaude` | Closed by C |
| Default config-dir helper/env on `doctor --isolation` | **Closed** (was Open — B1) |
| `.claude.json` link/hardlink under C | **Closed** (was M1) |
| Named account settings files | Still closed (M8-3 full-file refuse) |
| Chain fallback on isolation | Closed |

### Non-blocking nits (do not reopen gate)

1. `isolationProbe` catches `ClaudeSettingsError` only around C; if A threw on the canary (symlink plant), the error would propagate to CLI rather than a structured `IsolationReport`. Fail-closed (no spawn); UX-only. Fresh canary makes this unlikely.
2. No dedicated unit for `.claude.json` hardlink (code path shared with settings; spot-checked OK).

### Handoff: COMPLETE (Security code checkpoint)

- Delivered: this re-review — Decision **Approved**.
- Artifact(s): `.techteam/reviews/workspace-v2-f1-security-code.md` (this section).
- Acceptance criteria: C1–C12 met for F1 A+C Security code gate; B1/M1 closed with regression evidence.
- Checks run: code re-read; `node --test test/agents/claude-settings.test.ts` (9 pass / 0 fail); hardlink spot-check on `.claude.json`.
- Decisions/assumptions: explicit A+C on `isolationProbe` accepted vs routing through `runClaude`; no new live L3c required.
- Risks or known gaps: L1/L2 Low only; A-error UX nit above.
- Next owner/task: Lead — mark F1 Security code gate done; proceed with any remaining Reviewer/product close-out.
- Exact next action: no Security unblock remaining; do not reopen F1 for B1/M1.

## Ruling: narrowing of F1-C for settings `env` (2026-10-22, user-approved change)

- Scope: `checkSettingsRisky` / `envEntrySafe` in `src/agents/claude-settings.ts` (uncommitted). This applies to the **default** account's config-dir settings only.
- Unchanged:
  - `apiKeyHelper` still refuses;
  - `.claude.json` `env` still refuses;
  - project settings are still quarantined (A);
  - named accounts still refuse any `settings.json` (M8-3 S5).
- Reason: the blanket "any env refuses" rule blocked every stage for a legitimate local proxy.

**Q1. Is a loopback `ANTHROPIC_BASE_URL` acceptable? Yes, accepted as a residual.**
- It is the user's own deliberate configuration.
- It is no wider than the `ANTHROPIC_*` parent-env passthrough the stages already accept (M8-1 S15).
- The parsing is sound:
  - `new URL` normalises `127.1` / `0x7f.0.0.1` to `127.0.0.1`;
  - `127.0.0.1.evil.com` is not in the set;
  - userinfo is refused;
  - only http/https are allowed.
- Residuals:
  - (a) When the proxy is down, any local process can bind that port (including another user's on a shared Mac) and receive prompts plus the bearer credential.
  - (b) A same-user process (for example a builder) could plant a loopback URL together with a listener. A same-user process can already read the Keychain and the config dir, so (b) adds no new capability.
- Docs must state (a) in one line.

**Q2. Deny-list or allow-list? Allow-list. Binding condition before commit.**
- The deny-list misses variables that can change behaviour or load code:
  - `XDG_CONFIG_HOME` (redirects config lookups);
  - `GIT_SSH_COMMAND` ("SSH_COMMAND" matches none of the deny patterns);
  - `PYTHONPATH` / `PYTHONSTARTUP` / `PERL5OPT` / `RUBYOPT` / `BASH_ENV` / `ENV` / `ZDOTDIR`;
  - `CLAUDE_CODE_SHELL_PREFIX` and `CLAUDE_CODE_ENTRYPOINT` (the M8-1 review already ruled that `CLAUDE_CODE_ENTRYPOINT` changes what the CLI thinks its host is);
  - `TMPDIR`.
- An open-ended name space cannot be closed by a deny-list.
- **Required rule.** An env entry is allowed only if one of these holds:
  - (i) it is `ANTHROPIC_BASE_URL` meeting the existing loopback rule;
  - (ii) its name matches `^(ENABLE|DISABLE)_[A-Z0-9_]{1,58}$` (Claude feature toggles; this covers the user's `ENABLE_TOOL_SEARCH`) **and** its value matches `^[A-Za-z0-9_.,:-]{0,64}$`.
- Everything else refuses.
- Keep the existing deny-list as a second filter after the allow-list (defence in depth: a toggle containing `KEY`/`TOKEN`/`AUTH` etc. still refuses).
- Why toggles are acceptable: the read-only stage isolation is enforced by argv plus the fail-closed init predicate (exact tool set, no MCP, `dontAsk`), not by env. A toggle that added a tool or an MCP server would fail that predicate and spawn nothing useful.
- The refusal message stays class-only and names the remedy, for example "an environment setting Conductor does not allow (only ENABLE_/DISABLE_ toggles and a local ANTHROPIC_BASE_URL)". No key name or value is echoed.
- **Tests to add:**
  - the user's exact block passes;
  - `XDG_CONFIG_HOME`, `GIT_SSH_COMMAND`, `PYTHONPATH`, `BASH_ENV`, `CLAUDE_CODE_SHELL_PREFIX`, `CLAUDE_CODE_ENTRYPOINT`, `TMPDIR` and a lowercase key each refuse;
  - `ENABLE_X` with the value `$(touch /tmp/x)` or with a value over 64 characters refuses;
  - `ANTHROPIC_BASE_URL` set to `http://127.0.0.1.evil.com`, `http://[::2]`, `file:///…` and `http://u:p@localhost` each refuse.
- If the user later needs another specific variable, it is added by exact name after a Security note. No pattern widening.

**Verdict for this change:** approved once the allow-list above replaces the deny-list as the primary rule and the listed tests pass.

Verdict: Approved with conditions
