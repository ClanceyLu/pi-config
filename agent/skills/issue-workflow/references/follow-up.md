# Follow up and deliver

Read the current issue body, scan comment threads and expand relevant ones using multica.md. Read active Runs when reporting execution state. Summarize facts, blockers and next action. Do not update, reassign, restart or monitor unless explicitly requested.

Git/PR collaboration results stay in chat unless recording is separately required; this Issue delivery workflow does not force an Issue write for a PR review, commit, merge or push.

For authorized code implementation by the owner, reply to or update the issue with the problem, required changes and next step; use execution.md for the write and direct-start boundaries. A general fix request does not authorize rerun. Read-only inspection and review-only feedback remain non-implementation requests.

## Feedback and delivery

The body holds current requirements; comments hold decisions, changes, evidence, and handoffs. Changes to scope or acceptance need a reason and an impact statement. Record blockers with the missing condition, who can resolve it, and what allows continuation.

Issue feedback states the problem, impact, required fix and next action directly. Do not use internal review headings such as “Review 结论” or “复核结论”, or retell user instructions. Keep the coordinating session’s inspection process, checklists and execution results in chat; put only implementation facts, constraints and actionable problems on the issue. The assigned implementer still delivers actual validation evidence, unfinished work and material risks.

Report meaningful new facts, not a tool-call diary. Normal local pi sessions may post authorized progress updates. A managed Agent Runtime may impose different delivery/thread rules: obey the actual injected instructions, not assumptions from another deployment.

Lead with the concrete outcome and its completion boundary. Then give the changes that explain it, the validation actually performed (method/environment and observed result), and any unfinished or unverified items with the next action. Scale detail to the task: a small change usually needs a short paragraph and a few evidence points, not a full handoff form. Omit empty sections, repeated requirements, self-evaluation and declarations of compliance. Keep necessary permissions, blockers and acceptance boundaries explicit.

Separate checks that passed, checks that failed, and checks not run; explain material gaps. A proposed command is not validation evidence, a manual/static review is not a live test, and a successful Run is not human acceptance. Read `templates.md` only for a requested template/handoff.

Before handoff, provide accessible deliverables, actual validation commands/environment/results, unmet acceptance, risks, and the next owner/action. A local absolute path is not a remotely accessible deliverable. Review attachments or exported sessions for sensitive content before sharing.

For AI delivery, recommend review rather than claiming human acceptance. Do not change status merely because the process exited. Close only when the requested acceptance is met and closure is authorized; mark untested items explicitly. Do not change status for pure consultation unless requested.

Across sessions, leave a durable record with service/profile and workspace, current scope and decisions, code location/branch/commit or uncommitted work, validation, blockers, next action and authorization, and links/attachments. Resuming a pi session is helpful but cannot replace this record. This skill does not monitor future comments or wake a closed local pi session.
