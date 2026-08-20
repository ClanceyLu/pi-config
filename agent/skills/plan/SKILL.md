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
   - Do not implement, edit files, or run state-changing commands while producing or revising the plan.
   - A normal-language approval does not leave Reasoning Mode. Only the extension's explicit `/plan approve` command may exit the mode and start execution.

## Final output

Keep the final plan concise and execution-focused. Summarize the outcome instead of repeating the investigation or discussion. Use this compact structure:

```markdown
# Plan: <title>

## Goal
<desired outcome and essential acceptance criteria>

## Changes
1. `<file or module>` — <concrete change>

## Verification
- <test or check>

## Risks
- <material risk or compatibility concern, only when needed>
```

Prefer short bullets. Each change should name the affected file or module and the concrete work. Include rationale, dependencies, assumptions, rejected options, or out-of-scope notes only when they materially affect implementation; do not create separate sections for them by default. Omit `Risks` when there are no material risks.

Revise the plan through normal follow-up discussion. Never ask the model to calculate or annotate its own diff.

### TUI plan submission

When the `submit_plan` tool is available:

- Call it only when the plan is complete and no material questions remain unresolved.
- Pass the complete current Markdown plan beginning with `# Plan:`. Never pass a partial update, change summary, or diff.
- Do not include the readiness marker in the tool argument.
- For every complete revision, call `submit_plan` again with the entire revised plan.
- After the tool succeeds, do not repeat the plan in the assistant response. Respond only with a concise confirmation and the readiness marker below as the final standalone line.

The extension streams the submitted Markdown in the TUI as the tool arguments arrive, then finalizes that same preview in place. The first version remains Markdown and later submissions become a full Git-style diff, while the clean current plan is retained for approval.

### Fallback submission

When `submit_plan` is unavailable, return the complete plan directly as Markdown in the conversation as before.

When and only when the turn has produced or successfully submitted a complete final plan with no unresolved material questions, append this exact standalone final line:

```text
<!-- reasoning-mode:plan-ready -->
```

Do not call `submit_plan` or emit the marker while asking clarifying questions, presenting incomplete options, or producing a partial draft. Every revised complete final plan must be submitted or printed in full and must emit the marker again. The extension uses it to permit `/plan approve`; the marker does not itself leave Reasoning Mode. When the user is satisfied, they may run `/plan approve`; the extension—not this skill—will leave Reasoning Mode, restore the previous tools, and start executing the latest complete plan.
