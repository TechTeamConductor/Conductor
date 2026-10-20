# Security verification: M2 fixes (d08e05f, f608422) and the rev-2 plan transcription (f2b0bc7)

- Reviewer: TechTeam Security Engineer (independent of the author)
- Date: 2026-10-20
- Scope: (1) verify by diff that my M2 code-review conditions F-1..F-8 are applied (d08e05f) and review the additions in f608422; (2) check that the M5/M7 design conditions and the M3/M4/M6 skim notes are transcribed faithfully into the plans (f2b0bc7) and give a Decision per item.
- Method: `git archive` exports of d08e05f, f608422 and f2b0bc7 into scratch directories; full diffs read; the full suite and the type-check run on the f608422 export with a throw-away `HOME`/`CONDUCTOR_HOME`/`CONDUCTOR_BACKUP_DIR` and `CONDUCTOR_NO_KEYCHAIN=1`; ten extra probes of my own (`test/zz-sec-m2fix.test.ts` in the scratch export only). No real CLI (claude, agent, codex) was run, nothing under `~/.conductor` was touched, source and plans were not edited.
- Results: `npm run check` clean. `npm test` on f608422: **587 tests, 583 pass, 0 fail, 4 skipped** (the live suites). My probes: 9 of 10 pass; the one failure is my own wrong expectation in the probe (I asserted the tier name `full` for Claude; the vocabulary is `verified`), not a product issue.
- Codex status is unchanged and must stay so in every doc and UI string: **unverified / not run** (this machine's codex is a broken shim; no real transcript exists).

## Decisions

- Decision (M2 fixes F-1..F-8, d08e05f): **Approved**. All eight are applied and I reproduced the behaviour.
- Decision (f608422 additions, B1-B5 and majors): **Approved** with five non-blocking notes N-1..N-5 below.
- Decision (M5 transcription, §2b-1..8): **Approved**: faithful, with two places where the plan is stricter than my conditions (accepted) and five clarifications C5-1..C5-5 to fold into the text.
- Decision (M7 transcription, §2b-1..11): **Approved**: faithful, one place stricter than my conditions (accepted), six clarifications C7-1..C7-6 (C7-1 is the one that can break the build if left open).
- Decision (M6 transcription, §2b-1..7): **Approved**: faithful on every Security item; the Reviewer's changes to the risk rules and the default policy are acceptable as stated, with clarifications C6-1..C6-4.
- Decision (M3 transcription, §2b-2/7/8/9): **Approved**: faithful; one wording fix C3-1.
- Decision (M4 transcription, §2b-2/3/5/6): **Approved**: faithful; clarifications C4-1..C4-3.
- Decision (D10..D13 as recorded in M5 §2b): **Confirmed**; they match my recommendations.
- Start of M3/M4 implementation: **no Security objection**. None of the clarifications blocks M3 or M4; fold C3-1, C4-1, C4-2 and the accounting-module ordering (C5-4) in as you go. I will review each commit (M3 and M4 are on the build path and on a persistent store whose content reaches prompts).

---

## Part 1: M2 fixes

### F-1..F-8 against d08e05f (and what f608422 changed on top)

| # | Condition | Verdict | Evidence |
| --- | --- | --- | --- |
| F-1 network | A PASS needs a connection-failure exit and a listener that provably records | **Closed** | `evaluateCanary`: `fail` on any hit; `inconclusive` unless `listenerWorks` (Conductor's own `controlConnect` before the model run, then `reset()`); pass only for curl exits {6,7,28,35,52,55,56}. Probe: exit 7 pass; 0 and 127 inconclusive; `listenerWorks=false` inconclusive; hit gives fail. |
| F-1 env | `env`/`printenv` matched inside shell wrappers | **Closed**, with note N-1 | `ENV_CMD` regex; wrapped forms are found. It is also broad (N-1). |
| F-1 control layer | The positive control must be signed in, inside the private home, removed in a `finally` | **Closed** | The control layer (hook, MCP block, rule) is planted in the private home under the home lock and removed in `finally`; `prepareCodexHome(..., {purge:true})` then rewrites `config.toml` and refuses leftovers. Probe: a leftover `hooks.json` or `rules/canary.rules` makes the next pre-flight refuse (fail closed); a leftover MCP block in `config.toml` is rewritten to the constant. f608422 adds a `codexAuth` pre-check so an unsigned install stops before any model call. |
| F-1 tier | A canary PASS must not lift the tier until validated on a real transcript | **Closed** | `canaryValidatedAgainstRealCli = false`; `effectiveReadOnlyTier` returns the code constant after a pass, but `blocked` still blocks (probe: pass gives `unverified`, then blocked gives `blocked`). The seam `_setCanaryValidatedForTests` throws outside a test run. The API reports `trusted: false`. |
| F-2 | Health and auth must not wait for the per-home lock | **Closed** | `codexAuth` no longer takes `withCodexHomeLock`. Probe with the lock held: `codexAuth` returned `ok` in 58 ms (I measured 3016 ms starvation before). The unlocked `prepareCodexHome(..., {purge:false})` does not purge, and returns not-ok before touching `config.toml` while a canary control layer is planted (stray-entry check comes first). |
| F-3 | `envAllow` arrays frozen | **Closed** | `seal()` freezes `build.envAllow`, `build` and the provider; probe: `push` and reassignment throw `TypeError` for every provider with a build capability; the registry object is frozen. |
| F-4 | Purge regenerable private-home entries before each run | **Closed** | `REGENERABLE = models_cache.json, shell_snapshots, cache, tmp, .tmp`, purged only on the locked path. Probe: planted entries removed; a symlinked entry is unlinked and its outside target survives; any other planted name (for example `AGENTS.md`) still refuses. |
| F-5 | Vendor binary hash: hash it or document | **Closed (documented)** | `docs/ARCHITECTURE.md` and README state that Codex has never run against a real binary and that the canary is written from documentation and a scripted stand-in. |
| F-6 | Cooldown starts before the run | **Closed** | `canaryLast.set` moved before the call; `test/server-providers.test.ts` "F-6" passes. |
| F-7 | Board comment when a read-only step ran on another provider | **Closed** | `AgentOutcome.from`; `callReadOnly` posts an idempotent comment keyed `fallback:<stage>:<loop>:<agent>`, naming both providers (registry labels, not model text) and the weaker tier; `codex.test.ts` "F-7" passes. |
| F-8 | Errors list capped | **Closed** | `MAX_ERRORS = 5` on both push sites. Probe: 200 events leave 5. |

### Additions in f608422

Reviewed: `BROKEN_RE`/`spawn` classification for all three CLIs, the `detect/auth/selfTest` provider interface and `probe.ts`, the engine's own `freshHealth`, `user-clear` records and `doctor --clear-block`, the `--output-schema` removal, the roles-PUT "unchanged entry" rule, `WRITE_DENIED`, and the config fallback fix. Nothing weakens an M2 invariant: records still cannot raise a tier above the code constant, the router is still pure, `advances()` is unchanged. Notes:

- **N-1 (Low) `ENV_CMD` is broad.** The probe shows `echo env`, `grep env package.json` and `which env` each produce an env-decoy PASS when their output is merely non-empty and decoy-free. It cannot lift the tier today (F-1 gate), but when the matchers are validated on a real transcript, require that the unwrapped command is exactly `env`/`printenv` and that the output contains a known baseline variable (for example `PATH=`), not just non-empty text.
- **N-2 (Low, fix before wiring) `selfTest` uses `process.cwd()`.** For Claude and Cursor the `canary`-level `selfTest` makes a model call in `process.cwd()` (wherever Conductor was started: possibly the user's home or a repository), while the existing probe in `doctor.ts` runs in an empty scratch directory. `selfTest` has no callers yet. Before it is wired it must run in a fresh empty `mkdtemp` directory, as the old probe does.
- **N-3 (Low) `BROKEN_RE` is broad.** `vendor|not found|enoent|no such file` over the stderr tail, when no result event exists and the exit is non-zero, makes the stage a START failure (`spawn`), which lets the chain advance (possibly to the weaker Cursor ask tier). A CLI's stderr can echo repository paths, so a hostile repository might occasionally steer a fallback. Bounded: only with no result at all, the F-7 comment makes it visible, the router's tier rules still apply. Codex is tighter (no session, no errors, no commands, no text). Suggest tightening Claude and Cursor to exit 126/127 or an `ENOENT` spawn error.
- **N-4 (Low) `user-clear` UX.** It is CLI-only (no HTTP route; `addRecord` with that source appears only in `cli.ts` and a test), it can only return to the code constant, and a later blocked canary blocks again, so the invariant holds. Two gaps: it needs no `--yes` or TTY confirmation, and `isolationCheck` in the API is still derived from the last canary record, so after a clear the panel can show "blocked (current)" while the tier is `unverified`. Suggest printing the failing items it is clearing, requiring `--yes`, and showing "block cleared by user at <time>".
- **N-5 (Low) Roles PUT no longer re-judges entries already in the role.** Acceptable because the router refuses an invalid pairing at run time with zero spawns (`routing.test.ts` "build roles admit only build && verified providers", `roles-config.test.ts` "an assignment that no provider may take ... ZERO spawns"). Keep those two tests.

---

## Part 2: transcription of the rev-2 plans (f2b0bc7)

I compared each condition in `workspace-v2-m5-m7-security-design.md` (the copy in f608422 is byte-identical to my file) with the §2b text.

### M5 (`workspace-v2-m5.md`)

Faithful: M5-1 (§2b-1, with the ordering of caps, hardened env, `GIT_NO_LAZY_FETCH`, AC2 symlink test and D12), M5-2 (§2b-2 (a)..(h) word for word), M5-3 (§2b-3), M5-4 (§2b-4, plus an extra probe item: an attempted read of an absolute path outside the cwd must be denied), M5-5 (question-only default prompt), M5-6 (§2b-6), M5-7 (§2b-5, with D10), M5-8 (§2b-7), M5-9..16 (§2b-8, including the persisted limits and the DELETE endpoint). D10..D13 are recorded as I recommended.

Stricter than my conditions, accepted: the default research profile has **no file tools** (`--tools WebSearch,WebFetch`, init set `{WebSearch, WebFetch, StructuredOutput}`); Read/Grep/Glob only for the repo-aware opt-in. That is better (Read plus WebFetch is a data-plus-exfiltration pair). It also fixes an inconsistency in my text (I kept Read in the default). And: an ask fails fast instead of queueing, and an interrupted ask is never re-run automatically.

Clarifications to fold in:

- **C5-1 (Low) Stale lines outside §2b.** §3 table row for `stages.ts` still says "skip plan review, auto-approve unless hold", and §5 still lists "fast-path matrix (S + unprotected ⇒ auto; ...)". §2b overrides, but rewrite both so an implementer reading the table does not build the old behaviour (matrix must include `allowChange`, planner-derived eligibility and policy precedence).
- **C5-2 (Medium) The "Let Conductor make this change" button.** §2.3 offers a button for a `change` and separately a default-off `allowChange` option. State that the button creates an `ask-convert` card (untrusted, approval forced) and never starts the fast path; the fast path starts only from the option ticked **before** the ask.
- **C5-3 (Medium) Three new actors, and the board schema.** The fast path uses `createdBy: 'user-ask'`, research uses `research`, convert uses `ask-convert`, but §2b-3 lists only the last two. `ACTORS = ['user','conductor','import']` in `src/board/validate.ts:8` is checked on journal load (`item.createdBy`), so a journal containing a new actor is rejected by any older build: bump the board schema/journal version (or document no-downgrade) and add a validation test for all three.
- **C5-4 (Medium) Accounting module ordering.** §2b-8 persists `asksPerHour` and `researchPerDay` "through the single accounting module of M6", and M4 §2b uses it for `contextRunsPerDay`. M4 and M5 are built before M6. Land `src/limits/budget.ts` with its first consumer (M4 commit 4), not in M6; otherwise M5 will ship non-persistent counters.
- **C5-5 (Low) Predicate sets.** §2b-7 (b) should name both research sets (default and repo-aware); the default-profile predicate must not require Read/Grep/Glob.

### M7 (`workspace-v2-m7.md`)

Faithful: M7-1 (§2b-5), M7-2 (§2b-6), M7-3 (§2b-7), M7-4 (§2b-2), M7-5 and M7-6 (§2b-3 (a)..(d)), M7-7 (§2b-1), M7-8 (§2b-8), M7-9 (§2b-9), M7-10 (§2b-10, with the Linux-container suite correctly added to the download list), M7-11..21 (§2b-11).

Stricter than my conditions, accepted: **per-platform build baseline in code, and the host self-test record can only restrict** (R-M7-1). My wording let a passing record enable building; the Reviewer's version keeps the M2 principle that no file can enable a capability. Windows and Linux builders stay disabled until their own evidence is committed.

Fact check on §2b-2 ("v2 stores no credentials today"): confirmed. `putSecret`, `getSecret` and `registerSecretEnv` have no callers outside `src/secrets.ts`; `runtime.ts` only builds the store and exposes `dropSecret`. The inventory (env passthroughs in `agents/env.ts`, session OTP/cookie/CSRF in memory, CLI-owned stores, `.env` values read for redaction) matches the code.

Clarifications to fold in:

- **C7-1 (Medium; can break the build) asar versus fuses.** §2b-4 (b) requires the fuses `OnlyLoadAppFromAsar` and `EnableEmbeddedAsarIntegrityValidation`, and §2b-4 (c) says "decide `asar: false` or an explicit `asarUnpack` list". With `asar: false` those two fuses make the app fail to load. Decide now: asar plus a minimal `asarUnpack` (only files that are spawned or read by external processes), or drop the two fuses explicitly and record the residual. Do not leave both.
- **C7-2 (Low) Stale rows contradict §2b.** In §2.2/§2.3: the secret-store row (Linux "0600 file store with a visible notice" versus §2b-2's consent rule; Windows row still describes building `safeStorage` now), the no-push row ("gated on a passed host self-test record" versus "a record can only restrict"), the process-model bullet (`ELECTRON_RUN_AS_NODE` alternative dropped by §2b-6), the BrowserWindow bullet ("a dedicated session partition" versus non-persistent). §2b overrides; rewrite the rows.
- **C7-3 (Medium) Missing record means disabled.** Under R-M7-1 a missing host self-test disables building on that host. Without an automatic run, upgrading macOS users lose building. The self-test is local and zero-quota, so run it automatically at first start and when its binding changes, and surface a failure as a health banner with the reason.
- **C7-4 (Medium) Windows `open` fallback.** §2b-8 says the CLI prints the URL as the fallback. The fallback must not be a route that mints an OTP without an existing session (that would be an unauthenticated sign-in). Printing the URL that `start` generated is fine; a new minting endpoint is not.
- **C7-5 (Low) Gate wording.** The header says M7a may start once §2b-1 and §2b-3 are accepted. M7a also implements §2b-8, §2b-9 and the strategy-discipline and artifact-contents items; all of §2b binds M7a.
- **C7-6 (Low) Windows command override.** §2b-3 (c) adds a per-gate Windows command override in config. State that it passes through the same whitelist grammar, and validate it in the settings API like any other command text.

### M6 (`workspace-v2-m6.md`)

Faithful: M6-S1 (§2b-1, with `approvedBy` and the structural test), S2 and S3 (§2b-5), S4 (§2b-2, with the added git < 2.28 fallback and "target inside another git work tree refused"), S5 (§2b-3), S6 (§2b-6), S7 (table text plus §2b-7), S8 (§2b-7). The `planApproval` mapping preserves v1 (`first` becomes `full-auto` plus `policy.firstPlanHold`), so no behaviour is lost.

Reviewer changes that touch Security, accepted:

- Risk rules now run on **structured fields only** (`testing.commands[]`, `filesToChange[]`, graph item files), not prose `steps`; `full-auto` is "forced holds only" and is the default (= v1); `approve-risky` adds the risk rules. Together with the diff re-check before `ready` (§2b-5) this is acceptable for a seatbelt that the text itself says does not intercept a `--force` builder.
- The sample repository moved outside the Conductor home (resolves my M6-S5 conflict with `inspectRepo`).

Clarifications:

- **C6-1 (Medium) Commands in prose steps are no longer seen.** A plan step with a backticked or fenced `terraform apply` or `git push` is exactly what the rule exists for, and it is now invisible under `approve-risky`. Recommend also matching the destructive-command patterns inside **code spans and fences** of `steps` (commands, not prose; "update the deployment docs" stays clean). At minimum the UI and docs must say "approve-risky checks planned test commands and file lists, not the prose of steps".
- **C6-2 (Low) Default policy wording.** §2.1 makes `full-auto` the default while wizard step (5) sets `approve-risky`. State it once: unconfigured and migrated installs stay `full-auto` (v1); projects created through the wizard start `approve-risky`. The `full-auto` confirmation (§2b-6) should list which holds remain.
- **C6-3 (Low) Sample registration.** The sample now lives in a user-confirmed folder, so register it through the normal validated path. If the "internal-only path matching one constant directory exactly" is kept, it can only match the exact directory Conductor just created (record `dev`/`ino`); a user-chosen folder is not constant.
- **C6-4 (Low) Budget file.** `src/limits/budget.ts`: validate on load, quarantine a corrupt file, never throw into the engine, bound the counters, and for the ask and research buckets prefer "limit reached until the next local day" over a silent fresh budget when the file is unreadable.

### M3 (`workspace-v2-m3.md`)

Faithful: M3-S1 (§2b-7 trust classes, caps, "post-approval notes are run-local data"), S2 (§2b-2: one commit, parent equals `startHead`, clean tree, per-attempt nonce, **postBuildChecks and gates before `done`**, analysis never adopted, forge tests including a builder-made forged commit), S3 (§2b-8), S4 and S5 (§2b-9, 12 is the hard ceiling and config can only lower it). The Reviewer's addition to bypass the single-task crash-window block for graph runs is correct and needed.

- **C3-1 (Low) Wording.** §2b-2 says the nonce is one "the planner/builder cannot guess". A `--force` builder runs as the user and can read the run record, so the nonce is not secret. The guarantee is that adoption is not trusted (scans and gates run before `done`), which is already in the same paragraph. Reword and add one test where the builder reads the nonce from `run.json`, forges the commit, and is still held to the checks.

### M4 (`workspace-v2-m4.md`)

Faithful: M4-S1 (§2b-5 with spawn and time caps), S2 (§2b-3 (c), (d), (e): cumulative 24 h, episode cap 20, constant probe, structural error fields only), S3 (§2b-2 strings), S4 (§2b-6), S5, S6 (research prompts take deterministic facts only). Good additions: builder facts are computed at use time from git objects (the on-disk store is a cache for read-only stages and the UI only), a set `HTTP_PROXY`/`HTTPS_PROXY` makes the probe return `unknown`, and a human Resume is never re-paused by the probe alone.

- **C4-1 (Low) Charset versus script commands.** `[A-Za-z0-9._@/+:=-]` excludes the space, so nearly every `scripts{}` command (for example `node --test`) is dropped. The security aim (no sentence-shaped strings) is met either way; decide whether to keep script names only or define a token grammar.
- **C4-2 (Low) Validate on load.** A builder can rewrite the cache, and read-only stages and the UI read it. Re-apply the charset, length and control/bidi rules when the cache is loaded, not only at scan time; add a test that planted prose in `facts.json` does not reach a read-only prompt unfenced or unvalidated (the M4-AC4 forgery test already covers builders).
- **C4-3 (Low) Probe-based classification.** The new rule (a provider stage that times out while the cached probe says `offline` is classed `network`) is acceptable: a hostile repository cannot influence the probe, and the cumulative cap and episode cap bound pause loops. Keep the refund and the cap tests.

---

## What I will check in the M3/M4 code reviews

- M3: nonce-based adopt (one commit, parent equals `startHead`, clean tree, checks before `done`) with the four forge cases; `attributeBug` membership in the diff's file list, `--` plus literal pathspecs and 40-hex ids; item notes capped, fenced and absent from the approval text; the 12-item ceiling in both validator and config clamp; string sanitising for commit messages and subtask cards; graph runs bypass the single-task crash block; the approval hold uses the union of item files.
- M4: store directories created with an explicit 0700; hardened git env including `GIT_NO_LAZY_FETCH=1`; builder facts recomputed from git objects and never read from the cache; no symlink or submodule followed; probe constants and `redirect:'error'`; offline pause cumulative cap and episode cap; summaries and history never in builder or research prompts; keys validated before any path.

## Unblock summary

Nothing blocks. Fold C5-1..C5-5, C7-1..C7-6, C6-1..C6-4, C3-1 and C4-1..C4-3 into the plan text at the next revision (C7-1, C5-3 and C5-4 first, because each causes rework if found late). N-2 must be fixed before `selfTest` is wired to anything; N-1 and N-3 belong with the real-transcript validation of the canary matchers.
