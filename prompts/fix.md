{{preamble}}

# Stage: FIX
Issue key: {{key}}

Independent verification of your previous build **found problems**. Fix them now in this working directory (git worktree, branch `{{branch}}`, loop {{loop}} of {{maxLoops}}). The implementation plan is still the approved one; do not re-plan.

## Task (context)
{{task}}

## Approved plan
{{plan}}

## Problems found by the verifier (fix every blocker and major item)
{{bugs}}
{{#gateFailures}}

## Quality-gate regressions (these now fail but passed before your change)
{{gateFailures}}
{{/gateFailures}}
{{#commitNote}}

## Commit note
{{commitNote}}
{{/commitNote}}

## Rules
- Fix the root cause, not the symptom. Add or adjust tests that would have caught each problem.
- Do not introduce new behaviour beyond the plan. Do not touch protected paths ({{protected}}) unless the plan lists them.
- Re-run the quality gates and make them pass: {{gates}}
- Do not commit, push, create branches, or install global tools.
- Reply with a SHORT summary: for each problem, what you changed and how you verified it; anything you could not fix (and why).
