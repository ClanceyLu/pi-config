import readline from "node:readline";

if (process.env.FAKE_RPC_INVALID === "1") {
	process.stdout.write("not-json\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
	if (!line.trim()) continue;
	const command = JSON.parse(line);
	const respond = (data = undefined) => {
		process.stdout.write(`${JSON.stringify({
			id: command.id,
			type: "response",
			command: command.type,
			success: true,
			...(data === undefined ? {} : { data }),
		})}\n`);
	};
	switch (command.type) {
		case "get_commands":
			respond({ commands: [] });
			break;
		case "get_state":
			if (process.env.FAKE_RPC_CLOSE_PENDING === "1") process.exit(0);
			respond({ model: { provider: "fake", id: "model" }, thinkingLevel: "low" });
			break;
		case "prompt":
			respond();
			process.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "x" } })}\n`);
			process.stdout.write(`${JSON.stringify({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: { content: [] }, isError: false })}\n`);
			for (let index = 0; index < Number(process.env.FAKE_RPC_UPDATES ?? 0); index++) {
				process.stdout.write(`${JSON.stringify({ type: "message_update", index, delta: "x".repeat(1024) })}\n`);
			}
			const stopReason = process.env.FAKE_RPC_STOP_REASON;
			process.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fake answer" }], ...(stopReason ? { stopReason, errorMessage: `fake ${stopReason}` } : {}) } })}\n`);
			process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
			break;
		case "get_last_assistant_text":
			respond({ text: "fake answer" });
			break;
		case "get_session_stats":
			respond({
				tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 },
				cost: 0.01,
				toolCalls: 1,
				assistantMessages: 1,
			});
			break;
		case "abort":
			respond();
			break;
		default:
			process.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "unknown" })}\n`);
	}
}
