#!/usr/bin/env node

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { spawnSync, execSync } from "child_process";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { runAnthropicSearch, runCodexSearch } from "./providers.mjs";

function parseArgs(argv) {
	const out = {
		provider: undefined,
		model: undefined,
		purpose: "general research support",
		timeoutMs: 120000,
		json: false,
		help: false,
		query: "",
	};

	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			out.help = true;
			continue;
		}
		if (arg === "--json") {
			out.json = true;
			continue;
		}
		if (arg === "--provider") {
			out.provider = argv[++i];
			continue;
		}
		if (arg.startsWith("--provider=")) {
			out.provider = arg.slice("--provider=".length);
			continue;
		}
		if (arg === "--model") {
			out.model = argv[++i];
			continue;
		}
		if (arg.startsWith("--model=")) {
			out.model = arg.slice("--model=".length);
			continue;
		}
		if (arg === "--purpose") {
			out.purpose = argv[++i] || out.purpose;
			continue;
		}
		if (arg.startsWith("--purpose=")) {
			out.purpose = arg.slice("--purpose=".length) || out.purpose;
			continue;
		}
		if (arg === "--timeout") {
			out.timeoutMs = Math.max(1000, Number(argv[++i] || out.timeoutMs));
			continue;
		}
		if (arg.startsWith("--timeout=")) {
			out.timeoutMs = Math.max(1000, Number(arg.slice("--timeout=".length) || out.timeoutMs));
			continue;
		}
		positional.push(arg);
	}

	out.query = positional.join(" ").trim();
	return out;
}

function usage() {
	return `Usage:
  node search.mjs "<query>" [--purpose "<why>"] [--provider openai-codex|anthropic] [--model <id>] [--json]

Examples:
  node search.mjs "latest python release" --purpose "update dependency notes"
  node search.mjs "HTTP/3 browser support 2026" --provider openai-codex
  node search.mjs "vite 7 breaking changes" --json`;
}

function readJson(path, fallback = {}) {
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return fallback;
		throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function writeJson(path, value) {
	const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let descriptor;
	try {
		descriptor = openSync(temporaryPath, "wx", 0o600);
		writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporaryPath, path);
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		try {
			unlinkSync(temporaryPath);
		} catch (cleanupError) {
			if (cleanupError?.code !== "ENOENT") {
				throw new AggregateError([error, cleanupError], `Failed to persist ${path} and clean up its temporary file`);
			}
		}
		throw error;
	}
}

function resolveConfigValue(config) {
	if (typeof config !== "string" || !config) return undefined;
	if (config.startsWith("!")) {
		try {
			const out = execSync(config.slice(1), {
				encoding: "utf8",
				timeout: 10000,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			return out || undefined;
		} catch {
			return undefined;
		}
	}
	return process.env[config] || config;
}

function getAgentDir() {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return configured;
}

function normalizeProvider(provider) {
	if (!provider) return undefined;
	const p = String(provider).toLowerCase().trim();
	if (p.includes("anthropic") || p.includes("claude")) return "anthropic";
	if (p.includes("codex") || p === "openai" || p.startsWith("openai")) return "openai-codex";
	return undefined;
}

function pickProvider(argProvider, settings, auth) {
	const forced = normalizeProvider(argProvider);
	if (forced) return forced;

	const fromSettings = normalizeProvider(settings?.defaultProvider);
	if (fromSettings) return fromSettings;

	if (auth?.["openai-codex"]) return "openai-codex";
	if (auth?.anthropic) return "anthropic";

	throw new Error("Could not determine provider. Pass --provider openai-codex|anthropic");
}

function findPiExecutable() {
	const cmd = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(cmd, ["pi"], { encoding: "utf8" });
	if (result.status !== 0) return undefined;
	const first = result.stdout
		.split(/\r?\n/)
		.map((x) => x.trim())
		.find(Boolean);
	return first || undefined;
}

function collectModuleCandidates(fileName = "index.js", envVarName = "PI_AI_MODULE_PATH") {
	const candidates = new Set();

	const add = (p) => {
		if (!p) return;
		const abs = isAbsolute(p) ? p : resolve(p);
		candidates.add(abs);
	};

	if (envVarName && process.env[envVarName]) add(process.env[envVarName]);

	const cwd = process.cwd();
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	for (const start of [cwd, scriptDir]) {
		let dir = start;
		for (let i = 0; i < 8; i++) {
			add(join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", fileName));
			add(join(dir, "packages", "ai", "dist", fileName));
			add(join(dir, "ai", "dist", fileName));
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}

	const piExec = findPiExecutable();
	if (piExec) {
		try {
			const piReal = realpathSync(piExec);
			const piDir = dirname(piReal);
			add(join(piDir, "..", "..", "ai", "dist", fileName));
			add(join(piDir, "..", "..", "pi-ai", "dist", fileName));
			add(join(piDir, "..", "node_modules", "@earendil-works", "pi-ai", "dist", fileName));
			add(join(piDir, "..", "..", "node_modules", "@earendil-works", "pi-ai", "dist", fileName));
		} catch {
			// ignore
		}
	}

	add(join(homedir(), "Development", "pi-mono", "packages", "ai", "dist", fileName));

	return Array.from(candidates);
}

async function loadPiAi() {
	const tried = [];

	try {
		return await import("@earendil-works/pi-ai");
	} catch (err) {
		tried.push(`@earendil-works/pi-ai (${err?.code || err?.message || "not found"})`);
	}

	for (const candidate of collectModuleCandidates("index.js", "PI_AI_MODULE_PATH")) {
		if (!existsSync(candidate)) continue;
		try {
			return await import(pathToFileURL(candidate).href);
		} catch (err) {
			tried.push(`${candidate} (${err?.code || err?.message || "failed"})`);
		}
	}

	throw new Error(
		`Could not load @earendil-works/pi-ai. Set PI_AI_MODULE_PATH to its dist/index.js.\nTried:\n- ${tried.join("\n- ")}`,
	);
}

async function loadPiAiOAuth(piAi) {
	if (typeof piAi?.getOAuthApiKey === "function") {
		return { getOAuthApiKey: piAi.getOAuthApiKey.bind(piAi) };
	}

	const tried = [];

	try {
		const oauth = await import("@earendil-works/pi-ai/oauth");
		if (typeof oauth.getOAuthApiKey === "function") {
			return { getOAuthApiKey: oauth.getOAuthApiKey.bind(oauth) };
		}
		tried.push("@earendil-works/pi-ai/oauth (missing getOAuthApiKey export)");
	} catch (err) {
		tried.push(`@earendil-works/pi-ai/oauth (${err?.code || err?.message || "not found"})`);
	}

	for (const candidate of collectModuleCandidates("oauth.js", "PI_AI_OAUTH_MODULE_PATH")) {
		if (!existsSync(candidate)) continue;
		try {
			const oauth = await import(pathToFileURL(candidate).href);
			if (typeof oauth.getOAuthApiKey === "function") {
				return { getOAuthApiKey: oauth.getOAuthApiKey.bind(oauth) };
			}
			tried.push(`${candidate} (missing getOAuthApiKey export)`);
		} catch (err) {
			tried.push(`${candidate} (${err?.code || err?.message || "failed"})`);
		}
	}

	return {
		getOAuthApiKey: undefined,
		error: `Could not load getOAuthApiKey. Set PI_AI_OAUTH_MODULE_PATH to pi-ai dist/oauth.js.\nTried:\n- ${tried.join("\n- ")}`,
	};
}

function parseExpiryTimestamp(expires) {
	if (typeof expires === "number" && Number.isFinite(expires)) {
		if (expires <= 0) return undefined;
		return expires < 1_000_000_000_000 ? expires * 1000 : expires;
	}

	if (typeof expires === "string") {
		const trimmed = expires.trim();
		if (!trimmed) return undefined;

		const numeric = Number(trimmed);
		if (Number.isFinite(numeric)) {
			return parseExpiryTimestamp(numeric);
		}

		const parsed = Date.parse(trimmed);
		if (Number.isFinite(parsed)) return parsed;
	}

	return undefined;
}

function getCachedOAuthAccess(entry, now = Date.now()) {
	if (!entry || typeof entry !== "object") return undefined;

	const apiKey = resolveConfigValue(entry.access);
	if (!apiKey) return undefined;

	const expiresAt = parseExpiryTimestamp(entry.expires);
	if (!expiresAt) return undefined;

	if (now + 30_000 >= expiresAt) return undefined;

	return {
		apiKey,
		accountId: entry.accountId,
	};
}

function pickFastModel(provider, requestedModel, piAi) {
	const models = typeof piAi.getModels === "function" ? piAi.getModels(provider) : [];
	if (!Array.isArray(models) || models.length === 0) {
		if (requestedModel) return { id: requestedModel, baseUrl: undefined };
		if (provider === "openai-codex") return { id: "gpt-5.4-mini", baseUrl: "https://chatgpt.com/backend-api" };
		return { id: "claude-haiku-4-5", baseUrl: "https://api.anthropic.com" };
	}

	if (requestedModel) {
		const exact = models.find((m) => m.id === requestedModel);
		if (exact) return exact;
		return { ...models[0], id: requestedModel };
	}

	const preferredIds =
		provider === "openai-codex"
			? ["gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-5.1", "gpt-5.1-codex-mini"]
			: ["claude-haiku-4-5", "claude-3-5-haiku-latest", "claude-3-5-haiku-20241022"];

	for (const id of preferredIds) {
		const found = models.find((m) => m.id === id);
		if (found) return found;
	}

	const heuristic = models.find((m) => /mini|haiku|spark|flash|fast/i.test(m.id));
	return heuristic || models[0];
}

async function resolveApiKey(provider, auth, authPath, piAi) {
	const entry = auth?.[provider];
	if (!entry) {
		throw new Error(`No credentials for provider '${provider}' in ${authPath}`);
	}

	const inferredType = entry.type || (entry.access && entry.refresh ? "oauth" : entry.key ? "api_key" : undefined);

	if (inferredType === "api_key") {
		const key = resolveConfigValue(entry.key);
		if (!key) throw new Error(`API key for ${provider} is empty or unresolved.`);
		return { apiKey: key, accountId: entry.accountId };
	}

	if (inferredType !== "oauth") {
		throw new Error(`Unsupported credential type for ${provider}: ${String(entry.type || "unknown")}`);
	}

	const fallbackToken = getCachedOAuthAccess(entry);
	const oauth = await loadPiAiOAuth(piAi);

	if (typeof oauth.getOAuthApiKey !== "function") {
		if (fallbackToken) return fallbackToken;
		throw new Error(oauth.error || "Loaded pi-ai module does not export getOAuthApiKey");
	}

	const oauthCreds = {};
	for (const [k, v] of Object.entries(auth || {})) {
		if (v && (v.type === "oauth" || (v.access && v.refresh && v.expires))) {
			oauthCreds[k] = v;
		}
	}

	let refreshed;
	try {
		refreshed = await oauth.getOAuthApiKey(provider, oauthCreds);
	} catch (err) {
		if (fallbackToken) return fallbackToken;
		throw err;
	}

	if (!refreshed?.apiKey) {
		if (fallbackToken) return fallbackToken;
		throw new Error(`No OAuth credentials available for provider '${provider}'`);
	}

	const mergedCred = { type: "oauth", ...(entry || {}), ...(refreshed.newCredentials || {}) };
	auth[provider] = mergedCred;
	writeJson(authPath, auth);

	return {
		apiKey: refreshed.apiKey,
		accountId: mergedCred.accountId,
	};
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.query) {
		console.error(usage());
		process.exit(args.help ? 0 : 1);
	}

	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const settingsPath = join(agentDir, "settings.json");
	const auth = readJson(authPath, {});
	const settings = readJson(settingsPath, {});

	const provider = pickProvider(args.provider, settings, auth);
	const piAi = await loadPiAi();
	const model = pickFastModel(provider, args.model, piAi);
	const { apiKey, accountId } = await resolveApiKey(provider, auth, authPath, piAi);

	const text =
		provider === "openai-codex"
			? await runCodexSearch({
					model: model.id,
					apiKey,
					accountId,
					query: args.query,
					purpose: args.purpose,
					timeoutMs: args.timeoutMs,
					baseUrl: model.baseUrl,
			  })
			: await runAnthropicSearch({
					model: model.id,
					apiKey,
					query: args.query,
					purpose: args.purpose,
					timeoutMs: args.timeoutMs,
			  });

	if (args.json) {
		console.log(
			JSON.stringify(
				{
					provider,
					model: model.id,
					query: args.query,
					purpose: args.purpose,
					result: text,
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(`Provider: ${provider}`);
	console.log(`Model: ${model.id}`);
	console.log("");
	console.log(text);
}

main().catch((err) => {
	console.error(`Error: ${err?.message || err}`);
	process.exit(1);
});
