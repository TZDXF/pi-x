<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { MessageSquarePlus, TextQuote } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { captureOffsets, selectionEndRect } from "@/lib/selectionAnchors"
import { menuPlacement, type MenuPlacement } from "@/lib/selectionMenuPlacement"
import { selectionLineRange } from "@/lib/codeComments"
import type { AuxAskPayload } from "@/lib/auxSelection"
import type { ConversationSelectionSource } from "@/lib/conversationSelections"

/**
 * 划词浮动菜单（对齐 ZCode 的 MarkdownSelectionTooltip + SelectionActionMenu）。
 *
 * 两个挂载点共用**同一份**定位/翻转/钳制算法与同一组 document 级监听（TZD-103
 * 只加动作，不改算法）：
 *
 * - `mode="chat"`（默认，会话正文）：选区两端落在同一条消息正文内时，在划词结束处
 *   显示"引用到输入框"与"在辅助对话中提问"；后者是 TZD-103 新增的动作。
 * - `mode="code"`（文件预览：代码视图 / Markdown 渲染态，第二个入口）：选区两端落在
 *   同一文件内时只显示"在辅助对话中提问"，payload 带 `path` 与行区间；渲染态
 *   Markdown 没有 `[data-line]`，此时只带 `path`（不猜行号）。
 *
 * 手势语义与排除规则不变：松手才显示；`scroll` 收起；`selectionchange` 塌陷收起；
 * 控件内选区（`button/a/textarea/input/select/contenteditable/...`）不作为引用来源。
 */
const props = withDefaults(
  defineProps<{
    /** 划词检测范围：会话正文时是整个会话滚动容器，代码模式下是代码滚动容器。 */
    root: HTMLElement | null
    /** 选区最大长度，超长时动作置灰（与追加限制一致）。 */
    maxTextLength: number
    /** `chat` 在会话正文上；`code` 在文件预览（代码 / Markdown）上。 */
    mode?: "chat" | "code"
    /** `code` 模式下引用的文件路径（相对会话目录），随引用发给 agent。 */
    path?: string
  }>(),
  { mode: "chat" },
)
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
  /** 在辅助对话中提问（TZD-103）：两种模式共用同一个 payload 形状。 */
  auxAsk: [payload: AuxAskPayload]
}>()
const { t } = useI18n()

const state = ref<{
  text: string
  anchor: { left: number; top: number; bottom: number }
  payload: AuxAskPayload
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
  return !!element.closest(
    "button, a, textarea, input, select, sup[data-selection-anchor], [contenteditable], [data-no-selection]",
  )
}

/** 会话正文模式：同一条消息正文内的选区 → 消息 id + 字符区间（既有行为，未改）。 */
function inspectChatSelection(range: Range, text: string): AuxAskPayload | null {
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
  return {
    text,
    source: source as ConversationSelectionSource,
    messageId,
    startOffset: offsets.start,
    endOffset: offsets.end,
  }
}

/** 代码/预览模式：同一文件内的选区 → `path` +（可得的）行区间。 */
function inspectCodeSelection(root: HTMLElement, text: string): AuxAskPayload | null {
  const path = props.path?.trim()
  if (!path) return null
  // 行区间靠 `selectionLineRange`（与代码批注同源）：两端都得落在本容器内的 [data-line]。
  const lineRange = selectionLineRange(root, window.getSelection())
  return { text, path, ...(lineRange ? { lineRange } : {}) }
}

function inspectSelection() {
  const root = props.root
  const selection = window.getSelection()
  if (!root || !selection || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  if (isExcludedEndpoint(range.startContainer) || isExcludedEndpoint(range.endContainer)) return null
  const text = selection.toString().trim()
  if (!text) return null
  const payload = props.mode === "code" ? inspectCodeSelection(root, text) : inspectChatSelection(range, text)
  if (!payload) return null
  // 浮层锚定在划词结束处（多行选区取最后一行的行尾）。
  const endRect = selectionEndRect(range)
  if (!endRect) return null
  return { payload, anchor: { left: endRect.right, top: endRect.top, bottom: endRect.bottom } }
}

function clearState() {
  state.value = null
}
function showSelection() {
  const inspected = inspectSelection()
  if (inspected) state.value = { text: inspected.payload.text, anchor: inspected.anchor, payload: inspected.payload }
  else clearState()
}
function onSelectionChange() {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) clearState()
}
function onMouseUp() {
  // 松手才显示菜单，避免拖拽过程中闪烁；无效选区收起。
  showSelection()
}
// 键盘选区（Shift+方向键）没有 mouseup；keyup 时若已有非塌陷选区则显示。
function onKeyUp(event: KeyboardEvent) {
  if (!event.shiftKey && event.key !== "Shift") return
  showSelection()
}
function onScroll() {
  // 滚动后选区矩形已失准，直接收起。
  clearState()
}
// mousedown.prevent 防止点击菜单时选区被清掉导致菜单先消失。
// 两个动作都要在收起前**复核一次选区**：DOM 可能已被流式更新改写，此时不 emit。
function takePayload(): AuxAskPayload | null {
  const current = state.value
  if (!current || tooLong.value) return null
  const inspected = inspectSelection()
  clearState()
  return inspected?.payload ?? null
}
function quoteSelection() {
  const payload = takePayload()
  if (!payload) return
  const { text, source, messageId, startOffset, endOffset } = payload
  if (source === undefined || messageId === undefined || startOffset === undefined || endOffset === undefined) return
  emit("quote", { text, source, messageId, startOffset, endOffset })
}
function askInAux() {
  const payload = takePayload()
  if (payload) emit("auxAsk", payload)
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

/**
 * 浮层的实测宽度（横向钳制用）。
 *
 * 为什么不再写死 168：chat 模式有两个横排按钮（"引用到输入框" + "在辅助对话中提问"），
 * 真实宽度远超 168，1280px 视口右缘划词会把按钮推出视口（TZD-103 P2-1）。这里先给
 * 一个保守估计值，`nextTick` 后按 `offsetWidth` 实测覆盖；钳制/翻转规则本身没变
 * （见 `lib/selectionMenuPlacement.ts`）。
 */
const menuBox = ref<HTMLElement | null>(null)
const measuredWidth = ref(0)
const estimatedWidth = computed(() => (props.mode === "code" ? 148 : 262))
async function measureWidth() {
  await nextTick()
  const width = menuBox.value?.offsetWidth ?? 0
  if (width > 0 && width !== measuredWidth.value) measuredWidth.value = width
}
watch(
  () => state.value,
  shown => (shown ? void measureWidth() : (measuredWidth.value = 0)),
  { immediate: true },
)

// 按钮贴在划词结束处：默认在末行行尾下方，空间不足翻到上方（规则未改，只换宽度来源）。
const placement = computed<MenuPlacement | null>(() => {
  if (!state.value) return null
  return menuPlacement(
    state.value.anchor,
    { width: window.innerWidth, height: window.innerHeight },
    measuredWidth.value || estimatedWidth.value,
  )
})
</script>

<template>
  <div ref="menuBox" v-if="state && placement" class="fixed z-50 max-w-[calc(100vw-16px)]" :style="placement">
    <div class="flex items-center gap-1">
      <!-- 会话正文模式保留原动作；代码模式下"引用到输入框"仍是行号栏批注，不在这里重复。 -->
      <Button
        v-if="mode === 'chat'"
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
      <Button
        type="button"
        variant="ghost"
        size="sm"
        class="h-7 gap-1.5 border bg-background text-xs shadow-sm"
        :disabled="tooLong"
        :title="tooLong ? t('chat.selectionLimitSingle') : t('chat.selectionAskAux')"
        @mousedown.prevent
        @click="askInAux"
      >
        <MessageSquarePlus class="size-3.5" />
        {{ t("chat.selectionAskAux") }}
      </Button>
    </div>
  </div>
</template>
