import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import compactFooter, { alignStats, formatModel } from "../compact-footer.ts";

const model = (id = "gpt-5.6-sol", api = "openai-responses") => ({ id, api, reasoning: true, provider: "openai-codex", contextWindow: 200000 });

test("compact model keeps routing but always shows the selected thinking level", () => {
	assert.equal(formatModel({ model: model(), thinkingLevel: "medium" } as ExtensionContext), "gpt-5.6-sol · medium");
	assert.equal(formatModel({ model: model("auto", "pi-virtual"), thinkingLevel: "high" } as ExtensionContext, { model: "gpt-5.6-sol", thinkingLevel: "medium" }), "gpt-5.6-sol · high");
	assert.equal(formatModel({ model: model("auto", "pi-virtual"), thinkingLevel: "high" } as ExtensionContext), "auto · high");
	assert.equal(formatModel({ model: model(), thinkingLevel: "high" } as ExtensionContext, { model: "old-model" }), "gpt-5.6-sol · high");
	assert.equal(formatModel({ model: { ...model(), reasoning: false } } as ExtensionContext), "gpt-5.6-sol");
	assert.equal(formatModel({ model: undefined }), "no-model");
});

test("formatting fits narrow terminals and wide characters", () => {
	for (const width of [1, 5, 20, 80]) {
		assert.ok(visibleWidth(alignStats("↑12k 你好", "gpt-5.6-sol · medium", width)) <= width);
	}
	assert.equal(alignStats("↑1k", "sol", 12), "↑1k      sol");
});

test("footer shows the live routed model before persistence and unsubscribes on disposal", () => {
	const handlers = new Map<string, Function>();
	let factory: Function;
	let leaf = "old";
	let scans = 0, repaints = 0;
	let message = { role: "assistant", model: "previous-model" };
	const ctx = {
		mode: "tui", model: model("auto", "pi-virtual"), thinkingLevel: "high",
		ui: { setFooter: (value: Function) => { factory = value; } },
		getContextUsage: () => ({ percent: 10 }),
		sessionManager: {
			getSessionId: () => "session", getLeafId: () => leaf, getEntryCount: () => 1,
			getBranch: () => { scans++; return [{ type: "message", message }]; },
			getCwd: () => "/tmp/project", getSessionName: () => "",
		},
	} as unknown as ExtensionContext;
	compactFooter({ on: (event: string, handler: Function) => {
		handlers.set(event, handler);
		return () => handlers.delete(event);
	} } as unknown as ExtensionAPI);
	handlers.get("session_start")!({}, ctx);
	const footer = factory!({ requestRender() { repaints++; } }, { fg: (_color: string, text: string) => text }, {
		onBranchChange: () => () => {}, getGitBranch: () => "", getExtensionStatuses: () => new Map(),
	});
	assert.match(footer.render(120)[0], /previous-model · high$/);
	leaf = "user";
	handlers.get("message_start")?.({ message: { role: "assistant", model: "routed-model" } }, ctx);
	assert.match(footer.render(120)[0], /routed-model · high$/);
	assert.equal(scans, 1, "a new user entry must not overwrite the live route with history");
	handlers.get("message_update")?.({ message: { role: "assistant", model: "updated-model" } }, ctx);
	assert.match(footer.render(120)[0], /updated-model · high$/);
	handlers.get("message_start")?.({ message: { role: "toolResult", model: "not-a-route" } }, ctx);
	assert.match(footer.render(120)[0], /updated-model · high$/);
	assert.equal(repaints, 2);
	message = { role: "assistant", model: "updated-model" }; leaf = "finished";
	assert.match(footer.render(120)[0], /updated-model · high$/);
	assert.equal(scans, 2);
	message = { role: "assistant", model: "another-branch-model" }; leaf = "another-branch";
	assert.match(footer.render(120)[0], /another-branch-model · high$/);
	footer.dispose();
	assert.equal(handlers.has("message_start"), false);
	assert.equal(handlers.has("message_update"), false);
});

test("footer shows only context percentage alongside location and model, preserving warnings and extension statuses", () => {
	let start: Function;
	let factory: Function;
	let disposed = false;
	let scans = 0;
	let leaf = "one";
	let percent: number | null = 95;
	const usage = { input: 1000, output: 100, cacheRead: 1000, cacheWrite: 0, cost: { total: 0.1 } };
	const message = { role: "assistant", model: "gpt-5.6-sol", thinkingLevel: "medium", usage };
	const entries = [{ type: "message", message }, { type: "usage", usage }, { type: "compaction", usage }, { type: "message", message: { role: "toolResult", usage } }];
	const ctx = {
		mode: "tui", model: model("auto", "pi-virtual"), thinkingLevel: "high",
		ui: { setFooter: (value: Function) => { factory = value; } },
		getContextUsage: () => ({ percent, contextWindow: 200000 }),
		sessionManager: {
			getSessionId: () => "session", getLeafId: () => leaf, getEntryCount: () => entries.length,
			getEntries: () => assert.fail("must not scan token usage"),
			getBranch: () => { scans++; return [{ type: "message", message }]; },
			getCwd: () => "/tmp/project", getSessionName: () => "Work",
		},
	} as unknown as ExtensionContext;
	compactFooter({ on: (event: string, handler: Function) => {
		if (event === "session_start") start = handler;
		return () => {};
	} } as unknown as ExtensionAPI);
	start!({}, { mode: "rpc" });
	assert.equal(factory!, undefined);
	start!({}, ctx);
	const footer = factory!({ requestRender() {} }, { fg: (color: string, text: string) => color === "dim" ? text : `[${color}:${text}]` }, {
		onBranchChange: () => () => { disposed = true; }, getGitBranch: () => "main",
		getExtensionStatuses: () => new Map([["b", "fast\nmode"], ["a", "PM"]]),
	});
	const lines = footer.render(160);
	assert.equal(lines.length, 2, "location and stats share one row, extension statuses keep their own row");
	assert.match(lines[0], /^\/tmp\/project \(main\) • Work \| \[error:95\.0%\] +gpt/);
	assert.doesNotMatch(lines[0], /[↑↓$]|CH|200k|R1|auto|→/);
	assert.match(lines[0], /gpt-5.6-sol · high$/);
	assert.equal(lines[1], "PM fast mode");
	footer.render(160);
	assert.equal(scans, 1, "reuse cached route between renders");
	for (const level of ["low", "medium", "high", "xhigh"] as const) {
		ctx.thinkingLevel = level;
		assert.ok(footer.render(160)[0].endsWith(`gpt-5.6-sol · ${level}`));
	}
	assert.equal(message.thinkingLevel, "medium", "historical response stays unchanged");
	assert.equal(scans, 1, "selected level updates even with the route cached");
	leaf = "two";
	percent = null;
	assert.match(footer.render(160)[0], / \| \? +gpt/);
	assert.equal(scans, 2);
	percent = 75;
	assert.match(footer.render(160)[0], /\[warning:75\.0%\]/);
	percent = 0;
	assert.match(footer.render(160)[0], / \| 0\.0% +gpt/);
	ctx.model = model("gpt-5.6-luna") as ExtensionContext["model"];
	ctx.thinkingLevel = "low";
	assert.match(footer.render(160)[0], /gpt-5.6-luna · low$/);
	assert.equal(scans, 2);
	ctx.sessionManager.getCwd = () => `/tmp/${"目录".repeat(80)}`;
	for (const width of [1, 5, 20, 80, 160]) {
		const narrow = footer.render(width);
		assert.equal(narrow.length, 2);
		for (const line of narrow) assert.ok(visibleWidth(line) <= width);
	}
	assert.match(footer.render(160)[0], /gpt-5.6-luna · low$/);
	footer.dispose();
	assert.ok(disposed);
});
