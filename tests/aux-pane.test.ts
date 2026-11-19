import { expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"

/**
 * aux 面板与接线：源码级断言 + 纯逻辑单测。
 *
 * 面板本身依赖整套对话组件（Vue 渲染环境不在这里），DOM 交互由 `e2e/` 覆盖；
 * 这里钉住三条**不能回退**的契约：
 * 1. `ExtensionDialog` / `StatusBar`（经 `ChatComposer`）必须拿 aux 自己的 `session-id`；
 * 2. `ExtensionDialog` 只在激活态渲染，且 aux 不做 edit-retry/read-receipt；
 * 3. 关闭 Tab 走 `closeAux`（销毁进程与 store），不是只撤槽位。
 */
const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8")

test("the aux pane binds extension dialogs and status bar to the aux session id", () => {
  const pane = read("components/aux-chat/AuxChatPane.vue")
  // 扩展询问必须落在 aux 自己的 ui store：拿主会话 id 会把回答发错进程。
  expect(pane).toMatch(/<ExtensionDialog v-if="active" :session-id="runtimeId" \/>/)
  // `ChatComposer` 内部把 `:session-id` 传给 `StatusBar`；这里钉住传进去的是 aux id。
  expect(pane).toMatch(/:runtime-id="runtimeId"/)
  // 只在激活态渲染弹框：隐藏的 Tab 不该抢焦点。
  expect(pane).not.toMatch(/<ExtensionDialog v-if="true"/)
})

test("the aux pane reuses the shared list/composer without adding edits or receipts", () => {
  const pane = read("components/aux-chat/AuxChatPane.vue")
  expect(pane).toMatch(/<ChatTurnList/)
  expect(pane).toMatch(/<ChatComposer/)
  // 不做 history 分页 / edit-retry / read-receipt（aux 无 session 文件）。
  expect(pane).not.toMatch(/useSessionReadReceipt/)
  expect(pane).not.toMatch(/loadOlderHistory/)
  // 编辑态是恒不可用的桩：公共组件模板一行未改，编辑入口不出现。
  expect(pane).toMatch(/editBlocked: true/)
  // aux 读**自己的**引用桶、不消费主会话的批注/引用（TZD-103 的 `contexts: "aux"`）。
  expect(pane).toMatch(/contexts: "aux"/)
  expect(pane).not.toMatch(/contexts: "none"/)
})

test("the composer is only usable while the pane is actually connected to its process", () => {
  // 复审第四轮观察到的中间态：后端确认退出后 `session.started` 会置 false，但实例注册表
  // 里的 `tab.status` 仍是 `ready`。若只判 `status`，用户会看到一个"能发但发不出去"的
  // 输入框。面板必须把两处状态绑在一起（`connected = ready && session.started`）。
  const pane = read("components/aux-chat/AuxChatPane.vue")
  expect(pane).toMatch(/const connected = computed\(\(\) => ready\.value && session\.started\)/)
  expect(pane).toMatch(/ensureStarted: async \(\) => connected\.value/)
  expect(pane).toMatch(/:connected="connected"/)
  expect(pane).toMatch(/:ensure-started="async \(\) => connected"/)
  // 反向护栏：不允许再退回只判 `ready` 的三处旧写法。
  expect(pane).not.toMatch(/:connected="ready"/)
  expect(pane).not.toMatch(/:ensure-started="async \(\) => ready"/)
  expect(pane).not.toMatch(/ensureStarted: async \(\) => ready\.value/)
})

test("aux tabs are driven by the registry: add opens a process, close destroys it", () => {
  const chat = read("components/ChatView.vue")
  const auxTabs = read("composables/useAuxTabs.ts")
  const sidebar = read("components/RightSidebar.vue")
  // 接线在 `useAuxTabs`（ChatView 经 `useChatViewSidebar` 装配，只用返回值）。
  expect(chat).toMatch(/const sidebar = useChatViewSidebar\(\{/)
  expect(chat).toMatch(
    /const \{ tabs: sidebarTabs, activeId: activeTabId, parent: auxParent, addTab, closeTab, addSidebarTab } = sidebar/,
  )
  expect(chat).toMatch(/@close-tab="closeTab"/)
  expect(chat).toMatch(/@add-tab="addTab"/)
  // 快捷键关 Tab 也走同一入口（不能只撤槽位留下孤儿进程）。
  expect(chat).toMatch(/void closeTab\(activeTabId\.value\)/)
  // 添加：先开进程（openAux 同步入表再 await spawn），实例数量不设专属上限。
  expect(auxTabs).toMatch(/const tab = await openAux\(deps\.runtimeId, \{/)
  expect(auxTabs).not.toMatch(/auxChat\.limitReached|auxCanOpen|AUX_MAX_TABS/)
  // 关闭：实例先销毁（墓碑 + rpc_kill + store 拆除），再撤槽位。
  expect(auxTabs).toMatch(/await closeAux\(aux\.runtimeId\)/)
  // 同一父会话的手势不叠加槽位（否则留下查不到实例的空壳）。
  expect(auxTabs).toMatch(/if \(auxCreationPending\(deps\.runtimeId\)\) return/)
  // 侧栏入口：Popover 与空态宫格各一处，只在父上下文未就绪时禁用；不再出现数量上限提示。
  expect(sidebar.match(/:disabled="!auxParent"/g)).toHaveLength(2)
  expect(sidebar.match(/@click="addTab\('aux'\)"/g)).toHaveLength(2)
  expect(sidebar).not.toMatch(/auxChat\.limitReached|AUX_MAX_TABS|aux-limit|canAddAux/)
  // Tab 隐藏不卸载（force-mount + v-show），关闭才卸载。
  expect(sidebar).toMatch(/force-mount/)
  expect(sidebar).toMatch(/v-show="tab\.id === activeId"/)
})

test("a mount restores the aux slot when the sidebar group was evicted", () => {
  const auxTabs = read("composables/useAuxTabs.ts")
  // 侧栏组被 LRU 淘汰只丢槽位，进程与 store 仍在（实例存活是规格要求）：
  // 挂载时按存活实例补回槽位，否则实例会变成没有入口的孤儿。
  expect(auxTabs).toMatch(/function restoreSlots\(tabs: readonly SidebarTabItem\[\]\)/)
  expect(auxTabs).toMatch(/for \(const instance of auxInstancesFor\(deps\.runtimeId\)\)/)
  expect(auxTabs).toMatch(/setAuxTabId\(instance\.runtimeId, slot\)/)
  // 构造即补齐（接线方不需要额外调一行，ChatView 因此少 3 行）。
  expect(auxTabs).toMatch(/restoreSlots\(deps\.tabs\(\)\)/)
})

test("the aux composer hides the workspace/project picker it cannot use", () => {
  const pane = read("components/aux-chat/AuxChatPane.vue")
  const composer = read("components/chat/ChatComposer.vue")
  // aux 跟着父会话的 project 启动、不支持切分支/工作区；默认值 false 保证主会话不变。
  expect(pane).toMatch(/hide-workspace-context/)
  expect(composer).toMatch(/hideWorkspaceContext\?: boolean/)
  expect(composer).toMatch(/!hideWorkspaceContext &&/)
})

test("aux tray title comes from the registry and marks unanswered questions", () => {
  const sidebar = read("components/RightSidebar.vue")
  expect(sidebar).toMatch(/if \(tab\.type === "aux"\) return auxTitleForSidebarId\(tab\.id\)/)
  expect(sidebar).toMatch(/auxHasPendingQuestion\(tab\.id\)/)
  // 未答询问只在标题出标记，不在隐藏的 Tab 里弹框。
  expect(sidebar).toMatch(/data-aux-pending/)
})

test("spawn wiring passes独立字段 to aux_spawn and never concatenates a shell command", () => {
  const process = read("api/client/process.ts")
  expect(process).toMatch(/invoke<void>\("aux_spawn", \{/)
  for (const field of ["project", "runtimeId", "provider", "model", "thinking", "workspace", "sshConnectionId"]) {
    expect(process).toMatch(new RegExp(`\\b${field}: options\\.${field}`))
  }
  // 不做字符串拼接：参数逐项交给后端命令，argv 由后端代码常量组装。
  expect(process).not.toMatch(/child_process/)
})

test("side bar persistence drops aux on both read and write", () => {
  const lib = read("lib/sidebarTabs.ts")
  // 读盘：白名单只含四种落盘 kind（顺序是先过滤、再截断）。
  expect(lib).toMatch(/export const SIDEBAR_TAB_KINDS = \["review", "files", "terminal", "browser"\]/)
  // 写盘：aux 在本地就丢掉，不把脏数据交给后端兜底。
  expect(lib).toMatch(/const allowed = tabs\.filter\(tab => isPersistedSidebarTabKind\(tab\.type\)\)/)
  // 移除 aux 专属上限不改变通用侧栏的 20 条容量规则。
  expect(lib).toMatch(/export const MAX_SIDEBAR_TABS = 20/)
})

test("aux model target prefers the live state and refuses to guess a fallback", async () => {
  vi.resetModules()
  const { auxModelTarget, auxModelTargetKey, auxModelMissing, auxProjectMissing } = await import("@/lib/auxLaunch")
  const live = {
    currentModel: { provider: "home", id: "big", name: "big" },
    thinkingLevel: "high",
    desiredModelKey: null,
    offlineDefaultModelKey: null,
  }
  expect(auxModelTarget(live)).toEqual({ provider: "home", model: "big", thinking: "high" })
  expect(auxModelTargetKey(auxModelTarget(live))).toBe("home/big")
  // 懒启动（尚无 state）时用用户显式选过的离线默认。
  const lazy = { ...live, currentModel: null, desiredModelKey: "LongCat-2.5/xl" }
  expect(auxModelTarget(lazy)).toEqual({ provider: "LongCat-2.5", model: "xl", thinking: "high" })
  // 都没有 → null（不猜兜底模型），由面板按 coded error 展示。
  expect(auxModelTarget({ ...live, currentModel: null })).toBeNull()
  const { formatCodedError } = await import("@/lib/backendError")
  // 与 vue-i18n 一致：命中 key 时返回译文；这里用"前缀即译文"证明编码被翻译。
  const t = (key: string) => (key.startsWith("backendErrors.") ? `t:${key}` : key)
  expect(formatCodedError(t, auxModelMissing())).toBe("t:backendErrors.auxModelMissing")
  expect(formatCodedError(t, auxProjectMissing())).toBe("t:backendErrors.projectDirMissing")
  // 未收录的编码回退 fallback（原文），不会露裸键。
  expect(formatCodedError((key: string) => key, auxModelMissing())).toBe("辅助对话需要显式指定模型")
})

test("aux workspace context mirrors the parent session and is never used for remote projects", async () => {
  vi.resetModules()
  const { auxWorkspaceContext } = await import("@/lib/auxLaunch")
  const workspace = {
    projectRoot: () => "C:/proj",
    projectGroups: { "C:/proj": { name: "group", primary: "C:/proj", folders: ["C:/proj", "C:/proj/api"] } },
  }
  expect(auxWorkspaceContext(workspace, "C:/proj") as any).toMatchObject({ name: "group", primary: "C:/proj" })
  // 链接检出补进根列表，与主会话 `contextFor` 同一规则。
  expect((auxWorkspaceContext(workspace, "C:/proj/web") as any).roots).toContain("C:/proj/web")
  // 远程项目 P1 不支持多目录组。
  expect(auxWorkspaceContext(workspace, "ssh://host/proj")).toBeUndefined()
  expect(auxWorkspaceContext(undefined, "C:/proj")).toBeUndefined()
})

test("aux drafts stay in memory and keep the original File objects", async () => {
  vi.resetModules()
  const { auxDraftFor, saveAuxDraft, clearAuxDraft, auxDraftCount } = await import("@/stores/auxDrafts")
  const setItem = vi.fn()
  vi.stubGlobal("localStorage", { getItem: () => null, setItem, removeItem() {} })
  const file = new File(["x"], "a.png", { type: "image/png" })
  saveAuxDraft("aux:1", { text: "hi", files: [file] })
  expect(auxDraftFor("aux:1").files[0]).toBe(file)
  // 零 localStorage：aux 草稿不写 `pix.composerDrafts`（也不碰公共草稿键）。
  expect(setItem).not.toHaveBeenCalled()
  // 空草稿直接删条目，不留空项。
  saveAuxDraft("aux:1", { text: "", files: [] })
  expect(auxDraftCount()).toBe(0)
  saveAuxDraft("aux:2", { text: "second", files: [] })
  clearAuxDraft("aux:2")
  expect(auxDraftCount()).toBe(0)
  vi.unstubAllGlobals()
})
