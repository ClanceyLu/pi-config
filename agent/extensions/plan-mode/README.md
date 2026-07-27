# Pi Plan Mode

A branch-aware Plan Mode for Pi with a fail-closed read-only planning phase, explicit revision approval, and structured execution progress.

Pi automatically discovers the global extension at `~/.pi/agent/extensions/plan-mode/index.ts`; no `settings.json` package entry is required.

## Commands

- `/plan` or `/plan on` — enter Plan Mode with a fresh snapshot of the current normal tools
- `/plan status` — show phase, shell policy, and unknown-tool policy
- `/plan show` — show the current proposal
- `/plan approve` — approve the currently awaiting revision and restore the pre-plan tool set
- `/plan approve safe` — approve the currently awaiting revision with confirmation before shell or mutation tools
- `/plan revise [feedback]` — invalidate approval and require a complete new proposal
- `/plan off` — leave without approving
- `/plan cancel` — leave and discard the current plan
- `/plan export [path]` — explicitly export the current plan; defaults to `.pi/plans/<normalized-title>.md`
- `Ctrl+Alt+P` — enter Plan Mode or show the active plan
- `pi --plan` — start or resume a session in read-only Plan Mode

## Workflow

1. Plan Mode snapshots the exact active normal tools and exposes only inspection plus `plan_question` and `propose_plan`.
2. A runtime `tool_call` gate remains authoritative even if another extension re-enables a blocked tool.
3. `propose_plan` stores a structured revision and shows the complete Markdown in a read-only review before the approval choices.
4. Only that awaiting revision can be approved. Normal input, revision, staying in Plan Mode, or pausing execution with `/plan on` requires a complete new proposal.
5. Approval either restores the exact pre-plan snapshot or confirms shell/mutation calls individually, then activates `update_plan`.
6. Completion or leaving restores the exact snapshot and clears it from terminal state.
7. State is branch-aware. `/tree` navigation restores the target branch's phase, plan, widget, and tools; branches without Plan Mode restore normal tools without adding a navigation-only state entry.

## Configuration

Optional global config: `~/.pi/agent/plan-mode.json`

Optional trusted project config: `.pi/plan-mode.json` (valid values override global values by field; `tools` merges by tool name)

```json
{
  "shellPolicy": "inspect",
  "unknownTools": "deny",
  "tools": {
    "my_read_only_tool": "allow",
    "my_mutating_tool": "deny"
  }
}
```

- `shellPolicy`: `strict` disables agent Bash; `inspect` uses a conservative read-only command classifier.
- `unknownTools`: `allow`, `ask`, or `deny`. The default is `deny`.
- `tools`: exact tool-name overrides. `tools.bash: "deny"` removes Bash; Bash overrides cannot bypass command-level inspection.

The default policy denies tests, builds, native search, `wget`, shell composition, expansion, redirection, and unrecognized executables. `curl` is limited to one or more HTTPS URLs plus separate `-s`, `-S`, `-f`, `-L`, `-I`, `--silent`, `--show-error`, `--fail`, `--location`, `--head`, or `--compressed` tokens, and still requires one-time approval.

Setting `unknownTools` or a tool override to `ask` or `allow` explicitly trusts third-party tool behavior and can weaken the read-only guarantee.

Invalid fields produce warnings without discarding other valid fields in the same layer. An unreadable or invalid global/project layer is skipped without suppressing the other layer.

## Export safety

No project file is written during planning except through explicit `/plan export`. The default filename preserves Unicode letters and numbers after NFKC normalization and is limited to 60 code points. Export uses exclusive creation. If the target exists, TUI/RPC asks before overwriting; refusing leaves the file unchanged, and a UI-less invocation fails explicitly.

## Verification

From `~/.pi`:

```bash
node --test --experimental-strip-types agent/extensions/plan-mode/*.test.ts
```

Explicit-load smoke:

```bash
printf '%s\n' '{"id":"1","type":"get_commands"}' | \
  pi --offline --mode rpc --no-session --no-extensions \
  -e ./agent/extensions/plan-mode/index.ts \
  --no-skills --no-context-files --no-approve
```

`pi --offline --help` should also list `--plan  Start in read-only Plan Mode`, confirming global auto-discovery.
