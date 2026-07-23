import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { buildTaskArgs, runEvaluationPair, validateEvaluationCase } from "./evaluator.ts";
import type { EvaluationConfig, RpcRunResult } from "./types.ts";
import { inspectWorkspace } from "./workspace.ts";

function rpc(finalText: string): RpcRunResult {
	return {
		exitCode: 0, finalText, messages: [], events: [], commands: [], toolTrace: [],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0, toolCalls: 0, turns: 1 },
		model: { provider: "test", id: "current" }, thinkingLevel: "high", durationMs: 50, stderr: "",
	};
}

function config(cwd: string): EvaluationConfig {
	return {
		skill: {
			name: "test-skill", description: "test", skillFile: path.join(cwd, "SKILL.md"), baseDir: cwd,
			content: "---\nname: test-skill\ndescription: test\n---\n",
		},
		task: "Create result.txt", rubric: "The result must be correct", userRequest: "evaluate test-skill",
		cwd, taskModel: { provider: "test", id: "current" }, thinkingLevel: "high", taskTimeoutMs: 5_000,
		checks: [{ id: "check-1", type: "path_exists", path: "result.txt", exists: true }],
		activeTools: ["read", "run_skill_evaluation"], approveProjectResources: false,
	};
}

test("A/B arms run concurrently on the captured model and orchestration tools are filtered", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "skill-eval-pair-test-"));
	let active = 0;
	let maximum = 0;
	const requests: any[] = [];
	try {
		await fs.writeFile(path.join(cwd, "SKILL.md"), config(cwd).skill.content);
		const pair = await runEvaluationPair(config(cwd), {}, async (request) => {
			requests.push(request);
			active++;
			maximum = Math.max(maximum, active);
			await new Promise((resolve) => setTimeout(resolve, 80));
			await fs.writeFile(path.join(request.cwd, "result.txt"), request.expectedSkills?.length ? "treatment" : "baseline");
			active--;
			return rpc(request.expectedSkills?.length ? "treatment output" : "baseline output");
		}, await inspectWorkspace(cwd));
		assert.equal(maximum, 2);
		assert.equal(pair.baseline.rpc.finalText, "baseline output");
		assert.equal(pair.treatment.rpc.finalText, "treatment output");
		assert.deepEqual(requests.map((item) => item.expectedSkills), [[], ["skill:test-skill"]]);
		for (const request of requests) {
			assert.ok(request.args.includes("test/test/current") === false);
			assert.ok(request.args.includes("test/current"));
			assert.ok(request.args.includes("--no-skills"));
			assert.equal(request.args.join(" ").includes("run_skill_evaluation"), false);
		}
		assert.equal(buildTaskArgs(config(cwd), "baseline").includes("--skill"), false);
		assert.equal(buildTaskArgs(config(cwd), "treatment").includes("--skill"), true);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("one parent abort signal reaches both concurrently running arms", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "skill-eval-abort-test-"));
	const controller = new AbortController();
	let started = 0;
	let aborted = 0;
	try {
		await fs.writeFile(path.join(cwd, "SKILL.md"), config(cwd).skill.content);
		const running = runEvaluationPair(config(cwd), { signal: controller.signal }, async (request) => {
			started++;
			await new Promise<void>((resolve) => {
				if (request.signal?.aborted) resolve();
				else request.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			aborted++;
			const result = rpc("");
			result.error = { kind: "aborted", message: "aborted by parent" };
			return result;
		}, await inspectWorkspace(cwd));
		while (started < 2) await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort(new Error("native turn abort"));
		const pair = await running;
		assert.equal(aborted, 2);
		assert.equal(pair.baseline.rpc.error?.kind, "aborted");
		assert.equal(pair.treatment.rpc.error?.kind, "aborted");
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("an arm RPC failure is retained as evidence instead of losing the other arm", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "skill-eval-arm-failure-test-"));
	try {
		await fs.writeFile(path.join(cwd, "SKILL.md"), config(cwd).skill.content);
		let persisted = false;
		const pair = await runEvaluationPair(config(cwd), {
			onWorkspacesReady: async () => { persisted = true; },
		}, async (request) => {
			const result = rpc(request.expectedSkills?.length ? "" : "baseline survived");
			if (request.expectedSkills?.length) result.error = { kind: "agent", message: "treatment failed" };
			return result;
		}, await inspectWorkspace(cwd));
		assert.equal(pair.baseline.rpc.error, undefined);
		assert.equal(pair.treatment.rpc.error?.message, "treatment failed");
		assert.equal(persisted, true);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("evaluation case validation normalizes checks and rejects unsafe commands", () => {
	const value = validateEvaluationCase({
		task: "task", rubric: "rubric", checks: [
			{ type: "response_regex", pattern: "(?i)done" },
			{ type: "command", command: "test -f result.txt", timeoutSeconds: 3 },
		],
	});
	assert.equal(value.checks[0].type, "response_regex");
	assert.equal((value.checks[0] as any).flags, "i");
	assert.equal((value.checks[1] as any).timeoutMs, 3000);
	assert.throws(() => validateEvaluationCase({ task: "x", rubric: "y", checks: [{ type: "command", command: "curl https://example.com" }] }), /network/);
});
