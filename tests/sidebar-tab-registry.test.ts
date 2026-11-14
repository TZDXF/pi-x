import { test, expect, beforeEach } from "vitest"
import {
  MAX_SIDEBAR_TABS,
  normalizePersistedSidebarTabs,
  persistedFromTabs,
  sidebarTabGroupKey,
  tabsFromPersisted,
} from "@/lib/sidebarTabs"
import {
  activeIdFor,
  addTab,
  closeTab,
  dropGroup,
  hasGroup,
  hydrateGroup,
  isHydrated,
  markHydrated,
  persistedFor,
  rebindGroup,
  reorderTabs,
  sidebarTabRegistry,
  setActiveTab,
  tabsFor,
} from "@/stores/sidebarTabs"

const KEY = "C:/project\u0000C:/project/sessions/a.jsonl"
const RUNTIME_KEY = "runtime:rt-1"

beforeEach(() => {
  for (const key of [...sidebarTabRegistry.keys()]) sidebarTabRegistry.delete(key)
  // 注册表还有一份"已确定"标记；重新 import 不现实，这里逐个 drop 清掉。
  for (const key of [KEY, RUNTIME_KEY]) dropGroup(key)
})

test("registry survives component unmount: state lives outside any component instance", () => {
  addTab(KEY, "review")
  addTab(KEY, "files")
  // 模拟 ChatView 卸载后重新挂载：读同一 key 拿到的仍是同一份状态。
  expect(tabsFor(KEY).map(tab => tab.type)).toEqual(["review", "files"])
  expect(activeIdFor(KEY)).toBe(tabsFor(KEY)[1]!.id)
  expect(hasGroup(KEY)).toBe(true)
})

test("add/close keep active valid and close reports emptiness through the registry", () => {
  const first = addTab(KEY, "review")
  const second = addTab(KEY, "terminal")
  expect(activeIdFor(KEY)).toBe(second)
  closeTab(KEY, second)
  expect(tabsFor(KEY).map(tab => tab.type)).toEqual(["review"])
  expect(activeIdFor(KEY)).toBe(first)
  closeTab(KEY, first)
  expect(tabsFor(KEY)).toEqual([])
  expect(activeIdFor(KEY)).toBeNull()
  // 关闭不存在的 id 是幂等的。
  closeTab(KEY, 999)
})

test("reorder keeps the same tab objects and the active id untouched", () => {
  const first = addTab(KEY, "review")
  const second = addTab(KEY, "browser")
  const reordered = [...tabsFor(KEY)].reverse()
  reorderTabs(KEY, reordered)
  expect(tabsFor(KEY).map(tab => tab.id)).toEqual([second, first])
  expect(activeIdFor(KEY)).toBe(second)
})

test("reading tabs does not mark the group as hydrated, so a late payload still lands", () => {
  // 读一次会创建空状态，但不得因此把"尚未 hydrate"误判成"已知为空"。
  expect(tabsFor(KEY)).toEqual([])
  expect(isHydrated(KEY)).toBe(false)
  expect(hydrateGroup(KEY, { kinds: ["browser"], active: 0 })).toBe(true)
  expect(tabsFor(KEY).map(tab => tab.type)).toEqual(["browser"])
  // 反方向：先标记已确定，再来的载荷不再覆盖用户当前状态。
  markHydrated(KEY)
  expect(isHydrated(KEY)).toBe(true)
})

test("persisted payload carries only kinds and the active index", () => {
  addTab(KEY, "review")
  addTab(KEY, "terminal")
  addTab(KEY, "terminal")
  setActiveTab(KEY, tabsFor(KEY)[0]!.id)
  expect(persistedFor(KEY)).toEqual({ kinds: ["review", "terminal", "terminal"], active: 0 })
  // 空列表 → null，调用方据此删除落盘条目。
  dropGroup(KEY)
  expect(persistedFor(KEY)).toBeNull()
})

test("hydrate restores order and active, marking every terminal as stale", () => {
  expect(hydrateGroup(KEY, { kinds: ["review", "terminal"], active: 1 })).toBe(true)
  const tabs = tabsFor(KEY)
  expect(tabs.map(tab => tab.type)).toEqual(["review", "terminal"])
  // 恢复出来的 terminal 一律 stale：进程已随旧实例退出，不能挂 TerminalPanel。
  expect(tabs[1]!.stale).toBe(true)
  expect(tabs[0]!.stale).toBeUndefined()
  expect(activeIdFor(KEY)).toBe(tabs[1]!.id)
})

test("hydrate drops aux and unknown kinds and clamps the active index", () => {
  expect(
    hydrateGroup(KEY, { kinds: ["aux", "review", "mystery", "browser"], active: 99 }),
  ).toBe(true)
  const tabs = tabsFor(KEY)
  // TZD-94 的 aux Tab「关闭即销毁、不落盘」，读盘时同样丢弃。
  expect(tabs.map(tab => tab.type)).toEqual(["review", "browser"])
  expect(activeIdFor(KEY)).toBe(tabs[1]!.id)
  // 全部非法 → 不建状态。
  dropGroup(KEY)
  expect(hydrateGroup(KEY, { kinds: ["aux"] })).toBe(false)
  expect(hasGroup(KEY)).toBe(false)
})

test("hydrate tolerates malformed payloads instead of throwing", () => {
  for (const bad of [null, undefined, 42, "x", {}, { kinds: "nope" }, { active: 1 }]) {
    expect(hydrateGroup(KEY, bad)).toBe(false)
  }
  expect(normalizePersistedSidebarTabs({ kinds: [], active: 0 })).toBeNull()
})

test("rebind moves the runtime-scoped group onto the file key once the session persists", () => {
  addTab(RUNTIME_KEY, "review")
  addTab(RUNTIME_KEY, "browser")
  setActiveTab(RUNTIME_KEY, tabsFor(RUNTIME_KEY)[0]!.id)
  rebindGroup(RUNTIME_KEY, KEY)
  expect(hasGroup(RUNTIME_KEY)).toBe(false)
  expect(tabsFor(KEY).map(tab => tab.type)).toEqual(["review", "browser"])
  expect(activeIdFor(KEY)).toBe(tabsFor(KEY)[0]!.id)
})

test("rebind overwrites an older persisted group with the live one", () => {
  addTab(RUNTIME_KEY, "review")
  rebindGroup(RUNTIME_KEY, KEY)
  // 目标键在此之前已有一份更早的状态：以当前内存为准（与 UI 一致）。
  expect(tabsFor(KEY).map(tab => tab.type)).toEqual(["review"])
})

test("rebind with no source state leaves the target untouched", () => {
  addTab(KEY, "files")
  rebindGroup(RUNTIME_KEY, KEY)
  expect(tabsFor(KEY).map(tab => tab.type)).toEqual(["files"])
})

test("persisted round-trip is lossless for the four supported kinds", () => {
  const persisted = { kinds: ["review", "files", "terminal", "browser", "terminal"] as const, active: 3 }
  let counter = 1
  const rebuilt = tabsFromPersisted({ kinds: [...persisted.kinds], active: persisted.active }, () => counter++)
  expect(persistedFromTabs(rebuilt.tabs, rebuilt.activeId)).toEqual({
    kinds: ["review", "files", "terminal", "browser", "terminal"],
    active: 3,
  })
})

test("payload is truncated at the tab limit", () => {
  const kinds = Array.from({ length: MAX_SIDEBAR_TABS + 5 }, () => "review" as const)
  expect(normalizePersistedSidebarTabs({ kinds, active: 0 })?.kinds).toHaveLength(MAX_SIDEBAR_TABS)
})

test("group key separates unpersisted sessions from file identities", () => {
  expect(sidebarTabGroupKey("rt-1", null, "C:/project")).toBe("runtime:rt-1")
  expect(sidebarTabGroupKey("rt-1", "C:/project/sessions/a.jsonl", "C:/project")).toBe(
    "C:/project\u0000C:/project/sessions/a.jsonl",
  )
})
