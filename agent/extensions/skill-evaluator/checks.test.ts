import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { deterministicScore, normalizeRegexSpec, runChecks } from "./checks.ts";

test("deterministic checks cover response, paths, files, and commands", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "skill-eval-check-test-"));
	try {
		await fs.writeFile(path.join(cwd, "artifact.txt"), "MAGIC-123\n");
		const results = await runChecks(
			[
				{ id: "response", type: "response_regex", pattern: "done", flags: "i" },
				{ id: "path", type: "path_exists", path: "artifact.txt", exists: true },
				{ id: "file", type: "file_regex", path: "artifact.txt", pattern: "MAGIC-\\d+" },
				{ id: "command", type: "command", command: "test -f artifact.txt", timeoutMs: 5_000 },
			],
			cwd,
			"Done",
		);
		assert.equal(results.every((result) => result.passed), true);
		assert.equal(deterministicScore(results), 100);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("Python-style leading inline regex flags are normalized for JavaScript", () => {
	const normalized = normalizeRegexSpec("(?m)^1\\.\\s+\\S[\\s\\S]*^2\\.\\s+\\S");
	assert.equal(normalized.pattern, "^1\\.\\s+\\S[\\s\\S]*^2\\.\\s+\\S");
	assert.equal(normalized.flags, "m");
	assert.equal(new RegExp(normalized.pattern, normalized.flags).test("1. one\n2. two"), true);
});

test("path absence checks do not treat non-ENOENT filesystem errors as absent", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "skill-eval-check-enotdir-"));
	try {
		await fs.writeFile(path.join(cwd, "file"), "not a directory");
		const [result] = await runChecks([{ id: "error", type: "path_exists", path: "file/child", exists: false }], cwd, "");
		assert.equal(result.passed, false);
		assert.match(result.details, /ENOTDIR/);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test("file checks reject paths outside the workspace", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "skill-eval-check-escape-"));
	try {
		const [result] = await runChecks(
			[{ id: "escape", type: "path_exists", path: "../outside", exists: true }],
			cwd,
			"",
		);
		assert.equal(result.passed, false);
		assert.match(result.details, /escapes/);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});
