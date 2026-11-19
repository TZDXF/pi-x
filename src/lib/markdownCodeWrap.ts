/**
 * Markdown 代码块的全局自动换行开关（TZD-133）。
 *
 * 偏好与表现分开：
 * 1. 偏好持久化在 `~/.pix/config.json` 的 `preferences.markdownCodeWrap`，重启时由
 *    `initializeConfigPreferences()` 恢复，多窗口 / 远程端通过 `pi://app-config-changed` 同步；
 * 2. 表现以「绑给每个 `<Markdown>` 根节点的类」下发，所以偏好一变，页面上已渲染的
 *    所有代码块同时切换，不需要重新挂载。
 *
 * 渲染器（vue-stream-markdown）没有换行配置：换行只能靠 `[&_pre]` 变体改写 `<pre>`
 * 的 white-space；按钮通过它自带的 `controls.code.customize` 追加到代码块 header，
 * 点击只改全局偏好 —— 这正是「切一个、全生效」。
 */
import type { Component } from "vue"
import { computed } from "vue"
import { WrapText } from "@lucide/vue"
import { Markdown } from "vue-stream-markdown"
import { i18n } from "@/i18n"
import { createConfigPreference } from "@/lib/configPreference"

/** 偏好键名：后端 `app_preference_set` 的白名单需同步（src-tauri/src/commands/config.rs）。 */
export const MARKDOWN_CODE_WRAP_KEY = "markdownCodeWrap"
const OFF = "0"

const preference = createConfigPreference<boolean>({
  key: MARKDOWN_CODE_WRAP_KEY,
  defaultValue: true,
  read: raw => raw !== OFF,
  serialize: value => (value ? "1" : OFF),
})

/** 响应式的全局换行状态（按钮按下态、设置项都读这里）。 */
export const markdownCodeWrap = preference.value

export function setMarkdownCodeWrap(value: boolean) {
  if (typeof value !== "boolean") return
  return preference.set(value)
}

export function toggleMarkdownCodeWrap() {
  return preference.set(!markdownCodeWrap.value)
}

/** 绑给 `<Markdown>` 根节点：一次切换作用到该实例里的所有代码块。 */
export const markdownCodeWrapClass = computed(() =>
  markdownCodeWrap.value
    ? "[&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]"
    : "[&_pre]:whitespace-pre [&_pre]:[overflow-wrap:normal]",
)

// ---- 控件类型：从渲染器 `<Markdown>` 的 props 推导，避免自造结构漂移 ----
type ControlsConfig = NonNullable<InstanceType<typeof Markdown>["$props"]["controls"]>
type CodeCustomize = NonNullable<Extract<Extract<NonNullable<ControlsConfig>, object>["code"], object>["customize"]>
type BuiltinCodeControls = Parameters<CodeCustomize>[0]
type CodeControl = BuiltinCodeControls[number]

/**
 * 在库内建控件（折叠 / 复制 / 下载 / 全屏）之后追加「换行」按钮。
 * `wrap` 由调用方传入：控件是普通对象，只有重建它才能让按下态跟着偏好走。
 */
export function appendCodeWrapControl(builtin: BuiltinCodeControls, wrap: boolean): BuiltinCodeControls {
  const control: CodeControl = {
    key: "wrap",
    name: i18n.global.t(wrap ? "blocks.wrapCodeOn" : "blocks.wrapCodeOff"),
    icon: WrapText as unknown as Component,
    // 按下态用主题色强调，和复制按钮的 hover 样式区分开（库只会把 attrs 透传到外层 span，
    // 因此状态靠样式与按钮文案表达，不用 aria-pressed）。
    buttonStyle: wrap
      ? { backgroundColor: "color-mix(in oklab, var(--primary) 15%, transparent)", color: "var(--primary)" }
      : undefined,
    onClick: () => void toggleMarkdownCodeWrap(),
  }
  return [...builtin, control]
}

/** 传给 `<Markdown :controls>` 的配置；偏好一变就重建，使所有代码块的按钮同步更新。 */
export const markdownCodeWrapControls = computed(() => {
  const wrap = markdownCodeWrap.value
  return {
    code: { customize: (builtin: BuiltinCodeControls) => appendCodeWrapControl(builtin, wrap) },
  } as unknown as ControlsConfig
})
