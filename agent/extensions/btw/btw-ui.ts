import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	Markdown,
	truncateToWidth,
	visibleWidth,
	type Focusable,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";

export interface BtwTranscriptItem {
	question: string;
	answer: string;
}

export interface ToolCallInfo {
	toolCallId: string;
	toolName: string;
	args: string;
	status: "running" | "done" | "error";
}

export interface TranscriptState {
	thread: BtwTranscriptItem[];
	pendingQuestion: string | null;
	pendingAnswer: string;
	pendingError: string | null;
	pendingToolCalls: ToolCallInfo[];
}

type Theme = ExtensionContext["ui"]["theme"];
interface BtwOverlayOptions {
	theme: Theme;
	keybindings: KeybindingsManager;
	getTranscript: (width: number, theme: Theme) => string[];
	getStatus: () => string;
	onSubmit: (value: string) => void;
	onDismiss: () => void;
}
const markdownTheme = getMarkdownTheme();

function renderMarkdownLines(text: string, width: number): string[] {
	if (!text) return [];
	try {
		return new Markdown(text, 0, 0, markdownTheme).render(width);
	} catch (error) {
		throw new Error(`Failed to render BTW Markdown: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function formatToolArgs(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const values = args as Record<string, unknown>;
	if (toolName === "bash") {
		return typeof values.command === "string" ? truncateToWidth(values.command.split("\n")[0]!, 50, "…") : "";
	}
	if (["read", "write", "edit"].includes(toolName)) {
		return typeof values.path === "string" ? values.path : "";
	}
	const first = Object.values(values)[0];
	return typeof first === "string" ? truncateToWidth(first.split("\n")[0]!, 40, "…") : "";
}

function renderToolCallLines(toolCalls: ToolCallInfo[], theme: Theme, width: number): string[] {
	return toolCalls.map((toolCall) => {
		const icon = toolCall.status === "running" ? "⚙" : toolCall.status === "error" ? "✗" : "✓";
		const color = toolCall.status === "error" ? "error" : toolCall.status === "done" ? "success" : "dim";
		const label = theme.fg(color, `${icon} `) + theme.fg("toolTitle", toolCall.toolName);
		const args = toolCall.args ? theme.fg("dim", ` ${toolCall.args}`) : "";
		return truncateToWidth(`  ${label}${args}`, width, "");
	});
}

export function renderTranscript(state: TranscriptState, width: number, theme: Theme): string[] {
	if (state.thread.length === 0 && !state.pendingQuestion && !state.pendingAnswer && !state.pendingError) {
		return [theme.fg("dim", "No BTW messages yet. Type a question below.")];
	}
	const lines: string[] = [];
	for (const item of state.thread) {
		const userText = item.question.trim().split("\n")[0] ?? "";
		lines.push(theme.fg("accent", theme.bold("You: ")) + truncateToWidth(userText, width - 5, "…"), "");
		lines.push(...renderMarkdownLines(item.answer, width), "");
	}
	if (state.pendingQuestion) {
		const userText = state.pendingQuestion.trim().split("\n")[0] ?? "";
		lines.push(theme.fg("accent", theme.bold("You: ")) + truncateToWidth(userText, width - 5, "…"));
		if (state.pendingToolCalls.length > 0) {
			lines.push(...renderToolCallLines(state.pendingToolCalls, theme, width));
		}
		if (state.pendingError) lines.push(theme.fg("error", `❌ ${state.pendingError}`));
		else if (state.pendingAnswer) lines.push("", ...renderMarkdownLines(state.pendingAnswer, width));
		else if (state.pendingToolCalls.length === 0) lines.push(theme.fg("dim", "…"));
	}
	while (lines.at(-1) === "") lines.pop();
	return lines;
}

export class BtwOverlay extends Container implements Focusable {
	private readonly input: Input;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly getTranscript: (width: number, theme: Theme) => string[];
	private readonly getStatus: () => string;
	private readonly onSubmitCallback: (value: string) => void;
	private readonly onDismissCallback: () => void;
	private transcriptScrollTop = 0;
	private transcriptLineCount = 0;
	private transcriptHeight = 1;
	private followTranscript = true;
	private _focused = false;

	constructor(tui: TUI, options: BtwOverlayOptions) {
		super();
		this.tui = tui;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.getTranscript = options.getTranscript;
		this.getStatus = options.getStatus;
		this.onSubmitCallback = options.onSubmit;
		this.onDismissCallback = options.onDismiss;
		this.input = new Input();
		this.input.onSubmit = (value) => {
			this.scrollTranscriptToBottom();
			this.onSubmitCallback(value);
		};
		this.input.onEscape = this.onDismissCallback;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) return this.onDismissCallback();
		if (this.keybindings.matches(data, "tui.select.up")) return this.scrollTranscriptBy(-1);
		if (this.keybindings.matches(data, "tui.select.down")) return this.scrollTranscriptBy(1);
		if (this.keybindings.matches(data, "tui.select.pageUp")) return this.scrollTranscriptBy(-this.transcriptHeight);
		if (this.keybindings.matches(data, "tui.select.pageDown")) return this.scrollTranscriptBy(this.transcriptHeight);
		this.input.handleInput(data);
	}

	private scrollTranscriptBy(delta: number): void {
		const maxScrollTop = Math.max(0, this.transcriptLineCount - this.transcriptHeight);
		this.transcriptScrollTop = Math.max(0, Math.min(maxScrollTop, this.transcriptScrollTop + delta));
		this.followTranscript = this.transcriptScrollTop >= maxScrollTop;
		this.tui.requestRender();
	}

	private scrollTranscriptToBottom(): void {
		this.followTranscript = true;
		this.transcriptScrollTop = Math.max(0, this.transcriptLineCount - this.transcriptHeight);
		this.tui.requestRender();
	}

	setDraft(value: string): void {
		this.input.setValue(value);
		this.tui.requestRender();
	}

	getDraft(): string {
		return this.input.getValue();
	}

	private frameLine(content: string, innerWidth: number): string {
		const truncated = truncateToWidth(content, innerWidth, "");
		const padding = Math.max(0, innerWidth - visibleWidth(truncated));
		return `${this.theme.fg("borderMuted", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("borderMuted", "│")}`;
	}

	private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
		const left = edge === "top" ? "┌" : "└";
		const right = edge === "top" ? "┐" : "┘";
		return this.theme.fg("borderMuted", `${left}${"─".repeat(innerWidth)}${right}`);
	}

	override render(width: number): string[] {
		const dialogWidth = Math.max(1, Math.min(width, Math.max(56, Math.floor(width * 0.9))));
		const innerWidth = Math.max(1, dialogWidth - 2);
		const dialogHeight = Math.max(12, Math.min(30, Math.floor(this.tui.terminal.rows * 0.75)));
		const transcriptHeight = Math.max(3, dialogHeight - 9);
		const transcript = this.getTranscript(innerWidth, this.theme);
		this.transcriptLineCount = transcript.length;
		this.transcriptHeight = transcriptHeight;
		const maxScrollTop = Math.max(0, transcript.length - transcriptHeight);
		this.transcriptScrollTop = this.followTranscript ? maxScrollTop : Math.min(this.transcriptScrollTop, maxScrollTop);
		this.followTranscript = this.transcriptScrollTop >= maxScrollTop;
		const visibleTranscript = transcript.slice(this.transcriptScrollTop, this.transcriptScrollTop + transcriptHeight);

		const wasFocused = this.input.focused;
		this.input.focused = false;
		const inputLine = this.input.render(innerWidth)[0] ?? "";
		this.input.focused = wasFocused;
		const lines = [
			this.borderLine(innerWidth, "top"),
			this.frameLine(this.theme.fg("accent", this.theme.bold(" BTW side chat ")), innerWidth),
			this.frameLine(this.theme.fg("dim", "Separate side conversation. Esc closes."), innerWidth),
			this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`),
		];
		for (const line of visibleTranscript) lines.push(this.frameLine(line, innerWidth));
		for (let index = visibleTranscript.length; index < transcriptHeight; index++) lines.push(this.frameLine("", innerWidth));
		lines.push(
			this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`),
			this.frameLine(this.theme.fg("warning", this.getStatus()), innerWidth),
			`${this.theme.fg("borderMuted", "│")}${inputLine}${this.theme.fg("borderMuted", "│")}`,
			this.frameLine(this.theme.fg("dim", "↑↓/PgUp/PgDn scroll · Enter send · Esc close"), innerWidth),
			this.borderLine(innerWidth, "bottom"),
		);
		return lines;
	}
}
