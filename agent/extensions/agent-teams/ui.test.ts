import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import "../tests/pi-runtime.mjs";
const { TeamDashboard, heading, widgetLines, transcriptTail, toolRenderers } = await import("./ui.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");
import type { TeamView } from "./ui.ts";
function view(): TeamView {
 return { phase: "open", unseenFailures: 1, members: [{ name: "审阅者", status: "idle", latest_outcome: "failed", description: "检查接口", provider: "provider", model: "test", thinking: "high" }, { name: "tests", status: "running", preview: "回归验证中" }], tasks: [{ id: "task-1", subject: "接口测试", status: "pending", ready: false, owner: "tests", writeScopeWarnings: ["task-2"] }], results: [{ id: "result-1", round_id: "round-1", member: "审阅者", kind: "result", outcome: "failed", summary: "发现一个需要处理的问题。\n完整结果", produced_at: "2026-10-31T07:30:00Z", seq: 1 }] };
}
test("widget shows team summary and task counts within terminal width", () => {
 const model = view();
 for (const width of [1, 12, 24, 80]) assert.ok(widgetLines(model, width).every(line => visibleWidth(line) <= width));
 assert.deepEqual(widgetLines(model, 200), [heading(model), "任务 0/1 · /team 查看详情"]);
 assert.match(heading(model), /1 未读异常/);
 model.phase = "sealed"; assert.equal(widgetLines(model, 100).length, 2); assert.match(widgetLines(model, 100)[0], /已收尾/);
 model.storageError = "disk\x1b[2Jfull"; assert.ok(widgetLines(model, 100).every(line => !line.includes("\x1b")));
});
test("heading counts pending tasks separately from unacknowledged results and messages", () => {
 const model = view();
 model.tasks.push({ ...model.tasks[0], id: "active", status: "in_progress" }, { ...model.tasks[0], id: "done", status: "completed" });
 model.results.push({ ...model.results[0], id: "info", kind: "info", outcome: undefined }, { ...model.results[0], id: "acknowledged", acknowledged_at: "2026-10-31T08:00:00Z" });
 assert.match(heading(model), /1 任务待处理 · 2 条结果\/消息待确认/);
 model.results[0].acknowledged_at = "2026-10-31T08:00:00Z";
 model.tasks[0].status = "in_progress";
 assert.match(heading(model), /0 任务待处理 · 1 条结果\/消息待确认/);
});
test("dashboard navigates details, marks only UI reads, wraps Chinese text and cleans subscriptions", () => {
 const model = view(); let closed = false, removed = 0, renders = 0; let listener: (() => void) | undefined; const seen: string[] = [];
 const dashboard = new TeamDashboard({ view: () => model, height: () => 12, render: () => { renders++; }, done: () => { closed = true; }, seen: ids => { seen.push(...ids); }, subscribe: fn => { listener = fn; return () => { removed++; }; } });
 assert.equal(seen.length, 0);
 assert.match(dashboard.render(100).join("\n"), /模型：provider\/test · high/);
 assert.match(dashboard.render(100).join("\n"), /模型：未知/);
 dashboard.render(24); dashboard.handleInput("\r");
 assert.ok(seen.includes("result-1")); assert.equal(model.results[0].acknowledged_at, undefined);
 assert.ok(dashboard.render(24).join("\n").includes("待 Lead 确认"));
 assert.match(dashboard.render(100).join("\n"), /模型：provider\/test · high/);
 model.results.push({ ...model.results[0], id: "result-2" }); listener?.(); assert.ok(seen.includes("result-2"));
 for (const width of [1, 12, 24, 80]) { const lines = dashboard.render(width); assert.ok(lines.length <= 12); assert.ok(lines.every(line => visibleWidth(line) <= width)); }
 dashboard.handleInput("\x1b"); dashboard.handleInput("\x1b[B"); dashboard.handleInput("\r"); assert.match(dashboard.render(80)[0], /tests/);
 dashboard.handleInput("q"); assert.equal(closed, true); dashboard.dispose(); dashboard.dispose(); assert.equal(removed, 1); assert.ok(renders > 0);
});
test("long task lists can scroll beyond the selected member", () => {
 const model = view(); model.tasks = Array.from({length: 30}, (_, i) => ({ ...model.tasks[0], id: `task-${i}`, subject: `Task ${i}` }));
 const dashboard = new TeamDashboard({ view: () => model, height: () => 10, render() {}, done() {}, seen() {}, subscribe: () => () => {} });
 dashboard.render(80); for (let i = 0; i < 5; i++) dashboard.handleInput("\x1b[6~");
 assert.match(dashboard.render(80).join("\n"), /Task 29/); dashboard.dispose();
});
test("log reader tolerates partial JSONL, bounds reads and strips terminal controls", () => {
 const root = mkdtempSync(join(tmpdir(), "team-ui-"));
 try {
  const file = join(root, "child.jsonl");
  writeFileSync(file, JSON.stringify({ message: {role: "assistant", content: [{type: "text", text: "完成\x1b[2J"}] } }) + '\n{"incomplete":');
  assert.match(transcriptTail(file).join("\n"), /完成/); assert.ok(!transcriptTail(file).join("\n").includes("\x1b"));
  writeFileSync(file, "x".repeat(140000) + "\n" + JSON.stringify({message:{role:"assistant",content:"recent"}}) + "\n");
  assert.match(transcriptTail(file).join("\n"), /128 KiB/); assert.match(transcriptTail(file).join("\n"), /recent/);
  assert.match(transcriptTail(join(root,"missing"))[0], /读取失败/);
 } finally { rmSync(root,{recursive:true,force:true}); }
});
test("compact tool renderers preserve expanded details and SDK errors", () => {
 const renderer = toolRenderers("team_finalize"), theme = {fg: (_color: string, text: string) => text};
 const result = {details: {sealed:false,blockers:["unacknowledged_results"]},content:[{type:"text",text:'{"sealed":false}'}]};
 assert.match(renderer.renderResult(result,{expanded:false},theme).render(100).join("\n"), /尚未收尾/);
 assert.match(renderer.renderResult(result,{expanded:true},theme).render(100).join("\n"), /"sealed":false/);
 assert.match(renderer.renderResult({...result,content:[{type:"text",text:"disk full"}]},{expanded:false},theme,{isError:true}).render(100).join("\n"), /disk full/);
});
