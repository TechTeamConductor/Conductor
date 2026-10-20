# Sub-plan M4 — Project context engine and offline mode

- Parent: `.techteam/plans/workspace-v2.md` (direction for M4 + binding additions M-8/M-9 as recorded there). Requirement: `workspace-v2-requirements.md` §5 (Persistent Project Context and Offline Intelligence), §6 (retrieve only the relevant context), §8 steps 6–7 (initial analysis, local index).
- Author: TechTeam Lead · Date: 2026-10-20 · Plan status: **rev 2 — Reviewer: Approved (with conditions M4-1…M4-4, now in §2b); Security: Approved, M4-S1…M4-S6 (in §2b); rev-2 verification by both: Approved — `reviews/workspace-v2-m2-fixes-and-plans-rev2-{review,security}.md` (text conditions folded into §2b-8). §2b is BINDING and overrides any earlier sentence.** · Depends on: M1 (board projects), M2 (roles/router; the `context` role), M3 (plans/items consume packs).
- Gate: Reviewer approval before the first source edit. Security review of the code (a new persistent store whose content reaches prompts; a new "offline" classification of provider failures). No new CLI, no new inbound network surface; the connectivity probe is an outbound-only check (see 2.6).

## 1. Current State (verified in the clone at `bd5f186`)

- **No project knowledge survives a run.** Every plan stage re-discovers the repository from scratch through the provider's own tools (Claude reads/greps; Cursor `ask` mode); prompts carry only the card text, repo conventions excerpts (`stages.readConventions`: first 16 KB of `CLAUDE.md`/`AGENTS.md`), the gate list and `PROTECTED`. Nothing records modules, frameworks, test inventory, or what earlier runs achieved.
- **Gates detection exists** (`git/gates.ts` `detectGates`) and is used by the wizard; run history lives in `runs/<KEY>/run.json` + artifacts; the board holds titles/comments. There is no cross-run index.
- **No notion of "offline".** A provider failing for network reasons surfaces as a generic `agent` error (retry once, then `needs_human`) or, for some CLIs, is misread as something else. The dashboard cannot tell the user which parts of Conductor need the network.
- **Home skeleton** already reserves `projects/` (`HOME_SKELETON`, `paths.ts`); the importer and `assertHomeIsUsable` accept it empty.

## 2. Expected State

**Conductor keeps a small, deterministic, incrementally updated model of each registered project — built from git objects, stored in Conductor's own home, integrity-checked — and hands the right slice of it to each stage. Provider failures caused by the network pause the run instead of burning attempts, and the UI says which operations work offline.**

### 2.1 Store (`<v2 home>/projects/<projectKey>/context/`)

- Files: `manifest.json` (schemaVersion, repo path hash, `generatedAt`, `headSha`, `treeSha`, per-module `{path, treeSha, stale:false}`, `contentSha256` of `facts.json`), `facts.json` (deterministic facts, §2.2), `history.ndjson` (deterministic run-outcome digests, §2.5), optional `summaries.json` (opt-in LLM notes, §2.4). Directory 0700 (`ensureRealDir`, never through a symlink), files 0600, written with the durable atomic writer, **only from Conductor's own code** — never read from a checkout or worktree, never from anything an agent produced.
- **Integrity:** `schemaVersion` (versioned via `loadVersioned`, newer ⇒ refused, older ⇒ migrated in memory); `manifest.contentSha256` must equal the hash of `facts.json`, else the store is *corrupt* ⇒ kept aside as `*.corrupt-<ts>` and rebuilt (a context file is never trusted blindly). `projectKey` validated against the board's project keys (`^[A-Z]{2,6}$`) before any path is built.
- Caps: ≤ 200 000 tracked files indexed (beyond that `truncated:true` and top-level modules only), per-file read ≤ 256 KB, `facts.json` ≤ 200 KB, `history.ndjson` ≤ 1 MB (oldest lines pruned), packs ≤ 8 KB (configurable, hard ceiling 32 KB).

### 2.2 Scanner (`src/context/scan.ts`) — facts from git objects, not the working tree

Reads `git ls-tree -r -z --long <base>` (the project's repo `baseBranch` HEAD, resolved to a commit) and individual blobs via `git cat-file`; symlinks (`120000`) and submodules (`160000`) are listed as such and never followed; no file is executed. Facts (all structured, size-capped, control characters stripped, **no free-form prose from the repository**): `languages {ext→files}`, `packageManagers`, `frameworks[]` (from manifest dependency names: package.json, pyproject/requirements, Cargo.toml, go.mod, Gemfile, pom/gradle names only), `scripts {name→command ≤ 200 chars}` (package.json scripts, Makefile target names), `gates` (reuse `detectGates`), `modules[] {path, kind: package|app|lib|tests|docs|config, files, languages, entryPoints[]}` (top-level directories and workspace packages), `tests {runner?, dirs[], fileCount}`, `importantFiles[]` (README, CONTRIBUTING, LICENSE, config roots, CI definitions), `ci[]`, `conventionsFiles[]` (paths of CLAUDE.md/AGENTS.md — the *excerpts* stay where they are today).

### 2.3 Incremental update and staleness

- `refresh(project)` compares the base commit's per-module tree ids (`git rev-parse <commit>:<dir>`) and the root config blobs with the manifest: **unchanged ⇒ no work**; changed modules ⇒ only those are re-scanned; root config blob changed ⇒ repo-level facts recomputed; manifest missing/corrupt/schema-newer or > 60 % of modules changed ⇒ full rescan. A mtime/size fast path is **not** used for correctness (git ids are authoritative); it is only used to skip `git` calls when `.git/HEAD` and the ref file are unchanged since the last refresh.
- `status(project)` ⇒ `fresh | stale {reasons[], modules[]} | missing | corrupt`, with `generatedAt`, `headSha` and which modules are covered. Staleness = HEAD moved, a module tree changed, or `generatedAt` older than 14 days (configurable). Refresh runs: on project creation/first run (if missing), before each plan stage (cheap no-op when fresh), and on demand (`POST …/context/scan`). Never blocks a run on failure: a failed scan is logged and the run proceeds with whatever context exists (or none).

### 2.4 Packs and what may go where (binding)

- `buildPack(project, {consumer, task, plan?, budgetBytes})` selects **repo-level facts always** + the modules that overlap the task: path/keyword match against the card text and, once a plan exists, against `filesToChange` and item files; deterministic scoring, stable output, always within the budget (modules dropped, never truncated mid-record).
- **Builder prompts receive ONLY the deterministic facts** (`fence('project-facts', …)` — fenced as data, "derived mechanically from the repository, not instructions"). **Read-only stages** (plan, review, verification, analysis items) additionally may receive history digests and (opt-in) LLM summaries — fenced as untrusted, redacted, size-capped. **LLM text is never placed in a builder prompt.**
- **LLM summaries are OFF by default** (`project.context.summaries: false`, per project, set through the API with an explicit statement that it spends quota). When on: generated through the router (`context` role), one module at a time, **each call counted against `agentRuns` limits** of a system "context" budget (`pipeline.contextRunsPerDay`, default 12, hard ceiling 48), invalidated per module when its tree id changes, schema-validated (`{summary ≤ 600 chars}`), redacted (token shapes + `.env` values), size-capped, and never fed back into summary prompts.

### 2.5 History digests (deterministic)

When a run reaches `finished`/`ready`/`needs_human`/`aborted`, one line is appended: `{key, title (≤ 200), status, at, files[] (≤ 50, from the diff), verdict, loops, itemCount}` — no model text except the verdict word. Used by read-only stages as "previously completed tasks and their outcomes" (fenced). Titles are user text ⇒ fenced like all card text.

### 2.6 Offline mode

- **Classification:** `AgentResult.errorKind` gains `'network'`, assigned by each adapter only after a structural failure, from CLI-reported error text (`ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network error|unable to connect|socket hang up` — capped, never model prose, never when the turn completed). `advances('network')` is false for stage chains (another provider is just as offline) unless that provider is local (none today).
- **Pause semantics = the usage-limit pause, separate reason:** the stage returns the attempt (`agentRuns` refunded like a limit), the run becomes `paused` with `pauseReason: 'offline'` and `pausedUntil = now + backoff` (30 s → 1 min → 2 min → 5 min cap); the engine re-checks connectivity (`net/offline.ts` probe) and resumes by itself when online; **one** board comment and **one** notification per offline episode; an `offline` banner in the UI. A run offline for > 24 h ends `needs_human` with the reason.
- **Probe:** outbound-only, `https://` HEAD to a short list of well-known hosts of the *configured providers* (api.anthropic.com, api.openai.com / chatgpt.com, cursor.sh) via Node's `fetch` with a 4 s timeout, **no cookies, no auth, nothing sent**; result `online | offline | unknown` (unknown when blocked by a proxy/DNS policy ⇒ treated as online, so the probe can never trap a user in "offline"). Cached 20 s. Disabled (always `unknown`) in tests unless injected.
- **Labels:** `GET /api/offline` → `{ online, checkedAt, operations: [{ id, label, mode: 'offline-ok'|'needs-network', provider? }] }`: offline-ok = board, context read/refresh, scans, gates, history, importing, settings; needs-network = every provider stage (provider named). The UI shows an "Offline — N operations still work" strip and per-action hints.

### 2.7 API / UI

`GET /api/projects/:key/context` (status + facts summary, no raw history), `POST /api/projects/:key/context/scan` (refresh; `{full:true}` forces), `PUT /api/projects/:key/context/settings` (`summaries`, `staleDays`, `packBytes`, validated), `GET /api/offline`. All keys validated (`^[A-Z]{2,6}$`, exists on the board) before any path; mutations follow the existing CSRF/Host/Sec-Fetch rules. UI (minimal; the full hierarchy/onboarding UI is M6): a context chip on the board header (fresh/stale/missing, "Refresh") and the offline strip.

**Must remain unchanged:** the envelope and all M1–M3 safety properties; the "repo conventions" excerpts; gate behaviour; run state machine (a context failure never fails a run); no LLM text in builder prompts; zero runtime dependencies.

### 2b. Review conditions — BINDING (Reviewer M4-1…M4-4 + non-blocking, Security M4-S1…M4-S6)

1. **The eight V5 knowledge items, one by one (M4-1; master M-8).** Source / trust class / who may receive it:

| # | V5 item | Source | Trust class | Builder prompt | Read-only stages / UI |
| --- | --- | --- | --- | --- | --- |
| 1 | Repository structure, module responsibilities | scanner (git objects) — structure + module kinds; "responsibility" prose only from opt-in summaries | deterministic / agent text (summary) | facts only (computed at use time, §2b-2) | facts + (opt-in) summaries, fenced |
| 2 | Frameworks, languages, dependencies, build commands | scanner (names, scripts, gates) | deterministic (charset-limited strings) | yes | yes |
| 3 | Architectural decisions, coding conventions | board `Decision` rows (user-authored verbatim; conductor-authored = agent text) + conventions-file **paths**; model-written understanding = opt-in summaries | user text / agent text | user-authored decisions: yes, fenced; nothing agent-written | all, fenced |
| 4 | Important files, interfaces, integration points | scanner (important files, entry points, CI paths) | deterministic | yes | yes |
| 5 | Existing tests and verification procedures | scanner (test inventory, runner, gates) | deterministic | yes | yes |
| 6 | Current objectives and outstanding work | board: open `Milestone` rows (user text) and open work cards (titles, lanes) | user text | titles/milestone titles fenced; no agent text | yes |
| 7 | Previously completed tasks and outcomes | deterministic history digests (title (user text), status, files, verdict word) | user text + agent-influenced file names | **no** (class iii) | read-only stages, fenced |
| 8 | Known issues, constraints, unresolved decisions | board: open `bug` cards (agent text) and open `Decision` rows | agent text / user text | **no** | read-only stages, fenced |

   Only the **model-written understanding** of items 1, 3 and 8 is Partial (opt-in summaries); everything board-derivable is covered deterministically. The "LLM text never reaches a builder prompt" rule means **persisted cross-run agent text** (class iii of M3 §2b-7); in-run, human-visible agent output follows the M3 rule.
2. **Builder-facing facts do not depend on a file a builder can rewrite (M4-2).** A hash next to the file detects corruption, not tampering; a `--force` builder runs as the user and can rewrite the store. Therefore **the facts a builder prompt receives are computed at use time from git objects** (the scanner is deterministic and cheap); the on-disk store is a **cache for read-only stages and the UI only**, and the plan no longer calls it "integrity-protected" for prompt content. Strings in `scripts{}`, `importantFiles[]`, module and file names are restricted to a charset and length that cannot carry a sentence (`[A-Za-z0-9._@/+:=-]`, ≤ 120 characters; anything else is dropped and counted), control and bidi/format characters stripped (M4-S3); `fence()` is reused (it neutralises `<untrusted`/`</untrusted`).
3. **Offline classification (M4-3, M4-S2).** (a) Before spawning a provider stage the engine consults the cached probe; on a timeout/`timeout_idle`/generic failure with the probe saying `offline`, the stage is classified `network` (a CLI that is offline usually hangs, it does not print a network error). (b) **A set `HTTP_PROXY`/`HTTPS_PROXY` (either case) makes the probe return `unknown`** (Node's `fetch` ignores them while the CLIs honour them); a human **Resume** always attempts the stage once and is never re-paused by the probe alone. (c) The 24 h ceiling is **cumulative per run** (not per episode) plus an **episode cap (20)**, so a CLI that keeps reporting network errors while the probe says online cannot pause and resume forever with refunded attempts. (d) Probe: constant host list (code, not config), `redirect:'error'`, no headers, body never read, 4 s timeout. (e) Classification reads only the CLI's structural error fields — never tool results or model text (test: network words planted in a failed turn's tool result).
4. **Per-project settings live in ONE place (M4-4; also M6, Reviewer X-1).** `config.projects[KEY] = { policy?, limits?, context?: { summaries, staleDays, packBytes } }` — **config version 5** (migration adds an empty `projects`, null-prototype/own-property handling, keys validated `^[A-Z]{2,6}$`); a deleted board project drops its entry on the next save; store directories under `<home>/projects/<KEY>/` are never deleted automatically. M6 uses the same record (policy, limits).
5. **Scanner git hygiene (M4-S1).** Every scanner git call uses the hardened env (`GIT_CONFIG_GLOBAL` to the null device, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, **`GIT_NO_LAZY_FETCH=1`** — a partial clone would otherwise fetch from a remote, with credential helpers, during a "local" scan), no textconv/filters, `--end-of-options` and 40-hex ids; `cat-file --batch`/`--batch-check` instead of one process per module/blob; the number of spawns and wall time per scan are capped.
6. **Store modes and strings (M4-S4, M4-S5, M4-S6).** The context directories are created with an explicit 0700 (`ensureRealDir` sets none); `repoPathHash` is not a trust anchor; history digests (hostile file names, user titles) are fenced in read-only prompts and `textContent` in the UI; **LLM summaries and history digests are never placed in a research prompt** (M5-5: deterministic facts only, repo-aware only).
7. **Smaller points.** The pack states which commit it was computed from — the run's `baseSha` when a run exists, else the branch tip; `history.ndjson` diff file names and titles never reach a builder; router roles: M3 analysis items use the item's role, M4 summaries use `context`, M5 Quick Ask uses `context`.

8. **Clarifications from the rev-2 reviews (Security C4-1…C4-3, Reviewer M4 conditions; binding).**
   - **C4-1 — the strict charset has no space, so command text cannot ride in it.** Two classes of string, decided here: (i) *identifiers* — module names, file paths, script **names**, framework/dependency names — use the strict charset `[A-Za-z0-9._@/+:=-]` (≤ 120 chars) and are the only repository-derived strings a **builder** prompt receives, plus the gate list that prompts already carry today (Conductor-detected, unchanged); (ii) *command text* (`package.json` script bodies, Makefile recipes; ≤ 200 chars, control/bidi stripped, whitespace collapsed) goes **only to read-only stages and the UI**, fenced as untrusted data. A script body is never in a builder prompt.
   - **C4-2 — the cache is validated on load, not trusted.** A builder can rewrite `<home>/projects/<KEY>/context/*`. `facts.json`/`history.ndjson`/`summaries.json` are re-validated on every read (schema, size caps, charset, entry counts); an invalid entry is dropped and counted, a file that fails validation is quarantined and rebuilt. A hash match never skips validation. The residual — **a builder can rewrite the summaries/history cache that reaches read-only stages and so influence a later plan** — is stated plainly in the docs; it is bounded by opt-in summaries, fencing, "deterministic facts for builders are recomputed from git", and the approval/forced-hold gates on the resulting plan.
   - **C4-3 — tests that must stay:** an offline-refund test (a network-class failure never consumes `agentRuns`), a **cumulative** 24 h cap test and the **episode cap (20)** test, a proxy-env test (`HTTP(S)_PROXY` ⇒ `unknown`), and the planted-network-words-in-a-tool-result test.
   - **Accounting module lands here, not in M6 (Reviewer sequencing condition; also M5/M6).** `src/limits/budget.ts` is created in **M4 commit 4** with its first consumer (`contextRunsPerDay`) and the final semantics M6 relies on: a **local-day** key (not UTC), counts that survive restarts (add-only file with validation on load, C6-4), caps that count **running time only** (a paused/offline run does not burn them), ceilings as constants. M5's Quick Ask counters and M6's policy limits reuse it; M6 adds policy on top of it and does not create a second counter.
   - **Builder prompts and board titles.** Titles of open work/milestones that reach a builder are limited to **user-created `work` cards and user-authored milestones**; cards with `createdBy: 'import'` or `untrusted`, and `ask`/`research`/`bug`/`subtask` cards, are excluded from builder prompts (they may appear, fenced, in read-only stages).

### 2.8 Measurable acceptance criteria

- **M4-AC1** Scanner facts for fixture repos (node, python, Go, mixed monorepo, empty repo, repo with symlinks/submodules/huge files) match expected JSON; nothing is read from the working tree and no symlink is followed.
- **M4-AC2** Incremental: touching one module re-scans only that module (counted git reads); an untouched repo performs no scan; root-config change recomputes repo-level facts; > 60 % change ⇒ full rescan; manifest corrupt/newer ⇒ rebuilt/refused as specified.
- **M4-AC3** Status reports fresh/stale/missing/corrupt with reasons; stale after HEAD moves; covered-module list is exact.
- **M4-AC4** Packs are deterministic, relevance-ordered, within budget; builder prompts contain only deterministic facts **recomputed from git objects at use time** (a test plants LLM text AND forged facts in `summaries.json`, `facts.json` and `history.ndjson` and proves none reaches a builder prompt); read-only prompts fence the cache content.
- **M4-AC5** LLM summaries off by default; when enabled they are budgeted (counted, ceilings enforced), redacted, capped, schema-validated, invalidated per module; a hostile summary cannot escape its fence.
- **M4-AC6** Offline: a network-class provider failure refunds the attempt, pauses the run `offline`, comments + notifies once, resumes automatically when the probe says online, and never burns `agentRuns`; a completed turn with network words in its text is never offline (prose rule); `unknown` probe never traps.
- **M4-AC7** `/api/offline` and the UI label operations `offline-ok` / `needs-network (provider)`; `/api/projects/:key/context` endpoints validate keys and reject traversal.
- **M4-AC8** A context scan/refresh failure never fails or blocks a run; a corrupt store is quarantined and rebuilt; the store lives only under `<home>/projects/<KEY>/context/` (static test: no module reads context from a repo path).

## 3. Files to Be Changed

| File | Action | Change |
| --- | --- | --- |
| `src/context/store.ts` | Create | versioned/integrity-checked store, caps, quarantine, durable writes, key validation |
| `src/context/scan.ts` | Create | git-object scanner (facts §2.2), caps, symlink/submodule handling |
| `src/context/incremental.ts` | Create | refresh/status/staleness, per-module tree comparison, full-rescan rules |
| `src/context/pack.ts` | Create | relevance selection, budgeted deterministic packs, consumer rules (builder vs read-only) |
| `src/context/history.ts` | Create | deterministic outcome digests (append, prune, read) |
| `src/context/summaries.ts` | Create | opt-in LLM module summaries via the router with budget/redaction/validation |
| `src/net/offline.ts` | Create | probe, state, backoff schedule, operation labels |
| `src/agents/providers/{claude,cursor,codex}.ts`, `src/types.ts` | Modify | `errorKind:'network'` classification (structural-failure-first) |
| `src/pipeline/stages.ts`, `src/pipeline/engine.ts` | Modify | refresh before plan, pack insertion (fenced) in plan/review/verify/analysis and builder (facts only), offline pause/resume, history append at run end |
| `src/pipeline/prompts.ts`, `prompts/*.md` | Modify | `{{projectFacts}}` / `{{projectHistory}}` / `{{projectNotes}}` blocks with data-not-instructions wording |
| `src/server/api.ts`, `src/types.ts`, `ui/app.js` | Modify | context + offline endpoints/types; context chip, offline strip |
| `src/config.ts` | Modify | `pipeline.contextRunsPerDay`, per-project context settings (stored on the board project record or `config.projects[key].context`) |
| `docs/ARCHITECTURE.md`, `docs/API.md`, `README.md` | Modify | context engine, offline behaviour |
| `test/context/*.test.ts`, `test/offline.test.ts`, `test/engine-context.test.ts` | Create | per §5 |

## 4. Implementation TODO

- [ ] Reviewer approval (**before any edit**).
- [x] **Commit 1 — store + scanner + incremental + status** (pure modules, fixtures, no engine change).
- [x] **Commit 2 — packs + history + prompt blocks + engine insertion** (facts-only for builders; read-only fencing; refresh-before-plan; failure never blocks).
- [x] **Commit 3 — offline classification + pause/resume + probe + labels + API/UI.**
- [x] **Commit 4 — `src/limits/budget.ts` (first consumer: the context-run budget; final semantics per §2b-8) + opt-in LLM summaries + docs.**
- [ ] Reviewer code review + Security review; checkpoint commit.

## 5. Testing Strategy

- **Scanner/incremental (unit):** table of fixture repos built with `git` in temp dirs (node app, node monorepo with workspaces, python, go, empty, symlink-to-outside, submodule entry, 5 MB generated file, 300k-file synthetic via a stubbed `ls-tree` source); counted git invocations via a spy; corrupt/newer/hash-mismatch manifests; traversal keys (`../x`, `A/B`, empty) rejected.
- **Packs:** determinism (same input ⇒ same bytes), budget respected, relevance ordering, module drop vs truncate; **provenance test:** LLM text in summaries/history never appears in a builder prompt (prompt audit files), appears fenced in read-only prompts.
- **Offline:** fake provider emitting each network error shape; prose "connection refused" in a completed turn ⇒ not offline; pause/resume with `TestClock` and an injected probe; refund; one notification; 24 h cap; `unknown` probe ⇒ online; `/api/offline` labels.
- **Engine:** context refresh failure does not fail the run; history line appended at each terminal state; summaries budget ceiling.
- **Static:** no module reads `context` files from a repo/worktree path; `npm run check`; full `npm test`; live suites unchanged.
- **Not run (stated):** the probe against the real internet (injected in tests); real-provider network-failure strings beyond the documented/fake shapes.

## 6. Risks and Dependencies

- **Prompt-injection through "facts":** repo-controlled strings (script commands, file names) reach prompts. Mitigation: structured subset only, length caps, control-character stripping, fenced as data in every prompt, builder gets no LLM-written text.
- **Stale or wrong context misleading a stage:** facts carry `generatedAt/headSha`; packs state them; refresh-before-plan is cheap; context can be disabled per project.
- **Large repos:** caps + truncation flags; scans are off the hot path (git object reads, bounded).
- **Probe false negatives:** `unknown` is treated as online; a stuck pause can always be resumed by a human (`Resume`), as for usage limits.

## 7. Requirement Coverage Matrix (M4 slice)

| Requirement | Coverage |
| --- | --- |
| §5 repository structure, modules, frameworks, languages, dependencies, build commands, important files, tests/verification, | Covered (scanner facts) |
| §5 conventions, architectural decisions, objectives, outstanding work, known issues/constraints | **Partial** — conventions files referenced + excerpts as today; decisions/issues live on the board (Decision entity) and in history digests; no automatic extraction of objectives/decisions |
| §5 previously completed tasks and outcomes | Covered (deterministic history digests) |
| §5 incremental updates, reuse, relevant context only, track generated-at/coverage/staleness, full rescans only when necessary | Covered (per-module tree ids, status, caps, packs) |
| §5 offline-capable: local index, saved knowledge, history, plans available offline; distinguish local vs network operations | Covered (`/api/offline`, labels, offline pause) |
| §6 Quick Ask "retrieve only the relevant project context" | Packs available to M5 |
| §8 initial project-context analysis / local index | Provided as `POST …/context/scan` + auto-refresh; the onboarding UI is M6 |
