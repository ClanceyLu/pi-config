import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { completeEvaluationReport, createEvaluationReport, finishEvaluationReport, markAwaitingJudgment, writeArmArtifacts } from "./report.ts";
import type { ArmRunResult, EvaluationConfig } from "./types.ts";
import { createWorkspace, inspectWorkspace } from "./workspace.ts";

function arm(kind: "baseline" | "treatment", workspacePath: string): ArmRunResult {
	return {
		arm: kind, workspaceKind: "empty-directory", workspacePath, initialSnapshotHash: "hash",
		rpc: {
			exitCode: 0, finalText: `${kind} output`, messages: [], events: [{ type: "done" }], commands: [], toolTrace: [],
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0, toolCalls: 0, turns: 1 },
			durationMs: 10, stderr: "",
		},
		artifacts: { summary: { added: ["artifact.txt"], modified: [], deleted: [] }, text: "+ artifact", truncated: false },
		checks: [{ id: "check-1", type: "path_exists", passed: true, details: "present", durationMs: 1 }],
		deterministicScore: 100,
	};
}

test("failed reports remain readable for recovery", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-eval-report-failure-"));
	const source = path.join(root, "source");
	await fs.mkdir(source);
	const config: EvaluationConfig = {
		skill: { name: "failed-skill", description: "test", skillFile: path.join(source, "SKILL.md"), baseDir: source, content: "skill" },
		task: "prompt", rubric: "rubric", userRequest: "request", cwd: source,
		taskModel: { provider: "test", id: "current" }, thinkingLevel: "high", taskTimeoutMs: 1000,
		checks: [{ id: "check-1", type: "path_exists", path: "x", exists: true }], activeTools: [], approveProjectResources: false,
	};
	try {
		const created = await createEvaluationReport({ agentDir: root, config, startedAt: new Date(), warnings: [] });
		await finishEvaluationReport({ directory: created.directory, report: created.report, status: "failed", error: "simulated failure" });
		const persisted = JSON.parse(await fs.readFile(path.join(created.directory, "result.json"), "utf8"));
		assert.equal(persisted.status, "failed");
		assert.equal(persisted.error, "simulated failure");
		assert.match(await fs.readFile(path.join(created.directory, "report.md"), "utf8"), /simulated failure/);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("version 2 report persists staged state and complete candidate workspaces", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-eval-report-test-"));
	const source = path.join(root, "source");
	await fs.mkdir(source);
	const config: EvaluationConfig = {
		skill: { name: "test-skill", description: "test", skillFile: path.join(source, "SKILL.md"), baseDir: source, content: "skill" },
		task: "test prompt", rubric: "rubric", userRequest: "request", cwd: source,
		taskModel: { provider: "test", id: "current" }, thinkingLevel: "high", taskTimeoutMs: 1000,
		checks: [{ id: "check-1", type: "path_exists", path: "artifact.txt", exists: true }], activeTools: [], approveProjectResources: false,
	};
	const baselineWorkspace = await createWorkspace(await inspectWorkspace(source), "report-baseline");
	const treatmentWorkspace = await createWorkspace(await inspectWorkspace(source), "report-treatment");
	try {
		await fs.writeFile(path.join(baselineWorkspace.root, "artifact.txt"), "baseline");
		await fs.writeFile(path.join(treatmentWorkspace.root, "artifact.txt"), "treatment");
		const baseline = arm("baseline", baselineWorkspace.root);
		const treatment = arm("treatment", treatmentWorkspace.root);
		const created = await createEvaluationReport({ agentDir: root, config, startedAt: new Date("2026-01-01T00:00:00Z"), warnings: [] });
		await Promise.all([
			writeArmArtifacts({ directory: created.directory, label: "B", result: baseline, workspace: baselineWorkspace }),
			writeArmArtifacts({ directory: created.directory, label: "A", result: treatment, workspace: treatmentWorkspace }),
		]);
		await markAwaitingJudgment({ directory: created.directory, report: created.report });
		let persisted = JSON.parse(await fs.readFile(path.join(created.directory, "result.json"), "utf8"));
		assert.equal(persisted.version, 2);
		assert.equal(persisted.status, "awaiting_judgment");
		assert.equal(persisted.labelMap, undefined);
		created.report.arms = { baseline, treatment };
		created.report.labelMap = { A: "treatment", B: "baseline" };
		assert.equal(await fs.readFile(path.join(created.directory, "candidates", "A", "workspace", "artifact.txt"), "utf8"), "treatment");
		const blindedRun = JSON.parse(await fs.readFile(path.join(created.directory, "candidates", "A", "run.json"), "utf8"));
		assert.equal(blindedRun.arm, undefined);
		assert.equal(blindedRun.workspacePath, undefined);
		assert.equal(blindedRun.rpc.commands, undefined);
		await completeEvaluationReport({
			directory: created.directory, report: created.report,
			judgment: { winner: "treatment", scoreBaseline: 50, scoreTreatment: 90, confidence: 0.8, rationale: "better", criterionNotes: ["passed"] },
		});
		persisted = JSON.parse(await fs.readFile(path.join(created.directory, "result.json"), "utf8"));
		assert.equal(persisted.status, "completed");
		assert.equal(persisted.judgment.winner, "treatment");
	} finally {
		await baselineWorkspace.cleanup();
		await treatmentWorkspace.cleanup();
		await fs.rm(root, { recursive: true, force: true });
	}
});
