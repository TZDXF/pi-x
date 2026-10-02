import { ref, type Ref } from "vue"

/** Bottom drawers share the stage's height budget and are mutually exclusive when toggled. */
export function useBrowserDrawers(stageRef: Ref<HTMLElement | null>) {
  const showAnnotations = ref(false)
  const showConsole = ref(false)
  function toggleDrawer(drawer: "annotations" | "console") {
    const target = drawer === "annotations" ? showAnnotations : showConsole
    const other = drawer === "annotations" ? showConsole : showAnnotations
    target.value = !target.value
    if (target.value) other.value = false
  }

  // ---- drawer resizing ----------------------------------------------------------

  type DrawerName = "annotations" | "console"

  const DRAWER_MIN_HEIGHT = 96
  /** Space kept visible above an open drawer so the page stays usable. */
  const DRAWER_PAGE_RESERVE = 96

  const drawerHeights = ref<Record<DrawerName, number>>({ annotations: 192, console: 160 })
  let resizingDrawer: DrawerName | null = null
  let resizeStartY = 0
  let resizeStartHeight = 0

  function clampDrawerHeight(height: number) {
    const stageHeight = stageRef.value?.clientHeight ?? Number.POSITIVE_INFINITY
    const max = Math.max(DRAWER_MIN_HEIGHT, stageHeight - DRAWER_PAGE_RESERVE)
    return Math.min(Math.max(height, DRAWER_MIN_HEIGHT), max)
  }

  function onDrawerResizeStart(drawer: DrawerName, event: PointerEvent) {
    event.preventDefault()
    resizingDrawer = drawer
    resizeStartY = event.clientY
    resizeStartHeight = drawerHeights.value[drawer]
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
  }

  function onDrawerResizeMove(event: PointerEvent) {
    if (!resizingDrawer) return
    const height = resizeStartHeight + (resizeStartY - event.clientY)
    drawerHeights.value[resizingDrawer] = clampDrawerHeight(height)
  }

  function onDrawerResizeEnd() {
    resizingDrawer = null
  }

  return {
    showAnnotations,
    showConsole,
    drawerHeights,
    toggleDrawer,
    onDrawerResizeStart,
    onDrawerResizeMove,
    onDrawerResizeEnd,
  }
}
