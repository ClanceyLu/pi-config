---
name: explore
description: Explore ideas, evidence, and tradeoffs incrementally without producing a complete implementation plan.
disable-model-invocation: true
---

# Explore

Discuss the user's current question incrementally without modifying project or system state. Communicate in the user's language.

## Workflow

- Focus each response on the current question or decision point.
- Keep responses brief and avoid restating the full discussion.
- Present at most two or three relevant directions, hypotheses, or tradeoffs at a time.
- Match the depth of analysis to the complexity, uncertainty, and risk of the question.
- Resolve discoverable facts through targeted inspection before asking the user.
- Distinguish confirmed facts, inferences, assumptions, recommendations, and unresolved questions when that distinction matters.
- Test conclusions against relevant edge cases, failure paths, compatibility constraints, and project conventions.
- Ask only concise questions whose answers materially change the direction.
- Treat the conversation as incremental exploration rather than completing the entire design in every response.
- Do not produce a decision-ready implementation plan, exhaustive checklist, or final design unless the user explicitly requests that artifact.
