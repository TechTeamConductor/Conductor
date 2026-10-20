# Sub-plan M6 — Automation policy, board experience and onboarding

- Parent: `.techteam/plans/workspace-v2.md` (direction for M6; binding additions M-6/M-7 and decision D5). Requirement: `workspace-v2-requirements.md` §3 (board hierarchy as the user's view), §7 (approval modes, limits, sensitive-operation rules), §8 (guided onboarding, sensible defaults, sample task).
- Author: TechTeam Lead · Date: 2026-10-20 · Plan status: **rev 2 — Reviewer: Changes requested M6-1…M6-6 (applied); Security skim: Approved with conditions M6-S1…M6-S8 (BEFORE-EDIT ones in §2b, which is BINDING and overrides any earlier sentence)** (rev 1 was pending_reviewer) · Depends on: M1–M5 (board, roles/router/Codex, task graph, context, modes).
- Gate: Reviewer approval before the first source edit; Security review of the code afterwards (policies decide when work runs without a human; project creation writes to the user's disk; the sample task spends quota).

## 1. Current State (verified in the clone at `bd5f186`)

- **Approval is a single setting** (`pipeline.planApproval: auto|manual|first`) plus forced holds (`complexity L`, protected paths, `untrusted`). There is no per-project policy, no "approve only risky things", no per-stage manual control, and nothing that scans a plan for destructive or secret-touching steps.
- **Limits** exist as scattered settings: `maxLoops`, `maxParallel`, `maxAgentRunsPerIssue`, per-stage `timeoutsMin`, and the 60-iteration job cap. There is no per-run wall-clock cap, no per-project or per-graph agent-run budget visible to the user, and no single place that shows "what Conductor is allowed to do".
- **Board UI** (`ui/app.js`): one board of run columns plus Backlog/To do cards, a card drawer (overview, plan, verification, sessions, timeline, live log), a 2-step setup wizard (agents → repository). Projects, milestones and decisions exist in the board store and are creatable through the API (`POST /api/projects`), but the UI shows none of the hierarchy (project → milestone → work item → subtasks) and has no project switcher.
- **Onboarding** checks Claude and Cursor and registers an existing repository (`inspectRepo` requires a git repo **with at least one commit** and refuses `/`, the home directory and the Conductor home). There is no "create a project", no Codex step, no role defaults chooser, no initial context analysis (M4), no sample task.
- Everything in the settings panel maps to `stages`/`onClaudeLimit` compat fields; roles are only reachable through the M2 API.

## 2. Expected State

**Users choose how much Conductor does on its own (four policies, per project) within limits they can see; the board shows the real hierarchy; and a first-time user gets from install to "I watched a task run end-to-end" with recommended defaults and no configuration maze.**

### 2.1 Policies (per project; global default)

`policy ∈ full-auto | approve-plan | approve-risky | manual-stages`, stored per project (`config.projects[KEY].policy`, absent ⇒ the global `pipeline.policy`).

**Forced holds** (never removable by any policy or setting — D5): complexity `L`, any protected path, an `untrusted` source (imports, research/ask-convert cards), a graph with more than 8 items. They are the *only* holds `full-auto` keeps.

| Policy | Plan approval | Holds |
| --- | --- | --- |
| `full-auto` (**the default = v1 behaviour**) | automatic | forced holds only |
| `approve-risky` | automatic unless a **risk rule** matches | forced holds + risk rules |
| `approve-plan` | always waits for **Approve plan** | forced holds (moot) |
| `manual-stages` | waits before build **and** before verification (`awaiting_approval` with `holdStage: 'build'|'verify'`; one **Continue** each, bound to `holdStage` + run state — a stale Continue ⇒ 409) | forced holds |

Mapping from the existing settings API field `pipeline.planApproval` (must keep working): `auto` → `full-auto`; `manual` → `approve-plan`; `first` → `full-auto` **plus** the per-repo "first plan waits" rule, which stays as a separate hold flag (`policy.firstPlanHold`) so no behaviour is lost. The four policies are distinct, so the generated sweep test can tell them apart.

- **Risk rules (static, enforceable; apply to STRUCTURED fields only — Reviewer M6-2):** evaluated on `testing.commands[]`, `filesToChange[]` (paths and actions) and graph item files — **not** on prose `steps` (a step reading "update the deployment docs" must not hold a plan): secret-looking files (`.env*`, keys, credentials, `*.pem`); commands in `testing.commands[]` matching destructive/production patterns (`rm -rf`, `git push`, `git reset --hard`, `DROP|TRUNCATE`, `terraform apply|destroy`, `kubectl apply|delete`, `docker push`, `npm publish`, `pip upload`, `curl … | sh`, `aws … delete|rm`); deletes/renames of > 5 files; > 25 files; changes to CI/deploy definitions (`.github/workflows/**`, `Dockerfile`, deploy manifests). A manifest+lockfile change together is **not** a rule (normal). Every rule has negative cases that must not match ("deployment docs", `npm test`, a lockfile-only change, a 3-file change). Protected paths remain a forced hold, not a risk rule. A match produces **named reasons shown on the card** and requires an explicit **"I understand this plan runs …"** confirmation (a boolean in the approve request, server-checked) — never a silent approve. The rule list is code, not config.
- **Sensitive operations (requirement §7):** Conductor cannot intercept a `--force` builder's own shell calls — said plainly in the UI/docs. What it enforces: plan-level rules above, protected-path/secret scans after the build, provider-native deny lists, no deploy/push/publish capability anywhere in Conductor, and the existing never-push guard. Everything else is **not claimed**.
- Policies change **who clicks**, never the envelope or the isolation gates.

### 2.2 Limits (requirement §7 "configurable limits")

One **Limits** section with enforced, clamped values (each with a hard ceiling): retries (`maxLoops`, ≤ 8), parallel runs (`maxParallel`, ≤ 6), time (`timeoutsMin.*` per stage as today **plus** `maxRunMinutes` per run, default 360, ≤ 1440), agent runs (**per-run** `maxAgentRunsPerIssue` as scaled by M3, **per-graph** budget, and a **per-project daily agent-run budget** `projects[KEY].dailyAgentRuns`, default 200, ≤ 2000 — M-6: the "resource usage" limit is a run/token budget, not only time). Reaching a limit ends in `needs_human` (or pause until the next day for the daily budget) naming the limit and how to raise it. No cost limits (plans are included; the user removed cost earlier).

### 2.3 Board experience (hierarchy)

- **Projects bar** (switcher + "New project"), **milestones** (group + progress), **work item tree** (item → subtasks from M3, bug children), filters (status, repo, provider), list/board toggle, a **project page** (context status from M4, policy, limits, recent outcomes), card drawer gains: policy/hold reasons, Tasks (M3), Context used (pack summary: modules/size, never raw text), provider/tier labels (M2) and offline hints (M4). All text via `textContent`/the sanitising renderer; no new HTML sinks.
- Board mutations remain the existing API (`POST /api/projects`, milestones, items, move, comment, edit) + new `PUT /api/projects/:key/settings` (policy, limits; strict, clamped, own-property, CSRF) and `POST /api/projects/:key/milestones`.

### 2.4 Onboarding wizard v2 (recommended defaults first)

Steps: **(1) Environment** — OS/arch, Node/git versions, the three CLIs with `ApiProvider` state + static hints (Codex marked optional/unverified); **(2) Tools** — role defaults from one choice ("Claude plans and verifies, Cursor builds" = the recommended default; advanced = the M2 roles editor, with the unverified-acknowledgement flow); **(3) Project** — *open* an existing repository (as today) **or create** one: `POST /api/setup/project/create { parent, name, identity? }` → validates the target (must not exist or be empty; never `/`, home, or inside the Conductor home; name pattern), `git init -b main`, writes a minimal `README.md`, and makes an **initial commit** with the user-supplied identity or a Conductor-owned one, **set in the NEW repository's local git config** so every later builder commit works with no global identity (M-7, Reviewer M6-4; `inspectRepo` accepts the result) — local and reversible, no remote, no push; a target inside another git work tree is refused; **(4) Analysis** — runs the M4 deterministic scan and shows what it found; **(5) Defaults** — policy `approve-risky`, loops 3, parallel 2 (editable later); **(6) Sample task** — optional: creates a sample repository **outside the Conductor home** (a user-visible folder the user confirms, same rules as project creation — `inspectRepo` refuses any path inside the Conductor home), a tiny Node project with a passing test, registers it as project `SAMPLE` through an **internal-only registration path** that matches one constant directory exactly, and adds a card ("Add a greeting function") that the user can start; **starting it spends the user's plan quota and says so**, uses the recommended roles, and the finished card explains each stage. A user can skip any step; the wizard never blocks a configured user (health stays a banner, as now).
- **Desktop detection** (OS/arch/package type) only informs messages and the M7 shell; it changes no behaviour here.

### 2.5 What must remain unchanged

All M1–M5 safety properties; forced holds (D5) can never be disabled by any policy or setting (a test sweeps every policy × every hold); builders are never given more power by a policy; the importer, the envelope, authorship rules; the existing settings API fields (derived roles compat) keep working; no new runtime dependency; UI changes add no HTML sink and no new inline script.

### 2b. Review conditions — BINDING (Reviewer M6-1…M6-6 + non-blocking; Security M6-S1…M6-S8)

1. **One approval choke point (Security M6-S1, BEFORE-EDIT).** Every route into `build` — graph items (M3), the M5 fast path, Retry, `manual-stages` Continue, import approval, convert-to-work, `POST /api/runs/:key/approve` — consumes a **single `decideApproval` result**, recorded on the run as `approvedBy: human | policy:<name>`. A **structural test enumerates the transitions into `build` and fails if one bypasses `decideApproval`.** Precedence rule (Reviewer M6-6, M5-2b): **a policy can only add holds; the M5 fast path may skip plan *review* only, never an approval a policy or a forced hold requires.**
2. **Project creation writes to the user's disk from an HTTP body (Security M6-S4, BEFORE-EDIT; Reviewer M6-4).** Order: validate the name pattern and the parent (absolute, exists, a directory, owned by the user, realpath not inside the Conductor home or a system directory, not `/` or the home itself, no symlink in the chain; M7-9 rules on Windows); `mkdir` **non-recursive** (EEXIST fails); re-check the realpath containment; `git init -b main` (fallback for git < 2.28: `init` + `symbolic-ref`) with `--template=` empty and the hardened env (no global/system config, so no template hooks); identity only through `-c user.name/user.email` argv constants validated (no newline, no `<>`), `commit.gpgsign=false`, `core.hooksPath` pointing at an empty directory; README from a constant template with only the pattern-validated name inserted; no remote; then the identity is also written to the new repo's local config. **On failure remove only what Conductor created**, verifying `dev`/`ino` of the directory it made before removal. Test: create, then run a fake build through the envelope with **no global identity**.
3. **Sample repository (Reviewer M6-5, Security M6-S5).** Outside the Conductor home; registered through an internal-only path matching one constant directory exactly (never a flag reachable over HTTP); the key `SAMPLE` is reserved; the sample card never auto-starts.
4. **Limits accounting (Reviewer M6-3, X-4) — ONE accounting module owned here (`src/limits/budget.ts`):** a persisted, versioned, restart-safe counter file in the Conductor home with a **local-day key** (day = the user's local calendar day; DST-safe by using the date string, not 24 h arithmetic) holding the per-project daily agent-run budget **and** the M4 `contextRunsPerDay`, the M5 `asksPerHour`/`researchPerDay`/fast-path counters and the M3 per-graph consumption — one module, one day-boundary rule. `maxRunMinutes` counts **running time only** (not time in `awaiting_approval`, `paused`, `parked`). A limit reached while a stage is running means **finish the stage, then hold** — no stage is killed half-way. Reaching a limit ends in `needs_human` (or a pause until tomorrow for the daily budget) naming the limit.
5. **Risk rules (Security M6-S2/S3).** The structural rules are **re-checked on the actual diff before `ready`** (same named reasons and confirmation); the plan-time check stays. `confirmRisks` is bound to `{planRev, reasonsHash}` — a stale or mismatched one ⇒ 409 — and recorded on the timeline with time and reasons. The sentence that a `--force` builder's own shell commands cannot be intercepted stays in the UI/docs.
6. **Settings changes (Security M6-S6).** Each change leaves an audit entry (old → new, time) in the project timeline; selecting `full-auto` needs an explicit confirmation field; only the `api.ts` settings handler writes `projects[KEY].policy` or limits (static test); ceilings are code constants.
7. **Smaller points.** `manual-stages` reuses `awaiting_approval` with `holdStage`: the lane projection, `approve()` (today "plan approved") and the command matrix get the new cells **listed by name** (hold-build, hold-verify × Retry/Resume/Abort/Cleanup/Move/Continue/crash); the UI/onboarding adds no HTML sink and the environment report shows no tokens or env values; sign-in command strings are constants (Security M6-S8). Per-project settings live in `config.projects[KEY]` (config v5 — M4 §2b-4).

### 2.6 Measurable acceptance criteria

- **M6-AC1** Policy matrix: each of the 4 policies × {S, M, L} × {protected path, none} × {untrusted, trusted} × {graph ≤ 8, > 8} × {risk match, none} yields the specified approval behaviour — **`full-auto` and `approve-risky` differ exactly by the risk rules** and **no combination removes a forced hold** (generated table test); the structural test of §2b-1 passes.
- **M6-AC2** Each risk rule has a positive and a negative test; a risk-approved plan requires the explicit confirmation flag server-side (missing/false ⇒ 409 with the named reasons); reasons appear on the card and in the plan comment.
- **M6-AC3** `manual-stages` stops before build and before verification with one Continue each; abort/Retry/crash recovery behave (matrix cells added).
- **M6-AC4** Limits: each limit enforced and capped by its ceiling (config cannot exceed it); the daily budget pauses new agent calls for that project and resumes next day; messages name the limit.
- **M6-AC5** Project create: validation negatives (exists non-empty, `/`, home, inside Conductor home, bad name, traversal, symlink parent), initial commit succeeds with and without a configured git identity, `inspectRepo` accepts it, nothing is pushed, a failure leaves nothing behind.
- **M6-AC6** Onboarding API: environment report, role defaults, create/open project, analysis, defaults, sample task creation (idempotent; never starts without the user's click).
- **M6-AC7** UI (verified by API tests + scripted Browser-pane checks, screenshots under `.techteam/runs/evidence/`, desktop + mobile, console clean): hierarchy views render, the wizard completes on a fresh home with fake CLIs, policy/limits editing round-trips, no HTML sinks introduced (grep + DOM check).
- **M6-AC8** Requirement coverage stated honestly (§2.7).

### 2.7 Requirement coverage statement

§7 approval modes (fully automatic / approval before implementation / approval before risky operations / manual control of individual stages): **Covered** (policies). §7 sensitive operations "explicit permission and confirmation rules": **Covered for what Conductor can enforce** (plan rules, scans, no push/deploy capability, explicit confirmation) and **explicitly not claimed** for a builder's own shell calls. §7 configurable limits (retries, parallelism, execution time, resource usage): **Covered** (resource usage = agent-run budgets, not CPU/RAM). §8 steps 1–9: **Covered**; step 2 "configure Codex CLI" = detection + guidance + the private-home sign-in command (Conductor never runs an installer or login).

## 3. Files to Be Changed

| File | Action | Change |
| --- | --- | --- |
| `src/policy/{rules,policy,limits}.ts` | Create | risk rules (code constants), policy evaluation (`decideApproval(plan, project, run)` → `{auto|hold, reasons[]}`), limit resolution + ceilings, daily budget accounting |
| `src/pipeline/stages.ts`, `engine.ts` | Modify | `approvalGate` uses `decideApproval`; `manual-stages` holds; `maxRunMinutes`, daily budget checks; reasons on the card |
| `src/config.ts`, `src/types.ts` | Modify | `config.projects[KEY]` (policy, limits), clamping, ceilings, global defaults |
| `src/server/api.ts` | Modify | project settings/milestones endpoints; approve with `confirmRisks`; onboarding endpoints (environment, create project, sample task, defaults) |
| `src/onboarding/{env,create,sample}.ts` | Create | OS/tool report, safe project creation (git init + initial commit), sample repo + card |
| `src/git/worktree.ts` | Modify | none expected (initial commit lives in `onboarding/create.ts`); `inspectRepo` unchanged |
| `ui/app.js`, `ui/index.html`, `ui/style.css` | Modify | projects bar, milestones, tree, project page, drawer additions, wizard v2, policy/limits editor |
| `docs/*`, `README.md` | Modify | policies, limits, what is and is not enforced, onboarding |
| `test/policy*.test.ts`, `test/onboarding.test.ts`, `test/engine-policy.test.ts`, `test/ui-evidence/` (scripts) | Create | per §5 |

## 4. Implementation TODO

- [ ] Reviewer approval (**before any edit**).
- [ ] **Commit 1 — risk rules + policy evaluation + limits (pure) + config/projects model.**
- [ ] **Commit 2 — engine integration** (approval gate, manual stages, run-time cap, daily budget, reasons on cards) + the policy matrix test.
- [ ] **Commit 3 — onboarding backend** (environment report, safe project creation, sample task) + validation negatives.
- [ ] **Commit 4 — UI: hierarchy, project page, policy/limits editor, wizard v2** + scripted Browser-pane verification + screenshots.
- [ ] Reviewer code review + Security review; checkpoint commit.

## 5. Testing Strategy

- **Pure:** generated policy matrix; each risk rule ± ; limit clamping/ceilings; daily budget rollover with `TestClock`.
- **Engine:** approval flows per policy (with fakes), manual-stage holds + Continue, abort/Retry/crash mid-hold, risk confirmation required (and refused without it), forced holds under `full-auto`, run-time cap and daily budget endings and messages, builders unaffected by policy (envelope tests unchanged).
- **Onboarding:** create-project negatives and positives (identity present/absent, existing dir, symlinks, paths), sample repo is self-contained and its test passes, sample card never auto-starts, idempotent.
- **UI:** API-level tests for every new endpoint (strict bodies, CSRF, limits); scripted Browser-pane runs on the demo and on a fresh home (screens: wizard steps, hierarchy, policy editor; desktop + mobile; console clean); DOM sink audit (no `innerHTML`/`eval` added).
- **Not run (stated):** a first-time-user walkthrough with the real CLIs and real quota (the sample task is exercised with fakes; one opt-in live check with the user's quota).

## 6. Risks and Dependencies

- **Policy mis-reading as safety:** the UI/docs repeat that a `--force` builder's own commands cannot be intercepted; policies move approval, not isolation.
- **Risk-rule false negatives/positives:** static patterns will miss obfuscated commands; they are a seatbelt in addition to (not instead of) holds, scans and the envelope.
- **Project creation touches the user's disk:** strict path validation, empty/non-existing targets only, no remote, an explicit confirmation in the UI.
- **UI scope:** large; delivered incrementally behind the existing wizard/board with no new build tooling.

## 7. Requirement Coverage Matrix (M6 slice)

| Requirement | Coverage |
| --- | --- |
| §3 board as the primary UI with hierarchy (project → milestone → item → subtasks), engine keeps state and updates progress | Covered (projects bar, milestones, tree, project page) |
| §7 approval modes | Covered (4 policies, forced holds retained) |
| §7 sensitive operations rules | Covered for plan-level/scan/capability rules; builder shell calls not interceptable — stated |
| §7 configurable limits | Covered (retries, parallelism, time, agent-run budgets) |
| §8 onboarding steps 1–9, recommended defaults first, sample task | Covered |
| §8 "help configure Codex CLI, Claude Code CLI, Cursor CLI" | Covered as detection + guidance + sign-in command shown (never run by Conductor) |
