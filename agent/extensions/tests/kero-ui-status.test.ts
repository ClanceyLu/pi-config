import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import keroUIStatus from "../kero-ui-status.ts";

function load(t: TestContext, pane: string | undefined = "test-pane") {
	const previous = process.env.KERO_PANE;
	if (pane === undefined) delete process.env.KERO_PANE;
	else process.env.KERO_PANE = pane;
	t.after(() => {
		if (previous === undefined) delete process.env.KERO_PANE;
		else process.env.KERO_PANE = previous;
	});
	const output: string[] = [];
	t.mock.method(process.stdout, "write", (data: string) => { output.push(data); return true; });
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	keroUIStatus({
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI);
	const emit = (name: string, mode = "tui") => handlers.get(name)?.({}, { mode } as ExtensionContext);
	return { output, handlers, emit };
}

const blocked = `\u001b]7501;state=blocked:kind=question:app=pi:msg=${Buffer.from("等待回答").toString("base64")}\u001b\\`;
const clear = "\u001b]7501;state=clear:app=pi\u001b\\";

test("native UI prompt events block Kero and restore automatic status when the prompt closes", (t) => {
	const { output, emit } = load(t);
	emit("ui_prompt_end");
	assert.deepEqual(output, []);
	emit("ui_prompt_start");
	assert.deepEqual(output, [blocked]);
	emit("ui_prompt_start");
	assert.deepEqual(output, [blocked]);
	emit("ui_prompt_end");
	assert.deepEqual(output, [blocked, clear]);
	emit("ui_prompt_start");
	emit("ui_prompt_end");
	assert.deepEqual(output, [blocked, clear, blocked, clear]);
});

test("shutdown clears an outstanding wait once, including during reload", (t) => {
	const { output, emit } = load(t);
	emit("session_shutdown");
	assert.deepEqual(output, []);
	emit("ui_prompt_start");
	emit("session_shutdown");
	emit("ui_prompt_end");
	emit("session_shutdown");
	assert.deepEqual(output, [blocked, clear]);
});

test("does not emit terminal status in non-TUI modes", (t) => {
	const { output, emit } = load(t);
	for (const mode of ["print", "json", "rpc"]) {
		emit("ui_prompt_start", mode);
		emit("ui_prompt_end", mode);
	}
	emit("session_shutdown");
	assert.deepEqual(output, []);
});

test("does not register hooks outside Kero", (t) => {
	const { output, handlers } = load(t, "");
	assert.equal(handlers.size, 0);
	assert.deepEqual(output, []);
});
