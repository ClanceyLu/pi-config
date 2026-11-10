import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { Text, matchesKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Result } from "./lifecycle.ts";

export type MemberView = { name: string; description?: string; status: string; latest_outcome?: string; provider?: string; model?: string; thinking?: string; sessionFile?: string; error?: string; preview?: string };
export type TaskView = { id: string; subject: string; status: string; owner?: string; ready: boolean; writeScopeWarnings: string[] };
export type TeamView = { phase: "open" | "sealed" | "empty"; members: MemberView[]; tasks: TaskView[]; results: Result[]; unseenFailures: number; storageError?: string };
const status: Record<string, string> = { running: "执行中", inactive: "空闲", idle: "空闲", cancelling: "取消中", provisioning: "准备中", failed: "创建失败", recovery_required: "需要恢复" };
const outcome: Record<string, string> = { succeeded: "成功", failed: "失败", cancelled: "已取消", recovery_required: "需要恢复" };
const glyph: Record<string, string> = { running: "●", cancelling: "◐", provisioning: "…", failed: "×", inactive: "○", idle: "○", recovery_required: "!" };
export const clean = (value: string) => stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const oneLine = (value: string) => clean(value).replace(/\s+/g, " ").trim();
const phase = (view: TeamView) => view.phase === "sealed" ? "已收尾" : view.phase === "empty" ? "待分配" : "协作中";
const completed = (view: TeamView) => view.tasks.filter(t => t.status === "completed").length;
export function heading(view: TeamView) {
 return `Team · ${phase(view)} · ${view.members.filter(m => m.status === "running" || m.status === "cancelling").length} 执行中 · ${view.tasks.filter(t => t.status === "pending").length} 任务待处理 · ${view.results.filter(r => !r.acknowledged_at).length} 条结果/消息待确认${view.unseenFailures ? ` · ! ${view.unseenFailures} 未读异常` : ""}`;
}
function memberLine(member: MemberView) {
 const last = member.latest_outcome && outcome[member.latest_outcome];
 return `${glyph[member.status] ?? "·"} ${member.name} · ${status[member.status] ?? member.status}${last && member.status !== "running" ? ` · 最近：${last}` : ""}`;
}
function modelLine(member: MemberView) {
 return `模型：${member.provider ? member.provider + "/" : ""}${member.model ?? "未知"}${member.thinking ? ` · ${member.thinking}` : ""}`;
}
export function widgetLines(view: TeamView, width: number): string[] {
 const lines = [heading(view)];
 if (view.storageError) lines.push(`! ${oneLine(view.storageError)}`);
 lines.push(`任务 ${completed(view)}/${view.tasks.length} · /team 查看详情`);
 return lines.map(line => truncateToWidth(oneLine(line), Math.max(1, width)));
}

/** Read only a bounded log suffix; viewing never acknowledges model results. */
export function transcriptTail(file?: string): string[] {
 if (!file) return ["尚无执行日志。"];
 let fd: number | undefined;
 try {
  fd = openSync(file, "r"); const size = fstatSync(fd).size;
  const bytes = Math.min(size, 128 * 1024), buffer = Buffer.alloc(bytes);
  const read = readSync(fd, buffer, 0, bytes, size - bytes);
  const lines = buffer.subarray(0, read).toString("utf8").split("\n");
  if (size > bytes) lines.shift();
  const output = size > bytes ? ["… 仅显示最近 128 KiB 日志"] : [];
  for (const line of lines) {
   if (!line.trim()) continue;
   let entry;
   try { entry = JSON.parse(line); } catch { continue; /* A trailing in-progress JSONL record is not readable yet. */ }
   const message = entry.message;
   if (!message || !["user", "assistant", "toolResult"].includes(message.role)) continue;
   const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
   if (!Array.isArray(blocks)) continue;
   const text = blocks.flatMap(block => block?.type === "text" ? [String(block.text ?? "")] : block?.type === "toolCall" ? [`[工具 ${block.name}]`] : []).join("\n");
   if (text.trim()) output.push(`[${message.role}${message.toolName ? " · " + message.toolName : ""}]`, ...clean(text).slice(0, 12000).split("\n"), "");
  }
  return output.length ? output : ["尚无可显示的日志。"];
 } catch (error) { return [`日志读取失败：${oneLine(String(error))}`]; }
 finally { if (fd !== undefined) closeSync(fd); }
}

export type DashboardOptions = { view: () => TeamView; height: () => number; render: () => void; done: () => void; seen: (ids: string[]) => void; subscribe: (refresh: () => void) => () => void };
/** A read-only, live dashboard. No model tools or persistence mutations are called here. */
export class TeamDashboard {
 private options: DashboardOptions;
 private selected?: string;
 private detail = false;
 private log = false;
 private offset = 0;
 private maxOffset = 0;
 private revealSelection = true;
 private logLines: string[] = [];
 private unsubscribe: () => void;
 private disposed = false;
 constructor(options: DashboardOptions) {
  this.options = options;
  this.unsubscribe = options.subscribe(() => { this.markSeen(); options.render(); });
  this.markSeen();
 }
 private markSeen() {
  const view = this.options.view();
  // List view does not mark off-screen rows as read; only an opened member's results are read.
  if (this.detail) this.options.seen(view.results.filter(r => r.member === this.selected).map(r => r.id));
 }
 dispose() { if (!this.disposed) { this.disposed = true; this.unsubscribe(); } }
 invalidate() {}
 handleInput(data: string) {
  if (matchesKey(data, "escape")) { if (this.detail) { this.detail = false; this.log = false; this.offset = 0; } else this.options.done(); }
  else if (data === "q" || matchesKey(data, "ctrl+c")) this.options.done();
  else if (!this.detail && (matchesKey(data, "up") || matchesKey(data, "down"))) {
   const members = this.options.view().members;
   const index = Math.max(0, members.findIndex(m => m.name === this.selected));
   this.selected = members[Math.max(0, Math.min(members.length - 1, index + (matchesKey(data, "up") ? -1 : 1)))]?.name;
   this.offset = 0; this.revealSelection = true;
  } else if (!this.detail && matchesKey(data, "enter") && this.selected) { this.detail = true; this.offset = 0; this.markSeen(); }
  else if (this.detail && data === "l") { this.log = !this.log; this.offset = 0; if (this.log) this.loadLog(); }
  else if (this.detail && data === "r") { if (this.log) this.loadLog(); this.markSeen(); }
  else if (matchesKey(data, "pageDown") || this.detail && matchesKey(data, "down")) this.offset = Math.min(this.maxOffset, this.offset + (this.detail && matchesKey(data, "down") ? 1 : 8));
  else if (matchesKey(data, "pageUp") || this.detail && matchesKey(data, "up")) this.offset = Math.max(0, this.offset - (this.detail && matchesKey(data, "up") ? 1 : 8));
  this.options.render();
 }
 private loadLog() { this.logLines = transcriptTail(this.options.view().members.find(m => m.name === this.selected)?.sessionFile); }
 render(width: number): string[] {
  const view = this.options.view(); const cols = Math.max(1, width);
  if (!view.members.some(m => m.name === this.selected)) { this.selected = view.members[0]?.name; this.detail = false; this.revealSelection = true; }
  const member = view.members.find(m => m.name === this.selected);
  const title = this.detail && member ? `Team / ${member.name} / ${this.log ? "执行日志" : "结果与消息"}` : heading(view);
  let body: string[] = [];
  if (view.storageError) body.push(`! 存储异常：${view.storageError}`, "");
  if (this.detail && member) {
   body.push(memberLine(member), member.description ?? "", modelLine(member), "");
   if (member.error) body.push(`! ${member.error}`);
   if (member.preview) body.push(`当前活动：${member.preview}`, "");
   if (this.log) body.push(...this.logLines);
   else {
    const results = view.results.filter(r => r.member === member.name).slice(-50);
    if (!results.length) body.push("尚无结果或消息。");
    for (const result of results) {
     body.push(`${result.produced_at} · ${result.outcome ? outcome[result.outcome] : result.kind} · ${result.acknowledged_at ? "Lead 已确认" : "待 Lead 确认"}`, ...result.summary.split("\n"));
     if (result.report?.blocker) body.push(`阻塞：${result.report.blocker}`);
     if (result.report?.artifacts?.length) body.push("产物：", ...result.report.artifacts);
     if (result.report?.verification?.length) body.push("成员报告的验证：", ...result.report.verification);
     body.push("");
    }
   }
  } else {
   body.push("成员");
   if (!view.members.length) body.push("尚未创建成员。");
   for (const row of view.members) {
    body.push(`${row.name === this.selected ? ">" : " "} ${memberLine(row)}`, `  ${modelLine(row)}`);
    if (row.preview && row.status === "running") body.push(`  ${oneLine(row.preview)}`);
    if (row.error) body.push(`  ! ${row.error}`);
   }
   body.push("", `任务 ${completed(view)}/${view.tasks.length}`);
   if (!view.tasks.length) body.push("尚无共享任务。");
   for (const task of view.tasks) body.push(`${task.status === "completed" ? "●" : task.status === "in_progress" ? "◐" : "○"} ${task.subject}${task.owner ? ` @${task.owner}` : ""}${task.status === "pending" && !task.ready ? " · 阻塞" : ""}${task.writeScopeWarnings.length ? ` · ⚠${task.writeScopeWarnings.length}` : ""}`);
  }
  const wrapped = body.flatMap(line => wrapTextWithAnsi(clean(line).replace(/\t/g, "  "), cols));
  const height = Math.max(1, this.options.height());
  const available = Math.max(0, height - 3);
  this.maxOffset = Math.max(0, wrapped.length - available);
  // Keep the selected member visible while navigating a long roster.
  if (!this.detail && this.revealSelection) {
   this.revealSelection = false;
   const selectedLine = wrapped.findIndex(line => line.startsWith("> "));
   if (selectedLine >= 0 && selectedLine < this.offset) this.offset = selectedLine;
   else if (selectedLine >= this.offset + available) this.offset = Math.max(0, selectedLine - available + 1);
  }
  this.offset = Math.min(this.offset, this.maxOffset);
  const footer = this.detail ? "↑↓/PgUp/PgDn 滚动 · l 日志/结果 · r 刷新 · Esc 返回 · q 关闭" : "↑↓ 选择 · Enter 详情 · PgUp/PgDn 滚动 · Esc 关闭";
  return [title, "", ...wrapped.slice(this.offset, this.offset + available), footer].slice(0, height).map(line => truncateToWidth(clean(line), cols));
 }
}

const labels: Record<string, string> = { list_team_models: "可用模型", spawn_teammate: "创建成员", send_message: "团队消息", list_agents: "团队状态", team_wait: "等待团队", wait_agent: "等待变化", interrupt_agent: "中断成员", team_results: "读取结果", team_results_ack: "确认结果", team_finalize: "团队收尾", team_report: "成员报告", team_task_create: "创建任务", team_task_list: "任务列表", team_task_get: "读取任务", team_task_update: "更新任务", team_verification_start: "开始验证", team_verification_finish: "记录验证" };
export function toolTitle(name: string, args: Record<string, unknown>) {
 const suffix = [args.target ?? args.agent_id ?? args.name ?? args.subject ?? args.task_id ?? args.condition, args.action].filter(v => typeof v === "string").join(" · ");
 return `${labels[name] ?? name}${suffix ? " · " + oneLine(suffix) : ""}`;
}
export function toolSummary(name: string, value: unknown): string {
 if (!value || typeof value !== "object") return "已返回";
 const v = value as Record<string, any>;
 if (name === "team_finalize") return v.sealed ? "已收尾" : `尚未收尾 · ${(v.blockers ?? []).join(" · ")}`;
 if (name === "team_results") return `${v.results?.length ?? 0} 条结果`;
 if (name === "team_results_ack") return `已确认 ${v.acknowledged?.length ?? 0} 条结果`;
 if (name === "send_message") return v.accepted || v.sent || v.messageId ? "已接受 · 步骤边界引导" : "消息已保存";
 if (name === "interrupt_agent") return v.stopped ? "已停止" : "已请求中断";
 if (name === "team_wait" || name === "wait_agent") return `${({ satisfied: "必要成员已结束", timed_out: "等待超时", changed: "状态已变化", cancelled: "已取消", round_closed: "批次已关闭", no_progress: "没有可等待的执行" } as Record<string, string>)[v.reason] ?? v.reason} · ${v.running?.length ?? 0} 项未结束`;
 if (name === "list_agents") return `${v.members?.filter((m: any) => m.name !== "lead").length ?? 0} 个成员`;
 if (name === "team_task_list") return `${Array.isArray(value) ? value.length : 0} 项任务`;
 if (v.id && v.status) return `${v.id} · r${v.revision} · ${v.status}`;
 if (name === "spawn_teammate") return `${v.name ?? "成员"} · ${status[v.status] ?? v.status ?? "已创建"}`;
 if (name === "team_report") return "已记录 · 执行结束后发布";
 if (name.startsWith("team_verification")) return `${v.command ?? "验证"} · ${v.outcome ?? "已记录文件摘要"}`;
 return "已返回";
}
export function toolRenderers(name: string) {
 return {
  renderCall(args: Record<string, unknown>, theme: { fg: (color: any, value: string) => string }) { return new Text(theme.fg("accent", toolTitle(name, args)), 0, 0); },
  renderResult(result: { details?: unknown; content: Array<{ type: string; text?: string }>; isError?: boolean }, options: { expanded: boolean; isPartial?: boolean }, theme: { fg: (color: any, value: string) => string }, context?: { isError: boolean }) {
   if (options.isPartial) return new Text(theme.fg("muted", "执行中…"), 0, 0);
   const raw = result.content.filter(b => b.type === "text").map(b => b.text ?? "").join("\n");
   // Missing details can be a SDK-level error: never hide its diagnostic behind a success summary.
   const isError = result.isError || context?.isError;
   const text = isError || result.details === undefined ? raw : options.expanded ? `${toolSummary(name, result.details)}\n${raw}` : toolSummary(name, result.details);
   return new Text(theme.fg(isError ? "error" : "muted", clean(text)), 0, 0);
  },
 };
}
