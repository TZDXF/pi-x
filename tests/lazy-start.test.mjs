import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import { pathsModule } from "./lib/load-ts.mjs"
function harness(group = null) {
  const calls = [],
    spawnArgs = []
  const workspace = {
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
  }
  const source = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8")
    .split('<script setup lang="ts">')[1]
    .split("</script>")[0]
    .replace(/^import[\s\S]*?from ["'][^"']+["']\s*$/gm, "")
  const stores = new Map()
  const activeRuntimeId = { value: "default" }
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
  const context = vm.createContext({
    watch: () => {},
    ref: value => ({ value }),
    computed: def => ({
      get value() {
        return (typeof def === "function" ? def : def.get)()
      },
    }),
    onMounted: fn => {
      // App registers multiple mount hooks; chain them in registration order.
      const previous = context.mount
      context.mount = async () => {
        if (previous) await previous()
        await fn()
      }
    },
    onUnmounted: () => {},
    useI18n: () => ({ t: x => x, locale: { value: "en" } }),
    useSessionStore: () => new Proxy({}, { get: (_, k) => sessionFor(activeRuntimeId.value)[k] }),
    useWorkspaceStore: () => workspace,
    useUiStore: () => ({ clear() {}, pushToast() {} }),
    sessionFor,
    uiFor: () => ({ pushToast() {}, handleRequest() {}, pushStderr() {} }),
    activeRuntimeId,
    activateSession: id => {
      sessionFor(id)
      activeRuntimeId.value = id
    },
    createConversation: project => {
      const id = "rt" + ++seq
      const s = sessionFor(id)
      s.cwd = project
      activeRuntimeId.value = id
      return s
    },
    findConversation: () => undefined,
    getConfig: async () => ({ lastProject: "project" }),
    setTrayLabels: async () => {},
    tBackendError: x => x,
    onPiEvent: async () => () => {},
    onPiExit: async () => () => {},
    onPiStderr: async () => () => {},
    onReconnected: async () => () => {},
    trustStatus: async () => ({ needsDecision: false }),
    saveConfig: async () => {},
    spawnPi: async (...args) => {
      spawnArgs.push(args)
      calls.push("spawn")
    },
    killPi: async () => {},
    pixLog() {},
    listRunningSessions: async () => [],
    detectPi: async () => ({ found: true }),
    onSessionsChanged: async () => () => {},
    sessionMtime: async () => 0,
    registerSessionMtimeSync: () => {},
    useRoute: () => ({ value: { name: "home", params: {} } }),
    navigate: () => {},
    projectRoute: path => `/project/${encodeURIComponent(path)}`,
    sessionRoute: (id, project = "") => `/session/${encodeURIComponent(id)}/${encodeURIComponent(project)}`,
    samePath: pathsModule().samePath,
    normalizeSlashes: pathsModule().normalizeSlashes,
    normalizeProjectPath: pathsModule().normalizeProjectPath,
    window: { addEventListener() {}, removeEventListener() {} },
    dispatchShortcut: () => false,
    registerShortcutHandler: () => () => {},
  })
  vm.runInContext(
    ts.transpile(
      source +
        "\nglobalThis.actions = { start, selectProject, newProjectSession, resumeSession, selectQueuedConversation, connecting, selectingProject, phase };",
      { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    ),
    context,
  )
  return { context, calls, spawnArgs, workspace }
}
test("opening the app, selecting projects and drafting a new chat do not start pi", async () => {
  const { context, calls } = harness()
  await context.mount()
  await context.actions.selectProject("other")
  await context.actions.newProjectSession("other")
  expect(calls).toEqual([])
})
test("clicking new session reuses the pristine draft until a message is sent", async () => {
  const { context, calls } = harness()
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
  const { context, calls } = harness()
  await context.mount()
  expect(await context.actions.start()).toBe(true)
  expect(await context.actions.start()).toBe(true)
  expect(calls).toEqual(["spawn", "init"])
})
test("opening a saved conversation starts pi on demand", async () => {
  const { context, calls } = harness()
  await context.mount()
  await context.actions.resumeSession("session.jsonl")
  expect(calls).toEqual(["spawn", "init"])
})

test("only fresh process startup applies remembered selection", () => {
  const source = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8")
  expect(source).toMatch(
    /await spawnWorkspacePi\(project.value, undefined, owner.runtimeId\)\s+await owner.init\(project.value, true\)/,
  )
  expect((source.match(/\.init\(project.value, true\)/g) || []).length).toBe(1)
})

test("a grouped project passes every root to Pi and refreshes context on the next prompt after edits", async () => {
  const group = { name: "Both", primary: "project", folders: ["project", "other"] }
  const { context, calls, spawnArgs } = harness(group)
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
  const { context, calls } = harness()
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
  const view = readFileSync(new URL("../src/components/ChatView.vue", import.meta.url), "utf8")
  expect(view.split("(!connecting || selectingProject)").length - 1).toBe(1)
  expect(view).toMatch(/\(!connecting \|\| selectingProject \|\| workspace.gitBusy\)/)
  expect(view).toMatch(/:disabled="editBusy \|\| workspace.gitBusy \|\| connecting"/)
})

test("project selection keeps the editor enabled without bypassing other edit guards", () => {
  const view = readFileSync(new URL("../src/components/ChatView.vue", import.meta.url), "utf8")
  const editor = view.split("<ComposerRichEditor")[1].split("/>")[0]
  const expression = editor.match(/:disabled="([^"]+)"/)[1]
  const disabled = values => vm.runInNewContext(expression, values)
  const state = {
    editBusy: false,
    workspace: { gitBusy: false },
    connecting: true,
    selectingProject: true,
    completion: null,
  }
  expect(disabled(state)).toBe(false)
  expect(disabled({ ...state, selectingProject: false })).toBe(true)
  expect(disabled({ ...state, editBusy: true })).toBe(true)
  expect(disabled({ ...state, workspace: { gitBusy: true } })).toBe(true)
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
  const { context } = harness()
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
  const { context, calls } = harness()
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
  const { context, calls } = harness()
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
  const { context, calls } = harness()
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
  const { context } = harness()
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
