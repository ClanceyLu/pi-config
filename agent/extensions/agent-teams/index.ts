import { join } from "node:path";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TeamRuntime } from "./runtime.ts";
import { createSdkFactory } from "./sdk.ts";
import { TeamDashboard, heading, widgetLines, toolRenderers, type TeamView } from "./ui.ts";

const TEAM_POLICY = `Agent Teams is available. Choose available member models and thinking levels using task difficulty and known capabilities; query list_team_models before selecting an exact model ID. Use the parent model when suitability is unknown. The Lead and named teammates share cwd and filesystem. Split writes into disjoint scopes and use shared-task dependencies when ordering matters. write_scopes are advisory, not file locks. Only Lead can create teammates with spawn_teammate or interrupt them. Fresh context starts without Lead history; fork inherits only completed Lead turns, excluding the current in-flight turn. Creation returns an agent_id immediately; completion is delivered separately to Lead. Use target names for Team messages. send_message steers running targets at the next step boundary and starts or cold-resumes inactive targets. inactive means no turn is executing, not success or completion. Reuse members. List/get/claim tasks with the current revision, do the work, then complete them. Readiness does not start an owner. wait_agent observes changes, never wakes members, and returns immediately if no peer can progress. Before the final answer wait for required teammates, inspect their results, review changes and run relevant checks. The result/ack/finalize tools are available for explicit delivery tracking; file verification records are Lead-reported evidence, not independent certification.`;
const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value });
const string = () => Type.String({ minLength: 1 });
const optionalStrings = () => Type.Optional(Type.Array(string()));
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const thinking = () => Type.Optional(Type.Union(thinkingLevels.map(Type.Literal)));

type Preferences = { enabled: boolean; maxSubagentDepth: number };
function globalSettings(): Preferences {
 try {
  const settings = JSON.parse(readFileSync(join(getAgentDir(), "team-settings.json"), "utf8"));
  if (typeof settings?.enabled !== "boolean") throw new Error("Invalid team-settings.json: enabled must be a boolean");
  const depth = settings.maxSubagentDepth ?? 1;
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > 16) throw new Error("maxSubagentDepth must be an integer from 0 to 16");
  return { enabled: settings.enabled, maxSubagentDepth: depth };
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false, maxSubagentDepth: 1 };
  throw error;
 }
}
function saveSettings(enabled: boolean) {
 const settings = { ...globalSettings(), enabled };
 const directory = getAgentDir(), file = join(directory, "team-settings.json");
 mkdirSync(directory, { recursive: true });
 const temporary = `${file}.${randomUUID()}.tmp`;
 try { writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 }); renameSync(temporary, file); }
 finally { rmSync(temporary, { force: true }); }
}

export default function teams(pi: ExtensionAPI) {
 let context: ExtensionContext;
 let runtime: TeamRuntime | undefined;
 let connecting: Promise<TeamRuntime> | undefined;
 let enabled = false, closing = false, generation = 0;
 let storageError: string | undefined;
 let widgetInstalled = false;
 let renderWidget: (() => void) | undefined;
 const seen = new Set<string>();
 const listeners = new Set<() => void>();
 const dashboards = new Set<() => void>();
 function teamView(): TeamView {
  const snapshot = runtime?.snapshot;
  const results = (snapshot?.results ?? []).filter(r => r.round_id === snapshot?.round?.id);
  return { phase: snapshot?.round?.status ?? "empty", members: (snapshot?.members ?? []).filter(m => m.name !== "lead"), tasks: snapshot?.tasks ?? [], results, unseenFailures: results.filter(r => !seen.has(r.id) && (r.outcome && r.outcome !== "succeeded" || r.kind === "blocker")).length, storageError };
 }
 function changed() {
  if (context?.hasUI) {
   const view = teamView();
   const visible = enabled && !closing && view.members.length > 0;
   context.ui.setStatus("agent-teams", visible ? heading(view) : undefined);
   if (visible && !widgetInstalled) {
    context.ui.setWidget("agent-teams", tui => { renderWidget = () => tui.requestRender(); return { render: width => enabled && !closing ? widgetLines(teamView(), width) : [], invalidate() {}, dispose() { renderWidget = undefined; } }; });
    widgetInstalled = true;
   } else if (!visible && widgetInstalled) { context.ui.setWidget("agent-teams", undefined); widgetInstalled = false; renderWidget = undefined; }
  }
  renderWidget?.();
  for (const listener of [...listeners]) listener();
 }
 async function ensureRuntime(ctx: ExtensionContext) {
  if (closing) throw new Error("Agent runtime is stopping");
  if (context && context.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId()) throw new Error("Agent session changed");
  context = ctx;
  if (runtime) return runtime;
  if (connecting) return connecting;
  const epoch = generation;
  connecting = (async () => {
   const backend = new TeamRuntime(getAgentDir(), {
    session_id: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    thinking: ctx.thinkingLevel ?? pi.getThinkingLevel(), models: ctx.modelRegistry.getAvailable().map(m => `${m.provider}/${m.id}`),
    maxDepth: globalSettings().maxSubagentDepth,
    factory: createSdkFactory({ getContext: () => context, getRecord: id => runtime?.getRecord(id), registerChild: (api, caller) => register(api, caller) }),
    leadMessage: text => { if (!closing && epoch === generation) pi.sendMessage({ customType: "agent-message", content: text, display: false }, { triggerTurn: true, deliverAs: "steer" }); },
    changed,
   });
   await backend.start();
   if (closing || epoch !== generation) { await backend.detach(); throw new Error("Agent session changed while starting"); }
   runtime = backend; changed(); return backend;
  })();
  try { return await connecting; } finally { connecting = undefined; }
 }
 async function shutdown() {
  closing = true; generation++;
  for (const close of [...dashboards]) close();
  try {
   if (connecting) await connecting.catch(() => {});
   const previous = runtime; runtime = undefined;
   if (previous) await previous.detach();
  } finally { enabled = false; closing = false; seen.clear(); storageError = undefined; changed(); }
 }
 function register(api: ExtensionAPI, caller = "lead") {
  const isLead = caller === "lead";
  const record = () => runtime?.getRecord(caller);
  const isTeammate = () => !isLead && record()?.kind === "teammate";
  const tool = (name: string, description: string, parameters: any) => api.registerTool({ name, label: name, description, parameters, ...toolRenderers(name), execute: async (_id, args, signal, _update, ctx) => {
   if (!isLead && !runtime) throw new Error("Parent agent runtime is unavailable");
   if (!enabled) throw new Error("Teams is off; use /team on");
   const backend = isLead ? await ensureRuntime(ctx) : runtime!;
   if (isLead) backend.setDefaults(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, ctx.thinkingLevel ?? api.getThinkingLevel(), ctx.modelRegistry.getAvailable().map(m => `${m.provider}/${m.id}`));
   try { return reply(await backend.tool(name, args, signal, caller)); }
   finally { changed(); }
  } });
  tool("send_message", "Steer a running teammate at a step boundary or resume an inactive teammate. Address teammates or Lead by target name. Acceptance does not imply completion.", Type.Object({ target: string(), message: string(), kind: Type.Optional(Type.Union(["work", "info", "decision", "blocker"].map(Type.Literal))), required: Type.Optional(Type.Boolean()) }));
  tool("list_agents", "List team members and their current state. Inactive is availability, not outcome.", Type.Object({}));
  tool("wait_agent", "Wait for a team change. Never wakes inactive members; returns no_progress when no peer can progress.", Type.Object({ timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 60000 })) }));
  if (isLead) tool("interrupt_agent", "Request interruption of a teammate by target name. Preserve accepted pending messages and task ownership.", Type.Object({ target: string() }));
  // Child factories run before runtime publication. Registration follows the immutable caller identity.
  const teammate = isTeammate();
  if (isLead || teammate) {
   if (isLead) {
    tool("list_team_models", "List available teammate model IDs.", Type.Object({}));
    tool("spawn_teammate", "Create a named persistent teammate. Fresh starts without Lead history; fork inherits completed turns. Reuse members with send_message.", Type.Object({ name: string(), description: string(), prompt: string(), required: Type.Optional(Type.Boolean()), context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")])), model: Type.Optional(string()), thinking: thinking() }));
    tool("team_results", "Read durable execution results without acknowledging them.", Type.Object({ round_id: Type.Optional(string()), after_seq: Type.Optional(Type.Integer({ minimum: 0 })) }));
    tool("team_results_ack", "Acknowledge result IDs after reading and processing them.", Type.Object({ result_ids: Type.Array(string()) }));
    tool("team_finalize", "Optionally seal an explicit delivery round after members settle, results are acknowledged and blockers are handled.", Type.Object({ round_id: string(), expected_seq: Type.Integer({ minimum: 0 }), verification_ids: optionalStrings(), dispositions: Type.Optional(Type.Record(Type.String(), string())) }));
    tool("team_verification_start", "Capture listed workspace files before separately running final checks.", Type.Object({ command: string(), files: Type.Array(string(), { minItems: 1, maxItems: 512 }) }));
    tool("team_verification_finish", "Record Lead-reported verification evidence; reject changed files. Does not run commands.", Type.Object({ verification_id: string(), outcome: Type.Union([Type.Literal("passed"), Type.Literal("failed")]), evidence: string() }));
   }
   tool("team_wait", "Wait for changes or required member settlement without starting work.", Type.Object({ round_id: Type.Optional(string()), condition: Type.Optional(Type.Union([Type.Literal("any_change"), Type.Literal("all_required_settled")])), after_seq: Type.Optional(Type.Integer({ minimum: 0 })), timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 60000 })) }));
   if (!isLead) tool("team_report", "Record a report published when the actual member execution settles.", Type.Object({ summary: string(), artifacts: optionalStrings(), verification: optionalStrings(), blocker: Type.Optional(string()) }));
   tool("team_task_create", "Create a task with dependencies and advisory write scopes.", Type.Object({ subject: string(), description: string(), blocked_by: optionalStrings(), write_scopes: optionalStrings() }));
   tool("team_task_list", "List tasks, readiness and write overlap warnings.", Type.Object({}));
   tool("team_task_get", "Read a task's current revision before updating it.", Type.Object({ task_id: string() }));
   tool("team_task_update", "CAS task transition; only owner or Lead may mutate, only Lead may reassign.", Type.Object({ task_id: string(), expected_revision: Type.Integer({ minimum: 1 }), action: Type.Union(["claim", "release", "complete", "reopen", "reassign", "edit", "set_dependencies", "delete"].map(Type.Literal)), owner: Type.Optional(string()), subject: Type.Optional(string()), description: Type.Optional(string()), blocked_by: optionalStrings(), write_scopes: optionalStrings() }));
  }
  api.on("before_agent_start", event => {
   const sections = event.systemPromptOptions.sections ??= {};
   if (enabled && (isLead || isTeammate())) sections.agent_teams = TEAM_POLICY;
   else delete sections.agent_teams;
  });
  api.on("context", event => {
   if (!enabled || (!isLead && !isTeammate())) return;
   const identity = isLead ? `You are the Team Lead named "lead". Your agent_id is lead.` : `You are teammate "${record()!.name}". Your Team Lead is named "lead". Your agent_id is ${caller}.`;
   return { messages: [...event.messages, { role: "user" as const, content: [{ type: "text" as const, text: `Agent runtime context:\n${identity}` }], timestamp: 0 }] };
  });
 }
 register(pi);
 pi.on("session_start", async (_event, ctx) => { if (runtime || connecting) await shutdown(); context = ctx; enabled = globalSettings().enabled; if (enabled) await ensureRuntime(ctx); changed(); });
 pi.on("session_shutdown", shutdown);
 pi.registerCommand("team", { description: "团队：/team [dashboard|on|off|status]", handler: async (args, ctx) => {
  const action = args.trim() || "dashboard";
  if (action === "on") { await ensureRuntime(ctx); saveSettings(true); enabled = true; changed(); ctx.ui.notify("团队已开启", "info"); }
  else if (action === "off") {
   saveSettings(false); enabled = false; changed();
   if (runtime) for (const member of runtime.snapshot.members ?? []) if (member.name !== "lead" && ["running", "provisioning"].includes(member.status)) await runtime.tool("interrupt_agent", { target: member.name });
   for (const close of [...dashboards]) close();
   ctx.ui.notify("团队已关闭", "info");
  } else if (action === "status") ctx.ui.notify(enabled ? heading(teamView()) : "团队已关闭", "info");
  else if (action === "dashboard") {
   if (!enabled) { ctx.ui.notify("请先执行 /team on", "info"); return; }
   if (ctx.mode !== "tui") { ctx.ui.notify(heading(teamView()), "info"); return; }
   await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
    let component: TeamDashboard;
    const close = () => { component.dispose(); dashboards.delete(close); done(); };
    component = new TeamDashboard({ view: teamView, height: () => Math.max(1, tui.terminal.rows - 2), render: () => tui.requestRender(), done: close, seen: ids => { let updated = false; for (const id of ids) if (!seen.has(id)) { seen.add(id); updated = true; } if (updated) changed(); }, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } });
    dashboards.add(close); return component;
   });
  } else throw new Error("Usage: /team [dashboard|on|off|status]");
 } });
}
