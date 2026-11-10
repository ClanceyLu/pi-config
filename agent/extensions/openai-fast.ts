import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "openai-fast";
const SUPPORTED_MODELS = new Set([
	"openai-codex/gpt-5.6-sol",
	"magpie/codex/gpt-6.1-sol",
	"magpie/codex/gpt-6-astra",
]);
const supportedModelsLabel = [...SUPPORTED_MODELS].join(", ");

function readEnabled(): boolean {
	try {
		const settings = JSON.parse(readFileSync(join(getAgentDir(), "fast-settings.json"), "utf8"));
		if (typeof settings?.enabled !== "boolean") throw new Error("Invalid fast-settings.json: enabled must be a boolean");
		return settings.enabled;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function saveEnabled(enabled: boolean) {
	const directory = getAgentDir();
	const file = join(directory, "fast-settings.json");
	const temporary = `${file}.${randomUUID()}.tmp`;
	mkdirSync(directory, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify({ enabled }, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, file);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export default function (pi: ExtensionAPI) {
	let enabled = false;

	const isSupportedModel = (ctx: ExtensionContext) =>
		SUPPORTED_MODELS.has(`${ctx.model?.provider}/${ctx.model?.id}`);

	const updateStatus = (ctx: ExtensionContext) => {
		// Keep Pi's built-in footer so context threshold colors and the auto-compaction
		// indicator continue to reflect the core session state.
		ctx.ui.setStatus(STATUS_ID, enabled && isSupportedModel(ctx) ? "fast" : undefined);
	};

	const refresh = (ctx: ExtensionContext) => {
		try {
			enabled = readEnabled();
		} catch (error) {
			enabled = false;
			ctx.ui.notify(`Could not read Fast mode settings: ${error}`, "error");
		}
		updateStatus(ctx);
	};

	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("model_select", (_event, ctx) => refresh(ctx));

	pi.registerCommand("fast", {
		description: "Toggle global OpenAI Codex Fast/Priority mode (usage: /fast [on|off|status])",
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
				ctx.ui.notify(`Priority mode is not configured for this model; supported: ${supportedModelsLabel}`, "warning");
				return;
			}

			refresh(ctx);
			let next = enabled;
			if (action === "on") next = true;
			else if (action === "off") next = false;
			else if (action === "status") {
				// Keep the current value.
			} else if (action === "") next = !enabled;
			else {
				ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
				return;
			}

			if (action !== "status") {
				try {
					saveEnabled(next);
				} catch (error) {
					ctx.ui.notify(`Could not save Fast mode settings: ${error}`, "error");
					return;
				}
				enabled = next;
			}
			updateStatus(ctx);
			const state = enabled ? "enabled" : "disabled";
			if (isSupportedModel(ctx)) {
				ctx.ui.notify(`Fast mode ${state}`, "info");
			} else {
				ctx.ui.notify(
					`Fast mode ${state}; it only applies to ${supportedModelsLabel}`,
					"warning",
				);
			}
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		refresh(ctx);
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
