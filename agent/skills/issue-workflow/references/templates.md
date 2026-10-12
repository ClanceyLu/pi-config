# Issue templates

Use only the sections that matter. Do not fill unknown facts with guesses. For creation, ask the user to settle undecided content before publishing; remove template prompts and omit inapplicable optional fields. Open authoring questions belong in draft responses, not in a created issue. Confirmed research questions and honestly labeled unverified evidence may remain.

Fill issue templates with direct requirements in the requester's voice, following authoring.md. Do not prefix them with “用户要求” or describe how the issue was prepared. For a small task, combine related fields into a few paragraphs. The handoff and recovery forms below are for relevant operational detail, not a checklist to paste into every result comment.

## Wording examples

These are illustrative rewrites using the same supplied facts, not evidence of work performed.

Task description — before:
> 用户明确要求修复导出 CSV 时中文列名乱码的问题，因为运营无法直接读取。用户希望只改导出编码，并要求旧文件不变、不提交或推送。根据用户指示，需要用含中文列名的样例在 Excel 中检查，并保留现有回归检查。

Task description — after:
> 导出的 CSV 中文列名乱码，影响运营读取。修复导出编码，范围仅限编码处理；保留旧文件，不提交或推送 Git。验收：含中文列名的样例在 Excel 中正常显示，现有回归检查通过。

Delivery — before:
> 我已根据用户要求完成相关修改，并严格遵循不提交、不推送的要求。本次改动涉及导出编码。验证方面，在 macOS 上运行了 `pnpm test -- csv-export`，3 项通过。但没有 Excel，因此还没有验证 Excel 显示。Run 已结束，等待用户验收。

Delivery — after:
> CSV 导出编码已修复，改动尚未提交或推送。macOS 上运行 `pnpm test -- csv-export`，3 项通过。当前环境没有 Excel，中文列名显示仍待人工检查；交审核，尚未验收。

Issue feedback — example:
> authoring.md 无条件引导读取模板和测试参考，普通创建任务可能加载无关内容。删除这些指引或补齐入口的加载条件，并补充二级引用契约检查；保留标签授权和目标核验。修复已授权，由当前负责人实施并提供实际检查结果，完成后交审核。

Keep coordinating-session inspection logs and checklists in chat. This example assumes the fix is authorized: deliver it through an issue reply/update, without adding rerun, agent mentions or status changes to trigger it again. Feedback alone is not an implementation request. Only an explicit request to directly start/restart a Run permits a direct start operation.

## Creation arrangements (conversation, not issue body)

For the same confirmed CSV fix, ordinary creation, create-then-assign, and awaiting-planning requests all use this body:

> 导出的 CSV 中文列名乱码，影响运营读取。修复导出编码，保留旧文件。验收：含中文列名的样例在 Excel 中正常显示，现有回归检查通过。

The operation differs outside the body: ordinary creation uses the verified intended status; create-then-assign also applies the authorized assignee with trigger suppression; awaiting planning uses a verified parked status. Preserve the existing label-confirmation rules in each case. Do not append “仅创建并分配任务，不启动执行” or an internal `multica issue assign/status/rerun` command. Actual reproduction and validation commands may appear when the task needs them.

## Related issue reference example

Given a verified CLI response with matching workspace/project, `identifier: CERE-56` and `id: 01a1254c-fa1b-70bf-98ef-4bc4cab1fb1f`, the body/comment source is:

```markdown
相关任务：[CERE-56](mention://issue/01a1254c-fa1b-70bf-98ef-4bc4cab1fb1f)。
```

This is an illustrative mapping, not a reusable default: verify the actual target before publishing. Plain `相关任务：CERE-56` is insufficient for CLI/API writes. Do not set an issue parent or duplicate relationship, or mention an Agent, just to add this reference. See multica.md for verification and side effects.

## Compact result (optional)

```text
<Concrete result and what remains incomplete>.
<Relevant change or accessible deliverable>.
Validation: <actual method/environment and observed result>.
<Only if relevant: unverified item or blocker, reason, next action/owner>.
```

## Feature

```markdown
## Background and goal
Who has what problem, and what observable result is needed?

## Scope and non-goals
Included:
Excluded:
Compatibility, privacy, permission, and data constraints:

## Context
Repository/version/related links:
Known facts:
Optional approaches (not requirements):

## Delivery and ownership
Deliverables:
Implementer / acceptor:
Required prerequisite deliverables:

## Acceptance
- [ ] Given <condition>, perform <action>, observe <result>; verify with <test/operation>.
- [ ] Under <failure/edge condition>, observe <behavior>; preserve <constraint>.
- [ ] Verify <compatibility/regression> in <environment>.

## Evidence
Links or attachments / environment and commands / results / unverified items and risks:
```

## Bug

```markdown
## Symptom and impact
Actual behavior:
Expected behavior and basis:
Known impact/severity:

## Reproduction and context
Version, OS, commit/branch:
Prerequisites and smallest input:
1. ...
2. ...
Frequency and redacted logs/screenshots:
Suspected cause (unverified):

## Scope and non-goals
Fix scope:
Excluded refactor or feature:
Data, compatibility, and permission constraints:

## Delivery and acceptance
Implementer / acceptor:
- [ ] Original steps no longer reproduce the issue.
- [ ] A regression test or repeatable manual check covers it.
- [ ] Adjacent path/boundary behavior stays correct.
Evidence: fix link, root cause, validation results, and gaps.
```

## Research or discussion

```markdown
## Decision needed
What must be answered, and who will decide what from the result?

## Scope and non-goals
Scenarios, candidates, and comparison criteria:
Not doing: implementation, migration, or live resource changes (adjust as needed).
Constraints: time, budget, privacy, target version:

## Existing context
Known facts, assumptions to verify, existing material:

## Delivery and ownership
Implementer / decision maker:
Deliverable: recommendation, tradeoffs, fit conditions, sources, open questions.

## Acceptance
- [ ] Answer <question>, or state evidence is insufficient and how to gather it.
- [ ] Compare <candidates> by <criteria>; explain the recommendation.
- [ ] Separate sourced facts, inference, and advice; include source date/version.
- [ ] For experiments, report input, environment, method, result, and limits.
- [ ] State next action and decision owner; do not execute advice by default.
```

## Handoff

```text
Current result: what is done / not done
Target: service/profile, workspace, project, issue, repository, branch
Effective decisions: scope, constraints, links
Code: verified Issue/repository/branch/worktree mapping, development base and remote target commits, source commit, original Draft PR URL/head/base (or blocker), baseline content versus task increment, uncommitted changes and conflict risk
Acceptance/integration (when relevant): user acceptance of revision, verified primary branch, validation and same-PR remote merge result; missing closure gates
Validation: environment, commands, results; untested items and why
Blocker: missing thing, owner, release condition
Next: first action for the next session; whether issue reply/update, direct Run start/restart, or push is separately authorized
Delivery: accessible link or platform attachment
```

## Pre-creation label confirmation (conversation, not unresolved issue-body fields)

```text
Target: service/profile or task-managed context, workspace ID/name, project
Confirmed issue: title and settled scope/acceptance
Existing labels recommended: name / ID / reason (from current issue-label catalog)
Existing user selection: preserve or ask about a concrete conflict
Decision: use specified existing labels / no labels / discuss a new label
Only when needed — new label proposal:
  name / purpose / classification need / why existing names and synonyms do not fit
  color: #RRGGBB / resource type: issue / workspace / target issue
  separate authorization: create this label? bind it to this issue?
Wait for unresolved answers before issue creation; no automatic assignment/start.
```

## Label result / recovery handoff

```text
Workspace / issue ID:
Approved existing IDs / approved new name, purpose, color and authorization:
Observed created label ID (if any):
Baseline labels / verified bindings / missing approved bindings:
Issue created? label created? binding verified? (report each separately)
Readback commands and actual results / live versus simulated:
Failure: command, observed error, state read before retry, retry count
Unresolved condition and next authorized action (keep the same issue ID):
Assignee/status and preserved user choices:
```

## Git/PR collaboration examples

- “Review PR 42，只给意见”：核验仓库及 PR head/base，在当前会话 review 并回复发现；不修复、合并、推送或写 Issue。
- “把已确认的这两个文件提交到当前分支，不推送”：核验仓库、分支及暂存/未暂存差异，仅提交授权内容；保留其他改动，不重复要求许可，不创建 Issue。
- “合并指定 PR”：核验 PR、目标分支和已授权的合并方式；在当前会话完成范围内操作，不额外推送无关本地分支。目标存在歧义时先澄清。
- “将当前分支推送到已确认的 origin 分支”：核验远端和目标后执行普通推送；如需强推，先取得对应授权，不因 PM 模式拒绝或分派。
- “修复 review 发现的问题”：代码实施交 Issue 负责人；不额外直接启动 Run，除非另有明确启动授权。

These illustrate decisions, not performed Git operations. Report actual results in chat unless a separate recording requirement applies.

## Explicit follow-up examples

Illustrative outcomes, assuming target checks and readback actually succeeded:

- “跟进 CERE-51”：正文和相关评论已核对，阻塞原因仍是缺少复现数据；跟进分析完成后，已核验状态从 blocked 改为 todo。状态迁移不代表阻塞已解决。
- “跟进审核中的任务”：总结交付情况及未验证项后，重新核验归属、状态和 revision，in_review → todo；不表示人工验收或关闭。
- “只查看 CERE-51，不改状态”：只报告事实；即使当前 blocked 也不迁移。
- 写前发现 blocked 已变为 in_review：保留最新状态，报告并发变化；不套用另一条迁移覆盖。
- 写入超时但读回 todo：报告已核验的 todo，只执行了一次写入；不补 rerun 或 Agent mention。

These examples authorize no real operation. Apply follow-up.md for completion, ownership, concurrency, trigger suppression and readback; keep the operation plan out of the issue body.
