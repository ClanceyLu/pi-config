import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

let agentDir: string;
const hooks = registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@earendil-works/pi-coding-agent") {
			return { url: "data:text/javascript,export default {}", shortCircuit: true };
		}
		return next(specifier, context);
	},
});
mock.module("@earendil-works/pi-coding-agent", { namedExports: { getAgentDir: () => agentDir } });
const { default: openaiFast } = await import("../openai-fast.ts");
hooks.deregister();

for (const model of [
	{ provider: "magpie", id: "codex/gpt-6.1-sol" },
	{ provider: "magpie", id: "codex/gpt-6-astra" },
	{ provider: "openai-codex", id: "gpt-5.6-sol" },
]) {
	test(`fast mode persistence and model isolation for ${model.provider}/${model.id}`, async (t) => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-fast-"));
		t.after(() => rmSync(agentDir, { recursive: true, force: true }));
		const handlers = new Map<string, (event: { payload?: unknown }, ctx: ExtensionContext) => unknown>();
		let command!: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
		let status: string | undefined;
		const notifications: string[] = [];
		const ctx = {
			model,
			ui: {
				setStatus: (_key: string, value: string | undefined) => { status = value; },
				notify: (message: string) => notifications.push(message),
			},
		} as unknown as ExtensionCommandContext;
		const setup = () => openaiFast({
			on: (event: string, handler: typeof handlers extends Map<string, infer H> ? H : never) => handlers.set(event, handler),
			registerCommand: (_name: string, options: typeof command) => { command = options; },
		} as unknown as ExtensionAPI);
		setup();
		const emit = (event: string, payload?: unknown) => handlers.get(event)!({ payload }, ctx);
		const payload = { model: model.id, input: [] };

		emit("session_start");
		assert.equal(emit("before_provider_request", payload), undefined);
		await command.handler("on", ctx);
		assert.equal(status, "fast");
		assert.deepEqual(emit("before_provider_request", payload), { ...payload, service_tier: "priority" });
		assert.equal("service_tier" in payload, false);

		ctx.model = { ...ctx.model!, provider: "other" };
		emit("model_select");
		assert.equal(status, undefined);
		assert.equal(emit("before_provider_request", payload), undefined);
		await command.handler("on", ctx);
		assert.match(notifications.at(-1)!, /not configured/);

		ctx.model = { ...ctx.model!, ...model };
		emit("model_select");
		assert.equal(status, "fast");
		await command.handler("off", ctx);
		assert.equal(status, undefined);
		assert.equal(emit("before_provider_request", payload), undefined);

		await command.handler("", ctx);
		assert.equal(status, "fast");
		emit("session_start");
		assert.equal(status, "fast");
		setup();
		emit("session_start");
		assert.equal(status, "fast");
		assert.deepEqual(emit("before_provider_request", payload), { ...payload, service_tier: "priority" });

		const file = join(agentDir, "fast-settings.json");
		const saved = readFileSync(file, "utf8");
		assert.equal(JSON.parse(saved).enabled, true);
		await command.handler("status", ctx);
		await command.handler("invalid", ctx);
		assert.equal(readFileSync(file, "utf8"), saved);

		// Another Pi instance changes the shared preference between requests.
		writeFileSync(file, JSON.stringify({ enabled: false }));
		assert.equal(emit("before_provider_request", payload), undefined);
		assert.equal(status, undefined);
		await command.handler("", ctx);
		assert.equal(JSON.parse(readFileSync(file, "utf8")).enabled, true);
		await command.handler("off", ctx);
		setup();
		emit("session_start");
		assert.equal(status, undefined);
		assert.equal(emit("before_provider_request", payload), undefined);

		writeFileSync(file, '{"enabled":"false"}');
		emit("session_start");
		assert.equal(status, undefined);
		assert.match(notifications.at(-1)!, /Could not read/);
		assert.equal(emit("before_provider_request", payload), undefined);

		await command.handler("on", ctx);
		rmSync(file);
		mkdirSync(file);
		await command.handler("off", ctx);
		assert.match(notifications.at(-1)!, /Could not save/);
		rmSync(file, { recursive: true });
		writeFileSync(file, saved);
		assert.deepEqual(emit("before_provider_request", payload), { ...payload, service_tier: "priority" });
	});
}
