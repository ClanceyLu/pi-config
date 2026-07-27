import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";
import type { TestContext } from "node:test";

const codingAgentStub = `data:text/javascript,${encodeURIComponent(`
	export const CONFIG_DIR_NAME = ".pi";
	export function getAgentDir() { return "/nonexistent-plan-mode-agent"; }
`)}`;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-coding-agent") return { url: codingAgentStub, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});

// The hook must be installed before loading config.ts so its Pi runtime import resolves to this isolated test stub.
const { loadConfig } = await import("./config.ts");

async function fixture(t: TestContext, trusted = true) {
	const root = await fs.mkdtemp(path.join(tmpdir(), "plan-mode-config-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
	return {
		agentDir,
		cwd,
		ctx: { cwd, isProjectTrusted: () => trusted },
		globalPath: path.join(agentDir, "plan-mode.json"),
		projectPath: path.join(cwd, ".pi", "plan-mode.json"),
	};
}

test("valid global and trusted project config merge by field and tool name", async (t) => {
	const f = await fixture(t);
	await fs.writeFile(
		f.globalPath,
		JSON.stringify({ shellPolicy: "strict", unknownTools: "ask", tools: { global: "allow", shared: "deny" } }),
	);
	await fs.writeFile(
		f.projectPath,
		JSON.stringify({ shellPolicy: "inspect", tools: { project: "ask", shared: "allow" }, futureField: true }),
	);

	const result = await loadConfig(f.ctx as never, f.agentDir);
	assert.deepEqual(result, {
		config: {
			shellPolicy: "inspect",
			unknownTools: "ask",
			tools: { global: "allow", shared: "allow", project: "ask" },
		},
		warnings: [],
	});
});

test("untrusted project config is ignored without warnings", async (t) => {
	const f = await fixture(t, false);
	await fs.writeFile(f.globalPath, JSON.stringify({ shellPolicy: "strict", tools: { global: "allow" } }));
	await fs.writeFile(f.projectPath, "{ invalid project json");

	const result = await loadConfig(f.ctx as never, f.agentDir);
	assert.deepEqual(result.config, { shellPolicy: "strict", unknownTools: "deny", tools: { global: "allow" } });
	assert.deepEqual(result.warnings, []);
});

test("an invalid layer warns while the other valid layer still applies", async (t) => {
	const f = await fixture(t);
	await fs.writeFile(f.globalPath, "{ invalid global json");
	await fs.writeFile(f.projectPath, JSON.stringify({ unknownTools: "ask", tools: { project: "allow" } }));

	const result = await loadConfig(f.ctx as never, f.agentDir);
	assert.deepEqual(result.config, { shellPolicy: "inspect", unknownTools: "ask", tools: { project: "allow" } });
	assert.equal(result.warnings.length, 1);
	assert.ok(result.warnings[0]!.startsWith(`Invalid plan-mode config ${f.globalPath}: `));
});

test("valid fields in a parsable layer survive invalid sibling fields", async (t) => {
	const f = await fixture(t);
	await fs.writeFile(
		f.globalPath,
		JSON.stringify({
			shellPolicy: "strict",
			unknownTools: "sometimes",
			tools: { "": "allow", valid: "ask", invalid: "sometimes" },
		}),
	);

	const result = await loadConfig(f.ctx as never, f.agentDir);
	assert.deepEqual(result.config, { shellPolicy: "strict", unknownTools: "deny", tools: { valid: "ask" } });
	assert.deepEqual(result.warnings, [
		`Invalid plan-mode config ${f.globalPath}: unknownTools must be "allow", "ask", or "deny"`,
		`Invalid plan-mode config ${f.globalPath}: tools contains an empty tool name`,
		`Invalid plan-mode config ${f.globalPath}: tools.invalid must be "allow", "ask", or "deny"`,
	]);
});

test("root and tools shape errors use stable reasons", async (t) => {
	const f = await fixture(t);
	await fs.writeFile(f.globalPath, "[]");
	await fs.writeFile(f.projectPath, JSON.stringify({ shellPolicy: "inspect", tools: [] }));

	const result = await loadConfig(f.ctx as never, f.agentDir);
	assert.deepEqual(result.config, { shellPolicy: "inspect", unknownTools: "deny", tools: {} });
	assert.deepEqual(result.warnings, [
		`Invalid plan-mode config ${f.globalPath}: root must be an object`,
		`Invalid plan-mode config ${f.projectPath}: tools must be an object`,
	]);
});
