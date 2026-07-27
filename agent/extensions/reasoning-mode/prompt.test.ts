import assert from "node:assert/strict";
import test from "node:test";
import { reasoningModePrompt } from "./prompt.ts";

test("Reasoning Mode prompt keeps invariants and adds an evidence-driven reasoning protocol", () => {
	const prompt = reasoningModePrompt("plan");
	assert.match(prompt, /explicit read-only reasoning mode using the plan skill/);
	assert.match(prompt, /active reasoning skill specializes this protocol; it does not replace or relax/);
	assert.match(prompt, /Reasoning Mode takes precedence/);
	assert.match(prompt, /Match the depth of analysis to the complexity, uncertainty, and risk/);
	assert.match(prompt, /Gather enough repository evidence before reaching conclusions/);
	assert.match(prompt, /Consider multiple plausible hypotheses or approaches/);
	assert.match(prompt, /Distinguish confirmed facts, inferences, assumptions, recommendations, and unresolved questions/);
	assert.match(prompt, /Do not rush to a final recommendation while material uncertainty remains/);
	assert.match(prompt, /do not expose hidden chain-of-thought/);
});
