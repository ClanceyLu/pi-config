import {
	buildSessionContext,
	createAgentSession,
	createExtensionRuntime,
	SessionManager,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message, ThinkingLevel as AiThinkingLevel } from "@earendil-works/pi-ai";

const BTW_SYSTEM_PROMPT = [
	"You are BTW, a side-channel assistant embedded in the user's coding agent.",
	"You have access to the main conversation context — use it to give informed answers.",
	"Help with focused questions, planning, and quick explorations.",
	"Be direct and practical.",
].join(" ");

const BTW_SUMMARY_PROMPT =
	"Summarize this side conversation for handoff into the main conversation. Keep key decisions, findings, risks, and next actions. Output only the summary.";

export type SessionThinkingLevel = "off" | AiThinkingLevel;

export interface BtwDetails {
	question: string;
	answer: string;
	timestamp: number;
	provider: string;
	model: string;
	thinkingLevel: SessionThinkingLevel;
	usage?: AssistantMessage["usage"];
}

export interface SideSessionRuntime {
	session: AgentSession;
	modelKey: string;
	unsubscribe: () => void;
}

function stripDynamicSystemPromptFooter(systemPrompt: string): string {
	return systemPrompt
		.replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "")
		.replace(/\nCurrent working directory:[^\n]*$/u, "")
		.trim();
}

function createBtwResourceLoader(ctx: ExtensionContext, appendSystemPrompt: string[] = [BTW_SYSTEM_PROMPT]): ResourceLoader {
	const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	const systemPrompt = stripDynamicSystemPromptFooter(ctx.getSystemPrompt());
	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => appendSystemPrompt,
		extendResources: () => {},
		reload: async () => {},
	};
}

export function extractAssistantText(parts: AssistantMessage["content"]): string {
	return parts.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
}

export function extractEventAssistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const candidate = message as { role?: unknown; content?: unknown };
	if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return "";
	return candidate.content
		.filter((part): part is { type: "text"; text: string } =>
			!!part && typeof part === "object" && (part as { type?: unknown }).type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export function getLastAssistantMessage(session: AgentSession): AssistantMessage | null {
	for (let index = session.state.messages.length - 1; index >= 0; index--) {
		const message = session.state.messages[index];
		if (message.role === "assistant") return message as AssistantMessage;
	}
	return null;
}

function buildSeedMessages(ctx: ExtensionContext, thread: BtwDetails[]): Message[] {
	const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages;
	const seed = context.filter((message) => "role" in message) as Message[];
	for (const item of thread) {
		seed.push(
			{ role: "user", content: [{ type: "text", text: item.question }], timestamp: item.timestamp },
			{
				role: "assistant",
				content: [{ type: "text", text: item.answer }],
				provider: item.provider,
				model: item.model,
				api: ctx.model?.api ?? "openai-responses",
				usage: item.usage ?? {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: item.timestamp,
			},
		);
	}
	return seed;
}

export async function createBtwSideSession(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	thread: BtwDetails[],
	onEvent: (event: AgentSessionEvent) => void,
): Promise<SideSessionRuntime | null> {
	if (!ctx.model) return null;
	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		sessionManager: SessionManager.inMemory(),
		model: ctx.model,
		modelRegistry: ctx.modelRegistry as AgentSession["modelRegistry"],
		thinkingLevel: pi.getThinkingLevel() as SessionThinkingLevel,
		tools: ["read", "bash", "edit", "write"],
		resourceLoader: createBtwResourceLoader(ctx),
	});
	try {
		const seedMessages = buildSeedMessages(ctx, thread);
		if (seedMessages.length > 0) session.agent.state.messages = seedMessages as typeof session.agent.state.messages;
		return {
			session,
			modelKey: `${ctx.model.provider}/${ctx.model.id}`,
			unsubscribe: session.subscribe(onEvent),
		};
	} catch (error) {
		let abortError: unknown;
		try {
			await session.abort();
		} catch (cleanupError) {
			abortError = cleanupError;
		} finally {
			session.dispose();
		}
		if (abortError) throw new AggregateError([error, abortError], "Failed to seed and clean up the BTW side session");
		throw error;
	}
}

function formatThread(thread: BtwDetails[]): string {
	return thread.map((item) => `User: ${item.question.trim()}\nAssistant: ${item.answer.trim()}`).join("\n\n---\n\n");
}

export async function summarizeBtwThread(ctx: ExtensionContext, thread: BtwDetails[]): Promise<string> {
	if (!ctx.model) throw new Error("No active model selected.");
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (auth.ok === false) throw new Error(auth.error);
	const { session } = await createAgentSession({
		cwd: ctx.cwd,
		sessionManager: SessionManager.inMemory(),
		model: ctx.model,
		modelRegistry: ctx.modelRegistry as AgentSession["modelRegistry"],
		thinkingLevel: "off",
		tools: [],
		resourceLoader: createBtwResourceLoader(ctx, [BTW_SUMMARY_PROMPT]),
	});
	try {
		await session.prompt(formatThread(thread), { source: "extension" });
		const response = getLastAssistantMessage(session);
		if (!response) throw new Error("Summary finished without a response.");
		if (response.stopReason === "aborted") throw new Error("Summary request was aborted.");
		if (response.stopReason === "error") throw new Error(response.errorMessage || "Summary request failed.");
		return extractAssistantText(response.content) || "(No summary generated)";
	} finally {
		await session.abort().catch(() => undefined);
		session.dispose();
	}
}
