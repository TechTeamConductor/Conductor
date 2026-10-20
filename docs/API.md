# Conductor HTTP / SSE API (UI ↔ server contract)

The v2 contract (board-native; no Linear). Types live in [`src/types.ts`](../src/types.ts) (`Api*` interfaces). The server binds to `127.0.0.1` only.

## Transport & security (the UI must follow these)

- **Auth.** The browser arrives already signed in: `conductor open` mints a one-time URL that sets an `HttpOnly; SameSite=Strict` session cookie. The UI never sees or handles tokens. Any `401` ⇒ show a full-page "Session expired — run `conductor open` in a terminal" message.
- **Mutations** (`POST`/`PUT`/`DELETE`) must send `Content-Type: application/json` **and** header `X-Conductor-CSRF: <state.csrf>` (value from the latest `GET /api/state`). Missing/incorrect ⇒ `403`.
- **CSP** is `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'`. Therefore: **no inline `<script>`, no inline `style="…"` attributes, no external fonts/CDNs**. Use classes; set dynamic values via `element.style.setProperty('--x', …)` (CSSOM is allowed).
- **Static files** are an exact whitelist: `/` → `ui/index.html`, `/app.js`, `/style.css`, `/favicon.svg`. Nothing else is served.
- **Errors**: HTTP status + body `{"error":{"code":"…","message":"…"}}` (`ApiError`). Messages are human-readable and safe to show verbatim.
- All timestamps are **epoch milliseconds** unless noted. Bodies ≤ 1 MB.

## Read endpoints

### `GET /api/state` → `ApiState`
Everything the dashboard needs in one call (see `ApiState`): `setup` (wizard steps `agents`, `repo`; `complete:false` ⇒ show the setup wizard), `health` (claude/cursor + warnings), `quota.claude`, `engine` (incl. `storageProblem`, `ignored`), `settings`, `repos`, `runs` (`ApiRunSummary[]`, newest first, includes closed runs), **`cards`** (cards that have no run yet — Backlog / To do — each `{key,title,lane,kind,note?}`), `csrf`.

### `GET /api/providers` → `{ providers: ApiProvider[] }`
Every registry provider (`claude`, `cursor`, later `codex`): `state` (`ok | missing | broken-install | not-logged-in | attention`), `version`/`detail` (what the CLI said — redacted and truncated; render with `textContent`), a **static** `hint` (never CLI text; Conductor shows it and never runs it), `capabilities {readOnly, build, buildIsolationVerified}` — **derived from code, never from config** — the read-only `tier` (`verified | partial | unverified | blocked`), `inUse` (appears in a role chain) and `pausedUntil`. The same list is `ApiState.providers`.

### `GET /api/roles` → `ApiRoles`
`{ roles, choices, needs }`: the configured chain per role, for each role × provider whether it may be assigned (`ok`, a human `reason` when not, `needsAck` for an `unverified` provider) and what each role requires (`build` for implementation / debugging / documentation, `research` for research).

### `GET /api/runs/:key` → `ApiRunDetail`  (`404` if unknown)
Summary plus `notes[]` (the card's conversation: your notes and Conductor's), `plan`, `planMarkdown`, `planReview`, `verdicts[]` (per loop), `gates` (baseline + per-loop `GateRun` and `GateComparison`), `bugs[]`, `sessions[]` (each with a copyable `resumeCommand`), `timeline[]`, `diffStat`, `description`, `worktree`, `baseSha`, `commitSha`.

### `GET /api/board` → `{ projects, items, milestones }` and `GET /api/items/:key` → `{ item, comments, children, decisions }`
The raw board (newest 2000 items). Cards with a run are driven through `/api/runs/:key/*`; these are for browsing.

### `GET /api/runs/:key/log?after=<seq>&limit=<n>` → `{ events: LogEvent[], next: number }`
Backlog for the live log. `after` default 0, `limit` default 500 (max 2000). `next` = highest seq returned (pass as `after` next time).

### `GET /api/events` — Server-Sent Events
`text/event-stream`, `retry: 3000`. Events (JSON `data`):

| event | data | when |
| --- | --- | --- |
| `state` | `{ now, runs: ApiRunSummary[], cards: ApiCard[], engine: ApiEngine, quota: ApiQuota }` | any run/engine change (debounced ≤ 1/s) — **merge into local state** |
| `log` | `{ key: string, event: LogEvent }` | each normalised agent event (both Claude and Cursor) |
| `toast` | `{ level: 'info'\|'warn'\|'error', text: string }` | notable moments (needs human, limit pause, ready) |
| `ping` | `{ now }` | every 20 s (keep-alive; use to detect a dead stream) |

On reconnect the UI should refetch `GET /api/state` and the open run's `GET …/log?after=<lastSeq>`.

## Mutation endpoints (all return `{ "ok": true, … }` on success)

| Endpoint | Body | Result / notes |
| --- | --- | --- |
| `POST /api/tasks` | `{ title: string, description?: string, repo?: string }` | `201 { ok, key, url:'' }` — creates a card in To do (the engine starts it right away). `repo` must be a registered repo name (optional if only one). Extra fields (`author`, `kind`, `lane`, `key`, …) are ignored: authorship is server-side. |
| `POST /api/projects` | `{ key: 'ABC', name: string, repo?: string }` | `201 { ok, project }` |
| `POST /api/items/:key/move` | `{ lane: 'backlog'\|'todo'\|'done'\|'canceled' }` | the only way to move a card; cards with a run are routed through the engine (park / restart / finish / abort); `active`, `needs_you`, `review` are refused (`400`) |
| `POST /api/items/:key/comment` | `{ body: string }` | adds YOUR note (author is always `user`); read by the next plan |
| `POST /api/items/:key/edit` | `{ title?, description? }` | `null`/absent leaves a field unchanged; a description edit on a card with a run halts it at the next stage boundary |
| `POST /api/runs/:key/approve` | `{ rev: number }` | approve a plan in `awaiting_approval`; **`rev` is required** and must be the current plan revision (`409` if the plan was replaced) |
| `POST /api/runs/:key/retry` | — | retry the origin stage of a `needs_human`/`failed` run, or re-run from plan when `ready` (rework) |
| `POST /api/runs/:key/resume` | — | resume a `paused` run now (a `parked` run is restarted with `move → todo`) |
| `POST /api/runs/:key/abort` | — | kill the running agent (process group) and mark `aborted` |
| `POST /api/runs/:key/cleanup` | — | remove the worktree (and local branch if merged) of a `ready`/`finished`/`aborted` run |
| `POST /api/runs/:key/open` | `{ target }` | `target`: `cursor` (open worktree in Cursor), `terminal-claude` / `terminal-cursor` (new Terminal window resuming the latest session of that agent), `claude-desktop` (`claude --desktop --resume <id>`), `finder`. Server computes all paths/ids from the run record. |
| `POST /api/engine/pause` | `{ paused: boolean }` | global pause/resume (no new claims; running stages finish) |
| `PUT /api/settings` | partial `Settings` | validated server-side; returns `{ ok, settings }`. `stages` / `onClaudeLimit` are **derived** from the role chains; a PUT changes only the first claude/cursor slot (or the cursor-follows-claude rule) and leaves every other chain entry alone |
| `PUT /api/roles` | `{ roles: { <role>: { providers: ProviderId[1..4], autoByComplexity?: { S?\|M?\|L?: ProviderId } } }, acknowledge?: ProviderId[] }` | strict: plain objects only; role names are own-property checked; provider ids come from the registry; every pairing is checked against the capability/tier gate (`400 unsupported_pairing` with a human reason, e.g. "Claude cannot write code"); an `unverified` provider needs `acknowledge` (`409 needs_acknowledgement`); a `blocked` one is refused. Returns `{ ok, roles, notices }` — `notices` say where the text goes for a newly assigned provider |
| `POST /api/providers/:id/test` | `{ level?: "cheap" \| "canary", confirm?: true }` | `:id` is checked against the registry first (`404`). `cheap` (default) is a zero-quota look (version / login status). `canary` calls the model: it needs `"confirm": true` **on every call** (`400 confirm_required`), runs one at a time per provider (`409 busy`), is refused while stages are running, and has a one-minute cool-down (`429 cooldown`) |
| `POST /api/auth/logout` | — | clears the session cookie |

### Setup endpoints (used by the wizard; idempotent)

Storage failures answer `503`; validation failures `400`; unknown keys `404`; refused moves/duplicates `409`.

| Endpoint | Body | Result |
| --- | --- | --- |
| `POST /api/setup/repo` | `{ path: string, name?: string }` | validates it is a git work tree (not `/`, not `$HOME`), detects base branch + gates: `{ ok, repo: ApiRepo }` |
| `DELETE /api/setup/repo/:name` | — | unregister (does not touch the folder) |
| `POST /api/setup/probe` | `{ target: 'claude'\|'cursor' }` | explicit health probe that may spend a tiny amount of agent quota: `{ ok, detail, durationMs }` |

## UI behaviour requirements (for the implementer)

1. **First load**: `GET /api/state`; if `!setup.complete` render the **Setup wizard** (2 steps: Agents → Repository) with per-step status from `setup.steps`; otherwise the **Dashboard**.
2. **Dashboard**: header (engine pill with pause/resume, Claude quota meter from `quota.claude.utilization7d` + reset time, "New task" button, settings), **board** with columns **Backlog** and **To do** (run-less `cards`, with Start / Park / Cancel) followed by the run columns from `ApiRunSummary.column` (`queued, planning, plan_ready, building, verifying, needs_human, paused, ready`; `closed` runs live in a collapsible "History"). Cards show key, title, repo, activity sentence, loop `n/max`, open-bug count, an `unverified` badge, who is working (Claude/Cursor chip).
3. **Run detail** (drawer on desktop, full page on phone): tabs **Overview** (activity, next action, needs-human reason, action buttons honouring `canApprove/canRetry/canAbort/canCleanup/canPark/canFinish`), a **Notes** panel (the card's conversation + an input for your notes), **Live log** (SSE; filters by agent; auto-scroll with a "pinned" toggle; collapse noisy tool events), **Plan** (rendered `planMarkdown` + AC), **Verification** (verdict per loop, gate table with baseline vs now, bugs with severity), **Sessions** (resume commands with copy buttons + "Open in Claude app / Cursor / Terminal" buttons), **Timeline**.
4. **Honest empty/limit states**: when `engine.providerPause.claude` is set show a banner "Claude usage limit — resuming automatically at <time>"; when health warns about leaked instruction files, show them; `setup.complete:false` never shows an empty board.
5. **Accessibility/responsive**: keyboard reachable, focus-visible, ARIA live region for toasts, `prefers-color-scheme` light/dark (and respects `prefers-reduced-motion`), works at 390 px width without horizontal page scroll.
6. Never render server strings as HTML (`textContent` only); no `innerHTML` with data.
