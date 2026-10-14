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
	let updateTimer: ReturnType<typeof setInterval> | undefined;

	function stopUpdates(): void {
		if (updateTimer === undefined) return;
		clearInterval(updateTimer);
		updateTimer = undefined;
	}

	function updateWidget(ctx: ExtensionContext): void {
		if (startedAt === undefined) return;
		ctx.ui.setWidget(WIDGET_KEY, [`执行中 · ${formatElapsed(Date.now() - startedAt)}`], { placement: "aboveEditor" });
	}

	pi.on("session_start", async (_event, ctx) => {
		startedAt = undefined;
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

	pi.on("agent_settled", async (_event, ctx) => {
		if (startedAt === undefined) return;

		const elapsed = formatElapsed(Date.now() - startedAt);
		stopUpdates();
		startedAt = undefined;
		ctx.ui.setWidget(WIDGET_KEY, [`耗时 ${elapsed}`], { placement: "aboveEditor" });
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopUpdates();
		startedAt = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
}
