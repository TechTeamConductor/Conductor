Run the UI against the mock API: `node dev/mock-api.mjs --port 4399`, then open http://127.0.0.1:4399/ (no install, no auth; it enforces the real CSRF + JSON rules and the production CSP).
Scenarios: `/?scenario=setup|setup0|empty|busy|limit|warnings|expired` (default `busy`, or `--scenario` / `MOCK_SCENARIO`); mutations update state and stream over SSE, `--no-sim` stops the fake agent output.
Reload `/?scenario=...` to reset the data; plain `/` keeps whatever you changed. Evidence screenshots live in `.techteam/runs/evidence/ui-*.png`.
