import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { after, beforeEach, mock, test } from "node:test";
import type { ChildFactoryOptions } from "./sdk.ts";
import type { ChildRecord } from "./runtime.ts";
import "../tests/pi-runtime.mjs";
const root = mkdtempSync(join(tmpdir(), "pi-teams-extension-"));
beforeEach(() => rmSync(join(root, "team-settings.json"), { force: true }));
after(() => rmSync(root, { recursive: true, force: true }));
const schema = "export const Type = new Proxy({}, { get: () => (...args) => ({ args }) });";
const hooks = registerHooks({ resolve(s,c,next) {
 if (s === "@earendil-works/pi-coding-agent") return { url: "data:text/javascript,export default {}", shortCircuit: true };
 if (s === "typebox") return { url: "data:text/javascript,"+encodeURIComponent(schema), shortCircuit: true };
 return next(s,c);
} });
const children = new Map<string, ReturnType<typeof childHarness>>();
function childHarness(record: ChildRecord) {
 let finish!: () => void;
 const tools = new Map<string, any>(), handlers = new Map<string, any>();
 const api: any = { registerTool: t => tools.set(t.name,t), on: (n,h) => handlers.set(n,h), getThinkingLevel: () => "off" };
 const state = { tools, handlers, api, prompts: [] as string[], steering: [] as string[], disposed: false };
 const handle = { sessionFile: record.sessionFile!, async prompt(text: string) { state.prompts.push(text); await new Promise<void>(r => { finish = r; }); }, async steer(text: string) { state.steering.push(text); }, async abort() { finish?.(); }, getSteeringMessages: () => state.steering, clearQueue: () => ({steering: state.steering.splice(0), followUp: []}), getLastAssistantText: () => "done", dispose() { state.disposed = true; } };
 return Object.assign(state, { handle, complete: () => finish() });
}
mock.module("@earendil-works/pi-coding-agent", { namedExports: { getAgentDir: () => root } });
mock.module("./sdk.ts", { namedExports: { createSdkFactory: (options: ChildFactoryOptions) => async (record: ChildRecord) => { const child = childHarness(record); children.set(record.id, child); options.registerChild(child.api, record.id); return child.handle; } } });
const { default: extension } = await import("./index.ts");
hooks.deregister();
function harness(id: string) {
 const tools = new Map<string, any>(), handlers = new Map<string, any>(), commands = new Map<string, any>(), notices: any[] = [];
 extension({ registerTool: t => tools.set(t.name,t), on: (n,h) => handlers.set(n,h), registerCommand: (n,c) => commands.set(n,c), getThinkingLevel: () => "off", sendMessage: (m,o) => notices.push({ ...m, options: o }) } as any);
 const ctx: any = { cwd: root, hasUI: false, model: { provider: "test", id: "model" }, modelRegistry: { getAvailable: () => [{ provider: "test", id: "model" }] }, sessionManager: { getSessionId: () => id, getBranch: () => [] }, isIdle: () => false, ui: { notify() {} } };
 const call = async (name: string, args = {}, list = tools, signal?: AbortSignal) => (await list.get(name).execute("id", args, signal, undefined, ctx)).details;
 const start = () => handlers.get("session_start")({}, ctx);
 const on = async () => { await start(); await commands.get("team").handler("on", ctx); };
 const off = () => handlers.get("session_shutdown")();
 return { tools, handlers, commands, notices, ctx, call, start, on, off };
}
test("team preference is global and all collaboration tools require teams to be on", async () => {
 const h = harness("toggle");
 try {
  await h.start();
  for (const name of ["subagent", "subagent_fork", "list_subagent_models"]) assert.equal(h.tools.has(name), false);
  for (const name of h.tools.keys()) await assert.rejects(h.call(name), /off/);
  assert.equal(h.handlers.get("context")({ messages: [] }), undefined);
  await h.commands.get("team").handler("on", h.ctx);
  assert.deepEqual(await h.call("list_team_models"), { models: ["test/model"] });
  const task = await h.call("team_task_create", { subject: "Review", description: "Check files" });
  assert.equal(task.status, "pending"); assert.ok(existsSync(join(root, "herdr-teams")));
  const member = await h.call("spawn_teammate", { name: "worker", description: "work", prompt: "do work" });
  assert.equal(children.get(member.agent_id)!.prompts[0], "do work");
  await h.commands.get("team").handler("off", h.ctx);
  assert.equal(JSON.parse(readFileSync(join(root, "team-settings.json"), "utf8")).enabled, false);
  for (const name of h.tools.keys()) await assert.rejects(h.call(name), /off/);
  await assert.rejects(h.call("team_task_list", {}, children.get(member.agent_id)!.tools), /off/);
  await h.commands.get("team").handler("on", h.ctx);
  assert.equal((await h.call("list_agents")).members[0].status, "inactive");
 } finally { await h.off(); }
});

test("team status and widget appear only when teammates exist", async () => {
 const h = harness("visibility");
 const statuses = new Map<string, string | undefined>();
 const widgets = new Map<string, any>();
 h.ctx.hasUI = true;
 h.ctx.ui.setStatus = (name, value) => statuses.set(name, value);
 h.ctx.ui.setWidget = (name, factory) => {
  widgets.get(name)?.dispose();
  if (factory) widgets.set(name, factory({ requestRender() {} }));
  else widgets.delete(name);
 };
 try {
  await h.on();
  assert.equal(statuses.get("agent-teams"), undefined);
  assert.equal(widgets.has("agent-teams"), false);
  await h.call("team_task_create", { subject: "Review", description: "Check files" });
  assert.equal(statuses.get("agent-teams"), undefined);
  assert.equal(widgets.has("agent-teams"), false);
  const member = await h.call("spawn_teammate", { name: "worker", description: "work", prompt: "task" });
  assert.match(statuses.get("agent-teams")!, /1 任务待处理 · 0 条结果\/消息待确认/);
  assert.equal(widgets.get("agent-teams").render(200)[1], "任务 0/1 · /team 查看详情");
  await h.call("send_message", { target: "lead", message: "progress" }, children.get(member.agent_id)!.tools);
  assert.match(statuses.get("agent-teams")!, /1 任务待处理 · 1 条结果\/消息待确认/);
  const { results } = await h.call("team_results");
  assert.match(statuses.get("agent-teams")!, /1 条结果\/消息待确认/);
  await h.call("team_results_ack", { result_ids: results.map(r => r.id) });
  assert.match(statuses.get("agent-teams")!, /1 任务待处理 · 0 条结果\/消息待确认/);
  assert.match(widgets.get("agent-teams").render(200)[0], /0 条结果\/消息待确认/);
  await h.off();
  assert.equal(statuses.get("agent-teams"), undefined);
  assert.equal(widgets.has("agent-teams"), false);
  await h.start();
  assert.match(statuses.get("agent-teams")!, /Team/);
  assert.equal(widgets.get("agent-teams").render(200)[1], "任务 0/1 · /team 查看详情");
  await h.commands.get("team").handler("off", h.ctx);
  assert.equal(statuses.get("agent-teams"), undefined);
  assert.equal(widgets.has("agent-teams"), false);
 } finally { await h.off(); }
});

test("agent policies preserve prompt sections and follow the team toggle", async () => {
 const h = harness("prompt-policies");
 const event = { systemPrompt: "base", systemPromptOptions: { sections: undefined as Record<string, string> | undefined } };
 const apply = () => {
  assert.equal(h.handlers.get("before_agent_start")(event), undefined);
  assert.equal(event.systemPrompt, "base");
  return event.systemPromptOptions.sections!.agent_teams;
 };
 try {
  await h.start();
  assert.equal(apply(), undefined);
  event.systemPromptOptions.sections!.other_extension = "Keep this guidance";
  await h.commands.get("team").handler("on", h.ctx);
  assert.match(apply(), /Agent Teams is available/);
  assert.equal(event.systemPromptOptions.sections!.other_extension, "Keep this guidance");
  await h.commands.get("team").handler("off", h.ctx);
  assert.equal(apply(), undefined);
  assert.equal(event.systemPromptOptions.sections!.other_extension, "Keep this guidance");
 } finally { await h.off(); }
});

test("only Lead can create or interrupt members; teammates share tasks and messages", async () => {
 const h = harness("identity");
 try {
  await h.on();
  const member = await h.call("spawn_teammate", { name: "reviewer", description: "review", prompt: "inspect", context: "fork" });
  const child = children.get(member.agent_id)!;
  for (const name of ["spawn_teammate", "interrupt_agent", "subagent", "subagent_fork", "list_subagent_models"]) assert.equal(child.tools.has(name), false);
  assert.equal(child.tools.has("team_task_create"), true);
  assert.equal(child.tools.has("team_report"), true);
  const event = { messages: [] };
  const identity = child.handlers.get("context")(event).messages.at(-1).content[0].text;
  assert.match(identity, /teammate "reviewer"/);
  const start = { systemPrompt: "base", systemPromptOptions: { sections: {} as Record<string, string> } };
  assert.equal(child.handlers.get("before_agent_start")(start), undefined);
  const system = start.systemPromptOptions.sections.agent_teams;
  assert.ok(!system.includes('You are teammate "reviewer"'));
  assert.match(system, /step boundary/);
  assert.match(system, /spawn_teammate/);
  const task = await h.call("team_task_create", { subject: "Review", description: "Inspect changes" }, child.tools);
  assert.equal((await h.call("team_task_get", { task_id: task.id })).subject, "Review");
  await h.call("send_message", { target: "lead", message: "progress" }, child.tools);
  assert.match(h.notices.at(-1).content, /progress/);
 } finally { await h.off(); }
});

test("shutdown disposes children, preserves preference and allows cold continuation", async () => {
 const h = harness("shutdown");
 try {
  await h.on();
  const member = await h.call("spawn_teammate", { name: "worker", description: "work", prompt: "original" });
  await h.off();
  assert.equal(children.get(member.agent_id)!.disposed, true);
  assert.equal(JSON.parse(readFileSync(join(root, "team-settings.json"), "utf8")).enabled, true);
  await h.start();
  assert.equal((await h.call("list_agents")).members[0].status, "inactive");
  await h.call("send_message", { target: "worker", message: "continue" });
  assert.equal(children.get(member.agent_id)!.prompts.length, 1);
  assert.match(children.get(member.agent_id)!.prompts[0], /continue/);
  assert.ok(!children.get(member.agent_id)!.prompts.includes("original"));
 } finally { await h.off(); }
});

test("completion is delivered separately and busy messages steer before settlement", async () => {
 const h = harness("completion");
 try {
  await h.on();
  const agent = await h.call("spawn_teammate", { name: "reviewer", description: "summarize", prompt: "task", context: "fork" });
  const child = children.get(agent.agent_id)!;
  assert.equal(h.notices.length, 0);
  const sent = await h.call("send_message", { target: "reviewer", message: "adjust" });
  assert.equal(sent.delivery, "steer"); assert.match(child.steering[0], /adjust/);
  child.steering.splice(0); child.complete();
  await h.call("wait_agent", {timeout_ms: 1000});
  assert.match(h.notices[0].content, /Team result from reviewer.*succeeded/);
  assert.equal(h.notices[0].options.triggerTurn, true);
 } finally { await h.off(); }
});
