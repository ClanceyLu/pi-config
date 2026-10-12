# Labels for issue creation

Read multica.md for target verification first.

## Labels during issue creation

Use installed help for `label list`, `label create`, `issue create`, `issue label add`, and `issue label list`. Checked on 0.6.1 (2ea01ae4e), 2026-10-10: issue creation has no label flag; binding is a separate additive operation. `label create` requires name and hex color; explicitly use `--resource-type issue` (a Skill-topic label is still an issue label, not resource type `skill`).

Commands below omit context flags for task-managed mode. In human/local mode append the verified workspace/profile flags supported by that CLI. Never switch credentials to bypass task scope. Verify workspace identity using issue/project/workspace reads and label `workspace_id`; an empty catalog alone does not establish workspace identity.

1. Resolve target and finish body clarification. Read `multica label list --resource-type issue --output json`. Record actual IDs, names, descriptions, colors and workspace. Stop on read failure; do not treat it as no labels. Follow pagination if the installed CLI reports it.
2. Recommend existing labels from confirmed content, with reasons; ask the user to confirm IDs/names or no labels. Preserve explicit prior choices. If a requested label disappeared, changed meaning or belongs elsewhere, ask again instead of substituting. No match is a question, not permission to create.
3. Only if a concrete classification need is unmet, propose a new label with name, purpose, reason existing labels do not fit, visible hex color, workspace and target issue. Obtain explicit authorization to create it AND bind it; a combined explicit approval is valid, a generic approval of existing labels is not. Check case/whitespace variants and semantic equivalents (Bug/缺陷, feature/功能, 领域:Skill/Skill). Re-read immediately before creating to catch concurrent additions. If a new equivalent appears, propose reuse and confirm that changed selection rather than silently creating or substituting.
4. After approval, create only the authorized missing label:

   ```bash
   multica label create --name '<approved-name>' --description '<approved-purpose>' --color '#<approved-hex>' --resource-type issue --output json
   ```

   Verify returned ID against a fresh catalog, including name, color, resource type and workspace. Do not assume a successful exit or parseable stdout alone proves the right resource exists.
5. Create the issue once, from confirmed body/target. In local mode pipe exact UTF-8 text to `multica issue create --title '<confirmed-title>' --project <project-id> --description-stdin --output json`; obey injected runtime file requirements when applicable. Do not add an assignee or change status to facilitate labeling. Record the returned issue ID immediately. If creation is ambiguous, resolve the existing issue through reads before any retry; if identity remains uncertain, stop and report it.
6. Read that issue and its labels before binding. Confirm workspace and existing choices. For each approved missing label:

   ```bash
   multica issue label add <issue-id> <label-id> --output json
   ```

   Add only approved missing IDs; do not replace the set or remove labels added by the user/others. If concurrent labels conflict with the approved intent, pause for clarification. No-label approval means no label writes, not removing labels from an existing issue.
7. Re-read `multica issue get <issue-id> --output json` AND `multica issue label list <issue-id> --output json`. Compare approved IDs with actual bindings and baseline labels; verify workspace, assignee and status remain as intended. State verified labels, preserved baseline labels, missing labels, and any unexpected changes separately. Never call assignment/status/mentions/rerun/wakeup as part of label operations. External label-triggered automations may exist: if known or surfaced, resolve their execution implications before writing; help alone cannot prove their absence.

### Recover without duplicates

- **Label creation failed/timed out/malformed response:** first re-read the issue-label catalog in the same workspace. If one exact authorized label now exists, validate its metadata and use its ID. If only a synonym, conflicting metadata or several candidates exist, ask which to use. Do not edit a candidate to force a match. If a successful read confirms absence and the cause is safely recoverable, retry once under the same authorization, then re-read. If reads fail or outcome remains unclear, stop; do not loop.
- **Binding failed/timed out:** retain the issue ID and read issue, catalog and current bindings. If the approved ID is already attached, no retry is needed. If absent and both IDs/workspace/authorization remain valid, retry that missing binding once and verify. Never recreate the issue or label to retry a binding. If still unresolved, report issue created / label created (if applicable) / binding pending separately.
- **One of several bindings fails:** preserve successful bindings and original labels; resume only missing approved IDs. Do not roll back by deleting labels/issues or report all labels applied.
- **New label exists but issue creation fails:** report that label's ID and unresolved issue creation; preserve it, do not delete or duplicate it automatically.

Record command/version/context, approved choices, observed IDs, verification results and recovery decisions. Distinguish live checks from simulated failure traces and outstanding approval. Do not include credentials.
