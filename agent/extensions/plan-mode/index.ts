import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PlanModeRuntime } from "./runtime.ts";

export default function planModeExtension(pi: ExtensionAPI): void {
	new PlanModeRuntime(pi).register();
}
