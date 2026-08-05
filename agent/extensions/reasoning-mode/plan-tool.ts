import {
	DEFAULT_MAX_BYTES,
	generateDiffString,
	getMarkdownTheme,
	renderDiff,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PLAN_READY_MARKER, PLAN_SUBMIT_TOOL_NAME } from "./types.ts";
const FULL_DIFF_CONTEXT = Number.MAX_SAFE_INTEGER;

export interface SubmittedPlanDetails {
	kind: "reasoning-plan";
	version: number;
	previousVersion?: number;
	plan: string;
	diff?: string;
	changed: boolean;
}

interface PreviousPlan {
	plan: string;
	version: number;
}

interface PlanToolServices {
	canSubmit(ctx: ExtensionContext): boolean;
	onSubmitted(): void;
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => Boolean(
			part
			&& typeof part === "object"
			&& "type" in part
			&& part.type === "text"
			&& "text" in part
			&& typeof part.text === "string",
		))
		.map((part) => part.text)
		.join("\n");
}

function normalizePlan(plan: string): string {
	return plan.replace(/\r\n?/g, "\n").trim();
}

function isSubmittedPlanDetails(value: unknown): value is SubmittedPlanDetails {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.kind === "reasoning-plan"
		&& Number.isInteger(record.version)
		&& (record.version as number) > 0
		&& (record.previousVersion === undefined
			|| (Number.isInteger(record.previousVersion) && (record.previousVersion as number) > 0))
		&& typeof record.plan === "string"
		&& (record.diff === undefined || typeof record.diff === "string")
		&& typeof record.changed === "boolean";
}

function legacyCompletedPlan(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return;
	const record = message as { role?: unknown; content?: unknown };
	if (record.role !== "assistant") return;
	const text = textContent(record.content).trimEnd();
	const lines = text.split(/\r?\n/);
	if (lines.at(-1)?.trim() !== PLAN_READY_MARKER) return;
	const plan = normalizePlan(lines.slice(0, -1).join("\n"));
	return /^# Plan:/m.test(plan) ? plan : undefined;
}

export function findPreviousPlan(entries: readonly unknown[]): PreviousPlan | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry || typeof entry !== "object") continue;
		const record = entry as { type?: unknown; message?: unknown };
		if (record.type !== "message" || !record.message || typeof record.message !== "object") continue;
		const message = record.message as { role?: unknown; toolName?: unknown; details?: unknown };
		if (message.role === "toolResult"
			&& message.toolName === PLAN_SUBMIT_TOOL_NAME
			&& isSubmittedPlanDetails(message.details)) {
			return { plan: message.details.plan, version: message.details.version };
		}
		const legacy = legacyCompletedPlan(message);
		if (legacy) return { plan: legacy, version: 1 };
	}
	return;
}

function renderPlanTitle(version: number, previousVersion: number | undefined, changed: boolean, theme: Theme): Text {
	const comparison = previousVersion === undefined
		? "initial"
		: changed ? `compared with v${previousVersion}` : `unchanged from v${previousVersion}`;
	return new Text(theme.fg("accent", theme.bold(`Plan v${version} · ${comparison}`)), 0, 0);
}

export function registerPlanTool(pi: ExtensionAPI, services: PlanToolServices): void {
	pi.registerTool({
		name: PLAN_SUBMIT_TOOL_NAME,
		label: "Submit Plan",
		description: "Submit one complete, decision-ready implementation plan for Git-diff-style TUI rendering. Use only when the active plan workflow has no unresolved material questions. Always submit the full current plan, never a partial update or a diff.",
		parameters: Type.Object({
			plan: Type.String({ description: "The complete current plan as Markdown, beginning with '# Plan:' and excluding the readiness marker" }),
		}),
		renderShell: "self",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!services.canSubmit(ctx)) {
				throw new Error("submit_plan is available only in TUI Reasoning Mode with the plan skill active.");
			}
			const plan = normalizePlan(params.plan);
			if (!plan.startsWith("# Plan:")) {
				throw new Error("The submitted plan must be complete Markdown beginning with '# Plan:'.");
			}
			if (Buffer.byteLength(plan, "utf8") > DEFAULT_MAX_BYTES) {
				throw new Error(`The submitted plan exceeds the ${DEFAULT_MAX_BYTES}-byte tool output limit. Reduce the plan before submitting it.`);
			}

			const previous = findPreviousPlan(ctx.sessionManager.getBranch());
			const changed = previous ? previous.plan !== plan : false;
			const version = (previous?.version ?? 0) + 1;
			const diff = previous && changed
				? generateDiffString(previous.plan, plan, FULL_DIFF_CONTEXT).diff
				: undefined;
			const details: SubmittedPlanDetails = {
				kind: "reasoning-plan",
				version,
				previousVersion: previous?.version,
				plan,
				diff,
				changed,
			};
			services.onSubmitted();
			return { content: [{ type: "text" as const, text: plan }], details };
		},

		renderCall(_args, theme, context) {
			const text = context.lastComponent as Text | undefined ?? new Text("", 0, 0);
			text.setText(theme.fg("toolTitle", theme.bold("Submit Plan")));
			return text;
		},

		renderResult(result, _options, theme) {
			const details = result.details;
			if (!isSubmittedPlanDetails(details)) {
				return new Text(textContent(result.content), 0, 0);
			}
			const container = new Container();
			container.addChild(renderPlanTitle(details.version, details.previousVersion, details.changed, theme));
			if (details.diff) {
				container.addChild(new Text(renderDiff(details.diff), 0, 0));
			} else {
				container.addChild(new Markdown(details.plan, 0, 0, getMarkdownTheme()));
			}
			return container;
		},
	});
}
