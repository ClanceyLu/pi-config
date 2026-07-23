import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SkillTarget } from "./types.ts";

interface SkillFrontmatter extends Record<string, unknown> {
	name?: string;
	description?: string;
}

export async function loadSkillTarget(inputPath: string, cwd: string): Promise<SkillTarget> {
	let candidate = path.resolve(cwd, inputPath.replace(/^~/, process.env.HOME ?? "~"));
	const stat = await fs.stat(candidate);
	if (stat.isDirectory()) candidate = path.join(candidate, "SKILL.md");
	const canonical = await fs.realpath(candidate);
	const fileStat = await fs.stat(canonical);
	if (!fileStat.isFile()) throw new Error(`Skill path is not a file: ${canonical}`);
	const content = await fs.readFile(canonical, "utf8");
	const { frontmatter } = parseFrontmatter<SkillFrontmatter>(content);
	const name = frontmatter.name?.trim();
	const description = frontmatter.description?.trim();
	if (!name) throw new Error("Skill frontmatter is missing name.");
	if (!description) throw new Error("Skill frontmatter is missing description; Pi will not load it.");
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
		throw new Error(`Skill name cannot be safely invoked as /skill:<name>: ${name}`);
	}
	return {
		name,
		description,
		skillFile: canonical,
		baseDir: path.dirname(canonical),
		content,
	};
}
