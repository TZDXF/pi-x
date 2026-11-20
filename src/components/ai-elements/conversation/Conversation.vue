<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { reactiveOmit } from '@vueuse/core'
import { useStickToBottom } from 'vue-stick-to-bottom'
import { nextTick, onMounted, provide, ref, watch, watchEffect } from 'vue'
import { ScrollAreaRoot, ScrollAreaViewport } from 'reka-ui'
import { ScrollBar } from '@/components/ui/scroll-area'
import { pinToBottom } from '@/lib/bottomPin'
import { invalidateReveals, nextFrame, revealElement } from '@/lib/revealScroll'
import { shouldReleaseBottomLock, shouldReleaseBottomLockOnScroll, shouldResumeBottomLock } from '@/lib/scrollIntent'
import { conversationKey } from './context'

interface Props {
  ariaLabel?: string
  class?: HTMLAttributes['class']
  initial?: boolean | 'instant' | { damping?: number, stiffness?: number, mass?: number }
  resize?: 'instant' | { damping?: number, stiffness?: number, mass?: number }
  damping?: number
  stiffness?: number
  mass?: number
  anchor?: 'auto' | 'none'
}

const emit = defineEmits<{ scroll: [event: Event] }>()
/**
 * 定位过程中的抑制计数（TZD-138 P2）：`VirtualMessage` 的行高补偿会直接写 `scrollTop`，
 * 一次写入就会打断平滑滚动。定位期间把计数抬起来，让行高照常量、不写滚动位置；
 * 定位流程自己按最新布局反复校正，直到目标真的进入视口。
 */
const revealLock = ref(0)
/**
 * 把一个元素滚进视口并验证结果（返回是否到位）：先把目标虚拟行重挂出来，再进入
 * “滚 → 等停 → 复核 → 修正”循环。这期间禁止行高补偿写 `scrollTop`。
 */
async function revealInViewport(target: Element | null | undefined, options: { animated?: boolean } = {}) {
  const viewport = scrollRef.value
  if (!viewport || !target || !(target instanceof HTMLElement)) return false
  invalidateReveals(viewport)
  // 定位是"去读历史"的意图：释放底部跟随，否则内容变动会把人拉回底部。
  releaseBottomLock()
  revealLock.value++
  try {
    return await revealElement(viewport, target, { animated: options.animated })
  } finally {
    revealLock.value--
  }
}
defineExpose({
  stopScroll: releaseBottomLock,
  scrollToBottom,
  /** 通用入口：把任意视口内元素滚到视口里（划词引用徽标就用它）。 */
  revealInViewport,
  scrollToMessage: async (id: number) => {
    const viewport = scrollRef.value
    const message = viewport?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
    if (!viewport || !message) return false
    // 先作废旧定位再 await：等待期间旧定位的一轮修正同样不能覆盖这次目标。
    releaseBottomLock()
    revealLock.value++
    try {
      // 虚拟行可能整行卸载，`virtual-reveal` 让它重挂；等一帧布局稳定再量位置。
      message.dispatchEvent(new Event('virtual-reveal'))
      await nextTick()
      await nextFrame()
      if (!message.isConnected) return false
      // 与原有行为一致：目标顶端贴视口顶端（留 24px），长消息也能从开头读起。
      return await revealElement(viewport, message, {
        animated: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        align: 'start',
        margin: 24,
      })
    } finally {
      revealLock.value--
    }
  },
})

const props = withDefaults(defineProps<Props>(), {
  ariaLabel: 'Conversation',
  initial: true,
  damping: 0.7,
  stiffness: 0.05,
  mass: 1.25,
  anchor: 'none',
})
const delegatedProps = reactiveOmit(props, 'class', 'ariaLabel', 'anchor')
const context = useStickToBottom(delegatedProps)
const { scrollRef, contentRef } = context
const viewport = ref<InstanceType<typeof ScrollAreaViewport>>()
let readingHistory = props.initial === false
let lastScrollTop: number | undefined
function releaseBottomLock() {
  readingHistory = true
  context.stopScroll()
}
function scrollToBottom(options?: Parameters<typeof context.scrollToBottom>[0]) {
  readingHistory = false
  return context.scrollToBottom(options)
}
watchEffect(() => { scrollRef.value = viewport.value?.viewportElement ?? null })
watch(() => ({ ...delegatedProps }), options => context.setOptions(options))
// The library clears escapedFromLock when shrinking near the bottom. Keep the
// user's reading intent authoritative so our instant resize pin cannot re-lock.
// Run after its whole resize callback: isAtBottom also includes "near bottom",
// so a synchronous watcher cannot observe the internal at-bottom change.
watch(() => context.escapedFromLock.value, escaped => {
  if (readingHistory && !escaped) context.stopScroll()
})
function handleWheel(event: WheelEvent) {
  const scroll = scrollRef.value
  if (!scroll || event.ctrlKey || event.defaultPrevented || !(event.target instanceof Element)) return
  // Reka uses overflow: hidden scroll, which the library's shorthand overflow
  // check misses. Release before virtual row resizing can pin us back down.
  if (shouldReleaseBottomLock(scroll, event.target, event.deltaY)) releaseBottomLock()
}
function handleScroll(event: Event) {
  const scroll = scrollRef.value
  if (scroll) {
    const previous = lastScrollTop ?? scroll.scrollTop
    lastScrollTop = scroll.scrollTop
    // Scroll events also cover scrollbar dragging and keyboard navigation, but
    // layout shrinkage clamps scrollTop to the new bottom without user intent.
    if (shouldReleaseBottomLockOnScroll(previous, scroll.scrollTop, scroll.scrollHeight - scroll.clientHeight))
      releaseBottomLock()
    else if (shouldResumeBottomLock(
      previous,
      scroll.scrollTop,
      scroll.scrollHeight - scroll.clientHeight,
      readingHistory,
    )) readingHistory = false
  }
  emit('scroll', event)
}
// With resize="instant", pin scrollTop synchronously in the ResizeObserver
// callback (after layout, before paint). The library defers its correction to
// the next animation frame, which paints one frame per streaming chunk with a
// stale scrollTop and makes the scrollbar bounce.
watchEffect((onCleanup) => {
  const scroll = scrollRef.value
  const content = contentRef.value
  if (!scroll || !content || props.resize !== 'instant') return
  // A viewport resize can make the library escape after a layout clamp as well.
  // Follow our reading intent, rather than that incidental library state.
  const pin = () => pinToBottom(scroll, !readingHistory, false)
  const observer = new ResizeObserver(pin)
  observer.observe(content)
  observer.observe(scroll)
  onCleanup(() => observer.disconnect())
})
provide(conversationKey, { ...context, scrollToBottom, stopScroll: releaseBottomLock, revealLock })
onMounted(() => {
  if (props.initial === 'instant' && scrollRef.value)
    scrollRef.value.scrollTop = scrollRef.value.scrollHeight
  lastScrollTop = scrollRef.value?.scrollTop
})
</script>

<template>
  <ScrollAreaRoot :class="cn('relative min-h-0 min-w-0 flex-1 overflow-hidden', props.class)">
    <ScrollAreaViewport ref="viewport" class="size-full [&>div]:!block [&>div]:min-h-full [&>div]:min-w-0"
      :style="{ overflowAnchor: props.anchor }" @scroll="handleScroll" @wheel.passive="handleWheel" role="log" :aria-label="props.ariaLabel" tabindex="0">
      <div :ref="el => { contentRef = el as HTMLElement | null }"><slot /></div>
    </ScrollAreaViewport>
    <ScrollBar />
    <slot name="overlay" />
  </ScrollAreaRoot>
</template>
