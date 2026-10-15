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

`agent/extensions/compact-footer.ts` 精简底部模型显示：隐藏 provider，自动路由后仅显示实际模型，如 `gpt-6.1-sol · medium`（路由前显示 `auto`），思考等级实时显示当前选择值（包括快捷键切换），不使用上次回复的等级。目录、分支、上下文使用百分比与模型合并为一行，目录信息最多占终端宽度的三分之一，不显示 Token 数、缓存统计和费用；其他扩展状态仍会显示；完整模型信息可通过 `/model` 查看。

### 工具分组

`agent/extensions/tool-groups.ts` 在 `pi-compact-tools` 的 Compact 工具行外增加一层分组，支持 `read`、`bash`、`codemode` 及其他工具，不修改执行或会话记录。

- 运行 `/reload` 加载；选择 `/compact-tools compact`，并用 `/silent off` 显示工具。
- 分组采用单行摘要，例如 ` ⦁ read 3 · bash 2`；收起和展开均使用 Compact 工具行同款小圆点 `⦁`，展开时用 `├` / `└` 连接各工具的首个可见行，`│` 连接中间空行；最后一个分支在工具标题处结束，不包围其输出，仅显示各工具调用次数，不显示折叠箭头，摘要统一使用弱化颜色。
- 仅对已结束的工具显示摘要，不显示总调用数量、失败数量或“展开/收起”文案；运行中、结果未返回或仍在流式更新的工具保持原样显示，不进入分组。工具结束后继续保持展开 1 秒，再自动收起；计时从执行结束开始，每个调用独立计时，摘要不显示“执行中”。点击摘要可展开已结束的 Compact 行，再点击工具行查看详情；手动展开的分组保持展开，收起分组不会重置工具行的展开状态。
- 键盘操作：`/tool-groups expand` 展开所有分组，`/tool-groups collapse` 收起；工具详情仍可用 `Ctrl+O` 切换。`/tool-groups off` 关闭分组，`on` 恢复。
- 连续工具调用可跨纯思考内容合并，正文、提示和最终回复不隐藏。Silent 开启时不显示分组；`codemode` 的内部调用仍由原插件显示摘要，不创建额外工具行。

分组挂载依赖 Pi 1.2 的内部对话容器结构；升级 Pi 后需要确认兼容性。普通终端模式使用命令展开，全屏模式还支持鼠标点击。

### 提交差异审阅

`agent/extensions/commit-review/` 为 `git-commit-cn` 提供 `commit_review` 工具：左侧文件列表、右侧逐文件 diff，窄终端自动单栏，支持筛选、滚动、改动块跳转与完整提交信息确认。只审阅当前暂存区，不执行暂存、提交或推送；确认时校验暂存快照。

运行 `/reload` 后可由 Skill 调用，或用 `/commit-review fix: 修复问题` 手动浏览。按 `c` 进入最终确认，`Esc` 返回或取消。详见 [提交审阅说明](agent/extensions/commit-review/README.md)。

### 更新 Pi 和 packages

```zsh
pi list                  # 查看本机 package 声明
pi update                # 更新 Pi 本体
pi update --extensions   # 更新本机声明的 packages
pi update --models       # 刷新模型目录
pi update --all          # 更新 Pi 本体和 packages
```

启动 Pi 时会安装缺失的声明 package，无需提交 `agent/npm/`。这些命令不会更新仓库内手写的扩展或 skills，它们通过 Git 同步。
