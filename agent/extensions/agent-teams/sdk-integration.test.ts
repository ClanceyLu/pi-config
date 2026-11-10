import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import "../tests/pi-runtime.mjs";
const sdk = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const directory = mkdtempSync(join(tmpdir(), "pi-team-sdk-integration-"));
mock.module("@earendil-works/pi-coding-agent", { namedExports: { ...sdk, getAgentDir: () => directory } });
const { default: extension } = await import("./index.ts");

test("real SDK child uses the parent's dynamic provider, executes and cold-resumes with scoped tools", async () => {
 const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
 const requests: any[] = [];
 modelRuntime.registerProvider("local-test", {
  api: "local-test-api", apiKey: "fixture-key", baseUrl: "http://unused.invalid",
  models: [{ id: "echo", name: "Echo", input: ["text"], reasoning: false, contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  streamSimple(model, context) {
   requests.push(context);
   const stream = createAssistantMessageEventStream();
   const message = { role: "assistant" as const, content: [{type: "text" as const, text: `answer-${requests.length}`}], api: model.api, provider: model.provider, model: model.id, stopReason: "stop" as const, timestamp: Date.now(), usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}} };
   queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end(); });
   return stream;
  },
 });
 const tools = new Map<string, any>(), events = new Map<string, any>(), commands = new Map<string, any>(), messages: string[] = [];
 const parent = sdk.SessionManager.create(directory, join(directory, "sessions"));
 const ctx: any = {cwd: directory, hasUI: false, model: modelRuntime.getModel("local-test", "echo"), modelRegistry: new sdk.ModelRegistry(modelRuntime), sessionManager: parent, ui: {notify() {}}};
 extension({ registerTool: t => tools.set(t.name,t), on: (name, callback) => events.set(name,callback), registerCommand: (name, command) => commands.set(name, command), getThinkingLevel: () => "off", sendMessage: message => messages.push(message.content) } as any);
 const call = async (name: string, args = {}) => (await tools.get(name).execute("call",args,undefined,undefined,ctx)).details;
 try {
  await events.get("session_start")({}, ctx);
  await commands.get("team").handler("on", ctx);
  await call("spawn_teammate", {name: "worker", description: "echo", prompt: "first task"});
  await call("wait_agent", {timeout_ms: 1000});
  assert.match(messages[0], /answer-1/);
  assert.ok(modelRuntime.getModel("local-test", "echo"));
  assert.equal((await call("list_agents")).members[0].status, "inactive");
  const serialized = JSON.stringify(requests[0]);
  assert.match(serialized, /first task/);
  assert.match(serialized, /You are teammate \\"worker\\"/);
  assert.match(serialized, /send_message/);
  assert.match(serialized, /team_task_list/);
  assert.ok(!serialized.includes('"name":"spawn_teammate"'));
  assert.ok(!serialized.includes('"name":"subagent"'));
  await events.get("session_shutdown")();
  await events.get("session_start")({}, ctx);
  await call("send_message", {target: "worker", message: "second task"});
  await call("wait_agent", {timeout_ms: 1000});
  assert.match(messages.at(-1)!, /answer-2/);
  assert.match(JSON.stringify(requests[1]), /first task/);
  assert.match(JSON.stringify(requests[1]), /second task/);
 } finally {
  await events.get("session_shutdown")(); rmSync(directory, {recursive: true, force: true});
 }
});
