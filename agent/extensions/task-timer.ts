import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const UPDATE_INTERVAL_MS = 1_000;
const WIDGET_KEY = "task-timer";

export function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Math.floor(Math.max(0, elapsedMs) / 1_000);
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);

	if (totalMinutes === 0) return `${seconds}s`;

	const minutes = totalMinutes % 60;
	if (totalMinutes < 60) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;

	const hours = Math.floor(totalMinutes / 60);
	return `${hours}h ${minutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
}

export default function taskTimer(pi: ExtensionAPI) {
	let startedAt: number | undefined;
	let pausedAt: number | undefined;
	let updateTimer: ReturnType<typeof setInterval> | undefined;

	function stopUpdates(): void {
		if (updateTimer === undefined) return;
		clearInterval(updateTimer);
		updateTimer = undefined;
	}

	function updateWidget(ctx: ExtensionContext): void {
		if (startedAt === undefined) return;
		const status = pausedAt === undefined ? "执行中" : "等待回答";
		ctx.ui.setWidget(WIDGET_KEY, [`${status} · ${formatElapsed((pausedAt ?? Date.now()) - startedAt)}`], { placement: "aboveEditor" });
	}

	pi.on("session_start", async (_event, ctx) => {
		startedAt = undefined;
		pausedAt = undefined;
		stopUpdates();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.on("agent_start", async (_event, ctx) => {
		// Automatic retries can emit another agent_start before agent_settled.
		if (startedAt !== undefined) return;

		ctx.ui.setWidget(WIDGET_KEY, undefined);
		startedAt = Date.now();
		updateWidget(ctx);
		if (ctx.mode === "tui") {
			updateTimer = setInterval(() => updateWidget(ctx), UPDATE_INTERVAL_MS);
		}
	});

	pi.on("ui_prompt_start", async (_event, ctx) => {
		if (startedAt === undefined || pausedAt !== undefined) return;
		pausedAt = Date.now();
		updateWidget(ctx);
	});

	pi.on("ui_prompt_end", async (_event, ctx) => {
		if (startedAt === undefined || pausedAt === undefined) return;
		startedAt += Date.now() - pausedAt;
		pausedAt = undefined;
		updateWidget(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (startedAt === undefined) return;

		const elapsed = formatElapsed((pausedAt ?? Date.now()) - startedAt);
		stopUpdates();
		startedAt = undefined;
		pausedAt = undefined;
		ctx.ui.setWidget(WIDGET_KEY, [`耗时 ${elapsed}`], { placement: "aboveEditor" });
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopUpdates();
		startedAt = undefined;
		pausedAt = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
}
