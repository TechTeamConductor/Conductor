# Security design sign-off: F1 Claude `settings.json` isolation

- Reviewer: TechTeam Security Engineer
- Date: 2026-10-21
- Inputs:
  - `.techteam/plans/workspace-v2-f1-claude-settings.md` (status `pending_security_design`);
  - Evidence: `.techteam/runs/evidence/l3c-project-settings.md` (Critical — project settings);
  - Evidence: `.techteam/runs/evidence/m8-3-live.md` L3(b) (High — config-dir settings);
  - Prior finding: `.techteam/reviews/workspace-v2-m8-3-security-code.md` F1;
  - Code read (no edits): `src/agents/claude.ts`, `src/agents/providers/claude.ts`, `src/models/{claude,service}.ts`, `src/asks/{service,snapshot}.ts`, `src/accounts/{profile,env}.ts`, `src/config.ts`, `docs/ARCHITECTURE.md`.
- Method: design review only. No source edits. No CLI / live probe in this review.
- Severity: **Critical** = untrusted repo content alone can execute code or redirect credentials in a Conductor-spawned Claude. **High** = same-user plant in the default config dir can do the same. **Medium** = integrity gap if a spawn site is missed. **Low** = hygiene / docs.

## Threat model (narrow)

| Actor / asset | Path | Proven? |
| --- | --- | --- |
| Untrusted repository | `<cwd>/.claude/settings.json` / `settings.local.json` with `apiKeyHelper` + `env.ANTHROPIC_BASE_URL` | **Yes — L3c Critical.** Helper fires under `--safe-mode` for discovery probe, read-only stage (both isolation modes), research. Stages/research also hit the listener. |
| Same-user process (incl. Cursor builder) | Default account `CLAUDE_CONFIG_DIR` / `~/.claude/settings.json` with the same keys | **Yes — L3(b) High.** Helper + listener for auth status, discovery, stages, research under `--safe-mode`. |
| Named Claude account folder | Same plant | **Mitigated today** — M8-3 pre-flight refuses `settings.json` / `settings.local.json` / `managed-settings.json` (keep). |
| Quick Ask snapshot | Committed `.claude/**` | **Already omitted** by `AGENT_CONFIG` in `asks/snapshot.ts`. Still require spawn-time defence in depth (S2). |
| Discovery / research production cwd | Empty temp dirs (`prepareDiscoveryDir`, `conductor-research-*`) | Project settings N/A in production; **config-dir High still applies**. |

`--safe-mode` and the init fail-closed tool predicate do **not** stop `apiKeyHelper` or `env` from settings. Documented isolation claims that imply otherwise are false until this gate lands.

## Option pick

| Opt | Ruling |
| --- | --- |
| **A** | **Required** for F1(b) Critical (project cwd). Refined below — not bare delete/restore of hostile bytes as the only story. |
| **B** | **Optional upgrade**, not the sole control in this slice. Allowed to replace A's disk quarantine **only after** a zero-quota live proof (L3d) that Conductor's exact argv + `--settings <empty-file>` (or equivalent) yields helper **0** and listener **0** for the L3c matrix. Until then, do not depend on an unproven flag. |
| **C** | **Required** for F1(a) High (default config dir). **Refuse** (not warn-only; not silent strip of the user's real `~/.claude`). |
| **D** | **Rejected** (document-only). |

**Chosen control: A + C** (agree with Lead). B may land in the same implementation if L3d passes first; it must not delay A+C.

### A — project settings (refined)

Goal: no Conductor-owned Claude child whose `cwd` still exposes loadable hostile project settings.

1. **Choke point:** one shared pre-flight used by every path that eventually calls `runProcess` for Claude work shapes that honour project settings under today's evidence: at minimum `runClaude` (stages, research, doctor/self-test canaries), and any other Conductor Claude spawn whose cwd is not a Conductor-created empty temp dir. Discovery's empty dir is out of scope for A but still in scope for C.
2. **Targets at `<cwd>/.claude/` only (lstat, never follow):** `settings.json`, `settings.local.json`, `managed-settings.json`.
3. **If the path is a symlink, hard link (`nlink !== 1`), or not a regular file:** **refuse** the spawn (`errorKind: 'isolation'`, static class message, zero spawn). Never `unlink`/`open` through a link.
4. **If a regular file exists:** **quarantine** (rename aside under a Conductor-owned name outside Claude's load path, e.g. sibling under a `.conductor-quarantine/` dir with `O_NOFOLLOW` discipline) **or** replace in place with a Conductor-written empty JSON object `{}` via create-exclusive / no-follow semantics — implementer's choice, tested either way. Prefer quarantine+restore when the cwd is a durable worktree the user may open later in Claude Code / Cursor.
5. **Restore:** if quarantine+restore is used, restore in `finally` after the child is reaped. Parallel Claude spawns on the same cwd need a per-cwd mutex/lease so two stages cannot restore over each other's quarantine. Leaving the worktree permanently stripped is acceptable only if product accepts it; default is restore.
6. **Do not** "restore" by re-writing attacker-controlled content from memory after a replace-with-`{}` strategy — keep a side copy only via rename.
7. **Snapshots:** keep omitting `.claude` at build time; still run the same pre-flight (defence in depth if a non-snapshot cwd is ever passed).
8. **`setting-sources` mode:** A applies identically. After A, L3c for `--setting-sources project,local` must still show helper **0** / listener **0**. If that cannot be met, Conductor must **refuse** `isolation: 'setting-sources'` (fail closed to safe-mode-only or hard error) — no ship of a mode that re-loads hostile project settings by design.

### C — default config-dir settings (refined)

Goal: close the High path where the default account's real config dir supplies `apiKeyHelper` / redirecting `env`.

1. Before every default-account Claude spawn that L3(b) showed is affected (**auth status, discovery, read-only stages, research**; keep `--version` exempt if still inert), resolve the config dir the child will use (`CLAUDE_CONFIG_DIR` from the composed env, else the default Claude location — same resolution the child sees).
2. **lstat-only** on `settings.json`, `settings.local.json`, `managed-settings.json` in that dir (and, for defence in depth, parse `.claude.json` with the existing named-account key rules for `apiKeyHelper` / `env` / credential-shaped keys — refuse on hit). Never open credential files for content beyond the settings JSON size-capped parse already used for named accounts.
3. **Refuse** (zero spawn, `errorKind: 'isolation'` / account `unavailable` as appropriate) when any of those settings files has an own-property:
   - `apiKeyHelper`, or
   - `env` that is a non-null object containing any own-property (not only `ANTHROPIC_BASE_URL` — any injected env is a redirect/credential channel under the L3 threat).
4. **Do not** rewrite or delete the user's real `~/.claude` settings. Message: static doctor/settings copy that Conductor will not start Claude while a key helper or settings `env` block is present; no path, script body, or secret values in logs/UI.
5. Named-account pre-flight **unchanged** (still refuses the settings files entirely).

## Decision

**Approved with conditions.**

- A+C is the binding control set. D is rejected. B is optional and evidence-gated.
- There is no acceptable ship of Conductor Claude stages/research/discovery/auth-status on the default account or on repo worktrees until the numbered conditions below are in the plan text and met in the Security code checkpoint.
- Init fail-closed predicate and named-account refusals must remain.

## Binding conditions

1. **[BEFORE-EDIT] Control lock:** Implementation plan rev must state **A + C** as required; **D rejected**; **B optional only after L3d** proof that `--settings` (or documented empty-settings override) yields helper **0** and listener **0** on the L3c matrix under Conductor's exact argv. B may replace A's disk quarantine only with that evidence recorded under `.techteam/runs/evidence/`.

2. **[BEFORE-EDIT] Spawn inventory:** Plan must list every Conductor Claude `runProcess` site and mark each as in-scope for A, C, both, or neither (empty Conductor temp cwd ⇒ A N/A). Minimum inventory: `runClaude` (stages / research / doctor / self-test), `discoverClaude`, `auth status` / detect, account login/logout (login remains gated off), logout. Missing a site that L3 showed is affected is a Security code **blocker**.

3. **[BEFORE-EDIT] A mechanics:** Plan text must require: lstat/no-follow; refuse symlink/hardlink/non-file; quarantine or empty-`{}` replace; restore-only via rename side copy with `finally` after reap; per-cwd mutex if restore is used; targets `settings.json`, `settings.local.json`, `managed-settings.json` under `<cwd>/.claude/` only for A.

4. **[BEFORE-EDIT] C mechanics:** Plan text must require refuse-on-`apiKeyHelper` or any settings `env` object (own-property); no mutation of the user's real config dir; size-capped JSON parse; static messages; covers default-account auth status, discovery, stages, research.

5. **[BEFORE-EDIT] `setting-sources`:** Plan must either (a) apply A for that mode and keep AC1 for that row, or (b) refuse `isolation: 'setting-sources'` until (a) is true. Product may keep the config enum only if (b) fail-closes at runtime.

6. **[DURING] AC1–AC5** from the plan are binding verification. Automated tests must plant project settings (file + symlink negative) and assert zero spawn or helper/listener **0** via spy/`runProcess` + L3c replay evidence. Named-account suite stays green (AC3). Init predicate unchanged (AC4). No new network listener; no secrets in logs (AC5).

7. **[DURING] Single choke + assertion:** Project neutralization and default config-dir refusal run on the final cwd/env immediately before spawn (same spirit as `assertAccountEnv`). An isolation failure never advances the account/tool route.

8. **[LIVE] L3c replay** (zero quota, signed out, loopback listener): after the fix, discovery / safe-mode stage / setting-sources stage (or refused mode) / research → helper marker **0**, listener **0**. Record under `.techteam/runs/evidence/`.

9. **[LIVE] L3(b)-style config-dir plant** on the default path Conductor uses: refuse before spawn **or** helper/listener **0**. Prefer refuse (matches C).

10. **[DURING] Docs:** `docs/ARCHITECTURE.md` (and any UI copy that claimed `--safe-mode` isolates project settings) must state that Conductor neutralizes project settings files and refuses default-account settings `apiKeyHelper`/`env`, because `--safe-mode` alone does not.

11. **[DURING] Keep M8-3 named-account refusals** for settings files; do not weaken them to "strip keys and allow the file."

12. **Security code checkpoint** required after implementation before this finding is closed. Critical/High residual ⇒ Changes requested on the code review.

## Locked file areas (for the plan)

| Area | Likely files |
| --- | --- |
| Shared Claude pre-flight (new helper ok) | `src/agents/claude.ts` and/or small `src/agents/claude-settings.ts`; call from `runClaude` |
| Default config-dir check | `src/accounts/profile.ts` / `src/accounts/env.ts` (default path) + every default Claude spawn entry |
| Discovery / auth | `src/models/claude.ts`, `src/models/service.ts`, `src/agents/providers/claude.ts` (`auth` / detect) |
| Asks / snapshots | `src/asks/snapshot.ts` (keep omit); `src/asks/service.ts` only if cwd bypasses snapshot |
| Worktree stages | via `runClaude` choke — avoid scattering strip logic in `git/worktree.ts` unless inventory proves a non-`runClaude` path |
| Tests + evidence | `test/engine-safety*`, `test/accounts/env-profile*`, new L3c regression; evidence notes under `.techteam/runs/evidence/` |

Exact list may tighten in implementation; the **inventory in condition 2** is the contract.

## Findings on the draft plan

| ID | Sev | Note |
| --- | --- | --- |
| P1 | Medium | "Delete/replace … restore after" underspecifies symlink/hardlink refusal and per-cwd concurrency — closed by conditions 3 and 7. |
| P2 | Medium | Research/discovery production cwds are already empty; plan should not imply A is the research fix — C is. Closed by condition 2. |
| P3 | Low | Option B without live proof must not be the Critical mitigator — closed by condition 1. |

No Critical gap in the **direction** (A+C). Gaps are specificity; they are binding conditions, not a reject.

## Unblock

1. Lead folds conditions **1–5** into the F1 plan text (rev bump, status → pending Reviewer).
2. Reviewer plan approval on the locked design.
3. Implement A+C (+ optional B only with L3d).
4. Meet conditions **6–11**; Security + Reviewer code checkpoints (condition **12**).

Linear: no F1 root issue in this workspace session (`active-run.md`: Linear removed for this clone). Artifact of record is this file.

## Handoff

**Handoff: NEEDS-REVIEW (Reviewer plan) / COMPLETE (Security design)**
- Delivered: design sign-off; option pick **A+C**; **Approved with conditions** (12 binding).
- Artifact: `.techteam/reviews/workspace-v2-f1-security-design.md`
- Acceptance criteria: Security design gate for F1 — met for design phase; implementation not started.
- Checks run: code/evidence read only; no tests executed in this review.
- Decisions/assumptions: refuse (not warn) on default-account risky settings; B deferred pending L3d; Quick Ask snapshot omit is necessary but not sufficient.
- Risks or known gaps: Claude CLI may load additional settings shapes in future versions — AC/L3c matrix is the stop rule; widen refuse list only with evidence.
- Next owner/task: Lead (fold conditions into plan) → Reviewer (plan approval) → implementer.
- Exact next action: update `.techteam/plans/workspace-v2-f1-claude-settings.md` with A+C lock + conditions 1–5, then dispatch Reviewer.

Verdict: **Approved with conditions**
