# Code review — M8-6 "Design the work" (F3) + Deep Research intake (F4): backend, API, Home wiring

- Plan: `.techteam/plans/workspace-v2-m8-6.md` (§2c > §2b > earlier text)
- Diff: the uncommitted working tree on top of `a6e1a44`. I reviewed only the M8-6 hunks the author listed. M8-2 hunks in the same files are out of scope.
- Reviewed by: Reviewer (TechTeam), 2026-10-21
- What I ran:
  - The M8-6 and touched suites: `node --test` on `test/briefs*.test.ts`, `test/research-intake.test.ts`, `test/actor-trust.test.ts`, `test/board/schema-v3.test.ts`, `test/budget.test.ts`, `test/board/board.test.ts` and `test/ui-safety.test.ts`. **87/87 pass.**
  - `npx tsc --noEmit -p .`: **clean** at review time.
  - Probes of `introducesTarget` and `normalizeBriefPath` (results under M1).
  - I did not re-run the full `npm test`. The author reports 982/987, with the one failure in M8-2's `test/server-roles-models.test.ts`.

Verdict: Approved (second pass — see "Re-review" below; first pass was Approved with conditions)

**Condition:** fix M1 (false positives in the S6 fetch-target filter) and add its regression tests before the M8-6 commit. I will close it only after seeing the fix and the tests. Everything else is minor or a nit. The Security code review still has to run separately.

## Plan conditions: what I checked in the code

| Item | Where | Status |
| --- | --- | --- |
| **B1/S4** stamp at writable open, backup first, then a synchronous compact; brand-new board stamped at open, and the stamp is required before the first `design` op | `src/board/store.ts` constructor + `commit()` (`stampPending`/`tryStamp`), `journal.ts` `snapshotVersion`/`journalBytes` | Closed. Tests in `schema-v3.test.ts`: backup+compact, journal-only (absent snapshot), journal-only downgrade ⇒ `NewerVersionError` with no truncation, read-only open does nothing. Fixture `board.test.ts` uses `BOARD_SCHEMA_VERSION + 1`. |
| **S9/C5** one actor table | `ACTOR_INFO` → `ACTORS`/`TAINTED_ACTORS`/`REDACTED_ACTORS`; `validate.ts` re-exports `ACTORS`; `Board.text()` uses `REDACTED_ACTORS` | Closed. `import` keeps `redact:false` and `conductor` keeps `redact:true`, as before. `actor-trust.test.ts` and the S9 static test are present. The only other `'design'` literal in `src/` is the UI row id at `src/models/select.ts:42` (M8-2), which is not an actor. |
| **B2a–d / S8** send state machine | `src/briefs/service.ts` `sendWork`/`runSend`/`sendResearch`/`startResearchRun`/`resumeSending`; `store.ts` prune skips `running`/`sending` | Closed. The work send has no `await` between the status check and the write-ahead; creation is synchronous. The research send saves `sending` before the first `await`; `ask.briefId` is in the first save; adoption is via `findByBriefId`. Covered by `briefs-send` B2a/B2b/B2c and `research-intake` B2d. |
| **S1/N5** sanitisers | `schemas.ts` `line` = `sanitizeLine`, `block` = `stripInvisible` plus CR/tab handling; shape → cap → redact; `reshapeStoredWork` on load | Closed. `block()` from `research.ts` is not used. |
| **N6/S12** messages carry no model text | `validateWorkBrief`/`validateResearchBrief`; `validateSchema` messages contain paths and constants only | Closed. Test N6 is present. |
| **S10/N7** paths and `state` | `normalizeBriefPath` rejects rather than strips; `snapshot.index` → `file | omitted | absent`; `lstat` check inside the dir before removal | Closed. |
| **S2/S3/N1** `selRole` and Claude-only | `caller.ts` forwards only; `provider.ts` uses `onlyProviders` to narrow; `selRole` reaches `selectionFor` only; `RESEARCH_BRIEF_SEL_ROLE` is a constant | Closed. Tests S2a/b/c and S3 are present. |
| **S5** `> ` prefix | `cards.ts` `cardDescription` | Closed. Truncation drops only model lines, from the end, and keeps the header and `END_MARK`. |
| **S6** web brief = what the user reviewed | `researchBriefFence(renderResearchBrief(stored))`; `{{#brief}}`/`{{#deep}}` blocks; byte-identical golden | Closed for (a) and (c). **(b) is too broad — see M1.** |
| **S7** real secrets | `runtime.ts` `secrets: (repo) => engine.secretsFor({repo})` (copyFiles env + injected source) | Closed. Test T9 is present. |
| **S11/N12** counters | `takeKeyed` asserts integer `n ≥ 1`; `refund` uses the key from `take`, once per brief (`refunded`), only on `limited` | Closed. |
| **S13/N10** scratch | owned `conductor-brief-` prefix + `assertOwnedScratch`; `finally` cleanup; `sweepScratch`; `close()` aborts | Closed. |
| **S14/T13** Deep | `RESEARCH_DEPTH` frozen; ceiling asserted at module load and per call; `depth` only from the strict enum | Closed. |
| **N2** `/api/ask` stays closed | strict allow-list; `startResearchFromBrief` is not reachable from `api.ts` | Closed. |
| **N8/S15** projection and origin | `AskService.researchCards()` cached by write generation; `designOrigin` from `DESIGN_IDEM_RE` + lazy `partsCount` | Closed. |
| **N14** convert title | the title stays the user's question; "Research: <title> (model-written)" goes in the description | Closed. |
| **S12** strict API bodies | `strict()` (plain object, prototype check, own keys); ids are regex-checked before any path is built | Closed. Test T8: 403 without CSRF on every new mutation. |

## Blocking

None beyond the merge condition (M1).

## Major

**M1 — The S6(b) fetch-target filter rejects normal research text.** Two patterns in `src/briefs/schemas.ts:186-194` are too broad. I checked them with `introducesTarget(text, "How should we structure error handling in our Rust service?")`:
- `"Kubernetes metadata.labels usage"` → true
- `"Read the npm package metadata.json docs"` → true
- `"C# Dictionary::Add"` → true
- `"deadbeef::cafe"` → true

The causes:
- `/\bmetadata\.[a-z0-9.-]*/gi` matches any `metadata.<word>`, including field names (`metadata.name`) and file names (`metadata.json`).
- The IPv6 alternative `(?:\b[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}\b)?` matches identifier scopes whose neighbours are hex letters (`Dictionary::Add`, `a::b`, `Self::default` in some spellings).

Each hit costs the one corrective re-ask and, if the model keeps the term, fails the brief. Topics like Kubernetes, C#, C++, Rust and PHP run into this routinely.

Fix:
- Restrict `metadata.` to the hosts it is meant to block: `metadata.google.internal`, `metadata.azure.com`, `metadata.<cloud>` with a TLD; `169.254.169.254` is already covered by the IPv4 rule.
- Accept an IPv6 match only when it is a standalone token: not preceded by `[A-Za-z0-9_]`, all groups hex, and either at least 3 colons or bracketed (`[::1]`), or literally `::1` / `::ffff:…`.

Regression tests: the four strings above must be accepted, while `http://[::1]/`, `fe80::1`, `::1`, `metadata.google.internal` and `169.254.169.254` are still refused unless the user typed them.

## Minor

- **m1 — A send resumed at boot does not re-check that the repo is still registered.** `runSend` (`service.ts:486-532`) runs from `resumeSending()` and on `send_failed` retries without the B2c pre-check. If the repo was removed from config between the crash and the restart, `createLinked` → `engine.ensureProjectForRepo` still adopts the existing project, or creates a new one for an unregistered repo name. The cards then sit in To do and never run. Fix: in `runSend`, if the repo is not in `getConfig().repos`, end `send_failed` with "repository no longer registered".
- **m2 — `precheck` has a side effect.** `designCards().precheck` calls `ensureProjectForRepo`, which can **create** a project even when the answer is then 409 `full`. Use a lookup without create (`board.projects().find(p => p.repo === repo)`); a missing project means "not archived" and room for the cards.
- **m3 — The counter is taken but not refunded when the brief is refused or the save fails.** `start()` takes `designPerHour` before `saveBrief`. If the save throws (disk), or the research brief later fails at `runResearchBrief` "needs Claude" (Claude ineligible rather than limited), the counter stays spent. That is consistent with S11 (refund only on `limit`), but the second case is predictable before `take`. Move the S3 "Claude candidate exists" route check from `runResearchBrief` into `gate()` for `kind:'research'`, so it is answered synchronously without spending a counter.
- **m4 — Misleading fallback note.** With `onlyProviders` filtering out the chain head (`['cursor','claude']` → Claude), `Agents.readOnly` emits "Cursor is unavailable — Claude is doing this read-only step" (`provider.ts`, the `i === 0 && cand.id !== head` branch), though Cursor was healthy. For the research brief the note should read along the lines of "The research brief runs on Claude only".
- **m5 — A failed backup on upgrade stops Conductor from starting.** In B1, when `backupPaths` throws (backup root not writable, disk full), the open fails and Conductor does not start. This is the intended fail-closed behaviour. The raw fs error should reach the user as a clear startup message ("could not back up the board before upgrading it to v3: …; set CONDUCTOR_BACKUP_DIR or free space"). Check `doctor`/startup error surfacing.
- **m6 — No live update for briefs (deviation 4).** Briefs do not emit the SSE "changed" event, so the UI polls once a second. Acceptable, but correct the docs (§2.6 says SSE fires) or wire `onSave → engine.changed()` in a follow-up.

## Nits

- `start()` sanitises the user's `line` with `sanitizeLine`, so a multi-line request becomes one line before it is fenced and stored. That is fine for the composer. Note it in `docs/API.md`, since the card then shows the collapsed form.
- `resumeSending()`'s research catch resets to `ready` without the `!findByBriefId` guard that `startResearchRun` uses. Today this is harmless, because the inner path already reset it or adopted, but use the same guard.
- `sendWork` estimates `parts.length * 8200` bytes. Use `DESC_MAX + 200` from `cards.ts` rather than a magic number.

## Accepted deviations (author's notes)

- (1) Stamping a brand-new board at open is stricter than B1 asks. Accepted.
- (2) The run-mode axis of AC-6.7 and S9b waits for M8-4. M8-4's T2 iterates `TAINTED_ACTORS`, which includes `design`. Accepted. Whichever slice lands second must remove the TODO marker.
- (3) The C3 fallback and the M8-2 `selRole` consumer: accepted. The S2a argv test covers it.
- (5) The board does not yet draw the research projection or the "Part n/N" chip. Accepted as a recorded M8-U follow-up. S16 needs the untrusted chip on design cards before the board shows them as anything other than plain cards.
- (6) The step label wording follows the design, and the detail states that there is no repository access. Accepted.
- (8) The S17 live check was not run. Correct: it is not authorised.

## Record

- Artifact: `/Volumes/Sandisk/github/techteam-conductor-v2/.techteam/reviews/workspace-v2-m8-6-code-review.md`
- Next action:
  1. The author fixes M1 and adds its tests; m1–m4 are recommended in the same pass.
  2. The Reviewer checks the fix evidence and closes M1.
  3. The Security code review runs.
  4. The Lead commits. This session does not push.

## Re-review — fix evidence (2026-10-21, second pass)

**Verdict: Approved.**

Every M8-6 code-review item is closed. The Security code review remains a separate step.

- **M1 — closed.** `src/briefs/schemas.ts` `TARGETS` / `introducesTarget`:
  - `metadata.` now matches only an explicit list of cloud metadata hosts.
  - IPv6 counts only as a standalone token: compressed with at least one digit, at least 4 uncompressed groups, or bracketed.
  - Added: hex and decimal IPv4 forms, loopback short forms, wildcard-DNS names, and `*.localhost`.
  - My own probe agrees with the author's tests:
    - 13 ordinary research strings are accepted: the four from M1, plus `Self::default()`, `std::vector`, `Vec::new()`, `a::b::c`, `dead::beef`, `Python 3.11`, `macOS 10.15.7`, `12:30:45`, and "IPv6 adoption in 2024".
    - 18 real targets are refused, including `http://[::1]/`, `fe80::1`, `::1`, `::ffff:10.0.0.1`, `2001:db8::1`, `[fe80::1]`, `metadata.google.internal`, `169.254.169.254`, `127.1`, `0x7f000001`, `2130706433`, `x.nip.io`, `lvh.me`, `localhost` and `10.0.0.5`.
  - The documented residual (plain public hosts in prose, short forms such as `10.1`) is acceptable. A URL scheme and `www.` are still refused.
- **m1 — closed.** `runSend` re-checks that the repo is registered; if it is not, the send ends `send_failed` "no longer registered" with no card (`service.ts:504`).
- **m2 — closed.** `precheck` only looks the project up and never creates one (`runtime.ts:196-201`).
- **m3 — closed.** `gate()` refuses synchronously with 409 `needs_claude`, before any record or counter (`service.ts:188`).
- **m4 — closed.** The note now reads "This step runs on Claude only" (`provider.ts:166-167`).
- **m5 — closed.** A failed backup gives a plain-language startup error that says nothing was changed (`store.ts:150`).
- **m6 — closed.** `docs/API.md` states that brief saves send no live event (the UI polls) and that the line is stored collapsed to one line.
- **Nits — closed:** `DESC_MAX + 200` replaces the magic number (`service.ts:480`), and the boot-resume catch has the `findByBriefId` guard.
- **Security F1/F2/F4:** I noted the fixes. The Security reviewer owns them.

**What I ran:**
- `npx tsc --noEmit`: clean.
- The M8-6 suites (`briefs*`, `research-intake`, `actor-trust`, `board/schema-v3`, `budget`): 56/56 pass.
- The author reports the full `npm test` at 991 tests: 987 pass, 0 fail, 4 skipped.

**Next action:** the Security code review, then the Lead commits locally. Nothing is pushed.
