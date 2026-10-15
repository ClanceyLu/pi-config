import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import toolGroups, { groupTools, ToolGroup, type ToolRow } from "../tool-groups.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
const click = (y: number, height = 10) => ({ type: "click", button: "left", x: 3, y, width: 120, height } as TuiMouseEvent);

function row(name: string, id = name) {
	return Object.assign(Object.create(ToolExecutionComponent.prototype), {
		toolName: name, toolCallId: id, result: { isError: false }, isPartial: false, expanded: false, renders: 0,
		invalidate() {},
		render() { this.renders++; return [this.expanded ? `${name}: full result` : `${name}: compact`]; },
		handleMouse(event: TuiMouseEvent) {
			if (event.type !== "click" || event.button !== "left") return;
			this.expanded = !this.expanded;
			return { handled: true };
		},
	}) as ToolRow & { expanded: boolean; renders: number };
}

function thinking(text = "") {
	return Object.assign(Object.create(AssistantMessageComponent.prototype), {
		lastMessage: { content: [{ type: text ? "text" : "thinking", text }] },
		render: () => text ? [text] : [], invalidate() {},
	}) as Component;
}

test("groups all tools including codemode, across thinking only; preserves prompts, answers, warnings and order", () => {
	const read = row("read"), bash = row("bash"), code = row("codemode"), edit = row("edit");
	const spacer = new Spacer(1), thought = thinking(), answer = thinking("Visible answer"), notice = new Text("Warning");
	const groups: { rows: ToolRow[]; members: Component[] }[] = [];
	const input = [read, spacer, thought, bash, code, answer, edit, notice];
	const result = groupTools(input, (rows, members) => {
		groups.push({ rows, members });
		return new Text(`group ${rows.length}`);
	});
	assert.deepEqual(groups.map((group) => group.rows), [[read, bash, code], [edit]]);
	assert.deepEqual(groups[0].members, [read, spacer, thought, bash, code]);
	assert.equal(result[1], answer);
	assert.equal(result[3], notice);
	assert.equal(input.length, 8, "does not alter the transcript");
	assert.deepEqual(groupTools([read, spacer, thought], () => notice), [notice, spacer, thought], "trailing thinking remains outside a group");
});

test("assistant errors, aborts and truncation notices never fold into tool groups", () => {
	for (const stopReason of ["error", "aborted", "length"]) {
		const notice = thinking() as Component & { lastMessage: { stopReason?: string } };
		notice.lastMessage.stopReason = stopReason;
		const marker = new Text("group");
		assert.deepEqual(groupTools([row("read"), notice, row("bash")], () => marker), [marker, notice, marker]);
	}
});

test("two independent expansion levels preserve original compact rows and their mouse handlers", () => {
	const read = row("read"), code = row("codemode");
	const rows = [read, code];
	const state = { expanded: false };
	let repaints = 0;
	const build = () => new ToolGroup(rows, rows, state, theme, () => repaints++);
	let group = build();
	assert.deepEqual(group.render(120), ["", " ⦁ read 1 · codemode 1"]);
	assert.equal(read.renders, 0, "folded results are not rendered");
	assert.equal(group.handleMouse(click(0, 2)), undefined, "blank separator is not clickable");
	assert.equal(state.expanded, false);
	assert.equal(group.handleMouse(click(1))?.handled, true);
	assert.equal(repaints, 1);
	group = build();
	assert.deepEqual(group.render(120), ["", " ⦁ read 1 · codemode 1", " ├ read: compact", " └ codemode: compact"]);
	assert.equal(read.expanded, false, "opening the outer group does not open tool details");
	group.handleMouse(click(2));
	assert.equal(read.expanded, true);
	assert.match(build().render(120).join("\n"), /read: full result/);
	group.handleMouse(click(1));
	assert.equal(state.expanded, false);
	assert.equal(read.expanded, true, "closing the outer group preserves inner state");
	assert.equal(build().render(120).length, 2);
	for (const width of [0, 1, 5, 20, 80]) for (const line of build().render(width)) assert.ok(visibleWidth(line) <= width);
});

test("single-line summary keeps ANSI styling within narrow widths and truncates long tool names", () => {
	const styled = {
		fg: (_color: string, text: string) => `\x1b[90m${text}\x1b[39m`,
	} as Theme;
	const rows = [row("一个很长的工具名称_".repeat(20))];
	const group = new ToolGroup(rows, rows, { expanded: false }, styled, () => {});
	for (const width of [0, 1, 2, 5, 10, 20, 80]) {
		const lines = group.render(width);
		assert.equal(lines.length, 2);
		for (const line of lines) assert.ok(visibleWidth(line) <= width);
	}
	assert.equal(group.render(80)[0], "");
	assert.match(group.render(80)[1], / ⦁ 一个很长的工具名称_/);
});

test("expanded rail stays connected through multiline tools and spacers with correct mouse coordinates", () => {
	const read = row("read"), bash = row("bash");
	let received: TuiMouseEvent | undefined;
	let renderedWidth = 0;
	read.render = (width: number) => { renderedWidth = width; return ["• read", " │ output", " └ Done"]; };
	read.handleMouse = (event: TuiMouseEvent) => { received = event; return { handled: true }; };
	const group = new ToolGroup([read, bash], [read, new Spacer(1), thinking(), bash], { expanded: true }, theme, () => {});
	assert.deepEqual(group.render(40), ["", " ⦁ read 1 · bash 1", " ├ • read", " │  │ output", " │  └ Done", " │ ", " └ bash: compact"]);
	assert.equal(renderedWidth, 37);
	assert.equal(group.handleMouse({ ...click(3), x: 1, width: 40 }), undefined, "rail is not a tool click");
	assert.equal(group.handleMouse({ ...click(3), x: 8, width: 40 })?.handled, true);
	assert.equal(received?.x, 5);
	assert.equal(received?.y, 1);
	assert.equal(received?.width, 37);
	for (const width of [0, 1, 2, 3, 5, 20, 80]) {
		assert.ok(group.render(width).every((line) => visibleWidth(line) <= width));
	}
});

test("single codemode branch points at its header, not around its output", () => {
	const code = row("codemode");
	code.render = () => ["", "\x1b[90m   \x1b[0m", "⦁ codemode text(...)", " │ result", " └ Done", ""];
	const group = new ToolGroup([code], [code], { expanded: true }, theme, () => {});
	assert.deepEqual(group.render(80), ["", " ⦁ codemode 1", " │ ", " │ \x1b[90m   \x1b[0m", " └ ⦁ codemode text(...)", "    │ result", "    └ Done", "   "]);
});

test("active, partial and restored unfinished calls stay outside groups and preserve order", () => {
	const done = row("edit"), active = row("read"), partial = row("bash"), restored = row("codemode");
	partial.isPartial = true;
	restored.result = undefined;
	const running = new Set([active.toolCallId]);
	const spacer = new Spacer(1), thought = thinking();
	const marker = new Text("finished group");
	const input = [done, spacer, thought, active, partial, restored, row("write")];
	const groups: ToolRow[][] = [];
	const result = groupTools(input, (rows) => { groups.push(rows); return marker; }, running);
	assert.deepEqual(result, [marker, spacer, thought, active, partial, restored, marker]);
	assert.deepEqual(groups.map((rows) => rows.map((r) => r.toolName)), [["edit"], ["write"]]);
	assert.deepEqual(groupTools([active], () => marker, running), [active], "running-only transcript has no summary");
});

test("finished summary keeps per-tool counts without totals or action labels", () => {
	const read = row("read"), bash = row("bash");
	bash.result = { isError: true };
	const rows = [read, bash, row("read", "read-2")];
	const colors: string[] = [];
	const paint = { ...theme, fg: (color: string, text: string) => { colors.push(color); return text; } } as Theme;
	const state = { expanded: false };
	const group = new ToolGroup(rows, rows, state, paint, () => {});
	assert.equal(group.render(120)[1], " ⦁ read 2 · bash 1");
	assert.doesNotMatch(group.render(120)[1], /工具|展开|收起|失败|执行中|运行中|未完成|\x1b/);
	state.expanded = true;
	const opened = new ToolGroup(rows, rows, state, paint, () => {});
	assert.match(opened.render(120)[1], /^ ⦁ read 2 · bash 1$/);
	assert.deepEqual(opened.render(120).slice(2), [" ├ read: compact", " ├ bash: compact", " └ read: compact"]);
	assert.ok(colors.length > 0);
	assert.ok(colors.every((color) => color === "muted"));
});

function harness() {
	const handlers = new Map<string, Function>();
	let command: Function;
	const notices: string[] = [];
	const widgets: { dispose?(): void }[] = [];
	const chat = new Container(), document = new Container();
	document.addChild(chat);
	let repaints = 0;
	const tui = { children: [document], requestRender: () => { repaints++; } };
	const ctx = {
		mode: "tui", ui: {
			theme,
			notify: (message: string) => notices.push(message),
			setWidget: (_key: string, factory: Function) => widgets.push(factory(tui)),
		},
	};
	toolGroups({
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand: (_name: string, options: { handler: Function }) => { command = options.handler; },
	} as unknown as ExtensionAPI);
	return { chat, ctx, widgets, notices, tui, emit: (event: string, value = {}) => handlers.get(event)!(value, ctx), command: (args: string) => command!(args, ctx), repaints: () => repaints };
}

test("native chat render and mouse routing, keyboard commands, execution updates and cleanup", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	const read = row("read"), code = row("codemode");
	read.result = undefined;
	h.chat.addChild(read);
	h.chat.addChild(code);
	const originalChildren = h.chat.children;
	h.emit("session_start");
	const wrapper = h.chat.render;
	const beforeStart = h.repaints();
	h.emit("tool_execution_start", { toolCallId: "read" });
	assert.equal(h.repaints(), beforeStart + 1);
	h.emit("tool_execution_start", { toolCallId: "codemode/1", parentToolCallId: "codemode" });
	assert.equal(h.repaints(), beforeStart + 1, "nested calls do not request a group repaint");
	assert.equal(h.chat.render(120)[0], "read: compact");
	assert.doesNotMatch(h.chat.render(120).join("\n"), /执行中|运行中/);
	assert.equal(h.chat.children, originalChildren);
	h.chat.handleMouse(click(2));
	assert.match(h.chat.render(120).join("\n"), /codemode: compact/);
	h.chat.handleMouse(click(3));
	assert.equal(code.expanded, true);
	await h.command("collapse");
	assert.equal(h.chat.render(120)[0], "read: compact");
	const beforeEnd = h.repaints();
	read.result = { isError: false };
	h.emit("tool_execution_end", { toolCallId: "read" });
	assert.equal(h.repaints(), beforeEnd + 1);
	assert.equal(h.chat.render(120)[0], "read: compact");
	t.mock.timers.tick(1000);
	assert.equal(h.chat.render(120).length, 2);
	assert.doesNotMatch(h.chat.render(120)[1], /执行中/);
	await h.command("expand");
	assert.match(h.chat.render(120).join("\n"), /codemode: full result/);
	h.emit("tool_execution_end", { toolCallId: "read" });
	read.result = { isError: true };
	assert.doesNotMatch(h.chat.render(120)[1], /失败/);
	h.emit("agent_end");
	assert.ok(h.repaints() > 0);
	await h.command("off");
	assert.deepEqual(h.chat.render(120), ["read: compact", "codemode: full result"]);
	await h.command("on");
	assert.match(h.chat.render(120)[1], /read 1 · codemode 1/);
	await h.command("invalid");
	assert.match(h.notices.at(-1)!, /用法/);
	h.emit("session_start");
	assert.equal(h.chat.render, wrapper, "no wrapper stacking on session reload");
	h.widgets[0].dispose?.();
	assert.match(h.chat.render(120)[1], /read 1 · codemode 1/, "old widget disposal does not disable a new binding");
	h.emit("session_shutdown");
	assert.deepEqual(h.chat.render(120), ["read: compact", "codemode: full result"]);
});

test("calls stay unfolded while running and fold independently 1000ms after completion", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	h.chat.addChild(row("read"));
	h.chat.addChild(row("bash"));
	h.emit("session_start");
	for (const toolCallId of ["read", "bash"]) h.emit("tool_execution_start", { toolCallId });
	t.mock.timers.tick(3000);
	assert.deepEqual(h.chat.render(120), ["read: compact", "bash: compact"]);
	h.emit("tool_execution_end", { toolCallId: "read" });
	t.mock.timers.tick(999);
	assert.deepEqual(h.chat.render(120), ["read: compact", "bash: compact"]);
	const before = h.repaints();
	t.mock.timers.tick(1);
	assert.equal(h.repaints(), before + 1);
	assert.deepEqual(h.chat.render(120), ["", " ⦁ read 1", "bash: compact"]);
	h.emit("tool_execution_end", { toolCallId: "bash" });
	h.emit("agent_end");
	t.mock.timers.tick(999);
	assert.deepEqual(h.chat.render(120), ["", " ⦁ read 1", "bash: compact"]);
	h.emit("tool_execution_end", { toolCallId: "bash" });
	t.mock.timers.tick(1);
	assert.deepEqual(h.chat.render(120), ["", " ⦁ read 1 · bash 1"]);
	h.emit("session_shutdown");
});

test("manual expansion survives delayed folding and restarting cancels the previous timer", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	h.chat.addChild(row("read"));
	h.emit("session_start");
	h.emit("tool_execution_start", { toolCallId: "read" });
	await h.command("expand");
	h.emit("tool_execution_end", { toolCallId: "read" });
	t.mock.timers.tick(1000);
	assert.deepEqual(h.chat.render(120).slice(2), [" └ read: compact"]);
	await h.command("collapse");
	assert.equal(h.chat.render(120).length, 2);
	h.emit("tool_execution_start", { toolCallId: "read" });
	assert.deepEqual(h.chat.render(120), ["read: compact"]);
	await h.command("collapse");
	assert.deepEqual(h.chat.render(120), ["read: compact"]);
	h.emit("tool_execution_end", { toolCallId: "read" });
	t.mock.timers.tick(100);
	h.emit("tool_execution_start", { toolCallId: "read" });
	t.mock.timers.tick(1000);
	assert.deepEqual(h.chat.render(120), ["read: compact"]);
	h.emit("tool_execution_end", { toolCallId: "read" });
	t.mock.timers.tick(1000);
	assert.equal(h.chat.render(120).length, 2);
	h.emit("session_shutdown");
});

test("reload, shutdown and widget disposal clear active calls and pending timers", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	for (const ended of [false, true]) for (const cleanup of ["session_start", "session_shutdown", "dispose"]) {
		const h = harness();
		h.chat.addChild(row("read"));
		h.emit("session_start");
		h.emit("tool_execution_start", { toolCallId: "read" });
		assert.deepEqual(h.chat.render(120), ["read: compact"]);
		if (ended) h.emit("tool_execution_end", { toolCallId: "read" });
		if (cleanup === "dispose") h.widgets[0].dispose?.(); else h.emit(cleanup);
		const before = h.repaints();
		t.mock.timers.tick(1000);
		assert.equal(h.repaints(), before, cleanup);
		if (cleanup === "session_start") assert.equal(h.chat.render(120).length, 2);
		else assert.deepEqual(h.chat.render(120), ["read: compact"]);
		h.emit("session_shutdown");
	}
});

test("new calls join an opened group without changing its expansion state", () => {
	const h = harness();
	h.chat.addChild(row("read"));
	h.emit("session_start");
	h.chat.render(120);
	h.chat.handleMouse(click(1));
	h.chat.addChild(row("bash"));
	h.chat.addChild(row("codemode"));
	const lines = h.chat.render(120);
	assert.equal(lines[1], " ⦁ read 1 · bash 1 · codemode 1");
	assert.deepEqual(lines.slice(2), [" ├ read: compact", " ├ bash: compact", " └ codemode: compact"]);
	h.emit("session_shutdown");
});

test("an earlier finishing tool preserves a later group's manual expansion", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness(), read = row("read"), bash = row("bash");
	read.result = undefined;
	h.chat.addChild(read); h.chat.addChild(bash);
	h.emit("session_start");
	h.emit("tool_execution_start", { toolCallId: "read" });
	h.chat.render(120);
	h.chat.handleMouse(click(2));
	assert.match(h.chat.render(120).join("\n"), /bash: compact/);
	read.result = { isError: false };
	h.emit("tool_execution_end", { toolCallId: "read" });
	t.mock.timers.tick(1000);
	assert.deepEqual(h.chat.render(120), ["", " ⦁ read 1 · bash 1", " ├ read: compact", " └ bash: compact"]);
	h.chat.handleMouse(click(1));
	assert.deepEqual(h.chat.render(120), ["", " ⦁ read 1 · bash 1"]);
	await h.command("expand");
	assert.match(h.chat.render(120).join("\n"), /bash: compact/);
	h.emit("session_shutdown");
});

test("render errors restore original children; silent mode does not leak group summaries", () => {
	const silentKey = Symbol.for("pi-compact-tools.silent.state");
	const global = globalThis as typeof globalThis & { [silentKey]?: { active: boolean; enabled: boolean } };
	const previous = global[silentKey];
	const h = harness();
	const read = row("read");
	h.chat.addChild(read);
	const children = h.chat.children;
	try {
		global[silentKey] = { active: true, enabled: true };
		h.emit("session_start");
		assert.deepEqual(h.chat.render(120), ["read: compact"], "silent mode's own renderer remains responsible for hiding rows");
		global[silentKey].enabled = false;
		assert.match(h.chat.render(120)[1], / ⦁ read/);
		read.render = () => { throw new Error("render failed"); };
		h.command("expand");
		assert.throws(() => h.chat.render(120), /render failed/);
		assert.equal(h.chat.children, children);
	} finally {
		h.emit("session_shutdown");
		if (previous === undefined) delete global[silentKey]; else global[silentKey] = previous;
	}
});

test("non-TUI sessions remain untouched and unsupported layouts fall back safely", () => {
	const h = harness();
	h.ctx.mode = "rpc";
	h.emit("session_start");
	assert.equal(h.widgets.length, 0);
	h.ctx.mode = "tui";
	h.tui.children = [];
	h.emit("session_start");
	assert.match(h.notices[0], /布局不受支持/);
});
