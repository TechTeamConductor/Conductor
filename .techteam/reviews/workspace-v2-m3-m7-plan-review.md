# Plan review: M3, M4, M5, M6, M7 sub-plans (rev 1 each)

- Reviewer: independent. Plans read at `323d01e` (M3), `4c1e116` (M4), `ff1b22a` (M5), `cf22697` (M6), `956db87` (M7), against the master plan (direction items and binding additions M-5…M-9, decisions D1–D9, AC5–AC10), the verbatim requirement, and the real code at `bd5f186` (engine, stages, board, store, envelope, router, `inspectRepo`, `commitAll`, `secrets.ts`, the Claude/Cursor argv builders). Nothing was edited. No source exists for M3–M7 and none should until the decisions below are met.
- Method: every factual claim in "Current State" was checked in code; every cross-reference between plans was checked in both directions; the specific points you listed were each tested against the code or the other plans. Probes and greps are cited where they decide a finding.
- Scope note: Security design sign-off for M5 and M7 is separate. Where a finding is mainly a security design question I say so and mark it for that review, but I still count it as blocking here when the plan text as written would be unsafe or self-contradictory.

## Summary of decisions

| Plan | Decision | Blocking items |
| --- | --- | --- |
| M3 task graph | **Approved with conditions** | 6 (M3-1…M3-6), all plan-text changes |
| M4 context engine and offline | **Approved with conditions** | 4 (M4-1…M4-4) |
| M5 Quick Ask and Deep Research | **Changes requested** | 5 (M5-1…M5-5) |
| M6 policy, board, onboarding | **Changes requested** | 6 (M6-1…M6-6) |
| M7 desktop | **Approved with conditions** (M7a first) | 4 (M7-1…M7-4) |

Cross-plan items that no single plan owns are collected at the end (X-1…X-5).

---

## M3 — Plan v2 and task-graph execution

### What holds
- The current-state section is accurate: one `Run` per card, `runJob` capped at 60 iterations, `maxAgentRunsPerIssue`, `claimable(kinds=['work'])` claims only `work` cards, `approvalGate` reads `filesToChange` + `L` + `untrusted`, and the crash-window code at the top of `stages.build`. The board already has `parentId`/`dependsOn`/`kind:'subtask'`.
- The data model is additive (`Run.graph`, `BugRec.graphItem`) so no schema bump, and `graph.rev` ties it to the plan revision.
- Validation list is complete for structural faults (cycle, dangling, duplicate, uncovered criterion, file ownership both ways, analysis items without files, cap).
- Budgets: `runsLimit = min(150, maxAgentRunsPerIssue + 6·items)` and `iterationCap = min(400, 60 + 25·items)` are per graph with hard constants no config can lift; a graph-less run keeps today's numbers. This meets master direction (e).
- "Ready" is defined correctly: a graph with a failed or blocked item is never `ready`.
- Regression ownership is coherent: per-item gates see the regression the first time a gate can; the final whole-graph verify owns anything later and attributes by last touching commit. D1 (no parallel build) and the Partial coverage rows are stated honestly.

### Blocking
**M3-1 — Retry semantics contradict the engine as implemented.** §2.4 says Retry re-runs only failed/blocked items but "an edit of the plan or a move to To do = re-plan from scratch". In the code `retry()` and `applyHumanMove('todo')` both call `rerunFromHuman`, which takes `retryStage` from `needsHuman.origin` (`build`/`verify`/`plan_review` retry that stage and keep commits; anything else re-plans) and an untrusted run nobody approved always re-plans. There is no "edit of the plan" action (a human cannot edit a plan; a changed card description trips `integrity()` and sends the run back to the plan stage with origin `plan`). Restate the table in terms of the real triggers: Retry/To do with origin `build` ⇒ failed and blocked items back to `pending`, done items kept; origin `plan`, a description edit (`integrity`), a new plan revision, or the untrusted rule ⇒ graph discarded and worktree reset; Abort keeps the graph; Backlog park/unpark; and say what the old rev's subtask cards become on re-plan (see M3-4).

**M3-2 — the crash "adopt" rule is unsafe as written.** §2.7 adopts a running item as `done` when HEAD ≠ `startHead`, the tree is clean and "the HEAD commit message carries this item's marker", guarded by "commit authored by Conductor's identity". Two problems. First, there is no such identity: `commitAll` commits with the repository's configured identity (the user's), and a builder's own commit uses the same one, so the guard cannot distinguish them; the marker is text the builder controls (and `T<n>` sits in a subject that also holds the user's title and the planner's item title). Second, adopting as `done` skips everything Conductor does after its own commit (the branch-wide scope and secret scan and the item gates), so a self-committed builder result would be trusted after a crash with no checks until the final verify. Fix: adoption means "an item commit exists" only; require exactly one commit between `startHead` and HEAD (parent = `startHead`), clean tree, marker present, then **run `postBuildChecks` and the item gates before the item becomes `done`**; anything else ⇒ back up (`backupRefs`) and reset to `startHead`. Also state that the existing crash-window block at the top of `stages.build` (`head !== known` ⇒ "finished build ⇒ verify") is bypassed for graph runs; as written it would fire after the first item commit and send the run to verification with items unfinished.

**M3-3 — "single-task behaviour byte-for-byte" is an overclaim, and nothing pins it.** `PLAN_SCHEMA` gains `taskGraph`, which changes `jsonInstruction`/`describeSchema` for every plan call, and `prompts/plan.md` changes for every plan. The planner input and so its output can differ for a single task. What can be guaranteed is the build, commit, gate, verify and recovery path for a plan without a graph. Restate the claim to that, and add a characterization test written first (as in M1/M2): a no-graph and a one-item scenario produce the same event sequence, commit messages, run fields and board comments before and after (fake agents, real git). M3-AC8 ("the pre-M3 test set passes without edits") is necessary and not sufficient.

**M3-4 — the item state machine is described only in prose.** Master direction (b) asks for a state diagram of item and graph states. The plan has a graph-situation table but no transition table for items: `ready` is both listed as a stored state and defined as derived ("items whose dependencies are all done"); transitions for crash reset (`running → pending`), Retry (`failed/blocked → pending`, counters reset), Abort, blocked-propagation after a retry, and a dependency that becomes `done` later are not listed. Add the table, make `ready` derived (not stored), and state: what happens to a previous revision's subtask cards on re-plan (cancel/close them or reuse by key; today they would be orphaned in `needs_you`), and what happens when one concurrent analysis item raises a hold (limit pause, `needs_human`) while its sibling is still running (wait for both with `allSettled`, then transition once).

**M3-5 — the approval screen must show the graph.** The plan modifies `view.ts` and the drawer's Tasks panel, but not `prompts.ts` (`planToMarkdown`), which is what the approval card, the board plan comment and the builder's fenced plan render. As written a human approves (or auto-approval skips) a plan whose task structure only appears after approval. Add `planToMarkdown` to §3, render items/dependencies/files in it, and have the plan-review prompt and schema check the graph (not only the flat plan).

**M3-6 — "also bounded by the engine's free slots" has no mechanism.** `maxParallel` counts jobs (runs), not agent calls, so two concurrent analysis calls inside one job can exceed it (2 runs × 2 items = 4 agent processes). Specify a shared agent-call semaphore owned by the engine (or count analysis items against `maxParallel`), and give the deterministic barrier test the assertion that the cap holds across two runs.

### Non-blocking
- Item `files` are advisory for scope: `postBuildChecks` enforces only protected paths, so a build item may edit any unprotected file. Say so; "per-item verification" is gates plus the final verify.
- Attribution: the last commit touching a file may be a whole-graph fix commit, not an item commit; say how that maps (to the item named in the fix, else none).
- Analysis items go through `agents.readOnly`, which still needs a `stage` (`plan|plan_review|verify`) for timeouts, turn caps and event labels; name the one used.
- Item analysis notes are model text from a read-only pass over untrusted repo content that no human sees before it enters a builder prompt (see X-3).
- Budget accounting: say that `Run.agentRuns` (run-level) governs, `ItemRun.agentRuns` is informational.

---

## M4 — Project context engine and offline mode

### What holds
- Facts come from git objects (`ls-tree`, `cat-file`), never the working tree; symlinks and submodules are listed, not followed; per-module tree ids make updates incremental with counted-git-reads tests; staleness has reasons; a failed scan never blocks a run. The store sits under `<home>/projects/<KEY>/context/`; `projects/` is already reserved in `HOME_SKELETON`, and the board's project key rule (`^[A-Z]{2,6}$`) matches the plan's validation.
- Offline classification follows the house rule: only after a structural failure, from CLI-reported error text, never from model prose, never when the turn completed; `advances('network')` is false; the pause refunds the attempt like a usage limit; `unknown` probe is treated as online so the probe cannot trap a user; the probe is outbound-only, HEAD, no cookies, nothing sent, hosts limited to configured providers.
- The summaries (LLM text) are off by default, budgeted, fenced and never fed back.

### Your three questions
1. **Is the M-8 mapping acceptable with decisions, objectives and known issues Partial?** Not as written, but the gap is smaller than the plan states. M-8 asks for the eight V5 items one by one and says the items derivable from the board are deterministic facts. The plan's §7 lumps them into four rows. The board **does** hold what is needed: `Milestone` (title, description, status: user text, i.e. objectives), `Decision` (with `author: 'user' | 'conductor'`), open work cards (outstanding work) and open `bug` cards (known issues). "Partial — no automatic extraction" is acceptable for the *model-written* understanding (that is what the opt-in summaries are for), provided the matrix is one-by-one and the board-derived rows are covered deterministically (see M4-1). Without that, "Partial" hides items the plan could have covered.
2. **LLM text never reaches builder prompts.** True for the context engine as specified, but the sentence in §2.4 ("LLM text is never placed in a builder prompt") is broader than the system: the approved plan, the verifier's summary and bug lists, and (in M3) analysis-item notes already reach builder prompts. Scope the rule to what it can mean: *persisted, cross-run context* never enters a builder prompt; in-run agent output follows the existing fenced-and-approved path (X-3).
3. **Integrity model.** `contentSha256` of `facts.json` stored in `manifest.json` next to it detects corruption, not tampering. The builder runs as the user with `--force` (the docs say it is not a sandbox), so a compromised build can write `~/.conductor-v2/projects/<KEY>/context/`, recompute the hash, and place instructions in the "deterministic facts" every later builder prompt receives: persistence across runs, which is exactly the threat the plan sets out to remove (see M4-2).
4. **Offline rules.** Structural-first, never prose, `unknown` ⇒ online are right. Two gaps (M4-3).

### Blocking
**M4-1 — map the eight V5 items one by one** with, for each: source (scanner, board, history, summary), trust class (deterministic / user text / agent text), and which consumers may receive it. Cover from the board: objectives (open milestones), decisions (user-authored `Decision` rows verbatim; conductor-authored ones are agent text), outstanding work (open cards by title and lane), known issues (open bug cards: agent text, read-only stages only), completed tasks (history digests). Leave only "model-written understanding of decisions/conventions/known issues" as Partial.

**M4-2 — builder-facing facts must not depend on a file the builder can rewrite.** The scanner is deterministic and cheap; compute the facts a builder prompt receives **at use time from git objects** (using the store only as a cache for read-only stages), or sign the store with a key a builder cannot read, or state the residual risk explicitly with Security. A plain hash in the same directory must not be described as "integrity-protected" for prompt content. Also strip the `scripts{}`/`importantFiles[]` strings to a charset/length that cannot carry a sentence (repo-controlled `package.json` scripts are free text today and "fenced as data" is the only defence).

**M4-3 — offline classification gaps.** (a) A CLI that is offline usually hangs and retries rather than printing a network error, so the stage ends as `timeout_idle`/`agent` and never reaches the new `network` class: consult the cached probe before spawning a provider stage and, on a timeout or generic failure with the probe saying `offline`, classify as `network`. (b) Node's `fetch` does not use `HTTP(S)_PROXY`, which `baseEnv` passes to the CLIs: on a proxy-only network the probe fails for the wrong reason and returns `offline` (not `unknown`). If a proxy variable is set the probe must return `unknown`; a human **Resume** must always attempt the stage once and never be re-paused by the probe alone.

**M4-4 — one place for per-project settings, and name it now.** §3 says context settings live "on the board project record or `config.projects[key].context`"; M6 puts policy and limits in `config.projects[KEY]`. Decide once (config v5 migration, own-property/null-prototype handling, what happens when a project is deleted) and make both plans say it.

### Non-blocking
- A refresh before every plan stage reads the user's repository (`git` against the base branch), not the worktree the plan will run in; say which commit the pack states (the run's `baseSha` is more accurate than the branch tip).
- `history.ndjson` stores diff file names (agent-influenced) and card titles (user text): fenced for read-only stages as planned; keep them out of anything a builder sees.
- The `context` role name is shared by M3 (analysis item role), M4 (summaries) and M5 (Quick Ask); state the router role each call uses.

---

## M5 — Quick Ask and Deep Research

### Your four questions
- **`git archive` snapshot instead of the user's checkout.** Agreed: it is safer (no `.git`, no hooks, no untracked or uncommitted files, so no `.env`) and I accept the departure. Costs to state in the UI: the answer reflects the committed base branch, not what the user is editing, and `export-ignore` attributes can omit files. The plan does not say how the archive is extracted; there is no tar reader in Node and a symlink entry extracts as a symlink pointing anywhere. Name the mechanism (`git archive | tar` with `--no-same-owner` and a check that nothing resolves outside the scratch dir, or `git checkout-index --prefix`) and test a symlink to `/etc` and a `../` member.
- **Research profile.** The fail-closed exact tool set both ways with a negative test per profile is the right design, and the "web tools absent from every other profile" test is exactly what AC7 asks. One serious issue in the tool list (M5-2).
- **First-step probe of `dontAsk` + web tools with stop-don't-widen.** The rule is right, but it is not testable until the plan says what counts as "widening". `--permission-mode dontAsk` denies anything not pre-allowed, and WebSearch/WebFetch are ask-by-default tools, so the probable outcome is that they are denied, not that they work. The plan must pre-approve the minimal mechanism: `--allowedTools WebSearch,WebFetch` (exactly those two, no wildcard or domain rule) and nothing from `acceptEdits`/bypass modes; anything beyond that is the "stop" case. Otherwise the stop rule triggers on the expected result and the feature is dropped for no reason.
- **Structural citation check.** Observed-URL checking is a real structural control, but it proves the page was visited, not that it supports the claim, and `quote` is never checked against what was fetched. "Verified vs assumption is therefore enforced" is an overclaim. Either require each `quote` to appear (normalised substring) in the tool result text of that URL, or rename the status to "sources visited" and keep the "no independent fact-checking" sentence next to every report (M5-4).

### Blocking
**M5-1 — the fast path turns a read-only answer into an auto-started `--force` build from model output.** The model decides `kind: 'change'` while reading a snapshot of untrusted repository text; `complexity: 'S'`, a `files[]` list the model chose and the absence of a protected path are the only gates; approval is automatic; `untrusted` is deliberately not set. A README or comment in the repository that reads like a change request, asked about with an innocent question, can become a build nobody approved, and the card text is not specified (if it is the model's `change.description`, injected text goes straight into the builder prompt). Required: (a) execution must be the user's choice **per ask** (a visible "let Conductor make this change if it is small" option, off by default); otherwise a `change` is only *offered*; (b) the card description is the user's own question, never the model's description; (c) the fast path honours the configured approval policy: with `manual`/`approve-plan`/`manual-stages` (M6) and with the "first plan for this repo" rule it still waits for approval, and only plan *review* is skipped; (d) the plan stage's own `approvalGate` result (the plan, not the ask, decides protected paths and complexity) can always hold it, as it does for any run. As written M5 conflicts with M6 (X-2).

**M5-2 — the research profile gives a model both private data and an exfiltration channel by default.** The default research tool set is `Read, Grep, Glob, WebSearch, WebFetch`, with an empty scratch directory as cwd, and the plan says "nothing to leak through a fetched URL". Claude's Read tool is not confined to its cwd by this plan (the existing profile needs a credential **deny-list** precisely because reads outside the cwd exist), so private files outside the scratch directory remain readable, and fetched web pages are untrusted instructions with WebFetch as the way out. Default (non-repo-aware) research needs no file tools at all: make the default tool set exactly `{WebSearch, WebFetch, StructuredOutput}` and add Read/Grep/Glob only for the explicit repo-aware opt-in. Add to the first-step probe: with the research profile, attempt a read of an absolute path outside the working directory and confirm it is denied. (For Security.)

**M5-3 — define the permission mechanism before the probe** (see above): the allowed argv change, the forbidden ones, and that a result outside it stops the research part.

**M5-4 — citation status wording and quote check** (see above), including the UI label and the report footer.

**M5-5 — asks outside a run need explicit pause semantics.** `callAgent` returns `paused(limit|offline)`, but an ask has no run to wait in. State the behaviour for an interactive ask (fail fast with "usage limit until X, try again" and no queued retry, versus resuming later), who resumes a paused ask after a restart, and what happens to a running ask at shutdown (marked `failed: interrupted`, scratch deleted, nothing re-run automatically).

### Non-blocking
- `asksPerHour`/`researchPerDay` are counters; say where they are stored and that they survive a restart (X-4).
- WebFetch can follow redirects; the cited URL and the fetched URL may differ and the finding then (safely) lands in `unverified`: document it.
- `ASK_SCHEMA.kind` is a model choice that gates behaviour (M5-1 fixes the dangerous half).
- Quick Ask on Cursor (`ask` mode) runs with the weaker tier and the UI label says so: good; keep it next to the answer.

---

## M6 — Policy, board experience, onboarding

### Your points
- **Forced holds never removable.** The generated table test across every policy × hold is the right test and the intent (D5) is right. The table itself is inconsistent (M6-1).
- **Risk-rule list.** Reasonable seatbelt, but too coarse in places (M6-2).
- **M-6 agent-run budget.** Present (per-run, per-graph, per-project daily), but the accounting is not specified (M6-3).
- **M-7 project-create.** The validation list is good; two real gaps (M6-4, M6-5).
- **Honesty about builder shell calls.** Done well and repeated in the UI, docs, risks and matrix; it is stated as "not claimed", not as a limitation to hide.

### Blocking
**M6-1 — the policy table is internally inconsistent.** In `full-auto` the forced holds include "a risk rule match"; in `approve-risky` plans are automatic "unless a risk rule matches". So `full-auto` and `approve-risky` behave identically and the generated matrix test cannot tell them apart; the four policies are really three. Separately, the plan says the default is "approve-risky-compatible v1 behaviour: plans start automatically except forced holds", but `approve-risky` holds on risk matches, which v1 never did, and master D5 says the default is v1 behaviour (auto, forced holds L / protected / untrusted only). Resolve: forced holds = {`L`, protected path, `untrusted`, graph > 8 items} and are never removable by any policy or setting; `full-auto` = forced holds only (this is the v1 default); `approve-risky` = forced holds + risk rules; `approve-plan` and `manual-stages` as listed. Default policy = `full-auto` in that sense (v1-compatible). Then the four are distinct and the sweep test means something. Also give the mapping from the existing `pipeline.planApproval` (`auto|manual|first`, settings API field that must keep working) to policies, including what happens to the per-repo "first plan" rule.

**M6-2 — risk rules need a defined target and a false-positive budget.** "planned commands matching … `deploy` …" over plan *steps* (prose) will hold large numbers of ordinary plans ("update the deployment docs"), and "dependency manifest + lockfile together", "> 25 files" are normal changes. State where each rule applies (structured fields only: `testing.commands[]`, `filesToChange[]`, graph item files; step prose only for a short high-confidence list), keep `deploy`-style words out of the prose scan, and add the negative cases that must not match. Because the default becomes quieter after M6-1, a noisy rule list only affects users who opted into `approve-risky`.

**M6-3 — limits accounting.** (a) The daily per-project budget needs a persisted counter (state file, versioned, day key, and which day: local or UTC), restart-safe, and say whether M3's per-graph budget, M4's `contextRunsPerDay` and M5's ask/research counters share one accounting module (X-4). (b) `maxRunMinutes` must define what counts: running time, not time in `awaiting_approval`, `paused`, or `parked`, otherwise a run waiting a night for approval trips a cap it did nothing to earn. (c) Say what a reached limit does for a run that is `running` mid-stage (finish the stage, then hold) so no stage is killed half-way by a limit.

**M6-4 — project create must leave a project the engine can build in.** The initial commit uses a Conductor-owned identity "unless the user supplies one", but `commitAll` later commits with the repository's configured identity. A user with no global git identity gets a project that passes `inspectRepo` and then fails every build commit with an identity error. Set the identity (supplied or Conductor-owned) in the **new repository's local config** as part of creation, show it to the user, and add the test "create, then run a fake build through the envelope, with no global identity". Also refuse a target inside another git work tree (or ask), require `git init -b main` to fall back for git < 2.28, and roll back only what Conductor created if a later step fails.

**M6-5 — the sample repository cannot live under the Conductor home.** §2.4 creates it "under the Conductor home" and registers it as project `SAMPLE`; `inspectRepo` refuses any path inside the Conductor home (`isInside(c, real)`), and the default worktree root would sit next to it, also inside the home. Put the sample outside the home (under a user-visible folder the user confirms, same as project creation) and test that registration succeeds.

**M6-6 — M5's fast path and M6 policies need one precedence rule.** M5 says a fast-path card is auto-approved; M6 says `approve-plan` always waits and `manual-stages` holds. Write the rule in both: a policy can only add holds; the fast path may skip plan *review* only, never an approval the policy or a forced hold requires (see M5-1).

### Non-blocking
- `manual-stages` reuses `awaiting_approval` with `holdStage`; the lane projection, `approve()` (which currently means "plan approved"), and the 11 × 4 command matrix need the new cells listed by name, not only "matrix cells added".
- A risk-confirmed approval should bind to the plan revision and the reasons shown (the `rev` already required on approve covers the revision; include the reasons hash so a changed plan cannot reuse a confirmation).
- The UI scope is large; the plan's incremental, no-new-sinks approach is right; keep the Browser-pane evidence under `.techteam/runs/evidence/` as AC7 says, including a screenshot that shows the policy hold and the risk confirmation.

---

## M7 — Desktop distribution and cross-platform runtime

### Your points
- **Strategy layer split.** The split is the right one: one `src/platform` interface selected at startup, POSIX implementation identical to today's behaviour with snapshot tests as the extraction gate, Windows logic delivered as pure, host-independent units with the explicit statement that they are not claimed to work on Windows. M7a needs no download and is valuable alone.
- **Windows rules.** All F-9 items are present: no `shell:true`/`cmd /c` with agent- or schema-derived text, PATHEXT and `.cmd` handling, the Windows env keys, `NUL` and a generated stub instead of `/usr/bin/false`·`/dev/null`, `taskkill /T /F`, no control channel in desktop mode, drive/UNC/reserved-name rules. Two practical gaps (M7-3).
- **F-9 hardening list.** Present and correct: `contextIsolation`, `sandbox`, `nodeIntegration:false`, `webviewTag:false`, navigation and `window.open` locked to the loopback origin, https-only `openExternal`, deny-all permission handler, dedicated partition, `safeStorage` main-only over IPC, `{port, otp}` over IPC with no new route/token/command line, `utilityProcess`, single instance, no auto-update, frozen-spec and static tests. Missing items in M7-4.
- **Download permission.** Correctly gated on the user: nothing is downloaded or installed until the user says yes in chat, M7a needs none, and Docker image pulls are included. One wording fix: "Linux via a container if Docker is allowed" in M7a is itself a download; keep it in the asked-for list.
- **Artifacts labelled.** Yes: `.exe` "built, unverified", `.deb` container smoke test or unverified, CI "written, never executed, unvalidated YAML", and M7-AC9 requires the final report to say what ran on which OS.

### Blocking
**M7-1 — the host self-test record contradicts the M2 verification trust model.** M7-AC3 makes the build capability depend on "a passed host self-test record". In M2 (Security conditions 1c, 5; `verification.ts`) `buildIsolationVerified` comes only from a code-constant baseline bound to one CLI version, and a record file may only **add restriction or information**, never grant build; the baseline says nothing about the operating system, so as coded Cursor is build-eligible on Windows and Linux because it was proven on macOS. M7 needs both: make the baseline per platform in code (build verified only where a live suite ran: macOS today; Linux/Windows disabled until their own evidence is committed with the code), and let the host self-test only further restrict (a failed or missing host self-test disables building on that host). A file that can enable building is the exact path Security closed in M2. Write this into §2.2 and AC3, and have Security review it.

**M7-2 — state the real secret inventory.** In v2 as committed Conductor stores no credentials: Linear is gone, Codex API-key mode was not built, `defaultSecretStore()` is created in `runtime.ts` and the only call is `dropSecret` on uninstall. What Conductor *handles* are environment passthroughs (`ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `CURSOR_API_KEY`, per-repo `envPassthrough`, values read from copied `.env` files for redaction), the session OTP/cookie/CSRF (memory only) and the CLIs' own credential stores. The plan's `safeStorage`/IPC secret delivery, DPAPI consent screen and `secret-tool` work solve a problem v2 does not currently have. Either scope the safeStorage plumbing to "built when the first stored secret exists" or justify the first secret; in any case write the true inventory now (including env passthrough on Windows, where a desktop app launched from the Start menu will not inherit a shell's variables) and make AC7's test grep the stores the inventory names.

**M7-3 — make the Windows runner decision complete.** (a) Gates and setup commands are repo- or user-derived strings that commonly use `&&`, pipes and `VAR=value cmd`; a strict tokenizer that refuses them will refuse most real gates. State what happens (refuse with the reason; offer an explicit per-gate Windows command in config), not only "refused". (b) `.cmd` shims "resolved to the underlying executable": npm shims are batch wrappers around a `node` script and Windows cannot spawn a `.cmd` without a shell since Node 20.12 hardened it; say how each CLI (`claude`, `agent`, `codex`, `npm`/`pnpm`) is launched (native `.exe`, `node <script>` resolved from the shim's data, or refused). (c) Every agent argv value must be listed with its Windows handling: prompts already go on stdin (good), but Claude's `--json-schema` text, `--name`, `--model` are argv; run the injection corpus against the real argv builders, not only the tokenizer.

**M7-4 — packaging and hardening items missing from the plan.** (a) Pin the Electron version and prove the embedded Node satisfies what `dist/` needs (the sidecar runs under Electron's Node, not the user's Node ≥ 22.18); run the `dist/` smoke test under that version. (b) Flip the Electron fuses for the packaged app (`RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off, `OnlyLoadAppFromAsar` on, ASAR integrity where supported) or record why not. (c) The server reads `ui/`, `prompts/*.md` and spawns helpers relative to `ROOT`; inside an ASAR those paths either fail or cannot be executed. Decide `asar: false` or an explicit `asarUnpack` list and test `dist/` from a relocated directory. (d) `tsconfig.build.json` (master §3) is not in M7's file table; list it and the `.ts` → `.js` specifier rewrite.

### Non-blocking
- Run the existing full suite **inside a Linux container** in M7a (after the Docker permission): it is the cheapest real check for POSIX assumptions and is not in the plan.
- Per-OS default data directory is mentioned but not specified; state it (macOS path unchanged).
- On Windows the CLI `open`/`control` channel is unavailable (unix socket); document the fallback (print the URL).
- Diagnostics export: also redact the user's home path prefix.
- `.deb` `chrome-sandbox`/AppArmor user-namespace handling is correctly flagged as a risk; keep the "never silently disable the sandbox" rule as an explicit test of the packaged flags.

---

## Cross-plan items (no single plan owns them)

- **X-1 Per-project settings location** (M4 vs M6): see M4-4.
- **X-2 Fast path vs policies** (M5 vs M6): see M5-1 and M6-6.
- **X-3 Trust classes for text that reaches a builder.** M3 puts analysis-item notes (model text over untrusted repo content, never seen by a human) into dependent builder prompts; M4's rule says LLM text stays out of builder prompts; the existing plan, verifier summary and bug lists already reach builders. Define three classes once, in the master plan or M3: deterministic facts (anywhere), in-run agent output that a human can see (the approved plan, the fix inputs; fenced), persisted cross-run agent text (never to a builder). Decide which class item notes are and whether they need to be visible on the approval screen.
- **X-4 One accounting module for agent-run budgets.** M3 (per graph), M4 (`contextRunsPerDay`), M5 (`asksPerHour`, `researchPerDay`), M6 (`dailyAgentRuns`, `maxRunMinutes`) each introduce a counter; give them one persisted, versioned, restart-safe home (state file) and one day-boundary rule, and have M6 own it.
- **X-5 Matrix and test-count discipline.** Each plan states "existing suites pass unchanged" for its extraction (M5 `callAgent`, M7 platform layer) and the characterization-first rule; keep that, and add per plan the named list of migrated tests as M1/M2 did (M3 `engine-regress` plan-flow tests, M6 approval tests, M7 argv/env snapshots).

## Decisions

Decision (M3): **Approved with conditions** — M3-1…M3-6 are written into the plan before the first source edit; I will check the plan text, then the code by diff.
Decision (M4): **Approved with conditions** — M4-1…M4-4 are written into the plan before the first source edit.
Decision (M5): **Changes requested** — M5-1…M5-5; Security design sign-off still required and should take M5-1 and M5-2 first.
Decision (M6): **Changes requested** — M6-1…M6-6.
Decision (M7): **Approved with conditions** — M7-1…M7-4 are written into the plan before the first source edit; Security design sign-off still required, M7-1 and M7-2 first; M7a (strategy layer, no download) may start once M7-1 and M7-3 are in the plan.
