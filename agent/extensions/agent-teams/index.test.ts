import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { after, beforeEach, mock, test } from "node:test";
const root = mkdtempSync(join(tmpdir(), "pi-teams-integration-"));
beforeEach(() => rmSync(join(root, "team-settings.json"), { force: true }));
after(() => rmSync(root, { recursive: true, force: true }));
const children: any[] = [];
let nextSession = 0;
let failNextCreation = false;
const schema = "export const Type = new Proxy({}, { get: () => (...args) => ({ args }) });";
const hooks = registerHooks({ resolve(s,c,next) { if (s === "@earendil-works/pi-coding-agent") return { url: "data:text/javascript,export default {}", shortCircuit: true }; if (s === "@earendil-works/pi-tui") return { url: new URL("../../install/releases/1.4.0/node_modules/@earendil-works/pi-tui/dist/index.js", import.meta.url).href, shortCircuit: true }; if (s === "typebox") return { url: "data:text/javascript,"+encodeURIComponent(schema), shortCircuit: true }; return next(s,c); } });
mock.module("@earendil-works/pi-coding-agent", { namedExports: {
 getAgentDir: () => root,
 ModelRuntime: { create: async () => ({ getModel: () => ({ provider: "test", id: "model" }) }) },
 SessionManager: { create: () => { const file = join(root, `child-${++nextSession}.jsonl`); writeFileSync(file, ""); return { getSessionFile: () => file, appendMessage() {} }; }, open: (file: string) => ({ getSessionFile: () => file }) },
 DefaultResourceLoader: class { options: any; constructor(options: any) { this.options = options; } async reload() {} },
 createAgentSession: async ({resourceLoader}: any) => {
  if (failNextCreation) { failNextCreation = false; throw new Error("Session creation failed"); }
  const tools = new Map(); resourceLoader.options.extensionFactories[0]({ registerTool: (t: any) => tools.set(t.name,t) });
  let resolve: () => void; const child = { tools, prompts: [] as string[], messages: [], disposed: false, subscribe() { return () => {}; }, async bindExtensions() {}, prompt(message: string) { this.prompts.push(message); return new Promise<void>(r => { resolve = r; }); }, async steer(message: string) { this.prompts.push(message); }, async abort() { resolve?.(); }, finish() { resolve?.(); }, getLastAssistantText: () => "review complete", dispose() { this.disposed = true; } };
  children.push(child); return { session: child, extensionsResult: { errors: [] } };
 }
} });
const { default: extension } = await import("./index.ts"); hooks.deregister();
const tick = () => new Promise<void>(r => setImmediate(r));
function harness(id: string) {
 const tools = new Map<string, any>(), handlers = new Map<string, any>(), commands = new Map<string, any>(), notices: any[] = [];
 extension({ registerTool: t => tools.set(t.name,t), on: (n,h) => handlers.set(n,h), registerCommand: (n,c) => commands.set(n,c), getThinkingLevel: () => "off", sendMessage: (m,o) => notices.push({ ...m, options: o }) } as any);
 const ctx: any = { cwd: root, hasUI: false, model: { provider: "test", id: "model" }, modelRegistry: { getRegisteredProviderIds: () => [] }, sessionManager: { getSessionId: () => id, getBranch: () => [] }, isIdle: () => false, ui: { notify() {} } };
 const call = async (name: string, args = {}, list = tools, signal?: AbortSignal) => (await list.get(name).execute("id", args, signal, undefined, ctx)).details;
 const on = async () => { await handlers.get("session_start")({}, ctx); await commands.get("team").handler("on", ctx); };
 const off = () => handlers.get("session_shutdown")();
 const seal = async (dispositions = {}) => { const view = await call("list_agents"); return call("team_finalize", { round_id: view.round.id, expected_seq: view.event_seq, dispositions }); };
 return { tools, handlers, commands, notices, ctx, call, on, off, seal };
}
test("global switch survives session changes, extension reloads and shutdown without sharing team boards", async () => {
 const h = harness("global-first");
 const reloaded = harness("global-reloaded");
 const disabled = harness("global-disabled");
 const start = (instance: ReturnType<typeof harness>) => instance.handlers.get("session_start")({}, instance.ctx);
 try {
  await start(h);
  await assert.rejects(h.call("list_agents"), /off/);
  await h.commands.get("team").handler("on", h.ctx);
  await h.call("team_task_create", { subject: "first session", description: "must stay in this session" });
  h.ctx.sessionManager.getSessionId = () => "global-second";
  await start(h);
  assert.deepEqual(await h.call("team_task_list"), []);
  assert.equal((await h.call("list_agents")).members.length, 1);
  await h.off();
  // A newly loaded extension restores the global preference without /team on.
  await start(reloaded);
  assert.equal((await reloaded.call("list_agents")).members.length, 1);
  await reloaded.commands.get("team").handler("off", reloaded.ctx);
  reloaded.ctx.sessionManager.getSessionId = () => "global-off-switch";
  await start(reloaded);
  await assert.rejects(reloaded.call("list_agents"), /off/);
  await start(disabled);
  await assert.rejects(disabled.call("list_agents"), /off/);
 } finally { await h.off(); await reloaded.off(); await disabled.off(); }
});

test("queued work uses separate turns, durable results and explicit sealing; members remain reusable", async () => {
 const h = harness("lead-session");
 try {
  await h.handlers.get("session_start")({},h.ctx); await assert.rejects(h.call("list_agents"), /off/);
  await h.commands.get("team").handler("on",h.ctx);
  const initial = children.length;
  await h.call("spawn_teammate", { name: "reviewer", description: "review", prompt: "check" });
  const child = children[initial]; assert.equal(child.tools.has("spawn_teammate"),false); assert.equal(child.tools.has("team_finalize"),false);
  await h.call("send_message", { target: "reviewer", message: "check tests too" }); assert.equal(child.prompts.length,1);
  assert.equal((await h.seal()).sealed,false);
  child.finish(); await tick(); assert.equal(child.prompts.length,2);
  child.finish(); await tick();
  assert.equal((await h.call("list_agents")).members[1].status,"idle"); assert.equal(h.notices.length,0);
  const inbox = await h.call("team_results"); assert.equal(inbox.results.length,2);
  assert.notEqual(inbox.results[0].turn_id,inbox.results[1].turn_id);
  assert.equal((await h.seal()).sealed,false);
  await h.call("team_results_ack", { result_ids: inbox.results.map(r=>r.id) });
  assert.equal((await h.seal()).sealed,true);
  h.ctx.isIdle = () => true; await h.handlers.get("agent_settled")(); await tick(); assert.equal(h.notices.length,0);
  await assert.rejects(h.call("send_message", { target: "lead", message: "late" }, child.tools), /closed/);
  await h.call("send_message", { target: "reviewer", message: "second round" }); assert.equal(children.length,initial+1);
  await h.commands.get("team").handler("off",h.ctx); assert.equal(child.disposed,true);
  await h.commands.get("team").handler("on",h.ctx);
  await h.call("send_message", { target: "reviewer", message: "restored pass" }); assert.equal(children.length,initial+2);
  await h.handlers.get("session_start")({}, { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => "other-session" } });
  assert.equal(children[initial+1].disposed,true);
 } finally { await h.off(); }
});
test("work sent as a teammate finishes starts without another message", async () => {
 const h = harness("settlement-race");
 try {
  await h.on(); const initial = children.length;
  await h.call("spawn_teammate", { name: "worker", description: "test", prompt: "first" });
  const child = children[initial];
  child.finish();
  const accepted = await h.call("send_message", { target: "worker", message: "second" });
  await tick();
  assert.equal(accepted.accepted, true);
  assert.equal(child.prompts.length, 2);
  assert.match(child.prompts[1], /second/);
  child.finish(); await tick();
  assert.equal((await h.call("team_wait", { condition: "all_required_settled", timeout_ms: 10 })).reason, "satisfied");
  const inbox = await h.call("team_results");
  assert.equal(inbox.results.length, 2);
  assert.ok(inbox.results.every(r => r.outcome === "succeeded"));
  await h.call("team_results_ack", { result_ids: inbox.results.map(r => r.id) });
  assert.equal((await h.seal()).sealed, true);
 } finally { await h.off(); }
});
test("off stops running and queued work even when the global preference cannot be saved", async () => {
 const h = harness("off-write-failure");
 try {
  await h.on(); const initial = children.length;
  await h.call("spawn_teammate", { name: "worker", description: "test", prompt: "running" });
  const child = children[initial];
  await h.call("send_message", { target: "worker", message: "queued" });
  rmSync(join(root, "team-settings.json"));
  mkdirSync(join(root, "team-settings.json"));
  await assert.rejects(h.commands.get("team").handler("off", h.ctx));
  assert.equal(child.disposed, true);
  assert.equal(child.prompts.length, 1);
  await assert.rejects(h.call("list_agents"), /off/);
  rmSync(join(root, "team-settings.json"), { recursive: true });
  await h.commands.get("team").handler("on", h.ctx);
  const inbox = await h.call("team_results");
  assert.equal(inbox.results.length, 2);
  assert.ok(inbox.results.every(r => r.outcome === "cancelled"));
 } finally {
  rmSync(join(root, "team-settings.json"), { recursive: true, force: true });
  await h.off();
 }
});
test("simultaneous completion sends one hidden wake, and reading prevents repeated stale wakes", async () => {
 const h = harness("batch-session");
 try {
  await h.on(); const initial = children.length;
  for (const name of ["api","web"]) await h.call("spawn_teammate", { name, description: name, prompt: "review" });
  h.ctx.isIdle = () => true;
  children[initial].finish(); children[initial+1].finish(); await tick(); await tick();
  assert.equal(h.notices.length,1); assert.equal(h.notices[0].display,false); assert.equal(h.notices[0].customType,"team-wake"); assert.equal(h.notices[0].options.deliverAs,"steer");
  const inbox = await h.call("team_results");
  await h.handlers.get("agent_settled")(); await tick(); assert.equal(h.notices.length,1);
  await h.call("team_results_ack", { result_ids: inbox.results.map(r=>r.id) }); assert.equal((await h.seal()).sealed,true);
  await h.handlers.get("agent_settled")(); await tick(); assert.equal(h.notices.length,1);
 } finally { await h.off(); }
});
test("wait requires all necessary peers, has cursor/timeout/cancellation and does not duplicate wakes", async () => {
 const h = harness("wait-session");
 try {
  await h.on(); const initial = children.length;
  for (const name of ["one","two"]) await h.call("spawn_teammate", { name, description:name,prompt:"review" });
  const cursor = (await h.call("list_agents")).event_seq;
  assert.equal((await h.call("team_wait", { after_seq:cursor,timeout_ms:1 })).reason,"timed_out");
  const abort = new AbortController(); const cancelled = h.call("team_wait", { timeout_ms:1000 },h.tools,abort.signal); abort.abort(); assert.equal((await cancelled).reason,"cancelled");
  let done = false;
  const waiting = h.call("team_wait", { condition:"all_required_settled" }).then(v=>{done=true;return v;});
  children[initial].finish(); await tick(); assert.equal(done,false);
  children[initial+1].finish(); const settled = await waiting; assert.equal(settled.reason,"satisfied"); assert.equal(settled.running.length,0);
  assert.equal((await h.call("team_wait", { after_seq:cursor })).reason,"changed"); assert.equal(h.notices.length,0);
 } finally { await h.off(); }
});
test("task ownership, optional writers, structured blockers and cancellation prevent false success", async () => {
 const h = harness("cancel-session");
 try {
  await h.on(); const initial = children.length;
  await h.call("spawn_teammate", { name:"reviewer",description:"review",prompt:"review",required:false });
  const child = children[initial];
  const task = await h.call("team_task_create", {subject:"review",description:"check"});
  await assert.rejects(h.call("team_task_update", {task_id:task.id,expected_revision:1,action:"reassign",owner:"reviewer"},child.tools), /Lead/);
  await h.call("team_task_update", {task_id:task.id,expected_revision:1,action:"reassign",owner:"reviewer"});
  await h.call("team_report", {summary:"needs input",blocker:"missing contract"},child.tools);
  assert.equal((await h.call("team_wait", {condition:"all_required_settled"})).reason,"satisfied");
  assert.equal((await h.seal()).sealed,false);
  await h.call("send_message", {target:"reviewer",message:"queued"});
  await h.call("interrupt_agent", {target:"reviewer"});
  const inbox = await h.call("team_results"); assert.equal(inbox.results.length,2); assert.ok(inbox.results.every(r=>r.outcome==="cancelled"));
  assert.equal((await h.call("team_task_list"))[0].owner,"reviewer");
  await h.call("team_results_ack", {result_ids:inbox.results.map(r=>r.id)});
  assert.equal((await h.seal()).sealed,false);
  const dispositions = Object.fromEntries(inbox.results.map(r=>[r.id,"Cancelled; remaining work disclosed to user"])); dispositions[task.id]="Blocked pending contract";
  assert.equal((await h.seal(dispositions)).sealed,true);
 } finally { await h.off(); }
});
test("original-session regression: twelve results and one info message never create post-finalize replies", async () => {
 const h = harness("original-regression");
 try {
  await h.on(); const initial = children.length;
  await h.call("spawn_teammate", {name:"reviewer",description:"review",prompt:"pass 1"});
  const child = children[initial];
  for (let i=2;i<=12;i++) await h.call("send_message",{target:"reviewer",message:`pass ${i}`});
  await h.call("send_message",{target:"lead",message:"progress only",kind:"info"},child.tools);
  for(let i=0;i<12;i++){ child.finish(); await tick(); }
  const inbox = await h.call("team_results"); assert.equal(inbox.results.length,13);
  await h.call("team_results_ack",{result_ids:inbox.results.map(r=>r.id)});
  assert.equal((await h.seal()).sealed,true);
  h.ctx.isIdle=()=>true;
  for(let i=0;i<3;i++){ await h.handlers.get("agent_settled")(); await tick(); }
  assert.equal(h.notices.length,0);
 } finally { await h.off(); }
});
test("TUI widget updates in place; opening member details never acknowledges model results; off closes UI", async () => {
 const h = harness("tui-session"); let widget: any, panel: any, status: string | undefined, completed = false, removed = false;
 const tui = {terminal:{rows:24},requestRender(){}};
 h.ctx.hasUI = true; h.ctx.mode = "tui";
 h.ctx.ui.setStatus = (_key, value) => { status = value; };
 h.ctx.ui.setWidget = (_key, value) => { if (!value) { widget?.dispose?.(); widget = undefined; removed = true; } else widget = value(tui,{}); };
 h.ctx.ui.custom = factory => new Promise<void>(resolve => { panel = factory(tui, {}, {}, () => { completed = true; resolve(); }); });
 try {
  await h.on(); const initial = children.length;
  assert.equal(widget, undefined);
  assert.equal(status, undefined);
  await h.call("spawn_teammate",{name:"reviewer",description:"review",prompt:"check"});
  assert.match(widget.render(100).join("\n"), /reviewer.*执行中/);
  children[initial].finish(); await tick();
  const opening = h.commands.get("team").handler("",h.ctx);
  panel.render(100); panel.handleInput("\r");
  assert.equal((await h.call("list_agents")).unacknowledged_result_ids.length,1);
  assert.match(panel.render(100).join("\n"), /待 Lead 处理/);
  // Idle members with unread results still belong to an open collaboration.
  assert.ok(widget);
  assert.match(status!, /协作中/);
  const inbox = await h.call("team_results");
  await h.call("team_results_ack", {result_ids: inbox.results.map(r => r.id)});
  assert.equal((await h.seal()).sealed, true);
  assert.equal(widget, undefined);
  assert.equal(status, undefined);
  await h.call("send_message", {target:"reviewer", message:"check again"});
  assert.match(widget.render(100).join("\n"), /reviewer.*执行中/);
  assert.match(status!, /协作中/);
  await h.commands.get("team").handler("off",h.ctx); await opening;
  assert.equal(completed,true); assert.equal(removed,true); assert.equal(widget,undefined);
 } finally { await h.off(); }
});

test("failed provisioning produces a durable failure requiring acknowledgement and disposition", async () => {
 const h = harness("failed-provisioning");
 try {
  await h.on(); failNextCreation = true;
  await assert.rejects(h.call("spawn_teammate", {name:"broken",description:"test",prompt:"required work"}), /Session creation failed/);
  const inbox = await h.call("team_results");
  assert.equal(inbox.results.length, 1);
  const failure = inbox.results[0];
  assert.equal(failure.outcome, "failed");
  assert.equal(failure.member, "broken");
  assert.match(failure.summary, /Session creation failed/);
  assert.equal((await h.seal()).sealed, false);
  await h.call("team_results_ack", {result_ids:[failure.id]});
  assert.equal((await h.seal()).sealed, false);
  assert.equal((await h.seal({[failure.id]:"Creation failed; work deferred"})).sealed, true);
  await h.off(); await h.on();
  assert.equal((await h.call("team_results")).results[0].id, failure.id);
 } finally { failNextCreation = false; await h.off(); }
});
test("concurrent sends reserve capacity and release it after completion or loading failure", async () => {
 const h = harness("concurrent-capacity");
 try {
  await h.on(); const initial = children.length;
  for (let i = 0; i < 9; i++) {
   await h.call("spawn_teammate", {name:`worker-${i}`,description:"test",prompt:"initialize"});
   children[initial+i].finish(); await tick();
  }
  // Restore sessions to exercise the asynchronous loading path too.
  await h.off(); await h.on();
  const outcomes = await Promise.allSettled(Array.from({length:9}, (_, i) => h.call("send_message", {target:`worker-${i}`,message:"run"})));
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 8);
  const rejected = outcomes.find(r => r.status === "rejected") as PromiseRejectedResult;
  assert.match(String(rejected.reason), /capacity/);
  assert.equal((await h.call("list_agents")).running.length, 8);
  // Queueing for a running member consumes no additional member slot.
  await h.call("send_message", {target:"worker-0",message:"queued"});
  children.at(-1).finish(); await tick();
  failNextCreation = true;
  await assert.rejects(h.call("send_message", {target:"worker-8",message:"retry"}), /Session creation failed/);
  await h.call("send_message", {target:"worker-8",message:"retry"});
  assert.equal((await h.call("list_agents")).members.filter(m => m.name !== "lead" && m.status === "running").length, 8);
  await assert.rejects(h.call("spawn_teammate", {name:"extra",description:"test",prompt:"run"}), /capacity/);
  for (let i = 0; i < 9; i++) await h.call("interrupt_agent", {target:`worker-${i}`});
  // All targets are now cached: even await on an already loaded session must reserve a slot.
  const cached = await Promise.allSettled(Array.from({length:9}, (_, i) => h.call("send_message", {target:`worker-${i}`,message:"run cached"})));
  assert.equal(cached.filter(r => r.status === "fulfilled").length, 8);
  assert.equal((await h.call("list_agents")).members.filter(m => m.name !== "lead" && m.status === "running").length, 8);
 } finally { failNextCreation = false; await h.off(); }
});
