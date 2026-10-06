import { afterEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

/**
 * 远程项目的调用侧守卫（契约 §5）与项目→连接解析：
 * - paths.normalizeProjectPath 对 ssh:// 走 POSIX 归一化，本地路径零影响
 * - workspace.rememberWorkspace 不对远程项目查 git
 * - resolveSshConnectionId：优先记住的连接，退化为 host/port/user 匹配
 * （workspace.refresh 的远程分支详见 tests/ssh-sessions-ui.test.ts）
 */

const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  requests: [] as { path: string; resolve: (rows: unknown[]) => void }[],
  gitQueries: [] as string[],
  sshConnectionListCalls: [] as string[],
  sshSessionsCalls: [] as { project: string; sshConnectionId: string }[],
}))

vi.mock("@/api/piClient", () => ({
  listSessions: (path: string) =>
    new Promise(resolve => {
      mocks.requests.push({ path, resolve })
    }),
  updateSession: async () => 0,
  resolveProjectlessDir: async () => ({ dir: "/tmp/ws", defaultDir: "/tmp/ws", isDefault: true }),
  workspaceGitInfo: (path: string) => {
    mocks.gitQueries.push(path)
    throw new Error("not a repository")
  },
  sshConnectionList: async () => {
    mocks.sshConnectionListCalls.push("list")
    return []
  },
  sshSessions: (project: string, sshConnectionId: string) => {
    mocks.sshSessionsCalls.push({ project, sshConnectionId })
    return Promise.resolve([])
  },
  pixLog: () => {},
}))

vi.mock("@/api/transport", () => ({
  invoke: async () => undefined,
}))

function localStorageFor(storage: Map<string, string>) {
  return {
    getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
    setItem: (key: string, value: string) => {
      storage.set(key, value)
    },
    removeItem: (key: string) => {
      storage.delete(key)
    },
  }
}

async function harness(initialStorage = new Map<string, string>()) {
  mocks.storage = initialStorage
  mocks.requests.length = 0
  mocks.gitQueries.length = 0
  mocks.sshConnectionListCalls.length = 0
  mocks.sshSessionsCalls.length = 0
  vi.resetModules()
  setActivePinia(createPinia())
  vi.stubGlobal("localStorage", localStorageFor(initialStorage))
  const { useWorkspaceStore } = await import("@/stores/workspace")
  return useWorkspaceStore()
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test("normalizeProjectPath：远程 URI 走 POSIX 归一化，本地路径保持原语义", async () => {
  const { normalizeProjectPath } = await import("@/lib/paths")
  expect(normalizeProjectPath("ssh://dev@host/a/b///")).toBe("ssh://dev@host/a/b")
  expect(normalizeProjectPath("ssh://Host.Example.COM/Proj")).toBe("ssh://host.example.com/Proj")
  expect(normalizeProjectPath("ssh://host/")).toBe("ssh://host/")
  // 本地项目零影响
  expect(normalizeProjectPath("C:/code/")).toBe("C:/code")
  expect(normalizeProjectPath("/home/u/proj/")).toBe("/home/u/proj")
})

test("workspace.refresh：远程项目不调 listSessions，也不扫本地盘", async () => {
  const store = await harness()
  const uri = "ssh://dev@host:2222/home/dev/proj"
  // 无匹配连接：远程分支直接失败，不触达本地 session 命令。
  await expect(store.refresh(uri)).rejects.toThrow("sshConnectionMissing")
  expect(mocks.requests).toHaveLength(0)
  expect(mocks.sshSessionsCalls).toHaveLength(0)
  expect(store.histories[uri]).toEqual([])
})

test("workspace.rememberWorkspace：远程项目跳过 git 查询，直接进项目列表", async () => {
  const store = await harness()
  const uri = "ssh://dev@host/home/dev/proj"
  await store.rememberWorkspace(uri)
  expect(mocks.gitQueries).toHaveLength(0)
  expect(store.projects).toContain(uri)
  // recentProjects 持久化的是展示 URI
  expect(JSON.parse(mocks.storage.get("pix.recentProjects")!)).toContain(uri)
})

test("resolveSshConnectionId：优先记住的连接，失效后按 host/port/user 匹配", async () => {
  const { resolveSshConnectionId, rememberSshProjectConnection, forgetSshProjectConnection } = await import("@/lib/ssh")
  const uri = "ssh://dev@host:2222/home/dev/proj"
  const connections = [
    { id: "ssh-1", host: "host", port: 2222, user: "dev" },
    { id: "ssh-2", host: "host", port: 22, user: null },
    { id: "ssh-3", host: "other", port: 22, user: "dev" },
  ]
  // 未记住时按参数匹配
  expect(resolveSshConnectionId(uri, connections)).toBe("ssh-1")
  // 记住的连接优先生效
  rememberSshProjectConnection(uri, "ssh-1")
  expect(resolveSshConnectionId(uri, connections)).toBe("ssh-1")
  // 记住的连接已删除/不匹配时回退到参数匹配
  expect(resolveSshConnectionId(uri, [connections[1]!, connections[2]!])).toBeNull()
  expect(resolveSshConnectionId(uri, [{ id: "ssh-9", host: "host", port: 2222, user: "dev" }])).toBe("ssh-9")
  // 无匹配返回 null
  expect(resolveSshConnectionId("ssh://nobody@nowhere/x", connections)).toBeNull()
  // 本地项目恒为 null
  expect(resolveSshConnectionId("C:/code", connections)).toBeNull()
  forgetSshProjectConnection(uri)
  expect(resolveSshConnectionId(uri, connections)).toBe("ssh-1")
})

test("rememberSshProjectConnection 忽略本地路径与空 id", async () => {
  const { rememberSshProjectConnection, resolveSshConnectionId } = await import("@/lib/ssh")
  rememberSshProjectConnection("C:/code", "ssh-1")
  expect(mocks.storage.has("pix.sshProjectConnections")).toBe(false)
  expect(resolveSshConnectionId("C:/code", [{ id: "ssh-1", host: "host", port: 22, user: null }])).toBeNull()
})
