import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
	ArmRunResult,
	CandidateLabel,
	EvaluationConfig,
	EvaluationReport,
	SkillEvaluationJudgment,
	WorkspaceHandle,
} from "./types.ts";
import { exportWorkspace } from "./workspace.ts";

function safeName(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "skill";
}

function timestampId(date: Date): string {
	return date.toISOString().replace(/[:.]/g, "-");
}

async function privateWrite(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const temporary = `${filePath}.${randomUUID()}.tmp`;
	await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
	await fs.rename(temporary, filePath);
	await fs.chmod(filePath, 0o600);
}

function fixed(value: number): string {
	return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function armSummary(name: string, arm: ArmRunResult): string[] {
	return [
		`### ${name}`,
		"",
		`- Deterministic score: ${fixed(arm.deterministicScore)}`,
		`- Child status: ${arm.rpc.error ? `failed (${arm.rpc.error.kind}: ${arm.rpc.error.message})` : "completed"}`,
		`- Tokens: ${arm.rpc.usage.totalTokens}`,
		`- Cost: $${fixed(arm.rpc.usage.cost)}`,
		`- Duration: ${fixed(arm.rpc.durationMs / 1000)}s`,
		`- Tool calls: ${arm.rpc.usage.toolCalls}`,
		"",
	];
}

function markdown(report: EvaluationReport): string {
	const lines = [
		`# Skill Evaluation: ${report.config.skill.name}`,
		"",
		`- Run: \`${report.id}\``,
		`- Status: **${report.status}**`,
		`- Skill source: \`${report.config.skill.source?.resolved ?? report.config.skill.skillFile}\``,
		`- Model: \`${report.config.taskModel.provider}/${report.config.taskModel.id}\``,
		`- Thinking: \`${report.config.thinkingLevel}\``,
		`- Commit: ${report.config.commit ? `\`${report.config.commit}\`` : "(non-Git snapshot)"}`,
		"",
		"## Test Case",
		"",
		"### Prompt",
		"",
		report.config.task,
		"",
		"### Rubric",
		"",
		report.config.rubric,
		"",
		"### Checks",
		"",
		...report.config.checks.map((check) => `- \`${check.type}\`: ${JSON.stringify(check)}`),
		"",
	];
	if (report.arms) {
		lines.push("## Runs", "", ...armSummary("Baseline", report.arms.baseline), ...armSummary("Treatment", report.arms.treatment));
	}
	if (report.judgment) {
		lines.push(
			"## Current-session Judgment", "",
			`- Winner: **${report.judgment.winner}**`,
			`- Baseline score: ${fixed(report.judgment.scoreBaseline)}`,
			`- Treatment score: ${fixed(report.judgment.scoreTreatment)}`,
			`- Delta: ${fixed(report.judgment.scoreTreatment - report.judgment.scoreBaseline)}`,
			`- Confidence: ${fixed(report.judgment.confidence)}`,
			"", report.judgment.rationale, "",
			...report.judgment.criterionNotes.map((note) => `- ${note}`), "",
		);
	}
	if (report.error) lines.push("## Error", "", report.error, "");
	if (report.warnings.length > 0) lines.push("## Warnings", "", ...report.warnings.map((warning) => `- ${warning}`), "");
	lines.push(
		"## Artifacts", "",
		"Candidate artifacts and complete final workspace copies are under `candidates/A/` and `candidates/B/`.",
		"After judgment, `result.json` records which candidate was baseline or treatment.",
		"", "## Security", "",
		"This directory may contain prompts, source files, command output, model responses, credentials copied from the workspace, or other sensitive data. Delete it manually when no longer needed.", "",
	);
	return lines.join("\n");
}

export async function persistReport(directory: string, report: EvaluationReport): Promise<void> {
	report.updatedAt = new Date().toISOString();
	await Promise.all([
		privateWrite(path.join(directory, "result.json"), JSON.stringify(report, null, 2)),
		privateWrite(path.join(directory, "report.md"), markdown(report)),
	]);
}

export async function createEvaluationReport(input: {
	agentDir: string;
	config: EvaluationConfig;
	startedAt: Date;
	warnings: string[];
}): Promise<{ directory: string; report: EvaluationReport }> {
	const id = `${timestampId(input.startedAt)}-${safeName(input.config.skill.name)}`;
	const directory = path.join(input.agentDir, "evaluations", id);
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	await fs.chmod(directory, 0o700);
	const now = new Date().toISOString();
	const report: EvaluationReport = {
		version: 2,
		id,
		status: "running",
		startedAt: input.startedAt.toISOString(),
		updatedAt: now,
		config: {
			...input.config,
			skill: {
				name: input.config.skill.name,
				description: input.config.skill.description,
				skillFile: input.config.skill.skillFile,
				baseDir: input.config.skill.baseDir,
				source: input.config.skill.source,
				contentSha256: createHash("sha256").update(input.config.skill.content).digest("hex"),
			},
		},
		warnings: input.warnings,
	};
	await persistReport(directory, report);
	return { directory, report };
}

function blindedRunRecord(result: ArmRunResult): Record<string, unknown> {
	return {
		workspaceKind: result.workspaceKind,
		initialSnapshotHash: result.initialSnapshotHash,
		rpc: {
			exitCode: result.rpc.exitCode,
			usage: result.rpc.usage,
			model: result.rpc.model,
			thinkingLevel: result.rpc.thinkingLevel,
			durationMs: result.rpc.durationMs,
			error: result.rpc.error,
		},
		artifacts: { summary: result.artifacts.summary, truncated: result.artifacts.truncated },
		checks: result.checks,
		deterministicScore: result.deterministicScore,
	};
}

export async function writeArmArtifacts(input: {
	directory: string;
	label: CandidateLabel;
	result: ArmRunResult;
	workspace: WorkspaceHandle;
}): Promise<void> {
	const armDir = path.join(input.directory, "candidates", input.label);
	await fs.mkdir(armDir, { recursive: true, mode: 0o700 });
	const writes = await Promise.allSettled([
		privateWrite(path.join(armDir, "events.jsonl"), input.result.rpc.events.map((event) => JSON.stringify(event)).join("\n")),
		privateWrite(path.join(armDir, "output.md"), input.result.rpc.finalText),
		privateWrite(path.join(armDir, "workspace.diff"), input.result.artifacts.text),
		privateWrite(path.join(armDir, "checks.json"), JSON.stringify(input.result.checks, null, 2)),
		privateWrite(path.join(armDir, "stderr.log"), input.result.rpc.stderr),
		privateWrite(path.join(armDir, "run.json"), JSON.stringify(blindedRunRecord(input.result), null, 2)),
		exportWorkspace(input.workspace.root, path.join(armDir, "workspace")),
	]);
	const failed = writes.find((item): item is PromiseRejectedResult => item.status === "rejected");
	if (failed) throw failed.reason;
}

export async function markAwaitingJudgment(input: {
	directory: string;
	report: EvaluationReport;
}): Promise<void> {
	// Keep the arm mapping and unblinded structured results in memory until judgment.
	input.report.status = "awaiting_judgment";
	await persistReport(input.directory, input.report);
}

export async function completeEvaluationReport(input: {
	directory: string;
	report: EvaluationReport;
	judgment: SkillEvaluationJudgment;
}): Promise<void> {
	input.report.judgment = input.judgment;
	input.report.status = "completed";
	input.report.finishedAt = new Date().toISOString();
	await persistReport(input.directory, input.report);
}

export async function finishEvaluationReport(input: {
	directory: string;
	report: EvaluationReport;
	status: "failed" | "cancelled";
	error: string;
}): Promise<void> {
	input.report.status = input.status;
	input.report.error = input.error;
	input.report.finishedAt = new Date().toISOString();
	await persistReport(input.directory, input.report);
}
