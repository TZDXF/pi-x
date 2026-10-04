import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, ref } from "vue"
import { useWorkspaceSidebarLayout } from "@/composables/useWorkspaceSidebarLayout"
import type { ResizablePanelApi } from "@/composables/usePanelKeyboardResize"

function createPanelApi(): ResizablePanelApi {
  return { collapse: vi.fn(), expand: vi.fn(), getSize: () => 272, resize: vi.fn() }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("useWorkspaceSidebarLayout", () => {
  it("初始展开时不触发折叠，也不开启动画", () => {
    const layout = useWorkspaceSidebarLayout(ref(true), ref(1280), ref(false))
    const panel = createPanelApi()
    layout.sidebarPanel.value = panel
    expect(layout.sidebarVisible.value).toBe(true)
    expect(layout.sidebarAnimating.value).toBe(false)
    expect(panel.collapse).not.toHaveBeenCalled()
    expect(panel.resize).not.toHaveBeenCalled()
  })

  it("折叠时短暂开启动画并调用 collapse，240ms 后动画结束", async () => {
    const open = ref(true)
    const layout = useWorkspaceSidebarLayout(open, ref(1280), ref(false))
    const panel = createPanelApi()
    layout.sidebarPanel.value = panel

    open.value = false
    await nextTick()
    expect(panel.collapse).toHaveBeenCalled()
    expect(layout.sidebarAnimating.value).toBe(true)

    await vi.advanceTimersByTimeAsync(240)
    expect(layout.sidebarAnimating.value).toBe(false)
  })

  it("重新展开时按偏好宽度 resize 并短暂开启动画", async () => {
    const open = ref(false)
    const layout = useWorkspaceSidebarLayout(open, ref(1280), ref(false))
    const panel = createPanelApi()
    layout.sidebarPanel.value = panel

    open.value = true
    await nextTick()
    expect(panel.resize).toHaveBeenCalledWith(layout.preferredSidebarWidth.value)
    expect(panel.collapse).not.toHaveBeenCalled()
    expect(layout.sidebarAnimating.value).toBe(true)

    await vi.advanceTimersByTimeAsync(240)
    expect(layout.sidebarAnimating.value).toBe(false)
  })

  it("窄屏视为折叠，面板让出全部宽度", async () => {
    const narrow = ref(false)
    const layout = useWorkspaceSidebarLayout(ref(true), ref(1280), narrow)
    const panel = createPanelApi()
    layout.sidebarPanel.value = panel

    narrow.value = true
    await nextTick()
    expect(layout.sidebarCollapsed.value).toBe(true)
    expect(panel.collapse).toHaveBeenCalled()
  })

  it("defaultSidebarWidth 保持响应，面板重挂时能反映当前折叠态", () => {
    const open = ref(true)
    const layout = useWorkspaceSidebarLayout(open, ref(1280), ref(false))
    expect(layout.defaultSidebarWidth.value).toBe(layout.preferredSidebarWidth.value)

    open.value = false
    expect(layout.defaultSidebarWidth.value).toBe(0)

    open.value = true
    expect(layout.defaultSidebarWidth.value).toBe(layout.preferredSidebarWidth.value)
  })
})
