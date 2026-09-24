<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { clampReviewWidth, reviewWidthBounds } from "@/lib/reviewWidth"
import { useI18n } from "vue-i18n"
import { X } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import SessionDiff from "@/components/SessionDiff.vue"
import type { FileChange } from "@/lib/sessionChanges"
const props = defineProps<{ changes: FileChange[] }>()
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
function fileName(path: string) { return path.split("/").pop() || path }
function directory(path: string) { const end = path.lastIndexOf("/"); return end < 0 ? "" : path.slice(0, end) }
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
        <div class="shrink-0 border-b px-3 py-2">
          <h3 class="break-all text-xs font-medium" :title="activeFile.path">{{ activeFile.path }}</h3>
          <div class="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <span class="text-green-600">+{{ activeFile.added }}</span>
            <span class="text-red-500">−{{ activeFile.removed }}</span>
            <div class="ml-auto flex flex-wrap gap-1">
              <Button variant="ghost" size="sm" :aria-pressed="!splitDiff" :class="{ 'bg-accent': !splitDiff }" @click="splitDiff = false">{{ t('changes.unified') }}</Button>
              <Button variant="ghost" size="sm" :aria-pressed="splitDiff" :class="{ 'bg-accent': splitDiff }" @click="splitDiff = true">{{ t('changes.split') }}</Button>
              <Button variant="ghost" size="sm" :aria-pressed="wordDiff" :class="{ 'bg-accent': wordDiff }" @click="wordDiff = !wordDiff">{{ t('changes.wordDiff') }}</Button>
            </div>
          </div>
        </div>
        <div class="min-h-0 flex-1 overflow-auto" tabindex="0" :aria-label="t('changes.fileDiff')">
          <section v-for="(change, operation) in activeFile.changes" :key="change.id" class="border-b">
            <div class="px-3 py-2 text-xs text-muted-foreground">
              {{ operation + 1 }} · {{ change.tool }}<span v-if="!change.unknownBefore"> · {{ t('changes.snippetLines') }}</span><span v-if="change.unknownBefore"> · {{ t('changes.unknown') }}</span>
            </div>
            <SessionDiff :change="change" :split="splitDiff" :word="wordDiff" />
          </section>
        </div>
      </section>
      <nav class="changes-file-list" :aria-label="t('changes.files')">
        <h3 class="shrink-0 border-b px-3 py-2 text-xs font-medium">{{ t('changes.files') }} · {{ files.length }}</h3>
        <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
          <button
            v-for="file in files" :key="file.path" type="button"
            class="mb-1 block w-full min-w-0 rounded-md px-2 py-2 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring"
            :class="activeFile.path === file.path ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'"
            :aria-current="activeFile.path === file.path ? 'true' : undefined" :title="file.path"
            @click="selectedPath = file.path"
          >
            <span class="block truncate font-medium">{{ fileName(file.path) }}</span>
            <span v-if="directory(file.path)" class="mt-0.5 block truncate text-[10px] text-muted-foreground">{{ directory(file.path) }}</span>
            <span class="mt-1 flex flex-wrap gap-x-2">
              <span class="text-green-600">+{{ file.added }}</span><span class="text-red-500">−{{ file.removed }}</span>
              <span v-if="file.changes.some(change => change.unknownBefore)" :title="t('changes.unknown')">*</span>
            </span>
          </button>
        </div>
      </nav>
    </div>
    <p v-else class="p-6 text-center text-sm text-muted-foreground">{{ t('changes.empty') }}</p>
  </aside>
</template>
