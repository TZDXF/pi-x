<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { clampReviewWidth, reviewWidthBounds } from "@/lib/reviewWidth"
import { useI18n } from "vue-i18n"
import { FileCode, FolderTree, Globe, Plus, SquareTerminal, X } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs"
import SidebarTabTrigger from "@/components/SidebarTabTrigger.vue"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { VueDraggable } from "vue-draggable-plus"
import ReviewPanel from "@/components/ReviewPanel.vue"
import ProjectFiles from "@/components/ProjectFiles.vue"
import TerminalPanel from "@/components/terminal/TerminalPanel.vue"
import BrowserPanel from "@/components/browser/BrowserPanel.vue"
import { isRemoteProject } from "@/lib/ssh"
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
  checkpoints?: TurnCheckpointRecord[]
}>()
const emit = defineEmits<{
  close: []
  "update:activeId": [id: number | null]
  "add-tab": [type: SidebarTabType]
  "close-tab": [id: number]
  "reorder-tabs": [tabs: SidebarTabItem[]]
  "send-to-chat": [text: string]
}>()

const { t } = useI18n()
const addOpen = ref(false)
// 远程项目不支持本地文件浏览（契约 §5）；终端自 P2 起经 ssh -tt 开放（契约 §3.4）。
const filesAvailable = computed(() => !isRemoteProject(props.project))
function iconFor(type: SidebarTabType) {
  return type === "review" ? FileCode : type === "files" ? FolderTree : type === "browser" ? Globe : SquareTerminal
}
function titleFor(tab: SidebarTabItem): string {
  const base = t(`sidebarTabs.${tab.type}`)
  const sameType = props.tabs.filter(item => item.type === tab.type)
  if (sameType.length > 1) return `${base} ${sameType.findIndex(item => item.id === tab.id) + 1}`
  return base
}
function addTab(type: SidebarTabType) {
  addOpen.value = false
  emit("add-tab", type)
}
async function closeTab(id: number, event: MouseEvent) {
  const restoreFocus = document.activeElement === event.currentTarget
  emit("close-tab", id)
  if (restoreFocus) {
    await nextTick()
    const target =
      sidebar.value?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
      sidebar.value?.querySelector<HTMLElement>("[data-sidebar-add]")
    target?.focus()
  }
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
function reactivateTab(tab: SidebarTabItem) {
  // 已激活的终端 tab 再点一次时，若面板里没有 shell 则直接新建，避免停留在空状态。
  if (tab.type === "terminal") {
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
/**
 * 仅在开关切换后短暂开启宽度过渡；拖拽调整与窗口缩放时的宽度变化保持即时，
 * 避免面板跟随迟滞。时长略大于 CSS 过渡（200ms）。
 */
const animating = ref(false)
let animationTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => props.open,
  () => {
    animating.value = true
    clearTimeout(animationTimer)
    animationTimer = setTimeout(() => {
      animating.value = false
    }, 240)
  },
)
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
  clearTimeout(animationTimer)
  observer?.disconnect()
  window.removeEventListener("resize", measure)
  window.removeEventListener("blur", stopResize)
})
</script>

<template>
  <Tabs
    as-child
    class="gap-0"
    :model-value="activeId ?? ''"
    activation-mode="automatic"
    @update:model-value="value => emit('update:activeId', Number(value))"
  >
    <aside
      ref="sidebar"
      class="changes-sidebar gap-0 relative shrink-0 flex flex-col w-[clamp(300px,_36%,_640px)] min-h-0 overflow-hidden border-l border-border bg-background max-[900px]:absolute max-[900px]:[inset:0_0_0_auto] max-[900px]:w-[min(100%,_480px)] max-[900px]:z-[30] max-[900px]:shadow-[-8px_0_24px_#0002]"
      :class="{ 'is-animating': animating, 'is-dragging': dragging, 'is-closed': !open }"
      :style="{ width: open ? `${width}px` : '0px' }"
      :inert="!open"
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
      <!-- 内层保持展开时的固定宽度，收起动画中内容只被裁剪而不被压缩。 -->
      <div class="flex min-h-0 flex-1 flex-col min-w-0" :style="{ width: `${width}px` }">
        <div class="bg-background/95 flex h-12 shrink-0 items-center gap-1 border-b px-2">
          <TabsList as-child :loop="true" class="h-auto min-w-0 flex-1 justify-start bg-transparent p-0">
            <div :aria-label="t('sidebarTabs.title')">
              <VueDraggable
                tag="div"
                class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-clip"
                :model-value="tabs"
                :animation="150"
                filter=".sidebar-tab-close"
                :prevent-on-filter="false"
                @update:model-value="(next: SidebarTabItem[]) => emit('reorder-tabs', next)"
              >
                <div
                  v-for="tab in tabs"
                  :key="tab.id"
                  class="group flex h-7 shrink-0 cursor-grab select-none items-center gap-1.5 rounded-md px-2.5"
                  :class="tab.id === activeId ? 'bg-accent' : 'hover:bg-accent/50'"
                >
                  <SidebarTabTrigger
                    :value="tab.id"
                    :active="tab.id === activeId"
                    class="h-full min-w-0 flex-none cursor-grab select-none border-transparent bg-transparent px-0 text-xs font-normal text-muted-foreground shadow-none after:hidden hover:text-muted-foreground data-active:border-transparent data-active:bg-transparent data-active:font-medium data-active:text-accent-foreground data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent dark:data-active:font-medium dark:data-active:text-accent-foreground group-data-[variant=default]/tabs-list:data-active:shadow-none"
                    @reactivate="reactivateTab(tab)"
                  >
                    <component :is="iconFor(tab.type)" class="size-3.5 shrink-0" aria-hidden="true" />
                    <span class="truncate">{{ titleFor(tab) }}</span>
                  </SidebarTabTrigger>
                  <button
                    type="button"
                    class="sidebar-tab-close flex h-full items-center opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
                    :class="tab.id === activeId ? 'text-accent-foreground' : 'text-muted-foreground'"
                    :title="t('sidebarTabs.closeTab')"
                    :aria-label="`${t('sidebarTabs.closeTab')}: ${titleFor(tab)}`"
                    @click.stop="closeTab(tab.id, $event)"
                  >
                    <X class="size-3 shrink-0" aria-hidden="true" />
                  </button>
                </div>
              </VueDraggable>
            </div>
          </TabsList>
          <Popover v-model:open="addOpen">
            <PopoverTrigger as-child>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                class="shrink-0 text-muted-foreground"
                data-sidebar-add
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
              <Button
                v-if="filesAvailable"
                type="button"
                variant="ghost"
                size="sm"
                class="w-full justify-start gap-2"
                @click="addTab('files')"
              >
                <FolderTree class="size-4 shrink-0" />{{ t("sidebarTabs.newFiles") }}
              </Button>
              <Button
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
        <TabsContent
          v-for="tab in tabs"
          :key="tab.id"
          :value="tab.id"
          force-mount
          :hidden="tab.id !== activeId"
          v-show="tab.id === activeId"
          class="flex min-h-0 flex-col"
        >
          <ReviewPanel
            v-if="tab.type === 'review'"
            :changes="changes"
            :project="project"
            :focus="tab.id === activeId ? focus : null"
            :checkpoints="checkpoints"
          />
          <ProjectFiles v-else-if="tab.type === 'files'" :project="project" />
          <TerminalPanel
            v-else-if="tab.type === 'terminal'"
            :ref="el => setTerminalPanel(tab.id, el)"
            :project="project"
            :visible="open && tab.id === activeId"
            embedded
          />
          <BrowserPanel
            v-else-if="tab.type === 'browser'"
            :visible="open && tab.id === activeId"
            @send-to-chat="$emit('send-to-chat', $event)"
          />
        </TabsContent>
        <div v-if="tabs.length === 0" class="grid flex-1 grid-cols-2 content-center gap-3 p-6">
          <Button
            type="button"
            variant="outline"
            size="lg"
            class="h-auto flex-col gap-2 py-4"
            @click="addTab('review')"
          >
            <FileCode class="size-6 shrink-0" />{{ t("sidebarTabs.newReview") }}
          </Button>
          <Button
            v-if="filesAvailable"
            type="button"
            variant="outline"
            size="lg"
            class="h-auto flex-col gap-2 py-4"
            @click="addTab('files')"
          >
            <FolderTree class="size-6 shrink-0" />{{ t("sidebarTabs.newFiles") }}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            class="h-auto flex-col gap-2 py-4"
            @click="addTab('terminal')"
          >
            <SquareTerminal class="size-6 shrink-0" />{{ t("sidebarTabs.newTerminal") }}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            class="h-auto flex-col gap-2 py-4"
            @click="addTab('browser')"
          >
            <Globe class="size-6 shrink-0" />{{ t("sidebarTabs.newBrowser") }}
          </Button>
        </div>
      </div>
    </aside>
  </Tabs>
</template>

<style scoped>
/* 开关时宽度过渡收起/展开；visibility 过渡让隐藏延迟到收起动画结束后生效、展开立即生效。
   仅在开关切换后短暂开启宽度过渡（is-animating），拖拽与窗口缩放保持即时。 */
.changes-sidebar {
  transition: visibility 200ms ease-out;
}
.changes-sidebar.is-animating {
  transition:
    width 200ms ease-out,
    visibility 200ms ease-out;
}
.changes-sidebar.is-closed {
  visibility: hidden;
}
.changes-sidebar.is-dragging {
  transition: none;
}
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
