import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BtwRuntime } from "./btw-runtime.ts";

export default function btwExtension(pi: ExtensionAPI): void {
	new BtwRuntime(pi).register();
}
