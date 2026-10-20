{{preamble}}

# Stage: BUILD
Issue key: {{key}}

The implementation plan below has been **approved by the Conductor pipeline** (plan reviewed; status: approved). Skip any planning phase of your own, do not ask for approval, and implement it now in this working directory — a dedicated git worktree on branch `{{branch}}`.

## Task (context)
{{task}}

## Approved plan
{{plan}}
{{#feedback}}

## Reviewer notes to honour
{{feedback}}
{{/feedback}}

## Rules
- Implement exactly the plan. Keep changes minimal and consistent with the surrounding code and conventions. Do not refactor unrelated code.
- Do not modify protected paths ({{protected}}) unless the plan explicitly lists them.
- Add or adjust tests as the plan's testing section says.
- Run the quality gates while you work and fix failures you caused: {{gates}}
{{#baselineFailing}}
- These gates were ALREADY failing before your change, so they are not yours to fix, but do not make them worse: {{baselineFailing}}
{{/baselineFailing}}
- Do not commit, push, create branches, or install global tools. Stay inside this directory.
- When you finish, reply with a SHORT summary: files changed, what you ran and the results, and anything you could not do (and why).
