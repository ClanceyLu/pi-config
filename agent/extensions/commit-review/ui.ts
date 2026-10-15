import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, ScrollView, sliceByColumn, truncateToWidth, wrapTextWithAnsi, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { patch, safeText, unchanged, type Snapshot } from "./git.ts";

export type Decision = "confirmed" | "cancelled" | "adjust";
interface Page { ready?: Promise<void>; lines?: string[]; error?: string; scroll: ScrollView; horizontal: number; maxWidth: number; wrapped?: { width: number; lines: string[] } }
const labelText = (text: string) => safeText(text).replace(/\n/g, "\\n").replace(/\r/g, "\\r");

export class ReviewUI implements Component {
	focused = false;
	private filter = new Input({ prompt: "/ " });
	private filtering = false;
	private selected = 0;
	private pane: "files" | "diff" = "files";
	private stage: "review" | "confirm" = "review";
	private action = 0;
	private busy = false;
	private error = "";
	private closed = false;
	private width = 100;
	private height = 15;
	private wrap = false;
	private messageView = false;
	private pathView = false;
	private diffHeight = 15;
	private pages = new Map<string, Page>();
	private messageScroll = new ScrollView({ render: () => [], invalidate() {} });
	constructor(private snapshot: Snapshot, private message: string, private theme: Theme,
		private rows: () => number, private refresh: () => void, private done: (decision: Decision) => void,
		private signal?: AbortSignal) {
		this.filter.onSubmit = () => { this.filtering = false; this.refresh(); };
		this.filter.onEscape = () => { this.filtering = false; this.filter.setValue(""); this.selected = 0; this.refresh(); };
		this.load();
	}
	private files() {
		const query = this.filter.getValue().toLowerCase();
		return this.snapshot.files.filter((f) => (f.path + " " + (f.oldPath ?? "")).toLowerCase().includes(query))
			.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	}
	private tree(files: Snapshot["files"], width: number) {
		const lines: string[] = [];
		let previous: string[] = [], selectedStart = 0, selectedEnd = 0;
		for (const [i, file] of files.entries()) {
			const parts = file.path.split("/"), parents = parts.slice(0, -1);
			let common = 0;
			while (common < parents.length && parents[common] === previous[common]) common++;
			for (let depth = common; depth < parents.length; depth++) {
				lines.push(...wrapTextWithAnsi(`${"  ".repeat(Math.min(depth, 4))}${labelText(parents[depth])}/`, width));
			}
			const start = lines.length;
			lines.push(...wrapTextWithAnsi(`${i === this.selected ? "›" : " "} ${file.status} ${"  ".repeat(Math.min(parents.length, 4))}${labelText(parts.at(-1)!)}`, width));
			if (i === this.selected) { selectedStart = start; selectedEnd = lines.length; }
			previous = parents;
		}
		const start = Math.max(0, Math.min(selectedStart, selectedEnd - this.height));
		return Array.from({ length: this.height }, (_, row) => {
			const i = start + row, line = lines[i] ?? (i === 0 ? "无匹配文件" : "");
			return i >= selectedStart && i < selectedEnd ? this.theme.fg("accent", line) : line;
		});
	}
	private current() { return this.files()[this.selected]; }
	private pathLabel() {
		const file = this.current();
		return file ? `${file.oldPath ? labelText(file.oldPath) + " → " : ""}${labelText(file.path)}` : "无匹配文件";
	}
	private page() { const file = this.current(); return file ? this.pages.get(file.path) : undefined; }
	private load() {
		const file = this.current();
		if (!file || this.pages.has(file.path)) return;
		const page: Page = { scroll: new ScrollView({ render: () => [], invalidate() {} }), horizontal: 0, maxWidth: 0 };
		this.pages.set(file.path, page);
		page.ready = patch(this.snapshot, file, this.signal).then((text) => {
			page.lines = safeText(text).split("\n");
			page.maxWidth = page.lines.reduce((width, line) => Math.max(width, visibleWidth(line)), 0);
		})
			.catch((error) => { page.error = safeText(String(error)); })
			.finally(() => { if (!this.closed) this.refresh(); });
	}
	private finish(decision: Decision) { if (!this.closed) { this.closed = true; this.done(decision); } }
	dispose() { this.closed = true; }
	invalidate() { this.filter.invalidate(); }
	private async confirm() {
		this.busy = true;
		this.refresh();
		try {
			await Promise.all([...this.pages.values()].map((page) => page.ready));
			if (this.closed) return;
			if ([...this.pages.values()].some((page) => page.error)) throw new Error("存在无法加载的差异，请取消并重新审阅。");
			await unchanged(this.snapshot, this.signal);
			if (this.signal?.aborted) return this.finish("cancelled");
			this.finish("confirmed");
		} catch (error) {
			this.error = labelText(String(error));
			this.stage = "review";
		} finally { this.busy = false; if (!this.closed) this.refresh(); }
	}
	handleInput(data: string) {
		if (this.closed) return;
		if (matchesKey(data, "ctrl+c") || (this.busy && matchesKey(data, "escape"))) return this.finish("cancelled");
		if (this.filtering) {
			this.filter.handleInput(data);
			this.selected = 0; this.load(); this.refresh(); return;
		}
		if (matchesKey(data, "escape")) {
			if (this.stage === "confirm") this.stage = "review";
			else if (this.pathView) this.pathView = false;
			else if (this.messageView) this.messageView = false;
			else if (this.pane === "diff") this.pane = "files";
			else return this.finish("cancelled");
		} else if (this.busy) return;
		else if (this.stage === "confirm") {
			if (matchesKey(data, "pageUp")) this.messageScroll.scrollBy(-this.height);
			else if (matchesKey(data, "pageDown")) this.messageScroll.scrollBy(this.height);
			else if (matchesKey(data, "right") || matchesKey(data, "tab") || matchesKey(data, "down")) this.action = (this.action + 1) % 4;
			else if (matchesKey(data, "left") || matchesKey(data, "shift+tab") || matchesKey(data, "up")) this.action = (this.action + 3) % 4;
			else if (matchesKey(data, "enter")) {
				if (this.action === 0) this.stage = "review";
				if (this.action === 1) { void this.confirm(); return; }
				if (this.action === 2) return this.finish("adjust");
				if (this.action === 3) return this.finish("cancelled");
			}
		} else if (data === "c") { this.stage = "confirm"; this.action = 1; this.messageScroll.scrollToStart(); }
		else if (data === "m") { this.messageView = !this.messageView; this.pathView = false; this.messageScroll.scrollToStart(); }
		else if (data === "p") { this.pathView = !this.pathView; this.messageView = false; this.messageScroll.scrollToStart(); }
		else if (data === "/") this.filtering = true;
		else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) this.pane = this.pane === "files" ? "diff" : "files";
		else if (matchesKey(data, "enter") && !this.messageView && !this.pathView) this.pane = this.pane === "files" ? "diff" : "files";
		else if (data === "w") { this.wrap = !this.wrap; this.page()?.scroll.scrollToStart(); }
		else {
			const step = this.pane === "diff" && !this.messageView && !this.pathView ? this.diffHeight : this.height;
			const delta = matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : matchesKey(data, "pageUp") ? -step : matchesKey(data, "pageDown") ? step : 0;
			if (this.messageView || this.pathView) this.messageScroll.scrollBy(delta);
			else if (this.pane === "files") {
				this.selected = Math.max(0, Math.min(this.files().length - 1, this.selected + delta)); this.load();
			} else {
				const page = this.page();
				page?.scroll.scrollBy(delta);
				if (page && matchesKey(data, "left")) page.horizontal = Math.max(0, page.horizontal - 8);
				if (page && matchesKey(data, "right")) page.horizontal = Math.min(Math.max(0, page.maxWidth - this.diffWidth()), page.horizontal + 8);
				if (page && matchesKey(data, "home")) page.scroll.scrollToStart();
				if (page && matchesKey(data, "end")) page.scroll.scrollToEnd();
				if (page?.lines && (data === "[" || data === "]")) {
					const lines = this.diffLines(page, this.diffWidth());
					const hunks = lines.flatMap((line, i) => line.startsWith("@@") ? [i] : []);
					const target = data === "]" ? hunks.find((i) => i > page.scroll.scrollTop) : hunks.findLast((i) => i < page.scroll.scrollTop);
					if (target !== undefined) page.scroll.scrollTo(target);
				}
			}
		}
		this.refresh();
	}
	private diffWidth() { return Math.max(1, this.width < 90 ? this.width - 2 : this.width - Math.min(38, Math.floor(this.width / 3)) - 3); }
	private frame(title: string, content: string[], width: number, active = false) {
		const inner = Math.max(0, width - 2);
		const border = (text: string) => this.theme.fg(active ? "accent" : "border", text);
		const label = truncateToWidth(` ${title} `, inner, "");
		if (width < 4) return [truncateToWidth(title, width), ...content.map((line) => truncateToWidth(line, width)), ""];
		return [border(`╭${label}${"─".repeat(inner - visibleWidth(label))}╮`),
			...content.map((line) => border("│") + truncateToWidth(line, inner, "", true) + border("│")),
			border(`╰${"─".repeat(inner)}╯`)];
	}
	private diffLines(page: Page, width: number) {
		if (page.error) return wrapTextWithAnsi(page.error, width);
		if (!page.lines) return ["正在加载差异…"];
		if (!this.wrap) return page.lines;
		if (page.wrapped?.width !== width) page.wrapped = { width, lines: page.lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width))) };
		return page.wrapped.lines;
	}
	private viewport(lines: string[], scroll: ScrollView, width: number, horizontal = 0, color = false, height = this.height) {
		scroll.updateLayout(lines.length, height, this.refresh);
		return Array.from({ length: height }, (_, i) => {
			const raw = lines[scroll.scrollTop + i] ?? "";
			const line = truncateToWidth(sliceByColumn(raw, horizontal, width), width, "", true);
			return color ? this.theme.fg(raw.startsWith("+") ? "success" : raw.startsWith("-") ? "error" : raw.startsWith("@@") ? "accent" : "text", line) : line;
		});
	}
	render(width: number): string[] {
		this.width = Math.max(1, width);
		const fullMessage = this.stage === "confirm" || this.messageView || this.pathView;
		const fit = (text: string) => truncateToWidth(text, this.width);
		const options = ["返回审阅", "确认提交", "调整范围或信息", "取消"];
		const controls = this.stage === "confirm" ? [
			...(this.width < 90 ? options.map((option, i) => `${i === this.action ? "›" : " "}[${option}]`) : [options.map((option, i) => `${i === this.action ? "›" : " "}[${option}]`).join("  ")]),
			`Enter ${options[this.action]} · Esc 返回审阅`,
			"←→ / Tab 选择操作 · PgUp/PgDn 浏览信息 · Ctrl+C 取消",
		] : this.filtering ? ["Enter 完成筛选 · Esc 清空筛选 · Ctrl+C 取消"] : this.pathView || this.messageView ? [
			`${this.pathView ? "p" : "m"} / Esc 返回 · ↑↓ / PgUp/PgDn 浏览${this.pathView ? "路径" : "信息"}`,
			"c 继续确认 · Ctrl+C 取消",
		] : [
			"c 继续确认 · p 完整路径 · m 提交信息",
			`Tab 切换区域 · Enter ${this.pane === "files" ? "查看差异" : "返回文件列表"} · / 筛选`,
			"↑↓ / PgUp/PgDn 浏览 · ←→ 横移",
			"Home/End 首尾 · [ / ] 改动块 · w 折行",
			`Esc ${this.pane === "diff" ? "返回文件列表" : "取消审阅"} · Ctrl+C 取消`,
		];
		const footer = [fit(this.theme.fg("accent", "操作")), ...controls.flatMap((line) => wrapTextWithAnsi(line, this.width)).map((line) => fit(this.theme.fg("muted", line)))];
		const preview = !fullMessage && this.rows() - footer.length >= 14;
		this.height = Math.max(1, this.rows() - (preview ? 10 : 5) - footer.length);
		const files = this.files();
		const file = this.current();
		const page = this.page();
		const total = this.snapshot.files.reduce((acc, f) => [acc[0] + (Number(f.added) || 0), acc[1] + (Number(f.removed) || 0)], [0, 0]);
		const branch = this.snapshot.branch === "HEAD" ? `分离 HEAD · ${this.snapshot.head.slice(0, 12)}` : labelText(this.snapshot.branch.replace(/^refs\/heads\//, ""));
		const lines = [fit(this.theme.fg("accent", `提交分支：${branch}`)),
			fit(this.theme.fg("muted", `${labelText(this.snapshot.root)} · ${this.snapshot.files.length} 个暂存文件 +${total[0]} −${total[1]}`))];
		const path = this.pathLabel();
		this.filter.focused = this.focused && this.filtering;
		if (fullMessage) {
			const inner = Math.max(1, this.width - 2);
			const showPath = this.pathView && this.stage !== "confirm";
			const content = wrapTextWithAnsi(showPath ? path : safeText(this.message), inner);
			lines.push(...this.frame(this.stage === "confirm" ? "确认提交 · 完整提交信息" : showPath ? "完整文件路径 · p 返回" : "完整提交信息", this.viewport(content, this.messageScroll, inner), this.width, true));
		} else {
			const listWidth = this.width < 90 ? this.width : Math.min(38, Math.floor(this.width / 3));
			const list = this.tree(files, Math.max(1, listWidth - 2));
			const pathLines = wrapTextWithAnsi(path, this.diffWidth());
			const pathHeight = Math.min(pathLines.length, Math.max(0, Math.min(3, this.height - 2)));
			this.diffHeight = Math.max(1, this.height - pathHeight - (pathHeight ? 1 : 0));
			const context = pathLines.slice(0, pathHeight).map((line) => this.theme.fg("accent", line));
			if (pathHeight) context.push(this.theme.fg("muted", "p 查看完整路径"));
			const diff = context.concat(page ? this.viewport(this.diffLines(page, this.diffWidth()), page.scroll, this.diffWidth(), this.wrap ? 0 : page.horizontal, true, this.diffHeight) : Array(this.diffHeight).fill(""));
			const filePanel = this.frame(`暂存文件 ${files.length ? this.selected + 1 : 0}/${files.length}`, list, listWidth, this.pane === "files");
			const diffPanel = this.frame(`差异${file ? ` +${file.added} −${file.removed}` : ""}`, diff, this.width < 90 ? this.width : this.width - listWidth - 1, this.pane === "diff");
			lines.push(...(this.width < 90 ? this.pane === "files" ? filePanel : diffPanel : filePanel.map((line, i) => `${line} ${diffPanel[i]}`)));
			if (preview) {
				const content = wrapTextWithAnsi(safeText(this.message), Math.max(1, this.width - 2));
				lines.push(...this.frame(`提交信息 · m 展开${content.length > 3 ? ` · 共 ${content.length} 行` : ""}`, Array.from({ length: 3 }, (_, i) => content[i] ?? ""), this.width));
			}
		}
		const error = this.error || (page?.error ? labelText(page.error) : "");
		const position = fullMessage ? `${this.pathView && this.stage !== "confirm" ? "路径" : "信息"}行 ${this.messageScroll.scrollTop + 1} · ` : page?.lines ? `差异行 ${page.scroll.scrollTop + 1}/${this.diffLines(page, this.diffWidth()).length} · ` : "";
		const status = error || (this.busy ? "正在校验暂存快照…" : `${position}暂存区外 ${this.snapshot.outside} 个文件未包含`);
		lines.push(this.filtering ? this.filter.render(this.width)[0] : fit(this.theme.fg(error ? "error" : "muted", status)));
		const rows = Math.max(1, this.rows());
		return lines.slice(0, Math.max(0, rows - footer.length)).concat(footer.slice(0, rows));
	}
}
