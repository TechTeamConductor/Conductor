# Sub-plan M3 — Plan v2 and task-graph execution

- Parent: `.techteam/plans/workspace-v2.md` (direction for M3, items (a)–(i)). Requirement: `workspace-v2-requirements.md` §4 (Planning Stage Before Execution) and §7 (Automation-First Execution Engine, steps 3, 4, 7, 8, limits).
- Author: TechTeam Lead · Date: 2026-10-20 · Plan status: **rev 2 — Reviewer: Approved with conditions M3-1…M3-6; Security skim: Approved, M3-S1…M3-S5 (all written into §2b, which is BINDING and overrides any earlier sentence)** (rev 1 was pending_reviewer) · Depends on: M1 (native board), M2 (roles, router, envelope) — both committed in the v2 clone.
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

`maxAgentRunsPerIssue` and the 60-iteration job cap become **per graph**: `runsLimit = min(HARD_RUNS=150, maxAgentRunsPerIssue + 6·items)`, `iterationCap = min(HARD_ITERS=400, 60 + 25·items)`; a graph-less run keeps today's numbers. New config (clamped, in `pipeline`): `maxItems` (default 12, range 1–12; 12 is the hard ceiling), `readOnlyParallel` (default 2, range 1–4), `verifyEachItem` (false). Both ceilings are constants — no config can lift them.

### 2.6 Regression ownership

Per-item gates compare against the baseline; a regression introduced by item 2 and only noticed at item 4 fails item 4's gates (it is the first item to see it) and is fixed in item 4's loop (the builder gets the failing gate output and the list of earlier items). A bug found by the final whole-graph verification with a `file` is attributed to the **last item whose commit touched that file** (`git log --format=%H -n1 <baseSha>..HEAD -- <file>` mapped to the item commits); `BugRec.graphItem` is set, the bug card is a child of the parent as today, and the fix build (whole-graph, `debugging` role) names the suspected item in its prompt. Unattributable bugs have no `graphItem`.

### 2.7 Crash recovery

Every state transition is one `RunStore.update` (item state + `startHead` together). On restart, an item found `running`: if `HEAD !== startHead`, the tree is clean and the HEAD commit message carries this item's marker ⇒ **adopt** it as done (as the single-task crash window does); otherwise the partial work is backed up (`backupRefs`), the worktree reset to `startHead`, and the item re-runs with its loop counter preserved. Analysis items re-run (they have no side effects). The `subtasks` effect is idempotent by key (the board's `idemKey`), so a crash between creating a child and marking the effect done adopts the existing child.

**Must remain unchanged:** every M1/M2 safety property (envelope, guards, secret/scope scans, protected-path holds, effects crash protocol, lane projection ownership, authorship); the build, commit, gate, verify and recovery path of a plan without a graph (see §2b-3 for what is and is not claimed); no new executable surface; parallel *builds* are not introduced.

### 2b. Review conditions — BINDING (Reviewer `workspace-v2-m3-m7-plan-review.md`, Security skim `workspace-v2-m5-m7-security-design.md`)

1. **Retry/re-plan in terms of the real triggers (M3-1).** Retry and a move to To do both call `rerunFromHuman`. With `needsHuman.origin = 'build'`: failed and blocked items → `pending` (loop counters reset), `done` items and their commits are kept. With origin `plan`, a card-description edit (`integrity()` ⇒ origin `plan`), a new plan revision, or the "untrusted and never human-approved" rule: the graph is **discarded** and the worktree reset to base (as today). There is no "edit the plan" action. Abort keeps the graph for the record. **Un-parking (a move from Backlog to To do) re-plans, exactly as the single-task path does today, so it discards the graph** (Reviewer wording fix); parking itself changes nothing. A previous revision's subtask cards are **canceled** (lane `canceled`, comment "superseded by plan rev N") when the graph is discarded — never left orphaned in `needs_you`.
2. **Crash adopt is safe (M3-2, M3-S2).** Adoption means only "an item commit exists": exactly one commit between `startHead` and HEAD (parent of HEAD = `startHead`), clean tree, and the commit message carries a **per-attempt nonce** recorded in the run record before the builder started (the planner/builder cannot guess it; an item id alone is never enough); then Conductor **runs `postBuildChecks` and the item's gates before the item becomes `done`** — adopted is not trusted. Anything else ⇒ `backupRefs` + reset to `startHead` and re-run (loop counter preserved). Analysis items are never adopted (they re-run). The existing crash-window block at the top of `stages.build` ("a commit beyond what we recorded ⇒ finished ⇒ verify") is **bypassed for graph runs** (it would otherwise fire after the first item commit). Forge tests: a builder-made commit with another item's marker, with the right marker but a different parent, with two commits, and with a dirty tree — none is adopted unchecked. **Honest limit of the nonce (Security C3-1):** a builder running with `--force` can read `run.json` and so could learn the nonce; the nonce only stops a *guessed or copied* marker. The real guarantee is that scope/secret scans and the item's gates run **before** `done`, and that adoption needs exactly one commit on `startHead` with a clean tree.
3. **What "unchanged" means (M3-3).** `PLAN_SCHEMA` and `prompts/plan.md` change for every plan, so planner input/output can differ. Guaranteed: the build, commit, gate, verify and recovery path for a plan **without a graph** (and a one-item graph is treated as no graph). **Commit 0 is a characterization test written first:** a no-graph and a one-item scenario produce the same event sequence, commit messages, run fields and board comments before and after (fake agents, real git). M3-AC8 ("the pre-M3 test set passes without edits") is necessary, not sufficient.
4. **Item state machine (M3-4).** Stored item states: `pending | running | done | failed | blocked`; **`ready` is derived** (pending with all dependencies `done`). Transitions: `pending→running` (item started; `startHead`+nonce written in the same update) · `running→done` (commit + gates pass) · `running→failed` (loop budget spent, or a hold the item cannot recover from) · `running→pending` (crash reset; a usage-limit pause of the running build item — the attempt is refunded and the loop counter untouched; a retry-once after an agent error) · `failed→pending` (Retry) · `pending→blocked` (a dependency is `failed`/`blocked`; evaluated after every transition) · `blocked→pending` (Retry, once its dependencies are `pending`/`done`) · any→(discarded) on re-plan. Graph `final: pending→verifying→done`. When several analysis items run concurrently and one raises a hold (limit pause, `needs_human`), the run **waits for all of them to settle (`allSettled`) and then makes one transition**; a limit pause refunds only the limited items.
5. **The approval screen shows the graph (M3-5).** `prompts.ts planToMarkdown` renders items, dependencies, files and criteria (it feeds the approval card, the board plan comment and the builder's fenced plan); the plan-review prompt/schema checks the graph (coverage, dependency sanity), not only the flat plan. `planToMarkdown` is in §3.
6. **A real concurrency cap (M3-6).** The engine owns one **agent-call semaphore for analysis-item calls** (`readOnlyParallel`, global, default 2, ≤ 4) shared by all runs; job slots (`maxParallel`) are unchanged. Barrier test: two runs × two analysis items never exceed the cap; build items still never overlap anything of their own run.
7. **Trust classes (Reviewer X-3, Security M3-S1) — the rule for text that reaches a builder.** (i) *Deterministic facts* (M4 scanner output computed at use time): anywhere. (ii) *In-run agent output a human can see on the card* (the approved plan, the verifier summary, bug lists, **analysis-item notes**): allowed in builder prompts only fenced, capped, and with the wording that the approved item objective and file list are the only instructions; item notes are capped (summary ≤ 4 KB, decisions ≤ 10 × 200 characters), posted on the subtask card, and shown on the approval screen only after they exist (post-approval notes are run-local data, not approved text); protected-path, scope and secret scans remain the backstop. (iii) *Persisted cross-run agent text* (M4 summaries, history digests, ask/research results): **never** in a builder prompt. The M4 sentence "LLM text is never placed in a builder prompt" means class (iii).
8. **Bug attribution is safe (M3-S3).** `attributeBug` accepts a model-supplied `file` only if it is a member of `git diff --name-only <baseSha>..HEAD`; the path is passed after `--` with `--literal-pathspecs`; commit ids are 40-hex. A fix commit (whole-graph `debugging` build) maps to the item named in the fix prompt, else no `graphItem`.
9. **Strings and limits (M3-S4, M3-S5).** Item ids/titles in commit messages and subtask cards are single-line, control and bidi/format characters stripped, length-capped; a subtask card deleted or moved by a human never makes the projection loop throw or recreate it endlessly. **12 items is the hard v2.0 ceiling** (the config key can only lower it: range 1–12); a build-item prompt has a total size cap (notes included).
10. **Smaller points.** Item `files` are advisory for scope: `postBuildChecks` enforces protected paths (and the union rule), not per-item file lists — "per-item verification" = gates + the final verify. Analysis items call `agents.readOnly` with `stage: 'plan'` (timeouts, turn caps, event labels) and role = the item's role (`requirements`/`architecture`/`context`). `Run.agentRuns` governs budgets; `ItemRun.agentRuns` is informational. The accounting counters follow the single accounting module of M6 (Reviewer X-4).

### 2.8 Measurable acceptance criteria

- **M3-AC1** A plan with a valid graph executes its items in dependency order on one branch with one commit per build item; the card ends `ready` only after the final whole-graph verification passes.
- **M3-AC2** Each invalid-graph class (cycle, unknown dep, self dep, duplicate id, uncovered criterion, unknown criterion, file outside the plan, plan file owned by no item, analysis item with files, `research` role, > 12 items, no build item) is rejected by `validateTaskGraph` with a specific message and goes through the corrective re-ask.
- **M3-AC3** A failing item blocks its dependents, independents continue, the run ends `needs_human` with the exact action, and Retry re-runs only the failed + blocked items (done commits kept).
- **M3-AC4** Crash mid-item: adopt-or-reset behaves as in 2.7 (both branches tested with a real kill-and-restart style harness); no duplicate subtask cards.
- **M3-AC5** Limits scale and are capped (`runsLimit`, `iterationCap`); a graph exceeding its run budget ends `needs_human` with the budget named.
- **M3-AC6** Analysis items overlap in time (barrier test), build items never do.
- **M3-AC7** The union of item files (= plan files) drives the approval/protected-path hold; an item builder touching an unlisted protected path is held exactly as today.
- **M3-AC8** Single-task runs are unchanged where it matters: the pre-M3 engine/safety/security tests pass without edits **and** the characterization test of §2b-3 (written first) passes unchanged.
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
| `src/pipeline/prompts.ts` (`planToMarkdown`), `prompts/plan-review.md` | Modify | render the graph on the approval screen; plan review checks it |
| `src/pipeline/view.ts`, `src/server/api.ts` | Modify | graph in detail/summary; `GET /api/items/:key` children already exist |
| `prompts/plan.md`, `prompts/build-item.md` (new), `prompts/item-analysis.md` (new), `prompts/fix.md` | Modify/Create | decomposition guidance; item-scoped build/analysis/fix prompts (untrusted text fenced) |
| `ui/app.js` (+ `style.css` minimal) | Modify | "Tasks" panel in the run drawer (items, state chips, dependencies, commits); subtask cards read-only |
| `fixtures/fake-claude.mjs`, `fixtures/fake-agent.mjs` | Modify | scenario support for `taskGraph` plans, analysis item notes, per-item build steps and overlap markers |
| `docs/ARCHITECTURE.md`, `docs/API.md`, `README.md` | Modify | graph model, states, limits, what "ready" means |
| `test/graph.test.ts`, `test/engine-graph.test.ts` | Create | per §5 |

## 4. Implementation TODO

- [x] Reviewer approval of this plan (**before any edit**) — rev 2 approved (`reviews/workspace-v2-m2-fixes-and-plans-rev2-review.md`); Security approved (`…-security.md`).
- [x] **Commit 0 — characterization test (written first, §2b-3):** no-graph and one-item scenarios pin events, commit messages, run fields and board comments.
- [x] **Commit 1 — `graph.ts` + schemas + validation** (pure, fully unit-tested; no behaviour change).
- [x] **Commit 2 — data model, config keys, board mirror (`subtasks` effect), lane projection, API/view fields** (no execution change yet; graph created at approval only when a plan has ≥ 2 items).
- [x] **Commit 3 — graph-aware build:** ready set, build item through the envelope, item gates/loops, failure/blocked semantics, final verify hand-off, attribution, budgets; crash adopt/reset.
- [x] **Commit 4 — analysis items (concurrent) + prompts + Retry/re-plan matrix + UI Tasks panel + docs.**
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

## 7. Implementation notes (what was built, and where it differs from the text above)

- **Module split.** The graph-aware build lives in `src/pipeline/graph-build.ts` (`GraphBuilder`, behind a narrow `GraphHost` interface); `stages.ts` only delegates (`build()` hands a graph that is still `final:'pending'` to it; the whole-change fix loop after verification and every graph-less plan continue on the unchanged single-task code).
- **Item fix attempts use `prompts/build-item.md`'s own "gate regressions" section**, not `fix.md` with an item block (one template, fewer moving parts). The whole-change fix loop still uses `fix.md`; its bug list names the suspected task.
- **A failed item leaves no commits on the branch.** Its work is backed up (`refs/conductor-v2/<KEY>/prev-N`, `stash-N`) and the branch is reset to `ItemRun.floor` (HEAD before the item's first attempt), so independent items continue on good code. Retry runs the item again from there. (Not stated in the plan text; chosen because otherwise a failed item's regressing commit would fail every later independent item's gates.)
- **A safety hold (`held`: guard, protected paths, git settings) does not fail the item**; the item goes back to `pending` and the whole run waits for a person.
- **Analysis items** use the prompt heading `# Stage: ANALYSIS` (the fakes key their scenarios on it) and the read-only router with the item's role; they run as a *wave* (≤ `readOnlyParallel`, each waiting for a slot of the engine's one `Semaphore`), settle completely, and the run then makes ONE transition (a needs-you hold beats a limit pause). Read-only calls report the hold they want (`callReadOnly(…, {defer:true})` → `{kind:'stop', hold}`); the wave applies it once.
- **Fixture race found and fixed:** the fakes' call counters were not atomic (two concurrent invocations could read the same index); they now claim an index with `mkdir`.
- **Tests:** `engine-single-task` (characterization), `graph` (pure rules), `engine-graph-mirror` (data model + cards), `engine-graph` (execution, failure/Retry, crash adopt/forge/reset, budgets, holds, analysis notes, attribution), `engine-graph-parallel` (cap, exclusivity, wave holds, `Semaphore`). Every safety rule has a mutant that fails a test (nonce, parent/count, dirty tree, scope check on adopt, reset-on-fail, cap, hold priority, deferred holds).
- **Not run:** a real multi-item graph against the live CLIs (opt-in, uses quota).
