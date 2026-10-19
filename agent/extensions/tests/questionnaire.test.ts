import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import questionnaire from "../questionnaire.ts";

function open(questions: unknown[]) {
	let tool: any;
	let component: any;
	const tui = { terminal: { rows: 20 }, requestRender() {} };
	const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
	questionnaire({ registerTool: (value: unknown) => { tool = value; } } as unknown as ExtensionAPI);
	const result = tool.execute("test", { questions }, undefined, undefined, {
		mode: "tui",
		ui: { custom: (factory: Function) => new Promise((resolve) => {
			component = factory(tui, theme, {}, resolve);
			component.focused = true;
		}) },
	});
	return { tui, component, result };
}

const options = Array.from({ length: 20 }, (_, i) => ({
	value: `value-${i}`, label: `选项 ${i}`, description: "详细说明 ".repeat(30),
}));

function checkSize(component: any, rows: number, width = 50) {
	const lines: string[] = component.render(width);
	assert.ok(lines.length <= rows - 5);
	for (const line of lines) assert.ok(visibleWidth(line) <= width);
	return lines.join("\n");
}

test("long questionnaires keep the selected option visible and allow reading the full prompt", async () => {
	const { tui, component, result } = open([{ id: "q", prompt: "问题内容\n".repeat(60), options, allowOther: false }]);
	assert.match(checkSize(component, tui.terminal.rows), /> 1\. 选项 0/);
	for (let i = 0; i < 19; i++) {
		component.handleInput("\u001b[B");
		assert.match(checkSize(component, tui.terminal.rows), new RegExp(`> ${i + 2}\\. 选项 ${i + 1}`));
	}
	for (let i = 0; i < 100; i++) component.handleInput("\u0010"); // Ctrl+P
	const top = checkSize(component, tui.terminal.rows);
	assert.match(top, /问题内容/);
	assert.match(top, /Ctrl\+P\/N scroll/);
	component.handleInput("\u000e"); // Ctrl+N
	const next = checkSize(component, tui.terminal.rows);
	assert.notEqual(next, top);
	component.handleInput("\u001b[5~");
	assert.equal(checkSize(component, tui.terminal.rows), top);
	component.handleInput("\u001b[6~");
	assert.equal(checkSize(component, tui.terminal.rows), next);
	component.handleInput("\u001b[A");
	assert.match(checkSize(component, tui.terminal.rows), /> 19\. 选项 18/);
	tui.terminal.rows = 12;
	assert.match(checkSize(component, tui.terminal.rows, 24), /> 19\. 选项 18/);
	component.handleInput("\r");
	assert.equal((await result).details.answers[0].value, "value-18");
});

test("custom input remains visible after long content and preserves the submitted answer", async () => {
	const { tui, component, result } = open([{ id: "q", prompt: "很长的问题 ".repeat(100), options: options.slice(0, 1) }]);
	component.handleInput("\u001b[B");
	assert.match(checkSize(component, tui.terminal.rows), /> 2\. Type something/);
	component.handleInput("\r");
	component.handleInput("hello");
	const input = checkSize(component, tui.terminal.rows);
	assert.match(input, /hello/);
	component.handleInput("\u0010");
	assert.notEqual(checkSize(component, tui.terminal.rows), input);
	component.handleInput("\u000e");
	component.handleInput("!");
	assert.match(checkSize(component, tui.terminal.rows), /hello!/);
	component.handleInput("\r");
	assert.equal((await result).details.answers[0].value, "hello!");
});

test("tab navigation resets the viewport for the next question and submission", async () => {
	const { tui, component, result } = open([
		{ id: "q1", prompt: "长问题\n".repeat(60), options, allowOther: false },
		{ id: "q2", prompt: "下一题", options: [{ value: "ok", label: "确定" }], allowOther: false },
	]);
	checkSize(component, tui.terminal.rows);
	component.handleInput("\r");
	assert.match(checkSize(component, tui.terminal.rows), /下一题/);
	component.handleInput("\r");
	assert.match(checkSize(component, tui.terminal.rows), /Ready to submit/);
	component.handleInput("\r");
	assert.equal((await result).details.answers.length, 2);
});
