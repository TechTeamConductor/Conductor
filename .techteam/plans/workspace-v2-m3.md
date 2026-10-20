# Sub-plan M3 — Plan v2 and task-graph execution

- Parent: `.techteam/plans/workspace-v2.md` (direction for M3, items (a)–(i)). Requirement: `workspace-v2-requirements.md` §4 (Planning Stage Before Execution) and §7 (Automation-First Execution Engine, steps 3, 4, 7, 8, limits).
- Author: TechTeam Lead · Date: 2026-10-20 · Plan status: **pending_reviewer** (rev 1) · Depends on: M1 (native board), M2 (roles, router, envelope) — both committed in the v2 clone.
- Gate: Reviewer approval before the first source edit. Security review of the code afterwards (the graph touches the build path: per-item commits, protected-path holds, crash recovery). No new executable surface (no new CLI, no new network path).

## 1. Current State (verified in the clone at `bd5f186`)

- **One run = one card = one plan = one build/verify loop.** `Run` (`src/types.ts`) has a single `worktree/branch/baseSha/commitSha/loop/loopBudget/bugs/agentRuns/next`. `engine.runJob` (`engine.ts:571`) loops at most 60 times over `plan → plan_review → build → verify`; `maxAgentRunsPerIssue` (default 10) and the 60-iteration cap are the only budgets and are per card, not per amount of work.
- **The plan is flat** (`PLAN_SCHEMA`, `schemas.ts`): `summary, blocked, assumptions, currentState, expectedState, acceptanceCriteria[], filesToChange[], steps[] (strings), testing, risks, coverage[], complexity S|M|L, deliverable, answer`. `steps` are prose; nothing records dependencies, per-step files/criteria, roles, or parallelism. A large request therefore becomes ONE big builder call and one verification.
- **The board already has a hierarchy** (`board/types.ts`: `parentId`, `dependsOn[]`, `kind: work|subtask|bug`; acyclic, same-project, depth-limited). Only `kind:'work'` cards are claimed (`claimable(kinds=['work'])`); `bug` children are created by the `subissue` effect and moved by the `close` effect (now restricted to the run's own children).
- **Approval/protected-path hold** is computed from `plan.filesToChange` + `complexity === 'L'` (`stages.approvalGate`); the build is scope-checked against the plan's file list for **protected paths only** (`postBuildChecks`).
- **Crash window handling in `stages.build`**: "a commit exists beyond what we recorded ⇒ the build had finished", and leftover uncommitted work is backed up (`backupRefs`) and reset (`resetToCommit`) before a restart.
- **Limitations (what this milestone fixes):** no decomposition; no dependency order; no per-part verification or per-part retry; a failure anywhere restarts the whole card; budgets do not scale with the amount of work; humans see one card, not the plan's structure.

## 2. Expected State

**A plan may carry a validated task graph; a graph of ≥ 2 items is executed item by item, in dependency order, on the run's single worktree/branch (sequential build — decision D1; parallel build is NOT in v2.0 and requirement §7-4 is reported *Partial*), with per-item checks, per-item recovery, graph-scaled limits and a final whole-graph verification. A plan without a graph (or with one item) behaves exactly as today.**

### 2.1 Plan v2 (`taskGraph`)

`PLAN_SCHEMA` gains an optional `taskGraph: { items: PlanItem[] }`:

```ts
PlanItem = { id: 'T1'…, title, role: 'implementation'|'documentation'|'requirements'|'architecture'|'context',  // build-class vs analysis-class
             objective, dependsOn: string[], files: string[],            // files: only for build-class items, ⊆ plan.filesToChange paths
             criteria: string[],                                        // AC ids this item satisfies
             verification: string[], parallelGroup?: string }           // recorded for later parallel work; not used to schedule builds
```

- The planner is told (`prompts/plan.md`) to decompose by complexity: S → no graph; M → 2–6 items; L → up to 12; to give every acceptance criterion an owning item; to keep items independently verifiable; and to put analysis (requirements/architecture/context) before the build items that need it. It is told **not** to invent a template — the items must come from the project.
- **Semantic validation** (`graph.validateTaskGraph`, run with the schema validation; failure = the existing corrective re-ask, then `needs_human`): ≤ 12 items; ids unique `T\d+`; roles from the allowed set (`research` is rejected until M5 provides an isolated profile; `review`/`verification`/`debugging` are Conductor-owned stages, not plan items); every `dependsOn` exists, no self-dependency, **acyclic** (Kahn); **every acceptance-criterion id is claimed by ≥ 1 item and every item criterion exists**; build-class items have ≥ 1 file, each ⊆ `filesToChange`, **and every `filesToChange` path belongs to ≥ 1 build-class item**; analysis items list no files; at least one build-class item. All strings are length-capped and treated as untrusted data (fenced in prompts).
- **Approval/hold:** `approvalGate` already evaluates `filesToChange` (the union by the rule above) + `L`; a graph additionally forces a hold when it has > 8 items or any item touches a protected path (no behaviour change for `full` policies in M6).

### 2.2 Data model

```ts
Run.graph?: { items: ItemRun[]; rev: number; startedAt: number; final: 'pending'|'verifying'|'done' }
ItemRun = { id, key: string|null /*board subtask key*/, title, role, objective, dependsOn[], files[], criteria[], verification[],
            state: 'pending'|'ready'|'running'|'done'|'failed'|'blocked',
            loop, loopBudget, agentRuns, startHead?: string, commitSha?: string, note?: string, notesArtifact?: string }
BugRec.graphItem?: string          // the plan item believed to have introduced the bug (see 2.6)
```

- Additive optional fields: no `run.json` schema bump; `migrateRun*` untouched; a v3 reader ignores them. `graph.rev` ties the graph to the plan revision (a re-plan discards it).
- **Board mirror:** when the plan is **approved**, an idempotent effect `subtasks` creates one `kind:'subtask'` child card per item (`parentId` = the run's card, `dependsOn` mapped to the child ids, `autoStart:false`, `createdBy:'conductor'`), keyed by `(run, plan rev, item id)` so a crash between creation and recording never duplicates. Subtask lanes are a **level-triggered projection** of the item state, owned by Conductor exactly like the parent's: pending/ready → `todo`, running → `active`, done → `done`, failed/blocked → `needs_you`. A human move of a subtask card is overwritten on the next tick (documented; comments are allowed and are not fed to prompts — `board.user` authorship rules unchanged). Subtask cards are never claimed (`kind` ≠ work).

### 2.3 Execution (all inside the existing `build` stage — `Run.next` machine unchanged)

`stages.build(key)` becomes graph-aware: with `run.graph` it executes **one scheduling step per call** and leaves `next = 'build'` until the graph is complete:

1. **Ready set** = items whose dependencies are all `done`. Analysis-class ready items run first, **concurrently** (cap `limits.readOnlyParallel`, default 2, also bounded by the engine's free slots) through the router (`agents.readOnly`, role from the item) with `ITEM_NOTE_SCHEMA {summary, details, decisions[]}`; their output is saved as `item-<id>.json`, posted as a comment on the subtask card (redacted), and fenced as `<item-notes>` into the prompts of dependent items. A deterministic barrier test proves overlap for analysis items and **exclusivity for build items**.
2. Otherwise, **one** build-class ready item (lowest id) runs through the envelope with `prompts/build-item.md` (the approved plan, this item's objective/files/criteria, the notes of finished dependencies, the item list for orientation). Commit message `KEY: <title> — T<n>: <item title>`. `startHead` is recorded **before** the builder starts (in the same write that sets `running`).
3. After an item commit the deterministic **gates** run (existing `runGates` + baseline comparison). Gate regressions → the item loop (`item.loop < item.loopBudget`, default = `cfg.pipeline.maxLoops`) re-runs the builder with the failures (`prompts/fix.md` with the item block). A passing item becomes `done` with its `commitSha`; the item's AI verification is **not** run per item (cost) unless `cfg.pipeline.verifyEachItem` is true (default false; L-complexity graphs may enable it in M6).
4. When every item is `done`, `final='verifying'`, `next='verify'`: the existing verify stage runs over the **whole diff against `baseSha`** with all acceptance criteria. Bugs reported there use the existing bug-card/fix-loop machinery (loop on the parent; `debugging` role; whole-graph fix builds). Verification pass ⇒ `ready` as today.

### 2.4 States and what Retry means

| Graph situation | Run status | Notes |
| --- | --- | --- |
| items pending/running | `running` | board: parent in `active`; subtasks per projection |
| an item failed (loop budget spent) | dependents → `blocked`; **independent items continue**; when nothing else can run the run ends `needs_human` | the card text names the failed item, the reason, and the exact action: "fix it in the worktree or edit the plan, then Retry — T3 and the items that depend on it run again; finished items are kept" |
| all items done, final verify pending/failing | as today (`running` / fix loops / `needs_human` at the loop limit) | |
| all done + verify pass | `ready` | "ready" never means "partially complete": a graph with a failed/blocked item is never `ready` |

- **Retry** (`rerunFromHuman` from `needs_human`, origin `build`): failed and blocked items go back to `pending` (loop counters reset), `done` items and their commits stay; **an edit of the plan or a move to To do = re-plan from scratch** (graph discarded, worktree reset to base as today). `applyHumanMove`'s matrix and the "unapproved untrusted run always re-plans" rule are unchanged.
- **Abort/Cancel** stops the job as today; the graph is kept for the record (items stay as they were).

### 2.5 Limits that scale (requirement §7 "configurable limits")

`maxAgentRunsPerIssue` and the 60-iteration job cap become **per graph**: `runsLimit = min(HARD_RUNS=150, maxAgentRunsPerIssue + 6·items)`, `iterationCap = min(HARD_ITERS=400, 60 + 25·items)`; a graph-less run keeps today's numbers. New config (clamped, in `pipeline`): `maxItems` (default 12, range 1–20), `readOnlyParallel` (default 2, range 1–4), `verifyEachItem` (false). Both ceilings are constants — no config can lift them.

### 2.6 Regression ownership

Per-item gates compare against the baseline; a regression introduced by item 2 and only noticed at item 4 fails item 4's gates (it is the first item to see it) and is fixed in item 4's loop (the builder gets the failing gate output and the list of earlier items). A bug found by the final whole-graph verification with a `file` is attributed to the **last item whose commit touched that file** (`git log --format=%H -n1 <baseSha>..HEAD -- <file>` mapped to the item commits); `BugRec.graphItem` is set, the bug card is a child of the parent as today, and the fix build (whole-graph, `debugging` role) names the suspected item in its prompt. Unattributable bugs have no `graphItem`.

### 2.7 Crash recovery

Every state transition is one `RunStore.update` (item state + `startHead` together). On restart, an item found `running`: if `HEAD !== startHead`, the tree is clean and the HEAD commit message carries this item's marker ⇒ **adopt** it as done (as the single-task crash window does); otherwise the partial work is backed up (`backupRefs`), the worktree reset to `startHead`, and the item re-runs with its loop counter preserved. Analysis items re-run (they have no side effects). The `subtasks` effect is idempotent by key (the board's `idemKey`), so a crash between creating a child and marking the effect done adopts the existing child.

**Must remain unchanged:** every M1/M2 safety property (envelope, guards, secret/scope scans, protected-path holds, effects crash protocol, lane projection ownership, authorship); single-task behaviour byte-for-byte (a plan without `taskGraph`, or with one item, goes through today's code path); no new executable surface; parallel *builds* are not introduced.

### 2.8 Measurable acceptance criteria

- **M3-AC1** A plan with a valid graph executes its items in dependency order on one branch with one commit per build item; the card ends `ready` only after the final whole-graph verification passes.
- **M3-AC2** Each invalid-graph class (cycle, unknown dep, self dep, duplicate id, uncovered criterion, unknown criterion, file outside the plan, plan file owned by no item, analysis item with files, `research` role, > 12 items, no build item) is rejected by `validateTaskGraph` with a specific message and goes through the corrective re-ask.
- **M3-AC3** A failing item blocks its dependents, independents continue, the run ends `needs_human` with the exact action, and Retry re-runs only the failed + blocked items (done commits kept).
- **M3-AC4** Crash mid-item: adopt-or-reset behaves as in 2.7 (both branches tested with a real kill-and-restart style harness); no duplicate subtask cards.
- **M3-AC5** Limits scale and are capped (`runsLimit`, `iterationCap`); a graph exceeding its run budget ends `needs_human` with the budget named.
- **M3-AC6** Analysis items overlap in time (barrier test), build items never do.
- **M3-AC7** The union of item files (= plan files) drives the approval/protected-path hold; an item builder touching an unlisted protected path is held exactly as today.
- **M3-AC8** Single-task runs are unchanged: the entire pre-M3 engine/safety/security test set passes without edits.
- **M3-AC9** The run drawer shows the graph (items, states, dependencies, commits); `GET /api/runs/:key` and `GET /api/items/:key` expose it; subtask cards are Conductor-owned.
- **M3-AC10** Requirement coverage statement: §4 decomposition and dependencies **Covered**; "opportunities for parallel execution" **Recorded (`parallelGroup`, `files`) but builds are sequential — Partial**; §7 steps 3/7/8 **Covered**, step 4 **Partial (read-only items only)**.

## 3. Files to Be Changed

| File | Action | Change |
| --- | --- | --- |
| `src/pipeline/graph.ts` | Create | `PlanItem`/`ItemRun` types helpers, `validateTaskGraph`, `readySet`, `topoOrder`, `graphBudgets`, `attributeBug`, `projectItemLane`, item-marker commit parsing |
| `src/pipeline/schemas.ts` | Modify | `PLAN_SCHEMA.taskGraph`, `ITEM_NOTE_SCHEMA`; plan validation calls `validateTaskGraph` |
| `src/types.ts` | Modify | `Run.graph`, `ItemRun`, `BugRec.graphItem`, `ApiRunDetail.graph`, `ApiRunSummary.graph?` (progress), config `pipeline.{maxItems,readOnlyParallel,verifyEachItem}` |
| `src/config.ts` | Modify | clamp/normalise the three new pipeline keys |
| `src/pipeline/stages.ts` | Modify | graph-aware `build` (ready set, analysis wave, build item through the envelope, item gates/loops, crash adopt/reset), approval hold additions, `verify` attribution, subtask effects wiring; single-task path untouched |
| `src/pipeline/engine.ts` | Modify | per-graph `iterationCap`/`runsLimit`, Retry resets failed/blocked items only, re-plan discards the graph, subtask lane projection in the tick, human subtask moves overwritten |
| `src/pipeline/effects.ts` | Modify | `subtasks` effect (idempotent, own-parent rule), subtask lane/comment effects restricted to the run's children |
| `src/pipeline/view.ts`, `src/server/api.ts` | Modify | graph in detail/summary; `GET /api/items/:key` children already exist |
| `prompts/plan.md`, `prompts/build-item.md` (new), `prompts/item-analysis.md` (new), `prompts/fix.md` | Modify/Create | decomposition guidance; item-scoped build/analysis/fix prompts (untrusted text fenced) |
| `ui/app.js` (+ `style.css` minimal) | Modify | "Tasks" panel in the run drawer (items, state chips, dependencies, commits); subtask cards read-only |
| `fixtures/fake-claude.mjs`, `fixtures/fake-agent.mjs` | Modify | scenario support for `taskGraph` plans, analysis item notes, per-item build steps and overlap markers |
| `docs/ARCHITECTURE.md`, `docs/API.md`, `README.md` | Modify | graph model, states, limits, what "ready" means |
| `test/graph.test.ts`, `test/engine-graph.test.ts` | Create | per §5 |

## 4. Implementation TODO

- [ ] Reviewer approval of this plan (**before any edit**).
- [ ] **Commit 1 — `graph.ts` + schemas + validation** (pure, fully unit-tested; no behaviour change).
- [ ] **Commit 2 — data model, config keys, board mirror (`subtasks` effect), lane projection, API/view fields** (no execution change yet; graph created at approval only when a plan has ≥ 2 items).
- [ ] **Commit 3 — graph-aware build:** ready set, build item through the envelope, item gates/loops, failure/blocked semantics, final verify hand-off, attribution, budgets; crash adopt/reset.
- [ ] **Commit 4 — analysis items (concurrent) + prompts + Retry/re-plan matrix + UI Tasks panel + docs.**
- [ ] Reviewer code review + Security review; checkpoint commit; live check with the real Cursor on a tiny two-item graph (opt-in, quota).

## 5. Testing Strategy (one named test per failure mode)

- **graph.test.ts:** each invalid class in M3-AC2; topological order stability; ready-set evolution; `graphBudgets` scale + ceilings; attribution (last touching item; none); lane projection table; marker parse/forge (an item marker in a builder-written commit message of ANOTHER item is not adopted).
- **engine-graph.test.ts:** happy path 3 items (order, one commit each, ready only after final verify); independent items continue after a failure; dependents blocked; needs_human text + Retry subset; re-plan discards graph; per-item gate regression → item loop → fixed; item loop budget exhausted; budget scaling/cap hit; protected path unlisted in an item builder → held; union hold at approval; analysis overlap barrier + build exclusivity; analysis notes reach the dependent prompt (fenced); crash mid-item: adopt (commit exists, tree clean) and reset (dirty tree) via a harness that stops the engine at a hook; subtask effect idempotency (replay after crash); subtask human move overwritten; single-task regression: the existing suites unchanged; a one-item graph = single task.
- **Static/regression:** `npm run check`; full `npm test`; live Cursor suites unchanged.
- **Not run (stated):** a real multi-item graph against the live CLIs except the opt-in two-item check.

## 6. Risks and Dependencies

- **Planner quality:** a model may emit weak graphs; validation is structural. Mitigation: corrective re-ask, human approval hold for big graphs, and single-task fallback is always valid.
- **Sequential only:** large graphs are slow; the data model records `files/parallelGroup/dependsOn` so a later milestone can add per-item worktrees without a schema change.
- **Crash recovery complexity:** the adopt rule trusts a commit-message marker — guarded by "HEAD ≠ startHead, tree clean, marker present, commit authored by Conductor's identity" and a forge test.
- **Budget interplay with limits:** quota pauses are per provider and unchanged; `agentRuns` refunds on limit hits stay.

## 7. Requirement Coverage Matrix (M3 slice)

| Requirement | Coverage |
| --- | --- |
| §4 plan identifies requirements, modules/files, constraints, steps, tests, risks, dependencies, completion criteria per item | Covered (graph items carry objective/files/criteria/verification/dependsOn) |
| §4 intelligent decomposition by complexity (single task → hierarchy with explicit dependencies and independent verification) | Covered (S none, M 2–6, L ≤ 12; per-item gates, final whole-graph verify) |
| §4 opportunities for parallel execution | **Partial** — recorded, not scheduled for builds (D1) |
| §4 ask only when a decision materially affects the plan; reasonable assumptions | Covered by the existing `blocked.questions` / `assumptions` (unchanged) |
| §7 dependency order; capture outputs/decisions/logs; tests + independent verification; bounded recovery; board updates; limits | Covered (graph runtime, per-item loops, board subtasks, scaled limits) |
| §7 independent tasks in parallel where safe | **Partial** — read-only items concurrently; builds sequential |
| §7 approval modes, sensitive-operation rules | M6 |
