import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import type { PlanDocument } from "./types.ts";

const PlanStepInputSchema = Type.Object({
	title: Type.String({ minLength: 3, description: "Short implementation step title" }),
	description: Type.String({ minLength: 5, description: "Decision-complete description of the work" }),
	paths: Type.Optional(Type.Array(Type.String(), { description: "Critical paths, not an exhaustive inventory" })),
	verification: Type.Optional(Type.String({ description: "Step-specific verification" })),
});

export const PlanInputSchema = Type.Object({
	title: Type.String({ minLength: 3 }),
	summary: Type.String({ minLength: 10 }),
	implementation: Type.Array(Type.String(), { minItems: 1, description: "Behavior-level implementation changes" }),
	publicInterfaces: Type.Optional(Type.Array(Type.String(), { description: "Public API, schema, CLI, or type changes" })),
	steps: Type.Array(PlanStepInputSchema, { minItems: 1, maxItems: 20 }),
	tests: Type.Array(Type.String(), { minItems: 1 }),
	assumptions: Type.Optional(Type.Array(Type.String())),
	outOfScope: Type.Optional(Type.Array(Type.String())),
});
export type PlanInput = Static<typeof PlanInputSchema>;

export function planFromInput(input: PlanInput, previous?: PlanDocument): PlanDocument {
	const title = input.title.trim();
	if (!title) throw new Error("Plan title must not be blank");
	const summary = input.summary.trim();
	if (!summary) throw new Error("Plan summary must not be blank");
	const implementation = input.implementation.map((item) => item.trim()).filter(Boolean);
	if (implementation.length === 0) throw new Error("Plan implementation must contain at least one non-blank item");
	const steps = input.steps.map((step, index) => {
		const id = `S${index + 1}`;
		const stepTitle = step.title.trim();
		if (!stepTitle) throw new Error(`Plan step ${id} title must not be blank`);
		const description = step.description.trim();
		if (!description) throw new Error(`Plan step ${id} description must not be blank`);
		return {
			id,
			title: stepTitle,
			description,
			paths: (step.paths ?? []).map((item) => item.trim()).filter(Boolean),
			verification: step.verification?.trim() || undefined,
			status: "pending" as const,
		};
	});
	const tests = input.tests.map((item) => item.trim()).filter(Boolean);
	if (tests.length === 0) throw new Error("Plan verification must contain at least one non-blank item");
	const now = new Date().toISOString();
	return {
		id: previous?.id ?? randomUUID().slice(0, 8),
		revision: (previous?.revision ?? 0) + 1,
		title,
		summary,
		implementation,
		publicInterfaces: (input.publicInterfaces ?? []).map((item) => item.trim()).filter(Boolean),
		steps,
		tests,
		assumptions: (input.assumptions ?? []).map((item) => item.trim()).filter(Boolean),
		outOfScope: (input.outOfScope ?? []).map((item) => item.trim()).filter(Boolean),
		createdAt: previous?.createdAt ?? now,
		updatedAt: now,
	};
}
