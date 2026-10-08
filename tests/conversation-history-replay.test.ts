import { readFileSync } from "node:fs"
import { beforeEach, expect, test, vi } from "vitest"
import vm from "node:vm"
import ts from "typescript"
import { createPinia, setActivePinia } from "pinia"
import { peekConversation, findConversation, sessionFor, allConversations } from "@/stores/conversations"

const controls = vi.hoisted(() => {
  const state = {}
  return {
    state,
    piClient: {
      sessionHistory: async () => [],
      pixLog() {},
      sessionLastError: async () => null,
      sessionMtime: async () => 0,
      rpcRequest: async () => ({ success: true, data: { messages: [] } }),
    },
  }
})

vi.mock("@/api/piClient", () => controls.piClient)
vi.mock("@/api/transport", () => ({ invoke: async () => null }))
vi.mock("@/i18n", () => ({
  i18n: { global: { t: key => key } },
  tBackendError: value => String(value ?? ""),
}))
vi.mock("@/lib/checkpoints", () => ({
  createCheckpoint: async () => ({ commitOid: "oid" }),
  diffCheckpoints: async () => [],
  loadCheckpointManifest: async () => null,
  saveCheckpointManifest: async () => {},
}))
vi.mock("@/lib/fileRewind", () => ({
  fileRewindState: async () => [],
  markFileRewindState: async () => [],
}))
vi.mock("@/lib/notifications", () => ({ notifyTurnComplete() {} }))
vi.mock("@/stores/sessionRunStatus", () => ({ setSessionRunStatus() {} }))
vi.mock("@/stores/workspace", () => ({ useWorkspaceStore: () => ({}) }))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} })
})

// 回归：标题栏“返回”必须能回到上一个选择的会话。历史回放走
// App.vue 的 followConversationRoute，其路由 id 可能是运行时会话的
// runtimeId，也可能是已保存会话的文件路径，两者都必须先解析到
// 内存中的会话 store 再激活，否则会新开一个错误会话。

test("peekConversation resolves runtime ids and session files without creating stores", () => {
  const store = sessionFor("rt-1")
  store.sessionFile = "s.jsonl"
  expect(peekConversation("rt-1")).toBe(store)
  expect(peekConversation("s.jsonl")).toBe(store)
  expect(peekConversation("missing")).toBeUndefined()
  expect(allConversations().length).toBe(1)
})

const source = path => readFileSync(new URL(path, import.meta.url), "utf8")
const run = (code, context) =>
  vm.runInContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022 }), vm.createContext(context))

function replayHarness(peekResult) {
  const calls = []
  // followConversationRoute 已拆到 App 的导航 composable，按原文本切片执行。
  const app = source("../src/composables/useAppNavigation.ts")
  const code = app.slice(app.indexOf("async function followConversationRoute"), app.indexOf("async function drainNavigation"))
  const context = {
    peekConversation: () => peekResult,
    selectQueuedConversation: id => calls.push(["select", id]),
    resumeSession: (file, project) => calls.push(["resume", file, project]),
    newProjectSession: path => calls.push(["new", path]),
    project: { value: "fallback" },
  }
  run(code + "\nglobalThis.replay = followConversationRoute", context)
  const replay = route => context.replay(route)
  return { calls, replay }
}

test("back to a live conversation route activates it by runtime id, not a fresh resume", async () => {
  const { calls, replay } = replayHarness({ runtimeId: "rt-1", started: true, sessionFile: null })
  await replay({ name: "session", params: { conversation: "rt-1", project: "p" } })
  expect(calls).toEqual([["select", "rt-1"]])
})

test("back to a saved session route activates the matching store, not an empty one", async () => {
  const { calls, replay } = replayHarness({ runtimeId: "rt-9", started: true, sessionFile: "a.jsonl" })
  await replay({ name: "session", params: { conversation: "a.jsonl", project: "p" } })
  expect(calls).toEqual([["select", "rt-9"]])
})

test("a dormant conversation with a saved file goes through resume to reattach", async () => {
  const { calls, replay } = replayHarness({ runtimeId: "rt-2", started: false, sessionFile: "b.jsonl" })
  await replay({ name: "session", params: { conversation: "b.jsonl", project: "p" } })
  expect(calls).toEqual([["resume", "b.jsonl", "p"]])
})

test("a file-less conversation that lost its worker still activates from cache", async () => {
  const { calls, replay } = replayHarness({ runtimeId: "rt-3", started: false, sessionFile: null })
  await replay({ name: "session", params: { conversation: "rt-3", project: "p" } })
  expect(calls).toEqual([["select", "rt-3"]])
})

test("an unknown route id falls back to resume with the id as the session file", async () => {
  const { calls, replay } = replayHarness(undefined)
  await replay({ name: "session", params: { conversation: "c.jsonl", project: "p" } })
  expect(calls).toEqual([["resume", "c.jsonl", "p"]])
})

test("project routes replay as a new session in that project", async () => {
  const { calls, replay } = replayHarness(undefined)
  await replay({ name: "project", params: { project: "p" } })
  expect(calls).toEqual([["new", "p"]])
})

test("saved file lookup and history replay isolate local, SSH, WSL and Docker conversations", () => {
  const file = "/home/dev/.pi/agent/sessions/copied.jsonl"
  const projects = ["/project", "ssh://dev@host-a:22/project", "ssh://dev@host-b:22/project", "wsl://Ubuntu/project", "docker://box/project"]
  const owners = projects.map((project, index) => {
    const owner = sessionFor(`isolated-${index}`)
    owner.cwd = project
    owner.sessionFile = file
    return owner
  })
  projects.forEach((project, index) => {
    expect(findConversation(file, project)).toBe(owners[index])
    expect(peekConversation(file, project)).toBe(owners[index])
  })
  // Unscoped filesystem watcher/metadata callbacks refer only to local files.
  expect(findConversation(file)).toBe(owners[0])
  expect(findConversation(file, "docker://other/project")).toBeUndefined()
  expect(peekConversation(owners[2].runtimeId)).toBe(owners[2])
})
