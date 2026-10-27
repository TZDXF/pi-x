import { ref, type Ref } from "vue"
import { usePointerDrag } from "@/composables/usePointerDrag"

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
  function clampDrawerHeight(height: number) {
    const stageHeight = stageRef.value?.clientHeight ?? Number.POSITIVE_INFINITY
    const max = Math.max(DRAWER_MIN_HEIGHT, stageHeight - DRAWER_PAGE_RESERVE)
    return Math.min(Math.max(height, DRAWER_MIN_HEIGHT), max)
  }

  const resizeDrag = usePointerDrag<{ drawer: DrawerName; startY: number; startHeight: number }>({
    cursor: "row-resize",
    onMove: (start, event) => {
      const height = start.startHeight + (start.startY - event.clientY)
      drawerHeights.value[start.drawer] = clampDrawerHeight(height)
    },
  })

  const onDrawerResizeStart = (drawer: DrawerName, event: PointerEvent) =>
    resizeDrag.start(event, { drawer, startY: event.clientY, startHeight: drawerHeights.value[drawer] })
  const onDrawerResizeMove = resizeDrag.move
  const onDrawerResizeEnd = resizeDrag.stop

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
