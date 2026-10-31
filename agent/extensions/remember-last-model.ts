import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// shortcut: reads and rewrites the whole settings.json without pi's lock; if a concurrent
// settings write ever drops the value, switch to an official settings API once one exists.
const settingsPath = join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent"), "settings.json");

export default function rememberLastModel(pi: ExtensionAPI) {
  pi.on("model_select", (event) => {
    if (event.source === "restore") return;
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (settings.defaultProvider === event.model.provider && settings.defaultModel === event.model.id) return;
      settings.defaultProvider = event.model.provider;
      settings.defaultModel = event.model.id;
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    } catch {
      // Missing or unreadable settings: keep the session working, defaults stay unchanged.
    }
  });
}
