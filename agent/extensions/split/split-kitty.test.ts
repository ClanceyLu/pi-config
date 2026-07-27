import assert from "node:assert/strict";
import test from "node:test";
import {
	KITTY_SPLIT_PARENT_WINDOW_ENV,
	KITTY_SPLIT_SESSION_ENV,
	buildKittySplitLaunchArgs,
	focusKittySplitParent,
	getCurrentPiInvocation,
	getKittySplitParentWindowId,
	isKittySplitSession,
	isKittyTerminal,
	launchKittySplit,
	type ExecResult,
} from "./split-kitty.ts";

const ok: ExecResult = { stdout: "", stderr: "", code: 0, killed: false };

function valueAfter(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index < 0 ? undefined : args[index + 1];
}

test("detects Kitty and marked split sessions", () => {
	assert.equal(isKittyTerminal({ KITTY_WINDOW_ID: "17" }), true);
	assert.equal(isKittyTerminal({ TERM: "xterm-kitty" }), true);
	assert.equal(isKittyTerminal({ TERM: "xterm-256color" }), false);
	assert.equal(isKittySplitSession({ [KITTY_SPLIT_SESSION_ENV]: "1" }), true);
	assert.equal(isKittySplitSession({ [KITTY_SPLIT_SESSION_ENV]: "0" }), false);
	assert.equal(getKittySplitParentWindowId({ [KITTY_SPLIT_PARENT_WINDOW_ENV]: "17" }), "17");
	assert.equal(getKittySplitParentWindowId({ [KITTY_SPLIT_PARENT_WINDOW_ENV]: "17 OR all" }), undefined);
});

test("builds a forked Pi launch in a vertical Kitty split", () => {
	const args = buildKittySplitLaunchArgs({
		cwd: "/tmp/project with spaces",
		initialPrompt: "  --review this  ",
		sessionFile: "/tmp/main session.jsonl",
		sessionId: "019f-test-split-session",
		model: { provider: "openai", id: "gpt-5.4" },
		thinkingLevel: "high",
		parentWindowId: "17",
		cli: { command: "/opt/node", args: ["/opt/pi/cli.js"] },
	});

	assert.deepEqual(args.slice(0, 8), [
		"@", "launch", "--self", "--no-response", "--type=window", "--location=vsplit",
		"--cwd=/tmp/project with spaces", "--title=Pi Split",
	]);
	assert.equal(args[8], `--env=${KITTY_SPLIT_SESSION_ENV}=1`);
	assert.equal(args[9], `--env=${KITTY_SPLIT_PARENT_WINDOW_ENV}=17`);
	assert.equal(args[10], "/opt/node");
	assert.equal(valueAfter(args, "--fork"), "/tmp/main session.jsonl");
	assert.equal(valueAfter(args, "--session-id"), "019f-test-split-session");
	assert.equal(valueAfter(args, "--name"), "Split session");
	assert.equal(valueAfter(args, "--model"), "openai/gpt-5.4");
	assert.equal(valueAfter(args, "--thinking"), "high");
	assert.equal(args.includes("--append-system-prompt"), false);
	assert.equal(args.at(-1), " --review this");
});

test("protects @ prompts and omits blank prompts", () => {
	const atPromptArgs = buildKittySplitLaunchArgs({
		cwd: "/tmp/project",
		sessionFile: "/tmp/main.jsonl",
		sessionId: "new-session",
		initialPrompt: "@notes.md review this",
		cli: { command: "pi", args: [] },
	});
	assert.equal(atPromptArgs.at(-1), " @notes.md review this");

	const blankPromptArgs = buildKittySplitLaunchArgs({
		cwd: "/tmp/project",
		sessionFile: "/tmp/main.jsonl",
		sessionId: "new-session",
		initialPrompt: "   ",
		cli: { command: "pi", args: [] },
	});
	assert.equal(blankPromptArgs.at(-1), "Split session");
});

test("uses a login POSIX shell so child Pi reloads user environment", () => {
	const args = buildKittySplitLaunchArgs({
		cwd: "/tmp/project",
		sessionFile: "/tmp/main.jsonl",
		sessionId: "new-session",
		cli: { command: "/opt/node", args: ["/opt/pi/cli.js"] },
		shell: "/bin/zsh",
	});
	const shellIndex = args.indexOf("/bin/zsh");
	assert.deepEqual(args.slice(shellIndex, shellIndex + 5), ["/bin/zsh", "-lc", 'exec "$@"', "pi-split", "/opt/node"]);
	assert.equal(args[shellIndex + 5], "/opt/pi/cli.js");
});

test("current Pi invocation reuses the running executable and entrypoint", () => {
	assert.deepEqual(getCurrentPiInvocation(["/opt/node", "/opt/pi/cli.js"], "/opt/node", false), {
		command: "/opt/node",
		args: ["/opt/pi/cli.js"],
	});
	assert.deepEqual(getCurrentPiInvocation(["/opt/pi"], "/opt/pi", false), { command: "/opt/pi", args: [] });
	assert.deepEqual(getCurrentPiInvocation(["/opt/pi", "a prompt"], "/opt/pi", true), { command: "/opt/pi", args: [] });
});

test("tries kitten first and falls back to kitty", async () => {
	const calls: string[] = [];
	const result = await launchKittySplit(async (command) => {
		calls.push(command);
		return command === "kitten"
			? { stdout: "", stderr: "not found", code: 1, killed: false }
			: ok;
	}, {
		cwd: "/tmp/project",
		sessionFile: "/tmp/main.jsonl",
		sessionId: "new-session",
		cli: { command: "pi", args: [] },
	});
	assert.deepEqual(calls, ["kitten", "kitty"]);
	assert.deepEqual(result, { ok: true });
});

test("focuses the original Kitty window before quitting", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const result = await focusKittySplitParent(async (command, args) => {
		calls.push({ command, args });
		return ok;
	}, "/tmp/project", "17");
	assert.deepEqual(result, { ok: true });
	assert.deepEqual(calls, [{
		command: "kitten",
		args: ["@", "focus-window", "--match", "id:17", "--no-response"],
	}]);
	assert.equal((await focusKittySplitParent(async () => ok, "/tmp/project", "all")).ok, false);
});

test("reports both launch failures", async () => {
	const result = await launchKittySplit(async (command) => ({
		stdout: "",
		stderr: `${command} failed\nmore details`,
		code: 1,
		killed: false,
	}), {
		cwd: "/tmp/project",
		sessionFile: "/tmp/main.jsonl",
		sessionId: "new-session",
		cli: { command: "pi", args: [] },
	});
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /kitten exited with code 1: kitten failed/);
	assert.match(result.error ?? "", /kitty exited with code 1: kitty failed/);
});
