# Issue authoring

## Write an actionable issue

Write in the requester's voice without inventing personal claims: describe what needs to change, why, and how completion will be judged. Do not frame requirements as “用户明确要求”, “用户希望”, “根据用户指示”, or declarations that the agent followed instructions. Omit drafting/submission steps and internal deliberation. Keep decision provenance only when it matters to scope or authority.

Use short sentences and concrete terms. Combine overlapping points; use paragraphs for connected ideas and lists for comparable items. The structure below is a coverage guide, not a requirement to repeat every heading for small tasks. Preserve all material constraints, evidence qualifiers and authorization boundaries when shortening; never turn a suggestion into a requirement or an unverified observation into a fact.

Use a result or symptom as the title, not a file edit. Keep the body proportional to the task:

1. Background and impact: observed facts, who is affected, why it matters.
2. Goal: an observable result, or a decision question for research.
3. Scope and non-goals: identify allowed modules/files and behavior; include real compatibility, privacy, permissions, and data-preservation constraints. UI-only work excludes map configuration, backend services and signing-rule replacements; necessary scope expansion needs separate review and authorization.
4. Context: repository/version, reproduction inputs, relevant links and decisions; redact secrets.
5. Deliverables and ownership: what is handed over, who implements, who accepts.
6. Acceptance: pass/fail observations, validation method/environment, normal and important failure/edge cases. Acceptance targets the final merged artifact: record its commit and, for Android, APK SHA-256 and build type; production maps require Release physical-device validation, and web flows require a real authorized test environment. Define preservation checks for existing capabilities affected by deletions/replacements.

For draft-only requests, even a vague request gets a usable skeleton with Goal, Scope/non-goals, Deliverables, and Acceptance sections; mark unknowns in the response, not in a published issue. For creation requests, clarify undecided content with the user first, then create only from confirmed answers. For "improve a plugin", ask which plugin and what observable problem/result, and confirm scope and acceptance before creation; never invent them as agreed. A confirmed research question or accurately labeled unverified observation is valid issue content, not an unresolved authoring decision; never present unknown results as verified.

Separate outcomes from proposed implementation. A technical constraint explicitly required by the user remains a constraint. "Code written", "three files added", or "run completed" is not sufficient acceptance. State whether merge, release, or user acceptance is required; they are different events.

For related Multica issues in a body or comment to be written through CLI/API, use `[任务编号](mention://issue/<真实 UUID>)`, not only a plain-text identifier. Verify the identifier/UUID pair and workspace/project ownership before constructing the link; never invent IDs. Draft-only requests do not authorize platform reads or writes: mark an unresolved reference in the draft and verify it before publication. For platform writes, follow the reference and relationship rules in `multica.md`.

## Keep execution control outside the body

Do not automatically add “不启动执行”, “仅创建并分配任务”, “仅分配”, or equivalent execution switches to the body, scope, non-goals or acceptance. Creation/assignment arrangements and internal CLI scheduling commands belong in platform operations and, when useful, the conversation's operation summary. Apply this to ordinary creation, create-then-assign and tasks awaiting planning alike. Preserve actual task requirements: a reproduction/test command, a requested CLI implementation, investigation-only scope, data preservation and explicit Git restrictions are valid content.

Use the platform's verified status configuration to represent planning and execution readiness; follow execution.md for authorization, trigger suppression and readback. If the intended state cannot be established safely, resolve that operational uncertainty before the affected write; do not compensate with prose in the issue. Do not rewrite historical issues or comments as part of adopting this rule.

## Split only when useful

- Project: shared context and resources for multiple goals; do not create one for a small fix.
- Parent issue: an integrated outcome with an owner responsible for overall acceptance.
- Sub-issue: independently owned, discussed, blocked, delivered, or reviewed work.
- Checklist: steps within one owner and one delivery; default for small tasks.

Prefer independently verifiable outcomes over mechanical frontend/backend/test partitions. Each sub-issue needs its own context and acceptance plus shared constraints. Write what prerequisite delivery must be accepted before work starts. Parent/child structure is not itself a dependency graph.

Parallelize only when outputs, working directories, and shared resources do not conflict. Different issues or agents do not make shared-file edits safe. A parent is not done merely because all children are closed. For a single implementer, prefer one active implementation task unless parallel work has clear value.

## Labels

Reuse existing workspace labels and naming; do not create labels merely because this skill lists them. Normally choose one primary work type: Bug, feature, improvement, research, discussion, maintenance, or documentation (use established local-language equivalents).

Add area labels such as plugin, Skill, workflow, or integration only for recurring filtering needs. Blocked/needs-clarification markers require an explanation and removal when resolved. Do not duplicate status, priority, assignee, project, or dates in labels. A security label does not restrict visibility; sensitive vulnerability details need an appropriate private channel.

Label selection is part of issue creation, not just advice in the body. Once the issue content is confirmed, read the target workspace's actual issue-label catalog, explain suitable existing labels, and obtain the user's selection before creating. An explicit selection already given is sufficient; preserve it. If the user declines labels, create without them. If none fit, ask whether to proceed without labels or consider a concrete new-label proposal; silence is not consent.

New labels require separate explicit authorization for their name, purpose, reason, color, target workspace, and binding to the target issue. Approval to select existing labels or create an issue does not authorize label creation. Check same-name and synonymous labels first; do not build a catalog for hypothetical future needs. Do not modify/delete existing labels.

For Multica, follow the creation, binding, verification and recovery sequence in `labels.md` (shared target checks: `multica.md`). Preserve existing selections, issue identity and execution authorization during recovery. Report partial success accurately.
