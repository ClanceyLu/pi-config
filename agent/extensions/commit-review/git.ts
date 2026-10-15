import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export interface ReviewFile { status: string; path: string; oldPath?: string; added: string; removed: string }
export interface Snapshot { root: string; id: string; head: string; branch: string; files: ReviewFile[]; outside: number }

async function git(cwd: string, args: string[], signal?: AbortSignal) {
	try {
		const result = await exec("git", ["--no-pager", "--literal-pathspecs", ...args], {
			cwd, encoding: null, maxBuffer: 16 * 1024 * 1024, timeout: 30_000, signal,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
		});
		try { return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout); }
		catch (error) { throw new Error("仓库输出包含非 UTF-8 内容，无法可靠展示差异；请使用支持该编码的工具审阅。", { cause: error }); }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
			throw new Error("差异超过 16 MiB，无法完整审阅；请缩小提交范围后重试。", { cause: error });
		}
		if (error instanceof Error && "stdout" in error && Buffer.isBuffer(error.stdout) && error.stdout.length) {
			throw new Error(`${error.message}\n${error.stdout.toString("utf8")}`, { cause: error });
		}
		throw error;
	}
}

async function identity(root: string, signal?: AbortSignal) {
	const gitDir = (await git(root, ["rev-parse", "--absolute-git-dir"], signal)).replace(/\n$/, "");
	for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
		const exists = await access(join(gitDir, marker)).then(() => true, (error) => {
			if (error.code === "ENOENT") return false;
			throw error;
		});
		if (exists) throw new Error(`存在未完成的 Git 操作（${marker}），请处理后重新审阅。`);
	}
	const branch = (await git(root, ["symbolic-ref", "--quiet", "HEAD"], signal).catch((error) => {
		if (error.code === 1) return "HEAD";
		throw error;
	})).trim();
	// rev-parse --verify fails on an unborn branch; show-ref is not needed to identify its empty base.
	const head = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], signal).catch((error) => {
		if (error.code === 1) return "UNBORN";
		throw error;
	})).trim();
	const index = await git(root, ["ls-files", "--stage", "-z"], signal);
	if (index.split("\0").some((entry) => /^\d+ [a-f0-9]+ [123]\t/.test(entry))) throw new Error("存在未解决冲突，不能确认提交。");
	return { head, branch, id: createHash("sha256").update(JSON.stringify([root, branch, head, index])).digest("hex") };
}

export async function unchanged(snapshot: Snapshot, signal?: AbortSignal) {
	if ((await identity(snapshot.root, signal)).id !== snapshot.id) throw new Error("暂存区或 HEAD 已变化，请重新打开审阅。");
}

export function parseFiles(names: string, stats: string): ReviewFile[] {
	const tokens = names.split("\0");
	const files: ReviewFile[] = [];
	for (let i = 0; i < tokens.length && tokens[i];) {
		const status = tokens[i++];
		const first = tokens[i++];
		const renamed = status.startsWith("R") || status.startsWith("C");
		const path = renamed ? tokens[i++] : first;
		if (path === undefined) throw new Error("无法读取文件列表");
		files.push({ status, path, ...(renamed ? { oldPath: first } : {}), added: "0", removed: "0" });
	}
	const counts = stats.split("\0");
	for (let i = 0; i < counts.length && counts[i];) {
		const entry = counts[i++];
		const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(entry);
		if (!match) throw new Error("无法读取改动统计");
		let path = match[3];
		if (!path) { i++; path = counts[i++]; }
		const file = files.find((file) => file.path === path);
		if (file) { file.added = match[1]; file.removed = match[2]; }
	}
	return files;
}

export async function snapshot(cwd: string, signal?: AbortSignal): Promise<Snapshot> {
	const root = (await git(cwd, ["rev-parse", "--show-toplevel"], signal)).replace(/\n$/, "");
	const state = await identity(root, signal);
	const flags = ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--find-renames"];
	const files = parseFiles(await git(root, [...flags, "--name-status", "-z"], signal), await git(root, [...flags, "--numstat", "-z"], signal));
	if (!files.length) throw new Error("暂存区为空。请先明确提交范围并完成授权暂存，再打开审阅。");
	await git(root, ["diff", "--cached", "--check"], signal);
	const outside = (await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal)).split("\0");
	let count = 0;
	for (let i = 0; i < outside.length && outside[i]; i++) {
		const status = outside[i].slice(0, 2);
		if (status === "??" || status[1] !== " ") count++;
		if (/[RC]/.test(status)) i++;
	}
	const result = { root, ...state, files, outside: count };
	await unchanged(result, signal);
	return result;
}

export async function patch(snapshot: Snapshot, file: ReviewFile, signal?: AbortSignal) {
	await unchanged(snapshot, signal);
	const text = await git(snapshot.root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--submodule=short", "--", ...(file.oldPath ? [file.oldPath] : []), file.path], signal);
	await unchanged(snapshot, signal);
	if (!text) throw new Error("未能读取该文件的差异，请重新检查提交范围。");
	return text;
}

// Repository content is untrusted terminal input, including filenames and commit messages.
export function safeText(text: string) {
	return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).replace(/\t/g, "    ");
}
