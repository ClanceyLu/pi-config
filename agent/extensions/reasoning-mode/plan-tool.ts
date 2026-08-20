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
const LIVE_PREVIEW_MAX_BYTES = 12 * 1024;
const LIVE_PREVIEW_MIN_DELTA_BYTES = 512;

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

interface PlanRenderState {
	planDisplay?: Container;
	previewBytes?: number;
	previewCapped?: boolean;
	argsCompleteRendered?: boolean;
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

function limitLivePreview(plan: string): { text: string; bytes: number; capped: boolean } {
	// Inspect at most twice the byte cap: CRLF normalization can shrink two input
	// characters to one output byte, so this still detects every oversized prefix.
	const source = plan.slice(0, LIVE_PREVIEW_MAX_BYTES * 2 + 2);
	const normalized = source.replace(/\r\n?/g, "\n");
	const encoded = Buffer.from(normalized, "utf8");
	if (source.length === plan.length && encoded.byteLength <= LIVE_PREVIEW_MAX_BYTES) {
		return { text: normalized, bytes: encoded.byteLength, capped: false };
	}

	let end = LIVE_PREVIEW_MAX_BYTES;
	while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
	return {
		text: encoded.subarray(0, end).toString("utf8"),
		bytes: end,
		capped: true,
	};
}

function renderLivePlan(
	preview: { text: string; capped: boolean },
	theme: Theme,
	container?: Container,
): Container {
	const next = container ?? new Container();
	next.clear();
	next.addChild(new Text(theme.fg("toolTitle", theme.bold("Submit Plan")), 0, 0));
	if (preview.text) next.addChild(new Markdown(preview.text, 0, 0, getMarkdownTheme()));
	if (preview.capped) {
		next.addChild(new Text(theme.fg("warning", `Live preview limited to ${LIVE_PREVIEW_MAX_BYTES} bytes.`), 0, 0));
	}
	return next;
}

function renderFinalPlan(details: SubmittedPlanDetails, theme: Theme, container = new Container()): Container {
	container.clear();
	container.addChild(renderPlanTitle(details.version, details.previousVersion, details.changed, theme));
	if (details.diff) {
		container.addChild(new Text(renderDiff(details.diff), 0, 0));
	} else {
		container.addChild(new Markdown(details.plan, 0, 0, getMarkdownTheme()));
	}
	return container;
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

		renderCall(args, theme, context) {
			const state = context.state as PlanRenderState;
			const preview = limitLivePreview(typeof args?.plan === "string" ? args.plan : "");
			const previousBytes = state.previewBytes;
			const shouldRender = !state.planDisplay
				|| (context.argsComplete && !state.argsCompleteRendered)
				|| state.previewCapped !== preview.capped
				|| previousBytes === undefined
				|| Math.abs(preview.bytes - previousBytes) >= LIVE_PREVIEW_MIN_DELTA_BYTES;

			if (shouldRender) {
				state.planDisplay = renderLivePlan(preview, theme, state.planDisplay);
				state.previewBytes = preview.bytes;
				state.previewCapped = preview.capped;
				state.argsCompleteRendered = context.argsComplete;
			}
			return state.planDisplay!;
		},

		renderResult(result, _options, theme, context) {
			const details = result.details;
			if (!isSubmittedPlanDetails(details)) {
				return new Text(textContent(result.content), 0, 0);
			}

			const liveContainer = (context.state as PlanRenderState).planDisplay;
			if (!liveContainer) return renderFinalPlan(details, theme);

			// Replace the streamed call preview in place. Returning an empty result
			// prevents the completed plan from being appended a second time.
			renderFinalPlan(details, theme, liveContainer);
			return new Container();
		},
	});
}
