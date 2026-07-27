import assert from "node:assert/strict";
import test from "node:test";
import { reasoningModePrompt } from "./prompt.ts";

test("Reasoning Mode prompt keeps only mode-wide invariants and common requirements", () => {
	const prompt = reasoningModePrompt("plan");
	assert.match(prompt, /explicit read-only reasoning mode using the plan skill/);
	assert.match(prompt, /active reasoning skill specializes the reasoning workflow; it does not replace or relax/);
	assert.match(prompt, /Reasoning Mode takes precedence/);
	assert.match(prompt, /Ground conclusions in available evidence/);
	assert.match(prompt, /without exposing hidden chain-of-thought/);
	assert.doesNotMatch(prompt, /Do not rush to a final recommendation/);
	assert.doesNotMatch(prompt, /Consider multiple plausible hypotheses or approaches/);
});
