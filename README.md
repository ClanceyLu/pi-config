# Pi 配置备份

这个私有仓库用于管理可移植的 Pi 配置：

- `agent/settings.json`
- `agent/models.json`
- `agent/extensions/`
- `agent/skills/`

认证信息、API key、sessions、模型缓存和 `agent/npm/` 安装产物不会进入 Git。

## 恢复到新设备

先安装并配置好 Git、SSH 和 Pi。

### 全新的 `~/.pi`

当 `~/.pi` 尚不存在时：

```zsh
git clone git@github.com:ClanceyLu/pi-config.git ~/.pi
```

### 已存在 `~/.pi`

如果 Pi 已创建 `~/.pi`，先停止正在运行的 Pi。下面的命令只移走将由 Git 管理的配置，保留 `auth.json`、sessions 和 package 安装目录等本机状态：

```zsh
cd ~/.pi
backup="$HOME/.pi-config-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup/agent"
for name in settings.json models.json extensions skills; do
  if [[ -e "agent/$name" ]]; then
    mv "agent/$name" "$backup/agent/"
  fi
done

git init -b main
git remote add origin git@github.com:ClanceyLu/pi-config.git
git fetch origin main
git checkout -B main origin/main
git branch --set-upstream-to=origin/main main
```

确认配置正常后再自行删除 `$backup`。旧的 `models.json` 可能含密钥，应妥善保管。

## 注入 UUIDCX API key

`agent/models.json` 只保存 `"$UUIDCX_API_KEY"` 引用。真实 key 保存在仓库外的 `~/.zshenv`。

以下 zsh 命令以隐藏输入读取 key，并使用 shell 安全引用写入文件；命令本身不会把 key 放进 shell history：

```zsh
read -rs 'UUIDCX_API_KEY_VALUE?UUIDCX API key: '
print
printf '\nexport UUIDCX_API_KEY=%q\n' "$UUIDCX_API_KEY_VALUE" >> ~/.zshenv
unset UUIDCX_API_KEY_VALUE
chmod 600 ~/.zshenv
exec zsh
```

仅检查变量是否生效，不要打印其值：

```zsh
[[ -n "$UUIDCX_API_KEY" ]] && echo 'UUIDCX_API_KEY is set'
```

如果 `~/.zshenv` 已有同名 `export`，应更新原有行而不是重复添加。

## 恢复 packages

`agent/settings.json` 声明了 Pi packages，包括：

```text
npm:@plannotator/pi-extension
```

启动 Pi 时，package manager 会自动安装缺失的 package，因此无需恢复或提交 `agent/npm/`。也可用下面的命令查看当前声明：

```zsh
pi list
```

Sessions 不在仓库中，不会从 GitHub 恢复。

## 日常工作流

在修改配置前先同步：

```zsh
cd ~/.pi
git status
git pull --ff-only
```

修改后检查并提交：

```zsh
git status
git add .gitignore README.md agent/settings.json agent/models.json agent/extensions agent/skills
git diff --cached
git commit -m "Update Pi config"
git pull --ff-only
git push
```

`pull --ff-only` 在远程和本地历史分叉时会拒绝自动合并，避免意外产生合并提交；此时应先检查两端提交再手动处理。
