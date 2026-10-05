# SSH 远程项目：规划与技术方案

> 状态：v1（已融合 ZCode 参考实现）
> 范围：在 PiX 桌面客户端中操作远程 SSH 主机上的项目，pi 进程运行在远程主机上。
> 参考：ZCode（github.com/zai-org/ZCode）`packages/server/src/remote/`（39 个文件）的 SSH 远程实现，2026-10-05 调研。

## 1. 目标

- 用户在 PiX 中添加"SSH 远程项目"，像本地项目一样进行 AI 对话、代码修改、终端操作。
- 复用现有会话恢复、runtimeId、事件流机制；本地项目行为完全不变。
- 远程主机部署成本尽可能低（目标：只要能 SSH 登录即可，pi 环境可由 PiX 引导安装）。

## 2. ZCode 的做法（核心参考）

ZCode 是 Electron + React + Hono monorepo，其远程能力是主打功能，方案为 **VS Code Remote-SSH 模式**：agent 进程跑在远程主机上，SSH exec channel 作为传输隧道。支持 SSH / WSL / Docker 三种远端后端，统一抽象为 `IRemoteBackend`（`detect/upload/exec/exists/readFile/onDidDisconnect`）。

连接流程（`packages/server/src/remote/connect.ts`）：

1. **detect**：SSH exec `uname -s`/`uname -m` 探测远程平台架构；
2. **deploy**：按 manifest（逐组件版本 + sha256 幂等比对，远端 deploy lock 串行化）把 Node 运行时 + zcode-server bundle 上传到 `~/.zcode/server/`——远端**无需预装任何环境**；
3. **launch**：SSH exec 启动远端 `zcode-server.cjs`，server 以 stdio 模式运行，RPC 帧直接走 SSH channel 的 stdin/stdout；
4. **handshake**：逐行读 stdout 等 JSON hello，非 JSON 行当作 SSH banner/motd 跳过；
5. UI 经 RPC 框架（仿 VS Code PersistentProtocol：ACK + 重连 + 消息重放）拿到远端 40+ 服务的类型安全代理。

**与 PiX 的同构性**：ZCode 远端 server 的"stdout 只准承载 RPC 帧、日志全部改道 stderr"约束，与 PiX 的 `pi --mode rpc` JSONL 约束完全一致。ZCode 验证了"SSH exec channel 当传输隧道 + 远端 headless 进程 + agent 子进程"这条路线是打磨过的。

关键工程细节（踩坑经验，直接采纳）：

- **SSH exec 强制包一层 `/bin/sh`**（`posixShell.ts`）：防 fish 等非 POSIX 登录 shell 把命令当错误。
- **stdout 卫生**：远端进程任何日志必须走 stderr，且握手时容忍/跳过非 JSON 行（SSH banner、motd 污染）。
- **身份键**：`remote:ssh:<host>:<port>:<username>:<posixPath>`，强制走统一的构造/解析工具，禁止手拼；path 归一化（分隔符→`/`、去尾斜杠、恒以 `/` 开头），重连时用远端 `realpath` 归一化后回绑，防符号链接别名（如 `/home/dev` vs `/dev`）导致身份漂移。
- **凭据分离**：持久化的远程目标快照里 `stripRemoteTargetSecrets` 剥离密码/私钥口令，凭据单独存 OS 凭据服务（键 `remote-workspace:<workspaceKey>:password`）。ZCode 用 Node 的 `ssh2` 库，支持密码（含 keyboard-interactive）、私钥+口令、SSH agent；密码模式下默认禁用隐式 agent（防小 `MaxAuthTries` 主机被公钥尝试耗尽次数）。
- **启动恢复为断连态、手动重连**（源码注释明确是有意设计）：重连流程 = 重载凭据 → 连接 → 远端 `realpath` 归一化 → 与历史路径不同则回绑会话上下文 → 刷新状态 → 成败都落库。
- **保活**：keepalive 15s × 3 次无响应主动判定断开，`onDidDisconnect` 并入会话关闭链路，避免 UI 永远 loading。
- **文件上传**：优先 SFTP（带进度），失败自动降级 `cat > file` exec 管道并记住 exec-only 状态；AbortSignal 全程可取消。
- **测试环境**：`harness/remote/` 用 Docker 起 sshd 容器（2222 端口）+ `ssh-copy-id` 免密登录做本地集成测试。
- ZCode 的两个已知缺口（我们要避免）：未见 known_hosts/主机指纹校验；远程会话无自动重连（重连全手动）。

## 3. PiX 现状结论

### 可直接复用

- `src/api/transport.ts`：前端访问后端的唯一入口，传输无关。
- `SessionTransport`（`src-tauri/src/rpc/child.rs:29`）：RPC 会话 = stdin sender + pending map + 自增 id，与本地进程无强绑定。
- `runtimeId` 命名空间贯穿前后端，多远程会话并存有现成机制。
- `--session <path>` 恢复机制 = SSH 断线重连的天然路径。
- 终端 xterm.js + `term://output` base64 帧协议与传输无关。
- `rpc.rs:292 resolve_export_path` 已有多主机路径语义先例。
- 现有 `remote/` axum 模块（token 鉴权、WS 首帧认证、域化命令分发）可作为远期"远程 agent"的直接模板。

### 硬编码"pi 在本地"、需改造

| 位置 | 本地假设 |
| --- | --- |
| `rpc/child.rs:112-176` | 本地 spawn、`current_dir`、`taskkill /T /F` |
| `commands/pi.rs:34` | 本地 `is_dir()` 校验 |
| `pi_locate.rs` / `pi_data.rs` / `trust.rs` | 本地找 pi、本地 node SDK |
| `sessions.rs` + `session_watch.rs` | 本地扫 + notify watch 会话目录 |
| `workspace_git.rs`、`session_checkpoint/*`、`session_revert.rs` | 本地 git/文件操作 |
| `commands/files.rs`、`fs_search.rs`、`file_preview.rs` | 本地文件浏览/搜索/预览 |
| `terminal.rs` | portable-pty 本地 PTY |
| `stores/workspace.ts`、`workspaceStartup.ts`、`paths.ts` | 本地绝对路径语义 |

## 4. 方案选型

ZCode 的三层结构是：UI → RPC → 远端 zcode-server → agent 子进程。PiX 有两种对应形态：

- **方案 A（MVP，推荐起步）**：UI → 现有 RPC 通道 → Tauri 后端经 SSH exec 直接启动远端 `pi --mode rpc`。pi 本身就是 ZCode 里"远端 server"的角色（同为 stdio JSONL 协议），不需要远端再包一层。一次性命令（git、`test -d`、cat）走 SSH exec。
- **方案 B（终态，对齐 ZCode）**：远端部署一个 `pix-server`（headless，把现有 `remote/` axum 模块改造为 stdio 模式），pi 作为其子进程；文件/Git/终端/会话服务全部在远端本地执行，通过 SSH 隧道暴露完整服务面。等价于 ZCode 的架构，解决方案 A 中"文件浏览/搜索走 one-shot exec 粗糙"的问题。

推荐 **A 起步、向 B 演进**，两者共用同一套 SSH 传输与身份/凭据底座，B 不推翻 A 的成果。

### SSH 实现层

抽象 trait：

```rust
#[async_trait]
trait SshTransport: Send + Sync {
    async fn probe(&self) -> Result<RemoteProbe>;                            // uname / node / pi 版本
    async fn exec(&self, cmd: RemoteCommand) -> Result<ExecOutput>;          // 一次性，强制 /bin/sh 包裹 + base64 payload
    async fn exec_stream(&self, cmd: RemoteCommand) -> Result<StreamHandle>; // 长驻流：pi --mode rpc / ssh -tt 终端
    async fn upload(&self, local: PathBuf, remote: String) -> Result<()>;    // P4 部署引导用
    fn on_disconnect(&self) -> ...;                                          // 对齐 ZCode 的 onDidDisconnect
}
```

- MVP 后端：**系统 ssh 二进制**（`tokio::process::Command` + 独立参数数组，符合仓库"不拼接 shell 命令"约定）。认证仅 key/agent（`BatchMode=yes` 防挂在交互提示上），错误 stderr 归一化为产品文案（对齐 ZCode 的 `sshAuth.ts` 错误分类）。
- 终态后端：**russh**（密码 + keyboard-interactive 认证 UI、SFTP、host key TOFU 校验——补上 ZCode 的安全缺口）。
- 远程命令一律包 `/bin/sh -c` + base64 payload，规避 fish/引号二次解析。

## 5. 标识、路径与凭据模型（对齐 ZCode）

- **身份键**：`ssh://[user@]host[:port]/abs/path`（展示层 URI）；内部身份键采用 ZCode 的 `remote:ssh:<host>:<port>:<user>:<posixPath>` 规范格式，统一构造/解析函数，禁止手拼。
- **路径**：携带 target 归属；远程路径 POSIX 语义，重连时远端 `realpath` 归一化并回绑。
- **凭据**：连接配置（host/port/user/key 路径）存 `~/.pix/config.json`；密码/口令如后续支持（russh 阶段）单独存 OS 凭据服务，持久化快照一律剥离 secrets。
- **恢复策略**：启动时远程项目恢复为**断连态 + 手动重连**（采纳 ZCode 的有意设计，避免启动时静默发起 SSH 连接）；会话内断线则提示并走 `--session` 恢复。

## 6. 分期规划

**P1：远程对话跑通（核心价值）**
1. SSH 连接管理器（UI + config 持久化 + `~/.ssh/config` 别名补全）与连接测试（probe：uname / node / pi 版本，未装 pi 给出指引）。
2. `SshTransport`（系统 ssh 实现）：probe / exec / exec_stream，`/bin/sh` 包裹 + base64 payload。
3. `rpc_spawn` 分流：`ssh://` target 校验改远程 `test -d`，spawn 改 SSH exec 启动 `pi --mode rpc`，JSONL 桥接进现有 dispatch；容忍 stdout 非 JSON 行（banner/motd）。
4. 远程信任决策：SSH exec 跑 `pi_data.mjs`（远程有 node，方案原样成立）。
5. 断线处理：保活（`ServerAliveInterval=15`）→ `pi://exit` → 手动重连 → `--session` 恢复。
6. 项目选择器支持远程项目；远程路径 POSIX 归一化。

**P2：会话历史与终端**
- 远程会话列表：one-shot 扫远程 `~/.pi/agent/sessions/`，按需刷新。
- SSH 终端：每终端一个 `ssh -tt` 进程，输出接入现有 `term://output` base64 帧协议，前端 xterm.js 不改。

**P3：Git 与文件能力**
- `workspace_git.rs` 的 git 子进程调用改为经 SSH exec（该模块本就是子进程封装，改造面小）。
- 文件预览/浏览/搜索：one-shot `cat`/`grep`/`find` 起步。
- 远程项目先禁用 checkpoint/revert/rewind，评估远程语义后再做。

**P4：环境引导 + 向方案 B 演进（对齐 ZCode）**
- **一键远程环境引导**（借鉴 ZCode deploy manifest）：上传/安装 Node 运行时 + pi，逐组件版本 + SHA256 幂等，远端 deploy lock 串行化——实现"只要能 SSH 登录就能用"。
- russh 后端：密码/keyboard-interactive 认证 UI、SFTP 文件浏览、host key TOFU。
- 远端 `pix-server`（stdio 模式）：文件/Git/终端服务本地化执行，完整对齐 ZCode 架构。
- （可选）WSL / Docker 远端后端：PiX 与 ZCode 同构，`IRemoteBackend` 式抽象天然可扩展。

## 7. 风险与验证点

- **pi 的 stdin EOF 行为**：断连后远程 pi 是否干净退出需实测；兜底为 spawn 时记录远端 pid，必要时 exec `kill`。
- **Windows OpenSSH client** 是可选功能，probe 阶段检测并给安装指引（`Add-WindowsCapability`）。
- **stdout 污染**：远端 pi/中间层的日志必须走 stderr；握手读 stdout 需容忍非 JSON 行（ZCode 踩坑经验）。
- **RPC 多一个 RTT**：UI 需连接状态指示；超时预算沿用现有 10s 级。
- **远程 shell**：强制 `/bin/sh` 包裹规避 fish/zsh 差异（ZCode 做法）。
- **安全**：host key 校验 MVP 依赖系统 ssh 的 known_hosts（比 ZCode 的 ssh2 默认更安全）；russh 阶段自实现 TOFU；凭据永不入快照/日志。

## 8. 测试策略

- 单测（Vitest + Rust）：身份键构造/解析、base64 payload、SSH 参数数组构造（`PIX_SSH_COMMAND` 测试钩子注入 mock）、JSONL 分帧桥接、非 JSON 行容忍。
- 集成：借鉴 ZCode `harness/remote/`——Docker sshd 容器（2222 端口）+ `ssh-copy-id` 免密，CI 可跑真实 SSH 链路（container 内装 node + pi 或 stub）。
- 按 AGENTS.md 原则不为 SSH 交互新增 E2E。
