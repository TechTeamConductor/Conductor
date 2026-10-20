# Workspace v2 — report (2026-10-20)

Clone: `/Volumes/Sandisk/github/techteam-conductor-v2` (local `main`, nothing pushed). Tests: 708 (704 pass, 4 live skipped); `tsc` clean.

| Area | State |
| --- | --- |
| M1 native board, importer, versioned data | Done, reviewed (Reviewer + Security) |
| M2 provider/role router, build envelope, Codex read-only | Done, reviewed. Codex never ran on a real binary (install broken here) |
| M3 task graphs (decomposition, sequential build, per-task gates, crash adopt/reset, concurrent analysis, Tasks tab) | Done; Reviewer + Security findings fixed; **re-verification by both not yet run** for the final fixes |
| M4 project context (git-object scanner, incremental, packs, history, opt-in summaries, offline mode, budget module, context API) | Done; Security Approved; Reviewer majors fixed, **re-check pending** |
| M5 Quick Ask (snapshot, store, API, fast path, convert) + Ask UI | Done; review findings fixed, **re-check pending**. Research mode + live permission probe **not built** |
| M6 policies (4, one decision, risk rules, confirmRisks), project creation, sample, env report | Core done; review fixes applied. **Not built:** manual-stages (= approve-plan today), maxRunMinutes, daily agent-run budget, approval audit trail, hierarchy/project page/wizard-v2/policy editor UI |
| M7 macOS `.dmg` (user scope: macOS only) | Built and launch-checked (server answers, quits cleanly); unsigned; window contents not inspected visually; no Windows/Linux |
| M2b Codex as implementer | Not done (needs a working Codex) |

Open follow-ups are listed in the M3/M4/M5/M6 plan files (§ implementation notes) and the review reports in `.techteam/reviews/`.
