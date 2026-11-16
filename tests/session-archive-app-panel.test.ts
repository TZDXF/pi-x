import { afterEach, expect, test, vi } from "vitest"
import { compileScript, parse } from "vue/compiler-sfc"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import { reactive, ref } from "vue"
import * as vueRuntime from "vue"
import appSource from "@/App.vue?raw"
import * as paths from "@/lib/paths"
import * as backendError from "@/lib/backendError"
import { createConversationLoader } from "@/lib/conversationLoader"
import { createWorkspaceRuntime } from "@/lib/workspaceRuntime"
import { createWorkspaceStartup } from "@/lib/workspaceStartup"
import { useWorkspaceSidebarLayout } from "@/composables/useWorkspaceSidebarLayout"
// App 的职责 composable 用真实实现（其运行时依赖全部来自 App 注入的桩）。
import { useAppNavigation } from "@/composables/useAppNavigation"
import { useProjectActions } from "@/composables/useProjectActions"
import { useSessionOpening } from "@/composables/useSessionOpening"
import { useAppShortcuts } from "@/composables/useAppShortcuts"
import { useWorkspaceLayout } from "@/composables/useWorkspaceLayout"
import { useArchivedSessionPanel } from "@/composables/useArchivedSessionPanel"
import { announceSessionArchived } from "@/lib/sessionArchiveEvents"
import * as sessionIdentity from "@/lib/sessionIdentity"
import * as sshTrust from "@/lib/sshTrust"
import * as boardPanelSessionsModule from "@/lib/boardPanelSessions"

// 归档收敛面板（TZD-121）在**真实 App setup** 上跑：布局切换、`showKanban`、
// `rightSidebarOpen` 与看板详情都是真实代码路径，只有 pi/RPC/存储是桩。
// 覆盖质量工程师的两处复现：隐藏/已关闭的看板选择不得干扰聊天侧栏。

const scopes: ReturnType<typeof vueRuntime.effectScope>[] = []
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  vi.unstubAllGlobals()
})

async function loadVueSetup(source, require, props = {}) {
  const { descriptor } = parse(source, { filename: "App.vue" })
  const compiled = compileScript(descriptor, { id: "app-archive-panel-test", inlineTemplate: false }).content
  const output = transpileModule(compiled, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  const requireModule = id => (id in require ? require[id] : {})
  new Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports,
    requireModule,
    module,
    "App.vue",
    import.meta.dirname,
  )
  return module.exports.default.setup(props, { expose: () => {}, emit: () => {} })
}

async function harness() {
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} })
  const workspace = reactive({
    projectRoot: path => path,
    projectName: path => path,
    projectGroups: {},
    boardDrafts: {},
    ensureProjectless: async () => "",
    projectlessDefault: "",
    syncState: async () => {},
    applyState: () => {},
    isProjectless: () => false,
    isRemovedProject: () => false,
    unremoveProject: () => {},
  })
  const stores = new Map()
  const activeRuntimeId = ref("default")
  let seq = 0
  const sessionFor = id => {
    if (!stores.has(id))
      stores.set(id, {
        runtimeId: id,
        started: false,
        cwd: "",
        entries: [],
        sessionFile: null,
        clear() {},
        init: async () => {},
        loadHistory: async () => {},
        loadOfflineModels: async () => {},
      })
    return stores.get(id)
  }
  const peekConversation = id => (id ? stores.get(id) : undefined)
  let mountHooks = []
  const dependencies = {
    vue: {
      ...vueRuntime,
      onMounted: fn => mountHooks.push(fn),
      onUnmounted: () => {},
      watch: vueRuntime.watch,
    },
    "vue-i18n": { useI18n: () => ({ t: x => x, locale: ref("en") }) },
    "@vueuse/core": {
      useMediaQuery: () => ref(false),
      useWindowSize: () => ({ width: ref(1200), height: ref(800) }),
    },
    "@/composables/useWorkspaceSidebarLayout": { useWorkspaceSidebarLayout },
    "@/composables/useWorkspaceLayout": { useWorkspaceLayout },
    // 看板模型只替换成可控桩：真实 useKanbanWorkspace 的草稿演进由
    // tests/session-archive-board-panel.test.ts 单独覆盖（两个文件各守一段）。
    "@/composables/useKanbanWorkspace": {
      useKanbanWorkspace: () => ({
        cards: ref([]),
        projects: ref([]),
        selection: ref(null),
        selectedCard: ref(null),
        selectedDraft: ref(null),
        detailsOpen: ref(false),
        selectedProject: ref(""),
      }),
    },
    "@/composables/useSessionActivitySync": { useSessionActivitySync: () => {} },
    "@/lib/sessionIdentity": sessionIdentity,
    "@/lib/sshTrust": sshTrust,
    "@/api/transport": { isDesktop: false },
    "@/api/piClient": {
      detectPi: async () => ({ found: true }),
      prepareWorkspaceGit: async () => ({}),
      workspaceGitInfo: async () => ({}),
      exportSessionFileHtml: async () => true,
      listRunningSessions: async () => [],
      getConfig: async () => ({ lastProject: "project" }),
      killPi: async () => {},
      onPiEvent: async () => () => {},
      pixLog: () => {},
      onPiExit: async () => () => {},
      onPiStderr: async () => () => {},
      onSshPathBound: async () => () => {},
      onReconnected: async () => () => {},
      onWorkspaceStateChanged: async () => () => {},
      onSessionsChanged: async () => () => {},
      saveConfig: async () => {},
      sessionMtime: async () => 0,
      setTrayLabels: async () => {},
      spawnPi: async () => {},
      trustSave: async () => {},
      trustStatus: async () => ({ needsDecision: false }),
    },
    "@/stores/conversations": {
      useSessionStore: () => new Proxy({}, { get: (_, key) => sessionFor(activeRuntimeId.value)[key] }),
      sessionFor,
      peekConversation,
      uiFor: () => ({ pushToast() {}, handleRequest() {}, pushStderr() {} }),
      activeRuntimeId,
      activateSession: id => {
        sessionFor(id)
        activeRuntimeId.value = id
      },
      createConversation: project => {
        const id = `rt${++seq}`
        const session = sessionFor(id)
        session.cwd = project
        activeRuntimeId.value = id
        return session
      },
      findConversation: () => undefined,
      useUiStore: () => ({ clear() {}, pushToast() {} }),
    },
    "@/stores/workspace": { useWorkspaceStore: () => workspace, registerSessionMtimeSync: () => {} },
    "@/stores/appUpdate": {
      useAppUpdateStore: () => ({ autoCheck: async () => {}, startProgressListener: async () => {} }),
    },
    "@/lib/router": {
      useRoute: () => ref({ name: "home", params: {} }),
      navigate: () => {},
      goHome: () => {},
      projectRoute: path => `/project/${encodeURIComponent(path)}`,
      sessionRoute: (id, project = "") => `/session/${encodeURIComponent(id)}/${encodeURIComponent(project)}`,
    },
    "@/stores/sessionRunStatus": { acknowledgeSessionRunStatus: () => {}, sessionRunStatus: () => undefined },
    "@/lib/conversationLoader": { createConversationLoader },
    "@/lib/workspaceRuntime": { createWorkspaceRuntime },
    "@/lib/workspaceStartup": { createWorkspaceStartup },
    "@/composables/useAppNavigation": { useAppNavigation },
    "@/composables/useSessionNotificationNavigation": { useSessionNotificationNavigation: () => () => {} },
    // 这里用真实实现：整个文件的目的就是让归档监听接上真实 App 状态。
    "@/composables/useArchivedSessionPanel": { useArchivedSessionPanel },
    "@/lib/sessionArchiveEvents": { announceSessionArchived, onSessionArchived: () => () => {} },
    // 用真实实现：草稿索引/活运行时的身份汇总是被测逻辑的一部分。
    "@/lib/boardPanelSessions": boardPanelSessionsModule,
    "@/lib/notifications": { onSessionNotificationActivated: async () => () => {} },
    "@/composables/useProjectActions": { useProjectActions },
    "@/composables/useSessionOpening": { useSessionOpening },
    "@/composables/useAppShortcuts": { useAppShortcuts },
    "@/lib/paths": paths,
    "@/lib/backendError": backendError,
    "@/i18n": { tBackendError: value => value },
    "@/lib/shortcuts": { dispatchShortcut: () => false, registerShortcutHandler: () => () => {} },
    "@/lib/configPreference": { initializeConfigPreferences: async () => true },
  }
  const scope = vueRuntime.effectScope()
  scopes.push(scope)
  const actions = await scope.run(() => loadVueSetup(appSource, dependencies))
  return { actions, sessionFor, workspace }
}

/** 草稿索引里的条目（App 用它把 draftId 解析成已落盘的会话身份）。 */
const workspaceDraft = (workspace: { boardDrafts: Record<string, unknown> }, id = "draft-1") =>
  (workspace.boardDrafts[id] ??= { id }) as Record<string, unknown>

/** 看板里打开会话 A 并切到聊天布局 —— `App.vue` 切布局只清 `detailsOpen`，选择会留下。 */
function openBoardCardInChat(actions, detailsOpen: boolean) {
  actions.phase.value = "chat"
  actions.changeWorkspaceLayout("board")
  actions.board.selection = { file: "/sessions/A.jsonl", cwd: "/project" }
  actions.board.detailsOpen = detailsOpen
  actions.changeWorkspaceLayout("chat")
}

test("hidden board selection of another session must not close the visible chat sidebar", async () => {
  const { actions, sessionFor } = await harness()
  openBoardCardInChat(actions, true)
  Object.assign(sessionFor("default"), { sessionFile: "/sessions/B.jsonl", cwd: "/project" })
  actions.rightSidebarOpen.value = true
  expect(actions.showKanban.value).toBe(false)
  announceSessionArchived({ file: "/sessions/A.jsonl", project: "/project" })
  // 聊天布局显示的是 B：它的侧栏与主会话都不能被隐藏的 A 影响。
  expect(sessionFor("default").sessionFile).toBe("/sessions/B.jsonl")
  expect(actions.rightSidebarOpen.value).toBe(true)
})

test("a closed board panel must not suppress closure of the active chat session", async () => {
  const { actions, sessionFor } = await harness()
  openBoardCardInChat(actions, false)
  Object.assign(sessionFor("default"), { sessionFile: "/sessions/A.jsonl", cwd: "/project" })
  actions.rightSidebarOpen.value = true
  announceSessionArchived({ file: "/sessions/A.jsonl", project: "/project" })
  expect(actions.rightSidebarOpen.value).toBe(false)
})

test("a visible board panel closes its details and sidebar for the archived session", async () => {
  const { actions } = await harness()
  actions.phase.value = "chat"
  actions.changeWorkspaceLayout("board")
  actions.board.selection = { file: "/sessions/A.jsonl", cwd: "/project" }
  actions.board.detailsOpen = true
  actions.rightSidebarOpen.value = true
  announceSessionArchived({ file: "/sessions/A.jsonl", project: "/project" })
  expect(actions.board.selection).toBe(null)
  expect(actions.board.detailsOpen).toBe(false)
  expect(actions.rightSidebarOpen.value).toBe(false)
})

test("a draft card that gained a file closes the board panel through the draft index", async () => {
  const { actions, workspace } = await harness()
  actions.phase.value = "chat"
  actions.changeWorkspaceLayout("board")
  // 打开面板时的快照是草稿卡（只有 draftId），真实身份在草稿索引里。
  actions.board.selection = { draftId: "draft-1", cwd: "/project" }
  actions.board.detailsOpen = true
  actions.rightSidebarOpen.value = true
  Object.assign(workspaceDraft(workspace), { id: "draft-1", project: "/project", sessionFile: "/sessions/new.jsonl" })
  announceSessionArchived({ file: "/sessions/new.jsonl", project: "/project" })
  expect(actions.board.selection).toBe(null)
  expect(actions.board.detailsOpen).toBe(false)
  expect(actions.rightSidebarOpen.value).toBe(false)
})

test("archiving an unrelated session keeps the visible board panel and conversation", async () => {
  const { actions, sessionFor } = await harness()
  actions.phase.value = "chat"
  actions.changeWorkspaceLayout("board")
  actions.board.selection = { file: "/sessions/A.jsonl", cwd: "/project" }
  actions.board.detailsOpen = true
  actions.rightSidebarOpen.value = true
  Object.assign(sessionFor("default"), { sessionFile: "/sessions/A.jsonl", cwd: "/project" })
  announceSessionArchived({ file: "/sessions/other.jsonl", project: "/project" })
  expect(actions.board.selection).toEqual({ file: "/sessions/A.jsonl", cwd: "/project" })
  expect(actions.board.detailsOpen).toBe(true)
  expect(actions.rightSidebarOpen.value).toBe(true)
})
