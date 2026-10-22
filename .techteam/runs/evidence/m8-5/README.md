# M8-5 UI evidence

- Date: 2026-10-21
- Gate: `npm run check` clean; `npm test` **1077 pass / 0 fail / 4 skipped** (full suite after M8-5).
- Static UI contracts: `test/ui-safety.test.ts` (approve-waiting body helper; deferred `/api/models` kept), `test/ui-modes.test.ts` (run-mode helpers + chain-only wording), `test/run-mode.test.ts` (confirm text + `waiting` on live/state).
- Browser screenshots: not captured in this session (Cursor browser could not reach loopback `127.0.0.1:4337`). Manual smoke: `CONDUCTOR_HOME=$(mktemp -d) npm run demo` → Board run-mode seg + Settings Run mode group + Approve waiting when `waiting.bulkApprovable > 0`.
