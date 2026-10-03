<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { TextQuote } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import type { ConversationSelectionSource } from "@/lib/conversationSelections"

/**
 * 对话划词浮动菜单（对齐 ZCode 的 MarkdownSelectionTooltip + SelectionActionMenu）：
 * 选区两端都落在 root 内的消息正文上时，在选区旁显示"引用到输入框"。
 * 点击后清空选区并向上抛出引用；超限/重复等结果由父层处理。
 */
const props = defineProps<{
  /** 划词检测范围：整个会话滚动容器。 */
  root: HTMLElement | null
  /** 选区最大长度，超长时按钮置灰（与追加限制一致）。 */
  maxTextLength: number
}>()
const emit = defineEmits<{ add: [selection: { text: string; source: ConversationSelectionSource }] }>()
const { t } = useI18n()

const state = ref<{
  text: string
  source: ConversationSelectionSource
  top: number
  bottom: number
  center: number
} | null>(null)
const tooLong = computed(() => (state.value?.text.length ?? 0) > props.maxTextLength)

// 选区锚点所在元素节点；用 nodeType 判断而非 instanceof，便于测试环境桩对象。
function anchorElement(node: Node | null) {
  return node?.nodeType === 1 ? (node as Element) : node?.parentElement
}
// 按钮、链接、输入框等界面元素里的选区不作为对话引用（对齐 ZCode conversationSelectionGuard）。
function isExcludedEndpoint(node: Node | null) {
  const element = anchorElement(node)
  if (!element) return true
  return !!element.closest("button, a, textarea, input, select, [contenteditable], [data-no-selection]")
}

function inspectSelection() {
  const root = props.root
  const selection = window.getSelection()
  if (!root || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  if (isExcludedEndpoint(range.startContainer) || isExcludedEndpoint(range.endContainer)) return null
  // 选区跨消息时退回起点所在消息的类型，正文按选区原样引用。
  const sourceElement = anchorElement(range.startContainer)?.closest("[data-selection-source]")
  const source = sourceElement?.getAttribute("data-selection-source")
  if (source !== "user" && source !== "assistant") return null
  const text = selection.toString().trim()
  if (!text) return null
  const rect = range.getBoundingClientRect()
  if (!rect.width && !rect.height) return null
  return {
    text,
    source: source as ConversationSelectionSource,
    top: rect.top,
    bottom: rect.bottom,
    center: rect.left + rect.width / 2,
  }
}

function updateFromSelection() {
  const inspected = inspectSelection()
  if (inspected) state.value = inspected
}
function clearState() {
  state.value = null
}
function onSelectionChange() {
  // 选区塌陷（含点击输入框等）即收起；拖拽过程中由 mouseup 统一刷新。
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) clearState()
}
function onMouseUp() {
  // 松手才显示菜单，避免拖拽过程中闪烁；无效选区收起。
  const inspected = inspectSelection()
  if (inspected) state.value = inspected
  else clearState()
}
// 键盘选区（Shift+方向键）没有 mouseup；keyup 时若已有非塌陷选区则显示。
function onKeyUp(event: KeyboardEvent) {
  if (!event.shiftKey && event.key !== "Shift") return
  updateFromSelection()
}
function onScroll() {
  // 滚动后选区矩形已失准，直接收起。
  clearState()
}
// mousedown.prevent 防止点击菜单时选区被清掉导致菜单先消失。
function addSelection() {
  const current = state.value
  if (!current || tooLong.value) return
  window.getSelection()?.removeAllRanges()
  clearState()
  emit("add", { text: current.text, source: current.source })
}

document.addEventListener("selectionchange", onSelectionChange)
document.addEventListener("mouseup", onMouseUp)
document.addEventListener("keyup", onKeyUp)
document.addEventListener("scroll", onScroll, true)
watch(
  () => props.root,
  () => clearState(),
)
onBeforeUnmount(() => {
  document.removeEventListener("selectionchange", onSelectionChange)
  document.removeEventListener("mouseup", onMouseUp)
  document.removeEventListener("keyup", onKeyUp)
  document.removeEventListener("scroll", onScroll, true)
})

// 选区上方放不下时翻到下方（对齐 ZCode SelectionActionMenu 的上/下两档）。
const placement = computed(() => {
  if (!state.value) return null
  const flip = state.value.top < 72
  return {
    left: `${Math.max(48, Math.min(state.value.center, window.innerWidth - 48))}px`,
    ...(flip ? { top: `${state.value.bottom + 6}px` } : { bottom: `${window.innerHeight - state.value.top + 6}px` }),
  }
})
</script>

<template>
  <div v-if="state && placement" class="fixed z-50" :style="placement">
    <div class="-translate-x-1/2 rounded-lg border bg-background p-1 shadow-md" @mousedown.prevent>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        class="h-7 gap-1.5 text-xs"
        :disabled="tooLong"
        :title="tooLong ? t('chat.selectionLimitSingle') : undefined"
        @click="addSelection"
      >
        <TextQuote class="size-3.5" />
        {{ t("chat.selectionAdd") }}
      </Button>
    </div>
  </div>
</template>
