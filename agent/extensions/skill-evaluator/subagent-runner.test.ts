import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { JsonlDecoder, runPiRpc } from "./subagent-runner.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-rpc.mjs", import.meta.url));

function fakeSpawn(env: NodeJS.ProcessEnv = {}): typeof spawn {
	return ((..._args: unknown[]) => spawn(process.execPath, [fixture], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...env },
	})) as any;
}

test("JsonlDecoder splits only LF and preserves Unicode separators", () => {
	const decoder = new JsonlDecoder();
	assert.deepEqual(decoder.push(Buffer.from('{"x":"a\u2028b"}\r\n{"y":')), ['{"x":"a b"}']);
	assert.deepEqual(decoder.push(Buffer.from("1}\n")), ['{"y":1}']);
	assert.deepEqual(decoder.end(), []);
});

test("runPiRpc collects events, usage, commands, and tools from a fake child", async () => {
	const result = await runPiRpc(
		{
			cwd: process.cwd(),
			args: [],
			prompt: "hello",
			timeoutMs: 5_000,
			expectedSkills: [],
		},
		{ spawnImpl: fakeSpawn() },
	);
	assert.equal(result.error, undefined);
	assert.equal(result.finalText, "fake answer");
	assert.equal(result.usage.totalTokens, 18);
	assert.equal(result.usage.toolCalls, 1);
	assert.equal(result.toolTrace.length, 1);
	assert.deepEqual(result.model, { provider: "fake", id: "model" });
});

test("runPiRpc reports malformed JSONL", async () => {
	const result = await runPiRpc(
		{
			cwd: process.cwd(),
			args: [],
			prompt: "hello",
			timeoutMs: 5_000,
			expectedSkills: [],
		},
		{ spawnImpl: fakeSpawn({ FAKE_RPC_INVALID: "1" }) },
	);
	assert.equal(result.error?.kind, "protocol");
});

test("runPiRpc treats assistant error and aborted stop reasons as failures", async () => {
	for (const stopReason of ["error", "aborted"] as const) {
		const result = await runPiRpc(
			{ cwd: process.cwd(), args: [], prompt: "hello", timeoutMs: 5_000, expectedSkills: [] },
			{ spawnImpl: fakeSpawn({ FAKE_RPC_STOP_REASON: stopReason }) },
		);
		assert.equal(result.error?.kind, stopReason === "aborted" ? "aborted" : "agent");
		assert.match(result.error?.message ?? "", new RegExp(stopReason));
	}
});

test("runPiRpc fails promptly when a clean child close leaves an RPC request pending", async () => {
	const started = Date.now();
	const result = await runPiRpc(
		{ cwd: process.cwd(), args: [], prompt: "hello", timeoutMs: 5_000, expectedSkills: [] },
		{ spawnImpl: fakeSpawn({ FAKE_RPC_CLOSE_PENDING: "1" }) },
	);
	assert.equal(result.error?.kind, "agent");
	assert.ok(Date.now() - started < 2_000);
});

test("runPiRpc discards incremental updates and bounds retained events", async () => {
	const result = await runPiRpc(
		{ cwd: process.cwd(), args: [], prompt: "hello", timeoutMs: 10_000, expectedSkills: [] },
		{ spawnImpl: fakeSpawn({ FAKE_RPC_UPDATES: "6000" }) },
	);
	assert.equal(result.error, undefined);
	assert.ok(result.events.length < 100);
	assert.equal((result.events.at(-1) as any)?.type, "skill_eval_events_truncated");
});
