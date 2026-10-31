import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, openBoard, type State } from "./core.ts";
const state = (): State => ({ version: 1, teamId: "session", cwd: "/repo", members: [], tasks: [], nextTask: 1, sequence: 0 });
const member = (name: string) => ({ name, description: name, context: "fresh" as const, provider: "test", model: "model", thinking: "off", phase: "active" as const });
test("claims use CAS and enforce owner authorization", () => {
 const b = new Board(state()); b.addMember(member("alice")); b.addMember(member("bob"));
 const t = b.create({ subject: "API", description: "implement" });
 b.update("alice", { task_id: t.id, expected_revision: 1, action: "claim" });
 assert.throws(() => b.update("bob", { task_id: t.id, expected_revision: 1, action: "claim" }), /STALE/);
 assert.throws(() => b.update("bob", { task_id: t.id, expected_revision: 2, action: "complete" }), /owner/);
 assert.equal(b.update("alice", { task_id: t.id, expected_revision: 2, action: "complete" }).status, "completed");
});
test("DAG dependencies block claims; cycles and deletion preserve prior state", () => {
 const b = new Board(state()); const a = b.create({ subject: "API", description: "API" }); const c = b.create({ subject: "UI", description: "UI", blocked_by: [a.id] });
 assert.throws(() => b.update("lead", { task_id: c.id, expected_revision: 1, action: "claim" }), /blocked/);
 assert.throws(() => b.update("lead", { task_id: a.id, expected_revision: 1, action: "set_dependencies", blocked_by: [c.id] }), /cycle/);
 assert.throws(() => b.update("lead", { task_id: a.id, expected_revision: 1, action: "delete" }), /Missing/);
 assert.equal(b.state.tasks[0].revision, 1);
 b.update("lead", { task_id: a.id, expected_revision: 1, action: "claim" }); b.update("lead", { task_id: a.id, expected_revision: 2, action: "complete" });
 assert.equal(b.tasks()[1].ready, true);
});
test("overlap is advisory and member names remain reserved", () => {
 const b = new Board(state()); b.addMember(member("alice")); b.patchMember("alice", { phase: "failed" }); assert.throws(() => b.addMember(member("alice")), /already/);
 for (const scope of ["src", "src/api"]) { const t = b.create({ subject: scope, description: scope, write_scopes: [scope] }); b.update("lead", { task_id: t.id, expected_revision: 1, action: "claim" }); }
 assert.deepEqual(b.tasks()[1].writeScopeWarnings, ["task-1"]);
 assert.throws(() => b.create({ subject: "bad", description: "bad", write_scopes: ["../secret"] }), /relative/);
});
test("atomic persistence and single-owner lock survive reopen", () => {
 const root = mkdtempSync(join(tmpdir(), "pi-teams-"));
 try { const a = openBoard(root, "session", "/repo"); a.board.addMember(member("alice")); assert.throws(() => openBoard(root, "session", "/repo"), /owned/); a.close(); const b = openBoard(root, "session", "/repo"); assert.equal(b.board.member("alice").name, "alice"); b.close(); assert.throws(() => openBoard(root, "session", "/different"), /Invalid/); } finally { rmSync(root, { recursive: true, force: true }); }
});
test("persistence failure never commits a task mutation", () => {
 const b = new Board(state(), () => { throw new Error("disk full"); }); assert.throws(() => b.create({ subject: "x", description: "x" }), /disk full/); assert.equal(b.state.nextTask, 1); assert.equal(b.state.tasks.length, 0);
});

test("completion rechecks dependencies and completed dependents protect prerequisites", () => {
 const b = new Board(state());
 const a = b.create({subject:"A",description:"prerequisite"});
 const dependent = b.create({subject:"B",description:"dependent",blocked_by:[a.id]});
 const update = (id: string, action: any, extra = {}) => b.update("lead", {task_id:id,expected_revision:b.state.tasks.find(t => t.id === id)!.revision,action,...extra});
 update(a.id,"claim"); update(a.id,"complete"); update(dependent.id,"claim");
 update(a.id,"reopen");
 const revision = b.state.tasks[1].revision;
 assert.throws(() => update(dependent.id,"complete"), /dependencies/);
 assert.equal(b.state.tasks[1].revision,revision);
 assert.equal(b.state.tasks[1].status,"in_progress");
 update(a.id,"claim"); update(a.id,"complete"); update(dependent.id,"complete");
 assert.throws(() => update(a.id,"reopen"), /reopen dependent tasks first/);
 assert.equal(b.state.tasks[0].status,"completed");
 const c = b.create({subject:"C",description:"new prerequisite"});
 assert.throws(() => update(dependent.id,"set_dependencies", {blocked_by:[c.id]}), /completed dependencies/);
 update(dependent.id,"reopen"); update(a.id,"reopen");
 assert.equal(b.state.tasks[0].status,"pending");
});
test("adding an unfinished dependency to running work blocks completion", () => {
 const b = new Board(state());
 const a = b.create({subject:"A",description:"prerequisite"});
 const t = b.create({subject:"B",description:"work"});
 b.update("lead", {task_id:t.id,expected_revision:1,action:"claim"});
 b.update("lead", {task_id:t.id,expected_revision:2,action:"set_dependencies",blocked_by:[a.id]});
 assert.throws(() => b.update("lead", {task_id:t.id,expected_revision:3,action:"complete"}), /dependencies/);
});
