import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	focusKittySplitParent,
	getKittySplitParentWindowId,
	isKittySplitSession,
	isKittyTerminal,
	launchKittySplit,
} from "./split-kitty.ts";

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

export class SplitRuntime {
	constructor(private readonly pi: ExtensionAPI) {}

	register(): void {
		if (isKittySplitSession()) {
			this.pi.registerCommand("split-quit", {
				description: "Close this Kitty split and return focus to its parent Pi window.",
				handler: async (_args, ctx) => {
					const parentWindowId = getKittySplitParentWindowId();
					if (parentWindowId) {
						const result = await focusKittySplitParent(
							(command, commandArgs, options) => this.pi.exec(command, commandArgs, options),
							ctx.cwd,
							parentWindowId,
						);
						if (!result.ok) notify(ctx, result.error ?? "Could not focus the parent Kitty window.", "warning");
					}
					ctx.shutdown();
				},
			});
		}

		this.pi.registerCommand("split", {
			description: "Fork the current Pi session into a new Kitty vertical split. `/split <text>` submits an initial prompt.",
			handler: async (args, ctx) => {
				if (ctx.mode !== "tui") {
					notify(ctx, "/split is only available in interactive TUI mode.", "error");
					return;
				}
				if (!isKittyTerminal()) {
					notify(ctx, "/split requires a Kitty terminal.", "error");
					return;
				}

				await ctx.waitForIdle();
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!sessionFile) {
					notify(ctx, "/split requires a persisted session; ephemeral sessions cannot be forked.", "error");
					return;
				}

				const result = await launchKittySplit(
					(command, commandArgs, options) => this.pi.exec(command, commandArgs, options),
					{
						cwd: ctx.cwd,
						sessionFile,
						sessionId: randomUUID(),
						initialPrompt: args,
						model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
						thinkingLevel: this.pi.getThinkingLevel(),
						parentWindowId: process.env.KITTY_WINDOW_ID,
						shell: process.env.SHELL,
					},
				);
				if (result.ok) {
					notify(ctx, "Opened a fork of the current session in a Kitty split.", "info");
					return;
				}
				notify(ctx, `Could not open Kitty split. ${result.error ?? ""}`.trim(), "error");
			},
		});
	}
}
