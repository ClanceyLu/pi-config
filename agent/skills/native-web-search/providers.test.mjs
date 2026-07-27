import assert from "node:assert/strict";
import test from "node:test";
import { readCodexStream } from "./providers.mjs";

function stream(text) {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

test("Codex stream returns the complete final message", async () => {
	const body = stream([
		'data: {"type":"response.output_text.delta","delta":"partial"}',
		'',
		'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"complete"}]}}',
		'',
	].join("\n"));
	assert.equal(await readCodexStream(body), "complete");
});

test("Codex stream rejects malformed JSON instead of returning partial output", async () => {
	const body = stream('data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: {broken}\n\n');
	await assert.rejects(readCodexStream(body), /Invalid JSON in Codex stream event/);
});
