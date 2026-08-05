import assert from "node:assert/strict";
import test from "node:test";
import { harness, legacyStateEntry, previousStateEntry, stateEntry } from "./test-harness.ts";
import { PLAN_READY_MARKER } from "./types.ts";

test("default Reasoning Mode activates explore, enables inspection tools, and restores the exact snapshot", async (t) => {
	const original = ["read", "bash", "edit", "write", "external"];
	const h = await harness(t, { activeTools: original });
	await h.start();
	await h.command("reasoning", "on");
	assert.deepEqual(h.activeTools(), ["read", "bash", "grep", "find", "ls", "questionnaire"]);
	assert.equal(h.latestState()?.mode, "reasoning");
	assert.equal(h.latestState()?.activeSkill, "explore");
	assert.equal(h.store.statuses.get("reasoning-mode"), "REASON · explore");
	const prompt = await h.beforeAgent();
	assert.match(prompt.systemPrompt, /EXPLORE_SKILL_BODY/);
	assert.doesNotMatch(prompt.systemPrompt, /PLAN_SKILL_BODY/);

	await h.command("reasoning", "off");
	assert.deepEqual(h.activeTools(), original);
	assert.equal(h.latestState()?.mode, "off");
	assert.equal(h.store.statuses.get("reasoning-mode"), undefined);
});

test("leaving Reasoning Mode removes the prompt and records an explicit model-facing transition", async (t) => {
	const h = await harness(t);
	await h.start();
	await h.command("plan", "design memory");
	assert.match((await h.beforeAgent()).systemPrompt, /<reasoning_mode>/);

	await h.command("reasoning", "off");
	assert.equal(await h.beforeAgent(), undefined);
	assert.equal(h.store.customMessages.length, 1);
	assert.equal(h.store.customMessages[0]?.customType, "reasoning-mode-transition");
	assert.equal(h.store.customMessages[0]?.display, false);
	assert.match(h.store.customMessages[0]?.content ?? "", /Reasoning Mode was explicitly disabled/);
	assert.match(h.store.customMessages[0]?.content ?? "", /former Reasoning Mode and its active skill no longer apply/);

	await h.command("reasoning", "off");
	assert.equal(h.store.customMessages.length, 1);
});

test("bare /reasoning activates explore and missing explore leaves the current state unchanged", async (t) => {
	const available = await harness(t);
	await available.start();
	await available.command("reasoning");
	assert.equal(available.latestState()?.activeSkill, "explore");

	const missing = await harness(t, { exploreSkillEnabled: false });
	await missing.start();
	const before = missing.activeTools();
	await missing.command("reasoning", "on");
	assert.deepEqual(missing.activeTools(), before);
	assert.equal(missing.latestState(), undefined);
	assert.match(missing.store.notifications.at(-1)?.message ?? "", /Skill "explore" is unavailable/);

	const missingFlag = await harness(t, { reasoningFlag: true, exploreSkillEnabled: false });
	await missingFlag.start();
	assert.equal(missingFlag.latestState(), undefined);
	assert.equal(missingFlag.store.statuses.get("reasoning-mode"), undefined);
	assert.match(missingFlag.store.notifications.at(-1)?.message ?? "", /Skill "explore" is unavailable/);
});

test("/plan and /reasoning plan activate the same skill without a Plan workflow", async (t) => {
	const h = await harness(t);
	await h.start();
	await h.command("plan", "design memory");
	assert.equal(h.latestState()?.activeSkill, "plan");
	assert.deepEqual(h.store.userMessages, ["design memory"]);
	assert.equal(h.activeTools().includes("edit"), false);
	assert.equal(h.activeTools().includes("write"), false);
	assert.equal(h.activeTools().includes("submit_plan"), true);
	assert.equal(h.store.statuses.get("reasoning-mode"), "REASON · plan");

	await h.command("reasoning", "plan redesign cache");
	assert.deepEqual(h.store.userMessages, ["design memory", "redesign cache"]);
	assert.equal(h.latestState()?.activeSkill, "plan");

	await h.command("reasoning", "on");
	assert.equal(h.latestState()?.activeSkill, "explore");
	const prompt = await h.beforeAgent();
	assert.match(prompt.systemPrompt, /EXPLORE_SKILL_BODY/);
	assert.doesNotMatch(prompt.systemPrompt, /PLAN_SKILL_BODY/);
});

test("/plan approve leaves Reasoning Mode, restores tools, and starts plan execution", async (t) => {
	const original = ["read", "bash", "edit", "write", "external"];
	const h = await harness(t, { activeTools: original });
	await h.start();
	await h.command("plan", "design memory");
	assert.equal(h.latestState()?.activeSkill, "plan");
	await h.beforeAgent();
	await h.executeTool("submit_plan", { plan: "# Plan: Memory\n\n## Implementation steps\n1. Implement it." });
	await h.assistantMessage(`Plan submitted.\n\n${PLAN_READY_MARKER}`);
	assert.equal(h.latestState()?.planReady, true);

	await h.command("plan", "approve");
	assert.equal(h.latestState()?.mode, "off");
	assert.deepEqual(h.activeTools(), original);
	assert.equal(h.store.statuses.get("reasoning-mode"), undefined);
	assert.equal(await h.beforeAgent(), undefined);
	assert.deepEqual(h.store.customMessages.map((message) => message.customType), [
		"reasoning-mode-transition",
		"plan-approved",
	]);
	assert.equal(h.store.customMessages[0]?.display, false);
	assert.equal(h.store.customMessages[1]?.display, true);
	assert.deepEqual(h.store.customMessages[1]?.options, { deliverAs: "followUp", triggerTurn: true });
	assert.match(h.store.customMessages[1]?.content ?? "", /most recent complete implementation plan/);
	assert.match(h.store.customMessages[1]?.content ?? "", /Execute it now using the restored tools/);
});

test("/plan approve keeps incomplete or revised plans in read-only Reasoning Mode", async (t) => {
	const h = await harness(t);
	await h.start();
	await h.command("plan", "design memory");
	await h.assistantMessage(`Plan submitted without the required tool.\n\n${PLAN_READY_MARKER}`);

	await h.command("plan", "approve");
	assert.equal(h.latestState()?.mode, "reasoning");
	assert.equal(h.latestState()?.activeSkill, "plan");
	assert.equal(h.latestState()?.planReady, undefined);
	assert.equal(h.activeTools().includes("edit"), false);
	assert.equal(h.activeTools().includes("write"), false);
	assert.equal(h.store.customMessages.length, 0);
	assert.match(h.store.notifications.at(-1)?.message ?? "", /plan is not complete yet/);

	await h.executeTool("submit_plan", { plan: "# Plan: Memory\n\n## Implementation steps\n1. Implement it." });
	await h.assistantMessage(`Plan submitted.\n\n${PLAN_READY_MARKER}`);
	assert.equal(h.latestState()?.planReady, true);
	assert.deepEqual(await h.input("Revise the storage choice"), { action: "continue" });
	await h.beforeAgent();
	assert.equal(h.latestState()?.planReady, undefined);

	await h.command("plan", "approve");
	assert.equal(h.latestState()?.mode, "reasoning");
	assert.equal(h.activeTools().includes("edit"), false);
	assert.equal(h.store.customMessages.length, 0);
	assert.match(h.store.notifications.at(-1)?.message ?? "", /plan is not complete yet/);
});

test("/plan approve is rejected outside the active plan workflow", async (t) => {
	const h = await harness(t);
	await h.start();
	const original = h.activeTools();
	await h.command("plan", "approve");
	assert.deepEqual(h.activeTools(), original);
	assert.equal(h.latestState(), undefined);
	assert.match(h.store.notifications.at(-1)?.message ?? "", /No active plan workflow/);

	await h.command("reasoning", "on");
	const reasoningState = h.latestState();
	await h.command("plan", "approve");
	assert.deepEqual(h.latestState(), reasoningState);
	assert.equal(h.latestState()?.activeSkill, "explore");
	assert.equal(h.store.customMessages.length, 0);
});

test("direct /skill:plan input enters Reasoning Mode and avoids duplicate native expansion", async (t) => {
	const h = await harness(t);
	await h.start();
	const result = await h.input("/skill:plan investigate auth");
	assert.deepEqual(result, { action: "transform", text: "investigate auth" });
	assert.equal(h.latestState()?.activeSkill, "plan");
	const prompt = await h.beforeAgent();
	assert.match(prompt.systemPrompt, /<reasoning_mode>/);
	assert.match(prompt.systemPrompt, /PLAN_SKILL_BODY/);
	assert.doesNotMatch(prompt.systemPrompt, /disable-model-invocation/);
});

test("unmarked or missing skills are not activated and command failure is atomic", async (t) => {
	const h = await harness(t);
	await h.start();
	h.setSkillEnabled(false);
	const before = h.activeTools();
	await h.command("plan", "task");
	assert.deepEqual(h.activeTools(), before);
	assert.equal(h.latestState(), undefined);
	assert.match(h.store.notifications.at(-1)?.message ?? "", /unavailable or is not marked/);
	assert.deepEqual(await h.input("/skill:plan task"), { action: "continue" });
});

test("skill interception fails closed when a discovered skill becomes unreadable", async (t) => {
	const h = await harness(t);
	await h.start();
	const before = h.activeTools();
	await h.removeSkillFile();
	assert.deepEqual(await h.input("/skill:plan task"), { action: "handled" });
	assert.deepEqual(h.activeTools(), before);
	assert.equal(h.latestState(), undefined);
	assert.match(h.store.notifications.at(-1)?.message ?? "", /Failed to load reasoning skill "plan"/);
});

test("an active skill is cleared and the turn is blocked semantically when its body disappears", async (t) => {
	const h = await harness(t);
	await h.start();
	await h.command("plan", "design memory");
	await h.removeSkillFile();
	const prompt = await h.beforeAgent();
	assert.equal(h.latestState()?.activeSkill, undefined);
	assert.equal(h.store.statuses.get("reasoning-mode"), "REASON");
	assert.match(prompt.systemPrompt, /<reasoning_skill_error>/);
	assert.match(prompt.systemPrompt, /Do not continue or approximate that workflow/);
	assert.doesNotMatch(prompt.systemPrompt, /PLAN_SKILL_BODY/);
	assert.match(h.store.notifications.at(-1)?.message ?? "", /Failed to load active reasoning skill "plan"/);
	assert.equal(h.activeTools().includes("edit"), false);
});

test("session restore and --plan immediately clear an active skill when skills are disabled", async (t) => {
	const restored = await harness(t, {
		branch: [stateEntry("reasoning", { activeSkill: "plan", tools: ["read", "edit", "write"] })],
		skillEnabled: false,
	});
	await restored.start();
	assert.equal(restored.latestState()?.activeSkill, undefined);
	assert.equal(restored.store.statuses.get("reasoning-mode"), "REASON");
	assert.match(restored.store.notifications.at(-1)?.message ?? "", /Active reasoning skill "plan" is unavailable/);
	assert.doesNotMatch((await restored.beforeAgent()).systemPrompt, /PLAN_SKILL_BODY/);
	assert.equal(restored.activeTools().includes("edit"), false);

	const flagged = await harness(t, { planFlag: true, skillEnabled: false });
	await flagged.start();
	assert.equal(flagged.latestState()?.activeSkill, undefined);
	assert.equal(flagged.store.statuses.get("reasoning-mode"), "REASON");
	assert.match(flagged.store.notifications.at(-1)?.message ?? "", /Active reasoning skill "plan" is unavailable/);
	assert.doesNotMatch((await flagged.beforeAgent()).systemPrompt, /PLAN_SKILL_BODY/);
	assert.equal(flagged.activeTools().includes("write"), false);
});

test("questionnaire is temporarily enabled only in TUI mode", async (t) => {
	const tui = await harness(t, { activeTools: ["read", "edit"], mode: "tui" });
	await tui.start();
	await tui.command("reasoning", "on");
	assert.equal(tui.activeTools().includes("questionnaire"), true);
	assert.equal(tui.activeTools().includes("submit_plan"), false);
	assert.equal(await tui.toolCall("questionnaire", { questions: [] }), undefined);

	const rpc = await harness(t, { activeTools: ["read", "questionnaire", "edit"], mode: "rpc" });
	await rpc.start();
	await rpc.command("reasoning", "on");
	assert.equal(rpc.activeTools().includes("questionnaire"), false);
	assert.deepEqual(await rpc.toolCall("questionnaire", { questions: [] }), {
		block: true,
		reason: "Reasoning Mode: questionnaire is available only in TUI mode.",
	});
});

test("runtime gate remains authoritative when tools are re-enabled externally", async (t) => {
	const h = await harness(t);
	await h.start();
	await h.command("reasoning", "on");
	h.setActiveTools([...h.activeTools(), "write", "external"]);
	assert.deepEqual(await h.toolCall("write", { path: "x", content: "x" }), {
		block: true,
		reason: "Reasoning Mode: write is unavailable in Reasoning Mode.",
	});
	assert.deepEqual(await h.toolCall("external", {}), {
		block: true,
		reason: "Reasoning Mode: unknown tool external.",
	});
	assert.deepEqual(await h.toolCall("bash", { command: "npm test" }), {
		block: true,
		reason: "Reasoning Mode: tests/builds may modify state and are disabled in Reasoning Mode.",
	});
});

test("v1 neutral Reasoning state migrates to explore and persists v2 state", async (t) => {
	const original = ["read", "bash", "edit", "write"];
	const h = await harness(t, { activeTools: original, branch: [previousStateEntry("reasoning", { tools: original })] });
	await h.start();
	assert.equal(h.latestState()?.version, 2);
	assert.equal(h.latestState()?.activeSkill, "explore");
	assert.equal(h.store.statuses.get("reasoning-mode"), "REASON · explore");
	assert.equal(h.activeTools().includes("edit"), false);
});

test("a completed plan remains approvable after session restore", async (t) => {
	const original = ["read", "bash", "edit", "write", "external"];
	const h = await harness(t, {
		activeTools: original,
		branch: [stateEntry("reasoning", { activeSkill: "plan", planReady: true, tools: original })],
	});
	await h.start();
	assert.equal(h.activeTools().includes("edit"), false);

	await h.command("plan", "approve");
	assert.equal(h.latestState()?.mode, "off");
	assert.deepEqual(h.activeTools(), original);
	assert.equal(h.store.customMessages.at(-1)?.customType, "plan-approved");
});

test("branch navigation restores Reasoning state and exact tools without appending", async (t) => {
	const original = ["read", "bash", "edit", "write", "external"];
	const active = stateEntry("reasoning", { activeSkill: "plan", tools: original });
	const h = await harness(t, { activeTools: original, branch: [active] });
	await h.start();
	assert.equal(h.store.statuses.get("reasoning-mode"), "REASON · plan");
	assert.equal(h.store.appended.length, 0);

	h.setBranch([]);
	await h.tree();
	assert.deepEqual(h.activeTools(), original);
	assert.equal(h.store.statuses.get("reasoning-mode"), undefined);
	assert.equal(h.store.appended.length, 0);
});

test("legacy planning states migrate while legacy execution is never resumed", async (t) => {
	const original = ["read", "bash", "edit", "write"];
	const planning = await harness(t, { branch: [legacyStateEntry("planning", original)] });
	await planning.start();
	assert.equal(planning.latestState()?.mode, "reasoning");
	assert.equal(planning.latestState()?.activeSkill, "plan");
	assert.equal(planning.activeTools().includes("edit"), false);

	const executing = await harness(t, { branch: [legacyStateEntry("executing", original)] });
	await executing.start();
	assert.equal(executing.latestState()?.mode, "off");
	assert.equal(executing.activeTools().includes("edit"), true);
});

test("--reasoning and --plan initialize the intended state", async (t) => {
	const reasoning = await harness(t, { reasoningFlag: true });
	await reasoning.start();
	assert.equal(reasoning.latestState()?.mode, "reasoning");
	assert.equal(reasoning.latestState()?.activeSkill, "explore");

	const restoredPlan = await harness(t, {
		reasoningFlag: true,
		branch: [stateEntry("reasoning", { activeSkill: "plan", tools: ["read", "edit", "write"] })],
	});
	await restoredPlan.start();
	assert.equal(restoredPlan.latestState()?.activeSkill, "explore");
	assert.equal(restoredPlan.store.statuses.get("reasoning-mode"), "REASON · explore");

	const plan = await harness(t, { planFlag: true });
	await plan.start();
	assert.equal(plan.latestState()?.mode, "reasoning");
	assert.equal(plan.latestState()?.activeSkill, "plan");
	assert.equal(plan.activeTools().includes("submit_plan"), true);
});

test("mode-changing commands and reasoning skill invocations are rejected while the agent is busy", async (t) => {
	const h = await harness(t);
	await h.start();
	h.setIdle(false);
	await h.command("reasoning");
	assert.equal(h.latestState(), undefined);
	assert.match(h.store.notifications.at(-1)?.message ?? "", /Wait for the current turn/);
	await h.command("reasoning", "on");
	assert.equal(h.latestState(), undefined);
	await h.command("plan", "approve");
	assert.equal(h.latestState(), undefined);
	assert.match(h.store.notifications.at(-1)?.message ?? "", /Wait for the current turn/);
	assert.deepEqual(await h.input("/skill:plan task"), { action: "handled" });
	assert.equal(h.latestState(), undefined);
});
