import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { assertRepositoryHasNoSymlinks, findSkillFiles, parseGitHubLocation, pinnedLookup } from "./acquisition-security.ts";

test("pinned HTTPS lookup returns only the previously validated address", async () => {
	const lookup = pinnedLookup([{ address: "93.184.216.34", family: 4 }]);
	const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
		(lookup as any)("attacker.example", { all: false }, (error: Error | null, address: string, family: number) => {
			if (error) reject(error);
			else resolve({ address, family });
		});
	});
	assert.deepEqual(result, { address: "93.184.216.34", family: 4 });
});

test("GitHub tree URLs retain their explicit ref instead of defaulting to HEAD", () => {
	const location = parseGitHubLocation("https://github.com/owner/repo/tree/release/skills/demo");
	assert.equal(location?.ref, "release");
	assert.equal(location?.subpath, "skills/demo");
});

test("repository Skill discovery rejects symlinks", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-eval-symlink-test-"));
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), "skill-eval-symlink-outside-"));
	try {
		await fs.writeFile(path.join(outside, "SKILL.md"), "---\nname: outside\ndescription: outside\n---\n");
		await fs.symlink(path.join(outside, "SKILL.md"), path.join(root, "SKILL.md"));
		await assert.rejects(assertRepositoryHasNoSymlinks(root), /Symlinks are not allowed/);
		await assert.rejects(findSkillFiles(root), /Symlinks are not allowed/);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(outside, { recursive: true, force: true });
	}
});
