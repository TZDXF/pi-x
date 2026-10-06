# SSH 远程项目：P2 接口契约

> 状态：v1（契约冻结稿，供三方并行开发）
> 上游：`docs/plans/ssh-remote-project.md`（P2 = 会话历史与终端）；P1 契约 `docs/plans/ssh-remote-p1-contracts.md`（下称"P1 契约"）继续有效，本文档只做增量。
> 立契约前通读的现有实现（引用为 `path:line`，相对仓库根）：
> - 后端：`src-tauri/src/ssh/{mod,identity,payload,config,transport}.rs`、`src-tauri/src/rpc.rs`、`src-tauri/src/rpc/child.rs`、`src-tauri/src/commands/{pi,ssh,mod}.rs`、`src-tauri/src/sessions.rs`、`src-tauri/src/terminal.rs`、`src-tauri/src/trust.rs`、`src-tauri/src/pi_data.rs`、`src-tauri/resources/pi_data.mjs`、`src-tauri/src/lib.rs`
> - 前端：`src/lib/ssh.ts`、`src/lib/workspaceStartup.ts`、`src/lib/workspaceRuntime.ts`、`src/stores/workspace.ts`、`src/composables/useSessionOpening.ts`、`src/api/client/{ssh,sessions,config,process,rpc}.ts`、`src/components/terminal/TerminalPanel.vue`、`src/components/ChatView.vue`、`src/components/workspace/sidebar/SidebarSessionList.vue`、`src/components/WorkspaceSidebar.vue`
> - 测试环境：`docs/plans/wsl-test-env.md`（localhost:2222 实机）

---

## 1. P1 遗留盘点

### 1.1 realpath 路径别名回绑：已落地，本次扩大触发面

核查结论：P1 契约 §3.8 的回绑**已实现**，非遗留缺口：

- 后端：`rpc/child.rs:443-464` 在远程 spawn 就绪后经一次 exec `realpath` 归一化远端路径，路径有差异时发 `pi://sshPathBound`（payload `{ runtimeId, project, path }`，`project` 为回绑后重建的 `ssh://` 展示 URI）；实现位于 `rebind_remote_path`（`child.rs:496-555`），纯函数 `realpath_script`/`parse_realpath_output` 已有单测（`child.rs:908-931`）。
- 前端：`src/api/client/rpc.ts:61-65` 的 `onSshPathBound` 监听与 `src/lib/workspaceRuntime.ts:116-129` 的消费（更新 `owner.cwd`、`workspace.remember`、`config.lastProject`）均已完成。

**P2 变更（一处）**：当前回绑只在重连（`session_file.is_some()`，`child.rs:446`）时触发。首次 spawn 用别名路径（如 `/home/dev` 实为 `/dev` 的符号链接）创建的项目同样会以别名入库，产生身份漂移。改为**所有远程 spawn（含新建）就绪后都执行回绑检查**：删除 `child.rs:446` 的 `session_file.is_some()` 门槛，`if let SpawnProgram::Ssh(spec)` 分支保留。事件名与 payload 形状不变（P1 契约 §3.8 冻结继续有效）；realpath 失败仍不阻塞 spawn、不发事件。前端已实现的消费逻辑无需改动。

实机验证用例见 §6（用例 S-R1）。

### 1.2 远程信任主方案：P1 降级方案 → P2 落地（见 §4）

P1 按契约 §4.2 采用降级方案（远程项目跳过信任决策直接 spawn），涉及点：`src/lib/workspaceStartup.ts:167-173`、`src/composables/useSessionOpening.ts:105`、`useSessionOpening.ts:152-155` 的 `isSshProject` 分流。P2 按本文 §4 落地 `ssh_trust_status`/`ssh_trust_save`（名称沿用 P1 契约 §4.1 冻结），前端把上述三处分流从"跳过"改为"调远程命令"，信任弹窗（`App.vue:611-620` 的 `TrustDialog`）复用不变。

### 1.3 backendErrors i18n 键核查：已补齐，无需动作

实测核对（grep `src/i18n/locales/zh-CN.ts` 与 `en.ts`）：P1 契约 §2.4 列出的全部 coded error 键在两侧 `backendErrors` 命名空间（zh-CN.ts:1272 起，键位于 1443-1453；en.ts:1316 起，键位于 1489-1501）均已存在：`sshMissing`、`sshAuthFailed`、`sshConnectFailed`、`sshTimeout`、`sshProbeFailed`、`sshConnectionNotFound`、`sshConnectionMissing`、`sshConnectionMismatch`、`sshConnectionInvalid`、`sshWorkspaceUnsupported`、`sshRemotePiMissing`，另有 `projectDirMissing`（zh-CN.ts:1373）。`tests/backend-errors.test.ts` 校验三方同步，新增键时必须同步该测试（见 §5）。

### 1.4 `ssh/mod.rs` 未消费 re-export 的 cargo 警告清理

实测 `cargo check`（本次在 worktree 运行）共 9 条 warning，全部源自 P1 预留 API 暂无生产调用点：

```
warning: unused imports: `SshConnectionInput`, `SshConnection`, `SshProbeInfo`          (ssh/mod.rs:15)
warning: unused imports: `DEFAULT_PORT`, `IDENTITY_KEY_PREFIX`, `SSH_URI_PREFIX`,
         `identity_key`, `normalize_host`, `normalize_ssh_path`, `parse_identity_key`,
         `validate_user`                                                                (ssh/mod.rs:17-18)
warning: unused imports: `EXIT_CODE_SDK_DIST_MISSING`, `PROBE_SCRIPT`, `encode_payload`,
         `wrap_payload`                                                                 (ssh/mod.rs:22-23)
warning: unused imports: `ExecOutput`, `PROBE_TIMEOUT`, `RemoteProbe`, `SshEndpoint`,
         `SshErrorKind`, `SshError`, `SshTransport`, `SystemSsh`, `build_ssh_args`,
         `build_ssh_command`, `classify_failure`, `parse_probe_output`,
         `split_program_spec`, `ssh_program_parts`, `ssh_program`                       (ssh/mod.rs:26-27)
warning: constant `IDENTITY_KEY_PREFIX` is never used                                   (ssh/identity.rs:12)
warning: function `identity_key` is never used                                          (ssh/identity.rs:95)
warning: function `parse_identity_key` is never used                                    (ssh/identity.rs:111)
warning: constant `EXIT_CODE_SDK_DIST_MISSING` is never used                            (ssh/payload.rs:15)
warning: methods `exec` and `exec_stream` are never used                                (ssh/transport.rs:320)
```

处置（P2 落地后自然消除 + 显式标注保留）：

1. **自然消除**：`EXIT_CODE_SDK_DIST_MISSING`（§4 信任流程消费）、`ssh_program_parts`（§3 终端分支消费）、`parse_probe_output`/`probe` 相关（P1 已用，随本次 re-export 一起整理）。
2. **保留 + 标注**：`identity_key`/`parse_identity_key`/`IDENTITY_KEY_PREFIX` 是 P1 契约 §1.4 冻结 API，P4 身份快照持久化才启用——在 `ssh/identity.rs` 对应项加 `#[allow(dead_code)]` 并注明"契约 §1.4 API，P4 快照持久化启用"；`SshTransport` trait 的 `exec`/`exec_stream` 方法（`transport.rs:316-328`）同理加 `#[allow(dead_code)]`（P4 russh 后端启用；P2 调用方继续用自由函数 `ssh_exec`/`ssh_exec_stream`）。
3. **re-export 整改**：`ssh/mod.rs` 的四组 `pub use` 合并加 `#[allow(unused_imports)]`，对齐 `commands/mod.rs:34-37` 的既有做法（那里因 remote-access feature 的条件调用点采用同一模式）。

该清理由后端会话与信任 agent 执行（文件归属见 §7）。

---

## 2. 远程会话列表

### 2.1 命令签名决策：**新增 `ssh_sessions`（不扩展现有 `session_list`）**

理由：

1. **现有命令强绑定本地文件系统语义**。`session_list` 实现为 `sessions::list`（`sessions.rs:133-190`）：先 `std::fs::metadata(&project)`（`sessions.rs:134`）做本地目录校验，`dunce::canonicalize` 归一化 cwd（`sessions.rs:143-144`），meta 缓存以 `PathBuf` 为键（`sessions.rs:245-248`）。`ssh://` URI 在第一步就会撞上 `projectDirMissing`；要复用得给每层加远程分支，改动面大且污染本地路径。
2. **配套命令无法共享**。侧栏历史动作依赖 `session_mtime/history/update/delete/duplicate`（`sessions.rs:580-673`），全部是本地文件操作，对远程项目天然不可用——扩展 `session_list` 只解决列表一项，掩盖不了整套命令的不可用边界；P1 契约 §5 的"远程项目不触达本地 session 文件命令"守卫原则继续成立。
3. **实现零共享**。远端扫描走 find/head/grep 管道（§2.2），与本地 `BufReader` 逐行读（`sessions.rs:70-114`）无公共代码；返回形状复用即可，不必共命令。
4. **文件归属干净**（§7）：新命令落在新文件，终端 agent 与本地 sessions.rs 互不触碰。

精确签名（Rust，新建 `src-tauri/src/ssh_sessions.rs`；注册进 `lib.rs` 的 `generate_handler`）：

```rust
/// 远程项目会话列表。project 为 `ssh://` 展示 URI，ssh_connection_id 为
/// 连接 id（与 rpc_spawn 的 sshConnectionId 同源，是连接细节的唯一权威来源）。
#[tauri::command]
pub async fn ssh_sessions(
    project: String,
    ssh_connection_id: String,
) -> Result<Vec<crate::sessions::SessionMeta>, String>
```

- 返回类型**复用** `sessions::SessionMeta`（`sessions.rs:29-39`，camelCase 序列化），前端 `SessionMeta`（`src/api/client/sessions.ts:9-18`）零改动消费。字段取值：`file`=远端绝对路径、`id`/`cwd`/`timestamp` 取自会话头、`mtimeMs`=远端 mtime 秒×1000、`title`=最后一条 `session_info` 的 name、`preview`=恒 `null`（P2 裁剪，见 §2.3）、`archived`=恒 `false`（远程归档 P2 不做）。
- 校验链（对齐 `spawn_remote`，`commands/pi.rs:101-133`）：`parse_ssh_uri(project)` 失败 → `sshConnectionInvalid`；`ssh_connection_id` 空 → `sshConnectionMissing`；连接不存在 → `sshConnectionNotFound`；host/port/user 与 URI 不一致 → `sshConnectionMismatch`。
- 错误归类：SSH 失败经 `ssh_error_coded`（`commands/ssh.rs:32-51`）；扫描成功但 `PIX_SESSIONS_DONE` 标记缺失（超时/截断）→ coded error `sshRemoteFailed`（新键，文案见 §5.3）。
- exec 超时 20s。

### 2.2 远端扫描：单次 ssh exec，标签行协议

一次 exec 完成枚举 + 逐文件元数据提取（避免逐文件多次 RTT）。脚本冻结文本（加入 `ssh/payload.rs`，与 `PROBE_SCRIPT` 同级常量 `SESSIONS_SCRIPT`，经 §3.4 base64 通道投递；路径单引号包裹由 `posix_quote` 注入 `<PROJECT>`）：

```sh
SESS_ROOT="$HOME/.pi/agent/sessions"
PHYS=$(cd '<PROJECT>' >/dev/null 2>&1 && pwd -P)
echo "PIX_SESSION_CWD=$PHYS"
[ -n "$PHYS" ] || { echo "PIX_SESSIONS_DONE"; exit 0; }
[ -d "$SESS_ROOT" ] || { echo "PIX_SESSIONS_DONE"; exit 0; }
find "$SESS_ROOT" -type f -name '*.jsonl' 2>/dev/null | while IFS= read -r f; do
  m=$(stat -c %Y "$f" 2>/dev/null) || m=$(stat -f %m "$f" 2>/dev/null) || m=0
  printf '%s\t%s\n' "$m" "$f"
done | sort -rn | head -n 200 | while IFS="<TAB>" read -r m f; do
  echo "PIX_SESSION_FILE=$f"
  echo "PIX_SESSION_MTIME=$m"
  echo "PIX_SESSION_HEADER=$(head -c 8192 "$f" 2>/dev/null | head -n 1)"
  echo "PIX_SESSION_TITLE=$(grep '\"type\":\"session_info\"' "$f" 2>/dev/null | tail -n 1)"
done
echo "PIX_SESSIONS_DONE"
```

要点（冻结）：

- `<TAB>` 为字面制表符（0x09）；`while IFS="<TAB>" read -r m f` 按制表符切分 mtime 与路径，容忍路径空格。
- `stat -c`（GNU）/`stat -f`（BSD/macOS）回退链，取不到 mtime 记 0。
- `head -c 8192 | head -n 1` 截取会话头（首行是小 JSON，8 KiB 上限防异常文件）；`grep '"type":"session_info"' | tail -n 1` 取最后一条命名记录（与本地 `read_session_name` 的"最后一条生效"语义一致，`sessions.rs:331-352`）。
- `PIX_SESSION_CWD` 行给出项目物理路径（`pwd -P` 解析符号链接）：pi 记录在会话头的 `cwd` 可能是逻辑路径，后端过滤时与 URI path **或** 物理路径任一相等即收录，防别名路径把会话滤空。
- 扫描上限 200 个最新文件（本地 MAX_SESSIONS=50 的过滤余量），`sort -rn` 按新到旧。
- 退出码恒 0（业务语义走标签行 + DONE 标记）；`find`/`stat`/`grep` 失败静默降级，单文件损坏不清空整个列表（对齐本地 `sessions.rs:175-179` 的容错原则）。

后端解析（`ssh_sessions.rs` 纯函数 + 单测）：`parse_sessions_output(stdout, filter_paths: &[&str]) -> Vec<SessionMeta>`——逐行 `split_once('=')`，仅认 `PIX_SESSION_*` 前缀标签行，其余（banner/motd）静默忽略（同 `parse_probe_output` 模式，`transport.rs:183-218`）；读到 `PIX_SESSIONS_DONE` 才返回结果；`HEADER`/`TITLE` 值按 JSON 解析，解析失败的记录跳过；`cwd` 过滤 = `header.cwd == uri_path || header.cwd == phys_path`；输出按 `mtimeMs` 降序、上限 50。

### 2.3 P2 裁剪

- `preview`：首条用户消息预览需要本地式 32KB 预算流式扫描（`sessions.rs:70-114`），远端 shell 无等价低风险实现，P2 恒 `null`，侧栏显示标题/时间。
- `archived` 与归档列表页：远程会话不参与 `session_list_archived`（本地命令），归档页只见本地会话。
- 会话元数据写操作（重命名/归档/删除/复制）：远程项目入口继续禁用（P1 契约 §5 守卫不动）。

### 2.4 前端：解除守卫后的 UI 行为

`src/stores/workspace.ts` 的 `refresh(path)`（`workspace.ts:386-404`）远程分支从"置空返回"改为调用远程列表：

```ts
// src/api/client/ssh.ts 新增包装
export const sshSessions = (project: string, sshConnectionId: string) =>
  invoke<SessionMeta[]>("ssh_sessions", { project, sshConnectionId })
```

- 连接 id 解析复用 `resolveSshConnectionId(uri, config.sshConnections ?? [])`（`src/lib/ssh.ts:209-219`）；解析不到连接 → `histories[path] = []` 并 toast `ssh.sessionHistoryUnavailable`（沿用现有键）。
- 失败 → `histories[path] = []` + toast（`translateError` 渲染 coded error），不清空其它项目。
- **按需刷新，不做 inotify**：`pi://sessions-changed`（本地 watcher 事件）对远程项目不生效；远程项目在 (a) spawn 成功后、(b) 用户点击刷新按钮时各触发一次 `refresh`。刷新状态用 store 内 `remoteSessionsLoading: Record<string, boolean>` 驱动按钮 spinner。
- `SidebarSessionList.vue:120-123`：远程项目空态文案从 `ssh.sessionHistoryUnavailable`（P1 提示"暂不可用"）改为 `ssh.remoteSessionsEmpty`（"远程主机上暂无会话记录"，zh-CN/en 同步），并在历史区头部显示刷新按钮（title=`ssh.sessionsRefresh`："刷新远程会话"）。
- `WorkspaceSidebar.vue:140` 的 `unavailable: isSshProject(path)` 改为跟随加载/错误状态：远程项目 `unavailable=false`、`hasHistory` 正常计算，列表区渲染远程会话。
- 会话行点击恢复：复用现有 `useSessionOpening` 的 `--session` 恢复链路（`rpc_spawn` 已支持远端 `session_file`，`commands/pi.rs:53`），远程会话行的右键菜单仅保留"打开"（重命名/归档/删除等本地文件操作入口继续隐藏）。

新增测试：`tests/ssh-sessions-ui.test.ts`（store 分流、空态与刷新按钮渲染、连接缺失降级）。

---

## 3. SSH 终端

### 3.1 方案：portable-pty 内 spawn `ssh -tt`（而非裸管道）

`terminal.rs` 现有实现是 portable-pty 本地 PTY（`terminal.rs:48-132`）。远程分支**复用同一 PTY 装配**，只是把 `spawn_command` 的程序从本地 shell 换成本机 `ssh -tt`。选择 `ssh -tt` 而非 `ssh_exec_stream` 裸管道的理由（冻结）：

1. **resize 自动生效**：ssh 检测到本地 stdin 是 tty（PTY slave）时，把本地 SIGWINCH 转发为远端 PTY 尺寸变更——`term_resize` 只需 resize 本地 master（现有实现 `terminal.rs:148-167`），远端自动同步，无需任何远端辅助协议。
2. **远端得到真 PTY**：shell 提示符、job control、行编辑正常；裸管道下远端无 tty，体验残缺。
3. **交互提示天然可见**：认证密码、host key 确认等提示直接出现在终端里由用户处理（因此远程终端分支**不使用 `BatchMode=yes`**，见 §3.3）。
4. **输出链路不变**：PTY master 读端 → base64 → `term://output` 帧（`terminal.rs:90-110`）完全复用；`-tt` 下 ssh 把远端 stderr 也并入同一 tty，无额外流。

### 3.2 命令签名扩展

仅 `term_create` 增加一个可选参数；`term_write`/`term_resize`/`term_kill` 签名与行为**零改动**（`TerminalSession` 的 writer/master/killer 对 ssh 子进程同样适用，kill 走 `ChildKiller` 即杀本地 ssh）：

```rust
#[tauri::command]
pub fn term_create(
    app: AppHandle,
    state: State<'_, TerminalState>,
    cwd: String,                        // 本地分支照旧传本地路径；远程分支传 ssh:// 展示 URI
    cols: u16,
    rows: u16,
    owner: Option<String>,
    ssh_connection_id: Option<String>,  // 新增；前端 camelCase: sshConnectionId
) -> Result<u32, String>
```

分流规则（冻结）：

- `ssh::identity::parse_ssh_uri(&cwd).is_some()` → 远程分支；此时 `ssh_connection_id` 缺失 → coded error `sshConnectionMissing`。
- 本地路径 → 本地分支，行为与现在逐字节一致；**即使误传 `ssh_connection_id` 也忽略**（与 `rpc_spawn` 的"`project` 是唯一分流判据"一致，P1 契约 §3.1）。
- 远程分支校验链对齐 `spawn_remote`（`commands/pi.rs:119-133`）：连接不存在 → `sshConnectionNotFound`；host/port/user 与 URI 不一致 → `sshConnectionMismatch`。校验逻辑在 `terminal.rs` 内私有实现（终端 agent 不得改 `commands/pi.rs`，见 §7；三行字段比较允许重复）。

### 3.3 远程分支实现细节（冻结）

1. **交互式参数**：新增纯函数 `build_ssh_args_interactive(endpoint: &SshEndpoint) -> Vec<String>`（实现在 `ssh/transport.rs`，由后端会话与信任 agent 按 P1 `build_ssh_args` 的样式交付，终端 agent 只消费）：与 `build_ssh_args`（`transport.rs:116-141`）的差别仅两处——**去掉 `-o BatchMode=yes`**（交互终端允许密码/host key 提示浮出）、**追加 `-tt`**；`-o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=10 -p <port> [-i <key>]` 与目的地构造照旧。单测断言参数序列（放 `transport.rs` 测试模块）。
2. **远端脚本**：复用 `wrap_payload` base64 通道（`payload.rs:50-55`），内层脚本：

   ```sh
   cd '<PROJECT_PATH>' 2>/dev/null || echo "cd: cannot enter <PROJECT_PATH>" >&2
   exec "${SHELL:-/bin/sh}" -l
   ```

   与 spawn payload（`payload.rs:60-82`）不同：终端是交互场景，cd 失败不退码，仍进入 shell 让用户看到错误并自行修复。
3. **程序构造**：`CommandBuilder::new(ssh_program_parts()[0]).args(前置参数 + build_ssh_args_interactive + [wrap_payload(script)])`——消费 `ssh_program_parts()`（`transport.rs:110-112`）使 `PIX_SSH_COMMAND` 测试钩子对终端同样生效（该消费同时消除 §1.4 的一条 unused 警告）。远端命令恒为最后一个 argv 单元素。
4. **TERM 传递**：`cmd.env("TERM", "xterm-256color")` 对远程分支同样设置（本地分支 `terminal.rs:76-78` 已设；ssh 会把本地 TERM 转发给远端，保证 xterm.js 渲染语义一致）。
5. **stdout base64 帧协议不变**：`term://output`/`term://exit` 事件、`createTerminalOutputRouter` 前置订阅（`TerminalPanel.vue:84-96`）、exit 通知（`terminal.rs:113-120`）全部照旧。
6. Windows 下 portable-pty 自带隐藏窗口语义，无需 `CREATE_NO_WINDOW`。

### 3.4 前端守卫解除

- `src/components/ChatView.vue:260-262`：`sidebar.terminal` 快捷键守卫 `if (!isSshProject(props.project))` 移除（`ChatView.vue:258` 的 files 守卫**保留**，文件工具远程 P2 仍不可用）。
- `src/components/terminal/TerminalPanel.vue:169-173`：`term_create` 调用增加 `sshConnectionId`——远程项目时传 `resolveSshConnectionId(props.project, config.sshConnections ?? [])`（无连接时不发命令，toast `ssh.sessionHistoryUnavailable` 级别的既有连接缺失文案 `ssh.gitUnavailable` 不适用，改用 `backendErrors.sshConnectionMissing` 经 `translateError` 渲染）；本地项目传 `undefined`。
- 终端失败路径：`term_create` 的 coded error 由现有 catch（`TerminalPanel.vue:190`）改为 toast 展示（`translateError`），不再只 `console.error`。

---

## 4. 远程信任主方案

### 4.1 设计：上传 `pi_data.mjs`（内容走 stdin、原子落盘）+ 每次调用一个 exec

> **P2 实现修订（2026-10-06，WSL 实机验证）**：本节「请求 JSON 走 ssh stdin」依赖
> 脚本内命令能继承 ssh 会话 stdin。实测发现 P1 契约 §3.4 初版帧格式（脚本经
> `echo <B64> | base64 -d | /bin/sh` 管道投递）下，脚本内命令的 stdin 是 base64
> 管道，ssh stdin 数据被静默丢失。已按 P1 契约 §3.4 的 P2 修订将帧格式改为
> `eval "$(echo <B64> | base64 -d)"`（脚本在外层 shell 内展开执行），本节设计
> （mjs 走 stdin 上传、请求 JSON 走 ssh stdin、响应 JSON 走 stdout）原样成立。

与任务书的两处明确偏差，先说清：

- **不用 `exec_stream` 常驻流**：`pi_data.mjs` 是一次性程序——`readFileSync(0)` 读整个 stdin、输出一个 JSON 即退出（`resources/pi_data.mjs:7,79`），不支持循环处理多个 op。常驻流需要改 mjs（破坏与本地 `pi_data.rs:16-23` 的同构），故信任的每次 status/save 都是**一次独立 ssh exec**：`node --input-type=module --eval "$(cat ~/.pix/pi_data.mjs)" '<SDK_DIST>'`，请求 JSON 走 ssh stdin，响应 JSON 走 stdout——即"stdin/stdout 走既有 JSON op 协议"，协议面与本地完全一致。
- **上传不必走 SFTP/进度**：mjs 约 4KB 且内容编译期内嵌（`include_str!`，`pi_data.rs:19`），一次 exec 上传即可。

流程（实现于 `commands/ssh.rs`，脚本常量进 `ssh/payload.rs`）：

**第 1 步：上传（每连接进程内一次，带内容指纹跳过重复上传）**

新增传输函数（`ssh/transport.rs`）：

```rust
/// 带 stdin 数据的一次性 exec（上传 pi_data.mjs / 投递信任请求 JSON）。
pub async fn ssh_exec_with_stdin(
    endpoint: &SshEndpoint,
    script: &str,
    stdin_data: &[u8],
    timeout: Duration,
) -> Result<ExecOutput, SshError>
```

实现照抄 `ssh_exec`（`transport.rs:222-275`），仅多一步把 `stdin_data` 写入 child stdin 后 drop（EOF 结束远端 `cat`）。上传脚本（常量 `TRUST_UPLOAD_SCRIPT`）：

```sh
mkdir -p "$HOME/.pix" || exit 96
cat > "$HOME/.pix/pi_data.mjs.pixtmp" || exit 95
mv "$HOME/.pix/pi_data.mjs.pixtmp" "$HOME/.pix/pi_data.mjs" || exit 96
echo "PIX_TRUST_UPLOAD_DONE"
```

- 原子落盘：同目录临时文件 + `mv`（远端 POSIX rename 语义），远端并发/中断不留半个文件。
- `cat` 的 stdin 即 mjs 字节流（**不走 base64**——stdin 是二进制安全管道，无需转码；内层脚本经 wrap_payload 投递，内容只出现在 stdin）。
- 退出码约定追加：95=写临时文件失败、96=目录创建/改名失败（与 90/92/93 同族，归 `sshRemoteFailed`）。
- 跳过策略：`commands/ssh.rs` 持有 `static UPLOADED: Mutex<HashSet<String>>`（键 = 连接 id；mjs 内容随编译期常量固定，进程内无需再比对哈希）；上传失败不写入集合，下次调用重试。

**第 2 步：SDK dist 发现 + 执行（每次调用一次 exec）**

合并 P1 契约 §4.1 的发现脚本与执行为单脚本（常量 `TRUST_RUN_SCRIPT`，`<MJS_PATH>`/`<SDK_DIST 占位由发现逻辑内联>`）：

```sh
PI_BIN=$(command -v pi) || exit 92
REAL=$(readlink -f "$PI_BIN"); DIR=$(dirname "$REAL")
for i in 1 2 3 4 5; do
  DIR=$(dirname "$DIR")
  if [ -f "$DIR/core/settings-manager.js" ] && [ -f "$DIR/config.js" ]; then
    node --input-type=module --eval "$(cat "$HOME/.pix/pi_data.mjs")" "$DIR"
    exit $?
  fi
done
exit 93
```

- `--eval "$(cat …)"` + `argv[1]=dist` 与本地 `pi_data.rs:16-23` 的调用形态逐字一致（mjs 依赖 `process.argv[1]` 为 dist，`pi_data.mjs:5`）。
- 退出码 92 → `sshRemotePiMissing`（复用）、93 → 新键 `sshSdkDistMissing`。
- 请求 JSON（`{"op":"trust_status","project":…}` / `{"op":"trust_save",…}`）经 `ssh_exec_with_stdin` 的 stdin 投递；stdout 解析容忍非 JSON 行（banner/motd，取最后一个可解析 JSON 对象，复用 §3.8 容忍语义）。
- 超时 30s（node 冷启动）。

### 4.2 命令签名（P1 契约 §4.1 冻结名，本此落地）

```rust
#[tauri::command]
pub async fn ssh_trust_status(
    ssh_connection_id: String,
    project: String,
) -> Result<serde_json::Value, String>

#[tauri::command]
pub async fn ssh_trust_save(
    ssh_connection_id: String,
    project: String,
    trusted: bool,
    trust_parent: bool,
) -> Result<serde_json::Value, String>
```

- 返回形状与本地 `trust_status`/`trust_save`（`commands/pi.rs:22-33` → `trust.rs:22-33` → `pi_data.mjs:10-31`）**逐字段一致**：`{ projectPath, parentPath, hasTrustRequiringResources, decision, needsDecision, policy }`（save 返回同形状的决策后状态）。前端 `TrustStatus` 类型（`src/api/client/config.ts:6-12`）零改动。
- 注意 `projectPath` 是远端 `realpathSync` 后的路径（`pi_data.mjs:13`），可能带 `.png` 式符号链接归一差异；前端信任弹窗只展示不改身份，无回绑动作（身份回绑归 §1.1 的 `pi://sshPathBound` 管）。
- 校验链同 §2.1（parse/mismatch/notFound/missing）。
- 新 coded error 键：`sshSdkDistMissing`、`sshTrustFailed`（node 执行非零且非 92/93）、`sshRemoteFailed`（上传/标记缺失等）——文案见 §5.3。

### 4.3 前端分流（三处，全部改"跳过"为"调远程命令"）

1. `src/lib/workspaceStartup.ts:167-173`（新建会话前信任决策）与 `decideWorkspaceTrust`（`workspaceStartup.ts:99-107`）：`isSshProject(path)` 时调 `sshTrustStatus(path, connectionId)`/`sshTrustSave(...)`（连接 id 用 `sshConnectionIdFor`，`workspaceStartup.ts:70-75`）；本地照旧。
2. `src/composables/useSessionOpening.ts:105`：`const status = isSshProject(dir) ? await sshTrustStatus(...) : await trustStatus(dir)`（连接缺失时降级为 null 并 toast）。
3. `src/composables/useSessionOpening.ts:152-155`（分屏恢复前信任检查）：同上分流。

信任弹窗组件（`TrustDialog`，`App.vue:611-620`）与 `workspaceTrust` 状态机复用不变——它只消费 `TrustStatus` 与回调，不感知传输差异。

---

## 5. 主机指纹错误归类

### 5.1 归类（实机发现，wsl-test-env.md 待办第 1 条）

`BatchMode` 下 known_hosts 无记录报 `Host key verification failed.`、指纹变更报 `REMOTE HOST IDENTIFICATION HAS CHANGED!`，当前都被 `classify_failure`（`transport.rs:155-179`） lump 进 `Auth`，用户看到的"检查密钥或 agent"文案无法指导操作。P2 改法（`ssh/transport.rs`，后端会话与信任 agent）：

1. `SshErrorKind` 枚举（`transport.rs:57-68`）新增变体 `HostKey`（放在 `Auth` 前，语义上是其细分）。
2. `classify_failure` 在 auth 关键词判定**之前**先判（exit 255 或任意码 + stderr 小写匹配）：
   - 含 `remote host identification has changed` → `HostKey`（指纹变更）；
   - 含 `host key verification failed` → `HostKey`（无记录/未确认）。
3. 消费点同步：
   - `error_kind_label`（`commands/ssh.rs:53-61`）→ `"hostKey"`（`SshProbeResult.errorKind` 枚举值扩展，`src/api/client/ssh.ts:35` 的 `SshErrorKind` 联合类型加 `"hostKey"`）；
   - `ssh_error_coded`（`commands/ssh.rs:32-51`）→ 见 §5.3 编码；
   - `ssh_exit_error`（`rpc/child.rs:626-657`）的 `classify_failure` 分支同样落这两个 coded error。
4. `wsl-test-env.md` 待办第 2 条（ssh-keyscan 偶发抓不到指纹）不阻塞：PiX 不做指纹采集，错误文案引导用户手动 ssh 一次。

### 5.2 coded error 键（冻结）

| 键 | 触发 | zh-CN | en |
| --- | --- | --- | --- |
| `sshHostKeyUnverified` | `Host key verification failed` | `主机指纹尚未确认。请先在终端手动 ssh 一次该主机并确认指纹，然后重试。` | `The host key has not been verified yet. SSH into the host manually once in a terminal to confirm its fingerprint, then retry.` |
| `sshHostKeyChanged` | `REMOTE HOST IDENTIFICATION HAS CHANGED` | `远程主机指纹与 known_hosts 记录不一致，可能是主机重装或中间人攻击。核实后在 ~/.ssh/known_hosts 中删除该主机条目再重试。` | `The remote host fingerprint no longer matches ~/.ssh/known_hosts — the host may have been reinstalled, or this could be a man-in-the-middle attack. Verify it, remove the host's entry from ~/.ssh/known_hosts, then retry.` |

### 5.3 P2 其余新增键（汇总，`backendErrors` 命名空间 + `ssh` UI 命名空间，zh-CN/en 同步，并更新 `tests/backend-errors.test.ts`）

| 键 | 命名空间 | zh-CN |
| --- | --- | --- |
| `sshHostKeyUnverified` / `sshHostKeyChanged` | backendErrors | 见 §5.2 |
| `sshSdkDistMissing` | backendErrors | `未找到远程 pi 的 SDK 安装目录，无法执行远程信任操作。请确认远程主机已完整安装 pi。` |
| `sshTrustFailed` | backendErrors | `远程信任操作失败: {detail}` |
| `sshRemoteFailed` | backendErrors | `远程操作失败: {detail}` |
| `ssh.remoteSessionsEmpty` | ssh（UI） | `远程主机上暂无会话记录` |
| `ssh.sessionsRefresh` | ssh（UI） | `刷新远程会话` |

en 文案由前端 agent 按语义对齐翻译；键集以上表为冻结清单，实现时不得增删键名。

---

## 6. 实机集成测试约定

统一约定（全部用例遵守）：

- Rust 测试加 `#[ignore]`，函数名含 `ssh_real`（模块路径或函数名含 `ssh_real` 均可被过滤器命中）：`cargo test ssh_real -- --ignored` 只跑实机组，普通 `cargo test` / `cargo check` 自动跳过。
- 环境变量**直接沿用，不得改名**；用例入口统一经辅助函数读取，任一缺失则 `eprintln!` 后 `return`（对齐 `find_test_program` 跳过模式，`transport.rs:362-379`）：

  | 变量 | 值 |
  | --- | --- |
  | `PIX_SSH_TEST_HOST` | `localhost` |
  | `PIX_SSH_TEST_PORT` | `2222` |
  | `PIX_SSH_TEST_USER` | `tzdxf` |
  | `PIX_SSH_TEST_KEY_PATH` | `C:/Users/TZDXF/.ssh/pix_wsl_test` |
  | `PIX_SSH_TEST_PROJECT` | `/home/tzdxf/pix-ssh-demo` |

- 实机测试只允许访问 WSL 测试环境（wsl-test-env.md），禁止其它真实网络/SSH；写入远端的测试数据用 `PIX_TEST_` 前缀并在用例尾部清理。
- 前端（Vitest）不做实机测试，用 mock 覆盖（见 §2.4/§3.4/§4.3 的 tests 条目）。

各实现者应交付的实机用例：

**后端会话与信任 agent（`src-tauri/src/ssh_sessions.rs`、`commands/ssh.rs` 测试模块）**

| # | 用例 | 断言 |
| --- | --- | --- |
| S-R1 | realpath 回绑：经 exec 在远端 `ln -sfn /home/tzdxf/pix-ssh-demo /home/tzdxf/pix-ssh-alias`，对 `ssh://…/home/tzdxf/pix-ssh-alias` 走 `rebind_remote_path` | 收到回绑事件，`path == PIX_SSH_TEST_PROJECT`，重建 URI 的 host/port/user 不变 |
| S-R2 | `ssh_sessions`：对 `PIX_SSH_TEST_PROJECT` 调用 | 返回 `Vec<SessionMeta>`；在远端造一个临时 jsonl（头部 `{"type":"session","cwd":"<PROJECT>",…}`）后能扫到，删除后消失；cwd 为别名路径的会话因 `PIX_SESSION_CWD` 物理路径兜底仍被收录 |
| S-R3 | `ssh_trust_status`：对 `PIX_SSH_TEST_PROJECT` | 返回形状含全部 6 字段；`projectPath` 为远端绝对路径 |
| S-R4 | `ssh_trust_save` 往返：save(trusted=true) → status.decision==true → save(trusted=false) → decision==false | 远端 `~/.pi/agent/trust.json` 落盘（用例后还原） |
| S-R5 | mjs 上传幂等：连续两次 trust_status | 第二次不重复上传（可通过远端文件 mtime 不变或上传计数断言）；上传后远端 `~/.pix/pi_data.mjs` 与本地 `resources/pi_data.mjs` 字节一致 |
| S-R6 | 退出码映射：dist 发现失败场景（临时把远端脚本里的判断条件改假不可行，改为对 `HOME` 指向的空目录执行 `TRUST_RUN_SCRIPT`） | exit 93 → coded error `sshSdkDistMissing` |

**终端 agent（`terminal.rs` 测试模块）**

| # | 用例 | 断言 |
| --- | --- | --- |
| T-R1 | `ssh -tt` 开终端：term_create 远程分支连 WSL，写 `echo PIX_TEST_<uuid>\n` | `term://output` 帧（base64 解码）在超时内含该串与提示符 |
| T-R2 | resize 生效：term_resize 后 `stty size` | 输出反映新 cols/rows（SIGWINCH 转发验证） |
| T-R3 | 关闭：term_kill | 本地 ssh 进程退出，`term://exit` 事件到达；远端无残留 shell（经 exec `pgrep -f "PIX_TEST_<uuid>"` 验证为空） |

**主机指纹归类**：无法在测试环境安全构造（会污染 known_hosts），以 `classify_failure`/`ssh_exit_error` 的纯函数单测为准（构造两段真实 stderr 文本），实机不测——报告中注明。

---

## 7. 文件归属边界（三方并行，零冲突）

### 7.1 后端会话与信任 agent

**独占**：

- 新建：`src-tauri/src/ssh_sessions.rs`（§2 命令 + 解析纯函数 + 单测）
- `src-tauri/src/ssh/mod.rs`（§1.4 re-export 整理 + 新增导出）
- `src-tauri/src/ssh/transport.rs`（`SshErrorKind::HostKey`、`classify_failure` 扩展、`ssh_exec_with_stdin`、`build_ssh_args_interactive`、`#[allow(dead_code)]` 标注）
- `src-tauri/src/ssh/payload.rs`（`SESSIONS_SCRIPT`、`TRUST_UPLOAD_SCRIPT`、`TRUST_RUN_SCRIPT` 常量 + 单测）
- `src-tauri/src/ssh/identity.rs`（仅 §1.4 的 `#[allow(dead_code)]` 标注）
- `src-tauri/src/commands/ssh.rs`（`ssh_trust_status`/`ssh_trust_save` + 上传编排 + `HostKey` 归类消费）
- `src-tauri/src/commands/pi.rs`（不改 `spawn_remote` 主体；仅当信任/会话命令需要共享校验时的最小改动，改动范围不得触碰本地分支）
- `src-tauri/src/commands/mod.rs`（re-export）
- `src-tauri/src/rpc/child.rs`（§1.1 回绑门槛删除 + §5.1 `ssh_exit_error` HostKey 分支）
- `src-tauri/src/lib.rs`（`generate_handler` 注册 + `mod ssh_sessions;` 声明）——**命令注册只允许本 agent 改动**

### 7.2 终端 agent

**独占**：

- `src-tauri/src/terminal.rs`（term_create 远程分支 + 校验 helper + 单测；`PIX_SSH_COMMAND` mock 注入的全链路单测）

**接口依赖**：消费 `ssh::{SshEndpoint, posix_quote, wrap_payload, ssh_program_parts, build_ssh_args_interactive, parse_ssh_uri}`（前四个已存在，最后一个由会话与信任 agent 按本文 §3.3 冻结签名交付；终端 agent 可先按签名 stub 并行）。**不得改 `src-tauri/src/ssh/` 与 `lib.rs`。**

### 7.3 前端 agent

**独占**：

- 新建：`src/api/client/ssh.ts` 内追加 `sshSessions`/`sshTrustStatus`/`sshTrustSave` 包装（§2.4/§4.2）、`tests/ssh-sessions-ui.test.ts`、`tests/ssh-terminal-ui.test.ts`（守卫解除与参数透传）
- 修改：`src/api/client/ssh.ts`（`SshErrorKind` 加 `"hostKey"`）、`src/stores/workspace.ts`（refresh 分流 + `remoteSessionsLoading`）、`src/lib/workspaceStartup.ts`（§4.3 第 1 处）、`src/composables/useSessionOpening.ts`（§4.3 第 2/3 处）、`src/components/terminal/TerminalPanel.vue`（§3.4）、`src/components/ChatView.vue`（终端守卫移除）、`src/components/workspace/sidebar/SidebarSessionList.vue` 与 `src/components/WorkspaceSidebar.vue`（§2.4 UI）、`src/i18n/locales/zh-CN.ts` 与 `en.ts`（§5.2/§5.3 全部新键）、`tests/backend-errors.test.ts`（新键同步）

**不得改**：`src-tauri/` 全部；`src/lib/ssh.ts`（身份模型冻结，P2 无改动）。

### 7.4 共享契约点（改动须先改本文档）

- `ssh_sessions`/`ssh_trust_status`/`ssh_trust_save` 命令名、参数名（camelCase）与返回形状（§2.1/§4.2）
- `term_create` 的 `sshConnectionId` 参数名与分流判据（§3.2）
- `SESSIONS_SCRIPT`/`TRUST_UPLOAD_SCRIPT`/`TRUST_RUN_SCRIPT` 脚本文本与标签行协议（§2.2/§4.1）
- `SshErrorKind::HostKey`、errorKind `"hostKey"` 值与 §5.2/§5.3 coded error 键集
- `build_ssh_args_interactive` 签名与参数序列（§3.3 第 1 条）
- `pi://sshPathBound` 事件名/payload（P1 §3.8 冻结，P2 仅扩大触发面，§1.1）
- 边界纪律：三方各自跑针对性单测（`pnpm -C <worktree> exec vitest run tests/ssh-*.test.ts`；`cargo test ssh::` / `cargo check`）；实机用例另跑 `cargo test ssh_real -- --ignored`（需 WSL 环境就绪，见 wsl-test-env.md）；合入门禁统一执行。

---

## 8. 契约级验收清单（P2 完成定义）

1. `cargo check` 零 warning（§1.4 的 9 条全部消除或有 `#[allow]` 注释背书）；`cargo test ssh::`、`cargo test ssh_real -- --ignored`（WSL 就绪时）通过。
2. 远程项目侧栏列出远端 `~/.pi/agent/sessions` 中 cwd 匹配的会话（标题/时间正确，preview 空），刷新按钮与空态符合 §2.4；本地项目会话列表行为零变化。
3. 远程项目可打开交互终端（`ssh -tt`），resize 与输入输出正常，`term://output` base64 帧协议不变；本地终端行为零变化。
4. 远程项目新建/恢复会话按 §4.3 弹出信任决策，`TrustDialog` 复用无改动；`ssh_trust_save` 的结果在远端 `trust.json` 生效且对后续 spawn 生效。
5. known_hosts 无记录/指纹变更两种场景得到 §5.2 的可操作文案（纯函数单测覆盖文本匹配）。
6. `pi://sshPathBound` 在新建与重连的远程 spawn 上均按 §1.1 生效；别名路径项目在列表与 lastProject 中回绑为物理路径。
