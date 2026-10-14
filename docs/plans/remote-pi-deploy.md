# 远程环境引导：远端 pi 部署设计

> 状态：v1（参考 ZCode deploy 机制，2026-10-13 调研）
> 范围：PiX P4「一键远程环境引导」——远端未安装 pi 时，从本地 pi 安装上传自包含 bundle 并在远端运行。
> 上游文档：`ssh-remote-project.md` §6 P4、`ssh-remote-p2-contracts.md`、`remote-backends-contract.md`

## 1. 背景与目标

PiX 已实现 SSH 远程连接（P1–P3）：连接管理、probe、信任流程、`spawn_remote`（远端启动 `pi --mode rpc`）、`ssh_sessions`。但远端未安装 pi 时，`ssh::payload::build_spawn_payload` 的 `command -v pi || exit 92` 直接失败，命令层归一化为 `sshRemotePiMissing`——用户必须手动在远端安装 pi。

本设计补齐 P4 的核心价值：**只要能 SSH 登录，PiX 就能自动引导远端 pi 环境并开启会话**，对齐 `ssh-remote-project.md` §1「远程主机部署成本尽可能低」的目标。

### 已验证事实（2026-10-13 实机）

- 本地 pi 的 `dist/bundle/` 自包含（8.8M），仅依赖 `node:` 内置模块与相对路径，无外部 `require`；复制到任意目录后 `node bundle/cli.js --mode rpc` 可正常响应 JSONL（`get_state` 返回完整会话状态）。
- pi 的 npm 包 bin 指向 `dist/bundle/cli.js`，`package.json` 的 `files` 含 `dist`。
- 测试服务器 `192.168.3.3`：Debian 12 / Linux 6.18 / x86_64 / node v24.21.0 / npm 11.19.0 / **pi 未安装** / docker 可用。

## 2. ZCode 参考机制

ZCode（`packages/server/src/remote/`）的远端部署方案：

1. **detect**：SSH exec `uname -s`/`uname -m` 探测平台架构。
2. **deploy**：按 manifest（逐组件版本 + SHA256）把 node 运行时 + `zcode-server` bundle 上传到 `~/.zcode/server/`；远端无需预装环境。
3. **deploy lock**：`remoteDeployLock.ts` 用远端 `mkdir` 原子锁 + owner token + heartbeat（30s）+ stale 回收（600s）串行化并发部署。
4. **launch**：SSH exec 启动远端 `zcode-server.cjs`，stdio 承载 RPC 帧。

PiX 采纳其**幂等（SHA256 跳过）+ 原子锁（mkdir）**内核，但简化组件模型：pi 本身即「远端 server」，bundle 自包含，无需逐组件 manifest 与 CDN。

## 3. 部署目标结构

远端（`$HOME` 为远端登录用户家目录）：

```text
~/.pix/pi/
├── bin/
│   └── pi            # wrapper：exec node <dir>/../bundle/cli.js "$@"
├── bundle/           # 本地 pi dist/bundle 内容（8.8M）
│   ├── cli.js
│   ├── cli-runtime.js
│   ├── index.js
│   └── chunks/
└── .deploy-info      # JSON：contentHash / version / platform / arch / deployedAt
```

- 与既有 `~/.pix/pi_data.mjs`（信任脚本）同目录族，命名空间一致。
- wrapper 用 `$(dirname "$0")/..` 定位 bundle，不硬编码 HOME：

```sh
#!/bin/sh
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$DIR/bundle/cli.js" "$@"
```

## 4. 部署流程

```text
ensure_pi_available(connection_id, endpoint)
  │
  ├─ 1. detect：exec PI_CHECK_SCRIPT
  │      ├─ PATH 中有 pi           → 返回 { piBin: <path>, deployed: false }（尊重用户安装）
  │      └─ ~/.pix/pi/bin/pi 存在  → 返回部署路径 + 读 .deploy-info
  │
  ├─ 2. 幂等判断（仅当需用部署版）
  │      └─ 远端 contentHash == 本地 contentHash → 跳过上传
  │
  └─ 3. deploy（必要时）
         ├─ 本地：定位 pi bundle → 计算 contentHash → 打包 tar.gz
         ├─ 远端：exec PI_DEPLOY_SCRIPT（stdin = tar.gz）
         │     ├─ 获取 mkdir 原子锁（含 stale 回收）
         │     ├─ cat > tmp.tar.gz；tar xzf -C ~/.pix/pi
         │     ├─ 写 wrapper + chmod +x
         │     ├─ 写 .deploy-info（含本地 contentHash）
         │     └─ 释放锁
         └─ 校验：exec 读回 .deploy-info，比对 contentHash
```

### 为什么先 detect 再上传

- PATH 已有 pi → 零上传、零部署（对齐用户「连接服务器上已经安装的 pi」）。
- 已部署且 hash 一致 → 跳过 8.8M 上传（幂等）。
- 仅在真正需要时传输，避免每次 spawn 的固定开销。

## 5. 幂等机制（SHA256）

本地 contentHash 必须是**确定性**的，否则每次启动都判定「不一致」而重复上传。tar.gz 因 mtime/顺序不同不可复现，故对 bundle **目录内容**取哈希：

```text
contentHash = SHA256(
  for each file in sorted(relative paths):
    relative_path + "\0" + SHA256(file_bytes) + "\n"
)
```

- 文件遍历按相对路径字典序排序，消除目录枚举顺序差异。
- 逐文件流式 SHA256（8.8M 量级，毫秒级），避免整体读入内存。
- `sha2` 已是 `Cargo.toml` 依赖（`sha2 = "0.11"`），无需新增。

`.deploy-info` 同时记录 `version`（本地 pi `package.json`）与 `platform`/`arch`（远端 `uname`），便于诊断；**跳过判断只依据 contentHash**（version 相同而字节不同也必须重传，对齐 ZCode 的 artifact-SHA 语义）。

## 6. deploy lock（跨进程串行化）

参考 `remoteDeployLock.ts`，用纯 POSIX `sh`（兼容 Alpine/BusyBox，不依赖 bash）：

```sh
LOCK="$HOME/.pix/pi.deploy.lock"
while ! mkdir "$LOCK" 2>/dev/null; do
  now=$(date +%s)
  mtime=$(stat -c %Y "$LOCK" 2>/dev/null || stat -f %m "$LOCK" 2>/dev/null || echo 0)
  if [ "$mtime" -gt 0 ] && [ $((now - mtime)) -ge 600 ]; then
    rm -rf "$LOCK"           # stale 回收（owner 崩溃遗留）
  fi
  sleep 1
done
trap 'rm -rf "$LOCK"' EXIT HUP INT TERM
```

- **进程内**再加 `tokio::sync::Mutex`（对齐既有 `UPLOAD_SERIAL`），减少同进程重复竞争。
- 锁覆盖「检测 → 解包 → 写标记」全程；持锁期间写 owner 文件并 heartbeat（可选，v1 用短临界区 + stale 兜底）。
- 锁内**重新读一次** `.deploy-info`（double-check），避免等待期间他人已完成部署。

## 7. spawn 集成

`build_spawn_payload` 增加部署版回退（保持 exit 92 语义为「PATH 与部署版都没有」）：

```sh
cd <project> || exit 90
echo "PIX_PI_PID=$$" >&2
PI_BIN=$(command -v pi 2>/dev/null)
if [ -z "$PI_BIN" ]; then
  PI_BIN="$HOME/.pix/pi/bin/pi"
  [ -x "$PI_BIN" ] || exit 92
fi
exec "$PI_BIN" --mode rpc ...
```

命令层 `commands/pi.rs::spawn_remote` 在 `rpc::spawn` **之前**调用 `ensure_pi_available`：

- 成功 → 继续 spawn（payload 回退逻辑自然命中部署版 pi）。
- 失败（如远端无 node）→ 返回 coded error，不进入 spawn。

进程内缓存 `(connection_id, endpoint) → 已确认可用`，避免每次 spawn 重复 detect；缓存键随端点要素变化（复用 `endpoint_cache_key` 的既有教训：连接编辑保留 id 但端点可变）。

## 8. 错误处理

新增 coded error（i18n 同步 `zh-CN` 与 `en`）：

| 场景 | errorKind | coded error |
| --- | --- | --- |
| 远端无 node（无法运行 bundle） | `remote` | `sshRemoteNodeMissing` |
| 部署上传/解包失败 | `remote` | `sshRemoteDeployFailed`（`{detail}`） |
| 本地 pi bundle 定位失败 | — | `piNotFound`（复用本地键） |
| PATH 与部署版都无 pi | `remote` | `sshRemotePiMissing`（复用，文案改为「自动部署失败」指引） |

远端脚本退出码（与既有 90/92/93/95/96 同族）：

| 码 | 含义 |
| --- | --- |
| 94 | 远端无 node |
| 95 | 写临时 tar 失败 |
| 96 | 目录创建/锁失败 |
| 97 | tar 解包失败 |
| 98 | 写 wrapper / .deploy-info 失败 |

## 9. 安全考量

- **不拼接 shell 命令**：远端命令一律经 `wrap_payload`（base64 + `/bin/sh -c`）+ argv 单元素传递（沿用 `ssh/mod.rs` 约定）。
- **凭据不落盘**：部署过程不接触密码/私钥；连接凭据仍走既有 config 与（未来 russh 阶段）OS 凭据服务。
- **tar 解包**：远端解包目标限定 `~/.pix/pi`，先 `rm -rf bundle` 再解包，避免旧文件残留；不信任 tar 中的绝对路径（本地生成，可控）。
- **wrapper 权限**：`chmod +x` 仅作用于 `~/.pix/pi/bin/pi`。
- **不覆盖用户 pi**：PATH 中已有 pi 时优先使用，绝不写入系统路径。

## 10. 分期规划

- **v1（本文档）**：远端有 node 时部署 pi bundle；PATH pi 优先；幂等 + 原子锁；spawn 集成。
- **v2**：远端无 node 时部署 node 运行时（对齐 ZCode `node-runtime` 组件，按平台/架构选 artifact）。
- **v2**：byte 级上传进度（`remote_exec_stream` 分块 + 进度事件）。
- **v3**：`npm install -g` 安装模式作为上传模式的替代（需远端网络）。

## 11. 测试策略

- **单元测试（Rust）**：
  - contentHash 确定性（同内容同哈希、文件顺序无关、单字节变化即变）。
  - tar 打包可被标准 tar 解出且内容一致。
  - `build_spawn_payload` 回退分支（PATH 命中 / 部署版命中 / 都缺失 → exit 92）。
  - 部署脚本标记与退出码常量。
  - 错误码映射。
- **实机集成测试（`cargo test ssh_real -- --ignored`）**：沿用既有环境变量约定，新增部署用例：
  - 部署到测试机 → `~/.pix/pi/bin/pi --version` 可运行。
  - 二次部署命中幂等（`.deploy-info` mtime 不变）。
  - 部署后 `spawn_remote` 成功启动 `pi --mode rpc` 并响应 `get_state`。
- 不为 SSH 交互新增 E2E（对齐 `AGENTS.md`）。

## 12. 验证计划（192.168.3.3）

1. `ssh_probe_target` 确认远端 node 存在、pi 缺失。
2. 触发 `ensure_pi_available` → 观察部署日志与耗时。
3. 远端 `~/.pix/pi/bin/pi --version`、`--mode rpc` + `get_state`。
4. 二次触发确认幂等（跳过上传）。
5. 经 PiX 前端添加远程项目并开启会话（端到端）。

## 13. 待确认项

- 本地 pi 定位来源：优先复用 `pi_locate.rs::detect`（尊重用户自定义 Pi 路径），bundle 目录由其 launcher 反推；自定义路径非 npm 布局时给出明确错误。
- 上传是否压缩：v1 用 gzip（`flate2`）降低 WAN 传输；本地打包 8.8M → 约 2.5M。
- 远端 node 版本下限：bundle 面向 Node ≥ 22（对齐 PiX 前置要求），低于下限报 `sshRemoteNodeMissing` 并附版本。
