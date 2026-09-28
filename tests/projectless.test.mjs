import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import { loadTsSource } from "./lib/load-ts.mjs"

const paths = loadTsSource(readFileSync(new URL("../src/lib/paths.ts", import.meta.url), "utf8"))
const { isAbsolutePath, samePath } = paths

const DEFAULT_DIR = "C:/Users/you/.pix/workspace"
const LABEL = "无项目会话"

/**
 * 工作区 store 的 vm 测试环境：import 由 harness 提供，其中
 * `resolveProjectlessDir` 为后端解析命令的桩，`i18n`/`samePath` 用真实实现。
 */
function storeHarness({ dir = DEFAULT_DIR, defaultDir = DEFAULT_DIR, failures = 0 } = {}) {
  const source =
    readFileSync(new URL("../src/stores/workspace.ts", import.meta.url), "utf8")
      .replace(/^import .*$/gm, "")
      .replace(/export /g, "") + "\nglobalThis.store = useWorkspaceStore();"
  const calls = []
  const storage = new Map()
  let remaining = failures
  const context = vm.createContext({
    defineStore: (_, setup) => setup,
    ref: value => ({ value }),
    localStorage: { getItem: key => storage.get(key), setItem: (k, v) => storage.set(k, v) },
    listSessions: async () => [],
    updateSession: async () => 0,
    samePath,
    baseName: paths.baseName,
    i18n: { global: { t: key => (key === "projectless.name" ? LABEL : key) } },
    resolveProjectlessDir: async () => {
      calls.push(1)
      if (remaining > 0) {
        remaining--
        throw new Error('PIXERR:{"code":"projectlessDirUnusable","fallback":"无法使用无项目会话目录"}')
      }
      return { dir, defaultDir, isDefault: samePath(dir, defaultDir) }
    },
  })
  vm.runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), context)
  return { store: context.store, calls, storage }
}

test("无项目会话目录在首次使用时解析并复用同一次请求", async () => {
  const h = storeHarness()
  assert.equal(h.store.projectless.value, "")
  assert.equal(await h.store.ensureProjectless(), DEFAULT_DIR)
  assert.equal(await h.store.ensureProjectless(), DEFAULT_DIR)
  assert.equal(h.calls.length, 1)
  assert.equal(h.store.projectless.value, DEFAULT_DIR)
  assert.equal(h.store.projectlessDefault.value, DEFAULT_DIR)
})

test("设置改动后重新解析无项目会话目录", async () => {
  const h = storeHarness({ dir: "D:/pix/scratch", defaultDir: DEFAULT_DIR })
  assert.equal(await h.store.ensureProjectless(), "D:/pix/scratch")
  assert.equal(h.store.isProjectless("D:/pix/scratch"), true)
  assert.equal(await h.store.refreshProjectless(), "D:/pix/scratch")
  // refresh 必须绕过缓存，否则设置改动要等重启才生效。
  assert.equal(h.calls.length, 2)
})

test("解析失败不缓存，重试仍可成功", async () => {
  const h = storeHarness({ failures: 1 })
  await assert.rejects(h.store.ensureProjectless())
  assert.equal(h.store.projectless.value, "")
  assert.equal(await h.store.ensureProjectless(), DEFAULT_DIR)
})

test("isProjectless 忽略分隔符、尾斜杠与 Windows 大小写", async () => {
  const h = storeHarness()
  await h.store.ensureProjectless()
  assert.equal(h.store.isProjectless("C:\\Users\\you\\.pix\\workspace"), true)
  assert.equal(h.store.isProjectless("c:/users/you/.pix/workspace/"), true)
  assert.equal(h.store.isProjectless("C:/Users/you/.pix/workspace-notes"), false)
  assert.equal(h.store.isProjectless(""), false)
})

test("未解析时不会把任何路径当成无项目会话", () => {
  const h = storeHarness()
  assert.equal(h.store.isProjectless("C:/Users/you/.pix/workspace"), false)
})

test("无项目会话显示专用名称，普通项目仍显示目录名或项目名", async () => {
  const h = storeHarness()
  await h.store.ensureProjectless()
  h.store.createProject({ name: "工作区", folders: ["C:/code/app"], primary: "C:/code/app" })
  assert.equal(h.store.projectName(DEFAULT_DIR), LABEL)
  assert.equal(h.store.projectName("C:\\Users\\you\\.pix\\workspace"), LABEL)
  assert.equal(h.store.projectName("C:/code/demo"), "demo")
  assert.equal(h.store.projectName("C:/code/app"), "工作区")
})

test("isAbsolutePath 只接受绝对路径与 ~ 前缀", () => {
  for (const value of ["C:\\work", "D:/work", "/home/you/work", "\\\\server\\share", "~", "~/work", "~\\work"]) {
    assert.equal(isAbsolutePath(value), true, `${value} 应被接受`)
  }
  for (const value of ["work", "./work", "../work", "C:work", "~other/work"]) {
    assert.equal(isAbsolutePath(value), false, `${value} 应被拒绝`)
  }
})

test("samePath 归一化分隔符与尾斜杠，POSIX 路径区分大小写", () => {
  assert.equal(samePath("C:\\Users\\you\\work", "c:/users/you/work/"), true)
  assert.equal(samePath("/home/you/work", "/home/you/work/"), true)
  assert.equal(samePath("/home/you/Work", "/home/you/work"), false)
  assert.equal(samePath("a/../b", "b"), false)
  assert.equal(samePath("", "/home/you"), false)
  // 同前缀但不是同一目录时不能误判。
  assert.equal(samePath("/home/you/work", "/home/you/work-notes"), false)
})

test("入口、设置项与后端命令均已接线", () => {
  const read = path => readFileSync(new URL(path, import.meta.url), "utf8")
  // 后端：默认目录在 .pix 下、命令已注册、远程端可代理并保存该配置。
  assert.match(read("../src-tauri/src/data_dir.rs"), /join\("workspace"\)/)
  assert.match(read("../src-tauri/src/lib.rs"), /commands::projectless_dir_resolve/)
  assert.match(read("../src-tauri/src/remote.rs"), /"projectless_dir_resolve" =>/)
  assert.match(read("../src-tauri/src/remote.rs"), /cfg\.projectless_dir = a\["config"\]\["projectlessDir"\]/)
  // 前端：欢迎页/侧栏入口、设置页，以及会话空状态使用项目显示名。
  assert.match(read("../src/App.vue"), /@open-projectless="openProjectless"/)
  assert.match(read("../src/App.vue"), /@projectless="requestWorkspaceNavigation\(openProjectless\)"/)
  assert.match(read("../src/components/WelcomeView.vue"), /emit\('openProjectless'\)/)
  assert.match(read("../src/components/WorkspaceSidebar.vue"), /emit\('projectless'\)/)
  assert.match(read("../src/components/settings/GeneralSettings.vue"), /<ProjectlessSettings \/>/)
  assert.match(read("../src/components/settings/ProjectlessSettings.vue"), /projectlessDir: next \?\? undefined/)
  assert.match(read("../src/components/ChatView.vue"), /workspace\.projectName\(project\)/)
})

test("无项目会话文案在两种语言中保持同步", async () => {
  const messages = {}
  for (const locale of ["zh-CN", "en"]) {
    const source = readFileSync(new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url), "utf8")
    const js = ts.transpile(source, { module: ts.ModuleKind.ESNext })
    messages[locale] = (await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`)).default
  }
  const flatten = (value, prefix = "") =>
    Object.entries(value).flatMap(([key, entry]) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? flatten(entry, `${prefix}${key}.`)
        : [`${prefix}${key}`],
    )
  const keys = { "zh-CN": flatten(messages["zh-CN"]).sort(), en: flatten(messages.en).sort() }
  assert.deepEqual(keys["zh-CN"], keys.en)
  for (const key of Object.keys(messages["zh-CN"].projectless)) {
    for (const locale of ["zh-CN", "en"]) {
      assert.ok(keys[locale].includes(`projectless.${key}`), `${locale} 缺少 projectless.${key}`)
      assert.ok(messages[locale].projectless[key].trim().length > 0, `${locale}.projectless.${key} 不能为空`)
    }
  }
  // 设置说明必须带默认目录占位符，否则前端传参无效。
  assert.match(messages["zh-CN"].projectless.settingsDesc, /\{path\}/)
  assert.match(messages.en.projectless.settingsDesc, /\{path\}/)
})
