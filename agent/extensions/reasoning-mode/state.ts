import { INITIAL_STATE, type ReasoningModeState } from "./types.ts";

export const STATE_ENTRY_TYPE = "reasoning-mode-state-v1";
export const LEGACY_STATE_ENTRY_TYPE = "plan-mode-state-v1";

function uniqueStrings(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return [...new Set(value.filter((item): item is string => typeof item === "string"))];
}

export function normalizeState(value: unknown): ReasoningModeState {
	if (!value || typeof value !== "object") return structuredClone(INITIAL_STATE);
	const record = value as Record<string, unknown>;
	const mode = record.mode === "reasoning" ? "reasoning" : "off";
	const activeSkill = mode === "reasoning" && typeof record.activeSkill === "string" && record.activeSkill.trim()
		? record.activeSkill.trim()
		: undefined;
	return {
		version: 1,
		mode,
		activeSkill,
		toolsBeforeReasoning: mode === "reasoning" ? uniqueStrings(record.toolsBeforeReasoning) : undefined,
	};
}

/** Safely maps the old Plan Mode state. Execution is never resumed. */
export function migrateLegacyState(value: unknown): ReasoningModeState {
	if (!value || typeof value !== "object") return structuredClone(INITIAL_STATE);
	const record = value as Record<string, unknown>;
	if (record.phase !== "planning" && record.phase !== "awaiting_approval") {
		return structuredClone(INITIAL_STATE);
	}
	return {
		version: 1,
		mode: "reasoning",
		activeSkill: "plan",
		toolsBeforeReasoning: uniqueStrings(record.toolsBeforePlan),
	};
}
