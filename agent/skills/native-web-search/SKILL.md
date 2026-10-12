---
name: native-web-search
description: "Trigger native web search. Use when you need quick internet research with concise summaries and full source URLs."
---

# Native Web Search

Use this skill to run native web search and get a concise research summary with explicit full URLs. It uses the saved Pi default model unless `--model` is supplied; choose a supported smaller model explicitly when speed or cost matters.

## Script

- `search.mjs`

## Usage

Run from this skill directory:

```bash
node search.mjs "<what to search>" --purpose "<why you need this>"
```

Examples:

```bash
node search.mjs "latest python release" --purpose "update dependency notes"
node search.mjs "vite 7 breaking changes" --purpose "prepare migration checklist"
```

Optional flags:

- `--provider openai-codex|anthropic`
- `--model <model-id>`
- `--timeout <ms>`
- `--json`

## Output expectations

The script instructs the model to:
- search the internet for the requested topic
- provide a concise summary for the given purpose
- include full canonical URLs (`https://...`) for each key finding
- highlight disagreements between sources

## Notes

- Requires Node.js and Pi 0.87.1 or newer on PATH; no extra npm install is required.
- Set `PI_EXECUTABLE` to an executable path if `pi` is not on PATH.
- Authentication is delegated to `pi auth check --json --credentials`, supporting API keys and OAuth; secret output is captured privately. Do not run credential-printing commands directly in conversation-visible tools.
- Pi handles credential refresh and environment-variable interpolation. The script never reads or writes `auth.json` itself.
- Only the first-party `openai-codex` and `anthropic` search endpoints are supported, not arbitrary compatible proxies.
- When selecting a provider different from the saved default, also supply `--model <id>`. Unsupported defaults fail explicitly instead of silently switching providers or using retired model IDs.
