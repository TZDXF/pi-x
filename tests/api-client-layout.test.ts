import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  runtime: { value: "default" },
  desktop: false,
  invoke: vi.fn(async (command: string, _args?: unknown) =>
    command === "session_export_html" ? { path: "/host/session.html", html: "<html></html>" } : undefined,
  ),
  listeners: new Map<string, (event: { payload: any }) => void>(),
  unsubscribe: vi.fn(),
}))

vi.mock("@/stores/runtime", () => ({ activeRuntimeId: mocks.runtime }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }))
vi.mock("@tauri-apps/api/path", () => ({ join: vi.fn(async (...parts: string[]) => parts.join("/")) }))
vi.mock("@/api/transport", () => ({
  RECONNECTED_EVENT: "pi://reconnected",
  get isDesktop() {
    return mocks.desktop
  },
  invoke: mocks.invoke,
  listen: async (name: string, handler: (event: { payload: any }) => void) => {
    mocks.listeners.set(name, handler)
    return mocks.unsubscribe
  },
}))

const loaders = {
  config: () => import("@/api/client/config"),
  files: () => import("@/api/client/files"),
  mcp: () => import("@/api/client/mcp"),
  models: () => import("@/api/client/models"),
  packages: () => import("@/api/client/packages"),
  preview: () => import("@/api/client/preview"),
  process: () => import("@/api/client/process"),
  remote: () => import("@/api/client/remote"),
  rpc: () => import("@/api/client/rpc"),
  sessions: () => import("@/api/client/sessions"),
  skills: () => import("@/api/client/skills"),
  updates: () => import("@/api/client/updates"),
  workspace: () => import("@/api/client/workspace"),
}

// Freeze the pre-split public API, including erased TypeScript types.
const originalExports = `PiInfo TrustStatus ModelRef AppConfig PiSettings getPiSettings savePiSettings
setTrayLabels toggleDevtools HostedSkill listHostedSkills openHostedSkillsDirectory deleteHostedSkill setHostedSkillsEnabled DiscoveredSkill
listDiscoveredSkills skillListFiles skillReadFile detectPi PiUpdateStatus checkPiUpdate executePiUpdate
UpdateChannel AppUpdateStatus APP_UPDATE_PROGRESS_EVENT checkAppUpdate getAppVersion installAppUpdate restartApp getConfig
saveConfig ProjectlessDirInfo resolveProjectlessDir chooseDirectoryPath GlobalPromptFile listGlobalPrompts saveGlobalPrompt
trustStatus trustSave WorkspaceContext spawnPi killPi piRunning pixLog
SessionMeta listSessions sessionMtime sessionHistory SessionLastError sessionLastError duplicateSessionFile
onSessionsChanged FileHit searchFiles openPath openTerminalInDir exportSessionHtml exportSessionFileHtml
rpcRequest RpcImage rpcSteer rpcFollowUp rpcNotify onPiEvent onPiExit
onPiStderr onReconnected RemoteStatus remoteStatus remoteSet remotePasswordSet PreviewProxyInfo
previewProxyInfo ModelCostRates ModelFallbackModel ModelCompat ModelImageResize ModelImageInputLimits ModelInputLimits
ModelPromptCache ModelEntry ProviderEntry ModelsConfig getModelsConfig saveModelsConfig FetchedModel
fetchProviderModels updateSession listArchivedSessions deleteSession GitWorktree WorkspaceSelection prepareWorkspaceGit
WorkspaceGitInfo workspaceGitInfo createWorkspaceGit generateSessionTitle CatalogPackage InstalledPackage CatalogPage
packageCatalog packageList packageInstall packageRemove packageUpdate PackageResource packageResources
packageListFiles packageReadFile packageTranslate packageSetResource packageNameOf RunningSession listRunningSessions
McpScope McpConfigFile getMcpConfig saveMcpConfig McpToolDef McpServerStatus McpStatusResult
getMcpStatus McpCheckResult checkMcpServer`
  .split(/\s+/)
  .sort()

beforeEach(() => {
  vi.resetModules()
  mocks.invoke.mockClear()
  mocks.unsubscribe.mockClear()
  mocks.listeners.clear()
  mocks.runtime.value = "default"
  mocks.desktop = false
})

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test("compatibility barrel retains every value and type export without duplicates", async () => {
  const barrel = await import("@/api/piClient")
  const declarations: string[] = []
  const values: string[] = []
  for (const [name, load] of Object.entries(loaders)) {
    const domain = await load()
    const source = readFileSync(resolve("src/api/client", `${name}.ts`), "utf8")
    declarations.push(
      ...Array.from(source.matchAll(/^export (?:interface|type|const|function|async function) (\w+)/gm), m => m[1]),
    )
    for (const [key, value] of Object.entries(domain)) {
      values.push(key)
      expect(barrel[key as keyof typeof barrel], key).toBe(value)
    }
  }
  expect(declarations.sort()).toEqual(originalExports)
  expect(new Set(values).size).toBe(values.length)
  expect(Object.keys(barrel).sort()).toEqual(values.sort())
})

test("domain dependency graph is acyclic and never imports the compatibility barrel", () => {
  const graph = new Map<string, string[]>()
  const barrel = resolve("src/api/piClient.ts")
  for (const name of Object.keys(loaders)) {
    const file = resolve("src/api/client", `${name}.ts`)
    const source = readFileSync(file, "utf8")
    const dependencies: string[] = []
    for (const match of source.matchAll(/(?:from\s+|import\()["']([^"']+)["']/g)) {
      const specifier = match[1]
      const target = specifier.startsWith("@/")
        ? resolve("src", `${specifier.slice(2)}.ts`)
        : specifier.startsWith(".")
          ? resolve("src/api/client", `${specifier}.ts`)
          : null
      expect(target, `${name} must not import piClient`).not.toBe(barrel)
      if (target && Object.keys(loaders).some(key => target === resolve("src/api/client", `${key}.ts`))) {
        dependencies.push(target)
      }
    }
    graph.set(file, dependencies)
  }
  const done = new Set<string>()
  const visit = (file: string, stack: Set<string>) => {
    expect(stack.has(file), `cycle at ${file}`).toBe(false)
    if (done.has(file)) return
    const next = new Set(stack).add(file)
    for (const dependency of graph.get(file) ?? []) visit(dependency, next)
    done.add(file)
  }
  for (const file of graph.keys()) visit(file, new Set())
})

test("runtime defaults are evaluated at call time and explicit runtime ids still win", async () => {
  const api = await import("@/api/piClient")
  const images = [{ type: "image" as const, data: "base64", mimeType: "image/png" }]
  const calls = [
    () => api.spawnPi("/project"),
    () => api.killPi(),
    () => api.piRunning(),
    () => api.rpcRequest({ type: "get_state" }),
    () => api.rpcSteer("steer", images),
    () => api.rpcFollowUp("follow-up", images),
    () => api.rpcNotify({ type: "extension_ui_response", id: "request", value: "ok" }),
  ]
  for (const runtime of ["runtime-a", "runtime-b"]) {
    mocks.runtime.value = runtime
    for (const call of calls) {
      await call()
      expect(mocks.invoke.mock.lastCall?.[1]).toMatchObject({ runtimeId: runtime })
    }
  }
  await api.spawnPi("/project", "saved.jsonl", "explicit", { name: "work", primary: "/project", roots: ["/project"] })
  expect(mocks.invoke).toHaveBeenLastCalledWith("rpc_spawn", {
    project: "/project",
    sessionFile: "saved.jsonl",
    runtimeId: "explicit",
    workspace: { name: "work", primary: "/project", roots: ["/project"] },
  })
  await api.rpcRequest({ type: "get_state" }, "explicit")
  expect(mocks.invoke).toHaveBeenLastCalledWith("rpc_request", {
    command: { type: "get_state" },
    runtimeId: "explicit",
  })
  await api.rpcSteer("steer", images, "explicit")
  expect(mocks.invoke).toHaveBeenLastCalledWith("rpc_request", {
    command: { type: "steer", message: "steer", images },
    runtimeId: "explicit",
  })
  await api.rpcFollowUp("follow-up")
  expect(mocks.invoke).toHaveBeenLastCalledWith("rpc_request", {
    command: { type: "follow_up", message: "follow-up" },
    runtimeId: "runtime-b",
  })
})

test("session exports share the RPC layer without freezing the active runtime", async () => {
  const api = await import("@/api/piClient")
  vi.useFakeTimers()
  vi.stubGlobal("document", {
    body: { append: vi.fn() },
    createElement: () => ({ click: vi.fn(), remove: vi.fn() }),
  })
  const TestURL = class extends URL {}
  TestURL.createObjectURL = () => "blob:layout-test"
  TestURL.revokeObjectURL = vi.fn()
  vi.stubGlobal("URL", TestURL)
  mocks.runtime.value = "export-runtime"
  expect(await api.exportSessionHtml()).toBe(true)
  expect(mocks.invoke).toHaveBeenLastCalledWith("session_export_html", { runtimeId: "export-runtime" })
  expect(await api.exportSessionFileHtml("saved.jsonl")).toBe(true)
  expect(mocks.invoke).toHaveBeenLastCalledWith("session_export_html", { file: "saved.jsonl" })
  vi.runAllTimers()
})

test("domain calls preserve command names, optional nulls and title overwrite", async () => {
  const api = await import("@/api/piClient")
  const cases: [() => unknown, string, unknown][] = [
    [() => api.detectPi(), "pi_detect", { customPath: null }],
    [() => api.getMcpConfig("global"), "mcp_config_read", { scope: "global", project: null }],
    [
      () => api.saveMcpConfig("project", "{}", "/project"),
      "mcp_config_save",
      { scope: "project", content: "{}", project: "/project" },
    ],
    [() => api.checkMcpServer("global", "server"), "mcp_check", { scope: "global", name: "server", project: null }],
    [() => api.getMcpStatus(), "mcp_status", { project: null }],
    [() => api.packageInstall("npm:pkg"), "package_install", { source: "npm:pkg", scope: "global", project: null }],
    [() => api.packageUpdate(), "package_update", { source: null }],
    [
      () => api.generateSessionTitle("session.jsonl", "question"),
      "session_generate_title",
      { file: "session.jsonl", message: "question", overwrite: false },
    ],
    [
      () => api.generateSessionTitle("session.jsonl", "edit", true),
      "session_generate_title",
      { file: "session.jsonl", message: "edit", overwrite: true },
    ],
    [() => api.previewProxyInfo(), "preview_proxy_info", undefined],
    [() => api.listRunningSessions(), "rpc_sessions", undefined],
    [
      () => api.trustSave("/project", false, false),
      "trust_save",
      { project: "/project", trusted: false, trustParent: false },
    ],
  ]
  for (const [call, command, args] of cases) {
    await call()
    if (args === undefined) expect(mocks.invoke).toHaveBeenLastCalledWith(command)
    else expect(mocks.invoke).toHaveBeenLastCalledWith(command, args)
  }
  expect(api.packageNameOf("npm:@scope/pkg@1.2.3")).toBe("@scope/pkg")
})

test("RPC and session listeners forward payloads, including subagent events, unchanged", async () => {
  const api = await import("@/api/piClient")
  const event = vi.fn(),
    stderr = vi.fn(),
    exit = vi.fn(),
    sessions = vi.fn(),
    reconnect = vi.fn()
  const unsubscribe = await api.onPiEvent(event)
  await api.onPiStderr(stderr)
  await api.onPiExit(exit)
  await api.onSessionsChanged(sessions)
  await api.onReconnected(reconnect)
  const payload = { type: "subagent_update", runtimeId: "runtime", agents: [{ id: "child", state: "running" }] }
  mocks.listeners.get("pi://event")!({ payload })
  expect(event).toHaveBeenCalledWith(payload)
  expect(event.mock.lastCall?.[0]).toBe(payload)
  mocks.listeners.get("pi://stderr")!({ payload: { line: "line", runtimeId: "runtime" } })
  expect(stderr).toHaveBeenCalledWith("line", "runtime")
  mocks.listeners.get("pi://exit")!({ payload: { runtimeId: "runtime" } })
  expect(exit).toHaveBeenCalledWith("runtime")
  mocks.listeners.get("pi://sessions-changed")!({ payload: { files: ["saved.jsonl"] } })
  expect(sessions).toHaveBeenCalledWith(["saved.jsonl"])
  mocks.listeners.get("pi://reconnected")!({ payload: null })
  expect(reconnect).toHaveBeenCalledOnce()
  unsubscribe()
  expect(mocks.unsubscribe).toHaveBeenCalledOnce()
})
