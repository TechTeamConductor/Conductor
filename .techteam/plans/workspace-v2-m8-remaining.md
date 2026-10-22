# M8 — remaining development plan (updated 2026-10-21 evening)

**Code:** `/Volumes/Sandisk/github/techteam-conductor-v2`, local `main`.  
**Committed HEAD:** `256159c` (M8-3 + M8-4).  
**Uncommitted now:** M8-5 implementation + L3c evidence + this plan (+ review artifacts). Nothing pushed.

---

## Snapshot

```
DONE (committed)                 DONE (uncommitted — Reviewer+Security code Approved)
────────────────                 ────────────────────────────────────────────────────
M8-1…M8-4, M8-U, M8-U2, M8-6     M8-5 run-mode UI + waiting on state/SSE + approve list

NEXT                             LATER
────                             ─────
F1 Critical fix (Security design)  follow-ups · docs · .dmg · M8-7 · permission checks
```

---

## Just finished: M8-5

- Plan Approved (rev 2) → implemented → Reviewer code **Approved** → Security code **Approved**.
- `waiting` on `live()` / `state()` / SSE; Board + Settings run-mode switch; Approve waiting (eligible-only); chain-only `COMPLETE_AUTO_CONFIRM` + limit-rule label.
- Tests: full suite **1077 pass / 0 fail / 4 skipped**.
- Evidence note: `.techteam/runs/evidence/m8-5/README.md` (browser loopback blocked in Cursor; static tests are the gate).
- **Not committed yet** (say the word and Lead will commit).

---

## Next: F1 (Critical) — Claude settings.json isolation

**L3c done:** `.techteam/runs/evidence/l3c-project-settings.md` (Critical project path).  
**Security design:** Approved with conditions (A+C) — `.techteam/reviews/workspace-v2-f1-security-design.md` ([Security](64c92818-97b2-44de-b75a-458e5a9f1ced)).  
**Plan rev 2:** conditions 1–5 folded — `.techteam/plans/workspace-v2-f1-claude-settings.md` — pending Reviewer.

---

## After F1

1. Small follow-ups (CR-N5, L1 Cursor model re-check, M8-1 close(), M8-6 scratch, API save-first N1, same/wait semantics).
2. Docs + final report + rebuild `.dmg`.
3. Permission-gated: S17, account login checks, L5, Codex repair.
4. Plan M8-7 pairings.

---

## Suggested order now

1. Commit M8-5 (if you want).  
2. F1 Security design → fix.  
3. Follow-ups + docs + `.dmg`.  
4. Your OK for live checks / Codex as before.
