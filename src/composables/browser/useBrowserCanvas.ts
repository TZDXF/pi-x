import { ref, nextTick, onMounted, onBeforeUnmount, type Ref } from "vue"
import { drawAnnotation, type DrawAnnotation, type DrawTool, type Point } from "@/lib/canvasAnnotations"
import { useBrowserCanvasHistory } from "./useBrowserCanvasHistory"
import { hitTest } from "./browserCanvasHitTest"

/** Canvas rendering, pointer tools, erasing and PNG export in viewport coordinates. */
export function useBrowserCanvas(options: {
  mode: Ref<"none" | "draw" | "inspect">
  canvasRef: Ref<HTMLCanvasElement | null>
  stageRef: Ref<HTMLElement | null>
  onTextRequested: (point: Point) => void
}) {
  const { mode, canvasRef, stageRef, onTextRequested } = options
  type CanvasAnnotation = DrawAnnotation
  type CanvasTool = DrawTool | "eraser"

  const activeTool = ref<CanvasTool>("pen")
  const strokeColor = ref("#ef4444")
  const strokeWidth = ref(2)
  const drawAnnotations = ref<CanvasAnnotation[]>([])
  const currentAnnotation = ref<CanvasAnnotation | null>(null)
  const { history, historyIndex, saveHistory, undo, redo } = useBrowserCanvasHistory(drawAnnotations, redrawCanvas)

  const colors = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899"]
  const strokeWidths = [1, 2, 3, 5, 8]

  let canvas: CanvasRenderingContext2D | null = null
  let isDrawing = false
  let annotationIdSeq = 0
  let resizeObserver: ResizeObserver | null = null

  // Canvas history (undo/redo) only covers the free-hand layer; inspect
  // annotations are edited through the list instead.
  function generateId(): string {
    return `draw-${++annotationIdSeq}-${Date.now()}`
  }

  function clearDrawAnnotations() {
    drawAnnotations.value = []
    saveHistory()
    redrawCanvas()
  }

  function redrawCanvas() {
    if (!canvas || !canvasRef.value) return
    canvas.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
    for (const annotation of drawAnnotations.value) {
      drawAnnotation(canvas, annotation)
    }
    if (currentAnnotation.value && currentAnnotation.value.tool !== "text") {
      drawAnnotation(canvas, currentAnnotation.value)
    }
  }

  function getCanvasPoint(e: MouseEvent): Point {
    const canvasEl = canvasRef.value!
    const rect = canvasEl.getBoundingClientRect()
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    }
  }

  function onPointerDown(e: MouseEvent) {
    if (mode.value !== "draw") return
    if (activeTool.value === "eraser") {
      eraseAt(getCanvasPoint(e))
      return
    }
    e.preventDefault()
    isDrawing = true
    const point = getCanvasPoint(e)
    currentAnnotation.value = {
      id: generateId(),
      tool: activeTool.value,
      points: [point],
      color: strokeColor.value,
      strokeWidth: strokeWidth.value,
    }
  }

  function onPointerMove(e: MouseEvent) {
    if (!isDrawing || !currentAnnotation.value) return
    e.preventDefault()
    const point = getCanvasPoint(e)
    if (activeTool.value === "pen") {
      currentAnnotation.value.points.push(point)
      if (!canvas) return
      const pts = currentAnnotation.value.points
      if (pts.length >= 2) {
        canvas.beginPath()
        canvas.moveTo(pts[pts.length - 2].x, pts[pts.length - 2].y)
        canvas.lineTo(point.x, point.y)
        canvas.stroke()
      }
    } else {
      currentAnnotation.value.points = [currentAnnotation.value.points[0], point]
      redrawCanvas()
    }
  }

  function onPointerUp() {
    if (!isDrawing || !currentAnnotation.value) return
    isDrawing = false
    if (activeTool.value === "text") {
      onTextRequested(currentAnnotation.value.points[0])
      currentAnnotation.value = null
      return
    }
    drawAnnotations.value.push(currentAnnotation.value)
    currentAnnotation.value = null
    saveHistory()
    redrawCanvas()
  }

  function onPointerLeave() {
    if (isDrawing) onPointerUp()
  }

  /** Removes the topmost annotation near the point (eraser tool). */
  function eraseAt(point: Point) {
    const tolerance = 8 * (window.devicePixelRatio || 1)
    for (let i = drawAnnotations.value.length - 1; i >= 0; i--) {
      if (
        hitTest(
          drawAnnotations.value[i],
          point,
          tolerance,
          canvas ? text => canvas!.measureText(text).width : undefined,
        )
      ) {
        drawAnnotations.value.splice(i, 1)
        saveHistory()
        redrawCanvas()
        return
      }
    }
  }

  function exportAnnotations() {
    if (!canvasRef.value) return
    const link = document.createElement("a")
    link.download = `annotations-${Date.now()}.png`
    link.href = canvasRef.value.toDataURL("image/png")
    link.click()
  }

  function updateCanvasStyle() {
    if (!canvasRef.value) return
    canvasRef.value.style.pointerEvents = mode.value === "draw" ? "auto" : "none"
    canvasRef.value.style.cursor = mode.value === "draw" ? "crosshair" : "default"
  }

  function initCanvas() {
    if (!canvasRef.value || !stageRef.value) return
    const rect = stageRef.value.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const dpr = window.devicePixelRatio || 1
    canvasRef.value.width = rect.width * dpr
    canvasRef.value.height = rect.height * dpr
    canvasRef.value.style.width = `${rect.width}px`
    canvasRef.value.style.height = `${rect.height}px`
    canvas = canvasRef.value.getContext("2d")
    if (canvas) {
      canvas.scale(dpr, dpr)
    }
    redrawCanvas()
  }

  function addText(point: Point, text: string) {
    if (!text.trim()) return
    drawAnnotations.value.push({
      id: generateId(),
      tool: "text",
      points: [point],
      color: strokeColor.value,
      strokeWidth: strokeWidth.value,
      text: text.trim(),
    })
    saveHistory()
    redrawCanvas()
  }

  onMounted(() => {
    nextTick(() => {
      initCanvas()
      updateCanvasStyle()
      saveHistory()
    })
    resizeObserver = new ResizeObserver(() => initCanvas())
    if (stageRef.value) {
      resizeObserver.observe(stageRef.value)
    }
  })

  onBeforeUnmount(() => {
    resizeObserver?.disconnect()
  })
  return {
    activeTool,
    strokeColor,
    strokeWidth,
    colors,
    strokeWidths,
    history,
    historyIndex,
    undo,
    redo,
    clearDrawAnnotations,
    exportAnnotations,
    updateCanvasStyle,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerLeave,
    addText,
  }
}
