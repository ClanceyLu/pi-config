import { StringEnum } from "@earendil-works/pi-ai";
import {
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolCallEvent,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { registerPlanCommands } from "./commands.ts";
import { loadConfig } from "./config.ts";
import { PlanInputSchema, planFromInput, type PlanInput } from "./plan-document.ts";
import { classifyBashCommand, classifyTool, PLAN_TOOL_NAMES, planningToolSet } from "./policy.ts";
import { promptForState } from "./prompts.ts";
import { applyStepUpdates, formatPlanMarkdown, isPlanComplete, normalizeState } from "./state.ts";
import {
	DEFAULT_CONFIG,
	INITIAL_STATE,
	isReadOnlyPhase,
	type ExecutionPolicy,
	type PlanDocument,
	type PlanModeConfig,
	type PlanModeState,
	type StepStatus,
} from "./types.ts";

const STATE_ENTRY_TYPE = "plan-mode-state-v1";
const STATUS_KEY = "plan-mode";
const WIDGET_KEY = "plan-mode-plan";
const QuestionSchema = Type.Object({
	header: Type.Optional(Type.String()),
	question: Type.String({ minLength: 3 }),
	options: Type.Array(
		Type.Object({ label: Type.String({ minLength: 1 }), description: Type.Optional(Type.String()) }),
		{ minItems: 2, maxItems: 4 },
	),
	allowOther: Type.Optional(Type.Boolean()),
});
const QuestionInputSchema = Type.Object({ questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4 }) });
type QuestionInput = Static<typeof QuestionInputSchema>;
const StepUpdateSchema = Type.Object({
	stepId: Type.String(),
	status: StringEnum(["pending", "in_progress", "completed", "blocked", "skipped"] as const),
	note: Type.Optional(Type.String()),
});
const UpdatePlanSchema = Type.Object({ updates: Type.Array(StepUpdateSchema, { minItems: 1, maxItems: 20 }) });
type UpdatePlanInput = Static<typeof UpdatePlanSchema>;

function unique(names: string[]): string[] {
	return [...new Set(names)];
}

export class PlanModeRuntime {
	private state: PlanModeState = structuredClone(INITIAL_STATE);
	private config: PlanModeConfig = structuredClone(DEFAULT_CONFIG);
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	register(): void {
		this.pi.registerFlag("plan", { description: "Start in read-only Plan Mode", type: "boolean", default: false });
		this.registerQuestionTool();
		this.registerProposalTool();
		this.registerProgressTool();
		this.registerEvents();
		registerPlanCommands(this.pi, {
			getState: () => this.state,
			getConfig: () => this.config,
			enterPlanning: (ctx, preserve) => this.enterPlanning(ctx, preserve),
			leavePlanMode: (ctx, clear) => this.leavePlanMode(ctx, clear),
			approvePlan: (ctx, policy) => this.approvePlan(ctx, policy),
			showPlan: (ctx) => this.showPlan(ctx),
			confirmDecision: (ctx, title, message) => this.confirmDecision(ctx, title, message),
		});
	}

	private unmanagedActiveTools(): string[] {
		return this.pi.getActiveTools().filter((name) => !PLAN_TOOL_NAMES.has(name));
	}

	private ensureToolSnapshot(): string[] {
		if (this.state.toolsBeforePlan) return this.state.toolsBeforePlan;
		const snapshot = this.unmanagedActiveTools();
		this.state = { ...this.state, toolsBeforePlan: snapshot };
		return snapshot;
	}

	private restoreNormalTools(): void {
		const restored = this.state.toolsBeforePlan ?? this.unmanagedActiveTools();
		this.pi.setActiveTools(restored.filter((name) => !PLAN_TOOL_NAMES.has(name)));
	}

	private applyToolsForPhase(): void {
		if (isReadOnlyPhase(this.state.phase)) {
			this.pi.setActiveTools(planningToolSet(this.ensureToolSnapshot(), this.config));
		} else if (this.state.phase === "executing") {
			this.pi.setActiveTools(unique([...this.ensureToolSnapshot(), "update_plan"]));
		} else {
			this.restoreNormalTools();
		}
	}

	private persistState(): void {
		this.pi.appendEntry(STATE_ENTRY_TYPE, structuredClone(this.state));
	}

	private updateUI(ctx: ExtensionContext): void {
		const plan = this.state.plan;
		const style = (color: "warning" | "accent" | "success" | "error" | "muted", text: string): string =>
			ctx.mode === "tui" ? ctx.ui.theme.fg(color, text) : text;
		if (this.state.phase === "planning") ctx.ui.setStatus(STATUS_KEY, style("warning", plan ? `PLAN r${plan.revision}` : "PLAN"));
		else if (this.state.phase === "awaiting_approval") ctx.ui.setStatus(STATUS_KEY, style("warning", "PLAN · APPROVAL"));
		else if (this.state.phase === "executing" && plan) {
			const done = plan.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
			ctx.ui.setStatus(STATUS_KEY, style("accent", `EXEC ${done}/${plan.steps.length}`));
		} else ctx.ui.setStatus(STATUS_KEY, undefined);
		if (!plan || !["planning", "awaiting_approval", "executing"].includes(this.state.phase)) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const lines = [ctx.mode === "tui" ? ctx.ui.theme.bold(`${plan.title} · r${plan.revision}`) : `${plan.title} · r${plan.revision}`];
		for (const step of plan.steps) {
			const icon = ({ pending: "○", in_progress: "◉", completed: "✓", blocked: "!", skipped: "−" } as const)[step.status];
			const color = step.status === "completed" ? "success" : step.status === "blocked" ? "error" : step.status === "in_progress" ? "accent" : "muted";
			lines.push(style(color, `${icon} ${step.id} ${step.title}`));
		}
		ctx.ui.setWidget(WIDGET_KEY, lines);
	}

	private restoreBranchState(ctx: ExtensionContext, honorPlanFlag: boolean): void {
		const baseline = this.state.toolsBeforePlan ?? this.unmanagedActiveTools();
		const saved = [...ctx.sessionManager.getBranch()].reverse().find(
			(entry) => entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE,
		) as { data?: unknown } | undefined;
		this.state = normalizeState(saved?.data);
		let shouldPersist = false;
		if (["planning", "awaiting_approval", "executing"].includes(this.state.phase) && !this.state.toolsBeforePlan) {
			this.state = { ...this.state, toolsBeforePlan: baseline };
			shouldPersist = true;
		}
		if (honorPlanFlag && this.pi.getFlag("plan") === true) {
			if (this.state.phase === "off" || this.state.phase === "completed") {
				this.state = { version: 1, phase: "planning", toolsBeforePlan: baseline, executionPolicy: "restore" };
				shouldPersist = true;
			} else if (this.state.phase === "executing") {
				this.state = { ...this.state, phase: "planning", executionPolicy: "restore" };
				shouldPersist = true;
			}
		}
		if (this.state.phase === "off" || this.state.phase === "completed") {
			this.pi.setActiveTools(baseline.filter((name) => !PLAN_TOOL_NAMES.has(name)));
			this.state = { ...this.state, toolsBeforePlan: undefined };
		} else this.applyToolsForPhase();
		if (shouldPersist) this.persistState();
		this.updateUI(ctx);
	}

	private enterPlanning(ctx: ExtensionContext, preservePlan = false): void {
		const snapshot = this.unmanagedActiveTools();
		this.state = {
			version: 1,
			phase: "planning",
			plan: preservePlan ? this.state.plan : undefined,
			toolsBeforePlan: preservePlan && this.state.toolsBeforePlan ? this.state.toolsBeforePlan : snapshot,
			executionPolicy: "restore",
		};
		this.applyToolsForPhase();
		this.persistState();
		this.updateUI(ctx);
		ctx.ui.notify("Plan Mode enabled: project mutations are blocked.", "info");
	}

	private leavePlanMode(ctx: ExtensionContext, clearPlan = false): void {
		this.restoreNormalTools();
		this.state = {
			...this.state,
			phase: "off",
			plan: clearPlan ? undefined : this.state.plan,
			toolsBeforePlan: undefined,
			executionPolicy: "restore",
		};
		this.persistState();
		this.updateUI(ctx);
		ctx.ui.notify("Plan Mode disabled.", "info");
	}

	private approvePlan(ctx: ExtensionContext, executionPolicy: ExecutionPolicy): void {
		const plan = this.state.plan;
		if (this.state.phase !== "awaiting_approval" || !plan) throw new Error("No plan revision is awaiting approval.");
		const awaitingState = this.state;
		this.state = { ...this.state, phase: "executing", executionPolicy };
		this.applyToolsForPhase();
		this.persistState();
		this.updateUI(ctx);
		try {
			this.pi.sendMessage(
				{ customType: "plan-approved", content: this.approvedMessage(plan), display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (error) {
			this.state = awaitingState;
			this.applyToolsForPhase();
			this.persistState();
			this.updateUI(ctx);
			throw new Error(`Failed to start plan execution: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private approvedMessage(plan: PlanDocument): string {
		return `The user approved plan ${plan.id} revision ${plan.revision}. Execute this exact plan and track progress with update_plan.\n\n${formatPlanMarkdown(plan)}`;
	}

	private async confirmDecision(ctx: ExtensionContext, title: string, message: string): Promise<boolean> {
		return ctx.hasUI ? ctx.ui.confirm(title, message) : false;
	}

	private registerQuestionTool(): void {
		this.pi.registerTool({
			name: "plan_question",
			label: "Plan Question",
			executionMode: "sequential",
			description: "Ask up to four material planning questions with meaningful choices. Available only in Plan Mode.",
			promptSnippet: "Ask the user material planning questions with structured choices",
			parameters: QuestionInputSchema,
			execute: async (_id, params: QuestionInput, _signal, _update, ctx) => this.askPlanningQuestions(params, ctx),
		});
	}

	private async askPlanningQuestions(params: QuestionInput, ctx: ExtensionContext) {
		if (!isReadOnlyPhase(this.state.phase)) throw new Error("plan_question is only available in Plan Mode");
		if (!ctx.hasUI) return { content: [{ type: "text" as const, text: "Interactive UI is unavailable. Ask the material question directly and wait for a user response." }], details: { answered: false } };
		const answers: Array<{ question: string; answer: string }> = [];
		for (const question of params.questions) {
			const choices = question.options.map((option, index) => `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`);
			const otherIndex = question.options.length;
			if (question.allowOther) choices.push(`${otherIndex + 1}. Other…`);
			const title = question.header ? `${question.header}: ${question.question}` : question.question;
			const selected = await ctx.ui.select(title, choices);
			if (!selected) return { content: [{ type: "text" as const, text: "The user cancelled the planning question." }], details: { answered: false, answers } };
			const selectedIndex = choices.indexOf(selected);
			if (selectedIndex < 0) throw new Error(`Unknown planning question selection: ${selected}`);
			let answer = question.options[selectedIndex]?.label;
			if (selectedIndex === otherIndex && question.allowOther) {
				const custom = await ctx.ui.input(question.header ?? "Other answer", "Type your answer");
				if (!custom?.trim()) return { content: [{ type: "text" as const, text: "The user cancelled the custom answer." }], details: { answered: false, answers } };
				answer = custom.trim();
			}
			if (!answer) throw new Error(`Unknown planning question selection: ${selected}`);
			answers.push({ question: question.question, answer });
		}
		return { content: [{ type: "text" as const, text: answers.map((item) => `Q: ${item.question}\nA: ${item.answer}`).join("\n\n") }], details: { answered: true, answers } };
	}

	private registerProposalTool(): void {
		this.pi.registerTool({
			name: "propose_plan",
			label: "Propose Plan",
			executionMode: "sequential",
			description: "Submit a complete, decision-ready plan revision for user approval. This is the only Plan Mode approval boundary.",
			promptSnippet: "Submit the final complete Plan Mode proposal for approval",
			parameters: PlanInputSchema,
			execute: async (_id, params: PlanInput, _signal, _update, ctx) => this.proposePlan(params, ctx),
		});
	}

	private async proposePlan(params: PlanInput, ctx: ExtensionContext) {
		if (!isReadOnlyPhase(this.state.phase)) throw new Error("propose_plan is only available in Plan Mode");
		const plan = planFromInput(params, this.state.plan);
		this.state = { ...this.state, phase: "awaiting_approval", plan };
		this.persistState();
		this.updateUI(ctx);
		const markdown = formatPlanMarkdown(plan);
		if (!ctx.hasUI) return this.headlessProposalResult(plan, markdown);
		if (ctx.mode === "tui") await ctx.ui.editor(`Review ${plan.title} · revision ${plan.revision} (read-only)`, markdown);
		else ctx.ui.notify(markdown, "info");
		const choice = await ctx.ui.select(`Approve ${plan.title} · revision ${plan.revision}?`, [
			"Approve and restore normal tools",
			"Approve and confirm mutations during execution",
			"Revise with feedback",
			"Stay in Plan Mode",
		]);
		if (choice?.startsWith("Approve")) {
			const policy = choice.includes("confirm") ? "confirm_mutations" : "restore";
			this.approvePlan(ctx, policy);
			return { content: [{ type: "text" as const, text: "The user approved this exact plan for execution." }], details: { plan, decision: "approved", executionPolicy: policy }, terminate: true };
		}
		this.state = { ...this.state, phase: "planning" };
		this.persistState();
		this.updateUI(ctx);
		if (choice === "Revise with feedback") {
			const feedback = await ctx.ui.editor("Plan revision feedback", "");
			return { content: [{ type: "text" as const, text: feedback?.trim() ? `Revise the complete plan using this feedback:\n${feedback.trim()}` : "Continue refining the plan." }], details: { plan, decision: "revise", feedback: feedback?.trim() }, terminate: !feedback?.trim() };
		}
		return { content: [{ type: "text" as const, text: "Stay in Plan Mode. Do not execute the plan." }], details: { plan, decision: "stay" }, terminate: true };
	}

	private headlessProposalResult(plan: PlanDocument, markdown: string) {
		return {
			content: [{ type: "text" as const, text: `${markdown}\n\nPlan ${plan.id} revision ${plan.revision} is awaiting explicit approval. Use /plan approve to execute it.` }],
			details: { plan, decision: "awaiting_approval" },
			terminate: true,
		};
	}

	private registerProgressTool(): void {
		this.pi.registerTool({
			name: "update_plan",
			label: "Update Plan Progress",
			executionMode: "sequential",
			description: "Update structured progress for the currently approved plan. Available only during execution.",
			promptSnippet: "Track approved-plan execution with explicit step states",
			parameters: UpdatePlanSchema,
			execute: async (_id, params: UpdatePlanInput, _signal, _update, ctx) => this.updatePlan(params, ctx),
		});
	}

	private async updatePlan(params: UpdatePlanInput, ctx: ExtensionContext) {
		if (this.state.phase !== "executing" || !this.state.plan) throw new Error("No approved plan is currently executing");
		const updates = params.updates.map((update) => ({ stepId: update.stepId, status: update.status as StepStatus, note: update.note }));
		const plan = applyStepUpdates(this.state.plan, updates);
		const completed = isPlanComplete(plan);
		if (completed) {
			this.restoreNormalTools();
			this.state = { ...this.state, plan, phase: "completed", toolsBeforePlan: undefined };
		} else {
			this.state = { ...this.state, plan, phase: "executing" };
			this.applyToolsForPhase();
		}
		this.persistState();
		this.updateUI(ctx);
		return { content: [{ type: "text" as const, text: completed ? "All plan steps are complete." : "Plan progress updated." }], details: { plan, completed } };
	}

	private registerEvents(): void {
		this.pi.on("tool_call", (event, ctx) => this.handleToolCall(event, ctx));
		this.pi.on("input", (event, ctx) => {
			if (this.state.phase === "awaiting_approval" && event.source !== "extension") {
				this.state = { ...this.state, phase: "planning" };
				this.persistState();
				this.updateUI(ctx);
			}
			return { action: "continue" };
		});
		this.pi.on("before_agent_start", (event) => {
			const prompt = promptForState(this.state);
			return prompt ? { systemPrompt: `${event.systemPrompt}\n\n${prompt}` } : undefined;
		});
		this.pi.on("session_start", async (_event, ctx) => {
			const loaded = await loadConfig(ctx);
			this.config = loaded.config;
			for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
			this.restoreBranchState(ctx, true);
		});
		this.pi.on("session_tree", (_event, ctx) => this.restoreBranchState(ctx, false));
	}

	private async handleToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
		if (isReadOnlyPhase(this.state.phase)) {
			if (isToolCallEventType("bash", event)) {
				if (this.config.tools.bash === "deny" || this.config.shellPolicy === "strict") return { block: true, reason: "Plan Mode: bash is disabled by policy." };
				const decision = classifyBashCommand(event.input.command);
				if (decision.action === "allow" && this.config.tools.bash !== "ask") return;
				if (decision.action === "deny") return { block: true, reason: `Plan Mode: ${decision.reason}.` };
				const allowed = await this.confirmDecision(ctx, "Plan Mode shell command", `${decision.reason}:\n\n${event.input.command}`);
				return allowed ? undefined : { block: true, reason: `Plan Mode: shell command not approved (${decision.reason}).` };
			}
			const decision = classifyTool(event.toolName, this.config);
			if (decision.action === "allow") return;
			if (decision.action === "deny") return { block: true, reason: `Plan Mode: ${decision.reason}.` };
			const allowed = await this.confirmDecision(ctx, "Plan Mode tool permission", `Allow ${event.toolName} once?\n\n${decision.reason}`);
			return allowed ? undefined : { block: true, reason: `Plan Mode: ${event.toolName} was not approved.` };
		}
		if (this.state.phase === "executing" && this.state.executionPolicy === "confirm_mutations") {
			if (event.toolName === "update_plan" || ["read", "grep", "find", "ls"].includes(event.toolName)) return;
			const summary = isToolCallEventType("bash", event) ? event.input.command : JSON.stringify(event.input, null, 2);
			const allowed = await this.confirmDecision(ctx, "Approved plan execution", `Allow ${event.toolName}?\n\n${summary}`);
			if (!allowed) return { block: true, reason: `Execution permission denied for ${event.toolName}.` };
		}
	}

	private async showPlan(ctx: ExtensionContext): Promise<void> {
		if (!this.state.plan) {
			ctx.ui.notify(`Plan Mode phase: ${this.state.phase}; no plan proposal yet.`, "info");
			return;
		}
		const markdown = formatPlanMarkdown(this.state.plan);
		if (ctx.mode === "tui") await ctx.ui.editor(`${this.state.plan.title} (read-only view)`, markdown);
		else ctx.ui.notify(markdown, "info");
	}
}
