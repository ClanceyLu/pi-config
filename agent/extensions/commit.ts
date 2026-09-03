import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";

const SKILL_COMMAND = "/skill:git-commit-cn";
const MUTATING_TOOLS = new Set(["edit", "write"]);

function normalizeSessionPath(path: string, cwd: string): string | undefined {
	const cleanPath = path.startsWith("@") ? path.slice(1) : path;
	const absolutePath = isAbsolute(cleanPath) ? resolve(cleanPath) : resolve(cwd, cleanPath);
	const relativePath = relative(cwd, absolutePath);

	if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		return undefined;
	}

	return relativePath.split(sep).join("/");
}

function collectSessionModifiedPaths(entries: readonly unknown[], cwd: string): string[] {
	const calls = new Map<string, string>();
	const successfulCallIds = new Set<string>();
	const summarizedPaths: string[] = [];

	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;

		if (record.type === "compaction" || record.type === "branch_summary") {
			const details = record.details as { modifiedFiles?: unknown } | undefined;
			if (Array.isArray(details?.modifiedFiles)) {
				summarizedPaths.push(...details.modifiedFiles.filter((path): path is string => typeof path === "string"));
			}
		}

		if (record.type !== "message" || !record.message || typeof record.message !== "object") continue;
		const message = record.message as Record<string, unknown>;

		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!block || typeof block !== "object") continue;
				const toolCall = block as Record<string, unknown>;
				if (
					toolCall.type !== "toolCall" ||
					typeof toolCall.id !== "string" ||
					typeof toolCall.name !== "string" ||
					!MUTATING_TOOLS.has(toolCall.name) ||
					!toolCall.arguments ||
					typeof toolCall.arguments !== "object"
				) {
					continue;
				}

				const path = (toolCall.arguments as Record<string, unknown>).path;
				if (typeof path === "string") calls.set(toolCall.id, path);
			}
		}

		if (
			message.role === "toolResult" &&
			message.isError !== true &&
			typeof message.toolCallId === "string" &&
			typeof message.toolName === "string" &&
			MUTATING_TOOLS.has(message.toolName)
		) {
			successfulCallIds.add(message.toolCallId);
		}
	}

	const paths = [
		...summarizedPaths,
		...[...successfulCallIds].map((id) => calls.get(id)).filter((path): path is string => path !== undefined),
	];

	return [...new Set(paths.map((path) => normalizeSessionPath(path, cwd)).filter((path): path is string => !!path))].sort();
}

function withGuidance(request: string, guidance: string): string {
	return guidance ? `${request}。额外要求：${guidance}` : request;
}

export default function commitCommand(pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "提交已暂存、所有或当前 session 的变更",
		getArgumentCompletions: (prefix) => {
			if (prefix.includes(" ")) return null;
			const items = [
				{ value: "all", label: "all", description: "提交所有当前变更" },
				{ value: "session", label: "session", description: "仅提交当前 session 修改的文件" },
			];
			const matches = items.filter((item) => item.value.startsWith(prefix));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			const separatorIndex = trimmedArgs.search(/\s/);
			const subcommand = separatorIndex === -1 ? trimmedArgs : trimmedArgs.slice(0, separatorIndex);
			const guidance = separatorIndex === -1 ? "" : trimmedArgs.slice(separatorIndex).trim();
			let request: string;

			if (!subcommand) {
				request = `${SKILL_COMMAND} 提交当前已暂存变更`;
			} else if (subcommand === "all") {
				request = withGuidance(`${SKILL_COMMAND} 提交所有当前变更`, guidance);
			} else if (subcommand === "session") {
				const paths = collectSessionModifiedPaths(ctx.sessionManager.getBranch(), ctx.cwd);
				if (paths.length === 0) {
					ctx.ui.notify("当前 session 未记录到可提交的文件修改", "warning");
					return;
				}
				request = withGuidance(
					`${SKILL_COMMAND} 提交当前 Pi session 修改的文件。授权范围仅限以下路径，不得暂存其他路径：${JSON.stringify(paths)}`,
					guidance,
				);
			} else {
				request = `${SKILL_COMMAND} 提交变更。额外要求：${trimmedArgs}`;
			}

			pi.sendUserMessage(request, {
				...(ctx.isIdle() ? {} : { deliverAs: "followUp" as const }),
				expandPromptTemplates: true,
			});
		},
	});
}
