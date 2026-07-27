import { promises as fs } from "node:fs";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type PermissionAction, type PlanModeConfig, type ShellPolicy } from "./types.ts";

const ACTIONS: Record<PermissionAction, true> = { allow: true, ask: true, deny: true };
const SHELL_POLICIES: Record<ShellPolicy, true> = { strict: true, inspect: true };

export interface ConfigLoadResult {
	config: PlanModeConfig;
	warnings: string[];
}

interface ConfigLayer {
	config?: Partial<PlanModeConfig>;
	warnings: string[];
}

function warning(file: string, reason: string): string {
	return `Invalid plan-mode config ${file}: ${reason}`;
}

async function readConfig(file: string): Promise<ConfigLayer> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await fs.readFile(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { warnings: [] };
		return { warnings: [warning(file, error instanceof Error ? error.message : String(error))] };
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { warnings: [warning(file, "root must be an object")] };
	}

	const record = parsed as Record<string, unknown>;
	const config: Partial<PlanModeConfig> = {};
	const warnings: string[] = [];

	if (record.shellPolicy !== undefined) {
		if (typeof record.shellPolicy === "string" && SHELL_POLICIES[record.shellPolicy as ShellPolicy]) {
			config.shellPolicy = record.shellPolicy as ShellPolicy;
		} else {
			warnings.push(warning(file, 'shellPolicy must be "strict" or "inspect"'));
		}
	}

	if (record.unknownTools !== undefined) {
		if (typeof record.unknownTools === "string" && ACTIONS[record.unknownTools as PermissionAction]) {
			config.unknownTools = record.unknownTools as PermissionAction;
		} else {
			warnings.push(warning(file, 'unknownTools must be "allow", "ask", or "deny"'));
		}
	}

	if (record.tools !== undefined) {
		if (!record.tools || typeof record.tools !== "object" || Array.isArray(record.tools)) {
			warnings.push(warning(file, "tools must be an object"));
		} else {
			const tools: Record<string, PermissionAction> = {};
			for (const [name, action] of Object.entries(record.tools as Record<string, unknown>)) {
				if (name.length === 0) {
					warnings.push(warning(file, "tools contains an empty tool name"));
				} else if (typeof action !== "string" || !ACTIONS[action as PermissionAction]) {
					warnings.push(warning(file, `tools.${name} must be "allow", "ask", or "deny"`));
				} else {
					tools[name] = action as PermissionAction;
				}
			}
			config.tools = tools;
		}
	}

	return { config, warnings };
}

export async function loadConfig(ctx: ExtensionContext, agentDir = getAgentDir()): Promise<ConfigLoadResult> {
	const globalPath = path.join(agentDir, "plan-mode.json");
	const projectPath = path.join(ctx.cwd, CONFIG_DIR_NAME, "plan-mode.json");
	const globalLayer = await readConfig(globalPath);
	const projectLayer: ConfigLayer = ctx.isProjectTrusted() ? await readConfig(projectPath) : { warnings: [] };
	return {
		config: {
			shellPolicy: projectLayer.config?.shellPolicy ?? globalLayer.config?.shellPolicy ?? DEFAULT_CONFIG.shellPolicy,
			unknownTools: projectLayer.config?.unknownTools ?? globalLayer.config?.unknownTools ?? DEFAULT_CONFIG.unknownTools,
			tools: { ...DEFAULT_CONFIG.tools, ...globalLayer.config?.tools, ...projectLayer.config?.tools },
		},
		warnings: [...globalLayer.warnings, ...projectLayer.warnings],
	};
}
