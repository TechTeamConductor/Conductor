# Code review: M8-1 model discovery (F7a)

- Reviewed by: Reviewer, independently. I edited no source.
- Reviewed at: 2026-10-21. Uncommitted working tree on top of `8eaab46`.
- Scope:
  - code: `src/models/**` (sanitize, types, workdir, claude, cursor, cursor-families, codex, cache, service), `src/agents/spawn.ts`, `src/paths.ts`, `src/config.ts`, `src/runtime.ts`, `src/cli.ts`, `src/desktop-sidecar.ts`, and the `/api/models` hunks of `src/server/api.ts`;
  - fixtures: `fixtures/fake-{claude,agent}.mjs` and the new `fixtures/real/*` / `fixtures/codex-model-list.json`;
  - tests: `test/models/**`, `test/spawn-overflow.test.ts`, `test/argv-golden.test.ts`;
  - docs and evidence: the M8-1 hunks of `docs/{API,ARCHITECTURE}.md`, and `.techteam/runs/evidence/m8-1-live.md`.
- Not reviewed (M8-U): `ui/*`, `test/ui-*`, and the `/modes.js` line in `http.ts`.
- Checked against: plan §2b–§2f, the authoritative AC1–AC13 table, the security design conditions (S1–S20, R2-1–R2-5, the W1–W7 ruling), and my three round-2 watch items.

Verdict: Approved

The first pass was approved with one condition (B1). B1 has since landed: see "Follow-up" at the end.

The one condition is B1, a missing positive test for the production startup path. It must land before the M8-1 commit. No code change is required beyond what B1 uncovers.

## What I ran

- `npm run check`: clean.
- `npm test` (full suite): **847 tests, 843 pass, 0 fail, 4 skipped**, exit 0. The builder reported 846 total; the extra test is presumably M8-U's.
- M8-1 subset (`test/models/**`, `spawn-overflow`, `argv-golden`): 109 of 109 pass, in about 5 s.
- I ran no real CLI.

## Watch items from round 2

| Watch item | Result | Evidence |
| --- | --- | --- |
| The spawn counter is exercised by real boots | **Holds** | `test/models/no-real-cli.test.ts` builds a runtime exactly like `setup-wizard.test.ts` (default config, so the REAL `claude`/`agent` bins, and injected health). It then calls `/api/state`, `/api/providers`, `engine.freshHealth()` ×5, `warmUp()` and `GET /api/models`, and asserts `counters` = `{spawns:0, refusedInTest:0, refreshes:0}`. A manual refresh is then refused inside the test context (`refusedInTest:2`, `spawns:0`). The demo boot (`startDemo`) gets the same check, and a service without an injected spawn never runs the fake (no `calls.jsonl`). |
| No ESM spying | **Holds** | Every count goes through the injected `spawn` dependency (`test/models/helpers.ts` `buildService`) or `ModelService.counters`. No test reassigns a module export. |
| A hung discovery never blocks `view()` or GET | **Holds** | `view()` reads memory only once the service is constructed (`service.ts`; the default-account caches are read in the constructor). `POST /api/models/refresh` starts refreshes with `void svc.refresh(...)` and never awaits them. Tests: `api.test.ts:136` (hung Claude: POST and GET each answer in under 1 s with `refreshing: true`; a Cursor refresh queued behind it still leaves GET instant; the end state is `stale` with the timeout reason), `spawn.test.ts:191` (`view()` under 50 ms during a hang, `reading`, then killed), and `service.test.ts:40` (deleting the cache folder does not change `view()`). |

## Conformance with the plan

- **Argv and stdin (B5a, S6):** `CLAUDE_DISCOVERY_ARGS` is frozen. `--no-session-persistence` is mandatory. The only stdin is `CLAUDE_INIT_LINE`, with no `--model` and no prompt (`spawn.test.ts:21`). The Cursor argv is `['--list-models']`. Stage argv is untouched, and `argv-golden.test.ts` pins all three builders with the default config.
- **S1 tripwire:** `isTurnEvent` covers `assistant|user|result|stream_event|rate_limit_event` and `system/init`. On a hit it aborts, returns `turn` and caches nothing. The child is killed as soon as the matching `control_response` is parsed (`spawn.test.ts:49/59`).
- **S2 / S3 / B5b (no reply text or identity leaks):**
  - Only `response.response.models` and `.account` are read; `stdoutTail` is never used.
  - The reason text comes from stderr only, through `scrubIdentity`: `redact` with this refresh's email and organisation, an exact match for short strings, an email-shape scrub and a path scrub, capped at 200.
  - The Cursor reasons are fixed text.
  - `identity.test.ts` checks the decoy commands, agents, email, organisation, tokenSource and userID, plus an email on stderr. None appear in the cache, the API, the log, the reason or the CLI `--json` output.
- **S4 / B2 / R2-5 (output size):**
  - `SpawnOpts.maxOutputBytes` counts raw chunk bytes before line splitting, kills the process group and sets `overflow`. When the option is absent, the result has no `overflow` field (`spawn-overflow.test.ts:14`).
  - Both flood shapes are tested: a 5 MB unbroken line and 50,000 short lines.
  - A valid reply that arrived before the cap tripped is discarded (`spawn.test.ts:92`).
  - Lines over 512 KB are cut off in `onLine`.
- **S8 / S9 (parsing and text cleaning):**
  - Fields are read with `own()` and `typeof`, entries are built from literals, and flags are kept only when `=== true`. `__proto__` and `constructor` pollution is tested.
  - `cleanText` drops lone surrogates, applies NFC, turns whitespace controls into spaces, strips `\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}`, and truncates by code point.
  - Ids are checked raw and never repaired.
- **W1–W5 (per-provider id rule):** `modelIdOk(provider, id)` is the single entry point. Only Claude gets the `[a-z0-9]{1,8}` suffix. `CODEX_MODEL_RE` (in `config.ts`) re-exports the narrow base rule. The W5 accept and reject tables are tested.
- **AC1 (Claude fixtures):** signed in 13/0; Conductor env 5/0 with `claude-fable-5-1[1m]` kept; signed out 5/0. The live evidence records the stop condition being hit (4 kept / 1 dropped) and then the user's decision. That is how B5c was meant to work.
- **AC2 (Cursor fixture):** 265/0, `auto` is the one default, NO-ZDR is flagged, zero-width characters appear in labels only. The N10 stale/unavailable rule is tested through the service.
- **AC3 / S17 (Codex):** parser only. The service never resolves the Codex binary, prepares its home or spawns it (`service.test.ts:19`).
- **AC5 / S12 / S12a / C2 (cache):**
  - `O_NOFOLLOW` plus `fstat` on the handle, with owner and 4 MB checks, before reading.
  - `version === 1` is required: a missing version, `0`, `"1"` or `1.5` gets the file quarantined and never served (`cache.test.ts:80`).
  - A newer file is left untouched and the result stays in memory only.
  - At most 3 quarantined copies are kept; a link is removed while its target survives.
  - Provider and account must match the path; a future `fetchedAt` is shown as stale with no age; families are recomputed on read.
- **R2-2 / C1 (working folder):** `workdir.ts` checks `run/` and `run/discovery` with `lstat`, ownership and 0700. It empties the folder without following links, re-checks it, and cleans it again after the child is reaped, logging only the count. One service-wide queue serialises runs, and a test shows they never overlap.
- **S11 (automatic refresh limits):** at most once per (provider, account) per 5 minutes after a failure, and at most once per distinct `cliVersion` per process. A failure never updates `cliVersion`. The 10 s window applies to manual refreshes only. Tested in `backoff.test.ts`, including "repeated failures + 20 health refreshes ⇒ 1 spawn".
- **S13 / S14 (API, CLI and log):**
  - The refresh body is strict: a plain object with `Object.prototype` as prototype, own keys limited to `{provider}`, and a registry id. It returns 202 at once, and a second request inside 10 s returns 202 with the cached view. A missing service returns 501.
  - GET keys are checked against an allow-list, and reasons carry no absolute paths.
  - The log line carries counts only.
- **N6 / R2-N4 (CLI against a running server):** `conductor models --refresh` refuses when `acquireLock` throws `LockHeldError`, and otherwise holds the lock for its own refresh.
- **R2-N1:** `warmUp()` runs after `listen` in `cli.ts start` and in `desktop-sidecar.ts`.
- **Evidence (AC9):** the S5 marker check covers 7 markers; a positive control without the flags fired 4, which shows the setup is live. The S16 Cursor check shows 0 of 7. The `~/.claude.json` and `~/.claude/projects` counts are unchanged. Counts only, and the S7 hygiene test scans the evidence file.

## Builder-reported deviations: rulings

1. **The runtime's default `extraEnv` is `{}`.** Accepted. It matches `Agents`' own default (`src/agents/provider.ts:58`); tests inject their own. See N2 for the demo.
2. **`CursorFamily.ids`.** Accepted. It is derived, recomputed on every read, never stored, and documented in `API.md`. It also directly supports S19 for M8-2 (a composed id must be in the discovered list).
3. **M8-3 seams (`account` parameter, `envFor`, `accountIds`, `forget`).** Accepted, narrowly. They are small, unused in production, reachable from no config or API input, and covered by `service.test.ts:85`. Condition for M8-3, recorded rather than blocking: M8-3's Security design must review `envFor` explicitly. It replaces the env allow-list, so it must return only `claudeEnv`/`cursorEnv` output plus per-account variables.
4. **The Codex parser uses the `model` slug, falling back to `id`.** Accepted. That is the value `--model` takes. The S18 gate must confirm this against a real `generate-json-schema` / `model/list` reply.
5. **New `src/models/workdir.ts`.** Accepted. It is a clean separation of R2-2 and fully tested.
6. **The `MODEL_ID_RE` alias stays narrow.** Accepted, and it is the right call under W1/W3. M8-2 must validate only through `modelIdOk(provider, id)`, never through `MODEL_ID_RE`, or Claude's `[1m]` ids would be wrongly refused (N5).

## Blocking

**B1. The production startup path (real health ⇒ automatic discovery) has no test.**
- `autoDiscovery = !!models && !opts.health` and the `models.startup(...)` call in `readAgents` (`src/runtime.ts`) are the only route by which a real `conductor start` or the desktop app discovers models.
- Every runtime in the suite injects `health` (`no-real-cli.test.ts`, `api.test.ts`, `setup-wizard.test.ts`), so the positive branch never runs.
- The live evidence covers `conductor models --refresh` only, not `start`.
- A regression in that condition, or in the `warmUp` → `readAgents` → `startup` chain, would pass every test, and only the negative guard is pinned today.

Add one test, fakes only, so the rule against real CLIs in the suite still holds:
- `createRuntime` **without** `health`;
- `config.agents.claude.bin` / `cursor.bin` set to `FAKE_CLAUDE` / `FAKE_AGENT` (so the real `agentHealth` runs the fakes' `--version` and `auth status`);
- `models: { spawn: <recording runProcess>, bins, extraEnv: { FAKE_DIR } }`;
- then `rt.warmUp()`, wait until `counters.spawns === 2`, and assert both views are `fresh` and a second `warmUp()` adds no spawn (same version, so S11 holds).

## Non-blocking

- **N1. Corrupt files overwritten silently.** `writeCache` replaces an existing *unparseable* file without quarantining it (`cache.ts`, the `catch { /* corrupt: replaced below */ }` branch). The read path quarantines in the same situation (S12a). Quarantine here too, for consistency.
- **N2. Demo refresh ignores the demo's scenario.** The demo runtime does not pass `FAKE_DIR` to the model service. A manual Refresh in the demo runs the fakes with no scenario, so they print the default recorded lists. Pass `models: { extraEnv: { FAKE_DIR: fakeDir } }` in `src/demo.ts` so the demo follows its own scenario.
- **N3. `close()` does not wait for the child.** `Runtime.close()` calls `models.stop()`, which aborts without waiting for the child to be reaped, so `cleanDiscoveryDir()` can run after `close()` resolves. It is harmless (a missing folder returns 0), but an awaitable `stop()` would make shutdown deterministic.
- **N4. Mislabelled log trigger.** In `conductor models --refresh`, `noteVersion` may start a `startup`/`version` refresh that the manual `refresh` then joins, so the log line says `trigger=startup`. Cosmetic.
- **N5. Forward note for M8-2:** validate only through `modelIdOk` (see deviation 6). M8-2 must also add the W6 argv snapshot (`--model claude-fable-5-1[1m]`).
- **N6. One docs sentence overstates what was measured.** The `ARCHITECTURE.md` "Known footprint" says the stable folder "keeps that to one project entry". The evidence shows **no** entry was added for the discovery folder. State what was measured.
- **N7. Fixed timeout wording.** The Claude timeout reason always says "15 seconds", even when a test injects a shorter `timeoutMs`. That is correct for production; mentioned only so nobody "fixes" the test.

## Unrelated-change check

The M8-1 diff touches only the files in scope. `src/server/http.ts` (`/modes.js`), `ui/*`, `docs/API.md` §"UI behaviour" and the `ui-*` tests belong to M8-U, as the Lead said. I did not review them here. Commit M8-1 and M8-U separately, so this approval does not carry the UI hunks.

## Record

- Next action: the builder adds B1 (and optionally N1, N2, N6). The Lead re-runs `npm run check` and `npm test`, then commits M8-1. Release still needs the **Security code review** to confirm S1–S17; this review does not replace it.

## Follow-up: B1 closed (2026-10-21)

- **B1 is closed** by `test/models/startup.test.ts`, which I read and ran. The test:
  - creates a runtime **without** `health`, with the claude/cursor bins pointing at the fakes and a Codex bin that does not exist;
  - calls `warmUp()`; the real `agentHealth` then leads to `startup()`;
  - sees exactly 2 discovery spawns (Claude and Cursor), both `fresh` with 13 and 265 models;
  - confirms Codex stays `unavailable`;
  - confirms a second `warmUp()` adds no spawn;
  - finds 0 prompts recorded by the fakes.
- I re-ran `npm run check` (clean) and the `test/models/**` tests: 105 of 105 pass. The builder reports the full suite at 857 tests, 853 pass, 0 fail, 4 skipped. The Lead re-runs it before committing.
- The builder also reports N1, N2 and N6 as done, plus Security's L1–L4 (no-follow directory handling, an `atomicWriteFile` write path, Cursor sign-in detected only from stderr or exit status). I did not re-review those changes line by line. The Security code review owns L1–L4 and confirms them.
- Still open, all non-blocking: N3 (await `stop()`), N4 (log trigger label), N5 (M8-2 forward notes), N7 (informational).
