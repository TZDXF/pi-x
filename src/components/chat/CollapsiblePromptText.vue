<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { ChevronDown, ChevronUp } from "@lucide/vue"
import ComposerText from "@/components/ComposerText.vue"
import {
  PROMPT_COLLAPSE_LINES,
  promptClampHeight,
  promptClampMaxHeight,
  shouldCollapsePrompt,
} from "@/lib/promptCollapse"

/**
 * 提问气泡的只读正文（TZD-138）：超过 6 行的正文折叠成 6 行高，点击或按钮展开全文。
 *
 * 折叠是**纯展示**：这里只裁高度（`max-height: calc(6 * 1lh)` + `overflow: hidden`），
 * `props.text` 原样留在 DOM 与组件数据里，复制、编辑、重发仍拿完整原文（气泡的复制走
 * `visibleText`，编辑走 `usePromptEdit` 的 `visibleContent`，都不经过这里）。
 */
const props = defineProps<{ text: string; expanded: boolean }>()
const emit = defineEmits<{ toggle: [] }>()
const { t } = useI18n()

const wrap = ref<HTMLElement>()
const body = ref<HTMLElement>()
/** 折叠态是否裁高度；正文不足 6 行时不必裁，也不必给按钮。 */
const overflowing = ref(false)
/** 实测行高（px）：量不到时为 0，此时样式退回 CSS 的 `1lh` 表达式。 */
const lineHeight = ref(0)
let observer: ResizeObserver | undefined
let disposed = false
const collapsed = computed(() => !props.expanded)
/**
 * 高度上限：已量到行高就用像素（平台不支持 `lh` 单位时也照样能裁），首帧与量不到
 * 行高时退回 `calc(6 * 1lh)`，行高变化仍由 CSS 自己跟上。
 */
const clampStyle = computed(() => {
  if (!collapsed.value) return undefined
  const px = promptClampHeight(lineHeight.value, PROMPT_COLLAPSE_LINES)
  return { maxHeight: px > 0 ? `${px}px` : promptClampMaxHeight(PROMPT_COLLAPSE_LINES) }
})

/**
 * 量一次是否超过阈值：行高取自计算样式，内容全高取自 `scrollHeight`（`max-height` +
 * `overflow: hidden` 下它仍是内容高度，所以裁剪与测量可以同时成立）。宽度变化（窗口、
 * 侧栏 Tab 宽度）会改变自动折行，因此靠 `ResizeObserver` 观察外层宽度重测，而不是
 * 只量一次（裁剪后容器自身高度不变，量不出折行变化）。
 */
function measure() {
  const el = body.value
  if (!el) return
  const measured = Number.parseFloat(getComputedStyle(el).lineHeight)
  const px = Number.isFinite(measured) && measured > 0 ? measured : 0
  // 只在真的变了才写：裁剪会改变容器高度，`ResizeObserver` 会回调回来，值不变时就此收敛。
  if (px !== lineHeight.value) lineHeight.value = px
  // 首选按行高判：展开态下没有裁剪，`clientHeight` 等于内容高度，判不出溢出。
  // 行高解析不出来时（`line-height: normal`）退回"内容高 vs 可见高"—— 只在折叠态成立，
  // 但它至少给了按钮，不会把正文裁掉却没有任何入口。
  const next =
    lineHeight.value > 0
      ? shouldCollapsePrompt(el.scrollHeight, lineHeight.value, PROMPT_COLLAPSE_LINES)
      : collapsed.value && el.scrollHeight - el.clientHeight > 0.5
  if (next !== overflowing.value) overflowing.value = next
}
/** 点击正文展开时必须让"正在选中的文字"优先：选区非空说明用户在划词引用，不切换。 */
function onBodyClick() {
  if (props.expanded || !overflowing.value) return
  const selection = window.getSelection()
  if (selection && !selection.isCollapsed) return
  emit("toggle")
}
watch(
  () => props.text,
  async () => {
    await nextTick()
    measure()
  },
)
onMounted(() => {
  measure()
  observer = new ResizeObserver(() => measure())
  // 观察外层宽度而不是被裁剪的正文：折叠态容器高度被钉死，宽度变化（窗口/侧栏 Tab）
  // 只会改自动折行后的**内容**高度，这里用宽度触发重测。
  if (wrap.value) observer.observe(wrap.value)
  // 字体加载完成前后行高与折行都会变，加载后再量一次（不支持 FontFace 的环境跳过）。
  void document.fonts?.ready.then(() => {
    if (!disposed) measure()
  })
})
onBeforeUnmount(() => {
  disposed = true
  observer?.disconnect()
})
</script>

<template>
  <div ref="wrap" class="min-w-0" data-prompt-text-wrap>
    <div
      ref="body"
      class="min-w-0 overflow-hidden"
      :class="{ 'cursor-pointer': collapsed && overflowing }"
      :style="clampStyle"
      data-prompt-text
      :data-prompt-collapsed="collapsed && overflowing ? 'true' : 'false'"
      @click="onBodyClick"
    >
      <ComposerText :text="text" />
    </div>
    <!-- 折叠/展开按钮：折叠时是唯一的发现入口，展开后用于收回去。 -->
    <button
      v-if="overflowing"
      type="button"
      data-prompt-toggle
      class="text-muted-foreground hover:text-foreground focus-visible:outline-ring mt-1 flex items-center gap-1 rounded text-xs transition-colors"
      :aria-expanded="expanded"
      @click="emit('toggle')"
    >
      <ChevronDown v-if="!expanded" class="size-3.5 shrink-0" aria-hidden="true" />
      <ChevronUp v-else class="size-3.5 shrink-0" aria-hidden="true" />
      {{ expanded ? t("chat.collapsePrompt") : t("chat.expandPrompt") }}
    </button>
  </div>
</template>
