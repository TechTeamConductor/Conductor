# Implementation plan — M8-4 Run mode: "Per settings | Complete auto" (F6)

- Task: brief F6 (`.techteam/briefs/product-layer.md` §3 F6, §0.4, §6 Q1/Q6, §7 "Run mode", Decisions), slice 4 of M8 (`workspace-v2-m8.md`). UI half is already planned in M8-U (`workspace-v2-m8-u.md` §2.3/§2.4: feature-detects `settings.runMode`).
- Author: TechTeam Backend (planner) for TechTeam Lead
- Date: 2026-10-21
- Plan status: **approved (Reviewer: Approved with conditions, B1–B3 folded in)** (`.techteam/reviews/workspace-v2-m8-4-plan-review.md`).
  - **§2b is BINDING** and wins wherever an earlier sentence differs.
  - Security design is **not needed before the first edit** of commits 1–2 (justified in §6; Reviewer N10 agrees).
  - The Security **code** checkpoint covers commits 1–3 explicitly (N10).
- User decisions (2026-10-21): build the "Approve waiting plans" button (commit 3 stays); run mode is global.
- Depends on: **M8-3** (`src/accounts/limit-rule.ts`, `cfg.pipeline.limitRule`). This is a hard gate per §2b B2: commit 1 may land earlier; the C1 branch and `PUT /api/run-mode` come only after M8-3.
- User decisions used:
  - Q6: one global switch (decided).
  - Q1: leave waiting plans, and build "Approve waiting plans" (decided, §2.6 option B).
  - Q2: brief-derived cards are untrusted (decided; T2 + B3).

## 1. Current State (verified against the clone at `8eaab46`, 2026-10-21)

- **One approval decision.** `decideApproval(i: ApprovalInput)` (`src/policy/policy.ts:35-48`) is pure: forced holds come from `plan.complexity === 'L'` and `i.forced.{protectedPaths, untrusted, bigGraph}` and set `forcedHold = true`. On top of those, a policy can add holds: `approve-plan`/`manual-stages` (every plan), `approve-risky` (risk hits), `firstPlanHold`. `auto = reasons.length === 0`.
- **Effective policy.** `effectivePolicy(cfg, projectKey)` (`policy.ts:10-15`) picks the project's `cfg.projects[KEY].policy`, else the legacy `pipeline.planApproval === 'manual'` (→ `approve-plan`), else `cfg.pipeline.policy` (default `full-auto`).
- **The only call site** is `StageRunner.approvalGate` (`src/pipeline/stages.ts:708-748`). It reads `cfg` fresh on every call (`this.c.cfg()`), computes `touchesProtected` (`W.diffScopeViolations`), `bigGraph` (> `GRAPH_BIG_ITEMS = 8`, `stages.ts:55`), `untrusted: run.untrusted === true`, and `firstPlanHold: cfg.pipeline.planApproval === 'first' && approved === 0` (`stages.ts:721`). When `auto` is true it sets `approvedBy = 'auto'` and `next = 'build'`. Otherwise it sets `status = 'awaiting_approval'` with `holdReasons` and `risks`, plus a card comment. **`decision.forcedHold` is computed but not stored on the run.**
- **Untrusted sources.** `TAINTED_ACTORS = ['import', 'ask-convert', 'research']` (`src/board/types.ts:19`). `Engine.maybeClaim` sets `run.untrusted` from it (`src/pipeline/engine.ts:453`). Migrated v1 pickups get `untrusted` via `src/schema/run-migrations.ts`.
- **Waiting plans are never re-evaluated.** `recover()` (`engine.ts:271-280`) only re-queues `running` runs. An `awaiting_approval` run leaves that state only through:
  - `Engine.approve(key, by, rev?, confirmRisks)` (`engine.ts:820-827`). It is rev-bound, and risks need `confirmRisks`.
  - `retry` → `rerunFromHuman` (re-plans, then passes the gate again).
  - abort, park or move.
- **Limit handling today.** There is no explicit rule: the "on limit" behaviour is the provider chain per role. `onClaudeLimit` is a derived compat field (`config.ts:258`, `applySettings` at `config.ts:305-307`). M8-3 replaces it with `cfg.pipeline.limitRule` and a pure `effectiveLimitRule(cfg)` (agreed in §2.1).
- **Settings API.**
  - `GET /api/state` returns `settings: toSettings(cfg)` (`config.ts:251-266`, `api.ts:196`).
  - `PUT /api/settings` (`api.ts:575-580`) is **lenient**: `applySettings` ignores unknown keys (`config.ts:297`).
  - `PUT /api/projects/:key/settings` (`api.ts:417-427`) is strict, and `full-auto` needs `confirmFullAuto: true` (M6-S6).
  - CSRF is checked on every mutation in `src/server/http.ts:294-297`.
- **Live updates.** SSE `state` is `api.live()` (now, quota, engine, runs, cards) and is broadcast on `engine.onChange` (`http.ts:98, 187-201`). `settings` are only in `/api/state`.
- **Config.** `pipeline` is rebuilt from known keys in `normalizeConfig` (`config.ts:133-160`), so an unknown pipeline key is dropped on load. Version 5 today; M8-2 claims v6 and M8-3 claims v7.
- **Design reference** (`.techteam/design/v16/Main.dc.html`, behaviour only):
  - `setAutoMode` (lines 2094-2101): no-op when unchanged; counts `awaiting_approval` runs; toast wording on and off.
  - `afterPlan` (line 1975): `need = r.force || (!autoMode && …)`.
  - `policy()` (line 1998): `autoMode ? 'switch' : onLimit`.
  - Settings disable `planApproval` and the limit select under auto (lines 1084, 1188), with `paHint`/`polHint` (lines 2768-2771).
  - Board header radio pair `runModes` (lines 2532-2535).
- **Gap:** no run mode exists anywhere.

## 2. Expected State

One global switch, `pipeline.runMode: 'per-settings' | 'complete-auto'` (default `per-settings`). It is an **overlay**: it changes the *effective* policy and the *effective* limit rule that are read at decision time, and **writes nothing else**.

| | Per settings (default) | Complete auto |
| --- | --- | --- |
| Effective approval policy (every project) | stored: project → legacy `planApproval:manual` → global | **`full-auto`** |
| `firstPlanHold` (legacy `planApproval: first`) | as stored | **off** (not a forced hold) |
| Risk-rule holds (`approve-risky`) | as stored | **off** (only forced holds stop — brief F6) |
| Forced holds: complexity L, protected paths, untrusted source (`TAINTED_ACTORS`, migrated pickups, **M8-6 brief-derived cards**), graph > 8 | stop | **stop (unchanged)** |
| Effective limit rule | stored `pipeline.limitRule` (M8-3) | **`switch`** ("next account, then another tool") |
| Stored per-project / global policy, `planApproval`, `limitRule` | unchanged | **unchanged** (never written by the toggle) |
| Plans already `awaiting_approval` | wait | **still wait** (the toggle never approves them) |
| Plan review (`planReview`), loops, parallel, timeouts, budgets, asks/research caps | as stored | as stored (not overridden) |

### 2.1 Contracts (agreed with peers; binding for implementation)

**C1. Limit rule (agreed with M8-3, `abc732b6677fdd931`, 2026-10-21).**
- M8-3 creates `src/accounts/limit-rule.ts` with `export type LimitRule = 'switch' | 'same' | 'wait'` and the pure `export function effectiveLimitRule(cfg: Config): LimitRule`. In M8-3 it returns `cfg.pipeline.limitRule`.
- Stored field: `cfg.pipeline.limitRule: LimitRule`, default `'switch'`. Its migration reproduces today's chain-walk.
- **M8-4 owns one edit in that function**, as its first line: `if (cfg.pipeline.runMode === 'complete-auto') return 'switch';`. M8-4 also owns that branch's test.
- The engine, the router callers and the API call **only** `effectiveLimitRule`. Nothing else reads `pipeline.limitRule`, except the settings view and the edit of the stored value (`toSettings`, `applySettings`, the migration). A static test enforces this (T9).
- Settings view: `settings.limitRule` (stored) and `settings.limitRuleEffective`. `PUT /api/settings` accepts `limitRule` (M8-3).

**C2. Approval overlay (owned by M8-4).** In `src/policy/policy.ts`:
- `storedPolicy(cfg, projectKey): Policy` is today's body of `effectivePolicy`, renamed and unchanged.
- `effectivePolicy(cfg, projectKey): Policy` = `isCompleteAuto(cfg) ? 'full-auto' : storedPolicy(cfg, projectKey)`. The name is kept, so the only call site keeps working.
- `effectiveFirstPlanHold(cfg, approvedCount): boolean` = `!isCompleteAuto(cfg) && cfg.pipeline.planApproval === 'first' && approvedCount === 0`. It replaces the inline expression at `stages.ts:721`.
- `isCompleteAuto(cfg) = cfg.pipeline.runMode === 'complete-auto'`. **Exact equality only**: any other value, including a missing field, means Per settings, the safe side.
- **`decideApproval` is not modified.** The overlay only changes its `policy` and `firstPlanHold` inputs. `forced` and `plan.complexity` are computed exactly as today, so forced holds cannot be touched by the mode. This is the core safety argument; T1 proves it.

**C3. Config field.** `Config.pipeline.runMode: 'per-settings' | 'complete-auto'`.
- `normalizeConfig` uses `oneOf(pl.runMode, ['per-settings', 'complete-auto'], 'per-settings')`; `defaultConfig` sets `'per-settings'`.
- **No config version of its own.** The field is additive, and missing means `per-settings`. An older build that drops it falls back to Per settings, which is fail-safe.
- If the Reviewer prefers a bump, M8-4 takes the number after M8-3's v7, with an identity migration that adds `runMode: 'per-settings'`.

**C4. UI contract** (M8-U feature-detects `settings.runMode`; these are the only new names).
- `settings.runMode`.
- `settings.overriddenByRunMode: Array<'planApproval' | 'policy' | 'limitRule'>`: empty under Per settings, all three under Complete auto. The UI disables those controls and shows the explanation. The wording comes from the design (`paHint`/`polHint`/`modeHint`, Main.dc.html 2767-2771) and lives in the UI.
- `settings.limitRuleEffective` (C1).
- `engine.runMode` in the live SSE `state`, so a second tab's board header follows.
- `card/run.forcedHold: boolean` (only meaningful while `awaiting_approval`; §2.6).
- **Write endpoint** `PUT /api/run-mode` (§2.3).

### 2.2 Engine behaviour

- `approvalGate` calls `effectivePolicy(cfg, project)` and `effectiveFirstPlanHold(cfg, approved)` (the C2 functions) and nothing else changes.
- When the decision is `auto` and Complete auto made the difference (`storedPolicy` alone would have held, or the stored first-plan rule would have held), the history line reads "Plan approved automatically (Complete auto)". `approvedBy` stays `'auto'`, so the type is unchanged.
- When a run is held, the existing `holdReasons` and comment are written unchanged. **New:** `r.forcedHold = decision.forcedHold` is stored on the run (optional `Run.forcedHold?: boolean`). It is cleared in the auto patch (`stages.ts:727-729`) and, **newly**, in `markApproved` (`stages.ts:1281-1293`). `markApproved` does not clear `holdReasons` today, and that stays as it is: the view hides `holdReasons` outside `awaiting_approval` (N1).
- The toggle takes effect at the **next** decision point:
  - A run that is planning when the mode turns on is decided at its gate under Complete auto.
  - A run already approved is never re-held when the mode turns off.
  - A run already `awaiting_approval` is untouched in both directions (nothing re-evaluates holds; `recover()` ignores them). This is asserted by T3.
- Retry on a waiting card is a **human** action. It re-plans, and the new plan passes the gate under the current mode (documented; this is not "the toggle approving").
- The limit rule is read through `effectiveLimitRule` at each limit event. A stage that already moved under `switch` finishes where it is when the mode turns off (M8-3 semantics; no interruption).

### 2.3 API — `PUT /api/run-mode` (strict, CSRF)

- **Body checks:**
  - The body must be a plain object. Only the own keys `runMode` and `confirm` are allowed; any other key, including `__proto__` and `constructor`, ⇒ 400 `bad_request`.
  - `runMode` must be `'per-settings'` or `'complete-auto'`, else 400.
  - `confirm` is required as `true` **only** when switching *to* `complete-auto` from Per settings. Without it: 400 `confirm_required`, with the static message "Complete auto approves and builds plans without asking you and moves work to the next account or tool at a usage limit. Large changes, protected files and cards from unverified sources (imports, Ask and research results, designed work) still wait for you. Send "confirm": true." This mirrors M6-S6 `confirmFullAuto`. The UI's switch click is the confirmation and always sends it.
- **Same mode** ⇒ 200 `{ ok: true, runMode, changed: false, waiting }`. Nothing is written, and the call is idempotent like the design's `setAutoMode` no-op.
- **Change** ⇒ the handler writes `cfg.pipeline.runMode` and only that field, then calls `saveConfig`, `engine.invalidate()` and the engine change notification (so SSE `state` carries `engine.runMode`). It logs one line: `run mode: per-settings → complete-auto (waiting: N)`. That line holds counts only, no titles or keys.
- **Response:** `{ ok: true, runMode, changed: true, waiting: { total, bulkApprovable }, settings }`.
  - `total` = runs with `status === 'awaiting_approval'`. The toast uses it: "N plans already waiting still need you."
  - `bulkApprovable` = how many of those §2.6 would accept.
- **`PUT /api/settings` with a `runMode` key** ⇒ 400 "Change the run mode with PUT /api/run-mode." There is one writer. Without that check `applySettings` would silently ignore the key, which is a confusing no-op. All other keys behave exactly as today.
- **Static test (T8):** only the `PUT /api/run-mode` handler assigns `pipeline.runMode`. This is the M6-S6 pattern.

### 2.4 Settings view

`toSettings(cfg)` adds `runMode` and `overriddenByRunMode` (C4); M8-3 adds `limitRule` and `limitRuleEffective`. Stored values are always reported as stored. **The view never substitutes the effective value into a stored field**, so the UI shows "your choice" and "what applies now" separately.

### 2.5 What must remain unchanged

- `decideApproval`, `riskHits`, the forced-hold inputs, `Engine.approve` (rev binding, `confirmRisks`), `recover()`, the envelope and isolation gates, builders' power, and the per-project settings API and its `confirmFullAuto`.
- With `runMode` absent or `per-settings`, every decision is byte-identical to today. The existing `test/policy.test.ts` and `test/engine-policy.test.ts` stay green unmodified.
- Safety invariants (brief §0.4, `CLAUDE.md`): loopback + cookie + CSRF, forced holds cannot be removed by any setting or mode, zero runtime deps, `npm test` green, `npm run check` clean.

### 2.6 Q1 — waiting plans and the optional "Approve waiting plans" button (evaluation)

| Option | Behaviour | Risk | Verdict |
| --- | --- | --- | --- |
| A. Leave only (decided default) | toggle never touches waiting plans; toast "N still need you"; user approves card by card | none new | **Required** (in every option) |
| B. A + bulk button limited to **non-forced, no-risk** holds, explicit per run | user sees the listed cards and confirms; each run approved as `human`, rev-bound | small: a bulk human action; bounded by server re-checks | **Recommended**, as separable commit 3 |
| C. Toggle auto-approves waiting non-forced plans | — | violates F6 "never approves already-waiting plans" | Rejected |

Option B, if the user keeps it (reversible; commit 3 can be dropped without touching commits 1–2):

- **Endpoint** `POST /api/runs/approve-waiting`, strict, CSRF.
  - Body: `{ runs: [{ key, rev }], confirm: true }` with 1–50 entries. Each `key` matches `KEY_RE` and each `rev` is a positive integer. There are no other keys, and keys must be unique. Wrong shape ⇒ 400; missing `confirm` ⇒ 400 `confirm_required`.
  - The client sends exactly the runs it showed the user. **The server never expands "all".**
- **Per-run checks, in order (fail-closed):**
  1. The run exists and its status is `awaiting_approval`.
  2. `rev === run.rev`, else skip `stale`.
  3. `run.forcedHold === false`. `undefined` (a run held before this slice) counts as forced, so skip `forced`.
  4. `run.untrusted !== true` (belt and braces), else skip `forced`.
  5. `run.risks` is empty; risky plans keep the per-card "I understand" confirmation, so skip `risky`.
  - Then `engine.approve(key, 'human', rev, false)`.
- **Response:** `{ approved: string[], skipped: [{ key, reason: 'stale'|'forced'|'risky'|'not_waiting'|'missing' }] }` → 200. Partial success is normal and reported per run.
- **Not tied to the mode.** The button is a human approval in either mode. The UI (M8-U/M8-5) offers it in the Complete-auto toast/banner when `waiting.bulkApprovable > 0`.
- **View:** `forcedHold` is exposed on the card/run view (C4) so the UI can list the eligible cards.

### 2.7 Measurable acceptance criteria

1. **AC1 Forced holds survive Complete auto (matrix).** Generated over:
   - every stored policy in `POLICIES`;
   - legacy `planApproval` ∈ {auto, manual, first};
   - first-plan count 0 / 1;
   - each forced cause alone: complexity L, protected path, untrusted, graph > 8;
   - and each combined with a risk hit.

   Under `complete-auto`, the decision is `auto: false` and `forcedHold: true` with the same `reasons` as under `full-auto`. Without a forced cause it is `auto: true`, including risky plans and `firstPlanHold`.
2. **AC2 Engine level:** under Complete auto,
   - an untrusted card from **each actor in `TAINTED_ACTORS`** still stops at `awaiting_approval` with `forcedHold: true` (the loop picks up M8-6's `design` actor automatically);
   - so do an L plan, a protected-path plan and a 9-item graph;
   - a harmless plan under stored `approve-plan` builds without a click;
   - a risky plan under stored `approve-risky` builds.
3. **AC3 Stored settings are never written:** toggling on and off leaves `cfg.projects[*].policy`, `pipeline.policy`, `pipeline.planApproval` and `pipeline.limitRule` byte-identical, compared on the saved `config.json`. Only `pipeline.runMode` differs.
4. **AC4 Waiting plans are never approved by the toggle:** with N runs `awaiting_approval` (forced and non-forced), toggling on, then calling `engine.tick()`/`settle()` and restarting via `recover()`, leaves all N `awaiting_approval` with the same `rev`, `holdReasons` and no `approvedBy`. The response reports `waiting.total === N`.
5. **AC5 Limit rule:** `effectiveLimitRule` returns `switch` under Complete auto for every stored rule, and the stored rule otherwise. An engine limit event under stored `wait` + Complete auto moves to the next account/tool (M8-3 harness), and under Per settings it waits.
6. **AC6 Strict CSRF API:** `PUT /api/run-mode` returns:
   - 403 without the CSRF header;
   - 400 for unknown keys, `__proto__`, a non-object, a bad value, or turning on without `confirm`;
   - 200 with `changed: false` for the same mode;
   - 400 for `PUT /api/settings` with `runMode`.
7. **AC7 View:** `/api/state.settings` has `runMode`, `overriddenByRunMode` (empty vs three keys), stored `limitRule` and `limitRuleEffective`. SSE `state.engine.runMode` follows a change.
8. **AC8 (if commit 3 is kept)** `approve-waiting` approves only non-forced, no-risk, rev-matching runs that the client listed. Each skip reason is tested. A pre-slice held run (no `forcedHold`) is skipped as forced.
9. **AC9** Per settings is byte-identical: the existing policy/engine-policy tests are unchanged and green. `npm run check` is clean and `npm test` is green.

## 2b. Reviewer conditions — BINDING (`.techteam/reviews/workspace-v2-m8-4-plan-review.md`)

Where §2–§6 differ from this section, this section wins.

**B1. Persist first, then switch memory; a failed save changes nothing.**
- `PUT /api/run-mode` never mutates the live config object. It builds a new one: `next = normalizeConfig({ ...cfg, pipeline: { ...cfg.pipeline, runMode } })`.
- `src/runtime.ts` `save` is reordered to **write to disk first, then swap** `cfgRef.current` (today it swaps first, `runtime.ts:70-73`). This applies to every writer. Ephemeral runtimes keep swapping only.
- If `saveConfig` throws (`assertNotNewer`, failed pre-upgrade backup, disk error):
  - the response is **500** and the effective mode stays unchanged in memory and on disk;
  - there is no log line about a change and no SSE change notification.
- T4 adds: an injected failing `saveConfig` ⇒ 500, `getConfig().pipeline.runMode` unchanged, and a harmless plan under stored `approve-plan` still waits. The same holds in the "off" direction: a failed off leaves Complete auto on in memory and on disk, consistently.

**B2. M8-3 is a hard gate (C1).**
- (a) C1 must appear **verbatim** in M8-3's approved sub-plan:
  - `LimitRule = 'switch' | 'same' | 'wait'`;
  - pure `effectiveLimitRule(cfg)` in `src/accounts/limit-rule.ts`;
  - stored `cfg.pipeline.limitRule` (default `'switch'`);
  - `settings.limitRule` / `settings.limitRuleEffective`;
  - M8-4 owns the first-line `runMode` branch;
  - nothing else reads `pipeline.limitRule` (T9);
  - `switch` = "next account, then another eligible tool" (brief F6/F8).
- (b) Before M8-4's first edit that touches C1, the Lead checks the **landed** names against C1 and records the check in `.techteam/runs/active-run.md`. Any difference ⇒ delta re-review of §2.1 C1, AC5, T5 and T9.
- (c) Shipping rule:
  - **commit 1 (the inert overlay, types, `forcedHold`, B3, N2, B1 runtime reorder) may land before M8-3**, because there is no writer of `runMode` yet;
  - **`PUT /api/run-mode`, the only way to turn the mode on, ships only after the limit-rule branch is in.** Complete auto is both halves (brief F6), and the confirm text promises "next account or tool".

**B3. Every actor is classified; fail closed for actors that do not exist yet.**
- `test/actor-trust.test.ts` holds `const TRUST: Record<Actor, 'trusted' | 'tainted'>`, today:
  - `user`, `conductor`, `user-ask` → `trusted`;
  - `import`, `ask-convert`, `research` → `tainted`.
- A new `Actor` member without an entry fails `npm run check`, because `Record<Actor, …>` requires every key.
- The test asserts that the tainted set **equals** `TAINTED_ACTORS` (`src/board/types.ts:19`), and that the runtime `ACTORS` list (`src/board/validate.ts:8`, newly exported) equals the keys of `TRUST`.
- **M8-6 must classify its `design` actor as `tainted` in this table** in the same change that adds it to `Actor`/`ACTORS`/`TAINTED_ACTORS`. Together with M8-6's own test (every policy × both modes × a `design` card ⇒ held), this closes the loop. Recorded for M8-6 in §6.

**Non-blocking items taken.**
- **N1:** line refs fixed (§1). `forcedHold` is cleared in the auto patch and newly in `markApproved`; `holdReasons` is unchanged (§2.2).
- **N2:**
  - No config bump (C3 stands).
  - The v1 import (`migrate.ts:233`) forces `pipeline.runMode = 'per-settings'`: v1 data is untrusted input (C-3), and a hand-edited file must never arrive with Complete auto on without a `confirm`. Test T12.
- **N3 (commit 3):**
  - (a) Each run's checks and `engine.approve` run **synchronously with no `await` in between**.
  - (b) Distinct history line "Plan approved (you, from the waiting list)". `approvedBy` stays `'human'`.
  - (c) `toSummary` (`view.ts:113`) exposes `forcedHold` and `risky` (boolean: `risks.length > 0`) while `awaiting_approval`, so the UI can list eligible cards from the existing `runs` list without detail calls. The run-mode response also returns `eligible: [{ key, rev, title }]`, with the title redacted as all card text is.
  - (d) `waiting.bulkApprovable` and `eligible` belong to commit 3.
  - (e) No run-store loader or migration defaults `forcedHold` to `false`. Absent means forced; a test loads an old run file and asserts this.
- **N4:** T13 adds non-canonical `runMode` values (missing, `''`, `'Complete-Auto'`, `'complete-auto '`, `true`, `null` ⇒ Per settings), plus a project-level policy next to the global one.
- **N5:** T2 adds stored `planApproval: 'first'` with 0 approved plans ⇒ builds under Complete auto. T3 adds the off direction: a run approved under Complete auto and queued for `build` keeps going after the mode is turned off, never re-held.
- **N6:** AC3 compares the **parsed** `config.json` with `pipeline.runMode` removed. The baseline is taken after one save, so re-normalisation cannot hide a real write or cause flakes.
- **N7:** T9 extended. Outside `config.ts`, `types.ts`, `policy.ts`, `limit-rule.ts`, `migrate.ts` (N2) and the `api.ts` handler/view, nothing reads `runMode` or `isCompleteAuto`. In particular, `stages.ts` never references them, so forced inputs can never become mode-dependent.
- **N8:**
  - `confirm`, when present, must be a boolean. It is not required to turn the mode off.
  - The confirm message lists all four forced holds: large changes, protected files, more than 8 tasks, cards from unverified sources.
  - "Complete auto made the difference" is a pure helper in `policy.ts` (`decidedByRunMode(cfg, input)`: two `decideApproval` calls), so `stages.ts` only gains the call.
- **N9 (UI contract C4):**
  - The UI wording names **all** forced holds and does not copy the design's "Plans from research reports still ask" verbatim.
  - **The run-mode control at the top of Settings writes immediately via `PUT /api/run-mode`**, like the Board header switch. It is not part of the Settings draft, and `PUT /api/settings` returns 400 on `runMode`.
  - `overriddenByRunMode: 'policy'` means the per-project policy controls and the global default policy.
- **N10:** no Security design before commits 1–2. The Security code checkpoint explicitly covers commit 3's new bulk human route into `build`, or Security gives a one-line acknowledgement before commit 3's edit.
- **N11 (optional, taken):** the run-mode change also records `pipeline.runModeChangedAt` (epoch ms, written only by the same handler). The UI may show "Complete auto turned on at 14:02". The log line keeps counts only.

## 3. Files to Be Changed

| File path | Action | Purpose | Required changes | Reason |
| --- | --- | --- | --- | --- |
| `src/types.ts` | Modify | types | `Config.pipeline.runMode` (+ `runModeChangedAt?`, N11); `Settings.runMode`, `Settings.overriddenByRunMode`; `Run.forcedHold?: boolean`; `ApiEngine.runMode`; card/run view `forcedHold` | C3, C4 |
| `src/config.ts` | Modify | default + normalise + view | `defaultConfig().pipeline.runMode = 'per-settings'`; `normalizeConfig` `oneOf(...)`; `toSettings` adds `runMode`, `overriddenByRunMode` (`limitRule*` fields are M8-3's) | C3, §2.4 |
| `src/policy/policy.ts` | Modify | overlay | `isCompleteAuto`, `storedPolicy` (old body), `effectivePolicy` override, `effectiveFirstPlanHold`; `decideApproval` **unchanged** | C2 |
| `src/accounts/limit-rule.ts` | Modify (created by M8-3) | limit overlay | one branch at the top of `effectiveLimitRule` | C1 |
| `src/pipeline/stages.ts` | Modify | gate | `stages.ts:721` → `effectiveFirstPlanHold`; store `r.forcedHold` on hold, clear it on approval; history wording when Complete auto decided | §2.2 |
| `src/pipeline/view.ts` | Modify | view | `forcedHold: run.status === 'awaiting_approval' ? run.forcedHold === true : false` next to `holdReasons` (`view.ts:188`) | C4 |
| `src/server/api.ts` | Modify | API | `PUT /api/run-mode`; reject `runMode` in `PUT /api/settings`; `live().engine.runMode`; (commit 3) `POST /api/runs/approve-waiting` | §2.3, §2.6 |
| `test/run-mode.test.ts` | Create | pure + API | T1, T4, T5, T6, T7, T8, T9 | AC1, AC3, AC5–AC7 |
| `test/engine-run-mode.test.ts` | Create | engine | T2, T3, T10 | AC2, AC4, AC8 |
| `src/runtime.ts` | Modify | persist-then-swap | `save(c)`: `if (!opts.ephemeral) saveConfig(c); cfgRef.current = c;` (B1). This makes every writer fail-safe. | B1 |
| `src/board/validate.ts` | Modify | export | `export const ACTORS` (today module-private at `:8`); no behaviour change | B3 |
| `src/migrate.ts` | Modify | v1 import | force `pipeline.runMode = 'per-settings'` on the imported config (`migrate.ts:233`) | N2 |
| `test/actor-trust.test.ts` | Create | classification | `TRUST: Record<Actor, 'trusted'\|'tainted'>` + cross-checks (T11) | B3 |
| `docs/API.md`, `docs/ARCHITECTURE.md`, `.techteam/runs/active-run.md` | Modify | docs/checkpoint | endpoint, overlay semantics, what Complete auto never does | docs |

No change to: `decideApproval`/`rules.ts`, `engine.ts` (`approve`, `recover`), routing, env, spawn, argv, prompts, `ui/*` (M8-U/M8-5 own the UI).

## 4. Implementation TODO

- [ ] Reviewer approval of this plan, before any edit. Confirm that M8-3's `limit-rule.ts` has landed.
- [ ] **Commit 1 — inert overlay (pure + config).**
  - Types, `defaultConfig`/`normalizeConfig`/`toSettings`, the `policy.ts` overlay (+ the N8 helper), `stages.ts` wiring + `forcedHold`, `view.ts` (summary `forcedHold`/`risky`).
  - B3 actor classification + `ACTORS` export; N2 v1-import guard; B1 runtime save reorder.
  - Tests T1, T2, T3 (driven by setting `runMode` in the harness config), T9, T11, T12, T13.
- [ ] **Commit 2 — after the B2 gate.** The `limit-rule.ts` branch + T5; `PUT /api/run-mode` (B1 build-then-swap); the `PUT /api/settings` refusal; `engine.runMode`; the log line. Tests T4 (incl. B1 failure case), T6, T7, T8. Docs.
- [ ] **Commit 3 (Q1 option B; the user decided to build it)** — `POST /api/runs/approve-waiting` + T10, with the N3 refinements in §2b. The Security code checkpoint covers it explicitly (N10).
- Sequencing per §2b B2:
  - commit 1 may land before M8-3 (inert: no writer of `runMode` exists yet);
  - the C1 branch and commit 2 (`PUT /api/run-mode`) land only after M8-3's `limit-rule.ts` has landed and the Lead has recorded the name check.
- [ ] `npm run check`, `npm test`; checkpoint in `.techteam/runs/active-run.md`; Reviewer code review + Security code checkpoint.

## 5. Testing Strategy

Brief §7 "Run mode" → named tests:

| §7 item | Test | Expected |
| --- | --- | --- |
| forced holds still stop | **T1** `run-mode: matrix — every forced hold stops under Complete auto` (pure, generated over the AC1 dimensions × both modes) | under `complete-auto`: forced ⇒ `auto:false, forcedHold:true`, reasons equal to `full-auto`'s; non-forced ⇒ `auto:true`; under `per-settings` the results equal today's `decideApproval(storedPolicy…)` for every cell |
| forced holds still stop (engine) | **T2** `engine-run-mode: untrusted from every TAINTED_ACTORS actor, L, protected path, graph > 8 still wait; stored approve-plan / approve-risky plans build` | statuses per AC2; `run.forcedHold === true` on the forced ones; history "approved automatically (Complete auto)" on the others |
| stored policy unchanged | **T3** `engine-run-mode: toggling never writes stored settings and never approves waiting plans` | AC3 (saved `config.json` diff = `runMode` only) + AC4 (N waiting stay waiting across toggle on/off, tick and `recover()`) |
| strict CSRF API | **T4** `run-mode API: strict body, confirm to turn on, CSRF, idempotent, PUT /api/settings refuses runMode` | AC6 status codes; `waiting.total` counts |
| limit rule | **T5** `effectiveLimitRule: complete-auto ⇒ switch for every stored rule` (+ one engine limit case with the M8-3 harness) | AC5 |
| view | **T6** `/api/state settings: runMode, overriddenByRunMode, limitRule vs limitRuleEffective` | AC7 |
| live | **T7** `SSE state carries engine.runMode after PUT /api/run-mode` | AC7 |
| one writer | **T8** static: in `src/`, only the `PUT /api/run-mode` handler assigns `pipeline.runMode` (grep of `runMode\s*[:=]` outside `config.ts` defaults/normalise, types and that handler) | no other writer |
| overlay is the only path | **T9** static: `stages.ts` has no direct `cfg.pipeline.planApproval`/`cfg.pipeline.policy` read; no file except `config.ts`, `limit-rule.ts` and the settings/migration code reads `pipeline.limitRule` (C1) | holds |
| B3 every actor classified | **T11** `actor-trust: every Actor is classified; tainted set === TAINTED_ACTORS; ACTORS === keys(TRUST)` | an unclassified actor fails `npm run check` (Record type) and the test |
| N2 v1 import | **T12** `migrate: a v1 config carrying runMode: complete-auto imports as per-settings` | `per-settings` |
| N4 exact equality | **T13** `runMode values missing, '', 'Complete-Auto', 'complete-auto ', true, null ⇒ Per settings` (pure, project-level and global policy) | identical to Per settings |
| Q1 option B | **T10** `approve-waiting: only listed, non-forced, no-risk, rev-matching runs` | AC8, each skip reason |

- **Regression:** `test/policy.test.ts` and `test/engine-policy.test.ts` stay unmodified and green, which proves Per settings is unchanged. The `engine-board.test.ts` untrusted import test is unchanged.
- **Untrusted cards in tests:** use the existing pattern (`test/engine-board.test.ts:177`, a card created by a tainted actor). T2 loops over `TAINTED_ACTORS` instead of hard-coding the three actors.
- **Authn/authz:** the dashboard has one user (loopback + cookie + CSRF). The negative tests are no CSRF ⇒ 403 and no cookie ⇒ 401 (the existing middleware, asserted once in T4).
- **Build:** `npm run check` (tsc, erasable syntax only), `npm test` (fake agents, no network or quota). No live test.

## 6. Risks and Dependencies

- **Security design — not needed before the first edit.** The brief §0.2 requires a design sign-off for slices touching isolation, credentials, model discovery or model-written text. This slice touches none of them:
  - no spawn, argv, env, credential, file path or model output;
  - it only changes **who clicks**, by selecting a policy value (`full-auto`) that is already a valid, Security-reviewed per-project policy since M6;
  - it selects a limit rule (`switch`) that M8-3 defines and Security reviews there.

  What makes it safe:
  - forced holds are computed outside the overlay and `decideApproval` is untouched (T1/T2);
  - the switch sits behind CSRF plus an explicit `confirm` (as `confirmFullAuto`);
  - waiting plans are never approved by the toggle (T3);
  - stored settings are never written (T3).

  The Security **code** checkpoint after implementation stays (`CLAUDE.md`: every milestone). It should look at the `approve-waiting` endpoint if commit 3 is kept.
- **Broadened blast radius:** one switch makes every project `full-auto`, including projects whose owner picked `approve-plan`, and risk-rule holds stop applying. This is what the brief asks for. Mitigations:
  - the confirm message names it;
  - the Settings fields show "overridden";
  - the history line says why a plan ran without a click.
- **Dependency on M8-3:** this is a hard gate; see §2b B2.
- **Config versions:** M8-2 is on v6 and M8-3 on v7. M8-4 does not bump (C3). The downgrade direction is fail-safe: an older build drops the field and runs Per settings.
- **`manual-stages`:** it is not implemented (it behaves like `approve-plan`, M6 §8). Complete auto overrides it like any other policy; no change there.
- **M8-6 cards (confirmed by M8-6, `ab2e0292471932d82`, 2026-10-21):**
  - M8-6 adds a new server-only actor `design` to `Actor`, `ACTORS` (`board/validate.ts`) and `TAINTED_ACTORS` (`board/types.ts`), with `BOARD_SCHEMA_VERSION` 2 → 3.
  - `maybeClaim` therefore sets `run.untrusted`, and `decideApproval` receives `forced.untrusted = true`.
  - T2 iterates `TAINTED_ACTORS`, so it covers `design` cards automatically once M8-6 lands. M8-6 also adds its own test: every policy × both run modes × a `design` card ⇒ held.
  - Research "Turn into an engineering plan" cards keep the `research` actor.
  - **Binding (B3):** M8-6 also adds `design: 'tainted'` to `TRUST` in `test/actor-trust.test.ts`; otherwise `npm run check` fails.
- **Q1 is decided by the user (2026-10-21): build the button**, so commit 3 is in scope.
- **Open user questions:**
  - Should turning Complete auto **on** from the Board header ask for one confirmation click (a dialog), or is the labelled switch plus toast enough? The API requires `confirm: true` either way. Recommendation: no dialog, as in the design; the toast states what changed.

## 7. Requirement Coverage Matrix

| Requirement | Planned change | Verification | Status |
| --- | --- | --- | --- |
| F6 one global switch (Q6) | `pipeline.runMode` (C3) | T4, T6 | Covered |
| Complete auto ⇒ effective policy `full-auto`, only forced holds stop | `effectivePolicy` + `effectiveFirstPlanHold` overlay (C2) | T1, T2 | Covered |
| Complete auto ⇒ limit rule "next account, then another tool" | `effectiveLimitRule` branch (C1) | T5 | Covered (after M8-3) |
| Never overwrites stored per-project / global policy | the toggle writes only `runMode`; one writer | T3, T8 | Covered |
| Never removes forced holds (L, protected, untrusted incl. brief- and research-derived, graph > 8) | `decideApproval` untouched; forced inputs computed outside the overlay | T1 matrix, T2 per actor | Covered |
| Never approves already-waiting plans; toast says how many still wait | no re-evaluation; `waiting.total` in the response | T3, T4 | Covered |
| Optional "Approve waiting plans" (Q1) | `POST /api/runs/approve-waiting`, non-forced, no-risk, rev-bound, per run | T10 | Covered if kept (user question) |
| Overridden Settings fields disabled with explanation | `settings.overriddenByRunMode`; wording + disabling in M8-U/M8-5 | T6 (API); UI checks in M8-5 | Covered (API) / UI in M8-U |
| Strict CSRF API | `PUT /api/run-mode` strict + confirm | T4 | Covered |
| Untrusted for future actors (Q2) | B3 exhaustive `TRUST` classification | T11 (+ `npm run check`) | Covered |
| A failed save never switches the mode | B1 persist-then-swap | T4 failure case | Covered |
| Per settings unchanged | overlay is a no-op unless the value is exactly `complete-auto` | existing policy tests unmodified, T1 per-settings half | Covered |
