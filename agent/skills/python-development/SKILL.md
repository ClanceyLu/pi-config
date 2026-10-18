---
name: python-development
description: Use uv to create, configure, synchronize, and run Python project environments. Apply whenever working on a Python project or handling Python versions, virtual environments, dependencies, lockfiles, tests, scripts, or tooling; prefer uv over pip, venv, virtualenv, Poetry, Pipenv, or Conda unless the user or existing project explicitly requires otherwise.
compatibility: Requires the uv command-line tool, or permission to install it.
---

# Python Projects with uv

Use **uv** as the default Python project and environment manager for every Python task.

## Core rules

1. Inspect the repository before changing anything. Look for `pyproject.toml`, `uv.lock`, `.python-version`, `requirements*.txt`, `setup.py`, `setup.cfg`, and existing environment-manager configuration.
2. Check availability with `uv --version`. If uv is unavailable, tell the user and ask before installing it or provide the official installation command appropriate for the platform.
3. Do not install project packages globally.
4. Do not use bare `pip`, `python -m pip`, `python -m venv`, or `virtualenv`. Use their uv equivalents.
5. Preserve existing project metadata and conventions. Do not migrate another package manager, replace its lockfile, or substantially rewrite dependency configuration unless the task requires it or the user approves.
6. Prefer reproducible, locked environments. Commit `uv.lock` for applications; follow the repository's existing policy for libraries.

## Standard workflow

### Existing uv project

```bash
uv sync
uv run <command>
```

If lockfile fidelity is required, such as in CI:

```bash
uv sync --locked
```

### New Python project

```bash
uv init
uv add <package>
uv add --dev <development-package>
```

Use `uv init --lib` when creating a library rather than an application.

### Python versions

Honor `requires-python` and `.python-version`. When a required interpreter is missing:

```bash
uv python install <version>
uv python pin <version>
```

Only pin a version when appropriate for the project; do not overwrite an intentional existing pin.

### Dependency management

```bash
uv add <package>
uv add --dev <package>
uv remove <package>
uv lock
uv sync
```

Edit dependency files manually only when `uv add`/`uv remove` cannot express the required change or when preserving a specialized existing layout demands it. Refresh the lockfile after dependency changes.

### Running commands

Run all Python-based project commands inside the uv-managed environment:

```bash
uv run python <script.py>
uv run pytest
uv run ruff check .
uv run mypy .
```

For an ephemeral tool that should not become a project dependency, use:

```bash
uvx <tool> [args]
```

### Legacy requirements-based projects

Avoid an unsolicited migration. Create and populate a uv-managed environment while retaining the requirements files:

```bash
uv venv
uv pip install -r requirements.txt
```

Prefer `uv run ...` afterward. If the user asks to modernize the project, migrate dependencies to `pyproject.toml` deliberately and verify the resulting environment and lockfile.

## Verification

After setup or dependency changes:

1. Run `uv sync` (or `uv sync --locked` when validating an existing lockfile).
2. Run the project's relevant checks through `uv run`, such as tests, linting, type checking, or the application entry point.
3. Report changed files, the commands run, and any uv/Python version constraints or unresolved compatibility issues.
