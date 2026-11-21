import { readFileSync } from "node:fs"
import { chatSource } from "./fixtures/chatSources"
import { i18n } from "@/i18n"
import { afterEach, expect, test, vi } from "vitest"

// TZD-133：Markdown 代码块的全局自动换行开关。
// 覆盖：默认开启、点击后写进主机配置（~/.pix/config.json 的 preferences）、重启后恢复；
// 以及两处审查修复的回归：
// - 全屏弹层（teleport 到 `<Markdown>` 根之外）与内嵌同态，且只出现一个换行按钮；
// - 旧配置回执不得反转较新的本地切换（见 tests/config-preferences.test.ts）。

const mocks = vi.hoisted(() => ({
  config: { preferences: {} as Record<string, string> },
  writes: [] as { key: string; value: string }[],
}))

vi.mock("@/api/transport", () => ({
  isDesktop: true,
  invoke: async (command: string, args: { key: string; value: string }) => {
    if (command === "app_config_get") return mocks.config
    if (command === "app_preference_set") {
      mocks.writes.push({ key: args.key, value: args.value })
      mocks.config.preferences[args.key] = args.value
      return null
    }
    return null
  },
  listen: async () => () => {},
}))

/** 最小 document 桩：应用偏好时会写根元素数据集。 */
function stubDocument() {
  const root = { dataset: {} as Record<string, string> }
  vi.stubGlobal("document", { documentElement: root })
  return root
}

async function harness(preferences: Record<string, string> = {}) {
  vi.resetModules()
  mocks.config = { preferences: { ...preferences } }
  mocks.writes = []
  const root = stubDocument()
  const module = await import("@/lib/markdownCodeWrap")
  const config = await import("@/lib/configPreference")
  await config.initializeConfigPreferences()
  return { module, root }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

type CodeControl = {
  key: string
  name: string
  buttonStyle?: Record<string, string>
  onClick: () => void
}

function codeControls(module: Awaited<ReturnType<typeof harness>>["module"], builtin?: CodeControl[]) {
  const controls = module.markdownCodeWrapControls.value as any
  return controls.code.customize(builtin ?? [{ key: "copy", name: "Copy", onClick() {} }]) as CodeControl[]
}

test("code blocks wrap by default and the header gains a wrap control", async () => {
  const { module, root } = await harness()
  expect(module.markdownCodeWrap.value).toBe(true)
  // 换行状态写在根元素属性上（而不是 `<Markdown>` 根节点的类）：全屏弹层在根之外，
  // 只有属性选择器能同时覆盖内嵌与全屏。
  expect(root.dataset.markdownCodeWrap).toBe("on")

  const controls = codeControls(module)
  // 内建控件保留，追加一个全局换行按钮。
  expect(controls.map(control => control.key)).toEqual(["copy", "wrap"])
  expect(controls[1]!.name).toBe(i18n.global.t("blocks.wrapCodeOn"))
})

test("clearing the control turns wrapping off for every block and persists the choice", async () => {
  const { module, root } = await harness()
  const controls = codeControls(module)
  controls[1]!.onClick()

  await vi.waitFor(() => expect(module.markdownCodeWrap.value).toBe(false))
  expect(root.dataset.markdownCodeWrap).toBe("off")
  // 全局：同一份 controls 重建后按钮文案与高亮状态一起翻转。
  expect(codeControls(module)[1]!.name).toBe(i18n.global.t("blocks.wrapCodeOff"))
  await vi.waitFor(() => expect(mocks.writes).toEqual([{ key: "markdownCodeWrap", value: "0" }]))

  await module.toggleMarkdownCodeWrap()
  await vi.waitFor(() => expect(module.markdownCodeWrap.value).toBe(true))
  expect(root.dataset.markdownCodeWrap).toBe("on")
  await vi.waitFor(() => expect(mocks.writes.at(-1)).toEqual({ key: "markdownCodeWrap", value: "1" }))
})

test("restarting the app restores the saved preference", async () => {
  // 重启 = 重新读取主机配置；`0` 表示关闭换行。
  const { module, root } = await harness({ markdownCodeWrap: "0" })
  expect(module.markdownCodeWrap.value).toBe(false)
  expect(root.dataset.markdownCodeWrap).toBe("off")
  expect(codeControls(module)[1]!.name).toBe(i18n.global.t("blocks.wrapCodeOff"))
})

test("invalid writes never change the in-memory state", async () => {
  const { module } = await harness()
  await module.setMarkdownCodeWrap(undefined as unknown as boolean)
  expect(module.markdownCodeWrap.value).toBe(true)
  expect(mocks.writes).toEqual([])
})

test("customize keeps a single wrap control when the renderer re-applies it (fullscreen)", async () => {
  // 渲染器的全屏弹层会把**已定制过**的按钮列表再喂给 customize 一次
  // （`customize(headerActions)`）；不去重就会出现第二个换行按钮，而它的文案还是旧快照。
  const { module } = await harness()
  const builtin: CodeControl[] = [
    { key: "collapse", name: "Collapse", onClick() {} },
    { key: "copy", name: "Copy", onClick() {} },
    { key: "wrap", name: "stale label", onClick() {} },
  ]
  const once = codeControls(module, builtin)
  const twice = codeControls(module, once)
  for (const controls of [once, twice]) {
    expect(controls.filter(control => control.key === "wrap")).toHaveLength(1)
    expect(controls.at(-1)!.name).toBe(i18n.global.t("blocks.wrapCodeOn"))
    expect(controls.map(control => control.key)).toEqual(["collapse", "copy", "wrap"])
  }

  // 偏好翻转后重新定制：仍只有一个按钮，且文案、按下态都是最新的。
  await module.toggleMarkdownCodeWrap()
  await vi.waitFor(() => expect(module.markdownCodeWrap.value).toBe(false))
  const after = codeControls(module, twice)
  expect(after.filter(control => control.key === "wrap")).toHaveLength(1)
  expect(after.at(-1)!.name).toBe(i18n.global.t("blocks.wrapCodeOff"))
  expect(after.at(-1)!.buttonStyle).toBeUndefined()
})

test("the global wrap rule lives on the root element so fullscreen follows too", () => {
  const css = readFileSync(new URL("../src/styles/markdown.css", import.meta.url), "utf8")
  // 选择器不能限制在某个组件根内：全屏弹层被 teleport 到 #stream-markdown-overlay。
  expect(css).toMatch(/:root[^{]*pre\[data-stream-markdown="code"\]\s*\{[^}]*white-space: pre-wrap/)
  expect(css).toMatch(/:root\[data-markdown-code-wrap="off"\] pre\[data-stream-markdown="code"\]/)
  expect(css).toContain("overflow-wrap: anywhere")
  expect(css).toContain("white-space: pre;")
  // 全局样式必须真正被引入（跟随开关模块加载，不依赖某个组件根节点）。
  expect(readFileSync(new URL("../src/lib/markdownCodeWrap.ts", import.meta.url), "utf8")).toContain(
    'import "@/styles/markdown.css"',
  )
})

test("every Markdown rendering entry wires the global wrap control and no root-scoped class", () => {
  const sources = [
    "components/ai-elements/message/MessageResponse.vue",
    "components/ai-elements/reasoning/ReasoningContent.vue",
    "components/ProjectFilePreview.vue",
    "components/ResourceMarkdownPreview.vue",
    "components/settings/AboutSettings.vue",
  ].map(file => chatSource(file))

  for (const source of sources) {
    expect(source).toContain(':controls="markdownCodeWrapControls"')
    // 根节点上的 `[&_pre]` 类管不到全屏弹层，只有根元素属性规则能覆盖，故入口不再绑类。
    expect(source).not.toContain("markdownCodeWrapClass")
  }
})
