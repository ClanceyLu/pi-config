import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface Workspace { id: string; name: string }
export interface Project { id: string; workspace_id: string; title: string }
export interface Target extends Project {
	workspaceName: string;
	profile: string;
	serverUrl?: string;
	cwd: string;
}
export interface ModeState {
	enabled: boolean;
	target?: Target;
	issue?: string;
	waitingFor?: string;
}
export interface Candidate { target: Target; score: number; reason: string }
export interface ExecResult { stdout: string; stderr: string; code: number; killed: boolean }
export type Execute = (command: string, args: string[], signal?: AbortSignal) => Promise<ExecResult>;
export type Row = Record<string, any>;

export function cleanText(value: unknown): string {
	return String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}
export function canonicalPath(path: string): string {
	try { return realpathSync(path); } catch { return resolve(path); }
}
export function containsPath(parent: string, child: string): boolean {
	const rel = relative(canonicalPath(parent), canonicalPath(child));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
export function repoKey(value: string): string | undefined {
	try {
		const url = new URL(value.replace(/^([^/@]+)@([^/:]+):(.+)$/, "ssh://$1@$2/$3"));
		if (!["ssh:", "https:", "http:", "git:"].includes(url.protocol)) return;
		return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}${url.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "")}`;
	} catch { return; }
}
function checkedUrl(value: unknown): string | undefined {
	if (value === undefined || value === "") return;
	if (typeof value !== "string") throw new Error("Multica 服务地址格式无效");
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new Error("Multica 服务地址必须是不含凭据的 HTTP(S) 地址");
	}
	return value.replace(/\/$/, "");
}
export function restoreState(value: unknown, cwd: string, profile: string, serverUrl?: string): ModeState {
	if (!value || typeof value !== "object") return { enabled: false };
	const state = value as ModeState;
	const result: ModeState = { enabled: state.enabled === true };
	const t = state.target;
	if (!t || t.profile !== profile || t.cwd !== canonicalPath(cwd) ||
		[ t.id, t.workspace_id, t.title, t.workspaceName ].some(v => typeof v !== "string" || !v) ||
		(t.serverUrl !== undefined && typeof t.serverUrl !== "string")) return result;
	try {
		checkedUrl(t.serverUrl);
		if (serverUrl && checkedUrl(serverUrl) !== t.serverUrl) return result;
	} catch { return result; }
	result.target = { ...t };
	if (typeof state.issue === "string" && state.issue) result.issue = state.issue;
	if (typeof state.waitingFor === "string" && state.waitingFor) result.waitingFor = state.waitingFor;
	return result;
}

export class MulticaClient {
	serverUrl?: string;
	readonly execute: Execute;
	readonly profile: string;
	constructor(execute: Execute, profile = "", serverUrl?: string) {
		this.execute = execute;
		this.profile = profile;
		this.serverUrl = checkedUrl(serverUrl);
	}
	async read(args: string[], workspace?: string, signal?: AbortSignal): Promise<any> {
		const flags = ["--output", "json"];
		if (this.profile) flags.push("--profile", this.profile);
		if (this.serverUrl) flags.push("--server-url", this.serverUrl);
		if (workspace) flags.push("--workspace-id", workspace);
		const result = await this.execute("multica", [...args, ...flags], signal);
		if (result.code !== 0 || result.killed) {
			throw new Error(cleanText(result.stderr || result.stdout || "Multica 读取失败").slice(0, 1200));
		}
		try { return JSON.parse(result.stdout); }
		catch { throw new Error("Multica 未返回有效 JSON；请检查 CLI 版本和登录状态"); }
	}
	async machine(signal?: AbortSignal): Promise<Row> {
		const daemon = await this.read(["daemon", "status"], undefined, signal);
		if (!this.serverUrl && daemon.server_url) this.serverUrl = checkedUrl(daemon.server_url);
		return daemon;
	}
	async verify(target: Target, signal?: AbortSignal): Promise<Target> {
		if (target.profile !== this.profile || (this.serverUrl && target.serverUrl !== this.serverUrl)) {
			throw new Error("Multica 服务或 profile 已变化，请重新选择项目");
		}
		const project = await this.read(["project", "get", target.id], target.workspace_id, signal);
		if (project.id !== target.id || project.workspace_id !== target.workspace_id || typeof project.title !== "string") {
			throw new Error("项目与已确认 workspace 不匹配，请重新选择");
		}
		return { ...target, title: project.title };
	}
	async discover(cwd: string, signal?: AbortSignal): Promise<Candidate[]> {
		let daemon: Row = {};
		try { daemon = await this.machine(signal); }
		catch (error) { if (signal?.aborted) throw error; }
		const workspaces = await this.read(["workspace", "list"], undefined, signal);
		if (!Array.isArray(workspaces)) throw new Error("工作区列表格式无效");
		const git = await this.execute("git", ["remote", "get-url", "origin"], signal);
		const remote = git.code === 0 ? repoKey(git.stdout.trim()) : undefined;
		const candidates: Candidate[] = [];
		for (const workspace of workspaces as Workspace[]) {
			if (!workspace.id || typeof workspace.name !== "string") throw new Error("工作区格式无效");
			const projects = await this.read(["project", "list"], workspace.id, signal);
			if (!Array.isArray(projects)) throw new Error("项目列表格式无效");
			for (const project of projects as Project[]) {
				if (project.workspace_id !== workspace.id || !project.id || typeof project.title !== "string") {
					throw new Error("项目归属格式无效");
				}
				const resources = await this.read(["project", "resource", "list", project.id], workspace.id, signal);
				if (!Array.isArray(resources)) throw new Error("项目资源格式无效");
				let score = 0, reason = "手动选择";
				for (const resource of resources) {
					const ref = resource.resource_ref ?? {};
					if (resource.resource_type === "local_directory" && daemon.daemon_id && ref.daemon_id === daemon.daemon_id &&
						typeof ref.local_path === "string" && isAbsolute(ref.local_path) && containsPath(ref.local_path, cwd)) {
						const localScore = 1000 + canonicalPath(ref.local_path).length;
						if (localScore > score) { score = localScore; reason = `本机目录 ${ref.local_path}`; }
					} else if (resource.resource_type === "github_repo" && remote && typeof ref.url === "string" && repoKey(ref.url) === remote && score < 1) {
						score = 1; reason = "仓库匹配";
					}
				}
				candidates.push({ target: { id: project.id, workspace_id: workspace.id, title: project.title,
					workspaceName: workspace.name, cwd: canonicalPath(cwd), profile: this.profile, serverUrl: this.serverUrl }, score, reason });
			}
		}
		return candidates.sort((a, b) => b.score - a.score);
	}
	async overview(target: Target, issueId?: string, signal?: AbortSignal): Promise<Row> {
		const verified = await this.verify(target, signal);
		const page = await this.read(["issue", "list", "--project", target.id, "--limit", "100", "--sort", "created_at", "--direction", "desc",
			"--fields", "id,workspace_id,project_id,identifier,title,status,assignee_type,assignee_id,labels"], target.workspace_id, signal);
		if (!Array.isArray(page.issues) || typeof page.has_more !== "boolean") throw new Error("Issue 列表格式无效");
		if (page.issues.some((i: Row) => i.workspace_id !== target.workspace_id || i.project_id !== target.id)) {
			throw new Error("Issue 列表包含其他项目数据");
		}
		const result: Row = { target: verified, fetchedAt: new Date().toISOString(), issues: page.issues, hasMore: page.has_more, total: page.total };
		if (issueId) {
			const issue = await this.read(["issue", "get", issueId], target.workspace_id, signal);
			if (issue.workspace_id !== target.workspace_id || issue.project_id !== target.id) throw new Error("该 issue 不属于当前项目");
			const comments = await this.read(["issue", "comment", "list", issue.id, "--roots-only", "--summary", "--compact"], target.workspace_id, signal);
			const runs = await this.read(["issue", "runs", issue.id, "--active"], target.workspace_id, signal);
			if (!Array.isArray(comments) || !Array.isArray(runs)) throw new Error("评论或 Run 列表格式无效");
			result.focus = { issue, comments, runs };
		}
		return result;
	}
}

export function uniqueMatch(candidates: Candidate[]): Candidate | undefined {
	const matches = candidates.filter(c => c.score > 0);
	return matches.length > 0 && (matches.length === 1 || matches[0].score > matches[1].score) ? matches[0] : undefined;
}
export function summarize(snapshot: Row): string[] {
	const { target, issues, focus } = snapshot;
	const lines = [`${cleanText(target.workspaceName)} / ${cleanText(target.title)} · ${cleanText(snapshot.fetchedAt)}`,
		`任务 ${snapshot.total ?? issues.length} · 已读取 ${issues.length}${snapshot.hasMore ? "，更多任务需分页" : ""}`];
	if (focus) {
		lines.push(`${cleanText(focus.issue.identifier)} · ${cleanText(focus.issue.status)} · ${cleanText(focus.issue.title)}`);
		lines.push(`活动 Run：${focus.runs.map((r: Row) => `${cleanText(r.status)} (${cleanText(r.id)})`).join("、") || "无"}`);
	} else {
		for (const i of issues.slice(0, 5)) lines.push(`${cleanText(i.identifier)} · ${cleanText(i.status)} · ${cleanText(i.title)}`);
	}
	return lines;
}
