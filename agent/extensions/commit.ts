import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SKILL_COMMAND = "/skill:git-commit-cn";

export default function commitCommand(pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "使用中文 Conventional Commit 规范提交变更",
		handler: async (args, ctx) => {
			const guidance = args.trim();
			const request = guidance
				? `${SKILL_COMMAND} 提交变更。额外要求：${guidance}`
				: `${SKILL_COMMAND} 提交当前已暂存变更`;

			pi.sendUserMessage(request, {
				...(ctx.isIdle() ? {} : { deliverAs: "followUp" as const }),
				expandPromptTemplates: true,
			});
		},
	});
}
