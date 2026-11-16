import { afterEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"

/**
 * 远程连接多后端（docs/plans/remote-backends-contract.md §3/§4/§5.4）：
 * - resolveSshConnectionId 的 per-kind 匹配：kind 不匹配直接 false；
 *   ssh 比 host/port/user，wsl 比 distro/user，docker 比 container
 * - 旧数据迁移（契约 §3.2）：无 kind 字段的连接缺省视为 ssh，不匹配 wsl/docker URI
 * - localStorage pix.sshProjectConnections 映射键不变，URI 前缀自带 kind
 * - 表单按 kind 显隐（remoteFormFields）与 kind 入口平台守卫/不可用态（remoteKindOptions）
 * - paths.normalizeProjectPath 对 wsl://docker:// 走 POSIX 归一化
 * - workspace.refresh 对 wsl:// 项目一视同仁地走 ssh_sessions
 */

const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  connections: [] as { id: string; host: string; port?: number; user?: string | null }[],
  sshSessionsCalls: [] as { project: string; sshConnectionId: string }[],
}))

vi.mock("@/api/piClient", () => ({
  listSessions: async () => [],
  updateSession: async () => 0,
  resolveProjectlessDir: async () => ({ dir: "/tmp/ws", defaultDir: "/tmp/ws", isDefault: true }),
  workspaceGitInfo: async () => {
    throw new Error("not a repository")
  },
  sshConnectionList: async () => mocks.connections,
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

async function importSsh() {
  vi.resetModules()
  vi.stubGlobal("localStorage", localStorageFor(mocks.storage))
  return import("@/lib/ssh")
}

async function importStore() {
  vi.resetModules()
  setActivePinia(createPinia())
  vi.stubGlobal("localStorage", localStorageFor(mocks.storage))
  const { useWorkspaceStore } = await import("@/stores/workspace")
  return useWorkspaceStore()
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test("resolveSshConnectionId：wsl URI 按 distro/user 匹配 wsl 连接", async () => {
  const { resolveSshConnectionId } = await importSsh()
  const uri = "wsl://Ubuntu/home/tzdxf/pix-ssh-demo"
  const connections = [
    { id: "ssh-1", host: "ubuntu", port: 22, user: null },
    { id: "wsl-1", kind: "wsl" as const, distro: "Ubuntu", user: null },
    { id: "wsl-2", kind: "wsl" as const, distro: "Debian", user: null },
    { id: "wsl-3", kind: "wsl" as const, distro: "Ubuntu", user: "tzdxf" },
  ]
  expect(resolveSshConnectionId(uri, connections)).toBe("wsl-1")
  // user 不同不匹配
  expect(resolveSshConnectionId("wsl://tzdxf@Ubuntu/x", connections)).toBe("wsl-3")
  expect(resolveSshConnectionId("wsl://tzdxf@Ubuntu/x", connections.slice(0, 3))).toBeNull()
})

test("resolveSshConnectionId：docker URI 按 container 匹配 docker 连接", async () => {
  const { resolveSshConnectionId } = await importSsh()
  const uri = "docker://pix-docker-test/root/pix-docker-demo"
  const connections = [
    { id: "ssh-1", host: "pix-docker-test", port: 22, user: null },
    { id: "docker-1", kind: "docker" as const, container: "pix-docker-test" },
  ]
  expect(resolveSshConnectionId(uri, connections)).toBe("docker-1")
  expect(resolveSshConnectionId("docker://other/x", connections)).toBeNull()
})

test("kind 不匹配直接 false：URI 不会匹配到其它后端的连接", async () => {
  const { resolveSshConnectionId } = await importSsh()
  const connections = [
    { id: "ssh-1", host: "Ubuntu", port: 22, user: null },
    { id: "wsl-1", kind: "wsl" as const, distro: "Ubuntu", user: null },
  ]
  expect(resolveSshConnectionId("wsl://Ubuntu/x", [connections[0]!])).toBeNull()
  expect(resolveSshConnectionId("ssh://ubuntu/x", [connections[1]!])).toBeNull()
})

test("旧数据迁移：无 kind 字段的连接缺省视为 ssh，不匹配 wsl/docker URI（契约 §3.2）", async () => {
  const { resolveSshConnectionId } = await importSsh()
  const legacy = { id: "ssh-legacy", host: "host", port: 22, user: "dev" }
  expect(resolveSshConnectionId("ssh://dev@host/x", [legacy])).toBe("ssh-legacy")
  expect(resolveSshConnectionId("wsl://dev@host/x", [legacy])).toBeNull()
  expect(resolveSshConnectionId("docker://host/x", [legacy])).toBeNull()
})

test("rememberSshProjectConnection 接受三后端 URI，映射键不变", async () => {
  const { rememberSshProjectConnection, resolveSshConnectionId, forgetSshProjectConnection } = await importSsh()
  const wslUri = "wsl://Ubuntu/home/u/proj"
  const dockerUri = "docker://pix-docker-test/root/demo"
  rememberSshProjectConnection(wslUri, "wsl-1")
  rememberSshProjectConnection(dockerUri, "docker-1")
  expect(JSON.parse(mocks.storage.get("pix.sshProjectConnections")!)).toEqual({
    [wslUri]: "wsl-1",
    [dockerUri]: "docker-1",
  })
  const wslConnection = { id: "wsl-1", kind: "wsl" as const, distro: "Ubuntu", user: null }
  const dockerConnection = { id: "docker-1", kind: "docker" as const, container: "pix-docker-test" }
  expect(resolveSshConnectionId(wslUri, [wslConnection])).toBe("wsl-1")
  expect(resolveSshConnectionId(dockerUri, [dockerConnection])).toBe("docker-1")
  // 记住的连接与 URI kind 不一致时回退（此处无其它连接 → null）
  rememberSshProjectConnection(wslUri, "docker-1")
  expect(resolveSshConnectionId(wslUri, [wslConnection, dockerConnection])).toBe("wsl-1")
  forgetSshProjectConnection(wslUri)
  forgetSshProjectConnection(dockerUri)
  expect(JSON.parse(mocks.storage.get("pix.sshProjectConnections")!)).toEqual({})
  // 本地路径仍被拒绝（映射内容不变）
  rememberSshProjectConnection("C:/code", "ssh-1")
  expect(JSON.parse(mocks.storage.get("pix.sshProjectConnections")!)).toEqual({})
})

test("remoteFormFields：per-kind 字段表（契约 §5.4）", async () => {
  const { remoteFormFields } = await import("@/lib/remoteBackends")
  expect(remoteFormFields("ssh")).toEqual(["host", "port", "user", "keyPath"])
  expect(remoteFormFields("wsl")).toEqual(["distro", "user"])
  expect(remoteFormFields("docker")).toEqual(["container"])
})

test("remoteKindOptions：非 Windows 隐藏 WSL，不可用后端入口置灰并提示（契约 §4.1/§4.4）", async () => {
  const { remoteKindOptions } = await import("@/lib/remoteBackends")
  // 平台守卫：非 Windows 无 WSL 入口
  expect(remoteKindOptions({ isWindows: false, wslAvailable: null, dockerAvailable: null }).map(o => o.kind)).toEqual([
    "ssh",
    "docker",
  ])
  // Windows：三入口齐全，尚未枚举（null）时不置灰
  const pending = remoteKindOptions({ isWindows: true, wslAvailable: null, dockerAvailable: null })
  expect(pending.map(o => o.kind)).toEqual(["ssh", "wsl", "docker"])
  expect(pending.every(o => !o.disabled)).toBe(true)
  // docker daemon 未启动：入口置灰 + 提示
  const dockerDown = remoteKindOptions({ isWindows: true, wslAvailable: true, dockerAvailable: false })
  expect(dockerDown.find(o => o.kind === "docker")).toMatchObject({ disabled: true, hintKey: "ssh.dockerUnavailable" })
  expect(dockerDown.find(o => o.kind === "wsl")).toMatchObject({ disabled: false })
  // WSL 未安装：同样置灰
  const wslMissing = remoteKindOptions({ isWindows: true, wslAvailable: false, dockerAvailable: true })
  expect(wslMissing.find(o => o.kind === "wsl")).toMatchObject({ disabled: true, hintKey: "ssh.wslUnavailable" })
})

test("isWslPlatform：userAgent 平台守卫", async () => {
  const { isWslPlatform } = await importSsh()
  expect(isWslPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(true)
  expect(isWslPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(false)
  expect(isWslPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe(false)
})

test("normalizeProjectPath：wsl://docker:// 走 POSIX 归一化，大小写保留", async () => {
  vi.stubGlobal("localStorage", localStorageFor(mocks.storage))
  const { normalizeProjectPath } = await import("@/lib/paths")
  expect(normalizeProjectPath("wsl://Ubuntu/a/b///")).toBe("wsl://Ubuntu/a/b")
  expect(normalizeProjectPath("wsl://tzdxf@Ubuntu-22.04/home/dev/")).toBe("wsl://tzdxf@Ubuntu-22.04/home/dev")
  expect(normalizeProjectPath("docker://pix-docker-test/root/demo/")).toBe("docker://pix-docker-test/root/demo")
  // 非法远程 URI 保持原串（与 ssh:// 行为一致）
  expect(normalizeProjectPath("wsl://default/x")).toBe("wsl://default/x")
  // 本地路径零影响
  expect(normalizeProjectPath("C:/code/")).toBe("C:/code")
  expect(normalizeProjectPath("/home/u/proj/")).toBe("/home/u/proj")
})

test("workspace.refresh：wsl:// 项目按 per-kind 匹配连接并走 ssh_sessions", async () => {
  mocks.storage = new Map()
  mocks.sshSessionsCalls.length = 0
  const uri = "wsl://Ubuntu/home/tzdxf/pix-ssh-demo"
  mocks.connections = [{ id: "wsl-1", kind: "wsl", distro: "Ubuntu", user: null }] as never
  const store = await importStore()
  await store.refresh(uri)
  expect(mocks.sshSessionsCalls).toEqual([{ project: uri, sshConnectionId: "wsl-1" }])
  // 本地项目零影响
  await store.refresh("C:/code/local")
  expect(mocks.sshSessionsCalls).toHaveLength(1)
})
