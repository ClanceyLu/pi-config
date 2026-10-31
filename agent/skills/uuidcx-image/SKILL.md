---
name: uuidcx-image
description: "通过 uuidcx 的 OpenAI 兼容图片接口生成图片并保存到本地。当用户要求生成、绘制或创建图片，或明确要求使用 uuidcx / GPT Image 生图时使用。"
compatibility: Requires Node.js 20+ and UUIDCX_API_KEY.
---

# UUIDCX 图片生成

使用本目录的 `generate.mjs`，通过 `https://uuidcx.com/v1/images/generations` 调用图片模型。脚本无额外 npm 依赖，读取环境变量 `UUIDCX_API_KEY`，不修改聊天 provider 配置。

## 工作流程

1. 从用户需求整理图片提示词，保留主体、风格、构图、比例、文字内容等明确要求。需求足够时直接生成；只在缺少决定性信息时提问。不要把内部实现说明写进图片。
2. 默认使用 `gpt-image-2`，用户指定模型时使用原模型名。可先运行 `--list-models` 查询当前密钥下可见的图片模型。列表可见不保证模型实际可调用。
3. 使用脚本生成一张图片。用户指定保存位置时使用该位置；否则在当前任务目录运行，让脚本自动命名。脚本拒绝覆盖已有文件。
4. 读取或展示生成的图片，检查是否符合用户需求，并提供可点击的本地文件链接。明确说明任何实际失败，不将模型列表查询成功表述成生图成功。

用户要求生成图片即已授权一次必要的生图调用，无需重复确认。生成可能消耗账户额度；网络超时或服务端失败后不要自动重复提交，先告知当前结果，因为请求可能已经处理。

## 命令

将下面的 `<skill-dir>` 替换为本 SKILL.md 所在的绝对目录；可以从任意工作目录执行。

```bash
node <skill-dir>/generate.mjs --list-models
node <skill-dir>/generate.mjs --prompt '一只橘猫坐在窗边，温暖的水彩插画，正方形构图'
node <skill-dir>/generate.mjs --prompt '极简咖啡店海报，包含文字「早安咖啡」' --model gpt-image-2 --size 1024x1024 --output ./artifacts/coffee.png
```

使用工具参数或正确的 shell 引号传递用户提示词，避免将提示词中的反引号、`$()` 等内容当作 shell 代码执行。

可选参数：

- `--model`：默认 `gpt-image-2`。
- `--size`：按需指定，例如 `1024x1024`；是否支持取决于服务端模型。
- `--quality`：按需指定服务端支持的质量值；默认不传，由服务端决定。
- `--output`：输出路径；省略时按实际文件格式自动命名。显式扩展名需要匹配返回格式。
- `--timeout`：整个请求和下载的超时秒数，默认 300，最大 3600。

成功后输出包含绝对 `path`、`model`、`format` 和 `bytes` 的 JSON。支持服务端返回 `data[0].b64_json` 或 HTTPS `data[0].url`，校验图片格式后保存；下载图片时不发送 API key。

## 认证与排错

- 必须提供环境变量 `UUIDCX_API_KEY`；缺失时告知用户配置环境变量，不要求在聊天中粘贴密钥，不打印密钥。
- HTTP 401/403：检查密钥有效性、权限和网关访问限制。
- HTTP 400/404：查询模型列表，检查图片接口、模型和可选参数的兼容性。不要静默改用其他 provider。
- HTTP 429/5xx 或超时：说明错误，不自动循环重试。
- 聊天配置中的 `input: ["text", "image"]` 表示支持图片输入，与图片生成能力无关。
- 当前脚本仅支持文本生成图片；编辑现有图片需要另外接入图片编辑接口，不要声称已经支持。
