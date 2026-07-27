import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { harness, plan, proposal, stateEntry } from "./test-harness.ts";

test("session start and tree navigation restore branch state, widget, and exact tools", async (t) => {
	const normalTools = ["read", "bash", "edit", "write", "external"];
	const awaiting = stateEntry("awaiting_approval", { savedPlan: plan(), tools: normalTools });
	const h = await harness(t, { activeTools: normalTools, branch: [awaiting] });
	await h.start();
	assert.deepEqual(h.activeTools(), ["read", "bash", "plan_question", "propose_plan"]);
	assert.equal(h.statuses.get("plan-mode"), "PLAN · APPROVAL");
	assert.match(h.widgets.get("plan-mode-plan")?.[0] ?? "", /Plan Title · r1/);
	assert.equal(h.appended.length, 0);

	h.setBranch([]);
	await h.tree();
	assert.deepEqual(h.activeTools(), normalTools);
	assert.equal(h.statuses.get("plan-mode"), undefined);
	assert.equal(h.widgets.get("plan-mode-plan"), undefined);
	assert.equal(h.appended.length, 0);

	h.setBranch([awaiting]);
	await h.tree();
	assert.deepEqual(h.activeTools(), ["read", "bash", "plan_question", "propose_plan"]);
	assert.equal(h.statuses.get("plan-mode"), "PLAN · APPROVAL");
});

test("--plan pauses restored execution and does not reapply during tree navigation", async (t) => {
	const savedPlan = plan();
	const executing = stateEntry("executing", {
		savedPlan,
		tools: ["read", "bash", "edit", "write"],
	});
	const h = await harness(t, { branch: [executing], planFlag: true });
	await h.start();
	assert.equal(h.latestState()?.phase, "planning");
	const restoredPlan = h.latestState()?.plan;
	assert.ok(restoredPlan && typeof restoredPlan === "object" && "revision" in restoredPlan);
	assert.equal(restoredPlan.revision, 1);
	assert.equal(h.activeTools().includes("update_plan"), false);
	assert.equal(h.activeTools().includes("edit"), false);

	const appendedAfterStart = h.appended.length;
	await h.tree();
	assert.equal(h.appended.length, appendedAfterStart);
	assert.equal(h.latestState()?.phase, "planning");
});

test("off and completed branch state ignore stale snapshots and do not append on restore", async (t) => {
	const normalTools = ["read", "bash", "edit", "write", "external"];
	for (const phase of ["off", "completed"]) {
		const terminalPlan = plan();
		if (phase === "completed") {
			terminalPlan.steps[0]!.status = "completed";
			terminalPlan.steps[1]!.status = "skipped";
		}
		const h = await harness(t, {
			activeTools: normalTools,
			branch: [stateEntry(phase, { savedPlan: terminalPlan, tools: ["read"] })],
		});
		await h.start();
		assert.deepEqual(h.activeTools(), normalTools);
	}
});

test("runtime gate blocks tools re-enabled externally and slash transitions while busy", async (t) => {
	const h = await harness(t, { planFlag: true });
	await h.start();
	h.setActiveTools([...h.activeTools(), "write"]);
	assert.deepEqual(await h.toolCall("write", { path: "blocked.txt", content: "x" }), {
		block: true,
		reason: "Plan Mode: write is unavailable during planning.",
	});
	assert.deepEqual(await h.toolCall("bash", { command: "npm test" }), {
		block: true,
		reason: "Plan Mode: tests/builds may modify state and are disabled in Plan Mode.",
	});

	h.setIdle(false);
	const entriesBefore = h.appended.length;
	await h.command("off");
	assert.equal(h.appended.length, entriesBefore);
	assert.equal(h.latestState()?.phase, "planning");
	assert.equal(h.notifications.at(-1)?.message, "Wait for the current turn to settle before changing Plan Mode.");
});

test("plan_question shows the full question and maps display text back to labels", async (t) => {
	const h = await harness(t, { planFlag: true });
	await h.start();
	h.selectQueue.push("2. Beta — second choice");
	const result = await h.tool("plan_question", {
		questions: [
			{
				header: "Scope",
				question: "Which implementation should be used?",
				options: [
					{ label: "Other…", description: "literal user label" },
					{ label: "Beta", description: "second choice" },
				],
				allowOther: true,
			},
		],
	});
	assert.equal(h.uiEvents.at(-1)?.title, "Scope: Which implementation should be used?");
	assert.deepEqual(h.uiEvents.at(-1)?.value, [
		"1. Other… — literal user label",
		"2. Beta — second choice",
		"3. Other…",
	]);
	assert.equal(result.details?.answers?.[0]?.answer, "Beta");

	h.selectQueue.push("3. Other…");
	h.inputQueue.push("Custom answer");
	const custom = await h.tool("plan_question", {
		questions: [
			{
				question: "Choose again",
				options: [{ label: "One" }, { label: "Two" }],
				allowOther: true,
			},
		],
	});
	assert.equal(custom.details?.answers?.[0]?.answer, "Custom answer");
});

test("interactive and stateful plan tools execute sequentially", async (t) => {
	const h = await harness(t);
	assert.equal(h.toolMode("plan_question"), "sequential");
	assert.equal(h.toolMode("propose_plan"), "sequential");
	assert.equal(h.toolMode("update_plan"), "sequential");
});

test("blank proposal fields fail without changing planning state", async (t) => {
	const h = await harness(t, { planFlag: true });
	await h.start();
	const cases: Array<[Record<string, unknown>, RegExp]> = [
		[{ title: "   " }, /Plan title must not be blank/],
		[{ summary: "   " }, /Plan summary must not be blank/],
		[{ implementation: ["   "] }, /Plan implementation must contain at least one non-blank item/],
		[{ steps: [{ title: " ", description: "valid" }] }, /Plan step S1 title must not be blank/],
		[{ steps: [{ title: "valid", description: " " }] }, /Plan step S1 description must not be blank/],
		[{ tests: [" "] }, /Plan verification must contain at least one non-blank item/],
	];
	const entriesBefore = h.appended.length;
	for (const [overrides, expected] of cases) {
		await assert.rejects(h.tool("propose_plan", proposal(overrides)), expected);
	}
	assert.equal(h.appended.length, entriesBefore);
	assert.equal(h.latestState()?.phase, "planning");
});

test("proposal review precedes approval choices and Stay invalidates the revision", async (t) => {
	const h = await harness(t, { planFlag: true });
	await h.start();
	h.selectQueue.push("Stay in Plan Mode");
	await h.tool("propose_plan", proposal());
	const reviewEvents = h.uiEvents.slice(-2);
	assert.equal(reviewEvents[0]?.type, "editor");
	assert.equal(reviewEvents[0]?.title, "Review Implement Plan Mode · revision 1 (read-only)");
	assert.match(String(reviewEvents[0]?.value), /# Implement Plan Mode/);
	assert.equal(reviewEvents[1]?.type, "select");
	assert.equal(h.latestState()?.phase, "planning");

	await h.command("approve");
	assert.equal(h.notifications.at(-1)?.message, "No plan revision is awaiting approval.");
	assert.equal(h.messages.length, 0);
	await h.command("status");
	assert.equal(
		h.notifications.at(-1)?.message,
		"planning · Implement Plan Mode r1 · shell=inspect · unknown=deny",
	);
});

test("approval restores tools, activates progress tracking, and completion clears the snapshot", async (t) => {
	const normalTools = ["read", "bash", "edit", "write", "external"];
	const h = await harness(t, { activeTools: normalTools, planFlag: true });
	await h.start();
	h.selectQueue.push("Approve and restore normal tools");
	await h.tool("propose_plan", proposal({
		steps: [
			{ title: "First", description: "First implementation" },
			{ title: "Second", description: "Second implementation" },
		],
	}));
	assert.deepEqual(h.activeTools(), [...normalTools, "update_plan"]);
	assert.equal(h.messages.length, 1);
	assert.deepEqual(h.messages[0]?.options, { deliverAs: "followUp", triggerTurn: true });

	await h.tool("update_plan", {
		updates: [
			{ stepId: "S1", status: "completed" },
			{ stepId: "S2", status: "skipped" },
		],
	});
	assert.deepEqual(h.activeTools(), normalTools);
	assert.equal(h.latestState()?.phase, "completed");
	assert.equal(h.latestState()?.toolsBeforePlan, undefined);
});

test("slash safe approval works only for a fresh awaiting revision", async (t) => {
	const h = await harness(t, { planFlag: true, hasUI: false });
	await h.start();
	await h.tool("propose_plan", proposal());
	h.ctx.hasUI = true;
	await h.command("approve safe");
	assert.equal(h.latestState()?.phase, "executing");
	assert.equal(h.latestState()?.executionPolicy, "confirm_mutations");
	assert.equal(h.activeTools().includes("update_plan"), true);
});

test("sendMessage failure atomically restores awaiting approval and read-only tools", async (t) => {
	const h = await harness(t, { planFlag: true, hasUI: false });
	await h.start();
	await h.tool("propose_plan", proposal());
	h.setSendError(new Error("dispatch failed"));
	await assert.rejects(h.command("approve"), /Failed to start plan execution: dispatch failed/);
	assert.equal(h.latestState()?.phase, "awaiting_approval");
	assert.deepEqual(h.activeTools(), ["read", "bash", "plan_question", "propose_plan"]);
});

test("RPC reviews notify before selection and UI-less results contain full Markdown", async (t) => {
	const rpc = await harness(t, { planFlag: true, mode: "rpc" });
	await rpc.start();
	rpc.selectQueue.push("Stay in Plan Mode");
	await rpc.tool("propose_plan", proposal());
	const markdownNotification = rpc.uiEvents.findIndex(
		(item) => item.type === "notify" && String(item.value).startsWith("# Implement Plan Mode"),
	);
	const selectEvent = rpc.uiEvents.findIndex((item) => item.type === "select");
	assert.ok(markdownNotification >= 0);
	assert.ok(selectEvent > markdownNotification);
	assert.equal(rpc.uiEvents.some((item) => item.type === "editor"), false);

	const headless = await harness(t, { planFlag: true, hasUI: false });
	await headless.start();
	const result = await headless.tool("propose_plan", proposal());
	assert.match(result.content?.[0]?.text ?? "", /# Implement Plan Mode/);
	assert.match(result.content?.[0]?.text ?? "", /awaiting explicit approval/);
});

test("export preserves Unicode, refuses collisions, confirms overwrite, and wraps directory errors", async (t) => {
	const h = await harness(t, { planFlag: true, hasUI: false });
	await h.start();
	await h.tool("propose_plan", proposal({ title: "Ａ计划 / Café" }));
	await h.command("export");
	const target = path.join(h.ctx.cwd, ".pi", "plans", "A计划-Café.md");
	assert.match(await fs.readFile(target, "utf8"), /# Ａ计划 \/ Café/);

	await fs.writeFile(target, "sentinel");
	h.ctx.hasUI = true;
	h.confirmQueue.push(false);
	await h.command("export");
	assert.equal(await fs.readFile(target, "utf8"), "sentinel");
	h.confirmQueue.push(true);
	await h.command("export");
	assert.match(await fs.readFile(target, "utf8"), /# Ａ计划 \/ Café/);

	h.ctx.hasUI = false;
	await assert.rejects(h.command("export"), new RegExp(`Plan export target already exists: ${target}`));
	await assert.rejects(h.command("export ."), new RegExp(`Failed to export plan to ${h.ctx.cwd}: target is a directory`));
});
