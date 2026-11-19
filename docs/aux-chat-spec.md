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
- 能力探测（TZD-104 的调用点与缓存单测见 §11）：同可执行文件/同 PATH 规则下完整参数起 RPC、25s 内收到 `get_state` 成功且无 `sessionFile`、stdin EOF 后 20s 内 exit 0；失败即 `auxPiUnsupported`，禁止去 flag 重试。探测通过只证明"选项集被接受"，**不证明白名单生效**。探测结果**本地缓存**键 = program_id + version + flags_hash，TTL 10 分钟 + 部署后失效（与模型侧前缀缓存无关，本规格不主张任何前缀缓存收益）。**失败不入缓存**（同一条命令下次仍会真探一次，既不是"假通过"，也不是"去 flag 重试"）。

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

| #   | 文件                                           | 实现                                                             | 验收                                                                    |
| --- | ---------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | `src/lib/promptContexts.ts:32`                 | 剥离/重组该前缀块，首发与读回共用                                | 单测四种输入；序列化与解析互逆                                          |
| 2   | `src/stores/session/history.ts:150`            | 重建 user entry 存完整 prompt + 拆分后的可见正文                 | `loadHistory` 后 parentContext 有值、visibleText 无块；老历史不变       |
| 3   | `src/components/chat/ChatUserPrompt.vue:32/88` | 气泡**不渲染**该块（TZD-119 移除了折叠块）；复制只用 visibleText | 复制字符串不含 `<aux_parent_context>`；气泡无 `data-aux-parent-context` |
| 4   | `src/composables/usePromptEdit.ts:62/93`       | P1：aux **仅改显示、不重发**；主会话保存时块原样保留             | 块字节不变；aux 下 transport 零写入（无 `rewind_prompt`）               |
| 5   | `src/lib/conversationTimeline.ts:89/105`       | 两处摘要用 visibleText                                           | question 不含块；rank/entryId 对齐不变                                  |

**编辑重发**：`session.ts:499` 必发 `rewind_prompt`（M0 拒绝、aux 无文件）→ P1 不做，不绕过。"内存会话的编辑重发"（追加修正 prompt 而非回滚）列为后续事项。

## 5. 生命周期

- Tab 注册表模块级 `src/stores/auxChat.ts`（键 runtimeId，含 parentRuntimeId/clientId/tabId/ordinal），`ChatView` 挂载时 hydrate；切父会话 Pane 卸载、store 与进程存活，回切重建。`force-mount + v-show` 只保证同父组件内隐藏不卸载。槽位 id 由各父会话分别从 1 分配，显示、标题、未答标记必须按 `parentRuntimeId + tabId` 联合查找，不能用裸 tabId 全局匹配。
- **槽位恢复按类型、不按数字 id**（TZD-131）：`aux` 槽位永不落盘，侧栏组被 24 组容量 LRU 淘汰后重挂载时，落盘的普通 Tab 会**重新分配** 1..n 的 id —— 可能与存活实例记着的旧 `tabId` 撞号（先 aux(1) 再 files(2)，重挂载后 files 拿 1）。`useAuxTabs` 的 `restoreSlots` 因此以“该 id 上确实是一个 `aux` 槽位、且未被同父会话的另一个实例认领”为判据补槽位（未被认领的现存 `aux` 槽位优先复用，避免旧 id 被普通 Tab 顶掉时多出一格空槽），关闭与划词路由（`closeTab` / `activeAuxTab`）同样按「**本父会话 + 本组槽位**」解析：本组没有该槽位或坐的是普通 Tab 时只撤槽位、不发 kill（不按裸 id 查全局实例表 —— A、B 的首个 aux 也都是 `id=1`，否则重复关闭或过期手势会误关另一会话的存活实例）；坐的是 `aux` 槽位时先同步撤槽位（TZD-130），再按已解析实例的 `runtimeId` 关进程；否则恢复后 aux 没有入口，关闭同号普通 Tab 会发出 `kill(aux)` 中断用户对话。常驻用例：`tests/aux-slot-restore.test.ts`。
- **异步创建收尾不用旧槽位 id**（TZD-131）：`addAux` / `openForAsk` 会等到 spawn/handshake 完成，期间身份键变化会重排槽位，创建时捕获的 id 可能已属于普通 Tab 或已不存在。因此成功时按实例**当前** `tabId` 验证“本组 aux 槽 + 该实例占据”后才激活；失败或已在途被关闭时只撤“仍为 `aux` 且无实例认领”的格，绝不按旧 id 删普通 Tab 及其落盘布局。
- **组获准后重试补槽位**（TZD-131 收尾）：构造期补不上不是终态 —— 组数满时 `addSidebarTab` 返回 `null`，而组可能稍后才被**延迟准入**（`useSidebarTabs` 的排队回调）。`useSidebarTabs` 因此在组获准且带上落盘载荷后回调 `onGroupAdopted`，`useChatViewSidebar` 把它接到 `aux.restoreSlotsNow` 幂等补一次；否则存活 aux 会在侧栏无任何入口（既看不到也关不掉）。回调必须晚于 hydrate，否则刚补的 aux 槽位会被 `hydrateGroup` 的整表重建覆盖。缺槽仍不 kill。
- **满槽补不上就收回槽位号**（TZD-131）：单个侧栏组最多 20 条，换键/淘汰重挂载时若组已满，补不上槽位的实例保留进程与 store（缺槽不 kill），但把 `tabId` 置为 `null` —— 它因此**退出**按槽位的显示/关闭查找，不会用旧号被后来的新建撞上（同父同号会让显示/关闭都命中旧的、新的没有入口）。名额一空出（关闭普通/aux Tab）先给这些实例补格，再允许新建；`addAux` / `openForAsk` 在有人等槽时优先补回它并回报该实例。
- **投递前只看当前组入口**（TZD-131）：实例表里的 `tabId` 是"上一次分配到的号"，组被淘汰/排队/换键后与当前组无关。判据是接线层注入的 `AuxAskRouter.entry(tab)`（**必填**：槽位存在 + 类型为 `aux` + 由该实例占据，读的是**当前侧栏组**）；**没有当前 router 即视为无入口，不设实例表兜底** —— 父 `ChatView` 卸载后 router 已注销，正是"不能投递"的状态。候选过滤（`auxDeliverableFor`）、显式 target、自动路由以及**异步新建返回后**的收尾都走它，且异步返回后问的是**当前** router（已重挂载且入口有效则正常投递）。无入口一律 `unavailable`、不写引用桶；等位实例的进程、草稿与自动补槽保留（不为腾位杀既有对话）。
- 草稿仅内存 `src/stores/auxDrafts.ts`（不写 localStorage、不改 `composerDrafts`）；附件保留原始 `File`，blob URL 由 `PromptInput.onBeforeUnmount` revoke。
- 引用按 runtime 分桶 `src/stores/auxSelections.ts`，捕获/展示/发送/清理同源；主会话 `useChatSendControl` 的 clear 时机不变。
- 回收（TZD-104 落地位置见 §11）：不续期探针（不经 `RpcState::process`，不刷 `last_activity`；`last_user_activity` 只在 prompt/steer/follow_up 更新）+ 租约（`aux_claim/aux_release` 心跳 20s，**租约 TTL 90s**：停心跳的条目在 claim/list/reap 任一入口惰性过期，过期只让 `claims` 归零、仍由 30 分钟空闲门槛兜底）+ 三条件（非流式非待答无在途 ∧ 无未过期租约 ∧ 空闲 >30 分钟）。判定与 kill 在租约表同一把锁内仲裁（`begin_reap` 置 `reaping` 墓碑，`claim` 见墓碑即 `auxLeaseReaping`）；`aux_release` **只认 lease token**，clientId 只是标识不是凭证。`aux_*` 只注册为宿主命令（桌面 `lib.rs` + 远程 dispatch），**不进 JSONL 白名单**，不写 stdin、不改 policy。
- 销毁：墓碑 → 取消计时器 → `session.clear()` → `ui.clear()` + 补 `toasts`/`toastTimers`/`pendingEditorText`/`responding` → 清草稿与引用桶 → `rpc_kill` → 释放租约 → store `$dispose()` + Pinia state。迟到 `pi://exit`/事件走 `auxStore.get(id)`，墓碑命中丢弃，不 `sessionFor` 重建。创建中的实例同步入表，关闭置 `cancelRequested`。
- 对话框：`ExtensionDialog` 传 aux `session-id`；`StatusBar` 只展示；隐藏 Tab 不渲染弹框并出未答标记；有 timeout 由 `activity.rs` 过期，无 timeout 关闭时先发 `cancelled`；aux 的 `notifyQuestion`/`notifyTurnComplete`/`setTitle` 静默。
- 资源：单进程空闲基线约 138MB RSS（实测，非峰值）；实例数量不设辅助对话专属上限，通用侧栏容量与 30 分钟空闲回收规则不变。artifacts 上限 200 条 / 32 MiB（含 before+after），超限丢最旧并标记；单文件 2 MiB（`pix-file-changes.js:6`）。`pix-file-changes` 只跟踪成功的 `edit`/`write`，bash/powershell 改文件不产卡。**远程 aux 不承诺差异卡**（`rpc.rs:303` 仅 LocalPi 注入）。

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
| 实例注册表（Tab/序号/关闭销毁、clientId）                           | `src/stores/auxChat.ts`                                                   |
| 纯逻辑（前缀、序号分配）                                            | `src/lib/auxRuntime.ts`                                                   |
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

**④ 落地后这几处的实到位置**（原"为 TZD-104 预留"，现已被 TZD-104 消费，非死代码）：

- `AuxTab.clientId` / `currentAuxClientId()`：租约归属（`aux_claim`/`aux_release` 按它
  记名）与重连恢复（只恢复本机 clientId 条目，见 §11）。**不另生成第二份标识**。
- `activeAuxFor` / `closeAllFor`：划词复用与"父会话关闭即销毁"（§5/§10 已在用）。
- `auxLiveCount` / `auxModelTargetKey` / `hasConversation`：仅测试与诊断使用，可接受。

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
   `aux` 槽位永不落盘（`persistedFromTabs` / `normalizePersistedSidebarTabs` 的白名单只含 review/files/terminal/browser）。辅助对话不设专属实例上限，通用侧栏 20 条 / 24 组规则不变。

## 9. 上下文取材与折叠块（TZD-102 落地）

§3/§4 的实现落点与两处**写法差异**（差异是事实记录，不是等价说明）：

| 职责                                                                           | 文件                                     |
| ------------------------------------------------------------------------------ | ---------------------------------------- |
| 归一化、锚点截断、32k 整组丢弃、块拼装/剥离（零依赖）                          | `src/lib/auxParentContext.ts`            |
| 三源取材（只打父 runtime；`get_entries` → `get_messages` → `session_history`） | `src/lib/auxContextCollect.ts`           |
| “只注入首轮”记账（模块级，按 aux `runtimeId`）                                 | `src/stores/auxContext.ts`               |
| 面板接线（`streaming` 读父 store 实时值）                                      | `src/composables/useAuxParentContext.ts` |
| 首轮拼块（`serializeComposerPromptContexts` 的 `parentContext`）               | `src/composables/useChatSendControl.ts`  |
| 边界提醒（`--append-system-prompt` 常量）                                      | `src-tauri/src/rpc/aux_launch.rs`        |

**提交判据**：`live:true` 不作为判据（最终消息同样标 live）。已提交由来源身份定义 ——
`get_entries` 的 entry id 集合（同时用于给 `get_messages` / `session_history` 的
`_entryId` 过滤）；流式半轮既没有 entry，也会被“最后一条已提交 user 之后全部排除”的
锚点切掉。父会话在流式时该锚点生效，非流式时整段已提交对话都保留。

**两处差异**：

1. §3 写“兜底顺序：`get_entries` → `session_history`”。实际是 `get_entries` →
   `get_messages` → `session_history`：`get_entries` 返回空（无已提交输入）或失败时才
   下探，`get_messages` 是压缩投影语义的备选（规格 §3 也列了它），文件兜底最后。
2. §4 的成块顺序：块在 prompt **最前**，`get_entries` 侧的重建则把块从可见正文里剥出、
   存进 `UserEntry.parentContext` / `parentContextBlock`（**气泡不显示该块**、复制只用可见
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

## 10. 划词入口与引用分桶（TZD-103）

两个入口共用**同一份**浮层（`src/components/chat/ConversationSelectionMenu.vue`），
只新增动作，锚点/翻转/钳制算法与 document 级监听一字未改：

| 入口         | 挂载点                                                | 模式   | payload                                             |
| ------------ | ----------------------------------------------------- | ------ | --------------------------------------------------- |
| 会话正文划词 | `ChatTurnList.vue`（`ChatView` / `AuxChatPane` 共用） | `chat` | `{text, source, messageId, startOffset, endOffset}` |
| 文件预览划词 | `ProjectFilePreview.vue`（代码视图与渲染态 Markdown） | `code` | `{text, path, lineRange?}`                          |

- 代码模式下"引用到输入框"不出现（批注仍走行号栏的 gutter 拖拽/按钮）；渲染态
  Markdown 没有 `[data-line]`，此时只带 `path`，不猜行号。
- 内置浏览器 iframe 内的划词**不做**（跨域，需扩 `preview_proxy` bridge，另列）。

**引用按 runtime 分桶**（`src/stores/auxSelections.ts`）：`Map<runtimeId, entries>`，
键是 aux 自己的 `runtimeId`（一实例一桶，不需要 scope 漂移判断）；主会话继续用
`stores/conversationSelections.ts` 的单例，语义不变。`projects` 级 `codeComments`
**不被 aux 消费**（aux 的发送控制 `contexts: "aux"` 一律视为空）。

**路由**（`stores/auxChat.ts` 的 `askInAux`）：**入口优先** —— 先确认该父会话的
router 存在，再谈复用与新建；router 不存在（父 `ChatView` 已卸载）返回 `unavailable`
且**不写任何桶**。入口可用时：没有 aux → 新建后投递；只有一个 aux → 直接复用；
**有多个 aux → 浮层先展开目标选择，列出全部已有对话与"新建辅助对话"，用户选择后才
投递**。已有目标按 runtimeId 精确匹配且必须属于当前父会话，失效选项不落到其他实例；
辅助对话不设专属实例上限，"新建辅助对话"始终可点。选择已有或新建成功后都激活对应槽位。
连点同一手势只建一个实例（`pendingCreations` 复用 + `appendConversationSelection` 判重）。
入口缺失/新建未完成/引用超限各有一次用户可见提示（`lib/auxAsk.ts`）。aux 面板内的划词仍
直接进本实例，不弹目标选择。

**来源身份与本地定位**（P2-4/P2-5）：桶条目带 `sourceRuntimeId`（手势发生在哪个会话）。
消息 `messageId`/字符区间只在该 runtime 里有意义，因此 aux 正文的选区恢复与索引徽标
只在 `sourceRuntimeId === 本面板 runtimeId` 时生效；跨 runtime（含未标注的旧条目）一律
不猜位置（只在摘要里列出）。文件来源引用（`{path, lineRange}`，无 `messageId`）没有可
定位正文，但编辑动作仍给一个可用的视口锚点（摘要里的"编辑"不会点了没反应）。
`AuxChatPane` 的 `ChatComposer` 必须接 `@locate-selection` / `@edit-selection` 到
`ChatTurnList` 已 expose 的 `locateSelection` / `editSelection`，否则动作在子组件 emit
处中断。

**浮层定位**（P2-1；TZD-129 复审补充实测高度）：锚点仍是 `selectionEndRect`
（多行取最后一行），间距 4px、左边距 8px、四个 document 级监听与控件内选区排除不变；
横向钳制使用浮层**实测宽度**（左缘不早于 8px、右缘不超出视口），纵向翻转使用
**实测高度**。下侧空间不足且上侧可容纳时翻转；两侧都不足时钳制在视口内，目标选择
列表另设 `100vh - 16px` 最大高度与纵向滚动，保证上下边缘处已有目标和新建均可操作；
菜单内部滚动保持当前选择，外部内容滚动仍关闭菜单。1280px 视口右缘划词时双按钮整体在
视口内；1000×600 视口底部三目标、1000×180 矮视口两处入口的真实滚轮均有浏览器回归。

**`ProjectFilePreview` 的两个根**：模板是 `<section>` + 覆盖层浮层（fragment 下 Vue 3
**不再自动继承 attrs**），因此显式 `defineOptions({ inheritAttrs: false })` 并把
`v-bind="$attrs"` 只绑到 section；否则调用方的 `data-package-resource-preview` 与
`class` 会静默丢失（`e2e/package-resources.spec.ts` 会红）。

**发送与清理同源**（`composables/useChatSendControl.ts`）：`contexts` 从
`"shared" | "none"` 扩为 `"shared" | "aux" | "none"`；`"aux"` 读本桶、序列化仍走
`serializeComposerPromptContexts`（`# userselect:` 契约不变），发送成功后**只清本桶**
（与主会话的 clear 时机同源，含延迟发送）；`abort` 不清（文本可由停止按钮恢复）。关闭
实例（`closeAux`）与迟到收尾（`settleLateAux`）都清本桶。

验收用例：`tests/aux-selection-buckets.test.ts`（桶隔离/去重键/8000·8·16000/clear）、
`tests/aux-send-control.test.ts`（prompt 组装含 `# userselect:`、只清本桶、批注不消费、
abort 不清）、`tests/aux-selection-routing.test.ts`（入口优先 / 单实例复用 / 多实例精确选择 / 新建 /
失效目标 / 去重 / 清桶时机）、`tests/aux-selection-menu.test.ts`（浮层两模式、多实例选择与既有算法不变）、
`tests/aux-selection-placement.test.ts`（实测宽度钳制 + 右缘 ≤ 视口 + 翻转阈值）、
`tests/aux-selection-local.test.ts`（跨 runtime 不定位 / 同 runtime 可定位 / 文件来源可编辑）、
`tests/aux-selection-entries.test.ts`（两处入口接线、`$attrs` 单根回归、摘要定位/编辑接线）。

## 11. 生命周期、租约与孤儿回收（TZD-104 落地）

§1 能力探测与 §5 生命周期的实现落点：

| 职责                                                               | 文件                                                       |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| 不续期探针（独立用户活动时钟、只读、不写 stdin）                   | `src-tauri/src/rpc/aux_probe.rs`                           |
| 用户活动时钟的更新点（`accept_command`，只认三个 type）            | `src-tauri/src/rpc.rs`（`ProcessState.user_activity`）     |
| 活跃/待答判据（`RuntimeActivity::busy` / `pending_ui_count`）      | `src-tauri/src/rpc/activity.rs`                            |
| 租约本体（写/删/列、TTL 过期、lease token 续租校验、reaping 仲裁） | `src-tauri/src/aux_leases.rs`                              |
| `aux_claim` / `aux_release` / `aux_list` 宿主命令                  | `src-tauri/src/commands/aux_leases.rs`                     |
| 三条件判定 + 60s tick + 待重试 kill 句柄表 + `aux-reap` 日志       | `src-tauri/src/aux_reap.rs`                                |
| 终止的总 deadline（含**取锁**）与 `pi://exit` 幂等                 | `src-tauri/src/rpc/child.rs`（`process_kill_confirming`）  |
| 后端双客户端场景脚本（§6 f/g 的可重跑部分）                        | `src-tauri/src/aux_lifecycle_scenarios.rs`                 |
| 桌面注册（`generate_handler` + setup 启动回收器）                  | `src-tauri/src/lib.rs`                                     |
| 远程注册（`dispatch/session.rs`，同一实现、同一认证）              | `src-tauri/src/remote/dispatch/session.rs`                 |
| 探测缓存 TTL / 失败不入缓存                                        | `src-tauri/src/rpc/aux_launch.rs`（`cache_get_at`）        |
| 心跳（模块级，20s）、lease token 记账、关闭顺序、重连归属过滤      | `src/stores/auxChat.ts`                                    |
| 租约条目的宽容解析与过滤规则（纯函数）                             | `src/lib/auxLease.ts`                                      |
| 重连恢复接线（只在 `aux_list` 承认的条目上做 pending UI 恢复）     | `src/lib/workspaceRuntime.ts`（`reattachRunningSessions`） |

**不续期探针为什么必须绕开 `RpcState::process()`**：那个函数每次都会
`last_activity.insert(now)`（`rpc.rs` 的池级表，供 `schedules.rs` 的
`SCHEDULE_RUNTIME_TTL` 判"前端是否已 attach"）。探针若复用它，`get_state` 级别的只读
调用就会把空闲判据永久推后，30 分钟回收永远不成立。落点因此是：
`ProcessState.user_activity`（`std::time::Instant`，spawn 时初始化）+ 只在
`prompt`/`steer`/`follow_up` 三个 type 于 `accept_command` 里 `note()`。
`note()` 在 `permit.send()` 之后调用（"真的写进 stdin 才算用户活动"），且不与
`inner`/`activity` 的守卫重叠（锁序仍为 `inner` → `activity`；`user_activity` 单独一把）。

**租约只做三件事**：写 / 删 / 列。入参只有 `{runtimeId, clientId}`（claim）与
`{runtimeId, leaseToken}`（release），不接收
`command`/`extraArgs`，不写 stdin，不改 `policy`，不起进程。入口校验两条：
`runtimeId` 必须 `aux:` 前缀，且该 runtime 的 `policy` 必须是 `Aux`（**Main 拒绝**，
前缀不是权威来源 —— 单靠前缀挡不住"把主会话 id 改成 aux:xxx 再来领租约"）。
校验走 `aux_probe` 的只读通道（`policy_of`/`running_quiet`），因此 20s 心跳**不会**
顺带刷新池级 `last_activity`。

**伪造归属**：`release` 只删本客户端那一条，不持有即 `auxLeaseNotHeld`（不是静默成功）；
不存在的 runtime → `auxLeaseDenied`；空/超长 `clientId` → `auxLeaseClientIdInvalid`。
一个 runtime 可被多个 clientId 同时持有（分屏/双窗口），回收判据看的是"这个集合是否为空"。

**回收三条件**（`aux_reap::is_reclaimable`，同时成立才 kill）：
`busy == false && pending_ui == 0 && in_flight == 0` ∧ `claims == 0` ∧ `idle > 30 分钟`。
`in_flight` 取 `SessionInner.pending` 长度（在途请求），`pending_ui` 用
`RuntimeActivity::pending_ui_count`（先按 deadline 过期，与 `get_state` 快照同一规则）。
每 60s 扫一遍 `aux:` 前缀，命中时 `logs::write("aux-reap", …)` 带
`{runtimeId, parent, claims, idleSecs, probe{…}}`，随后 kill 并清掉该 runtime 的租约。
"进程已消失但租约还在"（客户端崩溃、没发 release）同样在这一轮清掉，日志
`reason: "lease-without-process"`；**残条不是"上一轮 live 快照的差集"**，而是逐个对
**当前实例**复核（旧差集会把扫描期间新建并 claim 的实例误删）。

**租约 TTL 与过期（§5 的补充）**：每条租约是 `clientId → { token, renewedAt }`，
TTL = `AUX_LEASE_TTL` = **90s（4.5 个 20s 心跳）**，容忍连续漏 2–3 拍。心跳即续期；
过期在 `claim`/`list`/`reap` **任一入口惰性清理**（无额外定时器）。

**心跳漏拍时会发生什么（精确口径，别读成"睡多久以内都安全"）**：过期只让该条目从租约
表消失，于是 `claims` 归零。**漏拍本身不会判死实例** —— 回收仍要另外两个条件
（`busy/pending_ui/in_flight` 全空，且 `last_user_activity` 距今 > 30 分钟）。

但**空闲门槛看的是"用户活动"，不是"睡了多久"**：睡前已经累计的空闲同样计入。所以

- 新实例 / 睡前只闲置几分钟：醒来后租约虽已过期，可立即重新 `claim`（该 clientId 的
  条目已被摘掉，算首次领取、签发新 token），`claims` 回到 1，实例存活。
- **已经空闲接近或超过 30 分钟的 Tab**：停跳哪怕只有 100 秒，只要回收器先于心跳跑一轮，
  就会被回收。这是规格 §5"**用户活动**超过 30 分钟即回收"的**预期结果**，本规格不给
  唤醒宽限（团队裁定，见本节末尾"已知边界"）。

换句话说：漏拍不会**自己**导致回收，但"漏拍 + 累计空闲已超阈"会。不要把它写成
"只有睡过 30 分钟才回收"的一般结论。

**租约凭证（§5 的补充）**：`aux_claim` 返回**服务端签发的 lease token**，`aux_release`
只认 token。`aux_list` 只回 `clientId` + `parentRuntimeId`（重连过滤用），**从不回
token**。

**续租也必须出示 token（复审第二轮 P1-2）**：`aux_claim` 入参有**可选** `leaseToken`。
条目已存在时：token 匹配 → 续租并返回**同一个** token；没带或不匹配 →
`auxLeaseConflict`，**绝不回吐已存在的 token**（否则"公开 clientId → claim → 拿 token
→ release"就是完整劫持链）。只有**首次** claim（该 clientId 在此 runtime 上还没有有效
条目）才签发新 token。

不采用"单纯轮换 token"：攻击者轮换后自己拿着新 token 照样能 release，还把受害者的合法
凭证作废，等于既没修归属、又制造了新的可用性问题。

**页面重载丢 token 的前端行为**：`aux_claim` 回 `auxLeaseConflict` 时**不重试、不停用
Tab**（实例与进程都还活着），前端进入 `AUX_LEASE_TTL_MS`（90s）静默窗口，窗口过后自动
再试 —— 届时旧条目已被后端惰性摘掉，这次算首次领取、签发新 token 成功。

**但这期间不保证"不会被回收"**：丢 token 之后**心跳保护被撤掉**，而原 Tab **已经累计的
空闲仍然计入**。若它接近/超过 30 分钟（**符合规格的空闲 Tab**），只要回收器先于心跳跑
一轮，该实例就会被正常回收 —— 这是 §5"用户活动超过 30 分钟即回收"的预期结果，规格不给
唤醒宽限（见本节末尾已知边界）。

**clientId 的可信来源（取舍，未做）**：本轮**没有**把 clientId 绑到宿主侧身份（桌面恒为
本地、远程用连接/会话 id）。理由是改动会跨桌面 `lib.rs`、远程 dispatch 与前端三处，而
当前方案已经把"clientId 不是凭证"这条**结构性**堵住（续租要 token、释放要 token、list
不回 token）。

**残余风险（如实）**：**首次** claim 不校验调用者身份。同一宿主上能调用 `aux_list`
的代码（= 同一控制面权限）可以：`aux_list` 取某个 clientId → 若该条目已过期/不存在，
用该 clientId **首次** claim 拿到新 token → 再 release，把 `claims` 归零。若原 Tab 的
用户活动已超过 30 分钟（**符合规格的空闲 Tab**），下一轮扫描就会回收它。即：
**伪装成原持有者抢先领取会阻挠原持有者恢复心跳**（竞争组被回收、无竞争对照恢复后仍活，
质量工程师已独立复现）。这不击穿"持续有效租约"的保护（有效租约期间无法抢占），且它
要求的正是"已可直接 `rpc_kill`"的宿主权限（规格 §2 明确 aux 只保 pi 的控制面，不是
invoke 沙箱）。真正的宿主级身份绑定留待有远程目标时一起做。

**回收仲裁（§5 的补充）**：判定与 kill 之间有并发窗口，因此在**租约表同一把锁内**
先复核 holders 为空并置 `reaping` 墓碑（`begin_reap`），放锁后才 kill。`claim` 在锁内
见墓碑即 `auxLeaseReaping`；墓碑是**该 runtime 的永久标记**（runtimeId 一实例一个
UUID、永不复用），因此"刚判定为空、kill 前又被领走"不可能发生。

**kill 失败必须可重试（复审第二轮 P1-1）**：`rpc::kill` 是"先从池里摘掉、再杀"，杀失败
也回 `Ok`；回收器若照抄这个语义，失败就会被记成"已回收"，第二轮连对象都找不到（质量
复现 `attempts=1, alive=true, pool=0, reaping=true, first_reported=1`）。

取舍：**不改 `rpc::kill` 的"先摘后杀"**（那条路同时服务 `kill_all`/`schedules`/
`closeAux`/远程 dispatch，改它要重新论证所有主路径的失败语义）。回收器改用自己的
**待重试句柄表**（`aux_reap::PENDING_KILLS`，`runtimeId → Arc<ProcessState>`）：

1. `try_kill(handle)` = `process_kill` 成功**且** `running()` 为假 → `Exited`，否则
   `RetryPending`。两条都要，因为 Windows taskkill 非零退出会被 `child::kill_inner`
   记日志后转成 `Ok`，只看返回值不够。
2. `Exited` 才 `retire_entry`（摘池 + 清池级时钟 + `forget` 租约）并 `push Reaped`；
   `RetryPending` 把句柄留在表里、日志记 `reason: "kill-retry", result: "pending"`、
   **不 push `Reaped`**。
3. 每轮扫描**先**处理待重试表（池里可能已被 `rpc::kill` 摘掉，只有这张表还握着句柄），
   再走常规判定；确认退出后移出表，否则句柄会泄漏。
4. `process_kill` 失败时把 `SessionInner` 放回 `ProcessState`（不 `take` 掉），否则
   `running()` 会因 `inner == None` 误判"已退出"，重试无从谈起。
5. 故障注入：`child::FAIL_NEXT_KILLS`（`#[cfg(test)]`）+ `aux_probe::fail_next_kills(n)`，
   回归 `a_failed_kill_is_retried_and_only_counted_once_the_process_is_gone` 与
   `repeated_kill_failures_never_report_a_reap`。

**终止事件只在确认退出后提交（复审第四轮 P1-1/P1-2）**：`child::process_kill` 现在

1. **先**置"这是主动 kill"的意图位（不发事件、不动代际）；
2. 调 `kill_inner`：**所有阶段共享一个总 deadline**（默认 5s，退出路径 500ms）——
   远程 `kill -TERM`、OS 终止命令（`taskkill`/`start_kill`）、`child.wait()` **确认退出**
   各段都从这份 budget 里扣，耗尽即判失败（不是"每段单独 5s"）；
3. 只有**确认退出**之后才 `commit_exit`：递增代际 + 发 `pi://exit`，且按
   `RuntimeActivity::has_exited` 去重（stdout reader 的 EOF 与 kill 的确认可能同时到，
   `pi://exit` 只发一次；主动 kill 期间的 EOF 记 `idle`，不是 `error`）；
4. 任一步失败（taskkill 非零、启动失败、`start_kill` 失败、确认超时）：**不递增代际、
   不发 exit、不清 pending**，把 `SessionInner` 放回 `ProcessState`（进程仍被追踪，
   重试才有对象）。`inner == None` 不再是"已退出"的依据。

`kill_all`（`RunEvent::Exit` 里 `block_on`）用 `process_kill_fast`：**总 deadline 500ms
/ 实例**（覆盖远程段 + OS 终止段 + 确认退出，不是只压最后那段 wait），且单条失败只记
日志、不中断循环 —— 最坏约 N×500ms，不会像分段超时那样"远程 5s + taskkill 无超时"把
退出拖住。OS 终止命令的 helper 进程设 `kill_on_drop(true)`，超时后由它收掉，不会变成
新的孤儿。

**取锁顺序与修改时机（复审第七轮）**：`process_kill_confirming` 固定 **先 `inner`、
后 `activity`**（与 `process_spawn_impl` 同一锁序），并且**两把锁都拿到之后才动共享
状态**（`mark_expected_stop()` 与 `take` 都发生在这一步）。上一版是"先置意图位、
再取 `inner`"，`inner` 超时后必须回头**无 budget** 地重取 `activity` 去撤销，于是 500ms
预算被打到 2083ms。现在：

- `inner` 抢不到 → 直接失败，**一行共享状态都没改**（无需撤销）；
- `activity` 抢不到 → 归还 `inner` 守卫（不 take）后失败，仍未改动；
- 收尾（提交 exit / 撤销意图位）也用 `timeout(remaining, …)`：**绝不无界等待**。

**停止意图优先于精确终止原因**：若收尾那次取 `activity` 也超 budget，会**保留**
`expected_stop = true` 并记日志。此时后续 EOF 会被记成 `idle` 而不是 `error` —— 因为
"我们确实已经请求过终止"，而不代表我们精确识别了终止原因。质量工程师确认这个窗口
**真实可达**（worker 可能在 OS kill 尚未执行时自行退出），但无害：进程确实已退出、
`pi://exit` 只发一次，不会把活进程判死。

**退出路径的取锁也受同一总 deadline 约束**：`process_kill_confirming` **先取 `inner`
锁、再取 `activity` 锁**（锁序与 `process_spawn_impl` 一致），**两把锁都用
`timeout(剩余 budget, lock())`**。否则另一条默认 kill 在跑 OS 命令期间持有 `inner`
（最长 5s）时，退出路径会白等满 5s（复审第六轮实测 N=1 4946ms）。抢不到锁即按"未确认
终止"失败：**一行共享状态都不动**（`inner` 不 take、意图位不置）、不 `commit_exit`，
由 `kill_all` 记日志后继续下一个实例。

> **早期版本的 `activity` → `inner` 顺序已废弃**（复审第七轮）：那个顺序要求"先置意图位
> 再取 `inner`"，`inner` 抢不到就必须回头无 budget 地重取 `activity` 去撤销，500ms 预算
> 被打到 2083ms。现在的顺序是"**先取锁、再改共享状态**"。

**`inner == None` 的幂等分支**：此时 `inner` 守卫与 `activity` 守卫**都仍在手上**，
撤销意图位与提交 `pi://exit` 直接使用这把 activity 守卫完成 —— **不再回头取锁**
（复审第八轮：旧版在这里调 `has_spawned_once()` 裸取 activity，实测 2001ms）。

**退出路径不做后台重试**：`kill_all` 会 `take` 整个进程池并 `clear_pending_kills()`，
所以退出时的终止失败**只记日志、不再重试**（也不跨启动恢复）—— 这些 Child 由**本次**
的 `kill_on_drop` 尽力终止。`respawn`（丢弃旧句柄）用 `deadline = None`，不引入额外等待。

**已知边界（团队裁定，不是缺陷）**：

1. **唤醒/漏拍时序**：已空闲 1 小时的 Tab 停跳 100 秒后被回收是**符合 §5** 的（门槛是
   "用户活动"，不是"这次睡了多久"）。规格不给唤醒宽限；用户可见的表现是"切回去时 Tab
   已销毁、重开是全新实例"，与"关闭即销毁、不保存历史"一致。
2. **首次 claim 不校验身份**：见上文"残余风险"。要求宿主控制面权限（该权限已可直接
   `rpc_kill`；规格 §2 明确 aux 只保 pi 的控制面，不是沙箱）。表现是"过期窗口内被抢先
   领取会阻挠原持有者恢复"。不做宿主级身份绑定（等有远程目标时一起做）。
3. **退出路径不重试**：`kill_all` 结束时就清空了待重试表（`take` 池 + `clear_pending_kills`），
   退出阶段的终止失败只有日志；残留 Child 由本次进程的 `kill_on_drop` 尽力终止，内存表
   **不跨启动恢复**，因此"下次启动收尾"不是保证。
4. **永久 kill 失败**：某个实例的 kill 一直无法确认退出时，它会在回收器的待重试表里
   长期保留（一份 `Arc<ProcessState>` 句柄），并在租约侧一直回 `auxLeaseReaping`
   （前端已进退避，不再每 20s 打一次）。这是**有意的**：宁可留下一条可重试句柄，也不
   假装已回收（假装会在孤儿进程与"日志显示已回收"之间制造矛盾）。

5. **远程三项未验（缺远程环境）**：远端 `probe_remote`、Web→远程 aux 的实际启动参数、
   远程 `aux_*` 的运行期归属/认证，本机无可用 SSH/WSL/Docker 目标，**本轮未验**；只有
   单测与静态路由断言（`web_dispatch_routes_aux_lease_commands_to_the_host_commands`）。
   按团队裁定以"本地范围收口"，这三项标注为未验、不作为本单完成的前置。

**重连归属**（第 4 条）：`reattachRunningSessions` 先调 `aux_list`，只对
`clientId == 本机 && parentRuntimeId 在本地注册表` 的条目恢复 pending UI 与流式标记；
其余条目**不动**（不改状态、不 kill），交给回收器。本机条目里"实例已不在本地表"的
（本页已关闭过）立即释放租约，让回收器可以回收那个进程。

**前端心跳的落点**：`stores/auxChat.ts` 模块级（不在 `AuxChatPane`）——
切父会话时 Pane 卸载、进程与 store 存活，心跳必须继续，否则 30 分钟后用户切回去
只剩一个死壳。只在存在 `aux:` 条目时跑；关掉最后一个实例即停表。关闭实例的顺序是
**先 `aux_release` 再 `rpc_kill`**，迟到收尾（`settleLateAux`）同样先释放租约。

**与规格正文的两处写法差异**（事实记录）：

1. §5 的功能实现写在 `src-tauri/src/aux_reap.rs` 与 `src-tauri/src/aux_leases.rs` 两个
   新模块，而不是全部塞进 `rpc.rs`；`rpc.rs` 只改三处：`ProcessState` 增两个字段、
   `accept_command` 转录用户活动、`kill`/`kill_all` 连租约一起清。
   §5 原文只写了"心跳 20s"，没有写过期与凭证；本轮补的 TTL/惰性过期、lease token、
   reaping 仲裁三条写进本节（属**补充**，不是对 §5 的重写）。
2. §1 写的缓存键"flags_hash"落地为 `probe_fingerprint(program_id, args, version)` 的
   全量串（含 `--append-system-prompt` 文本），未做哈希；TTL 判定改为可注入时间的
   `cache_get_at`，单测因此能钉住 10 分钟边界而不用真等。

**后端双客户端场景脚本（§6 f/g 的自动可重跑部分）**：`src-tauri/src/aux_lifecycle_scenarios.rs`
（`#[cfg(test)]`），用**真实长命子进程 + 真实租约表 + 两个模拟客户端**跑完整时序：

```text
cargo test --manifest-path src-tauri/Cargo.toml --lib aux_lifecycle_scenarios -- --nocapture
```

4 个用例、每条打印可粘贴的步骤（`[aux-lifecycle NN] …`）：① A 释放 + B 心跳到 31 分钟
→ 只回收 A；② 同一实例双客户端持有，A 释放后 B 仍持有则不回收、B 也停跳才回收；
③ `aux_list` 的归属字段够前端做重连过滤、且不含 token（拿他客户端 clientId 释放被拒）；
④ 客户端崩溃 → TTL 过期但空闲未到 → 不回收，31 分钟后才回收。GUI 双窗口手工留成员验收，
本脚本只证明后端状态机。

**证据边界（如实）**：`aux_*` 的远程 dispatch 覆盖与 `aux_spawn` 同级，仍是
**静态路由断言**（`web_dispatch_routes_aux_lease_commands_to_the_host_commands`），
运行期覆盖需要 `AppHandle<MockRuntime>`（`rpc::spawn`/`aux_spawn`/
`builtin_extensions` 全部绑定 `AppHandle<Wry>`）。真实 pi 上的能力探测只在本机实测过
（1.5.2：合法 argv 通过、`--future-flag` 返回 `Error: Unknown option` 且 exit 1），
远端探测（`probe_remote`）**本轮没有可用的 SSH 目标，未实测**。
