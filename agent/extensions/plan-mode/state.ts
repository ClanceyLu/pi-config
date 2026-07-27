import type { PlanDocument, PlanModeState, StepStatus } from "./types.ts";
import { INITIAL_STATE } from "./types.ts";

const VALID_PHASES = new Set(["off", "planning", "awaiting_approval", "executing", "completed"]);
const VALID_EXECUTION_POLICIES = new Set(["restore", "confirm_mutations"]);
const VALID_STEP_STATUSES = new Set(["pending", "in_progress", "completed", "blocked", "skipped"]);

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function normalizeState(value: unknown): PlanModeState {
	if (!value || typeof value !== "object") return structuredClone(INITIAL_STATE);
	const record = value as Record<string, unknown>;
	const storedPhase = typeof record.phase === "string" && VALID_PHASES.has(record.phase) ? record.phase : "off";
	const executionPolicy =
		typeof record.executionPolicy === "string" && VALID_EXECUTION_POLICIES.has(record.executionPolicy)
			? record.executionPolicy
			: "restore";
	const toolsBeforePlan = Array.isArray(record.toolsBeforePlan)
		? [...new Set(record.toolsBeforePlan.filter((item): item is string => typeof item === "string"))]
		: undefined;
	const plan = normalizePlan(record.plan);

	let phase = storedPhase as PlanModeState["phase"];
	if (!plan) {
		if (phase === "awaiting_approval" || phase === "executing") phase = "planning";
		else if (phase === "completed") phase = "off";
	} else if (phase === "executing" && isPlanComplete(plan)) {
		phase = "completed";
	} else if (phase === "completed" && !isPlanComplete(plan)) {
		phase = "planning";
	}

	return {
		version: 1,
		phase,
		plan,
		toolsBeforePlan: phase === "off" || phase === "completed" ? undefined : toolsBeforePlan,
		executionPolicy: executionPolicy as PlanModeState["executionPolicy"],
	};
}

function normalizePlan(value: unknown): PlanDocument | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.id !== "string" ||
		record.id.length === 0 ||
		typeof record.title !== "string" ||
		!Array.isArray(record.steps) ||
		record.steps.length === 0
	) {
		return undefined;
	}

	const steps: PlanDocument["steps"] = [];
	const stepIds = new Set<string>();
	for (const raw of record.steps) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
		const step = raw as Record<string, unknown>;
		if (
			typeof step.id !== "string" ||
			step.id.length === 0 ||
			stepIds.has(step.id) ||
			typeof step.title !== "string" ||
			typeof step.description !== "string" ||
			!Array.isArray(step.paths) ||
			step.paths.some((item) => typeof item !== "string") ||
			typeof step.status !== "string" ||
			!VALID_STEP_STATUSES.has(step.status) ||
			(step.verification !== undefined && typeof step.verification !== "string") ||
			(step.note !== undefined && typeof step.note !== "string")
		) {
			return undefined;
		}
		stepIds.add(step.id);
		steps.push({
			id: step.id,
			title: step.title,
			description: step.description,
			paths: step.paths as string[],
			verification: step.verification as string | undefined,
			status: step.status as StepStatus,
			note: step.note as string | undefined,
		});
	}

	if (steps.filter((step) => step.status === "in_progress").length > 1) {
		for (const step of steps) {
			if (step.status === "in_progress") step.status = "pending";
		}
	}

	const now = new Date().toISOString();
	return {
		id: record.id,
		revision: typeof record.revision === "number" && record.revision > 0 ? Math.floor(record.revision) : 1,
		title: record.title,
		summary: typeof record.summary === "string" ? record.summary : "",
		implementation: asStringArray(record.implementation),
		publicInterfaces: asStringArray(record.publicInterfaces),
		steps,
		tests: asStringArray(record.tests),
		assumptions: asStringArray(record.assumptions),
		outOfScope: asStringArray(record.outOfScope),
		createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now,
	};
}

export function applyStepUpdates(
	plan: PlanDocument,
	updates: Array<{ stepId: string; status: StepStatus; note?: string }>,
): PlanDocument {
	const next = structuredClone(plan);
	const requestedInProgress = updates.filter((update) => update.status === "in_progress");
	if (requestedInProgress.length > 1) throw new Error("Only one step may be in progress at a time");

	for (const update of updates) {
		const step = next.steps.find((candidate) => candidate.id === update.stepId);
		if (!step) throw new Error(`Unknown plan step: ${update.stepId}`);
		if (update.status === "in_progress") {
			for (const candidate of next.steps) {
				if (candidate.id !== step.id && candidate.status === "in_progress") candidate.status = "pending";
			}
		}
		step.status = update.status;
		step.note = update.note?.trim() || undefined;
	}
	next.updatedAt = new Date().toISOString();
	return next;
}

export function isPlanComplete(plan: PlanDocument): boolean {
	return plan.steps.length > 0 && plan.steps.every((step) => step.status === "completed" || step.status === "skipped");
}

export function formatPlanMarkdown(plan: PlanDocument, includeProgress = true): string {
	const lines = [`# ${plan.title}`, "", plan.summary.trim(), "", `> Plan ${plan.id} · revision ${plan.revision}`];
	if (plan.implementation.length > 0) {
		lines.push("", "## Implementation", ...plan.implementation.map((item) => `- ${item}`));
	}
	if (plan.publicInterfaces.length > 0) {
		lines.push("", "## Public interfaces", ...plan.publicInterfaces.map((item) => `- ${item}`));
	}
	lines.push("", "## Steps");
	for (const step of plan.steps) {
		const marker = includeProgress
			? ({ pending: "○", in_progress: "◉", completed: "✓", blocked: "!", skipped: "−" } as const)[step.status]
			: "-";
		lines.push(`${marker} **${step.id} — ${step.title}**`);
		lines.push(`  ${step.description}`);
		if (step.paths.length > 0) lines.push(`  Paths: ${step.paths.map((path) => `\`${path}\``).join(", ")}`);
		if (step.verification) lines.push(`  Verify: ${step.verification}`);
		if (step.note) lines.push(`  Note: ${step.note}`);
	}
	if (plan.tests.length > 0) lines.push("", "## Verification", ...plan.tests.map((item) => `- ${item}`));
	if (plan.assumptions.length > 0) lines.push("", "## Assumptions", ...plan.assumptions.map((item) => `- ${item}`));
	if (plan.outOfScope.length > 0) lines.push("", "## Out of scope", ...plan.outOfScope.map((item) => `- ${item}`));
	return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
