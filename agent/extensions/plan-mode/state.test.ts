import assert from "node:assert/strict";
import test from "node:test";
import { applyStepUpdates, formatPlanMarkdown, isPlanComplete, normalizeState } from "./state.ts";
import type { PlanDocument } from "./types.ts";

function plan(): PlanDocument {
	return {
		id: "plan-1",
		revision: 1,
		title: "Add Plan Mode",
		summary: "Implement safe planning and approval.",
		implementation: ["Add an explicit state machine"],
		publicInterfaces: ["Expose /plan"],
		steps: [
			{ id: "S1", title: "State", description: "Implement state", paths: ["state.ts"], status: "pending" },
			{ id: "S2", title: "Policy", description: "Implement policy", paths: ["policy.ts"], status: "pending" },
		],
		tests: ["Run unit tests"],
		assumptions: [],
		outOfScope: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

test("normalization rejects malformed plans and restores safe defaults", () => {
	assert.deepEqual(normalizeState(undefined), {
		version: 1,
		phase: "off",
		executionPolicy: "restore",
	});
	const state = normalizeState({ phase: "planning", executionPolicy: "bad", plan: { title: "missing id" } });
	assert.equal(state.phase, "planning");
	assert.equal(state.executionPolicy, "restore");
	assert.equal(state.plan, undefined);
});

test("step updates maintain at most one in-progress step", () => {
	const first = applyStepUpdates(plan(), [{ stepId: "S1", status: "in_progress" }]);
	const second = applyStepUpdates(first, [{ stepId: "S2", status: "in_progress" }]);
	assert.equal(second.steps[0]?.status, "pending");
	assert.equal(second.steps[1]?.status, "in_progress");
	assert.throws(
		() =>
			applyStepUpdates(plan(), [
				{ stepId: "S1", status: "in_progress" },
				{ stepId: "S2", status: "in_progress" },
			]),
		/Only one step/,
	);
});

test("completion requires every step to be completed or skipped", () => {
	const partial = applyStepUpdates(plan(), [{ stepId: "S1", status: "completed" }]);
	assert.equal(isPlanComplete(partial), false);
	const complete = applyStepUpdates(partial, [{ stepId: "S2", status: "skipped", note: "Not needed" }]);
	assert.equal(isPlanComplete(complete), true);
});

test("markdown contains stable step IDs and verification sections", () => {
	const markdown = formatPlanMarkdown(plan());
	assert.match(markdown, /# Add Plan Mode/);
	assert.match(markdown, /S1 — State/);
	assert.match(markdown, /## Verification/);
	assert.match(markdown, /Expose \/plan/);
});

test("normalization rejects an entire malformed, empty, or duplicate-step plan", () => {
	const valid = plan();
	for (const brokenPlan of [
		{ ...valid, steps: [] },
		{ ...valid, steps: [valid.steps[0], null] },
		{ ...valid, steps: [valid.steps[0], { ...valid.steps[1], id: "S1" }] },
		{ ...valid, steps: [valid.steps[0], { ...valid.steps[1], status: "unknown" }] },
	]) {
		const state = normalizeState({ phase: "awaiting_approval", plan: brokenPlan, toolsBeforePlan: ["read"] });
		assert.equal(state.plan, undefined);
		assert.equal(state.phase, "planning");
	}
});

test("normalization resets every conflicting in-progress step", () => {
	const valid = plan();
	valid.steps[0]!.status = "in_progress";
	valid.steps[1]!.status = "in_progress";
	const state = normalizeState({ phase: "executing", plan: valid, toolsBeforePlan: ["read"] });
	assert.deepEqual(state.plan?.steps.map((step) => step.status), ["pending", "pending"]);
	assert.equal(state.phase, "executing");
});

test("phase invariants never restore execution from contradictory state", () => {
	const incomplete = plan();
	assert.equal(normalizeState({ phase: "executing" }).phase, "planning");
	assert.equal(normalizeState({ phase: "awaiting_approval" }).phase, "planning");
	assert.equal(normalizeState({ phase: "completed" }).phase, "off");
	assert.equal(normalizeState({ phase: "completed", plan: incomplete, toolsBeforePlan: ["read"] }).phase, "planning");

	const complete = applyStepUpdates(incomplete, [
		{ stepId: "S1", status: "completed" },
		{ stepId: "S2", status: "skipped" },
	]);
	const completed = normalizeState({ phase: "executing", plan: complete, toolsBeforePlan: ["read"] });
	assert.equal(completed.phase, "completed");
	assert.equal(completed.toolsBeforePlan, undefined);

	const off = normalizeState({ phase: "off", plan: complete, toolsBeforePlan: ["read"] });
	assert.equal(off.phase, "off");
	assert.equal(off.plan?.id, complete.id);
	assert.equal(off.toolsBeforePlan, undefined);
});
