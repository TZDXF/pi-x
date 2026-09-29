import type { Ref } from "vue"

/** ResizablePanel 转发出来的 reka 命令式 API。 */
export interface ResizablePanelApi {
  collapse: () => void
  expand: () => void
  getSize: () => number | null
  resize: (size: number) => void
}

/**
 * reka Splitter 手柄未内置键盘调整，为其补上方向键与 Home/End。
 * 语义与左侧面板一致：ArrowLeft 加宽、ArrowRight 收窄，Shift 步长加倍。
 */
export function usePanelKeyboardResize(
  panel: Ref<ResizablePanelApi | null>,
  bounds: () => { min: number; max: number },
  step = 16,
) {
  return (event: KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
    const api = panel.value
    if (!api) return
    event.preventDefault()
    const { min, max } = bounds()
    const delta = event.shiftKey ? step * 2 : step
    const next =
      event.key === "Home"
        ? min
        : event.key === "End"
          ? max
          : (api.getSize() ?? min) + (event.key === "ArrowLeft" ? delta : -delta)
    api.resize(Math.min(max, Math.max(min, next)))
  }
}
