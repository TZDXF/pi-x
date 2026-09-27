# PiX

**pi coding agent 的桌面客户端** —— 基于 [Tauri 2](https://v2.tauri.app/) + Vue 3 + TypeScript 构建，通过 pi 官方支持的 RPC 模式驱动 [pi coding agent](https://github.com/badlogic/pi-mono)（`@earendil-works/pi-coding-agent`），在原生窗口中提供完整的 AI 结对编程体验。

```
┌─────────────────────────────────────────────────┐
│                PiX (Tauri 窗口)                 │
│                                                 │
│  Vue 3 前端 (ai-elements-vue 聊天 UI)            │
│      │ Tauri commands / events                  │
│  Rust 壳 (rpc.rs / trust.rs / pi_locate.rs)     │
└──────┬──────────────────────────────────────────┘
       │ stdin/stdout (JSONL, LF 字节帧)
       ▼
  pi --mode rpc 子进程
  （扩展 / 技能 / 提示词 / MCP 与 TUI 完全一致）
```

## 核心特性

- **流式对话**：文本、思考（Reasoning）、工具调用卡片全部流式渲染，打字机式实时生长
- **工具运行可视化**：每条工具调用的状态机（运行中 / 输出 / 完成 / 出错），可展开查看输出
- **模型与思考等级切换**：工具栏下拉选择任意 provider/model，实时切换思考等级（仅影响后续轮次）
- **消息队列**：AI 响应中继续输入 —— steering（转向）与 follow-up（追问）排队显示，Esc 中断后自动恢复输入
- **@file 引用**：输入 `@` 弹出项目文件补全（基名匹配优先，自动跳过 node_modules/.git/dist 等），支持光标处补全、中文/空格路径；选中插入 `@"relative/path"`，发送时明确提供路径供 agent 按需读取（不自动附加全文，不跨项目搜索符号链接）
- **图片输入**：粘贴 / 拖拽 / 添加按钮发送图片（base64），气泡内预览
- **Fork 分叉**：从任意历史用户提示词重新开始对话（`fork` RPC）
- **扩展 UI 完整支持**：pi 扩展弹出的 select / confirm / input / editor 对话框以原生桌面对话框呈现，回答通过 `extension_ui_response` 回传
- **项目信任管理**：调用已安装 Pi 的信任管理器，与终端共用 `trust.json`；首次打开项目弹出信任确认，父目录继承规则由 Pi 决定
- **pi 自动检测**：扫描 PATH 与常见安装位置定位 pi；支持在应用内配置自定义 pi 路径；Windows 下解析 npm `.cmd` shim 并直接以 `node + cli.js` 启动（绕开 cmd shim 在管道下的兼容性问题）
- **会话统计**：状态栏实时显示上下文 token 用量、成本、模型信息
- **会话导出**：桌面端选择目录导出 HTML 并在浏览器打开；侧边栏可直接导出任意会话而不切换，远程端下载到本地
- **应用内设置**：自定义 pi 可执行路径 + 实时检测结果（Windows 下自动解析 npm shim）；供应商与模型管理（可视化编辑 pi 的 models.json，打开模型选择器即生效）
- **技能托管**：完整技能（含 SKILL.md、脚本、参考文档）保存在 `~/.pix/skills`，可视化导入 / 启用 / 禁用 / 删除；启用列表写入 pi 的 settings.json，对所有项目生效
- **消息复制**：AI 回复一键复制为 Markdown 文本

## 定时任务

桌面端侧边栏「新会话」下方的「定时任务」可创建、编辑、暂停或删除任务。每个任务配置标题、指令、项目、工具权限（只读/读写/完全访问）、项目文件信任策略、模型与思考强度，支持每小时、每天、工作日、每周、每月及自定义 Cron。

- 使用本机时区，由 Rust 后端每 15 秒检查；PiX 必须保持运行（可以隐藏到托盘）。重启不补跑错过的任务；同一任务不重叠运行，单次最长一小时。
- 工作日指周一至周五，不排除法定节假日。每月选 29–31 日时，没有该日的月份会跳过。
- 自定义 Cron 使用五字段「分 时 日 月 星期」，如 `0 9 * * MON-FRI`；星期推荐用英文缩写，数字按 cron-rs 规则为 1=周日至 7=周六。日与星期同时指定时需同时匹配。
- 工具权限复用会话的 `--tools` 白名单；项目文件信任另行校验，两者都不是操作系统沙箱。任务不更改全局信任。选择「仅在项目已受信任时运行」后，信任撤销会阻止后续执行。需要交互输入的任务会失败，不自动批准。
- 每次运行启动独立 Pi 会话，不打断当前对话。成功结果可从任务列表或项目历史打开；状态及错误在任务列表显示。
- 配置保存在 `~/.pix/schedules.json`，不存储模型密钥。当前仅桌面端管理，不提供系统级唤醒或退出后执行。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | Tauri 2.0（Rust） |
| 前端 | Vue 3 + TypeScript + Vite |
| UI | Tailwind CSS v4 + shadcn-vue（reka-ui） |
| 聊天组件 | [ai-elements-vue](https://github.com/radix-vue/ai-elements)（Conversation / Message / Reasoning / Tool / PromptInput / Queue / Loader 全套） |
| 状态管理 | Pinia |
| 与 pi 通信 | `pi --mode rpc` 子进程，JSONL over stdio |

## 目录结构

```
pi-x/
├── src/                        # Vue 前端
│   ├── api/
│   │   ├── protocol.ts         # pi RPC 协议类型定义
│   │   └── piClient.ts         # Tauri command/event 封装
│   ├── stores/
│   │   ├── session.ts          # 会话状态：流式组装、工具运行状态机、队列
│   │   └── ui.ts               # 扩展对话框队列、toast、stderr 诊断
│   ├── components/
│   │   ├── ai-elements/        # ai-elements-vue 生成的组件（勿手改）
│   │   ├── ChatView.vue        # 主聊天界面
│   │   ├── AssistantBlocks.vue # assistant 消息块渲染（文本/思考/工具）
│   │   ├── PromptInputBridge.vue # PromptInput context 桥接（编程式访问输入框）
│   │   ├── ExtensionDialog.vue # 扩展 UI 对话框
│   │   ├── TrustDialog.vue     # 项目信任确认
│   │   ├── WelcomeView.vue     # 项目选择/引导页
│   │   └── StatusBar.vue       # 底部状态栏
│   └── App.vue                 # 阶段状态机：detecting → pick → trust → chat → down
├── src-tauri/                  # Rust 壳
│   └── src/
│       ├── rpc.rs              # pi 子进程生命周期 + stdio 桥 + 请求/响应关联
│       ├── pi_locate.rs        # pi 定位 + npm shim 解析（node+cli.js 直启）
│       ├── trust.rs            # 调用 Pi SDK 的信任管理器
│       ├── commands.rs         # Tauri commands + 应用配置
│       └── lib.rs / main.rs    # 入口，退出时清理子进程
└── package.json
```

## 开发

### 前置要求

- Node.js ≥ 22、Rust ≥ 1.90（含 cargo）
- 已安装 pi coding agent：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

- 模型凭据：沿用 pi 现有配置（`~/.pi/agent/auth.json` 或环境变量）。**OAuth 订阅登录（Claude Pro/Max 等）暂不支持**，请使用 API key 方式。

### 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev:desktop` | 桌面开发（不含远程访问） |
| `npm run dev:desktop:remote` | 桌面开发并包含远程访问功能 |
| `npm run dev` | 仅前端（浏览器预览，无 pi 进程） |
| `npm run build` | 前端构建（vite build） |
| `npm run typecheck` | 前端类型检查（vue-tsc） |
| `npm run lint` | ESLint（src + tests，vendored ui/ai-elements 已排除） |
| `npm run check` | lint + typecheck + 前端构建 + cargo check |
| `npm run test` | Rust 单元测试（cargo test） |
| `npm run test:web` | 前端/协议单元测试（node --test tests） |
| `npm run package` | 打包安装程序（NSIS/MSI 到 `src-tauri/target/release/bundle/`） |
| `npm run package:debug` | Debug 打包 |

普通桌面开发（`npm run dev:desktop`）不编译远程访问功能，无需生成 `dist`，保留 Vite 热更新。

使用 `npm run dev:desktop:remote` 可先构建前端，再启用 `remote-access` feature。启动后可在设置中开启远程访问，已保存的开启状态会自动恢复。远程页面使用编译时的前端快照，不走 HMR。

所有 `package*` 脚本仍包含远程访问功能（包括 Debug 打包）。直接运行 Cargo 默认不包含远程访问；若添加 `--features remote-access`，请先在项目根目录执行 `npm run build`。

### 调试提示

- pi 的 stderr 会转发为前端 `pi://stderr` 事件；pi 异常退出时「已退出」界面会显示最后 12 行 stderr，便于定位启动失败原因
- Rust 侧修改后需重启 `dev:desktop`；前端修改走 HMR（事件监听已做卸载清理，可安全热更）

## RPC 协议映射

前端使用到的 pi RPC 命令（详见 pi 的 `docs/rpc.md`）：

| 命令 | 用途 |
|---|---|
| `prompt` | 发送消息（流式，steering 模式） |
| `abort` / `clear_queue` | 中断当前轮次 / 取回排队消息 |
| `get_state` / `get_session_stats` | 模型、思考等级、token 用量 |
| `get_available_models` / `set_model` | 模型列表与切换 |
| `get_available_thinking_levels` / `set_thinking_level` | 思考等级 |
| `get_commands` | 自定义斜杠命令（命令面板数据源） |
| `new_session` / `compact` | 新会话 / 压缩上下文 |
| `extension_ui_response` | 应答扩展 UI 请求 |

事件流：`message_start` → `message_update`（delta 组装）→ `message_end`（权威替换）；`tool_execution_start/update/end` 驱动工具卡片。

## 打包发布

发布通过 GitHub Actions 完成，分正式版与预览版两条渠道，产物覆盖 Windows / macOS / Linux。

- **正式版**（`.github/workflows/release.yml`）：在 main 分支上创建语义化版本 tag 并推送即可触发（workflow 会校验 tag 必须位于 main）：
  ```bash
  git tag v0.0.1 origin/main
  git push origin v0.0.1
  ```
  版本号取自 tag（如 `0.0.1`），自动同步到 `package.json` 与 `src-tauri/tauri.conf.json`，发布为正式 Release 并自动生成 Release Notes。
- **预览版**（`.github/workflows/preview.yml`）：每天北京时间 00:00（UTC 16:00）检测 dev 分支，相对上一个预览 tag 有新提交时自动构建；版本号为当天日期（如 `2026.9.27`，tag 为 `preview-v2026.9.27`），发布为 Prerelease。当天预览 tag 已存在或无新提交时自动跳过；也可在 Actions 页面手动触发，勾选 `force` 可跳过更新检测。

> 预览版使用日期版本号，Windows 端仅提供 NSIS 安装包（MSI 要求主版本号 ≤ 255，无法使用日期形式的大版本号）。

## Roadmap

### M2（已完成）
- [x] **会话列表**：Rust 扫描 `~/.pi/agent/sessions/` JSONL 头部，展示历史会话并恢复（`switch_session` 免重启 / `--session` 重启兑底）
- [x] **斜杠命令面板**：基于 `get_commands` + ai-elements `PromptInputCommand` 的 `/` 命令补全
- [x] **会话内导航**：`get_tree` 分支树可视化（活跃路径高亮、user 节点一键 fork）

### M3（已完成）
- [x] **图片输入**：粘贴 / 拖拽 / 添加按钮 → `prompt.images`（base64），输入框与气泡内预览
- [x] **@file 引用补全**：Rust 端项目文件搜索（跳过依赖/构建目录）+ 输入 `@` 弹出补全面板
- [x] **消息操作**：工具栏 Fork（`get_fork_messages` + `fork` 从历史提示词重新分叉）；会话切换改用 `switch_session` 免重启

### M4（进行中）
- [x] **应用设置**：pi 路径配置 + 检测（SettingsDialog）
- [x] **会话导出**：`export_html` + 桌面端选择目录并打开／远程端下载
- [x] **消息复制**：ai-elements `MessageActions` 一键复制回复
- [x] **技能托管**：完整技能存放在 `~/.pix/skills`，设置中可视化导入 / 启用禁用 / 删除（`skills.rs`，启用列表同步到 pi settings）
- [ ] **自动更新**：tauri-plugin-updater（需签名密钥与发布渠道）
- [ ] **多会话并行**：多窗口 + 每窗口独立 pi 进程（需将 RpcState 改为 per-window 实例）
- [ ] **扩展管理界面**：列出/启用禁用扩展包

### 暂缓
- **主题映射**：pi 主题（`~/.pi/agent/themes`）映射到应用配色
- **OAuth 订阅登录**（Claude Pro/Max、ChatGPT、Copilot 等）：需要宿主应用注册与凭据安全存储方案，先依赖 pi 现有 auth.json / API key 配置

## 平台支持

- **Windows**（主要目标，已验证）：npm shim 解析、CREATE_NO_WINDOW、进程树清理
- macOS / Linux：理论可用（pi 以 shebang 脚本直接启动），未系统测试

## 局域网网页访问

在桌面端 **设置 → 局域网访问** 中开启（默认关闭，默认端口 `1421`），复制显示的完整访问链接到同一局域网内设备的浏览器。可在开启前修改端口。开关与端口会保存，重启应用后恢复；每次重新开启或重启应用都会生成新密钥，需重新复制链接。

- 保持桌面应用运行，并仅在 Windows 防火墙的专用网络中放行该端口；不自动修改防火墙。
- 网页复用本机 Pi 进程，支持会话、聊天及实时事件；首次连接已有进程时不会重启它。桌面和网页共享同一个会话，避免同时切换项目或发送消息。
- 网页选择项目时填写**主机上的绝对目录路径**，不是访问设备上的路径。运行时路径设置、局域网开关以及系统打开文件仅在桌面端使用。
- 关闭开关会停止监听并断开网页事件连接，不会终止已经提交给 Pi 的任务。
- **完整链接包含访问密钥，相当于授予主机上 Pi 的控制权限。HTTP 未加密，只用于可信局域网；不要公开链接或将端口映射到公网。**
- 网页文件随桌面程序内嵌打包。开发此功能时先运行 `npm run build` 更新网页资源，再启动/重建桌面端；只有 Vite 开发服务不能提供远程 Pi API。

### 自动会话标题

在桌面端「设置 → 模型配置」启用自动标题，通过与对话框相同的下拉列表一次选择「供应商 / 模型」；认证复用 pi 的配置，无需在 PiX 重复填写密钥。

新会话发送第一条消息后，侧栏立即显示消息预览，独立的 pi 进程异步生成标题并持久保存。不切换当前对话模型、不使用工具、不加载扩展或项目上下文。生成失败或超时保留预览，每个会话最多尝试一次；手动标题不会被覆盖。默认关闭，启用后会产生额外模型用量，配置变更对新会话生效。


### 窗口托盘与数据目录

- 点击关闭按钮直接最小化到系统托盘，后台任务继续运行。
- 托盘单击或菜单「显示 PiX」恢复窗口，菜单「退出 PiX」结束应用及正在运行的 agent。
- Pi 数据由 Pi 管理，默认使用 `~/.pi/agent`，尊重用户设置的 `PI_CODING_AGENT_DIR`。模型、凭据、提示词、技能、包配置、信任决定和会话与终端共用；PiX 不再创建独立 agent 目录。
- 模型和思考等级作为界面选择偏好保存在浏览器本地，新项目和新对话沿用上次选择；恢复历史会话时以 Pi 会话记录为准。
- `.pix` 仅保存 PiX 自有设置（窗口/界面、最近项目、自动标题功能、远程访问等），以及托管的完整技能（`~/.pix/skills`，启用状态记录在 Pi 的 settings.json；删除托管技能会同时从启用列表移除）。会话名称保存为 Pi 原生 `session_info`；`*.pix.json` 仅保存归档和标题生成尝试标记。
- 不读取或迁移旧 `.pix/agent`、旧默认模型、旧技能列表和旧标题字段；不会自动删除旧文件。
- 信任、默认模型、技能路径和离线会话改名通过已安装 Pi 的 SDK 操作，要求提供 `dist/core` 的 npm 版 Pi 及 Node.js；不会自动安装第二份 Pi。
- 项目内 `.pi` 配置仍在原位置，浏览器的界面偏好仍属于该浏览器。

### 输入框补全

- 消息开头输入 `/`：首次主动使用时启动 pi，展示 RPC 返回的扩展、提示词模板和技能命令；内置 `/new`、`/compact [要求]` 映射为对应 RPC 操作；其余终端专属或未知命令会提示不支持，不作为普通消息误发。
- 输入 `@`：搜索当前项目文件；支持在句中移动光标后补全，搜索失败可重试。
- `↑` / `↓` 切换候选，`Enter` / `Tab` 选择，`Esc` 关闭；`Shift+Enter` 换行。输入法确认不会选中候选或发送。
- 引用文件只提供项目相对路径，agent 按需读取。扩展命令保留原始参数，其文件引用解释由扩展负责；提示词模板如何使用参数由模板本身决定。
- 补全 UI 使用 AI Elements 的 PromptInputCommand 系列、PromptInputButton 和 Loader。

补全测试：`npm run test:web`（即 `node --test "tests/*.test.mjs"`，运行全部单元测试）。浏览器回归：安装 Playwright 后运行 `node tests/completion.browser.mjs`（默认使用本机 Edge，可通过 `PI_BROWSER_CHANNEL` 切换；`PI_PLAYWRIGHT_MODULE` 可指定已有 Playwright 的 index.mjs 路径）。浏览器测试使用模拟 RPC，不调用模型。

推送/PR 由 GitHub Actions（`.github/workflows/ci.yml`）自动执行 lint、typecheck、构建、Node 测试与 Rust check/test。

#### 错误消息约定

- **UI 层用户可见消息**：一律走 vue-i18n（`zh-CN` / `en`），包括 store 抛出的可预期错误。
- **Rust 侧诊断消息**：面向开发者/日志，保持原文；前端在展示时可用 toast 包装。
- **包管理器**：统一使用 pnpm（`pnpm-lock.yaml` 是唯一锁文件）；scripts 中的 `npm run` 仅为脚本执行器，与安装工具无关。
