import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs, selectModel, resolveApiKey } from "./search.mjs";

test("uses the verified Codex search model while preserving explicit overrides and Anthropic defaults", () => {
	for (const defaultModel of ["auto", "gpt-5.3-codex"]) {
		assert.deepEqual(selectModel({}, { defaultProvider: "openai-codex", defaultModel }), { provider: "openai-codex", model: "codex-auto-review" });
	}
	assert.deepEqual(selectModel({ provider: "openai-codex", model: "explicit" }, {}), { provider: "openai-codex", model: "explicit" });
	assert.deepEqual(selectModel({}, { defaultProvider: "anthropic", defaultModel: "saved" }), { provider: "anthropic", model: "saved" });
	assert.throws(() => selectModel({}, {}), /Choose --provider/);
	assert.throws(() => selectModel({ provider: "anthropic" }, { defaultProvider: "openai-codex", defaultModel: "gpt-6-astra" }), /Pass --model/);
	assert.throws(() => selectModel({ provider: "openai" }, {}), /Choose --provider/);
	assert.deepEqual(selectModel({ provider: "anthropic", model: "explicit" }, {}), { provider: "anthropic", model: "explicit" });
});

test("parses arguments and rejects invalid options", () => {
	const args = parseArgs(["query", "--model=model", "--purpose", "research", "--json", "--timeout=2000"]);
	assert.equal(args.model, "model");
	assert.equal(args.timeoutMs, 2000);
	assert.equal(args.json, true);
	for (const invalid of [["--timeout=NaN"], ["--timeout=0"], ["--model"], ["--unknown"]]) assert.throws(() => parseArgs(invalid));
});

test("delegates auth to Pi and keeps credential output private on failure", () => {
	const key = resolveApiKey("openai-codex", "model", 1000, (_exe, args, options) => {
		assert.deepEqual(args, ["auth", "check", "--provider", "openai-codex", "--model", "model", "--json", "--credentials"]);
		assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
		return { status: 0, stdout: JSON.stringify({ status: "ready", provider: "openai-codex", authType: "oauth", credentials: "secret" }) };
	});
	assert.equal(key, "secret");
	assert.throws(() => resolveApiKey("anthropic", "model", 1000, () => ({ status: 1, stdout: "secret", stderr: "secret" })), (error) => !error.message.includes("secret"));
});
