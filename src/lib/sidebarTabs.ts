/**
 * 右侧侧栏 Tab 的纯逻辑：类型、持久化载荷规整、从载荷重建 Tab。
 *
 * 与 Vue/Pinia 无关，便于 `test:web` 直接覆盖；响应式状态在 `stores/sidebarTabs.ts`，
 * 持久化字段经由 `workspace.json`（见 `lib/workspaceState.ts`）。
 */

/** 本轮接入的四种 kind。`aux` 属于 TZD-94，读盘时按"未知 kind"丢弃。 */
export const SIDEBAR_TAB_KINDS = ["review", "files", "terminal", "browser"] as const
export type SidebarTabKind = (typeof SIDEBAR_TAB_KINDS)[number]

export interface SidebarTabItem {
  id: number
  type: SidebarTabKind
  /**
   * 恢复出来的 terminal Tab：曾经开过 shell，但进程已不在。
   * 这类 Tab 只渲染占位，绝不挂 `TerminalPanel`（否则会自动开一个新 shell）。
   */
  stale?: boolean
}

/** 写盘载荷：只存 kind 顺序与 active 下标，不含任何面板内容。 */
export interface PersistedSidebarTabs {
  kinds: SidebarTabKind[]
  active: number
}

/** 单会话最多保留的 Tab 数，超出直接截断（与 `MAX_OPEN_CONVERSATIONS` 同量级）。 */
export const MAX_SIDEBAR_TABS = 20

export function isSidebarTabKind(value: unknown): value is SidebarTabKind {
  return typeof value === "string" && (SIDEBAR_TAB_KINDS as readonly string[]).includes(value)
}

/**
 * 规整落盘载荷：丢弃未知 kind（含 TZD-94 的 `aux`）、去重、截断到上限、
 * 并把 `active` 钳到合法下标。返回 `null` 表示该条目没有可恢复内容。
 */
export function normalizePersistedSidebarTabs(value: unknown): PersistedSidebarTabs | null {
  if (!value || typeof value !== "object") return null
  const raw = (value as { kinds?: unknown; active?: unknown }).kinds
  if (!Array.isArray(raw)) return null
  const kinds: SidebarTabKind[] = []
  for (const kind of raw) {
    // 同一 kind 允许重复（多个 review/terminal Tab 是合法状态）。
    if (isSidebarTabKind(kind) && kinds.length < MAX_SIDEBAR_TABS) kinds.push(kind)
  }
  if (!kinds.length) return null
  const active = Number((value as { active?: unknown }).active)
  const index = Number.isFinite(active) ? Math.trunc(active) : 0
  return { kinds, active: Math.min(Math.max(index, 0), kinds.length - 1) }
}

/**
 * 从落盘载荷重建 Tab 列表。恢复出来的 terminal 一律标记 `stale`：
 * 进程随旧实例一起被 `term_kill`/`kill_all` 收掉，恢复时不能假装它还在。
 */
export function tabsFromPersisted(
  persisted: PersistedSidebarTabs,
  nextId: () => number,
): { tabs: SidebarTabItem[]; activeId: number | null; nextId: number } {
  let cursor = 0
  const tabs = persisted.kinds.map(kind => {
    const id = nextId()
    cursor = id
    return kind === "terminal" ? { id, type: kind, stale: true } : { id, type: kind }
  })
  const activeTab = tabs[persisted.active] ?? tabs[tabs.length - 1] ?? null
  return { tabs, activeId: activeTab?.id ?? null, nextId: cursor + 1 }
}

/** 当前 Tab 列表 → 落盘载荷。空列表返回 `null`（写入方据此删除该条目）。 */
export function persistedFromTabs(
  tabs: readonly SidebarTabItem[],
  activeId: number | null,
): PersistedSidebarTabs | null {
  if (!tabs.length) return null
  const kinds = tabs.slice(0, MAX_SIDEBAR_TABS).map(tab => tab.type)
  const index = activeId === null ? -1 : tabs.findIndex(tab => tab.id === activeId)
  return { kinds, active: Math.max(index, 0) }
}

/**
 * 会话身份键：落盘按这个键分组。
 * - 已落盘会话：`sessionIdentityKey`（远程项目带 endpoint，本地为规范化路径）。
 * - 尚未落盘的草稿会话：`runtime:<id>`；文件出现后由 `migrate` 迁移到文件键。
 */
export function sidebarTabGroupKey(runtimeId: string, sessionFile: string | null | undefined, project: string): string {
  return sessionFile ? `${project}\u0000${sessionFile}` : `runtime:${runtimeId}`
}

/** 供 `rebind` 使用：把源键上的载荷迁到目标键（目标已有内容时以源为准，与 UI 一致）。 */
export function mergePersisted(
  existing: PersistedSidebarTabs | null,
  incoming: PersistedSidebarTabs | null,
): PersistedSidebarTabs | null {
  return incoming ?? existing
}
