import * as path from "node:path";
import type {
	ArmRunResult,
	DeterministicCheck,
	EvalArm,
	EvaluationConfig,
	PairRunResult,
	RpcRunRequest,
	RpcRunResult,
	WorkspaceHandle,
} from "./types.ts";
import { deterministicScore, normalizeRegexSpec, runChecks } from "./checks.ts";
import { runPiRpc } from "./subagent-runner.ts";
import { createWorkspace, diffSnapshots, inspectWorkspace, snapshotHash, snapshotWorkspace, type WorkspaceInspection } from "./workspace.ts";

const ORCHESTRATION_TOOLS = new Set([
	"prepare_skill_evaluation",
	"run_skill_evaluation",
	"submit_skill_evaluation_judgment",
]);

export interface EvaluationHooks {
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	onWarning?: (message: string) => void;
	onWorkspacesReady?: (input: {
		baselineWorkspace: WorkspaceHandle;
		treatmentWorkspace: WorkspaceHandle;
		result: PairRunResult;
	}) => Promise<void>;
}

export type RpcRunner = (request: RpcRunRequest) => Promise<RpcRunResult>;

function modelArgs(config: EvaluationConfig): string[] {
	return ["--provider", config.taskModel.provider, "--model", `${config.taskModel.provider}/${config.taskModel.id}`, "--thinking", config.thinkingLevel];
}

export function buildTaskArgs(config: EvaluationConfig, arm: EvalArm): string[] {
	const args = [
		...modelArgs(config),
		config.approveProjectResources ? "--approve" : "--no-approve",
		"--no-skills",
	];
	const tools = config.activeTools.filter((name) => !ORCHESTRATION_TOOLS.has(name));
	if (tools.length > 0) args.push("--tools", tools.join(","));
	else args.push("--no-tools");
	if (arm === "treatment") args.push("--skill", config.skill.skillFile);
	return args;
}

function validateGeneratedCommand(command: string): void {
	if (/\b(?:sudo|curl|wget|ssh|scp|nc|telnet)\b/i.test(command)) throw new Error("Generated check contains a privileged or network command.");
	if (/\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b/i.test(command)) throw new Error("Generated check contains recursive forced deletion.");
	if (/\bgit\s+push\b|\bnpm\s+publish\b|\b(?:pip|npm|pnpm|yarn)\s+install\b/i.test(command)) {
		throw new Error("Generated check contains publication or dependency installation.");
	}
}

function validateGeneratedPath(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("Generated check path is missing.");
	const normalized = path.normalize(value.trim());
	if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
		throw new Error(`Generated check path escapes the workspace: ${value}`);
	}
	return normalized;
}

export interface EvaluationCaseInput {
	task: string;
	rubric: string;
	rationale?: string;
	checks: Array<{
		type: DeterministicCheck["type"];
		pattern?: string;
		flags?: string;
		path?: string;
		exists?: boolean;
		command?: string;
		timeoutSeconds?: number;
	}>;
}

export function validateEvaluationCase(value: EvaluationCaseInput): {
	task: string;
	rubric: string;
	rationale?: string;
	checks: DeterministicCheck[];
} {
	if (typeof value.task !== "string" || !value.task.trim()) throw new Error("Test-case prompt is empty.");
	if (typeof value.rubric !== "string" || !value.rubric.trim()) throw new Error("Rubric is empty.");
	if (!Array.isArray(value.checks) || value.checks.length < 1 || value.checks.length > 6) {
		throw new Error("Evaluation case must contain 1-6 deterministic checks.");
	}
	const checks = value.checks.map((raw, index): DeterministicCheck => {
		const id = `check-${index + 1}`;
		if (raw.type === "response_regex") {
			if (typeof raw.pattern !== "string" || !raw.pattern) throw new Error("Response regex is missing.");
			const normalized = normalizeRegexSpec(raw.pattern, raw.flags);
			return { id, type: "response_regex", pattern: normalized.pattern, flags: normalized.flags || undefined };
		}
		if (raw.type === "path_exists") {
			return { id, type: "path_exists", path: validateGeneratedPath(raw.path), exists: raw.exists !== false };
		}
		if (raw.type === "file_regex") {
			if (typeof raw.pattern !== "string" || !raw.pattern) throw new Error("File regex is missing.");
			const normalized = normalizeRegexSpec(raw.pattern, raw.flags);
			return {
				id, type: "file_regex", path: validateGeneratedPath(raw.path), pattern: normalized.pattern,
				flags: normalized.flags || undefined,
			};
		}
		if (raw.type === "command") {
			if (typeof raw.command !== "string" || !raw.command.trim()) throw new Error("Command check is missing.");
			validateGeneratedCommand(raw.command);
			return {
				id, type: "command", command: raw.command.trim(),
				timeoutMs: Math.min(600, Math.max(1, raw.timeoutSeconds ?? 120)) * 1000,
			};
		}
		throw new Error(`Unsupported check type: ${raw.type}`);
	});
	return {
		task: value.task.trim(), rubric: value.rubric.trim(),
		rationale: value.rationale?.trim() || undefined, checks,
	};
}

async function executeArm(
	config: EvaluationConfig,
	workspace: WorkspaceHandle,
	arm: EvalArm,
	hooks: EvaluationHooks,
	runner: RpcRunner,
): Promise<ArmRunResult> {
	const prompt = arm === "treatment" ? `/skill:${config.skill.name} ${config.task}` : config.task;
	hooks.onProgress?.(`${arm}: running`);
	const rpc = await runner({
		cwd: workspace.cwd,
		args: buildTaskArgs(config, arm),
		prompt,
		timeoutMs: config.taskTimeoutMs,
		expectedSkills: arm === "treatment" ? [`skill:${config.skill.name}`] : [],
		signal: hooks.signal,
		onProgress: (message) => hooks.onProgress?.(`${arm}: ${message}`),
	});
	hooks.onProgress?.(`${arm}: collecting output and checks`);
	const finalSnapshot = await snapshotWorkspace(workspace.root);
	const artifacts = diffSnapshots(workspace.initialSnapshot, finalSnapshot);
	const checks = await runChecks(config.checks, workspace.cwd, rpc.finalText, hooks.signal);
	return {
		arm,
		workspaceKind: workspace.kind,
		workspacePath: workspace.root,
		initialSnapshotHash: snapshotHash(workspace.initialSnapshot),
		rpc,
		artifacts,
		checks,
		deterministicScore: deterministicScore(checks),
	};
}

export async function runEvaluationPair(
	config: EvaluationConfig,
	hooks: EvaluationHooks = {},
	runner: RpcRunner = runPiRpc,
	inspection?: WorkspaceInspection,
): Promise<PairRunResult> {
	const source = inspection ?? await inspectWorkspace(config.cwd);
	hooks.onProgress?.("creating isolated A/B workspaces");
	const baselineWorkspace = await createWorkspace(source, "baseline");
	let treatmentWorkspace: WorkspaceHandle | undefined;
	let primaryFailure: unknown;
	try {
		treatmentWorkspace = await createWorkspace(source, "treatment");
		if (snapshotHash(baselineWorkspace.initialSnapshot) !== snapshotHash(treatmentWorkspace.initialSnapshot)) {
			throw new Error("A/B workspaces do not have identical initial snapshots.");
		}
		hooks.onProgress?.("baseline and treatment running in parallel");
		const [baselineSettled, treatmentSettled] = await Promise.allSettled([
			executeArm(config, baselineWorkspace, "baseline", hooks, runner),
			executeArm(config, treatmentWorkspace, "treatment", hooks, runner),
		]);
		if (baselineSettled.status === "rejected") throw baselineSettled.reason;
		if (treatmentSettled.status === "rejected") throw treatmentSettled.reason;
		const result = { baseline: baselineSettled.value, treatment: treatmentSettled.value };
		await hooks.onWorkspacesReady?.({ baselineWorkspace, treatmentWorkspace, result });
		return result;
	} catch (error) {
		primaryFailure = error;
		throw error;
	} finally {
		hooks.onProgress?.("cleaning temporary A/B workspaces");
		const cleanup = await Promise.allSettled([
			baselineWorkspace.cleanup(),
			...(treatmentWorkspace ? [treatmentWorkspace.cleanup()] : []),
		]);
		const failures = cleanup.filter((item): item is PromiseRejectedResult => item.status === "rejected");
		for (const failure of failures) hooks.onWarning?.(`Failed to clean evaluation workspace: ${String(failure.reason)}`);
		if (failures.length > 0) {
			throw new AggregateError(
				[...(primaryFailure === undefined ? [] : [primaryFailure]), ...failures.map((item) => item.reason)],
				"Evaluation workspace cleanup failed.",
			);
		}
	}
}
