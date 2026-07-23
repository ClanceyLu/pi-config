import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type EvalArm = "baseline" | "treatment";
export type CandidateLabel = "A" | "B";
export type SkillSourceKind = "installed" | "local" | "github" | "direct_skill_url" | "web_document";
export type EvaluationStatus = "running" | "awaiting_judgment" | "completed" | "failed" | "cancelled";

export interface ModelRef {
	provider: string;
	id: string;
}

export interface SkillTarget {
	name: string;
	description: string;
	skillFile: string;
	baseDir: string;
	content: string;
	source?: {
		input: string;
		resolved: string;
		temporary: boolean;
		kind?: SkillSourceKind;
	};
}

export type DeterministicCheck =
	| { id: string; type: "response_regex"; pattern: string; flags?: string }
	| { id: string; type: "path_exists"; path: string; exists: boolean }
	| { id: string; type: "file_regex"; path: string; pattern: string; flags?: string }
	| { id: string; type: "command"; command: string; timeoutMs: number };

export interface EvaluationConfig {
	skill: SkillTarget;
	task: string;
	rubric: string;
	caseRationale?: string;
	userRequest: string;
	cwd: string;
	taskModel: ModelRef;
	thinkingLevel: ThinkingLevel;
	taskTimeoutMs: number;
	checks: DeterministicCheck[];
	activeTools: string[];
	approveProjectResources: boolean;
	commit?: string;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	toolCalls: number;
	turns: number;
}

export interface ToolTrace {
	toolCallId: string;
	toolName: string;
	args?: unknown;
	result?: unknown;
	isError?: boolean;
	startedAt?: number;
	endedAt?: number;
}

export interface ProcessError {
	kind: "spawn" | "timeout" | "aborted" | "protocol" | "agent" | "exit";
	message: string;
}

export interface RpcRunRequest {
	cwd: string;
	args: string[];
	prompt: string;
	probeOnly?: boolean;
	timeoutMs: number;
	expectedSkills?: string[];
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

export interface RpcRunResult {
	exitCode: number | null;
	finalText: string;
	messages: unknown[];
	events: unknown[];
	commands: Array<{ name: string; source?: string; path?: string }>;
	usage: UsageStats;
	toolTrace: ToolTrace[];
	model?: ModelRef;
	thinkingLevel?: string;
	durationMs: number;
	stderr: string;
	error?: ProcessError;
	structuredOutput?: unknown;
}

export interface WorkspaceFile {
	path: string;
	type: "file" | "symlink";
	size: number;
	hash: string;
	linkTarget?: string;
	textContent?: string;
}

export interface WorkspaceSnapshot {
	files: WorkspaceFile[];
	capturedAt: string;
}

export interface ArtifactDiff {
	summary: { added: string[]; modified: string[]; deleted: string[] };
	text: string;
	truncated: boolean;
}

export type WorkspaceKind = "git-worktree" | "directory-copy" | "empty-directory";

export interface WorkspaceHandle {
	kind: WorkspaceKind;
	root: string;
	cwd: string;
	sourceRoot: string;
	initialSnapshot: WorkspaceSnapshot;
	commit?: string;
	cleanup(): Promise<void>;
}

export interface CheckResult {
	id: string;
	type: DeterministicCheck["type"];
	passed: boolean;
	details: string;
	durationMs: number;
	stdout?: string;
	stderr?: string;
}

export interface ArmRunResult {
	arm: EvalArm;
	workspaceKind: WorkspaceKind;
	workspacePath: string;
	initialSnapshotHash: string;
	rpc: RpcRunResult;
	artifacts: ArtifactDiff;
	checks: CheckResult[];
	deterministicScore: number;
}

export interface PairRunResult {
	baseline: ArmRunResult;
	treatment: ArmRunResult;
}

export interface BlindMapping {
	A: EvalArm;
	B: EvalArm;
}

export interface SkillEvaluationJudgment {
	winner: EvalArm | "tie";
	scoreBaseline: number;
	scoreTreatment: number;
	confidence: number;
	rationale: string;
	criterionNotes: string[];
	submittedByModel?: ModelRef;
}

export interface EvaluationReport {
	version: 2;
	id: string;
	status: EvaluationStatus;
	startedAt: string;
	updatedAt: string;
	finishedAt?: string;
	config: Omit<EvaluationConfig, "skill"> & {
		skill: Omit<SkillTarget, "content"> & { contentSha256: string };
	};
	labelMap?: BlindMapping;
	arms?: PairRunResult;
	judgment?: SkillEvaluationJudgment;
	error?: string;
	warnings: string[];
}
