<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { reactiveOmit } from '@vueuse/core'
import { useStickToBottom } from 'vue-stick-to-bottom'
import { nextTick, onMounted, provide, ref, watch, watchEffect } from 'vue'
import { ScrollAreaRoot, ScrollAreaViewport } from 'reka-ui'
import { ScrollBar } from '@/components/ui/scroll-area'
import { pinToBottom } from '@/lib/bottomPin'
import { beginReveal, nextFrame, revealElement, type RevealRequest } from '@/lib/revealScroll'
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
 * 在**发起定位的那一刻**为该视口取得请求身份（TZD-138 P2 跨入口竞态）。
 *
 * 重挂虚拟行、展开折叠正文、重算锚点都是 `await`：如果等到真正滚动时才领身份，
 * "先发起、后恢复"的旧请求会被当成最新，把用户后来点的目标顶掉（QA 三内核复现）。
 * 所以调用方一进入定位就 `beginReveal(viewport)`，并把同一个身份贯穿到最终滚动。
 */
function beginRequest(): { viewport: HTMLElement; request: RevealRequest } | null {
  const viewport = scrollRef.value
  if (!viewport) return null
  return { viewport, request: beginReveal(viewport) }
}
/** 定位期间抑制行高补偿的写入（`VirtualMessage` 通过 context 读这个计数）。 */
async function withRevealLock<T>(run: () => Promise<T>): Promise<T> {
  revealLock.value++
  try {
    return await run()
  } finally {
    revealLock.value--
  }
}
/**
 * 把一个元素滚进视口并验证结果（返回是否到位）：沿用调用方给的请求身份（没有则在此取得），
 * 期间禁止行高补偿写 `scrollTop`。
 */
async function revealInViewport(
  target: Element | null | undefined,
  options: { animated?: boolean; request?: RevealRequest } = {},
) {
  const element = target
  if (!element || !(element instanceof HTMLElement)) return false
  const started = options.request ? { viewport: scrollRef.value, request: options.request } : beginRequest()
  if (!started?.viewport) return false
  // 已被更新的定位顶替：直接终止，不再动滚动位置。
  if (!started.request.isCurrent()) return false
  // 定位是"去读历史"的意图：释放底部跟随，否则内容变动会把人拉回底部。
  releaseBottomLock()
  return withRevealLock(() =>
    revealElement(started.viewport as HTMLElement, element, { animated: options.animated, request: started.request }),
  )
}
defineExpose({
  stopScroll: releaseBottomLock,
  scrollToBottom,
  /** 通用入口：把任意视口内元素滚到视口里（划词引用徽标就用它）。 */
  revealInViewport,
  /**
   * 在**发起定位的那一刻**取得该视口的请求身份。引用定位需要在"展开正文 / 重算锚点"等
   * `await` 之前就拿到它，并贯穿到最终滚动（否则先发起、后恢复的旧请求会顶掉新目标）。
   */
  beginRevealRequest: (): RevealRequest | null => beginRequest()?.request ?? null,
  scrollToMessage: async (id: number, inherited?: RevealRequest) => {
    const message = scrollRef.value?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
    if (!message) return false
    // **进入即领取身份**（在任何 await 之前）：重挂要等一帧，期间可能已有更新的定位。
    // 引用定位会把**自己发起时**取得的身份传进来：它不能在这里重新领，否则会反过来
    // 顶掉用户更晚发起的那次定位。
    const started = inherited ? { viewport: scrollRef.value, request: inherited } : beginRequest()
    if (!started?.viewport) return false
    const { viewport, request } = started as { viewport: HTMLElement; request: RevealRequest }
    // 作废后立刻终止，不改走别的回退（否则旧请求会重新取得滚动权）。
    if (!request.isCurrent()) return false
    releaseBottomLock()
    return withRevealLock(async () => {
      // 虚拟行可能整行卸载，`virtual-reveal` 让它重挂；等一帧布局稳定再量位置。
      message.dispatchEvent(new Event('virtual-reveal'))
      await nextTick()
      await nextFrame()
      if (!request.isCurrent() || !message.isConnected) return false
      // 与原有行为一致：目标顶端贴视口顶端（留 24px），长消息也能从开头读起。
      return await revealElement(viewport, message, {
        animated: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        align: 'start',
        margin: 24,
        request,
      })
    })
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
