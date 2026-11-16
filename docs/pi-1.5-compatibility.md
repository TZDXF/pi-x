# pi 1.5.x 兼容约定

PiX 继续通过 `pi --mode rpc` 和已安装 pi 的 SDK 对接，不固定或复制 pi 的模型运行时。

- 用 `agent_settled` 结束运行，同时读取 `aborted`；缺少该字段时仍兼容旧版本。
- 翻译进程检查退出状态和 `stopReason: "length"`，不将截断文本当作成功译文。
- 工具耗时优先使用 `durationMs`，缺省时使用本地观测时间；历史耗时来自工具结果。
- `responseModel` 和 `Usage.cost.totalFromProvider` 保留到历史和界面；账单总额不由目录分项重新相加。
- MCP `resources` 作为能力布尔值展示，兼容旧数量值，缺省表示未知；连接阶段不额外枚举资源。

## pi-schema

pi 1.5 使用 `@earendil-works/pi-schema` 验证工具参数。PiX 自身没有 TypeBox 工具定义，因此不新增一份运行时验证器，也不从 pi-ai 导入已经移除的 `Type`、`Static` 或 `TSchema`。

MCP 工具的 JSON Schema 原样保留。参数转换及验证交给运行工具的 pi；`tool_execution_start.args` 仍可能是模型的原始参数，不能当作经过转换的执行输入。界面优先使用执行开始事件的完整参数快照，并保留新版验证错误中的字段路径及错误详情。

以后新增工具时应使用普通 JSON Schema 或 pi-schema 构造器，不依赖 `Type.Refine()`、TypeBox 自定义格式、codec、BigInt 或 Undefined 的非 JSON Schema 行为。

## 全局设置

配置页读写 pi 自己的 `settings.json`，只更新编辑过的字段：

- `selfUpdateCommand`：程序及参数的字符串数组；清空时移除该键。环境变量 `PI_SELF_UPDATE_COMMAND` 优先。保存不执行命令；关于页继续通过 `pi update --self` 执行更新。
- `collapseChangelog`：控制终端 pi 启动时 pi 和扩展更新日志的折叠方式，不重置 `extensionChangelogVersions` 已读记录。
- `sessionShareDestination`：`auto`、`gist` 或 `radius`；保存不触发上传，终端 pi 的 `/share` 使用此设置。

新能力在旧版本中通过设置 schema 或 SDK 方法检测，缺失时禁用对应控件。

pi 1.5.1 起还需支持以下配置；当前最新版本 1.5.2 未再改变这些字段：

- `cacheWarming`：`off`、`streaming` 或 `idle`。`idle` 是 1.5.1 新增的默认值，会在运行结束后继续按需保持缓存最多 30 分钟。PiX 通过 Pi 的 SDK getter/setter 读写，并根据 schema 隐藏旧版本不支持的取值；不覆盖用户已有的 `promptCache` 模型元数据。
- `compat.requiresToolsWithToolHistory` 与 `compat.requiresNonNullAssistantContent`：OpenAI Completions 兼容开关。
- `compat.promptCacheKeyMode`：OpenAI Completions / Responses 的 `auto`、`enabled`、`disabled` 三态配置。
- `compat.supportsMessageThreads`：Anthropic Messages 的会话线程开关。

模型高级配置只结构化编辑已知字段，其余字段仍在 JSON 中原样保留，避免升级 Pi 后保存模型时丢失新配置。

## 验证

`pnpm run test:web:all` 覆盖客户端行为；设置 `PI_TEST_SDK` 为已安装 pi 的 `dist` 绝对目录后，可运行 `tests/pi-data.test.ts` 和 `tests/pi-schema.test.ts`，验证真实 SDK 的设置合并、参数转换及验证错误。测试使用临时目录，不访问模型服务或用户配置。
