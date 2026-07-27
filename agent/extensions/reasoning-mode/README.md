# Pi Reasoning Mode

A branch-aware, fail-closed read-only container that pins one explicitly marked reasoning skill into the system prompt. The default `explore` skill supports incremental discussion, while `plan` produces a decision-ready implementation plan.

## Commands

- `/reasoning` or `/reasoning on` — enter Reasoning Mode with the default `explore` skill
- `/reasoning <skill> [task]` — activate a skill whose metadata contains `reasoning-mode: "true"`
- `/reasoning status` — show mode, active skill, and policy
- `/reasoning off` — restore the exact pre-mode tool set
- `/plan [task]` — shortcut for `/reasoning plan [task]`
- `/plan approve` — approve the active plan, leave Reasoning Mode, restore the pre-mode tools, and start execution
- `/skill:explore [task]` or `/skill:plan [task]` — also enters Reasoning Mode before the skill runs
- `Ctrl+Alt+P` — activate or show the plan skill
- `pi --reasoning` / `pi --plan` — start in the corresponding mode

Reasoning Mode never exits because the user merely says "implement", "approve", or "proceed". Use `/reasoning off` explicitly, or `/plan approve` after the plan skill has produced a complete final plan to exit and immediately execute it. Approval is rejected while clarification is still in progress, when the plan workflow is not active, or when the agent is busy. On exit, the extension records a hidden model-facing transition so instructions from the former mode and skill are not carried into the next request. Only one reasoning skill is active at a time: activating `plan` replaces `explore`, and `/reasoning on` switches back to `explore`.

The core mode prompt owns read-only safety, tool restrictions, evidence requirements, and explicit exit behavior. Skills specialize the workflow but cannot relax those invariants. If a newly requested skill is unavailable, activation is rejected without changing the current mode or tool set. Saved v1 sessions that used skill-less neutral Reasoning Mode migrate to `explore` when restored.

## Configuration

Global: `~/.pi/agent/reasoning-mode.json`

Trusted project: `.pi/reasoning-mode.json`

```json
{
  "shellPolicy": "inspect",
  "unknownTools": "deny",
  "tools": {
    "my_read_only_tool": "allow"
  }
}
```

`shellPolicy: "strict"` disables Bash. `inspect` permits only conservatively classified inspection commands. `edit` and `write` are always denied. `questionnaire` is temporarily enabled only when it is installed and Pi is running in TUI mode.

Legacy `plan-mode.json` files are read with lower precedence and produce a deprecation warning.

## Reasoning skill contract

A skill opts in explicitly:

```yaml
metadata:
  reasoning-mode: "true"
```

The extension reads the skill from Pi's discovered resource list and injects its body on every turn while active, so compaction and session resume do not lose the workflow.
