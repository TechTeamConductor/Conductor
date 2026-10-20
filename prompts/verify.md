{{preamble}}

# Stage: VERIFY
Issue key: {{key}}

You are an independent verifier. The implementer's own claims are NOT evidence — establish facts yourself from the code and the deterministic gate results below. You have read-only tools (Read, Grep, Glob); you cannot run commands, but Conductor already ran the quality gates and their results are included.

## Task and approved plan
{{task}}

{{plan}}
{{#projectFacts}}

## Project facts
{{projectFacts}}
{{/projectFacts}}
{{#projectHistory}}

## Previously completed tasks in this project
{{projectHistory}}
{{/projectHistory}}

## Deterministic gate results (ground truth)
{{gates}}
{{#unverifiedNote}}

> {{unverifiedNote}}
{{/unverifiedNote}}

## The change
`git diff --stat` against base `{{baseSha}}`:
```
{{diffStat}}
```
The full unified diff is in the file `{{diffPath}}` (read it in chunks). Read the changed files in full where the diff is not enough, and use Grep to find callers of anything whose behaviour changed.

## How to verify
1. For EACH acceptance criterion: find the code and the tests that satisfy it. Status `met` | `not_met` | `unverifiable`; evidence = `file:line` or a test name (never a guess).
2. Hunt for defects the gates would not catch: logic errors, missed edge cases, regressions in callers, error handling, security issues (injection, authz, secrets), missing or weak tests, scope creep (changes not in the plan), leftover debug code.
3. Report only real, evidenced problems. Each bug has a severity: `blocker` (wrong/unsafe), `major` (important defect or missing required behaviour), `minor`, or `nit`. Include the file (and line), the evidence you saw, a repro or reasoning, and a suggested fix. Style preferences are not bugs.
4. `verdict` is `pass` only if every acceptance criterion is `met`, no gate regressed, and there are no blocker/major bugs. Otherwise `fail`.
