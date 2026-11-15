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

| #   | 文件                                            | 实现                                                 | 验收                                                              |
| --- | ----------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | `src/lib/promptContexts.ts:32`                  | 剥离/重组该前缀块，首发与读回共用                    | 单测四种输入；序列化与解析互逆                                    |
| 2   | `src/stores/session/history.ts:150`             | 重建 user entry 存完整 prompt + 拆分后的可见正文     | `loadHistory` 后 parentContext 有值、visibleText 无块；老历史不变 |
| 3   | `src/components/chat/ChatUserPrompt.vue:32/126` | 折叠块默认收起；复制只用 visibleText                 | 复制字符串不含 `<aux_parent_context>`                             |
| 4   | `src/composables/usePromptEdit.ts:62/93`        | P1：aux **仅改显示、不重发**；主会话保存时块原样保留 | 块字节不变；aux 下 transport 零写入（无 `rewind_prompt`）         |
| 5   | `src/lib/conversationTimeline.ts:89/105`        | 两处摘要用 visibleText                               | question 不含块；rank/entryId 对齐不变                            |

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

| #   | 场景                                                                       | 覆盖                   |
| --- | -------------------------------------------------------------------------- | ---------------------- |
| a   | 草稿不落盘；主会话同项目草稿不被覆盖                                       | 单测 + 手工            |
| b   | 引用互不消费；aux 桶与主桶独立                                             | 单测                   |
| c   | 结构命令被拒 + stdin 零写入 + 无新 session 文件；Main 对照成功             | Rust 单测              |
| d   | 执行类放行且**真有 stdin 写入**（防假放行）                                | Rust 单测              |
| e   | `set_steering_mode` 等 5 条被拒；`set_thinking_level` 放行且 settings 不变 | Rust 单测              |
| f   | 重连只恢复本机 clientId + 父匹配；他客户端不被杀                           | Rust 单测 + 双窗口手工 |
| g   | 活跃流/待答/有租约不被回收                                                 | Rust 单测 + 手工       |
| h   | 关闭与 spawn 竞态：无孤儿进程、无可见 Tab、迟到 exit 不复活                | 单测 + 手工            |
| i   | 折叠块五处落点逐项                                                         | 单测/组件测试          |
| j   | 只注入首轮：第 2/3 轮无前缀                                                | 单测                   |
| k   | 流式中取材三源快照（文件无 partial、store 有、`get_messages` 无 partial）  | 夹具（本地 stub）      |
| l   | 劫持：默认发现成功 / `--no-extensions` 不可达 / 显式 `-e` 仍触发           | 夹具                   |
| m   | 远端能力不足 `auxPiUnsupported`，不降级重试                                | Rust 单测 + 手工       |

## 7. 已知约束与后续事项

- **约束违规记录（事实，已在 issue 记录）**：为设 `cacheWarming=off` 曾临时修改全局 `~/.pi/agent/settings.json`，跑完已删除该键并校验复原；仍属违反"不动全局配置"。后续同类实验**必须**使用独立 `PI_CODING_AGENT_DIR`。
- 本机 provider 仅 `home`/`LongCat-2.5` 可用，其余 503，实验结论均带此前置。
- 后续：内存会话编辑重发；远程差异卡物化；任意扩展放开的生命周期约束；右侧 Tab 整体持久化（TZD-95）。

## 8. 前端落地（TZD-101）

本规格的前端主体落在以下文件（与 §2.1 的 M0 后端落点对应）：

| 职责                                                                | 文件                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 实例注册表（Tab/序号/上限 5/关闭销毁、clientId）                    | `src/stores/auxChat.ts`                                                   |
| 纯逻辑（前缀、上限、序号分配）                                      | `src/lib/auxRuntime.ts`                                                   |
| 草稿（仅内存）                                                      | `src/stores/auxDrafts.ts` + `src/composables/useAuxDraft.ts`              |
| `aux_spawn` 前端调用（独立字段，无拼接）                            | `src/api/client/process.ts` 的 `spawnAuxPi`                               |
| 启动上下文（继承模型/工作区/SSH 连接）+ 逐段判活的 `initAuxSession` | `src/lib/auxLaunch.ts`（纯逻辑）+ `src/lib/auxSpawn.ts`（调用）           |
| 侧栏接线（槽位 ↔ 实例、`closeAux`）                                 | `src/composables/useAuxTabs.ts` + `src/composables/useChatViewSidebar.ts` |
| 面板                                                                | `src/components/aux-chat/AuxChatPane.vue`                                 |
| aux 事件分流（墓碑丢弃，绝不重建 store）                            | `src/lib/auxEventSink.ts` + `src/lib/workspaceRuntime.ts`                 |

**维护待办（`ChatView.vue` 规模护栏 500 行）**：`ChatView` 的侧栏接线已整体搬进
`src/composables/useChatViewSidebar.ts`（TZD-101），行数 498 → 491。再往这个视图里
加侧栏/面板相关代码就该先抽 composable，**不要抬** `tests/chat-turn-list.test.ts` 的
500 行护栏；若还需继续瘦身，下一步是把 TZD-95 的 `useSidebarTabs` 接线也搬走
（属 TZD-95 范围，需单独授权）。

**为 TZD-104 预留 / 兜底说明**（本轮不清，非死代码）：

- `activeAuxFor` / `closeAllFor` / `AuxTab.clientId`：④ 的租约（`aux_claim/aux_release`
  按 clientId 归属）与重连恢复（只恢复本机 clientId 条目）要用；
- `auxLiveCount` / `auxModelTargetKey` / `hasConversation`：仅测试与诊断使用，可接受；
- `RightSidebar` 的 `aux-limit` 事件：名额已满时入口本就禁用，该事件是"用户仍点到
  禁用态"的可执行提示兜底，实际几乎不可达但保留。

与规格正文的**两处写法差异**（**非等价**：§5 的 `cancelRequested` 语义由下面的机制实现）：

1. §2.1 写作 `src-tauri/src/rpc/aux.rs`，M0 实际落地为 `src-tauri/src/rpc/aux_launch.rs`（本事项未改后端）。
2. §5 "关闭置 `cancelRequested`"：不新增该字段，语义由三个机制承担。

   **(a) 墓碑 + 唯一收尾函数**。`closeAux` 首先写墓碑（`closedAuxIds`）并把实例从表里
   摘除；此后所有迟到路径（`spawnAuxPi` 返回、`init` 抛错、面板重试）都先走同一个
   `settleLateAux(runtimeId)`，判据只有一条：**墓碑命中 _或_ 实例已不在表里**。命中时
   `rpc_kill` + 拆掉可能残留的 store，**不建 store、不写实例状态、不推 UI**。
   迟到路径上的 store 读取一律用**只查不建**的 `auxSessionExisting`（`auxSessionFor`
   是"缺席即创建"，只允许在"实例已登记且存活"的路径上调用，否则迟到返回会把关闭时
   已释放的 store 重建出来）。`spawnAuxRuntime` / `retryAuxSpawn` 的**入口**同样先过
   一次 `settleLateAux`，拿着已关闭实例的旧引用再调也起不了第二个进程。

   **(b) kill 不幂等、只拆 store 幂等**。每次命中都真调一次 `bridge.kill`
   （`rpc_kill` 对不存在的 runtime 无害）；幂等只用于拆 store（`sweptStores`：
   `auxSessions`/`auxUis`/`pinia._s`/`$dispose`）。原因：迟到的 spawn 可能在第一次
   收尾**之后**才真正把进程拉起来，若 kill 也被幂等挡掉，那一次就耗尽了额度，后面
   落地的进程永远杀不到（上一版 `lateSettled` 就是这么漏的，实测 kill 次数不变、
   进程仍活）。

   **(c) init 期间逐段判活**。`lib/auxSpawn.ts` 的 `initAuxSession(session, project)`
   取代公共 `session.init()`（后者原子地 `Promise.all(4 段) → applyConfiguredModes →
refreshThinkingLevels → applyRememberedSelection`，关闭落在首批飞行中时尾部照样
   打到一个已 kill 的 runtime）。它每段之间查一次 `settleLateAux`，命中立刻返回、
   **不进入**后续段；跳过的两段是 `applyConfiguredModes`（`set_follow_up_mode` 在
   Aux 策略里被拒，且写 pi 全局 settings）与 `applyRememberedSelection`（aux 的
   provider/model 由启动 argv 继承父会话）。验收判据：关闭之后对该 runtime **零**
   续发 RPC（`tests/aux-spawn-close.test.ts` ① 断言 `get_available_thinking_levels`
   零调用且 RPC 日志不再增长；①d 是不关闭的对照，证明尾部确实会发）。

   **对公共 `stores/session.ts` 的唯一改动是加宽导出**：`refreshThinkingLevels` 原本
   只在 store 内部用，`initAuxSession` 需要逐段调用它，因此进了 store 的返回值；
   `init()` 本身一行未改（主会话行为不变）。
   `aux` 槽位永不落盘（`persistedFromTabs` / `normalizePersistedSidebarTabs` 的白名单只含 review/files/terminal/browser），上限 5 是 `auxChat` 自己的计数，与侧栏 20 条 / 24 组无关。

## 9. 上下文取材与折叠块（TZD-102 落地）

§3/§4 的实现落点与两处**写法差异**（差异是事实记录，不是等价说明）：

| 职责 | 文件 |
| --- | --- |
| 归一化、锚点截断、32k 整组丢弃、块拼装/剥离（零依赖） | `src/lib/auxParentContext.ts` |
| 三源取材（只打父 runtime；`get_entries` → `get_messages` → `session_history`） | `src/lib/auxContextCollect.ts` |
| “只注入首轮”记账（模块级，按 aux `runtimeId`） | `src/stores/auxContext.ts` |
| 面板接线（`streaming` 读父 store 实时值） | `src/composables/useAuxParentContext.ts` |
| 首轮拼块（`serializeComposerPromptContexts` 的 `parentContext`） | `src/composables/useChatSendControl.ts` |
| 边界提醒（`--append-system-prompt` 常量） | `src-tauri/src/rpc/aux_launch.rs` |

**提交判据**：`live:true` 不作为判据（最终消息同样标 live）。已提交由来源身份定义 ——
`get_entries` 的 entry id 集合（同时用于给 `get_messages` / `session_history` 的
`_entryId` 过滤）；流式半轮既没有 entry，也会被“最后一条已提交 user 之后全部排除”的
锚点切掉。父会话在流式时该锚点生效，非流式时整段已提交对话都保留。

**两处差异**：

1. §3 写“兜底顺序：`get_entries` → `session_history`”。实际是 `get_entries` →
   `get_messages` → `session_history`：`get_entries` 返回空（无已提交输入）或失败时才
   下探，`get_messages` 是压缩投影语义的备选（规格 §3 也列了它），文件兜底最后。
2. §4 的成块顺序：块在 prompt **最前**，`get_entries` 侧的重建则把块从可见正文里剥出、
   存进 `UserEntry.parentContext` / `parentContextBlock`（气泡默认收起、复制只用可见
   正文、编辑重发原样拼回块）。历史重建仍用同一个解析器
   `parseComposerPromptContexts`，因此首发/读回不会漂。

**身份判据（rev.2 补）**：`get_entries` 成功且**非空**时它的 entry id 集合是三路的权威
判据；`get_entries` 失败或返回空（`leafId: null`、尚无已提交条目）时**不**把"无集合"
当成"全部已提交"，另两路改为**来源自证**（每条消息必须自带 `_entryId`），无 id 的消息
一律丢弃。`get_entries` 成功但为空按"无权威集合"处理 —— 否则会把随后已落盘的文件内容
过滤掉（实测竞态）。结果里的 `identity`（`authoritative`/`source`/`none`）用于诊断。

**回落顺序（rev.2 补）**：`get_entries` → `get_messages` → `session_history`，历史返回
null / 抛错 / 被身份过滤空之后**再取一次** `get_entries`（竞态常在几十毫秒内自愈），
仍无内容才收口成空提示；`attempts` 记录实际调用次数（测试断言 `history ≥ 1`、
`entries ≥ 2`）。并发首轮按先来先得：同一 aux 的后续提交等领头采集落地再发，后续轮次
不排队；采集 reject 时如实提示（`chat.parentContextFailed`）后不带块发送。

**已知代价（如实）**：父上下文前缀在后续每一轮都作为历史**全价**重发，本事项不主张任何
前缀缓存收益；32k 是硬护栏。`overLimit`（单轮自身超限）时整组保留、不按字符切断工具
调用与结果配对 —— 护栏宁可略微超限，也不制造互不配对的历史。
