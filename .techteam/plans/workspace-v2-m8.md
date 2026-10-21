# Implementation plan — M8 "product layer" (master)

- Task: build the product layer from the approved prototype (brief: `.techteam/briefs/product-layer.md`; design: `.techteam/design/v16/Main.dc.html`, artifact Version 16).
- Author: TechTeam Lead
- Date: 2026-10-21
- Plan status: pending_reviewer (master = direction + slice order; each slice has its own sub-plan and its own approval)

## 1. Current State (verified against the code at clone HEAD `8eaab46`, 2026-10-21)

- Roles: `src/agents/roles.ts` — 10 roles, `RoleConfig = { providers, autoByComplexity? }`, `normalizeRoles` strict. No model/effort per role.
- Routing: `src/agents/routing.ts` — pure `route()` over `ProviderState` (caps, tier, installed, auth, pausedUntil, webResearchIsolated). One state per provider; no accounts.
- Models: `cfg.agents.{claude,cursor,codex}.model` (free text; Codex validated by `CODEX_MODEL_RE` in `src/config.ts:40`), appended as `--model` by `buildClaudeArgs` (`src/agents/claude.ts:58`), `buildCursorArgs` (`src/agents/cursor.ts:20`), `buildCodexArgs` (`src/agents/providers/codex.ts:66`). No effort flag anywhere. Nothing discovers models.
- Config: `CONFIG_SPEC` version 5 with migrations 2→5 (`src/config.ts:45`) on the `src/schema/` framework (backup + quarantine).
- Health: zero-quota `detect`/`auth`/`selfTest` per provider (`src/agents/providers/probe.ts`), cached by the service and read by `Engine.routeStates()` (`src/pipeline/engine.ts:182`).
- API: `GET /api/state` (providers, settings), `PUT /api/roles` (strict), `PUT /api/settings`, `POST /api/providers/:id/test`, asks API (`/api/ask`, `/api/asks/*`).
- UI: vanilla `ui/app.js` with a three-mode start screen and dialogs (M5), Settings panel, board.
- Verified on this machine today: Claude Code 2.1.304 answers the `initialize` control request with 13 models + `supportedEffortLevels` per model in ~1.3 s with stdin closed immediately, writes nothing to its cwd; Cursor agent 2026.10.19 `--list-models` prints 265 ids (header line "Available models", trailing "Tip:" line; Cursor also accepts a parameterised `--model 'id[effort=high,fast=false]'` form); Codex is broken (`ENOENT` native binary).

## 2. Expected State

M8 delivers the brief's F1–F11 in seven slices, each with its own sub-plan (`workspace-v2-m8-<n>.md`), Reviewer approval, and — where the brief requires — Security design sign-off before the first edit.

| Slice | Features | Sub-plan | Security design? | Depends on | User decisions needed first (brief §6) |
| --- | --- | --- | --- | --- | --- |
| M8-1 | F7a model discovery (adapters, parsers, cache, refresh, API) | `-m8-1.md` | **Yes** (model discovery, untrusted CLI output) | — | Q9, Q10 (storage only; surfacing is M8-2/M8-5) |
| M8-2 | F7 model/effort/tool defaults per role (config v6, argv, API, row control) | `-m8-2.md` | Yes (argv from discovered text) | M8-1 | Q10 |
| M8-3 | F8 accounts store, routing, limit handling, API, CLI | `-m8-3.md` | **Yes** (credentials, isolation) | M8-1, M8-2 | Q4, Q7 |
| M8-4 | F6 run mode overlay | `-m8-4.md` | No (policy only; forced holds untouched) | M8-3 (limit rule) | Q1, Q6 |
| M8-5 | UI: Settings (F10), accounts popover/banners/chips (F9), dynamic wording (F5) | `-m8-5.md` | No | M8-2..4 | Q8 |
| M8-6 | Home composer: Ask inline (F1, F2) → Work intake (F3) → Research intake (F4) | `-m8-6.md` | **Yes** for F3 (new model-written structured output → cards) | M8-2 | Q2, Q3 |
| M8-7 | F11 any tool, any job — one pairing at a time | `-m8-7-<pairing>.md` | **Yes**, per pairing | M8-3; Codex pairings need Q5 | Q5 |

What must remain unchanged across all slices: the safety invariants in the brief §0.4 and `CLAUDE.md`; with no M8 setting used, every argv is byte-identical to today and the default routes are v1's; `npm test` green and `npm run check` clean after every commit; zero runtime dependencies.

### Role mapping (F7 rows → v2 roles; confirmed in M8-2)

| UI row | v2 role(s) | Note |
| --- | --- | --- |
| Quick Ask | `context` | the asks service already routes through `context` |
| Deep Research | `research` | Claude only until an F11 research pairing is lifted |
| Design the work | `requirements` (+ `architecture` mirrors it) | new F3 call uses `requirements` |
| Write the plan | `planning` | |
| Review the plan | `review` | |
| Build the code | `implementation` (+ `debugging`, `documentation` follow it) | build-class gate unchanged |
| Verify the result | `verification` | |

## 3. Files to Be Changed (master level — exact lists are in each sub-plan)

| Area | Action | Slices |
| --- | --- | --- |
| `src/models/` (new: discovery adapters, sanitiser, cache, service, Cursor families, effort fitting) | Create | M8-1, M8-2 |
| `src/agents/roles.ts`, `src/config.ts`, `src/types.ts` (config v6/v7) | Modify | M8-2, M8-3 |
| `src/agents/claude.ts`, `src/agents/cursor.ts`, `src/agents/providers/codex.ts` (model/effort argv) | Modify | M8-2 |
| `src/accounts/` (new), `src/agents/routing.ts`, `src/agents/env.ts`, `src/pipeline/engine.ts` | Create/Modify | M8-3 |
| `src/policy/policy.ts` (effective-policy overlay) | Modify | M8-4 |
| `src/server/api.ts` | Modify | every slice |
| `ui/app.js`, `ui/style.css`, `ui/index.html` | Modify | M8-2 (row control), M8-5, M8-6 |
| `prompts/design-work.md` (new) | Create | M8-6 |
| `docs/API.md`, `docs/ARCHITECTURE.md`, `README.md`, `.techteam/runs/active-run.md` | Modify | every slice |

## 4. Implementation TODO (slice order)

- [ ] M8-1 discovery → [ ] M8-2 per-role model/effort → [ ] M8-3 accounts → [ ] M8-4 run mode → [ ] M8-5 UI → [ ] M8-6 Home → [ ] M8-7 pairings (Security design may run in parallel with M8-5/6; ships last).
- Each slice: sub-plan → Reviewer (+ Security where marked) → implement in small commits → `npm run check` + `npm test` → slice report appended to `.techteam/runs/active-run.md`.

## 5. Testing Strategy

The brief §7 is the acceptance list; each sub-plan maps its part of §7 to named tests. Cross-slice: fake-agent fixtures gain the discovery entry points (no network, no quota); UI slices add scripted browser checks (desktop + phone, light + dark) with screenshots in `.techteam/runs/evidence/`.

## 6. Risks and Dependencies

- **Alpha/undocumented CLI surfaces** (Claude `initialize`, Codex `model/list`): one adapter each, version recorded, fixture-tested, fail to "unavailable" with the last cache — never to an invented list.
- **Codex unverifiable here** (broken install): its discovery adapter is built against a fixture and stays disabled in production until a working install passes a live check (needs Q5).
- **Credentials per account (M8-3)**: highest-risk slice; Security design first.
- **Model-written briefs → cards (M8-6 F3)**: untrusted by default (recommended, Q2).
- **UI size**: `ui/app.js` grows; M8-5 may split it into modules served as static files (no bundler, no deps) — decided in M8-5's sub-plan.
- Decisions D1–D13 from earlier milestones stand.

## 7. Requirement Coverage Matrix (planning only)

| Brief item | Planned in | Verification | Status |
| --- | --- | --- | --- |
| F7a discovery | M8-1 | fixtures, hostile-output, cache/staleness, spawn isolation tests | Covered |
| F7 per-role model/effort | M8-2 | argv snapshots, composition, fitting, migration, strict API | Covered |
| F8 accounts/switching | M8-3 | pure router tests, env cross-account test, store round-trip | Covered |
| F6 run mode | M8-4 | forced-hold matrix, stored policy unchanged, CSRF API | Covered |
| F5, F9, F10 UI | M8-5 | scripted browser checks + screenshots | Covered |
| F1–F4 Home | M8-6 | API tests + browser checks; F3 schema/cap/untrusted tests | Covered |
| F11 pairings | M8-7 | per-pairing live suite + predicate tests | Gap until Q5 + Security design |
