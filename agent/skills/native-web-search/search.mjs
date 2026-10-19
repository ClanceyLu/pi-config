#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runAnthropicSearch, runCodexSearch } from "./providers.mjs";

export function parseArgs(argv) {
	const out = { purpose: "general research support", timeoutMs: 120000, json: false, help: false };
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") { out.help = true; continue; }
		if (arg === "--json") { out.json = true; continue; }
		if (arg === "--") { positional.push(...argv.slice(i + 1)); break; }
		if (arg.startsWith("--")) {
			const [flag, ...rest] = arg.split("=");
			if (!["--provider", "--model", "--purpose", "--timeout"].includes(flag)) throw new Error(`Unknown option: ${flag}`);
			const value = rest.length ? rest.join("=") : argv[++i];
			if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
			if (flag === "--timeout") {
				out.timeoutMs = Number(value);
				if (!Number.isSafeInteger(out.timeoutMs) || out.timeoutMs < 1000 || out.timeoutMs > 2147483647) throw new Error("Timeout must be an integer between 1000 and 2147483647 ms");
			} else out[flag.slice(2)] = value;
			continue;
		}
		positional.push(arg);
	}
	out.query = positional.join(" ").trim();
	return out;
}

function agentDir() {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	return configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
}

function readSettings() {
	try { return JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8")); }
	catch (error) {
		if (error.code === "ENOENT") return {};
		throw new Error("Could not parse Pi settings.json");
	}
}

export function selectModel(args, settings) {
	const provider = args.provider ?? settings.defaultProvider;
	if (!["openai-codex", "anthropic"].includes(provider)) {
		throw new Error("Choose --provider openai-codex or --provider anthropic and --model <id>");
	}
	const model = args.model ?? (provider === "openai-codex" ? "codex-auto-review" : provider === settings.defaultProvider ? settings.defaultModel : undefined);
	if (!model) throw new Error("Pass --model <id> or save a default model for this provider in Pi");
	return { provider, model };
}

// The CLI owns authentication, environment interpolation, refresh and storage locks.
// Capture its secret output privately; never include stdout/stderr in errors or logs.
export function resolveApiKey(provider, model, timeoutMs, spawn = spawnSync) {
	const result = spawn(process.env.PI_EXECUTABLE || "pi", [
		"auth", "check", "--provider", provider, "--model", model, "--json", "--credentials",
	], {
		encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let payload;
	try { payload = JSON.parse(result.stdout); } catch { /* Never echo secret output. */ }
	if (result.error || result.status !== 0 || payload?.status !== "ready" ||
		payload.provider !== provider || typeof payload.credentials !== "string" || !payload.credentials.trim()) {
		throw new Error(`Pi could not resolve credentials for ${provider}. Check pi auth check --provider ${provider} or /login.`);
	}
	return payload.credentials.trim();
}

export async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	if (args.help || !args.query) {
		console.log('Usage: node search.mjs "<query>" [--purpose "<why>"] [--provider openai-codex|anthropic] [--model <id>] [--timeout <ms>] [--json]');
		if (!args.help) process.exitCode = 1;
		return;
	}
	const { provider, model } = selectModel(args, readSettings());
	const apiKey = resolveApiKey(provider, model, args.timeoutMs);
	const options = { model, apiKey, query: args.query, purpose: args.purpose, timeoutMs: args.timeoutMs };
	const text = provider === "openai-codex" ? await runCodexSearch(options) : await runAnthropicSearch(options);
	if (args.json) console.log(JSON.stringify({ provider, model, query: args.query, purpose: args.purpose, result: text }, null, 2));
	else console.log(`Provider: ${provider}\nModel: ${model}\n\n${text}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
}
