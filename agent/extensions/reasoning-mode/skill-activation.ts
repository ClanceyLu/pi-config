import { promises as fs } from "node:fs";
import path from "node:path";
import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface SkillReference {
	name: string;
	filePath: string;
	baseDir: string;
}

export interface ActiveReasoningSkill extends SkillReference {
	body: string;
}

function frontmatter(content: string): string | undefined {
	return content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
}

function stripFrontmatter(content: string): string {
	return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
}

function isReasoningSkill(content: string): boolean {
	const header = frontmatter(content);
	if (!header) return false;
	const metadata = header.match(/^metadata:\s*\r?\n((?:^[ \t]+.*(?:\r?\n|$))*)/m)?.[1];
	return metadata ? /^[ \t]+reasoning-mode:\s*(?:true|"true"|'true')\s*$/m.test(metadata) : false;
}

async function load(reference: SkillReference): Promise<ActiveReasoningSkill | undefined> {
	const content = await fs.readFile(reference.filePath, "utf8");
	if (!isReasoningSkill(content)) return undefined;
	return { ...reference, body: stripFrontmatter(content) };
}

export async function resolveReasoningSkill(
	options: BuildSystemPromptOptions,
	name: string,
): Promise<ActiveReasoningSkill | undefined> {
	const skill = options.skills?.find((candidate) => candidate.name === name);
	return skill ? load({ name: skill.name, filePath: skill.filePath, baseDir: skill.baseDir }) : undefined;
}

export async function resolveReasoningSkillFromCommands(
	pi: ExtensionAPI,
	name: string,
): Promise<ActiveReasoningSkill | undefined> {
	const command = pi.getCommands().find((candidate) => candidate.source === "skill" && candidate.name === `skill:${name}`);
	if (!command) return undefined;
	const filePath = command.sourceInfo.path;
	return load({ name, filePath, baseDir: command.sourceInfo.baseDir ?? path.dirname(filePath) });
}

export function formatReasoningSkill(skill: ActiveReasoningSkill): string {
	return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${skill.body}\n</skill>`;
}
