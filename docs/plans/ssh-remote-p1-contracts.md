# SSH 远程项目：P1 接口契约

> 状态：v1（契约冻结稿，供三方并行开发）
> 上游规划：`docs/plans/ssh-remote-project.md`（下称"规划文档"）
> 契约内容以本文档为准；如与规划文档冲突，以本文档修订并同步规划文档。
>
> 立契约前通读的现有代码（引用格式 `path:line`，均相对仓库根）：
> - 后端：`src-tauri/src/rpc.rs`（进程池/请求关联）、`src-tauri/src/rpc/child.rs`（spawn/stdio 桥接/kill）、`src-tauri/src/commands/pi.rs`（rpc_spawn 命令）、`src-tauri/src/pi_locate.rs`、`src-tauri/src/trust.rs`、`src-tauri/src/pi_data.rs`、`src-tauri/src/sessions.rs`、`src-tauri/src/commands/config.rs`（AppConfig 读写）、`src-tauri/src/data_dir.rs`、`src-tauri/src/builtin_extensions.rs`、`src-tauri/resources/pi_data.mjs`
> - 前端：`src/api/transport.ts`、`src/api/client/process.ts`、`src/api/client/config.ts`、`src/stores/workspace.ts`、`src/lib/workspaceStartup.ts`、`src/lib/paths.ts`
> - 依赖事实：`base64 = "0.23"` 已在 `src-tauri/Cargo.toml:44`；i18n 为 `src/i18n/locales/zh-CN.ts` 与 `en.ts`；命令注册在 `src-tauri/src/lib.rs:90` 的 `generate_handler`。

---

## 1. 身份模型

### 1.1 两种标识

| 标识 | 格式 | 用途 |
| --- | --- | --- |
| **展示 URI** | `ssh://[user@]host[:port]/abs/posix/path` | 前端项目列表、`config.lastProject`、`rpc_spawn` 的 `project` 参数、UI 展示、localStorage（`pix.recentProjects` 等） |
| **内部身份键** | `remote:ssh:<host>:<port>:<user>:<posixPath>` | 日志、后端内部匹配（连接配置 ↔ 项目 URI 校验）、未来持久化快照。沿用 ZCode 格式（规划文档 §5） |

**禁止任何一方手拼这两种字符串**，必须走下述构造/解析函数。

### 1.2 归一化与解析规则（TS / Rust 两侧语义完全一致）

1. URI 必须以字面 `ssh://` 开头（小写），否则不是远程项目（本地路径如 `C:/code`、`/home/u` 一律返回"非远程"）。
2. authority = `[user@]host[:port]`：
   - user 可为空（整体省略）。user 允许字符：字母、数字、`.`、`_`、`-`；不得含 `@`、`:`、空白；**大小写保留**（很多系统用户名区分大小写）。空 user（`ssh://@host/…`）非法。
   - host 不得含 `:`（**P1 不支持 IPv6 字面量**）、`/`、`@`、空白；**归一化为小写**。
   - port 为 1–65535 十进制；缺省 22；去前导零（`:022` → 22）。
3. path 必须以 `/` 开头（绝对 POSIX 路径），否则解析失败。归一化：
   - `\` → `/`；
   - 连续 `/` 折叠为单个 `/`；
   - 去除尾部 `/`，但根路径 `/` 保留为 `/`；
   - 删除 `.` 空段；**含 `..` 段直接拒绝**（P1 不做词法上推；符号链接别名由重连时远端 `realpath` 回绑解决，见 §3.8）；
   - **路径中不得出现 `:`**（保证身份键无歧义）；允许空格，拒绝 `\n`、`\r`、`\t`、`\0`。
4. 展示 URI 重建：`port == 22 && user == null` → `ssh://host/path`；否则按 `ssh://user@host:port/path` / `ssh://host:port/path` 还原（path 用归一化后的值）。
5. 身份键：`"remote:ssh:" + host(小写) + ":" + port(十进制无前导零) + ":" + user(可为空串) + ":" + path(归一化后)`。host/user/path 三个字段均不得含 `:`（构造时校验，违反即报错）。

### 1.3 前端实现（TypeScript，`src/lib/ssh.ts`，新建）

```ts
export interface SshTarget {
  host: string          // 归一化小写
  port: number          // 1–65535，缺省 22
  user: string | null   // null 表示缺省
  path: string          // 归一化后的绝对 POSIX 路径
}

export function isSshUri(value: string): boolean
export function parseSshUri(uri: string): SshTarget | null        // 非法/非 ssh 返回 null
export function buildSshUri(target: SshTarget): string            // 字段非法抛 Error
export function sshIdentityKey(target: SshTarget): string         // 字段非法抛 Error
export function parseSshIdentityKey(key: string): SshTarget | null
export function normalizeSshPath(path: string): string | null     // 仅路径归一化；含 ../: 等返回 null
/** UI 守卫统一入口：项目 cwd 是否为远程项目（= isSshUri）。 */
export const isSshProject = isSshUri
```

### 1.4 后端实现（Rust，`src-tauri/src/ssh/identity.rs`，新建）

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshTarget {
    pub host: String,           // 归一化小写
    pub port: u16,              // 缺省 22
    pub user: Option<String>,   // None 表示缺省
    pub path: String,           // 归一化后的绝对 POSIX 路径
}

pub fn is_ssh_uri(value: &str) -> bool;
pub fn parse_ssh_uri(uri: &str) -> Option<SshTarget>;
pub fn build_ssh_uri(target: &SshTarget) -> Result<String, String>;
pub fn identity_key(target: &SshTarget) -> Result<String, String>;
pub fn parse_identity_key(key: &str) -> Option<SshTarget>;
pub fn normalize_ssh_path(path: &str) -> Result<String, String>; // Err: 相对路径/../: 等
```

### 1.5 典型测试用例（两侧都必须通过；TS → `tests/ssh-identity.test.ts`，Rust → `identity.rs` 的 `#[cfg(test)]`）

| # | 输入 | 期望 |
| --- | --- | --- |
| 1 | `parse("ssh://dev@host.example.com:2222/home/dev/proj")` | `{host:"host.example.com", port:2222, user:"dev", path:"/home/dev/proj"}`；`build` round-trip 得到原串；身份键 `remote:ssh:host.example.com:2222:dev:/home/dev/proj` |
| 2 | `parse("ssh://Host.Example.COM/Proj")` | host 归一化为 `host.example.com`，port=22，user=null；**path 大小写保留** `/Proj`（POSIX 区分大小写）；身份键 `remote:ssh:host.example.com:22::/Proj`（user 空串）；展示重建 `ssh://host.example.com/Proj` |
| 3 | `parse("ssh://dev@host/a/b///")` → path `/a/b`；`parse("ssh://dev@host/")` → path `/`；`normalizeSshPath("\\home\\dev")` → `/home/dev` |
| 4 | `parse("ssh://dev@host/./a/./b")` → path `/a/b`；`parse("ssh://dev@host/../etc")` → `null` |
| 5 | 非法输入全部 → `null`：`"ssh://host"`（无路径）、`"ssh:///path"`（空 host）、`"https://host/x"`、`"C:/code"`、`"/home/u"`、`"ssh://host:70000/x"`、`"ssh://@host/x"`、`"ssh://host:99999/x"` |
| 6 | `parse("ssh://host:022/x")` → port=22；`parse("ssh://Dev.Name@host/a:x")` → `null`（path 含 `:`）；`parse("ssh://Dev.Name@host/x")` → user=`"Dev.Name"`（大小写与点保留） |
| 7 | 身份键互逆：对任意合法 `SshTarget`，`parseSshIdentityKey(sshIdentityKey(t))` 深等于 `t`；`parse_identity_key("remote:ssh:host:22:dev:/a")` → `{host:"host",port:22,user:"dev",path:"/a"}`；`parse_identity_key("remote:ssh:host:22:dev:relative")` → `null` |
| 8 | 非远程判定：`isSshUri("C:/code")`、`isSshUri("/home/u")`、`isSshUri("")` 均为 `false`——现有本地项目零影响 |

---

## 2. SSH 连接配置与 Tauri 命令

### 2.1 存储位置与 schema

沿用 `~/.pix/config.json` 的现有读写模式：`AppConfig` 结构体追加字段（`src-tauri/src/commands/config.rs:27`），serde `rename = "sshConnections"` + `default` + `skip_serializing_if = "Option::is_none"`，写入继续走 `write_config`（原子写，`config.rs:117-128`）。**凭据不落盘**：P1 认证仅 ssh key / ssh-agent（`BatchMode=yes`），只存私钥**路径**，无密码/口令字段。

```jsonc
// ~/.pix/config.json 新增字段（与现有字段平级）
"sshConnections": [
  {
    "id": "ssh-9f1c2a…",             // 必填唯一；后端生成 "ssh-" + UUID v4
    "name": "office server",         // 必填非空展示名
    "host": "host.example.com",      // 必填，存归一化小写
    "port": 22,                      // 必填，1–65535
    "user": "dev",                   // 可选，null 表示缺省
    "keyPath": "~/.ssh/id_ed25519",  // 可选；支持 ~ 前缀（后端展开规则同 data_dir::expand_home）
    "createdAt": "2026-10-05T08:00:00.000Z",
    "lastUsedAt": null,              // 上次成功 spawn/probe 时间
    "lastProbe": {                   // 可选；仅 UI 展示缓存，spawn 不依赖（见 §3.6）
      "probedAt": "2026-10-05T08:00:00.000Z",
      "ok": true,
      "uname": "Linux", "arch": "x86_64",
      "nodeVersion": "v22.10.0", "piVersion": "0.9.3"
    }
  }
]
```

前端对应类型（`src/api/client/ssh.ts`，新建）：

```ts
export interface SshProbeInfo {
  probedAt: string; ok: boolean
  uname: string | null; arch: string | null; nodeVersion: string | null; piVersion: string | null
}
export interface SshConnection {
  id: string; name: string; host: string; port: number
  user: string | null; keyPath: string | null
  createdAt: string; lastUsedAt: string | null; lastProbe: SshProbeInfo | null
}
export interface SshConnectionInput {
  id?: string; name: string; host: string
  port?: number; user?: string | null; keyPath?: string | null
}
export type SshErrorKind = "auth" | "network" | "sshMissing" | "remote" | "timeout"
export interface SshProbeResult {
  ok: boolean
  uname: string | null; arch: string | null
  nodeVersion: string | null; piVersion: string | null
  nodeFound: boolean; piFound: boolean
  errorKind: SshErrorKind | null
  /** 已按 i18n 键归类的 coded error，前端用 translateError 渲染 */
  error: string | null
}
```

### 2.2 新增 Tauri 命令（命令实现 `src-tauri/src/commands/ssh.rs`，注册进 `lib.rs`）

| 命令名 | 参数（前端 camelCase） | 返回 | 说明 |
| --- | --- | --- | --- |
| `ssh_connection_list` | 无 | `Result<SshConnection[], String>` | 按 createdAt 升序返回全部连接配置 |
| `ssh_connection_save` | `connection: SshConnectionInput` | `Result<SshConnection, String>` | 按 `id` upsert；无 id 生成 `"ssh-" + UUID`；校验 host/port（走 identity 归一化规则），name 去空格后非空；写回 config.json；新增时补 `createdAt` |
| `ssh_connection_delete` | `id: string` | `Result<(), String>` | 删除；id 不存在也返回 Ok（幂等） |
| `ssh_connection_probe` | `id: string` | `Result<SshProbeResult, String>` | 探测已保存连接；成功时把 `lastProbe`/`lastUsedAt` 写回配置；连接不存在 → coded error `sshConnectionNotFound` |
| `ssh_probe_target` | `host: string, port: number \| null, user: string \| null, keyPath: string \| null` | `Result<SshProbeResult, String>` | 保存前的"测试连接"：参数即测，不写配置 |

Rust 侧签名（`commands/ssh.rs`）：

```rust
#[tauri::command] pub async fn ssh_connection_list(app: AppHandle) -> Result<Vec<SshConnection>, String>;
#[tauri::command] pub async fn ssh_connection_save(app: AppHandle, connection: SshConnectionInput) -> Result<SshConnection, String>;
#[tauri::command] pub async fn ssh_connection_delete(app: AppHandle, id: String) -> Result<(), String>;
#[tauri::command] pub async fn ssh_connection_probe(app: AppHandle, id: String) -> Result<SshProbeResult, String>;
#[tauri::command] pub async fn ssh_probe_target(host: String, port: Option<u16>, user: Option<String>, key_path: Option<String>) -> Result<SshProbeResult, String>;
```

### 2.3 probe：一次 exec、标签行协议

probe 合并为**单次 SSH exec**（一次 RTT），payload 经 §3.4 的 base64 通道投递，脚本：

```sh
echo "UNAME_S=$(uname -s 2>/dev/null)"
echo "UNAME_M=$(uname -m 2>/dev/null)"
if command -v node >/dev/null 2>&1; then echo "NODE_V=$(node -v 2>/dev/null)"; fi
PI_BIN=$(command -v pi 2>/dev/null)
echo "PI_BIN=$PI_BIN"
if [ -n "$PI_BIN" ]; then echo "PI_V=$("$PI_BIN" --version 2>/dev/null | head -n 1)"; fi
echo "PIX_PROBE_DONE"
```

解析规则：stdout 逐行匹配 `^([A-Z_]+)=(.*)$`；读到 `PIX_PROBE_DONE` 才算完成（缺失 + 超时 → `timeout`）。`nodeFound = NODE_V 存在`、`piFound = PI_BIN 非空`；`UNAME_S` 为 `Darwin` 时 arch 取 `uname -m` 原值即可。**probe 结果缓存仅用于 UI 展示与错误指引（未装 pi 给安装提示），spawn 不读缓存**（理由见 §3.6）。

### 2.4 错误分类（errorKind）

后端把 ssh 的退出码 + stderr 归一化：

| errorKind | 判定（stderr 关键词 / 退出码） | 前端文案要点（i18n，zh-CN 与 en 同步） |
| --- | --- | --- |
| `sshMissing` | 本机 spawn ssh 失败（程序不存在；Windows 为可选功能） | 引导安装 OpenSSH 客户端 |
| `auth` | exit 255 + `Permission denied` / `Host key verification failed` / `publickey` | 检查密钥/agent；host key 拒绝提示先手动 ssh 一次 |
| `network` | `Could not resolve hostname` / `Connection refused` / `Connection timed out` | 检查 host/port/网络 |
| `timeout` | 30s 内未见 `PIX_PROBE_DONE`（整体超时） | 网络过慢或主机无响应 |
| `remote` | 以上之外的非零退出 / 脚本中止 | 展示 stderr 摘要 |

coded error 键（`pix_error` 风格，与 `errors.rs` 一致）：`sshMissing`、`sshAuthFailed`、`sshConnectFailed`、`sshTimeout`、`sshProbeFailed`、`sshConnectionNotFound`、`sshConnectionMissing`、`sshConnectionMismatch`、`sshWorkspaceUnsupported`、`sshRemotePiMissing`。i18n 新键统一挂 `ssh.*` 命名空间。

---

## 3. `rpc_spawn` 分流

### 3.1 分流方式：**新增可选参数 `sshConnectionId`（选定此方案）**

`commands/pi.rs::rpc_spawn`（现为 `pi.rs:44-78`）改为：

```rust
#[tauri::command]
pub async fn rpc_spawn(
    app: AppHandle,
    state: State<'_, rpc::RpcState>,
    project: String,
    session_file: Option<String>,        // 远程时为远端 POSIX 路径
    runtime_id: Option<String>,
    workspace: Option<WorkspaceContext>,
    ssh_connection_id: Option<String>,   // 新增；前端 camelCase: sshConnectionId
) -> Result<(), String>
```

**分流判据**：`ssh::identity::parse_ssh_uri(&project).is_some()` 即远程分支。

**二选一理由（为什么不选"`project` 为 `ssh://` 时自动按 URI 反查连接配置"）**：
1. 连接细节（port/user/keyPath）不在 URI 里；同一 host:port:user 可能存多个连接配置（不同 keyPath），URI 反查有二义性。
2. 显式参数让命令签名类型化，`sshConnectionId` 即连接的唯一权威来源；`project` 继续承担"项目身份"职责（会话 cwd、展示、localStorage），两者各司其职。
3. 后端仍做一致性校验（见下），两层冗余防止前端错配。

**远程分支步骤**（本地分支行为完全不变）：

1. `parse_ssh_uri(project)` 成功 ⇒ 进入远程分支，**跳过** `validate_project_dir`（本地 `is_dir` 无意义）与 `pi_locate::detect`（本地不需要装 pi）。
2. `ssh_connection_id` 为空 → `Err(pix_error("sshConnectionMissing", …))`。
3. 从 config 读连接；不存在 → `sshConnectionNotFound`。校验连接的 host/port/user 与 project URI 解析结果**完全一致**（port 缺省 22 参与==比较），不一致 → `sshConnectionMismatch`。
4. `workspace.is_some()` → `sshWorkspaceUnsupported`（远程项目 P1 不支持多目录组，前端保证传 null）。
5. 远程目录校验：一次 SSH exec `test -d '<path>'`（base64 通道），exit 1 → coded error `projectDirMissing`（复用现有键与文案），其余非零 → `sshConnectFailed`/`sshTimeout` 按退出码归类。
6. 构造 spawn payload（§3.5）→ `ssh exec_stream` 得到**本地 ssh 子进程**（stdout 即 JSONL）→ 走 §3.7 的桥接。
7. **不注入 builtin extensions**：`builtin_extensions::rpc_args`/`workspace_extension_args` 物化的是本地文件路径（`builtin_extensions.rs:65-88`），对远端无效；远程 extra_args 为空。`PIX_WORKSPACE` 环境变量不设置（它只影响本地 pix-workspace 扩展）。file-change 事件在远程项目 P1 缺失，属可接受裁剪（§5）。

### 3.2 SSH 参数数组（独立参数，绝不拼接 shell）

```rust
// src-tauri/src/ssh/transport.rs
pub struct SshEndpoint { pub host: String, pub port: u16, pub user: Option<String>, pub key_path: Option<String> }

/// 纯函数，单测直接覆盖
pub fn build_ssh_args(endpoint: &SshEndpoint) -> Vec<String>
// ["-o","BatchMode=yes","-o","ServerAliveInterval=15","-o","ServerAliveCountMax=3",
//  "-o","ConnectTimeout=10","-p","22","-i","<keyPath>?"(仅配置时),"<user@host>"]

/// 单次 exec：返回 (stdout, stderr, exit_code)
pub async fn ssh_exec(endpoint: &SshEndpoint, script: &str, timeout: Duration) -> Result<ExecOutput, SshError>
/// 长驻流：返回已 stdio-piped 的本地 ssh Child（kill_on_drop(true)）
pub async fn ssh_exec_stream(endpoint: &SshEndpoint, script: &str) -> Result<tokio::process::Child, SshError>
```

**远端命令包装**（最后一个 argv 元素，**单元素**传递，内部含引号是刻意设计）：

```
/bin/sh -c 'eval "$(echo <B64> | base64 -d)"'
```

- 外层 `/bin/sh -c '<单引号包裹>'` 规避 fish/csh 等非 POSIX 登录 shell（ZCode posixShell 经验，规划文档 §4）。
- B64 字符集仅 `[A-Za-z0-9+/=]`，不含单引号，内层安全。
- **P2 修订（2026-10-06，WSL 实机验证）**：初版帧格式为 `echo <B64> | base64 -d | /bin/sh`（脚本经 stdin 投递）。实测发现该格式下脚本内所有命令继承的 stdin 是 base64 管道而非 ssh 会话 stdin——远端 pi 的 RPC stdin、信任请求 JSON、交互终端 shell 全部会静默读到 EOF。改为 `eval` 在外层 shell 内展开执行后，脚本内命令的 stdin 即 ssh 会话 stdin；命令替换输出不会被二次展开，语义与 stdin 投递等价。
- argv 各元素独立传递给 `tokio::process::Command`（本地不经任何 shell），符合仓库"独立参数"约定；远端两段式 sh 管道是数据流而非本地拼接命令。
- `-p` 恒定传递（含 22），保证参数序列确定、可测。

### 3.3 测试钩子：`PIX_SSH_COMMAND`

`transport.rs` 的 `ssh_program() -> String`：读环境变量 `PIX_SSH_COMMAND`，缺省 `"ssh"`。值可为 `program` 或 `program arg1 arg2 …`（ASCII 空白切分，首段为程序路径，其余作为前置参数插入 args 最前）。单测优先覆盖纯函数 `build_ssh_args` 与 payload 构造；需要端到端时注入 mock 程序（假 ssh 脚本：向 stdout 打印脚本化 JSONL、stderr 打印 `PIX_PI_PID=`），**测试绝不发起真实 SSH 连接**。

### 3.4 base64 payload 约定

- 编码：Rust 侧用已有 `base64 = "0.23"`（`Cargo.toml:44`）标准字母表；TS 侧 `btoa`/`Buffer` 同字母表（仅单测构造用例用）。
- 脚本内嵌的路径/会话文件一律**单引号包裹 + `'\''` 转义**；`--session` 等 extra args 每个独立单引号包裹后追加。
- 帧格式（唯一入口 `transport.rs::wrap_payload(script) -> String`）：

```rust
format!("/bin/sh -c 'echo {} | base64 -d | /bin/sh'", b64(script))
```

### 3.5 远程 spawn payload（精确文本）

```sh
cd '<PROJECT_PATH>' || exit 90
echo "PIX_PI_PID=$$" >&2
PI_BIN=$(command -v pi) || exit 92
exec "$PI_BIN" --mode rpc [--session '<SESSION_FILE>'] [EXTRA_ARGS…]
```

- `$$` 在 `exec` 前取 shell pid，`exec` 替换映像后即 pi 的 pid；写 **stderr**（stdout 必须保持纯 JSONL）。
- 退出码约定：90=cd 失败（目录不存在）、92=远程未装 pi（后端映射 coded error `sshRemotePiMissing`）、93=SDK dist 未找到（信任流程用，§4）。
- extra args：P1 远程恒为空（builtin extensions 不上传，§3.1 第 7 条）；接口预留 `Vec<String>`，逐项单引号包裹。

### 3.6 远程 pi 发现：**spawn 时实时 `command -v pi`，probe 缓存仅 UI**

payload 内第 3 行即发现步骤，与 `cd` 同一次 exec，无额外连接成本。**不采用 probe 缓存路径 spawn**：缓存会过期（用户切 nvm/升级/换安装方式），且 spawn 本身是重操作，实时发现 + 失败退出码 92 给出明确指引更稳。probe 缓存（`lastProbe.piVersion` 等）只驱动连接管理器的状态展示与"未装 pi"提示。

### 3.7 复用 `rpc/child.rs` JSONL 桥接：**最小改动方案**

关键事实：ssh 客户端是**本地 tokio 子进程**，exec 通道把远端 pi 的 stdout 原样中继到本地 ssh 的 stdout——本地视角下与直连 pi 完全同构（规划文档 §2、§3 的同构性结论）。因此：

1. `SessionInner`（`child.rs:19-24`）与 `SessionTransport` **零改动**：stdin writer、pending map、next_id、LF 分帧（`pop_line`，`child.rs:77-85`）、dispatch 全部照旧。
2. `process_spawn`（`child.rs:112-309`）把"构造 Command"一段抽为按模式分支：

```rust
pub(super) enum SpawnProgram {
    LocalPi(PiInfo),                    // 现有逻辑原样（child.rs:131-154）
    Ssh(SshSpawnSpec),                  // Command::new(ssh_program()).args(ssh_args) + payload
}
```

   Ssh 分支：`stdin/stdout/stderr` piped、`kill_on_drop(true)`、**不设 `current_dir`**、Windows 仍加 `CREATE_NO_WINDOW`；其余 reader/writer 装配代码路径共用。
3. `build_spawn_args`（`child.rs:100-108`）保持不变——它产出的 pi 参数在远程分支被内嵌进 payload（§3.5），本地分支照旧。

### 3.8 stdout 非 JSON 行（SSH banner/motd）的容忍层

- **现有桥接层已天然容忍**：`child.rs:247-249` 对 stdout 每行 `serde_json::from_slice` 失败即 `continue`，banner/motd 行被静默丢弃，无需改协议。
- stderr 全量转发到日志与 `pi://stderr` 事件（`child.rs:285-296`），ssh 的 banner/告警走 stderr（OpenSSH 语义），用户可见但不污染 JSONL。
- **新增（后端接入 agent）**：stderr reader 额外识别 `PIX_PI_PID=` 前缀行，写入 `ProcessState.remote_pid: Arc<Mutex<Option<u32>>>`，不向 `pi://stderr` 转发该行。
- 可选增强（P1 只做日志）：stdout 丢弃非 JSON 行时记 debug 日志（截前 200 字节），便于诊断远端 `.bashrc` echo 污染 exec stdout 的场景。
- 路径别名回绑：重连（`--session`）spawn 成功后，后端一次 exec `realpath '<project>'`，与 URI path 不同则发事件 `pi://sshPathBound`（payload `{ runtimeId, project, path }`：`path` 为归一化后的远端路径，`project` 为用 `path` 回绑重建的 `ssh://` 展示 URI），前端监听后用 `project` 调 `workspace.remember` 更新项目列表与当前展示（防 `/home/dev` vs `/dev` 身份漂移；realpath 失败不阻塞 spawn 且不发事件）。

### 3.9 kill / EOF 行为与远程 pid 兜底

- **EOF**：本地 ssh 进程退出（被杀、网络断、`ServerAliveInterval=15 ×3` 保活判定失败）⇒ 本地 stdout EOF ⇒ 现有逻辑照发 `pi://exit`（`child.rs:256-267`），pending 清空。保活参数已内置在 §3.2 args 中，连接死活由 ssh 自身判定。
- **kill（`rpc_kill` / respawn / kill_all）**：`process_kill`（`child.rs:426-433`）扩展为：
  1. bump generation（照旧）；
  2. 读取 `remote_pid`：存在则经 `ssh_exec` 发 `kill -TERM <pid>`（5s 超时，忽略失败仅记日志）；
  3. 杀本地 ssh 子进程：非 Windows `start_kill()`，Windows 照旧 taskkill（杀的是 ssh.exe，无远端语义）。
- **兜底理由**：ssh 通道断开后远端 pi 是否因 stdin EOF 退出**需实测**（规划文档 §7）；remote_pid 兜底保证 respawn/退出应用不留远端孤儿进程占用会话文件。kill 失败全部降级为日志，不阻塞 UI。
- 退出码 90/92 由 stderr/退出码归一化为 coded error 后经 `rpc_spawn` 的 `Err` 返回给前端 toast。

---

## 4. 远程信任

### 4.1 主方案（接口先行，**P2 落地**）：SSH exec 远程跑 `pi_data.mjs`

远端有 node（probe 保证）即可原样复用 `resources/pi_data.mjs` 的 `trust_status`/`trust_save` op（`pi_data.mjs:10-31`）。远程 SDK dist 发现脚本（对齐本地 `pi_locate.rs:295-303` 的 4 级祖先查找）：

```sh
PI_BIN=$(command -v pi) || exit 92
REAL=$(readlink -f "$PI_BIN"); DIR=$(dirname "$REAL")
for i in 1 2 3 4 5; do
  DIR=$(dirname "$DIR")
  if [ -f "$DIR/core/settings-manager.js" ] && [ -f "$DIR/config.js" ]; then
    echo "PIX_SDK_DIST=$DIR"; exit 0
  fi
done
exit 93
```

随后单次 exec 完成调用（mjs 内容与请求 JSON 均走 base64）：

```sh
TMP=$(mktemp) || exit 94
echo <B64_MJS> | base64 -d > "$TMP" || exit 95
echo <B64_REQ> | base64 -d | node --input-type=module --eval "$(cat "$TMP")" '<SDK_DIST>'
RC=$?; rm -f "$TMP"; exit $RC
```

（本地同样以 `--eval` 方式跑，`pi_data.rs:16-23` 依赖 `process.argv[1]` 为 dist；`"$(cat)"` 命令替换在双引号内不会被二次解析。）stdout 解析容忍非 JSON 行（同 §3.8）。

预留命令（P2 实现，命名现在冻结）：`ssh_trust_status(sshConnectionId, project) -> TrustStatus`、`ssh_trust_save(sshConnectionId, project, trusted, trustParent) -> unknown`，返回形状与现有 `trust_status`/`trust_save`（`src/api/client/config.ts:110-113`）完全一致，前端届时零改消耗。

### 4.2 P1 采纳：**降级方案——远程项目不弹信任决策，直接 spawn**

P1 前端对 `isSshProject(project)` 的新项目**跳过** `trustStatus()`/`trustSave()` 调用（`workspaceStartup.ts:146-150` 的信任分支整体绕过），后端远程分支也不做任何信任读写，直接走 §3 的 spawn。

**降级理由**：
1. 一次信任决策 = SDK dist 发现 + pi_data.mjs 执行共 1–2 次额外 exec RTT，且 dist 发现依赖安装形态（npm symlink / brew / 手装），边界多、失败率高，会显著拖慢 P1 首跑体验；
2. `pi_data.mjs` 字段与 pi 版本强耦合，远端 pi 版本可能与本地不同，漂移风险需实测后再固化；
3. 信任语义最终归属 pi：若远程 pi 自身在未信任目录拒绝启动，spawn 会以明确错误浮出（用户照常看到失败原因），P1 不会静默出错；若放行，P1 直接可用——两种结果都可接受，无需先验。

**后续路径**：P2 按上面的 `ssh_trust_status`/`ssh_trust_save` 冻结名称补齐主方案，前端把 `workspaceStartup` 的信任分支按 `isSshProject` 分流到新命令即可，UI 组件（信任弹窗）复用不变。实测任务（P2 前置）：在 Docker sshd harness（规划文档 §8）中验证远程 pi 对未信任目录的行为与 pi_data.mjs 远程兼容性。

---

## 5. P1 范围裁剪（远程会话列表 / 文件浏览 / 终端不在 P1）

所有守卫统一走 `isSshProject(project)`（`src/lib/ssh.ts`），远程项目下：

| 入口 | 位置 | P1 处理 |
| --- | --- | --- |
| 会话历史列表 | `stores/workspace.ts` 的 `refresh()`（`workspace.ts:379-391` 调 `listSessions`，本地扫盘） | 远程项目不调 `listSessions`：`histories[path] = []`；侧栏历史区显示空态文案（i18n `ssh.sessionHistoryUnavailable`，zh-CN/en 同步）。`session_mtime/history/update/delete/duplicate` 等本地文件命令一律不被远程项目触达 |
| 文件浏览/搜索/预览 | `ProjectFiles.vue`、`ProjectFilePreview.vue`、`search_files` 调用点 | 入口隐藏（v-if `!isSshProject`）；若入口不可拆，则禁用 + tooltip（i18n `ssh.fileToolsUnavailable`） |
| 终端 | `components/terminal/TerminalPanel.vue` 与终端打开按钮 | 面板入口隐藏（v-if）；`open_terminal_in_dir` 不被远程项目触达（P2 以 `ssh -tt` 接入，规划文档 P2） |
| Git 面板 / worktree | `ChatView.vue` git props（`ChatView.vue:382`）、`workspace.rememberWorkspace` 的 git 查询（`workspace.ts:360-368`）、`workspaceStartup.ts:129-141` 的 branch/worktree 流 | 远程项目跳过 `workspaceGitInfo`/`prepareWorkspaceGit`（`remember(path)` 直进）；`WorkspaceSelection` 对远程项目必须无 `branch`/`worktree`（前端校验，否则 toast `ssh.gitUnavailable`） |
| checkpoint / revert / rewind | 会话右键菜单等入口 | 入口隐藏；后端这些命令均为本地文件操作，天然不可用于远程路径 |
| HTML 导出 | `export_html` 菜单 | 入口隐藏；后端 `rpc.rs::resolve_export_path`（`rpc.rs:292-303`）对 `ssh://` project 直接原样返回 pi 给的路径（跳过 `dunce::canonicalize`），作为防御性兜底 |
| 信任弹窗 | `workspaceStartup.ts:146-150` | 按 §4.2 跳过 |

裁剪原则：**后端不改这些命令的行为**（本地项目零影响），全部在前端调用侧守卫；每个隐藏点附一句 i18n 说明文案。

---

## 6. 文件归属边界（三方并行，零冲突）

### 6.1 传输层 agent（Rust SSH 基础设施）

**独占**（可新建，不得改本清单之外的后端文件）：
- `src-tauri/src/ssh/mod.rs`（模块声明与 re-export）
- `src-tauri/src/ssh/identity.rs`（§1.4 + 单测）
- `src-tauri/src/ssh/transport.rs`（§3.2–3.5：endpoint/args/payload/exec/exec_stream/ssh_program/错误归一化 + 单测）

**接口依赖**：向接入 agent 暴露 `identity::{SshTarget, parse_ssh_uri, build_ssh_uri, identity_key, normalize_ssh_path}`、`transport::{SshEndpoint, build_ssh_args, ssh_exec, ssh_exec_stream, SshError, ExecOutput, wrap_payload, ssh_program}`。接入 agent 可先按本契约签名 stub 并行。

### 6.2 后端接入 agent（Tauri 命令与 rpc 池）

**独占**：
- `src-tauri/src/commands/ssh.rs`（新建，§2.2 五条命令）
- `src-tauri/src/commands/mod.rs`（re-export）
- `src-tauri/src/commands/config.rs`（`AppConfig` 追加 `ssh_connections` 字段，§2.1）
- `src-tauri/src/commands/pi.rs`（`rpc_spawn` 远程分支，§3.1；`validate_project_dir` 不动）
- `src-tauri/src/rpc.rs`（spawn 转发扩展、`resolve_export_path` 远程兜底，§5）
- `src-tauri/src/rpc/child.rs`（`SpawnProgram` 分支、`remote_pid`、kill 扩展，§3.7/§3.9）
- `src-tauri/src/lib.rs`（`generate_handler` 注册 + `mod ssh;` 声明）

### 6.3 前端 agent

**独占**：
- 新建：`src/lib/ssh.ts`（§1.3）、`src/api/client/ssh.ts`（§2.1 类型 + 五条命令包装）、`tests/ssh-identity.test.ts`、`tests/ssh-ui-guards.test.ts`
- 修改：`src/api/client/process.ts`（`spawnPi` 增加 `sshConnectionId?: string` 形参并透传）、`src/api/client/config.ts`（`AppConfig` 追加 `sshConnections?: SshConnection[]`）、`src/lib/workspaceStartup.ts`（远程分支：跳过 git/trust，§4.2/§5）、`src/stores/workspace.ts`（`refresh`/`rememberWorkspace` 守卫，§5）、`src/components/SettingsPage.vue`（SSH 连接管理 UI）、`src/components/CreateProjectDialog.vue`（远程项目入口：选连接 + 输入远端绝对路径，构造 `ssh://` URI）、`RightSidebar.vue` / `ChatView.vue` / `components/terminal/TerminalPanel.vue`（§5 隐藏点）、`src/i18n/locales/zh-CN.ts` 与 `en.ts`（`ssh.*` 命名空间，两侧同步）

### 6.4 共享契约点（改动须以本文档为唯一权威，改契约先改文档）

- 身份 URI / 身份键格式与归一化规则（§1）
- `AppConfig.sshConnections` 字段名与 schema（§2.1）——Rust struct（接入 agent）与 TS 类型（前端 agent）各写一份，字段名/可选性逐字对齐
- 命令名、参数名（camelCase）、返回类型（§2.2）、coded error 键（§2.4）
- `rpc_spawn` 的 `sshConnectionId` 参数名（§3.1）
- `PIX_SSH_COMMAND` 测试钩子语义（§3.3）
- 边界纪律：传输层 agent 不改 `commands/`、`rpc/`、`lib.rs`；接入 agent 不改 `src-tauri/src/ssh/` 内文件；前端 agent 不改 `src-tauri/`。三方各自运行针对性单测（`pnpm -C <worktree> exec vitest run tests/ssh-*.test.ts`、`cargo test ssh::` / `cargo check`），合入门禁另行统一执行。

---

## 7. 契约级验收清单（P1 完成定义）

1. 身份两侧测试用例表（§1.5 全部 8 条）在 `tests/ssh-identity.test.ts` 与 Rust `identity.rs` 单测中全部通过（mock 环境，无网络）。
2. `build_ssh_args` / `wrap_payload` / spawn payload 构造的纯函数单测通过；`PIX_SSH_COMMAND` 注入 mock 程序后能完成一次假 spawn→JSONL→`pi://exit` 全链路（无真实 SSH）。
3. 五条 `ssh_*` 命令可从浏览器远程页与桌面端一致调用（经 `src/api/transport.ts` 的 invoke 通道，无需新增传输层改动）。
4. 本地项目回归零变化：`rpc_spawn` 不带 `sshConnectionId` 且 project 非 `ssh://` 时行为与现在逐字节一致。
