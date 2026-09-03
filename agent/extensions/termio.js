// termio agent status — reports Pi turn lifecycle to termio.
// Socket marker: agent-status.sock
export default (pi) => {
  const cli = "'\/Applications\/termio.app\/Contents\/Resources\/termiod'";
  const session = process.env.TERMIOD_SESSION_ID;
  const report = (state, context) => {
    if (!session) return;
    const id = context?.sessionManager?.getSessionId?.();
    const conversation = id && /^[A-Za-z0-9._-]+$/.test(id) ? ` --conversation ${id}` : "";
    pi.exec("sh", ["-c", `${cli} set-status "$TERMIOD_SESSION_ID" ${state}${conversation} 2>/dev/null || true`]);
  };
  pi.on("session_start", (_event, context) => report("idle", context));
  pi.on("agent_start", (_event, context) => report("working", context));
  pi.on("agent_end", (_event, context) => report("done", context));
};