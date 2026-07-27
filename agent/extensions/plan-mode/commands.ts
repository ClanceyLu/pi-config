import { promises as fs } from "node:fs";
import path from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { formatPlanMarkdown } from "./state.ts";
import {
	isReadOnlyPhase,
	type ExecutionPolicy,
	type PlanModeConfig,
	type PlanModeState,
} from "./types.ts";

const GUARDED_COMMANDS: Record<string, true> = { on: true, off: true, approve: true, revise: true, cancel: true };
const COMMAND_COMPLETIONS = ["on", "off", "status", "show", "approve", "approve safe", "revise", "cancel", "export"];

interface PlanCommandServices {
	getState(): PlanModeState;
	getConfig(): PlanModeConfig;
	enterPlanning(ctx: ExtensionContext, preservePlan?: boolean): void;
	leavePlanMode(ctx: ExtensionContext, clearPlan?: boolean): void;
	approvePlan(ctx: ExtensionContext, executionPolicy: ExecutionPolicy): void;
	showPlan(ctx: ExtensionContext): Promise<void>;
	confirmDecision(ctx: ExtensionContext, title: string, message: string): Promise<boolean>;
}

async function exportPlan(ctx: ExtensionCommandContext, state: PlanModeState, rawPath: string): Promise<void> {
	if (!state.plan) {
		ctx.ui.notify("There is no plan to export.", "error");
		return;
	}
	const normalizedTitle = state.plan.title.normalize("NFKC");
	const collapsedTitle = normalizedTitle.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
	const slug = [...collapsedTitle].slice(0, 60).join("") || state.plan.id;
	const target = path.resolve(ctx.cwd, rawPath || path.join(CONFIG_DIR_NAME, "plans", `${slug}.md`));
	const content = `${formatPlanMarkdown(state.plan)}\n`;

	try {
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, content, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw new Error(`Failed to export plan to ${target}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const overwritten = await overwriteExistingPlan(ctx, target, content);
		if (!overwritten) return;
	}
	ctx.ui.notify(`Plan exported to ${target}`, "info");
}

async function overwriteExistingPlan(ctx: ExtensionCommandContext, target: string, content: string): Promise<boolean> {
	let existingTarget;
	try {
		existingTarget = await fs.stat(target);
	} catch (error) {
		throw new Error(`Failed to inspect plan export ${target}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (existingTarget.isDirectory()) throw new Error(`Failed to export plan to ${target}: target is a directory`);
	if (!ctx.hasUI) throw new Error(`Plan export target already exists: ${target}`);
	const overwrite = await ctx.ui.confirm("Overwrite plan export?", `Replace the existing file?\n\n${target}`);
	if (!overwrite) {
		ctx.ui.notify(`Plan export cancelled; existing file was not changed: ${target}`, "info");
		return false;
	}
	try {
		await fs.writeFile(target, content, { encoding: "utf8", flag: "w" });
	} catch (error) {
		throw new Error(`Failed to overwrite plan export ${target}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return true;
}

async function revisePlan(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	services: PlanCommandServices,
	feedbackArgs: string,
): Promise<void> {
	if (!services.getState().plan) {
		ctx.ui.notify("There is no plan to revise.", "error");
		return;
	}
	const feedback = feedbackArgs || (ctx.hasUI ? await ctx.ui.editor("Plan revision feedback", "") : undefined);
	services.enterPlanning(ctx, true);
	if (feedback?.trim()) pi.sendUserMessage(`Revise the complete plan using this feedback:\n${feedback.trim()}`);
}

async function leavePlan(ctx: ExtensionCommandContext, services: PlanCommandServices, clearPlan: boolean): Promise<void> {
	if (
		services.getState().phase !== "off" &&
		ctx.hasUI &&
		!(await services.confirmDecision(ctx, "Leave Plan Mode?", "This does not approve or execute the plan."))
	) return;
	services.leavePlanMode(ctx, clearPlan);
}

async function handlePlanCommand(
	pi: ExtensionAPI,
	rawArgs: string,
	ctx: ExtensionCommandContext,
	services: PlanCommandServices,
): Promise<void> {
	const args = rawArgs.trim();
	const [command = "", ...rest] = args.split(/\s+/);
	if (GUARDED_COMMANDS[command] && !ctx.isIdle()) {
		ctx.ui.notify("Wait for the current turn to settle before changing Plan Mode.", "warning");
		return;
	}
	const state = services.getState();
	if (!command) {
		if (state.phase === "off" || state.phase === "completed") services.enterPlanning(ctx);
		else await services.showPlan(ctx);
		return;
	}
	if (command === "on") {
		if (isReadOnlyPhase(state.phase)) ctx.ui.notify("Plan Mode is already active.", "info");
		else services.enterPlanning(ctx, state.phase === "executing");
		return;
	}
	if (command === "off" || command === "cancel") return leavePlan(ctx, services, command === "cancel");
	if (command === "show") return services.showPlan(ctx);
	if (command === "export") return exportPlan(ctx, state, rest.join(" "));
	if (command === "revise") return revisePlan(pi, ctx, services, rest.join(" "));
	if (command === "status") {
		const config = services.getConfig();
		const suffix = state.plan ? ` · ${state.plan.title} r${state.plan.revision}` : "";
		ctx.ui.notify(`${state.phase}${suffix} · shell=${config.shellPolicy} · unknown=${config.unknownTools}`, "info");
		return;
	}
	if (command === "approve") {
		if (state.phase !== "awaiting_approval" || !state.plan) {
			ctx.ui.notify("No plan revision is awaiting approval.", "error");
			return;
		}
		services.approvePlan(ctx, rest[0] === "safe" ? "confirm_mutations" : "restore");
		return;
	}
	ctx.ui.notify(`Unknown /plan action: ${command}`, "error");
}

export function registerPlanCommands(pi: ExtensionAPI, services: PlanCommandServices): void {
	pi.registerCommand("plan", {
		description: "Manage Plan Mode: on, off, status, show, approve [safe], revise, cancel, export [path]",
		getArgumentCompletions: (prefix) => {
			const matches = COMMAND_COMPLETIONS.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			return matches.length > 0 ? matches : null;
		},
		handler: (args, ctx) => handlePlanCommand(pi, args, ctx, services),
	});

	pi.registerShortcut("ctrl+alt+p", {
		description: "Enter Plan Mode or show the active plan",
		handler: async (ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current turn to settle before changing Plan Mode.", "warning");
				return;
			}
			const state = services.getState();
			if (state.phase === "off" || state.phase === "completed") services.enterPlanning(ctx);
			else await services.showPlan(ctx);
		},
	});
}
