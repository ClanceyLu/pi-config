import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { CheckResult, DeterministicCheck } from "./types.ts";

const execFileAsync = promisify(execFile);
const MAX_CHECK_OUTPUT = 128 * 1024;
const MAX_FILE_CHECK_BYTES = 2 * 1024 * 1024;

export function normalizeRegexSpec(pattern: string, flags?: string): { pattern: string; flags: string } {
	let normalizedPattern = pattern;
	let normalizedFlags = flags ?? "";
	const inlineFlags = normalizedPattern.match(/^\(\?([a-z]+)\)/i);
	if (inlineFlags) {
		const unsupported = inlineFlags[1].split("").filter((flag) => !"dgimsuvy".includes(flag));
		if (unsupported.length > 0) {
			throw new Error(`Unsupported inline regular expression flags: ${unsupported.join("")}`);
		}
		normalizedFlags += inlineFlags[1];
		normalizedPattern = normalizedPattern.slice(inlineFlags[0].length);
	}
	if (/[^dgimsuvy]/.test(normalizedFlags)) throw new Error(`Unsupported regular expression flags: ${normalizedFlags}`);
	normalizedFlags = [...new Set(normalizedFlags.split(""))].join("");
	new RegExp(normalizedPattern, normalizedFlags);
	return { pattern: normalizedPattern, flags: normalizedFlags };
}

function safeRegex(pattern: string, flags?: string): RegExp {
	const normalized = normalizeRegexSpec(pattern, flags);
	return new RegExp(normalized.pattern, normalized.flags);
}

function resolveInside(root: string, input: string): string {
	const absolute = path.resolve(root, input);
	const relative = path.relative(root, absolute);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Path escapes evaluation workspace: ${input}`);
	}
	return absolute;
}

function finish(
	check: DeterministicCheck,
	startedAt: number,
	passed: boolean,
	details: string,
	extra: Partial<CheckResult> = {},
): CheckResult {
	return {
		id: check.id,
		type: check.type,
		passed,
		details,
		durationMs: Date.now() - startedAt,
		...extra,
	};
}

async function runCheck(
	check: DeterministicCheck,
	cwd: string,
	response: string,
	signal?: AbortSignal,
): Promise<CheckResult> {
	const startedAt = Date.now();
	try {
		if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
		switch (check.type) {
			case "response_regex": {
				const matched = safeRegex(check.pattern, check.flags).test(response);
				return finish(check, startedAt, matched, matched ? "Response matched regex." : "Response did not match regex.");
			}
			case "path_exists": {
				const target = resolveInside(cwd, check.path);
				let present: boolean;
				try {
					await fs.lstat(target);
					present = true;
				} catch (error: any) {
					if (error?.code !== "ENOENT") throw error;
					present = false;
				}
				const passed = present === check.exists;
				return finish(
					check,
					startedAt,
					passed,
					`Path ${check.path} is ${present ? "present" : "absent"}; expected ${check.exists ? "present" : "absent"}.`,
				);
			}
			case "file_regex": {
				const target = resolveInside(cwd, check.path);
				const stat = await fs.stat(target);
				if (!stat.isFile()) return finish(check, startedAt, false, `${check.path} is not a regular file.`);
				if (stat.size > MAX_FILE_CHECK_BYTES) {
					return finish(check, startedAt, false, `${check.path} exceeds ${MAX_FILE_CHECK_BYTES} bytes.`);
				}
				const text = await fs.readFile(target, "utf8");
				const matched = safeRegex(check.pattern, check.flags).test(text);
				return finish(check, startedAt, matched, matched ? "File matched regex." : "File did not match regex.");
			}
			case "command": {
				const shell = process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
				const args = process.platform === "win32" ? ["/d", "/s", "/c", check.command] : ["-lc", check.command];
				try {
					const result = await execFileAsync(shell, args, {
						cwd,
						encoding: "utf8",
						maxBuffer: MAX_CHECK_OUTPUT,
						timeout: check.timeoutMs,
						signal,
					});
					return finish(check, startedAt, true, "Command exited with status 0.", {
						stdout: result.stdout,
						stderr: result.stderr,
					});
				} catch (error: any) {
					return finish(check, startedAt, false, `Command failed: ${error?.message ?? String(error)}`, {
						stdout: error?.stdout,
						stderr: error?.stderr,
					});
				}
			}
		}
	} catch (error) {
		return finish(check, startedAt, false, error instanceof Error ? error.message : String(error));
	}
}

export async function runChecks(
	checks: DeterministicCheck[],
	cwd: string,
	response: string,
	signal?: AbortSignal,
): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	for (const check of checks) results.push(await runCheck(check, cwd, response, signal));
	return results;
}

export function deterministicScore(results: CheckResult[]): number {
	if (results.length === 0) return 0;
	return (results.filter((result) => result.passed).length / results.length) * 100;
}
