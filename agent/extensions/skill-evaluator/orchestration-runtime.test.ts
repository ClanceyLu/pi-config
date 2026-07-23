import assert from "node:assert/strict";
import test from "node:test";
import { EvaluationRuntime } from "./orchestration-runtime.ts";
import { TOOL_NAMES } from "./orchestration-prompts.ts";

function context() {
	return {
		mode: "tui", cwd: process.cwd(), model: { provider: "test", id: "current" },
		sessionManager: { getSessionId: () => "session-1" },
		isProjectTrusted: () => false,
		ui: {
			notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined,
		},
	} as any;
}

test("orchestration exposes only evaluator tools while untrusted Skill data is in context", async () => {
	const active = ["read", "bash", "write"];
	const toolSets: string[][] = [];
	let sent = "";
	const pi = {
		getActiveTools: () => active,
		setActiveTools: (tools: string[]) => toolSets.push([...tools]),
		getThinkingLevel: () => "high",
		getCommands: () => [],
		sendUserMessage: (message: string) => { sent = message; },
	} as any;
	const runtime = new EvaluationRuntime(pi);
	const ctx = context();
	runtime.startCommand("evaluate a remote Skill", ctx);
	assert.deepEqual(toolSets[0], [...TOOL_NAMES]);
	assert.match(sent, /prepare_skill_evaluation/);
	await runtime.onAgentSettled(ctx);
	assert.deepEqual(toolSets.at(-1), active);
	assert.equal(runtime.current, undefined);
});
