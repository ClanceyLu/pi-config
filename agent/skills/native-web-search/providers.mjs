function buildUserPrompt(query, purpose) {
	return `Search the internet for: ${query}\n\nPurpose: ${purpose}\n\nReturn a concise research summary with:\n- 3 to 7 key findings\n- for every finding: title, why it matters for this purpose, and a full canonical URL (https://...)\n- if multiple sources disagree, call that out\n- finish with a short recommendation on which source(s) to trust first.`;
}

function buildSystemPrompt() {
	return "You are a fast web research assistant. Always produce practical summaries and include full source URLs (no shortened links).";
}

function decodeJwtAccountId(jwt) {
	if (!jwt || typeof jwt !== "string") return undefined;
	try {
		const parts = jwt.split(".");
		if (parts.length !== 3) return undefined;
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
	} catch (error) {
		throw new Error(`Failed to decode the OpenAI account ID: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function resolveCodexUrl(baseUrl = "https://chatgpt.com/backend-api") {
	const normalized = String(baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function extractEventData(chunk) {
	const payload = chunk
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("\n")
		.trim();
	if (!payload || payload === "[DONE]") return null;
	return payload;
}

function applyCodexEvent(event, output) {
	if (event.type === "response.output_text.delta" && typeof event.delta === "string") output.text += event.delta;
	if (event.type === "response.output_item.done" && event.item?.type === "message") {
		const parts = Array.isArray(event.item.content) ? event.item.content : [];
		const full = parts
			.filter((part) => part.type === "output_text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
		if (full) output.fallbackText = full;
	}
	if (event.type === "error") throw new Error(event.message || "Codex stream failed");
	if (event.type === "response.failed") throw new Error(event.response?.error?.message || "Codex response failed");
}

export async function readCodexStream(body) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const output = { text: "", fallbackText: "" };
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			buffer += decoder.decode();
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		let match;
		while ((match = buffer.match(/\r?\n\r?\n/))) {
			const index = match.index ?? 0;
			const chunk = buffer.slice(0, index);
			buffer = buffer.slice(index + match[0].length);
			const data = extractEventData(chunk);
			if (!data) continue;
			let event;
			try {
				event = JSON.parse(data);
			} catch (error) {
				throw new Error(`Invalid JSON in Codex stream event: ${error instanceof Error ? error.message : String(error)}`);
			}
			applyCodexEvent(event, output);
		}
	}
	if (buffer.trim()) {
		const data = extractEventData(buffer);
		if (data) {
			try {
				applyCodexEvent(JSON.parse(data), output);
			} catch (error) {
				throw new Error(`Invalid final Codex stream event: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	const result = (output.fallbackText || output.text).trim();
	if (!result) throw new Error("Codex returned an empty response");
	return result;
}

export async function runCodexSearch({ model, apiKey, accountId, query, purpose, timeoutMs, baseUrl }) {
	const tokenAccountId = accountId || decodeJwtAccountId(apiKey);
	if (!tokenAccountId) throw new Error("Could not determine ChatGPT account ID for openai-codex token.");
	const signal = AbortSignal.timeout(timeoutMs);
	const response = await fetch(resolveCodexUrl(baseUrl), {
		method: "POST",
		headers: {
			authorization: `Bearer ${apiKey}`,
			"chatgpt-account-id": tokenAccountId,
			"content-type": "application/json",
			accept: "text/event-stream",
			"OpenAI-Beta": "responses=experimental",
			originator: "pi-native-web-search-skill",
		},
		body: JSON.stringify({
			model,
			store: false,
			stream: true,
			instructions: buildSystemPrompt(),
			input: [{ role: "user", content: buildUserPrompt(query, purpose) }],
			tools: [{ type: "web_search" }],
			tool_choice: "auto",
		}),
		signal,
	});
	if (!response.ok) throw new Error(`Codex request failed (${response.status}): ${await response.text()}`);
	if (!response.body) throw new Error("Codex response had no body");
	return readCodexStream(response.body);
}

function buildAnthropicHeaders(apiKey) {
	if (typeof apiKey === "string" && apiKey.includes("sk-ant-oat")) {
		return {
			authorization: `Bearer ${apiKey}`,
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "claude-code-20250219,oauth-2025-04-20,web-search-2025-03-05",
			"content-type": "application/json",
			accept: "application/json",
			"x-app": "cli",
			"user-agent": "claude-cli/1.0.72 (external, cli)",
		};
	}
	return {
		"x-api-key": apiKey,
		"anthropic-version": "2023-06-01",
		"anthropic-beta": "web-search-2025-03-05",
		"content-type": "application/json",
		accept: "application/json",
	};
}

export async function runAnthropicSearch({ model, apiKey, query, purpose, timeoutMs }) {
	const response = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: buildAnthropicHeaders(apiKey),
		body: JSON.stringify({
			model,
			max_tokens: 1800,
			temperature: 0,
			system: buildSystemPrompt(),
			tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
			messages: [{ role: "user", content: buildUserPrompt(query, purpose) }],
		}),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const payload = await response.text();
	if (!response.ok) throw new Error(`Anthropic request failed (${response.status}): ${payload}`);
	let parsed;
	try {
		parsed = JSON.parse(payload);
	} catch (error) {
		throw new Error(`Anthropic returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const text = (parsed.content || [])
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n\n")
		.trim();
	if (!text) throw new Error("Anthropic returned no text content");
	return text;
}
