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
		appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
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
const target = { id: "project", workspace_id: "workspace", title: "Project", workspaceName: "Workspace", profile: "", serverUrl: process.env.MULTICA_SERVER_URL?.replace(/\/$/, ""), cwd: process.cwd() };
const entry = (data: any, customType = "pm-mode") => ({ type: "custom", customType, data });
async function prompt(h: ReturnType<typeof harness>, forced = false) {
 const e = event(forced);
 const result = await h.handlers.before_agent_start(e, h.ctx);
 assert.equal(e.systemPromptOptions.sections.existing, "retain");
 assert.equal(e.systemPromptOptions.sections.multica_mode, undefined);
 if (forced && e.systemPromptOptions.sections.pm_mode) assert.equal(result.systemPrompt, e.systemPrompt + "\n\n" + e.systemPromptOptions.sections.pm_mode);
 return e.systemPromptOptions.sections.pm_mode;
}

test("default off and cached project/Issue never enable PM; stale sections removed", async () => {
 for (const data of [undefined, { target, issue: "ISS-1" }, { enabled: false, target, issue: "ISS-1" }]) {
  const h = harness(false, data ? [entry(data)] : []);
  await h.handlers.session_start({}, h.ctx);
  for (const forced of [false, true]) assert.equal(await prompt(h, forced), undefined);
  assert.deepEqual(h.calls, []);
 }
});

test("startup flag injects the actual Skill in resident and forced prompts", async () => {
 const h = harness(true);
 await h.handlers.session_start({}, h.ctx);
 for (const forced of [false, true]) {
  const text = await prompt(h, forced);
  assert.match(text, /Current PM runtime state: enabled: true/);
  assert.match(text, /Code implementation goes to the issue owner/);
  assert.match(text, /When PM is off or has never been enabled/);
  assert.match(text, /Turning PM off grants no additional commit, push, merge/);
 }
 assert.deepEqual(h.calls, []);
});

test("on/off with cached focus, repeated turns and all restore events respect latest state over flag/history", async () => {
 const entries = [entry({ enabled: true, target, issue: "ISS-1" }, "multica-mode"), entry({ enabled: false, target, issue: "ISS-1" })];
 const h = harness(true, entries);
 for (const lifecycle of ["session_start", "session_tree", "session_fork"]) {
  await h.handlers[lifecycle]({}, h.ctx);
  assert.equal(await prompt(h), undefined);
 }
 await h.commands.pm.handler("on", h.ctx);
 for (let i = 0; i < 2; i++) assert.match(await prompt(h), /enabled: true/);
 for (const lifecycle of ["session_start", "session_tree", "session_fork"]) {
  await h.handlers[lifecycle]({}, h.ctx);
  assert.match(await prompt(h), /enabled: true/);
 }
 await h.commands.pm.handler("off", h.ctx);
 assert.equal(entries.at(-1).data.enabled, false);
 assert.equal(entries.at(-1).data.issue, "ISS-1");
 for (const lifecycle of ["session_start", "session_tree", "session_fork"]) {
  await h.handlers[lifecycle]({}, h.ctx);
  assert.equal(await prompt(h, true), undefined);
 }
 assert.deepEqual(h.calls, []);
});

test("missing rules fallback applies only while enabled and disappears on off/restore", async () => {
 const h = harness(true);
 await h.handlers.session_start({}, h.ctx);
 missingRules = true;
 try {
  const text = await prompt(h, true);
  assert.match(text, /仅在当前 PM mode 开启时适用/);
  assert.match(text, /暂停平台写入、调度和本地实施/);
  assert.match(text, /使用当前会话工具并在聊天回复/);
  assert.match(text, /已明确授权的 Git 提交、合并、推送仍可在当前会话执行/);
  await h.commands.pm.handler("off", h.ctx);
  assert.equal(await prompt(h), undefined);
  await h.handlers.session_start({}, h.ctx);
  assert.equal(await prompt(h), undefined);
 } finally { missingRules = false; }
 assert.deepEqual(h.calls, []);
});

// These are static instruction contracts, not claims about model decisions.
const boundaryContracts = [
 /only while the current extension runtime reports `enabled: true`/,
 /Loading this Skill, mentioning an Issue, cached project\/Issue focus, or historical activation does not enable PM mode/,
 /current disabled state supersedes earlier PM instructions/,
 /perform authorized code changes and other operations in the current session without requiring an Issue, owner handoff, worktree or PR/,
 /Explicit Issue requests follow only the requested operation and its permissions/,
 /General authorization, safety confirmation, Git data protection and explicit repository or managed-run constraints still apply/,
 /Turning PM off grants no additional commit, push, merge or destructive-operation permission/,
];
function checkBoundary(text: string) { for (const pattern of boundaryContracts) assert.match(text, pattern); }
test("both entrypoints and execution reference satisfy positive and negative boundary contracts", async () => {
 for (const path of ["pm-mode/SKILL.md", "issue-workflow/SKILL.md", "issue-workflow/references/execution.md"]) {
  const text = await realReadFile(new URL("../../skills/" + path, import.meta.url), "utf8");
  checkBoundary(text);
  for (const pattern of boundaryContracts) assert.throws(() => checkBoundary(text.replace(pattern, "regressed boundary")), path);
  assert.match(text, /Diagnosis\/tests\/install (grant no|do not authorize) source edits/);
 }
});
