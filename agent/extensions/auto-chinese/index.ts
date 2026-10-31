import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StdinBuffer } from "@earendil-works/pi-tui";

const helper = fileURLToPath(new URL("./select-input-source", import.meta.url));
const enableFocusReporting = "\x1b[?1004h";
const disableFocusReporting = "\x1b[?1004l";

export default function autoChinese(pi: ExtensionAPI) {
  let dispose: (() => void) | undefined;

  function cleanup() {
    dispose?.();
    dispose = undefined;
  }

  pi.on("session_start", async (_event, ctx) => {
    if (process.platform !== "darwin" || ctx.mode !== "tui") return;
    cleanup();
    let active = true;
    const owner = randomUUID();
    let pending: { action: "enter" | "leave"; order: string } | undefined;
    let switching: Promise<void> | undefined;

    function select(action: "enter" | "leave"): Promise<void> {
      // Capture event time before spawning the helper or waiting in our queue.
      // Epoch microseconds are comparable across independently started pi processes.
      pending = { action, order: String(Math.floor((performance.timeOrigin + performance.now()) * 1000)) };
      // Keep the most recent focus change, even while the helper is running.
      if (switching) return switching;
      switching = (async () => {
        while (active && pending) {
          const target = pending;
          pending = undefined;
          try {
            const result = await pi.exec(helper, [target.action, target.order, owner], { timeout: 5000 });
            if (active && result.code !== 0) {
              warn(ctx, result.stderr.trim() || "输入法工具执行失败");
            }
          } catch (error) {
            if (active) warn(ctx, String(error));
          }
        }
      })().finally(() => { switching = undefined; });
      return switching;
    }

    // Fullscreen pi consumes focus reports before extension UI listeners run.
    // Observe stdin independently without consuming or modifying pi's input.
    // StdinBuffer handles split escape sequences and keeps pasted text separate.
    const input = new StdinBuffer();
    input.on("data", (sequence) => {
      if (sequence === "\x1b[I") void select("enter");
      else if (sequence === "\x1b[O") void select("leave");
    });
    const onData = (data: string | Buffer) => input.process(data);
    process.stdin.on("data", onData);
    dispose = () => {
      active = false;
      pending = undefined;
      process.stdin.off("data", onData);
      input.destroy();
      process.stdout.write(disableFocusReporting);
    };
    process.stdout.write(enableFocusReporting);
    await select("enter");
  });

  pi.on("session_shutdown", cleanup);
}

function warn(ctx: ExtensionContext, detail: string) {
  ctx.ui.notify(`自动切换输入法失败：${detail}`, "warning");
}
