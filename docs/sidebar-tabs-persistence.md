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
- `runtime:` → 文件键迁移时**不写回**（此时新键可能还没有内容，写回会删掉磁盘上已有的恢复载荷）。

## 4. 跨版本边界（P1 不能力协商）

`WorkspaceStatePatch` 在 Rust 侧是 `deny_unknown_fields`。因此：

- **前端与后端必须成对发布**。新前端向旧后端发送带 `sidebarTabs` 的 patch 时，
  整个 patch 会被拒绝（不只是丢这一个字段），该次写入的其它字段也一并失败。
- 反向（旧前端 + 新后端）安全：旧前端不发送该字段，新后端按"未出现"处理。
- P1 **不做**能力探测/降级。若不希望每次写入都可能整体失败，需要另立事项
  加"发送前探测后端字段集合"。

## 5. 上限与内存增长

- 单会话 **20 条**：上限落在 `addTab` 上（到 20 就**拒绝新增**并 toast 反馈）。
  不是"先加进去、写盘时截断"——那会让界面显示成功而重启后静默丢掉最新一个。
  落盘/读盘侧仍各自截断一次作为兜底。
- 会话组 **24 个**：`stores/sidebarTabs.ts` 的 `pruneGroups` 按 LRU 淘汰内存组，
  只丢内存、不删磁盘条目（重新打开该会话时再 hydrate）。仍被挂载的 `ChatView`
  通过 `retainGroup`/`releaseGroup` 持有，绝不淘汰。
  量级：每组最多 20 条 `{id, type, stale?}`（约几百字节），24 组 ≈ 十几 KB，
  不随会话数量线性增长。

## 6. 边界

- 只做 Tab 结构恢复，不把 `RightSidebar` 提升为 App 级驻留。
- `aux`（TZD-94 辅助对话）Tab 明确不落盘：写侧白名单直接丢弃，读盘时按未知 kind 丢弃，
  且只含未知 kind 的组会被整条丢弃（不报错，不影响其它组）。
- 后端 `normalize` 做**局部净化**（超限截断 / 全非法则丢该条 / `active` 越界与负数钳制），
  单条脏记录不会再让整个 `workspace.json` 读取失败；被污染的键也能用删除 patch 清掉。
