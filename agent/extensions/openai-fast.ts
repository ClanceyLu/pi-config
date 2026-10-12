import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "openai-fast";
const TARGET_PROVIDER = "openai-codex";
const TARGET_MODEL = "gpt-5.6-sol";

export default function (pi: ExtensionAPI) {
	// Priority may consume additional quota. Opt in explicitly for each session.
	let enabled = false;

	const isSupportedModel = (ctx: ExtensionContext) =>
		ctx.model?.provider === TARGET_PROVIDER && ctx.model.id === TARGET_MODEL;

	const updateStatus = (ctx: ExtensionContext) => {
		// Keep Pi's built-in footer so context threshold colors and the auto-compaction
		// indicator continue to reflect the core session state.
		ctx.ui.setStatus(STATUS_ID, enabled && isSupportedModel(ctx) ? "fast" : undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		enabled = false;
		updateStatus(ctx);
	});
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Codex Fast/Priority mode (usage: /fast [on|off|status])",
		getArgumentCompletions: (prefix) => {
			const normalizedPrefix = prefix.trim().toLowerCase();
			const items = ["on", "off", "status"]
				.filter((value) => value.startsWith(normalizedPrefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();

			if ((action === "on" || action === "") && !isSupportedModel(ctx)) {
				ctx.ui.notify(`Priority mode is not configured for this model; supported: ${TARGET_PROVIDER}/${TARGET_MODEL}`, "warning");
				return;
			}

			if (action === "on") enabled = true;
			else if (action === "off") enabled = false;
			else if (action === "status") {
				// Keep the current value.
			} else if (action === "") enabled = !enabled;
			else {
				ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
				return;
			}

			updateStatus(ctx);
			const state = enabled ? "enabled" : "disabled";
			if (isSupportedModel(ctx)) {
				ctx.ui.notify(`Fast mode ${state}`, "info");
			} else {
				ctx.ui.notify(
					`Fast mode ${state}; it only applies to ${TARGET_PROVIDER}/${TARGET_MODEL}`,
					"warning",
				);
			}
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (
			!enabled ||
			!isSupportedModel(ctx) ||
			!event.payload ||
			typeof event.payload !== "object" ||
			Array.isArray(event.payload)
		) {
			return;
		}

		return {
			...event.payload,
			service_tier: "priority",
		};
	});
}
