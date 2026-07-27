import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

const codingAgentStub = `data:text/javascript,${encodeURIComponent(`
	export const CONFIG_DIR_NAME = ".pi";
	export function getAgentDir() { return "/nonexistent-reasoning-mode-agent"; }
	export function isToolCallEventType(name, event) { return event.toolName === name; }
`)}`;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-coding-agent") return { url: codingAgentStub, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});

const { default: reasoningModeExtension } = await import("./index.ts");

type BranchEntry = { type: string; customType?: string; data?: unknown };
type Handler = (event: Record<string, any>, ctx: FakeContext) => any;
type RegisteredCommand = { handler: (args: string, ctx: FakeContext) => Promise<void> | void };

interface FakeContext {
	cwd: string;
	mode: "tui" | "rpc" | "json" | "print";
	hasUI: boolean;
	isProjectTrusted(): boolean;
	isIdle(): boolean;
	sessionManager: { getBranch(): BranchEntry[] };
	ui: {
		theme: { fg(color: string, text: string): string };
		setStatus(key: string, value: string | undefined): void;
		notify(message: string, level: string): void;
		confirm(title: string, message: string): Promise<boolean>;
	};
}

interface HarnessStore {
	activeTools: string[];
	allTools: string[];
	branch: BranchEntry[];
	idle: boolean;
	flags: Record<string, boolean>;
	appended: BranchEntry[];
	notifications: Array<{ message: string; level: string }>;
	statuses: Map<string, string | undefined>;
	commands: Map<string, RegisteredCommand>;
	handlers: Map<string, Handler>;
	userMessages: string[];
	customMessages: Array<{ customType: string; content: string; display?: boolean }>;
	confirmQueue: boolean[];
	skillPaths: Record<"explore" | "plan", string>;
	skillEnabled: Record<"explore" | "plan", boolean>;
}

function contextShape(): FakeContext {
	return {
		cwd: "",
		mode: "tui",
		hasUI: true,
		isProjectTrusted: () => false,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			notify: () => {},
			confirm: async () => false,
		},
	};
}

function createApi(store: HarnessStore) {
	return {
		registerFlag: () => {},
		registerCommand: (name: string, command: RegisteredCommand) => store.commands.set(name, command),
		registerShortcut: () => {},
		on: (name: string, handler: Handler) => store.handlers.set(name, handler),
		getFlag: (name: string) => store.flags[name] ?? false,
		getActiveTools: () => [...store.activeTools],
		getAllTools: () => store.allTools.map((name) => ({ name })),
		setActiveTools: (names: string[]) => { store.activeTools = [...names]; },
		getCommands: () => (["explore", "plan"] as const)
			.filter((name) => store.skillEnabled[name])
			.map((name) => ({
				name: `skill:${name}`,
				description: name === "plan" ? "Plan" : "Explore",
				source: "skill",
				sourceInfo: {
					path: store.skillPaths[name],
					source: "test",
					scope: "temporary",
					origin: "top-level",
					baseDir: path.dirname(store.skillPaths[name]),
				},
			})),
		appendEntry: (customType: string, data: unknown) => {
			const entry = { type: "custom", customType, data: structuredClone(data) };
			store.appended.push(entry);
			store.branch.push(entry);
		},
		sendMessage: (message: { customType: string; content: string; display?: boolean }) => {
			store.customMessages.push(structuredClone(message));
		},
		sendUserMessage: (message: string) => store.userMessages.push(message),
	};
}

export function stateEntry(mode: "off" | "reasoning", options: { activeSkill?: string; tools?: string[] } = {}): BranchEntry {
	return {
		type: "custom",
		customType: "reasoning-mode-state-v2",
		data: { version: 2, mode, activeSkill: options.activeSkill, toolsBeforeReasoning: options.tools },
	};
}

export function previousStateEntry(mode: "off" | "reasoning", options: { activeSkill?: string; tools?: string[] } = {}): BranchEntry {
	return {
		type: "custom",
		customType: "reasoning-mode-state-v1",
		data: { version: 1, mode, activeSkill: options.activeSkill, toolsBeforeReasoning: options.tools },
	};
}

export function legacyStateEntry(phase: string, tools?: string[]): BranchEntry {
	return { type: "custom", customType: "plan-mode-state-v1", data: { version: 1, phase, toolsBeforePlan: tools } };
}

export async function harness(
	t: TestContext,
	options: {
		activeTools?: string[];
		allTools?: string[];
		branch?: BranchEntry[];
		mode?: FakeContext["mode"];
		planFlag?: boolean;
		reasoningFlag?: boolean;
		skillEnabled?: boolean;
		exploreSkillEnabled?: boolean;
	} = {},
) {
	const root = await fs.mkdtemp(path.join(tmpdir(), "reasoning-mode-test-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const skillPaths = {
		explore: path.join(root, "skills", "explore", "SKILL.md"),
		plan: path.join(root, "skills", "plan", "SKILL.md"),
	};
	await Promise.all(Object.values(skillPaths).map((file) => fs.mkdir(path.dirname(file), { recursive: true })));
	await Promise.all([
		fs.writeFile(skillPaths.explore, `---\nname: explore\ndescription: test\ndisable-model-invocation: true\nmetadata:\n  reasoning-mode: "true"\n---\n\n# Explore workflow\n\nEXPLORE_SKILL_BODY\n`),
		fs.writeFile(skillPaths.plan, `---\nname: plan\ndescription: test\ndisable-model-invocation: true\nmetadata:\n  reasoning-mode: "true"\n---\n\n# Plan workflow\n\nPLAN_SKILL_BODY\n`),
	]);
	const store: HarnessStore = {
		activeTools: [...(options.activeTools ?? ["read", "bash", "edit", "write", "questionnaire", "external"])],
		allTools: [...(options.allTools ?? ["read", "bash", "edit", "write", "grep", "find", "ls", "questionnaire", "external"])],
		branch: structuredClone(options.branch ?? []), idle: true,
		flags: { plan: options.planFlag ?? false, reasoning: options.reasoningFlag ?? false },
		appended: [], notifications: [], statuses: new Map(), commands: new Map(), handlers: new Map(),
		userMessages: [], customMessages: [], confirmQueue: [], skillPaths,
		skillEnabled: { explore: options.exploreSkillEnabled ?? true, plan: options.skillEnabled ?? true },
	};
	const api = createApi(store);
	reasoningModeExtension(api as never);
	const ctx = contextShape();
	ctx.cwd = root;
	ctx.mode = options.mode ?? "tui";
	ctx.hasUI = ctx.mode === "tui" || ctx.mode === "rpc";
	ctx.isIdle = () => store.idle;
	ctx.sessionManager.getBranch = () => store.branch;
	ctx.ui.setStatus = (key, value) => store.statuses.set(key, value);
	ctx.ui.notify = (message, level) => store.notifications.push({ message, level });
	ctx.ui.confirm = async () => store.confirmQueue.shift() ?? false;

	return {
		ctx, store,
		activeTools: () => [...store.activeTools],
		latestState: () => store.appended.at(-1)?.data as Record<string, unknown> | undefined,
		start: async () => store.handlers.get("session_start")?.({}, ctx),
		tree: async () => store.handlers.get("session_tree")?.({}, ctx),
		input: async (text: string, source = "interactive") => store.handlers.get("input")?.({ text, source }, ctx),
		beforeAgent: async () => store.handlers.get("before_agent_start")?.({
			prompt: "task", systemPrompt: "BASE", systemPromptOptions: {
				cwd: root,
				skills: (["explore", "plan"] as const)
					.filter((name) => store.skillEnabled[name])
					.map((name) => ({
						name,
						description: name === "plan" ? "Plan" : "Explore",
						filePath: store.skillPaths[name],
						baseDir: path.dirname(store.skillPaths[name]),
						sourceInfo: {},
						disableModelInvocation: true,
					})),
			},
		}, ctx),
		toolCall: async (toolName: string, input: Record<string, unknown>) => store.handlers.get("tool_call")?.({ toolName, input }, ctx),
		command: async (name: "reasoning" | "plan", args = "") => {
			const command = store.commands.get(name);
			assert.ok(command, `missing command ${name}`);
			return command.handler(args, ctx);
		},
		setBranch: (entries: BranchEntry[]) => { store.branch = structuredClone(entries); },
		setActiveTools: (tools: string[]) => { store.activeTools = [...tools]; },
		setIdle: (idle: boolean) => { store.idle = idle; },
		setSkillEnabled: (enabled: boolean, name: "explore" | "plan" = "plan") => { store.skillEnabled[name] = enabled; },
		removeSkillFile: async (name: "explore" | "plan" = "plan") => fs.rm(store.skillPaths[name], { force: true }),
	};
}
