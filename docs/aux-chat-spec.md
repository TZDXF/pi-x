# Aux Chat 规格（rev.4 收口版）

基线 `dev@205f536`，pi 1.5.2。本规格为实现唯一依据，取代 rev.2 A/B、rev.3、rev.4 历史版本。

## 1. 启动 argv

```
--mode rpc --no-session                    # 由 aux_extra_args 唯一产出（本地与远程共用）
--no-extensions                 # 唯一与主会话不同权点；连带移除内置 MCP / codemode / tool_search
-e <pix-file-changes.js>        # 仅本地；与主会话同一条 builtin_file_changes 开关（关闭则整项不注入）；远程分支不注入
-e <pix-workspace.js>           # 仅当父会话有 workspace manifest
-e builtin:llama.cpp            # 仅当继承模型 provider 为 llama.cpp
--provider <p> --model <m> [--thinking <l>]   # 继承父会话 state.model/thinkingLevel
# 不传 --tools / --exclude-tools / --no-mcp / --no-skills / --no-prompt-templates /
#      --no-themes / --no-context-files / --approve / --no-approve
```

- 同权口径：工具与主会话同权（edit/write/bash/powershell），trust 用 pi 自己判定（`trust.json` + `defaultProjectTrust`），cwd = 父会话 cwd（远程用父 remote_path）。
- **不承诺完整工具集**：`--no-extensions` 使 `mcp`/`codemode`/`tool_search` 缺失，`llama`/`mcp` 命令消失；llama.cpp provider 需 `-e builtin:llama.cpp` 回补。
- 代价：已 trusted 项目的本地扩展**不会**在 aux 自动加载。
- `--session-dir <aux 临时目录>` 仅作纵深防御（让意外持久化落到可清理位置），**不构成保证**：挡不住 `switchSession` 指向既有文件。
- 能力探测：版本表（`AUX_MIN_PI`）+ 同可执行文件/同 PATH 规则下完整参数起 RPC、25s 内收到 `get_state` 成功且无 `sessionFile`、stdin EOF 后 20s 内 exit 0；失败即 `auxPiUnsupported`，禁止去 flag 重试。探测通过只证明"选项集被接受"，**不证明白名单生效**。探测结果**本地缓存**键 = program_id + version + flags_hash，TTL 10 分钟 + 部署后失效（与模型侧前缀缓存无关，本规格不主张任何前缀缓存收益）。

## 2. M0：RPC 网关（`rpc.rs` 的 request/notify 单一入口，按 `ProcessState.policy` 判定）

允许：`prompt` `steer` `follow_up` `abort` `clear_queue` `compact` `get_state` `get_messages` `get_session_stats` `get_commands` `get_available_models` `get_available_thinking_levels` `get_entries` `get_tree` `get_last_assistant_text` `set_model` `cycle_model` `set_thinking_level` `cycle_thinking_level`

拒绝：`fork` `clone` `new_session` `switch_session` `export_html` `set_session_name` `rewind_prompt` `get_fork_messages`、未知 type、以及 **`set_steering_mode` `set_follow_up_mode` `set_auto_compaction` `set_auto_retry` `abort_retry`**（实测写 agent `settings.json`，会改主会话行为）。

`rpc_notify` 仅放行 `extension_ui_response`。策略在 spawn 时写入 `ProcessState`，本地/远程同一结构（`rpc.rs:360` 唯一构造点），客户端无法翻转。命令层另堵：`session_endpoint`/`session_duplicate` 对 aux 返回 `auxRpcDenied`；内部 rename（`rpc::set_session_name` → `sessions/edit.rs:22`）对 aux 跳过。口径：**只保 aux pi 的控制面**，不是桌面 invoke 沙箱。

### 2.1 M0 落地位置（本 PR）

- `src-tauri/src/rpc/policy.rs`：`RuntimePolicy { Main, Aux }` + 允许/拒绝清单 + `guard_request`/`guard_notify`，含单元测试。
- `src-tauri/src/rpc.rs`：`ProcessState.policy`（唯一构造点写入）；`request`/`notify` 入口 guard；`spawn` 增 `policy` 参数并在 aux 下跳过 PiX 扩展注入、校验 `--session` 互斥；`session_endpoint` 对 aux 拒绝；`set_session_name` 循环跳过 aux。
- `src-tauri/src/rpc/child.rs`：`build_spawn_args` 增 `ephemeral`，aux 追加 `--no-session`。
- `src-tauri/src/rpc/aux.rs`：aux argv 组装（代码常量白名单）、探测缓存指纹、本地/远程能力探测、`auxRpcDenied`/`auxPiUnsupported` 归类。
- `src-tauri/src/commands/pi_aux.rs`：`aux_spawn`（本地/远程两条路径都写入 `RuntimePolicy::Aux`），runtimeId 必须 `aux:` 前缀。
- `src-tauri/src/remote/dispatch/session.rs`：`aux_spawn` 远程同权入口。
- `src-tauri/src/rpc/gateway_tests.rs`：拒绝零写入 / 执行类真写入 / Main 对照 / endpoint 与 rename 绕过。

## 3. 上下文取材与截断

前置已实测：`--no-session` 下 `get_entries` 可用（一轮对话前 2 条、后 11 条，`leafId` 有值），因此兜底走 `get_entries` 不依赖落盘。

主路径：**父 runtime（Main 策略）`get_entries` + `leafId→parentId` 重建已提交活动分支**。备选：`get_messages`（压缩投影语义）。兜底：`session_history`（`sessions.rs:713` 已按 parentId 回溯活动分支，不把 JSONL 全行当当前分支）。

截断规则（三源同一）：以**本轮已提交的 realUser** 为锚点，**排除其后**所有 assistant/toolResult；不是"删掉全部 assistant/tool 只留 user 文本"。32k 护栏按**整组**丢弃（user + 其后 assistant/tool 一起），不按字符切。

三类情形：
1. 确实尚无已提交输入 → 只带选段 + 顶部提示；
2. 已提交但文件暂不可读（`sessionFile` 已预留、文件未落盘，实测存在）→ 回落 `get_entries`；
3. 读取竞态失败 → 回落 `get_entries`。
后两类**不得**降级为"未取到父上下文"。`live`/乐观插入**不作为**提交判据，锚定到已接纳的 entry 身份。

**只注入首轮**：父上下文只写在 aux 第一条 user 消息；按 aux runtimeId 记 `contextInjected`，`entries` 已有 user 则永不拼块（单测断言第 2/3 轮 promptText 不含 `<aux_parent_context>`）。

**成本**：父上下文前缀在后续每轮作为历史全价重发，**不主张任何缓存收益**（实验为顺序执行、互相污染，只能记作"该供应商该时段行为"，不可作因果结论；`cacheWrite` 全 0，`cacheRate` 实际退化为 `cacheRead/(input+cacheRead)`）。32k 上限是硬护栏，其理由正是这个全价成本。

## 4. 折叠块 (b)：五处落点

格式（置于 prompt 最前）：`<aux_parent_context>…</aux_parent_context>` + 空行 + 提问正文。

| # | 文件 | 实现 | 验收 |
| --- | --- | --- | --- |
| 1 | `src/lib/promptContexts.ts:32` | 剥离/重组该前缀块，首发与读回共用 | 单测四种输入；序列化与解析互逆 |
| 2 | `src/stores/session/history.ts:150` | 重建 user entry 存完整 prompt + 拆分后的可见正文 | `loadHistory` 后 parentContext 有值、visibleText 无块；老历史不变 |
| 3 | `src/components/chat/ChatUserPrompt.vue:32/126` | 折叠块默认收起；复制只用 visibleText | 复制字符串不含 `<aux_parent_context>` |
| 4 | `src/composables/usePromptEdit.ts:62/93` | P1：aux **仅改显示、不重发**；主会话保存时块原样保留 | 块字节不变；aux 下 transport 零写入（无 `rewind_prompt`） |
| 5 | `src/lib/conversationTimeline.ts:89/105` | 两处摘要用 visibleText | question 不含块；rank/entryId 对齐不变 |

**编辑重发**：`session.ts:499` 必发 `rewind_prompt`（M0 拒绝、aux 无文件）→ P1 不做，不绕过。"内存会话的编辑重发"（追加修正 prompt 而非回滚）列为后续事项。

## 5. 生命周期

- Tab 注册表模块级 `src/stores/auxChat.ts`（键 runtimeId，含 parentRuntimeId/clientId/tabId/ordinal），`ChatView` 挂载时 hydrate；切父会话 Pane 卸载、store 与进程存活，回切重建。`force-mount + v-show` 只保证同父组件内隐藏不卸载。
- 草稿仅内存 `src/stores/auxDrafts.ts`（不写 localStorage、不改 `composerDrafts`）；附件保留原始 `File`，blob URL 由 `PromptInput.onBeforeUnmount` revoke。
- 引用按 runtime 分桶 `src/stores/auxSelections.ts`，捕获/展示/发送/清理同源；主会话 `useChatSendControl` 的 clear 时机不变。
- 回收：不续期探针（不经 `RpcState::process`，不刷 `last_activity`；`last_user_activity` 只在 prompt/steer/follow_up 更新）+ 租约（`aux_claim/aux_release` 心跳 20s）+ 三条件（非流式非待答无在途 ∧ 无租约 ∧ 空闲 >30 分钟）。`aux_*` 只注册为宿主命令（桌面 `lib.rs` + 远程 dispatch），**不进 JSONL 白名单**，不写 stdin、不改 policy。
- 销毁：墓碑 → 取消计时器 → `session.clear()` → `ui.clear()` + 补 `toasts`/`toastTimers`/`pendingEditorText`/`responding` → 清草稿与引用桶 → `rpc_kill` → 释放租约 → store `$dispose()` + Pinia state。迟到 `pi://exit`/事件走 `auxStore.get(id)`，墓碑命中丢弃，不 `sessionFor` 重建。创建中的实例计入上限（5），关闭置 `cancelRequested`。
- 对话框：`ExtensionDialog` 传 aux `session-id`；`StatusBar` 只展示；隐藏 Tab 不渲染弹框并出未答标记；有 timeout 由 `activity.rs` 过期，无 timeout 关闭时先发 `cancelled`；aux 的 `notifyQuestion`/`notifyTurnComplete`/`setTitle` 静默。
- 资源：单进程空闲基线约 138MB RSS（实测，非峰值）；上限 5 → 约 0.75GB 空闲基线。artifacts 上限 200 条 / 32 MiB（含 before+after），超限丢最旧并标记；单文件 2 MiB（`pix-file-changes.js:6`）。`pix-file-changes` 只跟踪成功的 `edit`/`write`，bash/powershell 改文件不产卡。**远程 aux 不承诺差异卡**（`rpc.rs:303` 仅 LocalPi 注入）。

## 6. 验收矩阵

| # | 场景 | 覆盖 |
| --- | --- | --- |
| a | 草稿不落盘；主会话同项目草稿不被覆盖 | 单测 + 手工 |
| b | 引用互不消费；aux 桶与主桶独立 | 单测 |
| c | 结构命令被拒 + stdin 零写入 + 无新 session 文件；Main 对照成功 | Rust 单测 |
| d | 执行类放行且**真有 stdin 写入**（防假放行） | Rust 单测 |
| e | `set_steering_mode` 等 5 条被拒；`set_thinking_level` 放行且 settings 不变 | Rust 单测 |
| f | 重连只恢复本机 clientId + 父匹配；他客户端不被杀 | Rust 单测 + 双窗口手工 |
| g | 活跃流/待答/有租约不被回收 | Rust 单测 + 手工 |
| h | 关闭与 spawn 竞态：无孤儿进程、无可见 Tab、迟到 exit 不复活 | 单测 + 手工 |
| i | 折叠块五处落点逐项 | 单测/组件测试 |
| j | 只注入首轮：第 2/3 轮无前缀 | 单测 |
| k | 流式中取材三源快照（文件无 partial、store 有、`get_messages` 无 partial） | 夹具（本地 stub） |
| l | 劫持：默认发现成功 / `--no-extensions` 不可达 / 显式 `-e` 仍触发 | 夹具 |
| m | 远端能力不足 `auxPiUnsupported`，不降级重试 | Rust 单测 + 手工 |

## 7. 已知约束与后续事项

- **约束违规记录（事实，已在 issue 记录）**：为设 `cacheWarming=off` 曾临时修改全局 `~/.pi/agent/settings.json`，跑完已删除该键并校验复原；仍属违反"不动全局配置"。后续同类实验**必须**使用独立 `PI_CODING_AGENT_DIR`。
- 本机 provider 仅 `home`/`LongCat-2.5` 可用，其余 503，实验结论均带此前置。
- 后续：内存会话编辑重发；远程差异卡物化；任意扩展放开的生命周期约束；右侧 Tab 整体持久化（TZD-95）。
