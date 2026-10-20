import { performance } from "node:perf_hooks";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

const STATUS_KEY = "token-speed";
const UPDATE_INTERVAL_MS = 250;
const WINDOW_MS = 1_000;

export default function tokenSpeed(pi: ExtensionAPI) {
	const encoder = new Tiktoken(o200kBase);
	let active = false;
	let lastRate = 0;
	let request: {
		message?: AssistantMessage;
		output: number;
		dirty: boolean;
		tokenizeAfter: number;
		samples: { at: number; output: number }[];
	} | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	const showRate = (ctx: ExtensionContext, rate = lastRate) => {
		lastRate = rate;
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, `${rate.toFixed(1)} tok/s`);
	};
	const stopRequest = (ctx: ExtensionContext) => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
		request = undefined;
		showRate(ctx);
	};
	const reset = (_event: unknown, ctx: ExtensionContext) => {
		active = false;
		stopRequest(ctx);
	};
	const update = (ctx: ExtensionContext) => {
		if (!request) return;
		const now = performance.now();
		if (request.dirty && request.message && now >= request.tokenizeAfter) {
			// shortcut: o200k_base estimates visible output only; use a model-specific tokenizer if live accuracy is needed.
			request.output = request.message.content.reduce((sum, block) => {
				const text = block.type === "text" ? block.text : block.type === "thinking" ? block.thinking
					: `${block.name}${JSON.stringify(block.arguments)}`;
				return sum + encoder.encode(text, [], []).length;
			}, 0);
			request.dirty = false;
			// Limit tokenization to roughly 5% CPU so long replies do not block stream consumption.
			const finished = performance.now();
			request.tokenizeAfter = finished + (finished - now) * 20;
		}
		const at = performance.now();
		const samples = request.samples;
		samples.push({ at, output: request.output });
		while (samples.length > 1 && samples[1].at <= at - WINDOW_MS) samples.shift();
		const elapsed = at - samples[0].at;
		const added = Math.max(0, request.output - samples[0].output);
		showRate(ctx, elapsed > 0 ? added * 1_000 / elapsed : 0);
	};

	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);
	pi.on("session_tree", reset);
	pi.on("agent_settled", reset);
	pi.on("agent_start", (event, ctx) => {
		if (active) return;
		reset(event, ctx);
		active = true;
	});
	pi.on("turn_start", (_event, ctx) => stopRequest(ctx));
	pi.on("before_provider_request", (_event, ctx) => {
		if (!active) return;
		stopRequest(ctx);
		request = { output: 0, dirty: false, tokenizeAfter: 0, samples: [{ at: performance.now(), output: 0 }] };
		if (ctx.mode === "tui") timer = setInterval(() => update(ctx), UPDATE_INTERVAL_MS);
	});
	pi.on("message_update", (event) => {
		if (!request || event.message.role !== "assistant") return;
		request.message = event.message;
		request.dirty = true;
	});
	pi.on("message_end", (event, ctx) => {
		if (active && event.message.role === "assistant") stopRequest(ctx);
	});
}
