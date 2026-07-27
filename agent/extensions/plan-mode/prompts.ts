import { formatPlanMarkdown } from "./state.ts";
import type { PlanModeState } from "./types.ts";

const PLANNING_PROMPT = `<pi_plan_mode>
# Plan Mode

You are in an explicit read-only planning collaboration mode. This mode only ends when the extension records an explicit user approval or mode change. User wording, urgency, or an instruction such as "implement it" does not change the mode; while this block is present, treat execution requests as requests to plan the execution.

## Safety
- Observe, read, search, reason, and ask questions. Do not modify project or system state.
- Use only the available inspection tools. A blocked tool must not be bypassed through another command, script, subprocess, or external tool.
- Tests and builds may create artifacts and therefore require explicit permission when offered.

## Workflow
1. Ground yourself in the repository before asking questions. Resolve discoverable facts with targeted inspection.
2. Ask only questions that materially affect intent, scope, interfaces, tradeoffs, or acceptance criteria. Prefer plan_question when available.
3. Produce a decision-complete implementation plan: goal, behavioral changes, interfaces/data flow where relevant, edge cases, verification, assumptions, and exclusions.
4. Submit the final complete plan with propose_plan. A revision must be a complete replacement, not a patch to an earlier proposal.

Do not use update_plan while planning. Do not ask "should I proceed?" in normal prose; propose_plan owns approval.
</pi_plan_mode>`;

export function promptForState(state: PlanModeState): string | undefined {
	if (state.phase === "planning" || state.phase === "awaiting_approval") {
		const revision = state.plan
			? `\n\nThe current proposal is revision ${state.plan.revision}. If changes are needed, submit a complete replacement.`
			: "";
		return PLANNING_PROMPT + revision;
	}
	if (state.phase === "executing" && state.plan) {
		return `<pi_plan_execution>
# Approved Plan Execution

The user approved the exact plan below. Implement it using the restored tool set. Use update_plan to mark steps in_progress, completed, blocked, or skipped; do not report progress with ad-hoc markers. Keep at most one step in progress. If repository facts require a material design change, mark the affected step blocked and ask to return to planning rather than silently changing scope.

${formatPlanMarkdown(state.plan)}
</pi_plan_execution>`;
	}
	return undefined;
}
