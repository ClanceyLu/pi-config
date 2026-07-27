export type PlanPhase = "off" | "planning" | "awaiting_approval" | "executing" | "completed";
export type StepStatus = "pending" | "in_progress" | "completed" | "blocked" | "skipped";
export type PermissionAction = "allow" | "ask" | "deny";
export type ShellPolicy = "strict" | "inspect";
export type ExecutionPolicy = "restore" | "confirm_mutations";

export interface PlanStep {
	id: string;
	title: string;
	description: string;
	paths: string[];
	verification?: string;
	status: StepStatus;
	note?: string;
}

export interface PlanDocument {
	id: string;
	revision: number;
	title: string;
	summary: string;
	implementation: string[];
	publicInterfaces: string[];
	steps: PlanStep[];
	tests: string[];
	assumptions: string[];
	outOfScope: string[];
	createdAt: string;
	updatedAt: string;
}

export interface PlanModeState {
	version: 1;
	phase: PlanPhase;
	plan?: PlanDocument;
	toolsBeforePlan?: string[];
	executionPolicy: ExecutionPolicy;
}

export interface PlanModeConfig {
	shellPolicy: ShellPolicy;
	unknownTools: PermissionAction;
	tools: Record<string, PermissionAction>;
}

export const DEFAULT_CONFIG: PlanModeConfig = {
	shellPolicy: "inspect",
	unknownTools: "deny",
	tools: {},
};

export const INITIAL_STATE: PlanModeState = {
	version: 1,
	phase: "off",
	executionPolicy: "restore",
};

export function isReadOnlyPhase(phase: PlanPhase): boolean {
	return phase === "planning" || phase === "awaiting_approval";
}
