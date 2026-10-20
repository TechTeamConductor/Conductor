# Sub-plan M5 — Operating modes: Quick Ask and Deep Research

- Parent: `.techteam/plans/workspace-v2.md` (direction for M5; binding additions as recorded there). Requirement: `workspace-v2-requirements.md` §6 (Three Primary Operating Modes: A Quick Ask, B Engineering Work, C Deep Research).
- Author: TechTeam Lead · Date: 2026-10-20 · Plan status: **pending_reviewer** (rev 1) · Depends on: M2 (router, roles, providers), M3 (plans/graph for convert-to-work), M4 (context packs, offline).
- Gates: Reviewer approval before the first source edit **and Security design sign-off before the first source edit** (a new executable profile: a provider with web tools and a fetch channel; a new persisted record type whose content is model/web text).

## 1. Current State (verified in the clone at `bd5f186`)

- **Only one way to start work:** a card in To do runs the Engineering pipeline (plan → [review] → approval → build → verify). Questions already work through it (BAR-363 fix: a read-only plan with `deliverable: 'answer'` finishes as an answer) but pay for a worktree, a branch, a plan review and card bookkeeping.
- **`stages.callReadOnly`** is the only place that implements "call a read-only provider with schema validation, one corrective re-ask, max-turns retry, limit pause/back-off, abort, redaction, event log, quota, per-card run cap". It is private to a run (it patches the run record and moves the run to `paused/needs_human`), so nothing else can reuse it.
- **Claude profiles:** `buildClaudeArgs` gives one read-only profile for plan/review/verify (`--tools Read,Grep,Glob`, `--disallowedTools` credential reads, `--strict-mcp-config`, `--disable-slash-commands`, `--permission-mode dontAsk`) and `checkClaudeInit` is a fail-closed predicate on the `system/init` event: the tool set must be exactly `Glob, Grep, Read, StructuredOutput`. **No profile has web tools**, so no role may research (`ROLE_NEEDS.research` requires `webResearchIsolated`; no provider has it).
- **No persisted record for non-run conversations**, no snapshot-of-repo primitive, no citation handling, no way to convert findings into work.
- M2 gives the router (`research` role, capability gate), M3 the plan graph, M4 packs and the offline classification — all committed or pending before this plan starts.

## 2. Expected State

**Three ways in. Quick Ask answers small questions (and performs focused, simple changes through a fast path) with minimal overhead; Deep Research gathers online evidence under a hardened, fail-closed profile and produces a cited, honest report that can be turned into planned work; Engineering Work is unchanged.**

### 2.1 One shared agent caller

`src/agents/caller.ts` extracts the provider-call loop of `callReadOnly` into a **run-independent** `callAgent({ role, stage, prompt, schema, cwd, validate, signal, secrets, budget, onEvent, hooks })` returning a discriminated result (`ok | paused(limit|offline) | aborted | failed(reason)`): schema validation + one corrective re-ask, max-turns retry, router + chain advance, limit/offline classification, redaction, events, quota recording. `stages.callReadOnly` becomes a thin adapter that translates the result into run transitions (**behaviour byte-for-byte**: every existing engine-plan/limit/safety/loop/regress test passes unchanged — extraction gate, characterization first as in M2). Asks and Research use the same function.

### 2.2 Persistence (`<v2 home>/asks/`)

`AskRecord { id, mode: 'quick'|'research', repo?, question (≤ 4000), createdAt, updatedAt, status: 'running'|'paused'|'done'|'failed'|'canceled', provider?, sessionId?, result?, error?, events[] (≤ 200 lines, redacted), tokens/cost?, convertedTo?: itemKey }` — one JSON file per ask (0600, dir 0700, `ensureRealDir`, durable atomic write, versioned via `loadVersioned`), `index.json` capped at 500 entries (oldest pruned), ids `ask-<hex>`; every id validated before a path is built. Results are **untrusted data**: rendered as text/markdown through the existing sanitising renderer, never executed, never fed to builder prompts, fenced when shown to any provider.

### 2.3 Mode A — Quick Ask

- **Input:** `POST /api/ask { question, repo? }` (repo optional: with one registered repo it defaults; with none it is a general question).
- **Context:** the M4 pack (deterministic facts + the modules that match the question) + the question — "retrieve only the relevant project context".
- **Where it runs — a read-only SNAPSHOT, not the user's checkout (deliberate, safer than the master text):** the repo's `baseBranch` commit exported with `git archive` into a 0700 scratch directory (no `.git`, no hooks, no config, no untracked or uncommitted files — so no `.env`), deleted afterwards; ≤ 500 MB else "too large for Quick Ask — use Engineering Work". The answer is stated to be based on *branch @ sha*. Provider profile = the existing read-only profile of the router's choice for the `context` role (Claude's fail-closed predicate; Cursor `ask`; Codex read-only sandbox), with the UI stating the tier ("answered by Cursor in ask mode — weaker isolation").
- **One call**, schema `ASK_SCHEMA { kind: 'answer'|'change', answer?: markdown (≤ 20 000), change?: { title, description, files[], complexity: 'S'|'M'|'L' } , citations?: [{file, lines}] }`. The model decides whether the request is a question or a request to change something.
  - `answer` ⇒ stored and shown; no card, no worktree, no branch.
  - `change` with `complexity: 'S'` and files that include **no protected path** ⇒ **fast path**: a work card is created (`createdBy: 'user-ask'`, `autoStart: true`) whose run has `fastPath: true` — planning still runs (a one-item plan), **plan review is skipped, approval is automatic, build is in a worktree through the envelope, gates and verification still run** — and the card links back to the ask. Any protected path, `M`/`L`, or a refusal to commit to a file list ⇒ the change is *offered* as "Turn into work" (a normal card in To do with the ask's text, normal approval rules) — never auto-started. `untrusted` is NOT set (the text is the user's own question).
- **Escalation:** "Turn into work" on any ask creates a normal card (title from the question, description = question + the answer as an *untrusted, fenced* note).

### 2.4 Mode C — Deep Research (hardened; the part that needs Security design sign-off)

- **Who may do it:** the `research` role, gated by `webResearchIsolated` — **derived** (a provider exposes `runResearch` AND its research profile's fail-closed predicate is baselined in code); today only Claude. Codex (`--search` exists, isolation unproven) and Cursor are **not** eligible; the router refuses them with the reason (`ROLE_NEEDS.research` already requires it).
- **Claude research profile** (`buildClaudeArgs('research')`): `--tools Read,Grep,Glob,WebSearch,WebFetch`, the same `--disallowedTools` credential-read deny list, `--strict-mcp-config`, `--disable-slash-commands`, `--safe-mode`, `--permission-mode dontAsk`, `--max-turns` capped (default 40) — **no Bash, Edit, Write, or MCP**. `checkClaudeInit(profile)` becomes profile-aware: the research tool set must be **exactly** `{Glob, Grep, Read, StructuredOutput, WebFetch, WebSearch}`; any extra tool ⇒ isolation violation ⇒ the run stops (`errorKind:'isolation'`, never falls back). **Negative test per profile:** the plan/review/verify profile still **rejects** `WebSearch/WebFetch` in its init; the research profile rejects `Bash`/`Edit`/`Write`/an MCP server.
- **A verified permission fact is required before implementation:** whether `--tools … --permission-mode dontAsk` actually *permits* WebSearch/WebFetch without prompting (an unverified assumption today). The first implementation step is an opt-in live probe (`doctor --research-probe`, uses a tiny quota) whose result is recorded in the plan/evidence; if the profile cannot work without widening permissions, **M5-research stops and is reported not delivered** (nothing is widened to make it work).
- **Where it runs:** default cwd = **an empty scratch directory** (no repository content reachable, so nothing to leak through a fetched URL); repo knowledge reaches the model only as a redacted, budgeted M4 deterministic pack inside the prompt. **Repo-aware research is an explicit per-task opt-in** (`repoAware: true`, shown in the UI with: "the agent can read the repository snapshot and could include its content in web requests"): cwd = the §2.3 snapshot, credential deny-list kept.
- **Citation integrity is structural:** the session's tool events are folded into an `observedUrls` set (WebFetch inputs; URLs in WebSearch results; normalised: scheme+host lowercase, fragment dropped, tracking params ignored). `RESEARCH_SCHEMA { question, summary, findings[{claim, evidence, confidence: high|medium|low, sources: [{url, title, quote ≤ 300}]}], alternatives[{name, pros[], cons[]}], recommendations[], unverified[], openQuestions[] }`. A finding with **any** source URL not in `observedUrls`, or with a non-`http(s)` URL, or none at all, is **moved to `unverified`** by Conductor (the model cannot self-certify). Verified vs assumption is therefore enforced, not requested.
- **Rendering:** the report is `<untrusted>` data: markdown through the sanitising renderer, URLs shown as text and opened only through the existing https allow-list `open` path; never executed; `javascript:`/`data:` rejected at the API boundary.
- **Convert to plan:** "Turn into an engineering plan" creates a **work card with `untrusted: true`** (so plan approval is forced **regardless of policy**), description = the user's question + recommendations as a fenced untrusted block.
- **Offline:** research needs the network (`needs-network (Claude)` in `/api/offline`); when the probe says offline it refuses immediately with that message; a mid-run network failure is the M4 offline pause.
- **Abuse limits:** `pipeline.asksPerHour` (default 20), `pipeline.researchPerDay` (default 5, ceiling 20), one running research at a time per provider; each counts as agent-run budget of a system "ask" bucket.

### 2.5 API / UI (minimal; the polished experience is M6)

`POST /api/ask`, `GET /api/asks`, `GET /api/asks/:id`, `POST /api/asks/:id/cancel`, `POST /api/asks/:id/convert`; all ids/keys validated before any path; mutations follow CSRF/Host/Sec-Fetch rules; bodies strict. SSE `ask` events (status + redacted lines). UI: a header "Ask" button → panel with the mode switch (Quick Ask / Deep Research — "Engineering Work" = the existing New task), question box, repo select, the research opt-ins, live status, rendered result, "Turn into work".

**Must remain unchanged:** all M1–M4 safety properties; the plan/review/verify Claude profile argv byte-identical (snapshot test) — only the init predicate becomes profile-aware (default profile behaviour identical); the envelope and builder isolation; no new inbound network surface; zero runtime dependencies.

### 2.6 Measurable acceptance criteria

- **M5-AC1** `callAgent` extraction is behaviour-preserving: the pre-M5 engine suites pass **unchanged**; `buildClaudeArgs` snapshot for the existing profile identical.
- **M5-AC2** Quick Ask answer path: one provider call, no worktree/branch/card, snapshot exported (no `.git`, no untracked/uncommitted files — tested with a planted `.env` and a dirty file) and deleted; answer stored; tier label shown; too-large repo refused.
- **M5-AC3** Fast path: an `S` change with no protected path creates a fast-path card that skips plan review and auto-approves yet still builds in a worktree through the envelope and is verified; a protected path, `M`/`L`, or no file list ⇒ offered, never auto-started; the card links to the ask.
- **M5-AC4** Research profile: predicate exact-set both ways (negative per profile), `dontAsk` permission fact verified live (or the research part reported not delivered), default cwd empty, repo-aware only on explicit opt-in.
- **M5-AC5** Citation integrity: a finding citing a URL never observed in a tool event is moved to `unverified`; non-http(s) URLs rejected; the model cannot move a finding back; verified/unverified are both shown.
- **M5-AC6** Research results are fenced untrusted everywhere they are re-shown to a provider; a research-seeded work card is `untrusted` (approval forced under every policy).
- **M5-AC7** Router refuses Codex/Cursor for `research` with the reason; an isolation violation never falls back.
- **M5-AC8** Limits: asks/hour and research/day enforced; one concurrent research per provider; offline refusal and offline pause behave as M4.
- **M5-AC9** Ask store: ids validated, 0600/0700, versioned, capped, durable; corrupt record quarantined; no path traversal.
- **M5-AC10** Requirement coverage stated honestly (§2.7 below).

### 2.7 Requirement coverage statement (V6)

Mode A "respond or execute" for questions, explanations, focused changes and simple fixes: **Covered** for questions and S-complexity fast-path changes; **Partial** for "execute" beyond S (those become approved Engineering Work, by design). Mode B: **Covered** by M1–M3. Mode C: **Covered if the `dontAsk` permission fact verifies; otherwise reported Not delivered** — "consult online sources, compare alternatives, evaluate evidence, structured report with citations, convert to plan, make clear when offline, distinguish verified from assumptions" are each tested; evidence evaluation is the structural citation rule plus the model's confidence labels (not independent fact-checking).

## 3. Files to Be Changed

| File | Action | Change |
| --- | --- | --- |
| `src/agents/caller.ts` | Create | run-independent `callAgent` (extracted loop) |
| `src/pipeline/stages.ts` | Modify | `callReadOnly` becomes an adapter over `callAgent` (no behaviour change); `fastPath` handling (skip plan review, auto-approve unless hold) |
| `src/agents/claude.ts` | Modify | profile-aware `buildClaudeArgs`/`checkClaudeInit` (`plan|review|verify` identical, new `research`), tool-event URL folding |
| `src/agents/providers/{claude,types,registry}.ts`, `verification.ts` | Modify | `runResearch`, derived `webResearch`/`webResearchIsolated` capabilities (baseline), router state |
| `src/modes/{store,ask,research,snapshot,citations}.ts` | Create | ask records, Quick Ask flow, research flow, `git archive` snapshot, citation integrity |
| `src/pipeline/engine.ts`, `src/runtime.ts` | Modify | ask runner (bounded concurrency, limits), convert-to-work, shutdown |
| `src/types.ts`, `src/config.ts` | Modify | `AskRecord`, `Run.fastPath`, `pipeline.asksPerHour/researchPerDay`, schemas `ASK_SCHEMA`, `RESEARCH_SCHEMA` |
| `src/server/api.ts`, `src/server/http.ts`(SSE) | Modify | ask endpoints/events |
| `prompts/ask.md`, `prompts/research.md` | Create | untrusted-data wording, fences, output rules |
| `ui/app.js`, `ui/index.html`, `ui/style.css` | Modify | Ask panel, result rendering, offline hints |
| `src/doctor.ts`, `src/cli.ts` | Modify | `doctor --research-probe --yes` (live permission fact; quota) |
| `docs/*`, `README.md` | Modify | modes, limits, what research can and cannot guarantee |
| `test/caller.test.ts`, `test/modes/*.test.ts`, `test/engine-modes.test.ts` | Create | per §5 |

## 4. Implementation TODO

- [ ] Reviewer approval **and Security design sign-off** (before any edit).
- [ ] **Commit 0 — characterization:** pin `callReadOnly` behaviour (existing suites + a few added cases for the corrective/max-turns/abort/limit paths) before extraction.
- [ ] **Commit 1 — `callAgent` extraction** (zero behaviour change) + `buildClaudeArgs` snapshot.
- [ ] **Commit 2 — ask store + snapshot + Quick Ask (answer path) + API/UI skeleton.**
- [ ] **Commit 3 — fast path for S changes + convert-to-work + limits.**
- [ ] **Commit 4 — live research-profile permission probe (opt-in; quota).** If it fails: stop research here and report; otherwise continue.
- [ ] **Commit 5 — research profile + predicate + citations + report schema + UI + docs.**
- [ ] Reviewer code review + Security review; checkpoint commit.

## 5. Testing Strategy

- **Characterization/extraction:** all engine-plan/limit/safety/loop/regress/matrix tests unchanged; `buildClaudeArgs('plan'|'review'|'verify')` snapshot; new cases for each loop branch of `callAgent`.
- **Quick Ask:** snapshot contents (no `.git`, planted `.env` and dirty file absent, symlink in repo not followed, size cap), scratch deleted on success/failure/abort, tier label, answer/change schema, fast-path matrix (S + unprotected ⇒ auto; protected/M/L/no files ⇒ offered), fast path still builds through the envelope and verifies (hook/guard tests reused), no approval skipped for protected paths.
- **Research:** predicate exact-set both ways per profile; forged init with extra tool ⇒ isolation stop; default empty cwd; repo-aware requires the flag; citation integrity (observed vs forged vs non-http), the model cannot restore `unverified`; report sanitising (script tags, `javascript:` URLs, huge text, prototype keys); seeded card `untrusted`; router refuses Codex/Cursor; offline refusal; per-day limit; one-at-a-time.
- **API:** strict bodies, id traversal, CSRF/cross-site, limits (429), convert idempotency, corrupt record quarantine.
- **Live (opt-in, stated):** `doctor --research-probe` against the real Claude to verify the `dontAsk` permission fact; the Cursor/Claude live suites unchanged. **Not run unless the user allows quota:** a full real Deep Research.

## 6. Risks and Dependencies

- **Web content as an injection and exfiltration channel:** mitigated by tools without Bash/Edit/Write/MCP, an empty scratch cwd by default, the credential deny-list, structural citation checks, untrusted rendering, forced approval for seeded work; **residual:** a repo-aware opt-in can leak repository content in URLs — said in the UI and docs.
- **The `dontAsk` + web tools assumption may be false:** the plan makes verifying it the first research step and stops rather than widens.
- **Snapshot cost:** `git archive` of a large repo; capped and refused beyond the limit.
- **Claude-only research:** a single provider; documented.

## 7. Requirement Coverage Matrix (M5 slice)

| Requirement | Coverage |
| --- | --- |
| §6 Mode A retrieve relevant context, select CLI, respond/execute with minimal overhead, avoid unnecessary hierarchies | Covered (snapshot + pack + one call; S fast path); beyond S → normal Engineering Work |
| §6 Mode B | Covered by M1–M3 |
| §6 Mode C gather information, consult online sources, compare alternatives, evaluate evidence, structured report with citations and recommendations | Covered **if** the permission fact verifies (else not delivered) |
| §6 convert findings into an executable plan | Covered (untrusted-seeded card, forced approval) |
| §6 make clear when online access is unavailable; distinguish verified from assumptions | Covered (offline refusal/labels; structural verified/unverified split) |
