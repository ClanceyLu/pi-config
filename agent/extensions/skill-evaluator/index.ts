import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EvaluationRuntime } from "./orchestration-runtime.ts";
import { registerEvaluationTools } from "./orchestration-tools.ts";

export default function skillEvaluatorExtension(pi: ExtensionAPI): void {
	if (process.env.PI_SKILL_EVAL_CHILD === "1") return;
	const runtime = new EvaluationRuntime(pi);
	registerEvaluationTools(pi, runtime);
	pi.registerCommand("skill-eval", {
		description: "Let the current Agent evaluate a naturally described Skill with two parallel A/B subagents",
		handler: async (args, ctx) => runtime.startCommand(args, ctx),
	});
	pi.on("agent_settled", (_event, ctx) => runtime.onAgentSettled(ctx));
	pi.on("session_shutdown", (_event, ctx) => runtime.onSessionShutdown(ctx));
}
