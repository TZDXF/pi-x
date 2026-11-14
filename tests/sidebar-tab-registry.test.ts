import { test, expect, beforeEach, vi } from "vitest"
import { effectScope, nextTick, reactive, ref, type Ref } from "vue"

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
  MAX_SIDEBAR_TAB_GROUPS,
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
  pruneGroups,
  rebindGroup,
  retainedCount,
  releaseGroup,
  reorderTabs,
  retainGroup,
  sidebarTabRegistry,
  setActiveTab,
  tabsFor,
} from "@/stores/sidebarTabs"
import { useSidebarTabs } from "@/composables/useSidebarTabs"
const useWorkspaceStore = () => fakeWorkspace
const RUNTIME_KEY_2 = "runtime:rt-2"

const KEY = "C:/project\u0000C:/project/sessions/a.jsonl"
const RUNTIME_KEY = "runtime:rt-1"

beforeEach(() => {
  for (const key of [...sidebarTabRegistry.keys()]) sidebarTabRegistry.delete(key)
  for (const key of [KEY, RUNTIME_KEY, RUNTIME_KEY_2]) dropGroup(key)
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

function setup(project = "C:/project") {
  fakeWorkspace.sidebarTabs = {}
  fakeWorkspace.persistSidebarTabs = (key, value) => {
    if (value === null) delete fakeWorkspace.sidebarTabs[key]
    else fakeWorkspace.sidebarTabs[key] = value as { kinds: string[]; active: number }
  }
  const workspace = useWorkspaceStore()
  const scope = effectScope()
  const sessionFile = ref<string | null>(null)
  const runtimeId = "rt-1"
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
  const { workspace, api, sessionFile } = setup()
  // 本会话还没加任何 Tab；磁盘上文件键已经有一份更早的载荷（另一个实例写的）。
  expect(api.tabKey.value).toBe("runtime:rt-1")
  workspace.sidebarTabs = { [KEY]: { kinds: ["files", "browser"], active: 1 } }
  sessionFile.value = "C:/project/sessions/a.jsonl"
  await nextTick()
  // 旧实现会在这里 persist(null) 把文件键的载荷删掉；修好后载荷仍在、且被恢复出来。
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

// ---- 复审修复（本轮）：上限前移、写侧白名单、rebind 不伪造失联、组数回收 ----

test("the tab limit is enforced at addTab and reported to the caller", () => {
  fakeWorkspace.sidebarTabs = {}
  const scope = effectScope()
  let limitHits = 0
  const api = scope.run(() =>
    useSidebarTabs({
      runtimeId: "rt-1",
      sessionFile: ref<string | null>("C:/project/sessions/a.jsonl"),
      project: () => "C:/project",
      onTabLimitReached: () => (limitHits += 1),
    }),
  )!
  for (let index = 0; index < MAX_SIDEBAR_TABS; index++) expect(api.add("review")).toBeTruthy()
  // 第 21 个必须被拒绝：不能"界面成功、写盘截断、重启静默丢最新一个"。
  expect(api.add("review")).toBeNull()
  expect(limitHits).toBe(1)
  expect(tabsFor(KEY)).toHaveLength(MAX_SIDEBAR_TABS)
  expect(fakeWorkspace.sidebarTabs[KEY].kinds).toHaveLength(MAX_SIDEBAR_TABS)
  expect(fakeWorkspace.sidebarTabs[KEY].active).toBeLessThan(MAX_SIDEBAR_TABS)
  scope.stop()
})

test("write-side whitelist drops aux and unknown kinds before the payload leaves the frontend", () => {
  const payload = persistedFromTabs(
    [
      { id: 1, type: "aux" },
      { id: 2, type: "review" },
      { id: 3, type: "mystery" },
    ] as never,
    2,
  )
  expect(payload).toEqual({ kinds: ["review"], active: 0 })
})

test("rebind does not fake terminal death while the pane is still mounted", () => {
  addTab(RUNTIME_KEY, "terminal")
  expect(tabsFor(RUNTIME_KEY)[0]!.stale).toBeUndefined()
  rebindGroup(RUNTIME_KEY, KEY)
  // 迁移只是换键：ChatView 没卸载、shell 还活着，不能标失联。
  expect(tabsFor(KEY)[0]!.stale).toBeUndefined()
})

test("group count is capped by LRU eviction, sparing groups that are still mounted", () => {
  for (let index = 0; index < MAX_SIDEBAR_TAB_GROUPS; index++) addTab(`runtime:old-${index}`, "review")
  addTab(RUNTIME_KEY_2, "terminal")
  retainGroup(RUNTIME_KEY_2)
  pruneGroups(MAX_SIDEBAR_TAB_GROUPS)
  expect(sidebarTabRegistry.size).toBe(MAX_SIDEBAR_TAB_GROUPS)
  expect(hasGroup(RUNTIME_KEY_2)).toBe(true)
  releaseGroup(RUNTIME_KEY_2)
  pruneGroups(1)
  // 淘汰只丢内存；磁盘条目保留（调用方不写 null），重新打开再 hydrate。
  expect(sidebarTabRegistry.size).toBe(1)
  expect(hasGroup(RUNTIME_KEY_2)).toBe(true)
  for (let index = 0; index < MAX_SIDEBAR_TAB_GROUPS; index++) dropGroup(`runtime:old-${index}`)
})

// ---- 第三轮复审新增：两项 P2 + 一条防御 + 两条建议 ----

function mount(options: { sessionFile?: Ref<string | null>; project?: () => string; runtimeId?: string } = {}) {
  const scope = effectScope()
  const api = scope.run(() =>
    useSidebarTabs({
      runtimeId: options.runtimeId ?? "rt-1",
      sessionFile: options.sessionFile ?? ref<string | null>(null),
      project: options.project ?? (() => "C:/project"),
    }),
  )!
  return { scope, api }
}

test("P2 draft -> persisted migration writes the new identity key immediately", async () => {
  // 新会话先加两个 Tab，`sessionFile` 之后才到。
  const sessionFile = ref<string | null>(null)
  const { scope, api } = mount({ sessionFile })
  api.add("review")
  api.add("browser")
  expect(api.tabKey.value).toBe("runtime:rt-1")
  expect(fakeWorkspace.sidebarTabs["runtime:rt-1"]).toEqual({ kinds: ["review", "browser"], active: 1 })

  sessionFile.value = "C:/project/sessions/a.jsonl"
  await nextTick()
  // 必须立即用新身份键写回并清掉旧 runtime 键：只搬内存不写盘的话，完整刷新后 Tab 全丢。
  expect(fakeWorkspace.sidebarTabs[KEY]).toEqual({ kinds: ["review", "browser"], active: 1 })
  expect(fakeWorkspace.sidebarTabs["runtime:rt-1"]).toBeUndefined()

  // 模拟完整重载：丢掉内存组，只用磁盘载荷重建。
  dropGroup(KEY)
  const reloaded = mount({
    runtimeId: "rt-9",
    sessionFile: ref<string | null>("C:/project/sessions/a.jsonl"),
  })
  expect(reloaded.api.tabs.value.map(tab => tab.type)).toEqual(["review", "browser"])
  reloaded.scope.stop()
  scope.stop()
})

test("retain/release stays balanced across identity changes (SSH realpath rebind)", async () => {
  // 同一个仍挂载的实例经历两次身份变化：草稿 → 文件键 → realpath 归一化后的项目身份。
  const sessionFile = ref<string | null>(null)
  const project = ref("C:/project")
  const { scope, api } = mount({ sessionFile, project: () => project.value })
  const draftKey = "runtime:rt-1"
  const reboundKey = "D:/rebound\u0000C:/project/sessions/a.jsonl"
  expect(retainedCount(draftKey)).toBe(1)

  sessionFile.value = "C:/project/sessions/a.jsonl"
  await nextTick()
  expect(retainedCount(draftKey)).toBe(0)
  expect(retainedCount(KEY)).toBe(1)
  expect(api.tabKey.value).toBe(KEY)

  // `workspaceRuntime` 的 onSshPathBound 会在组件仍挂载时改 cwd —— 键随之变化。
  project.value = "D:/rebound"
  await nextTick()
  expect(retainedCount(KEY)).toBe(0)
  expect(retainedCount(reboundKey)).toBe(1)
  scope.stop()
  // 卸载后不留任何残留引用（否则旧 alias 键永远不被淘汰）。
  expect(retainedCount(reboundKey)).toBe(0)
  expect(retainedCount(KEY)).toBe(0)
})

test("reorder entry clamps to the tab limit and keeps active valid", () => {
  const ids: number[] = []
  for (let index = 0; index < MAX_SIDEBAR_TABS; index++) ids.push(addTab(KEY, "review")!)
  expect(tabsFor(KEY)).toHaveLength(MAX_SIDEBAR_TABS)

  // 外部（例如别处越界后）传入 21 项：reorder 也必须守住上限，且不留悬空 active
  // （被截掉的项若正好是 active，activeId 回落到最后一项）。
  const oversize = [...ids, 0].map((id, index) => ({ id: (id ?? 0) + 1000 + index, type: "files" as const }))
  reorderTabs(KEY, oversize)
  expect(tabsFor(KEY).length).toBe(MAX_SIDEBAR_TABS)
  const state = sidebarTabRegistry.get(KEY)!
  expect(state.activeId).not.toBeNull()
  expect(tabsFor(KEY).some(tab => tab.id === state.activeId)).toBe(true)

  // 正常重排仍然生效（数量不变、顺序按传入数组）。
  const before = tabsFor(KEY).map(tab => tab.id)
  const swapped = [tabsFor(KEY)[1]!, tabsFor(KEY)[0]!, ...tabsFor(KEY).slice(2)]
  reorderTabs(KEY, swapped)
  expect(tabsFor(KEY).map(tab => tab.id)).toEqual([before[1], before[0], ...before.slice(2)])
})

test("group count never exceeds the cap, including the first render of a fresh group", () => {
  // 24 个旧组已在使用，再挂载一个新组：观察到的组数必须始终 ≤ 24。
  for (let index = 0; index < MAX_SIDEBAR_TAB_GROUPS; index++) addTab(`runtime:old-${index}`, "review")
  const { scope } = mount({ runtimeId: "fresh" })
  expect(sidebarTabRegistry.size).toBeLessThanOrEqual(MAX_SIDEBAR_TAB_GROUPS)
  expect(hasGroup("runtime:fresh")).toBe(true)
  scope.stop()
  for (let index = 0; index < MAX_SIDEBAR_TAB_GROUPS; index++) dropGroup(`runtime:old-${index}`)
})
