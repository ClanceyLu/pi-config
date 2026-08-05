import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { registerReasoningCommands } from "./commands.ts";
import { loadConfig } from "./config.ts";
import { registerPlanTool } from "./plan-tool.ts";
import { classifyBashCommand, classifyTool, reasoningToolSet } from "./policy.ts";
import { reasoningModePrompt } from "./prompt.ts";
import {
	formatReasoningSkill,
	resolveReasoningSkill,
	resolveReasoningSkillFromCommands,
} from "./skill-activation.ts";
import {
	LEGACY_STATE_ENTRY_TYPE,
	migrateLegacyState,
	migratePreviousState,
	normalizeState,
	PREVIOUS_STATE_ENTRY_TYPE,
	STATE_ENTRY_TYPE,
} from "./state.ts";
import {
	DEFAULT_CONFIG,
	DEFAULT_REASONING_SKILL,
	INITIAL_STATE,
	PLAN_READY_MARKER,
	PLAN_SUBMIT_TOOL_NAME,
	type ReasoningModeConfig,
	type ReasoningModeState,
} from "./types.ts";

const STATUS_KEY = "reasoning-mode";
const EXIT_TRANSITION_MESSAGE = `<reasoning_mode_transition status="off">
Reasoning Mode was explicitly disabled. Instructions from the former Reasoning Mode and its active skill no longer apply. Follow the base system prompt and the user's current request using the restored tool set; implementation is permitted when requested.
</reasoning_mode_transition>`;

function isCompletedPlanMessage(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const record = message as { role?: unknown; content?: unknown };
	if (record.role !== "assistant") return false;
	const text = typeof record.content === "string"
		? record.content
		: Array.isArray(record.content)
			? record.content
				.filter((part): part is { type: "text"; text: string } => Boolean(
					part
					&& typeof part === "object"
					&& "type" in part
					&& part.type === "text"
					&& "text" in part
					&& typeof part.text === "string",
				))
				.map((part) => part.text)
				.join("\n")
			: "";
	return text.trimEnd().split(/\r?\n/).at(-1)?.trim() === PLAN_READY_MARKER;
}

export class ReasoningModeRuntime {
	private state: ReasoningModeState = structuredClone(INITIAL_STATE);
	private config: ReasoningModeConfig = structuredClone(DEFAULT_CONFIG);
	private planSubmittedThisRun = false;
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	register(): void {
		this.pi.registerFlag("reasoning", { description: "Start in read-only Reasoning Mode", type: "boolean", default: false });
		this.pi.registerFlag("plan", { description: "Start Reasoning Mode with the plan skill", type: "boolean", default: false });
		registerPlanTool(this.pi, {
			canSubmit: (ctx) => this.state.mode === "reasoning" && this.state.activeSkill === "plan" && ctx.mode === "tui",
			onSubmitted: () => { this.planSubmittedThisRun = true; },
		});
		registerReasoningCommands(this.pi, {
			getState: () => this.state,
			getConfig: () => this.config,
			leave: (ctx) => this.leave(ctx),
			activateSkill: (ctx, name) => this.activateSkill(ctx, name),
		});
		this.registerEvents();
	}

	private persistState(): void {
		this.pi.appendEntry(STATE_ENTRY_TYPE, structuredClone(this.state));
	}

	private setPlanReady(ready: boolean): void {
		if (this.state.mode !== "reasoning" || this.state.activeSkill !== "plan") return;
		const currentlyReady = this.state.planReady === true;
		if (currentlyReady === ready) return;
		const next = structuredClone(this.state);
		if (ready) next.planReady = true;
		else delete next.planReady;
		this.state = next;
		this.persistState();
	}

	private allToolNames(): string[] {
		return this.pi.getAllTools().map((tool) => tool.name);
	}

	private withoutInternalTools(tools: string[]): string[] {
		return tools.filter((name) => name !== PLAN_SUBMIT_TOOL_NAME);
	}

	private applyReasoningTools(ctx: ExtensionContext): void {
		const snapshot = this.withoutInternalTools(this.state.toolsBeforeReasoning ?? this.pi.getActiveTools());
		this.pi.setActiveTools(reasoningToolSet(snapshot, this.allToolNames(), this.config, ctx.mode, this.state.activeSkill));
	}

	private enter(ctx: ExtensionContext, activeSkill?: string): void {
		const snapshot = this.withoutInternalTools(this.state.mode === "reasoning" && this.state.toolsBeforeReasoning
			? this.state.toolsBeforeReasoning
			: this.pi.getActiveTools());
		this.planSubmittedThisRun = false;
		this.state = { version: 2, mode: "reasoning", activeSkill, toolsBeforeReasoning: snapshot };
		this.applyReasoningTools(ctx);
		this.persistState();
		this.updateUI(ctx);
		ctx.ui.notify(activeSkill ? `Reasoning Mode enabled with skill: ${activeSkill}.` : "Reasoning Mode enabled.", "info");
	}

	private leave(ctx: ExtensionContext): void {
		if (this.state.mode === "off") {
			ctx.ui.notify("Reasoning Mode is already off.", "info");
			return;
		}
		this.pi.setActiveTools(this.withoutInternalTools(this.state.toolsBeforeReasoning ?? this.pi.getActiveTools()));
		this.planSubmittedThisRun = false;
		this.state = structuredClone(INITIAL_STATE);
		this.persistState();
		this.updateUI(ctx);
		this.pi.sendMessage({
			customType: "reasoning-mode-transition",
			content: EXIT_TRANSITION_MESSAGE,
			display: false,
		});
		ctx.ui.notify("Reasoning Mode disabled; previous tools restored.", "info");
	}

	private async activateSkill(ctx: ExtensionContext, name: string): Promise<boolean> {
		try {
			const skill = await resolveReasoningSkillFromCommands(this.pi, name);
			if (!skill) {
				ctx.ui.notify(`Skill \"${name}\" is unavailable or is not marked for Reasoning Mode.`, "error");
				return false;
			}
			this.enter(ctx, name);
			return true;
		} catch (error) {
			ctx.ui.notify(`Failed to load reasoning skill \"${name}\": ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
	}

	private async validateActiveSkillAvailability(ctx: ExtensionContext): Promise<void> {
		const name = this.state.activeSkill;
		if (!name) return;
		try {
			const skill = await resolveReasoningSkillFromCommands(this.pi, name);
			if (skill) return;
			this.invalidateActiveSkill(ctx, `Active reasoning skill \"${name}\" is unavailable or is not marked for Reasoning Mode.`);
		} catch (error) {
			this.invalidateActiveSkill(
				ctx,
				`Failed to load active reasoning skill \"${name}\": ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private updateUI(ctx: ExtensionContext): void {
		if (this.state.mode === "off") {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const text = this.state.activeSkill ? `REASON · ${this.state.activeSkill}` : "REASON";
		ctx.ui.setStatus(STATUS_KEY, ctx.mode === "tui" ? ctx.ui.theme.fg("warning", text) : text);
	}

	private async restoreBranchState(ctx: ExtensionContext, honorFlags: boolean): Promise<void> {
		const baseline = this.withoutInternalTools(this.state.toolsBeforeReasoning ?? this.pi.getActiveTools());
		this.planSubmittedThisRun = false;
		const branch = ctx.sessionManager.getBranch();
		const saved = [...branch].reverse().find(
			(entry) => entry.type === "custom"
				&& (entry.customType === STATE_ENTRY_TYPE || entry.customType === PREVIOUS_STATE_ENTRY_TYPE),
		) as { customType?: string; data?: unknown } | undefined;
		const previous = saved?.customType === PREVIOUS_STATE_ENTRY_TYPE;
		const legacy = saved ? undefined : [...branch].reverse().find(
			(entry) => entry.type === "custom" && entry.customType === LEGACY_STATE_ENTRY_TYPE,
		) as { data?: unknown } | undefined;
		this.state = saved
			? previous ? migratePreviousState(saved.data) : normalizeState(saved.data)
			: migrateLegacyState(legacy?.data);
		if (legacy && honorFlags) {
			const phase = legacy.data && typeof legacy.data === "object" ? (legacy.data as { phase?: unknown }).phase : undefined;
			ctx.ui.notify(
				phase === "planning" || phase === "awaiting_approval"
					? "Legacy Plan Mode restored as read-only Reasoning Mode; approval and execution tracking were removed."
					: "Legacy Plan execution was not resumed; Reasoning Mode is off.",
				"warning",
			);
		}
		let shouldPersist = Boolean(honorFlags && (legacy || previous));
		if (this.state.mode === "reasoning") {
			const restoredTools = this.withoutInternalTools(this.state.toolsBeforeReasoning ?? baseline);
			if (!this.state.toolsBeforeReasoning || restoredTools.length !== this.state.toolsBeforeReasoning.length) {
				this.state = { ...this.state, toolsBeforeReasoning: restoredTools };
				shouldPersist = shouldPersist || honorFlags;
			}
		}
		if (honorFlags && this.pi.getFlag("plan") === true) {
			this.state = { version: 2, mode: "reasoning", activeSkill: "plan", toolsBeforeReasoning: this.state.toolsBeforeReasoning ?? baseline };
			shouldPersist = true;
		}
		if (this.state.mode === "reasoning") this.applyReasoningTools(ctx);
		else {
			this.pi.setActiveTools(baseline);
			this.state = structuredClone(INITIAL_STATE);
		}
		if (shouldPersist) this.persistState();
		this.updateUI(ctx);

		if (honorFlags
			&& this.pi.getFlag("plan") !== true
			&& this.pi.getFlag("reasoning") === true) {
			await this.activateSkill(ctx, DEFAULT_REASONING_SKILL);
		}
	}

	private invalidateActiveSkill(ctx: ExtensionContext, reason: string): string {
		const name = this.state.activeSkill;
		if (!name) return reason;
		this.state = { ...this.state, activeSkill: undefined };
		this.planSubmittedThisRun = false;
		this.applyReasoningTools(ctx);
		this.persistState();
		this.updateUI(ctx);
		ctx.ui.notify(reason, "error");
		return `<reasoning_skill_error>\nThe requested reasoning skill \"${name}\" could not be loaded. Do not continue or approximate that workflow. Explain that the skill is unavailable and ask the user to restore it or choose another explicit mode.\n</reasoning_skill_error>`;
	}

	private async skillPrompt(
		options: BuildSystemPromptOptions,
		ctx: ExtensionContext,
	): Promise<{ content?: string; failure?: string }> {
		const name = this.state.activeSkill;
		if (!name) return {};
		try {
			const skill = await resolveReasoningSkill(options, name);
			if (skill) return { content: formatReasoningSkill(skill) };
			return { failure: this.invalidateActiveSkill(ctx, `Active reasoning skill \"${name}\" is no longer available.`) };
		} catch (error) {
			const message = `Failed to load active reasoning skill \"${name}\": ${error instanceof Error ? error.message : String(error)}`;
			return { failure: this.invalidateActiveSkill(ctx, message) };
		}
	}

	private async handleToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
		if (this.state.mode !== "reasoning") return;
		if (event.toolName === PLAN_SUBMIT_TOOL_NAME
			&& (this.state.activeSkill !== "plan" || ctx.mode !== "tui")) {
			return { block: true, reason: "Reasoning Mode: submit_plan is available only in the TUI plan workflow." };
		}
		if (event.toolName === "questionnaire" && ctx.mode !== "tui") {
			return { block: true, reason: "Reasoning Mode: questionnaire is available only in TUI mode." };
		}
		if (isToolCallEventType("bash", event)) {
			if (this.config.tools.bash === "deny" || this.config.shellPolicy === "strict") {
				return { block: true, reason: "Reasoning Mode: bash is disabled by policy." };
			}
			const decision = classifyBashCommand(event.input.command);
			if (decision.action === "allow" && this.config.tools.bash !== "ask") return;
			if (decision.action === "deny") return { block: true, reason: `Reasoning Mode: ${decision.reason}.` };
			const allowed = ctx.hasUI && await ctx.ui.confirm("Reasoning Mode shell command", `${decision.reason}:\n\n${event.input.command}`);
			return allowed ? undefined : { block: true, reason: `Reasoning Mode: shell command not approved (${decision.reason}).` };
		}
		const decision = classifyTool(event.toolName, this.config);
		if (decision.action === "allow") return;
		if (decision.action === "deny") return { block: true, reason: `Reasoning Mode: ${decision.reason}.` };
		const allowed = ctx.hasUI && await ctx.ui.confirm("Reasoning Mode tool permission", `Allow ${event.toolName} once?\n\n${decision.reason}`);
		return allowed ? undefined : { block: true, reason: `Reasoning Mode: ${event.toolName} was not approved.` };
	}

	private registerEvents(): void {
		this.pi.on("input", async (event, ctx) => {
			const match = event.text.match(/^\/skill:([a-z0-9-]+)(?:\s+([\s\S]*))?$/);
			if (!match) return { action: "continue" };
			const name = match[1]!;
			try {
				const skill = await resolveReasoningSkillFromCommands(this.pi, name);
				if (!skill) return { action: "continue" };
				if (!ctx.isIdle()) {
					ctx.ui.notify("Wait for the current turn to settle before changing Reasoning Mode.", "warning");
					return { action: "handled" };
				}
				this.enter(ctx, name);
				return {
					action: "transform",
					text: match[2]?.trim() || `Use the active ${name} skill. Ask what the user wants to analyze if the task is not yet clear.`,
				};
			} catch (error) {
				const message = `Failed to load reasoning skill \"${name}\": ${error instanceof Error ? error.message : String(error)}`;
				if (this.state.activeSkill === name) this.invalidateActiveSkill(ctx, message);
				else ctx.ui.notify(message, "error");
				return { action: "handled" };
			}
		});
		this.pi.on("before_agent_start", async (event, ctx) => {
			if (this.state.mode !== "reasoning") return;
			if (this.state.activeSkill === "plan") {
				this.planSubmittedThisRun = false;
				if (this.state.planReady === true) this.setPlanReady(false);
			}
			const skill = await this.skillPrompt(event.systemPromptOptions, ctx);
			const additions = [reasoningModePrompt(this.state.activeSkill), skill.content, skill.failure].filter(Boolean).join("\n\n");
			return { systemPrompt: `${event.systemPrompt}\n\n${additions}` };
		});
		this.pi.on("message_end", (event, ctx) => {
			const planToolRequired = ctx.mode === "tui" && this.pi.getActiveTools().includes(PLAN_SUBMIT_TOOL_NAME);
			if (this.state.mode === "reasoning"
				&& this.state.activeSkill === "plan"
				&& isCompletedPlanMessage(event.message)
				&& (!planToolRequired || this.planSubmittedThisRun)) {
				this.setPlanReady(true);
			}
		});
		this.pi.on("tool_call", (event, ctx) => this.handleToolCall(event, ctx));
		this.pi.on("session_start", async (_event, ctx) => {
			const loaded = await loadConfig(ctx);
			this.config = loaded.config;
			for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
			await this.restoreBranchState(ctx, true);
			await this.validateActiveSkillAvailability(ctx);
		});
		this.pi.on("session_tree", async (_event, ctx) => {
			await this.restoreBranchState(ctx, false);
			await this.validateActiveSkillAvailability(ctx);
		});
	}
}
