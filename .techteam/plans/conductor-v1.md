# Implementation plan — Conductor v1 (revision 2.1)

Planning only. No source is edited while this file is draft, pending review, or changes-requested.

- Task / Linear issue: none (no Linear connector in this session; tracked in `.techteam/runs/active-run.md`)
- Author (Lead or planner): TechTeam Lead
- Date: 2026-10-20 (rev 2.1 = rev 2 + Reviewer round-2 items B1–B5 + selected non-blocking items; round-1 RC1–RC11 resolved per review file)
- Plan status: **approved** (Reviewer round 3, 2026-10-20 — `.techteam/reviews/conductor-v1-plan-review.md`, Decision: Approved). Binding carry-forwards **C1–C6** at the end of this file.

## Round-2 amendments (Reviewer B1–B5) — where applied

| Item | Resolution | Where |
| --- | --- | --- |
| B1 init predicate | fail-closed rule now `tools=={Read,Grep,Glob,StructuredOutput}` ∧ `mcp_servers==[]` ∧ `skills==[]` ∧ `slash_commands==[]` ∧ `permissionMode=="dontAsk"`; `plugins`/`agents` informational; real init events (with/without `--json-schema`) captured as fixtures | §2 Isolation, §5 |
| B2 baseline masking | failure-set comparison where parsable, else gate marked `baseline-failing, unverified for regressions`; failing gate re-run once (flake guard) | §2 Verification integrity, §5 |
| B3 destructive reset | backup ref before any reset; `backlog/triage` = park, only `unstarted` re-runs/picks up; sub-issues never carry trigger label and poller ignores issues whose parent is a Conductor run | §2 resume matrix, §5 |
| B4 authz / no-push / R6 | `IssueHistory` attribution checks; credential/SSH/prompt neutralisation + **live-proven** `Shell(git:push*)` deny; cli.json hash guard; R6 re-worded to defence-in-depth | §2 Isolation, Secrets, §5, §7 |
| B5 R4 honesty | Cursor half **deferred by decision** (route exists: Cloud Agents / My Machines) — final report asks the user to accept/reject; S1 runnable now with user's go-ahead; S5 user check added | §2 Visibility, §4, §7 |

**One-line goal.** A local "Conductor" that takes a Linear issue through *Claude plans → Cursor builds → Claude verifies → bugs back to Cursor*, with one master dashboard, needing almost no manual work from the user.

**User intent.** Cursor agents (CLI, not IDE) + Claude Code; Claude better at analysis/plan/verify, Cursor faster at coding; a custom UI "master" to both; Linear as intermediary; see running tasks in the Cursor/Claude app; **least possible work, never "struggle with the agents"**.

## Revision log (Reviewer RC → resolution)

| RC | Resolution in this revision | Where |
| --- | --- | --- |
| RC1 trigger authz | `creator == viewer` only (server filter `creator:{isMe:{eq:true}}` **and** client re-check); assignee pickup opt-in w/ warning; only viewer-authored text feeds prompts; description hash snapshot; repos only from registered list | §2 Security, §5 |
| RC2 Claude isolation | **Empirically proven, zero quota**: `--safe-mode --tools "Read,Grep,Glob" --disable-slash-commands --strict-mcp-config --permission-mode dontAsk --permission-prompts none --max-turns N` ⇒ init shows tools=`[Glob,Grep,Read]`, mcp=`[]`, skills=0; session-transcript canary proves user CLAUDE.md absent. Fail-closed init check; repo conventions injected by Conductor (root files only). Ancestor scan. | §1, §2, §5 |
| RC3 Cursor isolation / no-push / cross-stage (historical — superseded by round-2 B4: no-push is defence-in-depth) | **Proven**: Cursor CLI loads `~/.cursor/rules` *and* ancestor `AGENTS.md`/`CLAUDE.md` (canary) — cannot be turned off ⇒ preamble + live negative assertions + doctor inventory. Diff-scope guard; structural no-push (`GIT_CONFIG_*` push-URL neutralisation, `.cursor/cli.json` deny rule, never `--approve-mcps`); local bare-remote test. | §2, §5 |
| RC4 secrets/env | Keychain via `security -i` stdin (file 0600 fallback), env allowlist per child, output redaction, deny rules, explicit threat model | §2, §5 |
| RC5 dashboard auth | OTP → HttpOnly SameSite=Strict cookie for **all** routes incl. GET/SSE; exact static whitelist; runKey-only open-actions; repo registration validated | §2, §5 |
| RC6 state machine | Source-of-truth rules, resume matrix, idempotent effect log, crash windows, single-instance lock, poll/backoff | §2 |
| RC7 verification integrity | Baseline gates on base SHA, `unverified` policy, commit hygiene, per-repo worktree mutex, `baseSha` | §2 |
| RC8 R4/R6 honesty | "Open in Claude app" = `claude --desktop --resume <id>` (flag verified present); cursor-cloud/My Machines **deferred to v1.1** (needs user's API key + consent to run `agent worker`); R6 re-scoped to defence-in-depth after round 2 (historical row) | §2, §7 |
| RC9 tests | AC→test table; Linear ops validated against vendored official `schema.graphql` with `graphql` `validate()`; negative tests; fixture provenance | §5 |
| RC10 completion honesty | Claude path qualified "fixture-only until post-reset live smoke"; explicit post-reset + user-run Linear smoke items | §5, §7 |
| RC11 hygiene | facts fixed (`--max-turns` exists; agent 2026.10.19; `--bare` reasoning; no TS warning); `docs/API.md`, lock, diff guard added; state types/colours specified | §1, §3 |

---

## 1. Current State

Greenfield repo `/Volumes/Sandisk/github/techteam-conductor` (empty; `git init` on `main`; user chose to stay on the checked-out branch). Only `.techteam/` planning artifacts exist.

**Verified facts (live probes on the user's Mac, 2026-10-20; ✔ = verified by me or Reviewer):**

| Fact | Evidence |
| --- | --- |
| ✔ Node 22.21.1 (type stripping on by default, **no warning emitted**), npm 10.9.4, git 2.49.0, arm64 macOS, `gh` present | `node -v`; Reviewer ran `.ts` test |
| ✔ `claude` 2.1.296; has `-p`, `stream-json`, `--verbose`, `--json-schema`, `--setting-sources`, `--safe-mode`, `--restricted`, `--tools`, `--disallowedTools`, `--permission-mode`, `--permission-prompts`, `--strict-mcp-config`, `--disable-slash-commands`, `--max-turns` (accepted but absent from `--help`), `-n`, `--desktop`, `--resume`, `--debug-file`. `--bare` exists but requires `ANTHROPIC_API_KEY` (user is on a claude.ai login) ⇒ **not used**. | `claude --help`; Reviewer |
| ✔ Plain `claude -p` leaks the user's whole setup: 7 MCP servers (incl. **claude.ai Linear**), 192 skills, 116 agents, 35 plugins; transcript contains the user's TechTeam CLAUDE.md. `--setting-sources project,local` removes user CLAUDE.md/skills/agents/plugins but **claude.ai connectors remain** and project CLAUDE.md loads. `--safe-mode` ⇒ mcp 0, builtin-only, project CLAUDE.md not loaded. `--safe-mode --tools "Read,Grep,Glob" --disable-slash-commands --strict-mcp-config --permission-mode dontAsk --permission-prompts none` ⇒ `tools=[Glob,Grep,Read]`, `mcp=[]`, `skills=0`. | live init-event + `~/.claude/projects/*.jsonl` canary grep (all zero-quota) |
| ✔ Claude `-p` currently rejected for all models: `rate_limit_event{status:"rejected",rateLimitType:"seven_day",resetsAt:1792587600}` = **2026-10-21 14:00 BST**; result `{is_error:true,api_error:"usage_limit_reached"}`. Account is Claude Pro ⇒ the weekly cap **will recur**. | live stream-json |
| ✔ `agent` (Cursor CLI) 2026.10.19-6bbf2c4 (earlier probes ran 2026.10.14), logged in. `agent -p --force --trust --output-format stream-json --workspace <dir> "<prompt>"` created a file live. Events: `system/init`, `user`, `thinking{delta,completed}`, `assistant`, `tool_call{started,completed; editToolCall/…}`, `result{usage…}`. `--mode plan\|ask` is read-only. | live runs; `agent --help` |
| ✔ **Cursor CLI loads user-level rules and ancestor files**: with canaries in `<anc>/AGENTS.md`, `<repo>/CLAUDE.md`, `<repo>/AGENTS.md` and 7 `.mdc` rules in `~/.cursor/rules`, the model reported `TT=YES; CANARIES=all three`. Not disable-able by a flag. | live ask-mode probe |
| ✔ Docs: Claude Desktop Code tab lists only Desktop-run sessions; `claude --desktop --resume <session-id>` opens a CLI session in the Desktop app (macOS, subscription login). Cursor cloud agents (SDK/API/Linear) appear in the Agents window; whether local CLI chats appear is unconfirmed. `agent worker` = "My Machines" (cloud agent loop, local tool calls, routed by git remote; `POST /v1/agents` with `env.type:"machine"`). | code.claude.com, cursor.com docs; Reviewer |
| ✔ Linear (SDK v98 generated types): `WorkflowStateCreateInput{color,name,teamId,type,position?}`; `IssueLabelCreateInput{name,color?,teamId?}`; `IssueFilter.creator:NullableUserFilter{id,isMe}`; `StringComparator{eq,in,nin,…}`; `IssueUpdateInput{stateId,addedLabelIds,removedLabelIds}`; `IssueCreateInput{teamId,title,description,parentId,labelIds,stateId,projectId}`; `CommentCreateInput{issueId,body}`. Official SDL: `linear/linear/packages/sdk/src/schema.graphql` (1.35 MB, MIT) ⇒ can be vendored for `graphql.validate()` tests. Auth header `Authorization: <personal key>`; rate limit ≈2,500 req/h/user shared across keys. | SDK types; docs; Reviewer |
| ✔ **Live no-push / secrets probes on Cursor 2026.10.19 with `--force`** (throwaway local bare remotes): baseline agent **pushed** and **read a file outside the workspace**. `.cursor/cli.json` **requires both `allow` and `deny` arrays**; `{"allow":[],"deny":["Shell(git:push*)"]}` **blocked the push** ("Command blocked by permissions configuration"), while the exact form `Shell(git:push)` did **not**. Env `remote.origin.pushurl` neutralisation blocked a named-remote push but **an explicit-URL push still succeeded**. `--sandbox enabled` blocked **neither** push nor outside read. `Read(path)` deny rules do **not** stop a shell `cat` ⇒ secrets cannot be protected from a `--force` builder by deny rules. | live runs `/private/tmp/claude-501/s3*` |
| ✔ Prompt on **stdin** works for both CLIs (Claude: transcript marker; Cursor: `STDIN-CURSOR-OK`). Keychain write/read/delete via `security -i` stdin works with a dummy item (cleaned). Cursor builder, unprompted, **read `~/.cursor/skills/techteam-ops/SKILL.md`** and announced "Using SoftCo Lead" ⇒ user rules actively steer it; `~/.cursor/rules` has **7** `.mdc` files. | live probes |
| Real Cursor event shapes captured on 2026.10.19 (`globToolCall`, `getMcpToolsToolCall`, `readToolCall`, `editToolCall`, `shellToolCall`; `result.usage`); ask-mode JSON arrives as prose + fenced block ⇒ `extractJson` must tolerate leading prose. | `/private/tmp/claude-501/fixtures-raw/` |

**Current problems.** (a) no bridge/state between the two CLIs; (b) user's global rules, MCP servers and plugins hijack headless agents; (c) Claude quota exhausted until 2026-10-21 14:00 BST and recurring; (d) headless runs aren't in the apps' lists; (e) Linear is a shared workspace ("Bargainn Services") — other people can assign issues and change workflow.

## 2. Expected State

**Product.** `techteam-conductor`: one local Node process (zero runtime deps), dashboard on `127.0.0.1:4317`.

```
Todo + label "conductor" ─claim→ Planning ─→ [Plan Ready]* ─→ Building ─→ Verifying ─→ Ready for Review
(created by viewer only)           Claude      (first run per      Cursor      Claude      (human merges; nothing pushed)
                                   +review      repo / manual)        ▲           │ fail → bug sub-issues
                                                                     └───────────┘ (max 3 loops → Needs Human)
```

### Stages
1. **Plan** (Claude, read-only): runs in an isolated git worktree at `baseSha`. Schema JSON plan (current/expected state, AC with verification, files, steps, testing, risks, coverage matrix, `complexity`). **Plan review** (second Claude pass, independent prompt) only for complexity M/L; ≤1 revision. Plan → Linear comment + untracked `.conductor/plan.md`.
2. **Build** (Cursor CLI `--force --trust`, worktree cwd): builder prompt declares plan *approved by Conductor*; Conductor (not the agent) commits after hygiene checks.
3. **Verify**: deterministic **gates** (baseline-compared) → Claude read-only verifier (AC→evidence, bugs) → verdict. Gate regression overrides "pass". `blocker|major` bugs → `conductor-bug` sub-issues (deduped across loops) → Build(fix). Pass → close sub-issues, `Ready for Review`. **No push/PR/merge.**
4. **Humans only when needed**: `Needs Human` with exact question/evidence; first run per repo pauses at `Plan Ready` (one click; configurable).

### Linear integration modes (decided: non-invasive default)
- `linear.mode: "labels"` (**default**): no workflow change on the shared team. Native state: `In Progress` (first `started` state) while active; `In Review` if the team has it, on pass. Stage shown via labels `conductor:planning|plan-ready|building|verifying|needs-human|ready` (add/remove with `addedLabelIds/removedLabelIds` — never clobbers human labels). Trigger label `conductor`; bug label `conductor-bug`. Labels reused if they already exist at team **or** workspace level. `Needs Human` leaves the issue `In Progress` with label `conductor:needs-human`. If label creation fails for permission reasons the UI shows the exact manual list to create (`conductor`, `conductor-bug`, `conductor:planning`, `conductor:plan-ready`, `conductor:building`, `conductor:verifying`, `conductor:needs-human`, `conductor:ready`) and retries on demand.
- `linear.mode: "states"` (opt-in button, previews exactly what is created): statuses `Planning`(started,#8b5cf6) `Plan Ready`(started,#f59e0b) `Building`(started,#3b82f6) `Verifying`(started,#06b6d4) `Needs Human`(started,#ef4444) `Ready for Review`(started,#22c55e).
- Human signals (both modes): native state *type* `unstarted` (drag to Todo) = "retry/re-plan" (`backlog`/`triage` = park); `completed/canceled` = abort; comment line `/approve` (viewer-authored) or dashboard button = approve plan.

### State machine specification (RC6)
- **Authoritative sources.** Linear: existence, trigger label, creator, native state type, title/description (hash), viewer-authored comments, `/approve`. Local store: run status/stage/loop, sessions, `baseSha`/`commitSha`, effect log, costs, `pausedUntil`, and `expected` (last Linear state/labels Conductor wrote — used to tell human edits from its own).
- **Single instance.** `~/.conductor/run/lock` (O_EXCL + pid liveness) + port bind; second instance exits with "already running — `conductor open`". Dev copy and launchd service cannot double-pick.
- **Claim.** run dir created atomically (`O_EXCL`) under the lock before any Linear write; claim idempotent.
- **Resume matrix**

| Local status | Observed in Linear / UI | Action |
| --- | --- | --- |
| none | viewer-created, label present (added by viewer — see attribution), **state type `unstarted` only** (Todo); issue is not a sub-issue of a Conductor run | create run `queued` (write-ahead) → claim. `backlog`/`triage` issues are never picked up (they are "parked") |
| queued / running | completed, canceled, deleted, trigger label removed | abort: SIGTERM→SIGKILL process group; `aborted`; (one comment unless deleted) |
| running | moved to **`backlog`/`triage`** ("park") | abort stage and **hold** (`status: parked`); no re-queue, no destructive git action; resumes only when moved to `unstarted` (then as the next row) |
| running | moved to **`unstarted`** ("re-run") | abort stage; **write backup ref `refs/conductor/<key>/prev-<rev>` at the current HEAD**, then worktree `reset --hard baseSha`; re-queue at **plan**, rev+1, new viewer comments included |
| running | description hash changed | abort → `needs_human` ("description changed — move to Todo to re-plan") |
| running | other state/label edits | ignore; re-asserted at next stage transition |
| awaiting_approval | `/approve` or dashboard approve | → build |
| awaiting_approval | moved to `unstarted` | re-plan rev+1 with comments (backup ref first if any commits exist) |
| awaiting_approval / needs_human / ready | moved to `backlog`/`triage` | park (hold; no action) |
| needs_human | moved to `unstarted` | retry **origin stage**; keep committed work, discard uncommitted (backup ref first); if origin was loop-cap: budget += `maxLoops`; plan origin → re-plan |
| needs_human | completed/canceled | finish/abort |
| paused (provider limit) | — | auto-resume at `pausedUntil`; dashboard "resume now" |
| ready | moved to `unstarted` | rework: plan rev+1, keep branch/commits (backup ref), loop reset |
| ready | completed | `finished` (offer cleanup) |
| failed (infra: Linear/disk) | — | retried by poll with backoff; visible in dashboard |

- **Sub-issues & first-approval.** Bug sub-issues are created in an explicit `unstarted` state (never the team default, so they don't land in a shared Triage inbox), carry only `conductor-bug` (**never** the trigger label), and the poller ignores any issue whose `parent` is a Conductor run. "First plan per repo needs approval" is persisted in `~/.conductor/state.json` (`repos[name].approvedPlans`); plans of `complexity:"L"` always require approval.
- **Attribution (RC1 residual).** At claim and at every stage boundary: via `issue.history` verify the trigger label was added by the viewer (`actorId`/`addedLabelIds`) and every `descriptionUpdatedBy` is the viewer; otherwise the issue is ignored (before claim) or goes `needs_human` (mid-run). Description hash still detects later edits.
- **Idempotent effects.** Every Linear write has key `<runId>:<stage>:<loop>:<kind>[:n]`: (1) write-ahead `pending` intent in `run.json`; (2) search Linear for the visible footer marker `conductor-ref: <key>` (comments) / description footer (sub-issues); (3) create only if absent; (4) mark `done`. Bug sub-issues deduped by fingerprint `sha1(normalised title + file)` across loops: still failing → comment on the existing one; fixed-then-regressed → reopen.
- **Crash windows** (each with a test): agent-exit→commit (dirty worktree + recorded success ⇒ commit; else reset to last Conductor commit and rerun); commit→Linear (replay effects idempotently); comment→store (marker lookup adopts).
- **Poll.** default 30 s (min 15 s) + jitter; HTTP 429/`RATELIMITED` ⇒ exponential backoff ≤10 min honouring `Retry-After`; comments fetched only for active runs.
- **Timeouts.** wall-clock deadlines (not timers); sleep-gap detection resets idle clock; `caffeinate -i -w <pid>` while runs are active. Idle 10 min, hard caps plan 20 / review 10 / build 90 / verify 30 min; one retry on hang then `needs_human`.

### Verification integrity (RC7)
- Gates (auto-detected: typecheck, lint, test per pnpm/yarn/bun/npm; pytest; go; cargo) run on **`baseSha` first** → `baseline.json`. Comparison is on **failure sets**, not gate status: where runner output is parseable (node:test/TAP, jest/vitest JSON or summary, pytest `-rf`, go `-json`, cargo, tsc/eslint error lines) the *set* (names or `file:line:code`) is diffed — **new failures = regressions** even if the gate already failed at baseline. Where output is not parseable the gate is marked `baseline-failing, unverified for regressions`; that is stated to the verifier and in the Linear comment, and a lone count increase is still treated as a regression. A failing gate is **re-run once** before a regression is declared (flake guard).
- **No gates detected** ⇒ run flagged `unverified` (banner in Linear + dashboard; policy `noGates:"warn"|"block"`), never a silent pass.
- Commit hygiene: copied env files and installed deps are git-excluded (`git rev-parse --git-path info/exclude`); size (>5 MB) and secret-pattern guard before commit → `needs_human` instead of committing; `commit.gpgsign=false`, `user.name/email` only supplied via `-c` if unset; repo hook failure = feedback into the fix loop (never hang, never `--no-verify`); per-repo mutex around `git worktree add`; `baseSha` recorded; **no auto-fetch** (base ref per repo configurable).
- Diff-scope guard after Build: changes to `.claude/** .cursor/** .mcp.json AGENTS.md CLAUDE.md GEMINI.md .github/** .husky/** .git* .techteam/** .conductor/**` ⇒ `needs_human` unless the approved plan lists them.

### Isolation (RC2/RC3)
- **Claude stages** (plan, review, verify): argv fixed by `claude.ts`: `--safe-mode --tools "Read,Grep,Glob" --disable-slash-commands --strict-mcp-config --permission-mode dontAsk --permission-prompts none --max-turns <n> -n "conductor <key> <stage>" --output-format stream-json --verbose --json-schema <schema>`, prompt on **stdin**, env scrubbed + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. No Bash ⇒ gates run outside; verifier reads `.conductor/diff.patch` and files. `--max-turns`: plan 40, plan-review 25, verify 40; `error_max_turns` ⇒ retry once with +50 %, then `needs_human` (never converted into a "fail" verdict). Repo conventions: Conductor injects root `CLAUDE.md`/`AGENTS.md` (≤16 KB, root only, labelled untrusted data).
  **Fail-closed predicate (B1, matches the real init event on this Mac):** abort the stage unless `set(tools) == {Read,Grep,Glob,StructuredOutput}` ∧ `mcp_servers == []` ∧ `skills == []` ∧ `slash_commands == []` ∧ `permissionMode == "dontAsk"`. `plugins` (35 installed-but-disabled + 3 builtin are *always* listed under `--safe-mode`) and `agents` (5 builtin) are **informational only** (recorded in the run). Real init events — with and without `--json-schema` — are captured as fixtures; `claude-init-failclosed` and `doctor --isolation` assert the predicate against them. Fallback `isolation:"setting-sources"` (older CLIs) uses the same predicate, so leaked MCP/skills abort the stage.
- **Cursor stages** (build; optional read-only fallback with `--mode ask`): leakage cannot be disabled ⇒ (i) pipeline preamble stating Conductor-approved plan and that it overrides any rule demanding planning gates/Reviewer/Linear/sub-agents; (ii) `doctor` inventories `~/.cursor/rules` + ancestor instruction files and warns; (iii) worktree root default `<repo-parent>/.conductor-worktrees/<repo>/<key>`, with **runtime ancestor scan** (warn + `worktreeRoot` override) instead of the old "outside $HOME" assumption; (iv) live negative assertions (AC7).
- **No-push — defence in depth, same-user threat model (B4).** *Live-proven layers* (see §1): (1) worktree-local `.cursor/cli.json` (written only if absent, git-excluded) = `{"permissions":{"allow":[],"deny":["Shell(git:push*)","Shell(gh:*)","Shell(security:*)","Shell(osascript:*)","Shell(sudo:*)"]}}` — `allow` array is mandatory, the `*` glob form is mandatory, **blocks pushes even under `--force`**; (2) agent env: `GIT_CONFIG_COUNT/KEY/VALUE` neutralising `remote.<each>.pushurl`, blanking `credential.helper`, `GIT_SSH_COMMAND=/usr/bin/false`, `GIT_TERMINAL_PROMPT=0` (stops credentialed/SSH pushes incl. to explicit URLs, but alone does not stop an explicit-URL push to a local/path remote); (3) prompt rule; (4) never `--approve-mcps`. `--sandbox` is **not** used as a control (proven ineffective for push/read). **Guard for layer 1:** SHA-256 of `.cursor/cli.json` recorded before Build and re-checked after (it is git-excluded, so the git diff guard cannot see it); mismatch ⇒ `needs_human`. If a *tracked* `.cursor/cli.json` already exists and the deny rule cannot be written, `doctor` and the run banner say **"no-push is env-only for this repo"**. AC7 uses an **adversarial prompt** instructing pushes to both the named remote and an explicit URL and reports the outcome either way.

### Secrets, env, redaction (RC4)
- **Threat model.** In scope: web pages (CSRF/DNS-rebinding), other OS users, teammates via Linear, accidental leaks into Linear/logs, prompt-injection in issue text (reduced, not removed). Out of scope: a malicious same-user process (a `--force` builder can `cat` anything the user can — **proven live**; `Read()` deny rules do not cover shell reads) — mitigations (Keychain, env scrubbing, redaction, `Shell(security:*)` deny, keeping secrets out of the worktree) reduce accidents only. Stated plainly in README.
- Linear key in **macOS Keychain** via `security -i` (key via stdin, never argv); `0600` file fallback; `LINEAR_API_KEY`/`CURSOR_API_KEY` env override. Children get an **allowlisted env** (`PATH HOME USER LANG LC_* TERM TMPDIR SHELL`); `ANTHROPIC_*`/`CLAUDE_CODE_*` only to claude spawns; `CURSOR_*` only to cursor spawns; gates/deps get minimal env + repo `env.passthrough`.
- **Redaction** of every agent-derived string before Linear/dashboard/logs: exact values from copied env files (≥8 chars) + token regexes (`lin_api_`, `sk-`, `ghp_`, `AKIA`, `xox[bp]-`, JWT).

### Dashboard security (RC5)
- Bound to `127.0.0.1`; `Host` must be `127.0.0.1:<port>`/`localhost:<port>`. Auth: `conductor open` (via `0600` control socket) mints a **single-use OTP URL (60 s)** → `/auth?otp=…` sets an **HttpOnly, SameSite=Strict random session cookie** → every route (GET, SSE, API) requires it; only `/login` (static hint) and `/auth` are public. Mutations additionally require `Content-Type: application/json`, same-origin (`Sec-Fetch-Site: same-origin` or exact `Origin`; missing both ⇒ reject) and `X-Conductor-CSRF`. Headers: CSP `default-src 'self'`, `Referrer-Policy: no-referrer`, `nosniff`, `no-store`. Static serving = exact whitelist of 3 files (no directory serving ⇒ no traversal). Body ≤1 MB.
- Open-actions accept only `{runKey,target}`; paths computed server-side from the run record; session ids validated as UUID; `execFile` with `--`; Terminal commands built with a single-quote escaper and fuzz-tested. Repo registration: `git rev-parse --show-toplevel` must equal the realpath; reject `/`, `$HOME`, `~/.conductor`.

### Least-work UX & visibility (R4/R5 honest)
- `npm start` (no install) → browser opens signed-in → in-UI Setup: paste Linear key → pick team → (labels auto-created) → add repo (gates auto-detected) → optional agent probe. Target **≤5 manual steps to first task** (measured, recorded).
- Resilience: usage-limit detection (stream `rate_limit_event`/`api_error`) ⇒ **pause, not fail**, notify, auto-resume at `resetsAt`; opt-in `onClaudeLimit:"cursor"` runs read-only stages on Cursor (`--mode ask`, JSON-in-text). Crash recovery; per-issue cap `maxAgentRunsPerIssue=10`; per-stage models; header shows Claude 7-day utilisation.
- **Visibility matrix (shown in README + UI):** Linear — everything; Dashboard — master live view for both agents; **Claude app** — "Open in Claude app" = `claude --desktop --resume <id>` (flag verified present in `--help`; sessions are kept resumable, never `--no-session-persistence`; end-to-end check = spike S1, runnable now on an existing probe session id once the user allows the Desktop app to open); **Cursor app** — no verified native listing of local `agent` CLI chats; "Open worktree in Cursor" and a copyable `agent --resume <id>` are provided. **The Cursor-app half of R4 is deferred to v1.1 by decision (a platform route exists: Cursor Cloud Agents / My Machines via `agent worker` + `POST /v1/agents` with `env.type:"machine"`); it needs the user's API key, a hosted git remote and consent to run `agent worker` — the final report asks the user to accept or reject this deferral.** User-run check **S5** (1 minute, decides whether v1.1 is needed for the Cursor app): after any `agent -p` run, does the Cursor app list that chat?
- `conductor demo` = full pipeline on fakes (no keys/quota). `conductor service install|uninstall` (explicit; plist uses absolute paths for node/claude/agent/pm; `doctor` warns about `/Volumes` start-up timing). `conductor uninstall` removes launchd agent + keychain entry (never Linear labels/states — documented manual rollback).

**Must remain unchanged:** user repos' main branches/work trees; `~/.claude`, `~/.cursor`; Linear workflow (labels mode); nothing pushed/merged.

**Acceptance criteria** (AC12 cloud builder **removed** — deferred)
- AC1 `node bin/conductor.mjs start` on a clean copy (no `node_modules`) boots, binds only 127.0.0.1, `/api/state` 200 with session cookie, 401 without.
- AC2 Setup wizard completes entirely in the UI against a mock Linear GraphQL server (click-through).
- AC3 Happy path (FakeLinear + fake agents): Todo→claim→plan→build→verify→Ready; plan comment; commit on `conductor/<key>`; main checkout byte-identical.
- AC4 Fail path: bugs→sub-issues (deduped)→fix→pass→sub-issues closed; loop cap→Needs Human with evidence.
- AC5 Usage limit ⇒ `paused`, single comment, notification, auto-resume (injected clock); fallback option works.
- AC6 Isolation: Claude argv/init fail-closed checks + canary fixtures; `doctor --isolation` transcript-canary probe passes on real CLI; builder prompt asserts approved plan.
- AC7 **Live real-Cursor E2E** (all stages on Cursor; Linear faked) in a tmp repo with a local bare remote: correct diff/tests; **negative**: no extra files/commits/branches, no `.techteam/.cursor/.claude` artefacts, `git push` attempt leaves remote unchanged, no secret value appears in the diff, commit, Linear comment or logs (an outside-workspace read by a `--force` builder is documented, not asserted).
- AC8 Dashboard (board, detail, live log, approve/retry/abort/pause, new task) at desktop + 390 px, console clean, screenshots saved to `.techteam/runs/evidence/`.
- AC9 Security tests (see §5) pass.
- AC10 `tsc --noEmit` strict + `node --test` green; every AC mapped to ≥1 named test (table §5).
- AC11 `service install --dry-run` output passes `plutil -lint` and content assertions; never auto-run.

**Non-goals (v1).** PR/merge automation; Linear webhooks/Agent-app; multi-user; Windows/Linux; Cursor cloud/My Machines builder (v1.1); injecting headless sessions into app lists beyond the documented `--desktop --resume`.

**Alternatives considered.** Cursor's native Linear integration (assign issue to Cursor ⇒ cloud agent + PR) is simpler but needs a hosted git remote, usage-based pricing, and has no Claude plan/verify loop or master UI; Linear Agent-app mode needs a public webhook URL and is a developer preview.

## 3. Files to Be Changed

All **Create**. `src/` is TypeScript run by Node type stripping (erasable syntax only, `.ts` specifiers). Runtime deps: none. devDeps: `typescript`, `@types/node`, `graphql`.

| File path | Action | Purpose | Required changes | Reason |
| --- | --- | --- | --- | --- |
| `package.json`, `tsconfig.json`, `.gitignore`, `.nvmrc` | Create | meta; scripts `start demo test check`; `engines.node>=22.18` | strict + `erasableSyntaxOnly` | AC1, AC10 |
| `bin/conductor.mjs` | Create | entry + Node-version guard | friendly error | AC1 |
| `src/types.ts` | Create | contract: Run, Plan, Verdict, Effect, Event, Config, ports | single source of truth | all |
| `src/config.ts`, `src/secrets.ts` | Create | config load/save/validate; Keychain (`security -i`) + 0600 file store; env allowlist builder | RC4 | AC9 |
| `src/log.ts`, `src/notify.ts`, `src/redact.ts` | Create | logger; osascript-argv notifications; secret redaction | RC4 | AC5, AC9 |
| `src/lock.ts` | Create | single-instance lock + control socket | RC6 | AC1 |
| `src/store.ts` | Create | atomic run store, effect log, ndjson events, pub/sub | RC6 | AC3–AC5 |
| `src/agents/spawn.ts` | Create | argv-only spawn, process-group kill, NDJSON parse, wall-clock/idle timeouts, sleep-gap | robustness | AC5 |
| `src/agents/json.ts` | Create | `extractJson` + mini JSON-schema validator | provider-agnostic structured output | AC3 |
| `src/agents/claude.ts` | Create | isolated argv builder, init fail-closed check, normaliser, limit detection | RC2 | AC5, AC6 |
| `src/agents/cursor.ts` | Create | argv builder (+no-push env, cli.json deny), normaliser, limit detection | RC3 | AC7 |
| `src/agents/provider.ts` | Create | per-stage routing + limit fallback ports | R7 | AC5 |
| `src/git/worktree.ts` | Create | worktree (mutex, baseSha, exclude, env copy, deps), commit hygiene, diff guard, ancestor scan | RC3, RC7 | AC3, AC7 |
| `src/git/gates.ts` | Create | detect/run gates; baseline compare | RC7 | AC3, AC4 |
| `src/linear/types.ts`, `client.ts` | Create | `LinearPort` + GraphQL client (pagination, 429 backoff, verbatim errors) | R3 | AC2, AC3 |
| `src/linear/ops.ts` | Create | all GraphQL documents in one file (so they can be validated) | RC9 | AC10 |
| `src/linear/fake.ts` | Create | in-memory `LinearPort` | demo/tests | AC3 |
| `src/linear/provision.ts` | Create | idempotent labels/(states) provisioning; mode handling | RC11 | AC2 |
| `prompts/*.md`, `src/pipeline/prompts.ts` | Create | plan, plan-review, build, fix, verify templates + preamble | quality, R8 | AC6 |
| `src/pipeline/schemas.ts` | Create | plan / review / verdict schemas | structured output | AC3 |
| `src/pipeline/stages.ts` | Create | plan, review, build, verify | core | AC3–AC4 |
| `src/pipeline/engine.ts` | Create | poll/reconcile, resume matrix, pool, pause, recovery, repo mapping, effects | RC6 | AC3–AC5 |
| `docs/API.md` | Create | frozen HTTP/SSE contract (UI ↔ server) | RC11 | AC8 |
| `src/server/http.ts`, `api.ts`, `auth.ts`, `open.ts` | Create | server, routes, OTP/session/CSRF, whitelisted open-actions | RC5 | AC8, AC9 |
| `ui/index.html`, `app.js`, `style.css` | Create | dashboard + setup wizard (vanilla, responsive, light/dark) | R1 | AC8 |
| `src/doctor.ts`, `service.ts`, `demo.ts`, `cli.ts` | Create | health (+`--isolation`, `--probe`, `--linear`), launchd, demo, router (`start demo doctor open service uninstall clean`) | R5 | AC1, AC11 |
| `fixtures/fake-claude.mjs`, `fake-agent.mjs`, `fixtures/*.ndjson`, `test/fixtures/linear-schema.graphql`, canary repo | Create | scripted agents, captured events (versions recorded, PII scrubbed), vendored SDL | RC9 | AC3–AC7 |
| `test/*.test.ts` | Create | per §5 | verify | AC10 |
| `README.md`, `docs/ARCHITECTURE.md`, `docs/TROUBLESHOOTING.md`, `AGENTS.md`, `CLAUDE.md` | Create | quickstart ≤5 steps, visibility matrix, rollback/uninstall, repo rules | adoption | AC10 |
| `.techteam/runs/final-report-conductor-v1.md`, `.techteam/runs/evidence/*` | Create | final report (template) + screenshots/logs | honesty | R10 |

**Not touched:** other repos; `~/.claude`, `~/.cursor`; Linear workspace (until the user clicks setup); launchd (until `service install`).

## 4. Implementation TODO

- [ ] **P0** skeleton: `package.json`, `types.ts`, `config/secrets/log/redact/lock/store`, `bin`.
- [ ] **P1 agents**: `spawn`, `json`, `claude`, `cursor`, `provider` + fixtures (re-capture Cursor events on 2026.10.19, record versions, scrub PII); unit tests incl. canary + fail-closed init.
- [ ] **P2 git**: `worktree`, `gates` on real temp repos (mutex, exclude, hygiene, diff guard, baseline, ancestor scan).
- [ ] **P3 Linear**: vendor SDL; `ops.ts` + `validate()` test; `client` (mock GraphQL server), `fake`, `provision`; `FakeLinear`/client parity suite.
- [ ] **P4 pipeline**: prompts/schemas; `stages`; `engine` (matrix, effects, recovery, limit pause); full E2E suite with fake agents.
- [ ] **P5 server/UI**: freeze `docs/API.md`; Frontend specialist builds UI against a mock-API fixture in parallel while backend implements `server/*`; security tests.
- [ ] **P6 ops**: `doctor` (+`--isolation/--probe/--linear`), `service`, `demo`, `cli`, `notify`.
- [ ] **P7 proof**: `tsc --noEmit`; `node --test`; **live Cursor E2E** (AC7 incl. negatives); `doctor --isolation` on real Claude (zero/low quota); demo + browser screenshots (desktop/390 px, saved as evidence); spikes S1 and S5 (S2–S4 done in planning); independent **Reviewer code review + Security review**; fix findings; docs; final report with honest "not run" list.
- [ ] **Spikes.** *Done during planning (evidence in §1):* S2 stdin prompts (both CLIs ✔), S3 Cursor deny rules / sandbox / push bypass (live ✔), S4 Keychain via `security -i` (✔). *Remaining (P7):* S1 `claude --desktop --resume <session-id>` opens the session in the Desktop app (opens a window ⇒ needs the user's go-ahead; can run now on an existing probe session id); S5 user-run check of Cursor-app chat listing (see §2).
- [ ] **Post-reset checklist (≥ 2026-10-21 14:00 BST) — required before claiming R2/R7/R8 live:** `doctor --probe`, one real Claude plan+verify run, leakage canary on real Claude, `doctor --linear` read-only smoke run by the user with their key.
- [ ] Docs: README, TROUBLESHOOTING (usage limit, CLI hang, Linear permissions, rollback/uninstall).
- [ ] Error handling/logging: `~/.conductor/logs` (rotated, 14 days), per-run `events.ndjson`, redaction everywhere.

## 5. Testing Strategy

State the expected result for each critical test.

**AC → test traceability**

| AC | Named tests (files in `test/`) |
| --- | --- |
| AC1 | `boot-clean-copy` (copy repo w/o `node_modules` to tmp, spawn start, GET `/api/state` 401→200 with cookie, `lsof`-style bind check = 127.0.0.1 only); `lock-single-instance` |
| AC2 | `setup-wizard-e2e` (headless browser via Browser pane or fetch-driven API sequence against a **mock GraphQL server**; key stored, team chosen, labels created, repo added); `provision-idempotent` |
| AC3 | `engine-happy`, `worktree-isolation` (main checkout hash+status unchanged), `commit-hygiene` |
| AC4 | `engine-fail-loop`, `bug-dedupe-reopen`, `loop-cap-needs-human` |
| AC5 | `limit-pause-resume` (clock-injected, real captured `rate_limit_event` fixture), `fallback-cursor`, `no-retry-storm` |
| AC6 | `claude-argv` (exact flags incl. `--safe-mode --tools --max-turns --permission-prompts none`), `claude-init-failclosed`, `canary-fixture`, `doctor-isolation` (real CLI), `builder-preamble` |
| AC7 | `live-cursor-e2e` (opt-in `LIVE=1`; negative assertions listed above) |
| AC8 | `ui-smoke` (demo + browser screenshots desktop/390 px + console), `sse-stream` |
| AC9 | `api-security` (below), `secrets-env` (below), `open-actions-fuzz` |
| AC10 | `check:tsc`, `linear-ops-validate` (vendored SDL + `graphql.validate()` on every document in `ops.ts`), this table |
| AC11 | `service-plist` (`plutil -lint` + content assertions; dry-run only) |

**Unit:** `extractJson`/schema validator; Claude/Cursor normalisers on fixtures (Cursor: real captured; Claude: documented shapes + real `rate_limit_event` + error result); arg builders; repo mapping precedence (registered-only; label > project > single); gate detection; config defaults/masking; store atomicity; redaction (env values + token regexes); plist.
**Git integration (real temp repos):** worktree create at `baseSha`, mutex, `info/exclude`, env copy, commit hygiene (secret/size guard, hook failure, unset identity, gpgsign off), diff-scope guard, no-op diff, ancestor scan, cleanup; main checkout unchanged.
**Linear:** client vs mock server (auth header, pagination, 429 backoff, verbatim GraphQL errors); **every document validated against the vendored official SDL**; `FakeLinear`≡client parity suite.
**Engine E2E (fake agents):** happy; fail→fix→pass; loop cap; plan `blocked`; manual approval + `/approve`; every row of the resume matrix; idempotent effects (crash between comment and store ⇒ no duplicate); crash windows; limit pause/resume; abort kills process group; concurrency cap; double-pick impossible; foreign-created issue assigned to viewer ignored; foreign comment excluded from prompt; description hash change halts; external cancel aborts; `maxAgentRunsPerIssue`. Plus (round-2): `drag-to-backlog-parks` (no reset, no requeue), `reset-keeps-backup-ref` (`refs/conductor/<key>/prev-<rev>` resolves to the pre-reset HEAD), `subissue-never-picked` (child with parent=run and even a stray trigger label ignored), `label-added-by-teammate-ignored`, `description-edited-by-teammate-halts` (via `issue.history` fixtures), `baseline-masking` (baseline has 2 failing tests, builder adds 3 ⇒ regression reported with the 3 names), `flaky-gate` (fails once, passes on rerun ⇒ no regression), `claude-init-failclosed` against the **real captured init events with and without `--json-schema`** (accepts `StructuredOutput`, accepts 38 informational plugins; rejects a planted MCP server/skill/extra tool), `error-max-turns` (retry once +50 % then needs_human, never a fail verdict), `first-approval-persisted` and `complexity-L-always-approval`.
**API/security negatives:** GET without cookie → 401; wrong Host → 4xx; OTP reuse/expiry; missing CSRF/Origin/Content-Type → 403/415; cross-site `Sec-Fetch-Site` → 403; static `..`, `%2e%2e`, symlink → 404; SSE needs cookie; body >1 MB → 413; open-actions reject unknown runKey / bad uuid / injected path; Terminal-quote fuzz (`' " $() ; newline`); repo registration rejects `/`, `$HOME`, `~/.conductor`, non-git, bare; secrets never in responses/logs.
**Secrets/env:** fake agent dumps env and reads `~/.conductor/**` ⇒ finds neither key; redaction removes planted `.env` values from Linear comment bodies; Keychain smoke (dummy account, cleaned).
**Live (opt-in, real CLIs):** AC7 on Cursor 2026.10.19 (plan/review/verify via `--mode ask`, build `--force`) incl. negatives; `doctor --isolation` on real Claude (canary transcript grep, works at zero/low quota); real Claude plan+verify after quota reset. AC7 additionally: **adversarial prompt** telling the builder to push to the named remote *and* an explicit URL, then to `cat` a planted secret outside the workspace — reported either way; assert remote unchanged, `.cursor/cli.json` SHA unchanged, and (documented, not asserted) that the outside read succeeds because deny rules do not cover shell reads.
**Build/lint/type:** `tsc --noEmit`. **Config validation:** `doctor` on this Mac; `plutil -lint`.

## 6. Risks and Dependencies

- **Claude quota** exhausted until 2026-10-21 14:00 BST and recurrent on Pro ⇒ live Claude E2E blocked today; mitigated by fixtures built from observed `rate_limit_event`/init shapes, pause/auto-resume, optional Cursor fallback, per-issue run cap, utilisation display; **R2/R7/R8 are reported "Claude half fixture-only" until the post-reset checklist passes** (or the user accepts the gap).
- **Cursor cannot be isolated from user rules/ancestors** ⇒ preamble + live negatives + doctor inventory; residual: model may still follow a rule; guarded by diff-scope guard, no-push, and verification.
- **Linear not live-tested** (no key): operations validated against the official SDL; first contact is read-only (`viewer`/`teams`); every GraphQL error shown verbatim; user-run `doctor --linear` smoke is a completion item.
- **Shared Linear workspace**: labels-only default; creator-only trigger; states mode opt-in with preview.
- **`--force` builder** can run arbitrary commands in the worktree: only user-registered repos; creator-only issues; no push by Conductor and builder no-push as defence-in-depth (live-proven deny rule + env); redaction; same-user threat model stated.
- **Prompt injection** via issue/repo text: reduced (viewer-only text, fenced untrusted sections, read-only verifier, diff guard), not removed.
- **Cursor no-push** — deny syntax `Shell(git:push*)` now **proven live**, `--sandbox` proven ineffective (not relied on). Still unproven: prefix-glob bypasses (`git -c k=v push`, `/usr/bin/git push`, `env git push`, `sh -c 'git push'`) and the extrapolated denies (`gh`, `security`, `osascript`, `sudo`) ⇒ asserted in AC7 or labelled unproven in the report.
- **Beta/changing CLIs** (flag drift: `--max-turns` hidden from help): `doctor` reports versions; argv builders unit-tested; fixtures record CLI versions.
- **Sleep/wake, `/Volumes` drive, launchd PATH**: wall-clock deadlines + `caffeinate`; absolute paths in plist; `doctor` warning.
- **Node ≥22.18** guard. **Costs** on Claude Pro / Cursor usage: caps and visibility; defaults `maxParallel=2`, `maxLoops=3`.
- Assumptions (recorded): trigger label `conductor`; labels mode default; first run per repo requires plan approval; base ref per repo, no auto-fetch; no PR/merge; stay on `main` (user choice).
- Unresolved/optional (not blocking): PR creation; Linear Agent-app/webhook mode; Cursor Cloud/My Machines builder (v1.1).

## 7. Requirement Coverage Matrix

| Requirement | Planned change | Verification | Status |
| --- | --- | --- | --- |
| R1 One master UI for Claude + Cursor | `server/*`, `ui/*`, normalised events from both adapters | `ui-smoke`, `sse-stream`, normaliser tests | Covered |
| R2 Claude plan → Cursor build → Claude verify → bugs loop | `stages`, `engine`, prompts, schemas | `engine-happy/fail-loop/loop-cap`; `live-cursor-e2e` (Cursor half live) | Covered — **Claude half fixture-only until post-reset live smoke** |
| R3 Linear as intermediary | `linear/*`, labels/states modes, comments, sub-issues, effects | `linear-ops-validate` (official SDL), client↔mock, parity, engine E2E | Covered — **live Linear unverified until user `doctor --linear`** |
| R4 See runs in Cursor/Claude app | dashboard live view; `claude --desktop --resume` action; "Open worktree in Cursor", resume commands; honest matrix | S1 (Claude bridge), S5 (user check), UI test, README matrix | **Claude half:** documented bridge `claude --desktop --resume`, verified via S1 / post-reset. **Cursor half: deferred to v1.1 by decision** (route exists: Cloud Agents / My Machines); **requires the user's explicit acceptance in the final report** |
| R5 Least work | in-UI setup, gate/repo auto-detect, demo, service, doctor | `setup-wizard-e2e`; measured steps-to-first-task ≤5; `doctor` | Covered |
| R6 Safe / local only | no push/PR/merge by Conductor; builder no-push **defence-in-depth** (live-proven `Shell(git:push*)` deny, env neutralisation, cli.json hash guard, prompt); worktrees, argv-only spawn, loopback+OTP+CSRF, keychain, env scrubbing, redaction | `api-security`, `secrets-env`, `live-cursor-e2e` adversarial negatives (named-remote **and** explicit-URL push), `worktree-isolation` | Covered as defence-in-depth under a same-user threat model (outside-file reads by a `--force` builder are **not** preventable; documented) |
| R7 Claude usage-limit handling | detection → pause/notify/auto-resume/fallback | `limit-pause-resume` with real captured event; `no-retry-storm` | Covered (fixture-based; live after reset) |
| R8 Global rules must not derail agents | Claude `--safe-mode`+tools+fail-closed; Cursor preamble+guards | `claude-argv`, `claude-init-failclosed`, `canary-fixture`, `doctor-isolation` (real CLI), AC7 negatives | Covered for Claude (proven zero-quota); Cursor = mitigated, residual disclosed |
| R9 Robustness ("don't struggle with agents") | timeouts, retries, recovery, abort, lock, idempotent effects, clear Needs-Human text | engine crash/abort/idempotency tests | Covered |
| R10 Honest reporting | final report lists run/not-run + spikes + post-reset items | `final-report-conductor-v1.md` | Covered |

---

## Binding carry-forwards from Reviewer round 3 (verified at code review; no plan re-review needed)

- **C1** An issue created *with* the trigger label (or description) has **no history entry** for it. Rule: *no entry ⇒ creation-time ⇒ attributed to the creator*; fetch **all** history pages. Test `created-with-label-empty-history ⇒ accepted`.
- **C2** Failure-set keys carry **no line/column numbers** (tsc/eslint: file + code + normalised message). Test `baseline-line-shift`. Re-install dependencies when the lockfile changed in the worktree.
- **C3** AC7 also tries `git -c k=v push`, `/usr/bin/git push`, `env git push`, `sh -c 'git push'` and reports outcomes either way; assert at least `security` and `gh` denies, else label unproven.
- **C4** Setup wizard reads the team's default new-issue state, confirms an `unstarted` state exists, and offers `pickup.fromBacklog` (default **off**) — otherwise "create an issue with the label" silently does nothing.
- **C5** Backup ref also captures uncommitted work (`git stash create`) under `refs/conductor/<key>/…`.
- **C6** Raise the R4 Cursor-app deferral and the user-run S5 check **now** (done in chat), not only in the final report.
- Not independently verified by the Reviewer: Cursor stdin prompt (re-prove in P1 or stay on argv for Cursor), Keychain smoke, Cursor canary, `--sandbox` result — plan does not rely on `--sandbox`.
