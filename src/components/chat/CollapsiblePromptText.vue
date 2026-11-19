<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { ChevronDown, ChevronUp } from "@lucide/vue"
import ComposerText from "@/components/ComposerText.vue"
import { PROMPT_COLLAPSE_LINES, measurePromptClamp, type PromptLineBox } from "@/lib/promptCollapse"

/**
 * 提问气泡的只读正文（TZD-138）：超过 6 个**视觉行**的正文折叠成 6 行高，点击或按钮展开全文。
 *
 * 折叠是**纯展示**：这里只裁高度（`max-height` + `overflow: hidden`，高度按实际视觉行边界
 * 算），`props.text` 原样留在 DOM 与组件数据里，复制、编辑、重发仍拿完整原文（气泡的复制走
 * `visibleText`，编辑走 `usePromptEdit` 的 `visibleContent`，都不经过这里）。
 *
 * 测量用 `Range.getClientRects()`：矩形按竖直方向分组成视觉行（行盒取并集，含 chip 的行
 * 会更高），裁剪到第 6 行的下边界。祖先的 `overflow: hidden` 不影响 `getClientRects()`，
 * 所以裁剪态下仍能量出全部行（这也是"6 行整不折叠、含 chip 的 6 行也不折叠"的前提）。
 */
const props = defineProps<{ text: string; expanded: boolean }>()
const emit = defineEmits<{ toggle: [] }>()
const { t } = useI18n()

const wrap = ref<HTMLElement>()
const body = ref<HTMLElement>()
/** 正文占多少个视觉行（量不到时为 0）。 */
const lineCount = ref(0)
/** 折叠态保留的高度（px，相对正文顶端）；0 表示不需要裁剪。 */
const clampHeight = ref(0)
let observer: ResizeObserver | undefined
let disposed = false
const collapsed = computed(() => !props.expanded)
/** 有溢出才折叠；`lineCount <= 6` 时任何情况都不裁、不给按钮。 */
const overflowing = computed(() => lineCount.value > PROMPT_COLLAPSE_LINES)
const clampStyle = computed(() =>
  collapsed.value && clampHeight.value > 0 ? { maxHeight: `${clampHeight.value}px` } : undefined,
)

/**
 * 正文的视觉行矩形，坐标已换算到**正文内容顶端**（`max-height` 的起点）：盒子自身没有
 * 边框，`padding` 也由内部 `ComposerText` 承担，所以 `rect.top` 就是内容原点。裁剪后的
 * `rect.height` 是可见高度，但 `getClientRects()` 仍列出被裁掉的行（实测），因此可以在
 * 裁剪态下继续测量。
 */
function rectOf(element: HTMLElement): PromptLineBox[] {
  const origin = element.getBoundingClientRect().top + element.clientTop
  const range = document.createRange()
  range.selectNodeContents(element)
  return Array.from(range.getClientRects()).map(rect => ({ top: rect.top - origin, bottom: rect.bottom - origin }))
}

/**
 * 量一次：视觉行数 + 折叠裁剪高度。宽度变化（窗口、侧栏 Tab）会改变自动折行，行内容变化
 * （chip 行更高）会改变行盒，因此靠 `ResizeObserver` 观察外层重测（折叠态自身高度被钉死，
 * 量不出内部变化），另外在文本/展开态变化与字体就绪后各补一次。
 */
function measure() {
  const element = body.value
  if (!element) return
  const next = measurePromptClamp(rectOf(element), PROMPT_COLLAPSE_LINES)
  // 只在真的变了才写：裁剪会改变容器高度并触发 ResizeObserver 回调，值不变时就此收敛。
  if (next.lineCount !== lineCount.value) lineCount.value = next.lineCount
  if (next.clampHeight !== clampHeight.value) clampHeight.value = next.clampHeight
}
/** 点击正文展开时必须让"正在选中的文字"优先：选区非空说明用户在划词引用，不切换。 */
function onBodyClick() {
  if (!collapsed.value || !overflowing.value) return
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
watch(
  () => props.expanded,
  async () => {
    // 展开/收起都改变布局（是否裁剪），重测一次让行数与阈值保持新鲜。
    await nextTick()
    measure()
  },
)
onMounted(() => {
  measure()
  observer = new ResizeObserver(() => measure())
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
      :data-prompt-lines="lineCount"
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
