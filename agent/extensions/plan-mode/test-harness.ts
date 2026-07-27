import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

const codingAgentStub = `data:text/javascript,${encodeURIComponent(`
	export const CONFIG_DIR_NAME = ".pi";
	export function getAgentDir() { return "/nonexistent-plan-mode-agent"; }
	export function isToolCallEventType(name, event) { return event.toolName === name; }
`)}`;
const piAiStub = `data:text/javascript,${encodeURIComponent(`
	export function StringEnum(values) { return { enum: values }; }
`)}`;
const typeboxStub = `data:text/javascript,${encodeURIComponent(`
	export const Type = {
		Object(properties, options = {}) { return { type: "object", properties, ...options }; },
		String(options = {}) { return { type: "string", ...options }; },
		Optional(schema) { return schema; },
		Array(items, options = {}) { return { type: "array", items, ...options }; },
		Boolean(options = {}) { return { type: "boolean", ...options }; },
	};
`)}`;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-coding-agent") return { url: codingAgentStub, shortCircuit: true };
		if (specifier === "@earendil-works/pi-ai") return { url: piAiStub, shortCircuit: true };
		if (specifier === "typebox") return { url: typeboxStub, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});

// Runtime imports are intentionally deferred until the extension-only dependency stubs above are registered.
const { default: planModeExtension } = await import("./index.ts");

interface ToolResult {
	content?: Array<{ text?: string }>;
	details?: { answers?: Array<{ answer: string }> };
}

interface FakeContext {
	cwd: string;
	mode: string;
	hasUI: boolean;
	isProjectTrusted: () => boolean;
	isIdle: () => boolean;
	sessionManager: { getBranch: () => BranchEntry[] };
	ui: {
		theme: { fg: (color: string, text: string) => string; bold: (text: string) => string };
		setStatus: (key: string, value: string | undefined) => void;
		setWidget: (key: string, value: string[] | undefined) => void;
		notify: (message: string, level: string) => void;
		select: (title: string, choices: string[]) => Promise<string | undefined>;
		input: (title: string, placeholder: string) => Promise<string | undefined>;
		editor: (title: string, content: string) => Promise<string | undefined>;
		confirm: (title: string, message: string) => Promise<boolean>;
	};
}

interface PlanFixture {
	id: string;
	revision: number;
	title: string;
	summary: string;
	implementation: string[];
	publicInterfaces: string[];
	steps: Array<{ id: string; title: string; description: string; paths: string[]; status: string }>;
	tests: string[];
	assumptions: string[];
	outOfScope: string[];
	createdAt: string;
	updatedAt: string;
}

interface TestState {
	phase?: unknown;
	plan?: unknown;
	toolsBeforePlan?: unknown;
	executionPolicy?: unknown;
}

type Handler = (event: Record<string, unknown>, ctx: FakeContext) => unknown;
type RegisteredTool = {
	name: string;
	executionMode?: "sequential" | "parallel";
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: FakeContext,
	) => Promise<ToolResult>;
};
type RegisteredCommand = { handler: (args: string, ctx: FakeContext) => Promise<void> };
type BranchEntry = { type: string; customType?: string; data?: unknown };

function contextShape(): FakeContext {
	return {
		cwd: "",
		mode: "tui",
		hasUI: true,
		isProjectTrusted: () => false,
		isIdle: () => true,
		sessionManager: { getBranch: (): BranchEntry[] => [] },
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			setStatus: (_key: string, _value: string | undefined) => {},
			setWidget: (_key: string, _value: string[] | undefined) => {},
			notify: (_message: string, _level: string) => {},
			select: async (_title: string, _choices: string[]) => undefined as string | undefined,
			input: async (_title: string, _placeholder: string) => undefined as string | undefined,
			editor: async (_title: string, _content: string) => undefined as string | undefined,
			confirm: async (_title: string, _message: string) => false,
		},
	};
}

export function plan(title = "Plan Title"): PlanFixture {
	return {
		id: "plan-1",
		revision: 1,
		title,
		summary: "A complete summary",
		implementation: ["Implement the behavior"],
		publicInterfaces: [],
		steps: [
			{ id: "S1", title: "First", description: "First change", paths: ["a.ts"], status: "pending" },
			{ id: "S2", title: "Second", description: "Second change", paths: ["b.ts"], status: "pending" },
		],
		tests: ["Run focused checks"],
		assumptions: [],
		outOfScope: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

export function stateEntry(phase: string, options: { savedPlan?: PlanFixture; tools?: string[]; executionPolicy?: string } = {}): BranchEntry {
	return {
		type: "custom",
		customType: "plan-mode-state-v1",
		data: {
			version: 1,
			phase,
			plan: options.savedPlan,
			toolsBeforePlan: options.tools,
			executionPolicy: options.executionPolicy ?? "restore",
		},
	};
}

export function proposal(overrides: Record<string, unknown> = {}) {
	return {
		title: "Implement Plan Mode",
		summary: "Implement the complete approved behavior.",
		implementation: ["Add the complete behavior"],
		publicInterfaces: ["Expose /plan"],
		steps: [{ title: "Implement", description: "Implement the approved behavior", paths: ["index.ts"] }],
		tests: ["Run focused tests"],
		assumptions: [],
		outOfScope: [],
		...overrides,
	};
}

interface HarnessStore {
	activeTools: string[];
	branch: BranchEntry[];
	idle: boolean;
	planFlag: boolean;
	sendError?: Error;
	appended: BranchEntry[];
	notifications: Array<{ message: string; level: string }>;
	uiEvents: Array<{ type: string; title?: string; value?: unknown }>;
	selectQueue: Array<string | undefined>;
	inputQueue: Array<string | undefined>;
	editorQueue: Array<string | undefined>;
	confirmQueue: boolean[];
	messages: Array<{ message: unknown; options: unknown }>;
	userMessages: string[];
	tools: Map<string, RegisteredTool>;
	commands: Map<string, RegisteredCommand>;
	handlers: Map<string, Handler>;
	statuses: Map<string, string | undefined>;
	widgets: Map<string, string[] | undefined>;
}

function createStore(options: { activeTools?: string[]; branch?: BranchEntry[]; planFlag?: boolean }): HarnessStore {
	return {
		activeTools: [...(options.activeTools ?? ["read", "bash", "edit", "write"])],
		branch: structuredClone(options.branch ?? []),
		idle: true,
		planFlag: options.planFlag ?? false,
		appended: [], notifications: [], uiEvents: [], selectQueue: [], inputQueue: [], editorQueue: [], confirmQueue: [],
		messages: [], userMessages: [], tools: new Map(), commands: new Map(), handlers: new Map(), statuses: new Map(), widgets: new Map(),
	};
}

function createApi(store: HarnessStore) {
	return {
		registerFlag: () => {},
		registerTool: (tool: RegisteredTool) => store.tools.set(tool.name, tool),
		registerCommand: (name: string, command: RegisteredCommand) => store.commands.set(name, command),
		registerShortcut: () => {},
		on: (name: string, handler: Handler) => store.handlers.set(name, handler),
		getActiveTools: () => [...store.activeTools],
		setActiveTools: (names: string[]) => { store.activeTools = [...names]; },
		appendEntry: (customType: string, data: unknown) => {
			const entry = { type: "custom", customType, data: structuredClone(data) };
			store.appended.push(entry);
			store.branch.push(entry);
		},
		getFlag: (name: string) => name === "plan" ? store.planFlag : undefined,
		sendMessage: (message: unknown, options: unknown) => {
			if (store.sendError) throw store.sendError;
			store.messages.push({ message, options });
		},
		sendUserMessage: (message: string) => store.userMessages.push(message),
	};
}

function configureContext(ctx: FakeContext, root: string, store: HarnessStore, mode: string, hasUI: boolean): void {
	ctx.cwd = root;
	ctx.mode = mode;
	ctx.hasUI = hasUI;
	ctx.isIdle = () => store.idle;
	ctx.sessionManager.getBranch = () => store.branch;
	ctx.ui.setStatus = (key, value) => store.statuses.set(key, value);
	ctx.ui.setWidget = (key, value) => store.widgets.set(key, value);
	ctx.ui.notify = (message, level) => {
		store.notifications.push({ message, level });
		store.uiEvents.push({ type: "notify", value: message });
	};
	ctx.ui.select = async (title, choices) => {
		store.uiEvents.push({ type: "select", title, value: [...choices] });
		return store.selectQueue.shift();
	};
	ctx.ui.input = async (title, placeholder) => {
		store.uiEvents.push({ type: "input", title, value: placeholder });
		return store.inputQueue.shift();
	};
	ctx.ui.editor = async (title, content) => {
		store.uiEvents.push({ type: "editor", title, value: content });
		return store.editorQueue.length > 0 ? store.editorQueue.shift() : content;
	};
	ctx.ui.confirm = async (title, message) => {
		store.uiEvents.push({ type: "confirm", title, value: message });
		return store.confirmQueue.shift() ?? false;
	};
}

function createHarnessResult(ctx: FakeContext, store: HarnessStore) {
	return {
		ctx,
		appended: store.appended,
		notifications: store.notifications,
		uiEvents: store.uiEvents,
		selectQueue: store.selectQueue,
		inputQueue: store.inputQueue,
		editorQueue: store.editorQueue,
		confirmQueue: store.confirmQueue,
		messages: store.messages,
		userMessages: store.userMessages,
		statuses: store.statuses,
		widgets: store.widgets,
		activeTools: () => [...store.activeTools],
		latestState: () => {
			const data = store.appended.at(-1)?.data;
			return data && typeof data === "object" ? (data as TestState) : undefined;
		},
		setActiveTools: (names: string[]) => { store.activeTools = [...names]; },
		setBranch: (entries: BranchEntry[]) => { store.branch = structuredClone(entries); },
		setIdle: (value: boolean) => { store.idle = value; },
		setPlanFlag: (value: boolean) => { store.planFlag = value; },
		setSendError: (error: Error | undefined) => { store.sendError = error; },
		start: async () => store.handlers.get("session_start")?.({}, ctx),
		tree: async () => store.handlers.get("session_tree")?.({}, ctx),
		input: async (source = "user") => store.handlers.get("input")?.({ source }, ctx),
		toolCall: async (toolName: string, input: Record<string, unknown>) => store.handlers.get("tool_call")?.({ toolName, input }, ctx),
		toolMode: (name: string) => store.tools.get(name)?.executionMode,
		tool: async (name: string, params: Record<string, unknown>) => {
			const tool = store.tools.get(name);
			assert.ok(tool, `missing tool ${name}`);
			return tool.execute("call-1", params, undefined, undefined, ctx);
		},
		command: async (args: string) => {
			const command = store.commands.get("plan");
			assert.ok(command);
			return command.handler(args, ctx);
		},
	};
}

export async function harness(
	t: TestContext,
	options: { activeTools?: string[]; branch?: BranchEntry[]; planFlag?: boolean; mode?: string; hasUI?: boolean } = {},
) {
	const root = await fs.mkdtemp(path.join(tmpdir(), "plan-mode-index-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const store = createStore(options);
	planModeExtension(createApi(store) as never);
	const ctx = contextShape();
	configureContext(ctx, root, store, options.mode ?? "tui", options.hasUI ?? true);
	return createHarnessResult(ctx, store);
}
