/**
 * Markdown 代码块的全局自动换行开关（TZD-133）。
 *
 * 偏好与表现分开：
 * 1. 偏好持久化在 `~/.pix/config.json` 的 `preferences.markdownCodeWrap`，重启时由
 *    `initializeConfigPreferences()` 恢复，多窗口 / 远程端通过 `pi://app-config-changed` 同步；
 * 2. 表现写在根元素属性 `data-markdown-code-wrap="on|off"` 上，由 `styles/markdown.css`
 *    统一作用于所有 `pre[data-stream-markdown="code"]`。
 *
 * 为什么不用「绑在 `<Markdown>` 根节点上的类」：渲染器的全屏弹层会被 teleport 到
 * `#stream-markdown-overlay`（在 `<Markdown>` 根之外），root 上的类够不到它，全屏里的
 * 代码块就会与内嵌的分裂。根元素属性是唯一同时覆盖内嵌与全屏的选择器锚点。
 *
 * 按钮通过渲染器自带的 `controls.code.customize` 追加到代码块 header，点击只改全局偏好
 * —— 这正是「切一个、全生效」。
 */
import type { Component } from "vue"
import { computed } from "vue"
import { WrapText } from "@lucide/vue"
import { Markdown } from "vue-stream-markdown"
import { i18n } from "@/i18n"
import { createConfigPreference } from "@/lib/configPreference"
// 全局换行规则只作用于 `pre[data-stream-markdown="code"]`（含全屏弹层），随本模块一起加载。
import "@/styles/markdown.css"

/** 偏好键名：后端 `app_preference_set` 的白名单需同步（src-tauri/src/commands/config.rs）。 */
export const MARKDOWN_CODE_WRAP_KEY = "markdownCodeWrap"
/** `markdownCodeWrap` 控件在代码块 header 里的 key。 */
export const MARKDOWN_CODE_WRAP_CONTROL_KEY = "wrap"
const OFF = "0"

/** 根元素属性（dataset 形式 → CSS 里的 `data-markdown-code-wrap`）。 */
const ROOT_ATTRIBUTE = "markdownCodeWrap"

function applyCodeWrap(value: boolean) {
  if (typeof document === "undefined") return
  document.documentElement.dataset[ROOT_ATTRIBUTE] = value ? "on" : "off"
}

const preference = createConfigPreference<boolean>({
  key: MARKDOWN_CODE_WRAP_KEY,
  defaultValue: true,
  read: raw => raw !== OFF,
  serialize: value => (value ? "1" : OFF),
  // 创建时与每次配置同步（本地写入、远程事件、重载）都会触发，样式因此始终跟随偏好。
  onChange: applyCodeWrap,
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

// ---- 控件类型：从渲染器 `<Markdown>` 的 props 推导，避免自造结构漂移 ----
type ControlsConfig = NonNullable<InstanceType<typeof Markdown>["$props"]["controls"]>
type CodeCustomize = NonNullable<Extract<Extract<NonNullable<ControlsConfig>, object>["code"], object>["customize"]>
type BuiltinCodeControls = Parameters<CodeCustomize>[0]
type CodeControl = BuiltinCodeControls[number]

/**
 * 在库内建控件（折叠 / 复制 / 下载 / 全屏）之后追加「换行」按钮。
 *
 * 渲染器会把**已定制过**的 header 按钮列表再喂给 customize 一次（全屏弹层的 actions
 * 就是 `customize(headerActions)`），所以这里必须按 key 去重，否则全屏里会出现第二个
 * 换行按钮，而且它的文案与点击闭包是上一次渲染的快照。
 */
export function appendCodeWrapControl(builtin: BuiltinCodeControls, wrap: boolean): BuiltinCodeControls {
  const control: CodeControl = {
    key: MARKDOWN_CODE_WRAP_CONTROL_KEY,
    name: i18n.global.t(wrap ? "blocks.wrapCodeOn" : "blocks.wrapCodeOff"),
    icon: WrapText as unknown as Component,
    // 按下态用主题色强调，和复制按钮的 hover 样式区分开（库只会把 attrs 透传到外层 span，
    // 因此状态靠样式与按钮文案表达，不用 aria-pressed）。
    buttonStyle: wrap
      ? { backgroundColor: "color-mix(in oklab, var(--primary) 15%, transparent)", color: "var(--primary)" }
      : undefined,
    onClick: () => void toggleMarkdownCodeWrap(),
  }
  const others = builtin.filter(existing => existing.key !== MARKDOWN_CODE_WRAP_CONTROL_KEY)
  return [...others, control]
}

/** 传给 `<Markdown :controls>` 的配置；偏好一变就重建，使所有代码块的按钮同步更新。 */
export const markdownCodeWrapControls = computed(() => {
  const wrap = markdownCodeWrap.value
  return {
    code: { customize: (builtin: BuiltinCodeControls) => appendCodeWrapControl(builtin, wrap) },
  } as unknown as ControlsConfig
})
