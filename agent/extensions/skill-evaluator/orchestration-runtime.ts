import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AcquiredSkillSource } from "./acquisition.ts";
import { finishEvaluationReport } from "./report.ts";
import type { BlindMapping, EvaluationConfig, EvaluationReport, ModelRef, PairRunResult, SkillTarget } from "./types.ts";
import { errorText, modelRef, orchestratorPrompt, sameSession, skillCommandName, TOOL_NAMES } from "./orchestration-prompts.ts";

export interface CapturedRequest {
	id: string;
	userRequest: string;
	sessionId: string;
	cwd: string;
	model: ModelRef;
	thinkingLevel: EvaluationConfig["thinkingLevel"];
	activeTools: string[];
	approveProjectResources: boolean;
	startedAt: Date;
	widgetVersion: number;
}

export interface RuntimeTask {
	status: "preparing" | "ready" | "running" | "awaiting_judgment" | "completed" | "failed" | "cancelled";
	request: CapturedRequest;
	skill?: SkillTarget;
	acquired?: AcquiredSkillSource;
	acquiredInput?: string;
	reportDirectory?: string;
	report?: EvaluationReport;
	result?: PairRunResult;
	mapping?: BlindMapping;
	abortController: AbortController;
	turnSignal?: AbortSignal;
	warnings: string[];
	history: string[];
}

function reportWithResults(task: RuntimeTask): void {
	if (!task.report || !task.result || !task.mapping) return;
	task.report.arms = task.result;
	task.report.labelMap = task.mapping;
}

async function collectFailures(operations: Array<Promise<unknown>>): Promise<unknown[]> {
	const settled = await Promise.allSettled(operations);
	return settled.filter((item): item is PromiseRejectedResult => item.status === "rejected").map((item) => item.reason);
}

export class EvaluationRuntime {
	current?: RuntimeTask;
	readonly pi: ExtensionAPI;
	private widgetVersion = 0;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	require(ctx: ExtensionContext): RuntimeTask {
		if (!this.current) throw new Error("No /skill-eval task is active in this session.");
		if (!sameSession(this.current, ctx)) throw new Error("The active Skill evaluation belongs to a different session.");
		return this.current;
	}

	update(ctx: ExtensionContext, message: string, title = "Skill evaluation in progress"): void {
		if (!this.current) return;
		const line = message.replace(/\s+/g, " ").trim();
		if (line && this.current.history.at(-1) !== line) this.current.history.push(line);
		ctx.ui.setStatus("skill-eval", line.slice(0, 100));
		ctx.ui.setWidget("skill-eval", [title, ...this.current.history.slice(-8).map((item) => `• ${item}`)]);
	}

	async cleanupAcquired(task: RuntimeTask): Promise<void> {
		const acquired = task.acquired;
		if (acquired) await acquired.cleanup();
		task.acquired = undefined;
		task.acquiredInput = undefined;
	}

	async cancelAtConfirmation(task: RuntimeTask, ctx: ExtensionContext): Promise<void> {
		task.status = "cancelled";
		this.update(ctx, "cancelled at confirmation", "Skill evaluation cancelled");
		try {
			await this.cleanupAcquired(task);
		} finally {
			this.release(task, ctx);
		}
	}

	async failRunningTask(task: RuntimeTask, ctx: ExtensionContext, primary: unknown): Promise<Error> {
		const cancelled = task.turnSignal?.aborted === true;
		const status = cancelled ? "cancelled" : "failed";
		const message = errorText(primary);
		task.status = status;
		reportWithResults(task);
		const operations: Array<Promise<unknown>> = [this.cleanupAcquired(task)];
		if (task.report && task.reportDirectory) {
			operations.push(finishEvaluationReport({ directory: task.reportDirectory, report: task.report, status, error: message }));
		}
		const failures = await collectFailures(operations);
		this.update(ctx, message, cancelled ? "Skill evaluation cancelled" : "Skill evaluation failed");
		this.release(task, ctx);
		const hint = task.reportDirectory ? ` Partial report: ${task.reportDirectory}` : "";
		if (failures.length > 0) return new AggregateError([primary, ...failures], `${message}.${hint} Cleanup/report finalization also failed.`);
		return new Error(`${message}.${hint}`, { cause: primary });
	}

	complete(task: RuntimeTask, ctx: ExtensionContext, winner: string): void {
		task.status = "completed";
		this.update(ctx, `completed: ${winner}; report ${task.reportDirectory}`, "Skill evaluation complete");
		const version = task.request.widgetVersion;
		this.release(task, ctx);
		const timer = setTimeout(() => {
			if (this.widgetVersion !== version || this.current || !sameSession(task, ctx)) return;
			ctx.ui.setWidget("skill-eval", undefined);
		}, 10_000);
		timer.unref();
	}

	startCommand(args: string, ctx: ExtensionCommandContext): void {
		if (ctx.mode !== "tui") return ctx.ui.notify("/skill-eval requires interactive TUI mode.", "error");
		if (!args.trim()) return ctx.ui.notify("Usage: /skill-eval <natural-language Skill request>", "warning");
		if (this.current) return ctx.ui.notify("A Skill evaluation task is already active.", "warning");
		if (!ctx.model) return ctx.ui.notify("No current conversation model is selected.", "error");
		const activeTools = this.pi.getActiveTools();
		const task = this.createTask(args, ctx, modelRef(ctx.model), activeTools);
		this.current = task;
		this.pi.setActiveTools([...TOOL_NAMES]);
		this.update(ctx, "current Agent is resolving the Skill source");
		const installed = this.pi.getCommands()
			.filter((command) => command.source === "skill" && command.sourceInfo.path)
			.map((command) => ({ name: skillCommandName(command.name), description: command.description, path: command.sourceInfo.path }));
		try {
			this.pi.sendUserMessage(orchestratorPrompt(args, installed));
		} catch (error) {
			this.release(task, ctx);
			ctx.ui.notify(`Failed to start Skill evaluation turn: ${errorText(error)}`, "error");
		}
	}

	async onAgentSettled(ctx: ExtensionContext): Promise<void> {
		const task = this.current;
		if (!task || !sameSession(task, ctx)) return;
		if (!["preparing", "ready", "awaiting_judgment"].includes(task.status)) return;
		const cancelled = task.turnSignal?.aborted === true;
		const message = cancelled ? errorText(task.turnSignal?.reason ?? "Current Agent turn was aborted.")
			: task.status === "awaiting_judgment" ? "Current Agent settled without submitting judgment."
				: "Current Agent settled before the evaluation was run.";
		await this.finalizeTerminal(task, ctx, cancelled ? "cancelled" : "failed", message);
	}

	async onSessionShutdown(ctx: ExtensionContext): Promise<void> {
		const task = this.current;
		if (!task) return;
		task.abortController.abort(new Error("Session shutdown"));
		if (task.status === "running") return;
		await this.finalizeTerminal(task, ctx, "cancelled", "Session shutdown");
	}

	private createTask(args: string, ctx: ExtensionCommandContext, model: ModelRef, activeTools: string[]): RuntimeTask {
		return {
			status: "preparing",
			request: {
				id: randomUUID(), userRequest: args, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
				model, thinkingLevel: this.pi.getThinkingLevel(), activeTools,
				approveProjectResources: ctx.isProjectTrusted(), startedAt: new Date(), widgetVersion: ++this.widgetVersion,
			},
			abortController: new AbortController(), warnings: [], history: [],
		};
	}

	private async finalizeTerminal(task: RuntimeTask, ctx: ExtensionContext, status: "failed" | "cancelled", message: string): Promise<void> {
		task.status = status;
		reportWithResults(task);
		const operations: Array<Promise<unknown>> = [this.cleanupAcquired(task)];
		if (task.report && task.reportDirectory) {
			operations.push(finishEvaluationReport({ directory: task.reportDirectory, report: task.report, status, error: message }));
		}
		const failures = await collectFailures(operations);
		this.update(ctx, message, status === "cancelled" ? "Skill evaluation cancelled" : "Skill evaluation failed");
		this.release(task, ctx);
		if (failures.length > 0) throw new AggregateError(failures, `Skill evaluation ${status}, but finalization failed.`);
	}

	private release(task: RuntimeTask, ctx: ExtensionContext): void {
		if (this.current !== task) return;
		ctx.ui.setStatus("skill-eval", undefined);
		this.pi.setActiveTools(task.request.activeTools);
		this.current = undefined;
	}
}
