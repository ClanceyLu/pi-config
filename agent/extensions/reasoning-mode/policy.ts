import { PLAN_SUBMIT_TOOL_NAME, type PermissionAction, type ReasoningModeConfig } from "./types.ts";

const ALWAYS_DENIED_TOOLS = new Set(["edit", "write"]);
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "questionnaire", PLAN_SUBMIT_TOOL_NAME]);

export interface PolicyDecision {
	action: PermissionAction;
	reason: string;
}

export function classifyTool(toolName: string, config: ReasoningModeConfig): PolicyDecision {
	if (ALWAYS_DENIED_TOOLS.has(toolName)) {
		return { action: "deny", reason: `${toolName} is unavailable in Reasoning Mode` };
	}
	const configured = config.tools[toolName];
	if (configured) return { action: configured, reason: `configured policy for ${toolName}` };
	if (READ_ONLY_TOOLS.has(toolName)) return { action: "allow", reason: "known read-only reasoning tool" };
	if (toolName === "bash") {
		return config.shellPolicy === "strict"
			? { action: "deny", reason: "bash is disabled by the strict shell policy" }
			: { action: "ask", reason: "bash command requires command-level inspection" };
	}
	return { action: config.unknownTools, reason: `unknown tool ${toolName}` };
}

const SIMPLE_READ_COMMANDS = new Set([
	"pwd", "ls", "eza", "cat", "head", "tail", "wc", "stat", "du", "df", "which", "whereis", "uname", "whoami", "id",
]);
const VERIFY_COMMANDS = new Set(["npm", "pnpm", "yarn", "bun", "cargo", "go", "make", "cmake", "gradle", "mvn"]);
const VERIFY_SUBCOMMANDS = new Set(["test", "check", "build", "lint", "typecheck", "verify"]);
const GIT_READ_SUBCOMMANDS = new Set([
	"status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "grep", "blame", "remote",
]);

export function tokenizeShellWords(command: string): string[] | null {
	const words: string[] = [];
	let current = "";
	let quote: "single" | "double" | undefined;
	let escaping = false;
	for (const char of command.trim()) {
		if (escaping) { current += char; escaping = false; continue; }
		if (char === "\\" && quote !== "single") { escaping = true; continue; }
		if (quote === "single") { if (char === "'") quote = undefined; else current += char; continue; }
		if (quote === "double") { if (char === '"') quote = undefined; else current += char; continue; }
		if (char === "'") { quote = "single"; continue; }
		if (char === '"') { quote = "double"; continue; }
		if (/\s/.test(char)) { if (current) { words.push(current); current = ""; } continue; }
		current += char;
	}
	if (escaping || quote) return null;
	if (current) words.push(current);
	return words;
}

function basename(executable: string): string {
	return executable.replace(/\\/g, "/").split("/").pop() ?? executable;
}
function hasForbiddenShellSyntax(command: string): boolean {
	return /[\n\r;&|<>`]/.test(command) || /\$\(|\$\{|\$[A-Za-z_?*!#@0-9]/.test(command);
}
function hasAnyArg(args: string[], patterns: RegExp[]): boolean {
	return args.some((arg) => patterns.some((pattern) => pattern.test(arg)));
}

const CURL_FLAGS: Record<string, true> = {
	"-s": true, "--silent": true, "-S": true, "--show-error": true, "-f": true, "--fail": true,
	"-L": true, "--location": true, "-I": true, "--head": true, "--compressed": true,
};

function classifyCurl(args: string[]): PolicyDecision {
	let urlCount = 0;
	for (const arg of args) {
		if (CURL_FLAGS[arg]) continue;
		if (arg.startsWith("https://")) { urlCount += 1; continue; }
		return { action: "deny", reason: "curl options are outside the read-only HTTPS allowlist" };
	}
	return urlCount > 0
		? { action: "ask", reason: "read-only HTTPS request requires explicit approval" }
		: { action: "deny", reason: "curl options are outside the read-only HTTPS allowlist" };
}

function classifyGit(args: string[]): PolicyDecision {
	let index = 0;
	while (args[index] === "-C") index += 2;
	const subcommand = args[index];
	const rest = args.slice(index + 1);
	if (!subcommand || !GIT_READ_SUBCOMMANDS.has(subcommand)) {
		return { action: "deny", reason: `git ${subcommand ?? ""} is not a recognized read-only operation` };
	}
	if (
		hasAnyArg(rest, [/^--output(?:=|$)/, /^--exec(?:=|$)/, /^--ext-diff$/, /^--textconv$/]) ||
		(subcommand === "grep" && hasAnyArg(rest, [/^--open-files-in-pager(?:=|$)/]))
	) return { action: "deny", reason: "git option may write files or execute an external command" };
	if (subcommand === "remote" && !["-v", "get-url"].includes(rest[0] ?? "")) {
		return { action: "deny", reason: "only git remote -v/get-url is allowed" };
	}
	return { action: "allow", reason: `git ${subcommand} is treated as read-only` };
}

export function classifyBashCommand(command: string): PolicyDecision {
	const trimmed = command.trim();
	if (!trimmed) return { action: "deny", reason: "empty command" };
	if (hasForbiddenShellSyntax(trimmed)) {
		return { action: "deny", reason: "shell composition, expansion, or redirection is not allowed in Reasoning Mode" };
	}
	const words = tokenizeShellWords(trimmed);
	if (!words?.length) return { action: "deny", reason: "command could not be parsed conservatively" };
	const executable = basename(words[0]!);
	const args = words.slice(1);
	if (SIMPLE_READ_COMMANDS.has(executable)) return { action: "allow", reason: `${executable} is a read-only inspection command` };
	if (executable === "date") return hasAnyArg(args, [/^-s$/, /^--set(?:=|$)/])
		? { action: "deny", reason: "date option can change the system clock" }
		: { action: "allow", reason: "date query is treated as read-only" };
	if (executable === "file") return hasAnyArg(args, [/^-C$/, /^--compile$/])
		? { action: "deny", reason: "file compile mode writes a magic database" }
		: { action: "allow", reason: "file is a read-only inspection command" };
	if (executable === "rg") return hasAnyArg(args, [/^--pre(?:=|$)/, /^--hostname-bin(?:=|$)/])
		? { action: "deny", reason: "rg option can execute another program" }
		: { action: "allow", reason: "rg is a read-only search command" };
	if (executable === "grep") return { action: "allow", reason: "grep is a read-only search command" };
	if (executable === "tree") return hasAnyArg(args, [/^-o$/, /^--output(?:=|$)/])
		? { action: "deny", reason: "tree output option writes a file" }
		: { action: "allow", reason: "tree is a read-only inspection command" };
	if (executable === "find") return hasAnyArg(args, [/^-delete$/, /^-(?:exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/])
		? { action: "deny", reason: "find action may mutate files or execute another command" }
		: { action: "allow", reason: "find expression is treated as read-only" };
	if (executable === "git") return classifyGit(args);
	if ((executable === "node" || executable === "python" || executable === "python3") && args.every((arg) => /^--?version$/.test(arg))) {
		return { action: "allow", reason: "runtime version query is read-only" };
	}
	if (executable === "curl") return classifyCurl(args);
	if (executable === "wget") return { action: "deny", reason: "wget is outside the read-only HTTPS allowlist" };
	if (executable === "node" && args[0]?.replace(/\\/g, "/").endsWith("/native-web-search/search.mjs")) {
		return { action: "deny", reason: "native web search may modify state and is disabled in Reasoning Mode" };
	}
	if (VERIFY_COMMANDS.has(executable)) {
		const subcommand = args.find((arg) => !arg.startsWith("-"));
		if (subcommand && VERIFY_SUBCOMMANDS.has(subcommand)) {
			return { action: "deny", reason: "tests/builds may modify state and are disabled in Reasoning Mode" };
		}
	}
	return { action: "deny", reason: `${executable} is not in the conservative inspection allowlist` };
}

export function reasoningToolSet(
	toolsBeforeReasoning: string[],
	allToolNames: string[],
	config: ReasoningModeConfig,
	mode: "tui" | "rpc" | "json" | "print",
	activeSkill?: string,
): string[] {
	const candidates = [...toolsBeforeReasoning, "read", "grep", "find", "ls"];
	if (mode === "tui" && allToolNames.includes("questionnaire")) candidates.push("questionnaire");
	if (mode === "tui" && activeSkill === "plan" && allToolNames.includes(PLAN_SUBMIT_TOOL_NAME)) candidates.push(PLAN_SUBMIT_TOOL_NAME);
	return [...new Set(candidates)].filter((name) => {
		if (!allToolNames.includes(name)) return false;
		if (name === "questionnaire" && mode !== "tui") return false;
		if (name === PLAN_SUBMIT_TOOL_NAME && (mode !== "tui" || activeSkill !== "plan")) return false;
		if (name === "bash") return config.shellPolicy !== "strict" && config.tools.bash !== "deny";
		return classifyTool(name, config).action !== "deny";
	});
}
