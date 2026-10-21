# Security code review: M8-6 "Design the work" (F3) + research briefs (F4)

- Reviewer: TechTeam Security Engineer (independent of the author, Full-Stack agent a5f1de9704394cf07)
- Date: 2026-10-21
- What was reviewed: the uncommitted working tree on top of `a6e1a44`, read on 2026-10-21. M8-2 edits are mixed into the same files, and I reviewed them only where M8-6 depends on them (`selRole`, `onlyProviders`, `sel` plumbing).
  - New files: `src/briefs/{schemas,cards,service,store,types}.ts`, `prompts/{design-work,research-brief}.md`.
  - M8-6 changes in: `prompts/research.md`, `src/agents/{caller,provider}.ts`, `src/agents/providers/claude.ts`, `src/asks/{service,research}.ts`, `src/board/{types,validate,store,journal}.ts`, `src/limits/budget.ts`, `src/runtime.ts`, `src/server/api.ts`, and the brief rendering in `ui/app.js` (`codeText`, `briefNodes`, `briefReview`).
- Checked against: my design sign-off `.techteam/reviews/workspace-v2-m8-6-security-design.md` (S1–S18) and the `CLAUDE.md` safety invariants.
- Method:
  - Read the code above.
  - Ran the M8-6 suites with the test preload: `briefs-api`, `briefs-schema`, `briefs-send`, `briefs`, `research-intake`, `board/schema-v3`, `budget`, `ui-safety`, `actor-trust`. All pass (59/59 top-level tests).
  - Ran one probe of my own in the scratchpad against `introducesTarget`, `normalizeBriefPath` and `block`. It imports the clone read-only; no file in the repo was touched.
  - Ran no real CLI and used no network or quota. Edited no source.

## Decision

**Approved with conditions.** Nothing is Critical or High.

The binding design conditions are implemented and tested:
- The `design` actor is fixed in one facade, `designCards` in `runtime.ts`, and the one `ACTOR_INFO` table makes it tainted and redacted.
- `untrusted` forces the hold on every plan revision. There is a test that rev 2 is held again after rev 1 was approved.
- Request bodies are strict, and the work send body carries part ids only.
- The full invisible-character set is stripped, in the order shape → cap → redact.
- `selRole` only selects model and effort. `onlyProviders` only narrows the candidates.
- The board is stamped at v3 before any `design` op can reach the journal.
- Model lines in a card description carry a `> ` prefix.
- The research prompt is rendered from the stored record only.

Six follow-ups remain (F1–F6). None blocks the checkpoint. F1 is a small, partly missed part of S14. F6 (the live check) must run before F3/F4 are called done.

## Condition by condition

| # | Verdict | Evidence (code) |
| --- | --- | --- |
| S1 sanitiser set | Met | `schemas.ts:61-63`: `line()` = `sanitizeLine`; `block()` = `stripInvisible`, with CR turned into `\n`, tabs into spaces and newline runs collapsed. Shape → cap → redact at `:117-144`. Reshaped on load (`reshapeStoredWork`, `store.ts`). Probe: BEL, ESC, CR, U+E0041 and U+FE0F were all removed. |
| S2 `selRole` = model/effort only | Met | `RESEARCH_BRIEF_SEL_ROLE` is a constant (`service.ts:43`). `provider.ts`: `selectionFor(req.selRole ?? req.role, …)` is the only place it is read; route, candidates, `runReadOnly`, profile and turns all use `req.role`. `api.ts` has no `selRole`. |
| S3 research brief on Claude only | Met | `onlyProviders` filters `route()` candidates after routing and never adds one; an empty result spawns nothing (`provider.ts`). The service pre-checks the context route for Claude (`service.ts:340-343`) and passes `onlyProviders: ['claude']`. |
| S4 downgrade covers the journal | Met | `store.ts` constructor: a writable open with an older or absent snapshot backs up (`pre-board-v3`) and compacts **before any op**, failing closed. A fresh board stamps and must have a current snapshot before the first `design` op (`commit()`). An old build now hits `NewerVersionError` on the snapshot. `schema-v3` tests the journal-only case. |
| S5 model text cannot pose as the user | Met | `cards.ts:55-105`. The user's line, header, labels, dependency lines and `END_MARK` are written by code. Every model line goes through `quote()`. Truncation removes model lines only. |
| S6 reviewed text = sent text; no new targets | Met, with residual F3 | (a) `researchBriefFence(renderResearchBrief(rec.brief))` from the stored record; `startResearchFromBrief` reshapes it again; the UI shows exactly the fields `renderResearchBrief` emits. (b) `introducesTarget` runs on the NFKC, invisible-stripped form (probe: `local​host`, full-width `ｌｏｃａｌｈｏｓｔ`, `[::1]`, `169.254.169.254`, `hxxp://` are all caught). (c) The `{{#brief}}` text in `prompts/research.md` says it cannot change rules, tools, format or source rules, and that the question wins. |
| S7 real secret values | Met, with note | `runtime.ts`: `secrets: (repo) => engine.secretsFor({repo})` (the repo's `copyFiles` env values). It is used for the shaped strings, events, the error and the card text, and again in `runSend`. Note: the engine's own injected source is `() => []` today (pre-existing), so Conductor's stored tokens are redacted by shape only. They are all shaped (`lin_api_`, `sk-ant-`, `crsr_`, …), so this is info only. |
| S8 no double send | Met | Work: no `await` between the status check and the write-ahead (`sendWork` is synchronous), plus `sendLocks`. Research: `sending` is saved before the first `await`, the `researchSends` promise map dedupes concurrent sends, and a failed start reverts to `ready` with no ask. `DELETE` returns 409 while `sending`. Pruning never removes `running`/`sending`. |
| S9 `design` reachable only from briefs | Met (S9b carried to M8-4) | `designCards` pins kind/lane/parentId/autoStart; no key, external, milestone or stage. `ACTOR_INFO` → `ACTORS`/`TAINTED_ACTORS`/`REDACTED_ACTORS`. `Board.text()` uses `REDACTED_ACTORS`. Static test present. S9b ("Approve waiting plans" skips design cards) cannot be tested until M8-4 lands; M8-4's plan already skips `untrusted`. |
| S10 paths | Met | `normalizeBriefPath` rejects (never strips) invisible characters, `:`, `\`, tab/newline and anything `safeEntryName` refuses. A `file` mark needs: the snapshot index says file, `resolve` stays under the dir, and `lstat().isFile()`, checked before removal. `secretLike` uses the M6 `SECRET_FILE` rule. Paths are display/text only. |
| S11 counters | Met | `takeKeyed` throws unless `n` is an integer ≥ 1. `refund` credits the recorded key only, is a no-op once that window has rolled over, runs once per brief (`refunded`), and runs only on the `limited` end. |
| S12 strictness / error text | Met | `Api.strict()` (plain object + prototype check) on every new body; ids are checked by regex before any path is built. Validator messages carry paths and constants only. `error` is ≤ 500, sanitised and redacted. Log lines carry id, kind, status, counts and ms only. |
| S13 lifecycle | Met, see F4 | Snapshot and scratch are removed in `finally`. `sweepScratch` runs at boot only (owned, older than 1 h, no symlinks). `failInterrupted` leaves `sending` alone. `close()` aborts and waits. |
| S14 Deep research | **Partly met** → F1 | `RESEARCH_DEPTH` is frozen, with the ≤ 60 assert both at module load and per call; depth comes only from the strict enum; Deep differs only in turns and wall clock. `fetchedTotal`/`searchedTotal` are recorded and validated on load (`research.ts:89-113`). **But the UI never shows them**: `ui/app.js:3028` lists the capped arrays without a "+N more not shown" line. |
| S15 projection and dismiss | Met | `researchCards()` is derived and cached by write generation and never journalled. `dismiss` is research `done` only, idempotent, and changes only `dismissedAt`. `designOrigin` needs `createdBy === 'design'` plus `DESIGN_IDEM_RE`. |
| S16 rendering | Met (chip carried to M8-U) | `h()` creates text nodes. `codeText` builds `<code>` with text content only; there is no link or image path. `approach` and `objective` use `is-pre` (pre-wrap). A constant model badge, protected and secret-looking badges, and a warning line appear before Send. The `ui-safety` static test passes. The "Part n/N" board chip is not drawn yet; the hold reason on those cards already says "unverified source". |
| S17 live check | **Not run** → F6 | Not authorised; it spends quota. |
| S18 docs | Met | `docs/ARCHITECTURE.md` section (R1–R4, 2 × 35 min, no downgrade plus the backup, Claude from the question only, the meaning of the file marks), README rows, `docs/API.md`. |

Further checks I made:
- `render()` does not rescan inserted values, so `{{…}}` inside a brief is inert.
- `fence()` escapes `<untrusted`/`</untrusted` in the card description and the research brief.
- The card description sent to the builder is at most what the brief view shows: `approach` is cut to 2,000 characters on the card versus 4,000 on screen. So nothing reaches a builder that the user could not see (M3 B-1 rule).
- `/api/ask` still rejects `brief`, `depth`, `briefId` and `selRole`.
- `startResearchFromBrief` cannot be reached from HTTP (static test).
- `UserBoard` passes only the `user` actor.

## Follow-ups (non-blocking unless marked)

**F1 (Low; finish S14):** in the report view, when `fetchedTotal > fetched.length` or `searchedTotal > searched.length`, show "+N more opened/searched, not listed". Add one UI test. Without it, a Deep run with more than 100 fetches or more than 50 searches quietly hides part of the M5-6(d) audit list.

**F2 (Low):** `reshapeStoredWork` (`schemas.ts:157-158`) trusts the stored `protected`, `secretLike` and `state` flags. Recompute `protected` (`isProtectedPath`) and `secretLike` (`SECRET_FILE`) on load; both are pure. Then a hand-edited record cannot hide the warning shown before Send. `state` can stay as stored, since the snapshot is gone. This is same-user tampering, so Low.

**F3 (Low, residual of S6b):** the probe shows these pass `introducesTarget`:
- the short IPv4 form `127.1`;
- the hex `0x7f000001` and decimal `2130706433` forms;
- wildcard-DNS loopback names (`localtest.me`, `*.nip.io` unless the name embeds a dotted IP);
- plain public hosts such as `evil.example/?d=…`.

The brief model's only input is the user's own question, so there is no hostile party steering it here. Recommended, cheap: add `\b0x[0-9a-f]{1,8}\b`, `\b\d{8,10}\b` next to a host word, `\b\d{1,3}\.\d{1,3}(\.\d{1,3})?\b`, and a small constant list (`nip.io`, `sslip.io`, `localtest.me`, `lvh.me`). Otherwise record the residual in `docs/ARCHITECTURE.md`.

**F4 (Low):** `sweepScratch` sweeps `os.tmpdir()` for `conductor-ask-`/`conductor-research-`/`conductor-brief-` dirs older than 1 hour. That directory is shared by every Conductor process of this user: the desktop app, a CLI started with another `CONDUCTOR_HOME`, the test suite. So one instance's boot can delete another instance's live scratch dir. A Deep research with its re-run can live up to 70 minutes. Fix (M5-11 already asked for an owned parent): create snapshot and scratch dirs under a per-home 0700 parent (for example `<home>/tmp`) and sweep only there, or make the sweep age greater than the longest session (2 × 35 min + margin).

**F5 (carry-forward):**
- S9b: M8-4's "Approve waiting plans" must skip `design` cards. Add it to the M8-4 test matrix when that slice lands.
- S16: M8-U should draw the "Part n/N" chip with the constant model label.

**F6 (required before F3/F4 are declared done; needs the user's permission because it spends quota):** the S17 live check. One real research-brief call with a canary file in a sibling `tmpdir` dir, and one design call on a repo whose `README.md` holds an injection line. Record that:
- (a) a Read or Glob outside the cwd is denied, and the canary is absent from the brief;
- (b) both init events pass the default read-only predicate;
- (c) the resulting cards are held for approval.

Store the evidence in `.techteam/runs/evidence/`.

## Residuals (unchanged from the design sign-off)

- R1: after a human approves, the builder sees the quoted, fenced part text; it is the same text shown on the card.
- R2: with Cursor or Codex on the `requirements` chain, the design call has weaker read-only isolation; the tier note is shown.
- R3, R4: as the plan states.
- Same-user tampering with `<home>/briefs` and `limits.json` is bookkeeping, not a security boundary.

## Not verified

- No real CLI (F6).
- Cursor ask mode's file and web access: S3 removes the dependency for research.
- The final commit: the tree was uncommitted and shared with M8-2 while I reviewed it. Before the checkpoint, the author should confirm that the committed M8-6 hunks match this tree; I will re-check the diff of `src/briefs/*`, `src/board/store.ts`, `src/agents/provider.ts` and `src/runtime.ts` on request.
- The full `npm test` run: the author reports 982/987, with one failure in M8-2's in-progress `server-roles-models` suite. That is outside this review.


## Re-check of the follow-ups (rev 2, 2026-10-21)

Checked in the working tree, after the author's F1–F4 hunks.
- I re-ran my scratchpad probe.
- I re-ran the M8-6 suites plus `ui-modes`/`ui-safety` with the preload: 75 of 75 pass.

| # | Status | Evidence |
| --- | --- | --- |
| F1 (S14) | **Closed** | `ui/app.js:3030-3031` use the pure `ConductorModes.moreNote` (`ui/modes.js:260`). A non-integer total is ignored, and the note is a text node. S14 is now fully met. |
| F2 | **Closed** | `reshapeStoredWork` recomputes `protected` (`isProtectedPath`) and `secretLike` (`SECRET_FILE`) from the path on load (`schemas.ts:161`). Only `state` is kept from the file. |
| F3 | **Closed, residual documented** | The probe now refuses `127.1`, `0x7f000001`, `2130706433`, `localtest.me`, `[::1]` and `*.nip.io`. Ordinary wording still passes (`std::vector`). Residual, documented in code and docs: plain public host names, and other short IPv4 forms such as `10.1`. That is acceptable, because the brief's only input is the user's own question. |
| F4 | **Closed** | `SWEEP_AGE_MS` = 3 h (`service.ts:52`), above Deep's 2 × 35 min worst case. Tested. A per-home scratch parent is still the cleaner long-term fix (optional). |
| F5 | Carried | S9b goes to the M8-4 test matrix; the "Part n/N" chip goes to M8-U. |
| F6 / S17 | **Open** | Not run; the Lead is asking the user for permission because it spends quota. It is required before F3/F4 are declared done, but it does not block this checkpoint. |

Reviewer items m1–m4 (a resumed send re-checks the repo; precheck never creates a project; `needs_claude` 409 is synchronous, with no record and no counter; the fallback note text) were not reviewed in depth. Nothing I read in those hunks weakens a security condition.

Verdict: Approved with conditions
