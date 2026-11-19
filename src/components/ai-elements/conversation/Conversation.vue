<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { reactiveOmit } from '@vueuse/core'
import { useStickToBottom } from 'vue-stick-to-bottom'
import { nextTick, onBeforeUnmount, onMounted, provide, ref, watch, watchEffect } from 'vue'
import { ScrollAreaRoot, ScrollAreaViewport } from 'reka-ui'
import { ScrollBar } from '@/components/ui/scroll-area'
import { pinToBottom } from '@/lib/bottomPin'
import { shouldReleaseBottomLock, shouldReleaseBottomLockOnScroll, shouldResumeBottomLock } from '@/lib/scrollIntent'
import { beginScrollDrag, clearScrollWrites, consumeScrollWrite, endScrollDrag, observeScrollWrites } from '@/lib/scrollWrites'
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
defineExpose({
  stopScroll: releaseBottomLock,
  scrollToBottom,
  scrollToMessage: async (id: number) => {
    const viewport = scrollRef.value
    const message = viewport?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
    if (!viewport || !message) return
    releaseBottomLock()
    message.dispatchEvent(new Event('virtual-reveal'))
    await nextTick()
    if (!message.isConnected) return
    viewport.scrollTo({
      top: viewport.scrollTop + message.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 24,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
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
/** Keys that scroll the conversation; their movement is the reader's. */
const CONVERSATION_SCROLL_KEYS = new Set(['End', 'Home', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', ' '])
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
  // The reader's own gesture outranks any recorded write, so the movement it
  // produces can never be mistaken for one the app made.
  clearScrollWrites(scroll)
  // Reka uses overflow: hidden scroll, which the library's shorthand overflow
  // check misses. Release before virtual row resizing can pin us back down.
  if (shouldReleaseBottomLock(scroll, event.target, event.deltaY)) releaseBottomLock()
}
function handleKeyDown(event: KeyboardEvent) {
  const scroll = scrollRef.value
  if (!scroll || event.defaultPrevented) return
  if (CONVERSATION_SCROLL_KEYS.has(event.key)) clearScrollWrites(scroll)
}
function handleScroll(event: Event) {
  const scroll = scrollRef.value
  if (scroll) {
    const previous = lastScrollTop ?? scroll.scrollTop
    lastScrollTop = scroll.scrollTop
    // Code moves this viewport too: bottom pinning, virtual-row height
    // compensation and the storage library's clamps. Those writes are recorded
    // when they happen, so a downward one can no longer pass for a downward
    // reading gesture - that re-armed following while the reader was scrolling
    // up and pinned every later chunk to the bottom (TZD-135).
    const programmatic = consumeScrollWrite(scroll, scroll.scrollTop)
    // Scroll events also cover scrollbar dragging and keyboard navigation, but
    // layout shrinkage clamps scrollTop to the new bottom without user intent.
    if (shouldReleaseBottomLockOnScroll(previous, scroll.scrollTop, scroll.scrollHeight - scroll.clientHeight))
      releaseBottomLock()
    else if (!programmatic && shouldResumeBottomLock(
      previous,
      scroll.scrollTop,
      scroll.scrollHeight - scroll.clientHeight,
      readingHistory,
    )) readingHistory = false
  }
  emit('scroll', event)
}
// A scrollbar drag is the reader, not the app: the thumb writes scrollTop while
// it follows the pointer, and that movement must keep re-arming following.
// Only this conversation's own scrollbar counts - nested and unrelated ones do
// not make the app's writes here the reader's.
function handlePointerDown(event: PointerEvent) {
  const scroll = scrollRef.value
  if (!scroll || !(event.target instanceof Element)) return
  const scrollbar = event.target.closest('[data-slot="scroll-area-scrollbar"]')
  // Only this conversation's own scrollbar: dragging a nested or unrelated one
  // does not make writes to this viewport the reader's.
  const own = scroll.parentElement?.querySelector('[data-slot="scroll-area-scrollbar"]')
  if (!scrollbar || !own || !scrollbar.isSameNode(own)) return
  beginScrollDrag(scroll)
}
function handlePointerUp() {
  const scroll = scrollRef.value
  if (scroll) endScrollDrag(scroll)
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
provide(conversationKey, { ...context, scrollToBottom, stopScroll: releaseBottomLock })
let stopObservingWrites: (() => void) | undefined
watchEffect((onCleanup) => {
  const scroll = scrollRef.value
  if (!scroll) return
  stopObservingWrites = observeScrollWrites(scroll)
  onCleanup(() => {
    stopObservingWrites?.()
    stopObservingWrites = undefined
  })
})
onMounted(() => {
  window.addEventListener('pointerdown', handlePointerDown, true)
  window.addEventListener('pointerup', handlePointerUp, true)
  window.addEventListener('pointercancel', handlePointerUp, true)
  if (props.initial === 'instant' && scrollRef.value)
    scrollRef.value.scrollTop = scrollRef.value.scrollHeight
  lastScrollTop = scrollRef.value?.scrollTop
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', handlePointerDown, true)
  window.removeEventListener('pointerup', handlePointerUp, true)
  window.removeEventListener('pointercancel', handlePointerUp, true)
})
</script>

<template>
  <ScrollAreaRoot :class="cn('relative min-h-0 min-w-0 flex-1 overflow-hidden', props.class)">
    <ScrollAreaViewport ref="viewport" class="size-full [&>div]:!block [&>div]:min-h-full [&>div]:min-w-0"
      :style="{ overflowAnchor: props.anchor }" @scroll="handleScroll" @wheel.passive="handleWheel" @keydown="handleKeyDown" role="log" :aria-label="props.ariaLabel" tabindex="0">
      <div :ref="el => { contentRef = el as HTMLElement | null }"><slot /></div>
    </ScrollAreaViewport>
    <ScrollBar />
    <slot name="overlay" />
  </ScrollAreaRoot>
</template>
