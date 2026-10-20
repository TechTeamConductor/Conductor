# Conductor HTTP / SSE API (UI ↔ server contract)

Frozen for v1. Types live in [`src/types.ts`](../src/types.ts) (`Api*` interfaces). The server binds to `127.0.0.1` only.

## Transport & security (the UI must follow these)

- **Auth.** The browser arrives already signed in: `conductor open` mints a one-time URL that sets an `HttpOnly; SameSite=Strict` session cookie. The UI never sees or handles tokens. Any `401` ⇒ show a full-page "Session expired — run `conductor open` in a terminal" message.
- **Mutations** (`POST`/`PUT`/`DELETE`) must send `Content-Type: application/json` **and** header `X-Conductor-CSRF: <state.csrf>` (value from the latest `GET /api/state`). Missing/incorrect ⇒ `403`.
- **CSP** is `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'`. Therefore: **no inline `<script>`, no inline `style="…"` attributes, no external fonts/CDNs**. Use classes; set dynamic values via `element.style.setProperty('--x', …)` (CSSOM is allowed).
- **Static files** are an exact whitelist: `/` → `ui/index.html`, `/app.js`, `/style.css`, `/favicon.svg`. Nothing else is served.
- **Errors**: HTTP status + body `{"error":{"code":"…","message":"…"}}` (`ApiError`). Messages are human-readable and safe to show verbatim.
- All timestamps are **epoch milliseconds** unless noted. Bodies ≤ 1 MB.

## Read endpoints

### `GET /api/state` → `ApiState`
Everything the dashboard needs in one call (see `ApiState`): `setup` (wizard steps; `complete:false` ⇒ show the setup wizard), `health` (claude/cursor/linear + warnings), `quota.claude`, `engine`, `settings`, `repos`, `runs` (`ApiRunSummary[]`, newest first, includes closed runs), `csrf`.

### `GET /api/runs/:key` → `ApiRunDetail`  (`404` if unknown)
Summary plus `plan`, `planMarkdown`, `planReview`, `verdicts[]` (per loop), `gates` (baseline + per-loop `GateRun` and `GateComparison`), `bugs[]`, `sessions[]` (each with a copyable `resumeCommand`), `timeline[]`, `diffStat`, `description`, `worktree`, `baseSha`, `commitSha`.

### `GET /api/runs/:key/log?after=<seq>&limit=<n>` → `{ events: LogEvent[], next: number }`
Backlog for the live log. `after` default 0, `limit` default 500 (max 2000). `next` = highest seq returned (pass as `after` next time).

### `GET /api/events` — Server-Sent Events
`text/event-stream`, `retry: 3000`. Events (JSON `data`):

| event | data | when |
| --- | --- | --- |
| `state` | `{ now, runs: ApiRunSummary[], engine: ApiEngine, quota: ApiQuota }` | any run/engine change (debounced ≤ 1/s) — **merge into local state** |
| `log` | `{ key: string, event: LogEvent }` | each normalised agent event (both Claude and Cursor) |
| `toast` | `{ level: 'info'\|'warn'\|'error', text: string }` | notable moments (needs human, limit pause, ready) |
| `ping` | `{ now }` | every 20 s (keep-alive; use to detect a dead stream) |

On reconnect the UI should refetch `GET /api/state` and the open run's `GET …/log?after=<lastSeq>`.

## Mutation endpoints (all return `{ "ok": true, … }` on success)

| Endpoint | Body | Result / notes |
| --- | --- | --- |
| `POST /api/tasks` | `{ title: string, description?: string, repo?: string }` | `201 { ok, key, url }` — creates a Linear issue carrying the trigger label (state: Todo). `repo` must be a registered repo name (optional if only one). |
| `POST /api/runs/:key/approve` | — | approve a plan in `awaiting_approval` |
| `POST /api/runs/:key/retry` | — | retry the origin stage of a `needs_human`/`failed` run, or re-run from plan when `ready` (rework) |
| `POST /api/runs/:key/resume` | — | resume a `paused`/`parked` run now |
| `POST /api/runs/:key/abort` | — | kill the running agent (process group) and mark `aborted` |
| `POST /api/runs/:key/cleanup` | — | remove the worktree (and local branch if merged) of a `ready`/`finished`/`aborted` run |
| `POST /api/runs/:key/open` | `{ target }` | `target`: `cursor` (open worktree in Cursor), `terminal-claude` / `terminal-cursor` (new Terminal window resuming the latest session of that agent), `claude-desktop` (`claude --desktop --resume <id>`), `finder`, `linear` (open issue URL). Server computes all paths/ids from the run record. |
| `POST /api/engine/pause` | `{ paused: boolean }` | global pause/resume (no new claims; running stages finish) |
| `PUT /api/settings` | partial `Settings` | validated server-side; returns `{ ok, settings }` |
| `POST /api/auth/logout` | — | clears the session cookie |

### Setup endpoints (used by the wizard; idempotent)

| Endpoint | Body | Result |
| --- | --- | --- |
| `POST /api/setup/linear-key` | `{ key: string }` | validates against Linear, stores in Keychain. `{ ok, viewer:{id,name,email}, teams:[{id,key,name}] }`. The key is **never** echoed back. |
| `POST /api/setup/team` | `{ teamId: string, mode: 'labels'\|'states', dryRun?: boolean }` | `dryRun:true` ⇒ preview only: `{ ok, dryRun:true, willCreate:string[], defaultState:{id,name,type}\|null, unstartedStates:string[], warnings:string[] }`. `dryRun:false` ⇒ creates labels (and statuses in `states` mode): `{ ok, dryRun:false, created:string[], manual?:string[] }` — `manual` lists what the user must create by hand if permissions failed. |
| `POST /api/setup/repo` | `{ path: string, name?: string }` | validates it is a git work tree (not `/`, not `$HOME`), detects base branch + gates: `{ ok, repo: ApiRepo }` |
| `DELETE /api/setup/repo/:name` | — | unregister (does not touch the folder) |
| `POST /api/setup/probe` | `{ target: 'claude'\|'cursor'\|'linear' }` | explicit health probe that may spend a tiny amount of agent quota: `{ ok, detail, durationMs }` |

## UI behaviour requirements (for the implementer)

1. **First load**: `GET /api/state`; if `!setup.complete` render the **Setup wizard** (4 steps: Agents → Linear key → Team → Repo) with per-step status from `setup.steps`; otherwise the **Dashboard**.
2. **Dashboard**: header (engine pill with pause/resume, Claude quota meter from `quota.claude.utilization7d` + reset time, "New task" button, settings), **board** with columns from `ApiRunSummary.column` (`queued, planning, plan_ready, building, verifying, needs_human, paused, ready`; `closed` runs live in a collapsible "History"). Cards show key, title, repo, activity sentence, loop `n/max`, open-bug count, cost, an `unverified` badge, who is working (Claude/Cursor chip).
3. **Run detail** (drawer on desktop, full page on phone): tabs **Overview** (activity, next action, needs-human reason, action buttons honouring `canApprove/canRetry/canAbort/canCleanup`), **Live log** (SSE; filters by agent; auto-scroll with a "pinned" toggle; collapse noisy tool events), **Plan** (rendered `planMarkdown` + AC), **Verification** (verdict per loop, gate table with baseline vs now, bugs with severity), **Sessions** (resume commands with copy buttons + "Open in Claude app / Cursor / Terminal" buttons), **Timeline**.
4. **Honest empty/limit states**: when `engine.providerPause.claude` is set show a banner "Claude usage limit — resuming automatically at <time>"; when health warns about leaked instruction files, show them; `setup.complete:false` never shows an empty board.
5. **Accessibility/responsive**: keyboard reachable, focus-visible, ARIA live region for toasts, `prefers-color-scheme` light/dark (and respects `prefers-reduced-motion`), works at 390 px width without horizontal page scroll.
6. Never render server strings as HTML (`textContent` only); no `innerHTML` with data.
