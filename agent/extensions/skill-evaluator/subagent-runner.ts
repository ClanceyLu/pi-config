import type { ProcessError, RpcRunRequest, RpcRunResult, UsageStats } from "./types.ts";
import { JsonlDecoder, RpcTransport, type RpcTransportOptions } from "./rpc-transport.ts";

export { JsonlDecoder } from "./rpc-transport.ts";

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, toolCalls: 0, turns: 0 };
}

function asError(kind: ProcessError["kind"], error: unknown): ProcessError {
	return { kind, message: error instanceof Error ? error.message : String(error) };
}

function combinedAbortSignal(request: RpcRunRequest): { signal: AbortSignal; cancelTimeout(): void } {
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(new Error(`Timed out after ${request.timeoutMs}ms`)), request.timeoutMs);
	const combined = new AbortController();
	for (const source of [timeout.signal, ...(request.signal ? [request.signal] : [])]) {
		if (source.aborted) combined.abort(source.reason);
		else source.addEventListener("abort", () => combined.abort(source.reason), { once: true });
	}
	return { signal: combined.signal, cancelTimeout: () => clearTimeout(timer) };
}

interface WorkflowResult {
	commands: Array<{ name: string; source?: string; path?: string }>;
	finalText: string;
	usage: UsageStats;
	model?: RpcRunResult["model"];
	thinkingLevel?: string;
}

async function executeWorkflow(transport: RpcTransport, request: RpcRunRequest): Promise<WorkflowResult> {
	const commandData = await transport.send<{ commands?: WorkflowResult["commands"] }>({ type: "get_commands" });
	const commands = commandData?.commands ?? [];
	const actualSkills = commands.filter((item) => item.source === "skill").map((item) => item.name).sort();
	const expectedSkills = [...(request.expectedSkills ?? [])].sort();
	if (JSON.stringify(actualSkills) !== JSON.stringify(expectedSkills)) {
		throw new Error(`Skill preflight mismatch: expected [${expectedSkills.join(", ")}], got [${actualSkills.join(", ")}]`);
	}
	const state = await transport.send<any>({ type: "get_state" });
	const base = {
		commands,
		model: state?.model ? { provider: state.model.provider, id: state.model.id } : undefined,
		thinkingLevel: state?.thinkingLevel,
	};
	if (request.probeOnly) return { ...base, finalText: "", usage: emptyUsage() };
	const settled = transport.collector.waitForSettled();
	await transport.send({ type: "prompt", message: request.prompt });
	await settled;
	const [last, stats] = await Promise.all([
		transport.send<{ text: string | null }>({ type: "get_last_assistant_text" }),
		transport.send<any>({ type: "get_session_stats" }),
	]);
	return {
		...base,
		finalText: last?.text ?? "",
		usage: {
			input: stats?.tokens?.input ?? 0,
			output: stats?.tokens?.output ?? 0,
			cacheRead: stats?.tokens?.cacheRead ?? 0,
			cacheWrite: stats?.tokens?.cacheWrite ?? 0,
			totalTokens: stats?.tokens?.total ?? 0,
			cost: stats?.cost ?? 0,
			toolCalls: stats?.toolCalls ?? transport.collector.traces.size,
			turns: stats?.assistantMessages ?? 0,
		},
	};
}

function abortRace(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		const rejectAbort = () => reject(signal.reason ?? new Error("Aborted"));
		if (signal.aborted) rejectAbort();
		else signal.addEventListener("abort", rejectAbort, { once: true });
	});
}

export async function runPiRpc(request: RpcRunRequest, options: RpcTransportOptions = {}): Promise<RpcRunResult> {
	const startedAt = Date.now();
	const abort = combinedAbortSignal(request);
	const transport = new RpcTransport(request, options);
	let workflow: WorkflowResult = { commands: [], finalText: "", usage: emptyUsage() };
	let resultError: ProcessError | undefined;
	try {
		transport.start();
		workflow = await Promise.race([executeWorkflow(transport, request), abortRace(abort.signal)]);
	} catch (error) {
		const timedOut = abort.signal.aborted && !request.signal?.aborted;
		const externallyAborted = request.signal?.aborted === true;
		resultError = asError(timedOut ? "timeout" : externallyAborted ? "aborted" : transport.protocolError ? "protocol" : "agent", error);
		try {
			await transport.requestAbort();
		} catch (abortError) {
			resultError.message += `; failed to send RPC abort: ${abortError instanceof Error ? abortError.message : String(abortError)}`;
		}
	} finally {
		abort.cancelTimeout();
		await transport.terminate();
	}
	if (!resultError && transport.collector.assistantFailure) resultError = { ...transport.collector.assistantFailure };
	if (!resultError && transport.protocolError) resultError = asError("protocol", transport.protocolError);
	if (!resultError && transport.exitCode !== null && transport.exitCode !== 0) resultError = asError("exit", `Pi exited with code ${transport.exitCode}`);
	return {
		exitCode: transport.exitCode,
		finalText: workflow.finalText,
		messages: transport.collector.messages,
		events: transport.collector.finalizeEvents(),
		commands: workflow.commands,
		usage: workflow.usage,
		toolTrace: Array.from(transport.collector.traces.values()),
		model: workflow.model,
		thinkingLevel: workflow.thinkingLevel,
		durationMs: Date.now() - startedAt,
		stderr: transport.stderr,
		error: resultError,
		structuredOutput: transport.collector.structuredOutput,
	};
}
