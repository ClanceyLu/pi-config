---
name: plan
description: Create a repository-grounded implementation plan through clarification, code exploration, option analysis, and risk assessment. Use explicitly when the user wants a plan for a project change.
disable-model-invocation: true
metadata:
  reasoning-mode: "true"
---

# Plan

Create a decision-ready implementation plan without modifying project or system state. Communicate in the user's language.

## Scope

Use this workflow for any project change: features, bug-fix planning, refactors, migrations, integrations, architecture changes, performance or security improvements, and configuration or documentation work.

## Workflow

1. **Understand the outcome**
   - Restate the desired behavior, constraints, and acceptance criteria.
   - Separate explicit requirements from assumptions.

2. **Ground the discussion in the repository**
   - Inspect relevant entry points, modules, types, configuration, tests, and similar implementations.
   - Resolve facts through targeted reading and search before asking the user.
   - Cite concrete files and symbols. Do not invent project patterns.

3. **Ask only material questions**
   - Ask when an answer changes scope, interfaces, behavior, tradeoffs, compatibility, or acceptance criteria.
   - In TUI mode, prefer the `questionnaire` tool when it is available. Group related questions instead of asking them one at a time.
   - If `questionnaire` is unavailable, ask concise numbered questions in normal text and wait for answers.

4. **Analyze options**
   - Present meaningful alternatives and their tradeoffs when more than one approach is viable.
   - Recommend the simplest approach that fits existing project conventions.
   - Record rejected alternatives and why they were rejected.

5. **Produce the final plan**
   - Do not finalize while material questions remain unresolved.
   - Make the plan actionable for an implementer who has not followed the full discussion.
   - Do not implement, edit files, run state-changing commands, or treat approval as permission to leave Reasoning Mode.

## Final output

Use this structure, omitting only sections that are genuinely irrelevant:

```markdown
# Plan: <title>

## Goal
## Requirements and acceptance criteria
## Current implementation
## Relevant files and modules
## Confirmed decisions
## Options considered
## Recommended approach
## Implementation steps
## Testing and verification
## Risks and edge cases
## Assumptions
## Out of scope
```

Each implementation step should identify:

- affected files or modules
- the concrete change
- why it is needed
- dependencies on other steps
- how to verify it
- important risks or compatibility concerns

Return the plan directly as Markdown in the conversation. Revise it through normal follow-up discussion. There is no proposal, approval, export, or execution workflow in this skill.
