# Pi Reasoning Mode

A branch-aware, fail-closed read-only mode that can pin explicitly marked reasoning skills into the system prompt.

## Commands

- `/reasoning` or `/reasoning on` — enter neutral Reasoning Mode
- `/reasoning <skill> [task]` — activate a skill whose metadata contains `reasoning-mode: "true"`
- `/reasoning status` — show mode, active skill, and policy
- `/reasoning off` — restore the exact pre-mode tool set
- `/plan [task]` — shortcut for `/reasoning plan [task]`
- `/skill:plan [task]` — also enters Reasoning Mode before the skill runs
- `Ctrl+Alt+P` — activate or show the plan skill
- `pi --reasoning` / `pi --plan` — start in the corresponding mode

Reasoning Mode never exits because the user says "implement" or "proceed". Use `/reasoning off` explicitly.

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
