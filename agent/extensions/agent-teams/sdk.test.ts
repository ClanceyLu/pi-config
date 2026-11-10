import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../tests/pi-runtime.mjs";
const sdk = await import("@earendil-works/pi-coding-agent");
const { SessionManager } = sdk;
const root = mkdtempSync(join(tmpdir(), "pi-child-sdk-"));
let agentDir: string;
let created: any[] = [];
let behavior: (session: any, text: string) => Promise<void>;

function assistant(text: string, stopReason = "stop", extra = {}) {
  return { role: "assistant", content: [{ type: "text", text }], api: "test", provider: "dynamic", model: "child", stopReason, timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra };
}
function user(text: string) { return { role: "user", content: text, timestamp: 1 }; }
function toolCall(id: string) { return assistant("", "toolUse", { content: [{ type: "toolCall", id, name: "read", arguments: { path: "a" } }] }); }
function toolResult(id: string) { return { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "a" }], isError: false, timestamp: 1 }; }

mock.module("@earendil-works/pi-coding-agent", { namedExports: {
  ...sdk,
  getAgentDir: () => agentDir,
  createAgentSession: async (options: any) => {
    const listeners = new Set<(event: any) => void>();
    const session = {
      options,
      sessionManager: options.sessionManager,
      prompts: [] as string[],
      steering: [] as string[],
      disposed: false,
      bound: false,
      subscribe(fn: (event: any) => void) { listeners.add(fn); return () => listeners.delete(fn); },
      emit(message: any) {
        options.sessionManager.appendMessage(message);
        for (const listener of listeners) listener({ type: "message_end", message });
      },
      async prompt(text: string, promptOptions: any) {
        assert.equal(promptOptions.expandPromptTemplates, false);
        this.prompts.push(text);
        this.emit(user(text));
        await behavior(this, text);
      },
      async steer(text: string) { this.steering.push(text); return "queued"; },
      async abort() {},
      clearQueue() { const steering = this.steering.splice(0); return { steering, followUp: [] }; },
      getSteeringMessages() { return this.steering; },
      async bindExtensions() { this.bound = true; },
      dispose() { this.disposed = true; },
    };
    created.push(session);
    return { session };
  },
} });
const { createSdkFactory } = await import("./sdk.ts");
after(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  agentDir = mkdtempSync(join(root, "agent-"));
  mkdirSync(join(agentDir, "skills"));
  created = [];
  behavior = async (session, text) => { session.emit(assistant(`answer: ${text}`)); };
});

function fixture() {
  const cwd = mkdtempSync(join(root, "workspace-"));
  const parent = SessionManager.create(cwd, join(cwd, "sessions"), { id: "parent" });
  const models = new Map([["dynamic/child", { provider: "dynamic", id: "child", api: "test", reasoning: true }]]);
  const runtime = { getModel: (provider: string, id: string) => models.get(`${provider}/${id}`) };
  const ctx = { cwd, sessionManager: parent, modelRegistry: { runtime }, model: models.get("dynamic/child") } as any;
  const records = new Map<string, any>();
  const registrations: string[] = [];
  const options = { getContext: () => ctx, getRecord: (id: string) => records.get(id), registerChild: (_pi: any, id: string) => { registrations.push(id); } };
  const factory = createSdkFactory(options);
  function record(id: string, context: "fresh" | "fork" = "fork", parentId = "lead") {
    const item = { id, name: id, description: "test", parent: parentId, kind: "teammate", context, cwd,
      sessionFile: join(cwd, "children", `${id}.jsonl`), provider: "dynamic", model: "child", thinking: "high", phase: "active" } as any;
    records.set(id, item);
    return item;
  }
  return { cwd, parent, runtime, models, ctx, registrations, options, factory, record };
}

function messageRoles(manager: any) { return manager.buildSessionContext().messages.map((message: any) => message.role); }

test("fork imports completed turns and compaction, excluding the current user and all its tool calls", async () => {
  const f = fixture();
  f.parent.appendMessage(user("summarized") as any);
  f.parent.appendMessage(assistant("summary source") as any);
  const kept = f.parent.appendMessage(user("completed tool turn") as any);
  f.parent.appendMessage(toolCall("done") as any);
  f.parent.appendMessage(toolResult("done") as any);
  f.parent.appendMessage(assistant("complete") as any);
  f.parent.appendCompaction("earlier discussion", kept, 1000);
  f.parent.appendContextEdit(kept, { content: "edited completed question" });
  const expected = f.parent.buildSessionContext().messages;
  f.parent.appendMessage(user("in-flight spawn") as any);
  f.parent.appendMessage(toolCall("running") as any);
  f.parent.appendMessage(toolResult("running") as any);
  f.parent.appendMessage(toolCall("spawn-tool") as any);
  const bytes = readFileSync(f.parent.getSessionFile()!, "utf8");
  const leaf = f.parent.getLeafId();
  const record = f.record("forked");
  const handle = await f.factory(record, "lead", false);
  const child = created[0];
  assert.deepEqual(child.sessionManager.buildSessionContext().messages, expected);
  assert.equal(child.options.modelRuntime, f.runtime);
  assert.equal(child.options.model, f.models.get("dynamic/child"));
  assert.equal(child.options.thinkingLevel, "high");
  assert.equal(child.bound, true);
  assert.deepEqual(f.registrations, ["forked"]);
  assert.equal(child.sessionManager.getHeader().parentSession, f.parent.getSessionFile());
  assert.equal(child.sessionManager.getSessionId(), record.id);
  assert.deepEqual(child.sessionManager.getEntries().filter((e: any) => e.type === "compaction"), JSON.parse(JSON.stringify(f.parent.getBranch().filter((e: any) => e.type === "compaction"))));
  await handle.prompt("child task");
  assert.equal(handle.getLastAssistantText(), "answer: child task");
  assert.equal(f.parent.getLeafId(), leaf);
  assert.equal(readFileSync(f.parent.getSessionFile()!, "utf8"), bytes);
  const reopened = SessionManager.open(handle.sessionFile);
  assert.deepEqual(reopened.buildSessionContext().messages, child.sessionManager.buildSessionContext().messages);
  handle.dispose();
});

test("fresh durable sessions discover skills/context but never load global or project extensions", async () => {
  const f = fixture();
  f.parent.appendMessage(user("private parent context") as any);
  f.parent.appendMessage(assistant("parent answer") as any);
  mkdirSync(join(agentDir, "extensions"));
  mkdirSync(join(f.cwd, ".pi", "extensions"), { recursive: true });
  for (const file of [join(agentDir, "extensions", "bad.ts"), join(f.cwd, ".pi", "extensions", "bad.ts")]) {
    writeFileSync(file, 'throw new Error("recursive extension loaded"); export default function() {}');
  }
  mkdirSync(join(agentDir, "skills", "sample"));
  writeFileSync(join(agentDir, "skills", "sample", "SKILL.md"), "---\nname: sample\ndescription: fixture skill\n---\nFixture skill.\n");
  writeFileSync(join(f.cwd, "AGENTS.md"), "Fixture workspace instructions");
  const handle = await f.factory(f.record("fresh", "fresh"), "lead", false);
  const child = created[0];
  assert.deepEqual(messageRoles(child.sessionManager), []);
  assert.equal(child.options.resourceLoader.getExtensions().errors.length, 0);
  assert.equal(child.options.resourceLoader.getExtensions().extensions.length, 1);
  assert.equal(child.options.resourceLoader.getSkills().skills.some((s: any) => s.name === "sample"), true);
  assert.equal(child.options.resourceLoader.getAgentsFiles().agentsFiles.some((a: any) => a.content.includes("Fixture workspace instructions")), true);
  assert.deepEqual(child.options.resourceLoader.getPrompts().prompts, []);
  assert.equal(SessionManager.open(handle.sessionFile).getSessionId(), "fresh");
  assert.equal(handle.getLastAssistantText(), undefined);
  handle.dispose();
});

test("cold resume opens the durable child without replaying its original prompt or requiring its parent", async () => {
  const f = fixture();
  const record = f.record("resume", "fresh");
  const first = await f.factory(record, "lead", false);
  await first.prompt("original task");
  const before = readFileSync(first.sessionFile, "utf8");
  first.dispose();
  const cold = createSdkFactory({ ...f.options, getRecord: () => undefined });
  const resumed = await cold(record, "missing-parent", true);
  assert.deepEqual(created[1].prompts, []);
  assert.equal(readFileSync(resumed.sessionFile, "utf8"), before);
  assert.equal(resumed.getLastAssistantText(), undefined);
  await resumed.prompt("continue");
  assert.deepEqual(created[1].prompts, ["continue"]);
  const reopened = SessionManager.open(resumed.sessionFile);
  assert.deepEqual(reopened.buildSessionContext().messages.filter((m: any) => m.role === "user").map((m: any) => m.content), ["original task", "continue"]);
  resumed.dispose();
  await assert.rejects(cold({ ...record, id: "other" }, "lead", true), /identity/);
  await assert.rejects(cold({ ...record, sessionFile: join(f.cwd, "missing.jsonl") }, "lead", true), /missing/);
  await assert.rejects(cold(record, "lead", false), /EEXIST/);
});

test("nested forks snapshot their caller rather than the lead, including cold parent lookup", async () => {
  const f = fixture();
  const parentRecord = f.record("teammate", "fresh");
  const parentHandle = await f.factory(parentRecord, "lead", false);
  await parentHandle.prompt("teammate completed");
  const parentSession = created[0];
  parentSession.emit(user("nested spawn"));
  parentSession.emit(toolCall("nested-call"));
  const nestedRecord = f.record("nested", "fork", "teammate");
  const nested = await f.factory(nestedRecord, "teammate", false);
  assert.deepEqual(messageRoles(created[1].sessionManager), ["user", "assistant"]);
  assert.equal(created[1].sessionManager.buildSessionContext().messages[0].content, "teammate completed");
  assert.equal(created[1].sessionManager.getHeader().parentSession, parentHandle.sessionFile);
  nested.dispose();
  parentHandle.dispose();
  const coldFactory = createSdkFactory(f.options);
  const cold = await coldFactory(f.record("cold-nested", "fork", "teammate"), "teammate", false);
  assert.deepEqual(messageRoles(created[2].sessionManager), ["user", "assistant"]);
  cold.dispose();
});

test("a first in-flight turn or failed turn is not inherited; malformed tool history fails closed", async () => {
  const f = fixture();
  f.parent.appendMessage(user("first spawn") as any);
  f.parent.appendMessage(toolCall("spawn") as any);
  const empty = await f.factory(f.record("empty"), "lead", false);
  assert.deepEqual(messageRoles(created[0].sessionManager), []);
  empty.dispose();
  f.parent.appendMessage(toolResult("spawn") as any);
  f.parent.appendMessage(assistant("", "error", { errorMessage: "failure" }) as any);
  const failed = await f.factory(f.record("failed-parent"), "lead", false);
  assert.deepEqual(messageRoles(created[1].sessionManager), []);
  failed.dispose();
  f.parent.appendMessage(assistant("complete") as any);
  f.parent.appendMessage(user("broken history") as any);
  f.parent.appendMessage(toolResult("orphan") as any);
  f.parent.appendMessage(assistant("complete") as any);
  await assert.rejects(f.factory(f.record("invalid"), "lead", false), /orphan tool result/);
});

test("run errors cannot return an earlier answer and abort preserves pending steering", async () => {
  const f = fixture();
  const handle = await f.factory(f.record("errors", "fresh"), "lead", false);
  await handle.prompt("success");
  behavior = async (session) => { session.emit(assistant("", "error", { errorMessage: "quota exhausted" })); };
  await assert.rejects(handle.prompt("fails"), /quota exhausted/);
  assert.equal(handle.getLastAssistantText(), undefined);
  await handle.steer("pending inbox");
  await handle.abort();
  assert.deepEqual(handle.getSteeringMessages!(), ["pending inbox"]);
  assert.deepEqual(handle.clearQueue!(), { steering: ["pending inbox"], followUp: [] });
  assert.deepEqual(handle.getSteeringMessages!(), []);
  handle.dispose();
  assert.equal(created[0].disposed, true);
});

test("dynamic providers are shared on every creation and missing parent runtimes fail rather than replacing auth", async () => {
  const f = fixture();
  const added = { provider: "late", id: "added", api: "test", reasoning: true };
  f.models.set("late/added", added);
  const record = { ...f.record("dynamic", "fresh"), provider: "late", model: "added" };
  const handle = await f.factory(record, "lead", false);
  assert.equal(created[0].options.modelRuntime, f.runtime);
  assert.equal(created[0].options.model, added);
  handle.dispose();
  f.ctx.modelRegistry = {};
  await assert.rejects(f.factory(f.record("no-runtime", "fresh"), "lead", false), /parent model registry/);
});
