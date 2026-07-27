import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SplitRuntime } from "./split-runtime.ts";

export default function splitExtension(pi: ExtensionAPI): void {
	new SplitRuntime(pi).register();
}
