# Workspace v2 — requirement (verbatim)

Source: pasted by the user in chat on 2026-10-20 as "Product Vision: An AI-Native Autonomous Engineering Workspace". Reproduced unchanged so coverage can be checked against the real text. Section headings (1–10) are the user's; the plan's shorthand V1…V10 refers to them in order.

---

Product Vision: An AI-Native Autonomous Engineering Workspace
1. Build a Complete Product
Build a desktop application available for both Windows (`.exe`) and Linux (`.deb`) that acts as an intelligent engineering workspace, coordinating multiple AI coding CLIs to plan, execute, verify, and research work within a project.
The product should be designed around automation, persistent project context, and configurable AI workflows. Users should not need to manually orchestrate every step or repeatedly explain their codebase to different AI agents.
The goal is to turn a simple request into a structured, dependency-aware execution plan and manage the work through completion.
2. Multi-CLI Integration and Configuration
During onboarding, allow users to configure and connect the three primary CLI tools:

* OpenAI Codex CLI
* Claude Code CLI
* Cursor CLI

Each integration should support automatic detection, installation or setup guidance, authentication checks, availability checks, and connection testing where supported.
Users must be able to configure each CLI independently and decide which tool is responsible for each stage of the workflow.
Configurable AI workflow
Allow users to assign different CLI tools to individual responsibilities, including:

* Requirements analysis and clarification
* Project-context analysis
* Task planning and decomposition
* Architecture and technical design
* Implementation
* Code review
* Testing and verification
* Debugging and error resolution
* Documentation
* Online research

For example, a user might choose Codex for implementation, Claude for planning, and another configured CLI for independent verification.
The system should also support using the same CLI for multiple stages, fallback providers, and automatic selection based on task complexity.
Keep the workflow configurable at every stage, but make sensible defaults work out of the box.
3. Replace Linear with an Internal Project Management System
Remove Linear as a backend dependency. Build an internal project and execution management system that owns the application's tasks, workflow state, dependencies, and execution history.
The internal system should manage:

* Projects and project context
* Work items and subtasks
* Task dependencies and execution order
* Planning and approval states
* Execution status and progress
* Verification results
* Failures, retries, and recovery
* Agent assignments and execution logs
* Project-level decisions and milestones

The board should be a native part of the product, not a wrapper around an external project management service.
Users should be able to view and manage work through a board, while the orchestration engine maintains the underlying state and automatically updates progress as work proceeds.
4. Introduce a Planning Stage Before Execution
Replace the traditional approach of creating a task from a short description with an intelligent Plan Before Execution stage.
A user should be able to enter a single-line request, such as:
"Add authentication to the application."
Before execution begins, the system should analyse the request using the existing project context and transform it into a detailed, actionable engineering plan.
The planning stage should identify:

* The actual requirements and expected outcomes
* Relevant modules, files, services, and existing patterns
* Technical constraints and assumptions
* Necessary implementation steps
* Required tests and verification criteria
* Potential risks and edge cases
* Dependencies between tasks
* Opportunities for parallel execution
* Completion criteria for each work item

Intelligent task decomposition
The system should automatically determine the appropriate level of decomposition based on complexity.
A small request may remain a single task. A medium-sized request may become several subtasks. A complex feature may become a hierarchy of tasks with explicit dependencies and independent verification steps.
For example:
User request: Add authentication.
Generated plan:

1. Analyse the existing application architecture and authentication requirements.
2. Design the authentication flow and session-management approach.
3. Implement the authentication backend.
4. Implement the login and logout interfaces.
5. Integrate authentication with existing routes and permissions.
6. Add unit and integration tests.
7. Run security-focused checks and verify the implementation.
8. Update the relevant documentation.

The system should derive the actual plan from the project rather than blindly using a predefined template.
It should also identify when information is missing, make reasonable assumptions when safe, and ask the user only when a decision materially affects the implementation.
Once the plan is ready, the system should be able to execute it automatically or request approval, depending on the user's preferences.
5. Persistent Project Context and Offline Intelligence
Create a persistent project-context engine so that AI tools do not need to repeatedly scan the entire repository or rediscover the same information.
The context engine should maintain a reusable understanding of the project, including:

* Repository structure and module responsibilities
* Frameworks, languages, dependencies, and build commands
* Architectural decisions and coding conventions
* Important files, interfaces, and integration points
* Existing tests and verification procedures
* Current project objectives and outstanding work
* Previously completed tasks and their outcomes
* Known issues, constraints, and unresolved decisions

Incremental context updates
Instead of repeatedly performing full repository scans, the system should maintain a local context index and update it incrementally when files change.
It should reuse existing analysis, identify relevant context for each task, and provide only the information needed by the selected CLI.
The system should track when context was generated, what files or decisions it covers, and when it may be stale. Full rescans should happen only when necessary.
Offline context mode
Support an offline-capable project context layer that works without continuous internet access.
Local repository indexing, saved project knowledge, task history, cached decisions, and previously generated plans should remain accessible offline.
When a configured model or CLI requires a network connection, the application should clearly distinguish between locally available functionality and operations that require connectivity.
The objective is to analyse once, retain the knowledge, update incrementally, and reuse intelligently.
6. Three Primary Operating Modes
The application should provide three simple ways to initiate work.
Mode A: Quick Ask
For small questions, explanations, focused changes, and simple fixes.
The system should retrieve only the relevant project context, select the appropriate CLI, and respond or execute the request with minimal overhead.
Avoid creating unnecessary task hierarchies for trivial work.
Mode B: Engineering Work
For real implementation tasks, features, refactoring, bug fixes, and multi-step development.
The system should generate a structured plan, decompose work when necessary, establish dependencies, assign CLI tools to the relevant stages, execute the work, and verify the results.
This should be the primary mode for day-to-day engineering.
Mode C: Deep Research
For complex technical investigations, architectural decisions, unfamiliar technologies, and research requiring online sources.
The system should gather relevant information, consult available online sources, compare alternatives, evaluate evidence, and produce a structured report with citations and actionable recommendations.
When research leads to implementation work, the user should be able to convert the findings into an executable engineering plan.
The system should make clear when online access is unavailable and distinguish verified findings from assumptions.
7. Automation-First Execution Engine
Make automation the default experience without removing user control.
Once a plan is approved—or when the user has enabled automatic execution—the orchestration engine should:

1. Select the appropriate CLI for each stage.
2. Prepare the necessary project context.
3. Execute tasks in dependency order.
4. Run independent tasks in parallel where safe.
5. Capture outputs, decisions, and execution logs.
6. Run tests and independent verification.
7. Detect failures and attempt bounded recovery.
8. Update the internal board automatically.
9. Report completed work, remaining issues, and required user decisions.

Support configurable limits for retries, parallelism, execution time, and resource usage.
Users should be able to choose between fully automatic execution, approval before implementation, approval before risky operations, or manual control of individual stages.
Sensitive operations—such as destructive changes, production deployments, or actions involving secrets—should follow explicit permission and confirmation rules.
8. Product Experience and Onboarding
The initial onboarding experience should be simple, guided, and intelligent.
It should:

1. Detect the operating system and supported environment.
2. Help the user configure Codex CLI, Claude Code CLI, and Cursor CLI.
3. Verify the configured tools and explain any missing dependencies.
4. Allow the user to select default tools for planning, implementation, and verification.
5. Ask the user to open or create a project.
6. Perform an initial project-context analysis.
7. Build the local context index and establish the project structure.
8. Create sensible default workflow settings.
9. Offer a sample task so the user can see the entire process working.

Do not overwhelm users with configuration screens during onboarding. Provide recommended defaults first, with advanced configuration available whenever needed.
9. Desktop Distribution and Reliability
Deliver a production-ready desktop application with:

* A Windows installer or executable distribution (`.exe`)
* A Debian package (`.deb`) for compatible Linux distributions
* Persistent local project and workflow data
* Secure handling of credentials and authentication
* Background task execution and recoverable state
* Clear execution logs and diagnostic information
* Safe handling of interrupted or failed operations
* Versioned configuration and data migrations

Validate each CLI's actual installation, invocation, authentication, and supported capabilities rather than assuming all tools behave identically.
10. Core Product Principles
The product should follow these principles:

* Plan before executing: Convert vague requests into meaningful work.
* Context before prompting: Reuse project knowledge instead of repeating repository analysis.
* Configurable intelligence: Let users decide which AI handles each responsibility.
* Automation by default: Minimise manual orchestration and repetitive decisions.
* Verification is mandatory: Treat implementation and verification as distinct responsibilities when appropriate.
* One internal source of truth: Own project state, tasks, dependencies, and execution history internally.
* Offline-aware design: Preserve local knowledge and support disconnected workflows wherever technically possible.
* Complexity-aware execution: Keep small tasks small and decompose complex work intelligently.
* Transparency and control: Make decisions, assumptions, failures, and progress visible.

Final Objective
Build an AI-native engineering workspace that takes a developer from a single-line request to a well-planned, context-aware, automatically executed, and independently verified outcome.
The user should not have to manage every agent, create every subtask manually, repeatedly scan the repository, or maintain a separate project board.
The product should manage the engineering workflow. The developer should focus on defining the outcome and reviewing the result.
