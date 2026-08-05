import assert from "node:assert/strict";
import test from "node:test";
import { classifyBashCommand, classifyTool, reasoningToolSet, tokenizeShellWords } from "./policy.ts";
import { DEFAULT_CONFIG, type ReasoningModeConfig } from "./types.ts";

const config: ReasoningModeConfig = structuredClone(DEFAULT_CONFIG);

test("known read tools and questionnaire are allowed while mutations and unknown tools fail closed", () => {
	assert.equal(classifyTool("read", config).action, "allow");
	assert.equal(classifyTool("questionnaire", config).action, "allow");
	assert.equal(classifyTool("submit_plan", config).action, "allow");
	assert.equal(classifyTool("edit", { ...config, tools: { edit: "allow" } }).action, "deny");
	assert.equal(classifyTool("write", config).action, "deny");
	assert.equal(classifyTool("custom", config).action, "deny");
});

test("Reasoning tool set scopes TUI-only tools and respects strict shell policy", () => {
	const all = ["read", "bash", "edit", "write", "grep", "find", "ls", "questionnaire", "submit_plan"];
	assert.deepEqual(reasoningToolSet(["read", "bash", "edit"], all, config, "tui", "plan"), [
		"read", "bash", "grep", "find", "ls", "questionnaire", "submit_plan",
	]);
	assert.deepEqual(reasoningToolSet(["read", "bash", "edit"], all, config, "tui", "explore"), [
		"read", "bash", "grep", "find", "ls", "questionnaire",
	]);
	assert.deepEqual(reasoningToolSet(["read", "bash", "questionnaire", "submit_plan"], all, config, "rpc", "plan"), [
		"read", "bash", "grep", "find", "ls",
	]);
	assert.equal(reasoningToolSet(["read", "bash"], all, { ...config, shellPolicy: "strict" }, "tui", "plan").includes("bash"), false);
});

test("shell tokenizer handles quotes and rejects incomplete input", () => {
	assert.deepEqual(tokenizeShellWords("git -C 'a b' status --short"), ["git", "-C", "a b", "status", "--short"]);
	assert.equal(tokenizeShellWords("rg 'unfinished"), null);
});

test("inspection commands are conservatively allowed", () => {
	for (const command of ["rg -n plan src", "git status --short", "git -C repo diff --stat", "git blame file.ts", "find . -name '*.ts'"]) {
		assert.equal(classifyBashCommand(command).action, "allow", command);
	}
});

test("shell composition, mutations, tests, builds, and native search are denied", () => {
	for (const command of [
		"ls; rm -rf .", "rg x | tee out", "echo $(touch out)", "find . -delete", "git diff --output=patch.txt",
		"python -c 'open(\"x\",\"w\").write(\"x\")'", "npm test", "cargo check", "wget https://example.com",
		"node /Users/me/.pi/agent/skills/native-web-search/search.mjs query",
	]) assert.equal(classifyBashCommand(command).action, "deny", command);
});

test("curl permits only narrow HTTPS reads with confirmation", () => {
	assert.deepEqual(classifyBashCommand("curl -s -S -f -L -I --compressed https://example.com"), {
		action: "ask",
		reason: "read-only HTTPS request requires explicit approval",
	});
	for (const command of ["curl http://example.com", "curl -sS https://example.com", "curl -o out https://example.com", "curl -X POST https://example.com"]) {
		assert.equal(classifyBashCommand(command).action, "deny", command);
	}
});
