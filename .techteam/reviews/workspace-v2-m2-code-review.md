# M2 code review (commits 2a-2d, 3, 4) and re-check of the commit-2 conditions

- Reviewer: independent. Security review is a separate gate. Code at `bd5f186` (HEAD has since moved to docs commits); I read `git archive` exports, not the working tree.
- Method: `npm run check` and `npm test` under a fake `HOME`; every new/changed test file run on its own; diffed every unchanged/migrated test against `492141b`; read all of `routing.ts`, `roles.ts`, `provider.ts` (router loop), `config.ts` (v4), the engine/stages router states, `envelope.ts`, the sealed registry, `codex.ts`, `codex-home.ts`, `canary.ts`, `verification.ts`, the API diff, the CLI diff, the UI diff, the docs; **11 mutation tests** on the routing/registry/canary/Codex/API code; six probes with scratch scripts (listed below). Nothing outside the scratchpad was written.
- Not verified by me: any real Codex binary (none runs on this machine, as you say), the live Cursor suite (I read the two saved logs: 3/3 after the extraction and 3/3 after the router change; I did not re-run them), Windows/Linux, the UI beyond reading the diff.

## Facts
- `npm run check` clean. **548 tests, 544 pass, 4 opt-in skips** (487 at 492141b + 61). The 61: routing 11, roles-config 8, server-providers 7, providers/codex 11, providers/canary 14, envelope +4, engine-safety +1, migrate-hardening +5.
- Unchanged and byte-identical to 492141b: `agents`, `engine-happy`, `engine-human`, `engine-loop`, `engine-plan`, `engine-security`, `engine-authz`, `git/worktree`. `src/agents/claude.ts` and `src/agents/cursor.ts` are not modified, so the Claude argv and the fail-closed init predicate are byte-identical.
- Migrated, as the M2 matrix lists and no more: `core` (config defaults/garbage test), `engine-limit` (2 config lines), `engine-regress` (the v1→v4 upgrade test), `schema`, `migrate`, the two live-suite config lines. Each migrated assertion is the same assertion on the derived value (for example `toSettings(cfg).onClaudeLimit` for the old `pipeline.onClaudeLimit`); none is weaker.
- Mutation tests, all **killed**: pause ignored by the router; `isolation` added to the advancing errors; complexity pick allowed to lower the tier; `blocked` tier allowed; registry check on object identity removed; `blocked` no longer sticky; prepare-env allow-list removed; "turn.completed + exit 0 is never a failure" removed; build-capability filter at config load removed; the `unverified` acknowledgement removed; canary "absence with a silent control is not a pass" removed.

## Part 1 — my commit-2 conditions

| Condition | Result | Evidence |
| --- | --- | --- |
| M-1 backup before an older run.json is rewritten | **Closed** | `RunStore` marks a record read at an older schema and copies it to `~/.conductor-backups` before its first rewrite; a failed backup refuses the write; the new test checks the backup holds the original. `run.json`, `config.json`, `state.json`, the verification file and the importer's staged files go through `atomicWriteFile(..., {durable:true})` (fsync file, rename, fsync directory) |
| m-1 registry identity | **Closed** | `createProviders` deep-freezes and registers every provider in a `WeakSet`; `buildEligibility` refuses anything else; the test seam for misbehaving adapters throws outside a test run (E17b). I re-ran my old probe: an object claiming `id:'cursor'` is now refused |
| m-2 env merge order | **Closed by amending the plan** | §2b-1(d) now says `extraEnv < prepare's allow-listed env < envelope env`, which is what the code does. Prepare's env is also an allow-list (`CURSOR_*`) now, stricter than before. One stale comment remains on `ProviderDeps.extraEnv` in `types.ts` |
| m-4 tamper + limit/abort/timeout/error | **Closed** | E25 |
| m-5 snapshot failure | **Closed** | `runBuild` holds the build, builder not started (E17d) |
| P-1…P-5 plan text | **Closed** | rev 3 text, the stance on a repo-level `.codex/` layer, P-4 argv line |
| live Cursor log after the extraction | **Present** | `.techteam/runs/evidence/live-cursor-suite-after-envelope-extraction-2026-10-20.log` (3/3) and the post-router log (3/3) |
| M2-5 (from round 3): the settings back-mapping must change only the first claude/cursor slot or the cursor-follows-claude rule and leave other entries intact | **Violated in one case** | see blocking item 5 |

## Part 2 — what the code does (verified)

- **Router** (`routing.ts`): pure (a deep-frozen input works, the clock is an argument); a provider that may not hold the role is dropped and never run, even as the last one left; `blocked` is unusable for every role; the complexity pick leads only for post-plan roles, only if eligible, and never at a lower tier; unhealthy providers are skipped with a reason; all-eligible-paused waits until the earliest reset (v1 semantics); an only-ineligible chain ⇒ zero spawns and the reason. Only `limit`/`spawn`/`auth` advance (`isolation` and `agent` never do). `Agents.readOnly` leaves a visible note at every hop and a weaker-tier reminder, and records a pause when a candidate hits a limit even though the chain moves on.
- **Default-chain equivalence with v1**: the defaults are `planning/review/verification = [claude, cursor]`, `implementation/debugging/documentation = [cursor]`, no Codex anywhere. `migrateConfigV3ToV4` reproduces v1 exactly, including v1's default upgrade (`wait` → takeover) on the `loadVersioned` path (checked in the schema test), keeps the old keys verbatim under `legacy.v3`, and treats `stages.plan='cursor'` as `[cursor]` with no fallback, which is what v1 did. Same limit behaviour in `engine-limit` (wait pauses, cursor falls back).
- **Documented divergences from v1** (accepted in the plan as "new, visible behaviours"): a Claude that is not installed, not signed in (per the last health reading) or that fails to start now hands the read-only stage to Cursor in ask mode instead of failing; the build stage also goes through the router (ineligible ⇒ held with the reason, all-limited ⇒ pause). Worth stating in the release notes because the independent verifier can end up on the weaker tier.
- **API**: strict plain-object bodies, own-property role names, registry ids only, every pairing through the capability/tier gate with a reason, `unverified` needs an acknowledgement, `blocked` refused, egress notice, canary needs `confirm:true` every call, single-flight, cool-down, refused while stages run. CLI strings in `/api/providers` are redacted and truncated; hints are static.
- **Codex**: constants-only argv (tests pin the exact list and the absent flags), prompt on stdin, schema and `-o` files in a 0700 temp dir outside the worktree, private `CODEX_HOME` and a per-run empty `HOME`, env allow-list (no `OPENAI_*`, no user `CODEX_*`), hygiene pre-flight with zero spawns on a planted entry, runs serialised per home, failure classification only after a structural failure from capped structured errors, no `build` by construction. No API-key mode, which is the right call without a working binary.
- **Verification records**: add-only, closed field set, lstat/owner/size checks, anything wrong reads as "no record"; a pass counts only while the install matches and never when the install is unknown; `blocked` is sticky; no path from a record to `buildIsolationVerified`.

## Part 3 — blocking items

**B1 — the dashboard hangs while a Codex stage runs.** `agentHealth(cfg,'codex')` calls `codexAuth`, which takes the same per-home lock as a Codex run. `Api.state()` awaits `cachedHealth()` (30 s cache), so after the cache expires `GET /api/state` (and `/api/providers`, and a "cheap" test) wait for the running stage. Probe: a fake Codex stage with a 6 s delay; `agentHealth(cfg,'codex',true)` started 0.8 s in returned after **5.3 s** (with the real plan timeout of 20 minutes the dashboard stalls for up to that long, whenever Codex is assigned to a role). Fix: health must not wait for the home lock (try-lock and answer the last known value, or run `login status` outside the lock), and add a test that `/api/state` answers promptly while a Codex stage is running.

**B2 — a broken Codex is only skipped while a dashboard has looked recently; at run time it is not a `spawn` error.** The router's health comes from `lastHealth`, which only the dashboard refreshes (older than 5 minutes it counts as "unknown ⇒ installed"). With nobody looking (the normal headless case) a chain `[codex, claude]` on this machine starts Codex, the shim prints `Error: spawn …/codex ENOENT` and exits 1, and `classifyCodexFailure` returns `agent` (probe: `{"kind":"agent",…}`), which does not advance the chain: the stage retries once and then goes to a human. `docs/TROUBLESHOOTING.md` says a broken Codex "is skipped by the router (the next provider in the chain does the stage)", true only with fresh health. Fix: classify a shim failure at exec (the same `BROKEN_RE` shapes `detectCodex` uses, on a non-zero exit with no CLI events) as `spawn`, and let the engine refresh the zero-quota health itself before routing when its reading is stale. Add the engine test with the fake.

**B3 — the isolation canary can never PASS on a real install.** The positive control runs Codex with a scratch `CODEX_HOME` that holds only the hook/MCP/rule files, so there are no credentials (and `OPENAI_*`/`CODEX_API_KEY` are rightly excluded from the env): the control run cannot reach the model, so its hook never fires and its rule probe is never attempted. Every item that depends on a control is then `inconclusive` by design, so the verdict is never `pass`; it can only be `inconclusive` or `blocked`. The fake binary does not model authentication, which is why the 14 canary tests are green. Consequences: the `partial` lift is unreachable in practice, and a `blocked` result (sticky "until a later pass") becomes permanent. This is a spend-quota command. Fix: give the control run Conductor's own credential (copy the private home's `auth.json` into the scratch control home with 0600 and remove it in `finally`; never the user's), or run the control against the private home's login with the layer files placed where Codex loads them; make `fake-codex.mjs` require an `auth.json` in its `CODEX_HOME` so this test would have failed; and provide a way to clear a stale `blocked` (a flag on the doctor command, documented), because a sticky block that no check can clear is a trap.

**B4 — acceptance criteria not met or not evidenced.**
 - AC3 ("three providers implement one interface; detect/auth/selfTest classify `missing | broken-install | not-logged-in | ok | unknown`"): the `Provider` type has `id`, `label`, `runReadOnly?`, `build?` only. Detection and auth live in `doctor.ts`/`codex.ts` as separate functions, there is no `selfTest`, and `ApiProvider.state` has `attention` instead of `unknown`. The plan's own §2 block lists `detect/auth` for commit 3 and `selfTest` for commit 4, and neither commit delivers them.
 - M2 AC (d) ("every provider passes one shared contract test suite (fakes)"): there is none. Claude and Cursor are covered by the old `agents` tests, Codex by `codex.test.ts`.
 - AC4 ("complexity routing honoured (unit + engine tests)", "fallback order"): complexity routing and fallback order are unit-tested only; no engine test has a plan complexity drive the router (`grep autoByComplexity test/` finds nothing outside the unit/API/config tests).
 Resolve each by delivering it or by amending the plan and the master AC3 coverage row to say what was descoped and why; add the two engine tests either way (complexity pick changes who reviews; a limit on the first provider moves the stage to the second and records the pause).

**B5 — the Settings back-mapping can reorder a chain (my condition M2-5).** `setCursorFallback(on)` removes every `cursor` from the chain and appends one at the end. Probe: planning `['cursor','codex','claude']` with a PUT of `onClaudeLimit:'cursor'` ⇒ `['codex','claude','cursor']`: the head silently changes from Cursor to Codex. (`['claude','codex']` ⇒ `['claude','codex','cursor']` and `['claude','codex','cursor']` + `wait` ⇒ `['claude','codex']` are right.) Fix: when a Cursor already sits before Claude, leave the chain alone (the derived value stays `wait`) rather than moving it; add that case to the round-trip test.

## Part 4 — majors and minors (non-blocking)

- **Major risk, unverifiable here: `--output-schema` with Conductor's schemas.** `PLAN_SCHEMA` and the other stage schemas have optional properties (`deliverable`, `answer`) and no `additionalProperties:false`. As far as I know, Codex sends the schema as a strict structured-output format, which rejects exactly that; the fake accepts anything. If so every real Codex stage fails with an `agent` error. Mitigation to plan now: derive a strict-compatible schema for Codex (all keys required, `additionalProperties:false`, optional fields nullable) or do not pass `--output-schema` and rely on the JSON instruction plus `validate()`, and let the first real run decide. Put it in the plan's risk list.
- Canary weak-pass paths: the network item passes when the probe command is attempted and nothing connects, which is also what a missing `curl` produces (exit 127); the write item passes on any non-zero exit with no file. Require evidence that the denial was the sandbox's (the error text/exit shape) or `inconclusive`. The canary also does not check `login status` first, so an unauthenticated install gives a generic "the isolation run did not complete".
- `binarySha` hashes whatever `resolveBin` returns, which for the npm install is the Node launcher script, not the native binary under `…/vendor/…`; the binding says "binary hash" and is weaker than that. Say so, or hash the vendor binary when it can be found.
- The login hint (`PROVIDER_HINT.codex`, README) does not state the credential store, which §2b-2 asked for; and the stage error for a last-candidate `auth` failure falls into the generic "codex failed twice" message with no sign-in guidance.
- Messages that point at a "Providers panel" that does not exist in the UI (`codex.ts` spawn error); the UI only gets a banner for an in-use provider that is unhealthy. Roles and the canary are API/CLI only, as the plan's "minimal UI" row says. Say so in the README.
- `research` is in the default config as `['claude']` but `validatePairing` refuses any provider for it, so a GET→PUT round trip of the whole role map fails on `research`.
- Plan §3 still lists the Codex key secret route, `src/secrets.ts` and `engine.secrets()` registration as work; none was built (correct). Mark them deferred.
- The 24 h pause ceiling, the hygiene allow-list (`memories/` and `rules/` accepted only while empty) and the `tmp/` scratch homes inside the Conductor home are reasonable; the `memories/` rule will refuse the run after a real Codex writes there, which is fail-closed and documented.
- Nits: README says "task decomposition, task decomposition"; `ProviderDeps.extraEnv` comment; `res.agent` in the retry notes is the lowercase id.
- Still true from last round: the single-choke-point test (E20) is lexical, and `Agents.provider(id)` still hands any module the (now frozen) provider.

## Part 5 — acceptance criteria and test matrix

| Criterion | Status |
| --- | --- |
| §2 Expected State | Mostly met: contract (derived capabilities, sealed registry), roles and router, config v4, Codex read-only with a private home, canary, records, API, minimal UI. Not met as written: the uniform `detect/auth/selfTest` interface |
| AC3 | **Partial** (B4) |
| AC4 | **Partial**: pairings rejected with a reason (API + routing tests), fallback never promotes an unverified builder (unit + engine tests, mutants killed); complexity and fallback order engine tests missing (B4) |
| AC11, Codex part | **Met in design and tests against the stand-in**: never `danger-full-access`/`workspace-write` (argv absence test), flags pinned, secrets never in argv (stdin) or logs (redaction), no new network listener (the canary's loopback listener is test-time and only on explicit confirm). Cannot be called verified: no real binary, B3, the schema risk |
| M2 AC (a) extraction is behaviour-preserving | Met (unchanged tests, byte-identical Claude/Cursor runners) |
| M2 AC (b) Claude argv unchanged | Met (`agents.test.ts` asserts `buildClaudeArgs`; the runner file is untouched) |
| M2 AC (c) live Cursor suites | Evidenced by two saved logs (3/3 each); not re-run by me |
| M2 AC (d) shared contract suite | **Not met** (B4) |
| M2 AC (e) Codex argv test | Met |
| M2 AC (f) provider-name leak | Met for the pause comment, notification, history and status; the dashboard banner is by code reading only |
| M2 test matrix | Unchanged tests unchanged; migrations exactly as listed; new tests exist for every row except the contract suite |

## Decision

Blocking list
1. Codex health must not wait for the per-home lock; test that `/api/state` is prompt during a Codex stage (B1).
2. Classify a broken-install exec as `spawn`; let the engine refresh stale health itself; engine test (B2).
3. Give the canary control an authenticated run, model authentication in the fake, a way to clear a stale `blocked` (B3).
4. AC3/AC(d)/AC4: deliver or formally descope the uniform provider interface and the shared contract suite; add the two engine tests (B4).
5. Settings back-mapping must not reorder a chain; add the case to the round-trip test (B5).

Decision (M2 code): Changes requested — blocking items 1-5; I will verify by diff and the new tests, no full re-review. Items 1, 2, 3 and 5 are small. Security should note B3 before it reviews the canary, since the canary's pass path has never been exercised against anything that behaves like a real CLI.
