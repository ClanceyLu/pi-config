# Pi Skill Evaluator

`/skill-eval` 让**当前会话 Agent**对一个 Skill 运行隔离的单次 A/B 评测：

- **baseline**：`--no-skills`
- **treatment**：`--no-skills --skill <SKILL.md>`，并通过 `/skill:<name>` 强制调用

两边使用命令触发时的当前会话模型、thinking level、active tools、任务和相同的初始 workspace，并作为仅有的两个 subagent 并行运行。没有评估模型选择，也不会再启动 case-generation、repetition-recommendation 或独立 judge 模型。

## 使用

在需要作为测试 workspace 的项目目录中启动 Pi TUI，然后用自然语言说明要评估的 Skill：

```text
/skill-eval 评估 python-development skill
/skill-eval 评估当前项目 ../my-skill 目录里的 Skill
/skill-eval 评估 https://github.com/owner/repository 中适合当前任务的 Skill
/skill-eval 阅读 https://example.com/install 文档并评估其中介绍的 Skill
```

命令参数必须是非空自然语言。扩展不会用路径、URL 或 Skill 名称正则从命令中猜测来源，而是把原文交给当前 Agent。Agent 会显式判断来源属于：

- 已加载的 Skill
- 本地 `SKILL.md` 或 Skill 目录
- GitHub 仓库、`tree` 或 `blob` URL
- 直接指向 `SKILL.md` 的 HTTPS URL
- 普通 HTTPS 文档

普通网页文档只会经过大小、redirect、DNS 和私网地址限制后将原文返回当前 Agent；实际 HTTPS 连接固定使用已校验的公网地址，每次 redirect 都重新解析、校验并固定地址，防止 DNS rebinding。扩展不会从安装文档正则提取仓库，也不会执行文档中的 shell/npm/npx 命令。Agent 阅读文档后自行选择明确的 GitHub 或 Skill URL。GitHub 仓库包含多个 Skills 时，工具只返回候选的 name、description 和 path，由 Agent 结合原始请求再次语义选择；仓库中的 symlink 会被拒绝。

URL 来源仅临时下载到系统临时目录，不写入 `~/.pi/agent/settings.json` 或永久 Skill 目录。

## 连续任务流程

`/skill-eval` 会触发当前会话中的一个连续 Agent turn。处理不可信 Skill/文档和盲评期间，当前 Agent 只启用 evaluator 的 prepare/run/judgment 三个工具；原来的 active tools 只传给两个隔离 subagent，并在评测结束后恢复。

1. 当前 Agent 语义判断并读取目标 Skill。
2. 当前 Agent 自动制定：
   - 能体现 Skill 独特能力的完整测试提示词
   - 评分 rubric
   - 1–6 项 deterministic checks
3. 显示唯一一次确认页，其中完整列出测试提示词、rubric、checks、Skill 来源、当前模型、workspace/commit、project trust 和代码执行风险。
4. 确认后，baseline 与 treatment 两个 subagent 并行运行。
5. 两边完成后，结果随机映射为 A/B，使用不超过 50 KiB 的聚合证据直接返回同一个当前 Agent turn；完整内容保存在报告中。
6. 当前 Agent 对 A/B 结果评分、提交结构化 judgment，并输出结论和报告路径。

整个流程算一个尚未结束的任务。两个 subagent 运行期间当前会话保持忙碌，不能进行其他对话；进度 widget 会显示两边的 workspace、运行、tool call、checks、产物保存和清理阶段。评测成功后，完成 widget 保留 10 秒再自动隐藏；最终回复中的报告路径不受影响。不提供额外 status 或 cancel 命令。需要中止时使用 Pi 原生的当前 turn 中止操作；父 turn 的 abort signal 会同时传给两个 subagent。

## 确定性检查

支持：

- 最终 response 匹配正则
- 相对路径存在或不存在
- 文件内容匹配正则
- shell 命令退出码为 0

Agent 制定的 checks 会在唯一确认页完整展示。执行器拒绝明显的网络、提权、发布、依赖安装和递归强制删除命令，并规范化 Python 风格的 leading inline regex flags，但模型生成的 shell 仍必须视为不可信代码。

检查在 subagent 完成并采集 workspace diff 后运行，因此检查命令产生的 coverage/cache 不进入任务 diff；最终保留的完整 workspace 则反映检查结束后的现场。

## Workspace 隔离与保留

- Git 项目：每个 arm 从当前 `HEAD` 创建独立 detached worktree。
- staged、unstaged 和 untracked 内容不进入 worktree；dirty 时确认页会说明只评测已提交的 `HEAD`。
- 无 commit 且非空的 Git 仓库拒绝运行。
- 非 Git 目录：为每个 arm 递归复制独立目录。
- 空目录：为每个 arm 创建独立空目录。
- 两边最终 workspace 会在清理临时 worktree 前复制到永久报告目录，并排除 `.git` 元数据。

## 评分与报告

当前会话收到的候选随机标记为 A/B。它依据测试提示词、rubric、最终 response、workspace diff 和 checks 提交：

- winner
- baseline/treatment 分数
- confidence
- rationale
- criterion notes

报告保存到：

```text
~/.pi/agent/evaluations/<timestamp>-<skill-name>/
```

主要内容：

```text
report.md
result.json
candidates/A/output.md
candidates/A/workspace.diff
candidates/A/checks.json
candidates/A/events.jsonl
candidates/A/stderr.log
candidates/A/run.json
candidates/A/workspace/
candidates/B/...
```

`result.json` 使用 version 2，并在执行过程中依次写入 `running`、`awaiting_judgment`、`completed`，或在异常路径写入 `failed`/`cancelled`。judgment 提交前，候选 `run.json` 会移除 arm、临时路径和 loaded-command 等身份信息，主报告也不写 A/B 映射；完成判断后才在最终 `result.json` 中记录映射。RPC incremental update events 会被丢弃，其余 events、messages 和 traces 设有数量与字节上限。即使评测失败或被原生中止，已经写出的报告和候选产物仍会保留用于排障。

报告根目录使用 `0700`，报告文件使用 `0600`。完整 workspace 永久保留，由用户自行删除。

## 安全边界

**待测 Skill、项目 extensions、Agent tools 和检查脚本具有代码执行能力，并使用当前用户权限。**

使用前必须审查确认页和可信来源。尤其注意：

- 子进程继承环境变量，Skill 或任务可能读取凭据并访问网络。
- 当前 Agent 会读取不可信 Skill/文档内容；数据分隔和工具约束不能消除 prompt injection 风险。
- HTTPS/SSRF 防护只限制文档获取位置，不代表内容可信。
- Git worktree/目录复制不是安全沙箱，只提供状态隔离。
- 非 Git 目录复制和永久 workspace 可能包含密钥、大文件或 symlink。
- 输出、events、diff 和 workspace 可能包含敏感数据；报告应按敏感数据处理。
- `--approve` 只在父 Pi 已信任项目且用户确认后传给两个 subagent。

如需更强隔离，应在容器、虚拟机或受限系统账户中运行整个 Pi。

## 测试

不调用真实模型的测试：

```bash
node --test --experimental-strip-types agent/extensions/skill-evaluator/*.test.ts
```

加载检查：

```bash
printf '%s\n' '{"id":"1","type":"get_commands"}' | \
  pi --mode rpc --no-session --no-extensions \
  -e ./agent/extensions/skill-evaluator/index.ts \
  --no-skills --no-context-files --no-approve
```

child 模式递归保护检查：

```bash
printf '%s\n' '{"id":"1","type":"get_commands"}' | \
  PI_SKILL_EVAL_CHILD=1 pi --mode rpc --no-session --no-extensions \
  -e ./agent/extensions/skill-evaluator/index.ts \
  --no-skills --no-context-files --no-approve
```

第二条输出中不应出现 `skill-eval` 命令。
