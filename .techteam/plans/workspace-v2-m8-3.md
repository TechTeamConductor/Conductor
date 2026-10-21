# Implementation plan — M8-3 Accounts and automatic switching (F8 engine + API/CLI)

- Task: brief F8 ("Accounts and automatic switching (engine)") plus its API and CLI (`conductor accounts add|login|list|check|move|remove`). Slice 3 of M8 (`workspace-v2-m8.md`).
- Author: TechTeam Backend (for TechTeam Lead)
- Date: 2026-10-21
- Plan status: **approved** (rev 2, 2026-10-21) — Reviewer: **Approved with conditions N1–N8** (`.techteam/reviews/workspace-v2-m8-3-plan-review.md`; binding text in §2N) · Security design: **Approved with conditions S1–S25** (incl. rev-2 check R2-1…R2-5) (`.techteam/reviews/workspace-v2-m8-3-security-design.md` is the authoritative text). The conditions are folded in as §2S, which wins over any conflicting text in §2–§7. §2T is the threat model.
- Rev 1 → rev 2:
  - the user decided Q4, D-A and Codex (§2.0);
  - Reviewer rev-1 findings B1–B5 and the non-blocking items are answered in §2.R;
  - the M8-2 selection table is adopted verbatim (§2.C).
- Depends on:
  - M8-1: per-account discovery = "Check sign-in"; cache per account (seams agreed, §2.C).
  - M8-2: `selectionForTool`, `modelOffered`, `toolDefaultSelection`, `fitEffort`; config v6.
  - Contracts with M8-2, M8-4, M8-6 and M8-1 are in §2.C.

## 1. Current State (verified against the code at clone HEAD `8eaab46`, 2026-10-21)

- **One sign-in per tool, implicit.** Nothing in `src/` knows the word "account".
  - Claude children get `claudeEnv()`. It passes through the parent's `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK|VERTEX`, `AWS_*` and every `ANTHROPIC_*` (`src/agents/env.ts:10-13,35-42`).
  - Cursor children get `cursorEnv()`, which passes `CURSOR_API_KEY` and `CURSOR_API_ENDPOINT` (`env.ts:14,45-47`). HOME is the parent's (`BASE_KEYS`).
  - Codex runs with Conductor's single private home `<home>/providers/codex-home` (0700, entry allow-list, symlink refusal, per-home lock) and a scratch HOME (`src/agents/providers/codex-home.ts`).
- **Cursor credential store** (verified by the Lead in the installed bundle 2026.10.19-6bbf2c4, module `./src/utils/credential-store.ts`):
  - Default: the macOS Keychain with service `cursor-access-token` and account `cursor-user`. These names are fixed, so every sign-in on this user would share them.
  - `AGENT_CLI_CREDENTIAL_STORE=file` switches to the file `join(homedir(), '.cursor', 'auth.json')`. It uses `homedir()` (`HOME`), **not** `CURSOR_CONFIG_DIR`.
  - `CURSOR_CONFIG_DIR` separately relocates config (fallback `XDG_CONFIG_HOME/cursor`, then `~/.cursor`).
- **Routing is pure and per provider.** `route({role, complexity, roles, states, now, label})` (`src/agents/routing.ts:70-118`):
  1. Capability/tier gate (fail closed).
  2. Complexity pick (never at a weaker tier than the head for read-only roles).
  3. Health filter (`installed`, `auth`, `pausedUntil`).
  - Result: `candidates[]`, or `paused`, or `ineligible`.
  - **Today's "nothing healthy" rule** (`routing.ts:111-117`): it pauses only when EVERY unhealthy provider is paused. Otherwise the first non-paused unhealthy provider runs, so that it reports its own precise error.
- **Research is not routed.** `AskService.runResearch` calls `agents.provider('claude').runResearch` directly (`src/asks/service.ts:110-124`), and `providers/claude.ts:45-56` uses `claudeEnv` without any account. `routeStates()` never sets `webResearchIsolated` (only `routing.ts:22,53` reads it), so `route({role:'research'})` built from `routeStates()` is always `ineligible`. As a result, `PUT /api/roles` (`api.ts:269-281`) cannot validate a research pairing either.
- **Limits.**
  - `Engine.pauses: Map<ProviderId,{until,reason}>` lives in memory and is capped at 24 h (`engine.ts:87,138-141,200-207`). `quotaMap` is keyed by provider (`engine.ts:97,148-149`; `stages.ts:419`).
  - Read-only stages: `Agents.readOnly` walks the candidates and advances on `limit|spawn|auth` with a note. It calls `onLimit` → `recordLimitPause`, which records the pause only: no streak, no comment (`provider.ts:96-123`, `stages.ts:231-235`). A **tool** hop leaves one comment `fallback:${stage}:${loop}:${agent}` (`stages.ts:413-417`).
  - `summariseCall` passes a no-op `onLimit` (`engine.ts:373`).
  - Builds: one route, then `candidates[0]` (`stages.ts:845-853`, `graph-build.ts:331-336`). A `limit` result goes to `pauseForLimit` (`stages.ts:943-947`).
  - `pauseForLimit` (`stages.ts:243-271`):
    - back-off 15 m → 6 h when the reset time is unknown;
    - one comment and one notify per streak (`limitStreak`/`limitEpisode`, `types.ts:269-270`);
    - more than 6 episodes ⇒ `needs_human`;
    - limit attempts are refunded (`stages.ts:337-339`).
  - Scheduler: `blockedByPause()` sets `paused` + `pauseReason` without a kind (`engine.ts:674-681`). A paused run with `pausedUntil > now` is not started early. `resume()` clears ALL pauses (`engine.ts:856-862`).
- **Build envelope env** (`src/pipeline/envelope.ts:17,103-113`):
  - `prep.env` is filtered by `FORBIDDEN_PREP_ENV` (`GIT_*|HOME|PATH|USERPROFILE|CODEX_*|XDG_*|LD_*|DYLD_*|NODE_OPTIONS`) and the adapter's `envAllow`.
  - The envelope's git env (`agentGitEnv`, `src/git/worktree.ts:950-970`) always wins. It sets `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_SSH_COMMAND=/usr/bin/false`, disabled push URLs and an empty credential helper.
  - The Cursor `build.run` composes `cursorEnv({...extraEnv, ...req.env})` (`providers/cursor.ts:65-69`).
  - **Conductor commits with its own git process** (`src/git/exec.ts:48`, real HOME). The builder therefore needs neither a git identity nor ssh nor gh.
- **Build isolation baseline**: Cursor's no-push isolation is grandfathered for 2026.10.19 by the bundled live suite, which ran with the real HOME and config (`src/agents/providers/verification.ts:18-29`).
- **`onClaudeLimit`** has not been stored since v4. The dashboard derives it from the planning chain (`config.ts:257-258`). `PUT /api/settings {onClaudeLimit}` edits the chains (`config.ts:282-307`).
- **Home calls** (`AskService`): a `paused` route ends the ask as failed with "… try again later." (`service.ts:136,231`), after the counter was taken (`service.ts:78,101`). There is no retry time.
- **CLI ↔ server**: a 0600 unix control socket that serves only `POST /otp` and `GET /status` (`src/server/http.ts:105-134`). Lock in `src/lock.ts`.
- **Config**: v5 today. M8-2 takes v6.
- **M8-1**: model cache at `<home>/models/<provider>/<account>.json`; `ACCOUNT_RE` exported from `src/models/sanitize.ts`; email and organisation never stored (S3).
- **Live facts** (zero quota):
  - Claude `initialize` with an empty `CLAUDE_CONFIG_DIR` ⇒ signed out. It writes `.claude.json`, `backups/` and `sessions/` into that dir.
  - Cursor signed out ⇒ exit 1 "Authentication required …".
  - Codex is broken here.
- **Design reference only**: `.techteam/design/v16/Main.dc.html:1441-2120` (`POLICIES`, `routeFor`, `beginStage`, `releaseLimited`, `hitLimit`, `resetAccount`, removal). The default rule is `switch`.

## 2. Expected State

> Nothing changes for a user with one sign-in per tool and default settings. The migration sets `limitRule: 'switch'`, and every tool has exactly one account `default` (today's sign-in, today's env). Under those conditions routes, argv and env are **byte-identical** to today, pinned by golden tests (AC1). Two things make this hold: the chain-only switch rule, and keeping today's "every unhealthy is paused" rule (§2.2 step 5).

### 2.0 Decisions

**User decisions (2026-10-21, via the Lead):**

- **Q4 — every extra account signs in with the tool's OWN CLI login. No pasted API keys, no long-lived tokens.**
  - **Claude** (rev-1 option C1):
    - a per-account `CLAUDE_CONFIG_DIR = <home>/accounts/claude/<id>/` (0700);
    - sign-in: `conductor accounts login <id>` runs `claude auth login` with that env in the user's terminal;
    - Claude keeps the credential in its own store for that dir, and **Conductor never reads it**.
  - **Cursor**:
    - a per-account HOME folder `H = <home>/accounts/cursor/<id>/` (0700), with `AGENT_CLI_CREDENTIAL_STORE=file`, plus `CURSOR_CONFIG_DIR = H/.cursor` only if L4e shows it is needed (S1);
    - sign-in: `conductor accounts login <id>` runs `agent login` with that env, stdio inherited. `NO_OPEN_BROWSER` is not set by default;
    - Cursor writes `H/.cursor/auth.json` itself, and **Conductor never reads it**;
    - the config dir is per-account (`H/.cursor`), **not** the user's real `~/.cursor`. A named account therefore never loads the user's global Cursor hooks, MCP or rules, and planted files are policed by the hygiene check (§2.4).
    - Rev-1's K1 (API key) and K2 (auth token) are rejected.
  - **The default account** of each tool is unchanged: real HOME, Keychain and today's env passthrough, byte-identical.
- **D-A — chain-only.** Under `switch`, routing never leaves the role's configured chain. It moves to the next account of the same tool, then to the next tool **in the chain** (with that tool's accounts in order).
- **Codex stays dormant** (no repair permission, Q5). Adding a Codex account is refused. The shape and code paths exist and are fixture-tested.

**Naming**:

- Commands: `conductor accounts add <claude|cursor> --name "<label>"` · `login <id>` · `list [--json]` · `check [<id>]` · `move <id> up|down` · `remove <id> [--keep-signin]`.
- Ids are `<tool>-<slug>-<nonce4>` (for example `claude-work-3f9a`) and match M8-1's `ACCOUNT_RE` (imported, not redefined). The **nonce is new at every add** (B4), so a re-added account never inherits an old folder or sign-in.
- The label is cleaned with M8-1 `cleanText`, ≤ 40 characters, and rendered with `textContent` only. The email is never stored, logged or shown (M8-1 S3).

**Decisions this plan takes (reversible):**

- **D-B `same` / `wait`.**
  - A **limit** never moves work to another tool; `wait` uses only the head tool's FIRST account.
  - Non-limit fallbacks (tool not installed, every account signed out) still follow the chain as today, because the rule governs limits only (§2.2).
- **D-C Migration**: `limitRule = 'switch'` always. Chain-only `switch` with one `default` account per tool is exactly today's chain walk. New installs also default to `'switch'` (design).
  - `toSettings().onClaudeLimit` stays as a derived, deprecated read field for one version.
  - `PUT /api/settings {onClaudeLimit}` keeps editing the chains as today. Under `same`/`wait` that edit affects only non-limit fallbacks; this is documented and tested.
- **D-D Unknown model list.** `modelOffered` returns `null`, which counts as offering when ordering accounts (`!== false`). The selection itself falls back to the tool default with a note (M8-2 table, §2.C), so an undiscovered id is never sent.
  - Q7 as recommended: accounts known to lack the model are tried after those that offer it.
  - When none offers it, the job runs on the tool default with a visible note (`selectionForTool`).
- **D-E Pauses stay in memory** (as today), keyed by account. They are not persisted.
- **D-F At most 8 accounts per tool.**
  - `default` cannot be removed; it can be moved down or renamed (label only).
  - Named accounts are usable only with `auth === 'ok'`, from their last check. They are checked at add, at login and at startup.
- **D-G Builds on named Cursor accounts are fail-closed until verified (Security S17).**
  - The grandfathered no-push baseline was proven with the real HOME and config. A per-account HOME is a changed isolation profile.
  - A code constant `CURSOR_ACCOUNT_HOME_BUILD_VERIFIED = false` (in `verification.ts`) makes named Cursor accounts ineligible for build roles. They run **read-only stages at once**. The router skips them for build-class roles with the reason "<label> can run read-only work only until its build isolation is checked".
  - Builds keep the `default` Cursor account. A build limit with only named accounts left ⇒ pause, as today.
  - The constant flips only after **L5** passes (the `cursor-nopush` suite under an account HOME, plus a loosened `cli-config.json` variant; user permission and quota needed). The flip is its own commit, and Security reviews it.
  - It is **not** a runtime record, and there is no `doctor --account` flag in this slice.

### 2.1 Data model (config v7)

```ts
// src/accounts/types.ts
export type LimitRule = 'switch' | 'same' | 'wait';             // src/accounts/limit-rule.ts (contract C1, §2.C)
export interface AccountMeta { id: string; name: string }        // id = ACCOUNT_RE (M8-1), name cleaned ≤ 40; NOTHING secret
export type Accounts = Record<ProviderId, AccountMeta[]>;        // ordered; index 0 first; 'default' always present once per tool
export interface AccountRef { provider: ProviderId; id: string } // what travels to providers (never a path, never a secret)
export const accountKey = (r: AccountRef) => `${r.provider}:${r.id}`;
```

- `Config.accounts: Accounts`; `Config.pipeline.limitRule: LimitRule`.
- `normalizeAccounts(raw)` treats its input as untrusted:
  - own-property reads, null-prototype result;
  - `ACCOUNT_RE`, de-duplicated, capped at 8;
  - `default` inserted at the end if missing;
  - names cleaned; unknown keys dropped and reported;
  - named Codex entries kept but inert (`enabled:false`).
- **Migration v6 → v7**:
  - `accounts = {claude:[{id:'default',name:'Main'}], cursor:[…], codex:[…]}`, `pipeline.limitRule = 'switch'`;
  - the existing `backupBeforeNextSave` backs the file up first;
  - a v7 file read by a v6 build is refused by `assertNotNewer`.
- **Folders** are derived from (provider enum, id) only, never stored: `<home>/accounts/<provider>/<id>/` (0700). `accounts` is added to `HOME_SKELETON`.
- **Run record**:
  - `account?: AccountRef & {name}` — the current or last stage;
  - `moved?: {kind:'account'|'tool'; restarted: boolean; note: string; at: number}` — static wording plus labels plus the real skip reason;
  - `pauseKind?: 'limit'|'offline'`;
  - `limitPauses?: number` — episodes that ended in a pause (B3b).
- **Engine quota**: `quotaMap` is keyed by `accountKey` and feeds `AccountView.usage`. `status().quota.claude` stays as the Claude head account's value, for compatibility.

### 2.2 Router (pure; `src/agents/routing.ts`)

`route()` stays a pure function of its input; the existing purity test is extended. New optional inputs, absent ⇒ today's behaviour:

```ts
export interface AccountState {
  id: string; name: string;
  isDefault: boolean;
  enabled: boolean;                         // false ⇒ never a candidate (dormant Codex)
  auth: 'ok' | 'not-logged-in' | 'unknown'; // default: today's provider health; named: from its last check ('unknown' ⇒ NOT usable for named)
  pausedUntil: number | null;
  offersModel: boolean | null;              // M8-2 modelOffered(tool, accountCatalogView, sel) with the selection THIS candidate runs; null = unknown
  buildOk: boolean;                         // default: true; named Cursor: false while CURSOR_ACCOUNT_HOME_BUILD_VERIFIED is false (D-G, S17)
}
export interface ProviderState { /* existing */ accounts?: readonly AccountState[] } // absent ⇒ one implicit 'default' mirroring auth/pausedUntil
export interface Candidate { id: ProviderId; tier: Tier; account: string; moved?: 'account' | 'tool'; modelFallback?: true; crossOnLimit: boolean }
export interface Skipped { id: ProviderId; account?: string; why: string; kind: 'gate'|'limit'|'auth'|'missing'|'model'|'disabled'|'build-unverified' }
route(input & { rule?: LimitRule /* default 'switch' */ })
```

Algorithm:

1. Run the gate and the complexity pick exactly as today, giving `ordered` (chain tools, complexity pick first). **No tool outside the role's chain is ever added** (D-A).
2. Per tool, in `ordered`. Not installed ⇒ every account of that tool is skipped (`missing`). Otherwise:
   - pool = the enabled accounts in config order (`wait` ⇒ the first only);
   - for build-class roles, accounts with `buildOk:false` are skipped (`build-unverified`);
   - usable = (`isDefault ? auth !== 'not-logged-in' : auth === 'ok'`) and not paused;
   - usable accounts with `offersModel !== false` come first, then those with `offersModel === false` (marked `modelFallback`, Q7).
3. Rule restriction, **limits only** (D-B; Reviewer R2-B2):
   - Under `same`/`wait`: if the head tool has at least one paused account in its pool and no usable account, the result is `paused` (step 5), and later tools are **not** candidates.
   - Otherwise later chain tools **are** included in `candidates` (for non-limit fallbacks), and each candidate carries `crossOnLimit: boolean`, which is `false` for every candidate of a later tool. Under `wait` the head pool is its first account only (step 2), so no other head account is ever built as a candidate (N2).
   - If the head tool is unusable for non-limit reasons only (missing, signed out), later chain tools follow as today.
   - Under `switch`, all chain tools are candidates, in order, with `crossOnLimit: true`.
   - **Mid-call rule** (`Agents.readOnly`, the research loop, and the build re-route in `onLimitHit`): after a `limit` error, the caller advances only to a next candidate whose `crossOnLimit` is true.
     - So under `same` a limit never crosses to another TOOL, and under `wait` never to another ACCOUNT either.
     - With no such candidate, the caller returns the limit/paused outcome: stages pause, asks end `limited`.
     - `spawn`/`auth` errors still advance to any next candidate (today's non-limit fallback).
4. `candidates` = the (tool, account) pairs in order.
   - `moved` = `'account'` when it is the head tool but not its first enabled account, and `'tool'` when it is not the head tool.
   - Every skip gets a `Skipped` with its real `kind`. Move notes use the real reason ("is not signed in" vs "reached its usage limit").
5. No candidate (B1: today's rule kept exactly; Reviewer R2-B1):
   - Let **S** = the health-skipped accounts in the considered pool that could run if they were healthy: default accounts, plus named accounts with `auth === 'ok'`. S excludes disabled accounts, `build-unverified` accounts, and named accounts that were never signed in or are signed out.
   - If S is non-empty and **every** member of S is paused ⇒ `{kind:'paused', pauseUntil: min(pausedUntil over S), provider, account}` (the earliest reset or back-off).
   - Otherwise the **first non-paused default account** (in `ordered`) runs and reports its own precise error, as today. A **named** account is never picked by this fallback (no credential).
   - Otherwise ⇒ `ineligible` "No signed-in account is available for <role>…" (design wording).
   - With default-only accounts this equals today's rule, so AC1 holds. **Adding an account never turns a pause into a failure.**
- `advances()` is unchanged: only `limit|spawn|auth` advance. An isolation failure never falls back.
- **`offersModel` per candidate**: computed by the caller as `modelOffered(tool, catalogViewOf(tool, account), sel)`.
  - `sel` is the role's selection when `tool === sel.tool` (M8-2 binds the selection to the tool it was made for); otherwise it is `toolDefaultSelection(cfg, tool)`. This also covers the complexity pick.
  - M8-6's `selRole` is passed the same way.
- **`webResearchIsolated`** is now set by `routeStates()` from code, never from config: `id === 'claude' && cfg.agents.claude.isolation === 'safe-mode'`, and false for the others (the F11 locks stay). This makes `route('research')` meaningful (B2). As a side effect `PUT /api/roles` can validate a research pairing; a test covers it.

### 2.3 Engine and stages

- **Pauses per account**: `Engine.pauses: Map<accountKey, {until, reason}>` (24 h cap).
  - `providerPause(ref, until, reason)`; the default account's ref is `{provider, id:'default'}`.
  - `routeStates(role?)` fills `accounts[]` from config order, sign-in state (§2.6), pauses, `buildOk`, and `offersModel` (only when a role is given; otherwise `null`).
  - `status().providerPause` stays for compatibility: a provider counts as paused only when ALL its enabled accounts are, until the earliest.
- **Limit info carries the account**: `LimitInfo.account?`, `AgentOutcome.account`, and `AgentOutcome.hops: {from: AccountRef; to: AccountRef; kind: 'limit'|'auth'|'spawn'}[]` (B3a).
  - `recordLimitPause` keys by account.
  - `summariseCall` now passes a real `onLimit`, which records the account pause.
- **Read-only stages** (`Agents.readOnly`) iterate the (tool, account) candidates.
  - The provider receives `req.account` beside M8-2's `req.sel = selectionForTool(role, tool, cfg, catalogViewOf(tool, account))`.
  - Each hop emits a note with the real reason, for example "Claude · Work reached its usage limit — continuing on Claude · Personal".
  - A limit hit thus restarts the stage on the next account inside the same call. The attempt is refunded (existing).
- **Research** (B2): `AskService.runResearch` routes with `route({role:'research', rule: effectiveLimitRule(cfg), states: routeStates('research')})`.
  - Only Claude passes the research gate, so the candidates are Claude accounts in order.
  - It loops over them, calling `claude.runResearch({..., account, sel})` (new `ResearchRunReq.account`); `providers/claude.ts` builds its env with `accountEnv`. It advances on `advances()` kinds, with the same notes.
  - The corrective re-ask stays on the account that answered.
  - `accountsGate('research')` uses the same route, so the gate and the run agree.
- **Builds**: `pauseForLimit` becomes `onLimitHit(key, limit)`:
  1. Record the account pause.
  2. Re-route the role under `effectiveLimitRule(cfg)`.
  3. A candidate exists ⇒ `queued` with the same `next` (the stage starts again on the next account), `moved {restarted:true}`, and a history line.
  4. Otherwise ⇒ `paused` until the route's `pauseUntil`, with `pauseKind:'limit'`.
  - The worktree is treated as on today's resume after a limit. Refunds as today.
- **Episodes** (B3):
  - An episode opens at the first limit hop or hit after a successful call (or the run start). It closes at the next successful agent call (existing `limitStreak` reset).
  - **Exactly one board comment** (key `limit:ep<n>`) and **one `notify()`** (the server turns it into a toast) per episode, on every path:
    - read-only: the stage inspects `outcome.hops` after `Agents.readOnly` returns;
    - research: the same, inside `AskService`, with no board comment (research is not a card) and one `notify`;
    - build: in `onLimitHit`.
  - The text says what happened: "… reached its usage limit; this step continued on Cursor · Main." or "… paused until 14:05; every account it may use is at its limit."
  - **Merge with the fallback comment**: when an episode comment is written for a call that also changed tool, the existing `fallback:${stage}:${loop}:${agent}` comment is **not** written separately. Its isolation-tier sentence is appended to the episode comment, so there is still exactly one comment. A tool hop for a non-limit reason (auth/spawn) keeps today's fallback comment unchanged.
  - Later hops in the same episode add only a history line and an event.
  - **Cap**: `needs_human` after more than 6 episodes **that ended in a pause** (`limitPauses`). Successful switches never count (B3b). A human restart resets `limitPauses`, as it resets `limitEpisode` today.
  - **The account on a limit pause comes from the candidate the caller ran**, never from provider output. `LimitInfo.account` is filled by the caller. A missing value is a programming error (an assert in tests), never a silent `'default'`.
  - Ping-pong is bounded: every rejected account is paused, so hops per call ≤ candidates (≤ 3 tools × 8 accounts).
- **Auto-resume**:
  - `blockedByPause()` sets `pauseKind:'limit'` too (B3c).
  - `schedule()` re-routes every `pauseKind:'limit'` run on each tick, regardless of `pausedUntil`.
  - As soon as any allowed account is usable (a reset, an account added or signed in, a reorder, a rule change), the run is queued and started, with one history line "<key> continues on …".
  - Offline pauses are unchanged.
- **A reset never interrupts a healthy stage**: routing happens only at stage start.
- **Removed account ⇒ restart**:
  - `jobAccount: Map<runKey, accountKey>` is set by an `onCandidate` callback when each attempt starts.
  - `accountRemoved(ref)`, for every job running on that account:
    - stops it with `stopJob` (the envelope's git-meta restore runs);
    - refunds the attempt;
    - sets `queued` with the same `next`;
    - records `moved {restarted:true, note:"… was removed, so this stage started again on …"}`.
  - This is not counted as a human restart.
  - S8 step 2 also aborts and awaits in-flight Quick Ask, Research and brief (M8-6) calls on that account, and its M8-1 check or discovery. An aborted ask ends `failed` "the account was removed", with its counter refunded.
  - **A removal mid-build leaves the aborted builder's partial, uncommitted edits in the worktree.** The next build attempt starts on top of them, exactly as after today's timeout or abort retry. Documented.
- **`resume(key)`** clears only the pauses of the accounts that the run's role may use.
- **Home requests never queue**:
  - `Engine.accountsGate(role, sel?): {ok:true} | {ok:false; retryAt: number|null; reason: string}` is the pure route over current states.
  - Quick Ask and Research call it before taking a counter. `ok:false` ⇒ `AskError('limited', …, 409)` with `retryAt`.
  - Mid-call exhaustion ⇒ `failed`, `errorKind:'limited'` + `retryAt`, and the counter refunded via `refund()` in `limits/budget.ts` (**M8-3 owns `refund()`**; M8-6 reuses it, §2.C).
  - `ApiFail` gains an allow-listed `extra` (`retryAt` only).

### 2.4 Child env and folders per account (`src/accounts/env.ts`, `src/accounts/profile.ts`)

`accountEnv(provider, ref, extra, src = process.env)`:

- **`ref.id === 'default'`** ⇒ **exactly** today's `claudeEnv(extra, src)` / `cursorEnv(extra, src)` / `codexEnv(...)`. A golden test pins it byte-identical, including the parent passthrough, the real HOME and the Keychain (no `AGENT_CLI_CREDENTIAL_STORE`).
- **Named Claude**:
  - start from `claudeEnv(extra, srcWithout)`, where `srcWithout` drops `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, every `ANTHROPIC_*`, `CLAUDE_CODE_USE_BEDROCK|VERTEX` and `AWS_*`;
  - set `CLAUDE_CONFIG_DIR = folder(ref)` **last**.
- **Named Cursor**:
  - start from `cursorEnv(extra, srcWithout)`, where `srcWithout` drops `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`, `CURSOR_API_ENDPOINT` and `XDG_CONFIG_HOME`;
  - set **last**: `HOME = folder(ref)` and `AGENT_CLI_CREDENTIAL_STORE = 'file'`. `CURSOR_CONFIG_DIR = folder(ref)/.cursor` is also set last **only if L4e shows it is needed** (S1); otherwise it is absent;
  - per S1, the drop lists apply to **both** `src` and `extra`. Named Claude also drops `CURSOR_*`/`AGENT_CLI_*`; named Cursor also drops `CURSOR_CONFIG_DIR`, `AGENT_CLI_*`, `HOME`, `XDG_*`, `ANTHROPIC_*` and `CLAUDE_*` before setting its own keys.
- **Named Codex**: dormant and unreachable (spy test).
- **`assertAccountEnv(provider, ref, env)`** runs immediately before every `runProcess` of a named account: stage, build, research, discovery, login, logout. A violation is an `isolation` failure with **zero spawn**.
  - Claude: `CLAUDE_CONFIG_DIR === folder`; none of `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, `AWS_*`, `CURSOR_*`, `AGENT_CLI_*`, `CODEX_*` (Security R2-2).
  - Cursor: `HOME === folder`; `AGENT_CLI_CREDENTIAL_STORE === 'file'`; `CURSOR_CONFIG_DIR` absent or `=== folder/.cursor`; none of `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`, `CURSOR_API_ENDPOINT`, `XDG_*`, `ANTHROPIC_*`, `CLAUDE_*`, `CODEX_*`.
  - **Default** account (S2, the reverse check): no `AGENT_CLI_CREDENTIAL_STORE`; `HOME`/`CLAUDE_CONFIG_DIR` exactly what the default functions produce; no named folder path anywhere in the env.
  - An isolation failure **never advances** (S2): a stage ⇒ `needs_human` with "The <label> account folder failed its safety check (<entry class>). Nothing was started."; an ask ⇒ `failed`; a check ⇒ the account is `unavailable`.
- **Builds on a named Cursor account** (B5). This is a reviewed exception, not a weakening of `FORBIDDEN_PREP_ENV`:
  - `FORBIDDEN_PREP_ENV` still forbids `HOME`/`XDG_*` from `prep.env`, unchanged.
  - The **envelope itself** (not the adapter) resolves `accountBuildEnv(ref)` from `src/accounts/env.ts` (fixed code), runs `assertAccountEnv`, and passes it as `BuildRunReq.accountEnv`.
  - `cursor.build.run` composes `cursorEnv(extraEnv, srcWithout)`, then `req.accountEnv`, then `req.env` (the envelope's git env, which wins for `GIT_*`). Any `CURSOR_*`/`AGENT_CLI_*`/`HOME` key in `req.env` is dropped before the account env applies.
  - Static test: `accountBuildEnv` is called only by the envelope; `build.run` uses `req.accountEnv` verbatim; HOME is the account folder, or the real HOME for `default`.
  - **The binding `assertAccountEnv` runs on the FINAL composed env inside `cursor.build.run`, immediately before `runProcess`** (Security R2-1), because `req.env` is applied after `req.accountEnv`. The envelope's earlier check is only an extra layer. Test: a forged `req.env` carrying `HOME`/`AGENT_CLI_*` ⇒ zero spawn.
  - **What the builder loses under a private HOME:**
    - Git identity, global git config, ssh and gh: nothing changes. The envelope already sets `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_SSH_COMMAND=/usr/bin/false`, Conductor commits with its own git process and the real HOME, and the builder never pushes.
    - HOME-relative toolchains and caches (`~/.cargo`/`~/.rustup`, `~/go`, `~/.npm`, pyenv/nvm roots) would resolve inside the account folder.
    - Mitigation: `ACCOUNT_TOOLCHAIN_VARS` (Security R2-5, narrowed form), a fixed code list: `npm_config_cache`, `GOMODCACHE` (not `GOPATH`, so nothing lands in `~/go/bin`), `RUSTUP_HOME`, `CARGO_HOME`.
    - Each var points at `<realHome>/…`, where `<realHome>` comes from `os.userInfo().homedir`. A var is included only if its target passes an `lstat` check: a real dir, owned by the user, outside the Conductor home. Otherwise that var is omitted.
    - **Builds only.** Never for read-only stages, discovery, login or check.
    - A parent-env value is never passed through.
    - `assertAccountEnv` requires each var to be absent or exactly the computed value, and requires `GOPATH`, `GOBIN`, `PYENV_ROOT`, `NVM_DIR` and similar to be absent.
    - No other HOME-relative state is bridged. An empty list is also acceptable if the Lead prefers it.
  - Build eligibility stays fail-closed until the constant flips after L5 (D-G, S17).
  - Gates and dependency installs never run under an account HOME (S18): `toolEnv` keeps the real HOME and never receives `AGENT_CLI_*`, `CURSOR_CONFIG_DIR` or an account HOME. A spy test covers this.
  - `ACCOUNT_TOOLCHAIN_VARS` is accepted by Security in the narrowed form above (R2-5). It is dead code until the S17 flip, so **it lands in the flip commit, not before** (Reviewer). With an empty list, builder caches are cleaned by S14.3 instead.
- **Folder hygiene** (`profile.ts`, modelled on `prepareCodexHome`) is **invoked by `accountEnv` itself** (S5), so no spawn path can skip it. It runs check-only while another job of the same account is alive (S9 per-account lock). §2S S3–S5 and S14 give the exact rules and win over the summary below:
  - the folder is a real directory (lstat, not a symlink), owned by the user, mode 0700 (tightened, then re-checked);
  - the parents `<home>/accounts/<provider>` pass the same checks;
  - no top-level entry may be a symlink;
  - every entry must be on an allow-list **measured live** (L1, L2(vi), L4c) after add + login + a read-only stage + discovery (Reviewer condition).
  - Refused, fail closed, with a message naming the entry:
    - Claude: `settings.json`, `settings.local.json`, `CLAUDE.md`, `agents`, `commands`, `hooks`, `plugins`, `skills`, `output-styles`, `.mcp.json`, and anything unknown.
    - Cursor `H/.cursor/`: `hooks.json`, `mcp.json`, `rules`, `commands`, `agents`, `skills`, `environment.json`, `cli.json`, and anything unknown ⇒ refused. Cursor `H/` top level: entries other than `.cursor` and the L4c-measured ones are **removed** while the account is idle (S14.3), not refused.
  - Cursor's `cli-config.json`, if Cursor itself creates it, follows S14.2:
    - `permissions.allow` must be absent or empty (stricter than S14, accepted by Security R2-4);
    - if L4c shows that `agent login` writes defaults there, the stop rule below applies.
    - A planted allow rule therefore cannot loosen the worktree's deny guard.
  - **Stop rule:** if L1/L2(vi)/L4c show the tool itself creating an entry on a refusal list, implementation stops. The Lead and Security then choose a content check or a different mechanism. Fail-closed must never brick a real account silently.
- Paths are built only from the enum and the id and asserted inside `<home>/accounts`. They never appear in API responses or reasons.

### 2.5 Secrets

- **Conductor holds no account secret.** Sign-ins live in each tool's own store: Claude's per-config-dir store, and the Cursor-written `auth.json` in the account folder.
- Conductor never reads, copies, logs or serves those files. The hygiene check only `lstat`s names and modes, plus the content of `cli-config.json` (permissions only).
- The view shows only `Ready` / `Not signed in`.
- Rev 1's `AccountSecrets`, Keychain names and API-key prompt are removed.

### 2.6 Sign-in, sign-out, check, per-account models

- **Login** (`conductor accounts login <id>`; terminal only, never the server, never `npm test`):
  - runs `claude auth login` or `agent login` with `accountEnv`, after hygiene and `assertAccountEnv`, with **stdio inherited**; Conductor captures nothing;
  - a check follows;
  - Codex is refused.
- **Remove signs out by default** (B4):
  - `claude auth logout` / `agent logout` runs first, with the account env (zero quota, constant argv, 20 s bound);
  - then the folder is deleted (lstat-checked, inside `<home>/accounts`), the model cache is deleted, and `ModelService.forget(provider, id)` is called;
  - `--keep-signin` (CLI only) skips the logout;
  - a failed logout is reported and removal still proceeds. Because the id carries a fresh nonce, a re-add never points at the old folder, so an orphaned Claude Keychain item for the old dir can never be reached by a new account;
  - `DELETE /api/accounts/:id` runs the same logout server-side (constant argv, zero quota).
- **Check** = M8-1 per-account discovery: `ModelService.refresh(provider, 'account-check', id)` with `envFor = accountEnv` (plus hygiene and the assertion).
  - `signedIn` becomes `AccountState.auth`. Claude: `tokenSource ≠ none`. Cursor: the list call succeeded.
  - It runs at add (⇒ "Not signed in"), after login, on `POST /api/accounts/:id/check`, and at startup through M8-1's serialised queue. S11 rate limits apply per (provider, account).
- **Default account health** stays today's `agentHealth`. The new accounts view shows the label, never "Signed in as <email>" (T9).
- **Model caches**:
  - The user's own sign-in keeps id `default`, so the existing `<home>/models/<provider>/default.json` caches **carry over unchanged**.
  - Named accounts get `<id>.json`. It is deleted on removal, together with `forget()`.
  - At startup, cache files for unknown ids are ignored and removed (lstat, regular files only).

### 2.7 API (strict, CSRF, loopback)

- **`GET /api/state`** gains:
  - `accounts: AccountView[]` (the field M8-U feature-detects);
  - `settings.limitRule` and `settings.limitRuleEffective`;
  - per run: `account` and `moved`.
- **`AccountView`**: `{ provider; id; name; order; isDefault; status: 'ready'|'in-use'|'at-limit'|'not-signed-in'|'not-installed'|'checking'|'unknown'|'unavailable'; until?; untilKind?: 'reset'|'retry'; plan?; usage?: {utilization7d?, utilization5h?, resetsAt?}; checkedAt?; inUse: number; buildReady?: boolean; signInCommand: string }`.
  - `signInCommand` is built from constants and the id only: `conductor accounts login claude-work-3f9a`.
  - `buildReady` appears for Cursor accounts (D-G).
  - No paths, no email, no secret.
- **Endpoints:**
  - `GET /api/accounts` ⇒ `{accounts, limitRule, limitRuleEffective}`.
  - `POST /api/accounts {provider, name}` ⇒ 201 `{account, signInCommand}`. It creates the metadata and an empty 0700 folder, and runs no CLI.
    - 400: unknown key, non-object, `__proto__`, bad provider, empty or over-long name, any credential-like field, or `codex`.
    - 409: duplicate name per tool, or more than 8 accounts.
  - `PUT /api/accounts/order {provider, ids}`: must be an exact permutation of that tool's ids.
  - `PUT /api/accounts/:id {name}`: rename.
  - `POST /api/accounts/:id/check` ⇒ 202; within 10 s ⇒ the cached view.
  - `DELETE /api/accounts/:id`: `default` ⇒ 409. Otherwise sign out, remove, and restart any running stage (§2.3, §2.6).
  - `PUT /api/settings` accepts `limitRule ∈ {switch, same, wait}` (strict ⇒ 400).
- Every change calls `engine.invalidate()` + `tickSoon()` (auto-resume). So does every **finished account check**, including the check after `login`, so limit-paused runs resume as soon as a new sign-in is usable.

### 2.8 CLI

- `conductor accounts list [--json]` · `add` · `login` · `check` · `move` · `remove [--keep-signin]`.
- **Single writer of config**:
  - with a server running (it holds the lock), add/move/remove/rename/check go through new **control-socket routes** (`/accounts…`), which use the same handlers as the API on the 0600 same-user socket;
  - without a server, the CLI takes the lock briefly and writes the config itself.
- `login` writes no config. It runs the tool login, then asks for a check via the socket or runs the check directly.

### 2.C Contracts agreed with peer slices (2026-10-21)

**C1. Limit rule (M8-4 Reviewer condition B2a — verbatim, binding):**

- M8-3 creates `src/accounts/limit-rule.ts` with `export type LimitRule = 'switch' | 'same' | 'wait'` and the pure `export function effectiveLimitRule(cfg: Config): LimitRule`. In M8-3 it returns `cfg.pipeline.limitRule`.
- Stored field: `cfg.pipeline.limitRule: LimitRule`, default `'switch'`. Its migration reproduces today's chain-walk (D-C: always `'switch'`).
- **`switch` = the next account (of the same tool), then the next tool in the role's chain** (with that tool's accounts in order). It never goes beyond the chain (user decision D-A). `same` = only the head tool's accounts, never another tool on a limit. `wait` = only the head tool's first account.
- **M8-4 owns one edit in that function**, as its first line: `if (cfg.pipeline.runMode === 'complete-auto') return 'switch';`. M8-4 also owns that branch's test.
- The engine, the router callers and the API call **only** `effectiveLimitRule`. Nothing else reads `pipeline.limitRule`, except the settings view and the edit of the stored value (`toSettings`, `applySettings`, the migration). A static test enforces this.
- Settings view: `settings.limitRule` (stored) and `settings.limitRuleEffective`. `PUT /api/settings` accepts `limitRule` (M8-3).
- M8-4 adds `pipeline.runMode` without a config bump (additive default `'per-settings'`). If the Reviewer wants a bump, M8-4 takes v8.

**M8-2 (model/effort)** — agreed (M8-2 rev 2). M8-2 exports these from `src/models/select.ts` (pure), and M8-3 re-implements nothing:

- `RoleModelSel` carries `tool: ProviderId` (the tool the choice was made for). It is applied only when the candidate tool equals `sel.tool`; any other tool gets its default with the effort fitted.
- `toolDefaultSelection(cfg, provider): RoleModelSel` reads `cfg.toolModels[tool]`. Unset ⇒ no `--model`; fast/thinking are dropped.
- `fitEffort(levels: readonly string[] | null, wanted?: string): { effort?: string; adjusted: boolean }` and `levelsFor(provider, catalog, sel)`.
- `selectionForTool(role, tool, cfg, catalog: CatalogView | null): ResolvedSel`. **M8-3 passes the target account's CatalogView.**
- `modelOffered(tool, catalog: CatalogView | null, sel): true | false | null`, where null means this account's list is unknown.
- Requests carry `sel?: ResolvedSel` (M8-2) and `account?: AccountRef` (M8-3) side by side. Argv builders stay account-agnostic.
- Config: M8-2 = v6, M8-3 = v7.
- **Selection semantics table (copied verbatim from M8-2 §2.9; both plans carry it identically).** Each cell is `modelArg` / `fallback` / `modelOffered`. "Default" means the tool-default resolution (`toolModels[tool]` via these same rules; unset ⇒ no `--model`). Effort is always fitted to whatever model is actually used.

| catalog state | Claude/Codex discovered id | Claude/Codex custom id | Cursor family | Cursor custom id | Tool default |
|---|---|---|---|---|---|
| null (no view), `reading`, `unavailable` | default / `list-unavailable` / null | the id / – / true | default / `list-unavailable` / null | default / `list-unavailable` / null | toolModels value if it may be sent under these rules, else no `--model` / – / true |
| `stale` or `fresh`, choice listed | the id / – / true | the id / – / true | listed variant id for (thinking, effort, fast). Missing tuple: fitted variant (drop fast → drop thinking → nearest effort) with notes / – / true | the id / – / true | as above / – / true |
| `stale` or `fresh`, choice NOT listed | default / `no-longer-offered` (signed-out wording when `signedIn === false`) / false | the id / – / true | default / `no-longer-offered` / false | default / `not-in-list` / false | as above / – / true |

Effort row (applies everywhere): `levelsFor` gives exactly the discovered levels. Custom Claude/Codex ids use the union of the tool's reported levels. With no list, or a model that has no levels, effort is dropped with a note.

**M8-6 (Home)** — agreed:

- Home services call `accountsGate(role)` before the snapshot or spawn and before taking a counter.
- `{ok:false}` ⇒ 409 `{error:'limited', retryAt, message}`, with no record and no counter.
- Mid-call exhaustion ⇒ `failed` with `errorKind:'limited'` + `retryAt`, and the counter refunded. No automatic retry for F3.
- Daily and hourly caps stay 429 `{error:'limit'}`.
- **`refund()` in `limits/budget.ts` is owned by M8-3.** M8-6 reuses it, or creates it with the same signature `refund(id: CounterId, opts?: {scope?, now?, n?})` if it lands first.

**M8-1 (discovery)** — agreed:

- Methods: `view(provider, account='default')`, `refresh(provider, trigger, account='default')`, `noteVersion(provider, version, account='default')`, `noteUnknownModel(provider, account='default')`, all keyed `${provider}:${account}`.
- `ACCOUNT_RE` is exported from `src/models/sanitize.ts`, and M8-3 imports it. A bad id ⇒ `unavailable`, never a path.
- Deps:
  - `envFor?(provider, account)`. The env reaches the spawn unchanged, so **M8-3's `accountEnv` + hygiene + `assertAccountEnv` guard discovery too**.
  - `accountIds?(provider)`.
- The cache path is unchanged; `default.json` carries over. **M8-3 calls `forget(provider, account)` when deleting a cache file.**

**M8-U / M8-5 (UI)**: the field names in §2.7.

### 2.R Reviewer rev-1 findings — how rev 2 answers them

| Finding | Answer |
| --- | --- |
| B1 byte-identity of step 5 | Today's "every unhealthy is paused" rule is kept exactly (§2.2 step 5). Chain-only D-A removes the auto-switch of Claude-only roles. AC1 golden test over all existing routing fixtures plus the B1 example. |
| B2 research not routed | `routeStates` sets `webResearchIsolated` from code. Research routes and loops over the Claude accounts with `ResearchRunReq.account`. Gate and run use the same route (§2.2, §2.3). Tests `research-*`. |
| B3a episodes across paths | `AgentOutcome.hops`; one comment + one notify per episode in read-only, build and research (notify only); merged with the fallback comment (§2.3). |
| B3b cap | Counts only episodes that end in a pause (`limitPauses`). |
| B3c | `blockedByPause` sets `pauseKind:'limit'`. |
| B4 id reuse | A fresh nonce per add; logout on remove by default; test `re-add same name ⇒ new id, new folder, not signed in`. |
| B5 Cursor HOME | §2.4 covers it: the env, the envelope mechanism, the builder consequences, hygiene of `H/.cursor`, the `assertAccountEnv` rules, the byte-identical default, the D-G build gate, and live checks L4a–e and L5. |
| offersModel selection | Computed per candidate with the selection it will run (`sel.tool`), §2.2. |
| registry order | Moot (chain-only). |
| quotaMap per account | §2.1. |
| `refund()` owner | M8-3 (§2.C). |
| L1 scope | Measured after login + stage + discovery; stop rule (§2.4). |
| same/wait and non-limit fallbacks | The restriction applies to limits only (D-B, step 3). |
| `PUT {onClaudeLimit}` under same | It edits the chains as today, which affects only non-limit fallbacks; documented and tested (D-C). |
| removal mid-build partial edits | Stated (§2.3). |
| fallback never a named account without credential | §2.2 step 5. |
| real skip reason in notes | `Skipped.kind` (§2.2). |
| `summariseCall` no-op `onLimit` | Fixed (§2.3). |

### 2S. Security design conditions — BINDING (`.techteam/reviews/workspace-v2-m8-3-security-design.md`, S1–S25)

The review file is the authoritative text. Where this summary or §2–§7 differ from it, the review file wins. What the code must do:

- **S1 env built in one place.**
  - Named accounts drop their lists from **both** `src` and `extra`, then set the credential-locating keys last (§2.4).
  - Default Cursor never has `AGENT_CLI_CREDENTIAL_STORE`/`CURSOR_CONFIG_DIR` (test).
  - `req.env` can never carry `HOME`/`CURSOR_*`/`AGENT_CLI_*`/`CLAUDE_CONFIG_DIR` into a named child.
  - `FORBIDDEN_PREP_ENV` is unchanged.
- **S2 `assertAccountEnv`** runs before every spawn shape (stage, build, research, check, `auth status`, `--version`, login, logout) and fails closed with zero spawn.
  - An isolation failure never advances.
  - A never-signed-in named account is never spawned for work; it gets only login and the zero-quota check.
  - The step-5 fallback picks only a default account or a named one whose last check said signed in (§2.2).
- **S3 paths.**
  - Built from the enum and an id matching `ACCOUNT_RE` **and** `^<provider>-[a-z0-9-]+$`; `default` has no folder (it throws); `path.relative` containment.
  - Messages name an entry *class*, never a path.
- **S4 folders.**
  - Parents are 0700, real directories owned by the user.
  - The leaf is made with a **non-recursive** `mkdirSync`; `EEXIST` ⇒ refuse and never adopt.
  - Leaf and parents are re-verified before every spawn.
- **S5 Claude pre-flight**, called by `accountEnv`:
  - exact top-level allow-list from L1; `.credentials.json` allowed only if L1/L2 show Claude creates it;
  - always refused: `settings.json`, `settings.local.json`, `CLAUDE.md`, `.mcp.json`, `managed-settings.json`, `agents`, `commands`, `hooks`, `plugins`, `skills`, `output-styles`, and anything unknown;
  - no symlinks to depth 2; top-level files `nlink === 1`;
  - `.claude.json` (≤ 4 MB, own-property parse) is refused if it has non-empty `mcpServers` (top or `projects.*`), `primaryApiKey`, approved `customApiKeyResponses`, `env` or `apiKeyHelper`;
  - `shell-snapshots` only if L1 shows it, and then emptied before each spawn;
  - **credentials are never read** (static test: no source reads `.credentials.json`/`auth.json`/`Claude Code-credentials*` except `lstat` in `profile.ts`).
- **S6** L1 and L3 run before the `profile.ts` commit (AC10).
- **S7** Login runs the CLI's own command with stdio inherited and captures nothing. The check stores only `signedIn`/`plan`.
- **S8 removal order.**
  1. Mark removing (treated as disabled).
  2. Abort and await the account's jobs and checks.
  3. Sign out by default (`--keep-signin` opts out).
  4. Delete the folder (no-follow).
  5. Delete the cache and call `forget`.
  6. Save config.
  - The response says whether the sign-out succeeded, with a static note if not.
  - The startup sweep deletes orphan folders (counted; documented as "no sign-out").
  - Ids get a random 4-hex suffix and are never reused.
- **S9** A per-account lock: cleaning and removal only when no process of that account is alive; otherwise the pre-flight is check-only.
- **S10 chain-only pinned.** Candidate tools ⊆ chain ∪ complexity pick, for every rule (static + property test).
- **S11 control socket.**
  - `<home>/run` must be a real 0700 dir owned by the user, else no socket.
  - An exact method + path allow-list: `GET /accounts`, `POST /accounts`, `PUT /accounts/order`, `PUT /accounts/<id>`, `POST /accounts/<id>/check`, `DELETE /accounts/<id>`.
  - It uses the same shared strict handlers as HTTP; bodies are ≤ 16 KB JSON; no credential, path or email; **no login route**.
- **S12 views and inputs.**
  - `AccountView` keys are allow-listed (test per key).
  - `signInCommand` matches `^conductor accounts login [a-z0-9][a-z0-9-]{0,31}$`.
  - `usage` values are clamped (utilization 0–100, `resetsAt` within now ± 8 days) or omitted.
  - An email-shaped label ⇒ 400 "Use a short name, not an email address" (normalize ⇒ "Account N").
  - `apiKey`/`token`/`key`/`password` fields ⇒ 400.
- **S13** In direct mode the CLI holds the lock for the whole read-modify-write and for the removal sequence.
- **S14 Cursor account HOME hygiene**, before every named-Cursor spawn:
  - `.cursor/` allow-list from L4c; refused: `hooks.json`, `mcp.json`, `rules/`, `commands/`, `agents/`, `skills/`, `environment.json`, `cli.json`, and anything unknown ⇒ an S2 failure, never a silent clean.
  - `cli-config.json` (≤ 256 KB, own-property parse): `permissions.allow` must be **absent or empty** (Security R2-4, Reviewer N1; if L4c shows `agent login` writes defaults there, the stop rule applies); `deny` may only tighten; MCP/hook/approval/sandbox/network loosening keys and unknown top-level keys are refused.
  - Top level of HOME: entries other than `.cursor` + L4c-measured ones (builder caches, `.zshrc`/`.zshenv`/`.bashrc`/`.profile`/`.npmrc`/`.gitconfig`/`.ssh`/`.netrc`) are **removed** with no-follow `rmSync` while the account is idle. The count and class are logged, and a visible run note is added for shell start-up or credential-style files.
  - `auth.json` must be a regular file with `nlink === 1`, mode tightened to 0600, and is **never opened**.
- **S15** L4a–e (AC10). L4a is the no-shared-Keychain-fallback stop condition.
- **S16 redaction by shape.**
  - Tests: Claude OAuth shapes (`sk-ant-oat01-…`, `sk-ant-ort01-…`) and the L4d Cursor shape are redacted in events, comments and logs, and refused by the commit guard.
  - If L4d finds no matching pattern, add an anchored pattern (never derived from a real value).
  - Conductor never reads `auth.json` to obtain an exact value.
- **S17** `CURSOR_ACCOUNT_HOME_BUILD_VERIFIED = false` until L5 passes, then a reviewed flip (D-G).
- **S18** Gates and installs never run under an account HOME (spy test).
- **S19** `agent logout` on removal. If it only deletes the file, the response note points to the session list in Cursor's account settings.
- **S20 disclosure** in §6, `docs/ARCHITECTURE.md` and the Accounts "Add an account" panel (M8-5 wording; M8-3 ships the doc text):
  - (a) a Cursor login is a plaintext 0600 file that the builder and repository checks can read as your user; a named-Cursor build also writes to your real npm, Go-module and Rust caches (R2-5);
  - (b) under "Next account, then another tool", work from any project may run on any listed account; use same/wait or do not add the account if a project must stay on one organisation;
  - (c) removed folders are deleted; sign-out is attempted, but Claude may keep a Keychain item.
- **S21** L2 is staged one account at a time (AC10).
- **S22 AC7** becomes a decoy grep. A test folder holds a planted `auth.json`/`.credentials.json` with `DECOY_TOKEN_…`, and the decoy must never appear in config, API, logs, events, comments, the run record or CLI JSON. `registerSecretEnv` is never used for accounts.
- **S23 (forward → M8-5)** Drop email and organisation from `providers[].detail` and from the limit reason.
- **S24 (forward)** Named Codex is dormant in fact (spy: zero `runProcess`/`prepareCodexHome` calls); enabling it is its own gate.
- **S25** This bookkeeping.
- **User decisions (2026-10-21, via the Lead):**
  - Extra Cursor accounts using the plaintext file store are **ACCEPTED**, with the visible S20 warning.
  - Live checks **authorised: only the no-sign-in ones, L1, L3 and L4a.** **L2, L4b–e and L5 are NOT authorised** and are marked "awaiting user permission" (AC10).
  - Consequences:
    - TODO 4 (`profile.ts`/`env.ts`/adapters/envelope path) may proceed only as far as L1, L3 and L4a allow;
    - the Claude allow-list comes from L1 (signed-out shapes); the Cursor `.cursor` allow-list stays empty plus refusal lists until L4c, so a named Cursor account is unusable until then;
    - **`conductor accounts login` (named-account sign-in, which needs L2 for Claude and L4b for Cursor) ships disabled.** It answers "Signing in extra accounts is not enabled yet (awaiting a live check)", and its code paths are tested against fakes only;
    - the L4c–e measurements stay blocked.
  - `ACCOUNT_TOOLCHAIN_VARS` stays deferred (moot until L5).
- **Unblock:**
  - router, engine and API work (TODO 1–3) may begin after Reviewer approval (given) and M8-2 config v6 (N8);
  - `profile.ts`/`env.ts` (TODO 4) only after L1, L3 and L4a pass (authorised); the L4c–e-dependent parts and `login` wait for L4b–e (awaiting user permission);
  - shipped named-Claude login only after L2;
  - named-Cursor builds only after L5 + the reviewed flip;
  - release after the Security code review confirms S1–S24 with tests.

### 2N. Reviewer conditions — BINDING (`.techteam/reviews/workspace-v2-m8-3-plan-review.md`, N1–N8; checked at the code review)

- **N1 One `cli-config.json` rule.** `permissions.allow` must be absent or empty (R2-4), and §2S S14 now says so; there is no looser text anywhere. AC6 tests it.
- **N2 `crossOnLimit` under `wait`.** One statement (§2.2 step 3): the `wait` pool is the head's first account only, so the code never builds other head-account candidates under `wait`. Test: the `wait` candidates contain no second head account.
- **N3 Abort ordering on removal.** The folder is not deleted (S8 step 4) until every child of that account has been reaped: stage jobs, asks, research, briefs, checks and discovery. This is enforced by the per-account lock (S9). Test: "remove during a running ask ⇒ ask failed and refunded; folder deleted only after the child exits".
- **N4 Auto-resume cost.** `schedule()` computes `routeStates(role)` (including `modelOffered` per account) **once per tick per role**, never per run. Test: N limit-paused runs on one role ⇒ one states computation per tick (spy).
- **N5 `moved` for a non-limit skip.** When the head's first account is signed out or never signed in, the note says "is not signed in" (the real reason). `Skipped.kind` is kept on the run record (`moved.reason`), so M8-5's F5 chip can avoid showing "Switched" for a non-limit skip (M8-5 wording check).
- **N6 Named-account starting state.** At startup the M8-1 `accountIds` fan-out checks every named account, and each completion calls `invalidate()` + `tickSoon()`. A restart therefore never leaves named accounts idle until a manual check. Test: startup with one named account ⇒ check spawned (fake) ⇒ state updated ⇒ a limit-paused run resumes.
- **N7 Product hint (forward → M8-5).** The Accounts panel and the rule hint say "another tool only if it is in that job's list", because chain-only `switch` cannot move a Claude-only row to Cursor. M8-3 ships the same sentence in `docs/ARCHITECTURE.md`.
- **N8 Sequencing gate.**
  - M8-3 commit 1 (types, `limit-rule.ts`, config v7) lands **after M8-2's config v6 commit**, so TODO 1–3 start then.
  - If M8-4 commit 1 needs `limit-rule.ts` earlier, the Lead records the order in `active-run.md`.
  - Before M8-4's first edit, the Lead checks the landed names against C1 (M8-4 review B2b).

### What must remain unchanged

- With one account per tool (all `default`) and `limitRule='switch'`, every route, argv and env is byte-identical to today. A golden + property test over the existing routing fixtures checks this, including the B1 example.
- Safety invariants:
  - Claude stages stay read-only with the fail-closed init check.
  - The builder never pushes and stays in its own worktree. `FORBIDDEN_PREP_ENV` is unchanged; the account env is a separate, envelope-owned path.
  - Redaction.
  - Allow-listed child env, tightened for named accounts.
  - Loopback + cookie + CSRF.
  - Forced holds untouched.
  - Gates fail closed.
  - The Codex and F11 locks are unchanged.
- `npm test` green, `npm run check` clean, zero runtime deps, live tests untouched. No real CLI runs inside `npm test`.

### Acceptance criteria

1. **AC1 Compatibility**:
   - With default accounts only, the golden routes, argv and env equal today's for every role × complexity × health fixture, including "Claude signed out + Cursor paused ⇒ Claude runs and reports".
   - The migration is idempotent and takes a backup; a newer file is refused.
2. **AC2 Router**: the named tests in §5.
3. **AC3 Engine**:
   - a build limit restarts on the next account or chain tool;
   - a read-only limit moves to the next candidate in the same call; research moves to the next Claude account;
   - nothing usable ⇒ pause until the earliest reset, then auto-resume on a reset, add, sign-in, reorder or rule change;
   - a reset never interrupts a healthy stage;
   - a removal restarts the stage;
   - refunds;
   - one comment + one notify per episode (merged with the fallback comment); the cap counts paused episodes only.
4. **AC4 Home never queues**:
   - 409 `limited` + `retryAt`, with no counter taken;
   - mid-call exhaustion ⇒ `failed` + refund;
   - the research gate agrees with the research run.
5. **AC5 Env** (spy on `runProcess`):
   - A named Claude child gets its own `CLAUDE_CONFIG_DIR` and none of `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_*`, `CURSOR_*`, `AGENT_CLI_*`, `CODEX_*`, `OPENAI_*`, `LINEAR_*`.
   - A named Cursor child gets `HOME` = its folder, the file store and its own `CURSOR_CONFIG_DIR`, with no `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN` or `XDG_CONFIG_HOME`. Two named accounts never see each other's folder.
   - The default env is byte-identical.
   - `assertAccountEnv` refuses a forged env with zero spawn.
   - A named Cursor build gets the account env through the envelope; the git env still wins, and `prep.env` HOME is still dropped.
6. **AC6 Folder hygiene**: each of these is refused before spawn with a static message:
   - a symlinked folder or parent, or a wrong owner;
   - mode 0755 (tightened first);
   - a planted refusal-list entry (Claude and Cursor);
   - a `cli-config.json` with `permissions.allow`;
   - a symlinked entry;
   - a traversal id.
7. **AC7 No credential handling**:
   - Conductor never opens `auth.json` or Claude's credential files (fs spy + static test, S5/S14). A decoy grep (S22): planted `DECOY_TOKEN_…` files in a test folder never appear in config, the API, logs, events, comments, the run record or CLI JSON;
   - the API rejects credential-like fields;
   - no path or email appears in any view or log (grep).
8. **AC8 API/CLI**:
   - strict bodies; no CSRF ⇒ 403;
   - removing `default` ⇒ 409; a Codex add is refused;
   - the CLI goes through the socket when a server runs, and writes directly under the lock otherwise;
   - remove signs out by default and skips it with `--keep-signin`;
   - re-adding the same name gives a new id and folder and shows not signed in (B4).
9. **AC9 Model caches**: `default.json` is reused; a named account's cache is created on check and deleted on removal, together with `forget()`; unknown-id files are swept.
10. **AC10 Live** — Security numbering S6/S15/S17/S21. **Authorisation status (user, 2026-10-21): L1, L3 and L4a are AUTHORISED. L2, L4b–e and L5 are awaiting user permission.** Every check runs **only with the user's permission**, manually and outside `npm test`, and each one is a stop condition. Evidence goes in `.techteam/runs/evidence/m8-3-*` and holds only yes/no, counts, entry names and hash-equality booleans: never a hash value, email, organisation, token, Keychain service suffix or path under `$HOME`. An S7-style identity grep runs over the evidence.
    - **L1** (S6, zero quota): every named-Claude spawn shape (discovery `initialize`, `auth status`, `--version`) runs signed out against an empty folder ⇒ the top-level and depth-2 entry names, which become `CLAUDE_PROFILE_ALLOWED`. Before the `profile.ts` commit.
    - **L2** (S21, the user's own login), staged one account at a time:
      - (i) record the default identity hash;
      - (ii) record the `Claude Code-credentials*` Keychain metadata (names and dates only, never `-w`);
      - (iii) the user signs in ONE named account;
      - (iv) the default is unchanged, a new item exists, and the default item's date is unchanged;
      - (v) only then a second account;
      - (vi) list the entry names after login.
      - Any change ⇒ stop.
      - L2 must pass before named Claude accounts can be signed in through the shipped CLI.
    - **L3** (S6, zero quota):
      - plant Claude `settings.json` (hooks, `apiKeyHelper`, `env.ANTHROPIC_BASE_URL` → a loopback listener), `CLAUDE.md`, `hooks/`, `.mcp.json` and a `.claude.json` `mcpServers` entry;
      - plant Cursor `~/.cursor/hooks.json` + `mcp.json` in an account HOME;
      - (a) the pre-flight refuses with zero spawns;
      - (b) in a scratch copy with the pre-flight bypassed, signed out: no marker and no listener connection for any spawn shape (record which shapes rely on the pre-flight alone).
    - **L4a–e** (S15, zero quota except the user's own login):
      - (a) with the default Cursor account signed in, an EMPTY account HOME + file store ⇒ `agent status` and `--list-models` both report **not signed in**. Otherwise the design is unsafe: stop;
      - (b) after the user signs in one named account: the default identity is unchanged, the named one differs, `auth.json` is regular 0600, and the shared Keychain entry's date is unchanged;
      - (c) the entry names under the account HOME and `.cursor`, plus the `cli-config.json` key names ⇒ the S14 allow-lists;
      - (d) whether `auth.json`'s value matches a `TOKEN_PATTERNS` shape (yes/no) ⇒ S16;
      - (e) whether `CURSOR_CONFIG_DIR` is needed ⇒ S1's optional key.
      - L1, L3 and L4a–e pass before the `profile.ts`/`env.ts`/login commit.
    - **L5** (S17, quota, opt-in): `cursor-nopush.test.ts` with `accountEnv('cursor', named)`, plus a variant with a loosened account `cli-config.json` ⇒ every push denied. Only then the `CURSOR_ACCOUNT_HOME_BUILD_VERIFIED` flip (its own commit, Security-reviewed).

## 2T. Threat model (for the Security design review)

Assets: the tools' sign-ins (Claude's per-dir store, Cursor `auth.json` in account folders, the Keychain for default accounts, Codex `auth.json`), quota per account, the worktrees, and Conductor's integrity (no push, read-only stages).

| # | Threat | Where | Mitigation | Residual / question for Security |
| --- | --- | --- | --- | --- |
| T1 | Account A's sign-in used by account B's process | `accountEnv`, adapters, envelope | Per-(provider,id) env; credential-locating vars set LAST; `assertAccountEnv` before every spawn (zero spawn on violation); spy tests (AC5) | — |
| T2 | Parent env credential (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_*`, `CURSOR_API_KEY`, `XDG_CONFIG_HOME`) overrides a named account | env | Dropped for named accounts; default unchanged | **Security: accepted** (default byte-identical). Named accounts drop the parent credentials from src and extra (S1). Doc note: named accounts bypass an `ANTHROPIC_BASE_URL` proxy |
| T3 | Traversal or symlink redirect of a folder to `~/.claude`, `~/.cursor` or elsewhere | `profile.ts` | Enum + `ACCOUNT_RE` only; asserted inside `<home>/accounts`; lstat at every level; owner + 0700 | — |
| T4 | Planted instructions or code in a named folder (Claude `settings.json` hooks/`apiKeyHelper`/env/`CLAUDE.md`/plugins/MCP; Cursor `hooks.json`/`mcp.json`/rules; `cli-config.json` allow rules) | folders (writable by any same-user process, incl. a builder's shell) | Allow-list measured live (L1, L2(vi), L4c); refusal lists; `cli-config.json` permissions check; pre-flight before every spawn; Claude stages keep `--safe-mode`; L2 marker check | **Security ruling (S5, S14):** top level alone is not enough. Depth-2 no-symlink, `nlink === 1`, the `.claude.json` key check, the `cli-config.json` content rule, and removal of non-allow-listed HOME entries. Transcript contents are not inspected |
| T5 | A sign-in token leaks via Conductor | logs/UI/API | Conductor never reads credential files (fs spy, AC7); no secret in config/API/logs | — |
| T6 | A named Cursor account's builder (untrusted repo content) reads `H/.cursor/auth.json` (a plain file, not the Keychain) and exfiltrates the session token. It can also read other folders by absolute path (same user, no sandbox) | build child | Builds on named accounts fail closed until verified (D-G). The file is Cursor-written, 0600, in a 0700 folder. Output redaction cannot know the token | **Security ruling:** accepted residual with S16 (redaction by shape), S19 (logout on removal), S20 (disclosure); "read-only only" kept only as the fail-closed state until L5 (S17) |
| T7 | A private HOME breaks or redirects the builder (toolchain caches written into the account folder, which then fail the hygiene check) | build | `ACCOUNT_TOOLCHAIN_VARS` (R2-5 narrowed: `npm_config_cache`, `GOMODCACHE`, `RUSTUP_HOME`, `CARGO_HOME`; builds only); git/ssh unaffected (envelope env); top-level HOME entries other than `.cursor` and the L4c-measured ones are **removed while the account is idle** (S14.3), with a count and class logged and a run note for shell start-up or credential-style files | **Security: settled** by S14.3 and R2-3/R2-5 |
| T8 | Cross-site creation, reorder or removal of accounts | API | Loopback + cookie + CSRF; strict bodies; no credential fields; sign-in only in the terminal, so a web request can at most create an empty signed-out folder; removal signs out and cannot sign in | — |
| T9 | Identity leak (email/org) | views/logs | S3; label only; grep tests | The existing `providers[].detail` still shows the default account's email — remove in M8-5? |
| T10 | Control-socket mutations bypass CSRF | `control.sock` | 0600 unix socket, same user (the existing OTP boundary); same strict handlers; no credential routes | **Security: accepted** under S11 (exact route allow-list, 0700 `run/` check, ≤ 16 KB JSON, no login route) |
| T11 | Forged limit messages cause restart storms | engine | 24 h cap; hops ≤ candidates; cap = 6 paused episodes ⇒ needs_human; removal restarts bounded by removals | — |
| T12 | Removal leaves a usable sign-in | remove | Logout by default; folder deleted; fresh nonce means no reuse (B4) | Security S8: random 4-hex suffix, never reused; S8 removal order; orphan sweep; static note when the sign-out fails |
| T13 | Dormant Codex accounts reachable | routing/env | `enabled:false`; add refused; spy test (zero Codex spawns and no home preparation for named ids) | Enabling = separate gate (Q5) |
| T14 | Hand-edited `accounts` config | `normalizeAccounts` | Own-property reads, `ACCOUNT_RE`, cap 8, null prototype, `default` enforced | — |
| T15 | Switching to a weaker-isolation tool | router | Chain-only (user D-A): only tools the user put in the role's chain; gates unchanged; one comment per episode carries the tier note | — |
| T16 | `AGENT_CLI_CREDENTIAL_STORE=file` silently falls back to the shared Keychain item when the file is missing | Cursor | L3/L4 must show "not signed in" with an empty folder while the Keychain holds a sign-in | Stop condition |

Security sign-off is asked on:

- the Q4 mechanisms as decided (per-dir Claude; per-HOME + file store Cursor);
- the envelope account-env path (§2.4) and D-G;
- T2, T4, T6, T7, T10, T12 and T16;
- live checks L1–L5 (Security numbering) as preconditions.

## 3. Files to Be Changed

| File path | Action | Purpose | Required changes | Reason |
| --- | --- | --- | --- | --- |
| `src/accounts/types.ts` | Create | types | §2.1 | F8 |
| `src/accounts/limit-rule.ts` | Create | C1 | §2.C | F8/F6 |
| `src/accounts/store.ts` | Create | normalize, add (nonce)/rename/reorder/remove over Config | §2.1, §2.7 | F8, B4 |
| `src/accounts/profile.ts` | Create | folders, hygiene, delete | §2.4 | T3, T4 |
| `src/accounts/env.ts` | Create | `accountEnv`, `accountBuildEnv`, `assertAccountEnv`, `ACCOUNT_TOOLCHAIN_VARS` | §2.4 | T1, T2, B5 |
| `src/accounts/service.ts` | Create | views, check, login/logout orchestration, removal, cache sweep | §2.6, §2.7 | F8 |
| `src/agents/routing.ts` | Modify | accounts, rule, `Skipped.kind`, `buildOk` | §2.2 | F8 |
| `src/agents/env.ts` | Modify | export the drop lists; default functions unchanged | §2.4 | T2 |
| `src/agents/provider.ts` | Modify | (tool, account) candidates, `sel` per candidate, `hops`, `onCandidate`, notes | §2.3 | F8, B3a |
| `src/agents/caller.ts` | Modify | `limited` + `retryAt` | §2.3 | Home |
| `src/agents/providers/{types,claude,cursor,codex}.ts` | Modify | `account` on run requests (incl. `ResearchRunReq`), `accountEnv` + assertion; Cursor `build.run` uses `req.accountEnv` | §2.4 | T1, B2, B5 |
| `src/agents/providers/verification.ts` | Modify | code constant `CURSOR_ACCOUNT_HOME_BUILD_VERIFIED = false` (flipped only after L5, in its own Security-reviewed commit); `buildOk` lookup | D-G, S17 | T6 |
| `src/pipeline/envelope.ts` | Modify | resolve `accountBuildEnv`, assert it, pass `accountEnv`; `FORBIDDEN_PREP_ENV` unchanged | §2.4 | B5 |
| `src/pipeline/engine.ts` | Modify | per-account pauses and quota, `routeStates(role?)` incl. `webResearchIsolated`, limit-paused re-evaluation, `pauseKind`, `accountsGate`, `accountRemoved`, `jobAccount`, scoped `resume`, `summariseCall` onLimit | §2.3 | F8, B1–B3 |
| `src/pipeline/stages.ts`, `src/pipeline/graph-build.ts`, `src/pipeline/context.ts` | Modify | `onLimitHit`, episodes from `hops`, merged fallback comment, `limitPauses` cap, run `account`/`moved` | §2.3 | B3 |
| `src/asks/service.ts`, `src/limits/budget.ts` | Modify | research routed over Claude accounts; gate before counters; `limited`; `refund()` | §2.3 | B2, Home |
| `src/types.ts` | Modify | Config/Run/Settings/ApiState fields | §2.1 | F8 |
| `src/config.ts` | Modify | v7 migration, `limitRule`, settings view/edit | §2.1, D-C | F8, F10 |
| `src/paths.ts` | Modify | `paths.accounts()`, `HOME_SKELETON` | §2.1 | F8 |
| `test/live/cursor-nopush.test.ts` | Modify | an opt-in variant that runs under `accountEnv('cursor', named)` plus a loosened `cli-config.json` (live suite only; never in `npm test`) | D-G, S17 | L5 |
| `src/runtime.ts` | Modify | AccountService; ModelService `envFor`/`accountIds` wiring | §2.C | F8 |
| `src/server/api.ts`, `src/server/http.ts` | Modify | endpoints, state fields, `ApiFail.extra`, control-socket routes | §2.7, §2.8 | F8 |
| `src/cli.ts` | Modify | `conductor accounts …` | §2.8 | F8 |
| `src/models/service.ts` | No change expected (M8-1 ships the seams) | — | — | — |
| `fixtures/fake-claude.mjs`, `fixtures/fake-agent.mjs` | Modify | record env keys, HOME and the credential-locating vars; limit-on-account scenario; fake `auth login/logout`, `login/logout`, `status` | — | AC3, AC5, AC8 |
| `test/accounts/*.test.ts`, `test/routing-accounts.test.ts`, `test/engine-accounts.test.ts`, `test/research-accounts.test.ts` | Create | AC1–AC9 | — | tests |
| `docs/API.md`, `docs/ARCHITECTURE.md`, `README.md` | Modify | accounts, rule, CLI, notes on the builder under a private HOME | — | docs |

## 4. Implementation TODO

0. [x] Reviewer approved (N1–N8) and Security approved (S1–S25, R2-1…R2-5). [ ] Steps 1–3 start after M8-2's config v6 lands (N8). [ ] Step 4 waits for L1, L3 and L4a (authorised); a failing L4a stops the Cursor part.
1. [ ] Types, `limit-rule.ts` (C1), store with nonce ids, config v7 migration, with tests.
2. [ ] Router plus golden compatibility tests (AC1, AC2).
3. [ ] Engine, stages, research routing, episodes, gate and refund (AC3, AC4).
4. [ ] `profile.ts`, `env.ts`, adapters, the envelope account-env path and the D-G build gate (AC5–AC7), only as far as L1, L3 and L4a allow. Named-account `login` ships disabled; L2 and L4b–e are **awaiting user permission**.
5. [ ] AccountService (login/logout/check), API, control socket, CLI, cache sweep (AC8, AC9).
6. [ ] Docs; `npm run check`; `npm test`; checkpoint. L2 (staged), L4b–e and L5 are **awaiting user permission**; enabling `login` and the L4c allow-lists are a follow-up once they pass.
7. [ ] Reviewer code review + Security code review.
- Commits: (1) model + migration; (2) router; (3) engine/stages/research/asks; (4) env/folders/envelope; (5) service/API/CLI/docs.

## 5. Testing Strategy

**Brief §7 router/accounts items → named tests**:

| Brief §7 item | Named test | Expected |
| --- | --- | --- |
| same-tool next account | `routing-accounts: switch — limited first account ⇒ second account of the same tool` | (claude, personal), `moved:'account'` |
| next eligible tool with its default model + fitted effort | `routing-accounts: switch — all Claude accounts limited ⇒ next chain tool Cursor` + `engine-accounts: switched stage gets selectionForTool(role, cursor, cfg, cursorAccountCatalogView)` | `moved:'tool'`; `sel` = tool default, effort fitted, note |
| never beyond the chain (D-A) | `routing-accounts: switch — Claude-only chain, all Claude limited ⇒ paused, never Cursor` | paused |
| model-lacking account skipped | `Q7: account without the model tried after those that offer it`, `Q7: none offers it ⇒ tool default + modelFallback`, `D-D: unknown list ⇒ null ⇒ ordered as offering, selection = tool default + note` | order; `modelFallback`; no undiscovered id in argv |
| ineligible tool never chosen | `gate: build never Claude/Codex`, `gate: research only Claude`, `D-G: unverified named Cursor account never builds` | not candidates; reasons given |
| same/wait never change tool on a limit | `same: all Claude limited ⇒ paused, never Cursor`, `wait: second Claude account free ⇒ paused`, `same: Claude not installed ⇒ Cursor (non-limit fallback kept)`, `same: head's last account hits a limit mid-call ⇒ no hop to Cursor; paused`, `wait: first account hits a limit mid-call ⇒ paused, no hop`, `same: head spawn error mid-call ⇒ Cursor (non-limit fallback kept)` | as stated |
| nothing usable ⇒ pause until earliest reset | `pause: min pausedUntil over S`, `B1: one signed out + one paused ⇒ today's rule (first non-paused default runs)`, `fallback never a named account without sign-in`, `never-signed-in named account + every credentialed account paused ⇒ paused, not ineligible` | as stated |
| reset/new account ⇒ resume | `engine-accounts: limit-paused run resumes on reset / account added+signed in / reorder / rule change` | queued then started; one history line |
| removed account ⇒ restart | `engine-accounts: removing the account of a running stage restarts it on the next` | abort, refund, `moved.restarted`, no `restartTimes` |
| running stage hit by a limit restarts; rejected attempts not counted | `build limit ⇒ restart on next account`, `read-only limit ⇒ next candidate same call`, `research limit ⇒ next Claude account`, `agentRuns unchanged after limit` | as stated |
| reset never interrupts a healthy stage | `pause expiry during a running stage ⇒ no abort` | — |
| Home never queues | `asks: no account ⇒ 409 limited + retryAt, counter untouched`, `asks: mid-call exhaustion ⇒ failed + refund`, `research gate and run agree` | — |
| one toast + one comment per switch episode | `three hops in one episode ⇒ 1 comment, 1 notify`, `tool hop on limit ⇒ fallback comment merged (1 comment total)`, `auth tool hop ⇒ today's fallback comment` | counts |
| cap counts paused episodes only | `7 successful switches ⇒ never needs_human`, `7 paused episodes ⇒ needs_human` | — |
| route() pure, gates fail closed | purity test extended | — |
| store/migration/backup round-trip | `test/accounts/store.test.ts` (v5/v6 → v7, idempotent, backup, newer refused, hostile `accounts`, re-add ⇒ new nonce id) | — |
| env allow-list proves no cross-account credential | `test/accounts/env.test.ts` (AC5, incl. the envelope build path and default byte-identity) | — |
| names sanitised | `store.test.ts: bidi/zero-width/control cleaned, ≤ 40, ACCOUNT_RE, no traversal` | — |

Other test types:

- **Unit**:
  - hygiene (AC6);
  - `effectiveLimitRule` plus the static single-reader test;
  - the view allow-list;
  - `webResearchIsolated` from code;
  - `PUT /api/roles` research pairing now validates.
- **API**: strictness, CSRF, status codes, credential-field rejection, and no path, email or secret anywhere (grep).
- **CLI**: fake socket and direct mode. Login and logout run only against fake binaries with an inherited fake TTY.
- **Regression**: all existing routing, engine, stage, asks and envelope tests unchanged and green; golden argv/env (AC1).
- **Live**: L1–L5 (with L4a–e) run manually, only with the user's permission,, outside `npm test`. The evidence holds counts and yes/no only, plus the S7-style identity grep.
- **Build**: `npm run check`, `npm test`.

## 6. Risks and Dependencies

- **Tool-behaviour assumptions are stop conditions, not guesses**:
  - Claude's per-dir sign-in separation (L2, staged per S21);
  - Cursor's file store with no Keychain fallback (L4a, T16);
  - what each tool writes into its folder (L1, L2(vi), L4c).
- **Builder under a private HOME** (named Cursor accounts): toolchain differences; fail-closed until L5 + the constant flip (D-G). Until then, build switching moves only to the `default` Cursor account.
- **T6**: the session token is a plain file the builder can read, a real weakening compared with the Keychain. Security ruling: an accepted residual, given S16, S19, S20 and the D-G gate.
- **Disclosure (S20, binding):**
  - (a) Signing in another account stores that tool's login in a private folder under the Conductor home. For Cursor this is a plaintext `auth.json` (0600), not the Keychain. Code run by the Cursor builder or by repository checks can read it as your user, just as it can read your other files. Builds on a named Cursor account also use (and can write to) your real npm, Go-module and Rust caches.
  - (b) Under "Next account, then another tool", work from any project may run on any listed account, including a personal one. If a project must stay on one organisation's account, use same/wait or do not add the account.
  - (c) Folders of removed accounts are deleted. Sign-out is attempted, but Claude may keep a Keychain item for a folder that no longer exists.
  - Non-binding: the docs suggest `tmutil addexclusion` for `<home>/accounts`.
- **Product cost (S17 note):** builds on named Cursor accounts that need a private registry or an SSH remote will fail. The Accounts UI says so.
- **User decisions (2026-10-21):**
  - plaintext Cursor file store for extra accounts ACCEPTED with the S20 warning;
  - only L1, L3 and L4a authorised;
  - named-account sign-in (L2, L4b) and L4c–e stay blocked, "awaiting user permission", so named accounts cannot be signed in from the shipped CLI in this slice.
- **Isolation scope (Security decision):** per-account folders protect against **accidental** credential crossing. They are not a boundary against a hostile same-user process.
- **Behaviour change**: with a second account, a build limit restarts at once instead of pausing. This is intended by F8.
- **Ordering**: config v7 requires M8-2's v6 first. M8-4 follows M8-3 (C1). The M8-1 seams are agreed.
- Pauses stay in memory (D-E).
- Brief §6: Q4 decided (user), Q7 taken as recommended, Q5 (Codex dormant), D-A decided (user).

## 7. Requirement Coverage Matrix

| Requirement (brief F8 / §7) | Planned change | Verification | Status |
| --- | --- | --- | --- |
| Ordered sign-ins per tool | `accounts` v7, reorder | store tests, AC8 | Covered |
| First usable (signed in, installed, not limited, offers the model) | router §2.2 | AC2 | Covered |
| switch → next account, then next chain tool with default model + fitted effort | router + M8-2 `selectionForTool` | AC2, engine sel test | Covered |
| same/wait never leave the tool | D-B | AC2 | Covered |
| Nothing usable ⇒ pause until earliest reset; auto-resume | router + scheduler | AC2, AC3 | Covered |
| Running stage restarts on next account; refunds | `onLimitHit`, readOnly/research loops | AC3 | Covered |
| Reset never interrupts | start-only routing | AC3 | Covered |
| Home never queues | `accountsGate`, 409 | AC4 | Covered |
| One toast + one comment per episode | §2.3 episodes | AC3 | Covered |
| route() pure, accounts under providers, gates fail closed | §2.2 | purity + gate tests | Covered |
| Per-account folders, env via allow-list (CLAUDE_CONFIG_DIR; Cursor HOME + file store) | §2.4 | AC5, AC6, L1–L4 | Covered (live: user) |
| Credentials never in config/logs/UI or another account's process | §2.4, §2.5 | AC5, AC7 | Covered |
| Names sanitised | `normalizeAccounts` | store tests | Covered |
| Versioned config incl. replacing `onClaudeLimit` | v7, D-C, C1 | AC1 | Covered |
| M8-1 `default` caches | §2.6 | AC9 | Covered |
| API list/register/reorder/remove (strict, CSRF) | §2.7 | AC8 | Covered |
| CLI add/list/check/remove (+login/move) | §2.8 | AC8 | Covered |
| Sign-in stays a terminal step | `login` in the CLI only | AC7, AC8 | Covered |
| Builds on named Cursor accounts | D-G (S17) | L5 + reviewed constant flip | Gap until L5 (opt-in, quota) |
| Codex accounts | dormant | T13 spy | Gap until Q5 + Security gate |
