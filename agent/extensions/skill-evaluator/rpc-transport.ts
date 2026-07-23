import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { RpcRunRequest, ToolTrace } from "./types.ts";

const STDERR_LIMIT = 1024 * 1024;
const MAX_JSONL_LINE_BYTES = 4 * 1024 * 1024;
const MAX_RETAINED_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_RETAINED_EVENTS = 5_000;
const MAX_RETAINED_MESSAGES = 100;
const MAX_RETAINED_TRACES = 1_000;
const MAX_RETAINED_VALUE_BYTES = 128 * 1024;
const SHUTDOWN_GRACE_MS = 2_000;
const KILL_GRACE_MS = 5_000;

export class JsonlDecoder {
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";

	push(chunk: Buffer | string): string[] {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		this.assertBounded();
		return this.drain(false);
	}

	end(): string[] {
		this.buffer += this.decoder.end();
		this.assertBounded();
		return this.drain(true);
	}

	private assertBounded(): void {
		if (Buffer.byteLength(this.buffer) > MAX_JSONL_LINE_BYTES && !this.buffer.includes("\n")) {
			throw new Error(`RPC JSONL line exceeds ${MAX_JSONL_LINE_BYTES} bytes.`);
		}
	}

	private drain(flush: boolean): string[] {
		const lines: string[] = [];
		while (true) {
			const index = this.buffer.indexOf("\n");
			if (index < 0) break;
			let line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (Buffer.byteLength(line) > MAX_JSONL_LINE_BYTES) throw new Error(`RPC JSONL line exceeds ${MAX_JSONL_LINE_BYTES} bytes.`);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			lines.push(line);
		}
		if (flush && this.buffer.length > 0) {
			let line = this.buffer;
			this.buffer = "";
			if (line.endsWith("\r")) line = line.slice(0, -1);
			lines.push(line);
		}
		return lines;
	}
}

function truncateJsonValue(value: unknown): unknown {
	const json = JSON.stringify(value);
	if (json === undefined || Buffer.byteLength(json) <= MAX_RETAINED_VALUE_BYTES) return value;
	return {
		truncated: true,
		preview: Buffer.from(json).subarray(0, MAX_RETAINED_VALUE_BYTES).toString("utf8"),
		originalBytes: Buffer.byteLength(json),
	};
}

export interface AssistantFailure {
	kind: "agent" | "aborted";
	message: string;
}

export class RpcEventCollector {
	readonly events: unknown[] = [];
	readonly messages: unknown[] = [];
	readonly traces = new Map<string, ToolTrace>();
	structuredOutput: unknown;
	assistantFailure?: AssistantFailure;
	private eventBytes = 0;
	private droppedEvents = 0;
	private settledResolve?: () => void;
	private settledReject?: (error: Error) => void;
	private readonly onProgress?: (message: string) => void;

	constructor(onProgress?: (message: string) => void) {
		this.onProgress = onProgress;
	}

	hasSettledWaiter(): boolean {
		return this.settledResolve !== undefined || this.settledReject !== undefined;
	}

	waitForSettled(): Promise<void> {
		if (this.hasSettledWaiter()) throw new Error("An agent-settled waiter is already active.");
		return new Promise<void>((resolve, reject) => {
			this.settledResolve = resolve;
			this.settledReject = reject;
		});
	}

	fail(error: Error): void {
		this.settledReject?.(error);
		this.settledResolve = undefined;
		this.settledReject = undefined;
	}

	handle(object: any): void {
		this.recordEvent(object);
		if (object.type === "message_end" && object.message) this.recordMessage(object.message);
		if (object.type === "tool_execution_start") this.startTrace(object);
		if (object.type === "tool_execution_end") this.endTrace(object);
		if (object.type === "agent_settled") {
			this.settledResolve?.();
			this.settledResolve = undefined;
			this.settledReject = undefined;
		}
	}

	finalizeEvents(): unknown[] {
		if (this.droppedEvents === 0) return this.events;
		return [...this.events, { type: "skill_eval_events_truncated", droppedEvents: this.droppedEvents }];
	}

	private recordEvent(object: any): void {
		if (object.type === "message_update" || object.type === "tool_execution_update") {
			this.droppedEvents++;
			return;
		}
		const retained = truncateJsonValue(object);
		const bytes = Buffer.byteLength(JSON.stringify(retained));
		if (this.events.length >= MAX_RETAINED_EVENTS || this.eventBytes + bytes > MAX_RETAINED_EVENT_BYTES) {
			this.droppedEvents++;
			return;
		}
		this.events.push(retained);
		this.eventBytes += bytes;
	}

	private recordMessage(message: any): void {
		if (this.messages.length < MAX_RETAINED_MESSAGES) this.messages.push(truncateJsonValue(message));
		if (message.role !== "assistant") return;
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			this.assistantFailure = {
				kind: message.stopReason === "aborted" ? "aborted" : "agent",
				message: String(message.errorMessage ?? `Assistant stopped with ${message.stopReason}.`),
			};
		} else {
			this.assistantFailure = undefined;
		}
	}

	private startTrace(object: any): void {
		if (!this.traces.has(object.toolCallId) && this.traces.size >= MAX_RETAINED_TRACES) return;
		this.traces.set(object.toolCallId, {
			toolCallId: object.toolCallId,
			toolName: object.toolName,
			args: truncateJsonValue(object.args),
			startedAt: Date.now(),
		});
		this.onProgress?.(`tool: ${object.toolName}`);
	}

	private endTrace(object: any): void {
		if (!this.traces.has(object.toolCallId) && this.traces.size >= MAX_RETAINED_TRACES) return;
		const trace: ToolTrace = this.traces.get(object.toolCallId) ?? {
			toolCallId: object.toolCallId,
			toolName: object.toolName,
		};
		trace.result = truncateJsonValue(object.result);
		trace.isError = object.isError === true;
		trace.endedAt = Date.now();
		this.traces.set(object.toolCallId, trace);
		if (object.result?.details !== undefined && String(object.toolName).startsWith("submit_skill_eval_")) {
			this.structuredOutput = truncateJsonValue(object.result.details);
		}
	}
}

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
}

export interface RpcTransportOptions {
	spawnImpl?: typeof spawn;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RpcTransport {
	readonly collector: RpcEventCollector;
	stderr = "";
	exitCode: number | null = null;
	protocolError?: Error;
	private proc?: ChildProcessWithoutNullStreams;
	private requestId = 0;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly request: RpcRunRequest;
	private readonly options: RpcTransportOptions;

	constructor(request: RpcRunRequest, options: RpcTransportOptions = {}) {
		this.request = request;
		this.options = options;
		this.collector = new RpcEventCollector(request.onProgress);
	}

	start(): void {
		const invocation = getPiInvocation(["--mode", "rpc", "--no-session", ...this.request.args]);
		this.proc = (this.options.spawnImpl ?? spawn)(invocation.command, invocation.args, {
			cwd: this.request.cwd,
			env: { ...process.env, ...this.request.env, PI_SKILL_EVAL_CHILD: "1" },
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;
		this.attachListeners(this.proc);
	}

	send<T = any>(command: Record<string, unknown>): Promise<T> {
		if (!this.proc || !this.proc.stdin.writable) return Promise.reject(new Error("RPC process stdin is not writable"));
		const id = `skill-eval-${++this.requestId}`;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.proc!.stdin.write(`${JSON.stringify({ id, ...command })}\n`, (error) => {
				if (!error) return;
				this.pending.delete(id);
				reject(error);
			});
		});
	}

	async requestAbort(): Promise<void> {
		if (!this.proc?.stdin.writable) return;
		const id = `skill-eval-${++this.requestId}`;
		await new Promise<void>((resolve, reject) => {
			this.proc!.stdin.write(`${JSON.stringify({ id, type: "abort" })}\n`, (error) => error ? reject(error) : resolve());
		});
	}

	async terminate(): Promise<void> {
		const proc = this.proc;
		if (!proc || proc.exitCode !== null) return;
		if (proc.stdin.writable) proc.stdin.end();
		await Promise.race([new Promise<void>((resolve) => proc.once("close", () => resolve())), delay(SHUTDOWN_GRACE_MS)]);
		if (proc.exitCode === null) {
			proc.kill("SIGTERM");
			await Promise.race([new Promise<void>((resolve) => proc.once("close", () => resolve())), delay(KILL_GRACE_MS)]);
		}
		if (proc.exitCode === null) proc.kill("SIGKILL");
	}

	private attachListeners(proc: ChildProcessWithoutNullStreams): void {
		const decoder = new JsonlDecoder();
		proc.stdout.on("data", (chunk) => this.consume(decoder, chunk));
		proc.stdout.on("end", () => this.consumeEnd(decoder));
		proc.stderr.on("data", (chunk) => {
			if (this.stderr.length < STDERR_LIMIT) this.stderr += chunk.toString().slice(0, STDERR_LIMIT - this.stderr.length);
		});
		proc.on("error", (error) => this.fail(error));
		proc.on("close", (code) => {
			this.exitCode = code;
			if (this.pending.size > 0 || this.collector.hasSettledWaiter()) {
				this.fail(new Error(`Pi RPC process closed with code ${code} while requests were pending.`));
			}
		});
	}

	private consume(decoder: JsonlDecoder, chunk: Buffer): void {
		try {
			for (const line of decoder.push(chunk)) this.processLine(line);
		} catch (error) {
			this.protocolError = error instanceof Error ? error : new Error(String(error));
			this.fail(this.protocolError);
		}
	}

	private consumeEnd(decoder: JsonlDecoder): void {
		try {
			for (const line of decoder.end()) this.processLine(line);
		} catch (error) {
			this.protocolError = error instanceof Error ? error : new Error(String(error));
			this.fail(this.protocolError);
		}
	}

	private processLine(line: string): void {
		if (!line.trim()) return;
		let object: any;
		try {
			object = JSON.parse(line);
		} catch (error) {
			throw new Error(`Invalid RPC JSONL record: ${line.slice(0, 200)}`, { cause: error });
		}
		if (!object || typeof object !== "object") throw new Error("RPC JSONL record must be an object.");
		if (object.type === "response" && typeof object.id === "string") {
			const item = this.pending.get(object.id);
			if (!item) return;
			this.pending.delete(object.id);
			if (object.success === false) item.reject(new Error(object.error || `RPC ${object.command} failed`));
			else item.resolve(object.data);
			return;
		}
		this.collector.handle(object);
	}

	private fail(error: Error): void {
		for (const item of this.pending.values()) item.reject(error);
		this.pending.clear();
		this.collector.fail(error);
	}
}
