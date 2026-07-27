import { basename } from "node:path";

export const KITTY_SPLIT_SESSION_ENV = "PI_KITTY_SPLIT_SESSION";
export const KITTY_SPLIT_PARENT_WINDOW_ENV = "PI_KITTY_SPLIT_PARENT_WINDOW_ID";

export interface CommandInvocation {
	command: string;
	args: string[];
}

export interface KittySplitLaunchOptions {
	cwd: string;
	sessionFile: string;
	sessionId: string;
	initialPrompt?: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	parentWindowId?: string;
	cli?: CommandInvocation;
	shell?: string;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export type ExecCommand = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number },
) => Promise<ExecResult>;

export interface KittyCommandResult {
	ok: boolean;
	error?: string;
}

export function isKittyTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.KITTY_WINDOW_ID) || env.TERM === "xterm-kitty";
}

export function isKittySplitSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[KITTY_SPLIT_SESSION_ENV] === "1";
}

export function getKittySplitParentWindowId(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const windowId = env[KITTY_SPLIT_PARENT_WINDOW_ENV];
	return windowId && /^\d+$/.test(windowId) ? windowId : undefined;
}

export function getCurrentPiInvocation(
	argv: string[] = process.argv,
	execPath: string = process.execPath,
	isStandaloneBinary: boolean = Boolean((process.versions as NodeJS.ProcessVersions & { bun?: string }).bun),
): CommandInvocation {
	if (isStandaloneBinary) return { command: execPath, args: [] };
	const entrypoint = argv[1];
	if (entrypoint && !entrypoint.startsWith("-")) {
		return { command: execPath, args: [entrypoint] };
	}
	return { command: execPath, args: [] };
}

function wrapInLoginShell(invocation: CommandInvocation, shell?: string): CommandInvocation {
	if (!shell) return invocation;
	const shellName = basename(shell);
	if (["sh", "bash", "dash", "ksh", "zsh"].includes(shellName)) {
		return {
			command: shell,
			args: ["-lc", 'exec "$@"', "pi-split", invocation.command, ...invocation.args],
		};
	}
	if (shellName === "fish") {
		return {
			command: shell,
			args: ["-lc", "exec $argv", invocation.command, ...invocation.args],
		};
	}
	return invocation;
}

export function buildKittySplitLaunchArgs(options: KittySplitLaunchOptions): string[] {
	const pi = options.cli ?? getCurrentPiInvocation();
	const piArgs = [
		...pi.args,
		"--fork",
		options.sessionFile,
		"--session-id",
		options.sessionId,
		"--name",
		"Split session",
	];
	if (options.model) piArgs.push("--model", `${options.model.provider}/${options.model.id}`);
	if (options.thinkingLevel) piArgs.push("--thinking", options.thinkingLevel);
	const initialPrompt = options.initialPrompt?.trim();
	if (initialPrompt) piArgs.push(initialPrompt.startsWith("-") || initialPrompt.startsWith("@") ? ` ${initialPrompt}` : initialPrompt);

	const child = wrapInLoginShell({ command: pi.command, args: piArgs }, options.shell);
	return [
		"@",
		"launch",
		"--self",
		"--no-response",
		"--type=window",
		"--location=vsplit",
		`--cwd=${options.cwd}`,
		"--title=Pi Split",
		`--env=${KITTY_SPLIT_SESSION_ENV}=1`,
		...(options.parentWindowId ? [`--env=${KITTY_SPLIT_PARENT_WINDOW_ENV}=${options.parentWindowId}`] : []),
		child.command,
		...child.args,
	];
}

function failureMessage(command: string, result: ExecResult): string {
	const detail = result.stderr.trim() || result.stdout.trim();
	const suffix = detail ? `: ${detail.split("\n", 1)[0]}` : "";
	return `${command} exited with code ${result.code}${result.killed ? " (timed out)" : ""}${suffix}`;
}

async function runKittyRemote(exec: ExecCommand, args: string[], cwd: string): Promise<KittyCommandResult> {
	const failures: string[] = [];
	for (const command of ["kitten", "kitty"]) {
		try {
			const result = await exec(command, args, { cwd, timeout: 5_000 });
			if (result.code === 0 && !result.killed) return { ok: true };
			failures.push(failureMessage(command, result));
		} catch (error) {
			failures.push(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { ok: false, error: failures.join("; ") };
}

export async function launchKittySplit(
	exec: ExecCommand,
	options: KittySplitLaunchOptions,
): Promise<KittyCommandResult> {
	return runKittyRemote(exec, buildKittySplitLaunchArgs(options), options.cwd);
}

export async function focusKittySplitParent(
	exec: ExecCommand,
	cwd: string,
	parentWindowId: string,
): Promise<KittyCommandResult> {
	if (!/^\d+$/.test(parentWindowId)) return { ok: false, error: "Invalid parent Kitty window id." };
	return runKittyRemote(exec, ["@", "focus-window", "--match", `id:${parentWindowId}`, "--no-response"], cwd);
}
