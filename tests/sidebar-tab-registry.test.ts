import { test, expect, beforeEach, vi } from "vitest"
import { effectScope, nextTick, reactive, ref } from "vue"

// 真实的 workspace store 会拉到 Tauri transport（node 环境没有 sessionStorage），
// 这里只替身出本用例需要的最小面：`sidebarTabs` 与 `persistSidebarTabs`。
const fakeWorkspace = reactive({
  sidebarTabs: {} as Record<string, { kinds: string[]; active: number }>,
  persistSidebarTabs(_key: string, _value: unknown) {},
})
vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: () => fakeWorkspace,
}))
import {
  MAX_SIDEBAR_TABS,
  markDetachedTabs,
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
  markGroupDetached,
  markHydrated,
  persistedFor,
  rebindGroup,
  reorderTabs,
  sidebarTabRegistry,
  setActiveTab,
  tabsFor,
} from "@/stores/sidebarTabs"
import { useSidebarTabs } from "@/composables/useSidebarTabs"
const useWorkspaceStore = () => fakeWorkspace

const KEY = "C:/project\u0000C:/project/sessions/a.jsonl"
const RUNTIME_KEY = "runtime:rt-1"

beforeEach(() => {
  for (const key of [...sidebarTabRegistry.keys()]) sidebarTabRegistry.delete(key)
  for (const key of [KEY, RUNTIME_KEY]) dropGroup(key)
})

test("registry survives component unmount: state lives outside any component instance", () => {
  addTab(KEY, "review")
  addTab(KEY, "files")
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
  expect(tabsFor(KEY)).toEqual([])
  expect(isHydrated(KEY)).toBe(false)
  expect(hydrateGroup(KEY, { kinds: ["browser"], active: 0 })).toBe(true)
  expect(tabsFor(KEY).map(tab => tab.type)).toEqual(["browser"])
  markHydrated(KEY)
  expect(isHydrated(KEY)).toBe(true)
})

test("persisted payload carries only kinds and the active index", () => {
  addTab(KEY, "review")
  addTab(KEY, "terminal")
  addTab(KEY, "terminal")
  setActiveTab(KEY, tabsFor(KEY)[0]!.id)
  expect(persistedFor(KEY)).toEqual({ kinds: ["review", "terminal", "terminal"], active: 0 })
  dropGroup(KEY)
  expect(persistedFor(KEY)).toBeNull()
})

test("hydrate restores order and active, marking every terminal as stale", () => {
  expect(hydrateGroup(KEY, { kinds: ["review", "terminal"], active: 1 })).toBe(true)
  const tabs = tabsFor(KEY)
  expect(tabs.map(tab => tab.type)).toEqual(["review", "terminal"])
  expect(tabs[1]!.stale).toBe(true)
  expect(tabs[0]!.stale).toBeUndefined()
  expect(activeIdFor(KEY)).toBe(tabs[1]!.id)
})

test("hydrate drops aux and unknown kinds and clamps the active index", () => {
  expect(hydrateGroup(KEY, { kinds: ["aux", "review", "mystery", "browser"], active: 99 })).toBe(true)
  const tabs = tabsFor(KEY)
  expect(tabs.map(tab => tab.type)).toEqual(["review", "browser"])
  expect(activeIdFor(KEY)).toBe(tabs[1]!.id)
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

test("rebind with no source state leaves the target untouched", () => {
  addTab(KEY, "files")
  rebindGroup(RUNTIME_KEY, KEY)
  expect(tabsFor(KEY).map(tab => tab.type)).toEqual(["files"])
})

test("persisted round-trip is lossless for the four supported kinds", () => {
  const kinds = ["review", "files", "terminal", "browser", "terminal"] as const
  let counter = 1
  const rebuilt = tabsFromPersisted({ kinds: [...kinds], active: 3 }, () => counter++)
  expect(persistedFromTabs(rebuilt.tabs, rebuilt.activeId)).toEqual({ kinds: [...kinds], active: 3 })
})

test("payload is truncated at the tab limit", () => {
  const kinds = Array.from({ length: MAX_SIDEBAR_TABS + 5 }, () => "review" as const)
  expect(normalizePersistedSidebarTabs({ kinds, active: 0 })?.kinds).toHaveLength(MAX_SIDEBAR_TABS)
})

test("group key separates unpersisted sessions from file identities", () => {
  expect(sidebarTabGroupKey("rt-1", null, "C:/project")).toBe("runtime:rt-1")
  expect(sidebarTabGroupKey("rt-1", "C:/project/sessions/a.jsonl", "C:/project")).toBe(KEY)
})

// ---- 卸载 → 重挂载：terminal 必须 stale（不靠落盘预填 stale）----

test("unmounting marks every terminal tab stale without touching persisted payload", () => {
  addTab(KEY, "review")
  addTab(KEY, "terminal")
  const before = persistedFor(KEY)
  markGroupDetached(KEY)
  expect(tabsFor(KEY).find(tab => tab.type === "terminal")!.stale).toBe(true)
  // stale 是瞬时 UI 状态：不进落盘，重启恢复由 hydrate 自己置 stale。
  expect(persistedFor(KEY)).toEqual(before)
  // 显式重开才清掉 stale。
  const terminal = tabsFor(KEY).find(tab => tab.type === "terminal")!
  terminal.stale = false
  expect(terminal.stale).toBe(false)
})

test("markDetachedTabs only flips terminal rows and reports whether it changed anything", () => {
  const tabs = [
    { id: 1, type: "review" as const },
    { id: 2, type: "terminal" as const },
    { id: 3, type: "terminal" as const, stale: true },
  ]
  expect(markDetachedTabs(tabs)).toBe(true)
  expect(tabs[1]!.stale).toBe(true)
  expect(markDetachedTabs(tabs)).toBe(false)
})

// ---- 真实 composable 行为（hydrate 竞态、active 落盘、rebind 不删载荷）----

function setup(
  options: { project?: string; runtimeId?: string; sessionFileValue?: string | null; keepDisk?: boolean } = {},
) {
  // `keepDisk`：模拟"重启"时复用同一份磁盘载荷，而不是清空。
  if (!options.keepDisk) fakeWorkspace.sidebarTabs = {}
  fakeWorkspace.persistSidebarTabs = (key, value) => {
    if (value === null) delete fakeWorkspace.sidebarTabs[key]
    else fakeWorkspace.sidebarTabs[key] = value as { kinds: string[]; active: number }
  }
  const project = options.project ?? "C:/project"
  const workspace = useWorkspaceStore()
  const scope = effectScope()
  const sessionFile = ref<string | null>(options.sessionFileValue ?? null)
  const runtimeId = options.runtimeId ?? "rt-1"
  let api!: ReturnType<typeof useSidebarTabs>
  scope.run(() => {
    api = useSidebarTabs({ runtimeId, sessionFile, project: () => project })
  })
  return { workspace, scope, sessionFile, api }
}

test("a late payload for THIS session still hydrates after another session's update arrives first", async () => {
  // 其余会话先更新：`workspace.sidebarTabs` 变化会被监听器看到 —— 用 once 的实现在这里就失效了。
  const { workspace, api } = setup()
  workspace.sidebarTabs = { "runtime:other": { kinds: ["browser"], active: 0 } }
  await nextTick()
  expect(isHydrated(api.tabKey.value)).toBe(false)
  // 本会话的载荷后到。
  workspace.sidebarTabs = { ...workspace.sidebarTabs, "runtime:rt-1": { kinds: ["review"], active: 0 } }
  await nextTick()
  expect(tabsFor(api.tabKey.value).map(tab => tab.type)).toEqual(["review"])
})

test("hydrate never overwrites tabs the user added while waiting for the payload", async () => {
  const { workspace, api } = setup()
  api.add("review")
  workspace.sidebarTabs = { "runtime:rt-1": { kinds: ["browser"], active: 0 } }
  await nextTick()
  expect(tabsFor(api.tabKey.value).map(tab => tab.type)).toEqual(["review"])
})

test("changing the active tab is persisted", async () => {
  const { workspace, api } = setup()
  api.add("review")
  api.add("browser")
  const reviewId = tabsFor(api.tabKey.value)[0]!.id
  api.activeId.value = reviewId
  expect(workspace.sidebarTabs["runtime:rt-1"]).toEqual({ kinds: ["review", "browser"], active: 0 })
})

test("rebinding after sessionFile arrives keeps the persisted payload for the new key", async () => {
  // 时序必须是三步（同一 tick 改载荷 + sessionFile 会被 hydrate 抢先，掩盖旧实现的删除）：
  // ① 预置文件键载荷；② 挂载并让 runtime 键先消费一次 watcher；③ 再改 sessionFile。
  const { workspace, api, sessionFile } = setup()
  expect(api.tabKey.value).toBe("runtime:rt-1")

  // ① 磁盘上文件键已经有一份更早的载荷（另一个实例写的）。
  workspace.sidebarTabs = { [KEY]: { kinds: ["files", "browser"], active: 1 } }
  await nextTick()

  // ② 读一次 runtime 键的 tabs（空），让 hydrate watcher 以 runtime 键消费掉这次更新。
  expect(tabsFor("runtime:rt-1")).toEqual([])
  expect(workspace.sidebarTabs[KEY]).toEqual({ kinds: ["files", "browser"], active: 1 })

  // ③ 会话落盘：旧实现会在这里 persist(null) 把文件键的载荷删掉。
  sessionFile.value = "C:/project/sessions/a.jsonl"
  await nextTick()
  expect(workspace.sidebarTabs[KEY]).toEqual({ kinds: ["files", "browser"], active: 1 })
  expect(tabsFor(KEY).map(tab => tab.type)).toEqual(["files", "browser"])
})

test("unmount through the scope flips terminal tabs to stale", async () => {
  const { api, scope } = setup()
  api.add("terminal")
  expect(tabsFor(api.tabKey.value)[0]!.stale).toBeUndefined()
  scope.stop()
  expect(tabsFor("runtime:rt-1")[0]!.stale).toBe(true)
})

test("rebind writes the new identity key immediately when the draft group is non-empty", async () => {
  // 新会话（草稿态）先加两个 Tab，`sessionFile` 之后才到位。
  const { workspace, api, sessionFile, scope } = setup()
  api.add("review")
  api.add("browser")
  expect(api.tabKey.value).toBe("runtime:rt-1")
  expect(workspace.sidebarTabs["runtime:rt-1"]).toEqual({ kinds: ["review", "browser"], active: 1 })

  sessionFile.value = "C:/project/sessions/a.jsonl"
  await nextTick()

  // 非空源迁移后必须**立即**写新身份键、并清掉旧 runtime 键。
  // 去掉写回（回到"等下一次侧栏操作"）这一条会红：磁盘上只剩 runtime:rt-1。
  expect(workspace.sidebarTabs[KEY]).toEqual({ kinds: ["review", "browser"], active: 1 })
  expect(workspace.sidebarTabs["runtime:rt-1"]).toBeUndefined()

  // 模拟完整重启：丢掉内存组，只用磁盘载荷重建 —— 两个 Tab 必须还在。
  dropGroup(KEY)
  // 重启后 `sessionFile` 一开始就在：键直接是文件身份键，只能靠磁盘载荷恢复。
  const reloaded = setup({
    runtimeId: "rt-9",
    sessionFileValue: "C:/project/sessions/a.jsonl",
    keepDisk: true,
  })
  expect(reloaded.api.tabs.value.map(tab => tab.type)).toEqual(["review", "browser"])
  reloaded.scope.stop()
  scope.stop()
})

test("rebind keeps a live terminal alive instead of faking its death", () => {
  // 迁移只是换键：`ChatView` 没有卸载、shell 还活着，不能借落盘载荷重建把它标成 stale。
  addTab(RUNTIME_KEY, "terminal")
  expect(tabsFor(RUNTIME_KEY)[0]!.stale).toBeUndefined()
  rebindGroup(RUNTIME_KEY, KEY)
  expect(tabsFor(KEY)[0]!.stale).toBeUndefined()
})
