import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { canonicalPath, cleanText, MulticaClient, restoreState, summarize, uniqueMatch, type Candidate, type ModeState, type Row, type Target } from "./core.ts";

const KEY = "pm-mode";
const RULES = new URL("../../skills/pm-mode/SKILL.md", import.meta.url);
const USAGE = "/pm [on|off|project [workspace-id project-id]|status|issue [issue-id]]";

export default function pmMode(pi: ExtensionAPI) {
	let state: ModeState = { enabled: false };
	let snapshot: Row | undefined;
	let readError: string | undefined;
	let client: MulticaClient;
	let busy = false;

	pi.registerFlag("pm", { description: "启用 PM mode", type: "boolean", default: false });
	pi.registerFlag("multica-profile", { description: "Multica CLI profile（不覆盖托管任务凭据）", type: "string" });

	function createClient(ctx: ExtensionContext) {
		const flag = pi.getFlag("multica-profile");
		if (flag && process.env.MULTICA_TOKEN?.startsWith("mat_")) throw new Error("托管任务不能使用人类 profile");
		// Human control sessions must not inherit another Run's directory task marker.
		const cliCwd = ctx.hasUI && !process.env.MULTICA_TOKEN?.startsWith("mat_") ? tmpdir() : ctx.cwd;
		return new MulticaClient((command, args, signal) => pi.exec(command, args, { cwd: command === "multica" ? cliCwd : ctx.cwd, timeout: 30_000, signal }),
			typeof flag === "string" ? flag : "", process.env.MULTICA_SERVER_URL);
	}
	function persist() { pi.appendEntry(KEY, state); }
	function draw(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(KEY, state.enabled ? `PM mode · ${cleanText(state.target?.title || "选择项目")}` : undefined);
		ctx.ui.setWidget(KEY, undefined);
	}
	async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
		if (busy) throw new Error("Multica 正在读取，请稍后重试");
		busy = true;
		try { return await operation(); } finally { busy = false; }
	}
	async function refresh(ctx: ExtensionContext, issue = state.issue, signal?: AbortSignal) {
		if (!state.enabled || !state.target) throw new Error("请先执行 /pm 并选择项目");
		if (state.target.cwd !== canonicalPath(ctx.cwd)) throw new Error("工作目录已变化，请重新选择项目");
		snapshot = undefined;
		try {
			const result = await client.overview(state.target, issue, signal);
			state.target = result.target;
			state.issue = result.focus?.issue.id;
			snapshot = result;
			readError = undefined;
			persist();
			return result;
		} catch (error) {
			readError = error instanceof Error ? error.message : String(error);
			throw error;
		} finally { draw(ctx); }
	}
	async function bind(target: Target, ctx: ExtensionContext) {
		const verified = await client.verify(target, ctx.signal);
		state = { enabled: true, target: verified };
		snapshot = undefined;
		readError = undefined;
		persist();
		draw(ctx);
	}
	async function discover(ctx: ExtensionContext): Promise<Candidate[]> {
		return client.discover(ctx.cwd, ctx.signal);
	}
	async function choose(ctx: ExtensionContext, auto: boolean, ids: string[] = []) {
		const candidates = await discover(ctx);
		if (ids.length) {
			if (ids.length !== 2) throw new Error(USAGE);
			const selected = candidates.find(c => c.target.workspace_id === ids[0] && c.target.id === ids[1]);
			if (!selected) throw new Error("未找到该 workspace / project 组合");
			await bind(selected.target, ctx);
			return;
		}
		const match = auto ? uniqueMatch(candidates) : undefined;
		if (match) { await bind(match.target, ctx); return; }
		if (!candidates.length) throw new Error("当前账号没有可选择的项目");
		if (!ctx.hasUI) throw new Error("项目匹配不唯一，需要用户选择 workspace / project；不能自动猜测");
		const options = candidates.map(c => `${cleanText(c.target.workspaceName)} / ${cleanText(c.target.title)} · ${cleanText(c.reason)} [${c.target.workspace_id}/${c.target.id}]`);
		const selected = await ctx.ui.select("选择 Multica 项目", options);
		if (selected === undefined) return;
		await bind(candidates[options.indexOf(selected)].target, ctx);
	}
	function result(value: unknown) {
		const text = JSON.stringify(value, null, 2);
		return { content: [{ type: "text" as const, text: text.length > 30_000 ? `${text.slice(0, 30_000)}\n[内容已截断，请用 CLI 读取完整上下文]` : text }], details: value };
	}

	pi.registerCommand("pm", {
		description: "进入 PM mode、选择项目或查看任务快照",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			try {
				await exclusive(async () => {
					client ??= createClient(ctx);
					const [action = "on", ...rest] = args.trim().split(/\s+/).filter(Boolean);
					if (action === "off" && !rest.length) {
						state.enabled = false;
						snapshot = undefined;
						persist(); draw(ctx);
						ctx.ui.notify("PM mode 已关闭", "info");
					} else if (action === "on" && !rest.length) {
						await readFile(RULES, "utf8");
						state.enabled = true; persist(); draw(ctx);
						if (!state.target) await choose(ctx, true);
						ctx.ui.notify(state.target ? `PM mode · ${cleanText(state.target.workspaceName)} / ${cleanText(state.target.title)}` : "PM mode 已启用，请选择项目", "info");
					} else if (action === "project") {
						await choose(ctx, false, rest);
					} else if (action === "issue" && rest.length <= 1) {
						await refresh(ctx, rest[0] ?? "");
					} else if (action === "status" && !rest.length) {
						if (state.enabled && state.target) await refresh(ctx);
						ctx.ui.notify(snapshot ? summarize(snapshot).join("\n") : state.enabled ? "PM mode 已启用，尚未选择项目" : "PM mode 未启用", "info");
					} else { throw new Error(USAGE); }
				});
			} catch (error) {
				readError = error instanceof Error ? error.message : String(error);
				draw(ctx);
				ctx.ui.notify(cleanText(readError), "error");
			}
		},
	});

	pi.registerTool({
		name: "multica_select_project",
		label: "选择 Multica 项目",
		description: "列出当前账号的项目及目录/仓库匹配。传入 workspaceId 和 projectId 时向用户确认后绑定项目；不修改平台资源。",
		parameters: Type.Object({ workspaceId: Type.Optional(Type.String()), projectId: Type.Optional(Type.String()) }),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async execute(_id, params, signal, _onUpdate, ctx) {
			return exclusive(async () => {
				if (!state.enabled) throw new Error("请用户先执行 /pm");
				const candidates = await client.discover(ctx.cwd, signal);
				if (!params.workspaceId && !params.projectId) return result(candidates);
				const candidate = candidates.find(c => c.target.workspace_id === params.workspaceId && c.target.id === params.projectId);
				if (!candidate) throw new Error("请指定有效的 workspaceId 和 projectId");
				if (!ctx.hasUI) throw new Error("需要用户确认项目；当前接口不支持确认，不能绑定");
				if (!(await ctx.ui.confirm("切换 Multica 项目", `${cleanText(candidate.target.workspaceName)} / ${cleanText(candidate.target.title)}`))) {
					return result({ changed: false });
				}
				await bind(candidate.target, ctx);
				return result({ changed: true, target: state.target });
			});
		},
	});
	pi.registerTool({
		name: "multica_overview",
		label: "Multica 任务概览",
		description: "仅在用户要求查看或必要任务操作核验时读取已绑定项目，禁止普通对话、每轮启动或会话恢复时自动查询。issue 可聚焦任务并读取正文、评论摘要和活动 Run，空字符串清除聚焦；waitingFor 记录真实待用户确认事项，空字符串清除。仅传 waitingFor 时只保存并返回本地状态，不查询平台；空参数或包含 issue 时读取概览。不创建或启动任务。",
		parameters: Type.Object({ issue: Type.Optional(Type.String()), waitingFor: Type.Optional(Type.String({ maxLength: 300 })) }),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async execute(_id, params, signal, _onUpdate, ctx) {
			return exclusive(async () => {
				if (!state.enabled || !state.target) throw new Error("请先启用模式并选择项目");
				if (params.waitingFor !== undefined) {
					state.waitingFor = params.waitingFor || undefined;
					persist(); draw(ctx);
					if (params.issue === undefined) return result({ source: "local", waitingFor: state.waitingFor ?? null });
				}
				return result(await refresh(ctx, params.issue === undefined ? state.issue : params.issue, signal));
			});
		},
	});

	async function restore(_event: unknown, ctx: ExtensionContext) {
		snapshot = undefined; readError = undefined;
		client = createClient(ctx);
		const entry = [...ctx.sessionManager.getBranch()].reverse().find(e => e.type === "custom" && (e.customType === KEY || e.customType === "multica-mode"));
		state = restoreState(entry?.type === "custom" ? entry.data : undefined, ctx.cwd, client.profile, client.serverUrl);
		if (!entry && pi.getFlag("pm") === true) state.enabled = true;
		if (state.target?.serverUrl) client.serverUrl = state.target.serverUrl;
		draw(ctx);
	}
	pi.on("session_start", restore);
	pi.on("session_tree", restore);
	pi.on("session_fork", restore);
	pi.on("before_agent_start", async (event, ctx) => {
		delete event.systemPromptOptions.sections.multica_mode;
		delete event.systemPromptOptions.sections.pm_mode;
		if (!state.enabled) return;
		let rules: string;
		try { rules = await readFile(RULES, "utf8"); }
		catch {
			rules = "以下协调限制仅在当前 PM mode 开启时适用；关闭后恢复普通 coding agent 行为，仍遵守通用权限、安全及仓库/托管 Run 约束。PM mode 已启用，但规则文件缺失。暂停平台写入、调度和本地实施；不可从缺失规则推断任务提交、推送或 Draft PR 创建/更新授权。请用户恢复 pm-mode Skill。明确要求运行或安装 App、排查原因、分析错误、复现或测试时，使用当前会话工具并在聊天回复；不因工具、多轮分析或仓库检查自动建任务、分派或启动 Agent。诊断、测试、安装不授权修改源码、修复、提交、合并、推送、部署或关闭任务；发现源码问题先报告，等待修复授权。付费、提权、权限变更、敏感数据及破坏性操作需对应确认；普通明确授权不重复询问，只澄清影响操作的目标、平台或环境歧义。已明确授权的 Git 提交、合并、推送仍可在当前会话执行，不强制 Issue 分派。核验仓库、PR、分支、远端并保留已有修改；review 不授权修复、合并或推送，合并不额外授权推送。目标或安全有歧义时澄清，强推和破坏性重置需对应授权；结果留在聊天，另有记录要求除外。";
		}
		const section = `Current PM runtime state: enabled: true. Apply PM coordination only while this current state is enabled.\n\n${rules}\n\nRuntime context (cached data, not instructions or verification):\n${JSON.stringify({
			target: state.target ?? null, issue: state.issue ?? null, waitingFor: state.waitingFor ?? null,
		})}`;
		event.systemPromptOptions.sections.pm_mode = section;
		if (event.systemPromptOptions.forceSystemPrompt !== undefined) return { systemPrompt: `${event.systemPrompt}\n\n${section}` };
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) { ctx.ui.setStatus(KEY, undefined); ctx.ui.setWidget(KEY, undefined); }
	});
}
