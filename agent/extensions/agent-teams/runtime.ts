import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Board, openBoard, text, type ChildRecord, type PendingMessage } from "./core.ts";
import { Lifecycle, unsettled, type Outcome, type Report } from "./lifecycle.ts";
export type { ChildRecord } from "./core.ts";

export interface ChildHandle {
 sessionFile: string;
 prompt(text: string): Promise<void>;
 steer(text: string): Promise<unknown>;
 abort(): Promise<void>;
 dispose(): void;
 getLastAssistantText(): string | undefined;
 clearQueue?(): { steering: string[]; followUp: string[] };
 getSteeringMessages?(): readonly string[];
}
export type ChildFactory = (record: ChildRecord, caller: string, resume: boolean) => Promise<ChildHandle>;
export interface RuntimeOptions {
 session_id: string; cwd: string; model?: string; thinking?: string; models?: string[]; maxDepth?: number;
 factory: ChildFactory; leadMessage(text: string): void | Promise<void>; changed?(): void;
}
type Execution = { handle: ChildHandle; messages: PendingMessage[]; cancelled: boolean; promise: Promise<void> };
const leadOnly = new Set(["spawn_teammate", "list_team_models", "team_results", "team_results_ack", "team_finalize", "team_verification_start", "team_verification_finish"]);

/** One owner serializes durable state; child conversations remain independent SDK sessions. */
export class TeamRuntime {
 private owner: ReturnType<typeof openBoard>;
 private lifecycle: Lifecycle;
 private handles = new Map<string, ChildHandle>();
 private loading = new Map<string, Promise<ChildHandle>>();
 private executions = new Map<string, Execution>();
 private reports = new Map<string, Report>();
 private reads = new Set<string>();
 private cancelledSpawns = new Set<string>();
 private waiters = new Set<() => void>();
 private closed = false;
 private started = false;
 private options: RuntimeOptions;
 private deliveryError?: string;
 constructor(directory: string, options: RuntimeOptions) {
  this.options = options;
  const depth = options.maxDepth ?? 1;
  if (!Number.isSafeInteger(depth) || depth < 0 || depth > 16) throw new Error("Invalid maxDepth");
  // Keep the existing directory so task boards/results survive the execution-backend upgrade.
  const id = createHash("sha256").update(options.session_id).digest("hex");
  this.owner = openBoard(join(directory, "herdr-teams"), id, options.cwd);
  this.lifecycle = new Lifecycle(this.board);
 }
 get board(): Board { return this.owner.board; }
 get records(): ChildRecord[] {
  return [...this.board.state.members.filter(m => m.id).map(m => ({ ...m, id: m.id!, parent: m.parent ?? "lead", kind: "teammate" as const, cwd: m.cwd ?? this.options.cwd })), ...(this.board.state.children ?? [])].map(r => structuredClone(r));
 }
 getRecord(idOrName: string): ChildRecord | undefined { const records = this.records; return records.find(r => r.id === idOrName) ?? records.find(r => r.kind === "teammate" && r.name === idOrName); }
 private record(id: string): ChildRecord {
  const record = this.getRecord(id);
  if (!record) throw new Error("Unknown agent");
  return record;
 }
 private caller(id: string) {
  if (id === "lead") return { id, name: "lead", team: true };
  const record = this.record(id);
  if (record.phase !== "active" && record.phase !== "provisioning") throw new Error("Agent is unavailable");
  return { id: record.id, name: record.name, team: record.kind === "teammate" };
 }
 private patch(id: string, patch: Partial<ChildRecord>) {
  this.board.change(s => {
   const record = s.members.find(r => r.id === id) ?? s.children?.find(r => r.id === id);
   if (!record) throw new Error("Unknown agent");
   Object.assign(record, patch);
  });
 }
 private status(record: ChildRecord) { return record.phase !== "active" ? record.phase : this.executions.has(record.id) ? "running" : "inactive"; }
 get snapshot() {
  const members = this.records.filter(r => r.kind === "teammate").map(r => ({ ...r, target: r.name, status: this.status(r), latest_outcome: this.lifecycle.state.results.filter(result => result.member === r.name && result.outcome).at(-1)?.outcome }));
  const legacy = this.board.state.members.filter(m => !m.id).map(m => ({ ...m, target: m.name, status: m.phase === "active" ? "inactive" : m.phase }));
  return { ...this.lifecycle.snapshot(), members: [...members, ...legacy], tasks: this.board.tasks(), results: structuredClone(this.lifecycle.state.results), children: this.records.filter(r => r.kind === "subagent").map(r => ({ ...r, agent_id: r.id, status: this.status(r) })), delivery_error: this.deliveryError };
 }
 private changed() { for (const wake of [...this.waiters]) wake(); this.options.changed?.(); }
 async start() {
  if (this.started) return this;
  try {
   const preserved = (this.board.state.inbox ?? []).filter(m => m.status === "queued" && m.turnId).map(m => m.turnId!);
   this.lifecycle.initialize(preserved);
   this.board.change(s => {
    // Admitted work may already have caused side effects. Only known unsent inbox entries survive.
    s.inbox = (s.inbox ?? []).filter(m => m.status === "queued");
    s.children ??= [];
    for (const record of [...s.members, ...s.children]) {
     if (!record.id) {
      if (record.phase === "active" || record.phase === "provisioning") {
       record.phase = "failed";
       record.error = "Legacy Herdr member; inspect its saved session and use a new SDK member name";
      }
      continue;
     }
     if (record.phase === "provisioning") {
      try {
       const entries = readFileSync(record.sessionFile!, "utf8").trim().split("\n").map(line => JSON.parse(line));
       const identity = entries.findLastIndex(e => e.type === "custom" && e.customType === "agent-teams.child-session" && e.data?.id === record.id && e.data?.parent === record.parent);
       const admitted = identity >= 0 && entries.slice(identity + 1).some(e => e.type === "message" && e.message?.role === "user");
       if (entries[0]?.id !== record.id || !admitted) throw new Error("Initial prompt was not durably accepted");
       record.phase = "active";
      } catch {
       record.phase = "failed";
       record.error = "Provisioning was interrupted before durable acceptance; inspect the child session";
      }
     }
    }
   });
   this.started = true; this.changed(); return this;
  } catch (error) { this.owner.close(); throw error; }
 }
 setDefaults(model: string | undefined, thinking: string, models: string[]) { Object.assign(this.options, { model, thinking, models }); }
 private async handle(record: ChildRecord, resume = true): Promise<ChildHandle> {
  const live = this.handles.get(record.id);
  if (live) return live;
  const pending = this.loading.get(record.id);
  if (pending) return pending;
  const load = (async () => {
   const child = await this.options.factory(record, record.parent, resume);
   if (this.closed || this.cancelledSpawns.has(record.id)) { child.dispose(); throw new Error("Agent creation was cancelled"); }
   this.handles.set(record.id, child);
   if (child.sessionFile !== record.sessionFile) this.patch(record.id, { sessionFile: child.sessionFile });
   return child;
  })();
  this.loading.set(record.id, load);
  try { return await load; } finally { this.loading.delete(record.id); }
 }
 private depth(id: string) {
  let depth = 0; const seen = new Set<string>();
  while (id !== "lead") {
   if (seen.has(id)) throw new Error("Invalid agent lineage");
   seen.add(id); const record = this.record(id);
   if (record.kind === "subagent") depth++;
   id = record.parent;
  }
  return depth;
 }
 private descendant(id: string, ancestor: string) {
  const seen = new Set<string>();
  while (id !== "lead" && !seen.has(id)) { seen.add(id); const r = this.record(id); if (r.parent === ancestor) return true; id = r.parent; }
  return false;
 }
 private async spawn(args: any, caller: string, kind: ChildRecord["kind"], signal?: AbortSignal) {
  signal?.throwIfAborted();
  const source = this.caller(caller);
  if (kind === "teammate" && caller !== "lead") throw new Error("Lead required");
  if (kind === "subagent" && this.depth(source.id) >= (this.options.maxDepth ?? 1)) throw new Error("Subagent delegation depth limit reached");
  const prompt = text(args.prompt, 65536), description = text(args.description, 200);
  const parent = caller === "lead" ? undefined : this.record(source.id);
  const model = args.model ?? (parent ? `${parent.provider}/${parent.model}` : this.options.model);
  if (!model || !this.options.models?.includes(model)) throw new Error("Unavailable model; list available models first");
  const context = args.context ?? "fresh";
  if (context !== "fresh" && context !== "fork") throw new Error("Invalid context mode");
  const cwd = kind === "teammate" ? this.options.cwd : resolve(parent?.cwd ?? this.options.cwd, args.cwd ?? ".");
  if (!statSync(cwd).isDirectory()) throw new Error("Child cwd must be a directory");
  const slash = model.indexOf("/");
  if (slash < 1) throw new Error("Use an exact provider/model ID");
  const id = randomUUID();
  const record: ChildRecord = { id, name: kind === "teammate" ? args.name : `subagent-${id}`, description, parent: source.id, kind, context, cwd, sessionFile: join(this.owner.directory, `${id}.jsonl`), provider: model.slice(0, slash), model: model.slice(slash + 1), thinking: args.thinking ?? parent?.thinking ?? this.options.thinking ?? "off", phase: "provisioning" };
  if (kind === "teammate") { this.lifecycle.begin("lead"); this.board.addMember({ ...record, kind: "teammate" }); }
  else this.board.change(s => { if ((s.children?.length ?? 0) >= 256) throw new Error("Subagent limit reached"); (s.children ??= []).push(record); });
  this.changed();
  try {
   const handle = await this.handle(record, false);
   signal?.throwIfAborted();
   this.patch(id, { phase: "active", sessionFile: handle.sessionFile });
   const message = this.admit(this.record(id), source.id, prompt, args.required);
   await this.dispatch(this.record(id), message);
   return { agent_id: id, name: record.name, target: record.kind === "teammate" ? record.name : undefined, status: this.status(this.record(id)), ...kind === "teammate" ? this.lifecycle.snapshot() : {} };
  } catch (error) {
   this.patch(id, { phase: "failed", error: String(error) });
   this.handles.get(id)?.dispose(); this.handles.delete(id);
   throw error;
  } finally { this.changed(); }
 }
 private admit(record: ChildRecord, sender: string, content: string, required = true) {
  const message: PendingMessage = { id: randomUUID(), target: record.id, sender, text: content, status: "queued" };
  if (record.kind === "teammate") message.turnId = this.lifecycle.admit("lead", record.name, content, required).id;
  this.board.change(s => { (s.inbox ??= []).push(message); });
  this.changed(); return message;
 }
 private async dispatch(record: ChildRecord, message: PendingMessage) {
  const handle = await this.handle(record);
  // A concurrent cold-load may have already started an execution.
  const current = this.executions.get(record.id);
  if (current) {
   this.board.change(s => { s.inbox!.find(m => m.id === message.id)!.status = "admitted"; });
   current.messages.push(message);
   try { await handle.steer(message.text); }
   catch (error) {
    current.messages = current.messages.filter(m => m.id !== message.id);
    this.board.change(s => { s.inbox = s.inbox!.filter(m => m.id !== message.id); });
    if (message.turnId) this.lifecycle.finish(message.turnId, "recovery_required", `Message admission was uncertain: ${String(error)}`);
    throw error;
   }
   this.changed(); return;
  }
  const inbox = (this.board.state.inbox ?? []).filter(m => m.target === record.id && m.status === "queued");
  const first = inbox[0] ?? message;
  this.board.change(s => { s.inbox!.find(m => m.id === first.id)!.status = "admitted"; });
  if (first.turnId) this.lifecycle.running(first.turnId);
  const execution: Execution = { handle, messages: [first], cancelled: false, promise: Promise.resolve() };
  this.executions.set(record.id, execution);
  execution.promise = this.execute(record, execution, first);
  // Preserve separate message boundaries; accepted pending work joins the running inbox.
  for (const next of inbox.slice(1)) await this.dispatch(record, next);
  this.changed();
 }
 private async execute(record: ChildRecord, execution: Execution, first: PendingMessage) {
  let outcome: Outcome = "succeeded", summary = "No closing message";
  try { await execution.handle.prompt(first.text); summary = execution.handle.getLastAssistantText() ?? summary; }
  catch (error) { outcome = "failed"; summary = String(error); }
  if (execution.cancelled) outcome = "cancelled";
  const pending = [...(execution.handle.getSteeringMessages?.() ?? [])];
  execution.handle.clearQueue?.();
  const retained = new Set<string>();
  // Duplicate message text is valid: match remaining queue entries by occurrence.
  for (const message of execution.messages.slice(1)) {
   const index = pending.indexOf(message.text);
   if (index >= 0) { pending.splice(index, 1); retained.add(message.id); }
  }
  try {
   this.board.change(s => { s.inbox = (s.inbox ?? []).filter(m => {
    if (!execution.messages.some(owned => owned.id === m.id)) return true;
    if (retained.has(m.id)) { m.status = "queued"; return true; }
    return false;
   }); });
   for (const message of execution.messages) if (message.turnId && !retained.has(message.id)) {
    const turn = this.lifecycle.state.turns.find(t => t.id === message.turnId);
    if (turn && unsettled(turn)) this.lifecycle.finish(turn.id, outcome, summary, this.reports.get(record.id));
   }
   this.reports.delete(record.id);
   this.executions.delete(record.id);
   this.changed();
   if (!this.closed) await this.notify(record.parent, `${record.kind === "teammate" ? `Team result from ${record.name}` : `Subagent ${record.id} completed`} (${outcome}):\n${summary}`, record.id);
  } catch (error) { this.deliveryError = String(error); this.executions.delete(record.id); this.changed(); }
 }
 private async notify(target: string, content: string, sender: string) {
  if (target === "lead") { await this.options.leadMessage(content); return; }
  const record = this.record(target);
  if (record.phase !== "active") throw new Error("Parent is unavailable for completion delivery");
  const message = this.admit(record, sender, content);
  await this.dispatch(record, message);
 }
 private addressed(args: any) {
  if (Boolean(args.target) === Boolean(args.agent_id)) throw new Error("Specify exactly one of target or agent_id");
  return args.target ?? args.agent_id;
 }
 private async send(args: any, caller: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const source = this.caller(caller), targetId = this.addressed(args);
  const direct = Boolean(args.agent_id);
  const target = targetId === "lead" ? undefined : this.record(targetId);
  if ((target?.id ?? "lead") === source.id) throw new Error("Cannot message yourself");
  if (direct) {
   if (target?.parent !== source.id && (caller === "lead" || this.record(source.id).parent !== (target?.id ?? "lead"))) throw new Error("Only direct parent and child agents can exchange messages");
  } else if (!source.team || target && target.kind !== "teammate") throw new Error("Team membership required; use agent_id for subagents");
  const content = `${direct ? `Agent ${source.id}` : `Team message from ${source.name}`}:\n${text(args.message, 65536)}`;
  if (Buffer.byteLength(content, "utf8") > 65536) throw new Error("Message exceeds 65536 bytes including sender prefix");
  if (!target) {
   if (args.kind === "work") throw new Error("Use info, decision or blocker for Lead messages");
   if (source.team && this.lifecycle.current?.status === "open") this.lifecycle.message(source.name, args.message, args.kind ?? "info");
   else this.board.change(() => {});
   await this.options.leadMessage(content); this.changed();
   return { sent: true, messageId: randomUUID() };
  }
  if (target.phase !== "active") throw new Error("Target agent is unavailable");
  const message = this.admit(target, source.id, content, args.required);
  await this.dispatch(target, message);
  return { sent: true, accepted: true, messageId: message.id, turn_id: message.turnId, delivery: "steer" };
 }
 private async interrupt(args: any, caller: string) {
  const source = this.caller(caller), target = this.record(this.addressed(args));
  if (target.id === source.id) throw new Error("Cannot interrupt yourself");
  if (args.target) { if (caller !== "lead" || target.kind !== "teammate") throw new Error("Lead required for named teammates"); }
  else if (!this.descendant(target.id, source.id)) throw new Error("Only an ancestor can interrupt a subagent");
  if (target.phase === "provisioning") {
   this.cancelledSpawns.add(target.id);
   await this.loading.get(target.id)?.catch(() => {});
  }
  const execution = this.executions.get(target.id);
  if (execution) { execution.cancelled = true; await execution.handle.abort(); await execution.promise; }
  return { interrupted: target.id, stopped: !this.executions.has(target.id) };
 }
 private list(caller: string, scope = "children") {
  if (scope !== "children" && scope !== "descendants") throw new Error("Invalid discovery scope");
  const source = this.caller(caller);
  const children: Array<ChildRecord & { agent_id: string; status: string; depth: number }> = [];
  const visit = (parent: string, depth: number) => { for (const record of this.records.filter(r => r.parent === parent)) {
   if (record.kind === "subagent") children.push({ ...record, agent_id: record.id, status: this.status(record), depth });
   if (scope === "descendants") visit(record.id, depth + 1);
  } };
  visit(source.id, 1);
  const snapshot = this.snapshot;
  return source.team ? { ...snapshot, children } : { event_seq: snapshot.event_seq, members: [], children };
 }
 private async wait(args: any, caller: string, signal?: AbortSignal) {
  const after = args.after_seq ?? this.board.state.sequence;
  const source = this.caller(caller);
  const view = () => this.lifecycle.snapshot(args.round_id);
  const progressing = () => this.records.some(r => r.id !== source.id && (source.team && r.kind === "teammate" || r.parent === source.id) && (this.executions.has(r.id) || r.phase === "provisioning"));
  const reason = () => this.closed || signal?.aborted ? "cancelled" : args.condition === "all_required_settled" && !view().running.some(t => t.required && t.member !== source.name) ? "satisfied" : this.board.state.sequence > after ? "changed" : !progressing() ? "no_progress" : undefined;
  const ready = reason();
  if (ready) return { reason: ready, ...view() };
  return new Promise(resolve => {
   const done = (why: string) => { clearTimeout(timer); this.waiters.delete(wake); signal?.removeEventListener("abort", abort); resolve({ reason: why, ...view() }); };
   const wake = () => { const why = reason(); if (why) done(why); };
   const abort = () => done("cancelled");
   const timer = setTimeout(() => done("timed_out"), Math.min(60000, Math.max(1, args.timeout_ms ?? 10000)));
   this.waiters.add(wake); signal?.addEventListener("abort", abort, { once: true }); wake();
  });
 }
 async tool(name: string, args: any, signal?: AbortSignal, caller = "lead"): Promise<any> {
  if (this.closed) throw new Error("Agent runtime is closed");
  const source = this.caller(caller);
  if (leadOnly.has(name) && caller !== "lead") throw new Error("Lead required");
  if (name.startsWith("team_") && !source.team) throw new Error("Team membership required");
  try {
   switch (name) {
    case "list_team_models": case "list_subagent_models": return { models: this.options.models ?? [] };
    case "spawn_teammate": return await this.spawn(args, caller, "teammate", signal);
    case "subagent": case "subagent_fork": return await this.spawn({ ...args, context: name === "subagent_fork" ? "fork" : "fresh" }, caller, "subagent", signal);
    case "send_message": return await this.send(args, caller, signal);
    case "interrupt_agent": return await this.interrupt(args, caller);
    case "list_agents": return this.list(caller, args.scope);
    case "wait_agent": case "team_wait": return await this.wait(args, caller, signal);
    case "team_report": {
     if (caller === "lead" || !this.executions.has(source.id)) throw new Error("Only an executing teammate can report");
     text(args.summary); this.reports.set(source.id, structuredClone(args)); return { recorded: true };
    }
    case "team_results": { const result = this.lifecycle.results(args.round_id, args.after_seq); for (const row of result.results) this.reads.add(row.id); return result; }
    case "team_results_ack": for (const id of args.result_ids) if (!this.reads.has(id)) throw new Error("Read results before acknowledging"); return this.lifecycle.ack(args.result_ids);
    case "team_finalize": return this.lifecycle.finalize(args.round_id, args.expected_seq, args.dispositions, this.records.some(r => r.kind === "teammate" && r.phase === "provisioning") ? ["members_loading"] : [], args.verification_ids);
    case "team_verification_start": return this.lifecycle.verificationStart(args.command, args.files);
    case "team_verification_finish": return this.lifecycle.verificationFinish(args.verification_id, args.outcome, args.evidence);
    case "team_task_create": { this.lifecycle.begin(source.name); const task = this.board.create(args); this.lifecycle.attachTask(task.id); return task; }
    case "team_task_list": return this.board.tasks();
    case "team_task_get": { const task = this.board.tasks().find(t => t.id === args.task_id); if (!task) throw new Error("Task not found"); return task; }
    case "team_task_update": { this.lifecycle.begin(source.name); const task = this.board.update(source.name, args); this.lifecycle.attachTask(task.id); return task; }
    default: throw new Error(`Unknown agent tool: ${name}`);
   }
  } finally { this.changed(); }
 }
 async detach() {
  if (this.closed) return;
  this.closed = true; this.changed();
  const errors: unknown[] = [];
  for (const execution of this.executions.values()) execution.cancelled = true;
  await Promise.allSettled([...this.handles.values()].map(async handle => { try { await handle.abort(); } catch (error) { errors.push(error); } }));
  await Promise.allSettled([...this.loading.values()]);
  await Promise.allSettled([...this.executions.values()].map(e => e.promise));
  for (const handle of this.handles.values()) { try { handle.dispose(); } catch (error) { errors.push(error); } }
  this.handles.clear(); this.owner.close();
  if (errors.length) throw new AggregateError(errors, "Agent cleanup failed");
 }
}
