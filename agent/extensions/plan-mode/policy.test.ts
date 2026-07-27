import assert from "node:assert/strict";
import test from "node:test";
import { classifyBashCommand, classifyTool, planningToolSet, tokenizeShellWords } from "./policy.ts";
import { DEFAULT_CONFIG, type PlanModeConfig } from "./types.ts";

const config: PlanModeConfig = structuredClone(DEFAULT_CONFIG);

test("default policy allows known reads and denies mutations and unknown tools", () => {
	assert.equal(config.unknownTools, "deny");
	assert.equal(classifyTool("read", config).action, "allow");
	assert.equal(classifyTool("edit", config).action, "deny");
	assert.equal(classifyTool("write", config).action, "deny");
	assert.equal(classifyTool("edit", { ...config, tools: { edit: "allow" } }).action, "deny");
	assert.equal(classifyTool("custom_tool", config).action, "deny");
});

test("planning tool set advertises allowed and confirmable tools", () => {
	assert.deepEqual(planningToolSet(["read", "bash", "edit", "custom_tool"], config), [
		"read",
		"bash",
		"plan_question",
		"propose_plan",
	]);
	assert.deepEqual(
		planningToolSet(["read", "custom_tool"], { ...config, unknownTools: "ask" }),
		["read", "custom_tool", "plan_question", "propose_plan"],
	);
	assert.equal(planningToolSet(["read", "bash"], { ...config, shellPolicy: "strict" }).includes("bash"), false);
	assert.equal(planningToolSet(["read", "bash"], { ...config, tools: { bash: "deny" } }).includes("bash"), false);
});

test("shell tokenizer handles quotes and rejects incomplete input", () => {
	assert.deepEqual(tokenizeShellWords("git -C 'a b' status --short"), ["git", "-C", "a b", "status", "--short"]);
	assert.equal(tokenizeShellWords("rg 'unfinished"), null);
});

test("inspection commands are conservatively allowed", () => {
	assert.equal(classifyBashCommand("rg -n plan src").action, "allow");
	assert.equal(classifyBashCommand("git status --short").action, "allow");
	assert.equal(classifyBashCommand("git -C repo diff --stat").action, "allow");
	assert.equal(classifyBashCommand("find . -name '*.ts'").action, "allow");
});

test("shell composition and mutating command variants are denied", () => {
	for (const command of [
		"ls; rm -rf .",
		"rg x | tee out",
		"echo $(touch out)",
		"find . -delete",
		"find . -fprint0 output",
		"date --set=tomorrow",
		"file --compile",
		"git diff --output=patch.txt",
		"git grep --open-files-in-pager pattern",
		"git grep --open-files-in-pager=less pattern",
		"rg --pre ./script pattern",
		"python -c 'open(\"x\",\"w\").write(\"x\")'",
	]) {
		assert.equal(classifyBashCommand(command).action, "deny", command);
	}
});

test("tests, builds, native search, and wget are denied", () => {
	for (const command of [
		"npm test",
		"pnpm build",
		"cargo check",
		"wget https://example.com",
		"node /Users/me/.pi/agent/skills/native-web-search/search.mjs query",
	]) {
		assert.equal(classifyBashCommand(command).action, "deny", command);
	}
	assert.equal(
		classifyBashCommand("npm test").reason,
		"tests/builds may modify state and are disabled in Plan Mode",
	);
});

test("curl permits only narrow read-only HTTPS requests with approval", () => {
	assert.deepEqual(classifyBashCommand("curl -s -S -f -L -I --compressed https://example.com https://example.org"), {
		action: "ask",
		reason: "read-only HTTPS request requires explicit approval",
	});
	for (const command of [
		"curl http://example.com",
		"curl -sS https://example.com",
		"curl -o out https://example.com",
		"curl --output=out https://example.com",
		"curl -X POST https://example.com",
		"curl --data x https://example.com",
		"curl --config settings https://example.com",
		"curl -s",
	]) {
		const decision = classifyBashCommand(command);
		assert.equal(decision.action, "deny", command);
		assert.equal(decision.reason, "curl options are outside the read-only HTTPS allowlist", command);
	}
});
