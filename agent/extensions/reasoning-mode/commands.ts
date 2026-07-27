import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReasoningModeConfig, ReasoningModeState } from "./types.ts";

interface ReasoningCommandServices {
	getState(): ReasoningModeState;
	getConfig(): ReasoningModeConfig;
	enter(ctx: ExtensionContext, activeSkill?: string): void;
	leave(ctx: ExtensionContext): void;
	activateSkill(ctx: ExtensionContext, name: string): Promise<boolean>;
	updateUI(ctx: ExtensionContext): void;
}

function statusText(state: ReasoningModeState, config: ReasoningModeConfig): string {
	const skill = state.activeSkill ? ` · skill=${state.activeSkill}` : "";
	return `${state.mode}${skill} · shell=${config.shellPolicy} · unknown=${config.unknownTools}`;
}

async function startSkill(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	services: ReasoningCommandServices,
	name: string,
	task: string,
): Promise<void> {
	if (!ctx.isIdle()) {
		ctx.ui.notify("Wait for the current turn to settle before changing Reasoning Mode.", "warning");
		return;
	}
	if (!(await services.activateSkill(ctx, name))) return;
	pi.sendUserMessage(task.trim() || `Start the ${name} workflow. Ask what the user wants to analyze if the task is not yet clear.`);
}

export function registerReasoningCommands(pi: ExtensionAPI, services: ReasoningCommandServices): void {
	pi.registerCommand("reasoning", {
		description: "Manage read-only Reasoning Mode: on, off, status, or <skill> [task]",
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();
			const [command = "", ...rest] = args.split(/\s+/);
			if (!command) {
				if (services.getState().mode === "off") {
					if (!ctx.isIdle()) {
						ctx.ui.notify("Wait for the current turn to settle before changing Reasoning Mode.", "warning");
						return;
					}
					services.enter(ctx);
				} else ctx.ui.notify(statusText(services.getState(), services.getConfig()), "info");
				return;
			}
			if (command === "status") {
				ctx.ui.notify(statusText(services.getState(), services.getConfig()), "info");
				return;
			}
			if (command === "on") {
				if (!ctx.isIdle()) {
					ctx.ui.notify("Wait for the current turn to settle before changing Reasoning Mode.", "warning");
					return;
				}
				services.enter(ctx);
				return;
			}
			if (command === "off") {
				if (!ctx.isIdle()) {
					ctx.ui.notify("Wait for the current turn to settle before changing Reasoning Mode.", "warning");
					return;
				}
				services.leave(ctx);
				return;
			}
			await startSkill(pi, ctx, services, command, rest.join(" "));
		},
	});

	pi.registerCommand("plan", {
		description: "Shortcut for /reasoning plan [task]",
		handler: (args, ctx) => startSkill(pi, ctx, services, "plan", args),
	});

	pi.registerShortcut("ctrl+alt+p", {
		description: "Enable Reasoning Mode with the plan skill",
		handler: async (ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current turn to settle before changing Reasoning Mode.", "warning");
				return;
			}
			if (services.getState().mode === "reasoning" && services.getState().activeSkill === "plan") {
				ctx.ui.notify(statusText(services.getState(), services.getConfig()), "info");
				return;
			}
			await services.activateSkill(ctx, "plan");
		},
	});
}
