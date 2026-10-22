# Implementation plan — F1 Claude `settings.json` isolation (Critical)

- Task: close Security F1 from M8-3 code review + L3c evidence (project settings honour `apiKeyHelper` / `env.ANTHROPIC_BASE_URL` under `--safe-mode`).
- Author: TechTeam Lead
- Date: 2026-10-21 (rev 2 — folds Security design conditions 1–5)
- Plan status: **approved** (Security design: Approved with conditions — `reviews/workspace-v2-f1-security-design.md`; Reviewer plan: Approved — `reviews/workspace-v2-f1-plan-review.md`)
- Evidence: `.techteam/runs/evidence/l3c-project-settings.md`, `.techteam/runs/evidence/m8-3-live.md` L3(b)

## 1. Current State

- Conductor Claude stages use `--safe-mode` (or `--setting-sources project,local`) + fail-closed init tool predicate. **`--safe-mode` does not stop settings `apiKeyHelper` / `env`.**
- Named Claude accounts: profile pre-flight **refuses** `settings.json` / `settings.local.json` / `managed-settings.json` in the account folder (M8-3). Keep unchanged (Security C11).
- Default account uses the user’s real `~/.claude` / `CLAUDE_CONFIG_DIR`.
- L3(b) High: planted **config-dir** `settings.json` → helper + `ANTHROPIC_BASE_URL` for auth status, discovery, stages, research under `--safe-mode`.
- L3c Critical: planted **project cwd** `.claude/settings.json` + `settings.local.json` → helper for discovery / safe-mode stage / setting-sources stage / research; listener on stages/research.
- Quick Ask snapshot already omits `.claude/**` (`AGENT_CONFIG`); still need spawn-time defence in depth.

## 2. Expected State — locked control: **A + C**

**Security condition 1 (control lock):** Implementation is **A + C**. **D (document-only) is rejected.** **B (`--settings`)** is optional only after live L3d proof that Conductor's exact argv + empty-settings override yields helper **0** and listener **0** on the L3c matrix; evidence under `.techteam/runs/evidence/`. B must not delay A+C and may replace A's disk quarantine only with that proof.

### A — project settings (Critical F1(b)) — Security condition 3

Goal: no Conductor-owned Claude child whose `cwd` still exposes loadable hostile project settings.

1. **Choke point:** one shared pre-flight immediately before spawn (same spirit as `assertAccountEnv`), used by every in-scope Claude `runProcess` site (inventory below). Prefer a small helper (e.g. `src/agents/claude-settings.ts`) called from `runClaude` / equivalent — do not scatter strip logic in `git/worktree.ts` unless inventory proves a non-`runClaude` path.
2. **Targets at `<cwd>/.claude/` only (lstat, never follow):** `settings.json`, `settings.local.json`, `managed-settings.json`.
3. **Symlink, hard link (`nlink !== 1`), or non-regular file:** **refuse** spawn (`errorKind: 'isolation'`, static message, zero spawn). Never unlink/open through a link.
4. **Regular file:** quarantine (rename aside under Conductor-owned name outside Claude's load path, e.g. `.conductor-quarantine/`, `O_NOFOLLOW`) **or** replace in place with Conductor-written `{}` via create-exclusive / no-follow. Prefer quarantine+restore for durable worktrees.
5. **Restore:** if quarantine+restore, restore in `finally` after the child is reaped. Parallel spawns on the same cwd need a **per-cwd mutex**. Do not "restore" by rewriting attacker bytes from memory after replace-with-`{}` — side copy only via rename.
6. **Snapshots:** keep omitting `.claude` at build time; still run the same pre-flight.
7. **`setting-sources` (Security condition 5):** apply A identically and keep AC1 for that row; **or** refuse `isolation: 'setting-sources'` at runtime (fail closed). No ship of a mode that re-loads hostile project settings.

Empty Conductor-created temp cwds (production discovery / research scratch): **A N/A**; **C still applies**.

### C — default config-dir settings (High F1(a)) — Security condition 4

1. Before every default-account Claude spawn that L3(b) showed is affected (**auth status, discovery, read-only stages, research**; `--version` exempt if still inert), resolve the config dir the child will use (`CLAUDE_CONFIG_DIR` from composed env, else default Claude location).
2. **lstat-only** on `settings.json`, `settings.local.json`, `managed-settings.json` in that dir; size-capped JSON parse. Defence in depth: refuse `.claude.json` hits for `apiKeyHelper` / `env` / credential-shaped keys using existing named-account key rules.
3. **Refuse** (zero spawn, `errorKind: 'isolation'` / account `unavailable` as appropriate) when any settings file has own-property:
   - `apiKeyHelper`, or
   - `env` that is a non-null object with **any** own-property (not only `ANTHROPIC_BASE_URL`).
4. **Do not** rewrite or delete the user's real `~/.claude`. Static doctor/settings message only — no path, script body, or secrets in logs/UI.
5. Named-account pre-flight **unchanged** (still refuses the settings files entirely — do not weaken to "strip keys and allow").

### Security condition 2 — spawn inventory

| Site | A (project cwd) | C (default config dir) | Notes |
| --- | --- | --- | --- |
| `runClaude` — plan / review / verify stages | Yes | Yes (default account) | Primary choke |
| `runClaude` — research | Yes if cwd not empty temp; else N/A | Yes | Production research uses empty temp → A N/A |
| `runClaude` / provider self-test / doctor canaries | Yes if cwd has project tree | Yes | Inventory at implement time |
| `discoverClaude` (`src/models/claude.ts`) | N/A (empty discovery dir) | Yes | |
| Provider `auth` / `detect` / `auth status` | N/A | Yes | |
| Account `login` / `logout` | N/A | login gated off; logout as inventory proves | Do not weaken M8-3 |
| Named-account spawns | Yes if cwd has project settings | N/A (named pre-flight already refuses settings files) | Keep M8-3 refusals |

Missing a site that L3 showed is affected ⇒ Security code **blocker**.

### Acceptance criteria (binding — Security C6)

- **AC1:** L3c replay after fix → helper **0**, listener **0** for discovery + safe-mode stage + setting-sources stage (or mode refused) + research.
- **AC2:** L3(b)-style config-dir plant → **refuse before spawn** (preferred) or helper/listener **0**.
- **AC3:** Named-account suite still refuses `settings.json` (unchanged strength).
- **AC4:** Init fail-closed predicate unchanged; `npm test` green.
- **AC5:** No new network listener; no secrets in logs/UI.
- Isolation failure never advances the account/tool route (Security C7).
- Docs: ARCHITECTURE (+ any false “safe-mode isolates settings” copy) updated (Security C10).
- Live evidence: L3c + L3(b)-style recorded under `.techteam/runs/evidence/` (Security C8–C9).
- Security + Reviewer code checkpoints before F1 closed (Security C12).

## 3. Files to Be Changed

| Area | Files |
| --- | --- |
| Shared Claude pre-flight (new helper ok) | `src/agents/claude.ts` and/or `src/agents/claude-settings.ts`; call from `runClaude` |
| Default config-dir check | `src/accounts/profile.ts` / `src/accounts/env.ts` + every default Claude spawn entry |
| Discovery / auth | `src/models/claude.ts`, `src/models/service.ts`, `src/agents/providers/claude.ts` |
| Asks / snapshots | `src/asks/snapshot.ts` (keep omit); `src/asks/service.ts` only if cwd bypasses snapshot |
| Worktree stages | via `runClaude` choke |
| Tests + evidence | `test/engine-safety*`, `test/accounts/env-profile*`, new L3c regression; `.techteam/runs/evidence/` |
| Docs | `docs/ARCHITECTURE.md` (+ UI copy if it over-claims `--safe-mode`) |

## 4. Implementation TODO

- [x] Security design sign-off (A+C, Approved with conditions)
- [x] Reviewer plan approval on this rev 2
- [x] Implement A + C (+ optional B only with L3d)
- [x] Automated plants (file + symlink negative) + AC1–AC5
- [x] Re-run L3c + L3(b)-style (zero quota); record evidence
- [x] Docs update (C10)
- [x] Security + Reviewer code checkpoints (C12) — Approved (`.techteam/reviews/workspace-v2-f1-security-code.md`, `.techteam/reviews/workspace-v2-f1-code-review.md`)

## 5. Testing Strategy

- Unit/integration: plant project settings (regular + symlink/hardlink refuse); spy `runProcess` zero spawn or post-fix helper/listener **0**.
- Default config dir: plant `apiKeyHelper` / any `env` → refuse, no mutation of real home in tests (throw-away `CLAUDE_CONFIG_DIR`).
- Named-account suite unchanged green.
- Live (opt-in, zero quota): L3c matrix + L3(b)-style refuse.

## 6. Risks

- Users who rely on default-account `apiKeyHelper` → Conductor refuses with a clear doctor message (product-correct for Critical/High).
- Missed spawn site → inventory + Security code gate.
- `setting-sources` must stay fail-closed (A works or mode refused).
- Quarantine restore races → per-cwd mutex.

## 7. Requirement Coverage Matrix

| Finding | Planned change | Verification | Status |
| --- | --- | --- | --- |
| F1(b) Critical project settings | A (quarantine/`{}` + restore/mutex; link refuse) | AC1, L3c, symlink negative | Covered (pending Reviewer) |
| F1(a) High default settings | C (refuse apiKeyHelper / any env object; no rewrite) | AC2, L3(b)-style | Covered (pending Reviewer) |
| Named accounts | keep M8-3 full-file refuse | AC3 | Covered |
| setting-sources | A or refuse mode | AC1 row | Covered (C5) |
| B `--settings` | optional after L3d | evidence file | Gap until L3d |
| Docs honesty | ARCHITECTURE update | C10 | Covered |
