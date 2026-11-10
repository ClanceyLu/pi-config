import assert from "node:assert/strict";
import test from "node:test";
import type { TUI, Terminal } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import "./pi-runtime.mjs";
const { Container, ScrollView, VStack, TuiAltScreen, TuiMainScreen, visibleWidth } = await import("@earendil-works/pi-tui");
const { default: extension, isReadingHistory, userTextAtViewport } = await import("../last-user-message.ts");

// Test the installed Pi components, including their padding and Markdown wrapping.
const agentDist = new URL("./", import.meta.resolve("@earendil-works/pi-coding-agent"));
const { UserMessageComponent } = await import(new URL("modes/interactive/components/user-message.js", agentDist).href);
const { initTheme } = await import(new URL("modes/interactive/theme/theme.js", agentDist).href);
initTheme("dark", false);

const document = { render: () => Array(100).fill("history"), invalidate() {} };
const context = (messages: unknown[]) => ({ sessionManager: {
	getBranch: () => messages.map((message) => ({ type: "message", message })),
	getSessionId: () => "session", getLeafId: () => String(messages.length), getEntryCount: () => messages.length,
} }) as unknown as ExtensionContext;

test("real fullscreen ScrollView tracks history and returning to the bottom", () => {
	const transcript = new ScrollView(document, { primary: true, follow: "end" });
	const tui = { mode: "fullscreen", layoutRoot: new VStack([transcript]) } as unknown as TUI;
	transcript.updateLayout(100, 20, () => {});
	assert.equal(isReadingHistory(tui), false);
	transcript.scrollBy(-10);
	assert.equal(isReadingHistory(tui), true);
	transcript.updateLayout(110, 20, () => {});
	assert.equal(isReadingHistory(tui), true);
	transcript.scrollToEnd();
	assert.equal(isReadingHistory(tui), false);
	assert.equal(isReadingHistory({ mode: "regular" } as TUI), false);
	assert.equal(isReadingHistory({ mode: "fullscreen" } as TUI), false);
});

function renderer() {
	const terminal = { columns: 40, rows: 12, write() {}, hideCursor() {} } as Terminal;
	const tui = new TuiAltScreen(terminal);
	// Render real frames without enabling terminal modes or scheduling background work.
	tui.requestRender = () => {};
	const internal = tui as any;
	internal.stopped = false;
	internal.altScreenActive = true;
	return { tui, internal, frame: () => internal.doRender() };
}

function load(tui: TUI, messages = [{ role: "user", content: "最新消息" }]) {
	let start: Function;
	extension({ on: (_name: string, handler: Function) => { start = handler; } } as unknown as ExtensionAPI);
	let widget: any;
	const ctx = context(messages);
	Object.assign(ctx, { mode: "tui", ui: { setWidget(_key: string, factory: Function) {
		widget = factory(tui, { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text });
	} } });
	start!({}, ctx);
	return widget;
}

test("fixed row keeps overlay stack empty, scrollbar and transcript selection available", () => {
	const { tui, internal, frame } = renderer();
	const user = new UserMessageComponent("最新消息");
	const chat = new Container();
	chat.addChild(user);
	chat.addChild(document);
	const transcript = new ScrollView(chat, { primary: true, follow: "end", scrollbar: "always" });
	const root = new VStack([{ component: transcript, basis: 0, grow: 1 }]);
	tui.setLayoutRoot(root);
	const messages = [{ role: "user", content: "最新消息" }];
	const widget = load(tui, messages);
	frame();
	assert.equal(tui.hasOverlayEntries, false);
	assert.doesNotMatch(tui.getScreenLines()[0], /最新消息/);
	transcript.scrollBy(-5);
	frame();
	assert.match(tui.getScreenLines()[0], /^ 最新消息/);
	assert.equal(transcript.viewportHeight, 11);
	assert.equal(tui.hasOverlayEntries, false);
	assert.equal(tui.hasOverlay(), false);
	assert.equal(internal.getScrollbarTargetAt(39, 3)?.scrollView, transcript);
	internal.handleMouseEvent({ x: 2, y: 3, button: 0, release: false });
	assert.equal(internal.selectionAnchor?.scrollView, transcript);
	const beforeSelectionScroll = transcript.scrollTop;
	internal.updateSelectionAutoScroll({ x: 2, y: 11 });
	internal.autoScrollSelection();
	internal.stopSelectionAutoScroll();
	assert.ok(transcript.scrollTop > beforeSelectionScroll);
	internal.handleMouseEvent({ x: 2, y: 3, button: 0, release: true });
	chat.removeChild(user);
	chat.children.unshift(new UserMessageComponent("新的问题"));
	frame();
	assert.match(tui.getScreenLines()[0], /新的问题/);
	for (const width of [1, 4, 10, 40]) {
		(internal.terminal as { columns: number }).columns = width;
		frame();
		assert.ok(visibleWidth(tui.getScreenLines()[0]) <= width);
	}
	internal.terminal.columns = 40;
	transcript.scrollToEnd();
	frame();
	assert.doesNotMatch(tui.getScreenLines()[0], /新的问题/);
	assert.equal(transcript.viewportHeight, 12);
	widget.dispose();
	assert.equal(internal.layoutRoot, root);
	internal.stopped = true;
});

test("widget remounts after regular/fullscreen renderer replacement and disposes cleanly", () => {
	const first = renderer();
	const second = renderer();
	const makeRoot = () => new VStack([new ScrollView(document, { primary: true, follow: "end" })]);
	const firstRoot = makeRoot();
	const secondRoot = makeRoot();
	first.tui.setLayoutRoot(firstRoot);
	second.tui.setLayoutRoot(secondRoot);
	let current: TUI = first.tui;
	const stable = new Proxy({} as TUI, { get(_target, key) {
		const value = Reflect.get(current, key, current);
		return typeof value === "function" ? value.bind(current) : value;
	} });
	const widget = load(stable);
	assert.equal(first.tui.hasOverlayEntries, false);
	current = new TuiMainScreen(first.tui.terminal);
	assert.deepEqual(widget.render(40), []);
	assert.equal((current as TuiMainScreen).hasOverlayEntries, false);
	current = second.tui;
	widget.render(40);
	const wrapper = second.internal.layoutRoot;
	assert.notEqual(wrapper, secondRoot);
	widget.render(40);
	assert.equal(second.internal.layoutRoot, wrapper);
	assert.equal(second.tui.hasOverlayEntries, false);
	widget.dispose();
	assert.equal(second.internal.layoutRoot, secondRoot);
	first.internal.stopped = second.internal.stopped = true;
});

test("pinned message follows earlier turns, wrapping, branches and exact message boundaries", () => {
	const { tui, internal, frame } = renderer();
	const chat = new Container();
	const header = { render: () => ["header", ""], invalidate() {} };
	const first = new UserMessageComponent("第一条问题：" + "长消息".repeat(30));
	const second = new UserMessageComponent("第二条问题");
	const third = new UserMessageComponent("第三条问题");
	const reply = { render: () => Array(20).fill("answer"), invalidate() {} };
	chat.addChild(header);
	for (const user of [first, second, third]) { chat.addChild(user); chat.addChild(reply); }
	const transcript = new ScrollView(chat, { primary: true, follow: "end", scrollbar: "always" });
	tui.setLayoutRoot(new VStack([{ component: transcript, basis: 0, grow: 1 }]));
	const widget = load(tui);
	frame();
	for (const width of [40, 16]) {
		internal.terminal.columns = width;
		frame();
		const contentWidth = transcript.getContentWidth(width);
		const secondRow = 2 + first.render(contentWidth).length + 20;
		const thirdRow = secondRow + second.render(contentWidth).length + 20;
		for (const [position, expected] of [
			[thirdRow + 2, "第三条问题"],
			[thirdRow - 1, "第二条问题"],
			[secondRow, "第二条问题"],
			[secondRow - 1, "第一条问题"],
			[3, "第一条问题"],
			[secondRow + 3, "第二条问题"],
		] as const) {
			transcript.scrollTo(position);
			frame();
			assert.ok(userTextAtViewport(tui).startsWith(expected));
			assert.ok(tui.getScreenLines()[0].includes(expected));
		}
	}
	transcript.scrollToStart();
	frame();
	assert.equal(userTextAtViewport(tui), "");
	assert.match(tui.getScreenLines()[0], /header/);
	chat.clear();
	chat.addChild(new UserMessageComponent("分支上的问题"));
	chat.addChild(reply);
	frame();
	transcript.scrollTo(3);
	frame();
	assert.match(tui.getScreenLines()[0], /分支上的问题/);
	transcript.scrollToEnd();
	frame();
	assert.equal(isReadingHistory(tui), false);
	widget.dispose();
	internal.stopped = true;
});


test("resize and content collapse schedule a corrective frame and restore layout hooks on disposal", () => {
	for (const change of ["resize", "collapse"]) {
		const { tui, internal, frame } = renderer();
		let queued = false;
		tui.requestRender = () => { queued = true; };
		const chat = new Container();
		chat.addChild(new UserMessageComponent("resize question"));
		chat.addChild(document);
		const transcript = new ScrollView(chat, { primary: true, follow: "end" });
		const original = transcript.updateLayout;
		tui.setLayoutRoot(new VStack([{ component: transcript, basis: 0, grow: 1 }]));
		const widget = load(tui);
		frame();
		transcript.scrollBy(-5);
		frame();
		assert.match(tui.getScreenLines()[0], /^ resize question/);
		queued = false;
		if (change === "resize") internal.terminal.rows = 200;
		else chat.removeChild(document);
		frame();
		assert.equal(isReadingHistory(tui), false);
		assert.equal(queued, true, "layout state change must request its own corrective frame");
		queued = false;
		frame();
		assert.equal(tui.getScreenLines()[0].startsWith(" resize question"), false);
		assert.equal(queued, false, "corrective frame must settle without a render loop");
		widget.dispose();
		assert.equal(transcript.updateLayout, original);
		internal.stopped = true;
	}
});

test("skill-only invocations and skills with follow-up text start their own user turns", async () => {
	const { SkillInvocationMessageComponent } = await import(new URL("modes/interactive/components/skill-invocation-message.js", agentDist).href);
	for (const userMessage of ["", "请检查这次修改"]) {
		const { tui, internal, frame } = renderer();
		const chat = new Container();
		const old = new UserMessageComponent("previous question");
		chat.addChild(old);
		chat.addChild(document);
		const skill = new SkillInvocationMessageComponent({ name: "review", path: "/tmp/review/SKILL.md", content: "review instructions", userMessage });
		chat.addChild(skill);
		if (userMessage) chat.addChild(new UserMessageComponent(userMessage));
		chat.addChild(document);
		const transcript = new ScrollView(chat, { primary: true, follow: "end" });
		tui.setLayoutRoot(new VStack([{ component: transcript, basis: 0, grow: 1 }]));
		const widget = load(tui);
		frame();
		const skillStart = old.render(40).length + 100;
		const expected = userMessage || "/skill:review";
		for (const offset of [0, skill.render(40).length + 3]) {
			transcript.scrollTo(skillStart + offset);
			frame();
			assert.equal(userTextAtViewport(tui), expected);
			assert.ok(tui.getScreenLines()[0].includes(expected));
		}
		transcript.scrollTo(skillStart - 1);
		frame();
		assert.equal(userTextAtViewport(tui), "previous question");
		widget.dispose();
		internal.stopped = true;
	}
});
