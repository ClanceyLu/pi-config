---
name: git-commit-cn
description: "Generate, rewrite, validate, and—only when explicitly requested—apply Chinese Conventional Commit messages using lowercase types such as `feat`, `fix`, `refactor`, `docs`, `test`, `style`, `chore`, `perf`, `build`, `ci`, and `revert`. Use when the user asks to commit code, requests a Chinese commit message, wants a message rewritten into Conventional Commits format, or wants staged or working-tree changes summarized as `type(scope): 中文摘要`."
---

# Git Commit CN

## Overview

检查实际 Git 状态和 diff，遵循仓库已有约定，选择最具体的 Conventional Commit 类型，并生成简洁、具体、以结果为导向的中文提交信息。
只提交用户明确授权的预期变更，不擅自扩大暂存范围或绕过仓库保护机制。
本 Skill 只负责本地提交；提交授权不包含 `git push`、`git pull`、`git fetch` 或其他远程仓库操作，远程操作必须由用户另行明确要求。

## Operation Modes

先判断用户请求属于哪种模式：

1. **仅生成信息**：用户要求生成、改写、检查或推荐 commit message 时，只执行只读检查并输出建议，不执行 `git add` 或 `git commit`。
2. **提交已暂存变更**：用户明确要求“提交”“commit”或应用该提交信息，且已有 staged 变更时，只提交当前预期的 staged snapshot。
3. **暂存指定范围并提交**：只有用户明确要求提交指定路径、pathspec 或所有当前变更时，才允许暂存对应范围。指定路径只授权该范围；“提交所有当前变更”才授权暂存全部。只说“提交代码”且暂存区为空时，不得推断为暂存全部，应询问用户。

除非用户分别明确授权，否则禁止执行：

- 超出用户指定范围的 `git add`，以及 `git reset`、`git restore`、`git stash` 或部分暂存
- `git commit --amend`、`git rebase`、`git cherry-pick` 或其他历史改写
- `git commit --no-verify`、`--allow-empty` 或跳过签名/检查的选项
- 修改 Git 配置

如果用户要求拆分提交，只提出拆分方案；未经授权不要自行调整 index。

## Workflow

### 1. Inspect repository state and conventions

使用非交互命令检查仓库：

- `git status --short`
- `git log -30 --format=%s`（仓库已有提交时；规律不明确时最多检查最近 50 条）
- 仓库中现有的 commitlint 配置、`CONTRIBUTING.md` 或其他明确提交规范（容易获取时）

仓库已有的 type、scope、标题长度和 footer 约定优先于本 Skill 的默认建议。

### 2. Interpret caller guidance

将用户随请求或 Skill 调用提供的参数视为额外指导：

- 自然语言说明可以影响 type、scope、summary 和 body，但必须与实际 diff 一致。
- 用户指定的 type、scope 或完整消息是优先偏好；如果与 diff 或仓库规范明显冲突，应指出冲突，不能静默照用或擅自改写后提交。
- 文件路径、目录、glob 或 Git pathspec 用于限制检查、暂存和提交范围；同时提供路径和说明时，两者都要遵守。
- 将用户提供的路径作为数据处理，Git 命令中使用 `--` 分隔选项与路径，并正确引用 glob/pathspec，避免 shell 提前展开或把路径解析成选项。
- 不要自行扩大用户指定的路径或 glob 范围。如果无法判断某个文件是否应包含，列出有歧义的文件并询问用户。

### 3. Select the exact snapshot

- 存在 staged 变更且用户未授权新的暂存范围时，使用 `git diff --cached --stat`、`git diff --cached --name-status` 和 `git diff --cached`，并且只根据 staged snapshot 生成信息。
- 用户明确要求提交指定路径时，先确认现有 staged 内容没有超出指定范围，再检查这些路径内的 tracked、deleted 和 untracked 变更；确认范围后才可使用 `git add -A -- <paths-or-pathspecs>`。指定 glob/pathspec 必须正确引用，并在暂存后核对实际匹配文件。
- 用户明确要求提交所有当前变更时，才可使用 `git add -A`；执行前仍应检查 untracked 文件和疑似敏感、生成或临时文件，存在歧义时先询问。
- 指定路径时如果暂存区包含范围之外的文件，应停止并询问用户，不得自行 reset，也不得把额外文件一起提交。
- 同一文件同时存在 staged 和 unstaged 变更时，未授权重新暂存该文件则只描述 staged 内容；必要时提醒用户提交后仍会保留未暂存变更。
- 暂存区为空时，仅在“生成信息”模式下使用 `git diff --stat`、`git diff`，并结合 `git status --short` 识别相关 untracked 文件。`git diff` 不包含 untracked 文件，必要时只读检查用户意图范围内的新文件。
- 执行提交模式下，如果暂存区为空且用户没有明确授权暂存范围，应输出候选信息并询问用户要暂存哪些文件。
- 没有可描述的变更、存在未解决冲突，或无法确认提交范围时，停止并询问用户，不猜测、不创建空提交。

### 4. Identify the dominant outcome

选择一个最重要的用户可见或工程结果，并判断改动是否足够原子化：

- 单一主题：生成一个提交信息。
- 多个相关变化：按主结果决定 type，正文可补充重要上下文。
- 多个无关主题：建议拆成多个提交，不使用模糊摘要掩盖混合改动，也不擅自操作暂存区。

### 5. Choose type and scope

优先使用仓库已有约定；没有明确约定时按下文规则选择最具体的 type。
仅当一个模块、目录或子系统明显占主导时使用简短 scope；跨多个区域时省略 scope。

### 6. Compose and validate the message

标题格式：

```text
type(scope): 中文摘要
```

没有合适 scope 时：

```text
type: 中文摘要
```

正文只在解释原因、迁移影响、跨模块变化、破坏性变更或重要后续事项时添加，不重复标题。

### 7. Verify before committing

执行提交前重新运行：

- `git status --short`
- `git diff --cached --stat`
- `git diff --cached --name-status`
- `git diff --cached`
- `git diff --cached --check`

确认暂存区非空、没有未解决冲突、没有空白错误，并且 staged snapshot 与用户意图一致。用户指定路径时，确认所有 staged 文件都在授权范围内。发现无关文件或范围不明确时停止并询问，不要提交。
遵循仓库要求的测试或校验流程；未运行的测试必须如实说明，不得声称通过。

### 8. Commit safely and verify the result

- 优先将完整提交信息写入临时文件，再使用 `git commit -F <message-file>`，随后删除临时文件。
- 不要把包含引号、反引号、`$`、`!` 或其他 shell 特殊字符的动态消息直接拼入 shell 命令。
- 简单且已安全转义的单行标题才可使用 `git commit -m`；需要正文时优先使用消息文件。
- 如果 Git hooks、签名或提交命令失败，报告原始错误并停止；不要自动使用 `--no-verify`、修改配置、重试为空提交或 amend。
- 成功后使用 `git show --stat --oneline -1` 和 `git status --short` 验证结果，并报告 commit hash、标题以及剩余工作区变更。

## Type Selection

- `feat`: 增加用户可见的新功能或新能力
- `fix`: 修复缺陷、错误、回归、安全问题或边界条件
- `refactor`: 调整内部结构但不改变外部行为
- `docs`: 修改文档、说明或不影响程序行为的注释示例
- `test`: 新增、修正或重构测试，且没有更主要的产品代码变化
- `style`: 只调整格式、空白或代码风格，不改变行为
- `perf`: 优化性能
- `build`: 修改构建系统、打包流程或影响构建的外部依赖
- `ci`: 修改 CI/CD 配置或流水线
- `chore`: 其他例行维护和非功能性工程整理
- `revert`: 回滚已有提交

优先使用最具体的类型，不要在适合 `feat`、`fix`、`refactor` 或 `build` 时偷懒使用 `chore`。
同时包含产品代码和测试时，按主改动决定类型，不要因为顺手补测试就写成 `test`。
纯依赖升级使用仓库现有习惯；没有先例时，影响构建或运行依赖的升级优先考虑 `build(deps)`。

## Message Rules

- `type` 使用英文小写。
- `scope` 使用仓库已有名称，通常是简短的目录、模块或子系统名，不自行创造同义 scope。
- 摘要使用中文，不加句号，描述结果而不是操作过程。
- 避免“更新代码”“修改一些问题”“提交更改”等低信息表达。
- 标题遵守仓库配置的长度限制；没有明确限制时尽量控制在 72 个字符以内。
- 专有名词、API、命令、文件名和标识符保留其准确写法。
- 正文使用中文说明原因、行为变化和影响，避免逐文件复述 diff。
- issue 引用、`Refs:`、`Closes:`、`Signed-off-by:`、`Co-authored-by:` 等 footer 保持项目要求的标准格式。
- 不要自行添加或编造 sign-off、协作者身份、issue 编号或其他 footer 元数据。只有用户明确提供，或仓库流程明确要求且信息可验证时才能添加。

## Breaking Changes

破坏性变更可在标题 type/scope 后添加 `!`：

```text
feat(api)!: 调整认证接口
```

并在空行后的 footer 中说明影响：

```text
BREAKING CHANGE: 认证接口不再接受旧版令牌
```

`BREAKING CHANGE:` 标记保持英文大写，说明内容使用中文。正文和 footer 之间保留空行。

## Examples

- `feat(api): 增加历史数据回补能力`
- `fix(auth): 修正令牌过期后的刷新逻辑`
- `refactor(cache): 统一缓存键生成流程`
- `docs: 补充本地开发环境说明`
- `test(parser): 增加无效输入的边界测试`
- `style(ui): 统一组件文件格式`
- `build(deps): 升级数据库驱动版本`
- `ci: 增加发布前类型检查`

带正文和 footer 的示例：

```text
feat(api)!: 统一分页参数格式

将页码参数替换为游标，避免数据变化时出现重复记录。

BREAKING CHANGE: 客户端必须使用 cursor 参数替代 page 参数
```

## Output Expectations

仅生成信息时，优先输出一个最佳候选；必要时简短说明 type、scope 或拆分依据。
执行提交时，提交前说明将提交的 staged 范围；成功后报告 commit hash 和标题。不要把未暂存或 untracked 内容描述成已经提交。
用户指定文件范围但存在歧义时，列出相关文件并提出具体问题，不要自行选择。提交完成后不要自动 push。
