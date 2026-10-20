import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import tokenSpeed from "../token-speed/index.ts";

function setup(t: TestContext, mode = "tui") {
	let now = 0;
	t.mock.timers.enable({ apis: ["setInterval"] });
	t.mock.method(performance, "now", () => now);
	const handlers = new Map<string, Function>();
	let status: string | undefined;
	const ctx = {
		mode,
		ui: { setStatus(key: string, value: string | undefined) { assert.equal(key, "token-speed"); status = value; } },
	} as unknown as ExtensionContext;
	tokenSpeed({ on: (name: string, handler: Function) => handlers.set(name, handler) } as unknown as ExtensionAPI);
	const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
	const content = (blocks: unknown[]) => emit("message_update", {
		message: { role: "assistant", usage: { output: 0 }, content: blocks },
	});
	emit("agent_start");
	return {
		emit, content, status: () => status,
		text: (text: string) => content([{ type: "text", text }]),
		end: (stopReason = "stop") => emit("message_end", {
			message: { role: "assistant", usage: { output: 10_000 }, content: [], stopReason },
		}),
		tick: (ms: number) => {
			while (ms > 0) {
				const step = Math.min(ms, 250);
				now += step;
				t.mock.timers.tick(step);
				ms -= step;
			}
		},
	};
}

test("recent output speed replaces historical speed instead of averaging the entire request", (t) => {
	const s = setup(t);
	s.emit("before_provider_request");
	for (const tokens of [5, 10, 15, 20]) {
		// In o200k_base, each leading-space 'a' is one token.
		s.text(" a".repeat(tokens));
		s.tick(250);
	}
	assert.equal(s.status(), "20.0 tok/s");
	for (const tokens of [22, 24, 26, 28]) {
		s.text(" a".repeat(tokens));
		s.tick(250);
	}
	assert.equal(s.status(), "8.0 tok/s", "the last second added 8 tokens; the full-request average would be 14");
});

test("a streaming pause retains the last positive speed and new output resumes measurement", (t) => {
	const s = setup(t);
	s.emit("before_provider_request");
	s.text("Hello world");
	s.tick(250);
	assert.equal(s.status(), "8.0 tok/s");
	s.text("Hello world!");
	s.tick(250);
	assert.equal(s.status(), "6.0 tok/s", "count the full three-token snapshot without double-counting prior text");
	s.tick(750);
	assert.equal(s.status(), "1.0 tok/s");
	s.tick(250);
	assert.equal(s.status(), "1.0 tok/s", "an empty window must retain the last positive speed");
	s.tick(2_000);
	assert.equal(s.status(), "1.0 tok/s");
	s.text("Hello world!" + " a".repeat(8));
	s.tick(250);
	assert.equal(s.status(), "8.0 tok/s", "resumed output uses the current window rather than the previous speed");
});

test("silent thinking stays zero; streamed thinking counts text but not signatures", (t) => {
	const s = setup(t);
	s.emit("before_provider_request");
	s.tick(5_000);
	assert.equal(s.status(), "0.0 tok/s");
	s.content([{ type: "thinking", thinking: "", thinkingSignature: "secret ".repeat(1_000) }]);
	s.tick(250);
	assert.equal(s.status(), "0.0 tok/s");
	s.content([{ type: "thinking", thinking: "Hello world", thinkingSignature: "secret ".repeat(1_000) }]);
	s.tick(250);
	assert.equal(s.status(), "2.0 tok/s", "only the two visible thinking tokens belong in the latest one-second window");
});

test("tool execution retains the last speed while subsequent requests use independent samples", (t) => {
	const s = setup(t);
	s.emit("before_provider_request");
	s.content([{ type: "toolCall", name: "read", arguments: { path: "<|endoftext|>" } }]);
	s.tick(250);
	assert.ok(Number.parseFloat(s.status()!) > 0, "a special-token literal in a tool argument must not break tokenization");
	const lastSpeed = s.status();
	s.end("toolUse");
	assert.equal(s.status(), lastSpeed);
	s.emit("message_end", { message: { role: "toolResult" } });
	s.tick(10_000);
	assert.equal(s.status(), lastSpeed);
	s.emit("turn_start");
	assert.equal(s.status(), lastSpeed);
	s.emit("before_provider_request");
	assert.equal(s.status(), lastSpeed);
	s.text("Hello world");
	s.tick(250);
	assert.equal(s.status(), "8.0 tok/s", "the new request starts its own window");
});

test("success, failure and cancellation stop streaming without turning final API totals into current speed", (t) => {
	const s = setup(t);
	for (const reason of ["stop", "error", "aborted"]) {
		s.emit("before_provider_request");
		s.text("Hello world");
		s.tick(250);
		assert.equal(s.status(), "8.0 tok/s");
		s.end(reason);
		assert.equal(s.status(), "8.0 tok/s");
		s.tick(2_000);
		assert.equal(s.status(), "8.0 tok/s");
	}
});

test("conversation and session lifecycle events retain speed, stop timers and ignore stale snapshots", (t) => {
	const s = setup(t);
	for (const event of ["agent_settled", "session_tree", "session_shutdown", "session_start"]) {
		s.emit("agent_start");
		s.emit("before_provider_request");
		s.text("Hello world");
		s.tick(250);
		assert.equal(s.status(), "8.0 tok/s");
		s.emit(event);
		s.text("Hello world!");
		s.emit("before_provider_request");
		s.tick(2_000);
		assert.equal(s.status(), "8.0 tok/s");
	}
});

test("retries discard the old request window and duplicate agent_start does not stop live measurement", (t) => {
	const s = setup(t);
	s.emit("before_provider_request");
	s.text("Hello world");
	s.tick(250);
	s.emit("agent_start");
	s.text("Hello world!");
	s.tick(250);
	assert.equal(s.status(), "6.0 tok/s");
	s.emit("before_provider_request");
	assert.equal(s.status(), "6.0 tok/s");
	s.tick(2_000);
	assert.equal(s.status(), "6.0 tok/s", "waiting for a retried request must retain the previous speed");
	s.text("Hello world");
	s.tick(250);
	assert.equal(s.status(), "2.0 tok/s");
});

test("tokenization cooldown keeps the newest pending snapshot for the next measurement", (t) => {
	const s = setup(t);
	s.emit("before_provider_request");
	s.text("Hello world");
	const times = [1_000, 1_100, 1_100, 1_500, 1_500, 3_200, 3_200, 3_200];
	t.mock.method(performance, "now", () => times.shift() ?? 3_200);
	s.tick(250);
	assert.equal(s.status(), "1.8 tok/s");
	s.text("Hello world!");
	s.tick(250);
	assert.equal(s.status(), "1.3 tok/s", "reuse the cached count during cooldown");
	s.tick(250);
	assert.equal(s.status(), "0.6 tok/s", "the newest snapshot adds one token after cooldown, not three historical tokens");
});

test("non-TUI calls do not change status", (t) => {
	const s = setup(t, "json");
	s.emit("before_provider_request");
	s.text("Hello world");
	s.tick(1_000);
	s.end();
	assert.equal(s.status(), undefined);
});
