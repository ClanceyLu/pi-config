# Pi 配置

共享资源通过 Git 同步，本机配置与运行状态留在各设备上。

| 内容 | 位置 | Git 同步 |
| --- | --- | --- |
| 通用规则 | `agent/AGENTS.md` | 是 |
| 通用 skills、extensions、prompts | `agent/skills/`、`agent/extensions/`、`agent/prompts/` | 是 |
| 新设备配置模板 | `shared/*.example.json` | 是 |
| 默认模型、主题、代理、packages、资源路径 | `agent/settings.json` | 否 |
| 自定义 provider、模型和端点 | `agent/models.json` | 否 |
| 本机 skills、extensions | `agent/local/skills/`、`agent/local/extensions/` | 否 |
| auth、sessions、信任记录、缓存和安装产物 | `agent/` 下对应文件或目录 | 否 |

模板仅用于初始化，Pi 不会自动读取模板，也不会自动合并模板更新。日常修改默认模型或安装本机 package，不影响其他设备。

## 新设备初始化

先安装 Git、SSH 和 Pi。当 `~/.pi` 尚不存在时：

```zsh
git clone git@github.com:ClanceyLu/pi-config.git ~/.pi
cd ~/.pi
mkdir -p agent/local/skills agent/local/extensions
[[ -e agent/settings.json ]] || cp shared/settings.example.json agent/settings.json
[[ -e agent/models.json ]] || cp shared/models.example.json agent/models.json
```

启动前编辑 `agent/settings.json`，选择本机可用的 `defaultProvider`、`defaultModel` 和 packages。模板中的 packages 是初始建议，可按设备增删。通过 `/login` 登录所需 provider。

`models.example.json` 是空的自定义 provider 配置；使用内置 provider 无需填写。如需自定义端点，在本机 `agent/models.json` 中配置。API key 优先通过环境变量或 Pi 认证存储提供，不要放进模板。

### 已有 Pi 目录，但尚未使用此仓库

先停止 Pi，将整个 `~/.pi` 备份到仓库外，再执行上述克隆和初始化命令。按需从备份恢复 `settings.json`、`models.json`、`auth.json`、sessions 和本机资源；不要直接用旧目录覆盖整个新仓库。

恢复旧 `settings.json` 后，参照下文添加本机资源路径。备份可能含密钥，应妥善保管。

## 已在同步旧版仓库的设备：首次迁移

**必须先备份再拉取。** 旧版跟踪了 `settings.json` 和 `models.json`；本次迁移从 Git 移除了它们，其他设备首次拉取可能删除对应文件。

先停止 Pi，确认暂存、未暂存及未追踪改动都已妥善处理。若有改动、分叉或冲突，先处理，不要强制重置。

```zsh
cd ~/.pi
git status
backup="$HOME/.pi-config-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$backup"
cp -p agent/settings.json agent/models.json "$backup/"
```

确认两个文件备份成功后，再执行：

```zsh
git pull --ff-only
```

仅在拉取成功后恢复本机配置：

```zsh
cp -p "$backup/settings.json" agent/settings.json
cp -p "$backup/models.json" agent/models.json
mkdir -p agent/local/skills agent/local/extensions
```

在恢复的 `agent/settings.json` 中，将以下路径加入已有数组（保留原有条目，不要覆盖整个文件）：

```json
{
  "skills": ["./local/skills"],
  "extensions": ["./local/extensions"]
}
```

资源路径相对于 `~/.pi/agent`。启动 Pi 后检查资源加载情况，确认正常再自行删除备份。执行本次修改的设备已保留本机文件并添加路径，不必重复迁移。

## 管理共享与本机资源

- 所有设备都要使用的 skill：放入 `agent/skills/<name>/SKILL.md`，提交到 Git。
- 只在本机使用的 skill：放入 `agent/local/skills/<name>/SKILL.md`，不会提交。
- 扩展同理，分别放入 `agent/extensions/` 与 `agent/local/extensions/`。
- `agent/skills/` 和 `agent/extensions/` 会自动发现，无需重复写入 settings。
- 本机 skill 不要与共享 skill 同名；同名不是可靠的覆盖机制，会产生冲突警告。
- 设备专属 package 仅在本机安装，其声明保存在本机 `agent/settings.json`。
- 更新共享模板不会改变现有设备配置；需要的设置应手动应用到本机文件。

已有共享资源不要仅因依赖某台设备就随意搬走；移动或删除共享文件会影响其他设备，确认适用范围后再调整。

## 认证与模型

`agent/models.json` 已留在本机，当前设备已有的端点配置会保留。若配置引用 `UUIDCX_API_KEY` 等环境变量，应在各设备的 shell 或秘密管理工具中单独配置；不要提交真实 key。

`auth.json` 不同步，各设备独立登录。Sessions 和 package 安装目录也不同步。

`/model` 和 `/thinking` 默认只修改当前会话；按 Ctrl+S 保存启动默认值后，也仅影响本机配置。

`agent/extensions/uuidcx-claude.ts` 为 `uuidcx-claude` provider 添加网关身份信息，合并网关与 Pi 所需的 beta，并隐藏返回的思考摘要。输出上限、thinking 格式和 effort 由 Pi 按本机 `models.json` 的模型配置生成。

Opus 5/5.5、Sonnet 5/5.5 的模型条目应设置 `compat.forceAdaptiveThinking: true` 和 `compat.supportsTemperature: false`，`thinkingLevelMap` 与当前 Pi 内置 Anthropic 对应型号一致：

| 模型 | `thinkingLevelMap` |
| --- | --- |
| Opus 5、Sonnet 5 | `{"xhigh":"xhigh","max":"max"}`；low/medium/high 使用 Pi 默认映射 |
| Opus 5.5、Sonnet 5.5 | `{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":"xhigh","max":"max"}` |

Haiku 4.5 使用预算式 thinking，无需设置 `forceAdaptiveThinking`。网关的 message threads 和对话中配置变更能力需分别验证后再启用。模型配置保存在本机，各设备独立维护。验证：`node --experimental-test-module-mocks --test agent/extensions/tests/uuidcx-claude.test.ts`。

## 日常工作流

修改共享资源前，确认工作区干净，再同步：

```zsh
cd ~/.pi
git status
git pull --ff-only
```

修改后选择需要共享的文件暂存，检查差异：

```zsh
git add .gitignore README.md shared agent/AGENTS.md agent/extensions agent/skills agent/prompts
git diff --cached
```

确认没有设备路径或秘密后，自行提交和推送。`settings.json`、`models.json` 与 `agent/local/` 不应出现在新增跟踪文件中；不要使用 `git add -f` 强行加入。

同步资源后在 Pi 中运行 `/reload`；修改启动默认模型后，在新会话确认。

`agent/extensions/openai-fast.ts` 提供 `/fast [on|off|status]`，开关保存在全局配置目录的 `fast-settings.json`（默认 `~/.pi/agent/fast-settings.json`），跨会话、重启和 `/reload` 保留；未配置时默认关闭。各 Pi 实例在发起请求前读取共享开关，仅对扩展支持的模型设置 Priority 服务等级。验证：`node --experimental-test-module-mocks --test agent/extensions/tests/openai-fast.test.ts`。

`agent/extensions/compact-footer.ts` 精简底部模型显示：隐藏 provider，自动路由后仅显示实际模型，如 `gpt-6.1-sol · medium`（路由前显示 `auto`），思考等级实时显示当前选择值（包括快捷键切换），不使用上次回复的等级。目录、分支、上下文使用百分比与模型合并为一行，目录信息最多占终端宽度的三分之一，不显示 Token 数、缓存统计和费用；输出速度显示在上下文占比右侧，其他扩展状态仍显示在独立状态行；完整模型信息可通过 `/model` 查看。

`agent/extensions/token-speed/index.ts` 测量当前输出速度，由 `compact-footer.ts` 显示在上下文占比右侧，例如 `25.0% | 30.0 tok/s`。

- **计算口径**：每 250ms 采样，用最近约 1 秒的 token 增量除以采样时间差；窗口未满时使用已有采样时长。不累计整个请求、对话或 session 的平均速度，每次模型请求独立采样。
- **token 计数**：使用 `js-tiktoken` 的 `o200k_base` 对已收到的正文、思考文字／摘要、工具名称和参数分词，不把字符数或数据块数直接当作 token 数。实时值是本地估算，不使用请求结束时的总用量反推瞬时速度。
- **thinking 阶段**：已传回客户端的思考内容参与测速；如果只有 thinking 提示、没有思考增量，则无法测出隐藏推理速度，显示 `0.0 tok/s`。不同模型的 tokenizer、思考摘要和网络缓冲都会影响估算结果，数值不代表服务端真实生成速度。
- **保留速度**：模型请求完成、失败或中断后保留最后一次采样速度，工具执行、对话结束（`agent_settled`）、切换会话和导航会话树时也不清零。新请求独立采样，测得正速度前保留上次显示值；请求进行中没有新输出时，速度可随窗口变化而降低，窗口内增量为零后保留最后一次正速度，收到新输出后继续更新。重新加载扩展后初始显示 `0.0 tok/s`。
- **运行开销**：使用单调时钟；长输出重新分词时根据实际编码开销降频，减少对流消费的阻塞，因此更新可能滞后。不保存日志。

首次同步此扩展后安装依赖：`pnpm --dir ~/.pi/agent/extensions/token-speed install --frozen-lockfile`，然后在 Pi 中运行 `/reload`。验证：`pnpm --dir agent/extensions/token-speed test`。

### 交互式问答

本机安装 `pi install npm:@juicesharp/rpiv-ask-user-question`，然后在 Pi 中执行 `/reload` 加载 `ask_user_question` 工具。Package 声明保存在本机 `agent/settings.json`，新设备模板包含此 package；已有设备需分别安装。工具支持单选、多选、多题标签页和自由输入答案。

### Plannotator

本机安装 `pi install npm:@plannotator/pi-extension`，然后在 Pi 中执行 `/reload` 加载。Package 声明保存在本机 `agent/settings.json`，其他设备按需安装。

- 使用 `pi --plan` 启动计划模式，或在会话中通过 `/plannotator-plan-mode`、`Ctrl+Alt+P` 切换。
- 模型将 Markdown 计划写入项目 `tmp/` 目录，通过 `plannotator_submit_plan` 打开浏览器评审界面。批准后执行计划，也可添加批注要求修改。
- `/plannotator-review` 打开代码差异评审；`/plannotator-annotate <文件>` 批注 Markdown 文件；`/plannotator-last` 批注最近一条助手回复。

### Agent Teams

`agent/extensions/agent-teams/` 提供进程内协作与持久子会话，使用 Pi 1.5 SDK 和父会话的模型运行时。协作规则通过 `systemPromptOptions.sections.agent_teams` 注入，Pi 按区段维护提示词。子会话可使用父会话动态注册的 provider 与认证；工作目录中的规则和 skills 按子会话目录加载。子会话使用内置文件/终端工具与协作工具，全局及项目扩展不会自动加载。

通过 `/team on` 开启协作工具，`/team off` 关闭并中断执行中的具名成员。开关保存为本机全局设置，新建、切换会话、重启或 `/reload` 后沿用，首次默认关闭。`/team` 打开成员与任务面板，`/team status` 查看概况。

Lead 通过 `list_team_models` 查询模型，再使用 `spawn_teammate` 创建具名成员，可指定 `context: "fresh" | "fork"`、模型与思考等级。`fresh` 使用独立上下文，`fork` 继承 Lead 已完成的对话前缀，包含压缩记录与上下文编辑，排除当前尚未结束的轮次。创建立即返回 `agent_id`，完成通知另行投递给 Lead。成员创建后保持这些设置，后续通过 `send_message({ target: "成员名", message })` 复用。只有 Lead 可以创建和中断具名成员；Team 内成员可直接互发消息。`inactive` 仅表示没有轮次执行，不代表工作完成或成功。消息成功仅表示已接受，不表示已处理。

Team 成员共享 Lead 的工作目录。共享任务支持依赖图、owner 与 revision CAS 更新，`write_scopes` 提供路径重叠警告，不限制文件写入。任务就绪不会自动启动 owner，成员失败或被中断时 owner 仍保留。`wait_agent` 等待变化，无其他执行可推进时立即返回 `no_progress`。Lead 应等待所需成员、检查结果和最终 diff，并运行相关检查后交付。

成员结果与任务按 Lead 会话保存，`team_results`、`team_results_ack` 与 `team_finalize` 可用于显式追踪交付。概况中的“任务待处理”统计 `pending` 任务（包含依赖阻塞的任务）；“结果/消息待确认”统计当前协作轮次内尚未被 Lead 确认的执行结果与消息。读取结果或查看面板不会确认结果，Lead 调用 `team_results_ack` 后计数随即更新。`team_report` 在实际执行结束时发布。文件验证工具记录 Lead 报告的命令结果，并绑定显式列出的文件哈希；它们不执行或独立认证测试。

团队元数据和独立子会话保存在本机 `agent/herdr-teams/<Lead会话哈希>/`（不通过 Git 同步）。元数据使用原子快照更新与单 owner 锁，子会话使用 Pi JSONL；任务、成员身份和对话在重载后保留，显式消息冷恢复原成员。无法确认是否已执行的工作标记为 `recovery_required`，不会自动重放。旧 Herdr 成员记录与结果可查看，其终端会话不作为 SDK 子会话恢复；需要使用新成员名继续。Lead 会话退出会停止并释放其创建的 SDK 子会话。若异常退出遗留 `owner.lock`，确认旧 Lead 已结束后再清理对应锁目录。

所有子任务都使用当前用户权限并共享文件系统，进程内会话不提供 worktree、文件锁或权限沙箱。验证：`node --experimental-test-module-mocks --test agent/extensions/agent-teams/*.test.ts`。同步后执行 `/reload` 加载工具。

### 扩展测试

SDK 和 TUI 测试通过 `agent/extensions/tests/pi-runtime.mjs` 读取 managed 安装的 `install/current-version`，解析当前 release 的依赖；`PI_MANAGED_INSTALL_ROOT` 可指定安装目录。普通 Node 安装沿用 Node 的包解析。Token 测速扩展需要先安装其自身依赖。

```zsh
node --experimental-test-module-mocks --test agent/extensions/tests/*.test.ts agent/extensions/agent-teams/*.test.ts agent/extensions/skill-evaluator/*.test.ts
```

### 更新 Pi 和 packages

```zsh
pi list                  # 查看本机 package 声明
pi update                # 更新 Pi 本体
pi update --extensions   # 更新本机声明的 packages
pi update --models       # 刷新模型目录
pi update --all          # 更新 Pi 本体和 packages
```

启动 Pi 时会安装缺失的声明 package，无需提交 `agent/npm/`。这些命令不会更新仓库内手写的扩展或 skills，它们通过 Git 同步。
