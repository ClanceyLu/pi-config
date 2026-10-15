import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import toolGroups, { groupTools, ToolGroup, type ToolRow } from "../tool-groups.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
const click = (y: number, height = 10) => ({ type: "click", button: "left", x: 0, y, width: 120, height } as TuiMouseEvent);

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
	const build = () => new ToolGroup(rows, rows, state, theme, new Set(), () => repaints++);
	let group = build();
	assert.deepEqual(group.render(120), ["", "▸ 工具 2 · read 1 · codemode 1 （展开）"]);
	assert.equal(read.renders, 0, "folded results are not rendered");
	assert.equal(group.handleMouse(click(0, 2)), undefined, "blank separator is not clickable");
	assert.equal(state.expanded, false);
	assert.equal(group.handleMouse(click(1))?.handled, true);
	assert.equal(repaints, 1);
	group = build();
	assert.deepEqual(group.render(120).slice(2), ["read: compact", "codemode: compact"]);
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
	const group = new ToolGroup(rows, rows, { expanded: false }, styled, new Set(), () => {});
	for (const width of [0, 1, 2, 5, 10, 20, 80]) {
		const lines = group.render(width);
		assert.equal(lines.length, 2);
		for (const line of lines) assert.ok(visibleWidth(line) <= width);
	}
	assert.equal(group.render(80)[0], "");
	assert.match(group.render(80)[1], /▸ 工具 1/);
});

test("folded groups show only active calls, then hide each finished call without changing manual expansion", () => {
	const read = row("read"), bash = row("bash"), done = row("edit");
	const rows = [done, read, bash];
	const members = [done, new Spacer(1), thinking(), read, bash];
	const running = new Set([read.toolCallId, bash.toolCallId]);
	const state = { expanded: false };
	const build = () => new ToolGroup(rows, members, state, theme, running, () => {});
	assert.deepEqual(build().render(120).slice(2), ["read: compact", "bash: compact"]);
	assert.equal(done.renders, 0);
	running.delete(read.toolCallId);
	read.result = { isError: true };
	assert.deepEqual(build().render(120).slice(2), ["bash: compact"]);
	running.clear();
	assert.equal(build().render(120).length, 2);
	assert.equal(state.expanded, false);
	state.expanded = true;
	assert.match(build().render(120).join("\n"), /edit: compact/);
	running.add(read.toolCallId);
	assert.equal(build().render(120).filter((line) => line === "read: compact").length, 1);
	running.clear();
	assert.match(build().render(120).join("\n"), /read: compact/);
});

test("summary keeps running, failed and incomplete calls visible, including restored calls without results", () => {
	const read = row("read"), bash = row("bash"), code = row("codemode");
	read.result = undefined;
	bash.result = { isError: true };
	code.result = undefined;
	const running = new Set([read.toolCallId]);
	const rows = [read, bash, code];
	const colors: string[] = [];
	const paint = { ...theme, fg: (color: string, text: string) => { colors.push(color); return text; } } as Theme;
	const state = { expanded: false };
	const group = new ToolGroup(rows, rows, state, paint, running, () => {});
	assert.equal(group.render(120)[1], "▸ 工具 3 · read 1 · bash 1 · codemode 1 · 1 执行中 · 1 失败 · 1 未完成 （展开）");
	running.clear();
	assert.match(group.render(120)[1], /1 失败 · 2 未完成/);
	assert.doesNotMatch(group.render(120)[1], /执行中|\x1b/);
	state.expanded = true;
	assert.match(group.render(120)[1], /^▾ 工具 3.*（收起）$/);
	state.expanded = false;
	for (const call of rows) call.result = { isError: false };
	assert.equal(group.render(120)[1], "▸ 工具 3 · read 1 · bash 1 · codemode 1 （展开）");
	assert.ok(colors.length > 0);
	assert.ok(colors.every((color) => color === "muted"), "all summary statuses use non-emphasis styling");
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

test("native chat render and mouse routing, keyboard commands, execution updates and cleanup", async () => {
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
	assert.match(h.chat.render(120)[1], /1 执行中/);
	assert.deepEqual(h.chat.render(120).slice(2), ["read: compact"]);
	assert.equal(h.chat.children, originalChildren);
	h.chat.handleMouse(click(1));
	assert.match(h.chat.render(120).join("\n"), /codemode: compact/);
	h.chat.handleMouse(click(3));
	assert.equal(code.expanded, true);
	await h.command("collapse");
	assert.deepEqual(h.chat.render(120).slice(2), ["read: compact"]);
	const beforeEnd = h.repaints();
	h.emit("tool_execution_end", { toolCallId: "read" });
	assert.equal(h.repaints(), beforeEnd + 1);
	assert.deepEqual(h.chat.render(120).slice(2), ["read: compact"]);
	assert.doesNotMatch(h.chat.render(120)[1], /执行中/);
	await h.command("expand");
	assert.match(h.chat.render(120).join("\n"), /codemode: full result/);
	h.emit("tool_execution_end", { toolCallId: "read" });
	read.result = { isError: true };
	assert.match(h.chat.render(120)[1], /1 失败/);
	h.emit("agent_end");
	assert.ok(h.repaints() > 0);
	await h.command("off");
	assert.deepEqual(h.chat.render(120), ["read: compact", "codemode: full result"]);
	await h.command("on");
	assert.match(h.chat.render(120)[1], /工具 2/);
	await h.command("invalid");
	assert.match(h.notices.at(-1)!, /用法/);
	h.emit("session_start");
	assert.equal(h.chat.render, wrapper, "no wrapper stacking on session reload");
	h.widgets[0].dispose?.();
	assert.match(h.chat.render(120)[1], /工具 2/, "old widget disposal does not disable a new binding");
	h.emit("session_shutdown");
	assert.deepEqual(h.chat.render(120), ["read: compact", "codemode: full result"]);
});

test("finished calls remain visible for exactly 300ms independently, even after agent end", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	h.chat.addChild(row("read"));
	h.chat.addChild(row("bash"));
	h.emit("session_start");
	for (const toolCallId of ["read", "bash"]) h.emit("tool_execution_start", { toolCallId });
	h.emit("tool_execution_end", { toolCallId: "read" });
	t.mock.timers.tick(100);
	h.emit("tool_execution_end", { toolCallId: "bash" });
	h.emit("agent_end");
	assert.doesNotMatch(h.chat.render(120)[1], /执行中/);
	t.mock.timers.tick(199);
	assert.deepEqual(h.chat.render(120).slice(2), ["read: compact", "bash: compact"]);
	const before = h.repaints();
	t.mock.timers.tick(1);
	assert.equal(h.repaints(), before + 1);
	assert.deepEqual(h.chat.render(120).slice(2), ["bash: compact"]);
	t.mock.timers.tick(100);
	assert.equal(h.chat.render(120).length, 2);
	h.emit("session_shutdown");
});

test("delay expiry preserves manual expansion and restarting a call cancels its old timer", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	h.chat.addChild(row("read"));
	h.emit("session_start");
	h.emit("tool_execution_start", { toolCallId: "read" });
	h.emit("tool_execution_end", { toolCallId: "read" });
	await h.command("expand");
	t.mock.timers.tick(300);
	assert.deepEqual(h.chat.render(120).slice(2), ["read: compact"]);
	await h.command("collapse");
	assert.equal(h.chat.render(120).length, 2);
	h.emit("tool_execution_start", { toolCallId: "read" });
	h.emit("tool_execution_end", { toolCallId: "read" });
	t.mock.timers.tick(100);
	h.emit("tool_execution_start", { toolCallId: "read" });
	t.mock.timers.tick(300);
	assert.deepEqual(h.chat.render(120).slice(2), ["read: compact"]);
	assert.match(h.chat.render(120)[1], /1 执行中/);
	h.emit("session_shutdown");
});

test("reload, shutdown and widget disposal cancel pending collapse timers", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	for (const cleanup of ["session_start", "session_shutdown", "dispose"]) {
		const h = harness();
		h.chat.addChild(row("read"));
		h.emit("session_start");
		h.emit("tool_execution_start", { toolCallId: "read" });
		h.emit("tool_execution_end", { toolCallId: "read" });
		if (cleanup === "dispose") h.widgets[0].dispose?.(); else h.emit(cleanup);
		const before = h.repaints();
		t.mock.timers.tick(300);
		assert.equal(h.repaints(), before, cleanup);
		if (cleanup === "session_start") assert.equal(h.chat.render(120).length, 2);
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
	assert.equal(lines[1], "▾ 工具 3 · read 1 · bash 1 · codemode 1 （收起）");
	assert.deepEqual(lines.slice(2), ["read: compact", "bash: compact", "codemode: compact"]);
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
		assert.match(h.chat.render(120)[1], /工具 1/);
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
