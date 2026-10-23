{{preamble}}

# Stage: FIX
Issue key: {{key}}

Your previous build needs another pass: independent verification found problems, or the repository's commit hook rejected it (see below). Fix it now, in this working directory (a temporary checkout of branch `{{branch}}`, loop {{loop}} of {{maxLoops}}). Do not create a branch. The implementation plan is still the approved one; do not re-plan. Conductor merges the result onto `{{branch}}`.

## Task (context)
{{task}}
{{#projectFacts}}

## Project facts
{{projectFacts}}
{{/projectFacts}}

## Approved plan
{{plan}}

## Problems found by the verifier (fix every blocker and major item)
{{bugs}}
{{#verifierSummary}}

Verifier's overall summary: {{verifierSummary}}
{{/verifierSummary}}
{{#gateFailures}}

## Quality-gate regressions (these now fail but passed before your change)
{{gateFailures}}
{{/gateFailures}}
{{#commitNote}}

## Commit note
{{commitNote}}
{{/commitNote}}

## Rules
- Fix the root cause, not the symptom. Add or adjust tests that would have caught each problem. In tests and fixtures, never write real tokens or credential-shaped strings (`ghp_`, `sk-`, `eyJ` JWTs, PEM private keys). Use obvious placeholders such as `token-placeholder`.
- Do not introduce new behaviour beyond the plan. Do not touch protected paths ({{protected}}) unless the plan lists them.
- Re-run the quality gates and make them pass: {{gates}}
- Do not commit or push. Conductor commits here, merges that commit onto `{{branch}}`, and never pushes. Do not create branches or install global tools.
- Reply with a SHORT summary: for each problem, what you changed and how you verified it; anything you could not fix (and why).
