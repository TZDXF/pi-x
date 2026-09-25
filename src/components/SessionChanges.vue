<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { clampReviewWidth, reviewWidthBounds } from "@/lib/reviewWidth"
import { useI18n } from "vue-i18n"
import { ChevronRight, Columns2, ExternalLink, FileCode, Folder, FolderOpen, FolderTree, Highlighter, List, Rows2, X } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { isDesktop } from "@/api/transport"
import { openFileInEditor } from "@/lib/openWith"
import SessionDiff from "@/components/SessionDiff.vue"
import { buildFileTree, flatFileRows, flattenVisibleTree } from "@/lib/reviewFileTree"
import type { FileChange } from "@/lib/sessionChanges"
const props = defineProps<{ changes: FileChange[]; project?: string; focus?: string | null }>()
defineEmits<{ close: [] }>()
const { t } = useI18n()
const sidebar = ref<HTMLElement | null>(null)
const containerWidth = ref(1200)
const overlay = ref(false)
const preferredWidth = ref(640)
const storageKey = "pix.review-sidebar-width"
try {
  const saved = Number(localStorage.getItem(storageKey))
  if (Number.isFinite(saved) && saved > 0) preferredWidth.value = saved
} catch { /* Storage may be unavailable in restricted browsers. */ }
const bounds = computed(() => reviewWidthBounds(containerWidth.value, overlay.value))
const width = computed(() => clampReviewWidth(preferredWidth.value, containerWidth.value, overlay.value))
const dragging = ref(false)
let pointer: { id: number; x: number; width: number; target: HTMLElement } | null = null
let observer: ResizeObserver | undefined
let previousCursor = ""
let previousSelect = ""
function measure() {
  containerWidth.value = sidebar.value?.parentElement?.getBoundingClientRect().width ?? 0
  overlay.value = window.matchMedia("(max-width: 900px)").matches
}
function saveWidth() {
  try { localStorage.setItem(storageKey, String(preferredWidth.value)) } catch { /* Optional preference. */ }
}
function startResize(event: PointerEvent) {
  if (event.button !== 0 || pointer) return
  measure()
  const target = event.currentTarget as HTMLElement
  target.focus()
  target.setPointerCapture(event.pointerId)
  pointer = { id: event.pointerId, x: event.clientX, width: width.value, target }
  dragging.value = true
  previousCursor = document.body.style.cursor
  previousSelect = document.body.style.userSelect
  document.body.style.cursor = "col-resize"
  document.body.style.userSelect = "none"
  event.preventDefault()
}
function resize(event: PointerEvent) {
  if (!pointer || pointer.id !== event.pointerId) return
  preferredWidth.value = clampReviewWidth(pointer.width + pointer.x - event.clientX, containerWidth.value, overlay.value)
}
function stopResize() {
  if (!pointer) return
  const active = pointer
  pointer = null
  dragging.value = false
  if (active.target.hasPointerCapture(active.id)) active.target.releasePointerCapture(active.id)
  document.body.style.cursor = previousCursor
  document.body.style.userSelect = previousSelect
  saveWidth()
}
function resizeWithKeyboard(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
  event.preventDefault()
  measure()
  const step = event.shiftKey ? 64 : 16
  const next = event.key === "Home" ? bounds.value.min : event.key === "End" ? bounds.value.max
    : width.value + (event.key === "ArrowLeft" ? step : -step)
  preferredWidth.value = clampReviewWidth(next, containerWidth.value, overlay.value)
  saveWidth()
}
onMounted(() => {
  measure()
  observer = new ResizeObserver(measure)
  if (sidebar.value?.parentElement) observer.observe(sidebar.value.parentElement)
  window.addEventListener("resize", measure)
  window.addEventListener("blur", stopResize)
})
onBeforeUnmount(() => {
  stopResize()
  observer?.disconnect()
  window.removeEventListener("resize", measure)
  window.removeEventListener("blur", stopResize)
})
const files = computed(() => {
  const groups = new Map<string, FileChange[]>()
  for (const change of props.changes) {
    const group = groups.get(change.path)
    if (group) group.push(change)
    else groups.set(change.path, [change])
  }
  return [...groups].map(([path, changes]) => ({ path, changes, added: changes.reduce((n, c) => n + c.added, 0), removed: changes.reduce((n, c) => n + c.removed, 0) }))
})
const splitDiff = ref(false)
const wordDiff = ref(true)
const selectedPath = ref<string | null>(null)
// Keep the current file selected during streaming; fall back safely when the session changes.
const activeFile = computed(() => files.value.find(file => file.path === selectedPath.value) ?? files.value[0] ?? null)
const opening = ref(false)
const openError = ref("")
watch(() => activeFile.value?.path, () => { openError.value = "" })
async function openActiveFile() {
  const file = activeFile.value
  if (!file || opening.value) return
  const path = file.path
  opening.value = true
  openError.value = ""
  try { await openFileInEditor(path, props.project ?? "") }
  catch (error) {
    if (activeFile.value?.path === path) openError.value = t("openWith.failed", { error: String(error) })
  } finally { opening.value = false }
}
const treeMode = ref(false)
const collapsed = ref(new Set<string>())
const fileRows = computed(() => treeMode.value
  ? flattenVisibleTree(buildFileTree(files.value.map(file => ({ ...file, path: file.path.replace(/\\/g, "/") }))), collapsed.value)
  : flatFileRows(files.value))
// Locate a file requested from a chat tool card: select it, reveal its
// tree ancestors, and scroll its row into view.
watch(() => props.focus, path => {
  if (!path) return
  const normalized = path.replace(/\\/g, "/")
  const file = files.value.find(file => file.path === normalized)
  if (!file) return
  selectedPath.value = file.path
  const next = new Set(collapsed.value)
  const parts = normalized.split("/")
  for (let i = 1; i < parts.length; i++) next.delete(parts.slice(0, i).join("/"))
  collapsed.value = next
  nextTick(() => sidebar.value?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" }))
}, { immediate: true })
function selectRow(row: (typeof fileRows.value)[number]) {
  if (row.isDir) {
    const next = new Set(collapsed.value)
    if (next.has(row.fullPath)) next.delete(row.fullPath)
    else next.add(row.fullPath)
    collapsed.value = next
  } else if (row.data) selectedPath.value = row.data.changes[0]?.path ?? row.fullPath
}
</script>

<template>
  <aside ref="sidebar" class="changes-sidebar" :style="{ width: `${width}px` }" :aria-label="t('changes.title')" @keydown.esc="$emit('close')">
    <div
      class="changes-resize-handle" :class="{ 'is-dragging': dragging }"
      role="separator" tabindex="0" aria-orientation="vertical"
      :aria-label="t('changes.resize')" :title="t('changes.resize')"
      :aria-valuenow="Math.round(width)" :aria-valuemin="Math.round(bounds.min)" :aria-valuemax="Math.round(bounds.max)"
      @pointerdown="startResize" @pointermove="resize" @pointerup="stopResize"
      @pointercancel="stopResize" @lostpointercapture="stopResize" @keydown="resizeWithKeyboard"
    />
    <div class="flex items-center justify-between border-b p-3">
      <h2 class="text-sm font-medium">{{ t('changes.title') }} · {{ files.length }}</h2>
      <Button variant="ghost" size="icon-sm" :aria-label="t('changes.close')" @click="$emit('close')"><X /></Button>
    </div>
    <p class="border-b p-3 text-xs text-muted-foreground">{{ t('changes.description') }}</p>
    <div v-if="activeFile" class="changes-review-body">
      <section :key="activeFile.path" class="changes-file-view" :aria-label="t('changes.fileDiff')">
        <div class="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
          <h3 class="min-w-0 flex-1 truncate font-mono text-xs" :title="activeFile.path">{{ activeFile.path }}</h3>
          <button v-if="isDesktop" class="changes-tool disabled:opacity-40" :disabled="opening" :title="t('openWith.open')" :aria-label="t('openWith.open')" @click="openActiveFile"><ExternalLink /></button>
          <button class="changes-tool" :class="{ 'bg-accent text-foreground': wordDiff }" :title="t('changes.wordDiff')" :aria-label="t('changes.wordDiff')" :aria-pressed="wordDiff" @click="wordDiff = !wordDiff"><Highlighter /></button>
          <button v-if="activeFile.changes.some(change => !change.unknownBefore)" class="changes-tool" :title="t(splitDiff ? 'changes.unified' : 'changes.split')" :aria-label="t(splitDiff ? 'changes.unified' : 'changes.split')" :aria-pressed="splitDiff" @click="splitDiff = !splitDiff"><Rows2 v-if="splitDiff" /><Columns2 v-else /></button>
        </div>
        <p v-if="openError" role="alert" class="shrink-0 break-words border-b px-3 py-2 text-xs text-destructive">{{ openError }}</p>
        <!-- 换 key 重建:reka-ui 的 ScrollAreaScrollbar 卸载时会同时禁用两个方向,动态改 orientation 会让 overflow-y 卡在 hidden -->
        <ScrollArea :key="splitDiff ? 'split' : 'unified'" class="min-h-0 flex-1" :orientation="splitDiff ? 'vertical' : 'both'" viewport-class="pb-2.5" :aria-label="t('changes.fileDiff')">
          <section v-for="(change, operation) in activeFile.changes" :key="change.id" class="border-b">
            <div class="px-3 py-2 text-xs text-muted-foreground">
              {{ operation + 1 }} · {{ change.tool }}<span v-if="!change.unknownBefore"> · {{ t('changes.snippetLines') }}</span><span v-if="change.unknownBefore"> · {{ t('changes.unknown') }}</span>
            </div>
            <SessionDiff :change="change" :split="splitDiff" :word="wordDiff" />
          </section>
        </ScrollArea>
      </section>
      <nav class="changes-file-list" :aria-label="t('changes.files')">
        <div class="flex shrink-0 items-center justify-between border-b px-3 py-1.5">
          <h3 class="text-xs text-muted-foreground">{{ t('changes.files') }} · {{ files.length }}</h3>
          <button class="changes-tool" :title="t(treeMode ? 'changes.showFlat' : 'changes.showTree')" :aria-label="t(treeMode ? 'changes.showFlat' : 'changes.showTree')" @click="treeMode = !treeMode"><List v-if="treeMode" /><FolderTree v-else /></button>
        </div>
        <ScrollArea class="min-h-0 flex-1" viewport-class="py-1">
          <button v-for="row in fileRows" :key="row.key" type="button"
            class="changes-file-row" :class="{ 'bg-accent': !row.isDir && row.data?.changes[0]?.path === activeFile.path }"
            :style="{ paddingLeft: treeMode ? `${8 + row.depth * 14}px` : '12px' }"
            :aria-current="!row.isDir && row.data?.changes[0]?.path === activeFile.path ? 'true' : undefined"
            :aria-expanded="row.isDir ? row.expanded : undefined" :title="row.fullPath" @click="selectRow(row)">
            <span v-if="treeMode" class="w-3 shrink-0 text-muted-foreground"><ChevronRight v-if="row.isDir" class="size-3 transition-transform" :class="{ 'rotate-90': row.expanded }" /></span>
            <component :is="row.isDir ? (row.expanded ? FolderOpen : Folder) : FileCode" class="size-3.5 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate">{{ row.name }}</span>
            <template v-if="row.data">
              <span v-if="row.data.added" class="shrink-0 text-green-600 dark:text-green-400">+{{ row.data.added }}</span>
              <span v-if="row.data.removed" class="shrink-0 text-red-600 dark:text-red-400">-{{ row.data.removed }}</span>
              <span v-if="row.data.changes.some(change => change.unknownBefore)" :title="t('changes.unknown')">*</span>
            </template>
          </button>
        </ScrollArea>
      </nav>
    </div>
    <p v-else class="p-6 text-center text-sm text-muted-foreground">{{ t('changes.empty') }}</p>
  </aside>
</template>
