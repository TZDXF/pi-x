<script setup lang="ts">
/**
 * Built-in browser panel: renders any page through the Rust preview proxy in
 * a plain iframe (works on desktop and in remote/web access), with two
 * annotation modes — element inspect (pin / area + comment, insertable into
 * the chat composer) and a free-hand canvas overlay.
 */
import { useI18n } from "vue-i18n"
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { openUrl } from "@tauri-apps/plugin-opener"
import {
  ArrowLeft,
  ArrowRight,
  Circle,
  Copy,
  Crosshair,
  Download,
  Eraser,
  ExternalLink,
  Globe,
  List,
  Minus,
  MousePointer2,
  Pencil,
  RefreshCw,
  Square,
  SquareTerminal,
  Trash2,
  Type,
  Undo2,
  Redo2,
  X,
} from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { isDesktop } from "@/api/transport"
import { previewProxyInfo } from "@/api/piClient"
import {
  isBridgeInbound,
  bridgeAddMarker,
  bridgeCommand,
  bridgeInspect,
  type BridgeOutbound,
  type PreviewArea,
  type PreviewPin,
} from "@/lib/previewBridge"
import {
  annotationsForPage,
  formatAnnotationsForChat,
  nextAnnotationId,
  type PageAnnotation,
} from "@/lib/previewAnnotations"
import { normalizeInputUrl, resolveProxyBase, toProxyUrl } from "@/lib/previewUrl"
import { drawAnnotation, type DrawAnnotation, type DrawTool, type Point } from "@/lib/canvasAnnotations"

type Mode = "none" | "draw" | "inspect"
type CanvasTool = DrawTool | "eraser"

interface ConsoleEntry {
  id: number
  level: "log" | "info" | "warn" | "error" | "debug"
  text: string
}

const props = defineProps<{ visible?: boolean }>()
const emit = defineEmits<{ "send-to-chat": [text: string] }>()

const { t } = useI18n()

// ---- preview proxy / navigation -------------------------------------------

const proxyBase = ref<string | null>(null)
const proxyError = ref(false)
const currentUrl = ref("")
const pageTitle = ref("")
const inputUrl = ref("")
const iframeKey = ref(0)
const loading = ref(false)

const iframeRef = ref<HTMLIFrameElement | null>(null)
// What the iframe actually loads; kept separate from `currentUrl` (the display
// URL) so bridge-reported navigations never recompute the src and cause
// reload loops through URL-normalization differences.
const activeSrc = ref("")

let initialized = false
watch(
  () => props.visible,
  visible => {
    if (visible && !initialized) {
      initialized = true
      initProxy()
    }
  },
  { immediate: true },
)

async function initProxy() {
  try {
    const info = await previewProxyInfo()
    proxyBase.value = resolveProxyBase(info.base)
  } catch {
    proxyError.value = true
  }
}

function navigate() {
  const url = normalizeInputUrl(inputUrl.value)
  if (!url) return
  if (url === currentUrl.value) {
    reload()
    return
  }
  currentUrl.value = url
  activeSrc.value = proxyBase.value ? toProxyUrl(proxyBase.value, url) : ""
  loading.value = true
}

function reload() {
  if (!currentUrl.value) return
  loading.value = true
  iframeKey.value++
}

function goBack() {
  postToPage(bridgeCommand("back"))
}

function goForward() {
  postToPage(bridgeCommand("forward"))
}

function openExternal() {
  if (!currentUrl.value) return
  if (isDesktop) void openUrl(currentUrl.value)
  else window.open(currentUrl.value, "_blank", "noopener")
}

function postToPage(message: BridgeOutbound) {
  // Payloads carry objects read out of deep refs (selections, annotations),
  // which are reactive proxies; structured clone rejects proxies, so flatten
  // to plain JSON first — the bridge contract is JSON data anyway.
  iframeRef.value?.contentWindow?.postMessage(JSON.parse(JSON.stringify(message)), "*")
}

function onIframeLoad() {
  loading.value = false
  postToPage(bridgeInspect(mode.value === "inspect"))
  syncMarkers()
}

// ---- bridge messages --------------------------------------------------------

const consoleEntries = ref<ConsoleEntry[]>([])
let consoleSeq = 0

function pushConsole(level: ConsoleEntry["level"], text: string) {
  consoleEntries.value.push({ id: ++consoleSeq, level, text })
  if (consoleEntries.value.length > 200) consoleEntries.value.splice(0, consoleEntries.value.length - 200)
}

function onMessage(event: MessageEvent) {
  const data = event.data
  if (!isBridgeInbound(data)) return
  if (!iframeRef.value || event.source !== iframeRef.value.contentWindow) return
  if (data.type === "navigated") {
    const pageUrl = proxyBase.value ? pageUrlFromProxy(proxyBase.value, data.url) : null
    currentUrl.value = pageUrl ?? currentUrl.value
    inputUrl.value = currentUrl.value
    pageTitle.value = data.title
    loading.value = false
    if (mode.value === "inspect") postToPage(bridgeInspect(true))
    syncMarkers()
  } else if (data.type === "console") {
    pushConsole(data.level, data.text)
  } else if (data.type === "selected" && mode.value === "inspect") {
    pendingSelection.value = { pin: data.pin, area: data.area }
    commentDraft.value = ""
  }
}

/** Maps a proxied URL back to the real page URL: `{base}/{scheme}/{host}/{path}`. */
function pageUrlFromProxy(base: string, proxiedUrl: string): string | null {
  const prefix = base.replace(/\/$/, "")
  if (!proxiedUrl.startsWith(`${prefix}/`)) return null
  const [scheme, ...rest] = proxiedUrl.slice(prefix.length + 1).split("/")
  if (!scheme || rest.length === 0) return null
  return `${scheme}://${rest.join("/")}`
}

// ---- annotation modes --------------------------------------------------------

const mode = ref<Mode>("none")
const showAnnotations = ref(false)
const showConsole = ref(false)
const annotations = ref<PageAnnotation[]>([])
const numberSeq = ref(0)

const pendingSelection = ref<{ pin?: PreviewPin; area?: PreviewArea } | null>(null)
const pendingTextPoint = ref<Point | null>(null)
const commentDraft = ref("")
const commentInput = ref<HTMLTextAreaElement | null>(null)

const showCommentPopover = computed(() => pendingSelection.value !== null || pendingTextPoint.value !== null)

function setMode(next: Mode) {
  mode.value = next
  if (next === "inspect") {
    postToPage(bridgeInspect(true))
    activeTool.value = "pen"
  } else {
    postToPage(bridgeInspect(false))
  }
  if (next !== "draw") updateCanvasStyle()
  if (next !== "inspect" && showAnnotations.value === false) showAnnotations.value = annotations.value.length > 0
}

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

const selectionSummary = computed(() => {
  const selection = pendingSelection.value
  if (!selection) return ""
  if (selection.pin) return selection.pin.selector + (selection.pin.text ? ` · ${selection.pin.text}` : "")
  const rect = selection.area?.rect
  if (rect)
    return `${Math.round(rect.width)}×${Math.round(rect.height)} @ (${Math.round(rect.x)}, ${Math.round(rect.y)})`
  return ""
})

function cancelPending() {
  pendingSelection.value = null
  pendingTextPoint.value = null
  commentDraft.value = ""
}

function saveComment() {
  if (pendingSelection.value) {
    const selection = pendingSelection.value
    const annotation: PageAnnotation = {
      id: nextAnnotationId(),
      kind: selection.pin ? "pin" : "area",
      number: ++numberSeq.value,
      pin: selection.pin,
      area: selection.area,
      comment: commentDraft.value.trim(),
      url: currentUrl.value,
    }
    annotations.value.push(annotation)
    postToPage(
      bridgeAddMarker({
        id: annotation.id,
        kind: annotation.kind,
        number: annotation.number,
        rect: annotationRect(annotation),
        pin: annotation.pin,
      }),
    )
  } else if (pendingTextPoint.value && commentDraft.value.trim()) {
    const annotation: CanvasAnnotation = {
      id: generateId(),
      tool: "text",
      points: [pendingTextPoint.value],
      color: strokeColor.value,
      strokeWidth: strokeWidth.value,
      text: commentDraft.value.trim(),
    }
    drawAnnotations.value.push(annotation)
    saveHistory()
    redrawCanvas()
  }
  cancelPending()
}

function annotationRect(annotation: PageAnnotation) {
  return annotation.pin?.rect ?? annotation.area?.rect ?? { x: 0, y: 0, width: 0, height: 0 }
}

function syncMarkers() {
  postToPage(bridgeCommand("clear-markers"))
  for (const annotation of annotationsForPage(annotations.value, currentUrl.value)) {
    postToPage(
      bridgeAddMarker({
        id: annotation.id,
        kind: annotation.kind,
        number: annotation.number,
        rect: annotationRect(annotation),
        pin: annotation.pin,
      }),
    )
  }
}

function deleteAnnotation(id: string) {
  annotations.value = annotations.value.filter(annotation => annotation.id !== id)
  syncMarkers()
}

function clearAllAnnotations() {
  annotations.value = []
  numberSeq.value = 0
  syncMarkers()
}

function copyAnnotations() {
  void navigator.clipboard?.writeText(chatText()).catch(() => {
    /* clipboard is optional */
  })
}

function chatText() {
  return formatAnnotationsForChat(
    annotations.value,
    { url: currentUrl.value, title: pageTitle.value },
    {
      page: t("browser.chatPage"),
      element: t("browser.chatElement"),
      area: t("browser.chatArea"),
      comment: t("browser.chatComment"),
    },
  )
}

function insertIntoChat() {
  if (!annotations.value.length) return
  emit("send-to-chat", chatText())
  showAnnotations.value = false
}

// ---- free-hand canvas layer ---------------------------------------------------

type CanvasAnnotation = DrawAnnotation

const canvasRef = ref<HTMLCanvasElement | null>(null)
const stageRef = ref<HTMLElement | null>(null)
const activeTool = ref<CanvasTool>("pen")
const strokeColor = ref("#ef4444")
const strokeWidth = ref(2)
const drawAnnotations = ref<CanvasAnnotation[]>([])
const currentAnnotation = ref<CanvasAnnotation | null>(null)
const history = ref<CanvasAnnotation[][]>([])
const historyIndex = ref(-1)

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

function saveHistory() {
  history.value = history.value.slice(0, historyIndex.value + 1)
  history.value.push(JSON.parse(JSON.stringify(drawAnnotations.value)))
  historyIndex.value = history.value.length - 1
}

function undo() {
  if (historyIndex.value <= 0) return
  historyIndex.value--
  drawAnnotations.value = JSON.parse(JSON.stringify(history.value[historyIndex.value]))
  redrawCanvas()
}

function redo() {
  if (historyIndex.value >= history.value.length - 1) return
  historyIndex.value++
  drawAnnotations.value = JSON.parse(JSON.stringify(history.value[historyIndex.value]))
  redrawCanvas()
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
    x: (e.clientX - rect.left) * (canvasEl.width / rect.width),
    y: (e.clientY - rect.top) * (canvasEl.height / rect.height),
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
    pendingTextPoint.value = currentAnnotation.value.points[0]
    currentAnnotation.value = null
    commentDraft.value = ""
    nextTick(() => commentInput.value?.focus())
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
    if (hitTest(drawAnnotations.value[i], point, tolerance)) {
      drawAnnotations.value.splice(i, 1)
      saveHistory()
      redrawCanvas()
      return
    }
  }
}

function hitTest(annotation: CanvasAnnotation, point: Point, tolerance: number): boolean {
  const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance
  const nearSegment = (a: Point, b: Point) => {
    const lengthSquared = (b.x - a.x) ** 2 + (b.y - a.y) ** 2
    const t =
      lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / lengthSquared))
    return near(point, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) })
  }
  if (annotation.tool === "pen" || annotation.tool === "arrow") {
    for (let i = 1; i < annotation.points.length; i++) {
      if (nearSegment(annotation.points[i - 1], annotation.points[i])) return true
    }
    return false
  }
  if (annotation.tool === "rect" && annotation.points.length >= 2) {
    const { x, y, width, height } = boundsOf(annotation)
    return (
      nearSegment({ x, y }, { x: x + width, y }) ||
      nearSegment({ x: x + width, y }, { x: x + width, y: y + height }) ||
      nearSegment({ x: x + width, y: y + height }, { x, y: y + height }) ||
      nearSegment({ x, y: y + height }, { x, y })
    )
  }
  if (annotation.tool === "circle" && annotation.points.length >= 2) {
    const { x, y, width, height } = boundsOf(annotation)
    const rx = width / 2
    const ry = height / 2
    if (rx <= 0 || ry <= 0) return false
    const dx = (point.x - (x + rx)) / rx
    const dy = (point.y - (y + ry)) / ry
    return Math.abs(Math.hypot(dx, dy) - 1) * Math.min(rx, ry) <= tolerance
  }
  if (annotation.tool === "text" && annotation.points.length >= 1) {
    const origin = annotation.points[0]
    const size = annotation.strokeWidth * 6 + 10
    const width = canvas?.measureText(annotation.text ?? "").width ?? annotation.text!.length * size
    return point.x >= origin.x && point.x <= origin.x + width && point.y >= origin.y - size && point.y <= origin.y
  }
  return false
}

function boundsOf(annotation: CanvasAnnotation) {
  const [start, end] = annotation.points
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
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

// ---- lifecycle -----------------------------------------------------------------

watch(currentUrl, url => {
  inputUrl.value = url
})

onMounted(() => {
  window.addEventListener("message", onMessage)
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
  window.removeEventListener("message", onMessage)
  resizeObserver?.disconnect()
})
</script>

<template>
  <div class="browser-panel flex h-full min-h-0 flex-col bg-background">
    <!-- 导航栏 -->
    <div class="flex items-center gap-1 border-b px-2 py-1.5">
      <Button variant="ghost" size="icon-xs" :title="t('browser.back')" :disabled="!currentUrl" @click="goBack">
        <ArrowLeft class="size-4" />
      </Button>
      <Button variant="ghost" size="icon-xs" :title="t('browser.forward')" :disabled="!currentUrl" @click="goForward">
        <ArrowRight class="size-4" />
      </Button>
      <Button variant="ghost" size="icon-xs" :title="t('browser.reload')" :disabled="!currentUrl" @click="reload">
        <RefreshCw class="size-4" />
      </Button>
      <div class="flex min-w-0 flex-1 items-center gap-1 rounded-md border bg-background px-2 py-1">
        <Globe class="size-3.5 shrink-0 text-muted-foreground" />
        <input
          v-model="inputUrl"
          type="text"
          class="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          :placeholder="t('browser.urlPlaceholder')"
          @keydown.enter="navigate"
        />
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        :title="t('browser.openExternal')"
        :disabled="!currentUrl"
        @click="openExternal"
      >
        <ExternalLink class="size-4" />
      </Button>
    </div>

    <!-- 模式与标注工具栏 -->
    <div class="flex items-center gap-1 border-b bg-muted/30 px-2 py-1">
      <Button
        variant="ghost"
        size="icon-xs"
        :title="t('browser.browse')"
        :class="{ 'bg-accent text-accent-foreground': mode === 'none' }"
        @click="setMode('none')"
      >
        <MousePointer2 class="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        :title="t('browser.drawMode')"
        :class="{ 'bg-accent text-accent-foreground': mode === 'draw' }"
        @click="setMode('draw')"
      >
        <Pencil class="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        :title="t('browser.inspect')"
        :class="{ 'bg-accent text-accent-foreground': mode === 'inspect' }"
        @click="setMode('inspect')"
      >
        <Crosshair class="size-4" />
      </Button>
      <div class="mx-1 h-4 w-px bg-border" />

      <template v-if="mode === 'draw'">
        <template v-for="tool in ['pen', 'arrow', 'rect', 'circle', 'text', 'eraser'] as const" :key="tool">
          <Button
            variant="ghost"
            size="icon-xs"
            :title="t(`browser.${tool}`)"
            :class="{ 'bg-accent': activeTool === tool }"
            @click="activeTool = tool"
          >
            <Circle v-if="tool === 'circle'" class="size-4" />
            <Minus v-else-if="tool === 'arrow'" class="size-4" />
            <Square v-else-if="tool === 'rect'" class="size-4" />
            <Type v-else-if="tool === 'text'" class="size-4" />
            <Eraser v-else-if="tool === 'eraser'" class="size-4" />
            <Pencil v-else class="size-4" />
          </Button>
        </template>
        <div class="mx-1 h-4 w-px bg-border" />
        <button
          v-for="color in colors"
          :key="color"
          class="size-4 rounded-full border-2"
          :class="strokeColor === color ? 'border-primary' : 'border-transparent'"
          :style="{ backgroundColor: color }"
          :title="color"
          @click="strokeColor = color"
        />
        <div class="mx-1 h-4 w-px bg-border" />
        <button
          v-for="width in strokeWidths"
          :key="width"
          class="flex size-6 items-center justify-center rounded-sm"
          :class="strokeWidth === width ? 'bg-accent' : 'hover:bg-accent/50'"
          :title="`${width}px`"
          @click="strokeWidth = width"
        >
          <span class="rounded-full bg-current" :style="{ width: `${width + 1}px`, height: `${width + 1}px` }" />
        </button>
        <div class="mx-1 h-4 w-px bg-border" />
        <Button variant="ghost" size="icon-xs" :title="t('browser.undo')" :disabled="historyIndex <= 0" @click="undo">
          <Undo2 class="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          :title="t('browser.redo')"
          :disabled="historyIndex >= history.length - 1"
          @click="redo"
        >
          <Redo2 class="size-4" />
        </Button>
        <Button variant="ghost" size="icon-xs" :title="t('browser.clearAnnotations')" @click="clearDrawAnnotations">
          <Trash2 class="size-4" />
        </Button>
        <Button variant="ghost" size="icon-xs" :title="t('browser.export')" @click="exportAnnotations">
          <Download class="size-4" />
        </Button>
      </template>
      <span v-else-if="mode === 'inspect'" class="truncate text-xs text-muted-foreground">{{
        t("browser.inspectHint")
      }}</span>
      <span v-else class="truncate text-xs text-muted-foreground">{{ t("browser.browseHint") }}</span>

      <div class="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-xs"
          :title="t('browser.console')"
          :class="{ 'bg-accent text-accent-foreground': showConsole }"
          @click="toggleDrawer('console')"
        >
          <SquareTerminal class="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          :title="t('browser.annotations')"
          :class="{ 'bg-accent text-accent-foreground': showAnnotations }"
          @click="toggleDrawer('annotations')"
        >
          <List class="size-4" />
          <span v-if="annotations.length" class="ml-0.5 text-[10px] leading-none">{{ annotations.length }}</span>
        </Button>
      </div>
    </div>

    <!-- 内容区 -->
    <div ref="stageRef" class="relative min-h-0 flex-1 overflow-hidden">
      <div
        v-if="proxyError"
        class="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground"
      >
        {{ t("browser.proxyUnavailable") }}
      </div>
      <div
        v-else-if="!activeSrc"
        class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground"
      >
        <Globe class="size-6 opacity-50" />
        <span>{{ t("browser.emptyHint") }}</span>
      </div>
      <template v-else>
        <iframe
          :key="iframeKey"
          ref="iframeRef"
          :src="activeSrc"
          class="absolute inset-0 h-full w-full border-none bg-white"
          title="PiX browser preview"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          referrerpolicy="no-referrer"
          @load="onIframeLoad"
        />
        <div
          v-if="loading"
          class="absolute inset-0 z-10 flex items-center justify-center bg-background/60 text-xs text-muted-foreground"
        >
          {{ t("browser.loading") }}
        </div>
      </template>

      <!-- 画笔涂鸦层 -->
      <canvas
        v-show="mode === 'draw'"
        ref="canvasRef"
        class="absolute inset-0 z-10"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointerleave="onPointerLeave"
      />

      <!-- 标注评论弹层(检查选择 / 画笔文字) -->
      <div
        v-if="showCommentPopover"
        class="absolute inset-x-6 bottom-3 z-20 rounded-lg border bg-background p-3 shadow-lg"
      >
        <div class="mb-2 flex items-center gap-2">
          <span class="text-xs font-medium">{{
            pendingTextPoint ? t("browser.textTool") : t("browser.addAnnotation")
          }}</span>
          <span
            v-if="selectionSummary"
            class="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground"
            :title="selectionSummary"
            >{{ selectionSummary }}</span
          >
          <Button variant="ghost" size="icon-xs" :title="t('browser.cancel')" @click="cancelPending">
            <X class="size-3.5" />
          </Button>
        </div>
        <textarea
          ref="commentInput"
          v-model="commentDraft"
          rows="2"
          class="w-full resize-none rounded-md border bg-transparent p-2 text-xs outline-none placeholder:text-muted-foreground"
          :placeholder="t('browser.commentPlaceholder')"
          @keydown.enter.exact.prevent="saveComment"
          @keydown.esc.prevent="cancelPending"
        />
        <div class="mt-2 flex justify-end gap-2">
          <Button variant="outline" size="sm" @click="cancelPending">{{ t("browser.cancel") }}</Button>
          <Button size="sm" @click="saveComment">{{ t("browser.save") }}</Button>
        </div>
      </div>

      <!-- 标注列表抽屉 -->
      <div
        v-if="showAnnotations"
        class="absolute inset-x-0 bottom-0 z-20 flex flex-col border-t bg-background"
        :style="{ height: `${drawerHeights.annotations}px` }"
      >
        <div
          class="absolute inset-x-0 -top-1.5 z-20 h-3 cursor-row-resize touch-none"
          :title="t('browser.resizeDrawer')"
          @pointerdown="onDrawerResizeStart('annotations', $event)"
          @pointermove="onDrawerResizeMove"
          @pointerup="onDrawerResizeEnd"
          @pointercancel="onDrawerResizeEnd"
        >
          <div class="mx-auto h-1 w-10 translate-y-1 rounded-full bg-muted-foreground/30"></div>
        </div>
        <div class="flex items-center gap-2 border-b px-2 py-1.5">
          <span class="text-xs font-medium">{{ t("browser.annotations") }}</span>
          <span class="text-xs text-muted-foreground">{{ annotations.length }}</span>
          <div class="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" :disabled="!annotations.length" @click="insertIntoChat">{{
              t("browser.insertToChat")
            }}</Button>
            <Button
              variant="ghost"
              size="icon-xs"
              :title="t('browser.copyAnnotations')"
              :disabled="!annotations.length"
              @click="copyAnnotations"
            >
              <Copy class="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              :title="t('browser.clearAnnotations')"
              :disabled="!annotations.length"
              @click="clearAllAnnotations"
            >
              <Trash2 class="size-4" />
            </Button>
            <Button variant="ghost" size="icon-xs" :title="t('sidebarTabs.closeTab')" @click="showAnnotations = false">
              <X class="size-4" />
            </Button>
          </div>
        </div>
        <div v-if="!annotations.length" class="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          {{ t("browser.annotationsEmpty") }}
        </div>
        <div v-else class="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          <div
            v-for="annotation in annotations"
            :key="annotation.id"
            class="group flex items-start gap-2 rounded-md border p-2 text-xs"
          >
            <span
              class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground"
              >{{ annotation.number }}</span
            >
            <div class="min-w-0 flex-1">
              <div
                class="truncate font-mono text-[10px] text-muted-foreground"
                :title="annotation.kind === 'pin' ? annotation.pin?.selector : undefined"
              >
                {{ annotation.kind === "pin" ? annotation.pin?.selector : t("browser.area") }}
              </div>
              <div v-if="annotation.kind === 'pin' && annotation.pin?.text" class="truncate">
                {{ annotation.pin.text }}
              </div>
              <div class="whitespace-pre-wrap">{{ annotation.comment }}</div>
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              class="shrink-0 opacity-0 group-hover:opacity-100"
              :title="t('browser.deleteAnnotation')"
              @click="deleteAnnotation(annotation.id)"
            >
              <X class="size-3.5" />
            </Button>
          </div>
        </div>
      </div>

      <!-- 控制台抽屉 -->
      <div
        v-if="showConsole"
        class="absolute inset-x-0 bottom-0 z-20 flex flex-col border-t bg-background font-mono text-[11px]"
        :style="{ height: `${drawerHeights.console}px` }"
      >
        <div
          class="absolute inset-x-0 -top-1.5 z-20 h-3 cursor-row-resize touch-none"
          :title="t('browser.resizeDrawer')"
          @pointerdown="onDrawerResizeStart('console', $event)"
          @pointermove="onDrawerResizeMove"
          @pointerup="onDrawerResizeEnd"
          @pointercancel="onDrawerResizeEnd"
        >
          <div class="mx-auto h-1 w-10 translate-y-1 rounded-full bg-muted-foreground/30"></div>
        </div>
        <div class="flex items-center gap-2 border-b px-2 py-1.5">
          <span class="font-sans text-xs font-medium">{{ t("browser.console") }}</span>
          <div class="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              :title="t('browser.clearAnnotations')"
              :disabled="!consoleEntries.length"
              @click="consoleEntries = []"
            >
              <Trash2 class="size-4" />
            </Button>
            <Button variant="ghost" size="icon-xs" :title="t('sidebarTabs.closeTab')" @click="showConsole = false">
              <X class="size-4" />
            </Button>
          </div>
        </div>
        <div
          v-if="!consoleEntries.length"
          class="flex flex-1 items-center justify-center font-sans text-xs text-muted-foreground"
        >
          {{ t("browser.consoleEmpty") }}
        </div>
        <div v-else class="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
          <div
            v-for="entry in consoleEntries"
            :key="entry.id"
            class="flex gap-2"
            :class="entry.level === 'error' ? 'text-destructive' : entry.level === 'warn' ? 'text-amber-500' : ''"
          >
            <span class="shrink-0 opacity-50">{{ entry.level }}</span>
            <span class="whitespace-pre-wrap break-all">{{ entry.text }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.browser-panel iframe {
  border: none;
}
</style>
