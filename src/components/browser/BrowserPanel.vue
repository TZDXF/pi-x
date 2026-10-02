<script setup lang="ts">
/**
 * Built-in browser panel: desktop/remote pages use the Rust preview proxy
 * and its iframe bridge by default, with direct iframe loading as a manual
 * fallback. Inspect annotations can be inserted into chat; the independent
 * canvas layer supports drawing, undo/redo, erasing and PNG export.
 */
import { useI18n } from "vue-i18n"
import { computed, nextTick, ref } from "vue"
import {
  ArrowLeft,
  ArrowRight,
  Circle,
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
import { bridgeInspect } from "@/lib/previewBridge"
import type { Point } from "@/lib/canvasAnnotations"
import { useBrowserNavigation } from "@/composables/browser/useBrowserNavigation"
import { useBrowserBridge } from "@/composables/browser/useBrowserBridge"
import { useBrowserPageAnnotations } from "@/composables/browser/useBrowserPageAnnotations"
import { useBrowserCanvas } from "@/composables/browser/useBrowserCanvas"
import { useBrowserConsole } from "@/composables/browser/useBrowserConsole"
import { useBrowserDrawers } from "@/composables/browser/useBrowserDrawers"
import BrowserDrawer from "./BrowserDrawer.vue"
import BrowserAnnotationsList from "./BrowserAnnotationsList.vue"
import BrowserConsoleList from "./BrowserConsoleList.vue"

type Mode = "none" | "draw" | "inspect"
const props = defineProps<{ visible?: boolean }>()
const emit = defineEmits<{ "send-to-chat": [text: string] }>()
const { t } = useI18n()
const mode = ref<Mode>("none")
const pendingTextPoint = ref<Point | null>(null)
const commentDraft = ref("")
const commentInput = ref<HTMLTextAreaElement | null>(null)
// Template refs remain owned by the host; controllers only use the supplied nodes.
const canvasRef = ref<HTMLCanvasElement | null>(null)
const stageRef = ref<HTMLElement | null>(null)
const iframeRef = ref<HTMLIFrameElement | null>(null)

const {
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
} = useBrowserCanvas({
  mode,
  canvasRef,
  stageRef,
  onTextRequested: point => {
    pendingTextPoint.value = point
    commentDraft.value = ""
    nextTick(() => commentInput.value?.focus())
  },
})
const {
  showAnnotations,
  showConsole,
  drawerHeights,
  toggleDrawer,
  onDrawerResizeStart,
  onDrawerResizeMove,
  onDrawerResizeEnd,
} = useBrowserDrawers(stageRef)
const { consoleEntries, pushConsole } = useBrowserConsole()
const navigation = useBrowserNavigation({
  visible: () => props.visible,
  t,
  postToPage: message => postToPage(message),
  onDirectMode: () => {
    showConsole.value = false
    showAnnotations.value = false
    if (mode.value === "inspect") mode.value = "none"
    updateCanvasStyle()
  },
})
const {
  directMode,
  useProxy,
  directHistory,
  directIndex,
  accessModeLabel,
  accessModeTitle,
  proxyBase,
  proxyError,
  currentUrl,
  pageTitle,
  inputUrl,
  iframeKey,
  loading,
  activeSrc,
  sandboxAttr,
  cycleAccessMode,
  navigate,
  reload,
  goBack,
  goForward,
  openExternal,
} = navigation
const {
  annotations,
  pendingSelection,
  selectionSummary,
  select,
  saveSelection,
  syncMarkers,
  deleteAnnotation,
  clearAllAnnotations,
  copyAnnotations,
  insertIntoChat,
} = useBrowserPageAnnotations({
  currentUrl,
  pageTitle,
  t,
  postToPage: message => postToPage(message),
  sendToChat: text => emit("send-to-chat", text),
  onInserted: () => {
    showAnnotations.value = false
  },
})
const { postToPage, onIframeLoad } = useBrowserBridge({
  iframeRef,
  directMode,
  proxyBase,
  sandboxAttr,
  onNavigated: (url, title) => {
    navigation.receiveNavigation(url, title)
    restorePageState()
  },
  onConsole: pushConsole,
  onSelected: selection => {
    if (mode.value !== "inspect") return
    select({ pin: selection.pin, area: selection.area })
    commentDraft.value = ""
  },
  onLoad: () => {
    loading.value = false
    if (!directMode.value) restorePageState()
  },
})

function restorePageState() {
  postToPage(bridgeInspect(mode.value === "inspect"))
  syncMarkers()
}

function setMode(next: Mode) {
  mode.value = next
  postToPage(bridgeInspect(next === "inspect"))
  if (next === "inspect") activeTool.value = "pen"
  updateCanvasStyle()
  if (next !== "inspect" && !showAnnotations.value) showAnnotations.value = annotations.value.length > 0
}

const showCommentPopover = computed(() => pendingSelection.value !== null || pendingTextPoint.value !== null)
function cancelPending() {
  pendingSelection.value = null
  pendingTextPoint.value = null
  commentDraft.value = ""
}
function saveComment() {
  if (pendingSelection.value) saveSelection(commentDraft.value)
  else if (pendingTextPoint.value) addText(pendingTextPoint.value, commentDraft.value)
  cancelPending()
}
</script>

<template>
  <div class="browser-panel flex h-full min-h-0 flex-col bg-background">
    <!-- 导航栏 -->
    <div class="flex items-center gap-1 border-b px-2 py-1.5">
      <Button
        variant="ghost"
        size="icon-xs"
        :title="t('browser.back')"
        :disabled="!currentUrl || (directMode && directIndex <= 0)"
        @click="goBack"
      >
        <ArrowLeft class="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        :title="t('browser.forward')"
        :disabled="!currentUrl || (directMode && directIndex >= directHistory.length - 1)"
        @click="goForward"
      >
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
      <!-- Access mode toggle: proxy by default, direct as the manual fallback. -->
      <button
        type="button"
        class="shrink-0 rounded border px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        :title="accessModeTitle"
        @click="cycleAccessMode"
      >
        {{ accessModeLabel }}
      </button>
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
        v-if="!directMode"
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
      <span v-else class="truncate text-xs text-muted-foreground">{{
        directMode ? t("browser.browseHintDirect") : t("browser.browseHint")
      }}</span>

      <div class="ml-auto flex items-center gap-1">
        <Button
          v-if="!directMode"
          variant="ghost"
          size="icon-xs"
          :title="t('browser.console')"
          :class="{ 'bg-accent text-accent-foreground': showConsole }"
          @click="toggleDrawer('console')"
        >
          <SquareTerminal class="size-4" />
        </Button>
        <Button
          v-if="!directMode"
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
        v-if="useProxy && proxyError"
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
          :title="t('browser.previewTitle')"
          :sandbox="sandboxAttr"
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

      <BrowserDrawer
        v-if="showAnnotations"
        :height="drawerHeights.annotations"
        @resize-start="onDrawerResizeStart('annotations', $event)"
        @resize-move="onDrawerResizeMove"
        @resize-end="onDrawerResizeEnd"
      >
        <BrowserAnnotationsList
          :annotations="annotations"
          @insert="insertIntoChat"
          @copy="copyAnnotations"
          @clear="clearAllAnnotations"
          @delete="deleteAnnotation"
          @close="showAnnotations = false"
        />
      </BrowserDrawer>
      <BrowserDrawer
        v-if="showConsole"
        :height="drawerHeights.console"
        class="font-mono text-[11px]"
        @resize-start="onDrawerResizeStart('console', $event)"
        @resize-move="onDrawerResizeMove"
        @resize-end="onDrawerResizeEnd"
      >
        <BrowserConsoleList :entries="consoleEntries" @clear="consoleEntries = []" @close="showConsole = false" />
      </BrowserDrawer>
    </div>
  </div>
</template>

<style scoped>
.browser-panel iframe {
  border: none;
}
</style>
