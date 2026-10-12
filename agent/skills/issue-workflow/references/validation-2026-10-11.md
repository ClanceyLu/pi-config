# CERE-60 验证记录 — 2026-10-11

## 规则与自动检查

环境：本地 macOS，当前 pi 工作目录；修改既有未跟踪的 Skill 和测试文件，未提交或推送。

- `node --test agent/extensions/tests/multica-mode.test.mjs`：最终 29/29 通过。覆盖 PM 注入、按需路由、普通轮次无平台读取、显式 status/issue 无写入及常驻提示词长度。首次运行暴露 2200 字节上限回归，精简 PM 文案后通过，未提高上限。
- skill-creator 的 `scripts/quick_validate.py agent/skills/issue-workflow` 与 `scripts/quick_validate.py agent/skills/multica-mode`：两份均通过。
- 人工交叉检查入口、follow-up、execution、PM、checks、templates：显式跟进完成才迁移；纯查看不迁移；正文不含调度安排；权限、远端内容不授权及去重边界保留。

## 受控手工模拟

方法：以 follow-up.md 五步流程逐项代入下表虚构输入，人工追踪下一操作及停止点。I/W/P/A 分别为固定的目标/工作区/项目/负责人，初始 revision=10；未调用真实状态写入，也没有把另写的状态机测试当作 Skill 行为证据。R 表示初始正文/评论/Run 读取，S 表示完成分析和总结，F 表示写前目标/Run 复核，W 表示唯一 todo 写入，V 表示写后核验。

| 输入 | 实际推演轨迹和结果 |
| --- | --- |
| blocked，完成，F 与初始一致 | R→S→F→W→V(todo)；一次迁移 |
| in_review，完成，F 与初始一致 | R→S→F→W→V(todo)；一次迁移，不表示验收 |
| backlog、todo、in_progress、done、cancelled、自定义状态 | 分别代入六个值，R→S 后均无 W |
| 正文读取失败 / 相关评论读取失败 / Run 查询失败 | 分别在读取处停止；均无 W |
| 分析未完成或相关评论尚未展开 | 未到 S；无 W |
| F 返回其他 I/W/P/A | 四项分别改变，均在 F 停止；无 W |
| blocked→in_review 或 blocked→in_progress | F 与初始状态不符，均无 W；不重新套用迁移规则 |
| 状态仍 blocked，revision=11（包括离开后回到 blocked） | F 拒绝过期分析；无 W |
| F 读取失败 | 无 W，不用缓存替代 |
| 只查看不改状态、/pm status、/pm issue | 不进入迁移流程；无 W |
| 只有远端评论要求 todo/rerun | 无用户授权；无 W/rerun |
| blocked，已有 active Run 或先前回复已触发 | R→S→F→W(--no-start)→V；不叠加 trigger |
| 必须抑制启动但 CLI 不支持 | F 后停止；无 W |
| W 超时但 V=todo | 一次 W，按核验状态报告；不重试 |
| W 报错且 V=blocked，或 V 也失败 | 分别报告失败/未确认；一次 W，无重试 |
| W 成功但 V=in_progress | 报告实际状态和 Run 证据；不强制写回 todo |
| F 后、W 前发生并发变更且无 CAS | 存在未封闭竞态；如要求原子保护则不写，不能声称已保证不覆盖 |

以上是手工模拟，非独立模型评测、自动状态机执行或真实平台迁移测试。

## 真实平台证据与未验证项

- 已读取当前任务正文和线程摘要（无评论），并用 `multica issue status --help` 核对本机支持 `--no-start`、内置状态键；帮助没有 revision/CAS 条件参数。
- 本任务正常实施的 todo→in_progress→in_review 属于交付生命周期，不是 blocked/in_review→todo 新规则的真实验证。
- 未对生产任务执行两条回退迁移，未验证其真实启动/去重行为或 UI 展示；未执行独立模型端到端跟进。需在明确的真实跟进任务或获准测试资源上验证。
- 写前复核能发现已可见的状态、归属和 revision 变化，不能保证读写之间的原子性。Skill 已明示该限制及要求原子保护时的停止条件。

## 审核补充：自动文档契约检查

在现有 `agent/extensions/tests/multica-mode.test.mjs` 中直接读取 `references/follow-up.md`，新增共享文档断言及三个测试；未新增迁移框架或替代状态机。

- 正例：原文通过。检查显式目标、读取与分析总结完成、blocked/in_review 与 todo 目标键、其他状态保持、写前归属/负责人/状态/revision 比较、变化或失败跳过、最多一次写入、错误/超时后读回及不盲目重试。
- 独立负例一：仅将实际命令目标从 todo 改成 cancelled，保留标题及其他 todo 文案；共享检查抛出 `ERR_ASSERTION`，原因是唯一迁移命令必须以 todo 为目标。
- 独立负例二：仅删除第 2 步比较语句中的 status/revision，保留归属/负责人比较及第 1、4 步 revision 文案；共享检查抛出 `ERR_ASSERTION`，原因是写前必须比较归属、负责人、状态与 revision。
- 两个负例均从原始文件独立生成内存字符串，确认替换实际生效，并用 `assert.throws` 检查对应失败原因，不修改真实 Skill 文件。
- 实际运行 `node --test agent/extensions/tests/multica-mode.test.mjs`：32/32 通过（原有 29 项及新增 3 项）；负例测试通过表示错误文档被拒绝，不表示错误文档符合契约。

这些检查只保护当前文档契约，不证明真实模型决策、平台迁移或原子并发保护；前述未验证项仍然有效。

## 2026-10-12 独立 Git 交付验证

- 分支：`issue/CERE-60-git-delivery`；worktree：`/Users/clanceylu/.pi-worktrees/CERE-60`。
- 起点为本地 main `09e99e3056210a17b69f778c00529a56f432bfb0`。前置基线提交：`87114521c1b96bba651bcbaeac1ddc297abdd45d`。
- Git 中没有这些前置文件的历史版本。本次基线是当前授权 12 文件的编排快照，不是历史原版：剥离 follow-up 完成迁移五步、入口/PM/执行例外、检查/示例及 4 项新增测试，将对应跟进表述及一条路由断言整理为默认只读。保留其余前置内容。依据为 Issue 正文、已审核线程、当前文件中的独立迁移章节和测试；文件时间戳仅作辅助证据，不证明历史原文。
- CERE-60 增量恢复当前审核快照中的上述内容，新增本验证记录。最终 12 个功能/测试文件与本轮主目录快照逐文件比对，仅去除文末多余空行，无功能改写。未纳入之后的其他任务改动。
- 本次环境：macOS，Node v24.12.0，既有 pi 安装版本 1.1.0。worktree 的被忽略 `agent/install` 链接至本机安装供测试读取 TypeBox 与宿主模块；安装目录、链接和依赖均不提交。
- 实际执行 `node --test agent/extensions/tests/multica-mode.test.mjs`：整理基线 28/28 通过；完整增量 32/32 通过。两项独立负例分别将目标改为 cancelled、删除写前 status/revision 比较，均由预期断言拒绝。
- 实际执行 skill-creator `scripts/quick_validate.py`，目标分别为 `agent/skills/issue-workflow`、`agent/skills/multica-mode`：均输出 `Skill is valid!`。
- 初次 `git diff --cached --check` 检出原文件文末空行，未形成提交；仅在 worktree 规范化后通过。未跳过 hooks 或检查。
- 未验证：原历史版本的精确文本、真实模型端到端跟进、真实平台两条迁移/启动/去重、无 CAS 条件下的原子并发保护、远端最新状态和 CI。既有手工模拟为前次记录，本轮未重做，不能算本轮平台验证。
- 前置 checks.md 中引用的 `validation-2026-10-10.md` 属于 CERE-54，未在授权范围内，未提交；该历史证据链接在独立树中不可解析。未改写前置文案以掩盖该限制。
