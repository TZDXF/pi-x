import { composerSources, turnSources } from "./fixtures/chatSources"
import { readFileSync } from "node:fs"
import { afterEach, test, expect, vi } from "vitest"
import { parse, compileScript } from "vue/compiler-sfc"
import { transpileModule, ModuleKind, ScriptTarget } from "typescript"
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

async function loadVueSetup(source, require) {
  const { descriptor } = parse(source, { filename: "App.vue" })
  const compiled = compileScript(descriptor, { id: "app-test" }).content
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
  return module.exports.default.setup({}, { expose: () => {}, emit: () => {} })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

async function harness(group = null) {
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} })
  const calls = []
  const spawnArgs = []
  const workspace = reactive({
    projectRoot: path => path,
    projectName: path => path,
    projectGroups: group ? { project: group } : {},
    // App 挂载即解析无项目会话目录（不阻塞启动），桩掉即可。
    ensureProjectless: async () => "",
    projectlessDefault: "",
    isProjectless: () => false,
    // 移除项目标记：默认没有任何已移除项目。
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
        init: async () => calls.push("init"),
        loadHistory: async () => {},
        loadOfflineModels: async () => {},
      })
    return stores.get(id)
  }
  const context = {
    mount: undefined,
    findConversation: () => undefined,
    trustStatus: async () => ({ needsDecision: false }),
    spawnPi: async (...args) => {
      spawnArgs.push(args)
      calls.push("spawn")
    },
    killPi: async () => {},
    listRunningSessions: async () => [],
  }
  let mountHooks = []
  const dependencies = {
    vue: {
      ...vueRuntime,
      onMounted: fn => {
        mountHooks.push(fn)
        context.mount = async () => {
          for (const hook of mountHooks) await hook()
        }
      },
      onUnmounted: () => {},
      watch: () => {},
    },
    "vue-i18n": { useI18n: () => ({ t: x => x, locale: ref("en") }) },
    "@vueuse/core": {
      useMediaQuery: () => ref(false),
      useWindowSize: () => ({ width: ref(1200), height: ref(800) }),
    },
    "@/composables/useWorkspaceSidebarLayout": { useWorkspaceSidebarLayout },
    "@/api/transport": { isDesktop: false },
    "@/api/piClient": {
      detectPi: async () => ({ found: true }),
      prepareWorkspaceGit: async () => ({}),
      workspaceGitInfo: async () => ({}),
      exportSessionFileHtml: async () => true,
      listRunningSessions: (...args) => context.listRunningSessions(...args),
      getConfig: async () => ({ lastProject: "project" }),
      killPi: (...args) => context.killPi(...args),
      onPiEvent: async () => () => {},
      pixLog: () => {},
      onPiExit: async () => () => {},
      onPiStderr: async () => () => {},
      onReconnected: async () => () => {},
      onSessionsChanged: async () => () => {},
      saveConfig: async () => {},
      sessionMtime: async () => 0,
      setTrayLabels: async () => {},
      spawnPi: (...args) => context.spawnPi(...args),
      trustSave: async () => {},
      trustStatus: (...args) => context.trustStatus(...args),
    },
    "@/stores/conversations": {
      useSessionStore: () => new Proxy({}, { get: (_, key) => sessionFor(activeRuntimeId.value)[key] }),
      sessionFor,
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
      findConversation: (...args) => context.findConversation(...args),
      useUiStore: () => ({ clear() {}, pushToast() {} }),
    },
    "@/stores/workspace": { useWorkspaceStore: () => workspace, registerSessionMtimeSync: () => {} },
    "@/stores/appUpdate": { useAppUpdateStore: () => ({ autoCheck: async () => {} }) },
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
    "@/composables/useProjectActions": { useProjectActions },
    "@/composables/useSessionOpening": { useSessionOpening },
    "@/composables/useAppShortcuts": { useAppShortcuts },
    "@/lib/paths": paths,
    "@/lib/backendError": backendError,
    "@/i18n": { tBackendError: value => value },
    "@/lib/shortcuts": { dispatchShortcut: () => false, registerShortcutHandler: () => () => {} },
  }
  const bindings = await loadVueSetup(appSource, dependencies)
  context.actions = {
    start: bindings.start,
    selectProject: bindings.selectProject,
    newProjectSession: bindings.newProjectSession,
    resumeSession: bindings.resumeSession,
    selectQueuedConversation: bindings.selectQueuedConversation,
    spawnWorkspacePi: bindings.spawnWorkspacePi,
    connecting: bindings.connecting,
    selectingProject: bindings.selectingProject,
    phase: bindings.phase,
  }
  context.activeRuntimeId = bindings.activeRuntimeId ?? activeRuntimeId
  context.sessionFor = bindings.sessionFor ?? sessionFor
  return { context, calls, spawnArgs, workspace }
}

test("opening the app, selecting projects and drafting a new chat do not start pi", async () => {
  const { context, calls } = await harness()
  await context.mount()
  await context.actions.selectProject("other")
  await context.actions.newProjectSession("other")
  expect(calls).toEqual([])
})
test("clicking new session reuses the pristine draft until a message is sent", async () => {
  const { context, calls } = await harness()
  await context.mount()
  await context.actions.newProjectSession("project")
  expect(context.activeRuntimeId.value).toBe("rt1")
  await context.actions.newProjectSession("project")
  expect(context.activeRuntimeId.value).toBe("rt1")
  context.sessionFor("rt1").entries = [{ kind: "user" }]
  await context.actions.newProjectSession("project")
  expect(context.activeRuntimeId.value).toBe("rt2")
  expect(calls).toEqual([])
})
test("first conversation starts pi and reuses the initialized process", async () => {
  const { context, calls } = await harness()
  await context.mount()
  expect(await context.actions.start()).toBe(true)
  expect(await context.actions.start()).toBe(true)
  expect(calls).toEqual(["spawn", "init"])
})
test("opening a saved conversation starts pi on demand", async () => {
  const { context, calls } = await harness()
  await context.mount()
  await context.actions.resumeSession("session.jsonl")
  expect(calls).toEqual(["spawn", "init"])
})

test("only fresh process startup applies remembered selection", () => {
  const source = readFileSync(new URL("../src/lib/workspaceStartup.ts", import.meta.url), "utf8")
  expect(source).toMatch(
    /await spawnWorkspacePi\(owner\.cwd \|\| project\.value, undefined, owner\.runtimeId\)\s+pixLog\([^\n]*\)\s+await owner\.init\(owner\.cwd \|\| project\.value, true\)/,
  )
  expect((source.match(/\.init\(owner\.cwd \|\| project\.value, true\)/g) || []).length).toBe(1)
})

test("a grouped project passes every root to Pi and refreshes context on the next prompt after edits", async () => {
  const group = { name: "Both", primary: "project", folders: ["project", "other"] }
  const { context, calls, spawnArgs } = await harness(group)
  await context.mount()
  await context.actions.selectProject("project")
  expect(await context.actions.start()).toBe(true)
  expect(spawnArgs[0][3], JSON.stringify(spawnArgs)).toBeTruthy()
  expect(spawnArgs[0].length, "worker startup has no tool-permission arguments").toBe(4)
  expect(Array.from(spawnArgs[0][3].roots)).toEqual(["project", "other"])
  expect(spawnArgs[0][3].name).toBe("Both")
  context.sessionFor(context.activeRuntimeId.value).sessionFile = "saved.jsonl"
  group.name = "Renamed"
  expect(await context.actions.start()).toBe(true)
  expect(spawnArgs[1][3].name).toBe("Renamed")
  expect(calls).toEqual(["spawn", "init", "spawn", "init"])
})

test("cross-project drafts stay visible during checks while sending remains blocked", async () => {
  const { context, calls } = await harness()
  await context.mount()
  let resolveTrust
  context.trustStatus = () =>
    new Promise(resolve => {
      resolveTrust = resolve
    })
  const pending = context.actions.newProjectSession("other")
  await new Promise(resolve => setImmediate(resolve))
  expect(context.sessionFor(context.activeRuntimeId.value).cwd).toBe("other")
  expect(context.actions.phase.value).toBe("chat")
  expect(context.actions.selectingProject.value).toBe(true)
  expect(context.actions.connecting.value).toBe(true)
  expect(await context.actions.start()).toBe(false)
  expect(calls).toEqual([])
  resolveTrust({ needsDecision: true })
  await pending
  expect(context.actions.phase.value).toBe("trust")
  expect(await context.actions.start()).toBe(false)
  expect(context.actions.selectingProject.value).toBe(false)
  expect(context.actions.connecting.value).toBe(false)
  expect(calls).toEqual([])
  const view = composerSources() + turnSources()
  expect(view.split("(!connecting || selectingProject)").length - 1).toBe(1)
  expect(view).toMatch(/\(!connecting \|\| selectingProject \|\| gitBusy\)/)
  expect(view).toMatch(/:disabled="editBusy \|\| gitBusy \|\| connecting"/)
})

test("project selection keeps the editor enabled without bypassing other edit guards", () => {
  const view = composerSources() + turnSources()
  const editor = view.split("<ComposerRichEditor")[1].split("/>")[0]
  const expression = editor.match(/:disabled="([^"]+)"/)[1]
  const state = {
    editBusy: false,
    gitBusy: false,
    connecting: true,
    selectingProject: true,
    completion: null,
  }
  const disabled = values => new Function(...Object.keys(values), `return (${expression})`)(...Object.values(values))
  expect(disabled(state)).toBe(false)
  expect(disabled({ ...state, selectingProject: false })).toBe(true)
  expect(disabled({ ...state, editBusy: true })).toBe(true)
  expect(disabled({ ...state, gitBusy: true })).toBe(true)
})

test("disabled accessory buttons do not dim the entire composer", () => {
  const group = readFileSync(new URL("../src/components/ui/input-group/InputGroup.vue", import.meta.url), "utf8")
  expect(group).not.toMatch(/has-disabled:/)
  for (const style of ["bg-input/50", "bg-input/80", "opacity-50"]) {
    expect(group.includes(`has-[[data-slot=input-group-control]:disabled]:${style}`)).toBeTruthy()
  }
  const editor = readFileSync(new URL("../src/components/ComposerRichEditor.vue", import.meta.url), "utf8")
  expect(editor.includes("aria-disabled:opacity-50")).toBeTruthy()
})

test("resuming across projects selects the saved identity before startup and loads history in parallel", async () => {
  const { context } = await harness()
  await context.mount()
  let releaseSpawn
  context.spawnPi = () =>
    new Promise(resolve => {
      releaseSpawn = resolve
    })
  const pending = context.actions.resumeSession("saved.jsonl", "other")
  const owner = context.sessionFor(context.activeRuntimeId.value)
  expect(owner.sessionFile).toBe("saved.jsonl")
  expect(owner.cwd).toBe("other")
  expect(context.actions.selectingProject.value).toBe(false)
  // Wait for trust/config checks to reach worker startup.
  for (let i = 0; i < 20 && !releaseSpawn; i++) await Promise.resolve()
  expect(releaseSpawn).toBeTruthy()
  let releaseInit
  let historyLoaded = false
  owner.clear = () => {
    owner.sessionFile = null
  }
  owner.init = () =>
    new Promise(resolve => {
      releaseInit = resolve
    })
  owner.loadHistory = async () => {
    historyLoaded = true
  }
  releaseSpawn()
  for (let i = 0; i < 20 && !releaseInit; i++) await Promise.resolve()
  expect(historyLoaded).toBe(true)
  expect(owner.sessionFile).toBe("saved.jsonl")
  releaseInit()
  await pending
  expect(owner.started).toBe(true)
})

test("selecting a queued new conversation reattaches its runtime without clearing or restarting", async () => {
  const { context, calls } = await harness()
  await context.mount()
  const pending = context.sessionFor(context.activeRuntimeId.value)
  pending.started = true
  pending.promptQueue = [{ text: "later", sendAt: Date.now() + 60000 }]
  const id = context.activeRuntimeId.value
  await context.actions.newProjectSession("project")
  expect(context.activeRuntimeId.value).not.toBe(id)
  await context.actions.selectQueuedConversation(id)
  expect(context.activeRuntimeId.value).toBe(id)
  expect(pending.promptQueue.length).toBe(1)
  expect(calls).toEqual([])
})

test("opening a running scheduled session attaches to its existing worker without spawning", async () => {
  const { context, calls } = await harness()
  await context.mount()
  const owner = context.sessionFor("schedule-unique-run")
  owner.cwd = "project"
  owner.markRunning = () => calls.push("running")
  context.listRunningSessions = async () => [
    { runtimeId: owner.runtimeId, project: "project", state: { sessionFile: "scheduled.jsonl", isStreaming: true } },
  ]
  await context.actions.resumeSession("scheduled.jsonl", "project")
  expect(context.activeRuntimeId.value).toBe(owner.runtimeId)
  expect(owner.started).toBe(true)
  expect(owner.isStreaming).toBe(true)
  expect(owner.sessionFile).toBe("scheduled.jsonl")
  expect(calls.includes("spawn")).toBe(false)
  expect(context.actions.phase.value).toBe("chat")
})

test("opening an observed scheduled session preserves its live output", async () => {
  const { context, calls } = await harness()
  await context.mount()
  const owner = context.sessionFor("schedule-observed")
  Object.assign(owner, {
    cwd: "project",
    started: true,
    isStreaming: true,
    sessionFile: "scheduled.jsonl",
    partialBlocks: [{ type: "text", text: "Working" }],
  })
  context.findConversation = () => owner
  await context.actions.resumeSession("scheduled.jsonl", "project")
  expect(context.activeRuntimeId.value).toBe(owner.runtimeId)
  expect(owner.partialBlocks[0].text).toBe("Working")
  expect(calls).toEqual([])
})

test("failed attachment never kills a backend-owned scheduled worker", async () => {
  const { context } = await harness()
  await context.mount()
  const owner = context.sessionFor("schedule-failed-attach")
  owner.init = async () => {
    throw new Error("Metadata temporarily unavailable")
  }
  const killed = []
  context.killPi = async id => killed.push(id)
  context.listRunningSessions = async () => [
    { runtimeId: owner.runtimeId, project: "project", state: { sessionFile: "scheduled.jsonl", isStreaming: true } },
  ]
  await context.actions.resumeSession("scheduled.jsonl", "project")
  expect(killed).toEqual([])
})

test("an empty project directory never reaches spawn and reports a coded error", async () => {
  const { context, calls } = await harness()
  await context.mount()
  // 回归：空目录曾直接传给后端并以晦涩的 os error 123 失败。
  await expect(context.actions.spawnWorkspacePi("")).rejects.toThrow("projectDirMissing")
  expect(calls).toEqual([])
  // 空目录同样不能创建会话：selectProject 与 newProjectSession 直接忽略。
  await context.actions.selectProject("")
  await context.actions.newProjectSession("")
  expect(calls).toEqual([])
})
