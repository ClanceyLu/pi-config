import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, type AgentSession, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openBoard, text, type Member, type Update } from "./core.ts";
import { Lifecycle, type Report, type Outcome } from "./lifecycle.ts";
import { TeamDashboard, heading, widgetLines, toolRenderers, type TeamView, type MemberView } from "./ui.ts";

const POLICY = `Agent Teams: members share cwd and filesystem. Split writes into disjoint scopes; write_scopes are advisory. Reuse members. Only Lead can spawn or interrupt. Work messages to busy members queue for their next turn, not live steering. Completion results are stored silently: Lead must call team_wait(condition=all_required_settled), team_results, explicitly acknowledge processed result IDs with team_results_ack, verify the work, then team_finalize with the latest event_seq before the final answer. For file-bound final verification, team_verification_start captures files before you run checks; run the command with bash, then team_verification_finish records outcome/evidence. Pass those IDs to finalize. These tools record your reported checks, not independently certified execution. A settled member is not proof of success; handle failures and incomplete tasks explicitly. team_finalize never aborts work automatically. Do not reply to internal wake notifications with acknowledgements; read the inbox and act only on new work or material blockers. After successful finalize, publish one consolidated answer. New Lead work opens a new round; teammates cannot reopen a sealed round. Read task revisions before CAS updates and complete tasks explicitly. Task readiness does not wake owners. Use bounded team_wait instead of polling or sleeping. Teammates may submit team_report; do not delegate outside this team.`;
const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value });
const string = () => Type.String({ minLength: 1 });
const optionalStrings = () => Type.Optional(Type.Array(string()));

// The preference is global; team boards and child sessions remain session-scoped.
function globallyEnabled() {
 try {
  const settings = JSON.parse(readFileSync(join(getAgentDir(), "team-settings.json"), "utf8"));
  if (typeof settings?.enabled !== "boolean") throw new Error("Invalid team-settings.json: enabled must be a boolean");
  return settings.enabled;
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
  throw error;
 }
}
function saveEnabled(enabled: boolean) {
 const directory = getAgentDir(), file = join(directory, "team-settings.json");
 mkdirSync(directory, { recursive: true });
 const temporary = `${file}.${randomUUID()}.tmp`;
 try {
  writeFileSync(temporary, `${JSON.stringify({ enabled }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
 } finally { rmSync(temporary, { force: true }); }
}

type Live = { session: AgentSession; running: boolean; cancelling?: boolean; turnId?: string; report?: Report; run?: Promise<void>; preview?: string; unsubscribe?: () => void };
export default function teams(pi: ExtensionAPI) {
 let owner: ReturnType<typeof openBoard> | undefined;
 let context: ExtensionContext;
 let lifecycle: Lifecycle;
 let storageError: string | undefined;
 let wakeScheduled = false, wakeQueued = false, leadWaiting = 0;
 const observed = new Set<string>();
 const readResults = new Set<string>();
 let enabled = false, closing = false, epoch = 0;
 const live = new Map<string, Live>();
 const loading = new Map<string, Promise<Live>>();
 const reservations = new Map<string, number>();
 function checkCapacity(name: string) {
  const active = new Set([...reservations.keys(), ...loading.keys(), ...[...live].filter(([, child]) => child.running).map(([name]) => name), ...board().state.members.filter(m => m.phase === "provisioning").map(m => m.name)]);
  if (!active.has(name) && active.size >= 8) throw new Error("Active teammate capacity reached (8)");
 }
 function reserve(name: string) {
  checkCapacity(name);
  reservations.set(name, (reservations.get(name) ?? 0) + 1);
  return () => { const count = reservations.get(name)! - 1; if (count) reservations.set(name, count); else reservations.delete(name); changed(); };
 }
 const waiters = new Set<() => void>();
 const pending = new Set<Promise<unknown>>();
 const uiSeen = new Set<string>();
 const uiListeners = new Set<() => void>();
 const dashboardClosers = new Set<() => void>();
 let uiTimer: ReturnType<typeof setTimeout> | undefined;
 let widgetInstalled = false;
 let renderWidget: (() => void) | undefined;
 function teamView(): TeamView {
  const round = lifecycle.current;
  const results = lifecycle.state.results.filter(r => r.round_id === round?.id);
  const members: MemberView[] = roster().filter(m => m.name !== "lead").map(m => ({ ...m, preview: live.get(m.name)?.preview }));
  for (const member of members) if (member.latest_outcome === "recovery_required" && member.status === "idle") member.status = "recovery_required";
  return { phase: round?.status ?? "empty", members, tasks: board().tasks(), results, pending: results.filter(r => !r.acknowledged_at).length, unseenFailures: results.filter(r => !uiSeen.has(r.id) && (r.outcome && r.outcome !== "succeeded" || r.kind === "blocker" || r.report?.blocker)).length + members.filter(m => m.status === "failed").length, storageError };
 }
 function refreshUi() {
  if (!uiTimer && enabled && !closing) uiTimer = setTimeout(() => { uiTimer = undefined; draw(); }, 100);
 }
 async function dashboard(ctx: ExtensionContext) {
  if (!enabled) { ctx.ui.notify("团队未开启，请先执行 /team on", "info"); return; }
  if (ctx.mode !== "tui") { ctx.ui.notify(heading(teamView()), "info"); return; }
  await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
   let component: TeamDashboard;
   const close = () => { component.dispose(); dashboardClosers.delete(close); done(); };
   component = new TeamDashboard({
    view: teamView, height: () => Math.max(1, tui.terminal.rows - 2), render: () => tui.requestRender(), done: close,
    seen: ids => { let updated = false; for (const id of ids) if (!uiSeen.has(id)) { uiSeen.add(id); updated = true; } if (updated) refreshUi(); },
    subscribe: listener => { uiListeners.add(listener); return () => uiListeners.delete(listener); },
   });
   dashboardClosers.add(close);
   // Host disposal must also remove callbacks if the UI closes independently.
   const dispose = component.dispose.bind(component);
   component.dispose = () => { dispose(); dashboardClosers.delete(close); refreshUi(); };
   return component;
  });
 }
 function changed() { for (const wake of [...waiters]) wake(); draw(); scheduleWake(); }
 function scheduleWake() {
  if (wakeScheduled || closing || !enabled) return;
  wakeScheduled = true;
  const generation = epoch;
  setImmediate(() => {
   wakeScheduled = false;
   if (!enabled || closing || generation !== epoch || leadWaiting || wakeQueued || !context.isIdle()) return;
   const round = lifecycle.current;
   if (!round || round.status !== "open") return;
   const view = lifecycle.snapshot();
   const unread = lifecycle.state.results.filter(r => r.round_id === round.id && !r.acknowledged_at);
   const urgent = unread.some(r => r.kind === "decision" || r.kind === "blocker" || r.outcome && r.outcome !== "succeeded");
   if (!storageError && (!unread.some(r => !observed.has(r.id)) || !urgent && (!view.all_required_settled || loading.size || [...live.values()].some(c => c.running)))) return;
   wakeQueued = true;
   // A single hidden wake contains references only. Ordinary results never use followUp.
   try { pi.sendMessage({ customType: "team-wake", content: `Team inbox changed for round ${round.id}. Read team_results and handle new results. Do not emit a routine acknowledgement.${storageError ? " Storage error: " + storageError : ""}`, display: false, details: { round_id: round.id, event_seq: view.event_seq } }, { triggerTurn: true, deliverAs: "steer" }); }
   catch (error) { wakeQueued = false; storageError = String(error); draw(); }
  });
 }
 function draw() {
  if (context?.hasUI) {
   const view = enabled && !closing ? teamView() : undefined;
   const visible = view?.phase === "open";
   context.ui.setStatus("agent-teams", visible ? heading(view) : undefined);
   if (visible && !widgetInstalled) {
    context.ui.setWidget("agent-teams", tui => { renderWidget = () => tui.requestRender(); return { render: width => enabled && !closing ? widgetLines(teamView(), width) : [], invalidate() {}, dispose() { renderWidget = undefined; } }; });
    widgetInstalled = true;
   } else if (!visible && widgetInstalled) { context.ui.setWidget("agent-teams", undefined); widgetInstalled = false; renderWidget = undefined; }
  }
  renderWidget?.();
  for (const listener of [...uiListeners]) listener();
 }
 function board() { if (!enabled || !owner || closing) throw new Error("Teams is off; use /team on"); return owner.board; }
 function authorize(name: string) { if (name !== "lead") board().member(name); else board(); }
 function track<T>(promise: Promise<T>) { pending.add(promise); promise.finally(() => pending.delete(promise)).catch(() => {}); return promise; }
 function roster() { return [{ name: "lead", status: context.isIdle() ? "inactive" : "running" }, ...board().state.members.map(m => ({ ...m, status: m.phase === "active" ? live.get(m.name)?.cancelling ? "cancelling" : live.get(m.name)?.running ? "running" : "idle" : m.phase, current_turn_id: live.get(m.name)?.turnId, latest_outcome: lifecycle.state.turns.filter(t => t.member === m.name).at(-1)?.status }))]; }
 async function shutdown() {
  for (const close of [...dashboardClosers]) close();
  clearTimeout(uiTimer); uiTimer = undefined;
  closing = true; enabled = false; epoch++; changed();
  await Promise.allSettled([...pending]);
  await Promise.allSettled([...live.values()].map(async child => { await child.session.abort(); await child.run; child.unsubscribe?.(); child.session.dispose(); }));
  try { for (const turn of lifecycle.state.turns.filter(t => t.status === "queued")) lifecycle.finish(turn.id, "cancelled", "Team stopped before execution"); } catch (error) { storageError = String(error); }
  live.clear(); loading.clear(); owner?.close(); owner = undefined; closing = false; wakeQueued = false; observed.clear(); readResults.clear(); uiSeen.clear(); storageError = undefined; draw();
 }
 async function activate(ctx: ExtensionContext) {
  if (closing) throw new Error("Team is stopping");
  if (enabled) return;
  context = ctx;
  owner = openBoard(join(getAgentDir(), "teams"), ctx.sessionManager.getSessionId(), ctx.cwd);
  lifecycle = new Lifecycle(owner.board);
  try { lifecycle.initialize(); } catch (error) { owner.close(); owner = undefined; throw error; }
  // Restored results remain visible and unacknowledged; enabling never replays old wakes.
  for (const result of lifecycle.state.results) observed.add(result.id);
  enabled = true;
  for (const m of owner.board.state.members.filter(m => m.phase === "provisioning")) owner.board.patchMember(m.name, { phase: "failed", error: "Creation interrupted; name remains reserved" });
  changed();
 }
 async function makeChild(member: Member, manager: SessionManager): Promise<Live> {
  const generation = epoch;
  const runtime = await ModelRuntime.create();
  for (const id of context.modelRegistry.getRegisteredProviderIds()) {
   const native = context.modelRegistry.getRegisteredNativeProvider(id);
   const config = context.modelRegistry.getRegisteredProviderConfig(id);
   if (native) runtime.registerNativeProvider(native);
   else if (config) runtime.registerProvider(id, config);
  }
  const model = runtime.getModel(member.provider, member.model);
  if (!model) throw new Error(`Unavailable teammate model ${member.provider}/${member.model}`);
  const loader = new DefaultResourceLoader({ cwd: context.cwd, agentDir: getAgentDir(), noExtensions: true, noSkills: true, noPromptTemplates: true, appendSystemPrompt: [POLICY, `You are teammate "${member.name}". Lead is "lead". Responsibility: ${member.description}. Use send_message for team communication. You cannot create teammates.`], extensionFactories: [childPi => register(childPi, member.name)] });
  await loader.reload();
  const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({ cwd: context.cwd, modelRuntime: runtime, model, thinkingLevel: member.thinking as any, sessionManager: manager, resourceLoader: loader, tools: ["read", "write", "edit", "bash", "grep", "find", "ls", "send_message", "list_agents", "wait_agent", "team_wait", "team_report", "team_task_create", "team_task_list", "team_task_get", "team_task_update"] });
  if (extensionsResult.errors.length || modelFallbackMessage || closing || generation !== epoch) { session.dispose(); throw new Error(modelFallbackMessage ?? (extensionsResult.errors.map(e => e.error).join("; ") || "Team stopped while loading")); }
  try { await session.bindExtensions({}); } catch (error) { session.dispose(); throw error; }
  const child: Live = { session, running: false };
  child.unsubscribe = session.subscribe(event => {
   if (closing || generation !== epoch) return;
   if (event.type === "tool_execution_start") child.preview = `工具：${event.toolName}`;
   else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") child.preview = (child.preview?.startsWith("工具：") ? "" : child.preview ?? "").concat(event.assistantMessageEvent.delta).slice(-240);
   refreshUi();
  });
  live.set(member.name, child); return child;
 }
 async function load(name: string): Promise<Live> {
  if (live.has(name)) return live.get(name)!;
  if (loading.has(name)) return loading.get(name)!;
  const member = board().member(name);
  if (member.phase !== "active" || !member.sessionFile || !existsSync(member.sessionFile)) throw new Error("Teammate session cannot be restored");
  const promise = makeChild(member, SessionManager.open(member.sessionFile)); loading.set(name, promise);
  try { return await promise; } finally { loading.delete(name); }
 }
 function enqueue(caller: string, name: string, child: Live, message: string, required = true) {
  if (child.cancelling) throw new Error("Teammate cancellation is in progress");
  const turn = lifecycle.admit(caller, name, message, required);
  if (!child.running) drain(name, child);
  changed(); return { accepted: true, turn_id: turn.id, round_id: turn.round_id, delivery: "next_turn" };
 }
 function drain(name: string, child: Live) {
  child.running = true;
  const generation = epoch;
  child.run = (async () => {
   // Clear running in the same continuation that observes an empty queue, so
   // enqueue cannot accept work between loop exit and an asynchronous finalizer.
   try {
    while (enabled && !closing && generation === epoch && !child.cancelling) {
     const next = lifecycle.state.turns.find(t => t.member === name && t.status === "queued");
     if (!next) break;
     lifecycle.running(next.id); child.turnId = next.id; child.report = undefined; child.preview = next.prompt.slice(0, 240); changed();
     let outcome: Outcome = "succeeded", summary = "No closing message.";
     try {
      await child.session.prompt(next.prompt, { expandPromptTemplates: false });
      const last = [...child.session.messages].reverse().find(m => m.role === "assistant") as any;
      if (last?.stopReason === "error") throw new Error(last.errorMessage || "Teammate model failed");
      if (last?.stopReason === "aborted" || child.cancelling || closing) outcome = "cancelled";
      summary = child.report?.summary ?? child.session.getLastAssistantText() ?? summary;
     } catch (error) { outcome = child.cancelling || closing ? "cancelled" : "failed"; summary = String(error); }
     // Commit before reporting completion. A disk error leaves a recoverable unsettled turn.
     lifecycle.finish(next.id, outcome, summary, child.report);
     child.turnId = undefined; child.preview = undefined; changed();
    }
   } catch (error) { storageError = String(error); }
   finally { child.running = false; child.turnId = undefined; changed(); }
  })();
 }
 async function interrupt(name: string) {
  board().member(name); const child = live.get(name);
  if (child) child.cancelling = true;
  board().change(s => { for (const turn of s.coordination!.turns) if (turn.member === name && turn.status === "running") turn.status = "cancelling"; });
  for (const turn of lifecycle.state.turns.filter(t => t.member === name && t.status === "queued")) lifecycle.finish(turn.id, "cancelled", "Cancelled before execution by Lead");
  changed();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
   await Promise.race([
    (async () => { await child?.session.abort(); await child?.run; if (child) child.cancelling = false; changed(); })(),
    new Promise<void>(resolve => { timer = setTimeout(resolve, 10000); }),
   ]);
  } finally { clearTimeout(timer); if (child && !child.running) child.cancelling = false; changed(); }
  return { interrupted: name, stopped: !child?.running, ...lifecycle.snapshot() };
 }
 async function spawn(args: { name: string; description: string; prompt: string; context?: "fresh" | "fork"; required?: boolean }) {
  const b = board(); text(args.prompt); if (!context.model) throw new Error("No Lead model selected");
  checkCapacity(args.name);
  const m: Member = { name: args.name, description: args.description, context: args.context ?? "fresh", provider: context.model.provider, model: context.model.id, thinking: context.thinkingLevel ?? pi.getThinkingLevel(), phase: "provisioning" };
  lifecycle.capacity(); lifecycle.begin("lead");
  b.addMember(m);
  const turn = lifecycle.admit("lead", m.name, `Initial task from lead:\n${args.prompt}`, args.required);
  const release = reserve(m.name);
  changed();
  try {
   const manager = SessionManager.create(context.cwd, join(owner!.directory, "sessions"));
   if (m.context === "fork") {
    // Snapshot only completed user exchanges: omit the current user exchange and all custom orchestration entries.
    const entries = context.sessionManager.getBranch();
    const lastUser = entries.findLastIndex(e => e.type === "message" && e.message.role === "user");
    for (const entry of entries.slice(0, lastUser < 0 ? 0 : lastUser)) if (entry.type === "message") manager.appendMessage(entry.message);
   }
   const child = await makeChild(m, manager);
   b.patchMember(m.name, { phase: "active", sessionFile: manager.getSessionFile() }); changed();
   drain(m.name, child); changed();
   return { ...roster().find(row => row.name === m.name), ...lifecycle.snapshot() };
  } catch (error) {
   lifecycle.finish(turn.id, "failed", String(error));
   b.patchMember(m.name, { phase: "failed", error: String(error) }); changed(); throw error;
  } finally { release(); }
 }
 async function send(caller: string, target: string, message: string, kind?: "work" | "info" | "decision" | "blocker", required = true) {
  authorize(caller); text(message, 65536); if (target === caller) throw new Error("Cannot message yourself");
  const content = `Team message from ${caller}:\n${message}`;
  if (target === "lead") {
   if (kind === "work") throw new Error("Use decision or blocker to request Lead action");
   const result = lifecycle.message(caller, message, kind ?? "info"); changed(); return { sent: true, target, result_id: result.id };
  }
  if (caller !== "lead") lifecycle.open();
  const release = reserve(target);
  try {
   const child = await load(target); if (closing) throw new Error("Team stopped");
   const result = enqueue(caller, target, child, content, required);
   return { sent: true, target, ...result };
  } finally { release(); }
 }
 async function wait(caller: string, args: { round_id?: string; condition?: "any_change" | "all_required_settled"; after_seq?: number; timeout_ms?: number }, signal?: AbortSignal) {
  authorize(caller);
  const roundId = args.round_id ?? lifecycle.current?.id;
  const after = args.after_seq ?? board().state.sequence;
  const timeout = Math.min(60000, Math.max(1, args.timeout_ms ?? 10000));
  const view = () => lifecycle.snapshot(roundId);
  const reason = () => {
   if (closing || !enabled) return "cancelled";
   if (signal?.aborted) return "cancelled";
   const snapshot = view();
   if (!snapshot.round || snapshot.round.status === "sealed") return "round_closed";
   if (args.condition === "all_required_settled") {
    // A child may wait for peers; it must never wait for itself.
    if (!snapshot.running.some(t => t.member !== caller && t.required) && !loading.size && !reservations.size) return "satisfied";
   } else if (snapshot.event_seq > after) return "changed";
   if (!snapshot.running.some(t => t.member !== caller) && !loading.size && !reservations.size) return "no_progress";
   return undefined;
  };
  const immediate = reason(); if (immediate) return { reason: immediate, ...view() };
  if (caller === "lead") leadWaiting++;
  try {
   return await new Promise(resolve => {
    let settled = false;
    const done = (why: string) => { if (settled) return; settled = true; clearTimeout(timer); waiters.delete(wake); signal?.removeEventListener("abort", abort); resolve({ reason: why, ...view() }); };
    const wake = () => { const why = reason(); if (why) done(why); };
    const abort = () => done("cancelled");
    const timer = setTimeout(() => done("timed_out"), timeout);
    waiters.add(wake); signal?.addEventListener("abort", abort, { once: true }); wake();
   });
  } finally { if (caller === "lead") leadWaiting--; }
 }
 function register(api: ExtensionAPI, caller: string) {
  const tool = (name: string, description: string, parameters: any, execute: (args: any, signal?: AbortSignal) => unknown) => api.registerTool({ name, label: name, description, parameters, ...toolRenderers(name), execute: async (_id, args, signal, _update, ctx) => { if (caller === "lead") { if (ctx.sessionManager.getSessionId() !== context.sessionManager.getSessionId()) throw new Error("Team session changed"); context = ctx; } authorize(caller); const result = await track(Promise.resolve().then(() => execute(args, signal))); return reply(result); } });
  if (caller === "lead") tool("spawn_teammate", "Create a named teammate in this session. Reuse existing teammates via send_message. Requires /team on.", Type.Object({ name: string(), description: string(), prompt: string(), required: Type.Optional(Type.Boolean()), context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])) }), spawn);
  tool("send_message", "Send work to a teammate (queued next turn when busy), or info/decision/blocker to Lead. Acceptance is not completion.", Type.Object({ target: string(), message: string(), kind: Type.Optional(Type.Union(["work", "info", "decision", "blocker"].map(Type.Literal))), required: Type.Optional(Type.Boolean()) }), a => send(caller, a.target, a.message, a.kind, a.required));
  tool("list_agents", "List members, current turns, outcomes, and collaboration status.", Type.Object({}), () => ({ members: roster(), ...lifecycle.snapshot(), storage_error: storageError }));
  tool("wait_agent", "Wait for next team change, then re-list. Does not wake inactive teammates.", Type.Object({ timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 60000 })) }), (a, signal) => wait(caller, a, signal));
  tool("team_wait", "Wait for any change or all required peers to settle. Settled does not imply success. Returns cursor and blockers; never starts work.", Type.Object({ round_id: Type.Optional(string()), condition: Type.Optional(Type.Union([Type.Literal("any_change"), Type.Literal("all_required_settled")])), after_seq: Type.Optional(Type.Integer({ minimum: 0 })), timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 60000 })) }), (a, signal) => wait(caller, a, signal));
  tool("team_report", "Record the current member turn summary and reported verification; published when execution actually ends.", Type.Object({ summary: string(), artifacts: optionalStrings(), verification: optionalStrings(), blocker: Type.Optional(string()) }), (a: Report) => {
   const child = live.get(caller); if (!child?.turnId || !child.running) throw new Error("Only an executing teammate can report");
   text(a.summary); for (const value of [...a.artifacts ?? [], ...a.verification ?? []]) text(value, 2048); if (a.blocker) text(a.blocker, 2048);
   if ((a.artifacts?.length ?? 0) > 64 || (a.verification?.length ?? 0) > 64) throw new Error("Report item limit reached");
   child.report = structuredClone(a); return { recorded: true, turn_id: child.turnId };
  });
  if (caller === "lead") {
   tool("team_verification_start", "Capture listed workspace files BEFORE final checks; returns verification ID. Run the command separately using bash. Wait for member work first.", Type.Object({ command: string(), files: Type.Array(string(), { minItems: 1, maxItems: 512 }) }), a => lifecycle.verificationStart(a.command, a.files));
   tool("team_verification_finish", "Record Lead-reported check outcome/evidence AFTER execution; rejects files changed during the check. Does not independently execute or certify commands.", Type.Object({ verification_id: string(), outcome: Type.Union([Type.Literal("passed"), Type.Literal("failed")]), evidence: string() }), a => lifecycle.verificationFinish(a.verification_id, a.outcome, a.evidence));
   tool("interrupt_agent", "Cancel a member's running and queued turns; retain task ownership. Waits for SDK stop confirmation.", Type.Object({ target: string() }), a => interrupt(a.target));
   tool("team_results", "Read durable results. Reading does not acknowledge results; do not turn routine notices into user replies.", Type.Object({ round_id: Type.Optional(string()), after_seq: Type.Optional(Type.Integer({ minimum: 0 })) }), a => { const results = lifecycle.results(a.round_id, a.after_seq); for (const result of results.results) { observed.add(result.id); readResults.add(result.id); } wakeQueued = false; return results; });
   tool("team_results_ack", "Acknowledge exact result IDs after reading and processing them.", Type.Object({ result_ids: Type.Array(string()) }), a => { for (const id of a.result_ids) if (!readResults.has(id)) throw new Error("Read team_results before acknowledging: " + id); const result = lifecycle.ack(a.result_ids); changed(); return { ...result, ...lifecycle.snapshot() }; });
   tool("team_finalize", "Seal this round before the final answer. Requires current event_seq, settled members and acknowledged results. Provide explicit dispositions for unresolved outcomes/tasks. Never aborts work automatically.", Type.Object({ round_id: string(), expected_seq: Type.Integer({ minimum: 0 }), verification_ids: optionalStrings(), dispositions: Type.Optional(Type.Record(Type.String(), string())) }), a => {
    const blockers = [...live.values()].some(c => c.running || c.cancelling) ? ["members_still_running"] : [];
    if (reservations.size || loading.size || board().state.members.some(m => m.phase === "provisioning")) blockers.push("members_loading");
    if (storageError) blockers.push("storage_error:" + storageError);
    const result = lifecycle.finalize(a.round_id, a.expected_seq, a.dispositions, blockers, a.verification_ids);
    if (result.sealed) wakeQueued = false;
    changed(); return result;
   });
  }
  tool("team_task_create", "Create a shared task with dependencies and advisory workspace write scopes.", Type.Object({ subject: string(), description: string(), blocked_by: optionalStrings(), write_scopes: optionalStrings() }), a => { lifecycle.begin(caller); const result = board().create(a); lifecycle.attachTask(result.id); changed(); return result; });
  tool("team_task_list", "List active tasks, readiness and write-scope warnings.", Type.Object({}), () => board().tasks());
  tool("team_task_get", "Read the current task revision before an update.", Type.Object({ task_id: string() }), a => { const task = board().tasks().find(t => t.id === a.task_id); if (!task) throw new Error("Task not found"); return task; });
  tool("team_task_update", "Compare-and-set a shared task. Reassign is Lead-only; other mutations require owner or Lead.", Type.Object({ task_id: string(), expected_revision: Type.Integer({ minimum: 1 }), action: Type.Union(["claim", "release", "complete", "reopen", "reassign", "edit", "set_dependencies", "delete"].map(Type.Literal)), owner: Type.Optional(string()), subject: Type.Optional(string()), description: Type.Optional(string()), blocked_by: optionalStrings(), write_scopes: optionalStrings() }), (a: Update) => { lifecycle.begin(caller); const result = board().update(caller, a); lifecycle.attachTask(result.id); changed(); return result; });
 }
 register(pi, "lead");
 pi.on("session_start", async (_event, ctx) => {
  if (owner) await shutdown();
  context = ctx;
  if (globallyEnabled()) await activate(ctx);
 });
 pi.on("session_shutdown", shutdown);
 pi.on("agent_settled", () => { scheduleWake(); });
 pi.on("before_agent_start", event => enabled ? { systemPrompt: `${event.systemPrompt}\n\n${POLICY}\nYou are Team Lead named lead.` } : undefined);
 pi.registerCommand("team", { description: "团队：/team [dashboard|on|off|status]，开关全局生效", handler: async (args, ctx) => {
  const action = args.trim() || "dashboard";
  if (action === "on") { saveEnabled(true); await activate(ctx); ctx.ui.notify("团队已全局开启，/team 查看成员与任务", "info"); }
  else if (action === "off") {
   try { saveEnabled(false); }
   catch (error) { throw new Error(`当前会话团队已关闭，但无法保存全局关闭设置，后续会话可能重新开启：${String(error)}`, { cause: error }); }
   finally { await shutdown(); }
   ctx.ui.notify("团队已全局关闭", "info");
  }
  else if (action === "dashboard") await dashboard(ctx);
  else if (action === "status") ctx.ui.notify(enabled ? heading(teamView()) : "团队已关闭", "info");
  else throw new Error("Usage: /team [dashboard|on|off|status]");
 } });
}
