import { promises as fs } from "node:fs";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type PermissionAction, type ReasoningModeConfig, type ShellPolicy } from "./types.ts";

const ACTIONS: Record<PermissionAction, true> = { allow: true, ask: true, deny: true };
const SHELL_POLICIES: Record<ShellPolicy, true> = { strict: true, inspect: true };

interface ConfigLayer {
	config?: Partial<ReasoningModeConfig>;
	warnings: string[];
	exists: boolean;
}
export interface ConfigLoadResult {
	config: ReasoningModeConfig;
	warnings: string[];
}

function warning(file: string, reason: string): string {
	return `Invalid reasoning-mode config ${file}: ${reason}`;
}

async function readConfig(file: string): Promise<ConfigLayer> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await fs.readFile(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { warnings: [], exists: false };
		return { warnings: [warning(file, error instanceof Error ? error.message : String(error))], exists: true };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { warnings: [warning(file, "root must be an object")], exists: true };
	}
	const record = parsed as Record<string, unknown>;
	const config: Partial<ReasoningModeConfig> = {};
	const warnings: string[] = [];
	if (record.shellPolicy !== undefined) {
		if (typeof record.shellPolicy === "string" && SHELL_POLICIES[record.shellPolicy as ShellPolicy]) {
			config.shellPolicy = record.shellPolicy as ShellPolicy;
		} else warnings.push(warning(file, 'shellPolicy must be "strict" or "inspect"'));
	}
	if (record.unknownTools !== undefined) {
		if (typeof record.unknownTools === "string" && ACTIONS[record.unknownTools as PermissionAction]) {
			config.unknownTools = record.unknownTools as PermissionAction;
		} else warnings.push(warning(file, 'unknownTools must be "allow", "ask", or "deny"'));
	}
	if (record.tools !== undefined) {
		if (!record.tools || typeof record.tools !== "object" || Array.isArray(record.tools)) {
			warnings.push(warning(file, "tools must be an object"));
		} else {
			const tools: Record<string, PermissionAction> = {};
			for (const [name, action] of Object.entries(record.tools as Record<string, unknown>)) {
				if (!name) warnings.push(warning(file, "tools contains an empty tool name"));
				else if (typeof action !== "string" || !ACTIONS[action as PermissionAction]) {
					warnings.push(warning(file, `tools.${name} must be "allow", "ask", or "deny"`));
				} else tools[name] = action as PermissionAction;
			}
			config.tools = tools;
		}
	}
	return { config, warnings, exists: true };
}

function mergeLayers(layers: ConfigLayer[]): ReasoningModeConfig {
	let shellPolicy = DEFAULT_CONFIG.shellPolicy;
	let unknownTools = DEFAULT_CONFIG.unknownTools;
	let tools: Record<string, PermissionAction> = { ...DEFAULT_CONFIG.tools };
	for (const layer of layers) {
		if (layer.config?.shellPolicy) shellPolicy = layer.config.shellPolicy;
		if (layer.config?.unknownTools) unknownTools = layer.config.unknownTools;
		if (layer.config?.tools) tools = { ...tools, ...layer.config.tools };
	}
	return { shellPolicy, unknownTools, tools };
}

export async function loadConfig(ctx: ExtensionContext, agentDir = getAgentDir()): Promise<ConfigLoadResult> {
	const legacyGlobalPath = path.join(agentDir, "plan-mode.json");
	const globalPath = path.join(agentDir, "reasoning-mode.json");
	const legacyProjectPath = path.join(ctx.cwd, CONFIG_DIR_NAME, "plan-mode.json");
	const projectPath = path.join(ctx.cwd, CONFIG_DIR_NAME, "reasoning-mode.json");
	const legacyGlobal = await readConfig(legacyGlobalPath);
	const global = await readConfig(globalPath);
	const legacyProject = ctx.isProjectTrusted() ? await readConfig(legacyProjectPath) : { warnings: [], exists: false };
	const project = ctx.isProjectTrusted() ? await readConfig(projectPath) : { warnings: [], exists: false };
	const deprecations: string[] = [];
	if (legacyGlobal.exists) deprecations.push(`${legacyGlobalPath} is deprecated; migrate to ${globalPath}`);
	if (legacyProject.exists) deprecations.push(`${legacyProjectPath} is deprecated; migrate to ${projectPath}`);
	const layers = [legacyGlobal, global, legacyProject, project];
	return {
		config: mergeLayers(layers),
		warnings: [...layers.flatMap((layer) => layer.warnings), ...deprecations],
	};
}
