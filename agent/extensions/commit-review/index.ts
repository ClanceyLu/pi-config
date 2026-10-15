import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { snapshot, unchanged } from "./git.ts";
import { ReviewUI, type Decision } from "./ui.ts";

export async function review(ctx: ExtensionContext, message: string, signal?: AbortSignal) {
	if (ctx.mode !== "tui") throw new Error("提交审阅需要 Pi 终端交互模式；当前模式不能确认提交。");
	if (!message.trim() || message.includes("\0")) throw new Error("请提供有效的完整提交信息。");
	if (signal?.aborted) throw new Error("审阅已取消");
	const staged = await snapshot(ctx.cwd, signal);
	const decision = await ctx.ui.custom<Decision>((tui, theme, _kb, done) => {
		const abort = () => ui.handleInput("\x03");
		const ui = new ReviewUI(staged, message, theme, () => tui.terminal.rows, () => tui.requestRender(), done, signal);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		return Object.assign(ui, { dispose() { signal?.removeEventListener("abort", abort); ReviewUI.prototype.dispose.call(ui); } });
	});
	if (decision === "confirmed") await unchanged(staged, signal);
	return { decision: decision ?? "cancelled", root: staged.root, snapshot: staged.id, head: staged.head,
		branch: staged.branch, message, files: staged.files.map((f) => f.path), outside: staged.outside };
}

export default function commitReview(pi: ExtensionAPI) {
	pi.registerTool({
		name: "commit_review", label: "提交审阅", exposure: "model-only",
		description: "在 Pi 中让用户浏览当前暂存区的逐文件 diff 和完整提交信息，再确认、调整或取消。只读，不暂存、不提交、不推送。仅 confirmed 授权按所展示的暂存快照和信息本地提交；内容改变必须重新审阅。调用前先检查范围、敏感内容和追踪必要性。",
		parameters: Type.Object({ message: Type.String({ minLength: 1, description: "拟使用的完整提交信息，含正文和 footer" }) }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const result = await review(ctx, params.message, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
	pi.registerCommand("commit-review", {
		description: "审阅暂存区：/commit-review <完整提交信息>（不执行提交）",
		async handler(message, ctx) {
			try {
				const result = await review(ctx, message);
				ctx.ui.notify(result.decision === "confirmed" ? "已确认暂存快照，尚未执行提交。" : result.decision === "adjust" ? "请调整提交范围或信息后重新审阅。" : "已取消提交审阅。", "info");
			} catch (error) { ctx.ui.notify(String(error), "error"); }
		},
	});
}
