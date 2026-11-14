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
  groupKeyFor,
  hasGroup,
  hydrateGroup,
  isHydrated,
  markGroupDetached,
  markHydrated,
  persistedFor,
  pruneGroups,
  rebindGroup,
  releaseGroup,
  reorderTabs,
  retainGroup,
  retainedGroupCount,
  pendingHydrateSizeForTest,
  sidebarTabRegistry,
  setActiveTab,
  tabsFor,
} from "@/stores/sidebarTabs"
import { useSidebarTabs } from "@/composables/useSidebarTabs"
const useWorkspaceStore = () => fakeWorkspace

const KEY = "C:/project\u0000C:/project/sessions/a.jsonl"
const RUNTIME_KEY = "runtime:rt-1"
const RUNTIME_KEY_2 = "runtime:rt-2"
// SSH realpath 回绑：同一个挂载实例的项目身份从 alias 变成实际路径，键随之改变。
const ALIAS_KEY = groupKeyFor("rt-1", "sessions/a.jsonl", "//host/proj/alias")
const REBOUND_KEY = groupKeyFor("rt-1", "sessions/a.jsonl", "//host/proj")

beforeEach(() => {
  for (const key of [...sidebarTabRegistry.keys()]) dropGroup(key)
  for (const key of [KEY, RUNTIME_KEY, RUNTIME_KEY_2, ALIAS_KEY, REBOUND_KEY]) {
    dropGroup(key)
    // 持有计数据也清掉，避免用例之间泄漏（retain/release 是本轮修的主题）。
    releaseGroup(key)
  }
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

// ---- TZD-96（P2 加固）：上限、写侧白名单、宽容反序列化、组数 LRU ----

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
  expect(fakeWorkspace.sidebarTabs[KEY]!.kinds).toHaveLength(MAX_SIDEBAR_TABS)
  expect(fakeWorkspace.sidebarTabs[KEY]!.active).toBeLessThan(MAX_SIDEBAR_TABS)
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

test("write-side whitelist filters kinds BEFORE the 20-tab truncation", () => {
  // 反过来（先截断后过滤）时，前面 20 个 aux 会把合法的 review/browser 挤掉，
  // 载荷变空 → 条目被删 → 用户的 Tab 整组消失。
  const tabs = [
    ...Array.from({ length: MAX_SIDEBAR_TABS }, (_, index) => ({ id: index + 1, type: "aux" as const })),
    { id: 100, type: "review" as const },
    { id: 101, type: "browser" as const },
  ]
  expect(persistedFromTabs(tabs as never, 101)).toEqual({ kinds: ["review", "browser"], active: 1 })
})

test("reorder cannot push the tab list past the limit", () => {
  const first = addTab(KEY, "review")!
  const rows = [
    ...tabsFor(KEY),
    ...Array.from({ length: MAX_SIDEBAR_TABS + 4 }, (_, index) => ({ id: 1000 + index, type: "files" as const })),
  ]
  reorderTabs(KEY, rows)
  // 拖拽是唯一可能绕过 `addTab` 把列表变长的入口：内存里也必须守住 20 条。
  expect(tabsFor(KEY)).toHaveLength(MAX_SIDEBAR_TABS)
  expect(tabsFor(KEY)[0]!.id).toBe(first)
  expect(persistedFor(KEY)!.kinds).toHaveLength(MAX_SIDEBAR_TABS)
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

// ---- 缺陷修复（审查反例）：身份变化后的 retain/release 配平、首渲染组数不变量 ----

test("an SSH realpath rebound keeps the mounted group out of LRU eviction", async () => {
  // 审查反例的同一构造：alias 身份下挂载的实例，回绑后键变成实际路径。
  // REBOUND 组先存在（分屏里另一个窗格开过它），因此它是内存里最老的候选 ——
  // 一旦它失去持有关系，默认 24 组回收第一个就挑它。
  addTab(REBOUND_KEY, "files")
  for (let index = 0; index < MAX_SIDEBAR_TAB_GROUPS - 2; index++) addTab(`runtime:idle-${index}`, "review")

  const project = ref("//host/proj/alias")
  const sessionFile = ref<string | null>("sessions/a.jsonl")
  const scope = effectScope()
  let api!: ReturnType<typeof useSidebarTabs>
  scope.run(() => {
    api = useSidebarTabs({ runtimeId: "rt-1", sessionFile, project: () => project.value })
  })
  expect(api.tabKey.value).toBe(ALIAS_KEY)

  // SSH realpath 回绑（`src/lib/workspaceRuntime.ts:149`）：原组件仍挂载就换了项目身份。
  project.value = "//host/proj"
  await nextTick()
  expect(api.tabKey.value).toBe(REBOUND_KEY)

  // 第一轮：再开几个会话把组数顶过上限，跑默认 24 组回收。
  for (let index = 0; index < 2; index++) addTab(`runtime:pressure-${index}`, "review")
  pruneGroups(MAX_SIDEBAR_TAB_GROUPS)
  // 旧实现只在 `runtime:` → 文件键时迁移引用，这里引用留在 alias 键上：
  // 正在显示的 REBOUND 组没有任何保护，被当成最老的候选整组删掉。
  expect(hasGroup(REBOUND_KEY), "回绑后正在显示的组不得被 LRU 淘汰").toBe(true)

  // 持有关系按"本实例实际 retain 过的键"配平：新键 1 次、旧 alias 键 0 次。
  expect(retainedGroupCount(REBOUND_KEY)).toBe(1)
  expect(retainedGroupCount(ALIAS_KEY)).toBe(0)

  // 第二轮：用足够多的新组把 REBOUND 重新变成最老的一组，再回收一次 ——
  // 只有"真的 retain 了它"才能让它活下来（只 touch 一次是撑不过这一轮的）。
  for (let index = 0; index < MAX_SIDEBAR_TAB_GROUPS; index++) addTab(`runtime:later-${index}`, "review")
  pruneGroups(MAX_SIDEBAR_TAB_GROUPS)
  expect(hasGroup(REBOUND_KEY)).toBe(true)
  expect(tabsFor(REBOUND_KEY).map(tab => tab.type)).toEqual(["files"])

  // 卸载后按记录的键释放；否则旧 alias 键的引用永久占位，卸载后也回收不了。
  scope.stop()
  expect(retainedGroupCount(ALIAS_KEY)).toBe(0)
  expect(retainedGroupCount(REBOUND_KEY)).toBe(0)
  addTab(ALIAS_KEY, "files")
  addTab("runtime:newest", "review")
  pruneGroups(1)
  expect(sidebarTabRegistry.size).toBe(1)
  expect(hasGroup(ALIAS_KEY)).toBe(false)
})

test("first render never exposes more groups than the limit", () => {
  // 24 个闲置组把内存占满，然后进入一个还没有内存组的会话（首渲染）。
  for (let index = 0; index < MAX_SIDEBAR_TAB_GROUPS; index++) addTab(`runtime:idle-${index}`, "review")
  expect(sidebarTabRegistry.size).toBe(MAX_SIDEBAR_TAB_GROUPS)

  const scope = effectScope()
  const sessionFile = ref<string | null>(null)
  let api!: ReturnType<typeof useSidebarTabs>
  scope.run(() => {
    api = useSidebarTabs({ runtimeId: "rt-new", sessionFile, project: () => "C:/project" })
  })
  // 首渲染会读取 tabs —— 这一步才创建该会话的空组。旧实现先按 24 回收再让该组建出来，
  // 于是这里能观察到 25 组；回收时机挪到"组真正可用之后/预留 1 个"才不会越界。
  expect(api.tabs.value).toEqual([])
  expect(sidebarTabRegistry.size).toBeLessThanOrEqual(MAX_SIDEBAR_TAB_GROUPS)
  scope.stop()
})

// ---- 容量准入（复审阻塞项）：组数上限必须靠"建组前准入"守住 ----

test("thirty simultaneously mounted conversations never exceed the group limit", async () => {
  // 复审复现的构造：30 个不同会话各挂一个实例，每个都 retain=1。
  // 旧实现"全部组被挂载持有 → pruneGroups 静默 return → stateFor 照样建组"，
  // 于是内存里稳定 30 组。准入必须在建组前拒绝，而不是事后淘汰。
  const scopes: ReturnType<typeof effectScope>[] = []
  let denied = 0
  for (let index = 0; index < 30; index++) {
    const scope = effectScope()
    const sessionFile = ref<string | null>(`sessions/c${index}.jsonl`)
    scope.run(() =>
      useSidebarTabs({
        runtimeId: `rt-cap-${index}`,
        sessionFile,
        project: () => "C:/project",
        onGroupLimitReached: () => (denied += 1),
      }),
    )
    scopes.push(scope)
  }
  expect(sidebarTabRegistry.size).toBeLessThanOrEqual(MAX_SIDEBAR_TAB_GROUPS)
  // 超出容量的挂载必须被明确拒绝（不能静默超限建组）。
  expect(denied).toBe(30 - MAX_SIDEBAR_TAB_GROUPS)
  for (const scope of scopes) scope.stop()
})

test("a conversation whose payload arrives while the registry is full is admitted after space frees up", async () => {
  // 复审的"24 闲置组 + 新组已有磁盘载荷"路径：旧实现先 hydrate 建组再 prune，
  // 中间态冲到 25。现在 hydrate 走准入；腾不出就把载荷暂存，名额空出来后补上。
  for (let index = 0; index < MAX_SIDEBAR_TAB_GROUPS; index++) retainGroup(`runtime:idle-${index}`)
  expect(sidebarTabRegistry.size).toBe(MAX_SIDEBAR_TAB_GROUPS)

  const lateKey = "runtime:late"
  expect(hydrateGroup(lateKey, { kinds: ["review", "browser"], active: 1 })).toBe(false)
  expect(sidebarTabRegistry.size).toBe(MAX_SIDEBAR_TAB_GROUPS)
  expect(sidebarTabRegistry.size).toBeLessThanOrEqual(MAX_SIDEBAR_TAB_GROUPS)

  releaseGroup("runtime:idle-0")
  // 名额空出后自动补 hydrate，载荷没被丢。
  expect(hasGroup(lateKey)).toBe(true)
  expect(tabsFor(lateKey).map(tab => tab.type)).toEqual(["review", "browser"])
  expect(activeIdFor(lateKey)).toBe(tabsFor(lateKey)[1]!.id)
})

test("unmounting the mounted holders admits the payload that was denied entry", () => {
  // 复审第三条缺口：释放后没人再触发回收/hydrate，被挡在门外的载荷就永久丢失。
  const scopes: ReturnType<typeof effectScope>[] = []
  // 留 2 个名额，其余全被挂载持有。
  for (let index = 0; index < MAX_SIDEBAR_TAB_GROUPS - 2; index++) {
    const scope = effectScope()
    const sessionFile = ref<string | null>(`sessions/h${index}.jsonl`)
    scope.run(() =>
      useSidebarTabs({ runtimeId: `rt-hold-${index}`, sessionFile, project: () => "C:/project" }),
    )
    scopes.push(scope)
  }
  // 先把空闲名额用完，再让带载荷的会话被准入拒绝（载荷进 pendingHydrate）。
  retainGroup("runtime:filler-1")
  retainGroup("runtime:filler-2")
  const deniedKey = "runtime:denied-with-payload"
  expect(hydrateGroup(deniedKey, { kinds: ["files", "browser"], active: 1 })).toBe(false)
  expect(hasGroup(deniedKey)).toBe(false)
  expect(pendingHydrateSizeForTest()).toBe(1)

  // 全部卸载：释放路径必须补一次回收 + 补 hydrate，否则这条载荷永远进不来。
  for (const scope of scopes) scope.stop()
  releaseGroup("runtime:filler-1")
  expect(hasGroup(deniedKey)).toBe(true)
  expect(tabsFor(deniedKey).map(tab => tab.type)).toEqual(["files", "browser"])
  expect(pendingHydrateSizeForTest()).toBe(0)
  releaseGroup("runtime:filler-2")
  expect(sidebarTabRegistry.size).toBeLessThanOrEqual(MAX_SIDEBAR_TAB_GROUPS)
})
