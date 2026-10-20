# Sub-plan M4 — Project context engine and offline mode

- Parent: `.techteam/plans/workspace-v2.md` (direction for M4 + binding additions M-8/M-9 as recorded there). Requirement: `workspace-v2-requirements.md` §5 (Persistent Project Context and Offline Intelligence), §6 (retrieve only the relevant context), §8 steps 6–7 (initial analysis, local index).
- Author: TechTeam Lead · Date: 2026-10-20 · Plan status: **pending_reviewer** (rev 1) · Depends on: M1 (board projects), M2 (roles/router; the `context` role), M3 (plans/items consume packs).
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

### 2.8 Measurable acceptance criteria

- **M4-AC1** Scanner facts for fixture repos (node, python, Go, mixed monorepo, empty repo, repo with symlinks/submodules/huge files) match expected JSON; nothing is read from the working tree and no symlink is followed.
- **M4-AC2** Incremental: touching one module re-scans only that module (counted git reads); an untouched repo performs no scan; root-config change recomputes repo-level facts; > 60 % change ⇒ full rescan; manifest corrupt/newer ⇒ rebuilt/refused as specified.
- **M4-AC3** Status reports fresh/stale/missing/corrupt with reasons; stale after HEAD moves; covered-module list is exact.
- **M4-AC4** Packs are deterministic, relevance-ordered, within budget; builder prompts contain only deterministic facts (a test plants LLM text in `summaries.json` and `history.ndjson` and proves neither reaches a builder prompt); read-only prompts fence them.
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
- [ ] **Commit 1 — store + scanner + incremental + status** (pure modules, fixtures, no engine change).
- [ ] **Commit 2 — packs + history + prompt blocks + engine insertion** (facts-only for builders; read-only fencing; refresh-before-plan; failure never blocks).
- [ ] **Commit 3 — offline classification + pause/resume + probe + labels + API/UI.**
- [ ] **Commit 4 — opt-in LLM summaries with budget + docs.**
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
