<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { clampReviewWidth, reviewWidthBounds } from "@/lib/reviewWidth"
import { useI18n } from "vue-i18n"
import { FileCode, FolderTree, Globe, PanelRight, Plus, SquareTerminal, X } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { isDesktop } from "@/api/transport"
import ReviewPanel from "@/components/ReviewPanel.vue"
import ProjectFiles from "@/components/ProjectFiles.vue"
import TerminalPanel from "@/components/terminal/TerminalPanel.vue"
import BrowserPanel from "@/components/browser/BrowserPanel.vue"
import type { FileChange } from "@/lib/sessionChanges"
import type { TurnCheckpointRecord } from "@/lib/checkpoints"

export type SidebarTabType = "review" | "files" | "terminal" | "browser"
export interface SidebarTabItem {
  id: number
  type: SidebarTabType
}

const props = defineProps<{
  open: boolean
  tabs: SidebarTabItem[]
  activeId: number | null
  changes: FileChange[]
  project: string
  focus?: string | null
  totals: { added: number; removed: number; unknown: boolean }
  checkpoints?: TurnCheckpointRecord[]
}>()
const emit = defineEmits<{
  close: []
  "update:activeId": [id: number | null]
  "add-tab": [type: SidebarTabType]
  "close-tab": [id: number]
  "send-to-chat": [text: string]
}>()

const { t } = useI18n()
const addOpen = ref(false)
function iconFor(type: SidebarTabType) {
  return type === "review" ? FileCode : type === "files" ? FolderTree : type === "browser" ? Globe : SquareTerminal
}
function titleFor(tab: SidebarTabItem): string {
  const base = t(`sidebarTabs.${tab.type}`)
  const sameType = props.tabs.filter(item => item.type === tab.type)
  if (sameType.length > 1) return `${base} ${sameType.findIndex(item => item.id === tab.id) + 1}`
  if (tab.type === "review" && (props.totals.added || props.totals.removed || props.totals.unknown))
    return `${base} +${props.totals.added} -${props.totals.removed}${props.totals.unknown ? " *" : ""}`
  return base
}
function addTab(type: SidebarTabType) {
  addOpen.value = false
  emit("add-tab", type)
}
function closeTab(id: number) {
  emit("close-tab", id)
}

interface TerminalPanelExposed {
  openTerminal: () => Promise<void>
  hasTerminals: () => boolean
}
const terminalPanels = new Map<number, TerminalPanelExposed>()
function setTerminalPanel(id: number, el: unknown) {
  if (el) terminalPanels.set(id, el as TerminalPanelExposed)
  else terminalPanels.delete(id)
}
function clickTab(tab: SidebarTabItem) {
  const wasActive = tab.id === props.activeId
  emit("update:activeId", tab.id)
  // 已激活的终端 tab 再点一次时，若面板里没有 shell 则直接新建，避免停留在空状态。
  if (wasActive && tab.type === "terminal") {
    const panel = terminalPanels.get(tab.id)
    if (panel && !panel.hasTerminals()) void panel.openTerminal()
  }
}

const sidebar = ref<HTMLElement | null>(null)
const containerWidth = ref(1200)
const overlay = ref(false)
const preferredWidth = ref(640)
const storageKey = "pix.review-sidebar-width"
try {
  const saved = Number(localStorage.getItem(storageKey))
  if (Number.isFinite(saved) && saved > 0) preferredWidth.value = saved
} catch {
  /* Storage may be unavailable in restricted browsers. */
}
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
  try {
    localStorage.setItem(storageKey, String(preferredWidth.value))
  } catch {
    /* Optional preference. */
  }
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
  preferredWidth.value = clampReviewWidth(
    pointer.width + pointer.x - event.clientX,
    containerWidth.value,
    overlay.value,
  )
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
  const next =
    event.key === "Home"
      ? bounds.value.min
      : event.key === "End"
        ? bounds.value.max
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
</script>

<template>
  <aside
    ref="sidebar"
    class="changes-sidebar relative shrink-0 flex flex-col w-[clamp(300px,_36%,_640px)] min-h-0 border-l border-border bg-background max-[900px]:absolute max-[900px]:[inset:0_0_0_auto] max-[900px]:w-[min(100%,_480px)] max-[900px]:z-[30] max-[900px]:shadow-[-8px_0_24px_#0002]"
    :style="{ width: `${width}px` }"
    :aria-label="t('sidebarTabs.title')"
    @keydown.esc="$emit('close')"
  >
    <div
      class="changes-resize-handle absolute [inset:0_auto_0_0] w-[7px] z-[2] cursor-col-resize [touch-action:none] focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px]"
      :class="{ 'is-dragging': dragging }"
      role="separator"
      tabindex="0"
      aria-orientation="vertical"
      :aria-label="t('changes.resize')"
      :title="t('changes.resize')"
      :aria-valuenow="Math.round(width)"
      :aria-valuemin="Math.round(bounds.min)"
      :aria-valuemax="Math.round(bounds.max)"
      @pointerdown="startResize"
      @pointermove="resize"
      @pointerup="stopResize"
      @pointercancel="stopResize"
      @lostpointercapture="stopResize"
      @keydown="resizeWithKeyboard"
    />
    <div
      class="flex items-center gap-1 shrink-0 border-b px-2 py-1.5 min-h-12"
      role="tablist"
      :aria-label="t('sidebarTabs.title')"
    >
      <div class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          role="tab"
          :aria-selected="tab.id === activeId"
          class="group flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs"
          :class="
            tab.id === activeId
              ? 'bg-accent text-accent-foreground font-medium'
              : 'text-muted-foreground hover:bg-accent/50'
          "
          @click="clickTab(tab)"
        >
          <component :is="iconFor(tab.type)" class="size-3.5 shrink-0" />
          <span class="truncate">{{ titleFor(tab) }}</span>
          <X
            class="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
            :title="t('sidebarTabs.closeTab')"
            :aria-label="t('sidebarTabs.closeTab')"
            @click.stop="closeTab(tab.id)"
          />
        </button>
        <Popover v-model:open="addOpen">
          <PopoverTrigger as-child>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              class="shrink-0 text-muted-foreground"
              :title="t('sidebarTabs.add')"
              :aria-label="t('sidebarTabs.add')"
            >
              <Plus />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" class="w-44 p-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="w-full justify-start gap-2"
              @click="addTab('review')"
            >
              <FileCode class="size-4 shrink-0" />{{ t("sidebarTabs.newReview") }}
            </Button>
            <Button type="button" variant="ghost" size="sm" class="w-full justify-start gap-2" @click="addTab('files')">
              <FolderTree class="size-4 shrink-0" />{{ t("sidebarTabs.newFiles") }}
            </Button>
            <Button
              v-if="isDesktop"
              type="button"
              variant="ghost"
              size="sm"
              class="w-full justify-start gap-2"
              @click="addTab('terminal')"
            >
              <SquareTerminal class="size-4 shrink-0" />{{ t("sidebarTabs.newTerminal") }}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="w-full justify-start gap-2"
              @click="addTab('browser')"
            >
              <Globe class="size-4 shrink-0" />{{ t("sidebarTabs.newBrowser") }}
            </Button>
          </PopoverContent>
        </Popover>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        class="shrink-0"
        :aria-label="t('sidebarTabs.toggle')"
        @click="$emit('close')"
        ><PanelRight
      /></Button>
    </div>
    <template v-for="tab in tabs" :key="tab.id">
      <ReviewPanel
        v-if="tab.type === 'review'"
        v-show="tab.id === activeId"
        :changes="changes"
        :project="project"
        :focus="tab.id === activeId ? focus : null"
        :checkpoints="checkpoints" />
      <ProjectFiles v-else-if="tab.type === 'files'" v-show="tab.id === activeId" :project="project" />
      <TerminalPanel
        v-else-if="tab.type === 'terminal' && isDesktop"
        v-show="tab.id === activeId"
        :ref="el => setTerminalPanel(tab.id, el)"
        :project="project"
        :visible="open && tab.id === activeId"
        embedded />
      <BrowserPanel
        v-else-if="tab.type === 'browser'"
        v-show="tab.id === activeId"
        :visible="open && tab.id === activeId"
        @send-to-chat="$emit('send-to-chat', $event)"
    /></template>
    <div v-if="tabs.length === 0" class="grid flex-1 grid-cols-2 content-center gap-3 p-6">
      <Button type="button" variant="outline" size="lg" class="h-auto flex-col gap-2 py-4" @click="addTab('review')">
        <FileCode class="size-6 shrink-0" />{{ t("sidebarTabs.newReview") }}
      </Button>
      <Button type="button" variant="outline" size="lg" class="h-auto flex-col gap-2 py-4" @click="addTab('files')">
        <FolderTree class="size-6 shrink-0" />{{ t("sidebarTabs.newFiles") }}
      </Button>
      <Button
        v-if="isDesktop"
        type="button"
        variant="outline"
        size="lg"
        class="h-auto flex-col gap-2 py-4"
        @click="addTab('terminal')"
      >
        <SquareTerminal class="size-6 shrink-0" />{{ t("sidebarTabs.newTerminal") }}
      </Button>
      <Button type="button" variant="outline" size="lg" class="h-auto flex-col gap-2 py-4" @click="addTab('browser')">
        <Globe class="size-6 shrink-0" />{{ t("sidebarTabs.newBrowser") }}
      </Button>
    </div>
  </aside>
</template>

<style scoped>
.changes-resize-handle::after {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 2px;
  background: transparent;
  transition: background 120ms;
}
.changes-resize-handle:hover::after {
  background: var(--primary);
}
.changes-resize-handle:focus-visible::after {
  background: var(--primary);
}
.changes-resize-handle.is-dragging::after {
  background: var(--primary);
}
</style>
