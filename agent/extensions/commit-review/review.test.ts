import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { patch, parseFiles, safeText, snapshot, unchanged } from "./git.ts";

// Resolve Pi's actual UI/schema packages, not mocks, for managed installs without local node_modules.
const version = readFileSync(new URL("../../install/current-version", import.meta.url), "utf8").trim();
const require = createRequire(new URL(`../../install/releases/${version}/package.json`, import.meta.url));
const hook = registerHooks({ resolve(specifier, context, next) {
	if (specifier === "@earendil-works/pi-tui" || specifier === "typebox") return next(require.resolve(specifier), context);
	return next(specifier, context);
} });
const { ReviewUI } = await import("./ui.ts");
const { review, default: extension } = await import("./index.ts");
const { sliceByColumn, visibleWidth } = await import("@earendil-works/pi-tui");
hook.deregister();
const theme = { fg: (_color: string, text: string) => text } as any;
function fixture(t: any) {
	const root = mkdtempSync(join(tmpdir(), "pi-commit-review-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
	git("init", "-q");
	git("config", "user.name", "Review Test"); git("config", "user.email", "review@example.invalid");
	const write = (path: string, text: string | Buffer) => writeFileSync(join(root, path), text);
	return { root, git, write };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
async function loaded(ui: InstanceType<typeof ReviewUI>) {
	for (let i = 0; i < 100; i++) {
		if (!ui.render(100).some((line) => line.includes("正在加载差异"))) return;
		await tick();
	}
	throw new Error("Timed out loading patch");
}

test("unborn branch, filenames, literal pathspec, complete large patch, and unchanged index", async (t) => {
	const f = fixture(t);
	f.write("[a].ts", Array.from({ length: 12000 }, (_, i) => `line ${i}`).join("\n") + "\n");
	f.write("a.ts", "other\n"); f.write("中文\n文件.ts", "内容\n");
	f.git("add", "--all"); f.write("outside", "not staged");
	const index = f.git("ls-files", "--stage", "-z");
	const s = await snapshot(f.root);
	assert.equal(s.files.length, 3); assert.equal(s.head, "UNBORN"); assert.equal(s.outside, 1);
	const diff = await patch(s, s.files.find((file) => file.path === "[a].ts")!);
	assert.match(diff, /line 11999/); assert.doesNotMatch(diff, /other/);
	await unchanged(s);
	assert.equal(f.git("ls-files", "--stage", "-z"), index);
});

test("rename, binary, delete and unstaged remainder are represented", async (t) => {
	const f = fixture(t);
	f.write("old", "same\n"); f.write("deleted", "gone\n"); f.git("add", "."); f.git("commit", "-qm", "initial");
	f.git("mv", "old", "new"); f.git("rm", "-q", "deleted");
	f.write("binary", Buffer.from([0, 1, 2])); f.git("add", "binary"); f.write("new", "unstaged\n");
	const s = await snapshot(f.root);
	assert.equal(s.outside, 1);
	assert.equal(s.files.find((file) => file.path === "new")?.oldPath, "old");
	assert.equal(s.files.find((file) => file.path === "deleted")?.status, "D");
	assert.equal(s.files.find((file) => file.path === "binary")?.added, "-");
	assert.match(await patch(s, s.files.find((file) => file.path === "binary")!), /Binary files/);
	assert.doesNotMatch(await patch(s, s.files.find((file) => file.path === "new")!), /unstaged/);
});

test("index, HEAD and branch changes invalidate confirmation", async (t) => {
	const f = fixture(t);
	f.write("a", "a\n"); f.git("add", ".");
	const initial = await snapshot(f.root);
	f.write("a", "b\n"); f.git("add", ".");
	await assert.rejects(unchanged(initial), /已变化/);
	const next = await snapshot(f.root);
	f.git("commit", "-qm", "initial");
	await assert.rejects(unchanged(next), /已变化/);
	f.write("a", "c\n"); f.git("add", ".");
	const branch = await snapshot(f.root);
	f.git("switch", "-qc", "other");
	await assert.rejects(unchanged(branch), /已变化/);
});

test("empty index, conflict and whitespace errors fail closed", async (t) => {
	const f = fixture(t);
	await assert.rejects(snapshot(f.root), /暂存区为空/);
	f.write("a", "bad  \n"); f.git("add", ".");
	await assert.rejects(snapshot(f.root));
	f.write("a", "a\n"); f.git("add", "."); f.git("commit", "-qm", "initial");
	f.git("switch", "-qc", "side"); f.write("a", "side\n"); f.git("commit", "-qam", "side");
	f.git("switch", "-q", "-"); f.write("a", "main\n"); f.git("commit", "-qam", "main");
	assert.throws(() => f.git("merge", "side"));
	await assert.rejects(snapshot(f.root), /未解决冲突|未完成的 Git 操作/);
});

test("in-progress Git operations invalidate an otherwise identical snapshot", async (t) => {
	const f = fixture(t); f.write("a", "a\n"); f.git("add", ".");
	const s = await snapshot(f.root);
	for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
		f.write(`.git/${marker}`, "fixture\n");
		await assert.rejects(unchanged(s), /未完成的 Git 操作/);
		rmSync(join(f.root, ".git", marker));
	}
});

test("non-UTF-8 names and oversized diffs cannot silently become empty previews", async (t) => {
	const f = fixture(t);
	f.write("a", "a\n"); f.git("add", ".");
	const oid = f.git("rev-parse", ":a").trim();
	execFileSync("git", ["update-index", "-z", "--index-info"], { cwd: f.root,
		input: Buffer.concat([Buffer.from(`100644 ${oid}\t`), Buffer.from([0xff, 0])]) });
	await assert.rejects(snapshot(f.root), /非 UTF-8/);
	const large = fixture(t); large.write("large", "x".repeat(17 * 1024 * 1024) + "\n"); large.git("add", ".");
	const s = await snapshot(large.root);
	await assert.rejects(patch(s, s.files[0]), /超过 16 MiB/);
});

test("untrusted terminal controls are escaped", () => {
	assert.equal(safeText("a\x1b[2J\r\u202eb\t"), "a\\u001b[2J\\u000d\\u202eb    ");
	assert.deepEqual(parseFiles("M\0a\0", "2\t1\ta\0"), [{ status: "M", path: "a", added: "2", removed: "1" }]);
});

async function uiFixture(t: any, message = "fix: 修复边界\n\n" + "正文\n".repeat(50)) {
	const f = fixture(t);
	f.write("a.ts", Array.from({ length: 100 }, (_, i) => `内容 ${i} ` + "x".repeat(180)).join("\n") + "\n");
	f.write("b.ts", "b\n"); f.git("add", ".");
	const s = await snapshot(f.root);
	const decisions: string[] = [];
	let rows = 25;
	const ui = new ReviewUI(s, message, theme, () => rows, () => {}, (decision) => decisions.push(decision));
	t.after(() => ui.dispose());
	return { ...f, ui, s, decisions, resize: (value: number) => { rows = value; } };
}

test("responsive layouts stay within terminal columns/rows and sanitize filenames", async (t) => {
	const f = await uiFixture(t);
	await loaded(f.ui);
	for (const width of [1, 3, 20, 60, 89, 90, 120]) for (const rows of [8, 12, 18, 25, 40]) {
		f.resize(rows);
		const lines = f.ui.render(width);
		assert.ok(lines.length <= rows);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
	}
	f.ui.handleInput("\r");
	assert.match(f.ui.render(60).join("\n"), /diff --git/);
	f.ui.handleInput("\x1b[6~");
	assert.match(f.ui.render(60).join("\n"), /内容/);
	f.ui.handleInput("\x1b[C");
	f.ui.handleInput("w");
	assert.ok(f.ui.render(60).every((line) => visibleWidth(line) <= 60));
	f.ui.handleInput("\x1b");
	assert.match(f.ui.render(60).join("\n"), /a.ts/);
});

test("commit-only panels show the target branch, staged diff and message preview", async (t) => {
	const f = await uiFixture(t, "fix: 修复边界\n\n完整正文\n第四行");
	await loaded(f.ui);
	f.s.branch = "refs/heads/feature/提交审阅";
	const screen = f.ui.render(120).join("\n");
	assert.match(screen, /提交分支：feature\/提交审阅/);
	assert.doesNotMatch(screen, /refs\/heads\//);
	assert.match(screen, /╭ 暂存文件/);
	assert.match(screen, /╭ 差异/);
	assert.match(screen, /diff --git/);
	assert.match(screen, /╭ 提交信息/);
	assert.match(screen, /完整正文/);
	for (const key of ["m", "\x1b", "c"]) {
		f.ui.handleInput(key);
		assert.match(f.ui.render(120).join("\n"), /提交分支：feature\/提交审阅/);
	}
	f.s.branch = "HEAD";
	f.s.head = "1234567890abcdef";
	assert.match(f.ui.render(120).join("\n"), /提交分支：分离 HEAD · 1234567890ab/);
	assert.deepEqual(f.decisions, []);
});

test("directory tree wraps long names, distinguishes duplicate basenames and navigates only files", async (t) => {
	const f = fixture(t);
	const directory = "目录".repeat(10), filename = "very-long-filename-".repeat(4) + "tail.ts";
	for (const path of ["src/alpha", "src/beta", `src/${directory}`]) mkdirSync(join(f.root, path), { recursive: true });
	f.write("src/alpha/index.ts", "ALPHA\n"); f.write("src/beta/index.ts", "BETA\n");
	f.write(`src/${directory}/${filename}`, "LONG\n"); f.git("add", ".");
	const s = await snapshot(f.root), decisions: string[] = [];
	const ui = new ReviewUI(s, "fix: 文件树", theme, () => 60, () => {}, (decision) => decisions.push(decision));
	t.after(() => ui.dispose());
	await loaded(ui);
	const screen = ui.render(120);
	const tree = screen.slice(3, 51).map((line) => sliceByColumn(line, 1, 36)).join("\n");
	assert.match(tree, /src\//); assert.match(tree, /alpha\//); assert.match(tree, /beta\//);
	assert.equal(tree.match(/index\.ts/g)?.length, 2);
	assert.ok(tree.replace(/\s/g, "").includes(directory + "/"));
	assert.ok(tree.replace(/\s/g, "").includes(filename));
	assert.doesNotMatch(tree, /…/);
	ui.handleInput("\x1b[B"); await loaded(ui);
	assert.match(ui.render(120).join("\n"), /BETA/);
	assert.match(ui.render(120).join("\n"), /暂存文件 2\/3/);
	ui.handleInput("p");
	assert.match(ui.render(120).join("\n"), /src\/beta\/index\.ts/);
	ui.handleInput("\x1b"); ui.handleInput("/"); ui.handleInput(filename); ui.handleInput("\r");
	assert.match(ui.render(120).join("\n"), /暂存文件 1\/1/);
	assert.ok(ui.render(120).slice(3, 51).map((line) => sliceByColumn(line, 1, 36)).join("").replace(/\s/g, "").includes(filename));
	assert.deepEqual(decisions, []);
});

test("full path view preserves rename paths and scrolls long escaped paths on narrow terminals", async (t) => {
	const f = fixture(t);
	const old = "old-".repeat(12) + ".ts", parents = ["parent-".repeat(10), "nested-".repeat(10)];
	const name = "中文\n\u202e-renamed-tail.ts", path = [...parents, name].join("/");
	f.write(old, "same\n"); f.git("add", "."); f.git("commit", "-qm", "initial");
	mkdirSync(join(f.root, ...parents), { recursive: true }); f.git("mv", old, path);
	const s = await snapshot(f.root), index = f.git("ls-files", "--stage", "-z"), decisions: string[] = [];
	let rows = 30;
	const ui = new ReviewUI(s, "fix: 路径", theme, () => rows, () => {}, (decision) => decisions.push(decision));
	t.after(() => ui.dispose());
	ui.render(120); ui.handleInput("p");
	const wide = ui.render(120).slice(3, 26).map((line) => sliceByColumn(line, 1, 118)).join("").replace(/\s/g, "");
	assert.ok(wide.includes(old + "→" + path.replace("\n", "\\n").replace("\u202e", "\\u202e")));
	rows = 12;
	let narrow = ui.render(20).join("\n");
	assert.doesNotMatch(narrow, /renamed-tail/);
	for (let i = 0; i < 10; i++) { ui.handleInput("\x1b[6~"); narrow += "\n" + ui.render(20).join("\n"); }
	assert.ok(narrow.replace(/\s|│/g, "").includes("renamed-tail.ts"));
	assert.doesNotMatch(narrow, /\u202e/);
	for (const width of [1, 20, 60, 120]) assert.ok(ui.render(width).every((line) => visibleWidth(line) <= width));
	assert.equal(f.git("ls-files", "--stage", "-z"), index);
	assert.deepEqual(decisions, []);
});

test("confirmation defaults to return, supports full message scrolling, adjustment and cancellation", async (t) => {
	const f = await uiFixture(t);
	f.ui.render(100); f.ui.handleInput("c");
	assert.match(f.ui.render(100).join("\n"), /›\[返回审阅\]/);
	f.ui.handleInput("\x1b[6~");
	assert.match(f.ui.render(100).join("\n"), /正文/);
	f.ui.handleInput("\r"); assert.deepEqual(f.decisions, []);
	f.ui.handleInput("c"); f.ui.handleInput("\x1b[C"); f.ui.handleInput("\x1b[C");
	assert.match(f.ui.render(30).join("\n"), /›\[调整范围或信息\] 3\/4/);
	for (const width of [1, 20, 60, 90, 120]) {
		const lines = f.ui.render(width);
		assert.ok(lines.length <= 25);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	f.ui.handleInput("\r");
	assert.deepEqual(f.decisions, ["adjust"]);
	const cancel = await uiFixture(t); cancel.ui.handleInput("\x1b"); assert.deepEqual(cancel.decisions, ["cancelled"]);
});

test("filter, empty search and file navigation do not authorize a commit", async (t) => {
	const f = await uiFixture(t);
	f.ui.render(100); f.ui.handleInput("/"); f.ui.handleInput("b.ts"); f.ui.handleInput("\r");
	await tick();
	assert.match(f.ui.render(100).join("\n"), /b.ts/);
	f.ui.handleInput("/"); f.ui.handleInput("not-found"); f.ui.handleInput("\r");
	assert.match(f.ui.render(100).join("\n"), /无匹配文件/);
	assert.deepEqual(f.decisions, []);
});

test("confirmation rechecks the index and refuses concurrent changes", async (t) => {
	const f = await uiFixture(t); await loaded(f.ui);
	f.ui.render(100); f.ui.handleInput("c");
	f.write("a.ts", "changed\n"); f.git("add", ".");
	f.ui.handleInput("\x1b[C"); f.ui.handleInput("\r");
	for (let i = 0; i < 100 && !f.ui.render(100).join("").includes("已变化"); i++) await tick();
	assert.deepEqual(f.decisions, []);
	assert.match(f.ui.render(100).join("\n"), /已变化/);
});

test("Escape during asynchronous verification cancels instead of confirming in the background", async (t) => {
	const f = await uiFixture(t); await loaded(f.ui);
	f.ui.render(100); f.ui.handleInput("c"); f.ui.handleInput("\x1b[C"); f.ui.handleInput("\r"); f.ui.handleInput("\x1b");
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.deepEqual(f.decisions, ["cancelled"]);
});

test("tool confirms exact message and paths, read-only; cancellation and non-TUI fail closed", async (t) => {
	const f = fixture(t); f.write("a", "a\n"); f.git("add", ".");
	let tool: any;
	extension({ registerTool(value: any) { tool = value; }, registerCommand() {} } as any);
	assert.equal(tool.name, "commit_review");
	const signal = new AbortController();
	const ctx: any = { mode: "tui", cwd: f.root, ui: { custom: async (factory: any) => new Promise((resolve) => {
		const ui = factory({ terminal: { rows: 25 }, requestRender() {} }, theme, {}, resolve);
		ui.render(100); ui.handleInput("c"); ui.handleInput("\x1b[C"); ui.handleInput("\r");
	}) } };
	const result = await tool.execute("id", { message: "feat: 新增文件" }, signal.signal, undefined, ctx);
	assert.equal(result.details.decision, "confirmed"); assert.equal(result.details.message, "feat: 新增文件");
	assert.deepEqual(result.details.files, ["a"]); assert.equal(f.git("diff", "--cached", "--name-only"), "a\n");
	assert.throws(() => f.git("rev-parse", "--verify", "--quiet", "HEAD"));
	await assert.rejects(review({ ...ctx, mode: "rpc" }, "fix: test"), /终端交互/);
	signal.abort(); await assert.rejects(review(ctx, "fix: test", signal.signal), /取消/);
	ctx.ui.custom = async () => undefined;
	assert.equal((await review(ctx, "fix: test")).decision, "cancelled");
});
