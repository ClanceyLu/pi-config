import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint } from "./verification.ts";
import { Board, type State } from "./core.ts";
import { Lifecycle } from "./lifecycle.ts";
const state = (): State => ({ version: 1, teamId: "session", cwd: "/repo", members: [], tasks: [], nextTask: 1, sequence: 0 });
test("v1 migration and interrupted recovery preserve exact outcomes without replaying results", () => {
 const board = new Board(state()); const life = new Lifecycle(board); life.initialize();
 const turn = life.admit("lead", "reviewer", "inspect side effects"); life.running(turn.id);
 const reopened = new Lifecycle(new Board(board.state)); reopened.initialize();
 assert.equal(reopened.state.turns[0].status,"recovery_required"); assert.equal(reopened.state.turns[0].prompt,"");
 assert.equal(reopened.results().results[0].outcome,"recovery_required");
 reopened.initialize(); assert.equal(reopened.results().results.length,1);
});
test("exact acknowledgement, stale sequence and unresolved blockers guard sealing", () => {
 const life = new Lifecycle(new Board(state())); life.initialize();
 const turn = life.admit("lead","reviewer","inspect"); life.running(turn.id);
 const result = life.finish(turn.id,"failed","connection error");
 assert.throws(()=>life.ack([result.id,"unknown"]),/Unknown/); assert.equal(life.state.results[0].acknowledged_at,undefined);
 life.ack([result.id]);
 assert.equal(life.finalize(turn.round_id,0).sealed,false);
 assert.equal(life.finalize(turn.round_id,life.board.state.sequence).sealed,false);
 assert.throws(()=>life.finalize(turn.round_id,life.board.state.sequence,{garbage:"ignore"}),/Invalid/);
 assert.equal(life.finalize(turn.round_id,life.board.state.sequence,{[result.id]:"Failure disclosed; blocked delivery"}).sealed,true);
 assert.throws(()=>life.admit("reviewer","peer","late"),/Only Lead/);
});
test("successful execution with a reported blocker still requires disposition", () => {
 const life = new Lifecycle(new Board(state())); life.initialize();
 const turn = life.admit("lead","reviewer","inspect"); life.running(turn.id);
 const result = life.finish(turn.id,"succeeded","inspection complete",{summary:"inspection complete",blocker:"missing input"});
 life.ack([result.id]); assert.equal(life.finalize(turn.round_id,life.board.state.sequence).sealed,false);
 assert.equal(life.finalize(turn.round_id,life.board.state.sequence,{[result.id]:"Awaiting user input"}).sealed,true);
});
test("failed persistence leaves a running turn recoverable and emits no success", () => {
 let fail = false;
 const board = new Board(state(),()=>{ if(fail) throw new Error("disk full"); }); const life = new Lifecycle(board); life.initialize();
 const turn = life.admit("lead","reviewer","inspect"); life.running(turn.id); fail=true;
 assert.throws(()=>life.finish(turn.id,"succeeded","done"),/disk full/);
 assert.equal(life.state.turns[0].status,"running"); assert.equal(life.state.results.length,0);
});
test("historical unfinished tasks remain blockers after migration", () => {
 const board = new Board(state()); const task = board.create({subject:"legacy",description:"unfinished"});
 const life = new Lifecycle(board); life.initialize(); const round = life.begin("lead");
 assert.deepEqual(life.snapshot().task_blockers,[task.id]);
 assert.equal(life.finalize(round.id,board.state.sequence).sealed,false);
});

test("verification binds listed files, rejects mid-check edits and invalidates stale evidence", () => {
 const root = mkdtempSync(join(tmpdir(), "pi-team-verification-"));
 try {
  writeFileSync(join(root,"app.ts"),"before");
  const life = new Lifecycle(new Board({...state(),cwd:root})); life.initialize(); const round = life.begin("lead");
  const first = life.verificationStart("node --test",["app.ts"]);
  writeFileSync(join(root,"app.ts"),"after");
  assert.throws(()=>life.verificationFinish(first.id,"passed","exit 0"),/changed/);
  const second = life.verificationStart("node --test",["app.ts"]); life.verificationFinish(second.id,"passed","exit 0");
  writeFileSync(join(root,"unrelated.ts"),"unrelated"); assert.equal(life.verificationStatus()[1].stale,false);
  writeFileSync(join(root,"app.ts"),"changed again");
  assert.equal(life.finalize(round.id,life.board.state.sequence,{},[],[second.id]).sealed,false);
  assert.throws(()=>fingerprint(root,["../outside"]),/escapes/);
  const third = life.verificationStart("node --test",["app.ts"]); life.verificationFinish(third.id,"passed","exit 0");
  assert.equal(life.finalize(round.id,life.board.state.sequence,{},[],[third.id]).sealed,true);
 } finally { rmSync(root,{recursive:true,force:true}); }
});
