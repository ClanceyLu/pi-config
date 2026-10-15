import { AssistantMessageComponent, ToolExecutionComponent, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, truncateToWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";

export interface ToolRow extends Component {
	toolName: string;
	toolCallId: string;
	result?: { isError?: boolean };
	isPartial: boolean;
}

type Chat = Container & { [HOOK]?: RenderHook };
type RenderHook = { original: Container["render"]; draw?: (width: number, render: () => string[]) => string[] };
const HOOK = Symbol.for("pi.tool-groups.render");
const SILENT = Symbol.for("pi-compact-tools.silent.state");
const WIDGET = "tool-groups";

function isKind(child: Component, kind: { prototype: object; name: string }): boolean {
	return kind.prototype.isPrototypeOf(child) || child.constructor.name === kind.name;
}

function isTool(child: Component): child is ToolRow {
	return isKind(child, ToolExecutionComponent);
}

function isThinkingOnly(child: Component): boolean {
	if (!isKind(child, AssistantMessageComponent)) return false;
	const message = (child as Component & { lastMessage?: { stopReason?: string; content?: { type: string; text?: string }[] } }).lastMessage;
	if (message?.stopReason && ["error", "aborted", "length"].includes(message.stopReason)) return false;
	return !message?.content?.some((block) => block.type === "text" && block.text?.trim());
}

/** Group tool rows across spacers and thinking, never across visible messages or notices. */
export function groupTools(children: readonly Component[], makeGroup: (rows: ToolRow[], members: Component[]) => Component): Component[] {
	const output: Component[] = [];
	let rows: ToolRow[] = [], members: Component[] = [], pending: Component[] = [];
	const flush = () => {
		if (rows.length) output.push(makeGroup(rows, members));
		output.push(...pending);
		rows = []; members = []; pending = [];
	};
	for (const child of children) {
		if (isTool(child)) {
			rows.push(child);
			members.push(...pending, child);
			pending = [];
		} else if (rows.length && (isKind(child, Spacer) || isThinkingOnly(child))) {
			pending.push(child);
		} else {
			flush();
			output.push(child);
		}
	}
	flush();
	return output;
}

export class ToolGroup extends Container {
	constructor(rows: ToolRow[], members: Component[], state: { expanded: boolean }, theme: Theme, running: ReadonlySet<string>, repaint: () => void) {
		super();
		this.addChild({
			invalidate() {},
			render(width) {
				const counts = new Map<string, number>();
				let failed = 0, active = 0, incomplete = 0;
				for (const row of rows) {
					counts.set(row.toolName, (counts.get(row.toolName) ?? 0) + 1);
					if (running.has(row.toolCallId)) active++;
					else if (!row.result || row.isPartial) incomplete++;
					else if (row.result.isError) failed++;
				}
				const tools = [...counts].map(([name, count]) => `${name} ${count}`).join(" · ");
				let label = `${state.expanded ? "▾" : "▸"} 工具 ${rows.length} · ${tools}`;
				if (active) label += ` · ${active} 执行中`;
				if (failed) label += ` · ${failed} 失败`;
				if (incomplete) label += ` · ${incomplete} 未完成`;
				label += state.expanded ? " （收起）" : " （展开）";
				return ["", truncateToWidth(theme.fg(failed ? "error" : active ? "accent" : incomplete ? "warning" : "muted", label), width)];
			},
			handleMouse(event: TuiMouseEvent) {
				if (event.type !== "click" || event.button !== "left" || event.y === 0) return;
				state.expanded = !state.expanded;
				repaint();
				return { handled: true };
			},
		});
		// Opening a group reveals existing Compact rows without opening their results.
		if (state.expanded) for (const member of members) this.addChild(member);
	}
}

function isSilent(): boolean {
	const state = (globalThis as typeof globalThis & { [SILENT]?: { active: boolean; enabled: boolean } })[SILENT];
	return state?.active === true && state.enabled;
}

export default function toolGroups(pi: ExtensionAPI) {
	let enabled = true, expanded = false;
	let states = new WeakMap<ToolRow, { expanded: boolean }>();
	const running = new Set<string>();
	let detach: (() => void) | undefined;
	let repaint: (() => void) | undefined;

	pi.on("tool_execution_start", (event) => { if (!event.parentToolCallId) running.add(event.toolCallId); });
	pi.on("tool_execution_end", (event) => { running.delete(event.toolCallId); });
	pi.on("agent_end", () => { running.clear(); repaint?.(); });
	pi.on("session_shutdown", () => { detach?.(); detach = undefined; repaint = undefined; running.clear(); });
	pi.on("session_start", (_event, ctx) => {
		detach?.();
		detach = undefined;
		repaint = undefined;
		running.clear();
		states = new WeakMap();
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(WIDGET, (tui) => {
			// shortcut: Pi 1.2 has no transcript-transform API; revisit this mount point when its layout changes.
			const document = (tui as unknown as { children?: Container[] }).children?.[0];
			const chat = document?.children?.at(-1) as Chat | undefined;
			if (!chat || !Array.isArray(chat.children) || typeof chat.render !== "function") {
				ctx.ui.notify("工具分组不可用：当前 Pi 的对话布局不受支持", "warning");
				return { render: () => [], invalidate() {} };
			}
			repaint = () => tui.requestRender();
			// Keep one wrapper across reloads, including when another extension wraps it.
			if (!Object.hasOwn(chat, HOOK)) {
				const hook: RenderHook = { original: chat.render };
				Object.defineProperty(chat, HOOK, { value: hook });
				chat.render = function (width) {
					const render = () => hook.original.call(this, width);
					return hook.draw ? hook.draw(width, render) : render();
				};
			}
			const hook = chat[HOOK]!;
			const draw: NonNullable<RenderHook["draw"]> = (_width, render) => {
				if (!enabled || isSilent()) return render();
				const original = chat.children;
				chat.children = groupTools(original, (rows, members) => {
					let state = states.get(rows[0]);
					if (!state) { state = { expanded }; states.set(rows[0], state); }
					return new ToolGroup(rows, members, state, ctx.ui.theme, running, repaint!);
				});
				try { return render(); } finally { chat.children = original; }
			};
			hook.draw = draw;
			const cleanup = () => { if (hook.draw === draw) hook.draw = undefined; };
			detach = cleanup;
			return { render: () => [], invalidate() {}, dispose: cleanup };
		}, { placement: "belowEditor" });
	});

	pi.registerCommand("tool-groups", {
		description: "工具分组：expand 展开分组，collapse 收起分组，on/off 开关分组",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on" || action === "off") enabled = action === "on";
			else if (action === "" || action === "expand" || action === "collapse") {
				enabled = true;
				expanded = action === "" ? !expanded : action === "expand";
				states = new WeakMap();
			} else { ctx.ui.notify("用法：/tool-groups [expand|collapse|on|off]", "warning"); return; }
			repaint?.();
			if (isSilent()) ctx.ui.notify("Silent 模式正在隐藏工具，请运行 /silent off 查看分组", "info");
		},
	});
}
