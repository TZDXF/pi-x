import { afterEach, expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import { createPinia, setActivePinia } from "pinia"
import { isAbsolutePath, samePath } from "@/lib/paths"
import en from "@/i18n/locales/en"
import zhCN from "@/i18n/locales/zh-CN"

const mocks = vi.hoisted(() => ({
  resolveProjectlessDir: async () => {
    throw new Error("resolveProjectlessDir was not configured")
  },
}))

vi.mock("@/api/piClient", () => ({
  listSessions: async () => [],
  updateSession: async () => 0,
  resolveProjectlessDir: (...args) => mocks.resolveProjectlessDir(...args),
  workspaceGitInfo: async () => ({}),
}))
vi.mock("@/api/transport", () => ({
  invoke: async () => null,
}))
vi.mock("@/i18n", () => ({
  i18n: {
    global: {
      t: key => (key === "projectless.name" ? "无项目会话" : key),
    },
  },
}))

const DEFAULT_DIR = "C:/Users/you/.pix/workspace"
const LABEL = "无项目会话"

// isolate:false 下，先前文件的 mock 可能已随 workspace store 一起实例化并被模块缓存；
// 重置缓存后动态导入，确保 store 的 piClient 绑定到本文件的 mock。
vi.resetModules()
const { useWorkspaceStore } = await import("@/stores/workspace")

afterEach(() => {
  vi.unstubAllGlobals()
  setActivePinia(undefined)
})

/** 建立 Pinia 真实 setup store；后端解析命令按用例注入。 */
function storeHarness({ dir = DEFAULT_DIR, defaultDir = DEFAULT_DIR, failures = 0 } = {}) {
  const calls = []
  const storage = new Map()
  let remaining = failures
  mocks.resolveProjectlessDir = async () => {
    calls.push(1)
    if (remaining > 0) {
      remaining--
      throw new Error('PIXERR:{"code":"projectlessDirUnusable","fallback":"无法使用无项目会话目录"}')
    }
    return { dir, defaultDir, isDefault: samePath(dir, defaultDir) }
  }
  vi.stubGlobal("localStorage", {
    getItem: key => storage.get(key),
    setItem: (key, value) => storage.set(key, value),
  })
  setActivePinia(createPinia())
  return { store: useWorkspaceStore(), calls, storage }
}

test("无项目会话目录在首次使用时解析并复用同一次请求", async () => {
  const h = storeHarness()
  expect(h.store.projectless).toBe("")
  expect(await h.store.ensureProjectless()).toBe(DEFAULT_DIR)
  expect(await h.store.ensureProjectless()).toBe(DEFAULT_DIR)
  expect(h.calls.length).toBe(1)
  expect(h.store.projectless).toBe(DEFAULT_DIR)
  expect(h.store.projectlessDefault).toBe(DEFAULT_DIR)
})

test("设置改动后重新解析无项目会话目录", async () => {
  const h = storeHarness({ dir: "D:/pix/scratch", defaultDir: DEFAULT_DIR })
  expect(await h.store.ensureProjectless()).toBe("D:/pix/scratch")
  expect(h.store.isProjectless("D:/pix/scratch")).toBe(true)
  expect(await h.store.refreshProjectless()).toBe("D:/pix/scratch")
  // refresh 必须绕过缓存，否则设置改动要等重启才生效。
  expect(h.calls.length).toBe(2)
})

test("解析失败不缓存，重试仍可成功", async () => {
  const h = storeHarness({ failures: 1 })
  await expect(h.store.ensureProjectless()).rejects.toThrow()
  expect(h.store.projectless).toBe("")
  expect(await h.store.ensureProjectless()).toBe(DEFAULT_DIR)
})

test("isProjectless 忽略分隔符、尾斜杠与 Windows 大小写", async () => {
  const h = storeHarness()
  await h.store.ensureProjectless()
  expect(h.store.isProjectless("C:\\Users\\you\\.pix\\workspace")).toBe(true)
  expect(h.store.isProjectless("c:/users/you/.pix/workspace/")).toBe(true)
  expect(h.store.isProjectless("C:/Users/you/.pix/workspace-notes")).toBe(false)
  expect(h.store.isProjectless("")).toBe(false)
})

test("未解析时不会把任何路径当成无项目会话", () => {
  const h = storeHarness()
  expect(h.store.isProjectless("C:/Users/you/.pix/workspace")).toBe(false)
})

test("无项目会话显示专用名称，普通项目仍显示目录名或项目名", async () => {
  const h = storeHarness()
  await h.store.ensureProjectless()
  h.store.createProject({ name: "工作区", folders: ["C:/code/app"], primary: "C:/code/app" })
  expect(h.store.projectName(DEFAULT_DIR)).toBe(LABEL)
  expect(h.store.projectName("C:\\Users\\you\\.pix\\workspace")).toBe(LABEL)
  expect(h.store.projectName("C:/code/demo")).toBe("demo")
  expect(h.store.projectName("C:/code/app")).toBe("工作区")
})

test("isAbsolutePath 只接受绝对路径与 ~ 前缀", () => {
  for (const value of ["C:\\work", "D:/work", "/home/you/work", "\\\\server\\share", "~", "~/work", "~\\work"]) {
    expect(isAbsolutePath(value), `${value} 应被接受`).toBe(true)
  }
  for (const value of ["work", "./work", "../work", "C:work", "~other/work"]) {
    expect(isAbsolutePath(value), `${value} 应被拒绝`).toBe(false)
  }
})

test("samePath 归一化分隔符与尾斜杠，POSIX 路径区分大小写", () => {
  expect(samePath("C:\\Users\\you\\work", "c:/users/you/work/")).toBe(true)
  expect(samePath("/home/you/work", "/home/you/work/")).toBe(true)
  expect(samePath("/home/you/Work", "/home/you/work")).toBe(false)
  expect(samePath("a/../b", "b")).toBe(false)
  expect(samePath("", "/home/you")).toBe(false)
  // 同前缀但不是同一目录时不能误判。
  expect(samePath("/home/you/work", "/home/you/work-notes")).toBe(false)
})

test("入口、设置项与后端命令均已接线", () => {
  const read = path => readFileSync(new URL(path, import.meta.url), "utf8")
  // 后端：默认目录在 .pix 下、命令已注册、远程端可代理并保存该配置。
  expect(read("../src-tauri/src/data_dir.rs")).toMatch(/join\("workspace"\)/)
  expect(read("../src-tauri/src/lib.rs")).toMatch(/commands::projectless_dir_resolve/)
  expect(read("../src-tauri/src/remote.rs")).toMatch(/"projectless_dir_resolve" =>/)
  expect(read("../src-tauri/src/remote.rs")).toMatch(/cfg\.projectless_dir = a\["config"\]\["projectlessDir"\]/)
  // 前端：欢迎页/侧栏入口、设置页，以及会话空状态使用项目显示名。
  expect(read("../src/App.vue")).toMatch(/@open-projectless="openProjectless"/)
  expect(read("../src/App.vue")).toMatch(/@projectless="openProjectlessFromSidebar"/)
  expect(read("../src/components/WelcomeView.vue")).toMatch(/emit\('openProjectless'\)/)
  expect(read("../src/components/WorkspaceSidebar.vue")).toMatch(/emit\('projectless'\)/)
  expect(read("../src/components/settings/WorkspaceSettings.vue")).toMatch(/<ProjectlessSettings \/>/)
  expect(read("../src/components/settings/ProjectlessSettings.vue")).toMatch(/projectlessDir: next \?\? undefined/)
  expect(read("../src/components/ChatView.vue")).toMatch(/workspace\.projectName\(project\)/)
})

test("无项目会话文案在两种语言中保持同步", () => {
  const messages = { "zh-CN": zhCN, en }
  const flatten = (value, prefix = "") =>
    Object.entries(value).flatMap(([key, entry]) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? flatten(entry, `${prefix}${key}.`)
        : [`${prefix}${key}`],
    )
  const keys = { "zh-CN": flatten(messages["zh-CN"]).sort(), en: flatten(messages.en).sort() }
  expect(keys["zh-CN"]).toEqual(keys.en)
  for (const key of Object.keys(messages["zh-CN"].projectless)) {
    for (const locale of ["zh-CN", "en"]) {
      expect(keys[locale].includes(`projectless.${key}`)).toBeTruthy()
      expect(messages[locale].projectless[key].trim().length > 0).toBeTruthy()
    }
  }
  // 设置说明必须带默认目录占位符，否则前端传参无效。
  expect(messages["zh-CN"].projectless.settingsDesc).toMatch(/\{path\}/)
  expect(messages.en.projectless.settingsDesc).toMatch(/\{path\}/)
})
