import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import taskTimer, { formatElapsed } from "../task-timer.ts";

test("elapsed formatting", () => {
	for (const [ms, expected] of [[-1, "0s"], [59_999, "59s"], [60_000, "1m 00s"], [3_661_000, "1h 01m 01s"]] as const) {
		assert.equal(formatElapsed(ms), expected);
	}
});

test("timer excludes prompt waits, survives retries, and stops on settle or shutdown", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
	let widget: string[] | undefined;
	const ctx = {
		mode: "tui",
		ui: {
			setWidget: (key: string, content: string[] | undefined, options?: { placement: string }) => {
				assert.equal(key, "task-timer");
				if (content !== undefined) assert.equal(options?.placement, "aboveEditor");
				widget = content;
			},
			setWorkingMessage: () => assert.fail("must not overwrite or reset the shared working message"),
		},
	} as unknown as ExtensionContext;
	taskTimer({ on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => handlers.set(event, handler) } as unknown as ExtensionAPI);
	const emit = async (event: string) => handlers.get(event)!({}, ctx);

	await emit("session_start");
	assert.equal(widget, undefined);
	await emit("agent_start");
	assert.deepEqual(widget, ["执行中 · 0s"]);
	t.mock.timers.tick(2_000);
	assert.deepEqual(widget, ["执行中 · 2s"]);
	await emit("agent_start");
	await emit("ui_prompt_start");
	assert.deepEqual(widget, ["等待回答 · 2s"]);
	t.mock.timers.tick(10_000);
	assert.deepEqual(widget, ["等待回答 · 2s"]);
	await emit("agent_start");
	await emit("ui_prompt_end");
	assert.deepEqual(widget, ["执行中 · 2s"]);
	t.mock.timers.tick(1_000);
	assert.deepEqual(widget, ["执行中 · 3s"]);
	await emit("ui_prompt_start");
	t.mock.timers.tick(5_000);
	await emit("agent_settled");
	assert.deepEqual(widget, ["耗时 3s"]);
	t.mock.timers.tick(2_000);
	assert.deepEqual(widget, ["耗时 3s"]);
	await emit("ui_prompt_end");
	assert.deepEqual(widget, ["耗时 3s"]);
	await emit("agent_start");
	assert.deepEqual(widget, ["执行中 · 0s"]);
	t.mock.timers.tick(1_000);
	assert.deepEqual(widget, ["执行中 · 1s"]);
	await emit("ui_prompt_start");
	await emit("session_shutdown");
	t.mock.timers.tick(2_000);
	assert.equal(widget, undefined);
});
