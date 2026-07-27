export type ReasoningModePhase = "off" | "reasoning";
export type PermissionAction = "allow" | "ask" | "deny";
export type ShellPolicy = "strict" | "inspect";

export interface ReasoningModeState {
	version: 2;
	mode: ReasoningModePhase;
	activeSkill?: string;
	planReady?: boolean;
	toolsBeforeReasoning?: string[];
}

export interface ReasoningModeConfig {
	shellPolicy: ShellPolicy;
	unknownTools: PermissionAction;
	tools: Record<string, PermissionAction>;
}

export const DEFAULT_REASONING_SKILL = "explore";
export const PLAN_READY_MARKER = "<!-- reasoning-mode:plan-ready -->";

export const DEFAULT_CONFIG: ReasoningModeConfig = {
	shellPolicy: "inspect",
	unknownTools: "deny",
	tools: {},
};

export const INITIAL_STATE: ReasoningModeState = {
	version: 2,
	mode: "off",
};
