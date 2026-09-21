# Pi X

**pi coding agent 的桌面客户端** —— 基于 [Tauri 2](https://v2.tauri.app/) + Vue 3 + TypeScript 构建，通过 pi 官方支持的 RPC 模式驱动 [pi coding agent](https://github.com/badlogic/pi-mono)（`@earendil-works/pi-coding-agent`），在原生窗口中提供完整的 AI 结对编程体验。

```
┌─────────────────────────────────────────────────┐
│                Pi X (Tauri 窗口)                 │
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
- **@file 引用**：输入 `@` 弹出项目文件补全（基名匹配优先，自动跳过 node_modules/.git/dist 等），选中插入 `@relative/path`
- **图片输入**：粘贴 / 拖拽 / 添加按钮发送图片（base64），气泡内预览
- **Fork 分叉**：从任意历史用户提示词重新开始对话（`fork` RPC）
- **扩展 UI 完整支持**：pi 扩展弹出的 select / confirm / input / editor 对话框以原生桌面对话框呈现，回答通过 `extension_ui_response` 回传
- **项目信任管理**：与 TUI 共享 `~/.pi/agent/trust.json`，首次打开项目弹出信任确认，父目录信任自动继承
- **pi 自动检测**：扫描 PATH 与常见安装位置定位 pi；支持在应用内配置自定义 pi 路径；Windows 下解析 npm `.cmd` shim 并直接以 `node + cli.js` 启动（绕开 cmd shim 在管道下的兼容性问题）
- **会话统计**：状态栏实时显示上下文 token 用量、成本、模型信息
- **会话导出**：一键导出为 HTML 并用浏览器打开
- **应用内设置**：自定义 pi 可执行路径 + 实时检测结果（Windows 下自动解析 npm shim）
- **消息复制**：AI 回复一键复制为 Markdown 文本

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
│       ├── trust.rs            # trust.json 读写（与 pi TUI 语义一致）
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
| `npm run dev:desktop` | 启动桌面应用开发模式（Vite HMR + Tauri） |
| `npm run dev` | 仅前端（浏览器预览，无 pi 进程） |
| `npm run build` | 前端构建（vite build） |
| `npm run check` | 前端构建 + cargo check |
| `npm run test` | Rust 单元测试（cargo test） |
| `npm run package` | 打包安装程序（NSIS/MSI 到 `src-tauri/target/release/bundle/`） |
| `npm run package:debug` | Debug 打包 |

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
- [x] **会话导出**：`export_html` + 系统默认浏览器打开
- [x] **消息复制**：ai-elements `MessageActions` 一键复制回复
- [ ] **自动更新**：tauri-plugin-updater（需签名密钥与发布渠道）
- [ ] **多会话并行**：多窗口 + 每窗口独立 pi 进程（需将 RpcState 改为 per-window 实例）
- [ ] **扩展管理界面**：列出/启用禁用扩展包

### 暂缓
- **主题映射**：pi 主题（`~/.pi/agent/themes`）映射到应用配色
- **OAuth 订阅登录**（Claude Pro/Max、ChatGPT、Copilot 等）：需要宿主应用注册与凭据安全存储方案，先依赖 pi 现有 auth.json / API key 配置

## 平台支持

- **Windows**（主要目标，已验证）：npm shim 解析、CREATE_NO_WINDOW、进程树清理
- macOS / Linux：理论可用（pi 以 shebang 脚本直接启动），未系统测试
