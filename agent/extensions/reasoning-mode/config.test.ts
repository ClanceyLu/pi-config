import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

const codingAgentStub = `data:text/javascript,${encodeURIComponent(`
	export const CONFIG_DIR_NAME = ".pi";
	export function getAgentDir() { return "/nonexistent-reasoning-agent"; }
`)}`;
registerHooks({ resolve(specifier, context, nextResolve) {
	if (specifier === "@earendil-works/pi-coding-agent") return { url: codingAgentStub, shortCircuit: true };
	return nextResolve(specifier, context);
} });
const { loadConfig } = await import("./config.ts");

async function fixture(t: TestContext, trusted = true) {
	const root = await fs.mkdtemp(path.join(tmpdir(), "reasoning-config-"));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
	return {
		agentDir, cwd, ctx: { cwd, isProjectTrusted: () => trusted },
		legacyGlobal: path.join(agentDir, "plan-mode.json"),
		global: path.join(agentDir, "reasoning-mode.json"),
		legacyProject: path.join(cwd, ".pi", "plan-mode.json"),
		project: path.join(cwd, ".pi", "reasoning-mode.json"),
	};
}

test("legacy and new layers merge in documented precedence order", async (t) => {
	const f = await fixture(t);
	await fs.writeFile(f.legacyGlobal, JSON.stringify({ shellPolicy: "strict", unknownTools: "ask", tools: { shared: "deny", a: "allow" } }));
	await fs.writeFile(f.global, JSON.stringify({ shellPolicy: "inspect", tools: { shared: "ask", b: "allow" } }));
	await fs.writeFile(f.legacyProject, JSON.stringify({ unknownTools: "deny", tools: { shared: "deny", c: "allow" } }));
	await fs.writeFile(f.project, JSON.stringify({ tools: { shared: "allow", d: "ask" } }));
	const result = await loadConfig(f.ctx as never, f.agentDir);
	assert.deepEqual(result.config, {
		shellPolicy: "inspect", unknownTools: "deny",
		tools: { shared: "allow", a: "allow", b: "allow", c: "allow", d: "ask" },
	});
	assert.equal(result.warnings.filter((item: string) => item.includes("is deprecated")).length, 2);
});

test("untrusted project layers are ignored", async (t) => {
	const f = await fixture(t, false);
	await fs.writeFile(f.global, JSON.stringify({ shellPolicy: "strict" }));
	await fs.writeFile(f.project, "{ bad");
	const result = await loadConfig(f.ctx as never, f.agentDir);
	assert.deepEqual(result.config, { shellPolicy: "strict", unknownTools: "deny", tools: {} });
	assert.deepEqual(result.warnings, []);
});

test("invalid sibling fields warn without discarding valid fields", async (t) => {
	const f = await fixture(t);
	await fs.writeFile(f.global, JSON.stringify({ shellPolicy: "strict", unknownTools: "sometimes", tools: { valid: "ask", invalid: "sometimes" } }));
	const result = await loadConfig(f.ctx as never, f.agentDir);
	assert.deepEqual(result.config, { shellPolicy: "strict", unknownTools: "deny", tools: { valid: "ask" } });
	assert.equal(result.warnings.length, 2);
	assert.match(result.warnings[0], /unknownTools/);
	assert.match(result.warnings[1], /tools\.invalid/);
});
