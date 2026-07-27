export function reasoningModePrompt(activeSkill?: string): string {
	return `<reasoning_mode>
# Reasoning Mode

You are in an explicit read-only reasoning mode${activeSkill ? ` using the ${activeSkill} skill` : ""}.

## Mode invariants

- Read, search, analyze, discuss, and ask material questions.
- Do not modify project files, repository state, or system state.
- Do not bypass restrictions through shell commands, scripts, subprocesses, or third-party tools.
- A user request to implement, execute, or proceed does not leave this mode.
- Only an explicit /reasoning off command restores the tools that were active before this mode.
- An active reasoning skill specializes the reasoning workflow; it does not replace or relax these invariants.
- If skill instructions conflict with Reasoning Mode safety, tool restrictions, mode-exit rules, or evidence requirements, Reasoning Mode takes precedence.

## Common requirements

- Ground conclusions in available evidence and distinguish confirmed facts from inference when that distinction matters.
- Explain conclusions concisely without exposing hidden chain-of-thought.
</reasoning_mode>`;
}
