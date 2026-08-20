import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./test-harness.ts";
import { PLAN_READY_MARKER } from "./types.ts";

const V1 = "# Plan: Cache\n\n## Steps\n1. Use memory.";
const V2 = "# Plan: Cache\n\n## Steps\n1. Use Redis.\n2. Add tests.";

test("submit_plan stores a clean first plan and computes a full revision diff", async (t) => {
	const h = await harness(t);
	await h.start();
	await h.command("plan", "design cache");
	await h.beforeAgent();

	const first = await h.executeTool("submit_plan", { plan: V1 });
	assert.deepEqual(first.content, [{ type: "text", text: V1 }]);
	assert.equal(first.details.version, 1);
	assert.equal(first.details.previousVersion, undefined);
	assert.equal(first.details.changed, false);
	assert.equal(first.details.diff, undefined);

	await h.assistantMessage(`Plan submitted.\n\n${PLAN_READY_MARKER}`);
	assert.equal(h.latestState()?.planReady, true);
	await h.beforeAgent();

	const second = await h.executeTool("submit_plan", { plan: V2 });
	assert.equal(second.details.version, 2);
	assert.equal(second.details.previousVersion, 1);
	assert.equal(second.details.plan, V2);
	assert.equal(second.details.changed, true);
	assert.match(second.details.diff, /Use memory/);
	assert.match(second.details.diff, /Use Redis/);
	assert.doesNotMatch(second.content[0].text, /^[-+]/m);

	const tool = h.store.tools.get("submit_plan");
	assert.ok(tool?.renderCall);
	assert.ok(tool.renderResult);
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const state: Record<string, unknown> = {};
	const partial = tool.renderCall(
		{ plan: "# Plan: Ca" },
		theme,
		{ lastComponent: undefined, state, argsComplete: false },
	);
	assert.equal(partial.children[1].text, "# Plan: Ca");

	const throttled = tool.renderCall(
		{ plan: "# Plan: Cache" },
		theme,
		{ lastComponent: partial, state, argsComplete: false },
	);
	assert.equal(throttled.children[1].text, "# Plan: Ca");

	const live = tool.renderCall(
		{ plan: V2 },
		theme,
		{ lastComponent: partial, state, argsComplete: true },
	);
	assert.equal(live, partial);
	assert.equal(live.children[1].text, V2);

	const cappedState: Record<string, unknown> = {};
	const capped = tool.renderCall(
		{ plan: `# Plan: Huge\n\n${"界".repeat(5_000)}` },
		theme,
		{ lastComponent: undefined, state: cappedState, argsComplete: false },
	);
	assert.ok(Buffer.byteLength(capped.children[1].text, "utf8") <= 12 * 1024);
	assert.doesNotMatch(capped.children[1].text, /�/);
	assert.match(capped.children[2].text, /limited to 12288 bytes/);

	const renderedResult = tool.renderResult(
		second,
		{ expanded: false },
		theme,
		{ lastComponent: undefined, state },
	);
	assert.equal(renderedResult.children.length, 0);
	assert.match(live.children[0].text, /Plan v2 · compared with v1/);
	assert.match(live.children[1].text, /Use Redis/);
});

test("an unchanged resubmission remains complete and is marked unchanged", async (t) => {
	const h = await harness(t);
	await h.start();
	await h.command("plan", "design cache");
	await h.executeTool("submit_plan", { plan: V1 });
	const second = await h.executeTool("submit_plan", { plan: V1 });
	assert.equal(second.details.version, 2);
	assert.equal(second.details.previousVersion, 1);
	assert.equal(second.details.changed, false);
	assert.equal(second.details.diff, undefined);
	assert.equal(second.details.plan, V1);
});

test("submit_plan follows the active branch when plans diverge", async (t) => {
	const h = await harness(t);
	await h.start();
	await h.command("plan", "design cache");
	await h.executeTool("submit_plan", { plan: V1 });
	const branchAtV1 = structuredClone(h.store.branch);
	await h.executeTool("submit_plan", { plan: V2 });

	h.setBranch(branchAtV1);
	await h.tree();
	const alternative = await h.executeTool("submit_plan", {
		plan: "# Plan: Cache\n\n## Steps\n1. Use SQLite.",
	});
	assert.equal(alternative.details.version, 2);
	assert.match(alternative.details.diff, /Use memory/);
	assert.doesNotMatch(alternative.details.diff, /Use Redis/);
});

test("submit_plan can use a legacy complete assistant plan as its baseline", async (t) => {
	const h = await harness(t, {
		branch: [{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `${V1}\n\n${PLAN_READY_MARKER}` }],
			},
		}],
	});
	await h.start();
	await h.command("plan", "revise cache");
	const result = await h.executeTool("submit_plan", { plan: V2 });
	assert.equal(result.details.version, 2);
	assert.equal(result.details.previousVersion, 1);
	assert.equal(result.details.changed, true);
});

test("submit_plan is fail-closed outside the TUI plan workflow", async (t) => {
	const explore = await harness(t);
	await explore.start();
	await explore.command("reasoning", "on");
	assert.equal(explore.activeTools().includes("submit_plan"), false);
	await assert.rejects(() => explore.executeTool("submit_plan", { plan: V1 }), /only in the TUI plan workflow/);

	const rpc = await harness(t, { mode: "rpc" });
	await rpc.start();
	await rpc.command("plan", "design cache");
	assert.equal(rpc.activeTools().includes("submit_plan"), false);
	await assert.rejects(() => rpc.executeTool("submit_plan", { plan: V1 }), /only in the TUI plan workflow/);
	await rpc.assistantMessage(`${V1}\n\n${PLAN_READY_MARKER}`);
	assert.equal(rpc.latestState()?.planReady, true);
});

test("TUI falls back to a direct complete plan when submit_plan is unavailable", async (t) => {
	const h = await harness(t);
	await h.start();
	await h.command("plan", "design cache");
	h.setActiveTools(h.activeTools().filter((name) => name !== "submit_plan"));
	await h.assistantMessage(`${V1}\n\n${PLAN_READY_MARKER}`);
	assert.equal(h.latestState()?.planReady, true);
});

test("submit_plan rejects incomplete headings and oversized plans", async (t) => {
	const h = await harness(t);
	await h.start();
	await h.command("plan", "design cache");
	await assert.rejects(() => h.executeTool("submit_plan", { plan: "## Steps\n1. Missing title" }), /beginning with '# Plan:'/);
	await assert.rejects(
		() => h.executeTool("submit_plan", { plan: `# Plan: Huge\n\n${"x".repeat(51 * 1024)}` }),
		/exceeds the 51200-byte tool output limit/,
	);
});
