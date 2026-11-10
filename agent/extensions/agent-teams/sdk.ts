import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRuntime,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ChildFactory, ChildRecord } from "./runtime.ts";

export interface ChildFactoryOptions {
  getContext(): ExtensionContext;
  registerChild(pi: ExtensionAPI, caller: string): void;
  getRecord?(id: string): ChildRecord | undefined;
}

const identityType = "agent-teams.child-session";

/** Copy only finalized turns; a tool call is not an assistant's final answer. */
function completedPrefix(parent: ExtensionContext["sessionManager"]): SessionEntry[] {
  const branch = parent.getBranch();
  let end = 0;
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message;
    if ((message.stopReason === "stop" || message.stopReason === "length") &&
        !message.content.some((part) => part.type === "toolCall")) end = i + 1;
  }
  // Keep compaction checkpoints and context edits between the completed and next turn.
  while (end > 0 && end < branch.length) {
    const entry = branch[end];
    if (entry.type === "custom_message" || entry.type === "branch_summary" || entry.type === "message") break;
    end++;
  }
  return structuredClone(branch.slice(0, end));
}

function assertToolPairs(manager: SessionManager): void {
  const pending = new Set<string>();
  for (const message of manager.buildSessionContext().messages) {
    if (message.role === "assistant") {
      for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
    } else if (message.role === "toolResult") {
      if (!pending.delete(message.toolCallId)) throw new Error("Cannot fork history with an orphan tool result");
    } else if (message.role === "user" && pending.size) {
      throw new Error("Cannot fork history with unfinished tool calls");
    }
  }
  if (pending.size) throw new Error("Cannot fork history with unfinished tool calls");
}

/** In-process children share the parent's provider/auth runtime, not extension discovery. */
export function createSdkFactory(options: ChildFactoryOptions): ChildFactory {
  const sessions = new Map<string, AgentSession>();

  function parentManager(caller: string, ctx: ExtensionContext): ExtensionContext["sessionManager"] {
    if (caller === "lead") return ctx.sessionManager;
    const live = sessions.get(caller);
    if (live) return live.sessionManager;
    const file = options.getRecord?.(caller)?.sessionFile;
    if (!file || !existsSync(file)) throw new Error(`Parent session is unavailable: ${caller}`);
    return SessionManager.open(file);
  }

  return async (record, caller, resume) => {
    if (sessions.has(record.id)) throw new Error(`Child session is already open: ${record.id}`);
    const ctx = options.getContext();
    // Pi 1.5 exposes the runtime through its compatibility facade, but not its declarations.
    const modelRuntime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
    if (!modelRuntime || typeof modelRuntime.getModel !== "function") {
      throw new Error("The parent model registry does not expose a compatible Pi model runtime");
    }
    const model = modelRuntime.getModel(record.provider, record.model);
    if (!model) throw new Error(`Unknown child model: ${record.provider}/${record.model}`);
    if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(record.thinking)) {
      throw new Error(`Invalid child thinking level: ${record.thinking}`);
    }
    let manager: SessionManager;
    if (resume) {
      if (!record.sessionFile || !existsSync(record.sessionFile)) throw new Error("Child session file is missing; cannot resume");
      manager = SessionManager.open(record.sessionFile, undefined, record.cwd);
      const identity = manager.getEntries().findLast((entry) => entry.type === "custom" && entry.customType === identityType);
      const data = identity?.type === "custom" ? identity.data as { id?: string; parent?: string } | undefined : undefined;
      if (manager.getSessionId() !== record.id || data?.id !== record.id || data.parent !== record.parent) {
        throw new Error("Child session identity does not match its durable record");
      }
    } else {
      const parent = parentManager(caller, ctx);
      const prefix = record.context === "fork" ? completedPrefix(parent) : [];
      const generated = SessionManager.create(record.cwd, record.sessionFile ? dirname(record.sessionFile) : undefined, {
        id: record.id,
        parentSession: parent.getSessionFile(),
      });
      const snapshot = SessionManager.inMemory(record.cwd, undefined, [generated.getHeader()!, ...prefix]);
      assertToolPairs(snapshot);
      snapshot.appendCustomEntry(identityType, { id: record.id, parent: record.parent, kind: record.kind, context: record.context });
      snapshot.appendSessionInfo(record.name);
      snapshot.appendModelChange(record.provider, record.model);
      snapshot.appendThinkingLevelChange(record.thinking);
      const file = record.sessionFile ?? generated.getSessionFile()!;
      mkdirSync(dirname(file), { recursive: true });
      // Import the entry tree intact: compaction/context-edit references retain their IDs.
      writeFileSync(file, [snapshot.getHeader(), ...snapshot.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
      manager = SessionManager.open(file, undefined, record.cwd);
    }

    const resourceLoader = new DefaultResourceLoader({
      cwd: record.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [(pi) => options.registerChild(pi, record.id)],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      agentDir: getAgentDir(),
      cwd: record.cwd,
      modelRuntime,
      model,
      thinkingLevel: record.thinking as ExtensionContext["thinkingLevel"],
      resourceLoader,
      sessionManager: manager,
    });
    let lastText: string | undefined;
    let failure: string | undefined;
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      const message = event.message;
      lastText = message.content.filter((part) => part.type === "text").map((part) => part.text).join("") || undefined;
      if (message.stopReason === "error") failure = message.errorMessage || "Child model request failed";
      else if (message.stopReason === "aborted") failure = "Child model request was aborted";
      else failure = undefined;
    });
    try {
      await session.bindExtensions({ mode: "print" });
      sessions.set(record.id, session);
    } catch (error) {
      unsubscribe();
      session.dispose();
      throw error;
    }
    return {
      sessionFile: manager.getSessionFile()!,
      async prompt(text) {
        lastText = undefined;
        failure = undefined;
        await session.prompt(text, { expandPromptTemplates: false });
        if (failure) throw new Error(failure);
      },
      steer: (text) => session.steer(text),
      abort: () => session.abort(),
      clearQueue: () => session.clearQueue(),
      getSteeringMessages: () => session.getSteeringMessages(),
      getLastAssistantText: () => lastText,
      dispose() {
        if (sessions.get(record.id) === session) sessions.delete(record.id);
        unsubscribe();
        session.dispose();
      },
    };
  };
}
