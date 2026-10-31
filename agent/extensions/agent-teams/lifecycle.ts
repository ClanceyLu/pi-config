import { randomUUID } from "node:crypto";
import { Board, text, type State } from "./core.ts";
import { fingerprint } from "./verification.ts";

export type Outcome = "succeeded" | "failed" | "cancelled" | "recovery_required";
export type Turn = { id: string; round_id: string; member: string; sender: string; prompt: string; required: boolean; status: "queued" | "running" | "cancelling" | Outcome; created_at: string };
export type Result = { id: string; round_id: string; turn_id?: string; member: string; kind: "result" | "info" | "decision" | "blocker"; outcome?: Outcome; summary: string; produced_at: string; seq: number; acknowledged_at?: string; report?: Report };
export type Report = { summary: string; artifacts?: string[]; verification?: string[]; blocker?: string };
export type Verification = { id: string; round_id: string; stage: "before" | "after"; command: string; outcome?: "passed" | "failed"; evidence?: string; files: Record<string, string>; recorded_at: string; completed_at?: string };
export type Round = { id: string; status: "open" | "sealed"; task_ids: string[]; created_at: string; delivery_id?: string; dispositions?: Record<string, string> };
export type Ledger = { rounds: Round[]; turns: Turn[]; results: Result[]; verifications?: Verification[] };
const now = () => new Date().toISOString();
export const unsettled = (turn: Turn) => ["queued", "running", "cancelling"].includes(turn.status);
const ledger = (s: State) => s.coordination!;
const addResult = (s: State, result: Omit<Result, "id" | "seq" | "produced_at">) => {
 const row: Result = { ...result, id: randomUUID(), seq: s.sequence + 1, produced_at: now() };
 ledger(s).results.push(row); return row;
};

/** All mutations commit through Board.change; no asynchronous SDK calls inside a transaction. */
export class Lifecycle {
 readonly board: Board;
 constructor(board: Board) { this.board = board; }
 get state() { return this.board.state.coordination!; }
 get current() { return this.state.rounds.at(-1); }
 initialize() {
  this.board.change(s => {
   s.version = 2;
   s.coordination ??= { rounds: [], turns: [], results: [] };
   for (const turn of ledger(s).turns.filter(unsettled)) {
    turn.status = "recovery_required";
    addResult(s, { round_id: turn.round_id, turn_id: turn.id, member: turn.member, kind: "result", outcome: "recovery_required", summary: "Execution stopped before a durable outcome. Inspect the child session before retrying side effects." });
    turn.prompt = "";
   }
  });
 }
 begin(caller: string) {
  if (this.current?.status === "open") return this.current;
  if (caller !== "lead") throw new Error("Only Lead can open a new collaboration round");
  return this.board.change(s => {
   // Preserve legacy unfinished tasks as explicit blockers on first use.
   const round: Round = { id: randomUUID(), status: "open", task_ids: ledger(s).rounds.length ? [] : s.tasks.filter(t => !["completed", "deleted"].includes(t.status)).map(t => t.id), created_at: now() };
   ledger(s).rounds.push(round); return round;
  });
 }
 open(roundId?: string) {
  const round = this.current;
  if (!round || round.status !== "open" || roundId && round.id !== roundId) throw new Error("Collaboration round is closed or changed");
  return round;
 }
 capacity() {
  if (this.state.turns.length >= 1024 || this.state.results.length >= 4096 || this.state.rounds.length >= 256) throw new Error("Team history capacity reached; start a new Lead session. Existing records are retained.");
 }
 admit(caller: string, member: string, prompt: string, required = true) {
  text(prompt, 65536); this.capacity(); const round = this.begin(caller);
  return this.board.change(s => {
   const turn: Turn = { id: randomUUID(), round_id: round.id, member, sender: caller, prompt, required, status: "queued", created_at: now() };
   ledger(s).turns.push(turn); return turn;
  });
 }
 running(id: string) {
  this.board.change(s => { const turn = ledger(s).turns.find(t => t.id === id)!; if (turn.status !== "queued") throw new Error("Turn is not queued"); turn.status = "running"; });
 }
 finish(id: string, outcome: Outcome, summary: string, report?: Report) {
  return this.board.change(s => {
   const turn = ledger(s).turns.find(t => t.id === id);
   if (!turn || !unsettled(turn)) throw new Error("Turn is already settled");
   turn.status = outcome; turn.prompt = "";
   return addResult(s, { round_id: turn.round_id, turn_id: id, member: turn.member, kind: "result", outcome, summary: summary.slice(0, 16384), report });
  });
 }
 message(member: string, summary: string, kind: "info" | "decision" | "blocker") {
  this.capacity(); text(summary, 65536); const round = this.open();
  return this.board.change(s => addResult(s, { round_id: round.id, member, kind, summary }));
 }
 attachTask(id: string) {
  const round = this.open();
  if (!round.task_ids.includes(id)) this.board.change(s => { ledger(s).rounds.find(r => r.id === round.id)!.task_ids.push(id); });
 }
 snapshot(roundId = this.current?.id) {
  const round = this.state.rounds.find(r => r.id === roundId);
  if (roundId && !round) throw new Error("Unknown collaboration round");
  const turns = this.state.turns.filter(t => t.round_id === roundId);
  return { round: round ? structuredClone(round) : null, event_seq: this.board.state.sequence, running: turns.filter(unsettled).map(({ prompt: _prompt, ...t }) => t), unacknowledged_result_ids: this.state.results.filter(r => r.round_id === roundId && !r.acknowledged_at).map(r => r.id), task_blockers: this.board.state.tasks.filter(t => round?.task_ids.includes(t.id) && !["completed", "deleted"].includes(t.status)).map(t => t.id), all_required_settled: !turns.some(t => t.required && unsettled(t)) };
 }
 results(roundId = this.current?.id, after = -1) {
  this.snapshot(roundId);
  return { round_id: roundId, event_seq: this.board.state.sequence, results: structuredClone(this.state.results.filter(r => r.round_id === roundId && r.seq > after)) };
 }
 ack(ids: string[]) {
  for (const id of ids) if (!this.state.results.some(r => r.id === id)) throw new Error(`Unknown result: ${id}`);
  return this.board.change(s => { for (const result of ledger(s).results) if (ids.includes(result.id)) result.acknowledged_at ??= now(); return { acknowledged: ids }; });
 }
 verificationStart(command: string, files: string[]) {
  text(command, 2048); this.open();
  if (this.snapshot().running.length) throw new Error("Wait for all member work before starting final verification");
  const snapshot = fingerprint(this.board.state.cwd, files);
  return this.board.change(s => {
   const v: Verification = { id: randomUUID(), round_id: this.current!.id, stage: "before", command, files: snapshot, recorded_at: now() };
   (ledger(s).verifications ??= []).push(v); return v;
  });
 }
 verificationFinish(id: string, outcome: "passed" | "failed", evidence: string) {
  text(evidence, 16384); this.open();
  const check = this.state.verifications?.find(v => v.id === id && v.round_id === this.current!.id);
  if (!check || check.stage !== "before") throw new Error("Unknown or already completed verification");
  const snapshot = fingerprint(this.board.state.cwd, Object.keys(check.files));
  if (JSON.stringify(snapshot) !== JSON.stringify(check.files)) throw new Error("Verification files changed during the check; record a new verification");
  if (this.snapshot().running.length) throw new Error("Member work is still executing");
  return this.board.change(s => { const v = ledger(s).verifications!.find(v => v.id === id)!; v.stage = "after"; v.outcome = outcome; v.evidence = evidence; v.completed_at = now(); return v; });
 }
 verificationStatus(roundId = this.current?.id) {
  return (this.state.verifications ?? []).filter(v => v.round_id === roundId).map(v => {
   let stale = true;
   try { stale = JSON.stringify(fingerprint(this.board.state.cwd, Object.keys(v.files))) !== JSON.stringify(v.files); } catch { /* Unreadable files invalidate evidence. */ }
   return { ...structuredClone(v), stale };
  });
 }
 finalize(roundId: string, expected: number, dispositions: Record<string, string> = {}, externalBlockers: string[] = [], verificationIds: string[] = []) {
  const round = this.open(roundId);
  if (expected !== this.board.state.sequence) return { sealed: false, blockers: ["stale_sequence"], ...this.snapshot(roundId) };
  for (const [id, reason] of Object.entries(dispositions)) {
   text(reason, 2048);
   if (!round.task_ids.includes(id) && !this.state.results.some(r => r.round_id === roundId && r.id === id && (r.outcome && r.outcome !== "succeeded" || r.kind === "blocker" || r.kind === "decision" || r.report?.blocker))) throw new Error(`Invalid disposition: ${id}`);
  }
  const view = this.snapshot(roundId);
  const blockers = [...externalBlockers];
  const verification = this.verificationStatus(roundId);
  for (const id of verificationIds) {
   const check = verification.find(v => v.id === id);
   if (!check || check.stale || check.stage !== "after" || check.outcome !== "passed") blockers.push(`invalid_verification:${id}`);
  }
  if (view.running.length) blockers.push("members_not_settled");
  if (view.unacknowledged_result_ids.length) blockers.push("unacknowledged_results");
  for (const id of view.task_blockers) if (!dispositions[id]) blockers.push(`unfinished_task:${id}`);
  for (const result of this.state.results.filter(r => r.round_id === roundId && (r.outcome && r.outcome !== "succeeded" || r.kind === "blocker" || r.kind === "decision" || r.report?.blocker))) if (!dispositions[result.id]) blockers.push(`unresolved_outcome:${result.id}`);
  if (blockers.length) return { sealed: false, blockers, ...view };
  const delivery = this.board.change(s => { const r = ledger(s).rounds.find(r => r.id === roundId)!; r.status = "sealed"; r.delivery_id = randomUUID(); r.dispositions = dispositions; return r; });
  return { sealed: true, verification: verification.filter(v => verificationIds.includes(v.id)), verification_scope: "Lead-reported commands; hashes cover only the explicitly listed files. No independent command execution or complete workspace coverage is implied.", delivery, results: this.results(roundId).results, ...this.snapshot(roundId) };
 }
}
