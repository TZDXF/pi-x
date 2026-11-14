# 右侧侧栏 Tab 持久化（TZD-95）

本文件记录右侧侧栏 Tab 恢复的**行为契约**与**跨版本边界**，实现见
`src/lib/sidebarTabs.ts`、`src/stores/sidebarTabs.ts`、`src/composables/useSidebarTabs.ts`
与 `src-tauri/src/commands/workspace_state.rs`。

## 1. 恢复什么

- 只恢复 **kind 顺序 + active 下标**，不恢复任何面板内容（review 选区、files 展开、
  browser URL/历史、终端进程）。按 00:59 口径。
- 落盘位置是 **`workspace.json`**（与项目/会话顺序同一个文件），字段 `sidebarTabs`：
  `{ "<会话身份键>": { "kinds": ["review", "files", "terminal"], "active": 2 } }`。
- 会话身份键：已落盘会话为 `project\0sessionFile`（远程项目用 `sessionIdentityKey` 的
  JSON 数组形态）；尚未落盘的草稿态为 `runtime:<runtimeId>`，会话文件首次出现时迁移。

## 2. terminal 一律 `stale`

两种情形都必须把 terminal Tab 标成 `stale`（只渲染占位，**不挂 `TerminalPanel`**）：

1. 从落盘恢复（`tabsFromPersisted`）；
2. 组件卸载（切会话、设置页往返）——`useSidebarTabs` 在 `onScopeDispose` 调
   `markGroupDetached`，因为 `TerminalPanel` 卸载时已 `term_kill`，shell 的存活前提已破。

理由：`TerminalPanel` 首次可见会自动开一个新 shell。若把"卸载后仍在注册表里的非 stale
terminal"当成活着的 shell，重挂载会静默新开一个 shell 并冒充"恢复成功"。

`stale` 是**瞬时 UI 状态**，不写进落盘（重启恢复时由 hydrate 自己置 stale）。
用户点"重新打开终端"= 显式清 `stale`（`restartTerminal`），也不写进落盘。

## 3. 不覆盖用户操作

- `addTab` 会先标记该组为 hydrated；异步落盘的 hydrate **只在未 hydrated 时**应用，
  因此"等落盘期间新加的 Tab"不会被旧载荷覆盖。
- 落盘监听**不是一次性**：`workspace.sidebarTabs` 可能被其他会话的更新先触发，
  一次性监听会被那次更新消耗掉，导致本会话稍后到达的载荷不再恢复。
- `runtime:` → 文件键迁移（`rebindGroup`）分两种语义：
  - **源非空**（用户已在草稿会话里加过 Tab）：迁移后**立即**用新身份键写回，并删除旧 `runtime:` 条目。
    不写的话磁盘上只剩草稿键，完整重启后 Tab 全丢。
  - **源为空**：**不写回**（新键可能已有磁盘载荷，写 `null` 会把它删掉），也不把新键标记 hydrated
    （否则随后到达的落盘条目会被 `isHydrated` 永久挡住）。
- 迁移**直接搬内存状态**，不经落盘载荷重建：重建会把 terminal 一律标 `stale`，而这条路径上
  `ChatView` 并没有卸载、shell 还活着，标失联就是伪造死亡。

## 4. 跨版本边界（P1 不能力协商）

`WorkspaceStatePatch` 在 Rust 侧是 `deny_unknown_fields`。因此：

- **前端与后端必须成对发布**。新前端向旧后端发送带 `sidebarTabs` 的 patch 时，
  整个 patch 会被拒绝（不只是丢这一个字段），该次写入的其它字段也一并失败。
- 反向（旧前端 + 新后端）安全：旧前端不发送该字段，新后端按"未出现"处理。
- P1 **不做**能力探测/降级。若不希望每次写入都可能整体失败，需要另立事项
  加"发送前探测后端字段集合"。

## 5. 上限、白名单与内存增长（TZD-96）

本分支落地四项 P2 加固（#14 / M1 已先行合并，本分支基于 `dev`，只含这些加固）。

- 单会话 **20 条**：上限落在 `addTab` 上（到 20 就**拒绝新增**并 toast 反馈）。
  不是"先加进去、写盘时截断"——那会让界面显示成功而重启后静默丢掉最新一个。
  拖拽排序入口（`reorderTabs`）同样截断，内存里始终 ≤20；落盘/读盘侧各截断一次作兜底。
- **写侧白名单**：`persistedFromTabs` 在本地丢掉 `aux` 与未知 kind，顺序是**先过滤再限额**
  （反过来会让前面的脏 kind 把后面的合法 kind 挤掉）。
- **Rust 宽容反序列化**：`SidebarTabs` 自定义 `Deserialize`，非对象/非数组/非数值按可读部分
  重建，`active` 解析期钳 0；`normalize` 先按白名单过滤再 `take(20)`。单条形状不合法
  只做局部净化，delete patch 也仍能删掉该脏键 —— 不会再让整份 `workspace.json` 读取失败。
- **内存组数 24 个**：`stores/sidebarTabs.ts` 的 `pruneGroups` 按 LRU 淘汰内存组，只丢内存、
  不删磁盘条目（重新打开该会话时再 hydrate）。形态：
  - 持有关系按**实例实际 retain 过的键**记录（`useSidebarTabs` 的 `heldKey`），换键时
    按记录配平。身份键变化不止 `runtime:` → 文件键一种 —— SSH realpath 回绑
    （`src/lib/workspaceRuntime.ts:149`）同样会在组件仍挂载时换键，两种情况都要配平，
    否则正在显示的组会失去保护、旧 alias 键引用还会永久泄漏。
  - **满额时 rebind 复用原名额**：`runtime:` → 文件键是**同一组换身份**，不是新建。
    `rebindGroup` 先删源键（位置已经腾出来）再落目标键，因此**不需要额外名额**，
    满额时也必须成功。顺序是"先迁移、后 retain 新键"；若反过来先为新键要名额，满额时
    会被准入挡回去 —— 一次身份变更就把"立即写回新身份键 + 清旧 `runtime:` 条目"整个
    跳过，那是回退而不是加固。只有"源不存在/为空"（没有内容可搬）才按常规准入争名额。
  - **建组前准入**（而不是先建后回收）：`ensureGroup` 先 `pruneGroups(上限 - 1)` 腾名额，
    腾不出才由调用方**排队**。因此 `sidebarTabRegistry.size ≤ 24` 是真不变量，
    不依赖"事后淘汰"的时序。
  - 准入覆盖所有会新建组的路径：`addTab`、`hydrateGroup`、`retainGroup`（挂载）、
    `reorderTabs`；`tabsFor`/`activeIdFor` 读取**不建组**。
  - **`hydrated` 只在真写成内容之后提交**：`addTab` 先准入、写进一条 Tab 才 `markHydrated`；
    `hydrateGroup` 填充成功才标。准入失败时该键**仍是"未确定"**（或载荷进队列）——
    绝不会出现"没有组却已 hydrated"，那种状态会让迟到的磁盘载荷被 `isHydrated` 永久
    挡住、同次运行内重挂载也恢复不回来。
  - **两份队列，语义不同**（不要合并）：
    - `pendingRetain`（FIFO）：会话**正在挂载**但没名额建组。名额一空出就补准入，
      该会话侧栏**原地自愈**，用户不需要切走再切回；
    - `pendingHydrate`：**载荷到了**但没名额建组。名额空出后补 hydrate。
      两者都由 `releaseGroup` / `pruneGroups` 腾位时 flush，且各自防重入。
  - **迟到载荷建组即被持有**：`hydrateGroup` 成功后调 `admitPendingRetain`，
    把该键排队中的挂载请求一并承认（`liveRefs` 一起补上），避免"正在显示却没人持有、
    下一次 LRU 就被淘汰"。补 hydrate 恢复出来的组因此天然受保护。
  - **被拒的挂载会排队、可撤销**：`retainGroup` 腾不出名额时登记 FIFO 请求而不是终态
    失败 —— 名额一空出（`releaseGroup` / `pruneGroups` 腾位）就回调 `onAdmit`，该窗格
    的侧栏**原地自愈**，用户不必切走再切回。排队请求按**发起实例**（`owner`）归属：
    卸载时撤销该实例排队过的**所有键**（身份键可能变过），不会给一个已卸载实例建组、
    留下 `retain=1` 且无人释放的永久占位。
  - `pruneGroups` 返回实际腾出的组数（腾不出返回 0）。全部组都被挂载持有时它腾不出
    名额，此时**新挂载排队**（组数仍是 ≤24），而不是把上限放成 30。
  - **有界极限**：`≥24` 个 pane 同时挂载时，新打开会话的侧栏会**排队**到有 pane 关闭。
    这是有界、可自愈、不丢数据的状态 —— 关掉任意一个 pane 后该会话侧栏自动可用，
    磁盘载荷在排队期间也不会被删除。
  - 量级：每组最多 20 条 `{id, type, stale?}`（约几百字节），**内存组数硬上限 24**，
    因此总量有界（≈ 十几 KB 加两份待处理队列），不随会话数量线性增长。

## 6. 边界

- 只做 Tab 结构恢复，不把 `RightSidebar` 提升为 App 级驻留。
- `aux`（TZD-94 辅助对话）Tab 明确不落盘：写侧白名单直接丢弃，读盘时按未知 kind 丢弃，
  且只含未知 kind 的组会被整条丢弃（不报错，不影响其它组）。
- 后端 `normalize` 做**局部净化**（超限截断 / 全非法则丢该条 / `active` 越界与负数钳制），
  单条脏记录不会再让整个 `workspace.json` 读取失败；被污染的键也能用删除 patch 清掉。
