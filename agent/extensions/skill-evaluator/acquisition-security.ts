import type { LookupAddress } from "node:dns";
import { promises as fs } from "node:fs";
import type { RequestOptions } from "node:https";
import * as path from "node:path";

const MAX_DISCOVERED_FILES = 20_000;
const MAX_SKILLS = 100;

export interface GitHubLocation {
	cloneUrl: string;
	repositoryUrl: string;
	ref?: string;
	subpath?: string;
}

export function parseGitHubLocation(input: string): GitHubLocation | undefined {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return undefined;
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length < 2) return undefined;
	const owner = segments[0];
	const repo = segments[1].replace(/\.git$/, "");
	if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return undefined;
	let ref: string | undefined;
	let subpath: string | undefined;
	if ((segments[2] === "tree" || segments[2] === "blob") && segments[3]) {
		ref = decodeURIComponent(segments[3]);
		subpath = segments.slice(4).map(decodeURIComponent).join("/") || undefined;
	}
	const repositoryUrl = `https://github.com/${owner}/${repo}`;
	return { cloneUrl: `${repositoryUrl}.git`, repositoryUrl, ref, subpath };
}

export function pinnedLookup(addresses: LookupAddress[]): NonNullable<RequestOptions["lookup"]> {
	return ((_hostname: string, options: any, callback: any) => {
		if (options?.all === true) callback(null, addresses);
		else callback(null, addresses[0].address, addresses[0].family);
	}) as NonNullable<RequestOptions["lookup"]>;
}

export async function assertRepositoryHasNoSymlinks(root: string): Promise<void> {
	let visited = 0;
	const visit = async (dir: string): Promise<void> => {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			if (++visited > MAX_DISCOVERED_FILES) throw new Error("Repository is too large to scan safely for symlinks.");
			if (entry.name === ".git") continue;
			const target = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in a Skill repository: ${target}`);
			if (entry.isDirectory()) await visit(target);
		}
	};
	await visit(root);
}

export async function findSkillFiles(root: string): Promise<string[]> {
	const found: string[] = [];
	let visited = 0;
	const visit = async (dir: string): Promise<void> => {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (++visited > MAX_DISCOVERED_FILES) throw new Error("Repository is too large to scan safely for Skills.");
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			const target = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in discovered Skill paths: ${target}`);
			if (entry.isDirectory()) await visit(target);
			else if (entry.isFile() && entry.name === "SKILL.md") {
				found.push(target);
				if (found.length > MAX_SKILLS) throw new Error(`Repository contains more than ${MAX_SKILLS} Skills.`);
			}
		}
	};
	await visit(root);
	return found.sort();
}
