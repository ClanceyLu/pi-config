import type {
	AgentSessionEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import {
	createBtwSideSession,
	extractAssistantText,
	extractEventAssistantText,
	getLastAssistantMessage,
	summarizeBtwThread,
	type BtwDetails,
	type SessionThinkingLevel,
	type SideSessionRuntime,
} from "./btw-session.ts";
import { BtwOverlay, formatToolArgs, renderTranscript, type ToolCallInfo } from "./btw-ui.ts";

const BTW_ENTRY_TYPE = "btw-thread-entry";
const BTW_RESET_TYPE = "btw-thread-reset";
type BtwResetDetails = { timestamp: number };
type OverlayRuntime = {
	handle?: OverlayHandle;
	refresh?: () => void;
	close?: () => void;
	finish?: () => void;
	setDraft?: (value: string) => void;
	closed?: boolean;
};

function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

export class BtwRuntime {
	private thread: BtwDetails[] = [];
	private pendingQuestion: string | null = null;
	private pendingAnswer = "";
	private pendingError: string | null = null;
	private pendingToolCalls: ToolCallInfo[] = [];
	private sideBusy = false;
	private overlayStatus = "Ready";
	private overlayDraft = "";
	private overlayRuntime: OverlayRuntime | null = null;
	private activeSideSession: SideSessionRuntime | null = null;
	private overlayRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	register(): void {
		this.pi.registerCommand("btw", {
			description: "Open a simple BTW side-chat popover. `/btw <text>` asks immediately, `/btw` opens the side thread.",
			handler: async (args, ctx) => {
				const question = args.trim();
				if (question) {
					await this.ensureOverlay(ctx);
					await this.runBtwPrompt(ctx, question);
					return;
				}
				await this.openThread(ctx);
			},
		});
		this.pi.on("session_start", async (_event, ctx) => this.restoreThread(ctx));
		this.pi.on("session_tree", async (_event, ctx) => this.restoreThread(ctx));
		this.pi.on("session_shutdown", async () => {
			await this.disposeSideSession();
			this.dismissOverlay();
		});
	}

	private async openThread(ctx: ExtensionCommandContext): Promise<void> {
		if (this.thread.length > 0 && ctx.hasUI) {
			const choice = await ctx.ui.select("BTW side chat:", ["Continue previous conversation", "Start fresh"]);
			if (choice === "Continue previous conversation") {
				await this.disposeSideSession();
				this.setOverlayStatus("Continuing BTW thread.");
				await this.ensureOverlay(ctx);
			} else if (choice === "Start fresh") {
				await this.resetThread(ctx, true);
				await this.ensureOverlay(ctx);
			}
			return;
		}
		await this.resetThread(ctx, true);
		await this.ensureOverlay(ctx);
	}

	private syncOverlay(): void {
		this.overlayRuntime?.refresh?.();
	}

	private scheduleOverlayRefresh(): void {
		if (this.overlayRefreshTimer) return;
		this.overlayRefreshTimer = setTimeout(() => {
			this.overlayRefreshTimer = null;
			this.syncOverlay();
		}, 16);
	}

	private setOverlayStatus(status: string, throttled = false): void {
		this.overlayStatus = status;
		if (throttled) this.scheduleOverlayRefresh();
		else this.syncOverlay();
	}

	private dismissOverlay(): void {
		this.overlayRuntime?.close?.();
		this.overlayRuntime = null;
		if (this.overlayRefreshTimer) clearTimeout(this.overlayRefreshTimer);
		this.overlayRefreshTimer = null;
	}

	private setOverlayDraft(value: string): void {
		this.overlayDraft = value;
		this.overlayRuntime?.setDraft?.(value);
	}

	private async disposeSideSession(): Promise<void> {
		const current = this.activeSideSession;
		this.activeSideSession = null;
		if (!current) return;
		current.unsubscribe();
		try {
			await current.session.abort();
		} finally {
			current.session.dispose();
		}
		if (this.overlayRefreshTimer) clearTimeout(this.overlayRefreshTimer);
		this.overlayRefreshTimer = null;
	}

	private async resetThread(ctx: ExtensionContext | ExtensionCommandContext, persist = true): Promise<void> {
		this.thread = [];
		this.pendingQuestion = null;
		this.pendingAnswer = "";
		this.pendingError = null;
		this.pendingToolCalls = [];
		this.sideBusy = false;
		this.setOverlayDraft("");
		this.setOverlayStatus("Ready");
		await this.disposeSideSession();
		if (persist) {
			const details: BtwResetDetails = { timestamp: Date.now() };
			this.pi.appendEntry(BTW_RESET_TYPE, details);
		}
		this.syncOverlay();
	}

	private async restoreThread(ctx: ExtensionContext): Promise<void> {
		await this.disposeSideSession();
		this.thread = [];
		this.pendingQuestion = null;
		this.pendingAnswer = "";
		this.pendingError = null;
		this.pendingToolCalls = [];
		this.sideBusy = false;
		this.overlayStatus = "Ready";
		this.overlayDraft = "";
		const branch = ctx.sessionManager.getBranch();
		let lastResetIndex = -1;
		for (let index = 0; index < branch.length; index++) {
			const entry = branch[index];
			if (entry.type === "custom" && entry.customType === BTW_RESET_TYPE) lastResetIndex = index;
		}
		for (const entry of branch.slice(lastResetIndex + 1)) {
			if (entry.type !== "custom" || entry.customType !== BTW_ENTRY_TYPE) continue;
			const details = entry.data as BtwDetails | undefined;
			if (details?.question && details.answer) this.thread.push(details);
		}
		this.syncOverlay();
	}

	private handleSideEvent(event: AgentSessionEvent): void {
		if (!this.sideBusy || !this.pendingQuestion) return;
		if (["message_start", "message_update", "message_end"].includes(event.type)) {
			const streamed = extractEventAssistantText((event as { message?: unknown }).message);
			if (streamed) {
				this.pendingAnswer = streamed;
				this.pendingError = null;
			}
			this.setOverlayStatus(event.type === "message_end" ? "Finalizing side response..." : "Streaming side response...", true);
			return;
		}
		if (event.type === "tool_execution_start") {
			const toolEvent = event as { toolCallId?: string; toolName?: string; args?: unknown };
			const toolName = toolEvent.toolName ?? "unknown";
			this.pendingToolCalls.push({ toolCallId: toolEvent.toolCallId ?? "", toolName, args: formatToolArgs(toolName, toolEvent.args), status: "running" });
			this.setOverlayStatus(`Running tool: ${toolName}...`, true);
			return;
		}
		if (event.type === "tool_execution_end") {
			const toolEvent = event as { toolName?: string; isError?: boolean };
			const toolName = toolEvent.toolName ?? "unknown";
			const call = this.pendingToolCalls.find((item) => item.toolName === toolName && item.status === "running");
			if (call) call.status = toolEvent.isError ? "error" : "done";
			this.setOverlayStatus("Streaming side response...", true);
			return;
		}
		if (event.type === "turn_end") this.setOverlayStatus("Finalizing side response...", true);
	}

	private async ensureSideSession(ctx: ExtensionCommandContext): Promise<SideSessionRuntime | null> {
		if (!ctx.model) return null;
		const modelKey = `${ctx.model.provider}/${ctx.model.id}`;
		if (this.activeSideSession?.modelKey === modelKey) return this.activeSideSession;
		await this.disposeSideSession();
		this.activeSideSession = await createBtwSideSession(this.pi, ctx, this.thread, (event) => this.handleSideEvent(event));
		return this.activeSideSession;
	}

	private closeOverlayRuntime(runtime: OverlayRuntime): void {
		if (runtime.closed) return;
		runtime.closed = true;
		runtime.handle?.hide();
		if (this.overlayRuntime === runtime) this.overlayRuntime = null;
		runtime.finish?.();
	}

	private createOverlayComponent(
		ctx: ExtensionContext | ExtensionCommandContext,
		runtime: OverlayRuntime,
	): (
		tui: TUI,
		theme: ExtensionContext["ui"]["theme"],
		keybindings: KeybindingsManager,
		done: (result: void) => void,
	) => Promise<BtwOverlay> {
		return async (tui, theme, keybindings, done) => {
			runtime.finish = () => done();
			const overlay = new BtwOverlay(tui, {
				theme,
				keybindings,
				getTranscript: (width, currentTheme) => renderTranscript({
					thread: this.thread,
					pendingQuestion: this.pendingQuestion,
					pendingAnswer: this.pendingAnswer,
					pendingError: this.pendingError,
					pendingToolCalls: this.pendingToolCalls,
				}, width, currentTheme),
				getStatus: () => this.overlayStatus,
				onSubmit: (value) => void this.submitFromOverlay(ctx, value),
				onDismiss: () => void this.closeOverlayFlow(ctx),
			});
			overlay.focused = true;
			overlay.setDraft(this.overlayDraft);
			runtime.setDraft = (value) => overlay.setDraft(value);
			runtime.refresh = () => {
				overlay.focused = runtime.handle?.isFocused() ?? false;
				tui.requestRender();
			};
			runtime.close = () => {
				this.overlayDraft = overlay.getDraft();
				this.closeOverlayRuntime(runtime);
			};
			if (runtime.closed) done();
			return overlay;
		};
	}

	private async ensureOverlay(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		if (this.overlayRuntime?.handle) {
			this.overlayRuntime.handle.setHidden(false);
			this.overlayRuntime.handle.focus();
			this.overlayRuntime.refresh?.();
			return;
		}
		const runtime: OverlayRuntime = {};
		runtime.close = () => this.closeOverlayRuntime(runtime);
		this.overlayRuntime = runtime;
		void ctx.ui.custom<void>(this.createOverlayComponent(ctx, runtime), {
			overlay: true,
			overlayOptions: { width: "80%", minWidth: 72, maxHeight: "78%", anchor: "top-center", margin: { top: 1, left: 2, right: 2 } },
			onHandle: (handle) => {
				runtime.handle = handle;
				handle.focus();
				if (runtime.closed) handle.hide();
			},
		}).catch((error) => {
			if (this.overlayRuntime === runtime) this.overlayRuntime = null;
			notify(ctx, error instanceof Error ? error.message : String(error), "error");
		});
	}

	private async injectSummaryIntoMain(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
		if (this.thread.length === 0) return notify(ctx, "No BTW thread to summarize.", "warning");
		this.setOverlayStatus("Summarizing BTW thread for injection...");
		try {
			const summary = await summarizeBtwThread(ctx, this.thread);
			const message = `Summary of my BTW side conversation:\n\n${summary}`;
			if (ctx.isIdle()) this.pi.sendUserMessage(message);
			else this.pi.sendUserMessage(message, { deliverAs: "followUp" });
			await this.resetThread(ctx);
			notify(ctx, "Injected BTW summary into main chat.", "info");
		} catch (error) {
			notify(ctx, error instanceof Error ? error.message : String(error), "error");
		}
	}

	private async closeOverlayFlow(ctx: ExtensionContext | ExtensionCommandContext): Promise<void> {
		this.dismissOverlay();
		if (!ctx.hasUI || this.thread.length === 0) return;
		const choice = await ctx.ui.select("Close BTW:", ["Keep side thread", "Inject summary into main chat"]);
		if (choice === "Inject summary into main chat") await this.injectSummaryIntoMain(ctx);
	}

	private async prepareSidePrompt(ctx: ExtensionCommandContext): Promise<SideSessionRuntime | null> {
		if (!ctx.model) {
			this.setOverlayStatus("No active model selected.");
			notify(ctx, "No active model selected.", "error");
			return null;
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (auth.ok === false) {
			this.setOverlayStatus(auth.error);
			notify(ctx, auth.error, "error");
			return null;
		}
		if (this.sideBusy) {
			notify(ctx, "BTW is still processing the previous message.", "warning");
			return null;
		}
		try {
			return await this.ensureSideSession(ctx);
		} catch (error) {
			const message = `Unable to create BTW side session: ${error instanceof Error ? error.message : String(error)}`;
			this.setOverlayStatus(message);
			notify(ctx, message, "error");
			return null;
		}
	}

	private async runBtwPrompt(ctx: ExtensionCommandContext, question: string): Promise<void> {
		const side = await this.prepareSidePrompt(ctx);
		if (!side || !ctx.model) return;
		this.sideBusy = true;
		this.pendingQuestion = question;
		this.pendingAnswer = "";
		this.pendingError = null;
		this.pendingToolCalls = [];
		this.setOverlayStatus("Streaming side response...");
		this.syncOverlay();
		try {
			await side.session.prompt(question, { source: "extension" });
			const response = getLastAssistantMessage(side.session);
			if (!response) throw new Error("BTW request finished without a response.");
			if (response.stopReason === "aborted") throw new Error("BTW request aborted.");
			if (response.stopReason === "error") throw new Error(response.errorMessage || "BTW request failed.");
			const details: BtwDetails = {
				question,
				answer: extractAssistantText(response.content) || "(No text response)",
				timestamp: Date.now(),
				provider: ctx.model.provider,
				model: ctx.model.id,
				thinkingLevel: this.pi.getThinkingLevel() as SessionThinkingLevel,
				usage: response.usage,
			};
			this.thread.push(details);
			this.pi.appendEntry(BTW_ENTRY_TYPE, details);
			this.pendingQuestion = null;
			this.pendingAnswer = "";
			this.pendingToolCalls = [];
			this.setOverlayStatus("Ready for the next side question.");
		} catch (error) {
			this.pendingError = error instanceof Error ? error.message : String(error);
			this.setOverlayStatus("BTW request failed.");
			notify(ctx, this.pendingError, "error");
		} finally {
			this.sideBusy = false;
			this.syncOverlay();
		}
	}

	private async submitFromOverlay(ctx: ExtensionContext | ExtensionCommandContext, rawValue: string): Promise<void> {
		const question = rawValue.trim();
		if (!question) return this.setOverlayStatus("Enter a question first.");
		this.setOverlayDraft("");
		if (!("waitForIdle" in ctx)) return this.setOverlayStatus("BTW submit requires command context. Re-open with /btw.");
		await this.runBtwPrompt(ctx, question);
	}
}
