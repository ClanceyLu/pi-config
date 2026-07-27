import assert from "node:assert/strict";
import test from "node:test";
import { harness, legacyStateEntry, stateEntry } from "./test-harness.ts";

test("neutral Reasoning Mode enables inspection tools and restores the exact snapshot", async (t) => {
	const original = ["read", "bash", "edit", "write", "external"];
	const h = await harness(t, { activeTools: original });
	await h.start();
	await h.command("reasoning", "on");
	assert.deepEqual(h.activeTools(), ["read", "bash", "grep", "find", "ls", "questionnaire"]);
	assert.equal(h.latestState()?.mode, "reasoning");
	assert.equal(h.store.statuses.get("reasoning-mode"), "REASON");

	await h.command("reasoning", "off");
	assert.deepEqual(h.activeTools(), original);
	assert.equal(h.latestState()?.mode, "off");
	assert.equal(h.store.statuses.get("reasoning-mode"), undefined);
});

test("/plan and /reasoning plan activate the same skill without a Plan workflow", async (t) => {
	const h = await harness(t);
	await h.start();
	await h.command("plan", "design memory");
	assert.equal(h.latestState()?.activeSkill, "plan");
	assert.deepEqual(h.store.userMessages, ["design memory"]);
	assert.equal(h.activeTools().includes("edit"), false);
	assert.equal(h.activeTools().includes("write"), false);
	assert.equal(h.store.statuses.get("reasoning-mode"), "REASON · plan");

	await h.command("reasoning", "plan redesign cache");
	assert.deepEqual(h.store.userMessages, ["design memory", "redesign cache"]);
	assert.equal(h.latestState()?.activeSkill, "plan");
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
	assert.equal(reasoning.latestState()?.activeSkill, undefined);

	const plan = await harness(t, { planFlag: true });
	await plan.start();
	assert.equal(plan.latestState()?.mode, "reasoning");
	assert.equal(plan.latestState()?.activeSkill, "plan");
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
	assert.deepEqual(await h.input("/skill:plan task"), { action: "handled" });
	assert.equal(h.latestState(), undefined);
});
