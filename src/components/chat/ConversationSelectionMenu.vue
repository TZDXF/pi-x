<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { TextQuote } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { captureOffsets, selectionEndRect } from "@/lib/selectionAnchors"
import type { ConversationSelectionSource } from "@/lib/conversationSelections"

/**
 * 对话划词浮动菜单（对齐 ZCode 的 MarkdownSelectionTooltip + SelectionActionMenu）：
 * 选区两端落在同一消息正文内时，在划词结束处显示"引用到输入框"按钮。
 * 点击后捕获选区文本、字符区间与锚点位置，交给父层打开批注弹窗。
 */
const props = defineProps<{
  /** 划词检测范围：整个会话滚动容器。 */
  root: HTMLElement | null
  /** 选区最大长度，超长时按钮置灰（与追加限制一致）。 */
  maxTextLength: number
}>()
const emit = defineEmits<{
  quote: [
    payload: {
      text: string
      source: ConversationSelectionSource
      messageId: number
      startOffset: number
      endOffset: number
    },
  ]
}>()
const { t } = useI18n()

const state = ref<{ text: string; anchor: { left: number; top: number; bottom: number } } | null>(null)
const tooLong = computed(() => (state.value?.text.length ?? 0) > props.maxTextLength)

// 选区锚点所在元素节点；用 nodeType 判断而非 instanceof，便于测试环境桩对象。
function anchorElement(node: Node | null) {
  return node?.nodeType === 1 ? (node as Element) : node?.parentElement
}
// 按钮、链接、输入框等界面元素里的选区不作为对话引用（对齐 ZCode conversationSelectionGuard）。
function isExcludedEndpoint(node: Node | null) {
  const element = anchorElement(node)
  if (!element) return true
  return !!element.closest(
    "button, a, textarea, input, select, sup[data-selection-anchor], [contenteditable], [data-no-selection]",
  )
}

function inspectSelection() {
  const root = props.root
  const selection = window.getSelection()
  if (!root || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  if (isExcludedEndpoint(range.startContainer) || isExcludedEndpoint(range.endContainer)) return null
  // 选区必须完整落在同一条消息正文内，才能记录可靠的定位区间。
  const sourceElement = anchorElement(range.startContainer)?.closest("[data-selection-source]")
  if (!sourceElement || sourceElement !== anchorElement(range.endContainer)?.closest("[data-selection-source]"))
    return null
  const source = sourceElement.getAttribute("data-selection-source")
  if (source !== "user" && source !== "assistant") return null
  const message = sourceElement.closest("[data-message-id]")
  const messageId = Number(message?.getAttribute("data-message-id"))
  if (!Number.isFinite(messageId)) return null
  const offsets = captureOffsets(sourceElement, range)
  if (!offsets) return null
  const text = selection.toString().trim()
  if (!text) return null
  // 浮层锚定在划词结束处（多行选区取最后一行的行尾）。
  const endRect = selectionEndRect(range)
  if (!endRect) return null
  return {
    text,
    source: source as ConversationSelectionSource,
    messageId,
    startOffset: offsets.start,
    endOffset: offsets.end,
    anchor: { left: endRect.right, top: endRect.top, bottom: endRect.bottom },
  }
}

function clearState() {
  state.value = null
}
function onSelectionChange() {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) clearState()
}
function onMouseUp() {
  // 松手才显示菜单，避免拖拽过程中闪烁；无效选区收起。
  const inspected = inspectSelection()
  if (inspected) state.value = { text: inspected.text, anchor: inspected.anchor }
  else clearState()
}
// 键盘选区（Shift+方向键）没有 mouseup；keyup 时若已有非塌陷选区则显示。
function onKeyUp(event: KeyboardEvent) {
  if (!event.shiftKey && event.key !== "Shift") return
  const inspected = inspectSelection()
  if (inspected) state.value = { text: inspected.text, anchor: inspected.anchor }
}
function onScroll() {
  // 滚动后选区矩形已失准，直接收起。
  clearState()
}
// mousedown.prevent 防止点击菜单时选区被清掉导致菜单先消失。
function quoteSelection() {
  const current = state.value
  if (!current || tooLong.value) return
  const inspected = inspectSelection()
  if (!inspected) {
    clearState()
    return
  }
  clearState()
  const { text, source, messageId, startOffset, endOffset } = inspected
  emit("quote", { text, source, messageId, startOffset, endOffset })
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

// 按钮贴在划词结束处：默认在末行行尾下方，空间不足翻到上方。
const placement = computed(() => {
  if (!state.value) return null
  const anchor = state.value.anchor
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 168))
  const flip = window.innerHeight - anchor.bottom < 48
  return {
    left: `${left}px`,
    ...(flip ? { bottom: `${window.innerHeight - anchor.top + 4}px` } : { top: `${anchor.bottom + 4}px` }),
  }
})
</script>

<template>
  <div v-if="state && placement" class="fixed z-50" :style="placement">
    <Button
      type="button"
      variant="ghost"
      size="sm"
      class="h-7 gap-1.5 border bg-background text-xs shadow-sm"
      :disabled="tooLong"
      :title="tooLong ? t('chat.selectionLimitSingle') : undefined"
      @mousedown.prevent
      @click="quoteSelection"
    >
      <TextQuote class="size-3.5" />
      {{ t("chat.selectionAdd") }}
    </Button>
  </div>
</template>
