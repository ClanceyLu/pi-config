import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createWorkspace, diffSnapshots, exportWorkspace, inspectWorkspace, snapshotHash, snapshotWorkspace } from "./workspace.ts";

const exec = promisify(execFile);

async function temp(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function git(cwd: string, args: string[]): Promise<void> {
	await exec("git", ["-C", cwd, ...args]);
}

test("Git workspaces use committed HEAD and ignore dirty source changes", async () => {
	const repo = await temp("skill-eval-git-test-");
	try {
		await git(repo, ["init"]);
		await git(repo, ["config", "user.email", "test@example.com"]);
		await git(repo, ["config", "user.name", "Test"]);
		await fs.mkdir(path.join(repo, "sub"));
		await fs.writeFile(path.join(repo, "sub", "value.txt"), "committed\n");
		await git(repo, ["add", "."]);
		await git(repo, ["commit", "-m", "initial"]);
		await fs.writeFile(path.join(repo, "sub", "value.txt"), "dirty\n");
		const inspection = await inspectWorkspace(path.join(repo, "sub"));
		assert.equal(inspection.kind, "git");
		assert.equal(inspection.dirty, true);
		const a = await createWorkspace(inspection, "test-a");
		const b = await createWorkspace(inspection, "test-b");
		try {
			assert.equal(await fs.readFile(path.join(a.cwd, "value.txt"), "utf8"), "committed\n");
			assert.equal(snapshotHash(a.initialSnapshot), snapshotHash(b.initialSnapshot));
			await fs.writeFile(path.join(a.cwd, "value.txt"), "changed\n");
			const after = await snapshotWorkspace(a.root);
			const diff = diffSnapshots(a.initialSnapshot, after);
			assert.deepEqual(diff.summary.modified, ["sub/value.txt"]);
		} finally {
			const aRoot = path.dirname(a.root);
			const bRoot = path.dirname(b.root);
			await a.cleanup();
			await b.cleanup();
			await assert.rejects(fs.stat(aRoot));
			await assert.rejects(fs.stat(bRoot));
		}
	} finally {
		await fs.rm(repo, { recursive: true, force: true });
	}
});

test("Git metadata failures are propagated instead of copying the directory as non-Git", async () => {
	const broken = await temp("skill-eval-broken-git-");
	try {
		await fs.mkdir(path.join(broken, ".git"));
		await assert.rejects(inspectWorkspace(broken));
	} finally {
		await fs.rm(broken, { recursive: true, force: true });
	}
});

test("workspace export retains final artifacts and excludes .git metadata", async () => {
	const source = await temp("skill-eval-export-source-");
	const destinationRoot = await temp("skill-eval-export-dest-");
	const destination = path.join(destinationRoot, "workspace");
	try {
		await fs.mkdir(path.join(source, ".git"));
		await fs.writeFile(path.join(source, ".git", "config"), "secret metadata");
		await fs.mkdir(path.join(source, "output"));
		await fs.writeFile(path.join(source, "output", "artifact.txt"), "retained");
		await exportWorkspace(source, destination);
		assert.equal(await fs.readFile(path.join(destination, "output", "artifact.txt"), "utf8"), "retained");
		await assert.rejects(fs.stat(path.join(destination, ".git")));
	} finally {
		await fs.rm(source, { recursive: true, force: true });
		await fs.rm(destinationRoot, { recursive: true, force: true });
	}
});

test("non-Git directories are copied and empty directories remain empty", async () => {
	const source = await temp("skill-eval-dir-test-");
	const empty = await temp("skill-eval-empty-test-");
	try {
		await fs.writeFile(path.join(source, "hello.txt"), "hello");
		const copied = await createWorkspace(await inspectWorkspace(source), "copy-test");
		const emptyWorkspace = await createWorkspace(await inspectWorkspace(empty), "empty-test");
		try {
			assert.equal(copied.kind, "directory-copy");
			assert.equal(await fs.readFile(path.join(copied.cwd, "hello.txt"), "utf8"), "hello");
			assert.equal(emptyWorkspace.kind, "empty-directory");
			assert.deepEqual(await fs.readdir(emptyWorkspace.cwd), []);
		} finally {
			await copied.cleanup();
			await emptyWorkspace.cleanup();
		}
	} finally {
		await fs.rm(source, { recursive: true, force: true });
		await fs.rm(empty, { recursive: true, force: true });
	}
});
