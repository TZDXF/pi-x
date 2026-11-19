import { chatSource } from "./fixtures/chatSources"
import { i18n } from "@/i18n"
import { afterEach, expect, test, vi } from "vitest"

// TZD-133：Markdown 代码块的全局自动换行开关。
// 覆盖三件事：默认开启、点击后写进主机配置（~/.pix/config.json 的 preferences）、
// 重启（重新读取配置）后恢复；以及所有 Markdown 渲染入口都接上了这个开关。

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

async function harness(preferences: Record<string, string> = {}) {
  vi.resetModules()
  mocks.config = { preferences: { ...preferences } }
  mocks.writes = []
  const module = await import("@/lib/markdownCodeWrap")
  const config = await import("@/lib/configPreference")
  await config.initializeConfigPreferences()
  return module
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const WRAP_ON_CLASS = "[&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]"
const WRAP_OFF_CLASS = "[&_pre]:whitespace-pre [&_pre]:[overflow-wrap:normal]"

function codeControls(module: Awaited<ReturnType<typeof harness>>) {
  const controls = module.markdownCodeWrapControls.value as any
  return controls.code.customize([{ key: "copy", name: "Copy", onClick() {} }]) as {
    key: string
    name: string
    buttonStyle?: Record<string, string>
    onClick: () => void
  }[]
}

test("code blocks wrap by default and the header gains a wrap control", async () => {
  const module = await harness()
  expect(module.markdownCodeWrap.value).toBe(true)
  expect(module.markdownCodeWrapClass.value).toBe(WRAP_ON_CLASS)

  const controls = codeControls(module)
  // 内建控件保留，追加一个全局换行按钮。
  expect(controls.map(control => control.key)).toEqual(["copy", "wrap"])
  expect(controls[1]!.name).toBe(i18n.global.t("blocks.wrapCodeOn"))
})

test("clearing the control turns wrapping off for every block and persists the choice", async () => {
  const module = await harness()
  const controls = codeControls(module)
  controls[1]!.onClick()

  await vi.waitFor(() => expect(module.markdownCodeWrap.value).toBe(false))
  expect(module.markdownCodeWrapClass.value).toBe(WRAP_OFF_CLASS)
  // 全局：同一份 controls 重建后按钮文案与高亮状态一起翻转。
  expect(codeControls(module)[1]!.name).toBe(i18n.global.t("blocks.wrapCodeOff"))
  await vi.waitFor(() => expect(mocks.writes).toEqual([{ key: "markdownCodeWrap", value: "0" }]))

  await module.toggleMarkdownCodeWrap()
  await vi.waitFor(() => expect(module.markdownCodeWrap.value).toBe(true))
  expect(module.markdownCodeWrapClass.value).toBe(WRAP_ON_CLASS)
  await vi.waitFor(() => expect(mocks.writes.at(-1)).toEqual({ key: "markdownCodeWrap", value: "1" }))
})

test("restarting the app restores the saved preference", async () => {
  // 重启 = 重新读取主机配置；`0` 表示关闭换行。
  const module = await harness({ markdownCodeWrap: "0" })
  expect(module.markdownCodeWrap.value).toBe(false)
  expect(module.markdownCodeWrapClass.value).toBe(WRAP_OFF_CLASS)
  expect(codeControls(module)[1]!.name).toBe(i18n.global.t("blocks.wrapCodeOff"))
})

test("invalid writes never change the in-memory state", async () => {
  const module = await harness()
  await module.setMarkdownCodeWrap(undefined as unknown as boolean)
  expect(module.markdownCodeWrap.value).toBe(true)
  expect(mocks.writes).toEqual([])
})

test("every Markdown rendering entry wires the global wrap class and control", () => {
  const sources = [
    "components/ai-elements/message/MessageResponse.vue",
    "components/ai-elements/reasoning/ReasoningContent.vue",
    "components/ProjectFilePreview.vue",
    "components/ResourceMarkdownPreview.vue",
    "components/settings/AboutSettings.vue",
  ].map(file => chatSource(file))

  for (const source of sources) {
    expect(source).toContain(':controls="markdownCodeWrapControls"')
    expect(source).toContain("markdownCodeWrapClass")
  }
})
