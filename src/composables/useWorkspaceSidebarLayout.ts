import { computed, ref, watch, type Ref } from "vue"
import { usePanelKeyboardResize, type ResizablePanelApi } from "@/composables/usePanelKeyboardResize"

/** Pixel-based splitter preference and narrow-screen overlay layout. */
export function useWorkspaceSidebarLayout(
  sidebarOpen: Ref<boolean>,
  route: Ref<{ name: string }>,
  windowWidth: Ref<number>,
  isNarrowViewport: Ref<boolean>,
) {
  const SIDEBAR_WIDTH_STORAGE_KEY = "pix.sidebar-width"
  const SIDEBAR_MIN_WIDTH = 220
  const SIDEBAR_DEFAULT_WIDTH = 272 // 与侧栏旧默认宽度 w-68 对齐
  const sidebarVisible = computed(() => sidebarOpen.value && route.value.name !== "settings")
  /** 窄屏下侧栏以覆盖层悬浮，面板需让出全部宽度。 */
  const sidebarCollapsed = computed(() => !sidebarVisible.value || isNarrowViewport.value)
  const sidebarMaxWidth = computed(() => Math.min(480, Math.max(280, windowWidth.value - 360)))
  const preferredSidebarWidth = ref(SIDEBAR_DEFAULT_WIDTH)
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
    if (Number.isFinite(saved) && saved > 0) preferredSidebarWidth.value = saved
  } catch {
    /* Storage may be unavailable in restricted browsers. */
  }
  /** reka 只在首次布局读取 default-size；初始折叠态直接体现到默认尺寸，避免布局就绪前调用命令式 API。 */
  const defaultSidebarWidth = sidebarCollapsed.value
    ? 0
    : Math.min(SIDEBAR_DEFAULT_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, preferredSidebarWidth.value))
  const sidebarPanel = ref<ResizablePanelApi | null>(null)

  function clampSidebarWidth(width: number) {
    return Math.min(sidebarMaxWidth.value, Math.max(SIDEBAR_MIN_WIDTH, width))
  }

  function onSidebarResize(width: number) {
    if (width <= 0 || isNarrowViewport.value) return
    preferredSidebarWidth.value = Math.round(width)
    try {
      localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(preferredSidebarWidth.value))
    } catch {
      /* Optional preference. */
    }
  }

  watch(
    sidebarCollapsed,
    collapsed => {
      const panel = sidebarPanel.value
      if (!panel) return
      if (collapsed) panel.collapse()
      else panel.resize(clampSidebarWidth(preferredSidebarWidth.value))
    },
    { flush: "post" },
  )

  const resizeSidebarWithKeyboard = usePanelKeyboardResize(sidebarPanel, () => ({
    min: SIDEBAR_MIN_WIDTH,
    max: sidebarMaxWidth.value,
  }))

  return {
    SIDEBAR_MIN_WIDTH,
    sidebarVisible,
    sidebarCollapsed,
    sidebarMaxWidth,
    preferredSidebarWidth,
    defaultSidebarWidth,
    sidebarPanel,
    onSidebarResize,
    resizeSidebarWithKeyboard,
  }
}
