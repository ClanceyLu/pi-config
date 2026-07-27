import assert from "node:assert/strict";
import test from "node:test";
import { migrateLegacyState, normalizeState } from "./state.ts";

test("normalization accepts only the compact Reasoning Mode state", () => {
	assert.deepEqual(normalizeState(undefined), { version: 1, mode: "off" });
	assert.deepEqual(normalizeState({ mode: "reasoning", activeSkill: " plan ", toolsBeforeReasoning: ["read", "read", 3] }), {
		version: 1,
		mode: "reasoning",
		activeSkill: "plan",
		toolsBeforeReasoning: ["read"],
	});
	assert.deepEqual(normalizeState({ mode: "off", activeSkill: "plan", toolsBeforeReasoning: ["read"] }), {
		version: 1,
		mode: "off",
		activeSkill: undefined,
		toolsBeforeReasoning: undefined,
	});
});

test("legacy planning states migrate but execution and completed states fail closed to off", () => {
	for (const phase of ["planning", "awaiting_approval"]) {
		assert.deepEqual(migrateLegacyState({ phase, toolsBeforePlan: ["read", "edit"] }), {
			version: 1,
			mode: "reasoning",
			activeSkill: "plan",
			toolsBeforeReasoning: ["read", "edit"],
		});
	}
	for (const phase of ["executing", "completed", "off", "bad"]) {
		assert.deepEqual(migrateLegacyState({ phase, toolsBeforePlan: ["read"] }), { version: 1, mode: "off" });
	}
});
