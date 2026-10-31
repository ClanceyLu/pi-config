import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, VStack, isViewportTUI, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

// Pi 1.4 has no public transcript-position API. Keep private layout access here.
export function transcriptView(tui: TUI): ScrollView | undefined {
	if (tui.mode !== "fullscreen") return;
	const root = (tui as TUI & { layoutRoot?: Component }).layoutRoot;
	const visit = (component: Component): ScrollView | undefined => {
		if (component instanceof ScrollView) return component.primary ? component : undefined;
		const children = (component as Component & { children?: Component[] }).children;
		for (const child of children ?? []) {
			const found = visit(child);
			if (found) return found;
		}
	};
	return root ? visit(root) : undefined;
}

export function isReadingHistory(tui: TUI): boolean {
	const transcript = transcriptView(tui);
	return !!transcript && transcript.viewportHeight > 0 && !transcript.isFollowingEnd;
}

function plainText(text: string): string {
	return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

// The document and chat are concatenating Containers. Other components must be
// measured as a whole, since their children may have padding or custom layouts.
// UserMessageComponent's text is private in Pi 1.4, so unsupported shapes fail closed.
export function userTextAtViewport(tui: TUI): string {
	const transcript = transcriptView(tui);
	if (!transcript) return "";
	const width = transcript.getContentWidth(tui.terminal.columns);
	let row = 0;
	let text = "";
	const visit = (component: Component) => {
		if (row > transcript.scrollTop) return;
		const user = component as Component & { text?: unknown; skillBlock?: { name?: unknown; userMessage?: unknown } };
		if (component.constructor.name === "UserMessageComponent" && typeof user.text === "string") {
			text = plainText(user.text);
		} else if (component.constructor.name === "SkillInvocationMessageComponent") {
			const block = user.skillBlock;
			text = typeof block?.userMessage === "string" && block.userMessage.trim()
				? plainText(block.userMessage)
				: typeof block?.name === "string" ? `/skill:${plainText(block.name)}` : "";
		} else if (component.constructor === Container) {
			for (const child of (component as Container).children) visit(child);
			return;
		}
		row += component.render(width).length;
	};
	for (const child of transcript.children) visit(child);
	return text;
}

export default function lastUserMessage(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget("last-user-message", (tui, theme) => {
			const currentText = () => userTextAtViewport(tui);
			const bar: Component = {
				invalidate() {},
				render(width) {
					const line = truncateToWidth(` ${currentText()}`, width);
					return [theme.bg("userMessageBg", theme.fg("userMessageText", line + " ".repeat(Math.max(0, width - visibleWidth(line)))))];
				},
			};
			let mounted: { root: Component; wrapper: VStack } | undefined;
			let observed: { view: ScrollView; original: ScrollView["updateLayout"]; hook: ScrollView["updateLayout"] } | undefined;
			const stopObserving = () => {
				if (observed?.view.updateLayout === observed?.hook && observed) observed.view.updateLayout = observed.original;
				observed = undefined;
			};
			const observeLayout = () => {
				const view = transcriptView(tui);
				if (!view || observed?.view === view) return;
				stopObserving();
				const original = view.updateLayout;
				const hook: ScrollView["updateLayout"] = function (...args) {
					const wasFollowing = this.isFollowingEnd;
					const previousTop = this.scrollTop;
					original.apply(this, args);
					// The fixed row is laid out before the transcript. A resize or
					// collapse can change its state later in the same frame.
					if (wasFollowing !== this.isFollowingEnd || previousTop !== this.scrollTop) tui.requestRender();
				};
				view.updateLayout = hook;
				observed = { view, original, hook };
			};
			const currentRoot = () => (tui as TUI & { layoutRoot?: Component }).layoutRoot;
			const mount = () => {
				if (tui.mode !== "fullscreen" || !isViewportTUI(tui)) return;
				const root = currentRoot();
				if (!root || root === mounted?.wrapper) return;
				const wrapper = new VStack([
					{ component: bar, basis: 1, grow: 0, shrink: 0, visible: () => isReadingHistory(tui) && currentText().length > 0 },
					{ component: root, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				]);
				mounted = { root, wrapper };
				tui.setLayoutRoot(wrapper);
				observeLayout();
			};
			mount();
			return {
				// Pi keeps widgets when replacing the renderer. Remount on its next render.
				render() { mount(); return []; },
				invalidate() {},
				dispose() {
					stopObserving();
					if (mounted && isViewportTUI(tui) && currentRoot() === mounted.wrapper) {
						tui.setLayoutRoot(mounted.root);
					}
				},
			};
		});
	});
}
