import assert from "node:assert/strict";
import test from "node:test";
import { migrateLegacyState, migratePreviousState, normalizeState } from "./state.ts";

test("v2 normalization accepts the compact Reasoning Mode state", () => {
	assert.deepEqual(normalizeState(undefined), { version: 2, mode: "off" });
	assert.deepEqual(normalizeState({ mode: "reasoning", activeSkill: " plan ", toolsBeforeReasoning: ["read", "read", 3] }), {
		version: 2,
		mode: "reasoning",
		activeSkill: "plan",
		toolsBeforeReasoning: ["read"],
	});
	assert.deepEqual(normalizeState({ mode: "reasoning", toolsBeforeReasoning: ["read"] }), {
		version: 2,
		mode: "reasoning",
		activeSkill: undefined,
		toolsBeforeReasoning: ["read"],
	});
	assert.deepEqual(normalizeState({ mode: "reasoning", activeSkill: "plan", planReady: true }), {
		version: 2,
		mode: "reasoning",
		activeSkill: "plan",
		planReady: true,
		toolsBeforeReasoning: undefined,
	});
	assert.equal(normalizeState({ mode: "reasoning", activeSkill: "explore", planReady: true }).planReady, undefined);
	assert.deepEqual(normalizeState({ mode: "off", activeSkill: "plan", toolsBeforeReasoning: ["read"] }), {
		version: 2,
		mode: "off",
		activeSkill: undefined,
		toolsBeforeReasoning: undefined,
	});
});

test("v1 neutral Reasoning Mode migrates to the explore skill", () => {
	assert.deepEqual(migratePreviousState({ mode: "reasoning", toolsBeforeReasoning: ["read"] }), {
		version: 2,
		mode: "reasoning",
		activeSkill: "explore",
		toolsBeforeReasoning: ["read"],
	});
	assert.deepEqual(migratePreviousState({ mode: "reasoning", activeSkill: "plan", planReady: true }), {
		version: 2,
		mode: "reasoning",
		activeSkill: "plan",
		toolsBeforeReasoning: undefined,
	});
});

test("legacy planning states migrate but execution and completed states fail closed to off", () => {
	for (const phase of ["planning", "awaiting_approval"]) {
		assert.deepEqual(migrateLegacyState({ phase, toolsBeforePlan: ["read", "edit"] }), {
			version: 2,
			mode: "reasoning",
			activeSkill: "plan",
			toolsBeforeReasoning: ["read", "edit"],
		});
	}
	for (const phase of ["executing", "completed", "off", "bad"]) {
		assert.deepEqual(migrateLegacyState({ phase, toolsBeforePlan: ["read"] }), { version: 2, mode: "off" });
	}
});
