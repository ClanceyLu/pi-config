import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ArtifactDiff, WorkspaceFile, WorkspaceHandle, WorkspaceSnapshot } from "./types.ts";

const execFileAsync = promisify(execFile);
const SNAPSHOT_TEXT_LIMIT = 64 * 1024;
const DIFF_LIMIT = 100 * 1024;
const MAX_SNAPSHOT_FILES = 25_000;

export interface WorkspaceInspection {
	cwd: string;
	kind: "git" | "directory" | "empty";
	gitRoot?: string;
	commit?: string;
	relativeCwd?: string;
	dirty?: boolean;
}

async function run(command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
	const result = await execFileAsync(command, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 10 * 1024 * 1024,
		timeout: 30_000,
	});
	return { stdout: result.stdout, stderr: result.stderr };
}

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await run("git", ["-C", cwd, ...args]);
	return result.stdout.trim();
}

async function gitAllowExit(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const result = await run("git", ["-C", cwd, ...args]);
		return { code: 0, ...result };
	} catch (error: any) {
		if (typeof error?.code !== "number") throw error;
		return { code: error.code, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
	}
}

async function directoryHasContent(dir: string, ignored = new Set<string>()): Promise<boolean> {
	const entries = await fs.readdir(dir);
	return entries.some((entry) => !ignored.has(entry));
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.lstat(target);
		return true;
	} catch (error: any) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

async function hasGitMetadata(start: string): Promise<boolean> {
	let current = start;
	while (true) {
		if (await pathExists(path.join(current, ".git"))) return true;
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

export async function inspectWorkspace(cwd: string): Promise<WorkspaceInspection> {
	const canonicalCwd = await fs.realpath(cwd);
	if (!(await hasGitMetadata(canonicalCwd))) {
		const empty = !(await directoryHasContent(canonicalCwd));
		return { cwd: canonicalCwd, kind: empty ? "empty" : "directory" };
	}

	const gitRoot = await git(canonicalCwd, ["rev-parse", "--show-toplevel"]);
	const status = await git(gitRoot, ["status", "--porcelain=v1"]);
	const commitResult = await gitAllowExit(gitRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
	if (commitResult.code !== 0 && commitResult.code !== 128) {
		throw new Error(`Git could not resolve HEAD (exit ${commitResult.code}): ${commitResult.stderr.trim()}`);
	}
	const commit = commitResult.code === 0 ? commitResult.stdout.trim() : undefined;
	if (!commit) {
		if (await directoryHasContent(gitRoot, new Set([".git"]))) {
			throw new Error("Git repository has no commit and is not empty; commit the desired state before evaluation.");
		}
		return { cwd: canonicalCwd, kind: "empty" };
	}
	return {
		cwd: canonicalCwd,
		kind: "git",
		gitRoot,
		commit,
		relativeCwd: path.relative(gitRoot, canonicalCwd),
		dirty: status.length > 0,
	};
}

async function hashFile(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	const handle = await fs.open(filePath, "r");
	try {
		const stream = handle.createReadStream();
		for await (const chunk of stream) hash.update(chunk as Buffer);
	} finally {
		await handle.close();
	}
	return hash.digest("hex");
}

function decodeText(buffer: Buffer): string | undefined {
	if (buffer.includes(0)) return undefined;
	const text = buffer.toString("utf8");
	if (text.includes("�")) return undefined;
	return text;
}

export async function snapshotWorkspace(root: string): Promise<WorkspaceSnapshot> {
	const files: WorkspaceFile[] = [];
	const visit = async (current: string, relative: string): Promise<void> => {
		const entries = await fs.readdir(current, { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (entry.name === ".git") continue;
			if (files.length >= MAX_SNAPSHOT_FILES) {
				throw new Error(`Workspace contains more than ${MAX_SNAPSHOT_FILES} files; evaluation snapshot aborted.`);
			}
			const absolute = path.join(current, entry.name);
			const rel = relative ? `${relative}/${entry.name}` : entry.name;
			const stat = await fs.lstat(absolute);
			if (stat.isDirectory()) {
				await visit(absolute, rel);
				continue;
			}
			if (stat.isSymbolicLink()) {
				const linkTarget = await fs.readlink(absolute);
				files.push({
					path: rel,
					type: "symlink",
					size: Buffer.byteLength(linkTarget),
					hash: createHash("sha256").update(linkTarget).digest("hex"),
					linkTarget,
				});
				continue;
			}
			if (!stat.isFile()) continue;
			let textContent: string | undefined;
			if (stat.size <= SNAPSHOT_TEXT_LIMIT) {
				textContent = decodeText(await fs.readFile(absolute));
			}
			files.push({
				path: rel,
				type: "file",
				size: stat.size,
				hash: await hashFile(absolute),
				textContent,
			});
		}
	};
	await visit(root, "");
	return { files, capturedAt: new Date().toISOString() };
}

export function snapshotHash(snapshot: WorkspaceSnapshot): string {
	const hash = createHash("sha256");
	for (const file of snapshot.files) {
		hash.update(`${file.path}\0${file.type}\0${file.size}\0${file.hash}\0`);
	}
	return hash.digest("hex");
}

function appendWithinLimit(parts: string[], value: string, state: { bytes: number; truncated: boolean }): void {
	if (state.truncated) return;
	const bytes = Buffer.byteLength(value);
	if (state.bytes + bytes > DIFF_LIMIT) {
		const available = Math.max(0, DIFF_LIMIT - state.bytes);
		parts.push(Buffer.from(value).subarray(0, available).toString("utf8"));
		parts.push("\n[diff truncated]\n");
		state.truncated = true;
		return;
	}
	parts.push(value);
	state.bytes += bytes;
}

function renderFileChange(kind: "added" | "modified" | "deleted", before?: WorkspaceFile, after?: WorkspaceFile): string {
	const filePath = after?.path ?? before?.path ?? "unknown";
	const header = `\n### ${kind}: ${filePath}\n`;
	if (before?.type === "symlink" || after?.type === "symlink") {
		return `${header}- link: ${before?.linkTarget ?? "(none)"}\n+ link: ${after?.linkTarget ?? "(none)"}\n`;
	}
	if (before?.textContent === undefined && after?.textContent === undefined) {
		return `${header}[binary or large file: ${before?.size ?? 0} -> ${after?.size ?? 0} bytes]\n`;
	}
	const removed = before?.textContent?.split("\n").map((line) => `- ${line}`).join("\n") ?? "";
	const added = after?.textContent?.split("\n").map((line) => `+ ${line}`).join("\n") ?? "";
	return `${header}${removed}${removed && added ? "\n" : ""}${added}\n`;
}

export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): ArtifactDiff {
	const oldMap = new Map(before.files.map((file) => [file.path, file]));
	const newMap = new Map(after.files.map((file) => [file.path, file]));
	const added = [...newMap.keys()].filter((file) => !oldMap.has(file)).sort();
	const deleted = [...oldMap.keys()].filter((file) => !newMap.has(file)).sort();
	const modified = [...newMap.keys()]
		.filter((file) => oldMap.has(file) && oldMap.get(file)!.hash !== newMap.get(file)!.hash)
		.sort();
	const parts: string[] = [];
	const state = { bytes: 0, truncated: false };
	appendWithinLimit(
		parts,
		`Added: ${added.length}, modified: ${modified.length}, deleted: ${deleted.length}\n`,
		state,
	);
	for (const file of added) appendWithinLimit(parts, renderFileChange("added", undefined, newMap.get(file)), state);
	for (const file of modified) appendWithinLimit(parts, renderFileChange("modified", oldMap.get(file), newMap.get(file)), state);
	for (const file of deleted) appendWithinLimit(parts, renderFileChange("deleted", oldMap.get(file), undefined), state);
	return { summary: { added, modified, deleted }, text: parts.join(""), truncated: state.truncated };
}

async function makeBaseDirectory(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function cleanupThenRethrow(cleanup: () => Promise<void>, original: unknown, message: string): Promise<never> {
	try {
		await cleanup();
	} catch (cleanupError) {
		throw new AggregateError([original, cleanupError], message);
	}
	throw original;
}

export async function exportWorkspace(sourceRoot: string, destination: string): Promise<void> {
	await fs.rm(destination, { recursive: true, force: true });
	await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
	await fs.cp(sourceRoot, destination, {
		recursive: true,
		dereference: false,
		preserveTimestamps: true,
		filter: (source) => path.basename(source) !== ".git",
	});
	await fs.chmod(destination, 0o700);
}

export async function createWorkspace(
	inspection: WorkspaceInspection,
	label: string,
): Promise<WorkspaceHandle> {
	const base = await makeBaseDirectory(`pi-skill-eval-${label}-`);
	const root = path.join(base, "workspace");
	let cleanup: () => Promise<void>;
	let kind: WorkspaceHandle["kind"];
	let workspaceCwd: string;
	let sourceRoot: string;

	if (inspection.kind === "git") {
		if (!inspection.gitRoot || !inspection.commit) throw new Error("Invalid Git workspace inspection");
		try {
			await git(inspection.gitRoot, ["worktree", "add", "--detach", root, inspection.commit]);
		} catch (error) {
			return cleanupThenRethrow(() => fs.rm(base, { recursive: true, force: true }), error, "Worktree creation and cleanup both failed.");
		}
		kind = "git-worktree";
		sourceRoot = inspection.gitRoot;
		workspaceCwd = path.join(root, inspection.relativeCwd ?? "");
		cleanup = async () => {
			try {
				await git(inspection.gitRoot!, ["worktree", "remove", "--force", root]);
			} catch {
				// A failed Git removal is fully recovered only if both the directory removal and metadata prune succeed.
				await fs.rm(root, { recursive: true, force: true });
				await git(inspection.gitRoot!, ["worktree", "prune"]);
			}
			await fs.rm(base, { recursive: true, force: true });
		};
	} else if (inspection.kind === "directory") {
		await fs.cp(inspection.cwd, root, { recursive: true, dereference: false, preserveTimestamps: true });
		kind = "directory-copy";
		sourceRoot = inspection.cwd;
		workspaceCwd = root;
		cleanup = () => fs.rm(base, { recursive: true, force: true });
	} else {
		await fs.mkdir(root, { recursive: true });
		kind = "empty-directory";
		sourceRoot = inspection.cwd;
		workspaceCwd = root;
		cleanup = () => fs.rm(base, { recursive: true, force: true });
	}

	try {
		const initialSnapshot = await snapshotWorkspace(root);
		return {
			kind,
			root,
			cwd: workspaceCwd,
			sourceRoot,
			initialSnapshot,
			commit: inspection.commit,
			cleanup,
		};
	} catch (error) {
		return cleanupThenRethrow(cleanup, error, "Workspace initialization and cleanup both failed.");
	}
}
