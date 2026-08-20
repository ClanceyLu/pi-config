import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";
import { reasoningModePrompt } from "./prompt.ts";
import { PLAN_READY_MARKER } from "./types.ts";

test("Reasoning Mode prompt keeps only mode-wide invariants and common requirements", () => {
	const prompt = reasoningModePrompt("plan");
	assert.match(prompt, /explicit read-only reasoning mode using the plan skill/);
	assert.match(prompt, /active reasoning skill specializes the reasoning workflow; it does not replace or relax/);
	assert.match(prompt, /Reasoning Mode takes precedence/);
	assert.match(prompt, /normal user request to implement, execute, approve, or proceed does not leave/);
	assert.match(prompt, /\/plan approve while the plan skill is active/);
	assert.match(prompt, /Ground conclusions in available evidence/);
	assert.match(prompt, /without exposing hidden chain-of-thought/);
	assert.doesNotMatch(prompt, /Do not rush to a final recommendation/);
	assert.doesNotMatch(prompt, /Consider multiple plausible hypotheses or approaches/);
});

test("plan skill uses submit_plan in TUI with a complete Markdown fallback", async () => {
	const skill = await fs.readFile(new URL("../../skills/plan/SKILL.md", import.meta.url), "utf8");
	assert.match(skill, /When the `submit_plan` tool is available/);
	assert.match(skill, /Pass the complete current Markdown plan/);
	assert.match(skill, /Never pass a partial update, change summary, or diff/);
	assert.match(skill, /Keep the final plan concise and execution-focused/);
	assert.match(skill, /do not create separate sections for them by default/);
	assert.match(skill, /When `submit_plan` is unavailable, return the complete plan directly/);
	assert.match(skill, /Do not call `submit_plan` or emit the marker while asking clarifying questions/);
	assert.ok(skill.includes(PLAN_READY_MARKER));
});
