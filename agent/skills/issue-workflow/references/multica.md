# Multica operations

## Execution modes and credentials

Local pi calling a logged-in CLI normally acts as the human account using the selected profile's PAT. That PAT can access the workspaces/APIs the account can access; it is not restricted to the issue under discussion. CLI writes do not automatically register local pi as a Multica Agent or upload its conversation/tool calls as a Run transcript.

A daemon-managed Agent Run uses injected task credentials and runtime instructions. Its permissions, profile access, delivery thread, comment frequency, and lifecycle rules may differ. Do not load human profile secrets or override injected credentials. Do not apply a past runtime's "one final comment" rule to all local pi sessions.

Neither skill instructions nor task credentials provide an OS filesystem sandbox. Stronger isolation requires a dedicated user/container/VM. Do not print CLI configuration containing tokens, copy tokens into issues, or put them in shell commands. Human CLI logout removes the local token; it does not revoke the server-side PAT.

## Resolve the target

Read the installed command's `--help` before a new operation. Confirm service/profile and workspace without dumping secret configuration. Use workspace/project listings and issue details to verify ownership. Use explicit `--workspace-id` for cross-session operations; use the confirmed `--profile` when necessary in human/local mode. Do not pass human-profile flags in task-managed contexts that reject them.

The examples below are human/local mode placeholders, not defaults. Replace every placeholder with a verified value; append the confirmed profile if needed.

```bash
multica workspace list --output json
multica project list --workspace-id <workspace-id> --output json
multica issue get <issue-id> --workspace-id <workspace-id> --output json
multica issue comment list <issue-id> --workspace-id <workspace-id> --roots-only --summary --compact --output json
multica issue comment list <issue-id> --workspace-id <workspace-id> --thread <comment-id> --tail 30 --compact --output json
multica issue runs <issue-id> --workspace-id <workspace-id> --active --output json
```

Summaries truncate content: expand relevant threads. `--recent` bounds thread count, not comment count. Read cursor guidance on stderr and pass both `--before` and `--before-id` when required. `--since` returns newly created comments, not every edit; it is not a complete synchronization mechanism. Verify current body/decisions before acting.

`runs --siblings` reports the parent and its children, is advisory rather than a lock, and is capped at 20 rows. `--active` in CLI 0.6.1 lists queued/dispatched/running/waiting_local_directory; do not infer the absence of future scheduled work from an empty response.

## Operation-specific details

### Related issue references

For CLI/API writes of issue bodies or comments, format each related issue as `[任务编号](mention://issue/<真实 UUID>)`. Read the target issue through the authenticated CLI and match its `identifier`, `id`, `workspace_id` and `project_id` to the intended target before constructing the link. A syntactically valid UUID is not evidence of identity. If the mapping or ownership is missing, ambiguous or mismatched, resolve it before publishing the affected reference; do not guess or silently fall back to a plain-text number.

An `issue` link is only a clickable reference: the link itself neither notifies members nor starts an Agent. Do not replace it with an `agent` mention (or a squad mention), which can enqueue execution. Writing the surrounding comment/update can still trigger existing routing; preserve execution.md's authorization and duplicate-trigger checks.

Related references do not create parent/child or duplicate relationships. Change `parent` / `parent_issue_id` or `duplicate_of` only for an explicitly intended, authorized structural relationship, never merely to make a reference clickable. A comment's `--parent` selects its reply thread, not an issue's parent.

Before writing, check link labels, verified UUIDs and the `issue` type; after writing, read back the stored body/comment. Report stored-text/static validation separately from actual page rendering and navigation checks. Do not claim UI verification from CLI readback alone.

For writes or dispatch read execution.md; for creation labels read labels.md. Load only the operation requested.

## Official references

- CLI: https://multica.ai/docs/cli
- Assignment and startup/stop semantics: https://multica.ai/docs/assigning-issues
- Run lifecycle: https://multica.ai/docs/tasks
- PAT and task credentials: https://multica.ai/docs/auth-tokens

Help checked on CLI 0.6.1 (2ea01ae4e), 2026-10-09. These instructions do not assume every server deployment has identical features.
