import { homedir } from "node:os";
import { relative, isAbsolute, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function formatModel(ctx: Pick<ExtensionContext, "model" | "thinkingLevel">, routed?: { model: string; thinkingLevel?: string }): string {
	const selected = ctx.model;
	if (!selected) return "no-model";
	const physical = selected.api === "pi-virtual" ? routed : undefined;
	const name = physical?.model ?? selected.id;
	const level = ctx.thinkingLevel ?? "off";
	return selected.reasoning ? `${name} · ${level}` : name;
}

export function alignStats(left: string, right: string, width: number): string {
	left = truncateToWidth(left, width);
	const available = width - visibleWidth(left) - 2;
	if (available <= 0) return left;
	right = truncateToWidth(right, available);
	return left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right;
}

export default function compactFooter(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			let statsKey = "";
			let routed: { model: string; thinkingLevel?: string } | undefined;
			return {
				dispose: footerData.onBranchChange(() => tui.requestRender()),
				invalidate() {},
				render(width) {
					const manager = ctx.sessionManager;
					const key = `${manager.getSessionId()}:${manager.getLeafId()}:${manager.getEntryCount()}`;
					if (key !== statsKey) {
						routed = undefined;
						for (const entry of manager.getBranch()) {
							if (entry.type === "message" && entry.message.role === "assistant") routed = entry.message;
						}
						statsKey = key;
					}
					const percent = ctx.getContextUsage()?.percent;
					const contextText = percent == null ? "?" : `${percent.toFixed(1)}%`;
					const contextDisplay = percent != null && percent > 70 ? theme.fg(percent > 90 ? "error" : "warning", contextText) : contextText;
					const homeRelative = relative(homedir(), manager.getCwd());
					let path = homeRelative === "" ? "~" : homeRelative !== ".." && !homeRelative.startsWith(`..${sep}`) && !isAbsolute(homeRelative) ? `~${sep}${homeRelative}` : manager.getCwd();
					const branch = footerData.getGitBranch();
					if (branch) path += ` (${branch})`;
					const name = manager.getSessionName();
					if (name) path += ` • ${name}`;
					const location = truncateToWidth(path, Math.floor(width / 3));
					const lines = [theme.fg("dim", alignStats(`${location} | ${contextDisplay}`, formatModel(ctx, routed), width))];
					const statuses = [...footerData.getExtensionStatuses()].sort(([a], [b]) => a.localeCompare(b));
					if (statuses.length) lines.push(truncateToWidth(theme.fg("dim", statuses.map(([, value]) => value.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim()).join(" ")), width));
					return lines;
				},
			};
		});
	});
}
