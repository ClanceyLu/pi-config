import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TeamRuntime, type ChildFactory, type ChildRecord, type ChildHandle } from "./runtime.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
class Child implements ChildHandle {
 sessionFile: string;
 prompts: string[] = []; steering: string[] = []; disposed = false; answer = "done";
 gate = deferred();
 constructor(record: ChildRecord) { this.sessionFile = record.sessionFile!; }
 async prompt(content: string) { this.prompts.push(content); this.gate = deferred(); await this.gate.promise; }
 async steer(content: string) { this.steering.push(content); return "queued"; }
 async abort() { this.gate.resolve(); }
 dispose() { this.disposed = true; }
 getLastAssistantText() { return this.answer; }
 getSteeringMessages() { return this.steering; }
 clearQueue() { const steering = this.steering.splice(0); return { steering, followUp: [] }; }
 consume() { this.steering.splice(0); }
 finish(answer = "done") { this.answer = answer; this.gate.resolve(); }
}
async function harness(options: { maxDepth?: number; directory?: string; factory?: ChildFactory } = {}) {
 const directory = options.directory ?? mkdtempSync(join(tmpdir(), "pi-team-runtime-"));
 const children = new Map<string, Child>(); const calls: Array<{ record: ChildRecord; caller: string; resume: boolean }> = []; const messages: string[] = [];
 const factory: ChildFactory = options.factory ?? (async (record, caller, resume) => { calls.push({ record, caller, resume }); const child = new Child(record); children.set(record.id, child); return child; });
 const runtime = await new TeamRuntime(directory, { session_id: "lead-session", cwd: directory, model: "test/model", models: ["test/model", "test/other"], thinking: "off", maxDepth: options.maxDepth, factory, leadMessage: content => { messages.push(content); } }).start();
 const spawn = (name = "worker", extra = {}) => runtime.tool("spawn_teammate", { name, description: "work", prompt: "initial", ...extra });
 const subagent = (extra = {}, caller = "lead") => runtime.tool("subagent", { description: "child", prompt: "subtask", ...extra }, undefined, caller);
 const settle = () => runtime.tool("team_wait", { condition: "all_required_settled", timeout_ms: 1000 });
 return { directory, children, calls, messages, runtime, spawn, subagent, settle, async close(remove = true) { await runtime.detach(); if (remove) rmSync(directory, { recursive: true, force: true }); } };
}

test("messages steer a running teammate and results publish only after execution ends", async () => {
 const h = await harness();
 try {
  const member = await h.spawn("worker", { context: "fork", model: "test/other", thinking: "high" });
  assert.equal(h.calls[0].record.context, "fork"); assert.equal(h.calls[0].record.model, "other");
  const child = h.children.get(member.agent_id)!;
  await h.runtime.tool("send_message", { target: "worker", message: "change direction" });
  assert.deepEqual(child.prompts, ["initial"]);
  assert.match(child.steering[0], /Team message from lead:\nchange direction/);
  assert.equal(h.runtime.snapshot.results.length, 0);
  child.consume(); child.finish("implemented"); await h.settle();
  assert.equal(h.runtime.snapshot.results.length, 2);
  assert.ok(h.runtime.snapshot.results.every(r => r.outcome === "succeeded" && r.summary === "implemented"));
  assert.match(h.messages[0], /Team result from worker/);
  assert.equal(h.runtime.snapshot.members[0].status, "inactive");
  await h.runtime.tool("send_message", { target: "worker", message: "more work" });
  assert.equal(child.prompts.length, 2); assert.equal(h.calls.length, 1);
 } finally { await h.close(); }
});

test("interrupt retains pending inbox and explicit continuation resumes it across reload", async () => {
 const h = await harness();
 let reopened: Awaited<ReturnType<typeof harness>> | undefined;
 try {
  const member = await h.spawn();
  await h.runtime.tool("send_message", { target: "worker", message: "pending" });
  await h.runtime.tool("interrupt_agent", { target: "worker" });
  assert.equal(h.runtime.snapshot.results[0].outcome, "cancelled");
  assert.equal(h.runtime.snapshot.running.length, 1);
  assert.equal(h.runtime.board.state.inbox?.[0].status, "queued");
  await h.close(false);
  reopened = await harness({ directory: h.directory });
  assert.equal(reopened.calls.length, 0);
  assert.equal(reopened.runtime.getRecord("worker")!.id, member.agent_id);
  await reopened.runtime.tool("send_message", { target: "worker", message: "resume" });
  assert.equal(reopened.calls[0].resume, true);
  const child = reopened.children.get(member.agent_id)!;
  assert.match(child.prompts[0], /pending/); assert.match(child.steering[0], /resume/);
  assert.ok(!child.prompts.includes("initial"));
  child.consume(); child.finish(); await reopened.settle();
  assert.equal(reopened.runtime.board.state.inbox?.length, 0);
 } finally { await (reopened?.close() ?? h.close()); }
});

test("ordinary subagents return immediately, notify parents and enforce lineage/depth", async () => {
 const h = await harness();
 try {
  const a = await h.subagent(); const b = await h.subagent();
  assert.equal(h.messages.length, 0);
  assert.equal((await h.runtime.tool("list_agents", {})).children.length, 2);
  await assert.rejects(h.runtime.tool("send_message", { agent_id: b.agent_id, message: "peer" }, undefined, a.agent_id), /direct parent and child/);
  await assert.rejects(h.runtime.tool("interrupt_agent", { agent_id: b.agent_id }, undefined, a.agent_id), /ancestor/);
  await assert.rejects(h.subagent({}, a.agent_id), /depth limit/);
  await assert.rejects(h.runtime.tool("spawn_teammate", { name: "bad", description: "x", prompt: "x" }, undefined, a.agent_id), /Lead/);
  await assert.rejects(h.runtime.tool("team_task_create", { subject: "bad", description: "x" }, undefined, a.agent_id), /membership/);
  await h.runtime.tool("send_message", { agent_id: "lead", message: "progress" }, undefined, a.agent_id);
  assert.match(h.messages[0], /progress/);
  h.children.get(a.agent_id)!.finish("answer");
  await h.runtime.tool("wait_agent", { timeout_ms: 1000 });
  assert.ok(h.messages.some(m => m.includes(a.agent_id) && m.includes("answer")));
  const list = await h.runtime.tool("list_agents", {}, undefined, a.agent_id);
  assert.equal(list.children.length, 0); assert.equal(list.tasks, undefined); assert.equal(list.results, undefined);
  await assert.rejects(h.runtime.tool("send_message", { agent_id: a.agent_id, target: "other", message: "ambiguous" }), /exactly one/);
 } finally { await h.close(); }
});

test("nested discovery is stable and completion wakes the direct parent", async () => {
 const h = await harness({ maxDepth: 2 });
 try {
  const a = await h.subagent(); const b = await h.subagent({}, a.agent_id);
  assert.deepEqual((await h.runtime.tool("list_agents", { scope: "descendants" })).children.map(r => [r.agent_id, r.depth, r.parent]), [[a.agent_id, 1, "lead"], [b.agent_id, 2, a.agent_id]]);
  h.children.get(b.agent_id)!.finish("nested result");
  await h.runtime.tool("wait_agent", { timeout_ms: 1000 }, undefined, a.agent_id);
  assert.match(h.children.get(a.agent_id)!.steering[0], /nested result/);
  await assert.rejects(h.runtime.tool("list_agents", { scope: "unknown" }), /scope/);
 } finally { await h.close(); }
});

test("wait without active peers returns no progress and rejects unknown callers", async () => {
 const h = await harness();
 try {
  assert.equal((await h.runtime.tool("wait_agent", { timeout_ms: 60000 })).reason, "no_progress");
  await assert.rejects(h.runtime.tool("list_agents", {}, undefined, "unknown"), /Unknown/);
  const abort = new AbortController(); abort.abort(new Error("cancelled"));
  await assert.rejects(h.subagent({ model: "bad/model" }), /Unavailable/);
  await assert.rejects(h.runtime.tool("subagent", { description: "x", prompt: "x" }, abort.signal), /cancelled/);
  assert.equal(h.runtime.records.length, 0);
 } finally { await h.close(); }
});

test("failed provisioning reserves teammate name and persistent tasks survive reload", async () => {
 const h = await harness({ factory: async () => { throw new Error("cannot create session"); } });
 let reopened: Awaited<ReturnType<typeof harness>> | undefined;
 try {
  await assert.rejects(h.spawn(), /cannot create/);
  assert.equal(h.runtime.snapshot.members[0].status, "failed");
  await assert.rejects(h.spawn(), /already used/);
  const task = await h.runtime.tool("team_task_create", { subject: "Review", description: "Review changes", write_scopes: ["src"] });
  await h.close(false); reopened = await harness({ directory: h.directory });
  assert.deepEqual(await reopened.runtime.tool("team_task_get", { task_id: task.id }), { ...task, ready: true, writeScopeWarnings: [] });
  assert.equal(reopened.runtime.snapshot.members[0].phase, "failed");
 } finally { await (reopened?.close() ?? h.close()); }
});

test("interrupt during provisioning prevents an orphan execution", async () => {
 const gate = deferred(); let child: Child | undefined;
 const h = await harness({ factory: async record => { child = new Child(record); await gate.promise; return child; } });
 try {
  const creation = h.spawn();
  const rejected = assert.rejects(creation, /cancelled/);
  const interruption = h.runtime.tool("interrupt_agent", { target: "worker" });
  gate.resolve(); await rejected; await interruption;
  assert.equal(child!.disposed, true); assert.equal(child!.prompts.length, 0);
  assert.equal(h.runtime.snapshot.members[0].phase, "failed");
 } finally { gate.resolve(); await h.close(); }
});

test("provisioning recovery reconciles a durable child prompt without replaying it", async () => {
 const h = await harness();
 let reopened: Awaited<ReturnType<typeof harness>> | undefined;
 try {
  const agent = await h.subagent();
  const record = h.runtime.getRecord(agent.agent_id)!;
  h.children.get(agent.agent_id)!.finish(); await h.runtime.tool("wait_agent", { timeout_ms: 1000 });
  h.runtime.board.change(s => { s.children![0].phase = "provisioning"; });
  writeFileSync(record.sessionFile!, [{ type: "session", id: record.id }, { type: "custom", customType: "agent-teams.child-session", data: { id: record.id, parent: "lead" } }, { type: "message", message: { role: "user", content: "initial" } }].map(e => JSON.stringify(e)).join("\n") + "\n");
  await h.close(false); reopened = await harness({ directory: h.directory });
  assert.equal(reopened.runtime.getRecord(agent.agent_id)!.phase, "active");
  assert.equal(reopened.calls.length, 0);
 } finally { await (reopened?.close() ?? h.close()); }
});
