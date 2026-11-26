import { computed, shallowRef } from "vue"
import { invoke, isDesktop } from "@/api/transport"

/** 桌面产物运行的操作系统；浏览器预览（`pnpm run dev` / 远程模式）不参与平台分支。 */
export type DesktopOs = "macos" | "windows" | "linux"

/** macOS「双击窗口标题栏」的系统偏好动作，取值见「系统设置 → 桌面与程序坞」。 */
export type TitleBarDoubleClickAction = "maximize" | "minimize" | "none"

export interface WindowPlatform {
  os: DesktopOs
  /** 非 macOS 恒为 `null`；macOS 上缺省按 `maximize`（与系统默认一致）。 */
  doubleClickAction: TitleBarDoubleClickAction | null
}

/** 浏览器预览（以及后端探测失败时）沿用现有的自绘标题栏：36px + 自绘窗口按钮。 */
const NO_DESKTOP: WindowPlatform = { os: "windows", doubleClickAction: null }

const platform = shallowRef<WindowPlatform>(NO_DESKTOP)

/**
 * 平台判定只认后端上报的 `cfg!(target_os)`：前端不解析 UA 或 navigator 平台字段
 * （各平台 webview 的 UA 并不自洽），也不为此新增 OS 探测插件依赖。
 */
export const isMacOS = computed(() => isDesktop && platform.value.os === "macos")

export function applyWindowPlatform(info: WindowPlatform) {
  platform.value = info
  // 标题栏高度与红绿灯占位由 CSS 变量切换（见 src/styles/base.css）。
  if (isDesktop && typeof document !== "undefined") document.documentElement.dataset.platform = info.os
}

/** 启动时探测一次平台；浏览器预览与调用失败都退回非 macOS 行为。 */
export async function initializePlatform(): Promise<void> {
  if (!isDesktop) {
    applyWindowPlatform(NO_DESKTOP)
    return
  }
  try {
    applyWindowPlatform(await invoke<WindowPlatform>("window_platform"))
  } catch {
    applyWindowPlatform(NO_DESKTOP)
  }
}

/**
 * 双击标题栏时重新读一次平台信息：用户在系统设置里改过「双击标题栏」偏好后立即生效，
 * 不需要重启 PiX。
 */
export async function resolveTitleBarDoubleClickAction(): Promise<TitleBarDoubleClickAction> {
  if (!isMacOS.value) return "maximize"
  try {
    const info = await invoke<WindowPlatform>("window_platform")
    applyWindowPlatform(info)
    return info.doubleClickAction ?? "maximize"
  } catch {
    return platform.value.doubleClickAction ?? "maximize"
  }
}
