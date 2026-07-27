import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ReasoningModeRuntime } from "./runtime.ts";

export default function reasoningModeExtension(pi: ExtensionAPI): void {
	new ReasoningModeRuntime(pi).register();
}
