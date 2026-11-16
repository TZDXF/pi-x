# 远程多后端契约：SSH / WSL / Docker

> 状态：v1（契约冻结稿，供两方并行开发：后端 agent、前端 agent）
> 上游：`docs/plans/ssh-remote-project.md`（规划）、`ssh-remote-p1-contracts.md`（下称"P1 契约"）、`ssh-remote-p2-contracts.md`（下称"P2 契约"）。P1/P2 契约继续有效，本文档只做"多后端泛化"增量；冲突处以本文档为准并回写上游。
> 参考结论（已核实 ZCode 源码，由任务书给定）：ZCode 三后端共用 detect→deploy→launch→handshake 流程；身份键 `remote:wsl:<distro>[:<user>]:<posixPath>` / `remote:docker:<container>:<posixPath>`；⑦ WSL/Docker 均为一次性子进程模型；⑧ 绝不 `wsl --terminate` 整个 distro，只杀自己 spawn 的 wsl.exe。

## 0. 立契约前的实机验证（2026-10-07，本机 Git Bash 实跑，非文献转述）

以下事实**全部当场验证**，是本文档若干决策的直接依据。Git Bash 下所有 wsl/docker 命令均加 `MSYS_NO_PATHCONV=1 MSYS2_ENV_CONV_EXCL='PIX_'`（wsl-test-env.md 的坑）。

| # | 命令 | 结论 |
| --- | --- | --- |
| V1 | `wsl.exe -l -v`（od 十六进制查看） | 输出为 **UTF-16LE**（大量 `\0` 字节），行尾 `\r\0\n\0`；NUL 剥除后为 `NAME  STATE  VERSION` 表，`*` 前缀标记 default（当前为 `docker-desktop`），另含 `Ubuntu Running 2`。表头与数据列按 **2 个以上空白** 分隔 |
| V2 | `wsl.exe -d Ubuntu -- /bin/sh -c 'read l1; echo L1=[$l1]'`（stdin 接 `AAA\n`） | **`L1=[]`——`--` 形态丢失引号语义**。`wsl.exe --` 把 `--` 之后的 argv 以空格拼接、经发行版默认 shell 再解析（实测 `wsl -- printf '[%s]\n' 'x y' 'z'` 产出 `[x y]n[z]n`，`\n` 反斜杠被吃掉）。含空白/引号/`$` 的参数一律被破坏 |
| V3 | `wsl.exe -d Ubuntu -u tzdxf --exec /bin/sh -c 'read l1; …'`（stdin 接 `AAA\n`） | `--exec` 形态 **argv 原样直达**（`L1=[AAA]`）、stdin 转发正常、`-u` 生效、`$WSL_DISTRO_NAME=Ubuntu`、`id -un=tzdxf` |
| V4 | `wsl.exe -d Ubuntu --exec /bin/sh -c 'exit 7'`；`docker exec pix-docker-test /bin/sh -c 'exit 9'` | 退出码传播：`7` / `9`，`classify_failure` 的退出码判定可直接复用 |
| V5 | eval 帧格式 stdin 验证：`printf 'read line; echo GOT_STDIN=$line\n' | base64` 后 `echo HELLO \| wsl --exec /bin/sh -c "eval \"\$(echo B64 \| base64 -d)\""` 与同型 docker 命令 | 两后端均 `GOT_STDIN=HELLO_PIX`——P1/P2 的 `wrap_payload`（`payload.rs:113-118`）eval 帧格式在 WSL/Docker 上 **stdin 语义成立** |
| V6 | 真实 pi RPC：P1 契约 §3.5 spawn payload 原文经 base64 后分别走 `wsl.exe -d Ubuntu --exec /bin/sh -c 'eval …'` 与 `docker exec -i pix-docker-test /bin/sh -c 'eval …'`，stdin 写 `{"type":"get_state","id":1}` | 两后端 stdout 返回完整 JSONL response（model=unknown），stderr 干净且含 `PIX_PI_PID=…`。**脚本层零改动即通** |
| V7 | `wsl.exe -d Ubuntu --exec /bin/sh -c 'printf "{\"a\":1}\nline2\n"'`（od 查看） | wsl.exe 对 **Linux 程序的输出按字节透传**（非 UTF-16）；只有 wsl.exe **自身的消息**（`-l` 列表、错误信息）才是 UTF-16LE/混合编码。JSONL 桥接不受影响 |
| V8 | `wsl.exe -d NoSuchDistro --exec /bin/true` | 退出码 **127**；stderr 为混合编码（GBK 中文 + UTF-16LE 尾段），NUL 剥除后含 ASCII 关键词 `Wsl/Service/WSL_E_DISTRO_NOT_FOUND`——错误归类必须先做编码归一化，再用 ASCII 关键词匹配 |
| V9 | `docker exec -i no-such-container-xyz /bin/true` | 退出码 1，stderr：`Error response from daemon: No such container: …` |
| V10 | `docker version --format '{{.Server.Version}}'`；`docker ps -a --format "{{json .}}"` | daemon 应答返回 `29.7.2`（**探活必须用 `docker version`**，CLI 存在≠daemon 可用）；`ps -a --format {{json .}}` 输出逐行 JSON（含 `Names`/`State`/`Image`/`Status`），pix-docker-test 为 `State:"running"` |

**最大发现（V2/V3）**：ZCode 的 `wsl.exe -d <distro> -- bash -lc <command>` 形态在本机 WSL 2.6.1 上会把多词命令拆散重解析——PiX **必须用 `--exec`**。这是本文档与 ZCode 形态的唯一实质分歧，理由见 §1.2。

---

## 1. 传输层泛化

### 1.1 核心洞察：脚本层零改动

PiX 的全部远端脚本——`PROBE_SCRIPT`、`SESSIONS_SCRIPT`、`TRUST_UPLOAD_SCRIPT`、`TRUST_RUN_SCRIPT`（`ssh/payload.rs:28-88`）、spawn payload（`payload.rs:128-150`）、`test -d`、`realpath`、终端 shell payload（`terminal.rs:128-134`）——都是 **POSIX shell 文本 + base64 通道**，对目标环境只有两条假设：存在 `/bin/sh` 与 `base64`。WSL 发行版（Ubuntu 等 Linux 发行版）与 Linux 容器（node:22-slim、Alpine）都满足。V5/V6 已实机验证 eval 帧格式在两后端的 stdin 语义与真实 pi 握手。

因此泛化边界划在**一处**：把「如何把 `<wrapped 命令>` 变成本地 argv」抽成 per-backend 分支，脚本层与上层（命令、校验链、JSONL 桥接、term 帧）零改动。

### 1.2 per-backend argv 形态（冻结）

`<wrapped>` 恒为 `wrap_payload(script)` 的产物（`/bin/sh -c 'eval "$(echo <B64> | base64 -d)"'`，单元素字符串）。三后端：

| 后端 | 本地 argv（程序 + 参数，tokio 独立参数，绝不本地拼 shell） |
| --- | --- |
| SSH（现状不变） | `ssh_program_parts()` + `build_ssh_args(endpoint)` + `[wrapped]` ——wrapped 是最后一个单元素 argv，由远端登录 shell 解析 |
| WSL | `wsl_program_parts()` + `["-d", <distro>]`（+ `["-u", <user>]` 仅配置了 user 时）+ `["--exec", "/bin/sh", "-c", wrapped]` |
| Docker | `docker_program_parts()` + `["exec", "-i", <container>, "/bin/sh", "-c", wrapped]` |

**WSL 外层 shell 决策：`/bin/sh -c`，不用 `bash -lc`**。理由：
1. `--exec` 直达目标程序，外层只负责解析 wrapped 字符串一次；wrapped 本身是 POSIX 文本，dash/busybox ash 均可（与 Docker 形态完全同构，心智统一）。
2. 登录 shell（`-l`）会 source profile：拖慢每次 exec（probe/会话扫描/信任共 3 类高频调用），且 profile 里任何 stdout echo 都扩大 banner 污染面（现有标签行解析已容忍，但没必要主动放大）。
3. `bash -lc` 的动机是补全 PATH（nvm 等安装形态）。代价/收益不划算：PiX 的 pi 发现是 `command -v pi`，WSL 默认 exec PATH 含 `/usr/local/bin`（V6 实测命中 `/usr/local/bin/pi`）；nvm 装法未覆盖，作为已知限制写进 probe 未装 pi 的指引文案（§4.4），不做 shell 层补偿。
4. `--` + `bash -lc`（ZCode 形态）在 V2 已实测破坏多词命令，`--exec` 是唯一保真形态。

**Docker 外层 shell 决策：`/bin/sh -c`**（即容器内 shell）。node:22-slim 的 `/bin/sh → /usr/bin/dash`、Alpine 为 busybox ash，POSIX 语义一致；不用 `-t`（会污染 JSONL stdout）、不用 `-u`（P3 不做容器内用户切换，见 §2.3）。`-i` 恒定传递（stdin 通道是 spawn/信任请求 JSON 的生命线，V5/V6）。

### 1.3 类型与函数改动（`src-tauri/src/ssh/`）

**新增 `ssh/backend.rs`**（后端 agent 独占）：

```rust
/// 三后端统一端点。SshEndpoint 结构不变（transport.rs:30-35）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RemoteEndpoint {
    Ssh(SshEndpoint),
    Wsl(WslEndpoint),        // { distro: String, user: Option<String> }
    Docker(DockerEndpoint),  // { container: String }
}

/// 纯函数：完整本地命令 (程序, 参数数组)。三后端分支按 §1.2 表实现；
/// 远端命令恒为最后一个 argv 元素（SSH）或最后的 -c 参数（WSL/Docker）。
pub fn build_remote_command(endpoint: &RemoteEndpoint, remote_command: &str) -> (String, Vec<String>);

/// 终端分支（§5.3）：SSH 用 build_ssh_args_interactive（-tt、无 BatchMode）；
/// WSL 与 exec 形态相同（wsl.exe 无 BatchMode 概念，直接 --exec）；
/// Docker 仅把 `-i` 换成 `-it`。
pub fn build_remote_command_interactive(endpoint: &RemoteEndpoint, remote_command: &str) -> (String, Vec<String>);

/// 测试钩子，语义与 ssh_program()/ssh_program_parts()（transport.rs:97-115）逐字一致：
/// 读 PIX_WSL_COMMAND / PIX_DOCKER_COMMAND，缺省 "wsl.exe" / "docker"，
/// 复用 split_program_spec 的 ASCII 空白切分与前置参数插入。
pub fn wsl_program() -> String;  pub fn wsl_program_parts() -> Vec<String>;
pub fn docker_program() -> String;  pub fn docker_program_parts() -> Vec<String>;
```

**transport.rs 泛化**（后端 agent 独占，重命名 + 换参类型，逻辑不动）：

```rust
// 以下函数把首参 &SshEndpoint 换成 &RemoteEndpoint，内部改调 build_remote_command：
pub async fn remote_exec(endpoint: &RemoteEndpoint, script: &str, timeout: Duration) -> Result<ExecOutput, SshError>;
pub async fn remote_exec_with_stdin(endpoint: &RemoteEndpoint, script: &str, stdin_data: &[u8], timeout: Duration) -> Result<ExecOutput, SshError>;
pub async fn remote_exec_stream(endpoint: &RemoteEndpoint, script: &str) -> Result<Child, SshError>;
```

- 命名决策：函数改为 `remote_*` 中性名；`SshError`/`SshErrorKind`/`ExecOutput` **结构名不改**（`SshError` 语义即"远程传输错误"，全仓 4 个消费文件改类型名纯属 diff 噪声；模块注释注明）。旧名 `ssh_exec`/`ssh_exec_with_stdin`/`ssh_exec_stream` 删除，调用点（`commands/ssh.rs`、`commands/pi.rs:138`、`rpc/child.rs` kill 兜底、`ssh_sessions.rs`）同步改。`SshEndpoint`/`build_ssh_args`/`build_ssh_command` 保留为 Ssh 分支的内部实现。
- `exec_remote` 共用实现体不变：stdio piped、`kill_on_drop(true)`、超时 drop、Windows `CREATE_NO_WINDOW`（`transport.rs:282-368`）——wsl.exe/docker.exe 同样需要隐藏窗口，`creation_flags` 对三后端恒加。
- Windows 下 `wsl.exe`/`docker.exe` 经 PATH 解析（tokio `Command::new("wsl.exe")`），无需绝对路径。

### 1.4 keepalive / 断连语义差异（冻结表述）

| | SSH | WSL | Docker |
| --- | --- | --- | --- |
| 保活 | `ServerAliveInterval=15 ×3`（`build_ssh_args` 内置），客户端可主动判定死链 | **无**。wsl.exe 子进程存活即"连接"；WSL VM 崩溃表现为 wsl.exe 退出 | **无**。docker CLI 子进程存活即"连接"；daemon 重启表现为 CLI 退出（容器不随之停） |
| 断连信号 | ssh 进程退出 → stdout EOF → 现有 `pi://exit` 链路（P1 契约 §3.9） | 同左：wsl.exe 退出 → EOF → `pi://exit` | 同左：docker CLI 退出 → EOF → `pi://exit` |
| 远端 pi 存活 | stdin EOF 使远端 pi 退出（wsl-test-env.md 实测④） | stdin EOF 机制相同（V5/V6 形态成立；`wsl_real` 用例复核） | stdin EOF 机制相同（`docker_real` 用例复核） |
| 断连事件 | 无 `onDidDisconnect`（P1 起即以 EOF+exit 事件表达，维持不变） | 无，同 SSH 现状 | 无，同 SSH 现状 |

三后端统一：**重连 = 手动 respawn + `--session` 恢复**（P1 有意设计，不因后端而变）；`remote_pid` 兜底 kill（`child.rs`）对三后端一致——kill 脚本 `kill -TERM <pid>` 经 `remote_exec` 投递，wsl 在发行版内、docker 在容器 PID 命名空间内执行，语义相同。**绝不调用 `wsl --terminate` / `docker stop`/`docker restart`**（任务书踩坑 ⑧/⑥）：后端只杀自己 spawn 的本地子进程 + 远端 pid。

---

## 2. 身份键文法（P1 契约 §1 的扩展）

### 2.1 六种标识总表

| 后端 | 展示 URI | 内部身份键 |
| --- | --- | --- |
| ssh（冻结不变） | `ssh://[user@]host[:port]/abs/path` | `remote:ssh:<host>:<port>:<user>:<posixPath>` |
| wsl | `wsl://[user@]distro/abs/path` | `remote:wsl:<distro>:<user>:<posixPath>` |
| docker | `docker://container/abs/path` | `remote:docker:<container>:<posixPath>` |

user 空段 = 缺省（WSL 用发行版默认用户）；docker 无 user 段（对齐 ZCode：`remote:docker:<container>:<posixPath>` 三段）。wsl 无 port 段。

### 2.2 归一化与校验规则（TS / Rust 两侧语义完全一致）

**共用规则**（直接复用 P1 契约 §1.2）：path 复用 `normalize_ssh_path`（`identity.rs:146-168` / `ssh.ts:43-52`）逐字不变——`\`→`/`、折叠 `//`、去尾 `/`（根保留）、删 `.`、拒 `..` 与 `:`、拒控制字符。所有字段禁 `:`（身份键分隔符）、禁空白与控制字符。

**wsl 专属**：
- authority = `[user@]distro`：user 规则同 SSH（字母数字 `._-`，大小写保留，空 user 非法）。
- distro 字符集：字母、数字、`.`、`_`、`-`，且不以 `.`/`-` 开头；**大小写保留、不做 lowercase 归一**（WSL 发行版名是注册表身份，`Ubuntu-22.04` 必须原样；比较一律字节相等）。**distro 名为 `default`（任何大小写）直接拒绝**——"default" 是模糊输入（任务书踩坑 ③），身份必须锚定 `$WSL_DISTRO_NAME`；前端发行版枚举（§4.2）给出的就是真实 distro 名，用户没有手输 default 的场景，防御性拒绝即可。
- 解析失败返回 None 的输入样例：`wsl://default/…`、`wsl://Ubuntu`（无路径）、`wsl:///path`、`wsl://u s/x`、`wsl://a:b/x`、`wsl://@Ubuntu/x`。

**docker 专属**：
- authority = container（无 user、无 port）。字符集：`^[A-Za-z0-9][A-Za-z0-9_.-]+$`（**至少 2 字符**——对齐 moby 真实命名规则 `restrictedNamePattern`，Docker 拒绝单字符容器名；短 ID 为其子集）。**容器名/短 ID 保留输入原样，不做 lowercase**（docker 名称区分大小写；短 ID 十六进制按原样比较——连接与 URI 必须由同一来源构造：前端枚举列表（§4.2）只给 `Names` 原值，杜绝手输短 ID 与全 ID 不一致的二义）。
- **短 ID/全 ID 不做归一化展开**：解析期是纯词法操作，不触碰 docker daemon（枚举命令除外）；身份一致性由「前端只从枚举列表选择」这一 UX 约束保证。
- 解析失败样例：`docker://-bad/x`、`docker://a b/x`、`docker://x`（无路径）、`docker:///path`、`docker://x:1/y`。

**展示 URI 重建**：无 port/user 可省段——`wsl://<distro><path>`（有 user 时 `wsl://<user>@<distro><path>`）；`docker://<container><path>`。path 用归一化值。

**身份键构造/解析**：与 P1 契约 §1.2 第 5 条同规则——段数固定（wsl 4 段、docker 3 段），path 必须已是归一化形式（二次归一化≠原值即拒绝，`identity.rs:132-135` 模式），user 空串↔None 互转。

### 2.3 实现归属与 API（两侧各一份，语义逐字对齐）

- Rust：**扩展现有 `src-tauri/src/ssh/identity.rs`**（不新建文件），新增：

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WslTarget { pub distro: String, pub user: Option<String>, pub path: String }
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DockerTarget { pub container: String, pub path: String }

pub fn parse_wsl_uri(uri: &str) -> Option<WslTarget>;
pub fn build_wsl_uri(target: &WslTarget) -> Result<String, String>;
pub fn wsl_identity_key(target: &WslTarget) -> Result<String, String>;      // remote:wsl:…
pub fn parse_wsl_identity_key(key: &str) -> Option<WslTarget>;
pub fn parse_docker_uri(uri: &str) -> Option<DockerTarget>;
pub fn build_docker_uri(target: &DockerTarget) -> Result<String, String>;
pub fn docker_identity_key(target: &DockerTarget) -> Result<String, String>; // remote:docker:…
pub fn parse_docker_identity_key(key: &str) -> Option<DockerTarget>;

/// 三后端伞型：本地路径与全部非远程输入返回 None。
pub enum RemoteTarget { Ssh(SshTarget), Wsl(WslTarget), Docker(DockerTarget) }
pub fn parse_remote_uri(uri: &str) -> Option<RemoteTarget>;   // 依次尝试 ssh/wsl/docker 前缀
pub fn is_remote_uri(value: &str) -> bool;                    // ssh:// | wsl:// | docker:// 前缀
```

- TS：**扩展现有 `src/lib/ssh.ts`**（P2 的"身份模型冻结"针对 P2 范围；P3 按本节扩展），新增 `WslTarget`/`DockerTarget`/`parseWslUri`/`buildWslUri`/`wslIdentityKey`/`parseWslIdentityKey`/`parseDockerUri`/`buildDockerUri`/`dockerIdentityKey`/`parseDockerIdentityKey`/`RemoteTarget` 联合类型/`parseRemoteUri`/`isRemoteUri`。**守卫入口**：现有 `isSshProject = isSshUri` 保留；新增 `export const isRemoteProject = isRemoteUri`，前端所有守卫点（P1 契约 §5、P2 契约 §2.4/§3.4 的 `isSshProject` 调用点）**全部切换到 `isRemoteProject`**。
- 禁止手拼六种字符串的纪律与 P1 契约 §1.1 相同。

### 2.4 测试用例表（两侧都必须通过；TS → `tests/ssh-identity.test.ts` 扩展，Rust → `identity.rs` `#[cfg(test)]` 扩展）

| # | 输入 | 期望 |
| --- | --- | --- |
| 1 | `parse_wsl_uri("wsl://tzdxf@Ubuntu-22.04/home/dev/proj")` | `{distro:"Ubuntu-22.04", user:"tzdxf", path:"/home/dev/proj"}`；round-trip 原串；身份键 `remote:wsl:Ubuntu-22.04:tzdxf:/home/dev/proj` |
| 2 | `parse_wsl_uri("wsl://Ubuntu/Proj")` | user=null；path `/Proj` 大小写保留；身份键 `remote:wsl:Ubuntu::/Proj`；重建 `wsl://Ubuntu/Proj` |
| 3 | `parse_wsl_uri("wsl://Ubuntu/a/b///")` → `/a/b`；`wsl://Ubuntu/./a` → `/a`；`wsl://Ubuntu/../etc` → null；`normalizeWslPath` 不单独存在（复用 normalizeSshPath） |
| 4 | 全部 null：`"wsl://default/x"`、`"wsl://Default/x"`、`"wsl://Ubuntu"`、`"wsl:///x"`、`"wsl://@U/x"`、`"wsl://U a/x"`、`"wsl://U:b/x"`、`"C:/code"`、`"/home/u"` |
| 5 | `parse_docker_uri("docker://pix-docker-test/root/pix-docker-demo")` | `{container:"pix-docker-test", path:"/root/pix-docker-demo"}`；身份键 `remote:docker:pix-docker-test:/root/pix-docker-demo`；round-trip |
| 6 | `parse_docker_uri("docker://fdc995e5a8fc/root/demo")` 合法（12 位短 ID）；`"docker://-x/y"`、`"docker://x"`、`"docker://x:1/y"`、`"docker:///y"` → null |
| 7 | 身份键互逆：合法 WslTarget/DockerTarget 的 key↔parse 深相等；`parse_wsl_identity_key("remote:wsl:Ubuntu:tzdxf")`（缺 path 段）→ null；`parse_docker_identity_key("remote:docker:c:/a")` → null；未归一化 path（`/a/`、`a`）→ null |
| 8 | 伞型：`parse_remote_uri("ssh://dev@h:22/a")`→Ssh；`("wsl://U/a")`→Wsl；`("docker://ci/a")`→Docker；`("docker://c/a")`→None（单字符容器名，moby 规则至少 2 字符）；`("C:/code")`、`("wslx://a/b")`→None；`is_remote_uri` 对 P1 §1.5 第 8 条输入全 false（本地零影响） |

---

## 3. 连接配置与迁移

### 3.1 schema：`sshConnections` 键名不变，项内新增 `kind`

```jsonc
// ~/.pix/config.json（键名沿用 "sshConnections"——历史命名，语义已是"远程连接"，§3.3 决策 1）
"sshConnections": [
  {
    "id": "wsl-9f1c2a…",             // 必填唯一；新增时按 kind 生成前缀："ssh-"/"wsl-"/"docker-" + UUID v4；旧 id 不改写
    "kind": "wsl",                   // ★ 新增："ssh" | "wsl" | "docker"；缺省 "ssh"（serde default = 迁移规则，§3.2）
    "name": "WSL Ubuntu",            // 必填非空展示名（trim 后）
    // ---- kind = "ssh" 专用（现字段原样）----
    "host": "host.example.com", "port": 22, "user": "dev", "keyPath": "~/.ssh/id_ed25519",
    // ---- kind = "wsl" 专用 ----
    "distro": "Ubuntu",              // 必填；§2.2 字符集，保存时 trim + 校验
    // "user": 可选（与 SSH 共用字段；None = 发行版默认用户）
    // ---- kind = "docker" 专用 ----
    "container": "pix-docker-test",  // 必填；§2.2 字符集
    // ---- 公共 ----
    "createdAt": "2026-10-07T08:00:00.000Z",
    "lastUsedAt": null,
    "lastProbe": { "probedAt": "…", "ok": true, "uname": "Linux", "arch": "x86_64", "nodeVersion": "…", "piVersion": "1.0.0" }
  }
]
```

**per-kind 字段裁剪（保存时强制，`ssh/config.rs::save_connection_in` 扩展）**：

| kind | 必填 | 可选 | 保存时置空/忽略 | 校验失败 |
| --- | --- | --- | --- | --- |
| `ssh` | host（identity::normalize_host）、port（缺省 22） | user、keyPath | distro、container 置 None | 现有 `sshConnectionInvalid` |
| `wsl` | distro（§2.2 校验） | user | host、port、keyPath、container 置 None | `sshConnectionInvalid`（文案插值 {detail}，键复用） |
| `docker` | container（§2.2 校验） | （无） | host、port、user、keyPath、distro 置 None | 同上 |

- **凭据字段仅 SSH 有**：`keyPath` 只在 kind=ssh 存在（其语义是本机 ssh 的私钥路径，对 WSL/Docker 无意义——两者复用 Windows 本机身份）。无新增凭据字段。
- Rust：`SshConnection`（`config.rs:36-55`）加 `#[serde(default)] kind: ConnectionKind`（新枚举，`serde rename_all="kebab-case"` → `"ssh"|"wsl"|"docker"`，default = Ssh）；`WslEndpoint`/`DockerEndpoint` 字段挂同一 struct（Option），序列化时 `skip_serializing_if = "Option::is_none"`。`SshConnection::to_endpoint()`（`config.rs:282-298`）改为 `to_remote_endpoint() -> RemoteEndpoint`，按 kind 装配（SSH 分支保留 `~` 展开逻辑）。
- TS：`SshConnection`（`src/api/client/ssh.ts`）加 `kind: "ssh" | "wsl" | "docker"`；`SshConnectionInput` 加 `kind?:` 同联合（缺省 ssh，由后端落盘）。`resolveSshConnectionId`（`ssh.ts:209-219`）的 `connectionMatches` 扩展为按 kind 比较：ssh 比 host/port/user，wsl 比 distro/user，docker 比 container——**kind 不匹配直接 false**（`wsl://` URI 不会匹配到 ssh 连接）。

### 3.2 迁移规则（冻结）

1. **读路径即迁移**：`kind` 字段 `#[serde(default)]` 缺失 → `"ssh"`。旧 config.json 无需任何一次性迁移脚本；首次任意写回时 kind 显式落盘。
2. 旧数据全是 ssh 连接 → default 值语义恒正确，无字段语义漂移。
3. **不做** `sshConnections` → `remoteConnections` 的键改名迁移（见 §3.3）。
4. localStorage `pix.sshProjectConnections`（`ssh.ts:158`）不动：URI 前缀本身携带 kind，映射键不变。

### 3.3 wire 参数命名决策：**原地沿用 `sshConnectionId`（选定）**

`rpc_spawn`/`term_create`（P2 已加）/`ssh_sessions`/`ssh_trust_status`/`ssh_trust_save` 的 `sshConnectionId` 参数**不改名、不双写**；`sshConnections` 配置键不改名。备选项否决理由：

- **一次性迁移到 `remoteConnectionId`**：波及 5 条命令签名 + localStorage 映射 + `src/api/client/{process,ssh,sessions,config,rpc}.ts` + 全部相关测试，diff 大且恰逢并行开发窗口；收益仅是命名审美。
- **双写过渡**：引入两个参数名并存一个版本，需要兼容矩阵与弃用期管理，复杂度高于问题本身。
- 原地沿用的代价（名字带 ssh 前缀承载 wsl/docker 连接 id）以文档注记消化：本契约 §3.1 已声明"sshConnections 语义 = 远程连接"。若未来改名，唯一合适时机是 P4 身份快照持久化引入第二个持久消费者时，做带迁移脚本的一次性切换。

---

## 4. 新命令：WSL 发行版枚举与 Docker 容器枚举

### 4.1 签名（命令实现 `src-tauri/src/commands/ssh.rs` 追加；枚举/解析逻辑在 `ssh/wsl.rs` 与 `ssh/docker.rs`，见 §7）

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslDistroInfo {
    pub name: String,       // 原样（§2.2：大小写保留）
    pub state: String,      // "Running" / "Stopped" / …（wsl.exe 原文）
    pub version: u32,       // 1 | 2
    pub is_default: bool,   // `*` 前缀行
}

/// 结构化可用性结果：探活/解析失败时不返回 Err，而是 available=false + errorKind，
/// 前端呈现「不可用」态而非报错 toast（§4.4）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslDistroListResult {
    pub available: bool,
    pub distros: Vec<WslDistroInfo>,
    pub error_kind: Option<&'static str>,   // 见 §4.4 errorKind 表
    pub error: Option<String>,              // coded error，前端 translateError 渲染
}

#[tauri::command]
pub async fn wsl_distro_list() -> Result<WslDistroListResult, String>

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainerInfo {
    pub name: String,     // json .Names（首名；逗号多网络名场景取 split(',')[0]）
    pub id: String,       // json .ID（12 位短 ID）
    pub image: String,    // json .Image
    pub state: String,    // json .State（"running"/"exited"/…，小写原值）
    pub status: String,   // json .Status（"Up 2 minutes" 等展示文本）
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainerListResult {
    pub available: bool,
    pub containers: Vec<DockerContainerInfo>,
    pub error_kind: Option<&'static str>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn docker_container_list() -> Result<DockerContainerListResult, String>
```

平台守卫：
- `wsl_distro_list` **仅 Windows 有意义**。非 Windows 平台返回 `Ok(WslDistroListResult { available: false, error_kind: Some("wslUnsupportedPlatform"), … })`（命令恒注册，用返回值而非 Err 表达平台限制；前端同时用 `navigator.userAgent`/构建平台隐藏入口）。`#[cfg(windows)]` 只用于实现体，命令本体全平台编译。
- `docker_container_list` 全平台（macOS/Linux/Windows 都有 Docker Desktop）。

### 4.2 WSL 枚举实现要点（`ssh/wsl.rs`，冻结）

1. 经 `wsl_program_parts()` spawn `wsl.exe -l -v`（消费 `PIX_WSL_COMMAND` 测试钩子），整体超时 15s，stdio piped，`CREATE_NO_WINDOW`。
2. **编码归一化（唯一入口 `decode_wsl_output(bytes) -> String`，纯函数 + 单测）**：字节流含 `\0` → 按 UTF-16LE lossy 解码；否则 UTF-8 lossy。随后统一剥 `\0`、`\r`、UTF-16 BOM（`\u{FEFF}`）。V1/V7 表明 wsl.exe 自身消息是 UTF-16LE/混合，Linux 程序输出字节透传——本函数只用于 **wsl.exe 自身输出**（`-l` 列表与错误流），`remote_exec` 的脚本输出不做此处理。
3. **列解析（`parse_wsl_list(stdout) -> Vec<WslDistroInfo>`，纯函数 + 单测）**：跳过表头行（含 `NAME`）；数据行从右往左切：末 token = version（数字），倒数第二 token = state，其余（剥去行首 `*` 与空白）= name。从右切使 name 内含单个空格也能存活；字段间 ≥2 空白是 wsl.exe 输出常态（V1）。
4. 输出无任何可解析数据行且退出码非 0 → `available=false`（`wslNotInstalled`，见 §4.4）；退出码 0 但零数据行 → 空列表 `available=true`（合法的"未装任何发行版"）。
5. 不区分 default 与列表排序：保持 wsl.exe 原顺序，`isDefault` 仅供 UI 标注。**枚举不触发 distro 启动**（`-l` 不拉起 VM；若 VM 未启动，wsl.exe 会自动启动后列出——这是 wsl.exe 既有行为，接受）。

### 4.3 Docker 枚举实现要点（`ssh/docker.rs`，冻结）

1. 经 `docker_program_parts()` spawn `docker ps -a --format` + 单参数 `{{json .}}`（独立 argv，模板不含引号）。整体超时 15s。
2. **探活语义（任务书踩坑 ④）**：`docker ps` 失败即区分——spawn 失败（CLI 不存在）→ `dockerMissing`；exit 非 0 且 stderr 小写含 `cannot connect to the docker daemon` → `dockerDaemonDown`（daemon 未启动/未应答）。**不单独前置 `docker version` 调用**（`docker ps` 的失败模式已覆盖 daemon 探活；少一次进程开销）。
3. stdout 逐行 `serde_json::from_str`，解析失败的行静默跳过（任务书踩坑 ⑤）；`Names` 字段取逗号前首名。
4. **容器未运行不自动 start（踩坑 ⑥）**：枚举就是 `-a` 全量展示（含 stopped），state 原样给前端标注；exec 连接时未运行容器报 `dockerContainerNotRunning`（§4.4），由用户自行启动容器。

### 4.4 错误归类与文案（i18n，zh-CN 与 en 同步；并入 `backendErrors` 命名空间，同步更新 `tests/backend-errors.test.ts`）

| errorKind / coded error 键 | 判定 | zh-CN 文案（冻结） | en 文案要点（前端 agent 按语义译，键名冻结） |
| --- | --- | --- | --- |
| `wslUnsupportedPlatform` | 非 Windows 平台调 `wsl_distro_list` | `当前平台不支持 WSL 远程连接。` | WSL remotes are only supported on Windows. |
| `wslNotInstalled` | spawn wsl.exe 失败；或 `-l` 退出码非 0 且无可解析列表 | `未找到 wsl.exe 或 WSL 未安装。请在「启用或关闭 Windows 功能」中启用「适用于 Linux 的 Windows 子系统」。` | wsl.exe not found or WSL is not installed. Enable "Windows Subsystem for Linux" in Windows Features. |
| `wslDistroNotFound` | exec/枚举退出码 127 或输出（剥 NUL 后）含 `WSL_E_DISTRO_NOT_FOUND`（V8） | `WSL 发行版不存在或已被注销。请确认发行版名称。` | The WSL distro does not exist or has been unregistered. Check the distro name. |
| `wslExecFailed` | 其余 wsl exec 非零退出（detail 插值） | `WSL 命令执行失败: {detail}` | WSL command failed: {detail} |
| `dockerMissing` | spawn docker 失败 | `未找到 docker 命令。请安装并启动 Docker Desktop。` | docker command not found. Install and start Docker Desktop. |
| `dockerDaemonDown` | stderr 含 `cannot connect to the docker daemon` | `Docker 守护进程未响应。请确认 Docker Desktop 已启动。` | The Docker daemon is not responding. Make sure Docker Desktop is running. |
| `dockerContainerNotFound` | stderr 含 `no such container`（V9，exit 1） | `Docker 容器不存在。请确认容器名称。` | The Docker container does not exist. Check the container name. |
| `dockerContainerNotRunning` | stderr 含 `is not running`（exit 1） | `容器未运行（state=exited）。请先启动该容器，PiX 不会自动启动它。` | The container is not running. Start it first — PiX will not start it automatically. |
| `dockerExecFailed` | 其余 docker exec 非零退出 | `Docker 命令执行失败: {detail}` | Docker command failed: {detail} |

UI 命名空间（`ssh.*`，前端枚举面板用）：`ssh.wslUnavailable`（`暂无法枚举 WSL 发行版`/`Cannot list WSL distros right now`）、`ssh.dockerUnavailable`（`暂无法枚举 Docker 容器`/`Cannot list Docker containers right now`）——`available=false` 时面板显示不可用态 + `error` 的 translateError 详情，而非抛错 toast。errorKind 的字符串值进 TS 联合类型 `SshErrorKind`（`ssh.ts`）扩展：`"wslUnsupportedPlatform" | "wslNotInstalled" | "wslDistroNotFound" | "wslExecFailed" | "dockerMissing" | "dockerDaemonDown" | "dockerContainerNotFound" | "dockerContainerNotRunning" | "dockerExecFailed"`。

---

## 5. spawn / 终端分流

### 5.1 `rpc_spawn`（`commands/pi.rs:49-97`）

- **分流判据**：`ssh::parse_ssh_uri(&project)` 改为 `ssh::parse_remote_uri(&project)`（§2.3）。本地路径行为逐字节不变。
- 校验链泛化（`spawn_remote`，`pi.rs:101-163`）：
  1. `ssh_connection_id` 空 → `sshConnectionMissing`（不变）；
  2. 连接不存在 → `sshConnectionNotFound`（不变）；
  3. 一致性比较（`pi.rs:124-129`）改为按 kind：`connection.kind` 与 URI 解析结果的 kind 必须一致，再比对应字段（ssh: host/port/user；wsl: distro/user；docker: container）→ 不一致 `sshConnectionMismatch`；
  4. `workspace.is_some()` → `sshWorkspaceUnsupported`（三后端同裁剪）；
  5. **远程目录校验三后端同一脚本**：`test -d '<path>'`（`posix_quote` 注入）经 `remote_exec`，exit 1 → `projectDirMissing`，其余按 §1.3 归类——wsl/docker 的退出码传播已实测（V4）。
- `rpc::SpawnProgram::Ssh(SshSpawnSpec)`（`rpc.rs:42-44`）泛化为 `SpawnProgram::Remote(RemoteSpawnSpec { endpoint: RemoteEndpoint, remote_path: String })`；`child.rs` 的 `process_spawn` Ssh 分支（`child.rs:262-271`）改调 `remote_exec_stream`；`PIX_PI_PID` stderr 解析、`wait_ssh_ready`、realpath 回绑（`child.rs:443-464`，P2 已扩大到全部远程 spawn）全部复用——realpath 脚本对 wsl/docker 原样可用（POSIX）。`remote_pid` kill 兜底（`child.rs:782`）改经 `remote_exec`。
- 不注入 builtin extensions、不设 `PIX_WORKSPACE`、`build_spawn_args` 产物内嵌 payload——均与传输无关，三后端一致（P1 契约 §3.1 第 7 条）。
- 成功后 `touch_connection`（lastUsedAt）不变。

### 5.2 `ssh_sessions` / `ssh_trust_*`

命令体的校验链与 §5.1 第 3 条同源（`commands/ssh.rs::resolve_ssh_connection:230-251` 泛化为 per-kind 比较）；脚本与解析零改动（V5/V6 已验证 eval 通道）。`SESSIONS_SCRIPT` 的 `stat -c/-f` 回退链、`TRUST_*` 脚本在 wsl/docker 原样成立（容器与发行版均为 Linux）。

### 5.3 终端 `term_create`（`terminal.rs:71-95`）

- 分流判据：`parse_ssh_uri` → `parse_remote_uri`；本地路径即使误传 `ssh_connection_id` 也忽略（P2 契约 §3.2 冻结不变）。校验链同 §5.1 第 3 条（`resolve_remote_endpoint`，`terminal.rs:156-187` 泛化）。
- **WSL 终端**：portable-pty spawn（复用 `spawn_terminal` 全部装配，`terminal.rs:191-260`）

  ```
  wsl.exe -d <distro> [-u <user>] --exec /bin/sh -c '<cd-payload>'
  ```

  `<cd-payload>` 复用 `build_remote_shell_payload`（`terminal.rs:128-134`）原文：`cd '<path>' 2>/dev/null || echo … >&2` + `exec "${SHELL:-/bin/sh}" -l`——`$SHELL` 在发行版环境内展开，交互式登录 shell 语义达成（任务书要求"交互式登录 shell + cd payload"）。cd 失败不退码、仍进 shell（P2 契约 §3.3 第 2 条冻结）。注意 `wsl.exe --exec` 形态下 wsl.exe 自身检测到 ConPTY 会中继终端语义（与 `ssh -tt` 同位）。
- **Docker 终端**：

  ```
  docker exec -it <container> /bin/sh -c '<cd-payload>'
  ```

  `-it`（替代 exec 分支的 `-i`）让 daemon 侧分配 PTY；payload 与 SSH/WSL 同一文本（`exec "${SHELL:-/bin/sh}" -l`，node:22-slim 的 SHELL=/bin/bash → bash 登录 shell；Alpine 回退 `/bin/sh -l`，busybox ash 支持 `-l`——`docker_real` 用例 T-D1 复核，若实测不识别 `-l`，Docker 分支改用去 `-l` 变体并在本文档补记）。stdin 是 tty 时内层 shell 自动进入交互模式。
- `TERM` 环境变量：三后端分支均 `cmd.env("TERM", "xterm-256color")`（`terminal.rs:121`）。SSH 由 ssh 转发；**WSL/Docker 不保证透传**（wsl.exe 是否把启动环境 TERM 传给发行版、docker exec 是否携带未在 WSLENV/`-e` 声明的变量——未实测），列为 T-W1/T-D1 的断言项：若 shell 内 `echo $TERM` 为空则接受（xterm.js 渲染语义由前端固定，不阻塞），并在实现报告注明实测值。
- **SIGWINCH/resize 预期行为**：`term_resize` 只 resize 本地 PTY master（`terminal.rs` 现状不变），远端尺寸同步机制 per-backend：
  - SSH：`-tt` 下 ssh 转发 SIGWINCH → 远端 PTY（P2 已实现，行为基线）；
  - WSL：wsl.exe 是 ConPTY 感知程序，本地 ConPTY 尺寸变化由 WSL 中继为发行版内 PTY 尺寸变化（预期自动生效，T-W2 实机断言 `stty size`）；
  - Docker：`docker exec -it` 的客户端把本地 tty 尺寸经 exec Resize API 推给 daemon 侧 PTY（预期自动生效，T-D2 实机断言）。
  若任一后端 resize 不生效，**不得**在前端加 workaround，回写本文档并评估远端辅助协议（P4 范畴）。
- `term_write`/`term_resize`/`term_kill` 签名零改动（P2 契约 §3.2）；kill 走 `ChildKiller` 杀本地 wsl.exe/docker.exe（远端 shell 由 stdin EOF 收尾；**绝不** `wsl --terminate`）。

- **P3 修订（2026-10-07，WSL/Docker 实机验证，T-W1/T-W2/T-D1/T-D2/R-T2/R-T3 实测回写）**：
  - **TERM 实测值**：WSL = `xterm-256color`（wsl.exe 把注入的 TERM 透传给发行版）；Docker = `xterm`（`docker exec` 不透传未在 `-e`/WSLENV 声明的环境变量，登录 shell 用默认值）。另实测 Docker 的登录 shell 为 `/bin/sh -l`（`docker exec` 环境无 `SHELL`，payload 回退 `${SHELL:-/bin/sh}`，§5.3 初稿对 node:22-slim 的 SHELL 预估不成立）。xterm.js 渲染不依赖透传，不阻塞。
  - **resize 实测**：T-W2（WSL ConPTY 中继）与 T-D2（docker exec Resize API）均自动生效，`stty size` 反映新尺寸（`wsl_real_term_resize_propagates_to_remote_pty` / `docker_real_term_resize_propagates_to_remote_pty` 实测通过），无需远端辅助协议。
  - **kill 后远端残留实测**：WSL 杀本地 wsl.exe 后 ConPTY 关闭在发行版内传播 HUP，远端登录 shell 与子进程被清理，无残留（R-T3 无残留断言对 wsl 成立）。**Docker 不成立**：`docker exec` 会话是 detach 语义——杀本地 docker.exe 后 daemon 仍持有 exec 的 PTY，远端登录 shell（实测 `/bin/sh -l`）与前台子进程持续存活（实测数分钟以上），直到进程自然退出或容器停止；「远端 shell 由 stdin EOF 收尾」对 docker 不成立（客户端 stdin EOF 不结束会话，docker exec 客户端也不因 stdin EOF 退出）。R-T3 的「pgrep 无残留」断言仅对 ssh/wsl 执行；docker 用例改为断言「kill 后标记进程仍存在」钉住实测行为。若要改变该行为需远端辅助清理协议（会话标记 + kill），列 **P4 评估项**。

### 5.4 前端分流总则

- 全部 `isSshProject(project)` 守卫点换 `isRemoteProject`（§2.3）；连接解析 `resolveSshConnectionId` 按 §3.1 的 per-kind 匹配。
- 新建连接/新建远程项目 UI（`SettingsPage.vue`、`CreateProjectDialog.vue`）：kind 选择器（ssh/wsl/docker）→ wsl 显示发行版下拉（`wsl_distro_list`，available=false 时显示 §4.4 不可用文案）+ 可选用户名；docker 显示容器下拉（`docker_container_list`）+ 测试项目路径输入；ssh 表单不变。URI 由 `buildWslUri`/`buildDockerUri`/`buildSshUri` 构造，禁止手拼。

---

## 6. 实机集成测试约定

统一约定（对齐 P2 契约 §6）：

- Rust 测试 `#[ignore]`，函数名分别含 `wsl_real` / `docker_real`：`cargo test wsl_real -- --ignored`、`cargo test docker_real -- --ignored` 单独跑；普通 `cargo test` / CI 自动跳过。全部实机用例先取 `ssh_real_lock()`（`transport.rs:473-476`，实机环境串行执行）。
- 环境变量**不得改名**，入口统一经辅助函数读取，任一缺失则 `eprintln!` 后 `return`：

  | 变量 | 值 |
  | --- | --- |
  | `PIX_WSL_TEST_DISTRO` | `Ubuntu` |
  | `PIX_WSL_TEST_PROJECT` | `/home/tzdxf/pix-ssh-demo` |
  | `PIX_DOCKER_TEST_CONTAINER` | `pix-docker-test` |
  | `PIX_DOCKER_TEST_PROJECT` | `/root/pix-docker-demo` |

  WSL 端点 = `RemoteEndpoint::Wsl { distro: $PIX_WSL_TEST_DISTRO, user: None }`（默认用户 tzdxf）；Docker 端点 = `RemoteEndpoint::Docker { container: $PIX_DOCKER_TEST_CONTAINER }`。
- Git Bash 运行实机命令一律加 `MSYS_NO_PATHCONV=1 MSYS2_ENV_CONV_EXCL='PIX_'`（覆盖两组变量与 wsl/docker 参数）。
- 只允许访问本机 WSL Ubuntu 与容器 pix-docker-test，禁止其它真实网络；写入远端的测试数据用 `PIX_TEST_` 前缀并在用例尾部清理。
- 前端（Vitest）不做实机测试，mock 覆盖。

**后端 agent 交付的实机用例**：

| # | 用例 | 断言 |
| --- | --- | --- |
| R-B1（wsl_real） | `remote_exec` 投递 P1 §3.5 spawn payload（V6 同型），stdin 写 get_state | stdout 首个 JSON 行 `success:true`；stderr 含 `PIX_PI_PID=`（脚本层零改动的最终背书） |
| R-B2（两者） | `test -d <PIX_*_TEST_PROJECT>` exit 0；不存在路径 exit 1 | 前者 Ok；后者 `SshErrorKind::Remote` + `exit_code==1`（→ projectDirMissing 路径） |
| R-B3（两者） | 脚本 `exit 7` | `exit_code == 7`（退出码传播，V4 回归） |
| R-B4（wsl_real） | `wsl_distro_list` 实机 | 含 `Ubuntu`；`isDefault` 与 `wsl -l -v` 的 `*` 行一致；state 非空 |
| R-B5（docker_real） | `docker_container_list` 实机 | 含 `pix-docker-test`、image `node:22-slim`、state `running` |
| R-B6（两者） | spawn payload 变体 `exec sleep 60`（`PIX_TEST_` 语义）→ 读 `PIX_PI_PID` → `remote_exec` 发 `kill -TERM <pid>` | 流在 5s 内 EOF（kill 兜底对 wsl/docker 生效；不触碰 distro/容器生命周期） |
| R-B7（docker_real） | `docker create --name pix-test-stopped-<uuid> alpine` 后对其 exec，用例尾 `docker rm -f` | coded error 含 `dockerContainerNotRunning`（不自动 start 的回归） |
| R-B8（两者） | probe 脚本（`PROBE_SCRIPT`）+ `parse_probe_output` | `piFound:true`、`piVersion` 与实测一致（1.0.0 / 1.0.4） |

**终端 agent 交付的实机用例**（`terminal.rs` 测试模块）：

| # | 用例 | 断言 |
| --- | --- | --- |
| R-T1（wsl_real / docker_real 各一） | `term_create` wsl 分支 / docker 分支，写 `echo PIX_TEST_<uuid>\n` | `term://output` 帧（base64 解码）在超时内含该串；记录 `echo $TERM` 实测值 |
| R-T2（两者） | `term_resize` 后执行 `stty size` | 输出反映新 cols/rows（WSL ConPTY 中继 / docker Resize API 验证；失败则按 §5.3 回写文档） |
| R-T3（两者） | `term_kill` | 本地 wsl.exe/docker.exe 退出、`term://exit` 到达；远端无残留 shell（经 `remote_exec` `pgrep -f PIX_TEST_<uuid>` 为空）。**P3 修订（2026-10-07 实测）**：无残留断言仅对 wsl 成立（ConPTY 关闭传播 HUP）；docker 为 detach 语义，远端登录 shell 与前台子进程在 CLI 死亡后仍存活，docker 用例断言「标记进程 kill 后仍存在」钉住实测行为（见 §5.3 P3 修订，远端辅助清理列 P4） |

**Vitest（前端 agent）**：身份键 §2.4 表、config kind 迁移/裁剪、`connectionMatches` per-kind、枚举结果不可用态渲染、i18n 键同步（`tests/backend-errors.test.ts`）。

---

## 7. 文件归属边界（两方并行，零冲突）

### 7.1 后端 agent

**独占（全部 `src-tauri/`）**：

- 新建：`src-tauri/src/ssh/backend.rs`（`RemoteEndpoint`、`build_remote_command[_interactive]`、`wsl_program[_parts]`、`docker_program[_parts]` + 单测）、`src-tauri/src/ssh/wsl.rs`（`decode_wsl_output`/`parse_wsl_list` + 单测）、`src-tauri/src/ssh/docker.rs`（容器 JSON 行解析 + 单测）
- 修改：`src-tauri/src/ssh/mod.rs`（re-export 整理）、`ssh/transport.rs`（`remote_*` 三函数换参类型、删旧 `ssh_exec*`）、`ssh/identity.rs`（§2.3 wsl/docker 身份 + 单测）、`ssh/config.rs`（kind 字段、per-kind 裁剪、`to_remote_endpoint` + 单测）、`ssh/payload.rs`（**脚本零改动**，仅当出现新脚本需求时经契约修订）、`src-tauri/src/commands/ssh.rs`（`wsl_distro_list`/`docker_container_list` + `resolve_ssh_connection` per-kind 泛化）、`src-tauri/src/commands/pi.rs`（`spawn_remote` 分流泛化）、`src-tauri/src/commands/mod.rs`（re-export）、`src-tauri/src/rpc.rs`（`SpawnProgram::Remote`/`RemoteSpawnSpec`）、`src-tauri/src/rpc/child.rs`（Ssh 分支改 Remote、kill 兜底 `remote_exec`）、`src-tauri/src/ssh_sessions.rs`（`ssh_exec`→`remote_exec`）、`src-tauri/src/terminal.rs`（term_create 三后端分流）
- **`src-tauri/src/lib.rs`（`generate_handler` 注册 + `mod` 声明）只允许后端 agent 改动。**

### 7.2 前端 agent

**独占**：

- 修改：`src/lib/ssh.ts`（§2.3 wsl/docker 身份 + `isRemoteProject` + `connectionMatches` per-kind）、`src/api/client/ssh.ts`（kind 类型、两条枚举命令包装、errorKind 联合扩展）、`src/api/client/process.ts` / `config.ts`（类型透传，参数名不变）、`src/stores/workspace.ts`、`src/lib/workspaceStartup.ts`、`src/composables/useSessionOpening.ts`（守卫 `isSshProject`→`isRemoteProject`）、`src/components/SettingsPage.vue`（kind 选择器 + wsl/docker 表单 + 不可用态）、`src/components/CreateProjectDialog.vue`（wsl/docker 项目入口）、`src/components/terminal/TerminalPanel.vue`（远程分支参数透传，若需）、`src/i18n/locales/zh-CN.ts` 与 `en.ts`（§4.4 全部新键）、`tests/ssh-identity.test.ts`、`tests/backend-errors.test.ts`
- 新建：`tests/remote-identity.test.ts`（或并入 ssh-identity.test.ts）、`tests/remote-connections.test.ts`（kind 迁移/匹配/枚举 UI mock）
- **不得改 `src-tauri/` 任何文件**（含 `lib.rs`）。

### 7.3 共享契约点（改动须先改本文档）

- §1.2 三后端 argv 形态与 `--exec` 决策；§1.4 keepalive/断连表述
- §2.1 六种标识格式、§2.2 归一化规则、§2.4 测试表
- §3.1 schema（`kind`、per-kind 裁剪）与 §3.3 `sshConnectionId` 原地沿用决策
- §4.1 命令名/返回形状、§4.4 errorKind 与 coded error 键集
- §5.1/§5.3 分流判据与终端 payload 文本
- 边界纪律：后端 `cargo test ssh::` / `cargo check` + `cargo test wsl_real docker_real -- --ignored`；前端 `pnpm exec vitest run tests/remote-*.test.ts tests/ssh-*.test.ts`；合入门禁统一执行。

---

## 8. 契约级验收清单

1. §2.4 身份表两侧全绿；本地项目回归零变化（`parse_remote_uri` 对本地路径返回 None，本地 spawn/终端行为逐字节不变）。
2. `PIX_SSH_COMMAND`/`PIX_WSL_COMMAND`/`PIX_DOCKER_COMMAND` 注入 mock 后，spawn→JSONL→`pi://exit` 全链路对三后端均可无网络跑通（纯函数单测为主，argv 序列逐元素断言）。
3. 旧 config.json（无 kind）读取后所有连接视为 ssh，功能与迁移前一致。
4. `wsl_distro_list`/`docker_container_list` 在 unavailable 时返回结构化结果，前端呈现不可用态而非报错。
5. 实机：R-B1~R-B8、R-T1~R-T3 全绿（wsl-real 4+3 项、docker-real 6 项按表执行）；WSL/Docker 上的 probe、会话扫描、信任、realpath 回绑零脚本改动生效。
6. 交互终端三后端可开、可输入输出、可 resize（或 resize 缺陷已按 §5.3 回写文档）。
