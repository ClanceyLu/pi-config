import { execFile } from "node:child_process";
import { promises as dns, type LookupAddress } from "node:dns";
import { promises as fs } from "node:fs";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { assertRepositoryHasNoSymlinks, findSkillFiles, parseGitHubLocation, pinnedLookup } from "./acquisition-security.ts";
import { loadSkillTarget } from "./skill.ts";
import type { SkillTarget } from "./types.ts";

export { parseGitHubLocation } from "./acquisition-security.ts";

const execFileAsync = promisify(execFile);
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface AcquiredSkillSource {
	candidates: SkillTarget[];
	source: string;
	resolvedSource: string;
	temporary: true;
	cleanup(): Promise<void>;
}

export interface AcquisitionOptions {
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}

export interface WebDocument {
	url: string;
	contentType: string;
	text: string;
}

function isPrivateAddress(address: string): boolean {
	if (net.isIPv4(address)) {
		const [a, b] = address.split(".").map(Number);
		return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
	}
	if (net.isIPv6(address)) {
		const value = address.toLowerCase();
		const dottedMapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
		if (dottedMapped) return isPrivateAddress(dottedMapped);
		const hexMapped = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
		if (hexMapped) {
			const numeric = (Number.parseInt(hexMapped[1], 16) << 16) | Number.parseInt(hexMapped[2], 16);
			return isPrivateAddress([numeric >>> 24, (numeric >>> 16) & 255, (numeric >>> 8) & 255, numeric & 255].join("."));
		}
		return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("ff") ||
			value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb");
	}
	return true;
}

interface PinnedDestination {
	url: URL;
	addresses: LookupAddress[];
}

async function resolvePublicHttpsUrl(input: string): Promise<PinnedDestination> {
	const url = new URL(input);
	if (url.protocol !== "https:") throw new Error("Only HTTPS URLs are allowed.");
	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
		throw new Error("Local URL hosts are not allowed.");
	}
	const addresses = net.isIP(hostname)
		? [{ address: hostname, family: net.isIPv4(hostname) ? 4 : 6 } as LookupAddress]
		: await dns.lookup(hostname, { all: true, verbatim: true });
	if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
		throw new Error("URL host resolves to a private or unavailable address.");
	}
	return { url, addresses };
}

function combineSignals(signals: AbortSignal[]): AbortSignal {
	const controller = new AbortController();
	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort(signal.reason);
			break;
		}
		signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
	}
	return controller.signal;
}

async function requestPinnedDocument(destination: PinnedDestination, signal?: AbortSignal): Promise<{
	status: number;
	location?: string;
	contentType: string;
	text: string;
}> {
	const requestSignal = combineSignals([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]);
	return new Promise((resolve, reject) => {
		const request = https.request(destination.url, {
			method: "GET",
			lookup: pinnedLookup(destination.addresses),
			servername: destination.url.hostname,
			signal: requestSignal,
			headers: { "user-agent": "pi-skill-evaluator/2", "accept-encoding": "identity" },
		}, (response) => {
			const status = response.statusCode ?? 0;
			const location = response.headers.location;
			const contentType = String(response.headers["content-type"] ?? "");
			if (status >= 300 && status < 400) {
				response.resume();
				resolve({ status, location, contentType, text: "" });
				return;
			}
			if (status < 200 || status >= 300) {
				response.resume();
				reject(new Error(`Failed to read URL: HTTP ${status}`));
				return;
			}
			const declaredLength = Number(response.headers["content-length"] ?? 0);
			if (declaredLength > MAX_DOWNLOAD_BYTES) {
				response.destroy(new Error("Document is larger than 2MB."));
				return;
			}
			const chunks: Buffer[] = [];
			let total = 0;
			response.on("data", (chunk: Buffer) => {
				total += chunk.length;
				if (total > MAX_DOWNLOAD_BYTES) response.destroy(new Error("Document is larger than 2MB."));
				else chunks.push(chunk);
			});
			response.on("end", () => resolve({ status, contentType, text: Buffer.concat(chunks).toString("utf8") }));
			response.on("error", reject);
		});
		request.on("error", reject);
		request.end();
	});
}

export async function readWebDocument(input: string, options: AcquisitionOptions = {}): Promise<WebDocument> {
	let current = input;
	for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
		const destination = await resolvePublicHttpsUrl(current);
		options.onProgress?.(`reading ${destination.url}`);
		const response = await requestPinnedDocument(destination, options.signal);
		if (response.status >= 300 && response.status < 400) {
			if (!response.location) throw new Error(`Redirect from ${destination.url} has no Location header.`);
			current = new URL(response.location, destination.url).toString();
			continue;
		}
		return { url: destination.url.toString(), contentType: response.contentType, text: response.text };
	}
	throw new Error(`URL redirected more than ${MAX_REDIRECTS} times.`);
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function containedRealPath(root: string, candidate: string): Promise<string> {
	const [realRoot, realCandidate] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
	if (!isInside(realRoot, realCandidate)) throw new Error(`Skill path escapes the cloned repository: ${candidate}`);
	return realCandidate;
}

async function loadCandidates(paths: string[], allowedRoot: string): Promise<SkillTarget[]> {
	if (paths.length === 0) throw new Error("No SKILL.md was found in the temporary source.");
	const candidates: SkillTarget[] = [];
	for (const skillPath of paths) {
		const canonical = await containedRealPath(allowedRoot, skillPath);
		const stat = await fs.lstat(canonical);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Skill candidate is not a regular file: ${skillPath}`);
		candidates.push(await loadSkillTarget(canonical, allowedRoot));
	}
	return candidates;
}

async function removeAfterFailure(tempRoot: string, original: unknown): Promise<never> {
	try {
		await fs.rm(tempRoot, { recursive: true, force: true });
	} catch (cleanupError) {
		throw new AggregateError([original, cleanupError], "Skill acquisition and temporary-directory cleanup both failed.");
	}
	throw original;
}

export async function acquireGitHubSkill(input: string, options: AcquisitionOptions = {}): Promise<AcquiredSkillSource> {
	const location = parseGitHubLocation(input);
	if (!location) throw new Error("The Agent-declared GitHub source is not a supported HTTPS GitHub URL.");
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-skill-eval-source-"));
	const checkout = path.join(tempRoot, "repository");
	try {
		await fs.chmod(tempRoot, 0o700);
		options.onProgress?.(`temporarily cloning ${location.repositoryUrl}`);
		const args = ["clone", "--depth", "1"];
		if (location.ref) args.push("--branch", location.ref);
		args.push("--", location.cloneUrl, checkout);
		await execFileAsync("git", args, {
			encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 120_000, signal: options.signal,
		});
		await assertRepositoryHasNoSymlinks(checkout);
		let searchRoot = checkout;
		if (location.subpath) {
			const lexical = path.resolve(checkout, location.subpath);
			if (!isInside(checkout, lexical)) throw new Error("GitHub subpath escapes the checkout.");
			searchRoot = await containedRealPath(checkout, lexical);
		}
		const stat = await fs.lstat(searchRoot);
		if (stat.isSymbolicLink()) throw new Error(`GitHub Skill path is a symlink: ${location.subpath}`);
		const files = stat.isFile() ? [searchRoot] : await findSkillFiles(searchRoot);
		return {
			candidates: await loadCandidates(files, checkout), source: input, resolvedSource: input, temporary: true,
			cleanup: () => fs.rm(tempRoot, { recursive: true, force: true }),
		};
	} catch (error) {
		return removeAfterFailure(tempRoot, error);
	}
}

export async function acquireDirectSkillUrl(input: string, options: AcquisitionOptions = {}): Promise<AcquiredSkillSource> {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-skill-eval-source-"));
	try {
		await fs.chmod(tempRoot, 0o700);
		const document = await readWebDocument(input, options);
		const dir = path.join(tempRoot, "skill");
		await fs.mkdir(dir, { mode: 0o700 });
		const skillFile = path.join(dir, "SKILL.md");
		await fs.writeFile(skillFile, document.text, { mode: 0o600 });
		return {
			candidates: await loadCandidates([skillFile], tempRoot), source: input, resolvedSource: document.url, temporary: true,
			cleanup: () => fs.rm(tempRoot, { recursive: true, force: true }),
		};
	} catch (error) {
		return removeAfterFailure(tempRoot, error);
	}
}
