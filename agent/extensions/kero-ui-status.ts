import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function keroUIStatus(pi: ExtensionAPI) {
	if (!process.env.KERO_PANE) return;

	let waiting = false;
	function clear() {
		if (!waiting) return;
		waiting = false;
		// Remove only the temporary override so Kero resumes automatic status detection.
		process.stdout.write("\u001b]7501;state=clear:app=pi\u001b\\");
	}

	pi.on("ui_prompt_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || waiting) return;
		waiting = true;
		const message = Buffer.from("等待回答").toString("base64");
		process.stdout.write(`\u001b]7501;state=blocked:kind=question:app=pi:msg=${message}\u001b\\`);
	});
	pi.on("ui_prompt_end", clear);
	pi.on("session_shutdown", clear);
}
