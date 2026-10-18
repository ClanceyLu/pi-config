---
name: node-development
description: Manage Node.js, JavaScript, and TypeScript packages, dependencies, lockfiles, workspaces, and scripts with pnpm. Apply whenever working in a JS/TS project or a repository containing package.json, or when handling dependency install/add/remove/upgrade, node_modules, monorepos, lockfiles, publishing, or any npm, npx, yarn, or bun command. Prefer pnpm over npm, npx, yarn, and bun unless the repository or the user explicitly requires otherwise.
compatibility: Requires the pnpm command-line tool, or permission to install it.
---

# Node.js Projects with pnpm

Use **pnpm** as the default package manager for every JavaScript and TypeScript task. Do not install, remove, resolve, or run project dependencies through `npm`, `npx`, or `yarn`.

## Core rules

1. Inspect the repository before changing anything. Look for `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `package-lock.json`, `yarn.lock`, `.npmrc`, `.nvmrc`/`.node-version`, the `packageManager` field, and CI workflow files.
2. Check availability with `pnpm --version`. If pnpm is missing, prefer `corepack enable pnpm` so the version pinned by `packageManager` is honored; otherwise report the situation and ask before installing.
3. Never run `npm install`, `npm ci`, `npm run`, `npx`, or `yarn` as a workaround, and never use them "just to read" registry data (`npm view` becomes `pnpm view`). If a step seems impossible without npm, stop and report why instead of silently switching tools.
4. Type `pnpm` explicitly. A shell alias such as `alias npm=pnpm` does not apply to the non-interactive shells you spawn, and aliases never affect child processes, CI, containers, or git hooks.
5. Do not create `package-lock.json` or `yarn.lock`. If one exists, mention it and ask before deleting it. When a migration is actually wanted, use `pnpm import`.
6. Honor the version and configuration the project already pins. Do not upgrade pnpm or rewrite dependency configuration unless the task or the user calls for it.
7. Install globally only standalone CLIs the user asked for, never project dependencies.

## Command mapping

| npm | pnpm |
| --- | --- |
| `npm install` | `pnpm install` |
| `npm ci` | `pnpm install --frozen-lockfile` (newer pnpm also has `pnpm ci`: clean + frozen install) |
| `npm install <pkg>` | `pnpm add <pkg>` |
| `npm install -D <pkg>` | `pnpm add -D <pkg>` |
| `npm install -g <pkg>` | `pnpm add -g <pkg>` |
| `npm uninstall <pkg>` | `pnpm remove <pkg>` |
| `npm run <script>` | `pnpm run <script>` (or `pnpm <script>`) |
| `npm test` | `pnpm test` |
| `npm run <script> -- <args>` | `pnpm run <script> -- <args>` |
| `npx <bin>` | `pnpm exec <bin>` when installed; `pnpm dlx <pkg>` for a one-off download |
| `npm init <starter>` | `pnpm create <starter>` |
| `npm ls` | `pnpm list` (`-r` for all workspace projects) |
| `npm why <pkg>` | `pnpm why <pkg>` |
| `npm outdated` / `npm update` | `pnpm outdated` / `pnpm update` |
| `npm audit` / `npm audit fix` | `pnpm audit` / `pnpm audit --fix` |
| `npm dedupe` / `npm prune` | `pnpm dedupe` / `pnpm prune` |
| `npm pack` / `npm publish` | `pnpm pack` / `pnpm publish` |
| `npm link` | `pnpm link` |
| `npm login` / `whoami` / `logout` | same names under pnpm |
| `npm view <pkg>` | `pnpm view <pkg>` |
| `npm config get` / `set` | `pnpm config get` / `set` (or `pnpm get` / `pnpm set`) |
| `npm pkg set ...` | `pnpm pkg set ...` |
| (none) | `pnpm patch <pkg>` then `pnpm patch-commit <dir>` to patch a dependency |

`pnpm` commands the npm CLI has no equivalent for and that are worth knowing: `pnpm import` (build `pnpm-lock.yaml` from an existing npm/yarn lockfile), `pnpm ignored-builds`, `pnpm approve-builds`, `pnpm doctor`, `pnpm deploy`, `pnpm clean` (newer versions). Confirm version-specific commands with `pnpm help <cmd>` before using them: an unknown pnpm subcommand silently falls back to running a same-named `package.json` script.

## Standard workflow

### Existing project

```bash
pnpm install                 # resolve and update pnpm-lock.yaml when the manifest changed
pnpm install --frozen-lockfile   # validate that the lockfile matches the manifest, no writes
pnpm run <script>
```

### New project

```bash
pnpm init
pnpm add <package>
pnpm add -D <development-package>
```

### Dependency changes

```bash
pnpm add <package>            # also: -D, -O, -P, -E, -g, -w
pnpm remove <package>
pnpm update                   # or: pnpm update <pkg> --latest
pnpm install                  # refresh the lockfile after manual manifest edits
```

Prefer the CLI over hand-editing `package.json`; if you do edit the manifest by hand, run `pnpm install` so `pnpm-lock.yaml` stays in sync.

### Scripts and one-off tools

```bash
pnpm run build
pnpm run test -- --watch         # use `--` so pnpm does not consume the flags
pnpm exec tsc --noEmit           # binary provided by an installed dependency
pnpm dlx <tool>@latest           # temporary environment, no project install
pnpm create vite my-app
```

For recursive runs, `--if-present` must come **before** the subcommand, otherwise it is forwarded to the script itself:

```bash
pnpm -r --if-present run build   # correct
pnpm -r run build --if-present   # wrong: the flag reaches each script
```

## Workspaces and monorepos

`pnpm-workspace.yaml` declares the workspace; newer pnpm versions also read settings such as `onlyBuiltDependencies`, `overrides`, and `catalog` from it.

```bash
pnpm -r run build                        # every workspace project
pnpm -r --filter "./packages/*" run test # filtered by path glob
pnpm --filter <name> add <pkg>           # dependency in one project
pnpm add -D -w <pkg>                     # dev dependency in the workspace root (-w is required there)
pnpm -r --filter "[origin/main]" run test   # only projects changed since a git ref
pnpm deploy --filter <name> --prod ./out    # standalone deployment bundle
```

Define shared versions once with a catalog and reference it as `catalog:` in each manifest, for example `pnpm add --save-catalog <pkg>`.

## Lockfile and CI

- Commit `pnpm-lock.yaml` for applications; follow the repository's existing policy for published libraries.
- Never hand-edit the lockfile. Regenerate it with `pnpm install` after manifest changes, or repair it with `pnpm install --fix-lockfile`.
- In CI use `pnpm install --frozen-lockfile` (default there when a lockfile is present) and fail the build instead of rewriting the lock.
- Cache the pnpm store, found via `pnpm store path`. For cache-only or air-gapped runs use `--offline` (or `--prefer-offline`). `pnpm fetch` hydrates the store from a lockfile without installing.
- Do not assume `pnpm run` is install-free: pnpm may verify or refresh dependencies before running a script (`verify-deps-before-run` setting on some versions). Run an explicit `pnpm install --frozen-lockfile` first when the install step must be controlled.

## Dependency build scripts (pnpm 10 and newer)

Dependency lifecycle scripts are blocked by default. When a package clearly needs one (native addons such as `esbuild`, `sharp`, `node-gyp`-based packages, `prisma`):

```bash
pnpm ignored-builds                 # list blocked packages
pnpm approve-builds <pkg>           # approve specific packages
pnpm approve-builds --all           # only when the user agrees to blanket approval
```

Approval is persisted in `onlyBuiltDependencies` (`pnpm-workspace.yaml` on newer versions, `.npmrc` on older ones). Never approve everything silently, and never disable script blocking wholesale.

## Migration from npm or yarn

Only migrate when the user asks or the task requires it. Otherwise keep the existing manager's files untouched and do the new work with pnpm commands.

```bash
pnpm import          # generate pnpm-lock.yaml from package-lock.json or yarn.lock
pnpm install
```

Afterwards: remove the old lockfile only with the user's approval, update `packageManager`, CI steps, `Dockerfile`s, git hooks, README instructions, and any scripts that call `npm` or `npx`.

## Troubleshooting

- **A dependency or CLI is "not found" at runtime**: pnpm keeps an isolated, symlinked `node_modules`, so code relying on hoisting can break. Fix the import or declare the missing dependency. Setting `node-linker=hoisted` is a last resort that changes the layout for everyone, so propose it before applying it.
- **A tool insists on npm**: run the underlying binary with `pnpm exec`, or install the tool with `pnpm dlx`. Report the blocker rather than installing with npm.
- **Node version**: use the project's pinned version through the existing version manager (`fnm`, `nvm`, `volta`), or `pnpm runtime` on newer pnpm versions (`pnpm env` is deprecated).
- **Registry, proxy, or auth problems**: `pnpm config get registry`, `pnpm ping`, and `~/.npmrc` (shared with npm) usually explain it.
- **Unexplained environment issues**: `pnpm doctor`.

## Verification

After setup or dependency changes:

1. Run `pnpm install --frozen-lockfile` (or `pnpm install` and confirm the lockfile change is intentional).
2. Run the project's checks through pnpm: `pnpm run test`, `pnpm run lint`, `pnpm run build`, or the app entry point.
3. Sanity-check the tree with `pnpm list --depth 0` (and `pnpm -r list --depth 0` in a workspace).
4. Report the commands run, files changed (`package.json`, `pnpm-lock.yaml`, workspace files), the pnpm and Node versions used, any pending build approvals, and anything still blocked.
