import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join, posix } from "node:path";
import type { Ledger } from "./lifecycle.ts";

export type PendingMessage = { id: string; target: string; sender: string; text: string; turnId?: string; status: "queued" | "admitted" };
export type ChildRecord = { id: string; name: string; description: string; parent: string; kind: "teammate" | "subagent"; context: "fresh" | "fork"; cwd: string; sessionFile?: string; provider: string; model: string; thinking: string; phase: "provisioning" | "active" | "failed"; error?: string };
export type Member = { id?: string; parent?: string; kind?: "teammate"; cwd?: string; name: string; description: string; context: "fresh" | "fork"; sessionFile?: string; provider: string; model: string; thinking: string; terminal?: string; phase: "provisioning" | "active" | "failed"; error?: string };
export type Task = { id: string; subject: string; description: string; status: "pending" | "in_progress" | "completed" | "deleted"; revision: number; owner?: string; blockedBy: string[]; writeScopes: string[] };
export type State = { version: 1 | 2; teamId: string; cwd: string; members: Member[]; tasks: Task[]; nextTask: number; sequence: number; coordination?: Ledger; children?: ChildRecord[]; inbox?: PendingMessage[] };
export type Update = { task_id: string; expected_revision: number; action: "claim" | "release" | "complete" | "reopen" | "reassign" | "edit" | "set_dependencies" | "delete"; owner?: string; subject?: string; description?: string; blocked_by?: string[]; write_scopes?: string[] };
export function text(value: string, limit = 16384) { if (!value.trim() || value.length > limit) throw new Error(`Expected nonempty text up to ${limit} characters`); return value; }
function scopes(values: string[]) { return [...new Set(values.map(value => { const path = posix.normalize(value.replaceAll("\\", "/")).replace(/\/$/, ""); if (!path || path === "." || path.startsWith("/") || path === ".." || path.startsWith("../") || /^[A-Za-z]:/.test(path)) throw new Error("write_scopes must be workspace-relative paths"); return path; }))]; }
export class Board {
 state: State;
 private save: (state: State) => void;
 constructor(state: State, save: (state: State) => void = () => {}) { this.state = structuredClone(state); this.save = save; }
 change<T>(fn: (draft: State) => T): T { const draft = structuredClone(this.state); const result = fn(draft); draft.sequence++; this.save(draft); this.state = draft; return structuredClone(result); }
 member(name: string) { const member = this.state.members.find(m => m.name === name); if (!member) throw new Error("Unknown teammate"); return member; }
 addMember(member: Member) { return this.change(s => { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(member.name) || member.name.length > 64 || member.name === "lead") throw new Error("Invalid teammate name"); text(member.description, 200); if (s.members.some(m => m.name === member.name)) throw new Error("Teammate name already used"); if (s.members.length >= 16) throw new Error("Team member limit reached"); s.members.push(member); return member; }); }
 patchMember(name: string, patch: Partial<Member>) { return this.change(s => { const m = s.members.find(m => m.name === name); if (!m) throw new Error("Unknown teammate"); Object.assign(m, patch); return m; }); }
 ready(task: Task, state = this.state) { return task.blockedBy.every(id => state.tasks.find(t => t.id === id)?.status === "completed"); }
 validate(state: State) { const visiting = new Set<string>(), visited = new Set<string>(); const visit = (id: string) => { if (visiting.has(id)) throw new Error("Task dependency cycle"); if (visited.has(id)) return; const t = state.tasks.find(t => t.id === id && t.status !== "deleted"); if (!t) throw new Error("Missing task dependency"); if (new Set(t.blockedBy).size !== t.blockedBy.length) throw new Error("Duplicate dependency"); visiting.add(id); t.blockedBy.forEach(visit); visiting.delete(id); visited.add(id); }; state.tasks.filter(t => t.status !== "deleted").forEach(t => visit(t.id)); }
 create(input: { subject: string; description: string; blocked_by?: string[]; write_scopes?: string[] }) { return this.change(s => { if (s.tasks.filter(t => t.status !== "deleted").length >= 256) throw new Error("Task limit reached"); const t: Task = { id: `task-${s.nextTask++}`, subject: text(input.subject, 200), description: text(input.description), status: "pending", revision: 1, blockedBy: input.blocked_by ?? [], writeScopes: scopes(input.write_scopes ?? []) }; s.tasks.push(t); this.validate(s); return t; }); }
 update(caller: string, input: Update) { return this.change(s => { const t = s.tasks.find(t => t.id === input.task_id); if (!t || t.status === "deleted") throw new Error("Task not found"); if (t.revision !== input.expected_revision) throw new Error("TEAM_TASK_STALE_REVISION: re-read task"); const lead = caller === "lead"; const owned = () => { if (!lead && t.owner !== caller) throw new Error("Requires owner or Lead"); }; switch (input.action) {
 case "claim": if (t.status !== "pending" || t.owner && t.owner !== caller || !this.ready(t, s)) throw new Error("Task blocked or owned"); t.owner = caller; t.status = "in_progress"; break;
 case "release": owned(); if (t.status !== "in_progress") throw new Error("Task is not in progress"); delete t.owner; t.status = "pending"; break;
 case "complete": owned(); if (t.status !== "in_progress") throw new Error("Task is not in progress"); if (!this.ready(t, s)) throw new Error("Task dependencies are not completed"); t.status = "completed"; break;
 case "reopen": owned(); if (t.status !== "completed") throw new Error("Task is not completed"); delete t.owner; t.status = "pending"; break;
 case "reassign": if (!lead) throw new Error("Lead required"); if (!["pending", "in_progress"].includes(t.status)) throw new Error("Task cannot be reassigned"); if (input.owner) { if (input.owner !== "lead" && !s.members.some(m => m.name === input.owner && m.phase === "active")) throw new Error("Unknown active owner"); if (!this.ready(t, s)) throw new Error("Task blocked"); t.owner = input.owner; t.status = "in_progress"; } else { delete t.owner; t.status = "pending"; } break;
 case "edit": owned(); if (input.subject !== undefined) t.subject = text(input.subject, 200); if (input.description !== undefined) t.description = text(input.description); if (input.write_scopes !== undefined) t.writeScopes = scopes(input.write_scopes); break;
 case "set_dependencies": owned(); if (!input.blocked_by) throw new Error("blocked_by required"); t.blockedBy = input.blocked_by; break;
 case "delete": owned(); t.status = "deleted"; break;
 default: throw new Error("Unknown task action"); }
 t.revision++; this.validate(s);
 if (s.tasks.some(task => task.status === "completed" && !this.ready(task, s))) throw new Error("Completed tasks require completed dependencies; reopen dependent tasks first");
 return t; }); }
 tasks() { return this.state.tasks.filter(t => t.status !== "deleted").map(t => ({ ...structuredClone(t), ready: t.status === "pending" && this.ready(t), writeScopeWarnings: this.state.tasks.filter(other => other.id !== t.id && other.status === "in_progress" && t.writeScopes.some(a => other.writeScopes.some(b => a === b || a.startsWith(b + "/") || b.startsWith(a + "/")))).map(t => t.id) })); }
}
export function openBoard(root: string, teamId: string, cwd: string) {
 const directory = join(root, teamId); mkdirSync(directory, { recursive: true, mode: 0o700 }); const lock = join(directory, "owner.lock");
 try { mkdirSync(lock); } catch { throw new Error(`Team already owned or stale lock: ${lock}. Close its owner before removing a stale lock.`); }
 const file = join(directory, "state.json");
 try { let state: State; try { state = JSON.parse(readFileSync(file, "utf8")); } catch (e: any) { if (e.code !== "ENOENT") throw e; state = { version: 1, teamId, cwd, members: [], tasks: [], nextTask: 1, sequence: 0 }; }
 if (![1, 2].includes(state.version) || state.teamId !== teamId || state.cwd !== cwd || !Array.isArray(state.members) || !Array.isArray(state.tasks)) throw new Error("Invalid Team state");
 const board = new Board(state, s => { const temporary = file + ".tmp"; writeFileSync(temporary, JSON.stringify(s), { mode: 0o600 }); renameSync(temporary, file); }); board.validate(state);
 return { board, directory, close: () => rmSync(lock, { recursive: true, force: true }) };
 } catch(e) { rmSync(lock, { recursive: true, force: true }); throw e; }
}
