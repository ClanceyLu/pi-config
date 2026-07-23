import assert from "node:assert/strict";
import test from "node:test";
import { renderBlindEvidence } from "./orchestration-prompts.ts";
import type { ArmRunResult } from "./types.ts";

function arm(kind: "baseline" | "treatment"): ArmRunResult {
	return {
		arm: kind, workspaceKind: "empty-directory", workspacePath: `/tmp/${kind}`, initialSnapshotHash: "hash",
		rpc: {
			exitCode: 0, finalText: "x".repeat(100_000), messages: [], events: [], commands: [], toolTrace: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, toolCalls: 0, turns: 0 },
			durationMs: 1, stderr: "",
		},
		artifacts: { summary: { added: [], modified: [], deleted: [] }, text: "y".repeat(100_000), truncated: true },
		checks: [{ id: "c", type: "response_regex", passed: true, details: "z".repeat(10_000), durationMs: 1 }],
		deterministicScore: 100,
	};
}

test("blinded evidence has one aggregate budget and exposes no arm paths", () => {
	const task: any = {
		request: { id: "job" }, mapping: { A: "treatment", B: "baseline" },
		result: { baseline: arm("baseline"), treatment: arm("treatment") },
		reportDirectory: "/secret/report",
		report: { config: { task: "t".repeat(20_000), rubric: "r".repeat(20_000) } },
	};
	const evidence = renderBlindEvidence(task);
	assert.ok(Buffer.byteLength(evidence) <= 50 * 1024);
	assert.doesNotMatch(evidence, /secret\/report|candidates\/|tmp\/baseline|tmp\/treatment/);
});
