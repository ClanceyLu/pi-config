import assert from "node:assert/strict";
import { readFile as realReadFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { mock, test } from "node:test";

// Only the schema builder is stubbed; import and execute the real extension,
// core, lifecycle handlers and on-disk Skill. No live CLI or network calls.
const schema = "export const Type = new Proxy({}, { get: () => (...args) => ({ args }) });";
const hooks = registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "typebox") return { url: "data:text/javascript," + encodeURIComponent(schema), shortCircuit: true };
		return next(specifier, context);
	},
});
let missingRules = false;
mock.module("node:fs/promises", {
	namedExports: {
		readFile: async (...args: Parameters<typeof realReadFile>) => {
			if (missingRules && String(args[0]).endsWith("/pm-mode/SKILL.md")) throw new Error("fixture: missing Skill");
			return realReadFile(...args);
		},
	},
});
const { default: pmMode } = await import("./index.ts");
hooks.deregister();

function harness(enabled = true, entries: any[] = []) {
	const handlers: Record<string, Function> = {};
	const commands: Record<string, any> = {};
	const calls: unknown[] = [];
	const pi = {
		registerFlag() {}, registerTool() {},
		registerCommand(name: string, command: any) { commands[name] = command; },
		getFlag(name: string) { return name === "pm" ? enabled : undefined; },
		on(name: string, handler: Function) { handlers[name] = handler; },
		appendEntry() {},
		exec(...args: unknown[]) { calls.push(args); throw new Error("Unexpected CLI execution"); },
	};
	pmMode(pi as any);
	const ctx = {
		cwd: process.cwd(), hasUI: false, sessionManager: { getBranch: () => entries },
		waitForIdle: async () => {}, ui: { notify() {} },
	};
	return { handlers, commands, calls, ctx };
}
function event(forced = false) {
	return { systemPrompt: "existing system prompt", systemPromptOptions: {
		sections: { existing: "retain", multica_mode: "stale", pm_mode: "stale" } as Record<string, string>,
		...(forced ? { forceSystemPrompt: "custom" } : {}),
	} };
}
const contracts = [
	["non-empty first commit", /first valid non-empty task commit/],
	["no placeholder", /empty branches get no placeholder commit or PR/],
	["reuse", /same verified branch\/worktree\/PR/],
	["publication review", /full remote-base diff and sensitive content/],
	["baseline authorization", /baseline work needs explicit publication authorization/],
	["prohibitions win", /Explicit prohibitions and stricter runtime rules win/],
	["ambiguous retry", /state reads before retry, never duplicate PRs or force/],
	["primary branch isolation", /No direct primary-branch push/],
	["no premature merge", /After explicit user acceptance and required checks, separately authorized merge uses the same PR/],
	["remote closure gate", /confirm the actual remote integration before permitted closure/],
	["no fake association", /URL alone is not formal platform association/],
] as const;

test("real resident and forced prompts expose the Draft PR contract without platform I/O", async () => {
	const h = harness();
	await h.handlers.session_start({}, h.ctx);
	for (const forced of [false, true]) {
		const e = event(forced);
		const result = await h.handlers.before_agent_start(e, h.ctx);
		const prompt = e.systemPromptOptions.sections.pm_mode;
		for (const [name, pattern] of contracts) assert.match(prompt, pattern, name);
		assert.match(prompt, /App run\/install/);
		assert.match(prompt, /do not authorize direct Run starts or duplicate triggers/);
		assert.equal(e.systemPromptOptions.sections.existing, "retain");
		assert.equal(e.systemPromptOptions.sections.multica_mode, undefined);
		if (forced) assert.equal(result.systemPrompt, e.systemPrompt + "\n\n" + prompt);
		else assert.equal(result, undefined);
	}
	assert.deepEqual(h.calls, []);
});

test("disabled mode clears stale rules and supplies no implementation authority", async () => {
	const h = harness(false);
	await h.handlers.session_start({}, h.ctx);
	const e = event();
	assert.equal(await h.handlers.before_agent_start(e, h.ctx), undefined);
	assert.deepEqual(e.systemPromptOptions.sections, { existing: "retain" });
	assert.deepEqual(h.calls, []);
});

test("legacy session restore and forks retain the current Skill contract without reads", async () => {
	const h = harness(false, [{ type: "custom", customType: "multica-mode", data: { enabled: true } }]);
	for (const lifecycle of ["session_start", "session_tree", "session_fork"]) {
		await h.handlers[lifecycle]({}, h.ctx);
		const e = event();
		await h.handlers.before_agent_start(e, h.ctx);
		assert.match(e.systemPromptOptions.sections.pm_mode, /same verified branch\/worktree\/PR/);
	}
	assert.deepEqual(h.calls, []);
});

test("missing Skill fails closed without losing session diagnosis and explicit Git boundaries", async () => {
	const h = harness();
	await h.handlers.session_start({}, h.ctx);
	missingRules = true;
	try {
		const e = event(true);
		const result = await h.handlers.before_agent_start(e, h.ctx);
		assert.match(result.systemPrompt, /不可从缺失规则推断任务提交、推送或 Draft PR 创建\/更新授权/);
		assert.match(result.systemPrompt, /暂停平台写入、调度和本地实施/);
		assert.match(result.systemPrompt, /使用当前会话工具并在聊天回复/);
		assert.match(result.systemPrompt, /已明确授权的 Git 提交、合并、推送仍可在当前会话执行/);
		assert.deepEqual(h.calls, []);
	} finally { missingRules = false; }
});

test("both entrypoints and execution/delivery routes preserve publication and closure gates", async () => {
	const read = (path: string) => realReadFile(new URL("../../skills/" + path, import.meta.url), "utf8");
	for (const skill of ["pm-mode", "issue-workflow"]) {
		const text = await read(skill + "/SKILL.md");
		for (const [name, pattern] of contracts) assert.match(text, pattern, skill + ": " + name);
	}
	const execution = await read("issue-workflow/references/execution.md");
	for (const pattern of [
		/explicit ordinary refspec/, /baseline-only advancement/, /including closed\/merged records/,
		/Multiple matches/, /unexpectedly ready PR/, /recheck immediately before creation/,
		/read actual remote refs and PR state/, /insufficient permissions block/,
		/Explicit no-commit\/no-push restrictions/, /merge through it using the authorized hosted method/,
		/verify the actual remote target\/result/, /reserving `done` for humans/,
	]) assert.match(execution, pattern);
	const delivery = await read("issue-workflow/references/follow-up.md");
	assert.match(delivery, /static\/prompt harness, temporary Git experiments and real hosted PR\/platform evidence/);
	assert.match(delivery, /pre-existing baseline commits from task increments/);
});
